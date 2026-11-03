/**
 * 群組 log 端點（POST／GET /api/group-log/{gid}）的模擬：儲存、排序、額度、大小上限全部跑伺服器的 api/group_log_routes.py
 * （lib/group_log_bridge.py，一個常駐的 python 行程）；這裡只做 FastAPI 路由在呼叫 routes 之前做的事：
 *   - AppendBody 的欄位長度（pydantic，不合 → 422）
 *   - 帳號簽章（api/chat/signing.py make_signed_account：排序 JSON、±300 秒、標準 base64；request_id 由 routes 自己防重放）
 *     ＋帳號（accountOf(pubkey) → 帳號 id 或 null；null → 403 account_not_registered，跟正式站一樣）。沒給 accountOf ＝ 帳號就是公鑰
 *     （scripts/review 的接線測試）；模擬的 mockApi 給它 keys-only 註冊的帳號（開源計畫第 3 步）
 * 模擬 API（mockApi.mjs）與 scripts/review 的群組 log 接線測試共用。
 *
 * W5（docs/GROUP_LOG_WIRING_W5.md）—— 惡意的伺服器：伺服器本來就能決定給誰看什麼（log 只排序、內容是不透明的 blob）。
 *   malice.equivocate({ gid, victim, seq, blob })  給 victim 看的 log 在 seq 那一號換成別的 blob（其他人看到真的）
 *   malice.swap({ gid, victim, a, b })             給 victim 看的 log 把 a、b 兩號的內容對調（同一批 commit、不同順序）
 *   malice.withhold({ gid, victim, fromSeq })      給 victim 看的 log 停在 fromSeq 之前（head 也跟著說謊）
 *   malice.clear(id)／malice.clearAll()            恢復誠實
 *   injectEntry(gid, blob)                         營運方直接寫進 log（不經帳號簽章；它管資料庫）
 *   appended[]：每一筆成功的 append { gid, seq, blob, who, at }（攔截、重放用）；fetched[]：每一次 GET { who, gid, after, n, at }
 * victim 是 label（mockApi 的 who）或 (label) => boolean。handle 的第 5 個參數是 who。
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const BRIDGE = fileURLToPath(new URL('./group_log_bridge.py', import.meta.url));
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const GID_PATH = /^\/api\/group-log\/([^/]+)$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

/** = api/chat/signing.py verify_device_signature（時間窗用呼叫端給的時鐘，模擬撥時間時一起動） */
export function verifyAccountSignature(pubkeyB64, sigB64, payload, nowSeconds) {
  try {
    const pk = Buffer.from(pubkeyB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pk.length !== 32 || sig.length !== 64 || pk.toString('base64') !== pubkeyB64 || sig.toString('base64') !== sigB64) return false;
    if (typeof payload.timestamp !== 'number' || Math.abs(nowSeconds - payload.timestamp) > 300) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(JSON.stringify(canonical(payload)), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/**
 * routesPy：api/group_log_routes.py 的路徑；dbPath：這次用的 sqlite 檔（每輪新的）。
 * now()：伺服器時間（毫秒）。python：直譯器（預設 SIM_PYTHON 或 python3）。
 */
export function createGroupLogServer({ routesPy, dbPath, now = () => Date.now(), python = process.env.SIM_PYTHON || 'python3', accountOf = null }) {
  const child = spawn(python, ['-I', BRIDGE, routesPy, dbPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let nextId = 1;
  let closed = false;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  });
  child.on('exit', () => {
    closed = true;
    for (const w of waiting.values()) w({ ok: false, status: 503, code: 'bridge_exited' });
    waiting.clear();
  });
  const call = (req) => new Promise((resolve) => {
    if (closed) { resolve({ ok: false, status: 503, code: 'bridge_exited' }); return; }
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
  const json = (status, body) => ({ status, body: JSON.stringify(body), contentType: 'application/json' });
  const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
  const counts = { appends: 0, fetches: 0, rejected: 0 };
  /** W5：被誤導的 GET 次數（每條規則） */
  const rules = new Map();
  let ruleSeq = 0;
  const appended = [];
  const fetched = [];
  const matches = (victim, who) => (typeof victim === 'function' ? !!victim(who) : victim === who);
  /** 照規則改這個人看到的這一頁（entries 依 seq 排好；head ＝ 伺服器說的最大 seq） */
  function mislead(who, gid, entries, head) {
    let out = entries.map((e) => ({ ...e }));
    let h = head;
    for (const r of rules.values()) {
      if (r.gid !== gid || !matches(r.victim, who)) continue;
      if (r.kind === 'equivocate') out = out.map((e) => (e.seq === r.seq ? { ...e, blob: r.blob } : e));
      else if (r.kind === 'swap') {
        const a = entries.find((e) => e.seq === r.a)?.blob;
        const b = entries.find((e) => e.seq === r.b)?.blob;
        if (a !== undefined && b !== undefined) out = out.map((e) => (e.seq === r.a ? { ...e, blob: b } : e.seq === r.b ? { ...e, blob: a } : e));
      } else if (r.kind === 'withhold') {
        out = out.filter((e) => e.seq < r.fromSeq);
        h = Math.min(h, r.fromSeq - 1);
      }
      r.hits++;
    }
    return { entries: out, head: h };
  }
  const addRule = (r) => { const id = ++ruleSeq; rules.set(id, { ...r, hits: 0 }); return id; };
  const malice = {
    equivocate: ({ gid, victim, seq, blob }) => addRule({ kind: 'equivocate', gid, victim, seq, blob }),
    swap: ({ gid, victim, a, b }) => addRule({ kind: 'swap', gid, victim, a, b }),
    withhold: ({ gid, victim, fromSeq }) => addRule({ kind: 'withhold', gid, victim, fromSeq }),
    hits: (id) => rules.get(id)?.hits ?? 0,
    clear: (id) => rules.delete(id),
    clearAll: () => rules.clear(),
  };

  /**
   * method、pathname、search（?after=…）、bodyText → { status, body, contentType, reason? }；不是 group-log 的路徑 → null。
   * reason：被拒的原因（簽章／重放這類「正式站也會拒」的，呼叫端記成 API-AUTH 的拒絕）。
   */
  async function handle(method, pathname, search, bodyText, who = null, skewMs = 0) {
    const m = GID_PATH.exec(pathname);
    if (!m) return null;
    const gid = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const q = new URLSearchParams(search || '');
      const num = (k, d) => (q.has(k) ? (/^-?\d+$/.test(q.get(k)) ? Number(q.get(k)) : NaN) : d);
      const after = num('after', 0);
      const limit = num('limit', 200);
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit)) return json(422, { detail: 'bad query' });
      const r = await call({ op: 'fetch', gid, after, limit });
      counts.fetches++;
      if (!r.ok) return json(r.status, { detail: r.code });
      const seen = rules.size ? mislead(who, gid, r.entries, r.head) : { entries: r.entries, head: r.head };
      fetched.push({ who, gid, after, n: seen.entries.length, at: Date.now() });
      if (fetched.length > 20000) fetched.splice(0, 5000);
      // 停在 fromSeq 之前的那一頁：more 也要說「沒了」（不然 App 會一直往下抓）
      const more = seen.entries.length === r.entries.length ? r.more : false;
      return json(200, { entries: seen.entries, head: seen.head, more });
    }
    if (method !== 'POST') return json(405, { detail: 'method not allowed' });
    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch { return json(422, { detail: 'bad json' }); }
    if (!str(body.blob, 1, 64 * 1024) || !str(body.pubkey, 40, 128) || !Number.isInteger(body.timestamp)
        || !str(body.request_id, 16, 128) || !str(body.signature, 80, 128)) {
      counts.rejected++;
      return { ...json(422, { detail: 'validation error' }), reason: 'validation' };
    }
    const p = await call({ op: 'payload', pubkey: body.pubkey, gid, blob: body.blob, timestamp: body.timestamp, request_id: body.request_id });
    if (!p.ok) { counts.rejected++; return { ...json(p.status, { detail: p.code }), reason: p.code }; }
    // 營運方對這一支說謊的時鐘（mockApi.serverTimeSkew）：說謊的人照自己說的時間判簽章時間窗
    if (!verifyAccountSignature(body.pubkey, body.signature, p.payload, Math.floor((now() + skewMs) / 1000))) {
      counts.rejected++;
      return { ...json(401, { detail: 'invalid_signature_or_timestamp' }), reason: 'invalid_signature_or_timestamp' };
    }
    const account = accountOf ? accountOf(body.pubkey) : body.pubkey;
    if (!account) {
      counts.rejected++;
      return { ...json(403, { detail: 'account_not_registered' }), reason: 'account_not_registered' };
    }
    const r = await call({ op: 'append', gid, blob: body.blob, account, request_id: body.request_id, now: now() / 1000 });
    if (!r.ok) { counts.rejected++; return { ...json(r.status, { detail: r.code }), reason: r.code }; }
    counts.appends++;
    appended.push({ gid, seq: r.seq, blob: body.blob, who, at: Date.now() });
    return json(200, { seq: r.seq });
  }

  /** 營運方直接寫一筆（W5 S8：不經帳號簽章 —— 它管資料庫）；回傳 seq */
  async function injectEntry(gid, blob) {
    const r = await call({ op: 'append', gid, blob, account: 'operator', request_id: crypto.randomBytes(16).toString('hex'), now: now() / 1000 });
    if (!r.ok) throw new Error(`inject failed: ${r.code}`);
    appended.push({ gid, seq: r.seq, blob, who: 'operator', at: Date.now() });
    return r.seq;
  }

  /** 直接讀 log（不經任何人的眼睛：誠實的那一份） */
  async function read(gid, after = 0) {
    const r = await call({ op: 'fetch', gid, after, limit: 200 });
    return r.ok ? r : { entries: [], head: 0, more: false };
  }

  return { handle, counts, malice, appended, fetched, injectEntry, read, close: () => { if (!closed) child.stdin.end(); } };
}

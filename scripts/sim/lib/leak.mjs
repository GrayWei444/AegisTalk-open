/**
 * LEAK 檢查（W2，docs/GROUP_LOG_WIRING_W2.md）：整輪模擬裡 broker 在群組主題（mist/group/{tid}/{寄件人}，W3：tid 是每一代
 * 金鑰推出來的 22 字元主題 id，不是 gid；gid 有沒有上 broker 由 lib/topics.mjs 的 GROUP-TOPICS 檢查）上看到的每一則，
 * 只能是 group_sealed：{ type, from, payload: { n, c }, timestamp }，from ＝ 主題上的寄件人，n／c 是 base64。
 * 沒有金鑰 id（W3，審查 M3：群組 log 上每一筆都帶明文 kid、看得到 gid —— 主題上再帶 kid，營運方照 kid 就把 tid 對回 gid）。
 * 看得到的欄位（密文 c 與 nonce n 以外）不能有群組名稱、暱稱、守護設定的 notifyTime／customMessage；
 * 整則（含密文）不能出現主題寄件人以外任何成員的公鑰（44 字元的標準 base64 或 43 字元的 URL-safe，亂數撞到的機率是 0）。
 * W5：群組主題以外（收件箱、presence、遺囑）的每一則 App 發的東西也要看（scanAny）：群組名稱、守護設定的內容（anywhere()）
 * 不能以明文出現在 broker 看得到的任何地方（暱稱不算：1 對 1 的 PROFILE_UPDATE 本來就是明文，W4 Limits）。
 * 開源第 4 步（docs/DIRECT_SEALED.md）：checkDirect —— 群組主題以外的每一則（收件箱、presence、遺囑、連線時留的）：
 *   - 收件箱上只准 direct_sealed、x3dh_init、group_key_sealed、換機兩種；明文的 1 對 1 信令型別（webrtc_*、call_*、profile_update…）一則都不准
 *   - direct_sealed 一字不差是 { type, from, to, payload: { v, ek, n, ct }, timestamp }（base64）
 *   - X3DH_INIT 不帶 senderName；任何地方都不准有 notificationHint／pushData（推播提示不上 broker）
 *   - 顯示名稱（names()）不准以一個字的樣子出現在任何看得到的字串裡（base64 的長字串不算 —— 那是密文／金鑰，亂數撞到短名字很正常）
 * 純函式，run.mjs 用 broker 的 onPublish 餵進來；scripts/review/sim_leak_check_self_test.mjs 測它真的抓得到。
 */
const MAX_FINDINGS = 50;
const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TOPIC_ID = /^[A-Za-z0-9_-]{22}$/;
/** 收件箱上准的型別（開源第 4 步：1 對 1 的信令只有封好的 direct_sealed） */
export const INBOX_TYPES = new Set(['direct_sealed', 'x3dh_init', 'group_key_sealed', 'device_transfer_request', 'device_transfer_data']);
/** 看起來是 base64／base64url 的長字串（密文、金鑰、簽章）：不拿來找名字 */
const OPAQUE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** JSON 裡所有字串值（不含欄位名稱） */
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

/**
 * secrets()：不該出現在看得到的欄位裡的字串（群組名稱、暱稱…）；members()：所有成員的公鑰（標準 base64）
 */
export function createLeakCheck({ secrets, members, anywhere = () => [], names = () => [] }) {
  const stats = { checked: 0, scanned: 0, types: {}, findings: [], findingCount: 0, direct: { checked: 0, scanned: 0, types: {} } };
  /**
   * 群組主題以外的一則（開源第 4 步）：收件箱的型別與形狀、推播提示、看得到的字串裡的顯示名稱
   */
  function checkDirect(label, topic, payload) {
    const parts = String(topic).split('/');
    if (parts[0] === 'mist' && parts[1] === 'group') return;
    stats.direct.scanned++;
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
    const find = (why) => {
      stats.findingCount++;
      if (stats.findings.length < MAX_FINDINGS) stats.findings.push(`${label} on ${parts.slice(0, 2).join('/')}/…/${parts[3] ?? ''}: ${why}`);
    };
    if (/notificationHint|pushData/.test(raw)) find('a push hint on the broker');
    let m = null;
    try { m = raw ? JSON.parse(raw) : null; } catch { m = null; }
    const inbox = parts[0] === 'mist' && parts[1] === 'user' && parts[3] === 'inbox';
    if (inbox) {
      stats.direct.checked++;
      const type = m?.type;
      stats.direct.types[type] = (stats.direct.types[type] ?? 0) + 1;
      if (!INBOX_TYPES.has(type)) find(`plaintext 1:1 type ${type}`);
      if (type === 'direct_sealed') {
        const extra = Object.keys(m).filter((k) => !['type', 'from', 'to', 'payload', 'timestamp'].includes(k));
        if (extra.length) find(`direct_sealed with extra fields ${extra.join(',')}`);
        const p = m.payload;
        const keys = p && typeof p === 'object' ? Object.keys(p).sort().join(',') : String(p);
        if (keys !== 'ct,ek,n,v') find(`direct_sealed payload is not {v, ek, n, ct} (${keys.slice(0, 60)})`);
        else if (p.v !== 1 || ![p.ek, p.n, p.ct].every((x) => typeof x === 'string' && B64.test(x))) find('direct_sealed payload is not {1, base64, base64, base64}');
      }
      if (type === 'x3dh_init' && /senderName|displayName/.test(JSON.stringify(m.payload ?? null))) find('X3DH_INIT carries a name field');
    }
    const visible = m === null ? [raw] : stringsOf(m);
    for (const n of names()) {
      if (!n) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}([^A-Za-z0-9]|$)`);
      if (visible.some((x) => !OPAQUE.test(x) && re.test(x))) find(`readable name "${n}"`);
    }
  }
  /** 任何主題（收件箱、presence、遺囑）上的整則：anywhere() 的字串一個都不能出現 */
  function scanAny(label, topic, payload) {
    stats.scanned++;
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
    for (const s of anywhere()) {
      if (!s || !raw.includes(s)) continue;
      stats.findingCount++;
      if (stats.findings.length < MAX_FINDINGS) stats.findings.push(`${label} on ${String(topic).split('/').slice(0, 2).join('/')}/…: readable "${s}"`);
    }
  }
  function check(label, topic, payload) {
    const parts = String(topic).split('/');
    if (parts[0] !== 'mist' || parts[1] !== 'group') return;
    stats.checked++;
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    const find = (why) => {
      stats.findingCount++;
      if (stats.findings.length < MAX_FINDINGS) stats.findings.push(`${label} on mist/group/${(parts[2] ?? '').slice(0, 6)}…: ${why}`);
    };
    if (parts.length !== 4 || !TOPIC_ID.test(parts[2] ?? '')) find('not a mist/group/{22-char tid}/{sender} topic');
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      find('not JSON');
      return;
    }
    stats.types[m?.type] = (stats.types[m?.type] ?? 0) + 1;
    if (m?.type !== 'group_sealed') find(`plaintext type ${m?.type}`);
    const extra = Object.keys(m ?? {}).filter((k) => !['type', 'from', 'payload', 'timestamp'].includes(k));
    if (extra.length) find(`extra fields ${extra.join(',')}`);
    if (typeof m?.from !== 'string' || toUrl(m.from) !== parts[3]) find('from is not the topic sender');
    const p = m?.payload;
    const keys = p && typeof p === 'object' ? Object.keys(p).sort().join(',') : String(p);
    if (keys !== 'c,n') find(`payload is not {n, c} (${keys.slice(0, 60)})`);
    else if (typeof p.n !== 'string' || !B64.test(p.n) || typeof p.c !== 'string' || !B64.test(p.c)) find('payload is not {base64, base64}');
    const visible = JSON.stringify(p && typeof p === 'object' ? { ...m, payload: { ...p, c: '', n: '' } } : m);
    for (const s of secrets()) if (s && visible.includes(s)) find(`readable "${s}"`);
    for (const pk of members()) {
      if (!pk || toUrl(pk) === parts[3]) continue;
      if (raw.includes(pk) || raw.includes(toUrl(pk))) find(`carries another member's key ${pk.slice(0, 8)}…`);
    }
  }
  return { check, scanAny, checkDirect, stats };
}

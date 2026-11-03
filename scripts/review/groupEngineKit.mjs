/**
 * 群組 log 接線測試共用（W1）：真的 services/groupEngine.ts（含 groupEngineSealed／groupBackup／groupProjection）、
 * 真的 groupLogStore.ts（每支手機自己一顆 sql.js 資料庫，schema 直接取 database.ts 的 GROUP_LOG_TABLES_SQL 與群組投影表）、
 * 真的 groupLogClient.ts（簽章 append、分頁 fetch），伺服器跑真的 api/group_log_routes.py（scripts/sim/lib/group_log_bridge.py），
 * 封給身分金鑰的信封走真的 identitySeal（含種類上限）。broker 只模擬「在線就送、離線就排隊」與群組主題的 group_sealed
 * （W2：QoS1 替離線的人排隊、QoS0 只給在線的；每一則記在 world.controlLog，測試可以拿金鑰拆開看）。
 * W3：群組主題是 tid（每一代金鑰推出來的）。手機照引擎的主題表（deps.onTopics）訂／退訂，跟 App 一樣（新的主題要
 * subscribeDelayMs 才訂好：換 token、重連、SUBACK；不要的馬上退訂）；broker 只送給訂了那個 tid 的手機，訂好之前發的就收不到。
 * controlLog 的 gid 是測試從各支手機的主題表查來的（world.tidGid，只給測試看）；headSeq ＝ 發的那一刻寄件人套到哪個 seq。
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, verify, x25519, seedOf, SRC } from './groupStateKit.mjs';
import { createGroupLogServer } from '../sim/lib/groupLogServer.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build } = require('esbuild');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const SQL = await initSqlJs();
const dir = mkdtempSync(join(tmpdir(), 'gengine-'));

/** database.ts 裡的群組 log 表（GROUP_LOG_TABLES_SQL）＋ groups／group_members／settings */
export function schemaStatements() {
  const src = readFileSync(`${SRC}/services/database.ts`, 'utf8');
  const out = [];
  for (const t of ['groups', 'group_members', 'settings']) {
    const a = src.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
    out.push(src.slice(a, src.indexOf(');', a) + 2));
  }
  const head = 'const GROUP_LOG_TABLES_SQL = ';
  const a = src.indexOf(head);
  if (a < 0) throw new Error('GROUP_LOG_TABLES_SQL not found in database.ts');
  out.push(...new Function(`return ${src.slice(a + head.length, src.indexOf('];', a) + 1)}`)());
  return out;
}

globalThis.__engineDbs = globalThis.__engineDbs ?? {};
globalThis.__engineFlushes = globalThis.__engineFlushes ?? {};

const dbModule = (label) => `
  const db = () => globalThis.__engineDbs[${JSON.stringify(label)}];
  export async function initDatabase() {}
  export async function run(sql, params = []) { db().run(sql, params); return db().getRowsModified(); }
  export async function query(sql, params = []) {
    const st = db().prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out;
  }
  export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
  export async function runBatch(sets) {
    const d = db(); d.run('BEGIN');
    try { for (const s of sets) d.run(s.statement, s.values); d.run('COMMIT'); } catch (e) { d.run('ROLLBACK'); throw e; }
    return 0;
  }
  export async function flushToStore() { globalThis.__engineFlushes[${JSON.stringify(label)}] = (globalThis.__engineFlushes[${JSON.stringify(label)}] ?? 0) + 1; }
  export async function getSetting() { return null; } export async function setSetting() {}`;

async function bundle(name, contents, label) {
  const out = join(dir, `${name}.mjs`);
  await build({
    stdin: { contents, resolveDir: `${SRC}/services`, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out,
    logLevel: 'silent', define: { 'import.meta.env': '{}' },
    plugins: label ? [{ name: 'db', setup(b) {
      b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'db' }));
      b.onLoad({ filter: /.*/, namespace: 'db' }, () => ({ loader: 'js', contents: dbModule(label) }));
    } }] : [],
  });
  return import(pathToFileURL(out) + `?${label ?? ''}`);
}

export const E = await bundle('engine', `
  export { createGroupEngine } from './groupEngine';
  export { restoreGroupBackups, restoreGroupBackup } from './groupBackup';
  export { createGroupLogClient, GroupLogHttpError } from './groupLogClient';
  export * as GS from './groupState';
  export * as GL from './groupLog';
  export * as S from './identitySeal';
  export * as CTL from './groupControl';
  export * as GT from './groupTopics';
  export { INVITE_RESEND_MS } from './groupEngineSealed';`);
const KIND_LIMITS = Object.fromEntries(['invite', 'ack', 'req', 'dist'].map((k) => [k, E.S.GROUP_SEALED_KIND_LIMITS[k]]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class World {
  constructor() {
    this.offset = 0;
    this.activity = 0;
    this.inflight = 0;
    this.phones = new Map();
    this.friendships = new Set();
    this.mailbox = new Map();     // 離線時排隊的信封（MQTT 持久 session）
    this.sealedLog = [];          // 每一封信封：{ from, to, kind }（測試看「有沒有回」）
    this.controlLog = [];         // 群組主題上每一則 group_sealed：{ from, tid, gid, kid, qos, envelope, headSeq }
    this.controlMailbox = new Map();   // 離線的人排隊的 group_sealed（QoS1）
    this.controlResults = [];     // 每一次 onControl 的結果：{ to, from, tid, gid, result }
    this.tidGid = new Map();      // 主題 id → 群組（測試用：從各支手機的主題表收集）
    this.tidKid = new Map();      // 主題 id → 那一代的 kid（信封上沒有 kid，W3 審查 M3）
    /** 送信封之前可以動手腳：sealedFilter({ from, to, body }) → false ＝ 這封「弄丟了」 */
    this.sealedFilter = null;
    this.dbPath = join(dir, `log-${crypto.randomBytes(4).toString('hex')}.db`);
    this.server = createGroupLogServer({ routesPy: `${root}api/group_log_routes.py`, dbPath: this.dbPath, now: () => this.now() });
    /** 伺服器端可以動手腳：fetchFilter(phone, entries) → entries（模擬給某人看不同的 log） */
    this.fetchFilter = null;
  }
  now() { return Date.now() + this.offset; }
  befriend(a, b) { this.friendships.add(`${a.pk}|${b.pk}`); this.friendships.add(`${b.pk}|${a.pk}`); }
  isFriend(a, pk) { return this.friendships.has(`${a.pk}|${pk}`); }
  /** sameAs：同一個身分的另一台（還原、換機） */
  async phone(label, sameAs) {
    const p = new Phone(this, label, sameAs?.id);
    await p.init();
    this.phones.set(p.pk, p);
    return p;
  }
  bump() { this.activity++; }
  /** 送信封：照真的 identitySeal 封（含種類上限），收件人在線就拆、交給他的引擎；離線就排隊 */
  async deliverSealed(from, to, body) {
    const env = await E.S.sealToIdentity({ from: from.pk, to, body, sign: from.id.sign, kindLimits: KIND_LIMITS }, x25519);
    this.sealedLog.push({ from: from.pk, to, kind: body.kind, gid: body.gid, kid: body.kid, body });
    if (this.sealedFilter && this.sealedFilter({ from: from.pk, to, body }) === false) return;
    const target = this.phones.get(to);
    if (!target) return;
    if (!target.online) { (this.mailbox.get(to) ?? this.mailbox.set(to, []).get(to)).push({ from: from.pk, env }); return; }
    this.receive(target, from.pk, env);
  }
  receive(target, fromPk, env) {
    this.inflight++;
    this.bump();
    setImmediate(async () => {
      try {
        if (!target.online || !target.engine) return;
        const opened = await E.S.openFromIdentity({ envelope: env, from: fromPk, to: target.pk, myX25519Private: await target.x25519Private(),
          verify, kindLimits: KIND_LIMITS }, x25519);
        await target.engine.onSealed(fromPk, opened);
      } catch (e) {
        target.errors.push(String(e?.message ?? e));
      } finally {
        this.inflight--;
        this.bump();
      }
    });
  }
  /**
   * 群組主題 mist/group/{tid}/{寄件人} 上的 group_sealed：只給訂了這個 tid 的手機（跟 broker 一樣；審查 W2 #12）。在線的人馬上收到；
   * QoS1 替離線的人排隊（broker 持久 session，訂閱留著），QoS0 不排
   */
  publishControl(from, tid, envelope, { qos }) {
    const gid = this.tidGid.get(tid) ?? null;
    this.controlLog.push({ from: from.pk, tid, gid, kid: this.tidKid.get(tid) ?? null, qos, envelope, fromSubscribed: from.subs.has(tid),
      headSeq: gid ? from.engine?.gossip(gid)?.seq ?? null : null });
    this.bump();
    for (const p of this.phones.values()) {
      if (p === from || !p.subs.has(tid)) continue;
      if (!p.online || !p.engine) {
        if (qos === 1) (this.controlMailbox.get(p.pk) ?? this.controlMailbox.set(p.pk, []).get(p.pk)).push({ from: from.pk, tid, envelope });
        continue;
      }
      this.receiveControl(p, from.pk, tid, envelope);
    }
    return true;
  }
  receiveControl(p, fromPk, tid, envelope) {
    this.inflight++;
    p.received.push({ from: fromPk, tid });
    setImmediate(() => p.engine.onControl(tid, fromPk, envelope)
      .then((result) => { this.controlResults.push({ to: p.pk, from: fromPk, tid, gid: this.tidGid.get(tid) ?? null, result }); })
      .catch((e) => p.errors.push(String(e?.message ?? e)))
      .finally(() => { this.inflight--; this.bump(); }));
  }
  /** 等所有引擎安靜下來（沒有在途信封、log 請求，活動計數 quietMs 內沒變） */
  async settle(quietMs = 450, maxMs = 60_000) {
    const t0 = Date.now();
    let last = -1;
    let stableSince = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(40);
      if (this.activity !== last || this.inflight > 0) { last = this.activity; stableSince = Date.now(); continue; }
      if (Date.now() - stableSince >= quietMs) return;
    }
    throw new Error('world did not settle');
  }
  close() {
    for (const p of this.phones.values()) p.engine?.stop();
    this.server.close();
    try { rmSync(this.dbPath, { force: true }); } catch { /* */ }
  }
}

let phoneCounter = 0;

export class Phone {
  constructor(world, label, id) {
    this.world = world;
    this.label = label;
    this.id = id ?? identity(`${label}-${crypto.randomBytes(3).toString('hex')}`);
    this.pk = this.id.pk;
    this.dbLabel = `${label}-${++phoneCounter}`;
    this.groups = new Map();
    this.notices = [];
    this.errors = [];
    this.controls = [];         // 引擎交給 App 的 call／delete（驗過的）
    this.subs = new Set();      // 訂好的群組主題 tid（broker 准了）；App 關掉時留著（持久 session）
    this.everSubscribed = new Set();   // 曾經訂過的 tid（測試：被踢的人從沒訂到新一代的主題）
    this.topicList = [];        // 引擎最近一次給的主題表（deps.onTopics）
    this.topicEvents = [];      // 每一次 onTopics：{ at, list }
    this.received = [];         // broker 送到這支的每一則群組主題訊息：{ from, tid }
    this.subscribeDelayMs = 0;  // 新的主題要過多久才訂好（App：換 token、重連、SUBACK）
    this.mqttUp = true;         // MQTT 連著嗎（deps.connected）
    this.conflictSeen = new Set();   // 畫面上出現過 head 交叉比對警告（Group.logConflict）的群
    this.online = true;
    this.appendHook = null;     // (gid, blob) → 在真的 append 之前呼叫（看存檔順序）
    this.fetchHook = null;      // async (gid, after) → 在每一次 GET log 之前等它（測試讓這支手機的同步卡住、再放行）
    this.fetchCount = new Map();
  }
  get db() { return globalThis.__engineDbs[this.dbLabel]; }
  sql(q, params = []) {
    const st = this.db.prepare(q); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out;
  }
  x25519Private() { return E.S.edSeedToX25519Scalar(seedOf(this.id.label)); }
  async init() {
    const d = new SQL.Database();
    for (const s of schemaStatements()) d.run(s);
    globalThis.__engineDbs[this.dbLabel] = d;
    this.storeMod = await bundle(`store-${this.dbLabel}`, `export { groupLogStore } from './groupLogStore';`, this.dbLabel);
    this.store = this.storeMod.groupLogStore;
  }
  logClient() {
    const world = this.world;
    const phone = this;
    return E.createGroupLogClient({
      base: 'https://api.test', signer: () => ({ publicKey: phone.pk, sign: phone.id.sign }), serverNow: () => world.now(),
      sleep: () => sleep(1),
      fetchFn: async (url, init = {}) => {
        world.bump();
        const u = new URL(url);
        const method = init.method ?? 'GET';
        if (method === 'POST' && phone.appendHook) {
          const body = JSON.parse(init.body);
          await phone.appendHook(decodeURIComponent(u.pathname.split('/').pop()), body.blob);
        }
        if (method === 'GET' && phone.fetchHook) {
          await phone.fetchHook(decodeURIComponent(u.pathname.split('/').pop()), Number(u.searchParams.get('after')));
        }
        let out = await world.server.handle(method, u.pathname, u.search, init.body ?? '');
        world.bump();
        if (method === 'GET') {
          const gid = decodeURIComponent(u.pathname.split('/').pop());
          const after = Number(u.searchParams.get('after'));
          phone.fetchCount.set(`${gid}|${after}`, (phone.fetchCount.get(`${gid}|${after}`) ?? 0) + 1);
          if (world.fetchFilter && out.status === 200) {
            const body = JSON.parse(out.body);
            body.entries = world.fetchFilter(phone, gid, body.entries);
            out = { ...out, body: JSON.stringify(body) };
          }
        }
        return new Response(out.body, { status: out.status, headers: { 'Content-Type': 'application/json' } });
      },
    });
  }
  deps(extra = {}) {
    const world = this.world;
    return {
      me: this.pk, sign: this.id.sign, verify, x25519, myX25519Private: () => this.x25519Private(), store: this.store,
      log: this.logClient(), sendSealed: (to, body) => world.deliverSealed(this, to, body),
      publish: (tid, envelope, opts) => world.publishControl(this, tid, envelope, opts),
      onControl: (gid, from, t, body) => { this.controls.push({ gid, from, t, body }); world.bump(); },
      project: (gid, g) => {
        if (g) this.groups.set(gid, g); else this.groups.delete(gid);
        if (g?.logConflict) this.conflictSeen.add(gid);
        world.bump();
      },
      // App：引擎的主題表就是 token 範圍與訂閱（W3）
      onTopics: (list) => this.setTopics(list),
      connected: () => this.online && this.mqttUp,
      topicReady: (tid) => this.subs.has(tid),
      isFriend: async (pk) => world.isFriend(this, pk), isBlocked: async () => false, nicknameOf: () => undefined,
      now: () => world.now(), notice: (n) => this.notices.push(n), pollMs: 3_600_000, minSyncIntervalMs: 0,
      inviteBudget: { perSender: 100, total: 1000 }, replyJitterMs: 0, switchGraceMs: 0, ...extra,
    };
  }
  async boot(extra) {
    this.online = true;
    this.engine = E.createGroupEngine(this.deps(extra));
    await this.engine.start();
    // 排隊的信封與群組主題上的 QoS1 控制訊息（broker 持久 session）
    for (const m of this.world.mailbox.get(this.pk) ?? []) this.world.receive(this, m.from, m.env);
    this.world.mailbox.delete(this.pk);
    for (const m of this.world.controlMailbox.get(this.pk) ?? []) this.world.receiveControl(this, m.from, m.tid, m.envelope);
    this.world.controlMailbox.delete(this.pk);
  }
  /** App 關掉：引擎停、不收信封與 ping（排隊） */
  shutdown() {
    this.online = false;
    this.engine?.stop();
    this.engine = null;
  }
  /** 引擎的主題表變了（App：setAclScope → mqtt._syncGroupTopics）：不要的馬上退訂，新的 subscribeDelayMs 之後訂好 */
  setTopics(list) {
    this.topicList = list;
    this.topicEvents.push({ at: this.world.now(), list });
    for (const t of list) { this.world.tidGid.set(t.tid, t.gid); this.world.tidKid.set(t.tid, t.kid); }
    const want = new Set(list.map((t) => t.tid));
    for (const tid of [...this.subs]) if (!want.has(tid)) this.subs.delete(tid);
    for (const tid of want) this.subscribe(tid);
    this.world.bump();
  }
  /** 訂一個群組主題（已經訂了就不動）；訂好了告訴引擎（App：mqtt 的 SUBACK → onTopicReady） */
  subscribe(tid) {
    if (this.subs.has(tid) || this.pendingSubs?.has(tid)) return;
    this.pendingSubs ??= new Set();
    this.pendingSubs.add(tid);
    this.world.inflight++;
    setTimeout(() => {
      this.pendingSubs.delete(tid);
      if (this.topicList.some((t) => t.tid === tid)) {
        this.subs.add(tid);
        this.everSubscribed.add(tid);
        this.engine?.onTopicReady(tid);
      }
      this.world.inflight--;
      this.world.bump();
    }, this.subscribeDelayMs);
  }
  /** 這個群目前這一代的主題 id（引擎的主題表；沒有 → null） */
  tidOf(gid) { return this.engine?.topics().find((t) => t.gid === gid && t.current)?.tid ?? null; }
  /** 這個群在表上的所有主題（目前的在前） */
  topicsOf(gid) { return (this.engine?.topics() ?? []).filter((t) => t.gid === gid).sort((a, b) => Number(b.current) - Number(a.current)); }
  roster(gid) { return (this.groups.get(gid)?.members ?? []).map((m) => m.publicKey).sort(); }
  admins(gid) { return (this.groups.get(gid)?.members ?? []).filter((m) => m.role === 'admin').map((m) => m.publicKey).sort(); }
  activeKid(gid) { return this.sql('SELECT key_id FROM group_keys WHERE group_id = ? AND is_active = 1', [gid]).map((r) => r.key_id); }
  /** 用這支手機手上的金鑰拆開一則 group_sealed（測試看內容；拆不開 → null） */
  async peekControl(entry) {
    const key = entry.gid ? this.engine?.decryptKey(entry.gid, entry.kid) : null;
    if (!key) return null;
    try {
      return await E.CTL.openControl({ envelope: entry.envelope, gid: entry.gid, tid: entry.tid, sender: entry.from, kid: entry.kid, key, verify });
    } catch {
      return null;
    }
  }
}

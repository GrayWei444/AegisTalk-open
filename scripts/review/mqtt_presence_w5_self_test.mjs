/**
 * W5：presence 的時鐘與順序（docs/GROUP_LOG_WIRING_W5.md；W4 Limits 的「API 時鐘差」）。真的 mqtt.ts／presenceSecret.ts，stub 同
 * mqtt_presence_w4_self_test。
 *   1. presenceClock：本機時鐘＋API 的時鐘差，最多 ±5 分鐘（PRESENCE_MAX_CLOCK_SKEW_MS）
 *   2. 營運方回一個慢一小時的 serverTime：一小時前錄下來的「在線」重放進來不算新鮮（以前算：好友不發推播）；
 *      時鐘差在上限內時，錄下來最多 10 分鐘（ONLINE_FRESH_MS＋上限）的才可能還算新鮮
 *   3. 營運方清掉好友目前的主題（空的 retained）再重放同一個主題上更早的狀態 → 不採用（每個主題最後採用的那一則留著當比較對象）；
 *      主題離開範圍、登出 → 那一份丟掉
 * Run: node scripts/review/mqtt_presence_w5_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto, { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from './groupStateKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttpres5-'));
globalThis.__clients = [];
globalThis.__idb = new Map();
const DEVICE = '0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab';
// the build's default server ('@ext/server'): an example one, so the test runs the same in the community tree (no default
// server there) and in the official one
const EXT_SERVER = `export const defaultServer = { name: 'Example chat', apiUrl: 'https://chat-api.example.org', mqttUrl: 'wss://chat-mqtt.example.org/mqtt', registration: 'invite' };
  export const connectSources = []; export const brandLegal = undefined;`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@ext/server' ? EXT_SERVER
    : a.path === 'mqtt' ? `export default { connect(url, options) {
        const handlers = {}; const subs = []; const pubs = [];
        const c = { connected: true, disconnected: false, subs, pubs, options, handlers, unsubs: [],
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          subscribe(topic, opts, cb) { subs.push(topic); cb?.(null, [].concat(topic).map((t) => ({ topic: t, qos: 1 }))); },
          unsubscribe(t, cb) { c.unsubs.push(...[].concat(t)); cb?.(null); },
          publish(t, p, o, cb) { pubs.push({ topic: t, payload: p, opts: o }); cb?.(null); },
          removeAllListeners() { for (const k in handlers) delete handlers[k]; }, ended: null, end(force, o, cb) { c.ended = { force: !!force }; (typeof o === 'function' ? o : cb)?.(); } };
        globalThis.__clients.push(c); return c; } };`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ throw new Error("no") }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? `export const getDeviceIdSync=()=>"${DEVICE}";`
    : `let n = 0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(e){ globalThis.__idb.set(e.id, e) }
       export async function removeOutgoing(id){ globalThis.__idb.delete(id) }
       export async function loadAllOutgoing(){ return [...globalThis.__idb.values()] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const store = new Map();
globalThis.window = undefined;
globalThis.localStorage = { getItem: (k) => (k === 'aegis_device_id' ? DEVICE : store.get(k) ?? null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
console.warn = () => {}; console.error = () => {}; console.log = (...x) => process.stdout.write(x.join(' ') + '\n');
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));
const P = await load('presenceSecret');

const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(raw).toString('base64'), sign: (data) => new Uint8Array(edSign(null, Buffer.from(data), privateKey)) };
}
const me = keypair();
const friend = keypair();
const friend2 = keypair();
const ME = url(me.pk);
const sec = () => ({ s: new Uint8Array(crypto.randomBytes(32)), e: 1_800_000_000 });
const mine = sec();
const myTag = await P.presenceTag(mine);
const myTopic = P.presenceTopic(me.pk, myTag);
const fSec = sec();
const fTopic = P.presenceTopic(friend.pk, await P.presenceTag(fSec));
const f2Sec = sec();
const f2Topic = P.presenceTopic(friend2.pk, await P.presenceTag(f2Sec));
const secrets = new Map([[friend.pk, fSec], [friend2.pk, f2Sec]]);
const currentTopics = new Set([fTopic, f2Topic]);   // codec：每個好友目前的主題（舊的 tag 不算）

// codec（App 裡是 presenceService.codec）：只封我目前的主題；pending ＝ 正在換秘密
const codec = {
  pending: false,
  clearedTopics: [],
  async seal(topic, state) {
    if (!this.current(topic)) return null;
    return JSON.stringify(await P.sealPresence({ secret: mine, topic, state }));
  },
  current(topic) { return !this.pending && topic === myTopic; },
  async open(topic, payload) {
    const p = P.parsePresenceTopic(topic);
    const s = p && secrets.get(p.owner);
    if (!s) return null;
    try { return { owner: p.owner, state: await P.openPresence({ secret: s, topic, payload }) }; } catch { return null; }
  },
  cleared(topic) { this.clearedTopics.push(topic); return P.parsePresenceTopic(topic)?.owner !== undefined && secrets.has(P.parsePresenceTopic(topic).owner) && currentTopics.has(topic); },
};

const requests = [];
const serverSubscribe = (b) => [`mist/user/${url(b.pubkey)}/inbox/+`, ...b.groups.map((g) => `mist/group/${g}/+`), ...(b.presence ?? [])];
globalThis.fetch = async (u, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  requests.push({ url: String(u), body });
  return { ok: true, json: async () => ({ token: 'jwt-' + requests.length, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    username: url(body.pubkey), subscribe: serverSubscribe(body), serverTime: Math.floor(Date.now() / 1000) }) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connectAndAck(sessionPresent = false) {
  const before = globalThis.__clients.length;
  const p = svc.connect(me.pk);
  for (let i = 0; i < 200 && globalThis.__clients.length === before; i++) await sleep(5);
  const c = globalThis.__clients.at(-1);
  c.emit('connect', { cmd: 'connack', sessionPresent });
  await p;
  await sleep(30);
  return c;
}
const presencePubs = (c, topic = myTopic) => c.pubs.filter((p) => p.topic === topic);
const open = (payload, topic = myTopic) => P.openPresence({ secret: mine, topic, payload });


svc.setPresenceCodec(codec);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([], { tag: myTag, topics: [fTopic, f2Topic] }, me.pk);
const c = await connectAndAck();
const deliver = async (topic, payload, retain = false) => { c.emit('message', topic, Buffer.from(payload), { retain }); await sleep(20); };
const now = () => Date.now();
const friendSays = async (on, ts, cs, topic = fTopic, s = fSec) => JSON.stringify(await P.sealPresence({ secret: s, topic, state: { on, ts, cs } }));
const stat = (k) => svc.presenceStats()[k] ?? 0;

// ── 1. presenceClock ──
assert.equal(P.PRESENCE_MAX_CLOCK_SKEW_MS, 5 * 60_000);
assert.equal(P.presenceClock(1_000_000, 1234), 1_001_234, 'a small offset is used as is');
assert.equal(P.presenceClock(1_000_000, 10 * 3_600_000), 1_000_000 + 5 * 60_000, 'a large positive offset is capped');
assert.equal(P.presenceClock(10 * 3_600_000, -10 * 3_600_000), 10 * 3_600_000 - 5 * 60_000, 'a large negative offset is capped');
assert.equal(P.presenceClock(1_000_000, NaN), 1_000_000, 'a broken offset → device clock');
console.log('PASS presenceClock: device clock + the API offset, capped at ±5 minutes');

// ── 2. 慢一小時的 serverTime：一小時前錄下來的「在線」不算新鮮 ──
const HOUR = 3_600_000;
svc._clockOffsetMs = -HOUR;   // 營運方回的 serverTime 慢一小時（token 回應）
const before = stat('outOfOrder');
await deliver(fTopic, await friendSays(1, now() - HOUR + 20_000, now() - HOUR), true);   // 一小時前錄下來的「在線」
assert.equal(svc.isFriendOnline(friend.pk), false, 'an online recorded an hour ago is not fresh even when the API says it is an hour earlier');
assert.equal(stat('outOfOrder'), before + 1, 'it was refused by the ordering/freshness check');
// 營運方最多只撥得動 5 分鐘：錄下來 11 分鐘的不新鮮；9.5 分鐘的還算（＝ONLINE_FRESH_MS＋上限：最壞的情況是 10 分鐘內的重放）
await deliver(fTopic, await friendSays(1, now() - 11 * 60_000, now() - 11.5 * 60_000), true);
assert.equal(svc.isFriendOnline(friend.pk), false, 'an 11-minute-old online is not fresh with the hour-behind API');
assert.equal(stat('outOfOrder'), before + 2, 'refused: nothing older than ONLINE_FRESH_MS + the cap can look fresh');
await deliver(fTopic, await friendSays(1, now() - 9.5 * 60_000, now() - 10 * 60_000), true);
assert.equal(svc.isFriendOnline(friend.pk), true, 'a 9.5-minute-old one still passes: the worst case is bounded by 10 minutes (and by the TTL afterwards)');
svc._clockOffsetMs = 0;
await deliver(fTopic, await friendSays(0, now(), now() - 10 * 60_000), true);
assert.equal(svc.isFriendOnline(friend.pk), false);
console.log('PASS an API that turns the clock back an hour cannot make an hour-old online fresh; the replay window is at most 10 minutes');

// ── 2b. TTL 也照同一個時鐘：營運方把時鐘往回撥一小時，延長不了一個早就該過期的「在線」 ──
await deliver(fTopic, await friendSays(1, now(), now() - 1000), true);   // 他新的連線，剛剛在線
assert.equal(svc.isFriendOnline(friend.pk), true);
const realNow2 = Date.now;
Date.now = () => realNow2() + 20 * 60_000;   // 20 分鐘過去了，他沒再更新（遺囑被擋掉）
svc._clockOffsetMs = -HOUR;                   // API 說現在是一小時前
assert.equal(svc.isFriendOnline(friend.pk), false, 'the TTL runs on the bounded clock: a −1 h API offset does not keep a 20-minute-old online alive');
Date.now = realNow2;
svc._clockOffsetMs = 0;
await deliver(fTopic, await friendSays(0, now(), now() - 500), true);
console.log('PASS the online TTL uses the bounded clock too (an API offset cannot stretch it)');

// ── 3. 清掉主題之後重放同一個主題上更早的狀態 ──
const cs = now() - 120_000;
const t1 = await friendSays(1, now() - 60_000, cs, f2Topic, f2Sec);
const t2 = await friendSays(1, now() - 1_000, cs, f2Topic, f2Sec);
const off = await friendSays(0, now() - 500, cs, f2Topic, f2Sec);
await deliver(f2Topic, t1, true);
await deliver(f2Topic, t2, true);
await deliver(f2Topic, off, true);   // 他正常離線（同一條連線）
assert.equal(svc.isFriendOnline(friend2.pk), false);
await deliver(f2Topic, '', true);    // 營運方在他目前的主題上發一則空的（他沒有換秘密）
assert.equal(codec.clearedTopics.at(-1), f2Topic, 'the codec heard the clear (it asks him for a new secret)');
const refusedBefore = stat('outOfOrder');
await deliver(f2Topic, t1, true);    // 重放同一條連線、他離線之前的「在線」
await deliver(f2Topic, t2, true);
assert.equal(svc.isFriendOnline(friend2.pk), false, 'after a forged clear, replayed onlines from before his offline do not bring him back');
assert.equal(stat('outOfOrder'), refusedBefore + 2, 'both replays refused against the last state taken on that topic');
// 他真的新連上（cs 比較大）→ 照常採用
await deliver(f2Topic, await friendSays(1, now(), now() - 100, f2Topic, f2Sec), true);
assert.equal(svc.isFriendOnline(friend2.pk), true, 'a genuinely new connection is still taken');
console.log('PASS a forged clear does not reset the ordering: replays of older states on the same topic are refused');

// ── 4. 主題離開範圍、登出 → 那一份丟掉 ──
assert.ok(svc._presenceFloor.has(f2Topic) && svc._presenceFloor.has(fTopic));
svc.setAclScope([], { tag: myTag, topics: [fTopic] }, me.pk);
assert.ok(!svc._presenceFloor.has(f2Topic) && svc._presenceFloor.has(fTopic), 'a topic that left the scope forgets its last state (bounded by the scope)');
svc.disconnect();
assert.equal(svc._presenceFloor.size, 0, 'logout forgets them all');
console.log('PASS the per-topic last state is bounded by the scope and wiped on logout');

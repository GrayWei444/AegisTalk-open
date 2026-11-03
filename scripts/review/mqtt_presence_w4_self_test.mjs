/**
 * 好友之間的秘密 presence 在 mqtt.ts 這一層（W4）：真的 mqtt.ts／mqttCredential.ts／presenceSecret.ts，stub 掉 mqtt.js、IDB、fetch。
 *   1. token 請求沒有 peers（公鑰清單）；presence ＝ 確切的好友主題（萬用字元、只有公鑰的舊形狀不送），presence_tag ＝ 我的 tag
 *   2. 遺囑在 mist/user/<我>/presence/<tag> 上，payload 只有 {n, c}（沒有 from、沒有公鑰、沒有明文的上線與否），解開是「離線」；
 *      連上之後在同一個主題發 retained 的「在線」（同一個 cs）；正在換秘密（codec 不封）→ 不設遺囑、不發
 *   3. 好友的 presence 主題照範圍訂；範圍少了 → 退訂、不換 token；我的 tag 換了 → 換 token（250ms）
 *   4. 收：好友封的「在線」才算；營運方寫的明文 {online:true}、自己編的密文、搬到別的主題、太舊的「在線」→ 不算（推播不會被擋掉）；
 *      舊的 mist/user/<他>/presence 不再是 presence 主題（retained 也丟）
 *   5. 順序：舊連線晚到的遺囑不採用；同一條連線的離線採用；「在線」10 分鐘沒更新 → 自動變成離線（listener 收得到）
 *   6. 好友的主題被清掉（空的 retained）→ 當他離線、codec 收到通知；clearPresence 只發在我目前的主題上（空的 retained、等 PUBACK）
 *   7. 正常關閉時發封好的「離線」；登出時好友狀態清掉
 * Run: node scripts/review/mqtt_presence_w4_self_test.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'mqttpres-'));
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
svc.setAclScope([], { tag: myTag, topics: [fTopic, `mist/user/${url(friend2.pk)}/presence`, `mist/user/+/presence/${myTag}`, `${fTopic}/x`] }, me.pk);
let c = await connectAndAck();

// ── 1. token 請求 ──
const req = requests.at(-1).body;
assert.ok(!('peers' in req), 'no peers (public keys) in the token request');
assert.deepEqual(req.presence, [fTopic], 'only exact friend presence topics are sent');
assert.equal(req.presence_tag, myTag, 'my tag for the publish right');
console.log('PASS token request: no peers; exact friend presence topics only; my tag');

// ── 2. 遺囑與上線 ──
const will = c.options.will;
assert.ok(will, 'a will is set');
assert.equal(will.topic, myTopic, 'will on my secret presence topic');
assert.equal(will.retain, true);
assert.deepEqual(Object.keys(JSON.parse(will.payload)).sort(), ['c', 'n'], 'will payload is only {n, c}');
for (const leak of [me.pk, ME, 'from', 'online', 'presence']) assert.ok(!will.payload.includes(leak), `will does not carry ${leak}`);
const willState = await open(will.payload);
assert.equal(willState.on, 0, 'the will says offline');
assert.ok(willState.ts >= willState.cs && willState.ts - willState.cs < 2000, 'written at connect time');
const onPub = presencePubs(c);
assert.equal(onPub.length, 1, 'online published once on connect');
assert.deepEqual(onPub[0].opts, { qos: 1, retain: true });
const onState = await open(onPub[0].payload);
assert.equal(onState.on, 1);
assert.equal(onState.cs, willState.cs, 'same connection start as the will');
assert.ok(!c.pubs.some((p) => p.topic.endsWith('/presence')), 'nothing on the old key-only topic');
console.log('PASS will and online on mist/user/<me>/presence/<tag>, sealed {n, c} only, same connection start');

// ── 3. 訂閱照範圍 ──
assert.ok(c.subs.flat().includes(fTopic), 'friend presence topic subscribed');
assert.ok(!c.subs.flat().some((t) => /\/presence$/.test(t) || t.includes('+/presence')), 'no key-only or wildcard presence subscription');
const nTok = requests.length;
svc.setAclScope([], { tag: myTag, topics: [] }, me.pk);
await sleep(2300);
assert.equal(globalThis.__clients.at(-1), c, 'dropping a friend topic → no token swap');
assert.equal(requests.length, nTok);
assert.ok(c.unsubs.includes(fTopic), 'the dropped friend topic is unsubscribed');
svc.setAclScope([], { tag: myTag, topics: [fTopic, f2Topic] }, me.pk);
const cBeforeGrow = c;
await sleep(2300);   // 多了好友的主題：2 秒 debounce 後換 token（舊連線正常斷線，stub 馬上關）
c = globalThis.__clients.at(-1);
assert.notEqual(c, cBeforeGrow, 'a new friend topic the token lacks → token swap');
c.emit('connect', { cmd: 'connack', sessionPresent: true });
await sleep(30);
assert.deepEqual(requests.at(-1).body.presence, [fTopic, f2Topic].sort(), 'new token carries both friend topics');
assert.ok(c.subs.flat().includes(f2Topic), 'the new friend topic is subscribed after the swap');
assert.ok(cBeforeGrow.subs.flat().filter((t) => t === fTopic).length === 2, 'the other one was re-subscribed on the old connection when it came back into scope (the broker session keeps it)');
console.log('PASS presence subscriptions follow the scope (shrink: unsubscribe without a swap; grow: new token, then subscribe)');

// ── 4. 收：只有好友封的才算 ──
const changes = [];
svc.onPresenceChange((pk, on) => changes.push(`${pk === friend.pk ? 'F' : pk === friend2.pk ? 'G' : '?'}:${on}`));
await sleep(5);
changes.length = 0;
const deliver = async (topic, payload, retain = false) => { c.emit('message', topic, Buffer.from(payload), { retain }); await sleep(20); };
const now = () => Date.now();
const friendSays = async (on, ts, cs, topic = fTopic, s = fSec) => JSON.stringify(await P.sealPresence({ secret: s, topic, state: { on, ts, cs } }));
// cs ＝ ts 的狀態：時鐘只讀一次（以前寫 now(), now()，兩次之間跨過一毫秒就變成 cs > ts，sealPresence 拒絕 → 測試偶爾自己壞掉）
const friendSaysAt = (on, ts, topic, s) => friendSays(on, ts, ts, topic, s);
// 營運方：沒有好友的秘密
await deliver(fTopic, JSON.stringify({ type: 'presence', from: friend.pk, payload: { online: true }, timestamp: now() }), true);
const craft = (key) => {
  const iv = crypto.randomBytes(12); const ci = crypto.createCipheriv('aes-256-gcm', key, iv); ci.setAAD(Buffer.from(fTopic));
  const ct = Buffer.concat([ci.update(JSON.stringify({ on: 1, ts: now(), cs: now() })), ci.final(), ci.getAuthTag()]);
  return JSON.stringify({ n: iv.toString('base64'), c: ct.toString('base64') });
};
await deliver(fTopic, craft(crypto.randomBytes(32)), true);
await deliver(fTopic, craft(Buffer.alloc(32)), true);
await deliver(fTopic, await friendSaysAt(1, now(), f2Topic, f2Sec));                 // friend2 的密文搬到 friend 的主題
await deliver(fTopic, await friendSaysAt(1, now() - 6 * 60_000));                    // 太舊的「在線」（重放）
await deliver(`mist/user/${url(friend.pk)}/presence`, JSON.stringify({ type: 'presence', from: friend.pk, payload: { online: true }, timestamp: now() }), true);
assert.equal(svc.isFriendOnline(friend.pk), false, 'forged, moved, stale or old-form presence does not make the friend online');
assert.deepEqual(changes, [], 'and no listener fired');
const cs1 = now() - 30_000;
await deliver(fTopic, await friendSays(1, now(), cs1), true);
assert.equal(svc.isFriendOnline(friend.pk), true, 'a sealed online from the friend is accepted');
assert.deepEqual(changes, ['F:true']);
console.log('PASS only the friend\'s sealed state counts: operator plaintext, crafted ciphertext, moved, stale and old-form presence are ignored');

// ── 5. 順序與 TTL ──
await deliver(fTopic, await friendSays(0, cs1 - 60_000, cs1 - 60_000));                 // 上一條連線晚到的遺囑
assert.equal(svc.isFriendOnline(friend.pk), true, 'a late will of an older connection is ignored');
await deliver(fTopic, await friendSays(0, cs1, cs1));                                    // 這一條連線的遺囑
assert.equal(svc.isFriendOnline(friend.pk), false, 'the will of the current connection is taken');
await deliver(fTopic, await friendSays(1, now(), cs1));                                  // 離線之後才到的同一條連線的上線（重放）
assert.equal(svc.isFriendOnline(friend.pk), false, 'online of a connection after its own offline is ignored');
assert.deepEqual(changes, ['F:true', 'F:false']);
// TTL：好友的「在線」10 分鐘沒更新（遺囑被擋掉）→ 自己變成離線、listener 收得到（本機時鐘往後撥 —— W5 起 presence 的時鐘最多只照
//   API 的時鐘差撥 5 分鐘，見 mqtt_presence_w5_self_test，所以這裡撥的是 Date.now）
await deliver(f2Topic, await friendSays(1, now(), now() - 10, f2Topic, f2Sec));
assert.equal(svc.isFriendOnline(friend2.pk), true);
changes.length = 0;
const realDateNow = Date.now;
Date.now = () => realDateNow() + P.ONLINE_TTL_MS + 1000;
assert.equal(svc.isFriendOnline(friend2.pk), false, 'no refresh for 10 minutes → no longer online (pushes are sent again)');
svc._armPresenceExpiry();
await sleep(150);
assert.deepEqual(changes, ['G:false'], 'the listener hears the expiry');
Date.now = realDateNow;
await deliver(f2Topic, await friendSaysAt(1, now(), f2Topic, f2Sec));   // 他又更新了（新的連線）
assert.equal(svc.isFriendOnline(friend2.pk), true);
console.log('PASS ordering: a late will of an older connection and a replayed online after offline are ignored; online expires after the TTL');

// ── 6. 清掉的主題、clearPresence ──
changes.length = 0;
await deliver(f2Topic, '', true);
assert.equal(svc.isFriendOnline(friend2.pk), false, 'an emptied (cleared) friend topic → offline');
assert.deepEqual(codec.clearedTopics, [f2Topic], 'the codec is told (it asks the friend for the new secret)');
assert.deepEqual(changes, ['G:false']);
// 好友舊主題（舊的 tag）上的空訊息（我還留著舊的訂閱、或營運方塞的）：不動他現在的狀態（審查 W4 #8）
await deliver(fTopic, await friendSays(1, now(), now() - 10));   // 他的新連線
assert.equal(svc.isFriendOnline(friend.pk), true);
const fOld = P.presenceTopic(friend.pk, await P.presenceTag({ s: fSec.s, e: fSec.e - 1 }));
await deliver(fOld, '', true);
assert.equal(svc.isFriendOnline(friend.pk), true, 'an empty message on an old topic of the friend does not wipe his current state');
changes.length = 0;
const before = c.pubs.length;
assert.equal(await svc.clearPresence(fTopic), false, 'cannot clear somebody else\'s topic');
assert.equal(await svc.clearPresence(`mist/user/${ME}/presence/${'Z'.repeat(22)}`), false, 'cannot clear a topic the token cannot publish');
assert.equal(c.pubs.length, before, 'nothing published for those');
assert.equal(await svc.clearPresence(myTopic), true, 'my current topic is cleared (PUBACK)');
assert.deepEqual(c.pubs.at(-1), { topic: myTopic, payload: '', opts: { qos: 1, retain: true } }, 'an empty retained message');
// 收件箱上的 retained 照樣丟（只有確切的 presence 主題可以 retained）
const got = [];
svc.onMessage('profile_request', (m) => got.push(m.from));
c.emit('message', `mist/user/${ME}/inbox/${url(friend.pk)}`, Buffer.from(JSON.stringify({ type: 'profile_request', from: friend.pk, payload: {}, timestamp: now() })), { retain: true });
assert.deepEqual(got, [], 'retained on the inbox still dropped');
console.log('PASS a cleared friend topic marks him offline and tells the codec; clearPresence only on my current topic (empty retained)');

// ── 2b. 換秘密的中途：不設遺囑、不發上線；tag 換了 → 換 token ──
codec.pending = true;
const nT = requests.length;
const newTag = 'N'.repeat(22);
svc.setAclScope([], { tag: newTag, topics: [fTopic, f2Topic] }, me.pk);
await sleep(1900);   // tag 換了：250ms 後換 token（舊連線正常斷線最多等 1.5 秒）
assert.equal(requests.length, nT + 1, 'a tag change swaps the token');
assert.equal(requests.at(-1).body.presence_tag, newTag);
const c2 = globalThis.__clients.at(-1);
assert.notEqual(c2, c);
assert.equal(c2.options.will, undefined, 'no will while the codec will not seal (rotation pending)');
c2.emit('connect', { cmd: 'connack', sessionPresent: true });
await sleep(30);
assert.ok(!c2.pubs.some((p) => p.topic.includes('/presence/')), 'no presence published while the codec will not seal');
console.log('PASS while a rotation is pending: no will, no online; a tag change swaps the token');

// ── 7. 正常關閉、登出 ──
codec.pending = false;
svc.setAclScope([], { tag: myTag, topics: [fTopic, f2Topic] }, me.pk);
await sleep(1900);
const c3 = globalThis.__clients.at(-1);
c3.emit('connect', { cmd: 'connack', sessionPresent: true });
await sleep(30);
c = c3;
await deliver(fTopic, await friendSaysAt(1, now()));
assert.equal(svc.isFriendOnline(friend.pk), true);
// 好友的主題離開範圍（刪好友）→ 他的狀態丟掉、通知一次離線
const offs = [];
const offL = svc.onPresenceChange((pk, on) => { if (pk === friend.pk) offs.push(on); });
await sleep(5);
offs.length = 0;
svc.setAclScope([], { tag: myTag, topics: [f2Topic] }, me.pk);
assert.equal(svc.isFriendOnline(friend.pk), false, 'a friend whose topic left the scope is no longer online');
assert.deepEqual(offs, [false], 'and the listener hears it');
offL();
await svc.gracefulShutdown(500);
const last = c3.pubs.filter((p) => p.topic === myTopic).at(-1);
assert.equal((await open(last.payload)).on, 0, 'graceful shutdown publishes a sealed offline');
assert.deepEqual(last.opts, { qos: 1, retain: true });
assert.deepEqual(c3.ended, { force: true }, 'after a sealed offline the socket is closed as before (the will is the fallback)');
// 正在換秘密時進背景：舊秘密封的遺囑不能讓 broker 發在（已經清掉的）舊主題上 → 正常斷線（DISCONNECT，沒有遺囑；審查 W4 #6）
const c4 = await connectAndAck(true);
codec.pending = true;
const before4 = c4.pubs.length;
await svc.gracefulShutdown(300);
assert.equal(c4.pubs.length, before4, 'nothing published on the old topic');
assert.deepEqual(c4.ended, { force: false }, 'a clean DISCONNECT, so the broker does not publish the old will');
codec.pending = false;
// 封的那段 await 裡剛開始換秘密（審查 W4 #6）：封好了也不發在舊主題上
const c5 = await connectAndAck(true);
let releaseSeal = null;
const realSeal = codec.seal;
codec.seal = async function (topic, state) {
  const out = await realSeal.call(this, topic, state);
  await new Promise((r) => { releaseSeal = r; });
  return out;
};
const before5 = presencePubs(c5).length;
const publishing = svc._publishPresence(1);
for (let i = 0; i < 200 && !releaseSeal; i++) await sleep(5);
assert.ok(releaseSeal, 'the seal is in flight');
codec.pending = true;
releaseSeal();
await publishing;
assert.equal(presencePubs(c5).length, before5, 'a seal that finished after a rotation started is not published on the old topic');
codec.seal = realSeal;
codec.pending = false;
svc.disconnect();
assert.equal(svc.isFriendOnline(friend.pk), false, 'logout forgets friend presence');
console.log('PASS graceful shutdown publishes a sealed offline; logout forgets friend presence');

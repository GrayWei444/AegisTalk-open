/**
 * DIRECT_SEALED 的 App 這一層（開源第 4 步，services/directSignal.ts）：真的 directSignal.ts／directSeal.ts／identitySeal.ts／
 * peerBudget.ts，mqtt 換成記錄器、身分換成 Node crypto（groupKeyDelivery 的 currentSealer）。
 *   1. 送：封好、型別 direct_sealed；transient 的不排隊、ttlMs 照給的（通話 60 秒）、其他 24 小時；同一個收件人照呼叫的順序送
 *      （審查 M2：以前兩則同時封、先封好的先上 broker，通話的 seq 倒退被丟）
 *   2. 收：好友封的 → 交給那一種的 handler（body 帶 from／iat／nonce）；收件人不是我 → 丟
 *   3. 營運方／Mallory：用自己的金鑰簽、寫成 from＝Alice → bad-envelope，不交給 handler；Mallory 自己的身分 → 他只能送 dc（陌生人），
 *      call／profile／prekey／delete 一律丟（不會響、不會改名、不會叫我重建 session、不會刪我的訊息）
 *   4. 重放：錄下來的信封再塞一次 → 丟；個人資料舊的晚到 → 丟；重開之後重放剛才的來電 → 丟（request 的 iat 記錄存著）
 *   5. 封鎖的人寄的不拆；封鎖名單查不了也不拆（審查 L5）；陌生人有額度（一次建線夠用、灌不爆）
 *   6. 同一個寄件人一則一則依序處理（offer 拆得慢，後面的 ICE 也不會先到 handler）；handler 還沒註冊的先收著、註冊時補交
 * Run: node scripts/review/direct_signal_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, verify, x25519 } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'directsig-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
globalThis.__ds = { listeners: {}, sent: [], transient: [], server: () => Date.now(), bounded: () => Date.now(), sealer: null, verify, x25519, connected: true };
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/groupKeyDelivery$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path === './mqtt'
    ? `export const MessageType = { DIRECT_SEALED: 'direct_sealed' };
       const g = globalThis.__ds;
       export const mqttService = {
         onMessage(t, f) { (g.listeners[t] ??= new Set()).add(f); return () => g.listeners[t].delete(f); },
         sendToUser(to, type, payload, opts) { g.sent.push({ to, type, payload, opts }); },
         sendTransientToUser(to, type, payload) { g.transient.push({ to, type, payload }); g.log?.push('publish'); return g.connected; },
         serverNow: () => g.server(), boundedNow: () => g.bounded(),
       };`
    : `const g = globalThis.__ds;
       export const currentSealer = () => g.sealer;
       export const verify = (...a) => g.verify(...a);
       export const x25519 = { generateX25519: () => g.x25519.generateX25519(), x25519: (p, q) => g.x25519.x25519(p, q) };` }));
} };
await require('esbuild').build({
  stdin: { contents: "export * from './directSignal'; export { edSeedToX25519Scalar } from './identitySeal';", resolveDir: SRC + '/services', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'sig.mjs'), logLevel: 'silent', plugins: [stub] });
const S = await import(pathToFileURL(join(dir, 'sig.mjs')));
console.error = () => {};
const g = globalThis.__ds;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const A = identity(), B = identity(), M = identity(), Z = identity();
const sealerOf = (id) => ({ me: id.pk, sign: id.sign, x25519Private: S.edSeedToX25519Scalar(new Uint8Array(id.seed)) });
const as = (id) => { g.sealer = sealerOf(id); };
/** id 封一則給 to（App 真的 sendDirect），回傳 MQTT 訊息（{ type, from, to, payload, timestamp }） */
async function sealFrom(id, to, body, opts = {}) {
  const prev = g.sealer;
  as(id);
  g.sent.length = 0; g.transient.length = 0;
  assert.equal(await S.sendDirect(to.pk, body, opts), true);
  g.sealer = prev;                                   // 收件那邊（Bob）正在拆的不受影響
  const out = [...g.sent, ...g.transient][0];
  return { type: out.type, from: id.pk, to: out.to, payload: out.payload, timestamp: Date.now() };
}
/** 等到 cond 成立（收件是 async：拆封、等身分；最多 3 秒） */
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await tick(10);
  return cond();
}
const deliver = (msg) => { for (const f of g.listeners.direct_sealed ?? []) f(msg); };

// 1
await sealFrom(A, B, { kind: 'call', sig: 'offer', callId: 'C'.repeat(22), seq: 2, data: { type: 'offer', sdp: 'x' } }, { transient: true });
await sealFrom(A, B, { kind: 'call', sig: 'request', callId: 'C'.repeat(22), seq: 1 }, { ttlMs: S.CALL_CONTROL_TTL_MS });
as(A); g.sent.length = 0; g.transient.length = 0;
await S.sendDirect(B.pk, { kind: 'dc', sig: 'ice', pc: 'pc-1', data: {} }, { transient: true });
await S.sendDirect(B.pk, { kind: 'call', sig: 'end', callId: 'C'.repeat(22), seq: 3 }, { ttlMs: S.CALL_CONTROL_TTL_MS });
await S.sendProfileUpdate(B.pk, { displayName: 'Ann', avatar: '' });
await S.sendPrekeyRequest(B.pk, { signedPreKey: 'spk', signature: 'sig' });
await S.sendDeleteMessage(B.pk, 'msg-1');
assert.equal(g.transient.length, 1, 'media signalling goes out only while connected (not queued)');
assert.deepEqual(g.sent.map((x) => [x.type, x.opts?.ttlMs]), [['direct_sealed', 60_000], ['direct_sealed', 86_400_000], ['direct_sealed', 86_400_000], ['direct_sealed', 86_400_000]],
  'call control queued for at most 60 s; profile / prekey / delete for 24 h');
assert.ok([...g.sent, ...g.transient].every((x) => Object.keys(x.payload).sort().join() === 'ct,ek,n,v'), 'every one is an identity-sealed envelope');
g.sealer = null;
assert.equal(await S.sendDirect(B.pk, { kind: 'profile', displayName: 'x' }), false, 'no unlocked identity → nothing sent');
// 同一個收件人照呼叫的順序：第二則等第一則上了 broker 才開始封（不然封得快的那則先送）
as(A);
g.log = [];
const realSign = g.sealer.sign;
g.sealer = { ...g.sealer, sign: (d) => { g.log.push('sign'); return realSign(d); } };
await Promise.all([
  S.sendDirect(B.pk, { kind: 'dc', sig: 'offer', pc: 'pc-1', data: { type: 'offer', sdp: 'x'.repeat(40_000) } }, { transient: true }),
  S.sendDirect(B.pk, { kind: 'dc', sig: 'ice', pc: 'pc-1', data: { candidate: 'c' } }, { transient: true }),
  S.sendDirect(B.pk, { kind: 'dc', sig: 'ice', pc: 'pc-1', data: { candidate: 'd' } }, { transient: true }),
]);
assert.deepEqual(g.log, ['sign', 'publish', 'sign', 'publish', 'sign', 'publish'], 'one recipient\'s messages are sealed and published one after another');
g.log = null;
g.sealer = null;
console.log('PASS sending: one sealed type; transient / 60 s / 24 h as asked; per-recipient order kept');

// 2 Bob 收
const friends = new Set([A.pk]);
const blocked = new Set();
const store = new Map();
const marks = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
const got = [];
const handlerFor = (kind) => (from, body) => { got.push({ kind, from, body }); };
const offs = ['call', 'dc', 'profile', 'prekey', 'delete'].map((k) => S.onDirect(k, handlerFor(k)));
const startBob = () => {
  as(B);
  return S.startDirectSignal({ me: B.pk, storedIdentity: async (pk) => (friends.has(pk) ? pk : null), isBlocked: async (pk) => blocked.has(pk), marks });
};
let stop = startBob();
const req = await sealFrom(A, B, { kind: 'call', sig: 'request', callId: 'C'.repeat(22), seq: 1, video: false });
as(B);
deliver(req);
await until(() => got.length > 0);
assert.equal(got.length, 1, 'a friend\'s sealed call request reaches the call handler');
assert.equal(got[0].from, A.pk);
assert.equal(got[0].body.sig, 'request');
assert.ok(typeof got[0].body.nonce === 'string' && typeof got[0].body.iat === 'number');
deliver({ ...req, to: Z.pk });
await tick(20);
assert.equal(got.length, 1, 'a message addressed to someone else is dropped');
console.log('PASS a friend\'s sealed signal reaches its handler with the verified sender');

// 3 營運方／Mallory
got.length = 0;
const forged = await sealFrom(M, B, { kind: 'call', sig: 'offer', callId: 'C'.repeat(22), seq: 9, data: { type: 'offer', sdp: 'evil' } });
as(B);
deliver({ ...forged, from: A.pk });                       // 營運方把 Mallory 簽的那封寫成 from＝Alice
await tick(30);
assert.equal(got.length, 0, 'an envelope signed by Mallory but labelled from=Alice is not delivered');
assert.ok((S.directStats()['bad-envelope'] ?? 0) >= 1, 'counted as bad-envelope');
for (const body of [{ kind: 'call', sig: 'request', callId: 'M'.repeat(22), seq: 1 }, { kind: 'profile', displayName: 'Mallory' },
  { kind: 'prekey' }, { kind: 'delete', messageId: 'm' }]) {
  const m = await sealFrom(M, B, body);
  as(B);
  deliver(m);
}
await tick(40);
assert.deepEqual(got, [], 'Mallory (not a friend) cannot ring me, rename anyone, trigger a session reset or delete my messages');
const dc = await sealFrom(M, B, { kind: 'dc', sig: 'offer', pc: 'pc-m', data: { type: 'offer', sdp: 'x' } });
as(B);
deliver(dc);
await until(() => got.length > 0);
assert.deepEqual(got.map((x) => [x.kind, x.from]), [['dc', M.pk]], 'a stranger\'s data-channel offer is passed on (webrtc decides: group-key proof or held, see webrtc_held_offer)');
console.log('PASS forged signatures are dropped; a stranger can only reach the data-channel gate');

// 4 重放
got.length = 0;
deliver(req);
await tick(30);
assert.equal(got.length, 0, 'a recorded envelope replayed by the operator is dropped');
const newer = await sealFrom(A, B, { kind: 'profile', displayName: 'Ann (new)' });
await tick(5);
const older = await sealFrom(A, B, { kind: 'profile', displayName: 'Ann (old)' });   // 封得較晚、但 iat 往前撥（下面）
older.payload = (await (async () => { as(A); const realNow = g.server; g.server = () => Date.now() - 60_000;
  g.sent.length = 0; await S.sendProfileUpdate(B.pk, { displayName: 'Ann (old)' }); g.server = realNow; return g.sent[0].payload; })());
as(B);
deliver(newer);
deliver(older);
await until(() => got.length > 0);
await tick(150);
assert.deepEqual(got.map((x) => x.body.displayName), ['Ann (new)'], 'an older profile arriving later cannot roll the name back');
stop();
got.length = 0;
stop = startBob();                                         // 重開 App：nonce 表是新的，profile 的順序還記得
deliver(newer);
await tick(30);
assert.equal(got.length, 0, 'after a restart the same profile is still refused (persisted per-sender mark)');
deliver(req);
await tick(30);
assert.equal(got.length, 0, 'after a restart the operator replays the call request from a minute ago: the phone does not ring again');
assert.ok((S.directStats()['out-of-order:call'] ?? 0) >= 1, 'refused by the persisted call-request mark');
console.log('PASS replays dropped; out-of-order profile updates and call requests dropped, also after a restart');

// 5 封鎖、陌生人額度
got.length = 0;
blocked.add(A.pk);
const fromBlocked = await sealFrom(A, B, { kind: 'call', sig: 'request', callId: 'D'.repeat(22), seq: 1 });
as(B);
const badBefore = S.directStats()['bad-envelope'] ?? 0;
deliver(fromBlocked);
await tick(30);
assert.equal(got.length, 0, 'a blocked contact\'s envelope is not even opened');
assert.ok((S.directStats().blocked ?? 0) >= 1);
blocked.delete(A.pk);
stop();
stop = S.startDirectSignal({ me: B.pk, storedIdentity: async (pk) => (friends.has(pk) ? pk : null),
  isBlocked: async () => { throw new Error('db not ready'); }, marks });
const whenBroken = await sealFrom(A, B, { kind: 'call', sig: 'request', callId: 'E'.repeat(22), seq: 1 });
as(B);
deliver(whenBroken);
await tick(30);
assert.equal(got.length, 0, 'the block list cannot be read → treated as blocked (not opened)');
stop();
stop = startBob();
const floods = [];
for (let i = 0; i < 80; i++) floods.push(await sealFrom(M, B, { kind: 'dc', sig: 'ice', pc: 'pc-m', data: { i } }));
as(B);
for (const f of floods) deliver(f);
await until(() => got.length >= 40, 2000);
await tick(300);
assert.ok(got.length >= 30, `a stranger (a group member my roster has not caught up with) gets enough for one connection setup (${got.length})`);
assert.ok(got.length <= 42, `but a flood is cut by the stranger budget (${got.length} of 80 opened)`);
assert.equal(S.directStats()['bad-envelope'] ?? 0, badBefore, 'nothing else went wrong');
console.log(`PASS blocked senders (or an unreadable block list) are not opened; a stranger flood is budgeted (${got.length}/80)`);

// 6 依序、先收著
stop();
for (const off of offs) off();
got.length = 0;
const order = [];
S.onDirect('dc', (from, body) => { order.push(body.sig); });
stop = startBob();
const o1 = await sealFrom(A, B, { kind: 'dc', sig: 'offer', pc: 'pc-a', data: { type: 'offer', sdp: 'x'.repeat(30_000) } });
const i1 = await sealFrom(A, B, { kind: 'dc', sig: 'ice', pc: 'pc-a', data: { candidate: 'c' } });
const f1 = await sealFrom(A, B, { kind: 'dc', sig: 'fp', pc: 'pc-a', rpc: 'pc-b', data: {} });
as(B);
deliver(o1); deliver(i1); deliver(f1);
await until(() => order.length >= 3);
assert.deepEqual(order, ['offer', 'ice', 'fp'], 'one sender\'s messages reach the handler in the order they arrived');
const early = await sealFrom(A, B, { kind: 'prekey', signedPreKey: 's', signature: 'g' });
as(B);
deliver(early);
await until(() => (S.directStats()['ok:prekey'] ?? 0) > 0);
const late = [];
S.onDirect('prekey', (from, body) => late.push([from, body.signedPreKey]));
await until(() => late.length > 0);
assert.deepEqual(late, [[A.pk, 's']], 'a message that arrived before its handler registered is handed over when it does');
stop();
console.log('PASS per-sender order kept; early arrivals wait for their handler');

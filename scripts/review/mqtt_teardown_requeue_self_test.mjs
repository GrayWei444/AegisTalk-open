/**
 * 拆線時還沒等到 PUBACK 的 durable 訊息要放回待送佇列（稽核 M7，對應群星 P1-4）：真的 mqtt.ts，stub 掉 mqtt.js 與 IDB。
 *   加好友／群組信封（邀請、金鑰；GROUP_KEY_SEALED）等 PUBACK 才從 IDB 刪，送出時記在 inflight。
 *   但 clean:false 時 mqtt.js `end(true)` 不會回呼 publish callback：殭屍連線 90 秒後 forceReconnect、
 *   App 進背景 gracefulShutdown，client 一丟，這些訊息就永遠停在 inflight，
 *   `_loadPersistedQueue` 也因為 id 還在 inflight 而跳過 → 直到 App 重啟都不會補送。
 *   現在：_teardown 把沒確認的放回待送佇列，下次連上重送；舊 client 晚到的回呼不會造成重複；
 *   disconnect()（登出／換機取消）清空記憶體佇列，不帶到下一個帳號。
 * Run: node scripts/review/mqtt_teardown_requeue_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttrequeue-'));
const idb = globalThis.__idb = { put: [], removed: [], rows: new Map() };
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no") } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : `let n=0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(e){ globalThis.__idb.put.push(e.id); globalThis.__idb.rows.set(e.id, e); }
       export async function removeOutgoing(id){ globalThis.__idb.removed.push(id); globalThis.__idb.rows.delete(id); }
       export async function loadAllOutgoing(){ return [...globalThis.__idb.rows.values()] }` }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
console.warn = () => {}; console.error = () => {};
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));
const wait = () => new Promise((r) => setTimeout(r, 20));

const published = [];
const fakeClient = () => ({ connected: true, publish: (topic, payload, opts, cb) => published.push({ topic, payload, cb }),
  subscribe() {}, unsubscribe() {}, removeAllListeners() {}, on() {}, end() {} });   // end() 不回呼 callback（clean:false）
svc.client = fakeClient();
svc.publicKeyBase64 = 'A'.repeat(44);
const B = 'B'.repeat(43) + '=';

svc.sendToUser(B, MessageType.X3DH_INIT, { hello: 1 });
await wait();
assert.equal(published.length, 1, 'friend-add published, waiting for PUBACK');
const oldCallback = published[0].cb;

svc._teardown();                                  // 殭屍連線 → forceReconnect
assert.equal(svc.outgoingQueue.length, 1, 'an unacknowledged durable message goes back to the send queue on teardown');

await svc._loadPersistedQueue();                  // 下次 connect 會先載 IDB
assert.equal(svc.outgoingQueue.length, 1, 'reloading from IDB does not duplicate it');

published.length = 0;
svc.client = fakeClient();                        // 新連線
svc._flushOutgoingQueue();
assert.equal(published.length, 1, 'it is re-sent on the next connection');

oldCallback(new Error('client discarded'));       // 舊 client 晚到的失敗回呼
assert.equal(svc.outgoingQueue.length, 0, 'a late callback from the discarded client does not queue a duplicate');

published[0].cb(null);                            // 新連線的 PUBACK
await wait();
assert.equal(idb.rows.size, 0, 'removed from IDB once the broker acknowledges it');
console.log('PASS unacknowledged durable messages survive a reconnect without waiting for an app restart');

// 登出／換帳號：記憶體裡的待送訊息不帶到下一個帳號
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { n: 'bye' });
await wait();
assert.equal(svc._inflight.size, 1, 'the sealed group envelope is waiting for PUBACK');
svc.disconnect();
assert.equal(svc.outgoingQueue.length, 0, 'user-initiated disconnect drops the in-memory queue');
console.log('PASS user-initiated disconnect does not carry the queue to the next account');

// 信令不重送（開源第 4 步：1 對 1 的信令都是 DIRECT_SEALED，種類在密文裡 —— offer／ICE 不排隊（sendTransientToUser），
//   通話控制排隊時帶 ttlMs ≤ 60 秒）：離線時排入的通話控制在重連後送出、PUBACK 前又拆線 → 不放回
svc.publicKeyBase64 = 'A'.repeat(44);             // 上一段 disconnect() 清掉了
idb.rows.clear(); svc.outgoingQueue = []; published.length = 0;
svc.client = { ...fakeClient(), connected: false };
assert.equal(svc.sendTransientToUser(B, MessageType.DIRECT_SEALED, { v: 1, ek: 'offer' }), false, 'an offer is not queued while offline');
assert.equal(svc.outgoingQueue.length, 0);
svc.sendToUser(B, MessageType.DIRECT_SEALED, { v: 1, ek: 'call-control' }, { ttlMs: 60_000 });
await wait();
assert.equal([...idb.rows.values()][0]?.ttlMs, 60_000, 'the queue entry remembers how long it may wait (local only)');
assert.ok(!JSON.parse([...idb.rows.values()][0].payload).ttlMs, 'and the wire message does not carry it');
svc.client = fakeClient();
svc._flushOutgoingQueue();
assert.equal(published.length, 1, 'the queued call control is flushed on reconnect');
svc._teardown();
await wait();
assert.equal(svc.outgoingQueue.length, 0, 'unacknowledged signalling is not put back on teardown');
await svc._loadPersistedQueue();
assert.equal(svc.outgoingQueue.length, 0, 'and is not reloaded from IDB on the next connect');
console.log('PASS stale signalling is not re-sent after a reconnect');

// 順序：先送的信封（例如金鑰索取）還沒確認就拆線，之後排入的（例如回覆的金鑰）不能跑到它前面
idb.rows.clear(); svc.outgoingQueue = []; published.length = 0;
svc.client = fakeClient();
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { n: 'first' });
svc.client.connected = false;                     // socket 已死、health monitor 還沒拆線
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { n: 'second' });
svc._teardown();
const order = () => svc.outgoingQueue.map((m) => JSON.parse(m.payload).payload.n);
assert.deepEqual(order(), ['first', 'second'], 'the older message is re-sent first');
await svc._loadPersistedQueue();
assert.deepEqual(order(), ['first', 'second'], 'reloading from IDB keeps the order');
console.log('PASS re-sent messages keep their original order');

// 佇列滿了先丟即時型別：拆線放回的群組信封不能被之後離線排的 200 個 ICE 擠掉（對應 AegisPlay 19b17dac，第二輪審查 M3）
idb.rows.clear(); svc.outgoingQueue = []; published.length = 0;
svc.client = fakeClient();
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { n: 'sealed' });
svc._teardown();
svc.client = { ...fakeClient(), connected: false };
for (let i = 0; i < 220; i++) svc.sendToUser(B, MessageType.DIRECT_SEALED, { v: 1, ek: 'call-control-' + i }, { ttlMs: 60_000 });
await wait();
assert.ok(svc.outgoingQueue.some((m) => JSON.parse(m.payload).type === MessageType.GROUP_KEY_SEALED),
  'the durable message survives an overflow of signalling');
assert.ok([...idb.rows.values()].some((m) => JSON.parse(m.payload).type === MessageType.GROUP_KEY_SEALED), 'also in IndexedDB');
console.log('PASS a full queue drops signalling before durable messages');

// 沒有即時型別時先丟一般訊息：離線改幾次暱稱（每個好友一則封好的個人資料）不能擠掉群組信封（對應 AegisPlay 27179ddb）
idb.rows.clear(); svc.outgoingQueue = []; published.length = 0;
svc.client = fakeClient();
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { n: 'sealed' });
svc._teardown();
svc.client = { ...fakeClient(), connected: false };
for (let i = 0; i < 220; i++) svc.sendToUser(B, MessageType.DIRECT_SEALED, { v: 1, ek: 'profile-' + i });
await wait();
assert.ok(svc.outgoingQueue.some((m) => JSON.parse(m.payload).type === MessageType.GROUP_KEY_SEALED),
  'the durable message survives an overflow of ordinary messages');
console.log('PASS a full queue drops ordinary messages before durable ones');

// 離線排超過 1 分鐘的即時型別不送（對方早就放棄那次連線／來電）
idb.rows.clear(); svc.outgoingQueue = []; published.length = 0;
const realNow = Date.now;
Date.now = () => realNow() - 120_000;
svc.sendToUser(B, MessageType.DIRECT_SEALED, { v: 1, ek: 'call-request' }, { ttlMs: 60_000 });
svc.sendToUser(B, MessageType.X3DH_INIT, { hello: 'old' });
Date.now = realNow;
await wait();
svc.client = fakeClient();
svc._flushOutgoingQueue();
assert.deepEqual(published.map((p) => JSON.parse(p.payload).type), [MessageType.X3DH_INIT], 'a 2-minute-old call request is dropped, the friend request is sent');
console.log('PASS stale real-time messages are not sent after a long offline period');

// 別的帳號留在 IndexedDB 的待送訊息（清除帳號時 IDB 一時打不開）不載入、刪掉（第二輪審查 L5）
idb.rows.clear(); svc.outgoingQueue = []; svc._inflight.clear();
idb.rows.set('foreign', { id: 'foreign', topic: 't', qos: 1, timestamp: realNow(), payload: JSON.stringify({ type: 'x3dh_init', from: 'Z'.repeat(44) }) });
idb.rows.set('mine', { id: 'mine', topic: 't', qos: 1, timestamp: realNow(), payload: JSON.stringify({ type: 'x3dh_init', from: 'A'.repeat(44) }) });
await svc._loadPersistedQueue();
await wait();
assert.deepEqual(svc.outgoingQueue.map((m) => m.id), ['mine'], 'only this account\'s queued messages are loaded');
assert.ok(!idb.rows.has('foreign'), 'and the other account\'s entry is deleted');
console.log('PASS queued messages left by another account are not sent');

// 同一個人排了好幾封加好友（X3DH_INIT）：只留最新那封（部署前審查 LOW）。離線時重掃幾次 QR，以前重連後全部依序送出，
//   對方每收一封就清一次 session、待送訊息與 WebRTC，最後才停在最新那封
const C = 'C'.repeat(43) + '=';
idb.rows.clear(); svc.outgoingQueue = []; svc._inflight.clear(); published.length = 0;
svc.client = { ...fakeClient(), connected: false };
svc.sendToUser(B, MessageType.X3DH_INIT, { n: 1 });
svc.sendToUser(C, MessageType.X3DH_INIT, { n: 2 });
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { groupId: 'g' });
svc.sendToUser(B, MessageType.X3DH_INIT, { n: 3 });
await wait();
const queued = () => svc.outgoingQueue.map((m) => { const p = JSON.parse(m.payload); return [p.type, p.payload.n ?? p.payload.groupId]; });
assert.deepEqual(queued(), [[MessageType.X3DH_INIT, 2], [MessageType.GROUP_KEY_SEALED, 'g'], [MessageType.X3DH_INIT, 3]],
  'an older queued X3DH_INIT to the same person is dropped when a newer one is queued; other people and other types stay');
assert.equal([...idb.rows.values()].filter((m) => JSON.parse(m.payload).type === MessageType.X3DH_INIT).length, 2, 'also removed from IndexedDB');
// App 重開：IDB 裡留著同一個人的兩封 → 載回時只留最新
idb.rows.clear(); svc.outgoingQueue = [];
const row = (id, ts, n) => ({ id, topic: 'inbox-B', qos: 1, timestamp: ts, payload: JSON.stringify({ type: MessageType.X3DH_INIT, from: 'A'.repeat(44), payload: { n } }) });
idb.rows.set('old', row('old', realNow() - 5000, 1));
idb.rows.set('new', row('new', realNow() - 1000, 2));
await svc._loadPersistedQueue();
await wait();
assert.deepEqual(svc.outgoingQueue.map((m) => m.id), ['new'], 'on reload only the newest X3DH_INIT per recipient is kept');
assert.ok(!idb.rows.has('old'), 'and the superseded one is deleted');
console.log('PASS only the newest queued friend request per recipient is sent');

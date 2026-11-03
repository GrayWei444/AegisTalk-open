/**
 * 加好友／群組邀請（W1 起是封給身分金鑰的 GROUP_KEY_SEALED）要等 broker PUBACK 才從 IDB 刪（稽核 M7，對應群星 B37）：
 * 真的 mqtt.ts，stub 掉 mqtt.js 與 IDB。
 *   以前連線中直接 publish、什麼都不留；離線排隊的那條也是 publish() 一呼叫就從 IDB 刪 ——
 *   連線其實已經死了（殭屍連線、手機切網路、broker 重啟）的話，X3DH_INIT／群組邀請就這樣不見了。
 *   現在：durable 型別連線中也先持久化，等 PUBACK 才刪；失敗留在 IDB 並回到記憶體佇列，下次連上補送。
 *   信令（offer／ICE）照舊直接 publish，不進持久化（過期信令重送只會搗亂）。
 * Run: node scripts/review/mqtt_durable_puback_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttdurable-'));
const idb = globalThis.__idb = { put: [], removed: [] };
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
       export async function persistOutgoing(e){ await new Promise(r=>setTimeout(r,5)); globalThis.__idb.put.push(e.id); }
       export async function removeOutgoing(id){ globalThis.__idb.removed.push(id); }
       export async function loadAllOutgoing(){ return [] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
console.warn = () => {}; console.error = () => {};
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));
const wait = () => new Promise((r) => setTimeout(r, 20));

const published = [];
svc.client = { connected: true, publish: (topic, payload, opts, cb) => published.push({ topic, payload, cb }), subscribe() {}, unsubscribe() {} };
svc.publicKeyBase64 = 'A'.repeat(44);
const B = 'B'.repeat(43) + '=';

// ── 連線中送 durable：先持久化，PUBACK 才刪 ──
svc.sendToUser(B, MessageType.X3DH_INIT, { hello: 1 });
await wait();
assert.equal(published.length, 1);
assert.equal(idb.put.length, 1, 'friend-add is persisted even while connected');
assert.deepEqual(idb.removed, [], 'not removed before PUBACK');
assert.equal(typeof published[0].cb, 'function', 'published with a PUBACK callback');
published[0].cb(null);
await wait();
assert.deepEqual(idb.removed, idb.put, 'removed after PUBACK');

// ── PUBACK 失敗：留在 IDB，回到記憶體佇列 ──
svc.sendToUser(B, MessageType.X3DH_INIT, { hello: 2 });
await wait();
published[1].cb(new Error('connection lost'));
await wait();
assert.equal(idb.removed.length, 1, 'failed publish stays in IDB');
assert.equal(svc.outgoingQueue.length, 1, 'and goes back into the in-memory queue for the next connect');
svc.outgoingQueue = [];

// ── 群組信封（邀請、金鑰）走收件匣，也是 durable；群組主題上的 group_sealed 不是（W2：commit 通知只是提示、log 本身才是紀錄，
//    重連一定補抓；here／通話過了就沒意義） ──
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { v: 1, ek: 'e', n: 'n', ct: 'c' });
await wait();
assert.equal(idb.put.length, 3, 'sealed group envelopes (invites, keys) are persisted until PUBACK');
assert.ok(published[2].topic.startsWith(`mist/user/`), 'published on the recipient inbox');
const TID = 'Tq3xZ0-_aB9cD8eF7gH6iJ';   // 群組主題 id（W3）
assert.equal(svc.sendToGroup(TID, MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }), true);
await wait();
assert.equal(idb.put.length, 3, 'a group_sealed control message is not persisted');
assert.ok(published[3].topic.startsWith(`mist/group/${TID}/`), 'and goes out on the group topic');
// W3：群組主題上的不排隊（排著的那則是用當時那一代封的）：沒連上回 false、不進佇列也不進 IDB，群組引擎留著重封
const connected = svc.client;
svc.client = { connected: false, publish() { throw new Error('offline'); }, subscribe() {}, unsubscribe() {} };
const queuedBefore = svc.outgoingQueue.length;
assert.equal(svc.sendToGroup(TID, MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }, { qos: 1 }), false, 'offline → not sent (the engine keeps it)');
await wait();
assert.equal(svc.outgoingQueue.length, queuedBefore, 'a group message is never queued');
assert.equal(idb.put.length, 3, 'nor persisted');
svc.client = connected;
assert.equal(svc.sendToGroup('group-1760000000000-abc1234', MessageType.GROUP_SEALED, { k: 'k' }), false, 'only 22-char topic ids');

// ── 離線排隊的 durable：重連 flush 後也要等 PUBACK ──
svc.client = { connected: false, publish() { throw new Error('offline'); }, subscribe() {}, unsubscribe() {} };
svc.sendToUser(B, MessageType.GROUP_KEY_SEALED, { v: 1, ek: 'e2', n: 'n', ct: 'c' });
await wait();
assert.equal(idb.put.length, 4);
const removedBefore = idb.removed.length;
published.length = 0;
svc.client = { connected: true, publish: (topic, payload, opts, cb) => published.push({ topic, payload, cb }), subscribe() {}, unsubscribe() {} };
svc._flushOutgoingQueue();
await wait();
assert.equal(published.length, 1, 'queued invite is flushed on reconnect');
assert.equal(idb.removed.length, removedBefore, 'flushed invite is not removed from IDB before PUBACK');
published[0].cb(null);
await wait();
assert.equal(idb.removed.length, removedBefore + 1, 'removed once acknowledged');

// ── 信令照舊直接 publish ──
published.length = 0;
const putBefore = idb.put.length;
svc.sendToUser(B, MessageType.WEBRTC_OFFER, { sdp: 'x' });
await wait();
assert.equal(idb.put.length, putBefore, 'signaling is not persisted');
assert.equal(published.length, 1, 'signaling publishes directly');
console.log('PASS friend-add / group invites wait for PUBACK before leaving IDB; failures are kept; signaling stays direct');

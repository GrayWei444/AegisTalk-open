/**
 * 同一毫秒排進 MQTT 待送佇列的訊息，App 重開、從 IndexedDB 載回後要照排入順序送。
 *   以前的例子是唯一的 admin 離開時連發的 GROUP_ROLE_UPDATED、GROUP_MEMBER_LEFT（對應群星 1170d062）；那兩個型別 W1 拿掉了，
 *   群組主題上的 group_sealed W3 起也不排隊（排著的那則是用當時那一代封的）。順序還是要緊的是收件箱上封給身分金鑰的信封：
 *   例如先回邀請者的 ack、再補一則 req —— 同一毫秒排入。離線、還沒連上就關 App 的話，重開後從 IndexedDB 載回 —— getAll 照 id 排，
 *   以前 id 是「毫秒-亂數」，同一毫秒的兩則一半機率顛倒。記憶體裡的佇列本來就照排入順序（見 _teardown）。
 *   真的 mqtt.ts＋真的 outgoingQueueStore.ts；idb 換成照 key 排序的記憶體版（跟 IndexedDB 的 getAll 一樣）。
 * Run: node scripts/review/mqtt_queue_restart_order_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttorder-'));
const rows = globalThis.__rows = new Map();
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|^idb$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no") } };'
    // IndexedDB 的 getAll 照主鍵（keyPath id）由小到大回傳
    : a.path === 'idb' ? `export async function openDB() { const R = globalThis.__rows; return {
        put: async (s, v) => { R.set(v.id, JSON.parse(JSON.stringify(v))); },
        getAll: async () => { const k = [...R.keys()].sort(); return (globalThis.__getAllReversed ? k.reverse() : k).map((x) => R.get(x)); },
        delete: async (s, k) => { R.delete(k); }, clear: async () => { R.clear(); } }; }`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";' }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
console.warn = () => {}; console.error = () => {};
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));
const wait = () => new Promise((r) => setTimeout(r, 10));

const published = [];
const fakeClient = () => ({ connected: true, publish: (topic, payload) => published.push(JSON.parse(payload).payload.n),
  subscribe() {}, unsubscribe() {}, removeAllListeners() {}, on() {}, end() {} });
svc.publicKeyBase64 = 'A'.repeat(43) + '=';
const R = 'B'.repeat(43) + '=';
const realNow = Date.now;
const ROUNDS = 40;
let flipped = 0;
for (let i = 0; i < ROUNDS; i++) {
  rows.clear(); svc.outgoingQueue = []; svc._inflight.clear(); svc.client = null;   // 離線
  const ms = realNow() + i * 1000;
  Date.now = () => ms;                                                             // 兩則同一毫秒排入
  svc.sendToUser(R, MessageType.GROUP_KEY_SEALED, { v: 1, ek: 'e', n: 'first', ct: 'c' });
  svc.sendToUser(R, MessageType.GROUP_KEY_SEALED, { v: 1, ek: 'e', n: 'second', ct: 'c' });
  // 群組主題上的不排隊（W3）
  assert.equal(svc.sendToGroup('T'.repeat(22), MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }), false);
  Date.now = realNow;
  await wait();                                                                    // 寫進 IndexedDB
  svc.outgoingQueue = [];                                                          // App 關掉：只剩 IndexedDB 那份
  await svc._loadPersistedQueue();
  published.length = 0;
  svc.client = fakeClient();
  svc._flushOutgoingQueue();
  assert.equal(published.length, 2, 'both queued envelopes are sent after the restart (and nothing for the group topic)');
  if (published[0] !== 'first') flipped++;
}
svc.client = null; svc.outgoingQueue = []; svc._inflight.clear();
assert.equal(flipped, 0, `the second envelope went out first in ${flipped}/${ROUNDS} restarts`);
console.log(`PASS same-millisecond queued envelopes keep their order across an app restart (${ROUNDS}/${ROUNDS}); group topics queue nothing`);

// 真的 outgoingQueueStore：同一毫秒做出來的 id 照做出來的順序排；載回時同一時間的照 id 排（不靠 IndexedDB 的回傳順序），
//   舊版留下的（毫秒-亂數）照樣載得回來、照時間排
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/outgoingQueueStore.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'q.mjs'), logLevel: 'silent', plugins: [stub] });
const Q = await import(pathToFileURL(join(dir, 'q.mjs')));
Date.now = () => 1_760_000_000_000;
const ids = Array.from({ length: 50 }, () => Q.makeOutgoingId());
Date.now = realNow;
assert.deepEqual([...ids].sort(), ids, 'ids made in the same millisecond sort in the order they were made');
assert.equal(new Set(ids).size, ids.length, 'and are unique');
rows.clear();
const entry = (id, timestamp) => ({ id, topic: 't', payload: '{}', qos: 1, timestamp });
for (const e of [entry(ids[1], 5), entry('1760000000001-aaaaaaaa', 6), entry(ids[0], 5), entry('1759999999999-legacyzz', 4)]) {
  await Q.persistOutgoing(e);
}
globalThis.__getAllReversed = true;   // 不靠 getAll 的回傳順序
const loaded = await Q.loadAllOutgoing();
globalThis.__getAllReversed = false;
assert.deepEqual(loaded.map((e) => e.id), ['1759999999999-legacyzz', ids[0], ids[1], '1760000000001-aaaaaaaa'],
  'loaded by time, same-time entries in the order they were queued, legacy ids still load');
rows.clear();
console.log('PASS queue ids keep the enqueue order within a millisecond; loading sorts by time, then id');

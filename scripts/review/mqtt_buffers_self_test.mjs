/**
 * 還沒有 listener 的 MQTT 訊息先暫存，但要有上限（移植群星 B38）：真的 mqtt.ts，stub 掉 mqtt.js 與 IDB。
 *   以前不限數量：連得上我收件箱的人灌 200 則 × 256KB 一個還沒人聽的型別 → 全留在記憶體（50MB）。
 *   1. 每型別 ≤ 50 則、一般型別合計 ≤ 4MB；listener 一註冊照樣重播、額度跟著釋放
 *   2. 一般型別塞滿之後，關鍵型別（加好友 X3DH_INIT）有自己的額度，還排得進來
 *   3. sealed 路徑共用同一份上限（以前另外一份、沒有上限）
 *   4. 帳號 disconnect（登出、被踢、換機）時暫存的全部丟掉：寄給這個帳號的，不能重播給下一個帳號的 listener
 *   5. direct_sealed 滿了丟最舊的（開源第 4 步審查 L4）；6. 有期限的信令帶 MQTT 5 message expiry 給 broker
 * Run: node scripts/review/mqtt_buffers_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttbuf-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no") } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(env){ return globalThis.__unsealed(env) }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : 'export const makeOutgoingId=()=>"o"; export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

svc.publicKeyBase64 = 'A'.repeat(44);
const B = 'B'.repeat(42) + 'A=';
const inbox = `mist/user/${'A'.repeat(43)}/inbox/${B.replace(/=+$/, '')}`;
const send = (type, payload) => svc.handleMessage(inbox, Buffer.from(JSON.stringify({ type, from: B, payload, timestamp: Date.now() })));
const heldBytes = (type) => (svc.pendingMessages.get(type) ?? []).reduce((s, m) => s + JSON.stringify(m.payload).length, 0);
const big = 'x'.repeat(256 * 1024);

// 1（W2 拿掉了明文的 group_call_*、開源第 4 步拿掉了 typing／call_*：一般型別只剩換機傳輸的兩種，用它們當沒人聽的型別）
const ORD = 'device_transfer_request', ORD2 = 'device_transfer_data';
for (let i = 0; i < 200; i++) send(ORD, { big, i });
const held = svc.pendingMessages.get(ORD) ?? [];
const bytes1 = heldBytes(ORD);
assert.ok(held.length > 0 && held.length <= 50, `at most 50 buffered per type (got ${held.length})`);
assert.ok(bytes1 <= 4 * 1024 * 1024, `at most 4MB buffered (got ${(bytes1 / 1048576).toFixed(1)}MB)`);
let replayed = 0;
const offOrd = svc.onMessage(ORD, () => { replayed++; });
await new Promise((r) => setTimeout(r, 0));
assert.equal(replayed, held.length, 'buffered ones still replay when a listener arrives');
offOrd();   // 第 3 段再用這個型別當「沒人聽」
assert.equal(svc.pendingTotalBytes, 0, 'byte counter released after replay');
console.log(`PASS unhandled-type buffer is bounded (${held.length} msgs, ${(bytes1 / 1048576).toFixed(1)}MB of 50MB sent) and still replays`);

// 2
for (let i = 0; i < 200; i++) send(ORD2, { big, i });
send('x3dh_init', { ephemeralPublicKey: 'e' });
assert.equal(svc.pendingMessages.get('x3dh_init')?.length, 1, 'a flood of other types cannot crowd out a friend-add');
// 開源第 4 步：1 對 1 的信令（預備金鑰請求、個人資料…）是 direct_sealed，也有自己的額度
send('direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'c' });
assert.equal(svc.pendingMessages.get('direct_sealed')?.length, 1, 'nor a sealed 1:1 signal (prekey request, profile)');
console.log('PASS critical types keep their own budget');

// 3（先把上一段塞滿的一般型別放掉）
svc.onMessage(ORD2, () => {});
await new Promise((r) => setTimeout(r, 0));
assert.equal(svc.pendingTotalBytes, 0);
globalThis.__unsealed = () => ({ type: ORD, from: B, payload: { big }, timestamp: Date.now() });
svc.privateKeyBase64 = 'K';
for (let i = 0; i < 60; i++) await svc.handleSealedMessage(inbox, { sealed: true, envelope: {}, timestamp: Date.now() });
const sealedHeld = (svc.pendingMessages.get(ORD) ?? []).length;
assert.ok(sealedHeld > 0, 'sealed messages are buffered too');
assert.ok(heldBytes(ORD) <= 4 * 1024 * 1024 && svc.pendingTotalBytes <= 4 * 1024 * 1024, `sealed messages share the same byte budget (${sealedHeld} of 60 kept)`);
console.log('PASS sealed messages share the same bounded buffer');

// 4
svc.disconnect();
assert.equal(svc.pendingMessages.size, 0, "logout / kick drops messages buffered for this account");
assert.equal(svc.pendingTotalBytes, 0);
assert.equal(svc.pendingMessageTimers.size, 0, 'and their timers');
let leaked = 0;
svc.onMessage('x3dh_init', () => { leaked++; });
await new Promise((r) => setTimeout(r, 0));
assert.equal(leaked, 0, "the next account's listener does not get the previous account's friend-add");
console.log('PASS disconnect drops the no-listener buffer (not replayed to the next account)');

// 5 開源第 4 步審查 L4：direct_sealed 滿了丟最舊的（重連時一堆排著的舊信令先到，剛到、叫醒手機的那通來電要留下）；其他關鍵型別照舊丟新的
for (let i = 0; i < 60; i++) send('direct_sealed', { v: 1, ek: 'e', n: 'n', ct: `c${i}` });
assert.deepEqual((svc.pendingMessages.get('direct_sealed') ?? []).map((m) => m.payload.ct), Array.from({ length: 50 }, (_, i) => `c${i + 10}`),
  'direct_sealed keeps the newest 50');
svc.disconnect();
for (let i = 0; i < 6; i++) send('direct_sealed', { v: 1, ek: 'e', n: 'n', ct: `${i}`.repeat(300 * 1024) });
const keptBig = (svc.pendingMessages.get('direct_sealed') ?? []).map((m) => m.payload.ct[0]);
assert.deepEqual(keptBig, ['3', '4', '5'], 'and the newest that fit in 1 MB');
assert.ok(heldBytes('direct_sealed') <= 1024 * 1024 && svc.pendingBytes.get('direct_sealed') === heldBytes('direct_sealed'), 'byte counter matches');
for (let i = 0; i < 60; i++) send('group_key_sealed', { v: 1, ek: 'e', n: 'n', ct: `g${i}` });
assert.equal(svc.pendingMessages.get('group_key_sealed')?.[0].payload.ct, 'g0', 'other critical types still keep the first ones (unchanged)');
svc.disconnect();
console.log('PASS a full direct_sealed buffer drops the oldest (the fresh call request that woke the phone is kept)');

// 6 開源第 4 步審查 L4：有期限的信令告訴 broker 期限（MQTT 5 message expiry），離線的人連上時不會一口氣收到一堆過期的
const pubs = [];
svc.publicKeyBase64 = 'A'.repeat(44);                       // disconnect 清掉了
svc.client = { connected: true, publish(topic, payload, opts, cb) { pubs.push({ type: JSON.parse(payload).type, opts }); cb?.(); }, end() {}, removeAllListeners() {} };
svc.sendTransientToUser(B, 'direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'c' });
svc.sendToUser(B, 'direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'c' }, { ttlMs: 60_000 });
svc.sendToUser(B, 'direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'c' }, { ttlMs: 24 * 3600_000 });
svc.sendToUser(B, 'direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'c' });
assert.deepEqual(pubs.map((p) => p.opts), [
  { qos: 1, properties: { messageExpiryInterval: 120 } },
  { qos: 1, properties: { messageExpiryInterval: 60 } },
  { qos: 1, properties: { messageExpiryInterval: 86400 } },
  { qos: 1 },
], 'transient signals expire at the broker after 2 min; queued ones after their own TTL');
svc.client = { connected: false, publish() {}, end() {}, removeAllListeners() {} };
svc.sendToUser(B, 'direct_sealed', { v: 1, ek: 'e', n: 'n', ct: 'q' }, { ttlMs: 60_000 });
svc.client = { connected: true, publish(topic, payload, opts, cb) { pubs.push({ type: JSON.parse(payload).type, opts }); cb?.(); }, end() {}, removeAllListeners() {} };
svc._flushOutgoingQueue();
const flushed = pubs.at(-1).opts;
assert.ok(flushed.qos === 1 && flushed.properties.messageExpiryInterval >= 1 && flushed.properties.messageExpiryInterval <= 60,
  `a queued signal sent later expires at the broker after what is left of its TTL (${flushed.properties?.messageExpiryInterval}s)`);
svc.client = null;
console.log('PASS signals carry their TTL to the broker (MQTT 5 message expiry)');

/**
 * MQTT 時戳新鮮度（傳輸統一 X2／X3）：真的 mqtt.ts，stub 掉 mqtt.js 與 IDB。
 *   X2 離線遺囑（LWT）的時戳是「連線當下」：連線超過 5 分鐘後當機，遺囑一到就被當成過期丟掉
 *      → 對方永遠顯示在線，useChat 也就不發推播。現在離線不擋時戳；在線照舊 5 分鐘。
 *      W4：presence 在秘密主題 mist/user/<他>/presence/<tag> 上，時間在密文裡（codec 拆開才看得到）；規則照舊，由 mqtt.ts 套
 *      presenceSecret.acceptState（這裡的 codec 是假的：payload 就是明文的 {on, ts, cs}）
 *   X3 群組信封（邀請、金鑰，GROUP_KEY_SEALED）／刪除訊息走 QoS1（clean:false，broker 存 24h），收端卻只給 5 分鐘
 *      → 離線超過 5 分鐘的人永遠收不到邀請、刪除失效（稽核 H9）。現在給 24h；信令照舊 5 分鐘。
 *      W1 起名冊不再走 MQTT 訊息（伺服器 log）；群組主題上只剩 log 的 ping（5 分鐘，舊的不需要：重連一定補抓 log）。
 * Run: node scripts/review/mqtt_freshness_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttfresh-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no") } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'   // 只有取 token 時才動態載入
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : `export const makeOutgoingId=()=>"o"; export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

svc.publicKeyBase64 = 'A'.repeat(44);
const B = 'B'.repeat(42) + 'A=';   // 32 bytes 公鑰的標準寫法（收件端只認這種，見 mqtt_acl_scope_self_test 2b）
const urlB = B.replace(/=+$/, '');
// 主題最後一節是寄件者（broker ACL 綁 username；mqtt.ts 收件時核對它跟 from 一致）
const inbox = `mist/user/${'A'.repeat(43)}/inbox/${urlB}`;
const group = `mist/group/g1/${urlB}`;
const presence = `mist/user/${urlB}/presence/${'T'.repeat(22)}`;
const min = 60_000;
const send = (topic, type, payload, ageMs) =>
  svc.handleMessage(topic, Buffer.from(JSON.stringify({ type, from: B, payload, timestamp: Date.now() - ageMs })));
svc.setPresenceCodec({
  async seal() { return null; },
  current() { return false; },
  async open(topic, payload) { return topic === presence ? { owner: B, state: JSON.parse(payload) } : null; },
  cleared() { return true; },
});
const tick = () => new Promise((r) => setTimeout(r, 10));
/** 好友的狀態：寫在 ageMs 之前，連線是 connAgeMs 之前連上的（遺囑的 ts ＝ 連上的時間） */
const state = async (on, ageMs, connAgeMs = ageMs, retained = false) => {
  svc.handleMessage(presence, Buffer.from(JSON.stringify({ on, ts: Date.now() - ageMs, cs: Date.now() - connAgeMs })), retained);
  await tick();
};

// ── X2 ──
const changes = [];
svc.onPresenceChange((key, online) => changes.push(online));
await state(1, 0, 40 * min);
assert.equal(svc.isFriendOnline(B), true);
await state(0, 40 * min);   // 40 分鐘前連線時寫好的遺囑，現在才觸發
assert.equal(svc.isFriendOnline(B), false, 'a stale-timestamped offline will still marks the friend offline');
assert.deepEqual(changes, [true, false]);
await state(1, 10 * min, 10 * min);    // 舊的「在線」仍要擋，否則當機的人會被復活
assert.equal(svc.isFriendOnline(B), false, 'a stale online presence is still ignored');
console.log('PASS offline will is honoured regardless of age; stale online still rejected');

// ── X3 ──
// 群組信封（邀請、金鑰）、1 對 1 的封好信令（DIRECT_SEALED：個人資料、預備金鑰請求、刪除…，開源第 4 步）走個人 inbox；
//   群組主題上只有 group_sealed（W2：群訊刪除也在裡面，broker 替離線的人排隊到 24h → MQTT 這層給 24h；真正的新鮮度由引擎／
//   directSeal 看內層簽過名的時間、依種類判斷 —— 1 對 1 的信令 2 分鐘，見 group_control_w2_self_test、direct_seal_self_test）
const QUEUED = [['group_key_sealed', inbox], ['direct_sealed', inbox], ['group_sealed', group]];
const got = [];
for (const [t] of QUEUED) svc.onMessage(t, () => got.push(t));
svc.onMessage('device_transfer_request', () => got.push('device_transfer_request'));
for (const [t, topic] of QUEUED) send(topic, t, { k: 'k' }, 3 * 60 * min);   // 3 小時前送出，broker session 剛交付
send(inbox, 'device_transfer_request', { timestamp: 1 }, 10 * min);   // 即時型別過舊仍要擋（5 分鐘）
assert.deepEqual(got, QUEUED.map(([t]) => t), `queued sealed group envelopes / deletes / group_sealed accepted for 24h (got ${got.join(',')})`);
send(inbox, 'group_key_sealed', { groupId: 'g2' }, 25 * 60 * min);
send(group, 'group_sealed', { k: 'k' }, 25 * 60 * min);
assert.equal(got.length, QUEUED.length, 'older than the 24h broker session is still rejected');
got.length = 0;
// 群組主題上只收 group_sealed；group_sealed 也只走群組主題（W2）
send(group, 'delete_message', { messageId: 'm', groupId: 'g1' }, 0);   // 以前的明文群組刪除、ping、通話型別都不收
send(group, 'direct_sealed', { v: 1 }, 0);
send(group, 'device_transfer_request', {}, 0);
send(group, 'group_log_ping', { h: 'x', s: 2 }, 0);
send(inbox, 'group_sealed', { k: 'k' }, 0);
assert.deepEqual(got, [], `only group_sealed on group topics, and group_sealed only there (got ${got.join(',')})`);
// 開源第 4 步：以前的明文 1 對 1 型別（信令、個人資料、預備金鑰、推播訂閱、打字中、刪除）不是型別了：剛送出的也一律丟
const RETIRED = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'call_request', 'call_accept', 'call_reject', 'call_end',
  'call_webrtc_offer', 'call_webrtc_answer', 'call_webrtc_ice', 'profile_update', 'profile_request', 'prekey_request', 'prekey_bundle',
  'push_subscription_update', 'typing', 'delete_message', 'encrypted_message'];
for (const t of RETIRED) svc.onMessage(t, () => got.push(t));
for (const t of RETIRED) send(inbox, t, { sdp: 'x' }, 0);
assert.deepEqual(got, [], `retired plaintext 1:1 types are rejected even when fresh (got ${got.join(',')})`);
got.length = QUEUED.length;
console.log('PASS sealed group envelopes / deletes / group_sealed accepted for 24h; stale signalling rejected; group topics carry group_sealed only');

// ── 未來的時戳（審查 MEDIUM）：以前取絕對值，寫成「23 小時後」的邀請現在收、47 小時後也還收 ──
got.length = 0;
send(inbox, 'group_key_sealed', { groupId: 'future' }, -23 * 60 * min);
send(inbox, 'group_key_sealed', { groupId: 'future' }, -6 * min);
assert.deepEqual(got, [], 'timestamps more than 5 minutes in the future are rejected');
assert.equal(svc.isFriendOnline(B), false);
await state(1, 0, 0);
await state(0, -60 * min);       // 離線遺囑只放寬「太舊」，不放寬「未來」
assert.equal(svc.isFriendOnline(B), true, 'a far-future offline will is rejected too');
send(inbox, 'group_key_sealed', { groupId: 'skew' }, -4 * min);
assert.deepEqual(got, ['group_key_sealed'], 'a few minutes of clock skew is still fine');
console.log('PASS future timestamps cannot stretch the freshness window');

// ── retained 只收 presence（審查 MEDIUM）：收件箱／群組頻道上的 retained 是別人留著、每次訂閱都重播的舊訊息 ──
got.length = 0;
const sendRetained = (topic, type, payload) =>
  svc.handleMessage(topic, Buffer.from(JSON.stringify({ type, from: B, payload, timestamp: Date.now() })), true);
sendRetained(inbox, 'group_key_sealed', { groupId: 'r' });
sendRetained(group, 'group_sealed', { k: 'k' });
assert.deepEqual(got, [], 'retained messages on inbox and group topics are dropped');
await state(0, 0, 0, true);
assert.equal(svc.isFriendOnline(B), false, 'a retained presence is still accepted');
sendRetained(`mist/user/${urlB}/presence`, 'presence', { online: true });   // 舊的只有公鑰的主題：不是 presence 主題了
await tick();
assert.equal(svc.isFriendOnline(B), false, 'a retained message on the old key-only presence topic is dropped');
console.log('PASS retained messages are accepted only on presence topics');

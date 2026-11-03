/**
 * 推播請求的 client 端（移植群星 A5；伺服器端見 push_endpoints_self_test.py）：
 *   真的 mqtt.ts／pushRequest.ts／capacitor.ts，stub 掉 mqtt.js、IDB、Capacitor 外掛與 fetch。
 *   以前：triggerFcmNotify 只送 {recipientPubkeyHash, notificationHint}（沒有身分）；來電的 hint 帶自己填的 senderName，
 *         明文經過 broker、原樣進 FCM；registerFcmToken 送自算的 pubkeyHash。
 *   現在：
 *   1. 沒有已解鎖的身分 → 不推
 *   2. 推播請求由帳戶金鑰簽章（簽章內容＝送出的所有欄位，canonical JSON 跟 Python sort_keys 一字不差），request_id 每次新的
 *   3. notificationHint 只有 type／isVideoCall：守護 SDK 多帶的 protectedName／alertType 不送；不認得的型別不送；
 *      社群版（開源第 4 步：沒設 VITE_AEGIS_EDITION）只送 message／incoming_call，官方完整版另外送 guardian_alert／check_in
 *   4. MQTT 訊息不帶推播提示（以前來電的 notificationHint 明文搭在 MQTT 上；開源第 4 步拿掉），推播也不帶名字
 *   5. FCM token 註冊由帳戶金鑰簽章、沒有 pubkeyHash
 *   6. 時鐘差（開源第 4 步）：用校正到伺服器的時鐘簽；伺服器回 401 clock_skew → 用它的時間校正、換 request_id 重簽一次（推播、FCM 註冊）
 * Run: node scripts/review/push_signing_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'pushsig-'));
globalThis.__clients = [];
globalThis.__idb = new Map();
const DEVICE = '0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab';
const FCM_TOKEN = 'fcm-registration-token-0123456789';
// the build's default server ('@ext/server'): an example one, so the test runs the same in the community tree (no default
// server there) and in the official one (the official default otherwise)
const EXT_SERVER = `export const defaultServer = { name: 'Example chat', apiUrl: 'https://chat-api.example.org', mqttUrl: 'wss://chat-mqtt.example.org/mqtt', registration: 'invite' };
  export const connectSources = []; export const brandLegal = undefined;`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$|^@capacitor\/|^capacitor-native-biometric$|plugins\/fcmTokenPlugin$/ },
    (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@ext/server' ? EXT_SERVER
    : a.path === 'mqtt' ? `export default { connect(url, options) {
        const handlers = {}; const subs = []; const pubs = [];
        const c = { connected: true, disconnected: false, subs, pubs, options, handlers,
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          subscribe(topic, opts, cb) { subs.push(topic); cb?.(null, [].concat(topic).map((t) => ({ topic: t, qos: 1 }))); },
          unsubscribe() {}, publish(t, p, o, cb) { pubs.push({ topic: t, payload: p, opts: o }); cb?.(null); },
          removeAllListeners() { for (const k in handlers) delete handlers[k]; }, end() {} };
        globalThis.__clients.push(c); return c; } };`
    : a.path === '@capacitor/core' ? `export const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        export const registerPlugin = () => ({}); export class WebPlugin {}`
    : a.path === 'capacitor-native-biometric' ? 'export const NativeBiometric = {};'
    : a.path === '@capacitor/push-notifications' ? `export const PushNotifications = {
        async requestPermissions() { return { receive: 'granted' }; },
        async register() {},
        addListener(ev, cb) { if (ev === 'registration') setTimeout(() => cb({ value: '${FCM_TOKEN}' }), 0); return { remove() {} }; } };`
    : a.path.startsWith('@capacitor/') ? 'export {}'
    // Firebase 有沒有初始化：開源第 5d 步起問兩個版本都有的 FCMTokenPlugin（社群版沒有守護外掛）
    : a.path.includes('fcmTokenPlugin') ? 'export const FCMTokenPlugin = { async getToken() { return { token: null }; }, async markSynced() {}, async hasFirebase() { return { available: true }; } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? `export const getDeviceIdSync=()=>"${DEVICE}";`
    : `let n = 0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(e){ globalThis.__idb.set(e.id, e) }
       export async function removeOutgoing(id){ globalThis.__idb.delete(id) }
       export async function loadAllOutgoing(){ return [...globalThis.__idb.values()] }` }));
} };
await require('esbuild').build({
  stdin: { contents: `export * from './src/services/mqtt.ts'; export { registerFcmToken } from './src/services/capacitor.ts';
    export { serverPushHint, pushHintTypes, appEdition } from './src/services/pushRequest.ts';`,
    resolveDir: root + 'packages/pwa', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [stub],
  define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
globalThis.localStorage = { getItem: (k) => (k === 'aegis_device_id' ? DEVICE : null), setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {}; console.log = (...x) => process.stdout.write(x.join(' ') + '\n');
const { mqttService: svc, registerFcmToken, MessageType, serverPushHint, pushHintTypes, appEdition } = await import(pathToFileURL(join(dir, 'p.mjs')));

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(raw).toString('base64'), sign: (data) => new Uint8Array(edSign(null, Buffer.from(data), privateKey)) };
}
/** = Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False) */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function verifies(body) {
  const { signature, ...signed } = body;
  const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(body.pubkey, 'base64')]), format: 'der', type: 'spki' });
  return edVerify(null, Buffer.from(canonical(signed), 'utf8'), key, Buffer.from(signature, 'base64'));
}
const me = keypair();
const friend = keypair().pk;

const requests = [];
/** 下一個推播／註冊請求先回 401 clock_skew（伺服器時間 ＝ 現在＋這麼多秒）；null ＝ 照常 */
let skewNext = null;
/** 下一個帶響鈴 token 的推播回 422 invalid_ring_token（開源第 5d 步） */
let refuseRingNext = false;
globalThis.fetch = async (u, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  requests.push({ url: String(u), body });
  if (refuseRingNext && body.notificationHint?.ringToken) {
    refuseRingNext = false;
    const res = { ok: false, status: 422, json: async () => ({ detail: 'invalid_ring_token' }) };
    return { ...res, clone: () => res };
  }
  if (skewNext !== null && /\/api\/push\//.test(String(u))) {
    const serverTime = Math.floor(Date.now() / 1000) + skewNext;
    skewNext = null;
    const res = { ok: false, status: 401, json: async () => ({ detail: { code: 'clock_skew', server_time: serverTime } }) };
    return { ...res, clone: () => res };
  }
  if (String(u).endsWith('/api/mqtt/token')) {
    const user = body.pubkey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { ok: true, json: async () => ({ token: 'jwt', expiresAt: Math.floor(Date.now() / 1000) + 3600, username: user }) };
  }
  return { ok: true, status: 200, json: async () => ({ success: true }) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pushes = () => requests.filter((r) => r.url.endsWith('/api/push/notify'));

// ── 1. 沒有已解鎖的身分 → 不推 ──
svc.triggerFcmNotify(friend, { type: 'message' });
await sleep(5);
assert.equal(pushes().length, 0, 'no signer → no push request');
console.log('PASS no unlocked identity → no push request');

svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
const p = svc.connect(me.pk);
for (let i = 0; i < 100 && globalThis.__clients.length === 0; i++) await sleep(5);
const client = globalThis.__clients.at(-1);
client.emit('connect', { cmd: 'connack', sessionPresent: false });
await p;

// ── 2. 簽章、欄位 ──
svc.triggerFcmNotify(friend, { type: 'incoming_call', isVideoCall: true });
await sleep(5);
let push = pushes().at(-1);
assert.equal(push.url, 'https://chat-api.example.org/api/push/notify');
assert.deepEqual(Object.keys(push.body).sort(),
  ['action', 'notificationHint', 'pubkey', 'recipient_pubkey', 'request_id', 'signature', 'timestamp']);
assert.equal(push.body.action, 'push_notify');
assert.equal(push.body.pubkey, me.pk);
assert.equal(push.body.recipient_pubkey, friend);
assert.deepEqual(push.body.notificationHint, { type: 'incoming_call', isVideoCall: true });
assert.ok(Math.abs(push.body.timestamp - Date.now() / 1000) < 5);
assert.ok(verifies(push.body), 'signature covers every field the server rebuilds (canonical JSON)');
assert.ok(!verifies({ ...push.body, recipient_pubkey: keypair().pk }), 'changing the recipient breaks the signature');
assert.ok(!('recipientPubkeyHash' in push.body), 'no unauthenticated hash field');
const firstId = push.body.request_id;
svc.triggerFcmNotify(friend, { type: 'message' });
await sleep(5);
push = pushes().at(-1);
assert.deepEqual(push.body.notificationHint, { type: 'message' });
assert.ok(verifies(push.body));
assert.notEqual(push.body.request_id, firstId, 'request_id is new every time (the server accepts each once)');
console.log('PASS push requests are signed by the account key over all fields; request_id is single-use');

// ── 3. 守護 SDK 多帶的文字欄位不送；不認得的型別不送；社群版不送守護型別 ──
assert.equal(appEdition({}), 'community', 'no VITE_AEGIS_EDITION → community edition');
assert.equal(appEdition({ VITE_AEGIS_EDITION: 'official' }), 'official');
assert.deepEqual([...pushHintTypes('community')].sort(), ['incoming_call', 'message'], 'community: only message and incoming_call (owner decision 2)');
assert.deepEqual(serverPushHint({ type: 'guardian_alert', protectedName: '媽媽', alertType: 'high_risk_conversation', senderName: '銀行' }, 'official'),
  { type: 'guardian_alert' }, 'official: only the type goes to the server');
assert.deepEqual(serverPushHint({ type: 'check_in', checkInType: 'request' }, 'official'), { type: 'check_in' });
const beforeGuardian = pushes().length;
svc.triggerFcmNotify(friend, { type: 'guardian_alert', protectedName: '媽媽', alertType: 'high_risk_conversation', senderName: '銀行' });
svc.triggerFcmNotify(friend, { type: 'check_in', checkInType: 'request' });
await sleep(5);
assert.equal(pushes().length, beforeGuardian, 'this build is the community edition: guardian / check-in hints are not sent at all');
const before = pushes().length;
svc.triggerFcmNotify(friend, { type: 'fake_bank_alert' });
svc.triggerFcmNotify(friend, { type: 'incoming_call', isVideoCall: 'yes' });
await sleep(5);
assert.equal(pushes().length, before + 1, 'unknown types are not sent');
assert.deepEqual(pushes().at(-1).body.notificationHint, { type: 'incoming_call' }, 'isVideoCall only when it is a boolean');
console.log('PASS the hint carries only type/isVideoCall: guardian SDK extras are dropped, unknown types not sent');

// ── 4. MQTT 上不帶推播提示（來電是封好的 DIRECT_SEALED，推播只走帳戶簽章的 API）；推播不帶名字 ──
assert.equal(typeof svc.sendCallRequest, 'undefined', 'no plaintext call request sender left');
svc.sendToUser(friend, MessageType.DIRECT_SEALED, { v: 1, ek: 'e', n: 'n', ct: 'c' });
await sleep(5);
const sealedPub = client.pubs.map((x) => JSON.parse(x.payload)).filter((m) => m.type === 'direct_sealed').at(-1);
assert.ok(sealedPub, 'sealed 1:1 signal published');
assert.deepEqual(Object.keys(sealedPub).sort(), ['from', 'payload', 'timestamp', 'to', 'type'], 'the MQTT message carries no notificationHint / pushData');
svc.triggerFcmNotify(friend, { type: 'incoming_call', isVideoCall: false, senderName: '媽媽' });
await sleep(5);
push = pushes().at(-1);
assert.deepEqual(push.body.notificationHint, { type: 'incoming_call', isVideoCall: false });
assert.ok(!/媽媽|senderName/.test(JSON.stringify(push.body)));
assert.ok(verifies(push.body));
console.log('PASS no push hint rides on MQTT; the incoming-call push carries no caller name');

// ── 5. FCM token 註冊 ──
await registerFcmToken(me.pk);
const reg = requests.filter((r) => r.url.endsWith('/api/push/register-token')).at(-1);
assert.ok(reg, 'token registered');
assert.equal(reg.url, 'https://chat-api.example.org/api/push/register-token');
assert.deepEqual(Object.keys(reg.body).sort(), ['action', 'platform', 'pubkey', 'request_id', 'signature', 'timestamp', 'token']);
assert.equal(reg.body.action, 'push_register');
assert.equal(reg.body.pubkey, me.pk);
assert.equal(reg.body.token, FCM_TOKEN);
assert.equal(reg.body.platform, 'android');
assert.ok(verifies(reg.body), 'registration is signed by the account key');
assert.ok(!('pubkeyHash' in reg.body), 'no client-computed hash');
console.log('PASS FCM token registration is signed by the account key (no client-computed pubkeyHash)');

// ── 6. 時鐘差：401 clock_skew → 用伺服器的時間重簽一次 ──
const n0 = pushes().length;
skewNext = 900;                                     // 伺服器比手機快 15 分鐘
svc.triggerFcmNotify(friend, { type: 'message' });
await sleep(20);
const [refused, retried] = pushes().slice(n0);
assert.ok(refused && retried, `refused once, then re-signed (${pushes().length - n0} requests)`);
assert.ok(Math.abs(refused.body.timestamp - Date.now() / 1000) < 5, 'first try signed with the (wrong) local clock');
assert.ok(Math.abs(retried.body.timestamp - (Date.now() / 1000 + 900)) < 5, 'the retry is signed with the server time');
assert.notEqual(retried.body.request_id, refused.body.request_id, 'with a new request_id');
assert.ok(verifies(retried.body));
assert.ok(Math.abs(svc.serverNow() - (Date.now() + 900_000)) < 5_000, 'the offset is kept for the next requests (mqtt.serverNow)');
svc.triggerFcmNotify(friend, { type: 'incoming_call' });
await sleep(10);
assert.ok(Math.abs(pushes().at(-1).body.timestamp - (Date.now() / 1000 + 900)) < 5, 'the next push is signed on server time at once');
const r0 = requests.filter((r) => r.url.endsWith('/api/push/register-token')).length;
skewNext = -1200;
svc.adoptServerTime(Math.floor(Date.now() / 1000));   // 回到 0 再測一次註冊
await registerFcmToken(me.pk);
const regs = requests.filter((r) => r.url.endsWith('/api/push/register-token')).slice(r0);
assert.equal(regs.length, 2, 'FCM registration: refused once, re-signed once');
assert.ok(Math.abs(regs[1].body.timestamp - (Date.now() / 1000 - 1200)) < 5 && verifies(regs[1].body), 'and re-signed on the server time');
console.log('PASS push and FCM registration are signed on the server-corrected clock and retried once on clock_skew');

// ── 7. 響鈴 token（開源第 5d 步）：這一通的 callId；iat 用有上限的時鐘（審查 H1）；伺服器嫌 token 太舊 → 不帶 token 再送一次 ──
const claimsOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
const CALL = 'C'.repeat(21) + 'g';
svc.adoptServerTime(Math.floor(Date.now() / 1000));
const k0 = pushes().length;
svc.triggerFcmNotify(friend, { type: 'incoming_call', isVideoCall: true, callId: CALL });
await sleep(10);
const ringPush = pushes().at(-1);
assert.equal(pushes().length - k0, 1);
assert.equal(typeof ringPush.body.notificationHint.ringToken, 'string', 'the call push carries a ring token');
const c = claimsOf(ringPush.body.notificationHint.ringToken);
assert.deepEqual([c.v, c.d, c.callId, c.from, c.to, c.video], [1, 'aegistalk-ring-v1', CALL, me.pk, friend, true], 'the token is mine, for the callee, for this call');
assert.ok(Math.abs(c.iat - Date.now()) < 5_000);
const raw = Buffer.from(ringPush.body.notificationHint.ringToken.split('.')[1], 'base64url');
const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(me.pk, 'base64')]), format: 'der', type: 'spki' });
assert.ok(edVerify(null, Buffer.concat([Buffer.from('aegistalk-ring-v1:'), raw]), key, Buffer.from(ringPush.body.notificationHint.ringToken.split('.')[2], 'base64url')), 'signed by me over "prefix:" ‖ claims');
assert.ok(verifies(ringPush.body), 'and the account signature covers it');
svc.triggerFcmNotify(friend, { type: 'message', callId: CALL });
await sleep(10);
assert.ok(!('ringToken' in pushes().at(-1).body.notificationHint), 'no token on message pushes');
// 營運方說伺服器快一小時：請求照它的時間簽，token 的 iat 最多只往前 5 分鐘
svc.adoptServerTime(Math.floor(Date.now() / 1000) + 3600);
refuseRingNext = true;
const k1 = pushes().length;
svc.triggerFcmNotify(friend, { type: 'incoming_call', isVideoCall: false, callId: CALL });
await sleep(30);
const [withToken, without] = pushes().slice(k1);
assert.ok(Math.abs(withToken.body.timestamp - (Date.now() / 1000 + 3600)) < 5, 'the request itself is on the server-corrected clock');
const ci = claimsOf(withToken.body.notificationHint.ringToken).iat;
assert.ok(ci - Date.now() <= 5 * 60_000 + 2_000 && ci - Date.now() > 4 * 60_000, `the token iat is capped at +5 min, not +1 h (review H1; got ${Math.round((ci - Date.now()) / 1000)} s)`);
assert.ok(without && !('ringToken' in without.body.notificationHint) && without.body.notificationHint.type === 'incoming_call' && verifies(without.body),
  'refused as invalid_ring_token → the push goes again without a token (the callee gets a plain notification)');
assert.equal(pushes().length - k1, 2, 'exactly one retry');
console.log('PASS call pushes carry my ring token for this call id, dated on the bounded clock; a refused token → one retry without it');
svc.disconnect();   // 收掉「到期前換 token」的計時器，行程才會結束


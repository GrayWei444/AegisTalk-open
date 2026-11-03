/**
 * 加好友不再採信對方自稱的信任等級、沒有我發出的憑證就不加（稽核 H1／H2，對應 AegisPlay A2）：
 *   真的 friendInvites.ts ＋ 抽出 AppProvider 的 X3DH_INIT effect 配 stub 執行。
 *   以前：陌生人的 X3DH_INIT 帶 trustLevel:'verified' 就被加成「已驗證」好友；INVITE_ACCEPT 不檢查
 *   inviteCode、也不檢查寄件者，一則偽造訊息就讓我跟陌生人建 session 並加好友。
 *   現在：陌生人的 INIT 要帶對得上我發出的短碼／QR nonce 才加（帶的是綁他金鑰與 ephemeral 的 proof，憑證本身不上線），
 *   否則整封拒收；信任等級只看那個憑證
 *   （當面掃我畫的 QR 才算已驗證）。邀請連結整條拿掉，INVITE_ACCEPT 一律拒收。
 *   （2026-10-15 起嚴格收，沒有舊版 client 要相容；細節與來回測試見 friend_strict_accept_self_test）
 * Run: node scripts/review/friend_invites_self_test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { friendViaKit } from './friendViaKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');

// ── friendInvites.ts 單元（記憶體 localStorage、可控時間） ──
const store = new Map();
let now = 1_800_000_000_000;
const FakeDate = class extends Date { static now() { return now; } };
const fiPath = root + 'packages/pwa/src/services/friendInvites.ts';
let api = { rememberShortCode() {}, issueQrInvite: () => ({}), acceptedVia: () => null, cleanPeerName: (n, f) => n || f, makeVia: async () => null };
if (existsSync(fiPath)) {
  const src = readFileSync(fiPath, 'utf8');
  api = new Function('localStorage', 'Date', 'crypto', transformSync(src.replace(/^export /gm, ''), { loader: 'ts' }).code
    + ';return {rememberShortCode,issueQrInvite,acceptedVia,cleanPeerName,newQrNonce,makeVia,viaName};')(
    { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    FakeDate, globalThis.crypto);
}
const { cleanPeerName: clean } = api;
// 每個角色一支真的手機（真的身分金鑰、真的 friendViaSealer；via 封給收件人的身分金鑰，見 friendViaKit）
const kit = await friendViaKit(root);
const P = {};
for (const n of ['ME', 'OTHER', 'A', 'B', 'STRANGER', 'MALLORY', 'ALICE', 'BOB', 'CAROL', 'DAVE']) P[n] = await kit.party(n);
const pk = (name) => P[name].pk;
/** owner 收到 from 的 via：認不認（App 的 acceptedVia，owner 手機的 sealer 拆） */
const accept = (owner, from, eph, v) => api.acceptedVia(pk(owner), pk(from), eph, v, P[owner].sealer);
const DAY = 24 * 3600e3;
/** 伺服器給的短碼，伺服器說 24 小時後到期 */
const rememberCode = (owner, code) => api.rememberShortCode(pk(owner), code, now + DAY);
/** 畫一張 QR，回傳它的 nonce */
const showQr = (owner) => api.issueQrInvite(pk(owner)).nonce;
/** INIT 的 ephemeral：32-byte 公鑰的 base64（收端先檢查長度，審查 L2） */
const EPH = Buffer.alloc(32, 5).toString('base64');
const EPH2 = Buffer.alloc(32, 6).toString('base64');
/** 拿到憑證（短碼／QR nonce）的人送出的 via：綁自己金鑰與這封 ephemeral 的 proof，封給收件人 to，憑證本身不上線 */
const via = (kind, token, from, eph = EPH, to = 'ME', name) => api.makeVia({ kind, token }, pk(from), eph, pk(to), P[from].sealer, name);
const plain = (o) => JSON.parse(JSON.stringify(o));

if (existsSync(fiPath)) {
  assert.equal(await accept('ME', 'STRANGER', EPH, undefined), null);
  assert.equal(await accept('ME', 'STRANGER', EPH, await via('code', 'ATK-ABC234', 'STRANGER')), null, 'a code I never issued');
  assert.equal(await accept('ME', 'STRANGER', EPH, await P.STRANGER.sealer.seal(pk('ME'), { kind: 'admin', proof: 'x'.repeat(44) })), null, 'unknown kind');
  rememberCode('ME', 'ABC234');                                        // 伺服器回的是不含前綴的短碼
  assert.deepEqual(plain(await accept('ME', 'A', EPH, await via('code', 'atk-abc234', 'A'))), { kind: 'code' }, 'code, case/prefix-insensitive');
  assert.equal(await accept('ME', 'A', EPH, { kind: 'code', token: 'ATK-ABC234' }), null, 'the raw code on the wire is not a credential');
  assert.equal(await accept('ME', 'MALLORY', EPH, await via('code', 'ABC234', 'A')), null, 'a proof made for A does not work for MALLORY');
  assert.equal(await accept('ME', 'A', EPH2, await via('code', 'ABC234', 'A')), null, 'nor for another ephemeral key');
  const nonce1 = showQr('ME');
  assert.equal((await accept('ME', 'B', EPH, await via('qr', nonce1, 'B'))).kind, 'qr');
  assert.equal(await accept('ME', 'B', EPH, await via('qr', 'nonce-2', 'B')), null);
  assert.equal(await accept('OTHER', 'A', EPH, await via('code', 'ATK-ABC234', 'A', EPH, 'OTHER')), null, 'another account on this device cannot use my invites');
  assert.equal(await accept('OTHER', 'A', EPH, await via('code', 'ATK-ABC234', 'A')), null, 'nor open a via sealed to me');
  now += DAY + 23 * 3600e3;
  assert.equal(await accept('ME', 'B', EPH, await via('qr', nonce1, 'B')), null, 'QR nonce long expired');
  assert.ok(await accept('ME', 'A', EPH, await via('code', 'ATK-ABC234', 'A')), 'code still valid until its server expiry + 24 h');
  now += 3600e3 + 1000;
  assert.equal(await accept('ME', 'A', EPH, await via('code', 'ATK-ABC234', 'A')), null, 'code refused after server expiry + 24 h (details: friend_code_expiry_self_test)');
  assert.equal(clean('<b>\u0000小明</b>', 'fallback'), 'b小明/b');
  assert.equal(clean('  ', 'fallback'), 'fallback');
  assert.equal(clean('a'.repeat(100), 'x').length, 40);
  assert.match(api.newQrNonce(), /^[A-Za-z0-9_-]{16,}$/, 'QR nonce is random url-safe text');
  console.log('PASS invite credentials: only what I issued (code/QR), owner-scoped, expiring; peer names cleaned');
}

const provider = readFileSync(process.env.APP_PROVIDER_SRC ?? root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const slice = (from, to) => {
  const a = provider.indexOf(from); const b = provider.indexOf(to, a);
  assert.ok(a > 0 && b > a, `found ${from}`);
  return transformSync(provider.slice(a, b).replace(/\bimport\(/g, '__import('), { loader: 'ts' }).code;
};

// ── X3DH_INIT：陌生人加我 ──
const x3dhCode = slice('// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息');
async function init(from, payload) {
  let handler; const added = []; const accepted = [];
  runInNewContext(x3dhCode, {
    useEffect: (fn) => fn(), console: { error() {}, log() {}, warn() {} }, Date, JSON, Promise,
    mqtt: { isConnected: true, subscribe: (t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: { X3DH_INIT: 'x3dh_init', PREKEY_REQUEST: 'prekey_request', PROFILE_UPDATE: 'profile_update' },
    getFriendByPublicKey: () => undefined, findFriendSettled: async () => undefined, updateFriendProfile() {}, addFriend: (...a) => added.push(a),
    fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, devLog() {}, publicKey: pk('ME'), friendViaSealer: P.ME.sealer,
    hasSessionWith: () => false, wasInitAccepted: () => false, recentlyInitiatedTo: () => false, rememberAcceptedInit() {},
    signedPreKey: { publicKeyBase64: 'MYSPK', signatureBase64: 'MYSIG' },
    mqttService: { sendToUser() {} }, clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {},
    sendProfileUpdate: async () => true, sendPrekeyRequest: async () => true, viaName: api.viaName,
    webrtcService: { disconnect() {} }, acceptSession: (...a) => accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }),
    getServiceTranslation: () => (k) => k, localStorage: { getItem: () => null },
    useChatStore: { getState: () => ({ userProfile: { displayName: 'me' } }) },
    acceptedVia: api.acceptedVia, cleanPeerName: clean, isBlacklisted: async () => false,
    usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  });
  await handler({ from: pk(from), payload: { ephemeralPublicKey: EPH, senderName: 'Mallory', signedPreKey: 'S', signature: 'G', sessionReset: true, ...payload } });
  return { added, accepted };
}
let r = await init('STRANGER', { trustLevel: 'verified' });
assert.equal(r.added.length + r.accepted.length, 0, 'a stranger with no credential (claiming trustLevel:"verified") is refused — no friend, no session');
if (existsSync(fiPath)) {
  now = 1_900_000_000_000;
  const nonceLive = showQr('ME');
  rememberCode('ME', 'XYZ789');
  // 開源第 4 步：名字在封給我的 via 裡（payload 明文的 senderName 不再採信 —— broker 看得到、誰都能填）
  r = await init('ALICE', { trustLevel: 'unverified', senderName: 'Mallory', via: await via('qr', nonceLive, 'ALICE', EPH, 'ME', 'Alice') });
  assert.equal(r.added[0][2], 'verified', 'someone who scanned the QR I am showing is verified');
  assert.equal(r.added[0][1], 'Alice', 'the name comes from the sealed via, not from a plaintext senderName');
  assert.equal(r.accepted.length, 1);
  r = await init('BOB', { trustLevel: 'verified', via: await via('code', 'ATK-XYZ789', 'BOB') });
  assert.equal(r.added[0][2], 'unverified', 'my short code → unverified, whatever the payload says');
  r = await init('CAROL', { trustLevel: 'verified', via: await via('qr', 'guessed', 'CAROL') });
  assert.equal(r.added.length + r.accepted.length, 0, 'a QR nonce I never showed is refused');
  r = await init('CAROL', { trustLevel: 'verified', via: await via('qr', nonceLive, 'ALICE') });
  assert.equal(r.added.length + r.accepted.length, 0, 'Alice\'s via replayed by Carol is refused');
  now += 30 * 60e3 + 1e3;   // 碼主人收 QR 的 INIT 認到畫出來後 30 分鐘：之後才處理的不認（細節見 qr_invite_window_self_test）
  r = await init('DAVE', { trustLevel: 'verified', via: await via('qr', nonceLive, 'DAVE') });
  assert.equal(r.added.length + r.accepted.length, 0, 'a QR nonce processed 30 minutes after it was shown is refused, not added as unverified');
}
console.log('PASS X3DH_INIT from a stranger: only with my own unexpired invite; trust comes from it, never from the payload');

// ── INVITE_ACCEPT：邀請連結整條拿掉，連訊息型別都沒了（MQTT 收到未知型別直接丟，見 friend_strict_accept_self_test） ──
assert.ok(!/INVITE_ACCEPT/.test(provider), 'no INVITE_ACCEPT listener left');
console.log('PASS INVITE_ACCEPT (invite links removed) is not even a message type any more');

// ── 送出端：每條加好友路都帶上 via，發出憑證的一端記下來 ──
const modal = readFileSync(root + 'packages/pwa/src/components/Verification/AddFriendModal.tsx', 'utf8');
const qr = readFileSync(root + 'packages/pwa/src/components/Verification/QRCodeVerification.tsx', 'utf8');
const fc = readFileSync(root + 'packages/pwa/src/components/Verification/FriendCode.tsx', 'utf8');
assert.match(modal, /trustLevel: 'verified' \| 'unverified', invite: FriendInvite, attempt: number,/, 'proceedAddFriend requires a credential');
assert.match(modal, /const via = await makeVia\(invite, publicKey, ephemeralB64, peerData\.pk, friendViaSealer,\s*userProfile\.displayName/, 'the INIT carries a proof of the credential (and my name), bound to my key and this ephemeral key, sealed to the peer\'s identity key');
assert.doesNotMatch(modal.slice(modal.indexOf('const initPayload'), modal.indexOf('mqttService.sendToUser(peerData.pk, MessageType.X3DH_INIT')), /senderName/, 'no plaintext name in the INIT');
assert.match(modal, /\n\s+via,\s/, 'X3DH_INIT always carries via');
assert.match(modal, /proceedAddFriend\(peerQr, 'verified', invite, attempt\)/, 'QR scan proves the QR nonce');
assert.match(modal, /proceedAddFriend\(riskWarning\.pendingQrData, 'verified', invite, attempt\)/, 'QR scan after the risk warning too');
assert.match(modal, /kind: 'code', token: code/, 'short code add proves the code');
assert.match(qr, /n: invite\.nonce/, 'QR carries its nonce');
assert.match(qr, /const invite = issueQrInvite\(publicKey\);/, 'the QR I show is remembered (issueQrInvite)');
assert.match(fc, /rememberShortCode\(publicKey, data\.short_code, data\.expires_at \* 1000, \{ replacePrevious: forceRefresh \}\)/, 'the short code I issue is remembered (until server expiry + 24 h; regenerate cancels the old one)');
console.log('PASS every AegisTalk add path (QR, short code) sends its credential and the issuer remembers it');

/**
 * 加好友改成嚴格收（對應 AegisPlay A2）：App 還沒上線、沒有舊版 client，以前「陌生人的 X3DH_INIT 沒有憑證也加成
 * 未驗證好友」的相容規則拿掉。
 *   收端：不是好友的 X3DH_INIT，via 要對得上我這台發出、還沒過期的短碼／QR nonce，否則整封拒收 ——
 *         不加好友、不建 session、不回送我的個人資料；只印一行 log（不含對方的名字、憑證）。
 *         既有好友（含冷啟動清單還沒載入時）重送／修復的 INIT 照舊。
 *   INVITE_ACCEPT：產生邀請連結的入口早在 AddFriendModal v2 就移除了，邀請連結整條拿掉 —— 連訊息型別都拿掉（MQTT 收到直接丟）。
 *   送出端：還留著的加好友路（掃 QR、輸入 ATK- 短碼）一定帶憑證；沒有憑證可帶的（舊長碼 aegis:、沒有 nonce 的
 *         QR、邀請連結）在畫面上就擋下或整條拿掉，不會送出一封一定被拒收的 INIT 讓加的人以為加成功。
 *   每條路都用真的程式碼來回跑一次：真的 QRCodeVerification／FriendCode 發出憑證 → 真的 AddFriendModal
 *   送出 INIT → 真的 AppProvider X3DH_INIT handler 收下。
 *   憑證本身不上線（程式碼審查 M2）：INIT 是明文、broker 誰都能訂閱別人的收件匣，以前 via 帶原本的短碼／QR nonce，
 *   被看到就能換成自己的金鑰重送一次、變成「已驗證」好友。現在 via 是封給收件人身分金鑰的信封（identitySeal，
 *   寄件者簽名、綁 from／to，網域 aegistalk-friend-via-v1），裡面是 { kind, proof }，
 *   proof = base64(HMAC-SHA256(key = 憑證, msg = "aegistalk-friend-via-v1|寄件者公鑰|這封的 ephemeral 公鑰"))。
 *   只封 proof 不夠：短碼只有約 2^30 種，看得到 proof 的人可以離線暴力猜出短碼（AegisPlay 審查）。
 *   收端：拆信封（簽章要是 INIT 的寄件者）→ 拿自己記著、還沒過期的同種憑證逐一重算比對。
 *   每個角色是一支真的手機（真的身分金鑰、真的 groupKeyDelivery.friendViaSealer，見 friendViaKit）。
 * Run: node scripts/review/friend_strict_accept_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { friendViaKit } from './friendViaKit.mjs';
import { verify } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const srcPath = (p) => root + 'packages/pwa/src/' + p;
const src = (p) => readFileSync(srcPath(p), 'utf8');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

// ── 真的 friendInvites.ts（記憶體 localStorage、可控時間） ──
const SEC = 1000, MIN = 60 * SEC, DAY = 24 * 60 * MIN, T0 = 1_800_000_000_000;
const store = new Map();
let now = T0;
const at = (ms) => { now = T0 + ms; };
const FakeDate = class extends Date { static now() { return now; } };
const fiNames = ['rememberShortCode', 'acceptedVia', 'issueQrInvite', 'qrScanExpired', 'cleanPeerName', 'QR_INVITE_GRACE_MS', 'makeVia', 'viaName'];
const fi = new Function('localStorage', 'Date', 'crypto', transformSync(src('services/friendInvites.ts').replace(/^export /gm, ''), { loader: 'ts' }).code
  + `;return {${fiNames.map((k) => `${k}: typeof ${k} === 'undefined' ? undefined : ${k}`).join(',')}};`)(
  { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, FakeDate, globalThis.crypto);
const GRACE = fi.QR_INVITE_GRACE_MS ?? 30 * SEC;
/** 規格（AegisPlay 會用同一套，換 domain 字串）：base64(HMAC-SHA256(key = utf8(憑證), msg = utf8("aegistalk-friend-via-v1|" + 寄件者 + "|" + ephemeral))) */
const specProof = (token, sender, eph) => createHmac('sha256', Buffer.from(token, 'utf8'))
  .update(`aegistalk-friend-via-v1|${sender}|${eph}`, 'utf8').digest('base64');
/** 32-byte X25519 公鑰的 base64（INIT 的 ephemeral 要是 32 bytes，審查 L2） */
const key32 = (n) => Buffer.alloc(32, n).toString('base64');
const EPH = key32(5);

// ── 每個角色一支真的手機：真的 Ed25519 身分金鑰＋真的 friendViaSealer（via 封給收件人的身分金鑰） ──
const kit = await friendViaKit(root);
const P = {};
for (const n of ['BOB', 'ALICE_PK', 'MALLORY_PK', 'STRANGER', 'LATE', 'BLOCKED', 'FAY', 'SOMEONE_ELSE', 'CAROL']) P[n] = await kit.party(n);
const partyOf = (x) => P[x] ?? Object.values(P).find((p) => p.pk === x);
const pkOf = (x) => partyOf(x)?.pk ?? x;
const BOB = P.BOB.pk, ALICE = P.ALICE_PK.pk, MALLORY = P.MALLORY_PK.pk;
// 開源第 5b 步：既有好友的 INIT 要有寄件人身分金鑰的簽章（services/x3dhInitAuth.ts）—— 真的模組、各自手機真的身分金鑰簽
const authDir = mkdtempSync(join(tmpdir(), 'initauth-'));
await require('esbuild').build({ entryPoints: [srcPath('services/x3dhInitAuth.ts')], bundle: true, platform: 'node',
  format: 'esm', outfile: join(authDir, 'a.mjs'), logLevel: 'silent' });
const IA = await import(pathToFileURL(join(authDir, 'a.mjs')));
/** 一個「真的拿到憑證的人」（sender）會送的 via：用 App 自己的 makeVia 算 proof、用他手機的 sealer 封給 to */
const viaFor = async (kind, token, sender, eph = EPH, to = BOB) => {
  assert.equal(typeof fi.makeVia, 'function', 'friendInvites exports makeVia (the token never goes on the wire)');
  const p = partyOf(sender);
  return fi.makeVia({ kind, token }, p.pk, eph, to, p.sealer);
};

const cut = (text, from, to, file) => {
  const a = text.indexOf(from); const b = text.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${file} has "${from}" … "${to}"`);
  return text.slice(a, b);
};
const tsx = (code) => transformSync(code.replace(/\bimport\(/g, '__import('), { loader: 'tsx' }).code;

// ── 收端：真的 AppProvider X3DH_INIT handler ──
const provider = src('providers/AppProvider.tsx');
const x3dhCode = tsx(cut(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息', 'AppProvider'));

/** Bob 的手機收到一封 X3DH_INIT。friend：Bob 已有的好友紀錄（冷啟動時 findFriendSettled 等一下才拿得到） */
async function receiveInit(from, payload, { friend, blocked = false } = {}) {
  let handler; const r = { added: [], accepted: [], sent: [], logs: [], errors: [], trust: [] };
  const log = (sink) => (...a) => sink.push(a.map(String).join(' '));
  runInNewContext(x3dhCode, {
    useEffect: (fn) => fn(), Date, JSON, Promise,
    console: { error: log(r.errors), log: log(r.logs), warn: log(r.logs), info: log(r.logs), debug: log(r.logs) },
    mqtt: { isConnected: true, subscribe: (t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: { X3DH_INIT: 'x3dh_init', PREKEY_REQUEST: 'prekey_request', PROFILE_UPDATE: 'profile_update' },
    getFriendByPublicKey: () => undefined,
    findFriendSettled: async (pk) => { await new Promise((ok) => setTimeout(ok, 5)); return pk === friend?.publicKey ? friend : undefined; },
    updateFriendProfile() {}, addFriend: (...a) => r.added.push(a),
    fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, devLog() {}, publicKey: BOB, friendViaSealer: P.BOB.sealer,
    hasSessionWith: () => false, wasInitAccepted: () => false, isInitOlderThanAccepted: () => false, recentlyInitiatedTo: () => false, rememberAcceptedInit() {},
    signedPreKey: { publicKeyBase64: 'BOB_SPK', signatureBase64: 'BOB_SIG' },
    mqttService: { sendToUser: (to, type) => r.sent.push([to, type]), serverNow: () => now, boundedNow: () => now },
    verifyInitAuth: IA.verifyInitAuth, identityVerify: verify, initResetBudget: IA.createResetBudget(),
    // 開源第 4 步：個人資料、預備金鑰請求封給對方的身分金鑰（directSignal）—— 一樣記成「送了什麼給誰」
    sendProfileUpdate: async (to) => { r.sent.push([to, 'profile_update']); return true; },
    sendPrekeyRequest: async (to) => { r.sent.push([to, 'prekey_request']); return true; },
    viaName: fi.viaName,
    clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {},
    webrtcService: { disconnect() {} }, acceptSession: (...a) => r.accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }),
    getServiceTranslation: () => (k) => k, localStorage: { getItem: () => null },
    useChatStore: { getState: () => ({ userProfile: { displayName: 'Bob' }, updateFriendTrust: (...a) => r.trust.push(a) }) },
    acceptedVia: fi.acceptedVia, cleanPeerName: fi.cleanPeerName, isBlacklisted: async () => blocked,
    usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  });
  r.errors.length = 0; r.logs.length = 0;   // 只算處理這封訊息時印的（effect 掛 listener 時那行不算）
  const full = { ephemeralPublicKey: EPH, senderName: 'Mallory', signedPreKey: 'S', signature: 'G', sessionReset: true, ...payload };
  // 真的手機送的 INIT 都帶寄件人的簽章（AddFriendModal 送出的已經帶了；這裡直接造的補上）
  if (!('auth' in full) && partyOf(from)) full.auth = IA.signInitAuth(partyOf(from).mod.currentSealer(), BOB, full, now);
  await handler({ from: pkOf(from), payload: full });
  return r;
}
const refused = (r) => r.added.length === 0 && r.accepted.length === 0 && r.sent.length === 0;

await check('a stranger INIT with no via is refused: no friend, no session, my profile is not sent back', async () => {
  store.clear(); at(0);
  const r = await receiveInit('STRANGER', { trustLevel: 'verified' });
  assert.ok(refused(r), `added=${r.added.length} sessions=${r.accepted.length} sent=${JSON.stringify(r.sent)}`);
});

await check('a stranger INIT with a credential I never issued (or for another account, or an unknown kind) is refused', async () => {
  store.clear(); at(0);
  fi.rememberShortCode('SOMEONE_ELSE', 'ABC234', now + DAY);
  const S = partyOf('STRANGER');
  const proofs = [await viaFor('code', 'ATK-ABC234', 'STRANGER'), await viaFor('qr', 'guessed', 'STRANGER'),
    await S.sealer.seal(BOB, { kind: 'admin', proof: 'x'.repeat(44) }), await S.sealer.seal(BOB, { kind: 'constructor', proof: 'x'.repeat(44) }),
    { kind: 'constructor', proof: 'x'.repeat(44) }];
  for (const via of [...proofs, { kind: 'code', token: 'ATK-ABC234' }, 'ATK-ABC234']) {
    const r = await receiveInit('STRANGER', { via });
    assert.ok(refused(r), `via ${JSON.stringify(via)} → added=${r.added.length} sessions=${r.accepted.length}`);
  }
});

await check('an INIT carrying a QR nonce processed 30 minutes after the QR was shown is refused, not added as unverified', async () => {
  store.clear(); at(0);
  const { nonce } = fi.issueQrInvite(BOB);
  const via = await viaFor('qr', nonce, 'LATE');
  at(29 * MIN + 59 * SEC);
  assert.ok(!refused(await receiveInit('LATE', { via })), 'control: the same INIT processed at 29:59 is accepted');
  at(30 * MIN + SEC);
  const r = await receiveInit('LATE', { via });
  assert.ok(refused(r), `added=${JSON.stringify(r.added.map((a) => [a[0], a[2]]))} sessions=${r.accepted.length}`);
});

await check('an INIT carrying a short code past its server expiry + 24 h is refused', async () => {
  store.clear(); at(0);
  fi.rememberShortCode(BOB, 'XYZ789', now + DAY);           // 伺服器說 24 小時後到期
  const via = await viaFor('code', 'ATK-XYZ789', 'LATE');
  at(DAY + 23 * 60 * MIN);
  assert.ok(!refused(await receiveInit('LATE', { via })), 'control: an INIT that waited in the broker queue (within 24 h of expiry) is accepted');
  at(2 * DAY + SEC);
  const r = await receiveInit('LATE', { via });
  assert.ok(refused(r), `added=${r.added.length} sessions=${r.accepted.length}`);
});

await check('the old wire format (the raw code / QR nonce as via.token) is refused even for a live credential', async () => {
  store.clear(); at(0);
  fi.rememberShortCode(BOB, 'ABC234', now + DAY);
  const { nonce } = fi.issueQrInvite(BOB);
  for (const via of [{ kind: 'code', token: 'ATK-ABC234' }, { kind: 'code', token: 'ABC234' }, { kind: 'qr', token: nonce },
    { kind: 'qr', token: nonce, proof: nonce }, { kind: 'qr', proof: specProof(nonce, ALICE, EPH) }]) {   // 最後一個：proof 對、但沒封
    const r = await receiveInit(ALICE, { via });
    assert.ok(refused(r), `via ${JSON.stringify(via)} → added=${r.added.length} sessions=${r.accepted.length}`);
  }
});

await check('a refusal logs exactly one line, without the sender name or the token', async () => {
  store.clear(); at(0);
  const r = await receiveInit('STRANGER', { senderName: 'Mallory<script>', via: { kind: 'code', token: 'ATK-SECRET' } });
  assert.ok(refused(r), 'refused');
  const all = [...r.errors, ...r.logs];
  assert.equal(r.errors.length, 1, `one console.error line, got ${JSON.stringify(r.errors)}`);
  assert.ok(!all.some((l) => /Mallory|SECRET/.test(l)), `no content in logs: ${JSON.stringify(all)}`);
  assert.ok(r.errors[0].includes(pkOf('STRANGER').slice(0, 12)), 'says whose INIT (key prefix)');
});

await check('a blocked person is refused even with a valid credential', async () => {
  store.clear(); at(0);
  fi.rememberShortCode(BOB, 'ABC234', now + DAY);
  const via = await viaFor('code', 'ATK-ABC234', 'BLOCKED');
  assert.ok(!refused(await receiveInit('BLOCKED', { via })), 'control: the same INIT from someone not blocked is accepted');
  const r = await receiveInit('BLOCKED', { via }, { blocked: true });
  assert.ok(refused(r), `added=${r.added.length} sessions=${r.accepted.length}`);
});

await check('an existing friend re-sending / repairing an INIT without via still works (also on a cold start), trust kept', async () => {
  store.clear(); at(0);
  const friend = { publicKey: pkOf('FAY'), name: 'Fay', trustLevel: 'verified', avatar: 'a', pushSubscription: undefined };
  for (const payload of [{}, { repair: true }, { sessionReset: false }]) {
    const r = await receiveInit('FAY', payload, { friend });
    assert.equal(r.accepted.length, 1, `session accepted for ${JSON.stringify(payload)}`);
    assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[pkOf('FAY'), 'verified']], 'only the bundle is refreshed, trust stays verified');
    assert.ok(r.sent.some(([to, t]) => to === pkOf('FAY') && t === 'profile_update'), 'profile sent back to the friend');
  }
});

await check('an INIT whose ephemeral key is not 32 bytes is refused before anything is added (review L2: no friend without a session)', async () => {
  store.clear(); at(0);
  const { nonce } = fi.issueQrInvite(BOB);
  for (const eph of [Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), '', 'not base64 at all']) {
    const via = await viaFor('qr', nonce, ALICE, eph);    // 憑證是真的，只有 ephemeral 壞掉
    const r = await receiveInit(ALICE, { via, ephemeralPublicKey: eph });
    assert.ok(refused(r), `eph ${JSON.stringify(eph)} (${Buffer.from(eph, 'base64').length} bytes) → added=${r.added.length} sessions=${r.accepted.length}`);
  }
  for (const eph of [undefined, 42]) {
    const r = await receiveInit(ALICE, { via: await viaFor('qr', nonce, ALICE), ephemeralPublicKey: eph });
    assert.ok(refused(r), `eph ${eph} → refused`);
  }
  const fay = { publicKey: pkOf('FAY'), id: 'friend-FAY', name: 'Fay', trustLevel: 'verified' };
  const r = await receiveInit('FAY', { ephemeralPublicKey: Buffer.alloc(16, 1).toString('base64') }, { friend: fay });
  assert.equal(r.added.length + r.accepted.length + r.sent.length, 0, 'an existing friend\'s malformed INIT touches nothing either');
  const ok = await receiveInit(ALICE, { via: await viaFor('qr', nonce, ALICE) });
  assert.deepEqual(ok.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']], 'control: a 32-byte ephemeral key is accepted');
});

await check('an existing unverified friend who scans my QR again becomes verified on my side too (review L3); a short code or a bad proof does not', async () => {
  store.clear(); at(0);
  const { nonce } = fi.issueQrInvite(BOB);
  fi.rememberShortCode(BOB, 'ABC234', now + DAY);
  const fay = () => ({ publicKey: pkOf('FAY'), id: 'friend-FAY', name: 'Fay', trustLevel: 'unverified' });
  let r = await receiveInit('FAY', { via: await viaFor('qr', nonce, 'FAY') }, { friend: fay() });
  assert.equal(r.accepted.length, 1, 'session accepted');
  assert.deepEqual(r.trust, [['friend-FAY', 'verified']], `upgraded to verified (got ${JSON.stringify(r.trust)})`);
  r = await receiveInit('FAY', { via: await viaFor('code', 'ABC234', 'FAY') }, { friend: fay() });
  assert.deepEqual(r.trust, [], 'a short code re-add keeps the trust level');
  r = await receiveInit('FAY', { via: await viaFor('qr', nonce, 'SOMEONE_ELSE') }, { friend: fay() });
  assert.deepEqual(r.trust, [], 'a proof made for someone else does not upgrade');
  r = await receiveInit('FAY', { via: await viaFor('qr', 'never-shown', 'FAY') }, { friend: fay() });
  assert.deepEqual(r.trust, [], 'a QR I never showed does not upgrade');
  r = await receiveInit('FAY', {}, { friend: fay() });
  assert.deepEqual(r.trust, [], 'a repair INIT without via does not upgrade');
  r = await receiveInit('FAY', { via: await viaFor('qr', nonce, 'FAY') }, { friend: { ...fay(), trustLevel: 'verified' } });
  assert.deepEqual(r.trust, [], 'already verified: nothing to do');
});

// ── 送出端：真的 AddFriendModal（掃 QR、風險警告後確認、輸入短碼） ──
const modal = src('components/Verification/AddFriendModal.tsx');
const friendCodeSrc = src('components/Verification/FriendCode.tsx');
const qrInviteSrc = (() => { const i = modal.indexOf('const qrInvite'); return i >= 0 ? modal.slice(i, modal.indexOf('\n\n', i)) : ''; })();
const modalCode = tsx(qrInviteSrc + '\n' + cut(modal, 'const proceedAddFriend = useCallback(', '// 開始掃描', 'AddFriendModal'))
  + ';({ handleQrScanned, handleConfirmAddFriend, handleFriendCodeSubmit })';
const fcHelpers = new Function(tsx(cut(friendCodeSrc, 'export function isShortCode', 'export default FriendCode', 'FriendCode').replace(/^export /gm, ''))
  + ';return { isShortCode, ShortCodeRateLimitedError,'
  + ' isFriendCode: typeof isFriendCode === "undefined" ? undefined : isFriendCode,'
  + ' parseFriendCode: typeof parseFriendCode === "undefined" ? undefined : parseFriendCode };')();

/** Alice 的手機：加好友彈窗。回傳送出去的 X3DH_INIT 與畫面上的錯誤 */
function aliceModal({ friendCodeInput = '', pendingQrData = null, lookup = async () => null, risky = false } = {}) {
  const r = { inits: [], scanError: '', codeError: '', reAdded: [] };
  const fns = runInNewContext(modalCode, {
    useCallback: (fn) => fn, publicKey: ALICE, Date: FakeDate, JSON, Math, Error, atob, btoa,
    console: { error() {}, log() {}, warn() {} }, devLog() {}, devWarn() {},
    setStatusMessage() {}, setScanStatus() {}, setScanError: (m) => { r.scanError = m; }, setRiskWarning() {},
    setFriendCodeError: (m) => { r.codeError = m; }, setFriendCodeProcessing() {}, setFriendCodeInput() {},
    riskWarning: { show: !!pendingQrData, riskInfo: {}, pendingQrData }, friendCodeInput, t: (k) => k,
    // 信任分數查詢、雲端備份寫入（開源第 5a 步起經 @ext）：跟以前一樣「查到空的紀錄、寫入成功」
    ext: { antiFraud: { contactRisk: async () => ({}) }, identity: { backup: { flushNow: async () => ({ success: true }) } } }, shouldShowWarning: () => risky,
    mqttService: { getState: () => 'connected', connect: async () => {}, isConnected: () => true,
      sendToUser: (to, type, payload) => r.inits.push({ to, type, payload: JSON.parse(JSON.stringify(payload)) }) },
    MessageType: { X3DH_INIT: 'x3dh_init' }, ConnectionState: { CONNECTED: 'connected' },
    fromBase64: (s) => s, toBase64: (b) => Buffer.from(b).toString('base64'), clearPeerSession: async () => {}, webrtcService: { disconnect() {} },
    deletePendingMessagesForRecipient: async () => {}, reAddFriend: async (...a) => { r.reAdded.push(a); },
    createSession: () => ({ ephemeralPublicKey: Buffer.alloc(32, 7) }), flushSessionWrites: async () => {},
    userProfile: { displayName: 'Alice' }, signedPreKey: { publicKeyBase64: 'ALICE_SPK', signatureBase64: 'ALICE_SIG' },
    onFriendAdded() {}, onClose() {}, setTimeout: () => 0,
    qrScanExpired: (e) => fi.qrScanExpired(e), lookupShortCode: lookup, ...fcHelpers, makeVia: fi.makeVia, friendViaSealer: P.ALICE_PK.sealer,
    withInitAuth: (to, p) => ({ ...p, auth: IA.signInitAuth(P.ALICE_PK.mod.currentSealer(), to, p, now) }),
    setAwaiting() {}, addAttemptRef: { current: 0 }, usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  });
  return { ...fns, r };
}

// ── 發憑證的一端：真的 QRCodeVerification.generateQR、真的 FriendCode.fetchShortCode ──
const qrComp = src('components/Verification/QRCodeVerification.tsx');
async function bobShowsQr() {
  const encoded = [];
  const { generateQR } = runInNewContext(tsx(cut(qrComp, 'const generateQR = useCallback(', '// 打開畫面', 'QRCodeVerification')) + ';({ generateQR })', {
    useCallback: (fn) => fn, publicKey: BOB, signedPreKey: { publicKeyBase64: 'BOB_SPK', signatureBase64: 'BOB_SIG' },
    displayName: 'Bob', t: (k) => k, onError() {}, issueQrInvite: fi.issueQrInvite, generatingRef: { current: false },
    QRCode: { toDataURL: async (text) => { encoded.push(text); return 'data:'; } },
    setQr() {}, setNow() {}, setError() {}, setIsGeneratingQR() {}, Date: FakeDate, JSON,
  });
  await generateQR();
  assert.equal(encoded.length, 1, 'Bob drew a QR');
  return encoded[0];
}
async function bobShowsShortCode(shortCode) {
  const { fetchShortCode } = runInNewContext(tsx(cut(friendCodeSrc, 'const fetchShortCode = useCallback(', '// 自動取得短碼', 'FriendCode')) + ';({ fetchShortCode })', {
    useCallback: (fn) => fn, publicKey: BOB, signedPreKey: { publicKeyBase64: 'BOB_SPK', signatureBase64: 'BOB_SIG' },
    displayName: 'Bob', t: (k) => k, onError() {}, onCodeGenerated() {}, apiBase: () => 'https://api', JSON, Error,
    // 請求簽章（開源第 3 步）在 shortcode_request_self_test.mjs 驗；這裡只要碼主人記下發出去的碼
    mqttService: { identitySignerFor: (pk) => ({ publicKey: pk, sign: () => new Uint8Array(64) }), serverNow: () => now, boundedNow: () => now },
    signedShortCodeRequest: (signer, bundle, action) => ({ action, public_key: signer.publicKey }),
    fetch: async () => ({ ok: true, json: async () => ({ short_code: shortCode, expires_at: Math.floor(now / 1000) + 86400, remaining_seconds: 86400, is_new: true }) }),
    rememberShortCode: fi.rememberShortCode, setIsLoading() {}, setError() {}, setShortCode() {}, setExpiresAt() {},
  });
  await fetchShortCode();
}
/** 伺服器 /api/shortcode/lookup 回 Bob 註冊的資料 */
const bobLookup = (shortCode) => async (code) => (code.trim().toUpperCase().replace(/^ATK-/, '') === shortCode
  ? { v: 1, pk: BOB, spk: 'BOB_SPK', sig: 'BOB_SIG', name: 'Bob' } : null);

await check('round trip, QR scan: Bob shows his QR → Alice scans → Bob adds Alice as verified and accepts the session', async () => {
  store.clear(); at(0);
  const qrText = await bobShowsQr();
  at(4 * MIN + 59 * SEC);
  const alice = aliceModal();
  await alice.handleQrScanned(qrText);
  assert.equal(alice.r.inits.length, 1, `Alice sent one INIT (error: ${alice.r.scanError})`);
  const { to, payload } = alice.r.inits[0];
  assert.equal(to, BOB);
  assert.equal((await P.BOB.sealer.open(ALICE, BOB, payload.via)).kind, 'qr', 'the INIT carries a sealed proof of the QR nonce');
  at(5 * MIN + 10 * SEC);                                  // 掃到時 4:59，INIT 在寬限內才到
  const r = await receiveInit(ALICE, payload);
  assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']]);
  assert.equal(r.accepted.length, 1, 'session accepted');
});

await check('round trip, QR scanned at 4:59 and Bob\'s phone locked: Bob only processes the INIT at 25:00 → still verified (review M1)', async () => {
  store.clear(); at(0);
  const qrText = await bobShowsQr();
  at(4 * MIN + 59 * SEC);
  const alice = aliceModal();
  await alice.handleQrScanned(qrText);
  assert.equal(alice.r.inits.length, 1, `sent (error: ${alice.r.scanError})`);
  at(25 * MIN);                                           // 掃完 Bob 就鎖屏，INIT 在離線佇列等了 20 分鐘
  const r = await receiveInit(ALICE, alice.r.inits[0].payload);
  assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']], 'Bob adds Alice (it used to be refused after 5:30)');
  assert.equal(r.accepted.length, 1, 'session accepted');
});

await check('round trip, QR scan after a risk warning: confirmed in time → verified', async () => {
  store.clear(); at(0);
  const qrText = await bobShowsQr();
  at(2 * MIN);
  const alice = aliceModal({ pendingQrData: JSON.parse(qrText) });
  await alice.handleConfirmAddFriend();
  assert.equal(alice.r.inits.length, 1, `sent (error: ${alice.r.scanError})`);
  const r = await receiveInit(ALICE, alice.r.inits[0].payload);
  assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']]);
  assert.equal(r.accepted.length, 1);
});

await check('round trip, short code: Bob shows ATK-XXXXXX → Alice types it → Bob adds Alice as unverified and accepts the session', async () => {
  store.clear(); at(0);
  await bobShowsShortCode('K7M2QP');
  at(DAY + 12 * 60 * MIN);                                 // 碼在伺服器 24h；到期前送出的 INIT 在 broker 佇列等了半天才到
  for (const typed of ['ATK-K7M2QP', 'atk-k7m2qp']) {
    const alice = aliceModal({ friendCodeInput: typed, lookup: bobLookup('K7M2QP') });
    await alice.handleFriendCodeSubmit();
    assert.equal(alice.r.inits.length, 1, `sent for "${typed}" (error: ${alice.r.codeError})`);
    assert.equal((await P.BOB.sealer.open(ALICE, BOB, alice.r.inits[0].payload.via)).kind, 'code', 'the INIT carries a sealed proof of the short code');
    const r = await receiveInit(ALICE, alice.r.inits[0].payload);
    assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[ALICE, 'unverified']]);
    assert.equal(r.accepted.length, 1, 'session accepted');
  }
});

await check('the via is sealed to Bob\'s identity key: the broker sees no credential, kind or proof (no offline brute force of a short code); only Bob opens it', async () => {
  store.clear(); at(0);
  const qrText = await bobShowsQr();
  const { n } = JSON.parse(qrText);
  const alice = aliceModal();
  await alice.handleQrScanned(qrText);
  assert.equal(alice.r.inits.length, 1, `Alice sent one INIT (error: ${alice.r.scanError})`);
  const { payload } = alice.r.inits[0];
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes(n), 'the QR nonce is not on the wire');
  assert.deepEqual(Object.keys(payload.via ?? {}).sort(), ['ct', 'ek', 'n', 'v'], `via is an identity-seal envelope: ${JSON.stringify(payload.via)}`);
  assert.ok(!/"proof"|"kind"|"token"/.test(wire), 'no proof, kind or token in clear');
  await assert.rejects(P.MALLORY_PK.sealer.open(ALICE, MALLORY, payload.via), 'Mallory (who can read Bob\'s inbox) cannot open it');
  await assert.rejects(P.CAROL.sealer.open(ALICE, P.CAROL.pk, payload.via), 'nor can anyone else');
  const body = await P.BOB.sealer.open(ALICE, BOB, payload.via);
  assert.equal(body.kind, 'qr');
  assert.equal(body.proof, specProof(n, ALICE, payload.ephemeralPublicKey),
    'inside: proof = base64(HMAC-SHA256(nonce, "aegistalk-friend-via-v1|" + sender + "|" + ephemeral))');
  assert.ok(!JSON.stringify(body).includes(n), 'the nonce itself is not even inside');

  store.clear();
  await bobShowsShortCode('K7M2QP');
  const a2 = aliceModal({ friendCodeInput: 'atk-k7m2qp', lookup: bobLookup('K7M2QP') });
  await a2.handleFriendCodeSubmit();
  assert.equal(a2.r.inits.length, 1, `sent (error: ${a2.r.codeError})`);
  const p2 = a2.r.inits[0].payload;
  assert.ok(!/K7M2QP/i.test(JSON.stringify(p2)) && !/"proof"/.test(JSON.stringify(p2)), 'neither the short code nor its proof is on the wire');
  const body2 = await P.BOB.sealer.open(ALICE, BOB, p2.via);
  assert.equal(body2.proof, specProof('K7M2QP', ALICE, p2.ephemeralPublicKey), 'the code is normalised (upper case, no ATK-) before the HMAC');
});

await check('cold start: an INIT that arrives just before Bob\'s identity is unlocked is still accepted (the sealer waits for it)', async () => {
  store.clear(); at(0);
  const { nonce } = fi.issueQrInvite(BOB);
  const via = await viaFor('qr', nonce, ALICE);
  P.BOB.lock();
  setTimeout(() => P.BOB.unlock(), 300);
  const r = await receiveInit(ALICE, { via });
  assert.deepEqual(r.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']], 'accepted once the identity is unlocked');
});

await check('a via sealed for someone else, or sealed by someone other than the INIT sender, is refused', async () => {
  store.clear(); at(0);
  const { nonce } = fi.issueQrInvite(BOB);
  let r = await receiveInit(ALICE, { via: await viaFor('qr', nonce, ALICE, EPH, P.CAROL.pk) });
  assert.ok(refused(r), 'sealed to Carol, sent to Bob → Bob cannot open it');
  r = await receiveInit(ALICE, { via: await viaFor('qr', nonce, 'MALLORY_PK') });
  assert.ok(refused(r), 'sealed and signed by Mallory but sent as Alice → refused (signature / from binding)');
  r = await receiveInit(ALICE, { via: await viaFor('qr', nonce, ALICE) });
  assert.ok(!refused(r), 'control: sealed by Alice for Bob → accepted');
});

await check('a via copied from someone else\'s INIT (as seen on the broker) is refused under another key or another ephemeral key', async () => {
  store.clear(); at(0);
  const qrText = await bobShowsQr();
  const alice = aliceModal();
  await alice.handleQrScanned(qrText);
  const { payload } = alice.r.inits[0];
  for (const [from, p] of [[MALLORY, payload], [MALLORY, { ...payload, ephemeralPublicKey: key32(66) }],
    [ALICE, { ...payload, ephemeralPublicKey: key32(77) }]]) {
    const r = await receiveInit(from, p);
    assert.ok(refused(r), `${from} eph=${p.ephemeralPublicKey} → added=${r.added.length} sessions=${r.accepted.length}`);
  }
  const mine = await receiveInit(ALICE, payload);
  assert.deepEqual(mine.added.map((a) => [a[0], a[2]]), [[ALICE, 'verified']], 'control: Alice\'s own INIT is accepted');
});

await check('a legacy aegis: long code is rejected on the input screen (no INIT that would be refused)', async () => {
  const legacy = 'aegis:' + btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, pk: BOB, spk: 'BOB_SPK', sig: 'BOB_SIG', name: 'Bob' }))));
  const alice = aliceModal({ friendCodeInput: legacy });
  await alice.handleFriendCodeSubmit();
  assert.equal(alice.r.inits.length, 0, 'no INIT sent');
  assert.equal(alice.r.reAdded.length, 0, 'Bob is not added on Alice\'s side either');
  assert.ok(alice.r.codeError, 'Alice sees an error');
});

await check('a QR without a nonce (v1, or v2 missing n) is rejected on scan (no INIT that would be refused)', async () => {
  at(0);
  for (const qr of [{ v: 1, pk: BOB, spk: 'S', sig: 'G', name: 'Bob' }, { v: 2, pk: BOB, spk: 'S', sig: 'G', name: 'Bob', ts: T0, exp: T0 + 5 * MIN }]) {
    const alice = aliceModal();
    await alice.handleQrScanned(JSON.stringify(qr));
    assert.equal(alice.r.inits.length, 0, `v${qr.v}: no INIT sent`);
    assert.equal(alice.r.reAdded.length, 0, `v${qr.v}: not added on Alice's side`);
    assert.ok(alice.r.scanError, `v${qr.v}: Alice sees an error`);
  }
});

// ── INVITE_ACCEPT：邀請連結整條拿掉，連訊息型別都沒了 ──
await check('INVITE_ACCEPT is gone: not a message type (the MQTT validator drops it before any listener or buffer), no listener (review L4)', () => {
  const mqttSrc = src('services/mqtt.ts');
  const e = mqttSrc.indexOf('export enum MessageType {');
  const enumBody = mqttSrc.slice(e, mqttSrc.indexOf('\n}', e));
  assert.ok(e >= 0 && enumBody.includes('X3DH_INIT'), 'found the MessageType enum');
  assert.doesNotMatch(enumBody, /INVITE_ACCEPT|invite_accept/, 'MessageType has no INVITE_ACCEPT');
  assert.doesNotMatch(mqttSrc, /'invite_accept'/, 'not listed as a critical / persistent type either');
  assert.match(mqttSrc, /const knownTypes = Object\.values\(MessageType\) as string\[\];\s*if \(!knownTypes\.includes\(msg\.type\)\) return false;/,
    'validateMessage rejects unknown types, so a forged invite_accept is dropped');
  assert.doesNotMatch(provider, /INVITE_ACCEPT/, 'AppProvider has no INVITE_ACCEPT listener');
  assert.doesNotMatch(src('hooks/useCrypto.ts'), /INVITE_ACCEPT/, 'no stale INVITE_ACCEPT comment in useCrypto');
});

await check('dead leftovers are gone (review L4): invite-link storage and table, sendX3DHInit, unused texts, trustLevel in X3DH_INIT', () => {
  assert.doesNotMatch(src('services/storage.ts'), /InviteLink|invite_links/, 'storage.ts has no invite-link helpers');
  assert.doesNotMatch(src('services/database.ts'), /invite_links/, 'no invite_links table or index is created');
  assert.doesNotMatch(src('services/mqtt.ts'), /sendX3DHInit/, 'mqttService.sendX3DHInit removed');
  assert.doesNotMatch(src('hooks/useMqtt.ts'), /sendX3DHInit/, 'useMqtt wrapper removed');
  for (const f of ['i18n/types.ts', 'i18n/locales/en.ts', 'i18n/locales/ja.ts', 'i18n/locales/ko.ts', 'i18n/locales/zh-CN.ts', 'i18n/locales/zh-TW.ts']) {
    assert.doesNotMatch(src(f), /\b(friendInvite|someoneWantsToAdd|unverifiedHint|defaultUserName):/, `${f}: unused invite-dialog texts removed`);
  }
  const sends = [];
  // 開源第 5b 步：payload 包在 withInitAuth(收件人, { … }) 裡（加寄件人身分金鑰的簽章）
  for (const m of provider.matchAll(/MessageType\.X3DH_INIT, (?:withInitAuth\([^,]+, )?\{/g)) {
    sends.push(provider.slice(m.index, provider.indexOf('});', m.index)));
  }
  assert.ok(sends.length >= 2, `found the X3DH_INIT sends in AppProvider (${sends.length})`);
  for (const body of sends) assert.doesNotMatch(body, /trustLevel/, `an X3DH_INIT send still carries trustLevel: ${body.slice(0, 80)}`);
  const modalInit = modal.slice(modal.indexOf('const initPayload: X3DHInitPayload = {'), modal.indexOf('};', modal.indexOf('const initPayload: X3DHInitPayload = {')));
  assert.doesNotMatch(modalInit.replace(/\/\/.*$/gm, ''), /trustLevel/, 'AddFriendModal does not send trustLevel');
  const handlerType = cut(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 不印對方自取的名字', 'AppProvider');
  assert.doesNotMatch(handlerType, /trustLevel\?:/, 'the receiver does not even declare a trustLevel field');
});

await check('the invite-link path is gone: no URL parsing, no accept dialog, no INVITE_ACCEPT sender, no link generator', () => {
  const app = src('App.tsx');
  const chat = src('pages/ChatApp.tsx');
  assert.doesNotMatch(app, /parseInviteLink|checkForInviteLink|pendingInvite/, 'App.tsx no longer reads ?invite= links');
  assert.doesNotMatch(chat, /MessageType\.INVITE_ACCEPT|pendingInvite|handleAcceptInvite|InviteModal/, 'ChatApp has no invite dialog');
  assert.ok(!existsSync(srcPath('services/verification.ts')), 'services/verification.ts (createInviteLink) removed');
  assert.doesNotMatch(src('services/index.ts'), /verification/, 'services/index.ts does not re-export it');
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = d + '/' + n; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const senders = walk(srcPath('').replace(/\/$/, '')).filter((p) => /\.tsx?$/.test(p))
    .filter((p) => /sendToUser\([^;]*INVITE_ACCEPT/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(senders, [], 'nothing sends INVITE_ACCEPT');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nALL PASS');

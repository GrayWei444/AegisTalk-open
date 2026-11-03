/**
 * 加好友的一方（掃 QR、輸入短碼）不再馬上說「已加入」，要等對方確認（程式碼審查 M1）。
 *   以前：Alice 掃完 Bob 的 QR、送出 X3DH_INIT，畫面馬上「已加入」、Bob 也已經在 Alice 的好友清單。可是 Bob 可能
 *   很久之後才處理那封 INIT（掃完就鎖屏、離線佇列），晚到超過 QR 期限就整封拒收 —— Alice 以為加好了，
 *   傳過去的訊息 Bob 全部丟掉，兩邊都不知道。
 *   現在：
 *   - Bob 那邊 QR 認到畫出來後 30 分鐘（qr_invite_window_self_test）。
 *   - Alice 送出 INIT 就把 Bob 記成「等待確認」（stores/pendingFriendStore，依帳號分開、重開 App 還在，記著這封 INIT
 *     的 ephemeral），畫面說「等待 Bob 確認」。確認只認兩種：Bob 收下 INIT 回的 PROFILE_UPDATE 帶著**這封 INIT 的
 *     ephemeral**（initEph）；或第一則解得開的 Bob 的訊息（解得開＝他用的是這次建的 session）。一般的個人資料更新、
 *     回舊 INIT 的、Bob 自己送來的 X3DH_INIT 都不算。等 2 分鐘還沒確認就改說「對方還沒確認，他打開 App 就會加上；
 *     沒加上就重新掃一張新的 QR」（5 種語言）。
 *   - 彈窗：開始新的一次（掃到新 QR、送出短碼）先清掉上一次的等待畫面；await 回來時已經開始了新的一次或彈窗關了，
 *     就不再改畫面（加好友本身照樣做完）。
 *   - 沒確認的 Bob 不是「看起來加好了、訊息卻默默丟掉」的半個好友：好友清單有「等待確認」標記，聊天室頂端說明，
 *     可以取消（刪掉這個好友）。
 *   真的 pendingFriendStore（stub 掉 zustand）、真的 friendInvites、真的 AddFriendModal 加好友程式碼、
 *   真的 AppProvider X3DH_INIT／PROFILE_UPDATE handler，配 stub 執行。
 * Run: node scripts/review/friend_add_confirm_self_test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { extVm } from './extStub.mjs';
import { friendViaKit } from './friendViaKit.mjs';
import { verify } from './directKit.mjs';
import { MODES, flagContext } from './groupEnforcementFlags.mjs';
import { receiveScope, visibleTypes } from './providerScope.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const { transformSync } = esbuild;
const src = (p) => readFileSync(root + 'packages/pwa/src/' + p, 'utf8');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

const SEC = 1000, MIN = 60 * SEC, T0 = 1_800_000_000_000;
let now = T0;
const at = (ms) => { now = T0 + ms; };
const FakeDate = class extends Date { static now() { return now; } };

// ── 真的 friendInvites ──
const fiStore = new Map();
const fiNames = ['rememberShortCode', 'acceptedVia', 'issueQrInvite', 'qrScanExpired', 'cleanPeerName', 'makeVia', 'viaName'];
const fi = new Function('localStorage', 'Date', 'crypto', transformSync(src('services/friendInvites.ts').replace(/^export /gm, ''), { loader: 'ts' }).code
  + `;return {${fiNames.map((k) => `${k}: typeof ${k} === 'undefined' ? undefined : ${k}`).join(',')}};`)(
  { getItem: (k) => fiStore.get(k) ?? null, setItem: (k, v) => fiStore.set(k, v), removeItem: (k) => fiStore.delete(k) }, FakeDate, globalThis.crypto);

// ── 真的 pendingFriendStore（zustand 換成最小實作；localStorage 用記憶體） ──
const ls = new Map();
globalThis.localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
const realDateNow = Date.now;
Date.now = () => now;                                     // store 用 Date.now() 記時間
const dir = mkdtempSync(join(tmpdir(), 'friendconfirm-'));
const zustandStub = { name: 'zustand-stub', setup(b) {
  b.onResolve({ filter: /^zustand$/ }, () => ({ path: 'zustand', namespace: 'z' }));
  b.onLoad({ filter: /.*/, namespace: 'z' }, () => ({ loader: 'js', contents: `export function create(fn) { let state; const subs = new Set();
    const set = (p) => { const prev = state; state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; for (const s of [...subs]) s(state, prev); };
    const get = () => state; state = fn(set, get); const hook = (sel) => (sel ? sel(state) : state);
    hook.getState = get; hook.setState = set; hook.subscribe = (l) => { subs.add(l); return () => subs.delete(l); }; return hook; }` }));
} };
/** 每次載入是一個新的 App 行程（重開 App）：狀態從 localStorage 讀回來 */
async function loadPendingStore(tag) {
  try {
    await esbuild.build({ entryPoints: [root + 'packages/pwa/src/stores/pendingFriendStore.ts'], bundle: true, platform: 'node',
      format: 'esm', outfile: join(dir, `pf-${tag}.mjs`), logLevel: 'silent', plugins: [zustandStub] });
    return await import(pathToFileURL(join(dir, `pf-${tag}.mjs`)));
  } catch { return null; }
}
const PF = await loadPendingStore('main');
const needPF = () => assert.ok(PF, 'stores/pendingFriendStore.ts exists (pending friend adds)');
const pendingOf = (owner, pk) => PF.findPending(PF.usePendingFriendStore.getState().entries, owner, pk);
const resetPending = () => { ls.clear(); PF?.usePendingFriendStore.setState({ entries: [] }); };

const cut = (text, from, to, file) => {
  const a = text.indexOf(from); const b = text.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${file} has "${from}" … "${to}"`);
  return text.slice(a, b);
};
const tsx = (code) => transformSync(code.replace(/\bimport\(/g, '__import('), { loader: 'tsx' }).code;
const provider = src('providers/AppProvider.tsx');
// Alice、Bob 各一支真的手機（真的身分金鑰；via 封給收件人的身分金鑰，見 friendViaKit）
const kit = await friendViaKit(root);
const PA = await kit.party('ALICE'), PB = await kit.party('BOB');
const ALICE = PA.pk, BOB = PB.pk;
// 開源第 5b 步：既有好友的 INIT 要有寄件人身分金鑰的簽章（services/x3dhInitAuth.ts）—— 真的模組、各自手機真的身分金鑰簽
const authDir = mkdtempSync(join(tmpdir(), 'initauth-'));
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/x3dhInitAuth.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(authDir, 'a.mjs'), logLevel: 'silent' });
const IA = await import(pathToFileURL(join(authDir, 'a.mjs')));
const signerOf = (pk) => (pk === ALICE ? PA : pk === BOB ? PB : null)?.mod.currentSealer();
const quiet = { error() {}, log() {}, warn() {}, info() {}, debug() {} };

// ── Bob 收 INIT：真的 X3DH_INIT handler ──
const x3dhCode = tsx(cut(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息', 'AppProvider'));
async function receiveInit(me, from, payload, { friend } = {}) {
  let handler; const r = { added: [], accepted: [], sent: [] };
  runInNewContext(x3dhCode, {
    useEffect: (fn) => fn(), Date, JSON, Promise, console: quiet,
    mqtt: { isConnected: true, subscribe: (t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: { X3DH_INIT: 'x3dh_init', PREKEY_REQUEST: 'prekey_request', PROFILE_UPDATE: 'profile_update' },
    getFriendByPublicKey: () => friend, findFriendSettled: async (pk) => (pk === friend?.publicKey ? friend : undefined),
    updateFriendProfile() {}, addFriend: (...a) => r.added.push(a),
    fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, devLog() {}, publicKey: me, friendViaSealer: (me === BOB ? PB : PA).sealer,
    hasSessionWith: () => false, wasInitAccepted: () => false, isInitOlderThanAccepted: () => false, recentlyInitiatedTo: () => false, rememberAcceptedInit() {},
    signedPreKey: { publicKeyBase64: 'SPK', signatureBase64: 'SIG' },
    mqttService: { sendToUser: (to, type, payload) => r.sent.push([to, type, payload]), serverNow: () => now, boundedNow: () => now },
    verifyInitAuth: IA.verifyInitAuth, identityVerify: verify, initResetBudget: IA.createResetBudget(),
    // 開源第 4 步：個人資料、預備金鑰請求封給對方的身分金鑰（directSignal）—— 這裡記下送了什麼
    sendProfileUpdate: async (to, profile) => { r.sent.push([to, 'profile', profile]); return true; },
    sendPrekeyRequest: async (to, bundle) => { r.sent.push([to, 'prekey', bundle]); return true; },
    viaName: fi.viaName,
    clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {},
    webrtcService: { disconnect() {} }, acceptSession: (...a) => r.accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }),
    getServiceTranslation: () => (k) => k, localStorage: { getItem: () => null },
    useChatStore: { getState: () => ({ userProfile: { displayName: me }, updateFriendTrust() {} }) },
    acceptedVia: fi.acceptedVia, cleanPeerName: fi.cleanPeerName, isBlacklisted: async () => false,
    usePendingFriendStore: PF?.usePendingFriendStore,
  });
  const full = { signedPreKey: 'S', signature: 'G', sessionReset: true, ...payload };
  // 真的手機送的 INIT 都帶寄件人的簽章（AddFriendModal 送出的已經帶了；這裡直接造的補上）
  if (!('auth' in full) && signerOf(from)) full.auth = IA.signInitAuth(signerOf(from), me, full, now);
  await handler({ from, payload: full });
  return r;
}

// ── Alice 收個人資料（開源第 4 步：DIRECT_SEALED kind profile，directSignal 驗過簽章才交給這個 handler）：真的 handler ──
const profileCode = tsx(cut(provider, '// 全域監聽 PROFILE_UPDATE - 好友個人資料更新', '// （PROFILE_REQUEST 拿掉了', 'AppProvider'));
function receiveProfile(me, from, friends = [{ publicKey: BOB, name: 'Bob' }], payload = { displayName: 'Bob', avatar: '' }) {
  let handler; const updated = [];
  runInNewContext(profileCode, {
    useEffect: (fn) => fn(), console: quiet, devLog() {}, setTimeout: () => 0, publicKey: me, cryptoReady: true,
    onDirect: (kind, cb) => { assert.equal(kind, 'profile'); handler = cb; return () => {}; },
    cleanPeerName: fi.cleanPeerName,
    getFriendByPublicKey: (pk) => friends.find((f) => f.publicKey === pk),
    updateFriendProfile: (pk, p) => updated.push([pk, p.displayName]),
    useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => friends.find((f) => f.publicKey === pk), updateFriendProfile() {} }) },
    usePendingFriendStore: PF?.usePendingFriendStore,
  });
  handler(from, { kind: 'profile', ...payload });
  return updated;
}
/** Bob 收下 INIT 後回給 Alice 的那則個人資料（封給 Alice 的身分金鑰）的內容 */
const profileReply = (bob) => bob.sent.find(([to, t]) => to === ALICE && t === 'profile')?.[2];

// ── Alice 解開一則 1-1 訊息：真的 processEncryptedMessage ──
const pemCode = transformSync('globalThis.__p = (() => {' + cut(provider, 'const processEncryptedMessage = async (', '// 儲存到 ref，讓 P2P', 'AppProvider')
  + ' return processEncryptedMessage; })();', { loader: 'ts' }).code;
async function receiveMessage(me, from, { decryptOk = true } = {}) {
  const shown = [];
  const ctx = {
    console: quiet, diagLog() {}, devLog() {}, devWarn() {}, JSON, Date, Promise, ...flagContext(MODES[0][1]), ...visibleTypes, ...receiveScope, globalThis: {}, publicKey: me,
    getFriendByPublicKey: (pk) => (pk === BOB ? { id: 'friend-bob', publicKey: BOB, name: 'Bob' } : undefined),
    RatchetMessage: { fromJson: (x) => x },
    decrypt: async () => { if (!decryptOk) throw new Error('aead::Error'); return JSON.stringify({ id: 'm1', type: 'text', content: 'hi' }); },
    isBlacklisted: async () => false, receiveMessage: async () => shown.push('shown'),
    useChatStore: { getState: () => ({ getFriendByPublicKey: () => undefined, messages: {} }) }, useGroupStore: { getState: () => ({}) },
    isStorageInitialized: () => true,
    window: { dispatchEvent() {} }, CustomEvent: class {}, aeadRepairRequestRef: { current: new Map() },
    mqttService: { sendToUser() {} }, MessageType: {}, signedPreKey: null, isAegisReady: () => false, ext: extVm,
    sendPrekeyRequest: async () => true,
    usePendingFriendStore: PF?.usePendingFriendStore,
  };
  runInNewContext(pemCode, ctx);
  await ctx.globalThis.__p(from, 'CIPHERTEXT');
  return shown;
}

// ── Alice 的加好友彈窗：真的 proceedAddFriend／handleQrScanned／handleFriendCodeSubmit ──
const modal = src('components/Verification/AddFriendModal.tsx');
const qrInviteSrc = (() => { const i = modal.indexOf('const qrInvite'); return i >= 0 ? modal.slice(i, modal.indexOf('\n\n', i)) : ''; })();
const modalCode = tsx(qrInviteSrc + '\n' + cut(modal, 'const proceedAddFriend = useCallback(', '// 開始掃描', 'AddFriendModal'))
  + ';({ handleQrScanned, handleFriendCodeSubmit })';
const EPH_A = Buffer.alloc(32, 7).toString('base64');
/** gate：讓下一次 flushSessionWrites 卡住，直到 release()（模擬很慢的那一步） */
function gate() { let release; const promise = new Promise((ok) => { release = ok; }); return { promise, release }; }
function aliceModal({ friendCodeInput = '', lookup = async () => null, createSession, slow = [] } = {}) {
  const r = { inits: [], status: '', scanError: '', codeError: '', reAdded: [], friendAdded: [], closed: 0, timers: [], awaiting: null, messages: [] };
  const addAttemptRef = { current: 0 };
  const ctx = {
    useCallback: (fn) => fn, publicKey: ALICE, Date: FakeDate, JSON, Math, Error, console: quiet, devLog() {}, devWarn() {},
    setStatusMessage: (m) => r.messages.push(m), setScanStatus: (s) => { r.status = s; }, setScanError: (m) => { r.scanError = m; },
    setRiskWarning() {}, setFriendCodeError: (m) => { r.codeError = m; }, setFriendCodeProcessing() {}, setFriendCodeInput() {},
    setAwaiting: (v) => { r.awaiting = typeof v === 'function' ? v(r.awaiting) : v; },
    riskWarning: { show: false, riskInfo: null, pendingQrData: null }, friendCodeInput, t: (k) => k,
    // 信任分數查詢、雲端備份寫入（開源第 5a 步起經 @ext）：跟以前一樣「查到空的紀錄、寫入成功」
    ext: { antiFraud: { contactRisk: async () => ({}) }, identity: { backup: { flushNow: async () => ({ success: true }) } } }, shouldShowWarning: () => false,
    mqttService: { getState: () => 'connected', connect: async () => {}, isConnected: () => true,
      sendToUser: (to, type, payload) => r.inits.push({ to, type, payload: JSON.parse(JSON.stringify(payload)) }) },
    MessageType: { X3DH_INIT: 'x3dh_init' }, ConnectionState: { CONNECTED: 'connected' },
    fromBase64: (s) => s, toBase64: (s) => (typeof s === 'string' ? s : Buffer.from(s).toString('base64')),
    clearPeerSession: async () => {}, webrtcService: { disconnect() {} },
    deletePendingMessagesForRecipient: async () => {}, reAddFriend: async (...a) => { r.reAdded.push(a); },
    createSession: createSession ?? (() => ({ ephemeralPublicKey: Buffer.alloc(32, 7) })),
    flushSessionWrites: () => (slow.length ? slow.shift().promise : Promise.resolve()), addAttemptRef,
    userProfile: { displayName: 'Alice' }, signedPreKey: { publicKeyBase64: 'ALICE_SPK', signatureBase64: 'ALICE_SIG' },
    onFriendAdded: (...a) => r.friendAdded.push(a), onClose: () => { r.closed++; },
    setTimeout: (fn, ms) => { r.timers.push(ms); return 0; },
    qrScanExpired: (e) => fi.qrScanExpired(e), lookupShortCode: lookup, makeVia: fi.makeVia, friendViaSealer: PA.sealer,
    withInitAuth: (to, p) => ({ ...p, auth: IA.signInitAuth(PA.mod.currentSealer(), to, p, now) }),
    isShortCode: (c) => /^ATK-[A-Z2-9]{6}$/.test(c.trim().toUpperCase()), ShortCodeRateLimitedError: class extends Error {},
    usePendingFriendStore: PF?.usePendingFriendStore,
  };
  const fns = runInNewContext(modalCode, ctx);
  /** 使用者關掉彈窗（關閉的 effect 做的事）；ctx 讓測試在中途換掉輸入框的內容 */
  return { ...fns, r, ctx, close: () => { addAttemptRef.current++; } };
}
function bobQr() {
  const { nonce, issuedAt, expiresAt } = fi.issueQrInvite(BOB);
  return JSON.stringify({ v: 2, pk: BOB, spk: 'BOB_SPK', sig: 'BOB_SIG', name: 'Bob', ts: issuedAt, exp: expiresAt, n: nonce });
}

await check('pending store (real): mark → pending; confirm clears it (and says it was pending); cancel; per account; survives an app restart', async () => {
  needPF(); resetPending(); at(0);
  const s = PF.usePendingFriendStore.getState();
  s.markPending(ALICE, BOB, 'qr', 'EPH1');
  assert.deepEqual(JSON.parse(JSON.stringify(pendingOf(ALICE, BOB))), { owner: ALICE, pk: BOB, via: 'qr', eph: 'EPH1', since: T0 });
  assert.equal(PF.usePendingFriendStore.getState().confirm(ALICE, BOB, 'EPH_OF_AN_OLDER_INIT'), false, 'an answer to another INIT does not confirm');
  assert.ok(pendingOf(ALICE, BOB), 'still pending');
  assert.equal(pendingOf('CAROL', BOB), undefined, 'another account on this phone is not waiting for Bob');
  assert.equal(PF.usePendingFriendStore.getState().confirm('CAROL', BOB), false, 'confirming for another account does nothing');
  assert.ok(pendingOf(ALICE, BOB), 'still pending for Alice');
  const restarted = await loadPendingStore('restart');
  assert.ok(restarted.findPending(restarted.usePendingFriendStore.getState().entries, ALICE, BOB), 'still pending after reopening the app');
  assert.equal(PF.usePendingFriendStore.getState().confirm(ALICE, BOB, 'EPH1'), true, 'the answer to this INIT confirms (and says Bob was pending)');
  assert.equal(pendingOf(ALICE, BOB), undefined, 'confirmed → no longer pending');
  assert.equal(PF.usePendingFriendStore.getState().confirm(ALICE, BOB), false, 'a second confirmation is a no-op');
  s.markPending(ALICE, 'DAVE', 'code');
  PF.usePendingFriendStore.getState().cancel(ALICE, 'DAVE');
  assert.equal(pendingOf(ALICE, 'DAVE'), undefined, 'cancelled');
  s.markPending(ALICE, 'ERIN', 'code', 'E1');
  assert.equal(PF.usePendingFriendStore.getState().confirm(ALICE, 'ERIN'), true, 'confirm without an INIT key (a decrypted message) needs no match');
  s.markPending(ALICE, 'FRED', 'qr');
  PF.usePendingFriendStore.getState().forgetPeer('FRED');
  assert.equal(pendingOf(ALICE, 'FRED'), undefined, 'forgetPeer (friend removed) drops the entry');
  const again = await loadPendingStore('restart2');
  assert.equal(again.usePendingFriendStore.getState().entries.length, 0, 'confirm / cancel are saved too');
});

await check('addFriendPhase: "waiting" for 2 minutes, then "not confirmed yet"; "confirmed" once the pending entry is gone', () => {
  needPF();
  assert.equal(PF.FRIEND_CONFIRM_WAIT_MS, 2 * MIN);
  assert.equal(PF.addFriendPhase(T0, true, T0 + 2 * MIN - 1), 'waiting');
  assert.equal(PF.addFriendPhase(T0, true, T0 + 2 * MIN), 'unconfirmed');
  assert.equal(PF.addFriendPhase(T0, true, T0 + 3 * 60 * MIN), 'unconfirmed');
  assert.equal(PF.addFriendPhase(T0, false, T0 + 10 * SEC), 'confirmed');
  assert.equal(PF.addFriendPhase(T0, false, T0 + 10 * MIN), 'confirmed');
});

await check('QR scan (real AddFriendModal): after the INIT Alice sees "waiting for Bob", Bob is pending, nothing reports him as added', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const alice = aliceModal();
  await alice.handleQrScanned(bobQr());
  assert.equal(alice.r.inits.length, 1, `INIT sent (error: ${alice.r.scanError})`);
  assert.equal(alice.r.reAdded.length, 1, 'Bob is in Alice\'s list (session ready, so queued messages go out once he accepts)');
  assert.equal(pendingOf(ALICE, BOB)?.via, 'qr', 'Bob is pending (via QR)');
  assert.equal(pendingOf(ALICE, BOB)?.eph, alice.r.inits[0].payload.ephemeralPublicKey, 'tied to this INIT\'s ephemeral key');
  assert.equal(alice.r.status, 'waiting', `status "waiting", not "success" (got ${alice.r.status})`);
  assert.deepEqual(JSON.parse(JSON.stringify(alice.r.awaiting ?? {})), { pk: BOB, name: 'Bob', via: 'qr', since: T0, syncFailed: false });
  assert.equal(alice.r.friendAdded.length, 0, 'not reported as added yet');
  assert.equal(alice.r.closed + alice.r.timers.length, 0, 'the modal does not close by itself');
  assert.ok(!alice.r.messages.some((m) => /Successfully added/.test(m)), `no "Successfully added": ${JSON.stringify(alice.r.messages)}`);
});

await check('short code (real AddFriendModal): same — "waiting", pending via code, not reported as added', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  fi.rememberShortCode(BOB, 'K7M2QP', now + 24 * 60 * MIN);
  const alice = aliceModal({ friendCodeInput: 'ATK-K7M2QP',
    lookup: async () => ({ v: 1, pk: BOB, spk: 'BOB_SPK', sig: 'BOB_SIG', name: 'Bob' }) });
  await alice.handleFriendCodeSubmit();
  assert.equal(alice.r.inits.length, 1, `INIT sent (error: ${alice.r.codeError})`);
  assert.equal(pendingOf(ALICE, BOB)?.via, 'code');
  assert.equal(alice.r.awaiting?.via, 'code');
  assert.equal(alice.r.friendAdded.length + alice.r.closed + alice.r.timers.length, 0, 'not reported as added, modal stays');
});

await check('Bob accepts (real X3DH_INIT handler) → the PROFILE_UPDATE he sends back confirms Bob on Alice\'s side (real handler)', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const alice = aliceModal();
  await alice.handleQrScanned(bobQr());
  at(20 * MIN);                                           // Bob 鎖屏 20 分鐘才處理到
  const bob = await receiveInit(BOB, ALICE, alice.r.inits[0].payload);
  assert.equal(bob.accepted.length, 1, 'Bob accepted the session');
  // 開源第 4 步：INIT 上沒有名字；Alice 的名字在封給 Bob 的 via 裡，Bob 用它加 Alice
  assert.ok(!('senderName' in alice.r.inits[0].payload), 'the INIT carries no display name on the broker');
  assert.equal(bob.added[0]?.[1], 'Alice', 'Bob names Alice from the sealed via');
  const reply = profileReply(bob);
  assert.ok(reply, 'Bob sends Alice his profile (the accept signal)');
  assert.equal(reply.initEph, alice.r.inits[0].payload.ephemeralPublicKey, 'it names the INIT it answers (initEph)');
  assert.ok(pendingOf(ALICE, BOB), 'still pending until that arrives');
  const updated = receiveProfile(ALICE, BOB, undefined, reply);
  assert.equal(pendingOf(ALICE, BOB), undefined, 'confirmed');
  // 名字照加好友時一樣過 cleanPeerName（控制字元、角括號、40 字）—— 這裡 Bob 的名字是他的公鑰（44 字）
  assert.deepEqual(updated, [[BOB, fi.cleanPeerName(reply.displayName, '')]], 'the profile itself is still applied');
});

await check('Bob refuses (INIT processed too late) → no PROFILE_UPDATE → Bob stays pending on Alice\'s side and the text turns to "not confirmed yet"', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const alice = aliceModal();
  await alice.handleQrScanned(bobQr());
  at(31 * MIN);
  const bob = await receiveInit(BOB, ALICE, alice.r.inits[0].payload);
  assert.equal(bob.accepted.length + bob.added.length + bob.sent.length, 0, 'Bob refused, sent nothing');
  const p = pendingOf(ALICE, BOB);
  assert.ok(p, 'Bob is still pending — visible and cancellable, not a silent friend');
  assert.equal(PF.addFriendPhase(p.since, true, now), 'unconfirmed');
});

await check('a PROFILE_UPDATE from someone else, or meant for another account on the phone, does not confirm Bob', async () => {
  needPF(); resetPending(); at(0);
  PF.usePendingFriendStore.getState().markPending(ALICE, BOB, 'qr');
  receiveProfile(ALICE, 'CAROL_PK', [{ publicKey: 'CAROL_PK', name: 'Carol' }], { displayName: 'Carol', initEph: 'X' });
  receiveProfile('OTHER_ACCOUNT', BOB, undefined, { displayName: 'Bob', initEph: 'X' });
  assert.ok(pendingOf(ALICE, BOB), 'still pending');
});

await check('a PROFILE_UPDATE that does not answer this INIT (a plain profile change, or the answer to an older INIT) does not confirm Bob', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const first = aliceModal();
  await first.handleQrScanned(bobQr());
  const oldInit = first.r.inits[0].payload;
  const second = aliceModal({ createSession: () => ({ ephemeralPublicKey: Buffer.alloc(32, 8) }) });   // Alice 重掃一次
  await second.handleQrScanned(bobQr());
  receiveProfile(ALICE, BOB);                                                     // 一般的個人資料更新
  assert.ok(pendingOf(ALICE, BOB), 'a plain profile update does not confirm');
  receiveProfile(ALICE, BOB, undefined, { displayName: 'Bob', initEph: oldInit.ephemeralPublicKey });
  assert.ok(pendingOf(ALICE, BOB), 'the answer to the superseded INIT does not confirm');
  receiveProfile(ALICE, BOB, undefined, { displayName: 'Bob', initEph: second.r.inits[0].payload.ephemeralPublicKey });
  assert.equal(pendingOf(ALICE, BOB), undefined, 'the answer to the current INIT does');
});

await check('the first message from Bob that Alice can decrypt confirms him (real processEncryptedMessage); a failed decrypt or an INIT from "Bob" does not', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  PF.usePendingFriendStore.getState().markPending(ALICE, BOB, 'code', 'EPH_A');
  const r = await receiveInit(ALICE, BOB, { ephemeralPublicKey: Buffer.alloc(32, 9).toString('base64') },
    { friend: { publicKey: BOB, name: 'Bob', trustLevel: 'unverified' } });
  assert.equal(r.accepted.length, 1, 'Alice accepted an INIT claiming to be from Bob');
  assert.ok(pendingOf(ALICE, BOB), 'that alone does not confirm (anyone can put Bob\'s key in "from")');
  await receiveMessage(ALICE, BOB, { decryptOk: false });
  assert.ok(pendingOf(ALICE, BOB), 'a message that does not decrypt does not confirm');
  const shown = await receiveMessage(ALICE, BOB);
  assert.deepEqual(shown, ['shown'], 'the message is shown');
  assert.equal(pendingOf(ALICE, BOB), undefined, 'a decrypted message confirms');
});

await check('a new scan / code submit clears the previous "waiting" screen at once', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const alice = aliceModal();
  await alice.handleQrScanned(bobQr());
  assert.ok(alice.r.awaiting, 'waiting for Bob');
  const next = alice.handleQrScanned(bobQr());
  assert.equal(alice.r.awaiting, null, 'cleared before the next add even starts its key exchange');
  await next;
  alice.r.awaiting = { stale: true };
  alice.ctx.friendCodeInput = 'ATK-ZZZZZZ';
  const code = alice.handleFriendCodeSubmit();
  assert.equal(alice.r.awaiting, null, 'a code submit clears it too');
  await code;
});

await check('a slow add that is overtaken (new scan, or the modal closed) does not overwrite the screen — but still finishes', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const g = gate();
  const alice = aliceModal({ slow: [g] });
  const first = alice.handleQrScanned(bobQr());              // 第一次卡在存 session
  await new Promise((ok) => setTimeout(ok, 10));
  alice.ctx.friendCodeInput = 'ATK-K7M2QP';
  const carol = await kit.party('CAROL');
  alice.ctx.lookupShortCode = async () => ({ v: 1, pk: carol.pk, spk: 'S', sig: 'G', name: 'Carol' });
  await alice.handleFriendCodeSubmit();                      // 第二次（短碼加 Carol）先做完
  assert.equal(alice.r.awaiting?.name, 'Carol', 'the screen shows the newer add');
  g.release(); await first;                                  // 第一次這時才回來
  assert.equal(alice.r.awaiting?.name, 'Carol', 'the older add does not overwrite it');
  assert.equal(alice.r.status, 'waiting');
  assert.ok(alice.r.inits.some((i) => i.to === BOB), 'the older add still sent its INIT');
  assert.ok(pendingOf(ALICE, BOB), 'and Bob is pending');

  resetPending();
  const g2 = gate();
  const bob2 = aliceModal({ slow: [g2] });
  const p = bob2.handleQrScanned(bobQr());
  await new Promise((ok) => setTimeout(ok, 10));
  bob2.close();                                              // 使用者關掉彈窗
  g2.release(); await p;
  assert.equal(bob2.r.awaiting, null, 'closed modal: no "waiting" screen set afterwards');
  assert.ok(pendingOf(ALICE, BOB), 'the add itself still finished (Bob pending, visible in the list)');
});

await check('something failing after Bob was added locally leaves him pending (visible, cancellable), not a silent friend', async () => {
  needPF(); resetPending(); fiStore.clear(); at(0);
  const alice = aliceModal({ createSession: () => { throw new Error('x3dh failed'); } });
  await alice.handleQrScanned(bobQr());
  assert.equal(alice.r.inits.length, 0, 'no INIT');
  assert.equal(alice.r.reAdded.length, 1, 'Bob was already in Alice\'s list');
  assert.ok(pendingOf(ALICE, BOB), 'so he is marked pending');
  assert.equal(alice.r.status, 'error');
});

await check('wiring: "added" only once the entry is gone; friend list badge; chat banner with cancel; deleting the friend clears it; 5 languages', () => {
  const addCb = modal.indexOf('const proceedAddFriend = useCallback(');
  const addEnd = modal.indexOf('// 開始掃描', addCb);
  assert.ok(!/onFriendAdded\?\.\(|onClose\(\)/.test(modal.slice(addCb, addEnd)), 'the add flow itself never reports "added" or closes the modal');
  assert.match(modal, /addFriendPhase\(awaiting\.since, !!awaitingEntry, Date\.now\(\)\)/, 'the modal derives its phase from the pending entry');
  assert.match(modal, /if \(phase !== 'confirmed' \|\| !awaiting\) return;[\s\S]{0,400}onFriendAddedRef\.current/, 'it reports "added" only when confirmed');
  assert.match(modal, /<FriendConfirmStatus/, 'the modal shows the waiting / not confirmed / added status');
  const status = src('components/Verification/FriendConfirmStatus.tsx');
  for (const k of ['friendConfirm.waiting', 'friendConfirm.notConfirmedQr', 'friendConfirm.notConfirmedCode', 'friendConfirm.added']) {
    assert.ok(status.includes(`'${k}'`), `FriendConfirmStatus uses ${k}`);
  }
  assert.doesNotMatch(status, /text-red/, 'not shown as an error');
  const list = src('components/FriendList/FriendList.tsx');
  assert.match(list, /findPending\(pendingEntries, publicKey, friend\.publicKey\)/, 'the friend list looks up pending friends');
  assert.match(src('components/FriendList/FriendItem.tsx'), /pendingLabel/, 'FriendItem shows the pending badge');
  const chat = src('components/ChatRoom/ChatRoom.tsx');
  assert.match(chat, /<PendingFriendBanner[\s\S]{0,200}onCancel=\{\(\) => setShowDeleteConfirm\(true\)\}/, 'the chat shows the banner; cancel = delete this friend (with the usual confirmation)');
  const store = src('stores/chatStore.ts');
  const rm = store.slice(store.indexOf('removeFriend: async (friendId) => {'), store.indexOf('getFriendByPublicKey: (publicKey) =>'));
  assert.match(rm, /usePendingFriendStore\.getState\(\)\.forgetPeer\(friend\.publicKey\)/, 'removeFriend itself clears the pending entry (every way of deleting a friend)');
  const banner = src('components/ChatRoom/PendingFriendBanner.tsx');
  for (const k of ['friendConfirm.waiting', 'friendConfirm.notConfirmedQr', 'friendConfirm.notConfirmedCode', 'friendConfirm.cancel']) {
    assert.ok(banner.includes(`'${k}'`), `banner uses ${k}`);
  }
  const types = src('i18n/types.ts');
  for (const k of ['waiting', 'notConfirmedQr', 'notConfirmedCode', 'added', 'badge', 'cancel']) assert.match(types, new RegExp(`\\b${k}: string;`));
  for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
    const loc = src(`i18n/locales/${lang}.ts`);
    const sec = loc.slice(loc.indexOf('friendConfirm: {'), loc.indexOf('},', loc.indexOf('friendConfirm: {')));
    assert.ok(sec.length > 20, `${lang} has friendConfirm`);
    for (const k of ['waiting', 'notConfirmedQr', 'notConfirmedCode', 'added']) assert.match(sec, new RegExp(`\\b${k}: (['"])[^'"\\n]*\\{name\\}[^'"\\n]*\\1,`), `${lang} ${k} has {name}`);
    for (const k of ['badge', 'cancel']) assert.match(sec, new RegExp(`\\b${k}: (['"])[^'"\\n]+\\1,`), `${lang} ${k}`);
  }
});

await check('the friend list\'s relative time ("just now", "5 min ago") comes from the locale, not hard-coded Chinese', () => {
  const item = src('components/FriendList/FriendItem.tsx');
  const code = item.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /[぀-ヿ㐀-鿿가-힯]/, 'FriendItem has no CJK text outside comments');
  const keys = { justNow: null, minutesAgo: 'minutes', hoursAgo: 'hours', daysAgo: 'days' };
  for (const [k, p] of Object.entries(keys)) {
    assert.ok(item.includes(`t('friendList.${k}'${p ? `, { ${p}: ` : ')'}`), `FriendItem uses friendList.${k}${p ? ` with {${p}}` : ''}`);
  }
  for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
    const loc = src(`i18n/locales/${lang}.ts`);
    const start = loc.indexOf('\n  friendList: {');
    const sec = loc.slice(start, loc.indexOf('\n  },', start));
    assert.ok(start > 0 && sec.length > 20, `${lang} has friendList`);
    for (const [k, p] of Object.entries(keys)) {
      const v = sec.match(new RegExp(`\\n    ${k}: (['"])([^'"\\n]+)\\1,`));
      assert.ok(v, `${lang} friendList.${k}`);
      if (p) assert.ok(v[2].includes(`{${p}}`), `${lang} friendList.${k} has {${p}}: ${v[2]}`);
    }
  }
});

Date.now = realDateNow;
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nALL PASS');

/**
 * 封鎖要擋住所有路，不是只有一對一文字（稽核 H13，對應 AegisPlay B49）：
 *   抽出 AppProvider 真的 processEncryptedMessage、handleGroupKeyMessage、X3DH_INIT effect、群組信封（GROUP_KEY_SEALED：
 *   邀請、金鑰；W1 起群組邀請只走這裡）effect，以及 voiceCall 的來電處理，配 stub 執行。
 *   以前封鎖檢查在「一般 1-1 訊息」那段，前面的檔案 manifest、群組金鑰分發、一對一加密的群組訊息、
 *   群組金鑰訊息全都照收；刪好友後對方送 X3DH_INIT 就把自己加回來；封鎖的人照樣能讓我響鈴、拉我進群。
 *   現在：解完密（ratchet 要同步）就丟，所有型別都丟；其他入口一樣先查封鎖。
 *   （以前的 groupEnforcement 開關 W1 拿掉了，成員檢查一直開著；MODES 只剩一種。）
 * Run: node scripts/review/block_all_paths_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extVm } from './extStub.mjs';
import { MODES, flagContext } from './groupEnforcementFlags.mjs';
import { receiveScope, visibleTypes } from './providerScope.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const provider = readFileSync(process.env.APP_PROVIDER_SRC ?? root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const between = (src, from, to) => {
  const s = src.indexOf(from); const e = src.indexOf(to, s);
  assert.ok(s >= 0 && e > s, `found ${from}`);
  return src.slice(s, e);
};
const blocked = async (pk) => pk === 'BLOCKED';
const quiet = { console: { error() {}, log() {}, warn() {} }, diagLog() {}, devLog() {}, devWarn() {}, JSON, Date, Promise };
// 存檔的群組畫面：這裡不測（group_view_scope_self_test），照寄件人給的存
const viewGroupIdsToSave = (s, g, c, get, unenforced) => unenforced;

// ── 解密後的所有型別（processEncryptedMessage） ──
const pemCode = transformSync('globalThis.__p = (() => {' + between(provider, 'const processEncryptedMessage = async (', '// 儲存到 ref，讓 P2P')
  + ' return processEncryptedMessage; })();', { loader: 'ts' }).code;
async function receive(sender, data, isBl = blocked, flags = MODES[0][1]) {
  const touched = [];
  const ctx = {
    ...quiet, ...flagContext(flags), ...visibleTypes, ...receiveScope, globalThis: {}, publicKey: 'ME',
    getFriendByPublicKey: (pk) => ({ id: pk, publicKey: pk, name: pk }),
    RatchetMessage: { fromJson: (s) => s }, decrypt: async () => JSON.stringify(data),
    isBlacklisted: isBl,
    groupKeyService: { handleKeyDistribution: async () => touched.push('group key installed'), getGroupKeyById: async () => null },
    retryPendingGroupMessages: async () => {},
    fileTransfer: { handleManifestPayload: async () => touched.push('file manifest accepted') },
    useGroupStore: { getState: () => ({ getGroupById: (id) => ({ id, members: [{ publicKey: sender, role: 'admin' }, { publicKey: 'ME' }] }),
      incrementUnread() {}, updateMemberNickname() {} }) },
    useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => ({ publicKey: pk }), messages: {} }) },
    viewGroupIdsToSave, isStorageInitialized: () => true, markGroupMessageProcessed: () => true,
    getConversationIdForPeer: (p) => 'conv-' + p, isAegisReady: () => false, ext: extVm,
    storageSaveMessage: async () => { touched.push('group message saved'); },
    window: { dispatchEvent(e) { touched.push('event ' + e.type); } }, CustomEvent: class { constructor(t) { this.type = t; } },
    receiveMessage: async () => touched.push('1-1 message shown'),
    aeadRepairRequestRef: { current: new Map() }, mqttService: { sendToUser() {} }, MessageType: {}, signedPreKey: null,
    sendPrekeyRequest: async () => true,
    usePendingFriendStore: { getState: () => ({ confirm: () => false }) },
  };
  runInNewContext(pemCode, ctx);
  await ctx.globalThis.__p(sender, 'CIPHERTEXT');
  return touched;
}
const manifest = { type: 'file_manifest', fileManifest: { fileId: 'f', name: 'scam.apk', size: 1 } };
const keyDist = { type: 'group_key_distribution', groupId: 'G', keyId: 'k', keyBase64: 'K', createdAt: 1, createdBy: 'x', isRotation: false };
const groupMsg = { id: 'm1', type: 'text', content: 'hi', groupId: 'G' };
for (const [mode, flags] of MODES) {
  assert.deepEqual(await receive('FRIEND', manifest, blocked, flags), ['file manifest accepted'], `${mode}: control: a normal friend's file goes through`);
  assert.deepEqual(await receive('BLOCKED', manifest, blocked, flags), [], `${mode}: a blocked contact cannot send files`);
  assert.deepEqual(await receive('BLOCKED', keyDist, blocked, flags), [], `${mode}: a blocked contact cannot hand me group keys`);
  assert.deepEqual(await receive('BLOCKED', groupMsg, blocked, flags), [], `${mode}: a blocked contact's group messages are dropped`);
  assert.deepEqual(await receive('BLOCKED', { id: 'm2', type: 'text', content: 'hi' }, blocked, flags), [], `${mode}: 1-1 text still dropped`);
}
console.log('PASS every decrypted message type from a blocked contact is dropped (after decrypt, so the ratchet stays in sync)');

// ── 群組金鑰加密的群訊（handleGroupKeyMessage） ──
const hs = provider.indexOf('const handleGroupKeyMessage = useCallback(');
const gkmCode = transformSync('globalThis.__h = ' + provider.slice(provider.indexOf('useCallback(', hs), provider.indexOf('}, [holdGroupMessage]);', hs))
  + '}, []);', { loader: 'ts' }).code;
/** 群組引擎：這個群在、寄件者在套上的名冊上、那一代的金鑰有 */
const engineStub = { knows: () => true, isMember: () => true, decryptKey: () => new Uint8Array(32), requestSync() {}, onGossip() {} };
async function groupKeyMsg(sender, isBl = blocked, flags = MODES[0][1]) {
  const saved = [];
  const ctx = {
    ...quiet, ...flagContext(flags), globalThis: {}, useCallback: (fn) => fn, isBlacklisted: isBl,
    groupKeyService: ({
      decryptWithGroupKey: async () => JSON.stringify({ id: 'm', content: 'hi' }), verifySignature: () => true, bytesToBase64: () => 'K' }),
    getGroupEngine: () => engineStub, holdGroupMessage() {},
    pendingGroupMessagesRef: { current: new Map() }, PENDING_GROUP_MSG_MAX: 200, publicKeyRef: { current: 'ME' }, hasMessageFrom: async () => false, ackGroupMessage() {}, groupMessagesInProgress: new Set(),
    offlineQueue: { cacheGroupMessage() {} }, isAegisReady: () => false, ext: extVm, viewGroupIdsToSave,
    getConversationIdForPeer: (p) => 'conv-' + p, storageSaveMessage: async (m) => saved.push(m),
    window: { dispatchEvent() {} }, CustomEvent: class {},
    useGroupStore: { getState: () => ({ getGroupById: () => ({ members: [{ publicKey: sender }, { publicKey: 'ME' }] }), incrementUnread() {}, updateMemberNickname() {} }) },
  };
  runInNewContext(gkmCode, ctx);
  await ctx.globalThis.__h(sender, { messageId: 'm', groupId: 'G', senderId: sender, timestamp: 1, type: 'text', encrypted: { keyId: 'k', ciphertext: 'c', iv: 'i' }, signature: '' });
  return saved.length;
}
for (const [mode, flags] of MODES) {
  assert.equal(await groupKeyMsg('FRIEND', blocked, flags), 1, `${mode}: control: a member's group message is saved`);
  assert.equal(await groupKeyMsg('BLOCKED', blocked, flags), 0, `${mode}: a blocked member's group-key messages are not shown`);
}
console.log('PASS group-key messages from a blocked member are dropped');

// 封鎖名單一時查不到（DB 還沒好、查詢丟錯）：已經解完密的訊息不能就這樣丟掉（ratchet 已經往前走，對方不會重送）。
//   當成沒封鎖並記一筆（部署前審查 LOW）
const broken = async () => { throw new Error('database not ready'); };
assert.deepEqual(await receive('FRIEND', { id: 'm3', type: 'text', content: 'hi' }, broken), ['1-1 message shown'],
  'a blacklist lookup error does not lose an already-decrypted 1-1 message');
assert.equal(await groupKeyMsg('FRIEND', broken), 1, 'nor a group-key message');
console.log('PASS a failing blacklist lookup does not drop messages');

// ── X3DH_INIT：刪好友＋封鎖後，對方不能自己加回來 ──
const x3dhCode = transformSync(between(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息').replace(/\bimport\(/g, '__import('), { loader: 'ts' }).code;
async function init(from) {
  let handler; const added = []; const accepted = [];
  runInNewContext(x3dhCode, {
    ...quiet, useEffect: (fn) => fn(), waitForLocalLists: async () => {}, mqtt: { isConnected: true, subscribe: (t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: {}, getFriendByPublicKey: () => undefined, findFriendSettled: async () => undefined, updateFriendProfile() {},
    addFriend: (...a) => added.push(a), fromBase64: (s) => Buffer.from(s, 'base64'), publicKey: 'ME',
    hasSessionWith: () => false, wasInitAccepted: () => false, recentlyInitiatedTo: () => false, rememberAcceptedInit() {},
    signedPreKey: null, mqttService: { sendToUser() {} }, clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {},
    sendPrekeyRequest: async () => true, sendProfileUpdate: async () => true, viaName: async () => null,
    webrtcService: { disconnect() {} }, acceptSession: (...a) => accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }), getServiceTranslation: () => (k) => k,
    localStorage: { getItem: () => null }, useChatStore: { getState: () => ({ userProfile: {} }) },
    // 陌生人要帶我發出的憑證才加得到我（friend_strict_accept_self_test）：這裡兩個人都帶一張對得上的
    acceptedVia: async (_owner, _from, _eph, via) => (via && typeof via === 'object' ? { kind: via.kind } : null), cleanPeerName: (n, f) => n || f, isBlacklisted: blocked,
    usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
    friendViaSealer: { seal: async () => { throw new Error('no identity in this test'); }, open: async () => { throw new Error('no identity in this test'); } },
  });
  await handler({ from, payload: { ephemeralPublicKey: Buffer.alloc(32, 4).toString('base64'), sessionReset: true, via: { kind: 'code', proof: 'PROOF_OF_MY_CODE' } } });
  return added.length + accepted.length;
}
assert.ok(await init('NEWPERSON') > 0, 'control: an unknown (not blocked) person with my valid code can still add me');
assert.equal(await init('BLOCKED'), 0, 'a blocked person cannot re-add themselves with X3DH_INIT, even with my valid code');
console.log('PASS a blocked person cannot become my friend again via X3DH_INIT');

// ── 群組信封（GROUP_KEY_SEALED：邀請、金鑰）：封鎖的好友不能拉我進群、不能塞金鑰 ──
// （W2：後面接的是群組主題 group_sealed 的 effect，W1 的 log 通知 effect 拿掉了）
const sealedCode = transformSync('/**\n' + between(provider, '   * 封給我身分金鑰的群組信封（groupKeyDelivery）', '  /**\n   * 群組主題上的 group_sealed'), { loader: 'ts' }).code;
async function sealed(from) {
  let handler; const reached = [];
  runInNewContext(sealedCode, {
    ...quiet, useEffect: (fn) => fn(), waitForLocalLists: async () => {}, publicKey: 'ME',
    mqtt: { isConnected: true, subscribe: (t, cb) => { handler = cb; return () => {}; } }, MessageType: {},
    sealedOpenBudget: { take: () => true }, keyAnswerBudget: { take: () => true }, isFriendOrFellowMember: async () => true,
    isBlacklisted: blocked, openGroupSealed: async (f, payload) => { reached.push('opened'); return { kind: 'invite', from: f, body: payload }; },
    waitForGroupEngine: async () => ({ onSealed: async () => { reached.push('engine'); } }),
  });
  await handler({ from, payload: { kind: 'invite', gid: 'G' } });
  return reached;
}
assert.deepEqual(await sealed('FRIEND'), ['opened', 'engine'], 'control: a friend\'s invite reaches the group engine');
assert.deepEqual(await sealed('BLOCKED'), [], 'a blocked friend\'s sealed invite / key message is dropped unopened');
console.log('PASS group invites and key messages from a blocked friend are ignored');

// ── 來電（voiceCall.handleCallRequest：開源第 4 步起是封好的 kind 'call' 的 request，帶 callId 與 seq） ──
const vc = readFileSync(root + 'packages/pwa/src/services/voiceCall.ts', 'utf8');
const method = between(vc, 'handleCallRequest(callerId: string, s: CallSignal, iat: number)', '/**\n   * 處理通話接受');
const isAsync = /private async handleCallRequest/.test(vc);
const callCode = transformSync(`globalThis.__call = ${isAsync ? 'async ' : ''}function ` + method.trimEnd(), { loader: 'ts' }).code;
async function ring(from, flags = MODES[0][1]) {
  const rang = [];
  let current = null;
  const self = { callState: 'idle', currentCall: null, notifyStateChange() {}, incomingCallListeners: [(pk) => rang.push(pk)], rejectCall() {},
    guard: { current: () => current, begin: (role, peer, callId) => { current = { role, peer, callId }; } }, count() {}, sendSignal() {} };
  const ctx = {
    ...quiet, ...flagContext(flags), globalThis: {}, CallState: { IDLE: 'idle', INCOMING: 'incoming' }, setTimeout: () => 0,
    mqttService: { serverNow: () => Date.now() }, CALL_REQUEST_MAX_AGE_MS: 35_000,
    isBlacklisted: blocked,
    useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => ({ publicKey: pk }) }) },
    findFriendSettled: async (pk) => ({ publicKey: pk }),
  };
  runInNewContext(callCode, ctx);
  await ctx.globalThis.__call.call(self, from, { sig: 'request', callId: 'C'.repeat(22), seq: 1, video: false }, Date.now());
  return rang;
}
for (const [mode, flags] of MODES) {
  assert.deepEqual(await ring('FRIEND', flags), ['FRIEND'], `${mode}: control: a friend can call`);
  assert.deepEqual(await ring('BLOCKED', flags), [], `${mode}: a blocked contact cannot make my phone ring`);
}
console.log('PASS calls from a blocked contact do not ring');

// 封鎖的好友也不能對我開 WebRTC 直連（看得到我的 IP、能灌 DataChannel；部署前審查 LOW）：抽出 useWebRTC 真的 policy
const rtcHook = readFileSync(root + 'packages/pwa/src/hooks/useWebRTC.ts', 'utf8');
const policyCode = transformSync(between(rtcHook, 'const isGroupMember =', 'setIsInitialized(true);'), { loader: 'ts' }).code;
let policy = null;
runInNewContext(policyCode, {
  ...quiet, webrtcService: { setInboundPolicy: (p) => { policy = p; }, setOfferProofs() {} }, isBlacklisted: blocked, localPublicKeyBase64: 'ME',
  useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => (pk === 'FRIEND' || pk === 'BLOCKED' ? { publicKey: pk } : undefined) }) },
  useGroupStore: { getState: () => ({ groups: [{ members: [{ publicKey: 'BLOCKED' }, { publicKey: 'MATE' }] }] }) },
  findFriendSettled: async () => undefined,
});
assert.deepEqual([await policy.isBlocked('FRIEND'), await policy.isKnown('FRIEND')], [false, true], 'control: friends can still open WebRTC');
assert.deepEqual([await policy.isBlocked('MATE'), await policy.isKnown('MATE')], [false, true], 'control: group members too');
assert.equal(await policy.isBlocked('BLOCKED'), true,
  'a blocked friend / group member is reported as blocked → webrtc.ts refuses it in both modes (webrtc_inbound_gate_self_test)');
console.log('PASS blocked contacts fail the WebRTC inbound gate');

// 來電處理丟錯（例如封鎖名單或好友清單查詢失敗）不能變成 unhandled rejection：每一則通話信令（request 也是）都在
//   handleSignal 的 this.signalChain.then(run).catch(...) 裡跑（審查 L3 起依序處理）；封鎖名單查不了 ＝ 不響（審查 L5）
const vcSrc = readFileSync(root + 'packages/pwa/src/services/voiceCall.ts', 'utf8');
const handleSignalSrc = between(vcSrc, 'private handleSignal(from: string, body: DirectBody): void {', '/**\n   * 發起通話');
assert.match(handleSignalSrc, /if \(s\.sig === 'request'\) return this\.handleCallRequest\(from, s, body\.iat\);/, 'requests go to handleCallRequest inside run()');
assert.match(handleSignalSrc, /this\.signalChain = this\.signalChain\.then\(run\)\.catch\(/, 'and run() rejections are caught');
assert.match(method, /await isBlacklisted\(callerId\)\.catch\(\(\) => true\)/, 'a failing block-list lookup does not ring');
console.log('PASS call-request handler errors are caught');

/**
 * 冷啟動時好友清單還沒載入，真的好友不能被當成陌生人（部署前審查 HIGH）：真的 chatStore（stub 掉 zustand／storage）、
 *   真的 webrtc.ts、抽出真的 voiceCall.handleCallRequest 與 AppProvider 的 X3DH_INIT／PREKEY_REQUEST，以及群組邀請的好友檢查
 *   （W1 起邀請是封給身分金鑰的 invite，經 GROUP_KEY_SEALED 交給群組引擎；好友檢查是引擎的 isFriend）。
 *   chatStore.loadFromStorage 先把每個好友的訊息都載完才一次填好友清單；推播喚醒的 App 在這段時間收到：
 *     - 好友的來電（CALL_REQUEST）→ 不響；
 *     - 好友的 WebRTC offer → 丟掉（訊息走 P2P，整段收不到）；
 *     - 好友重送／修復的 X3DH_INIT → 走陌生人分支，把已驗證的好友降成未驗證；
 *     - 好友的群組邀請、session 修復請求 → 丟掉（不會再送一次）。
 *   現在這些判斷先等好友清單載入（最多 8 秒），記憶體沒有再直接查 contacts 表；陌生人分支不會蓋掉既有好友。
 *   （以前的 groupEnforcement 開關 W1 拿掉了：成員檢查一直開著，MODES 只剩一種。）
 * Run: node scripts/review/friends_cold_start_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extStubPlugin } from './extStub.mjs';
import { runInNewContext } from 'node:vm';
import { MODES, enforcementPlugin, flagContext, reasons } from './groupEnforcementFlags.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'coldstart-'));
const F = 'F'.repeat(43) + '=';
const F2 = 'G'.repeat(43) + '=';
const contact = (pk, trustLevel) => ({ pubkey: pk, nickname: 'Fay', avatar: '', addedAt: 1, trustLevel, signedPreKey: 'spk-' + pk.slice(0, 2), signature: 'sig' });
const db = globalThis.__db = { contacts: [contact(F, 'verified')], extra: { [F2]: contact(F2, 'verified') }, added: [] };
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^zustand$|services\/storage$|services\/database$|services\/directSignal$|secureId$|utils\/devLog$|cryptoSessionControl$|services\/webrtc$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'zustand' ? `export function create(fn) { let state; const subs = new Set();
      const set = (p) => { const prev = state; state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; for (const s of [...subs]) s(state, prev); };
      const get = () => state; state = fn(set, get); const hook = (sel) => (sel ? sel(state) : state);
      hook.getState = get; hook.setState = set; hook.subscribe = (l) => { subs.add(l); return () => subs.delete(l); }; return hook; }`
    : a.path.endsWith('storage') ? `export const isInitialized = () => true;
      export async function getAllContacts() { return globalThis.__db.contacts; }
      export async function getContact(pk) { return globalThis.__db.contacts.find((c) => c.pubkey === pk) ?? globalThis.__db.extra[pk] ?? null; }
      export async function getMessages() { return []; }
      export async function addContact(c) { globalThis.__db.added.push([c.pubkey, c.trustLevel]); }`
    : a.path.endsWith('database') ? 'export async function getSetting(){ return null }'
    : a.path.endsWith('directSignal') ? 'export function broadcastProfileUpdate() {}'
    : a.path.includes('secureId') ? 'export const generateId = (p) => p + "-1";'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('cryptoSessionControl') ? 'export async function clearPeerSession(){}'
    : 'export const webrtcService = { disconnect() {} };' }));
} };
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/stores/chatStore.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'cs.mjs'), logLevel: 'silent', plugins: [stub, extStubPlugin()] });
globalThis.localStorage = { getItem: () => null, setItem() {} };
console.error = () => {};
const CS = await import(pathToFileURL(join(dir, 'cs.mjs')));
const { useChatStore } = CS;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const coldStart = () => useChatStore.setState({ friends: [], isLoaded: false });

// ── chatStore：等好友清單 ──
assert.equal(typeof CS.findFriendSettled, 'function', 'chatStore exports findFriendSettled');
coldStart();
let p = CS.findFriendSettled(F);
await tick();
void useChatStore.getState().loadFromStorage();
assert.equal((await p)?.trustLevel, 'verified', 'a lookup made before the friend list loads waits for it');
assert.equal(await CS.findFriendSettled('STRANGER', 50), undefined, 'strangers are still strangers');
assert.equal((await CS.findFriendSettled(F2, 50))?.trustLevel, 'verified', 'a contact missing from memory (empty-load race) is found in storage');
coldStart();
const t0 = Date.now();
assert.equal(await CS.findFriendSettled('NOBODY', 60), undefined, 'the wait is bounded');
assert.ok(Date.now() - t0 < 1000, 'bounded wait');
console.log('PASS friend lookups wait for the friend list (bounded) and fall back to the contacts table');

// ── 來電 ──
const vc = readFileSync(root + 'packages/pwa/src/services/voiceCall.ts', 'utf8');
const s = vc.indexOf('handleCallRequest(callerId: string, s: CallSignal, iat: number)'); const e = vc.indexOf('/**\n   * 處理通話接受', s);
const callCode = esbuild.transformSync('globalThis.__call = async function ' + vc.slice(s, e).trimEnd(), { loader: 'ts' }).code;
for (const [mode, flags] of MODES) {
  coldStart();
  const rang = []; const logs = [];
  let current = null;
  const self = { callState: 'idle', currentCall: null, notifyStateChange() {}, incomingCallListeners: [(pk) => rang.push(pk)], rejectCall() {},
    guard: { current: () => current, begin: (role, peer, callId) => { current = { role, peer, callId }; } }, count() {}, sendSignal() {} };
  const cctx = { globalThis: {}, console: { error() {}, log() {} }, devLog() {}, devWarn() {}, diagLog() {}, Promise,
    CallState: { IDLE: 'idle', INCOMING: 'incoming' }, setTimeout: () => 0,
    mqttService: { serverNow: () => Date.now(), boundedNow: () => Date.now() }, CALL_REQUEST_MAX_AGE_MS: 35_000,
    isBlacklisted: async () => false, useChatStore, findFriendSettled: CS.findFriendSettled, ...flagContext(flags, logs) };
  runInNewContext(callCode, cctx);
  const ringing = cctx.globalThis.__call.call(self, F, { sig: 'request', callId: 'C'.repeat(22), seq: 1 }, Date.now());
  await tick();
  void useChatStore.getState().loadFromStorage();
  await ringing;
  await tick();
  assert.deepEqual(rang, [F], `${mode}: a friend's call that arrives before the friend list loads still rings (push-woken app)`);
  assert.deepEqual(reasons(logs), [], `${mode}: and is not logged as a non-friend once the list has loaded`);
}
console.log('PASS calls from friends ring on a cold start');

// ── WebRTC offer：非同步閘門；等待中的 ICE 不丟 ──
// 開源第 4 步：信令是 DIRECT_SEALED kind 'dc'（directSignal 驗過才交給 webrtc；這裡直接餵驗過的內容）
const rstub = { name: 'rstub', setup(b) {
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|\.\/directSignal$|\.\/iceServers$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('directSignal') ? 'export const onDirect=()=>()=>{};export const sendDirect=async()=>true;'
    : 'export async function getIceServers(){return []}' }));
} };
const dc = (sig, data) => ({ kind: 'dc', sig, pc: 'pc-remote-1', data, iat: Date.now(), nonce: 'n'.repeat(22) });
for (const [mode, flags] of MODES) {
  const out = join(dir, `w-${flags.ENFORCE_GROUP_MEMBERSHIP}.mjs`);
  await esbuild.build({ entryPoints: [root + 'packages/pwa/src/services/webrtc.ts'], bundle: true, platform: 'node',
    format: 'esm', outfile: out, logLevel: 'silent', plugins: [rstub, enforcementPlugin(flags)] });
  const { webrtcService: rtc, parseDcSignal } = await import(pathToFileURL(out));
  const built = [];
  rtc.createResponderConnection = async (pk, offer, pcId, iat, early) => { built.push([pk, (early ?? []).length]); };
  rtc.startDcHeartbeat = () => {};
  rtc.initialize('ME');
  // 封鎖名單查詢（IndexedDB）與好友清單一樣是非同步的
  rtc.setInboundPolicy({ isBlocked: async () => { await tick(40); return false; }, isKnown: async (pk) => { await tick(40); return pk === F; } });
  const offerF = rtc.handleOffer(parseDcSignal(F, dc('offer', { type: 'offer', sdp: 'x' })));
  await tick(5);
  await rtc.handleIceCandidate(parseDcSignal(F, dc('ice', { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host' })));
  const offerS = rtc.handleOffer(parseDcSignal('STRANGER', dc('offer', { type: 'offer', sdp: 'x' })));
  await Promise.all([offerF, offerS]);
  assert.deepEqual(built.map(([pk]) => pk), flags.ENFORCE_GROUP_MEMBERSHIP ? [F] : [F, 'STRANGER'],
    `${mode}: an async policy is awaited: the friend gets an answer, the stranger ${flags.ENFORCE_GROUP_MEMBERSHIP ? 'does not' : 'too (only logged)'}`);
  assert.equal(built[0][1], 1, `${mode}: ICE that arrived while the gate was waiting is kept for the new connection`);
}
const hook = readFileSync(root + 'packages/pwa/src/hooks/useWebRTC.ts', 'utf8');
assert.match(hook, /await findFriendSettled\(pk\)/, 'useWebRTC\'s policy waits for the friend list');
console.log('PASS WebRTC offers from friends are answered on a cold start (ICE kept while waiting)');

// ── X3DH_INIT：重送／修復的 INIT 不能把已驗證的好友降級 ──
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const head = 'mqtt.subscribe(MessageType.X3DH_INIT, ';
const start = provider.indexOf(head) + head.length;
const end = provider.indexOf('\n    });\n\n    return () => {', start);
const xcode = esbuild.transformSync(`module.exports = (${provider.slice(start, end + 6)});`,
  { loader: 'tsx', format: 'cjs', supported: { 'dynamic-import': false } }).code;
coldStart();
db.added.length = 0;
const addFriendCalls = [];
const mod = { exports: {} };
runInNewContext(xcode, {
  module: mod, exports: mod.exports, console: { log() {}, error() {} }, Date, JSON, localStorage: globalThis.localStorage,
  require: (n) => { if (n === '../services/p2pSend') return { flushQueueForPeer() {} }; throw Error(n); },
  publicKey: 'ME', signedPreKey: { publicKeyBase64: 'spk', signatureBase64: 'sig' },
  getFriendByPublicKey: (pk) => useChatStore.getState().getFriendByPublicKey(pk), findFriendSettled: CS.findFriendSettled,
  updateFriendProfile() {}, addFriend: (...x) => addFriendCalls.push([x[0], x[2]]), fromBase64: (x) => Buffer.from(x, 'base64'), diagLog() {},
  recentlyInitiatedTo: () => false, isBlacklisted: async () => false, acceptedVia: () => null, cleanPeerName: (n, f) => n || f,
  // 開源第 5b 步：既有好友的 INIT 要有他身分金鑰的簽章（services/x3dhInitAuth，x3dh_init_auth_self_test 用真的簽章測那一關）；
  //   這裡的好友不是真的金鑰 —— 他的 INIT 當作簽章正確，測的是後面的行為
  verifyInitAuth: () => 'ok', identityVerify: () => true, initResetBudget: { take: () => true },
  mqttService: { sendToUser() {}, serverNow: () => Date.now(), boundedNow: () => Date.now() }, MessageType: { PREKEY_REQUEST: 'p', PROFILE_UPDATE: 'u' },
  sendProfileUpdate: async () => true, sendPrekeyRequest: async () => true, viaName: async () => null,
  clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {}, webrtcService: { disconnect() {} },
  acceptSession: () => {}, flushSessionWrites: async () => {}, hasSessionWith: () => false,
  wasInitAccepted: () => false, isInitOlderThanAccepted: () => false, rememberAcceptedInit() {},
  getServiceTranslation: () => (k) => k, useChatStore: { getState: () => ({ userProfile: {} }) },
  usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  friendViaSealer: { seal: async () => { throw new Error('no identity in this test'); }, open: async () => { throw new Error('no identity in this test'); } },
});
const initDone = mod.exports({ from: F, payload: { ephemeralPublicKey: Buffer.alloc(32, 9).toString('base64'), signedPreKey: 'spk2', signature: 'sig2', sessionReset: true, repair: true } });
await tick();
void useChatStore.getState().loadFromStorage();
await initDone;
assert.ok(!addFriendCalls.some(([, trust]) => trust === 'unverified'), 'an existing verified friend is never re-added as unverified');
assert.deepEqual(addFriendCalls, [[F, 'verified']], 'the existing-friend branch keeps the verification and only refreshes the bundle');
console.log('PASS a repeated/repair X3DH_INIT from an existing friend keeps the verification on a cold start');

// ── 群組邀請、session 修復請求也等好友清單 ──
const engineSrc = provider.slice(provider.indexOf('const engine = createGroupEngine({'), provider.indexOf('setGroupEngine(engine);'));
assert.match(engineSrc, /isFriend: async \(pk\) => !!\(useChatStore\.getState\(\)\.getFriendByPublicKey\(pk\) \|\| await findFriendSettled\(pk\)\)/,
  'the group engine\'s inviter-is-a-friend check waits for the friend list before rejecting an invite');
const sealedSrc = provider.slice(provider.indexOf('mqtt.subscribe(MessageType.GROUP_KEY_SEALED'), provider.indexOf('// 群組主題上的 log 通知'));
assert.match(sealedSrc, /await waitForLocalLists\(\);[\s\S]*isFriendOrFellowMember\(message\.from\)/,
  'sealed invites wait for the local lists before the friend-or-member pre-check');
const prekeySrc = provider.slice(provider.indexOf("onDirect('prekey'"), provider.indexOf('// 註冊加密函數給 guardianAlert'));
assert.match(prekeySrc, /await findFriendSettled\(requesterPubKey\)/, 'PREKEY_REQUEST waits for the friend list before ignoring a friend');
console.log('PASS group invites and session-repair requests from friends are not dropped on a cold start');
process.exit(0);

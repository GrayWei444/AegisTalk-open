/**
 * 1 對 1 通話的狀態機與 DTLS 指紋（開源第 4 步；群星 aegisplay-call-check.md 的同一個攻擊）：真的 voiceCall.ts／callSignalGuard.ts／
 * dtlsFingerprint.ts，假的 RTCPeerConnection／getUserMedia，信令（directSignal）換成記錄器 —— 測試自己扮演對方（與攻擊者）。
 *   以前（明文信令）：通話中收到的每一則 offer 都重建連線（最後一則贏，兩邊各塞一則 ＝ 中間人）；answer 不看角色與狀態；ICE 不看是哪一通；
 *   end／reject 只看寄件人；非好友的 CALL_REQUEST 只靠 broker 綁的 from；ICE 一連上就算接通。
 *   1. 被叫方：只有好友能響；一通只接一則 offer（第二則、別通的、重放的都不接，連線不換）；被叫方不接 answer；別通的 ICE 不給
 *   2. 發起方：永遠不接 offer；accept 只收對方、這一通、還在等接聽時；answer 只在 have-local-offer；第二則 answer 不接
 *   3. 上一通的 end／reject 晚到（或被重放）掛不掉新的一通；seq 倒退的不收
 *   4. DTLS 指紋：ICE 連上後兩邊交換，對上才 CONNECTED、才送自己的聲音、才播對方的；對不上 → 掛斷（送 end）、提示使用者；
 *      在那之前麥克風／鏡頭不送（track.enabled = false）
 *   5. 來電推播走帳戶簽章的 API（triggerFcmNotify），不在 MQTT 上；信令每一則都是封好的 kind 'call'，帶 callId 與 seq
 *   6. 審查後：信令全部排隊 60 秒（不再沒連上就丟）；ICE／指紋不看順序（改狀態的才看 seq）；超過 35 秒的來電不響；封鎖名單查不了不響；
 *      接聽後 45 秒沒接通 → 掛斷（送 end failed）；同一個人的信令依序處理（來電還在查好友時到的掛斷不會被丟）
 * Run: node scripts/review/call_state_machine_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extStubPlugin } from './extStub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'callsm-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const g = globalThis.__vc = { handler: null, sent: [], pushes: [], friends: new Set(), blocked: new Set(), notices: [], blockedThrows: false, friendDelay: 0 };
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/iceServers$|stores\/chatStore$|^\.\/localBlacklist$|utils\/devLog$|^\.\/directSignal$/ },
    (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === './mqtt' ? 'export const mqttService = { triggerFcmNotify: (to, hint) => globalThis.__vc.pushes.push({ to, hint }), serverNow: () => Date.now() };'
    : a.path === './iceServers' ? 'export const getIceServers = () => [];'
    : a.path.includes('chatStore') ? `export const findFriendSettled = async (pk) => {
        if (globalThis.__vc.friendDelay) await new Promise((r) => setTimeout(r, globalThis.__vc.friendDelay));
        return globalThis.__vc.friends.has(pk) ? { publicKey: pk } : undefined; };`
    : a.path === './localBlacklist' ? `export const isBlacklisted = async (pk) => {
        if (globalThis.__vc.blockedThrows) throw new Error('db not ready'); return globalThis.__vc.blocked.has(pk); };`
    : a.path.includes('devLog') ? 'export const devLog = () => {}; export const devWarn = () => {};'
    : `export const CALL_CONTROL_TTL_MS = 60000;
       export const onDirect = (kind, f) => { if (kind === 'call') globalThis.__vc.handler = f; return () => {}; };
       export const sendDirect = async (to, body, opts) => { globalThis.__vc.sent.push({ to, ...body, opts }); return true; };` }));
} };

// ── 假的 WebRTC 與麥克風 ──
const hex = (b) => Array.from({ length: 32 }, () => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const FME = `sha-256 ${hex(0x11)}`, FPEER = `sha-256 ${hex(0x22)}`, FMITM = `sha-256 ${hex(0x33)}`;
class FakePC {
  constructor() { this.signalingState = 'stable'; this.remoteDescription = null; this.localDescription = null; this.iceConnectionState = 'new';
    this.tracks = []; this.ice = []; this.closed = false; this.fp = { local: FME, remote: FPEER }; FakePC.all.push(this); }
  addTrack(t) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'my-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'my-answer' }; }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) {
    if (d.type === 'answer' && this.signalingState !== 'have-local-offer') throw new Error('wrong state');
    this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c) { this.ice.push(c.candidate); }
  async getStats() {
    const fp = this.fp;
    return { forEach(cb) {
      cb({ id: 'T', type: 'transport', dtlsState: 'connected', localCertificateId: 'L', remoteCertificateId: 'R' });
      cb({ id: 'L', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: fp.local.split(' ')[1] });
      cb({ id: 'R', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: fp.remote.split(' ')[1] });
    } };
  }
  close() { this.closed = true; }
  iceTo(s) { this.iceConnectionState = s; this.oniceconnectionstatechange?.(); }
}
FakePC.all = [];
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCSessionDescription = class { constructor(i) { Object.assign(this, i); } };
globalThis.RTCIceCandidate = class { constructor(i) { Object.assign(this, i); } };
const streams = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async ({ video }) => {
  const tracks = [{ kind: 'audio', enabled: true, stop() { this.stopped = true; } }, ...(video ? [{ kind: 'video', enabled: true, stop() {} }] : [])];
  const s = { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') };
  streams.push(s); return s;
} } } });
globalThis.window = { dispatchEvent: (e) => { g.notices.push(e.detail); } };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
console.error = () => {};
// 接聽後等接通的 45 秒計時器（CONNECT_TIMEOUT_MS）由測試手動觸發；其他計時器照常
const connectTimers = [];
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...a) => {
  if (ms === 45_000) { const h = { fn, live: true }; connectTimers.push(h); return h; }
  return realSetTimeout(fn, ms, ...a);
};
globalThis.clearTimeout = (h) => { if (h && typeof h === 'object' && 'live' in h) h.live = false; else realClearTimeout(h); };
const fireConnectTimer = () => { const h = connectTimers.filter((x) => x.live).at(-1); assert.ok(h, 'a connect timer is running'); h.live = false; h.fn(); };

// 通話語音分析（官方版的防詐，開源第 5a 步起經 ext.antiFraud.callAnalysis）：跟以前的 stub 一樣什麼都不做
globalThis.__extHooks = { callAnalysis: {
  initialize: async () => {}, onSlice: () => () => {}, start: async () => {}, stop() {}, startSession: async () => {},
} };
await require('esbuild').build({ entryPoints: [SRC + '/services/voiceCall.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'vc.mjs'), logLevel: 'silent', plugins: [stub, extStubPlugin()] });
const { voiceCallService: vc } = await import(pathToFileURL(join(dir, 'vc.mjs')));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const A = 'A'.repeat(43) + '=', B = 'B'.repeat(43) + '=', M = 'M'.repeat(43) + '=';
const CALL = 'K'.repeat(22), OTHER = 'O'.repeat(22);
g.friends.add(A);
vc.initialize(B);
const signal = async (from, body, iat = Date.now()) => { g.handler(from, { kind: 'call', from, to: B, iat, nonce: 'n'.repeat(22), ...body }); await settle(); };
const sentBy = (sig) => g.sent.filter((x) => x.sig === sig);
const state = () => vc.getCallState();
const pc = () => FakePC.all.at(-1);

// 1 被叫方
await signal(M, { sig: 'request', callId: OTHER, seq: 1 });
assert.equal(state(), 'idle', 'a non-friend\'s (sealed, correctly signed) request does not ring');
assert.equal(vc.debugState().counters['request-not-friend'], 1);
await signal(A, { sig: 'request', callId: CALL, seq: 1, video: false });
assert.equal(state(), 'incoming', 'a friend\'s request rings');
await signal(A, { sig: 'request', callId: CALL, seq: 1 });
assert.equal(vc.debugState().counters['request-duplicate'], 1, 'the same request again does not ring twice');
await signal(M, { sig: 'accept', callId: CALL, seq: 2 });
assert.equal(vc.debugState().counters['not-current:accept'], 1, 'someone else\'s signal for this call id is not part of the call');
await vc.acceptCall();
await settle();
assert.equal(state(), 'connecting');
assert.deepEqual(sentBy('accept').map((x) => [x.to, x.callId, x.seq, x.opts?.ttlMs]), [[A, CALL, 1, 60_000]], 'accept sealed to A, this call id, my seq 1, queued ≤ 60 s');
const mic = streams.at(-1);
assert.deepEqual(mic.getTracks().map((t) => t.enabled), [false], 'the microphone is not sent before the fingerprints are verified');
await signal(A, { sig: 'ice', callId: CALL, seq: 2, data: { candidate: 'early-1' } });   // ICE 比 offer 先到：先收著
await signal(A, { sig: 'offer', callId: CALL, seq: 3, data: { type: 'offer', sdp: 'A-offer' } });
const first = pc();
assert.equal(first.remoteDescription?.sdp, 'A-offer', 'the first offer of this call is answered');
assert.deepEqual(first.ice, ['early-1'], 'ICE that came before the offer is added after it');
assert.deepEqual(sentBy('answer').map((x) => [x.callId, x.data.sdp, x.opts?.ttlMs]), [[CALL, 'my-answer', 60_000]], 'answer sealed, this call id, queued ≤ 60 s');
await signal(A, { sig: 'offer', callId: CALL, seq: 4, data: { type: 'offer', sdp: 'second-offer' } });
assert.equal(pc(), first, 'a second offer for the same call does not rebuild the connection (exactly one offer per call)');
assert.equal(first.remoteDescription.sdp, 'A-offer');
assert.equal(vc.debugState().counters['offer-refused'], 1);
await signal(A, { sig: 'offer', callId: OTHER, seq: 5, data: { type: 'offer', sdp: 'other-call' } });
assert.equal(pc(), first, 'an offer for another call id is not part of this call');
await signal(A, { sig: 'answer', callId: CALL, seq: 6, data: { type: 'answer', sdp: 'x' } });
assert.equal(vc.debugState().counters['answer-refused'], 1, 'the callee never takes an answer');
await signal(A, { sig: 'ice', callId: OTHER, seq: 7, data: { candidate: 'other' } });
await signal(A, { sig: 'ice', callId: CALL, seq: 8, data: { candidate: 'good' } });
await signal(A, { sig: 'ice', callId: CALL, seq: 3, data: { candidate: 'late' } });
assert.deepEqual(first.ice, ['early-1', 'good', 'late'], 'ICE only for this call; ICE arriving out of order is still used');
console.log('PASS callee: friends only; one offer per call; no answers; ICE only for the active call (buffered before the offer)');

// 4 指紋：對上 → 接通；對不上 → 掛斷
first.iceTo('connected');
await settle();
assert.equal(state(), 'connecting', 'ICE connected is not "connected" yet: the fingerprints have to match first');
const myFp = sentBy('fp').at(-1);
assert.deepEqual([myFp.callId, myFp.data.local, myFp.data.remote, myFp.data.got, myFp.opts?.ttlMs], [CALL, [FME], [FPEER], false, 60_000],
  'I send my local and the remote fingerprint I see, sealed, for this call');
await signal(A, { sig: 'fp', callId: CALL, seq: 9, data: { local: [FPEER], remote: [FME], got: true } });
assert.equal(state(), 'connected', 'matching fingerprints → connected');
assert.deepEqual(mic.getTracks().map((t) => t.enabled), [true], 'now the microphone is sent');
assert.equal(vc.debugState().verified, true);
vc.endCall();
await settle();
assert.deepEqual(sentBy('end').map((x) => [x.callId, x.opts?.ttlMs]), [[CALL, 60_000]], 'hang-up sends end for this call');
assert.ok(first.closed, 'and closes the connection at once');
await tick(2100);
assert.equal(state(), 'idle');
g.sent.length = 0;

// 3 上一通的 end 晚到不掛新的一通；倒退的 seq 不收
await signal(A, { sig: 'request', callId: OTHER, seq: 1 });
assert.equal(state(), 'incoming');
await signal(A, { sig: 'end', callId: CALL, seq: 99 });
assert.equal(state(), 'incoming', 'the previous call\'s end (late or replayed) does not end the new one');
await vc.acceptCall(); await settle();
await signal(A, { sig: 'offer', callId: OTHER, seq: 3, data: { type: 'offer', sdp: 'o2' } });
const second = pc();
await signal(A, { sig: 'end', callId: OTHER, seq: 2 });
assert.equal(state(), 'connecting', 'a state-changing signal whose seq goes backwards is dropped');
assert.equal(vc.debugState().counters['not-current:end'] >= 1, true);
second.fp = { local: FME, remote: FMITM };              // 這一次中間有人：我連到的是他的憑證
second.iceTo('connected');
await settle();
await signal(A, { sig: 'fp', callId: OTHER, seq: 4, data: { local: [FPEER], remote: [FMITM], got: false } });
assert.equal(state(), 'ended', 'mismatching fingerprints → the call is hung up');
assert.ok(second.closed, 'the connection is closed at once');
assert.deepEqual(sentBy('end').map((x) => x.callId), [OTHER], 'the peer is told (end)');
assert.ok(g.notices.some((n) => n?.kind === 'call-unverified' && n.reason === 'mismatch'), 'the user is told (call-unverified notice)');
assert.deepEqual(streams.at(-1).getTracks().map((t) => [t.enabled, !!t.stopped]), [[false, true]], 'the microphone was never sent and is released');
assert.equal(vc.debugState().counters['fp-mismatch'], 1);
await tick(2100);
console.log('PASS fingerprints: connected only after they match; a mismatch hangs up and tells the user; the mic is never sent before');
console.log('PASS an old call\'s end cannot end a new call; backwards seq dropped');

// 2 發起方
g.sent.length = 0; g.pushes.length = 0;
await vc.startCall(A, 'Ann', true);
const myCall = vc.debugState().callId;
assert.match(myCall, /^[A-Za-z0-9_-]{22}$/, 'a fresh random call id');
assert.deepEqual(sentBy('request').map((x) => [x.to, x.callId, x.seq, x.video, x.opts?.ttlMs]), [[A, myCall, 1, true, 60_000]]);
assert.deepEqual(g.pushes, [{ to: A, hint: { type: 'incoming_call', isVideoCall: true, callId: myCall } }],
  'the incoming-call push goes through the signed push API, naming this call (its ring token is signed for this call id; open-source step 5d)');
await signal(A, { sig: 'offer', callId: myCall, seq: 1, data: { type: 'offer', sdp: 'callee-offer' } });
assert.equal(vc.debugState().counters['offer-refused'] >= 2, true, 'the caller never takes an offer');
await signal(M, { sig: 'accept', callId: myCall, seq: 2 });
assert.equal(state(), 'requesting', 'an accept from someone else is not part of the call');
await signal(A, { sig: 'accept', callId: OTHER, seq: 3 });
assert.equal(state(), 'requesting', 'an accept for another call id is ignored');
await signal(A, { sig: 'accept', callId: myCall, seq: 4 });
assert.equal(state(), 'connecting');
const mine = pc();
assert.equal(mine.localDescription?.sdp, 'my-offer');
assert.deepEqual(sentBy('offer').map((x) => [x.callId, x.seq, x.opts?.ttlMs]), [[myCall, 2, 60_000]], 'my offer: this call, my seq 2, queued ≤ 60 s');
assert.deepEqual(streams.at(-1).getTracks().map((t) => t.enabled), [false, false], 'mic and camera not sent yet');
const refusedBefore = vc.debugState().counters['offer-refused'];
await signal(A, { sig: 'offer', callId: myCall, seq: 5, data: { type: 'offer', sdp: 'callee-offer-while-connecting' } });
assert.equal(pc(), mine, 'the caller never takes an offer, also while connecting (the connection is not replaced)');
assert.equal(mine.remoteDescription, null);
assert.equal(vc.debugState().counters['offer-refused'], refusedBefore + 1);
await signal(A, { sig: 'answer', callId: myCall, seq: 6, data: { type: 'answer', sdp: 'A-answer' } });
assert.equal(mine.remoteDescription?.sdp, 'A-answer', 'the answer is taken in have-local-offer');
await signal(A, { sig: 'answer', callId: myCall, seq: 7, data: { type: 'answer', sdp: 'second-answer' } });
assert.equal(mine.remoteDescription.sdp, 'A-answer', 'a second answer is not (no longer have-local-offer)');
assert.ok(vc.debugState().counters['answer-refused'] >= 2);
mine.fp = { local: FME, remote: FPEER };
mine.iceTo('connected');
await settle();
await signal(A, { sig: 'fp', callId: myCall, seq: 8, data: { local: [FPEER], remote: [FME], got: false } });
assert.equal(state(), 'connected');
assert.deepEqual(streams.at(-1).getTracks().map((t) => t.enabled), [true, true], 'verified: mic and camera on');
assert.deepEqual(sentBy('fp').map((x) => x.data.got), [false, true], 'I answered his fingerprint because he had not seen mine yet');
vc.toggleMute();
assert.deepEqual(streams.at(-1).getTracks().map((t) => t.enabled), [false, true], 'mute still works after verification');
await signal(A, { sig: 'end', callId: myCall, seq: 9 });
assert.equal(state(), 'ended', 'the peer\'s end for this call ends it');
await tick(2100);
console.log('PASS caller: never takes an offer; accept only from the peer for this call; answer only in have-local-offer; push via the signed API');

// 6 審查後
g.sent.length = 0;
await signal(A, { sig: 'request', callId: 'S'.repeat(22), seq: 1 }, Date.now() - 40_000);
assert.equal(state(), 'idle', 'a call request sealed 40 s ago does not ring (the caller gave up after 30 s)');
assert.equal(vc.debugState().counters['request-stale'], 1);
g.blockedThrows = true;
await signal(A, { sig: 'request', callId: 'T'.repeat(22), seq: 1 });
assert.equal(state(), 'idle', 'the block list cannot be read → does not ring');
g.blockedThrows = false;
// 依序：來電還在查好友（慢）時同一個人的掛斷就到了 → 掛斷照樣生效（以前它先跑完、對不上任何一通而被丟，手機白響 30 秒）
g.friendDelay = 40;
g.handler(A, { kind: 'call', from: A, to: B, iat: Date.now(), nonce: 'q'.repeat(22), sig: 'request', callId: 'U'.repeat(22), seq: 1 });
g.handler(A, { kind: 'call', from: A, to: B, iat: Date.now(), nonce: 'r'.repeat(22), sig: 'end', callId: 'U'.repeat(22), seq: 2 });
await tick(120); await settle();
g.friendDelay = 0;
assert.equal(state(), 'ended', 'a hang-up that arrives while the request is still being checked ends that call');
await tick(2100);
// 接聽後一直沒接通（少了一則信令）→ 45 秒後掛斷，不會永遠「連線中」
await signal(A, { sig: 'request', callId: 'V'.repeat(22), seq: 1 });
await vc.acceptCall(); await settle();
assert.equal(state(), 'connecting');
fireConnectTimer();
await settle();
assert.equal(state(), 'ended', 'not connected in time → hung up');
assert.deepEqual(sentBy('end').map((x) => [x.callId, x.reason]), [['V'.repeat(22), 'failed']], 'and the caller is told (end, failed)');
assert.equal(vc.debugState().counters['connect-timeout'], 1);
await tick(2100);
await vc.startCall(A, 'Ann');
const c2 = vc.debugState().callId;
await signal(A, { sig: 'accept', callId: c2, seq: 2 });
assert.equal(state(), 'connecting');
const pc2 = pc();
pc2.iceTo('connected'); await settle();
await signal(A, { sig: 'fp', callId: c2, seq: 3, data: { local: [FPEER], remote: [FME], got: true } });
assert.equal(state(), 'connected');
const timeouts = vc.debugState().counters['connect-timeout'];
assert.equal(connectTimers.at(-1).live, false, 'the connect timer is cleared once connected');
connectTimers.at(-1).fn();                                  // 就算計時器的回呼還是跑了（清掉前已經排進去）
await settle();
assert.equal(state(), 'connected', 'a connected call is never ended by the connect timer');
assert.equal(vc.debugState().counters['connect-timeout'], timeouts);
vc.endCall();
await tick(2100);
console.log('PASS stale requests and an unreadable block list do not ring; signals are handled in order; a call that never connects is hung up');

// 5 原始碼：信令只有封好的 kind 'call'，沒有明文型別
const src = readFileSync(SRC + '/services/voiceCall.ts', 'utf8');
assert.doesNotMatch(src, /MessageType\.|sendCall(Request|Accept|Reject|End|Offer|Answer|IceCandidate)\(/, 'no plaintext MQTT call types or senders left');
assert.match(src, /onDirect\('call', \(from, body\) => this\.handleSignal\(from, body\)\)/, 'signals come only from the sealed channel');
assert.match(src, /timeoutMs: FINGERPRINT_TIMEOUT_MS/, 'the fingerprint check has a timeout (the timeout path: dtls_fingerprint_self_test)');
console.log('PASS voiceCall uses only sealed signalling');
process.exit(0);

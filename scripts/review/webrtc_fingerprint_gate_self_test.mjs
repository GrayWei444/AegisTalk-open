/**
 * DataChannel：封好的信令＋DTLS 指紋閘門＋pcId 劫持（開源第 4 步；群星 aegisplay-call-check.md 的「DC hijack via new pcId」）：
 * 真的 webrtc.ts／dtlsFingerprint.ts，假的 RTCPeerConnection，信令（directSignal）換成記錄器（webrtcKit）。
 *   1. 回應 offer：answer 封給對方、標明回的是哪一條 PC（rpc）；通道開了但指紋還沒對過 → 不算開著（不送、收到的先壓著）
 *   2. 指紋對上 → OPEN、壓著的往上送；對不上 → 拆掉這條 PC、壓著的丟掉、提示使用者
 *   3. 指紋要對到我現在這一條（pc／rpc 對不上的不理）
 *   4. pcId 劫持：活著的連線上來了一則換 pcId 的 offer —— 比我學到對方目前那一條的那一則舊（重放、晚到）→ 不拆；
 *      比較新（對方真的重建了）→ 拆掉重建；不是 directSignal 驗過的（authenticated 不是 true）→ 不理
 *   5. answer 一定要回我這一條（rpc ＝ 我的 localPcId）而且我在等 answer；ICE 只給對方目前那一條
 *   6. 原地重開時對方另一條 PC 回的 answer → 拆掉（審查 L2：以前收下、DTLS 重新握手，verified 卻還是 true）
 * Run: node scripts/review/webrtc_fingerprint_gate_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webrtcStub, dcBody, deliverDc, sentDc } from './webrtcKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'rtcfp-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';

const hex = (b) => Array.from({ length: 32 }, () => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const FME = `sha-256 ${hex(0x11)}`, FPEER = `sha-256 ${hex(0x22)}`, FMITM = `sha-256 ${hex(0x33)}`;
class FakePC {
  constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.remoteDescription = null;
    this.ice = []; this.closed = false; this.fp = { local: FME, remote: FPEER }; FakePC.all.push(this); }
  createDataChannel() { return { readyState: 'connecting', close() { this.readyState = 'closed'; }, send() {} }; }
  async createOffer() { return { type: 'offer', sdp: 'my-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'my-answer' }; }
  async setLocalDescription(d) { this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(c) { this.ice.push(c.candidate); }
  async getStats() {
    const fp = this.fp;
    return { forEach(cb) {
      cb({ id: 'T', type: 'transport', dtlsState: 'connected', localCertificateId: 'L', remoteCertificateId: 'R' });
      cb({ id: 'L', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: fp.local.split(' ')[1] });
      cb({ id: 'R', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: fp.remote.split(' ')[1] });
    } };
  }
  close() { this.closed = true; this.connectionState = 'closed'; }
  connected() { this.iceConnectionState = 'connected'; this.connectionState = 'connected'; this.oniceconnectionstatechange?.(); this.onconnectionstatechange?.(); }
}
FakePC.all = [];
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCSessionDescription = class { constructor(i) { Object.assign(this, i); } };
globalThis.RTCIceCandidate = class { constructor(i) { Object.assign(this, i); } };
globalThis.localStorage = { getItem: () => null };
const notices = [];
globalThis.window = { dispatchEvent: (e) => notices.push(e.detail) };
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };
console.error = () => {};

await require('esbuild').build({ entryPoints: [SRC + '/services/webrtc.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [webrtcStub()] });
const { webrtcService: rtc, parseDcSignal } = await import(pathToFileURL(join(dir, 'w.mjs')));
rtc.startDcHeartbeat = () => {};
rtc.initialize('ME');
rtc.setInboundPolicy({ isBlocked: () => false, isKnown: () => true });
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 25; i++) await tick(); };
const opens = [];
rtc.onDataChannelStateChange((pk, s) => { if (s === 'open') opens.push(pk); });
const got = [];
rtc.onMessage((pk, data) => got.push([pk, data]));
const T = Date.now();
const deliver = async (from, sig, data, opts) => { await deliverDc(rtc, parseDcSignal, from, dcBody(sig, data, opts)); await settle(); };
const mySent = (sig, to) => sentDc().filter((x) => x.sig === sig && (!to || x.to === to));
/** 對方開了一條通道過來（responder 端 ondatachannel） */
const peerChannel = (pc) => { const ch = { readyState: 'open', close() { this.readyState = 'closed'; }, send(d) { (this.out ??= []).push(d); } };
  pc.ondatachannel({ channel: ch }); ch.onopen(); return ch; };

// 1 ＋ 2：回應 offer，指紋對上
await deliver('BOB', 'offer', { type: 'offer', sdp: 'bob-offer' }, { pc: 'pc-bob-1', iat: T });
const pc1 = FakePC.all.at(-1);
const local1 = rtc.debugState().peers.BOB.localPcId;
assert.deepEqual(mySent('answer', 'BOB').map((x) => [x.rpc, x.pc, x.data.sdp, x.transient]), [['pc-bob-1', local1, 'my-answer', true]],
  'the answer is sealed to Bob, names the PC it answers (rpc) and mine (pc), and is not queued');
const ch1 = peerChannel(pc1);
assert.deepEqual(opens, [], 'an open channel is not announced before the fingerprints are verified');
assert.equal(rtc.isDataChannelOpen('BOB'), false, 'not usable yet');
assert.equal(rtc.send('BOB', 'secret'), false, 'nothing is sent over an unverified channel');
ch1.onmessage({ data: '{"type":"early"}' });
assert.deepEqual(got, [], 'frames from an unverified channel are held');
pc1.connected();
await settle();
const fp1 = mySent('fp', 'BOB').at(-1);
assert.deepEqual([fp1.pc, fp1.rpc, fp1.data.local, fp1.data.remote, fp1.data.got], [local1, 'pc-bob-1', [FME], [FPEER], false],
  'once ICE is connected I send my fingerprints, sealed, for this PC pair');
await deliver('BOB', 'fp', { local: [FPEER], remote: [FME], got: true }, { pc: 'pc-bob-1', rpc: local1 });
assert.deepEqual(opens, ['BOB'], 'verified → the channel is announced open');
assert.equal(rtc.isDataChannelOpen('BOB'), true);
assert.equal(rtc.send('BOB', 'hello'), true);
assert.deepEqual(got, [['BOB', '{"type":"early"}']], 'the held frame is delivered after verification');
console.log('PASS a data channel counts as open only after the DTLS fingerprints match; frames before that are held');

// 3：指紋要對到我現在這一條
await deliver('BOB', 'fp', { local: [FMITM], remote: [FME], got: true }, { pc: 'pc-bob-OLD', rpc: local1 });
await deliver('BOB', 'fp', { local: [FMITM], remote: [FME], got: true }, { pc: 'pc-bob-1', rpc: 'pc-not-mine' });
assert.equal(rtc.isDataChannelOpen('BOB'), true, 'fingerprint messages for another PC pair are ignored');
assert.equal(rtc.debugState().counters['fp-stale'], 2);
console.log('PASS fingerprint messages must name this exact PC pair');

// 4：pcId 劫持
const before = rtc.debugState().peers.BOB;
await deliver('BOB', 'offer', { type: 'offer', sdp: 'replayed' }, { pc: 'pc-bob-0', iat: T - 60_000 });
assert.equal(rtc.debugState().peers.BOB?.localPcId, before.localPcId, 'an older-generation offer (replayed / late) does not tear down the live PC');
assert.equal(pc1.closed, false);
assert.equal(rtc.isDataChannelOpen('BOB'), true);
assert.equal(rtc.debugState().counters['offer-stale-generation'], 1);
await rtc.handleOffer({ ...parseDcSignal('BOB', dcBody('offer', { type: 'offer', sdp: 'unauth' }, { pc: 'pc-bob-9', iat: T + 99_000 })), authenticated: false });
await settle();
assert.equal(rtc.debugState().peers.BOB?.localPcId, before.localPcId, 'a signal that did not come through the sealed channel never tears anything down');
const pcsBefore = FakePC.all.length;
await rtc.handleOffer({ ...parseDcSignal('DAVE', dcBody('offer', { type: 'offer', sdp: 'unauth' }, { pc: 'pc-dave-1', iat: T })), authenticated: false });
await settle();
assert.equal(rtc.debugState().peers.DAVE, undefined, 'nor opens a new connection');
assert.equal(FakePC.all.length, pcsBefore);
await deliver('BOB', 'offer', { type: 'offer', sdp: 'rebuilt' }, { pc: 'pc-bob-2', iat: T + 5_000 });
const pc2 = FakePC.all.at(-1);
assert.ok(pc1.closed && pc2 !== pc1, 'a newer authenticated offer with a new pcId (Bob really rebuilt) replaces the PC');
assert.equal(pc2.remoteDescription?.sdp, 'rebuilt');
assert.equal(rtc.isDataChannelOpen('BOB'), false, 'the new PC starts unverified');
console.log('PASS pcId hijack: only a newer, authenticated offer may replace a live PC; replays and unauthenticated signals cannot');

// 2：對不上 → 拆掉、壓著的丟掉、提示
const ch2 = peerChannel(pc2);
ch2.onmessage({ data: '{"type":"from-mitm"}' });
pc2.fp = { local: FME, remote: FMITM };                  // 中間人：我連到的是他的憑證
pc2.connected();
await settle();
const local2 = rtc.debugState().peers.BOB.localPcId;
await deliver('BOB', 'fp', { local: [FPEER], remote: [FMITM], got: false }, { pc: 'pc-bob-2', rpc: local2 });
assert.equal(rtc.debugState().peers.BOB, undefined, 'a mismatch drops the PC');
assert.ok(pc2.closed);
assert.deepEqual(got.map((x) => x[1]).filter((d) => d.includes('from-mitm')), [], 'frames held on the unverified channel are discarded');
assert.ok(notices.some((n) => n?.kind === 'link-unverified' && n.reason === 'mismatch'), 'the user is told');
assert.equal(rtc.debugState().counters['fp-mismatch'], 1);
console.log('PASS a fingerprint mismatch drops the connection, discards what it held and tells the user');

// 5：answer 與 ICE 的世代
await rtc.connect('CAROL');
await settle();
const pcC = FakePC.all.at(-1);
const localC = rtc.debugState().peers.CAROL.localPcId;
assert.deepEqual(mySent('offer', 'CAROL').map((x) => x.pc), [localC], 'my offer carries my pcId');
await deliver('CAROL', 'ice', { candidate: 'early' }, { pc: 'pc-carol-1' });
await deliver('CAROL', 'answer', { type: 'answer', sdp: 'for-someone-else' }, { pc: 'pc-carol-1', rpc: 'pc-not-mine' });
assert.equal(pcC.remoteDescription, null, 'an answer to another PC generation is ignored');
assert.equal(rtc.debugState().counters['answer-other-generation'], 1);
await deliver('CAROL', 'answer', { type: 'answer', sdp: 'carol-answer' }, { pc: 'pc-carol-1', rpc: localC });
assert.equal(pcC.remoteDescription?.sdp, 'carol-answer', 'the answer to my offer is taken');
assert.equal(rtc.debugState().peers.CAROL.remotePcId, 'pc-carol-1', 'and tells me which PC Carol uses');
assert.deepEqual(pcC.ice, ['early'], 'ICE that arrived before the answer is added after it (same PC)');
await deliver('CAROL', 'answer', { type: 'answer', sdp: 'again' }, { pc: 'pc-carol-1', rpc: localC });
assert.equal(pcC.remoteDescription.sdp, 'carol-answer', 'a second answer is not taken (no longer have-local-offer)');
await deliver('CAROL', 'ice', { candidate: 'other-gen' }, { pc: 'pc-carol-OLD' });
await deliver('CAROL', 'ice', { candidate: 'good' }, { pc: 'pc-carol-1' });
assert.deepEqual(pcC.ice, ['early', 'good'], 'ICE only for Carol\'s current PC');
assert.ok(rtc.debugState().counters['ice-other-generation'] >= 1);
console.log('PASS answers must answer my current PC in have-local-offer; ICE only for the peer\'s current PC');

// 6 審查 L2：原地重開（同一條 PC 再 offer）的 answer 來自對方另一條 PC → 對方的 DTLS 憑證換了，驗過的指紋不算數 → 拆掉
pcC.signalingState = 'have-local-offer';                  // 我在同一條 PC 上重新 offer（reopenDataChannelInPlace）
await deliver('CAROL', 'answer', { type: 'answer', sdp: 'from-a-new-pc' }, { pc: 'pc-carol-2', rpc: localC });
assert.equal(rtc.debugState().peers.CAROL, undefined, 'an answer from a different PC generation on a live PC drops it');
assert.ok(pcC.closed);
assert.equal(rtc.debugState().counters['answer-new-generation'], 1);
console.log('PASS an answer from another PC generation on a live connection tears it down (its fingerprints no longer apply)');
rtc.shutdown();
process.exit(0);

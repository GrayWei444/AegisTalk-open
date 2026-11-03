/**
 * 群組通話的 DTLS 指紋核對（開源第 5d 步，移植 1 對 1 的 dtlsFingerprint；services/groupCallService.ts，docs/DIRECT_SEALED.md §4）：
 * 真的 groupCallService.ts（esbuild，stub 掉群組名冊、引擎、送信），假的 RTCPeerConnection（getStats 給兩張憑證的指紋）。
 *   以前：群組通話的每條 PeerConnection 只要 ICE 連上就算接通 —— 信令哪天出了漏洞，中間人沒人抓得到。
 *   1. 每條 PC 送出去的是本機 track 的複本、一開始是關的；對方的串流先收著，不交給畫面
 *   2. ICE 連上 → 經封好的信令（sendGroupSealed kind call，signal 'fp'，transient）送「我的／我看到的對方」指紋
 *   3. 兩邊交叉對上 → 這位參與者才接通：複本打開（照靜音／鏡頭設定）、他的串流交給畫面
 *   4. 對不上（他看到的「對方」不是我 ＝ 中間有人）→ 只拆那一條 PC（關掉、拿掉這位參與者、複本停掉、從沒打開過），
 *      跟使用者說（aegis:mqtt-notice kind group-call-unverified）；其他參與者照常
 *   5. 讀不到指紋 → 一樣拆掉；不是成員、別的群、重放的指紋訊息不理
 * Run: node scripts/review/group_call_fingerprint_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'gcallfp-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
globalThis.__group = { id: 'g1', name: '本機群名', members: [{ publicKey: 'zME' }, { publicKey: 'alice' }, { publicKey: 'bob' }, { publicKey: 'carol' }, { publicKey: 'dave' }, { publicKey: 'zzz-late' }, { publicKey: 'erin' }, { publicKey: 'frank' }] };
globalThis.__signals = [];
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/iceServers$|utils\/devLog$|^\.\.\/types$|stores\/groupStore$|^\.\/localBlacklist$|^\.\/groupEngineHost$|^\.\/groupKeyDelivery$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === './mqtt' ? 'throw new Error("no plaintext MQTT");'
    : a.path.includes('iceServers') ? 'export function getIceServers(){ return [] }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('groupStore') ? 'export const useGroupStore = { getState: () => ({ getGroupById: (id) => id === globalThis.__group.id ? globalThis.__group : undefined }) };'
    : a.path.includes('localBlacklist') ? 'export async function isBlacklisted() { return false; }'
    : a.path.includes('groupEngineHost') ? 'export const getGroupEngine = () => ({ sendControl: async () => "sent" });'
    : a.path.includes('groupKeyDelivery') ? 'export async function sendGroupSealed(to, body, opts) { globalThis.__signals.push({ to, body, opts }); return true; }'
    : 'export const GROUP_CONSTANTS = { MAX_CALL_MEMBERS: 8 };' }));
} };

const hex = (n) => Array.from({ length: 32 }, (_, i) => ((n * 7 + i * 13) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP = { me: `sha-256 ${hex(1)}`, alice: `sha-256 ${hex(2)}`, bob: `sha-256 ${hex(3)}`, dave: `sha-256 ${hex(4)}`, frank: `sha-256 ${hex(5)}`, mitm: `sha-256 ${hex(9)}` };
const tracks = [];
function fakeTrack(kind, original = true) {
  const t = { kind, enabled: true, stopped: false, original, everEnabled: false,
    clone() { const c = fakeTrack(kind, false); return c; }, stop() { this.stopped = true; } };
  const proxy = new Proxy(t, { set(o, k, v) { if (k === 'enabled' && v === true && !o.original) o.everEnabled = true; o[k] = v; return true; } });
  tracks.push(proxy);
  return proxy;
}
class FakePC {
  static all = [];
  constructor() { this.senders = []; this.closed = false; this.iceConnectionState = 'new'; this.signalingState = 'stable'; this.log = []; this.local = FP.me; this.remoteSeen = null; this.unreadable = false; FakePC.all.push(this); }
  addTrack(track) { this.senders.push(track); return {}; }
  async createOffer() { return { type: 'offer', sdp: 'o' }; }
  async createAnswer() { return { type: 'answer', sdp: 'a' }; }
  async setLocalDescription(d) {
    this.log.push(`local:${d.type}`);
    if (d.type === 'offer') this.signalingState = 'have-local-offer';
    else if (d.type === 'rollback' || d.type === 'answer') this.signalingState = 'stable';
    this.localDescription = d;
  }
  async setRemoteDescription(d) {
    this.log.push(`remote:${d.type}`);
    if (d.type === 'offer' && this.signalingState === 'have-local-offer') throw new Error('InvalidStateError: offer in have-local-offer (glare not resolved)');
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  async getStats() {
    if (this.unreadable) throw new Error('no stats');
    const reports = [
      { id: 'T', type: 'transport', dtlsState: 'connected', localCertificateId: 'L', remoteCertificateId: 'R' },
      { id: 'L', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: this.local.split(' ')[1] },
      { id: 'R', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: this.remoteSeen.split(' ')[1] },
    ];
    return { forEach: (cb) => reports.forEach(cb) };
  }
  close() { this.closed = true; }
  connect(remoteSeen) { this.remoteSeen = remoteSeen; this.iceConnectionState = 'connected'; this.oniceconnectionstatechange?.(); }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCSessionDescription = class { constructor(x) { Object.assign(this, x); } };
globalThis.RTCIceCandidate = class { constructor(x) { Object.assign(this, x); } };
const notices = [];
globalThis.window = new EventTarget();
window.addEventListener('aegis:mqtt-notice', (e) => notices.push(e.detail));
const localStream = { getTracks: () => [audio, video], getAudioTracks: () => [audio], getVideoTracks: () => [video] };
const audio = fakeTrack('audio');
const video = fakeTrack('video');
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => localStream } } });

const out = join(dir, 'c.mjs');
await require('esbuild').build({ entryPoints: [SRC + '/services/groupCallService.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', plugins: [stub] });
const { groupCallService: svc } = await import(pathToFileURL(out));
let nonceSeq = 0;
const sig = (signal, data, over = {}) => ({ kind: 'call', gid: 'g1', signal, data, iat: Date.now(), nonce: `nonce-${++nonceSeq}-xxxxxxxxxxxx`, ...over });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await tick(20); } return false; };
const fpSent = (to) => globalThis.__signals.filter((x) => x.to === to && x.body.signal === 'fp');
const stream = () => { const t = [fakeTrack('audio', false)]; return { getTracks: () => t }; };

svc.initialize('zME');
await svc.startGroupCall('g1', '本機群名', ['alice', 'bob', 'carol'], true);

// ── 1 ＋ 2 ＋ 3：Alice（指紋對得上）──
svc.handleControl('g1', 'alice', { action: 'join', video: true });
await tick();
const pcA = FakePC.all.at(-1);
assert.equal(pcA.senders.length, 2, 'audio + video go to the PC');
assert.ok(pcA.senders.every((t) => !t.original), 'each PC gets its own clones, never the shared local tracks');
assert.ok(pcA.senders.every((t) => t.enabled === false), 'the clones start disabled (silence / black until verified)');
assert.deepEqual(globalThis.__signals.filter((x) => x.to === 'alice').map((x) => x.body.signal), ['offer']);
svc.handleSignal('alice', sig('answer', { type: 'answer', sdp: 'a' }));
await tick();
const sA = stream();
pcA.ontrack({ streams: [sA] });
assert.equal(svc.getParticipants().get('alice').remoteStream, null, 'Alice\'s stream is held back before verification');
assert.ok(sA.getTracks().every((t) => t.enabled === false), '…and muted');
pcA.connect(FP.alice);
assert.ok(await until(() => fpSent('alice').length > 0), 'after ICE connects my fingerprints go to Alice');
const mine = fpSent('alice')[0];
assert.deepEqual([mine.body.kind, mine.opts?.transient, mine.body.gid], ['call', true, 'g1'], 'sealed to Alice as a group call signal, transient');
assert.deepEqual(mine.body.data, { local: [FP.me], remote: [FP.alice], got: false }, 'mine = what I hold and what I see of her');
assert.equal(svc.getParticipants().get('alice').isConnected, false, 'not connected on ICE alone');
assert.equal(svc.debugState().peers.alice.verified, false);
svc.handleSignal('alice', sig('fp', { local: [FP.alice], remote: [FP.me], got: true }));
await tick();
const a = svc.getParticipants().get('alice');
assert.equal(svc.debugState().peers.alice.verified, true, 'cross-matching fingerprints verify Alice');
assert.equal(a.isConnected, true, 'Alice is connected only now');
assert.equal(a.remoteStream, sA, 'her stream goes to the screen');
assert.ok(sA.getTracks().every((t) => t.enabled), '…unmuted');
assert.ok(pcA.senders.every((t) => t.enabled === true), 'my clones for Alice are on (unmuted, camera on)');
svc.toggleMute();
assert.equal(pcA.senders.find((t) => t.kind === 'audio').enabled, false, 'mute reaches the clones');
svc.toggleMute();
assert.equal(pcA.senders.find((t) => t.kind === 'audio').enabled, true);
console.log('PASS each PC sends disabled clones and holds the remote stream; fingerprints go out sealed after ICE; cross-match → connected, media on');

// ── 4：Bob（他看到的「對方」不是我 ＝ 中間有人）──
svc.handleControl('g1', 'bob', { action: 'join', video: true });
await tick();
const pcB = FakePC.all.at(-1);
svc.handleSignal('bob', sig('answer', { type: 'answer', sdp: 'a' }));
await tick();
const sB = stream();
pcB.ontrack({ streams: [sB] });
pcB.connect(FP.mitm);
assert.ok(await until(() => fpSent('bob').length > 0));
const n0 = notices.length;
svc.handleSignal('bob', sig('fp', { local: [FP.bob], remote: [FP.mitm], got: false }));
await tick();
assert.equal(pcB.closed, true, 'the PC to Bob is closed');
assert.ok(!svc.getParticipants().has('bob'), 'Bob is dropped from the call');
assert.ok(pcB.senders.every((t) => t.stopped && !t.everEnabled), 'my clones for Bob were never enabled and are stopped');
assert.ok(sB.getTracks().every((t) => !t.enabled), 'Bob\'s stream was never played');
assert.deepEqual(notices.slice(n0), [{ kind: 'group-call-unverified', reason: 'mismatch' }], 'the user is told (group-call-unverified)');
assert.equal(svc.debugState().counters['fp-mismatch'], 1);
assert.equal(pcA.closed, false, 'Alice stays in the call');
assert.equal(svc.getParticipants().get('alice').isConnected, true);
console.log('PASS mismatch (Bob sees someone else\'s certificate): only that PC is dropped, its media never flowed, the user is told; Alice stays');

// ── 5：讀不到指紋；不是成員、別的群、重放 ──
svc.handleControl('g1', 'carol', { action: 'join', video: false });
await tick();
const pcC = FakePC.all.at(-1);
pcC.unreadable = true;
pcC.connect(FP.alice);
assert.ok(await until(() => pcC.closed, 6000), 'unreadable fingerprints → the PC is dropped');
assert.equal(notices.at(-1)?.reason, 'unreadable');
assert.ok(!svc.getParticipants().has('carol'));
const before = svc.debugState().counters['fp-verified'] ?? 0;
svc.handleSignal('mallory', sig('fp', { local: [FP.alice], remote: [FP.me], got: true }));
svc.handleSignal('alice', sig('fp', { local: [FP.alice], remote: [FP.me], got: true }, { gid: 'g2' }));
const replay = sig('fp', { local: [FP.mitm], remote: [FP.me], got: true });
svc.handleSignal('alice', replay);
svc.handleSignal('alice', replay);
await tick();
assert.equal(svc.debugState().counters['fp-verified'] ?? 0, before, 'no new verification from these');
assert.equal(pcA.closed, true, 'control: a fresh mismatching fingerprint from Alice herself still drops her (a verified link is re-checked)');
console.log('PASS unreadable fingerprints drop the PC; fingerprints from non-members, other groups and replays are ignored');

// ── 6：指紋比 PC／ICE 先到 ──
const early = sig('fp', { local: [FP.dave], remote: [FP.me], got: true });
svc.handleSignal('dave', early);            // 還沒有跟 Dave 的 PC：沒有地方收 → 丟掉（他會重送）
await tick();
assert.equal(svc.debugState().peers.dave, undefined, 'a fingerprint before any PC with that member creates nothing');
svc.handleControl('g1', 'dave', { action: 'join', video: false });
await tick();
const pcD = FakePC.all.at(-1);
svc.handleSignal('dave', sig('fp', { local: [FP.dave], remote: [FP.me], got: true }));   // PC 有了、ICE 還沒連上：先收著
await tick();
assert.equal(svc.debugState().peers.dave.verified, false, 'held, not verified before ICE connects and my own fingerprints are read');
pcD.connect(FP.dave);
assert.ok(await until(() => svc.debugState().peers.dave?.verified === true), 'the held fingerprint verifies once ICE connects');
assert.equal(pcD.closed, false);
console.log('PASS a fingerprint that arrives before ICE connects is held and checked then; one before any PC is dropped');

// ── 7：誰發起 offer（G1 抓到的：加入的人公鑰較大時兩邊都在等，那一對接不起來）──
globalThis.__signals.length = 0;
svc.handleControl('g1', 'zzz-late', { action: 'join', video: false });
await tick();
assert.deepEqual(globalThis.__signals.filter((x) => x.to === 'zzz-late').map((x) => x.body.signal), ['offer'],
  'a member already in the call offers to a joiner even when the joiner\'s key is larger (no pair is left waiting)');
// glare：兩邊同時發起（幾乎同時加入）
const pcZ = FakePC.all.at(-1);
svc.handleSignal('zzz-late', sig('offer', { type: 'offer', sdp: 'their-offer' }));
await tick();
assert.deepEqual(pcZ.log, ['local:offer', 'local:rollback', 'remote:offer', 'local:answer'], 'glare, my key smaller: I roll back my offer and answer theirs');
assert.equal(globalThis.__signals.filter((x) => x.to === 'zzz-late').at(-1).body.signal, 'answer');
svc.handleControl('g1', 'erin', { action: 'join', video: false });
await tick();
const pcE = FakePC.all.at(-1);
const before7 = globalThis.__signals.length;
svc.handleSignal('erin', sig('offer', { type: 'offer', sdp: 'their-offer' }));
await tick();
assert.deepEqual(pcE.log, ['local:offer'], 'glare, my key larger: their offer is ignored, mine stands');
assert.equal(globalThis.__signals.length, before7, '…and nothing is sent back');
svc.handleSignal('erin', sig('answer', { type: 'answer', sdp: 'their-answer' }));
await tick();
assert.deepEqual(pcE.log, ['local:offer', 'remote:answer'], 'they answer my offer');
console.log('PASS the member already in the call always offers to a joiner; simultaneous offers are resolved by key order (smaller rolls back)');

// ── 8：驗過的連線上重新協商（深度防禦，5d 複審 L5）──
svc.handleControl('g1', 'frank', { action: 'join', video: false });
await tick();
const pcF = FakePC.all.at(-1);
svc.handleSignal('frank', sig('answer', { type: 'answer', sdp: 'a' }));
await tick();
pcF.connect(FP.frank);
assert.ok(await until(() => fpSent('frank').length > 0));
svc.handleSignal('frank', sig('fp', { local: [FP.frank], remote: [FP.me], got: true }));
await tick();
assert.equal(svc.debugState().peers.frank?.verified, true);
const sdpWith = (fp) => `v=0\r\na=fingerprint:${fp}\r\n`;
svc.handleSignal('frank', sig('offer', { type: 'offer', sdp: sdpWith(FP.frank) }));
await tick();
assert.equal(pcF.closed, false, 'a renegotiation offer with the verified certificate is taken');
assert.equal(globalThis.__signals.filter((x) => x.to === 'frank').at(-1).body.signal, 'answer');
const nF = notices.length;
svc.handleSignal('frank', sig('offer', { type: 'offer', sdp: sdpWith(FP.mitm) }));
await tick();
assert.equal(pcF.closed, true, 'a renegotiation offer with another certificate drops the verified connection');
assert.deepEqual(notices.slice(nF), [{ kind: 'group-call-unverified', reason: 'mismatch' }]);
console.log('PASS renegotiation on a verified connection must keep the verified certificate (otherwise dropped, user told)');
svc.endCall();
process.exit(0);

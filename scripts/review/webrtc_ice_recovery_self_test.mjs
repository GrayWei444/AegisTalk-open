/**
 * 短暫斷線後 ICE 自己恢復，要補發一次 DataChannel OPEN（移植群星 B34）：真的 webrtc.ts，stub 掉 mqtt、假的 RTCPeerConnection。
 *   DataChannel 一直是 open、不會再有 open 事件 → onPeerConnected 不跑 → 斷線期間排進 outbox 的訊息一直卡著。
 *   1. 瀏覽器常見的順序：iceconnectionstatechange（connected）先到、connectionstatechange（connected）後到 → 補發剛好一次
 *      （群星只在 connectionstatechange 比前一個狀態，這個順序下比不出來）
 *   2. 反過來的順序也只補發一次
 *   3. 沒斷過的 connected 事件不補發；通道已經關了不補發（重開時 onopen 自己會發）；舊 PC 的晚到事件不補發
 *   4. 通道編號（channelEpoch，fileTransfer 一輪送檔綁在上面）：每條通道 open 換號，ICE 恢復不換，PC 拆了回 0
 *   5. 連線已經 failed／closed、通道 readyState 卻還說 open（對方關了 App、這條通道還沒收過心跳）→ connect 拆掉重建；
 *      只是暫時 disconnected、或真的連著 → 不動（四機模擬 D1：該由我重連時每次都白叫，對方重開 App 後幾分鐘連不回來）
 * Run: node scripts/review/webrtc_ice_recovery_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webrtcStub } from './webrtcKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'rtcrecover-'));
const stub = webrtcStub();
globalThis.localStorage = { getItem: () => null };
globalThis.RTCPeerConnection = class {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable'; }
  close() {} getStats() { return Promise.resolve(new Map()); }
};
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/webrtc.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [stub] });
const { webrtcService: svc } = await import(pathToFileURL(join(dir, 'w.mjs')));
svc.startDcHeartbeat = () => {};
svc.initialize('ME');
const opens = [];
svc.onDataChannelStateChange((pk, state) => { if (state === 'open') opens.push(pk); });

function makePeer(pk, dcState = 'open') {
  const connection = svc.createPeerConnection(pk, true);
  svc.peers.set(pk, { publicKeyBase64: pk, connection, dataChannel: { readyState: dcState, close() {} }, connectionState: 'connected',
    dataChannelState: 'open', isInitiator: true, pendingCandidates: [], candidateFlushTimer: null, incomingCandidates: [],
    lastDcInboundAt: Date.now(), hbCapable: false, localPcId: 'pc-1',
    // DTLS 指紋已經對過的連線（開源第 4 步；沒對過的不算開著，見 webrtc_fingerprint_gate_self_test）
    fp: { start() {}, stop() {}, receive() {}, state: 'verified' }, verified: true, heldInbound: [], heldInboundBytes: 0 });
  const ice = (s) => { connection.iceConnectionState = s; connection.oniceconnectionstatechange(); };
  const conn = (s) => { connection.connectionState = s; connection.onconnectionstatechange(); };
  ice('connected'); conn('connected');
  return { connection, ice, conn };
}

// 1
let p = makePeer('A');
assert.deepEqual(opens, [], 'a normal first connect does not re-announce (onopen does that)');
p.ice('disconnected'); p.conn('disconnected');
p.ice('connected');                                   // ICE 先恢復、connectionState 還是 disconnected
assert.deepEqual(opens, [], 'not yet: the connection itself still says disconnected');
p.conn('connected');
assert.deepEqual(opens, ['A'], 'ICE recovered with the channel still open → OPEN re-announced once');
p.ice('completed'); p.conn('connected');
assert.deepEqual(opens, ['A'], 'only once per interruption');
console.log('PASS ICE-first recovery (the usual browser order) re-announces OPEN exactly once');

// 2
opens.length = 0;
p = makePeer('B');
p.conn('disconnected'); p.ice('disconnected');
p.conn('connected'); p.ice('connected');
assert.deepEqual(opens, ['B'], 'connection-first recovery also re-announces once');
console.log('PASS connection-first recovery re-announces OPEN exactly once');

// 3
opens.length = 0;
p = makePeer('C');
p.ice('completed'); p.conn('connected');
assert.deepEqual(opens, [], 'no interruption → nothing to re-announce');
p = makePeer('D', 'closed');
p.ice('disconnected'); p.conn('disconnected'); p.ice('connected'); p.conn('connected');
assert.deepEqual(opens, [], 'channel already closed → its reopen announces itself');
p = makePeer('E');
const old = p;
p.ice('disconnected'); p.conn('disconnected');
makePeer('E');                                         // 換了一條新的 PC
old.connection.connectionState = 'connected'; old.connection.iceConnectionState = 'connected';
old.connection.oniceconnectionstatechange(); old.connection.onconnectionstatechange();
assert.deepEqual(opens, [], 'late events from a replaced PC do not re-announce');
console.log('PASS no re-announce without an interruption, with a closed channel, or from a replaced PC');

// 4 通道編號（fileTransfer 用來認「還是不是同一條通道」）：每條通道 open 換號；ICE 恢復補發的 OPEN 不換；PC 拆了回 0
p = makePeer('F');
const openChannel = () => { const ch = { readyState: 'open', close() {} }; svc.setupDataChannel(ch, 'F'); ch.onopen(); return ch; };
openChannel();
const first = svc.channelEpoch('F');
assert.ok(first > 0, 'an opened channel gets a number');
p.ice('disconnected'); p.conn('disconnected'); p.ice('connected'); p.conn('connected');
assert.equal(svc.channelEpoch('F'), first, 'ICE recovering on the same channel keeps the number (an in-flight file round stays valid)');
openChannel();
assert.ok(svc.channelEpoch('F') > first, 'a new channel (peer reopened its app, reconnect, second channel) gets a new number');
svc.closePeer('F');
assert.equal(svc.channelEpoch('F'), 0, 'no channel → 0');
console.log('PASS channel numbers change on every channel open, not on ICE recovery; 0 once the peer is gone');

// 5 failed／closed 的連線上殘留 'open' 的通道：connect 要重建；暫時 disconnected、連著的不動
RTCPeerConnection.prototype.createDataChannel = function () { return { readyState: 'connecting', close() {} }; };
RTCPeerConnection.prototype.createOffer = async function () { return { type: 'offer', sdp: '' }; };
RTCPeerConnection.prototype.setLocalDescription = async function () {};
for (const [conn, ice, rebuilt] of [['failed', 'disconnected', true], ['closed', 'closed', true], ['connected', 'failed', true],
  ['failed', 'checking', true], ['disconnected', 'disconnected', false], ['connected', 'connected', false]]) {
  p = makePeer('H');
  p.connection.connectionState = conn; p.connection.iceConnectionState = ice;
  await svc.connect('H');
  assert.equal(svc.peers.get('H')?.connection !== p.connection, rebuilt, `conn=${conn} ice=${ice} with a channel still saying open → ${rebuilt ? 'rebuilt' : 'left alone'}`);
  svc.closePeer('H');
}
console.log('PASS a failed/closed connection whose channel still says open is rebuilt by connect(); live or briefly disconnected ones are left alone');

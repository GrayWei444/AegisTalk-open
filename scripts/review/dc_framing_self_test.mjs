/**
 * DataChannel 大訊息分塊（傳輸統一 X5）：真的 dcFraming.ts／webrtc.ts／p2pSend.ts。
 *   以前一則訊息超過 DataChannel 上限（Chromium ~256KB）時 send() 直接 throw：
 *   1 對 1 語音約 7 秒以上（base64 音訊 × ratchet JSON 數字陣列 ≈ 3.6 倍）、或很長的文字就送不出去，
 *   進 outbox 後 flush 每次停在那筆 → 該好友之後的訊息全部卡住 30 天。
 *   現在：超過上限的字串自動切塊、收端重組（不切斷 emoji）；收端有上限防灌爆；
 *   outbox 裡永遠送不出去的超大舊條目會被移除，不再擋住後面的訊息。
 * Run: node scripts/review/dc_framing_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'dcframe-'));
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

// ── 1. dcFraming 本身 ──
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/services/dcFraming.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'f.mjs'), logLevel: 'silent' });
const F = await import(pathToFileURL(join(dir, 'f.mjs')));
const LIMIT = 240 * 1024;

const small = JSON.stringify({ type: 'encrypted_message', payload: 'x'.repeat(1000) });
assert.deepEqual(F.splitFrame(small, LIMIT), [small], 'small messages go out unchanged (old peers keep working)');

const voice = JSON.stringify({ type: 'encrypted_message', payload: JSON.stringify({ ciphertext: Array.from({ length: 600_000 }, (_, i) => i % 256) }) });
const parts = F.splitFrame(voice, LIMIT);
assert.ok(parts.length > 1 && parts.every((p) => utf8(p) <= LIMIT), `every part fits the limit (${parts.length} parts)`);
let asm = new F.FrameAssembler();
let out;
for (const p of parts) out = asm.push(p);
assert.equal(out, voice, 'reassembles a ~2MB voice-sized message exactly');

const cjk = ('語音訊息😀測試' + 'é').repeat(60_000);
const cparts = F.splitFrame(cjk, LIMIT);
assert.ok(cparts.every((p) => utf8(p) <= LIMIT), 'multi-byte text parts fit the byte limit');
const body = (p) => p.split('|').slice(4).join('|');   // 去掉 "\u0001P|id|seq|count|" 標頭
assert.ok(cparts.every((p) => !/^[\uDC00-\uDFFF]/.test(body(p)) && !/[\uD800-\uDBFF]$/.test(body(p))), 'no part splits an emoji surrogate pair');
asm = new F.FrameAssembler();
for (const p of cparts) out = asm.push(p);
assert.equal(out, cjk, 'reassembles multi-byte text exactly');
assert.equal(F.splitFrame('x'.repeat(F.DC_MAX_MESSAGE_CHARS + 1), LIMIT), null, 'over the hard cap → refused');
console.log(`PASS split/reassemble (${parts.length} parts for ${(voice.length / 1e6).toFixed(1)}M chars; emoji-safe)`);

// 收端防灌爆
asm = new F.FrameAssembler();
assert.equal(asm.push(small), undefined, 'normal frames pass through');
assert.equal(asm.push('\u0001P|a|0|0|x'), null, 'count 0 rejected');
assert.equal(asm.push('\u0001P|a|5|3|x'), null, 'seq out of range rejected');
assert.equal(asm.push('\u0001P|a|0|99999|x'), null, 'absurd part count rejected');
assert.equal(asm.size, 0, 'rejected frames leave no state');
for (let i = 0; i < 10; i++) asm.push(`\u0001P|id${i}|0|2|x`);
assert.ok(asm.size <= 4, `at most 4 messages in assembly per peer (got ${asm.size})`);
let clock = 0;
asm = new F.FrameAssembler(() => clock);
asm.push('\u0001P|t|0|2|a');
clock = 61_000;
asm.push('\u0001P|u|0|2|b');
assert.equal(asm.push('\u0001P|t|1|2|c'), null, 'an assembly older than 60s is dropped');
const big = 'y'.repeat(3_000_000);
for (let s = 0; s < 3; s++) asm.push(`\u0001P|huge|${s}|4|${big}`);
assert.ok(asm.bufferedChars <= F.DC_MAX_MESSAGE_CHARS, 'buffered characters capped');
console.log('PASS receiver limits (bad frames, concurrency, 60s expiry, size cap)');

// ── 2. 真的 webrtc.ts：send 切塊、onmessage 重組 ──
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|\.\/directSignal$|\.\/iceServers$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    // 信令（開源第 4 步：DIRECT_SEALED kind dc）：這裡不測信令
    : a.path.includes('directSignal') ? 'export const onDirect=()=>()=>{};export const sendDirect=async()=>true;'
    : 'export async function getIceServers(){return []}' }));
} };
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/services/webrtc.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [stub] });
globalThis.localStorage = { getItem: () => null };
console.error = () => {};
const { webrtcService: rtc } = await import(pathToFileURL(join(dir, 'w.mjs')));
const wire = [];
const PK = 'P'.repeat(44);
const dc = { readyState: 'open', bufferedAmount: 0, send: (d) => { if (utf8(d) > 256 * 1024) throw new TypeError('too large'); wire.push(d); } };
// DTLS 指紋已經對過的通道（開源第 4 步：沒對過的不送、收到的先壓著 —— webrtc_fingerprint_gate_self_test）
const verified = { verified: true, heldInbound: [], heldInboundBytes: 0, fp: { start() {}, stop() {}, receive() {}, state: 'verified' } };
rtc.peers.set(PK, { publicKeyBase64: PK, connection: { sctp: { maxMessageSize: 262144 } }, dataChannel: dc, lastDcInboundAt: 0, hbCapable: false, ...verified });
assert.equal(rtc.send(PK, voice), true, 'a voice-sized message is accepted by send()');
assert.ok(wire.length > 1, 'and went out as several frames');
const got = [];
rtc.onMessage((pk, data) => got.push(data));
const rx = {};
rtc.setupDataChannel(rx, PK);
for (const d of wire) rx.onmessage({ data: d });
assert.deepEqual(got, [voice], 'the receiver delivers exactly one reassembled message');
console.log(`PASS webrtc.ts send/receive (${wire.length} frames → 1 message)`);

// 新舊版混用：舊版收端不認得分塊幀，舊版直接 send() 送得到的大小必須照舊單幀送
const sendWith = (connection, size, sendLimit = 256 * 1024) => {
  const frames = [];
  const attempts = [];
  const chan = { readyState: 'open', bufferedAmount: 0, send: (d) => { attempts.push(utf8(d)); if (utf8(d) > sendLimit) throw new TypeError('too large'); frames.push(d); } };
  rtc.peers.set(PK, { publicKeyBase64: PK, connection, dataChannel: chan, lastDcInboundAt: 0, hbCapable: false, ...verified });
  const msg = JSON.stringify({ type: 'encrypted_message', payload: 'x'.repeat(size) });
  return { ok: rtc.send(PK, msg), frames, msg, attempts };
};
let r = sendWith({ sctp: { maxMessageSize: 262144 } }, 248 * 1024);
assert.ok(r.ok && r.frames.length === 1 && r.frames[0] === r.msg, '248KB (old senders sent it whole) still goes out as one frame');
r = sendWith({}, 100 * 1024);
assert.ok(r.ok && r.frames.length === 1, 'no sctp info: 100KB is not chunked (old peers could receive it)');
r = sendWith({ sctp: null }, 200 * 1024);
assert.ok(r.ok && r.frames.length === 1, 'sctp null (ICE blip): 200KB is not chunked');
r = sendWith({ sctp: { maxMessageSize: 1 << 30 } }, 300 * 1024);
assert.ok(r.ok && r.frames.length > 1, 'peer advertises more than this side can send → goes out as chunks');
// 宣告得更大（Firefox 宣告 1GB）時不去試單幀：libwebrtc 在 reliable 通道送超過上限的訊息可能直接把通道關掉
//   （對應 AegisPlay 170125d8，第二輪審查 L1）
assert.ok(r.attempts.every((n) => n <= 256 * 1024), 'and a single frame over 256KB is never even tried (it may close the channel)');
const back = [];
const off = rtc.onMessage((pk, data) => back.push(data));
const rx2 = {};
rtc.setupDataChannel(rx2, PK);
for (const d of r.frames) rx2.onmessage({ data: d });
assert.ok(back.includes(r.msg), 'and the fallback chunks reassemble');
off();
console.log('PASS mixed versions: sizes old peers could receive stay single-frame');

// ── 3. p2pSend：超大舊條目不再擋住後面 ──
const read = (p) => readFileSync(root + 'packages/pwa/src/' + p, 'utf8');
const mod = { exports: {} };
let pending = [];
const storage = {
  getPendingMessageCount: async (peer) => pending.filter((m) => m.recipientPubkey === peer).length,
  addPendingMessage: async (m) => pending.push(m),
  getPendingMessagesForRecipient: async (peer) => pending.filter((m) => m.recipientPubkey === peer),
  getAllPendingMessages: async () => pending,
  removePendingMessage: async (id) => { pending = pending.filter((m) => m.id !== id); },
  updatePendingMessageRetry: async () => {},
};
const framing = await import(pathToFileURL(join(dir, 'f.mjs')));
const capMatch = read('services/p2pSend.ts').match(/const DC_MAX_MESSAGE_CHARS = ([\d *]+);/);
assert.ok(capMatch, 'p2pSend declares its DataChannel size cap');
assert.equal(Number(eval(capMatch[1])), framing.DC_MAX_MESSAGE_CHARS, 'p2pSend and dcFraming agree on the size cap');
runInNewContext(esbuild.transformSync(read('services/p2pSend.ts'), { loader: 'ts', format: 'cjs' }).code, {
  module: mod, exports: mod.exports, crypto: webcrypto, Date, Math, JSON, setTimeout: () => 0, console: { error() {} },
  require: (n) => {
    if (n === './storage') return storage;
    if (n === '../utils/devLog') return { devLog() {}, devWarn() {} };
    if (n === '../utils/diagLog') return { diagLog() {} };
    throw Error(n);
  },
});
const api = mod.exports;
const sent = [];
// 真的 webrtc.send 對永遠送不出去的訊息回 false（splitFrame → null）；這裡照樣模擬
api.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: (_p, d) => { if (d.length > framing.DC_MAX_MESSAGE_CHARS) return false; sent.push(d); return true; }, connectPeer: async () => {} });
const huge = JSON.stringify({ type: 'encrypted_message', payload: 'z'.repeat(framing.DC_MAX_MESSAGE_CHARS + 10) });
pending.push({ id: 'old-huge', recipientPubkey: 'peer', encryptedPayload: huge, messageType: 'encrypted_message', createdAt: 1, retryCount: 0 });
pending.push({ id: 'next', recipientPubkey: 'peer', encryptedPayload: small, messageType: 'encrypted_message', createdAt: 2, retryCount: 0 });
await api.flushQueueForPeer('peer');
assert.deepEqual(sent, [small], 'the message behind an undeliverable giant is sent');
assert.equal(pending.length, 0, 'the undeliverable giant is removed from the outbox');
assert.equal(api.sendViaP2P('peer', huge), false, 'a new giant is refused');
await new Promise((r) => setImmediate(r));
assert.equal(pending.length, 0, 'and never enters the outbox');
console.log('PASS outbox no longer blocks behind an oversized entry');

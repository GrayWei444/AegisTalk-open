/**
 * 連送 5 張照片，5 張都要到；送端要等收端 ack 才從待送清單移除（移植群星 B32）。
 * 兩份真的 fileTransfer.ts（送端、收端）直接接起來：manifest／chunks 往收端、ack／busy 往送端。
 *   以前：收端不回 ack、送端推完就當送到；同時太多時收端靜默丟掉 → 那張就永遠不見。
 *   1. 連送 5 張全部收到，每張收端 ack 之後送端才從待送清單移除
 *   2. 收端早就有了（ack 在路上掉了）→ 送端重連補送時收端直接回 ack，不再推 chunks、也不會多一則
 *   3. 收端同時在收的檔太多 → 回 busy（不是靜默丟掉）；送端留著、稍後再送
 *   4. 對端亂送的 manifest（chunkCount 2^31、size／chunk 對不上、fileKey 不是 32 bytes、sha256 格式錯）一律不收、不回 ack
 * Run: node scripts/review/file_ack_queue_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File, Blob } from 'node:buffer';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const req = createRequire(ROOT + 'package.json');
const { transformSync } = req('esbuild');
const code = transformSync(readFileSync(ROOT + 'src/services/fileTransfer.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;

function load(name) {
  const module = { exports: {} };
  const ls = new Map();
  const blobs = new Map();
  let n = 0;
  runInNewContext(code, {
    module, exports: module.exports, crypto: webcrypto, Blob, atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    Promise, Date, JSON, Math, Array, Set, Map, Number, String, console: { error() {}, warn() {}, log() {} },
    setTimeout: (f, ms) => (ms >= 30_000 ? 0 : setTimeout(f, ms)), clearTimeout,   // 長計時（stall、ack 逾時）不跑
    localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: (k) => ls.delete(k) },
    require: (m) => ({
      'hash-wasm': req('hash-wasm'), '../utils/devLog': { devLog() {}, devWarn() {} }, '../utils/diagLog': { diagLog() {} },
      './fileBlobStore': { putBlob: async (id, b) => { blobs.set(id, b); }, readBlob: async (id) => blobs.get(id) ?? null },
      '../utils/secureId': { generateId: (p) => `${p}_${name}${(++n).toString().padStart(8, '0')}` },
    })[m],
  });
  return { api: module.exports, ls, blobs };
}

const S = load('snd'), R = load('rcv');
const received = [];
const ctlSeen = [];
const later = (fn) => setTimeout(fn, 0);   // 跨端訊息非同步到達
const plain = (x) => JSON.parse(JSON.stringify(x));   // vm 裡建的物件換成這邊的（deepStrictEqual 會比原型）
S.api.initFileTransfer({
  owner: 'A', getBufferedAmount: () => 0, isConnectedTo: () => true, connectPeer: async () => {},
  sendManifest: async (_p, m) => { later(() => void R.api.handleManifestPayload(m, 'A')); },
  sendChunk: (_p, f) => { const copy = f.slice(0); later(() => void R.api.handleChunkFrame(copy, 'A')); return true; },
});
R.api.initFileTransfer({
  owner: 'B', getBufferedAmount: () => 0, isConnectedTo: () => true, connectPeer: async () => {},
  sendChunk: () => true, sendManifest: async () => {},
  sendControl: async (_p, ctl) => { ctlSeen.push(ctl); later(() => S.api.handleFileControl('B', ctl)); },
});
R.api.onFileReceived((rf) => { received.push(rf.name); });

// 1
for (let i = 1; i <= 5; i++) {
  await S.api.sendFile('B', new File([new Uint8Array(1024 * 1024).fill(i)], `photo${i}.jpg`, { type: 'image/jpeg' }));
}
const pending = () => JSON.parse(S.ls.get('aegis_file_pending') || '[]').length;
assert.ok(pending() > 0, 'sent files are on the pending list until acked');
for (let t = 0; t < 200 && (received.length < 5 || pending() > 0); t++) await new Promise((r) => setTimeout(r, 50));
assert.deepEqual([...received].sort(), ['photo1.jpg', 'photo2.jpg', 'photo3.jpg', 'photo4.jpg', 'photo5.jpg'], `all five arrive (got ${received.join(',')})`);
assert.equal(pending(), 0, 'sender clears each file only after the receiver acks it');
assert.equal(ctlSeen.filter((c) => c.kind === 'ack').length, 5, 'one ack per file');
console.log('PASS five photos in a row all arrive; sender clears its pending list on the receiver\'s acks');

// 2
const before = received.length;
const [fileId] = [...R.blobs.keys()];
S.ls.set('aegis_file_pending', JSON.stringify([{ owner: 'A', peer: 'B', at: Date.now(), manifest: { v: 1, fileId, messageId: 'm', name: 'dup.jpg', mimeType: 'image/jpeg', size: 1, sha256: 'a'.repeat(64), chunkSize: 65536, chunkCount: 1, fileKey: Buffer.alloc(32).toString('base64'), timestamp: 1 } }]));
S.blobs.set(fileId, new Blob([new Uint8Array(1)]));
S.api.resumePendingChunks('B');
for (let t = 0; t < 60 && pending() > 0; t++) await new Promise((r) => setTimeout(r, 50));
assert.equal(pending(), 0, 'duplicate resend is acked straight away');
assert.equal(received.length, before, 'no duplicate file message');
console.log('PASS a resend of a file the receiver already has is acked without re-delivery');

// 3 收端忙：同時在收 4 個（manifest 到了、chunks 還沒來）→ 第 5 個回 busy
const R2 = load('rcv2');
const busyCtl = [];
R2.api.initFileTransfer({ owner: 'B', getBufferedAmount: () => 0, isConnectedTo: () => true, connectPeer: async () => {},
  sendChunk: () => true, sendManifest: async () => {}, sendControl: async (_p, c) => { busyCtl.push(c); } });
const fakeManifest = (i) => ({ v: 1, fileId: `file_busy${String(i).padStart(4, '0')}`, messageId: `m${i}`, name: `f${i}`, mimeType: 'text/plain',
  size: 10, sha256: 'b'.repeat(64), chunkSize: 65536, chunkCount: 1, fileKey: Buffer.alloc(32, i).toString('base64'), timestamp: 1 });
for (let i = 1; i <= 5; i++) await R2.api.handleManifestPayload(fakeManifest(i), 'A');
assert.deepEqual(plain(busyCtl), [{ kind: 'busy', fileId: 'file_busy0005' }], 'the fifth concurrent file gets a busy reply instead of silence');
console.log('PASS a receiver that is busy says so (busy) instead of dropping the file silently');

// 4 亂送的 manifest
const R3 = load('rcv3');
const ctl3 = [];
R3.api.initFileTransfer({ owner: 'B', getBufferedAmount: () => 0, isConnectedTo: () => true, connectPeer: async () => {},
  sendChunk: () => true, sendManifest: async () => {}, sendControl: async (_p, c) => { ctl3.push(c); } });
const good = fakeManifest(9);
for (const [why, bad] of [
  ['huge chunkCount', { ...good, chunkCount: 2 ** 31, size: 2 ** 31 * 65536 }],
  ['chunkCount does not match size', { ...good, chunkCount: 7 }],
  ['short key', { ...good, fileKey: Buffer.alloc(16).toString('base64') }],
  ['bad sha256', { ...good, sha256: 'zz' }],
  ['bad fileId', { ...good, fileId: '../x' }],
]) {
  await R3.api.handleManifestPayload(bad, 'A');
  assert.equal(ctl3.length, 0, `${why}: no ack/busy for a forged manifest`);
}
// 亂送的都沒佔到收檔名額：之後 4 個合法的照樣收（不會回 busy）
for (let i = 11; i <= 14; i++) await R3.api.handleManifestPayload(fakeManifest(i), 'A');
assert.deepEqual(plain(ctl3), [], 'forged manifests created no receivers (four real ones still fit)');
await R3.api.handleManifestPayload(fakeManifest(15), 'A');
assert.deepEqual(plain(ctl3), [{ kind: 'busy', fileId: 'file_busy0015' }], 'the fifth real one is the first to get busy');
console.log('PASS forged manifests (huge chunkCount, inconsistent sizes, short key, bad hash/id) are refused');

// 5 AppProvider 的接線：file_ctl 交給 fileTransfer、不當訊息；init 帶 owner 與 sendControl；連上就補送待送的檔
const app = readFileSync(ROOT + 'src/providers/AppProvider.tsx', 'utf8');
const body = app.slice(app.indexOf('const processEncryptedMessage = async'), app.indexOf('processEncryptedMessageRef.current = processEncryptedMessage'));
const ctlAt = body.indexOf("type === 'file_ctl'");
assert.ok(ctlAt > 0 && ctlAt < body.indexOf('DIRECT_VISIBLE_TYPES'), 'file_ctl is handled before the visible-type check');
assert.match(body.slice(ctlAt, ctlAt + 300), /fileTransfer\.handleFileControl\(senderPublicKeyBase64, ctl\);\s*\}?\s*return;|handleFileControl\(senderPublicKeyBase64, ctl\);[\s\S]*?return;/, 'file_ctl goes to handleFileControl');
const init = app.slice(app.indexOf('fileTransfer.initFileTransfer({'), app.indexOf('fileTransfer.onFileReceived('));
assert.match(init, /owner: publicKey/, 'the pending-file list is bound to this account');
assert.match(init, /sendControl: async \(peer, payload\)[\s\S]*encrypt\(peer[\s\S]*type: 'file_ctl'[\s\S]*encrypted\.free\(\)/, 'acks / busy go out DR-encrypted as file_ctl');
const connected = app.slice(app.indexOf('const onPeerConnected = useCallback('), app.indexOf('const onPeerDisconnected'));
assert.match(connected, /resumePendingChunks\(peerPublicKey\)/, 'parked files resume when the peer connects');
console.log('PASS AppProvider wires file_ctl, the account-bound pending list and resume-on-connect');

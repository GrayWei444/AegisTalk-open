/**
 * 收檔做到一半 shutdown（登出、被踢、換帳號、effect 重跑）：還在 await 的那段回來之後不能再寫檔、不能通知、
 * 不能推進舊的接收狀態（移植群星 fileTransfer generation）。真的 fileTransfer.ts 片段。
 *   1. finalizeFile：hash 算完前 shutdown → 不寫檔、不通知；寫檔途中 shutdown → 不通知；正常 → 寫一次、通知一次、回 ack
 *   2. handleChunkFrame：解密完成前 shutdown → 舊的接收狀態不前進
 * Run: node scripts/review/file_shutdown_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../packages/pwa/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const src = readFileSync(new URL('../../packages/pwa/src/services/fileTransfer.ts', import.meta.url), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

// 1
const finalizeCode = transformSync(src.slice(src.indexOf('async function finalizeFile(')), { loader: 'ts' }).code;
for (const mode of ['normal', 'hash-shutdown', 'put-shutdown']) {
  let releaseHash, releasePut, writes = 0, notifications = 0;
  const acks = [];
  const state = { hashChain: new Promise((r) => { releaseHash = r; }), hasher: { digest: () => 'a'.repeat(64) }, hashedUpTo: 1,
    manifest: { fileId: 'f'.repeat(32), chunkCount: 1, sha256: 'a'.repeat(64), size: 1, mimeType: 'text/plain', name: 'file' },
    chunkBlobs: [new Blob(['x'])], fromPubkey: 'peer' };
  const ctx = { fileReceivedTasks: new Set(), transferGeneration: 0, receiverStates: new Map([['id', state]]), clearStallTimer() {},
    completedRecvFileIds: new Set(), COMPLETED_RECV_MAX: 32, Blob, devWarn() {}, notifyProgress() {}, diagLog() {}, console: { error() {} },
    fileReceivedListeners: new Set([() => notifications++]), Promise,
    sendCtl: (peer, kind) => acks.push(kind), readBlob: async () => null,
    putBlob: async () => { writes++; await new Promise((r) => { releasePut = r; }); } };
  runInNewContext(finalizeCode, ctx);
  const pending = ctx.finalizeFile('id');
  if (mode === 'hash-shutdown') ctx.transferGeneration++;
  releaseHash(); await flush();
  if (mode === 'put-shutdown') ctx.transferGeneration++;
  releasePut?.(); await pending;
  assert.equal(notifications, mode === 'normal' ? 1 : 0, `${mode}: notifications`);
  assert.equal(writes, mode === 'hash-shutdown' ? 0 : 1, `${mode}: writes`);
  assert.deepEqual(acks, mode === 'normal' ? ['ack'] : [], `${mode}: ack only once stored in this session`);
}
console.log('PASS a shutdown while a received file is being hashed or stored suppresses the old write / notification / ack');

// 2
const start = src.indexOf('export async function handleChunkFrame(');
const chunkCode = transformSync(src.slice(start, src.indexOf('/**', start)).replace('export async', 'async'), { loader: 'ts' }).code;
let release;
const state = { fromPubkey: 'peer', manifest: { chunkCount: 1, size: 1, chunkSize: 1 }, chunkBlobs: [undefined], receivedCount: 0 };
const ctx = { transferGeneration: 0, isFileTransferReady: () => true, _debugChunksReceived: 0, receiverStates: new Map([['id', state]]),
  decodeChunkFrame: () => ({ fileId: 'id', chunkIndex: 0, ciphertext: new Uint8Array(17), iv: 'AAAAAAAAAAAAAAAA' }),
  decryptChunkBytes: () => new Promise((r) => { release = r; }), devWarn() {} };
runInNewContext(chunkCode, ctx);
const work = ctx.handleChunkFrame(new ArrayBuffer(0), 'peer');
ctx.transferGeneration++;
release(new Uint8Array(1)); await work;
assert.equal(state.receivedCount, 0);
assert.equal(state.chunkBlobs[0], undefined);
console.log('PASS decryption finishing after shutdown cannot advance the old receiver');

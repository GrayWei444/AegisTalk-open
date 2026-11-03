/**
 * 掛起的送檔跨重開、對方晚上線也補得到（移植群星 Codex review 2026-09-27 #16；AegisTalk 稽核 H12：以前對方 15 秒內
 * 沒上線，chunks 就永遠不送）：真的 fileTransfer.ts 片段（park → resumePendingChunks），
 * 每一輪用新的 vm context＝「App 重開」，只有 localStorage 留下來。
 * Run: node scripts/review/file_parked_resume_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../packages/pwa/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const src = readFileSync(new URL('../../packages/pwa/src/services/fileTransfer.ts', import.meta.url), 'utf8');
const from = src.indexOf('const PARKED_LS');
const to = src.indexOf('/**', src.indexOf('export function resumePendingChunks'));
const code = transformSync(src.slice(from, to).replace(/export function/g, 'function'), { loader: 'ts' }).code
  + '\n;globalThis.api={park,resumePendingChunks,readParked,handleFileControl,setOwner:(o)=>{_owner=o}};';
// 重連補送會先等 1.5 秒看收端是不是早就有了（B32），所以補送後要等超過這段
const tick = () => new Promise((r) => setTimeout(r, 1_700));

const store = new Map();
let storageBroken = false;
const localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { if (storageBroken) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
};
const manifest = (fileId, chunkCount = 3) => ({ fileId, chunkCount, size: 1, fileKey: Buffer.alloc(32, 7).toString('base64') });

/**
 * 一次「App 啟動」：新的模組狀態，共用 localStorage。比 1.5 秒長的計時器（60 秒等 ack、重試退避）不跑：上一次「啟動」的
 * 重試不能在後面的步驟裡冒出來改清單（逾時重試、換通道見 file_resume_new_channel_self_test）
 */
function boot(owner, { blobs = new Map([['f1', new Blob(['x'])]]), sendResult = true, sendDelay = 0, blobError = false } = {}) {
  const sent = [];
  const ctx = {
    localStorage, Date, JSON, Array, Set, Map, Promise, console: { error() {} }, crypto: globalThis.crypto,
    setTimeout: (f, ms) => (ms > 1_600 ? 0 : setTimeout(f, ms)), clearTimeout: (h) => { if (h) clearTimeout(h); },
    transferGeneration: 0, devWarn() {}, notifyProgress() {}, diagLog() {}, recordRecentManifest() {},
    PEER_CONNECT_WAIT_MS: 15_000, _isConnectedTo: () => true, _connectPeer: async () => {}, _channelEpoch: null,
    base64ToBytes: (b) => new Uint8Array(Buffer.from(b, 'base64')),
    readBlob: async (id) => { if (blobError) throw new Error('Connection to Indexed Database server lost'); return blobs.get(id) ?? null; },
    _sendManifest: async (peer, m) => { sent.push({ manifest: m.fileId, peer }); },
    sendChunksToPeer: async (peer, blob, fileId, chunkCount) => {
      sent.push({ peer, fileId, chunkCount, size: blob.size });
      if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
      return sendResult ? 'pushed' : 'failed';
    },
  };
  runInNewContext(code, ctx);
  ctx.api.setOwner(owner);
  return { api: ctx.api, sent };
}

// 1. 送出當下記下來 → App 被殺 → 重開、對方連上 → 先重送 manifest 再補 chunks，送完才刪
let app = boot('A');
app.api.park('A', 'B', manifest('f1'));
assert.equal(JSON.parse(store.get('aegis_file_pending')).length, 1);
app = boot('A');
app.api.resumePendingChunks('B'); await tick();
assert.deepEqual(app.sent, [{ manifest: 'f1', peer: 'B' }, { peer: 'B', fileId: 'f1', chunkCount: 3, size: 1 }], 'manifest first, then chunks');
assert.equal(app.api.readParked().length, 1, 'chunks pushed but not acked yet → still pending (B32)');
app.api.handleFileControl('C', { kind: 'ack', fileId: 'f1' });
assert.equal(app.api.readParked().length, 1, 'an ack from someone else does not count');
app.api.handleFileControl('B', { kind: 'ack', fileId: 'f1' });
assert.equal(store.has('aegis_file_pending'), false, 'receiver acked → removed');
console.log('PASS parked send survives restart; manifest re-sent before chunks; removed only on the receiver\'s ack');

// 2. 沒送完（通道又斷、緩衝沒排空）→ 留著；IDB 暫時讀不到 → 也留著
boot('A').api.park('A', 'B', manifest('f1'));
app = boot('A', { sendResult: false });
app.api.resumePendingChunks('B'); await tick();
assert.equal(app.api.readParked().length, 1, 'incomplete → kept');
app = boot('A', { blobError: true });
app.api.resumePendingChunks('B'); await tick();
assert.equal(app.api.readParked().length, 1, 'transient IDB error must not drop the entry');
console.log('PASS incomplete push and transient IDB errors keep the entry');

// 3. 別的帳號、別的 peer 不動它；兩次連線事件同時到只推一份
app = boot('C'); app.api.resumePendingChunks('B'); await tick();
assert.equal(app.sent.length, 0, 'other owner must not send A\'s file');
app = boot('A'); app.api.resumePendingChunks('D'); await tick();
assert.equal(app.sent.length, 0, 'other peer untouched');
app = boot('A', { sendDelay: 30 });
app.api.resumePendingChunks('B'); app.api.resumePendingChunks('B');
await tick(); await new Promise((r) => setTimeout(r, 100));
assert.equal(app.sent.filter((s) => s.fileId).length, 1, 'duplicate connect events push once');
console.log('PASS owner/peer scoped; concurrent resumes push once');

// 4. 本機檔確定不在 → 丟掉；超過 30 天 → 不送
store.delete('aegis_file_pending');   // 前面的 f1 還在等 ack（會佔住這個 peer 的佇列），這一段只看 'gone'
boot('A').api.park('A', 'B', manifest('gone', 2));
app = boot('A'); app.api.resumePendingChunks('B'); await tick();
assert.equal(app.api.readParked().length, 0, 'missing blob → dropped');
store.set('aegis_file_pending', JSON.stringify([{ owner: 'A', peer: 'B', manifest: manifest('f1'), at: Date.now() - 31 * 86400e3 }]));
app = boot('A'); app.api.resumePendingChunks('B'); await tick();
assert.equal(app.sent.length, 0, 'expired entry ignored');
store.delete('aegis_file_pending');
console.log('PASS missing blob dropped; entries older than 30 days ignored');

// 5. localStorage 寫不進去 → 這個 session 內照樣送得到（退回記憶體）
storageBroken = true;
app = boot('A');
app.api.park('A', 'B', manifest('f1'));
app.api.resumePendingChunks('B'); await tick();
assert.equal(app.sent.filter((s) => s.fileId).length, 1, 'storage failure falls back to memory within the session');
storageBroken = false;
console.log('PASS storage failure still delivers within the session');

// 6. 重送太多次（對方一直不回 ack）→ 放棄，不無限重送
storageBroken = false;
store.set('aegis_file_pending', JSON.stringify([{ owner: 'A', peer: 'B', manifest: manifest('f1'), at: Date.now(), tries: 8 }]));
app = boot('A');
app.api.resumePendingChunks('B'); await tick();
assert.equal(app.sent.length, 0, 'no ninth attempt');
assert.equal(app.api.readParked().length, 0, 'dropped after the last try');
console.log('PASS gives up after 8 unacknowledged deliveries');

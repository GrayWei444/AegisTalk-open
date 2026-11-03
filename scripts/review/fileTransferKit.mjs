/**
 * 送檔測試的共用件：真的 fileTransfer.ts（每一份＝一個 App 頁面，各自的模組狀態、localStorage；IndexedDB 可以共用＝同一台重開），
 * 中間接一條模擬的 DataChannel。給 file_resume_new_channel_self_test、file_retry_self_test 用。
 *
 * 通道（makeNet）＝送端 A 看到的樣子：
 *   epoch     webrtc channelEpoch（每開一條新通道換號；沒開是 0）
 *   open      readyState 是 open（send 收不收）；connected＝isDataChannelOpen（ICE 斷線、殭屍時 false，但 send 照收）
 *   to        這條通道那頭的頁面；null＝那頭已經關了，送進去的都沒了、送出緩衝排不掉
 *   hold      ICE 斷了一下：送進去的先排著、緩衝變大；release() 恢復時照順序送到、緩衝清空（SCTP 重送）
 *   pace      每塊之間隔幾毫秒才送到（慢的網路；依序）
 *   wire      送過的東西：{ epoch, kind: manifest|chunk|offline-manifest, fileId, chunkIndex, at, tries }
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto, randomBytes } from 'node:crypto';
import { File, Blob } from 'node:buffer';

export const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const req = createRequire(ROOT + 'package.json');
const { transformSync } = req('esbuild');
const code = transformSync(readFileSync(ROOT + 'src/services/fileTransfer.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
export const CHUNK = 64 * 1024;          // fileTransfer.ts CHUNK_SIZE
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(cond, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (await cond()) return true;
  return !!(await cond());
}

const livePages = new Set();

/**
 * 一份 fileTransfer.ts＝一個 App 頁面。`speed`：時間壓縮（計時器跟 Date.now 一起；100 倍：60 秒等 ack＝0.6 秒）。
 * speed 1：≥30 秒的計時器（stall、early chunk TTL、等 ack）不跑。close()：頁面關了，計時器全停
 */
export function load(name, { speed = 1, idb = new Map() } = {}) {
  const module = { exports: {} };
  const ls = new Map();
  const logs = [];
  const timers = new Set();
  const win = {};
  const t0 = Date.now();
  const page = { name, ls, idb, logs, puts: 0, closed: false };
  let n = 0;
  const st = (f, ms = 0) => {
    if (page.closed || (speed === 1 && ms >= 30_000)) return 0;
    const h = setTimeout(() => { timers.delete(h); if (!page.closed) f(); }, Math.ceil(ms / speed));
    timers.add(h);
    return h;
  };
  runInNewContext(code, {
    module, exports: module.exports, crypto: webcrypto, Blob, atob, btoa, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    Promise, JSON, Math, Array, Set, Map, Number, String, window: win,
    Date: { now: () => t0 + (Date.now() - t0) * speed },
    console: { error: (...a) => logs.push(a.join(' ')), warn() {}, log() {} },
    setTimeout: st, clearTimeout: (h) => { if (h) { clearTimeout(h); timers.delete(h); } },
    localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: (k) => ls.delete(k) },
    require: (m) => ({
      'hash-wasm': req('hash-wasm'), '../utils/devLog': { devLog() {}, devWarn() {} }, '../utils/diagLog': { diagLog() {} },
      './fileBlobStore': { putBlob: async (id, b) => { page.puts++; idb.set(id, b); }, readBlob: async (id) => idb.get(id) ?? null },
      '../utils/secureId': { generateId: (p) => `${p}_${name}${(++n).toString().padStart(8, '0')}` },
    })[m],
  });
  page.api = module.exports;
  page.debug = () => win.__aegisDebug.fileTransfer();
  page.close = () => { page.closed = true; for (const h of timers) clearTimeout(h); timers.clear(); };
  livePages.add(page);
  return page;
}

export const header = (frame) => JSON.parse(Buffer.from(frame, 4, new DataView(frame).getUint32(0, true)).toString());
export const pending = (page) => JSON.parse(page.ls.get('aegis_file_pending') || '[]');
export const mkFile = (name, chunks) => new File([randomBytes(chunks * CHUNK - 123)], name, { type: 'application/octet-stream' });
export const manifestsOf = (net, fileId) => net.wire.filter((w) => w.kind === 'manifest' && (!fileId || w.fileId === fileId));
/** 某條通道上這個檔最先到的幾樣（例：'manifest,chunk0,chunk1'） */
export const firstOn = (net, epoch, fileId) => net.wire.filter((w) => w.epoch === epoch && w.fileId === fileId && w.kind !== 'offline-manifest')
  .slice(0, 4).map((w) => w.kind + (w.chunkIndex ?? '')).join(',');

export function makeNet() {
  const net = { epoch: 0, open: false, connected: false, buffered: 0, to: null, hold: false, held: [], pace: 0, wire: [],
    onChunk: null, onManifest: null, duringManifest: null };
  let paced = Promise.resolve();
  net.deliver = (fn) => {
    if (!net.pace) { setTimeout(fn, 0); return; }
    paced = paced.then(() => sleep(net.pace)).then(fn);
  };
  net.openTo = (page) => { net.epoch += 1; net.open = true; net.connected = true; net.buffered = 0; net.to = page; };
  net.release = () => { net.connected = true; net.hold = false; net.buffered = 0; for (const fn of net.held.splice(0)) net.deliver(fn); };
  return net;
}

/** 送端 A 接上通道。`ctl` 給 handleFileControl 的對象名稱固定 'B' */
export function wireSender(A, net) {
  A.api.initFileTransfer({
    owner: 'A',
    channelEpoch: () => (net.open ? net.epoch : 0),
    isConnectedTo: () => net.open && net.connected,
    getBufferedAmount: () => (net.open ? net.buffered : 0),
    connectPeer: async () => {},
    sendManifest: async (_p, m) => {
      const tries = pending(A).find((p) => p.manifest.fileId === m.fileId)?.tries ?? 0;
      if (!net.open || !net.connected) {   // 進了離線 outbox（這裡不模擬它之後補送到哪裡）
        net.wire.push({ epoch: net.epoch, kind: 'offline-manifest', fileId: m.fileId, at: Date.now(), tries });
        return;
      }
      net.wire.push({ epoch: net.epoch, kind: 'manifest', fileId: m.fileId, at: Date.now(), tries });
      const page = net.to, copy = JSON.parse(JSON.stringify(m));
      const fn = () => { if (page && !page.closed) void page.api.handleManifestPayload(copy, 'A'); };
      if (net.hold) net.held.push(fn); else if (page) net.deliver(fn);
      net.onManifest?.(m);
      await net.duringManifest?.(m);
    },
    sendChunk: (_p, frame) => {
      if (!net.open) return false;
      const { fileId, chunkIndex } = header(frame);
      net.wire.push({ epoch: net.epoch, kind: 'chunk', fileId, chunkIndex });
      const page = net.to, copy = frame.slice(0);
      const fn = () => { if (page && !page.closed) void page.api.handleChunkFrame(copy, 'A'); };
      if (net.hold || !page) net.buffered += frame.byteLength;    // ICE 斷著、或那頭已經關了：緩衝排不掉
      if (net.hold) net.held.push(fn); else if (page) net.deliver(fn);
      net.onChunk?.(chunkIndex, fileId);
      return true;
    },
  });
}

/** 收端 B 接上：ack／busy／fail 回給 A（dropCtl 回 true 的那幾個掉了）。回傳收到的檔、送出的控制訊息、收檔進度 */
export function wireReceiver(B, A, { dropCtl = () => false } = {}) {
  const got = [], ctl = [], progress = [];
  B.api.initFileTransfer({
    owner: 'B', getBufferedAmount: () => 0, isConnectedTo: () => true, connectPeer: async () => {},
    sendChunk: () => true, sendManifest: async () => {},
    sendControl: async (_p, c) => {
      if (B.closed) return;
      const copy = { kind: c.kind, fileId: c.fileId };
      ctl.push(copy);
      if (!dropCtl(copy) && A) setTimeout(() => A.api.handleFileControl('B', copy), 0);
    },
  });
  B.api.onFileReceived((rf) => { got.push({ name: rf.name, size: rf.size }); });
  B.api.onFileProgress((p) => { if (p.direction === 'receive') progress.push(p.status); });
  return { got, ctl, progress };
}

/** 每個情境各自跑、各自報（舊程式碼上一次看到每一個失敗；變異測試也看得出是哪一個抓到的）。跑完把留下的頁面都關掉 */
export async function runScenarios(list) {
  for (const [name, fn] of list) {
    try {
      await fn();
    } catch (err) {
      process.exitCode = 1;
      console.log(`FAIL ${name}: ${err.message}`);
    } finally {
      for (const page of livePages) page.close();
      livePages.clear();
    }
  }
}

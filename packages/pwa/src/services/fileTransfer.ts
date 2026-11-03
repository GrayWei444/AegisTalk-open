/**
 * File Transfer — 大檔分塊 + backpressure（push model）
 *
 * 協定（透過 WebRTC DataChannel）：
 *   1. Sender 計算 sha256 + 隨機產 fileKey (AES-256) + 切 chunks (64KB 一塊)
 *   2. Sender 發 file_manifest（走 Double Ratchet 加密的 JSON 訊息）
 *      包含 fileId, name, size, sha256, chunkSize, chunkCount, fileKey
 *   3. Sender 等對方 P2P 連線後逐塊送 binary chunk frame（ArrayBuffer）
 *      每塊用 fileKey AES-GCM 加密；header 含 fileId/chunkIndex/iv
 *   4. Sender 用 bufferedAmount 4MB/1MB 高低水位做 backpressure
 *   5. Receiver 收齊所有 chunks → 驗 sha256 → 組 Blob → 寫進 fileBlobStore
 *
 * Binary chunk frame format:
 *   [4 bytes uint32 LE: header length N]
 *   [N bytes UTF-8 JSON: {fileId, chunkIndex, iv}]
 *   [後續 bytes: AES-256-GCM ciphertext]
 *
 * 對應 LEARNINGS_FROM_AEGISTRANS.md §1
 */

import { createSHA256, type IHasher } from 'hash-wasm';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { putBlob, readBlob } from './fileBlobStore';
import { generateId } from '../utils/secureId';

const PROTOCOL_VERSION = 1;
const CHUNK_SIZE = 64 * 1024;                  // 64 KB（多數瀏覽器 DC max msg ~256KB，留 header overhead）
const MAX_FILE_SIZE = 500 * 1024 * 1024;       // 500 MB hard cap
/**
 * 收端對 manifest／chunk 的上限（對應群星 2026-09-06）。送端本來就用 CHUNK_SIZE 切，這兩個只是「對端可能亂送」的
 * 天花板：正常流量碰不到，但擋得住 `chunkCount: 2**31` 這種讓收端 OOM 的 manifest。
 */
const MAX_CHUNK_SIZE = 1024 * 1024;            // 1 MB（送端固定 64KB）
const MAX_CHUNK_COUNT = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 1; // 正常上限約 8000 塊
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;     // 4 MB
const BACKPRESSURE_LOW = 1 * 1024 * 1024;      // 1 MB
/** 背壓最多等多久：有在排（慢）就再推；這段時間一點都沒排出去＝卡住了，這一輪算失敗 */
const BACKPRESSURE_MAX_WAIT_MS = 30_000;
/**
 * App 說通道不能用了（isDataChannelOpen false：ICE 斷線、殭屍）要連續多久才停下這一輪。ICE 斷一下常常自己恢復（同一條通道、
 * 送出緩衝裡的東西照樣送到）—— 那時停下來就得從第一塊重推。通道真的沒了（換號、拆掉）不等，當場停（見 SendRound）
 */
const DISCONNECT_GRACE_MS = 10_000;
const PEER_CONNECT_WAIT_MS = 15_000;           // 等對方 P2P 連線最多 15s
// 接收端 stall watchdog：超過此秒數沒收到新 chunk → 判定中斷（DataChannel 斷/peer 離線），
// 清掉 receiver state（避免半套傳輸的 chunk Blob 永久留在 Map）+ 標 failed（§教訓2 不可靜默卡 transferring）。
// 給寬一點避開 sender 端 backpressure（最長等 30s）+ 慢網偶發停頓造成的誤判。
const RECEIVE_STALL_MS = 60_000;

// ============================================================
// Types
// ============================================================

/** Manifest payload — 走 Double Ratchet 加密通道送出（type='file_manifest'）。 */
export interface FileManifestPayload {
  v: number;
  messageId: string;          // 雙方共用的 message id（與 chatStore 對齊）
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  fileKey: string;            // base64 AES-256 ephemeral key
  caption?: string;
  timestamp: number;
  /** 群組檔案標記（ADR-016 視圖群組）：有值時接收端存成群組訊息而非 1-1 訊息 */
  groupIds?: string[];
}

export interface FileProgress {
  fileId: string;
  direction: 'send' | 'receive';
  bytesDone: number;
  bytesTotal: number;
  status: 'transferring' | 'complete' | 'failed';
}

export interface ReceivedFile {
  messageId: string;
  fileId: string;
  fromPubkey: string;
  name: string;
  mimeType: string;
  size: number;
  caption?: string;
  timestamp: number;
  groupIds?: string[];
}

interface ReceiverState {
  manifest: FileManifestPayload;
  fromPubkey: string;
  /** 每塊 plaintext 包成獨立 Blob ref（瀏覽器可 disk-spill，不像大 Uint8Array 一定占 heap）。 */
  chunkBlobs: (Blob | undefined)[];
  receivedCount: number;
  bytesReceived: number;
  fileKeyImported: CryptoKey;
  /** 增量 SHA-256（hash-wasm）：chunks 順序消化，避免 finalize 時一次 load 全檔 OOM。 */
  hasher: IHasher | null;
  /** 已 hash 到第幾塊（連續，from 0；遇到 hole 暫停）。 */
  hashedUpTo: number;
  /** Hash 鏈：序列化 hasher.update，避免亂序 chunk 雙重 hash。 */
  hashChain: Promise<void>;
  /** Stall watchdog：每收一塊 reset；超過 RECEIVE_STALL_MS 沒新塊 → 判定中斷、標 failed + 清 state。 */
  stallTimer: ReturnType<typeof setTimeout> | null;
}

// ============================================================
// Module state
// ============================================================

type SendChunkFn = (peerPubkey: string, frame: ArrayBuffer) => boolean;
type SendManifestFn = (peerPubkey: string, payload: FileManifestPayload) => Promise<void>;
type GetBufferedAmountFn = (peerPubkey: string) => number;
type IsConnectedToFn = (peerPubkey: string) => boolean;
type ConnectPeerFn = (peerPubkey: string) => Promise<void>;
/** 目前送訊用的那條 DataChannel 的編號（webrtc channelEpoch；沒有通道回 0） */
type ChannelEpochFn = (peerPubkey: string) => number;

let _sendChunk: SendChunkFn | null = null;
let _sendManifest: SendManifestFn | null = null;
let _getBufferedAmount: GetBufferedAmountFn | null = null;
let _isConnectedTo: IsConnectedToFn | null = null;
let _connectPeer: ConnectPeerFn | null = null;
let _channelEpoch: ChannelEpochFn | null = null;

const receiverStates = new Map<string, ReceiverState>();
const progressListeners = new Set<(p: FileProgress) => void>();
const fileReceivedListeners = new Set<(rf: ReceivedFile) => void | Promise<void>>();
/** 收完檔交給 AppProvider 存的那段工作（shutdown 時等它做完） */
const fileReceivedTasks = new Set<Promise<void>>();

/**
 * Early-chunk buffer：chunks 比 manifest 先到時暫存，manifest 到達後 replay。
 * 原因：manifest 走 Double Ratchet 解密慢（~50-100ms），sender push chunks
 * 不等對方 ack 直接連發，前幾十個 chunks 必然先到 binary path。
 *
 * Map<fileId, ArrayBuffer[]> 自動 30s TTL（沒對到 manifest 就放掉，避免 leak）。
 * 有上限（對應群星 B39）：最多 8 個檔、每個對象 2 個、每個檔 64 塊、合計 8MB —— 不然連得上的人灌一堆假 fileId，
 * 記憶體一直長，好友真正的檔案也排不進來。同時在收的檔最多 4 個，多的回 busy（B32）。
 */
const earlyChunkBuffer = new Map<string, {
  frames: ArrayBuffer[];
  bytes: number;
  fromPubkey: string;
  ttlTimer: ReturnType<typeof setTimeout>;
}>();
const EARLY_CHUNK_BUFFER_TTL_MS = 30_000;
const MAX_EARLY_FILES = 8;
const MAX_EARLY_FILES_PER_PEER = 2;
const MAX_EARLY_FRAMES_PER_FILE = 64;
const MAX_EARLY_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_RECEIVERS = 4;
let earlyChunkBytes = 0;

function deleteEarlyChunks(fileId: string): void {
  const entry = earlyChunkBuffer.get(fileId);
  if (!entry) return;
  clearTimeout(entry.ttlTimer);
  earlyChunkBytes = Math.max(0, earlyChunkBytes - entry.bytes);
  earlyChunkBuffer.delete(fileId);
}

/**
 * Manifest 走 Double Ratchet 加密、fire-and-forget 直送 DataChannel。若送出當下雙方 ratchet 分裂
 * （對方剛在別台恢復/重加 → session repair 尚未收斂），DataChannel「送達」但對方解不開（aead）→
 * manifest 永久遺失、檔案收不到（chunks 走 fileKey 不受影響，會進 earlyChunkBuffer 等 30s）。
 * 修：sender 端記住近 30s 送出的 manifest，peer 每次 (重)連上（session repair 後必重連）就重送一次。
 * 重送用當下（已修好的）ratchet 加密；receiver 靠 fileId dedup（active + 近期完成），冪等安全。
 * 這讓 manifest 得到與文字 outbox 相同的「重連即自癒」韌性（見 p2pSend flushQueueForPeer）。
 */
const recentManifests = new Map<string, Array<{ payload: FileManifestPayload; at: number }>>();
const RECENT_MANIFEST_TTL_MS = 30_000;
// 近期已完成接收的 fileId（bounded）→ 重送的 manifest 不再建新 receiver（避免完成後又空等 chunk → 假 failed）。
const completedRecvFileIds = new Set<string>();
const COMPLETED_RECV_MAX = 200;
// 近期收齊了但 sha256 對不上的 fileId（bounded）：送端重送的 manifest 再回一次 fail（不能當成收好了回 ack）
const failedRecvFileIds = new Set<string>();
function rememberBounded(set: Set<string>, fileId: string): void {
  set.add(fileId);
  if (set.size > COMPLETED_RECV_MAX) set.delete(set.values().next().value as string);
}

let _debugChunksSent = 0;
let _debugChunksReceived = 0;
let _debugChunksDecodeFailed = 0;
let _debugChunksWithoutManifest = 0;

// Debug 給 e2e
if (typeof window !== 'undefined') {
  // @ts-expect-error - 偷塞給 window
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error
  window.__aegisDebug.fileTransfer = () => ({
    initialized: !!_sendChunk,
    chunksSent: _debugChunksSent,
    chunksReceived: _debugChunksReceived,
    chunksDecodeFailed: _debugChunksDecodeFailed,
    chunksWithoutManifest: _debugChunksWithoutManifest,
    activeReceivers: Array.from(receiverStates.entries()).map(([fileId, st]) => ({
      fileId: fileId.slice(0, 8),
      name: st.manifest.name,
      receivedCount: st.receivedCount,
      total: st.manifest.chunkCount,
    })),
  });
}

/** §14.5（LEARNINGS）：登入後同步窗口 gate — callbacks 註冊完才算可送檔。 */
export function isFileTransferReady(): boolean {
  return !!_sendChunk && !!_sendManifest;
}

/**
 * 收端回給送端的控制訊息（對應群星 B32）：
 *   ack  —— 這個檔我已經完整收好（或本來就有）→ 送端才從待送清單移除
 *   busy —— 我同時在收的檔太多，等一下再送 → 送端稍後重送
 *   fail —— 收齊了但 sha256 對不上、或我不支援這個 manifest 版本：再送也一樣 → 送端不再重送、標失敗
 * 以前沒有這個：送端「推完 chunks」就當送到，收端同時太多就丟掉，那張照片就永遠不見。
 * 舊版送端不認得 fail（只認 ack／busy），收到就忽略、照舊重送到次數用完。
 */
export type FileControlPayload = { kind: 'ack' | 'busy' | 'fail'; fileId: string };
type SendControlFn = (peer: string, payload: FileControlPayload) => Promise<void>;
let _sendControl: SendControlFn | null = null;
function sendCtl(peer: string, kind: FileControlPayload['kind'], fileId: string): void {
  void _sendControl?.(peer, { kind, fileId }).catch(() => { /* 送不出去：對方下次重送時會再問一次 */ });
}

export function initFileTransfer(opts: {
  sendChunk: SendChunkFn;
  sendManifest: SendManifestFn;
  getBufferedAmount: GetBufferedAmountFn;
  isConnectedTo: IsConnectedToFn;
  connectPeer: ConnectPeerFn;
  /** 本機帳號公鑰：掛起的送檔清單綁它（換帳號不會拿別人的檔去送） */
  owner: string;
  /** 收端回 ack／busy 給送端（見 FileControlPayload） */
  sendControl?: SendControlFn;
  /** 目前那條 DataChannel 的編號：一輪送檔綁在一條通道上，換了就從 manifest 重來（見 SendRound）。沒給＝當成一直同一條 */
  channelEpoch?: ChannelEpochFn;
}): void {
  _owner = opts.owner;
  _sendControl = opts.sendControl ?? null;
  _sendChunk = opts.sendChunk;
  _sendManifest = opts.sendManifest;
  _getBufferedAmount = opts.getBufferedAmount;
  _isConnectedTo = opts.isConnectedTo;
  _connectPeer = opts.connectPeer;
  _channelEpoch = opts.channelEpoch ?? null;
  devLog('[fileTransfer] initialized');
  // 重開 App 時對方可能早就連著（onPeerConnected 在 init 之前就發過了）→ 這裡補一次
  for (const peer of new Set(readParked().filter((p) => p.owner === _owner).map((p) => p.peer))) {
    if (opts.isConnectedTo(peer)) resumePendingChunks(peer);
  }
}

/** 每次 shutdown 加一：還在跑的送檔／收檔（await 回來之後）看到世代變了就停手，不碰下一個 session 的東西 */
let transferGeneration = 0;

export function fileTransferSession(): number { return transferGeneration; }

export async function shutdownFileTransfer(): Promise<void> {
  transferGeneration += 1;
  _owner = '';  // 掛起清單留在 localStorage（同帳號下次登入接著送），只是這個 session 不再動它
  _sendControl = null;
  peerChains.clear();
  for (const round of [...resuming.values()]) abortRound(round);   // 還在跑的那幾輪：停手（等 ack 的叫醒）
  resuming.clear();
  for (const waiters of [...ackWaiters.values()]) for (const done of [...waiters]) done('aborted');
  ackWaiters.clear();
  clearRetries();
  _sendChunk = null;
  _sendManifest = null;
  _getBufferedAmount = null;
  _isConnectedTo = null;
  _connectPeer = null;
  _channelEpoch = null;
  for (const st of receiverStates.values()) clearStallTimer(st);  // 清掉 stall watchdog timer
  receiverStates.clear();
  for (const entry of earlyChunkBuffer.values()) clearTimeout(entry.ttlTimer);
  earlyChunkBuffer.clear();
  earlyChunkBytes = 0;
  recentManifests.clear();
  completedRecvFileIds.clear();
  failedRecvFileIds.clear();
  progressListeners.clear();
  fileReceivedListeners.clear();
  await Promise.all([...fileReceivedTasks]);
}

/** 記錄剛送出的 manifest（供 peer 重連後重送）。順手 prune 過期項。 */
function recordRecentManifest(peerPubkey: string, payload: FileManifestPayload): void {
  const now = Date.now();
  const list = (recentManifests.get(peerPubkey) ?? []).filter((m) => now - m.at < RECENT_MANIFEST_TTL_MS);
  list.push({ payload, at: now });
  recentManifests.set(peerPubkey, list);
}

/**
 * 還沒把 chunks 全部推完、收端還沒 ack 的送檔（對應群星 Codex review 2026-09-27 #16）。
 * 以前只放記憶體 —— 對方離線時送檔、15 秒內沒連上就永遠不送（AegisTalk 稽核 H12）；App 被殺／重新整理也一樣，
 * manifest 靠持久化 outbox 照樣送到，chunks 卻永遠不來，對方卡在 0%。現在送出當下就把 manifest 記進 localStorage
 * （blob 本來就在 IDB），收端 ack 才刪；peer 連上（或重開 App 時已連著）就先重送 manifest 再補 chunks
 * （對方可能已因 60 秒沒進度把這個檔丟了；收端對進行中／已收完的 fileId 會略過重複的 manifest）。
 * manifest 裡的金鑰跟 IDB 裡的明文 blob 同一台裝置、同一個保護層級，沒有多暴露什麼。
 */
const PARKED_LS = 'aegis_file_pending';
const PARKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 跟持久化 outbox（p2pSend 30 天）一樣：manifest 還送得到，chunks 就要補得到
/** tries：幾輪「送到了卻沒 ack／送不出去」（換通道、斷線被打斷的不算），到 MAX_DELIVERY_TRIES 放棄 */
type ParkedSend = { owner: string; peer: string; manifest: FileManifestPayload; at: number; tries?: number };
let _owner = '';
/**
 * 正在送（或在佇列裡等著送）的那一輪，key＝`${generation}|${peer}|${fileId}`：同一個檔同一時間只有一輪 ——
 * 對方連上時的補送跳過還有效的那一輪，不重推一份（綁在別條通道上的那一輪例外，見 SendRound）。
 */
const resuming = new Map<string, SendRound>();
/** localStorage 寫不進去（額度、隱私模式）時退回這個 session 的記憶體清單 */
let memoryParked: ParkedSend[] | null = null;

function readParked(): ParkedSend[] {
  const now = Date.now();
  const fresh = (list: unknown): ParkedSend[] => (Array.isArray(list) ? list : []).filter((p: ParkedSend) =>
    p && typeof p.owner === 'string' && p.owner && typeof p.peer === 'string' && typeof p.manifest?.fileId === 'string'
    && typeof p.manifest.fileKey === 'string' && now - p.at < PARKED_TTL_MS);
  if (memoryParked) return fresh(memoryParked);
  try { return fresh(JSON.parse(localStorage.getItem(PARKED_LS) || '[]')); } catch { return []; }
}

function writeParked(list: ParkedSend[]): void {
  if (!memoryParked) {
    try {
      if (list.length) localStorage.setItem(PARKED_LS, JSON.stringify(list));
      else localStorage.removeItem(PARKED_LS);
      return;
    } catch { /* 往下退回記憶體 */ }
  }
  memoryParked = list;
}

const sameSend = (p: ParkedSend, owner: string, peer: string, fileId: string) =>
  p.owner === owner && p.peer === peer && p.manifest.fileId === fileId;

function park(owner: string, peer: string, manifest: FileManifestPayload): void {
  if (!owner) return;
  writeParked([...readParked().filter((p) => !sameSend(p, owner, peer, manifest.fileId)), { owner, peer, manifest, at: Date.now() }]);
}

function unpark(owner: string, peer: string, fileId: string): void {
  writeParked(readParked().filter((p) => !sameSend(p, owner, peer, fileId)));
}

/**
 * 同一個檔最多幾輪「送到了卻沒 ack（逾時）／送不出去」；到了就放棄、標失敗。換了通道、通道斷了而被打斷的那幾輪不算 ——
 * 對方重開 App、重連不該吃掉重送次數（跟著待送清單存著：tries）。
 */
const MAX_DELIVERY_TRIES = 8;
/** 推完 chunks 之後等 ack 多久。等到了或逾時，同一個 peer 的下一個檔才開始（逾時的稍後重試，見 afterRound） */
const ACK_WAIT_MS = 60_000;
/** 補送時先等收端回 ack 多久（它可能早就收好了、只是 ack 在路上掉了）才推 chunks */
const RESEND_ACK_PEEK_MS = 1_500;
/** 沒等到 ack 就結束的那一輪多久之後再試：5 秒起、每次加倍、最多 5 分鐘 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** 發現通道換了而自己停下的那一輪：新通道的補送通常已經接手，這只是保險 */
const STALE_RETRY_MS = 1_000;
/** 收端說忙（同時在收的檔太多） */
const BUSY_RETRY_MS = 15_000;
/** 同一條連線（channelEpoch）上最多幾次定時重試；還是不行就等下次連上（新通道的補送會全部重來） */
const MAX_TIMED_RETRIES_PER_CHANNEL = 3;
/** 該重試了卻沒連著：隔多久再看一次（殭屍通道自己恢復時不會有 open 事件，不能只等 onPeerConnected） */
const OFFLINE_RECHECK_MS = 30_000;

/**
 * 同一個 peer 的送檔**一個接一個**（manifest＋chunks＋等 ack）（對應群星 B32）：收端同時最多收 4 個，manifest 一到就開
 * 60 秒 stall 計時 —— 一口氣送 5 個 manifest 的話，排在後面的會在 chunks 到之前就逾時，第 5 個直接被拒。
 */
const peerChains = new Map<string, Promise<void>>();
function enqueuePeer(peer: string, job: () => Promise<void>): void {
  const run = (peerChains.get(peer) ?? Promise.resolve()).catch(() => {}).then(job);
  peerChains.set(peer, run);
  void run.finally(() => { if (peerChains.get(peer) === run) peerChains.delete(peer); }).catch(() => {});
}

/**
 * 一輪送檔（manifest → chunks → 等 ack）綁在一條 DataChannel 上（2026-10-23 四機模擬 D1 在 bdd03df 重現兩次）。
 * 對方傳到一半關 App、幾秒後重開，舊的這一輪還在跑（還在推 chunks，或推完在等 60 秒 ack）時，以前：
 *   1. 新通道 open 時的補送因為這一輪還佔著位子，就跳過這個檔；
 *   2. 這一輪接著把剩下的 chunks 推進**新**通道 —— 對方新開的頁面沒收過 manifest（送進了關掉的舊頁面），30 秒後丟掉；
 *   3. 等 ack 逾時只說「下次連上再送」，但新通道一直開著、沒有下次 → 永遠卡在待送清單、重送 0 次。
 * 現在：`channel` 記這一輪的 manifest 走的是哪一條通道（webrtc channelEpoch，每開一條新通道換號；不確定就是 null）。
 *   推第一塊之前 manifest 不在目前這條通道上，就在這條上再送一次；之後每塊送出前同步確認還是同一條，不是就整輪作廢 ——
 *   舊一輪的 chunks 絕不進新通道。新通道 open 時的補送把綁在別條通道上的那一輪當場作廢、讓出位子，從 manifest 重來
 *   （收端靠 fileId／chunk 編號去重，照樣驗每一塊與 sha256）。沒等到 ack 就結束的稍後重試（afterRound），不再只等重連。
 */
interface SendRound {
  readonly tag: string;
  readonly peer: string;
  /** manifest 走的那條通道（channelEpoch）；null＝還沒送、進了離線 outbox，或送的期間通道換了（不知道進了哪一條） */
  channel: number | null;
  aborted: boolean;
  /** 作廢或結束時叫醒還在等的（等 ack） */
  readonly wake: Set<() => void>;
}

/** 一輪怎麼結束的：acked／busy／gone（收端說 fail、本機檔已經沒了）不必再排；其餘都沒等到 ack，稍後重試（afterRound） */
type RoundEnd = 'acked' | 'busy' | 'gone' | 'timeout' | 'stale' | 'offline' | 'down' | 'failed';
/**
 * chunks 推得怎樣：pushed＝推完而且緩衝排空；stale＝這一輪作廢、session 換了或通道換了；
 * down＝通道連續 DISCONNECT_GRACE_MS 不能用；failed＝送不出去、背壓等不動或排不空
 */
type PushResult = 'pushed' | 'stale' | 'down' | 'failed';

function currentChannel(peer: string): number {
  try { return _channelEpoch?.(peer) ?? 0; } catch { return 0; }
}

/** 作廢一輪：讓出位子（補送才能從 manifest 重來）、叫醒它在等的 ack。還在跑的那段看到 aborted 就停手 */
function abortRound(round: SendRound): void {
  if (round.aborted) return;
  round.aborted = true;
  if (resuming.get(round.tag) === round) resuming.delete(round.tag);
  for (const wake of [...round.wake]) wake();
}

type AckOutcome = 'ack' | 'busy' | 'fail' | 'timeout' | 'aborted';
const ackWaiters = new Map<string, Set<(outcome: AckOutcome) => void>>();

/** 等收端對這個檔回 ack／busy／fail（handleFileControl）；逾時、這一輪作廢或結束也會回來 */
function waitAck(round: SendRound, fileId: string, ms: number): Promise<AckOutcome> {
  const key = `${round.peer}|${fileId}`;
  return new Promise((resolve) => {
    const waiters = ackWaiters.get(key) ?? new Set<(outcome: AckOutcome) => void>();
    ackWaiters.set(key, waiters);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (outcome: AckOutcome): void => {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(done);
      if (waiters.size === 0 && ackWaiters.get(key) === waiters) ackWaiters.delete(key);
      round.wake.delete(wake);
      resolve(outcome);
    };
    const wake = (): void => done('aborted');
    waiters.add(done);
    round.wake.add(wake);
    if (round.aborted) { done('aborted'); return; }
    timer = setTimeout(() => done('timeout'), ms);
  });
}

function settleAckWaiters(peer: string, fileId: string, outcome: AckOutcome): void {
  for (const done of [...(ackWaiters.get(`${peer}|${fileId}`) ?? [])]) done(outcome);
}

/** 不送了（收端說 fail、或次數用完）：移出待送清單、取消排好的重試、標失敗 */
function dropSend(owner: string, peer: string, manifest: FileManifestPayload, why: string): void {
  console.error(`[fileTransfer] giving up on ${manifest.fileId.slice(0, 8)} to ${peer.slice(0, 8)}: ${why}`);
  unpark(owner, peer, manifest.fileId);
  retryPlans.delete(planKey(peer, manifest.fileId));
  notifyProgress({ fileId: manifest.fileId, direction: 'send', bytesDone: 0, bytesTotal: manifest.size, status: 'failed' });
}

/** AppProvider 收到對方的 file_ctl 時呼叫。只認「這個檔本來就是送給他的」 */
export function handleFileControl(fromPubkey: string, payload: FileControlPayload): void {
  if (!payload || typeof payload.fileId !== 'string'
      || (payload.kind !== 'ack' && payload.kind !== 'busy' && payload.kind !== 'fail')) return;
  const owner = _owner;
  const entry = readParked().find((p) => sameSend(p, owner, fromPubkey, payload.fileId));
  if (payload.kind === 'ack') {
    if (entry) {
      unpark(owner, fromPubkey, payload.fileId);
      retryPlans.delete(planKey(fromPubkey, payload.fileId));
    }
    settleAckWaiters(fromPubkey, payload.fileId, 'ack');
    return;
  }
  if (payload.kind === 'fail') {
    // 收端收齊了但 sha256 對不上（或不支援這個版本）：再送也一樣 → 不再重送、標失敗
    if (entry) dropSend(owner, fromPubkey, entry.manifest, 'the receiver rejected it (sha256 / version)');
    settleAckWaiters(fromPubkey, payload.fileId, 'fail');
    return;
  }
  // busy：這一輪先放下（讓佇列往下走），15 秒後再補（不算失敗、不算進每條連線的定時重試上限）
  settleAckWaiters(fromPubkey, payload.fileId, 'busy');
  if (entry) planRetry(fromPubkey, payload.fileId, BUSY_RETRY_MS, false);
}

/**
 * 每個檔自己的下一次重試時間（這個 session；key `${peer}|${fileId}`）。每個 peer 一個計時器，排在最早到期的那個；
 * 時間到只重試到期的檔（剛排了 5 分鐘退避的檔不會被別的檔提早拉起來）。counted：算進每條連線的定時重試上限（busy 不算）
 */
const retryPlans = new Map<string, { at: number; counted: boolean }>();
const retryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>();
/** 每個 peer 在目前這條連線（channelEpoch）上已經做了幾次定時重試 */
const timedRetries = new Map<string, { channel: number; count: number }>();
const planKey = (peer: string, fileId: string): string => `${peer}|${fileId}`;
const plansOf = (peer: string): Array<[string, { at: number; counted: boolean }]> =>
  [...retryPlans].filter(([key]) => key.startsWith(`${peer}|`));

function planRetry(peer: string, fileId: string, delayMs: number, counted: boolean): void {
  retryPlans.set(planKey(peer, fileId), { at: Date.now() + delayMs, counted });
  armRetryTimer(peer);
}

function armRetryTimer(peer: string): void {
  const plans = plansOf(peer);
  const due = plans.length ? Math.min(...plans.map(([, plan]) => plan.at)) : Infinity;
  const armed = retryTimers.get(peer);
  if (armed?.due === due) return;
  if (armed) { clearTimeout(armed.timer); retryTimers.delete(peer); }
  if (due === Infinity) return;
  const generation = transferGeneration;
  const timer = setTimeout(() => {
    if (retryTimers.get(peer)?.timer === timer) retryTimers.delete(peer);
    if (generation === transferGeneration) runDueRetries(peer);
  }, Math.max(0, due - Date.now()));
  retryTimers.set(peer, { timer, due });
}

/** 計時器到了：沒連著就晚一點再看；連著就重試到期的檔，但同一條連線上最多 MAX_TIMED_RETRIES_PER_CHANNEL 次 */
function runDueRetries(peer: string): void {
  const now = Date.now();
  const due = plansOf(peer).filter(([, plan]) => plan.at <= now);
  if (due.length > 0 && !_isConnectedTo?.(peer)) {
    for (const [key, plan] of due) retryPlans.set(key, { ...plan, at: now + OFFLINE_RECHECK_MS });
  } else if (due.length > 0) {
    const channel = currentChannel(peer);
    const used = timedRetries.get(peer);
    const count = used && used.channel === channel ? used.count : 0;
    const allowCounted = count < MAX_TIMED_RETRIES_PER_CHANNEL;
    const fileIds = new Set<string>();
    for (const [key, plan] of due) {
      retryPlans.delete(key);
      if (!plan.counted || allowCounted) fileIds.add(key.slice(peer.length + 1));
    }
    if (due.some(([, plan]) => plan.counted)) {
      if (allowCounted) timedRetries.set(peer, { channel, count: count + 1 });
      else console.error(`[fileTransfer] ${MAX_TIMED_RETRIES_PER_CHANNEL} timed retries to ${peer.slice(0, 8)} on this connection — the rest waits for the next connect`);
    }
    if (fileIds.size > 0) resumeFiles(peer, fileIds);
  }
  armRetryTimer(peer);
}

function clearRetries(): void {
  for (const { timer } of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  retryPlans.clear();
  timedRetries.clear();
}

/** 第 n 次失敗之後等多久再試：5 秒、10 秒、20 秒…最多 5 分鐘 */
const retryDelay = (n: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, n - 1));

/**
 * 一輪沒等到 ack 就結束：還在待送清單上、也沒有新的一輪接手 → 稍後重試。以前只等「下次連上」—— 通道一直開著
 * （ack 掉了、或收端重開時舊的一輪把 chunks 推進了新通道）就永遠沒有下次。
 * 只有逾時（送到了卻沒 ack）與送不出去算一次失敗（tries），到 MAX_DELIVERY_TRIES 就放棄。
 */
function afterRound(round: SendRound, owner: string, fileId: string, generation: number, end: RoundEnd): void {
  if (end === 'acked' || end === 'busy' || end === 'gone' || generation !== transferGeneration) return;
  if (resuming.has(round.tag)) return;                          // 新通道的補送已經接手
  const entry = readParked().find((p) => sameSend(p, owner, round.peer, fileId));
  if (!entry) return;                                           // 已經 ack、放棄，或換了帳號
  const charged = end === 'timeout' || end === 'failed';
  const tries = (entry.tries ?? 0) + (charged ? 1 : 0);
  if (charged && tries >= MAX_DELIVERY_TRIES) {
    dropSend(owner, round.peer, entry.manifest, `${tries} deliveries without an ack`);
    return;
  }
  if (charged) writeParked(readParked().map((q) => sameSend(q, owner, round.peer, fileId) ? { ...q, tries } : q));
  const delay = end === 'stale' ? STALE_RETRY_MS : retryDelay(Math.max(1, tries));
  console.error(`[fileTransfer] ${fileId.slice(0, 8)} to ${round.peer.slice(0, 8)} ended ${end} (${tries} failed) — retry in ${delay / 1000}s`);
  planRetry(round.peer, fileId, delay, true);
}

/**
 * 排一輪送檔進這個 peer 的佇列、佔住位子。`load` 拿檔案與金鑰（補送時從 IndexedDB 讀；確定沒有回 null → 從待送清單移除）。
 */
function startRound(
  owner: string, peer: string, manifest: FileManifestPayload, generation: number, resend: boolean,
  load: () => Promise<{ file: Blob; key: CryptoKey } | null>,
  onError: (err: unknown) => void,
): void {
  const round: SendRound = { tag: `${generation}|${peer}|${manifest.fileId}`, peer, channel: null, aborted: false, wake: new Set() };
  resuming.set(round.tag, round);
  retryPlans.delete(planKey(peer, manifest.fileId));            // 現在就送：排好的重試作廢
  enqueuePeer(peer, async () => {
    const end = await (async (): Promise<RoundEnd> => {
      if (round.aborted || generation !== transferGeneration) return 'stale';
      const source = await load();
      if (!source) { unpark(owner, peer, manifest.fileId); return 'gone'; }
      return deliver(round, manifest, source.file, source.key, generation, resend);
    })().catch((err): RoundEnd => { onError(err); return 'failed'; });
    for (const wake of [...round.wake]) wake();                 // 推到一半就停的：還掛著的 ack 等待收掉
    if (resuming.get(round.tag) === round) resuming.delete(round.tag);
    afterRound(round, owner, manifest.fileId, generation, end);
  });
}

/**
 * 送 manifest，回它走的那條通道：送之前、送之後都連著而且是同一條才算數；否則 null（進了離線 outbox，
 * 或送的期間通道換了 —— 不知道進了哪一條）。
 */
async function sendManifestOnChannel(
  peer: string, manifest: FileManifestPayload, sendManifest: SendManifestFn, isConnected: IsConnectedToFn,
): Promise<number | null> {
  const before = isConnected(peer) ? currentChannel(peer) : null;
  await sendManifest(peer, manifest);
  const after = isConnected(peer) ? currentChannel(peer) : null;
  return before !== null && before === after ? after : null;
}

/**
 * 送一個檔給一個 peer：manifest → 等連線 → chunks → 等 ack。全部在該 peer 的佇列裡跑。
 * `resend`（補送）：先給收端 1.5 秒回 ack —— 它可能早就收好了（ack 在路上掉了），就不必再推一次 chunks。
 */
async function deliver(
  round: SendRound, manifest: FileManifestPayload, file: Blob, key: CryptoKey, generation: number, resend: boolean,
): Promise<RoundEnd> {
  const { peer } = round;
  const sendManifest = _sendManifest, isConnected = _isConnectedTo, connectPeer = _connectPeer;
  const over = (): boolean => round.aborted || generation !== transferGeneration;
  if (over() || !sendManifest || !isConnected || !connectPeer) return 'stale';
  const early = resend ? waitAck(round, manifest.fileId, RESEND_ACK_PEEK_MS) : null;
  round.channel = await sendManifestOnChannel(peer, manifest, sendManifest, isConnected);
  if (over()) return 'stale';
  recordRecentManifest(peer, manifest);
  diagLog(`[DIAG:FILE:SEND] manifest sent: ${manifest.fileId.slice(0, 8)} (${manifest.size}B, ${manifest.chunkCount} chunks) to ${peer.slice(0, 16)}`);
  let waited = 0;
  while (!isConnected(peer) && waited < PEER_CONNECT_WAIT_MS) {
    if (waited === 0) void connectPeer(peer).catch(() => { /* will retry via wait */ });
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
    if (over()) return 'stale';
  }
  if (!isConnected(peer)) {
    // 掛著（清單在 localStorage），onPeerConnected → resumePendingChunks 補
    console.error(`[fileTransfer] peer ${peer.slice(0, 8)} not connected after ${PEER_CONNECT_WAIT_MS}ms — chunks parked until reconnect`);
    return 'offline';
  }
  if (early) {
    const peek = await early;
    if (peek === 'ack') return 'acked';                         // 收端早就有了，handleFileControl 已移除
    if (peek === 'busy') return 'busy';
    if (peek === 'fail') return 'gone';
    if (over()) return 'stale';
  }
  if (round.channel !== currentChannel(peer)) {
    // manifest 不在目前這條通道上（送的時候沒連著而進了離線 outbox —— 那份可能補送到別條通道、或排在 chunks 後面；
    //   或送出之後通道換了）：在這條上再送一次再推 chunks（收端對同一個 fileId 的 manifest 去重）
    round.channel = await sendManifestOnChannel(peer, manifest, sendManifest, isConnected);
    if (over()) return 'stale';
    if (round.channel === null || round.channel !== currentChannel(peer)) return 'stale';
  }
  const acked = waitAck(round, manifest.fileId, ACK_WAIT_MS);
  const pushed = await sendChunksToPeer(peer, file, manifest.fileId, manifest.chunkCount, key, generation, round);
  if (pushed !== 'pushed') return pushed;                       // 還掛著的 ack 等待由 startRound 收掉
  const outcome = await acked;
  if (outcome === 'ack') return 'acked';
  if (outcome === 'busy') return 'busy';
  if (outcome === 'fail') return 'gone';
  if (outcome === 'aborted') return 'stale';
  console.error(`[fileTransfer] no ack for ${manifest.fileId.slice(0, 8)} from ${peer.slice(0, 8)} in ${ACK_WAIT_MS / 1000}s`);
  return 'timeout';
}

/**
 * 補送 peer 的待送檔（only：只補這幾個 fileId，重試計時器用；null＝全部）。沒連著就什麼都不做 —— 不作廢、不開新的一輪，
 * 連上時（onPeerConnected）會再叫一次。綁在別條通道上的那一輪（對方重開 App、重連）當場作廢、從新通道重來（見 SendRound）；
 * 還有效的那一輪不重推一份。
 */
function resumeFiles(peerPubkey: string, only: Set<string> | null): void {
  const owner = _owner;
  const generation = transferGeneration;
  if (!owner || !_isConnectedTo?.(peerPubkey)) return;
  const tagOf = (p: ParkedSend) => `${generation}|${p.peer}|${p.manifest.fileId}`;
  const mine = readParked().filter((p) => p.owner === owner && p.peer === peerPubkey && (!only || only.has(p.manifest.fileId)));
  const channel = currentChannel(peerPubkey);
  for (const p of mine) {
    const round = resuming.get(tagOf(p));
    if (round && round.channel !== null && round.channel !== channel) {
      console.error(`[fileTransfer] ${p.manifest.fileId.slice(0, 8)} to ${peerPubkey.slice(0, 8)} was going out on an older channel — restarting it on this one`);
      abortRound(round);
    }
  }
  const list = mine.filter((p) => !resuming.has(tagOf(p)));
  if (!list.length) return;
  console.error(`[fileTransfer] peer ${peerPubkey.slice(0, 8)} connected — resuming ${list.length} parked file(s)`);
  for (const p of list) {
    const { fileId } = p.manifest;
    if ((p.tries ?? 0) >= MAX_DELIVERY_TRIES) {
      dropSend(owner, p.peer, p.manifest, `${p.tries} deliveries without an ack`);
      continue;
    }
    startRound(owner, peerPubkey, p.manifest, generation, true, async () => {
      // readBlob：讀取錯誤會丟（iOS 背景回來常見的 IDB 斷線），只有「確定沒有」才丟掉這筆
      const file = await readBlob(fileId);
      if (!file) return null;
      const key = await crypto.subtle.importKey('raw', base64ToBytes(p.manifest.fileKey) as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
      return { file, key };
    }, (err) => {
      // console.error（prod 留得下來）：補送時讀 IndexedDB 裡的檔、加密都可能丟錯，看不到原因就查不了為什麼一直重試
      console.error('[fileTransfer] resumed send failed:', (err as Error)?.name, (err as Error)?.message ?? String(err));
      notifyProgress({ fileId, direction: 'send', bytesDone: 0, bytesTotal: p.manifest.size, status: 'failed' });
    });
  }
}

/** peer 連上時呼叫（AppProvider onPeerConnected；init 時對已連著的 peer）：把掛著的檔全部再送一輪（manifest 起頭） */
export function resumePendingChunks(peerPubkey: string): void {
  resumeFiles(peerPubkey, null);
}

/**
 * peer (重)連上時呼叫（AppProvider onPeerConnected）：重送近 30s 內送給該 peer 的 manifest。
 * session repair 後 ratchet 已收斂 + WebRTC 重連 → 此時重送用新 ratchet 加密、對方解得開。
 * receiver 對 active/已完成的 fileId 冪等 dedup，重複呼叫安全。
 */
export async function resendRecentManifests(peerPubkey: string): Promise<void> {
  if (!_sendManifest) return;
  const now = Date.now();
  const list = (recentManifests.get(peerPubkey) ?? []).filter((m) => now - m.at < RECENT_MANIFEST_TTL_MS);
  if (list.length === 0) { recentManifests.delete(peerPubkey); return; }
  recentManifests.set(peerPubkey, list);
  for (const m of list) {
    try {
      await _sendManifest(peerPubkey, m.payload);
      diagLog(`[DIAG:FILE:SEND] manifest RESENT (peer reconnected): ${m.payload.fileId.slice(0, 8)} to ${peerPubkey.slice(0, 16)}`);
    } catch (err) {
      devWarn('[fileTransfer] resend manifest failed:', (err as Error)?.message ?? err);
    }
  }
}

export function onFileProgress(cb: (p: FileProgress) => void): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function onFileReceived(cb: (rf: ReceivedFile) => void | Promise<void>): () => void {
  fileReceivedListeners.add(cb);
  return () => fileReceivedListeners.delete(cb);
}

function notifyProgress(p: FileProgress): void {
  progressListeners.forEach((cb) => {
    try { cb(p); } catch (e) { console.error(e); }
  });
}

// ============================================================
// Sender
// ============================================================

/**
 * 串流 SHA-256：blob.slice() + hasher.update() per window，避免 blob.arrayBuffer()
 * 一次 load 整個檔案（200MB+ 在 mobile 一定 OOM）。Web Crypto subtle.digest 沒有
 * streaming API，所以用 hash-wasm 增量 hasher。
 */
async function computeSha256Hex(blob: Blob): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const HASH_WINDOW = 4 * 1024 * 1024;  // 4MB read window — 平衡 RAM 與 read 次數
  for (let offset = 0; offset < blob.size; offset += HASH_WINDOW) {
    const end = Math.min(offset + HASH_WINDOW, blob.size);
    const buf = await blob.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
  }
  return hasher.digest('hex');
}

async function generateFileKey(): Promise<{ keyBase64: string; cryptoKey: CryptoKey }> {
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await crypto.subtle.exportKey('raw', cryptoKey);
  return { keyBase64: bytesToBase64(new Uint8Array(raw)), cryptoKey };
}

/**
 * 發送大檔給指定 peer（push model）。
 * - 計算 sha256, 產生 fileKey, 切 chunks, 存 blob 到 fileBlobStore
 * - 發 manifest（走 DR 加密）
 * - 等 P2P 連線後 push 所有 chunks（含 backpressure）
 *
 * 回傳 { fileId, messageId }，呼叫端用 messageId 寫進 chatStore。
 */
export async function sendFile(
  peerPubkey: string,
  file: File,
  caption?: string,
): Promise<{ fileId: string; messageId: string }> {
  if (!_sendChunk || !_sendManifest || !_isConnectedTo || !_connectPeer || !_getBufferedAmount) {
    throw new Error('[fileTransfer] not initialized');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
  }
  // 0 bytes → chunkCount 0，收端永遠等不到「收齊」→ 60 秒後失敗，送出端卻顯示已送出（LEARNINGS §16.3，對應群星 P3-2）
  if (file.size === 0) {
    throw new Error('File is empty');
  }

  // 串流 hash（不 load 整檔進 heap，避免大檔 OOM）
  const generation = transferGeneration;
  const owner = _owner;
  const sha256 = await computeSha256Hex(file);
  const { keyBase64, cryptoKey } = await generateFileKey();
  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');

  const fileId = generateId('file');
  const messageId = generateId('msg');
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  // 1) 本地存 Blob（File 本身就是 Blob，直接交給 IDB，不額外複製進 RAM）
  await putBlob(fileId, file, file.type);
  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');

  // 2) manifest（走 DR 加密通道）
  const manifest: FileManifestPayload = {
    v: PROTOCOL_VERSION,
    messageId,
    fileId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    sha256,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    fileKey: keyBase64,
    caption,
    timestamp: Date.now(),
  };
  // 先記進待送清單（App 被殺、對方 15 秒內沒上線也補得回來），再排進這個 peer 的佇列：manifest → chunks → 等 ack（B32）。
  //   sendFile 立刻 return → 氣泡秒出（optimistic，2026-07-15 hunt17_3：以前同步等 P2P 最多 15 秒，自己的氣泡 15 秒不出現）
  //   佔住位子：佇列等待期間對方連上 → onPeerConnected 的補送跳過它，不重推一份
  park(owner, peerPubkey, manifest);
  startRound(owner, peerPubkey, manifest, generation, false, async () => ({ file, key: cryptoKey }), (err) => {
    console.error('[fileTransfer] background send failed:', (err as Error)?.name, (err as Error)?.message ?? String(err));
    notifyProgress({ fileId, direction: 'send', bytesDone: 0, bytesTotal: file.size, status: 'failed' });
  });

  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');
  return { fileId, messageId };
}

/**
 * 群組檔案：同一份檔案 chunked 傳給多個成員（ADR-016 視圖群組 = N 條 1-1 DataChannel）。
 * 與 sendFile 同協定，但 fileId/messageId/fileKey 全員共用、manifest 帶 groupIds，
 * 接收端據此存成群組訊息。曾用 inline base64 走 group_key_message 一包送 →
 * 超過 DataChannel 單訊息上限（~256KB）整包送不出去，群組 PDF 因此收不到。
 * 成員間序列傳送（避免 N 份 chunk 流同時搶頻寬/CPU）；單一成員失敗不影響其他成員。
 */
export async function sendFileToGroup(
  memberPubkeys: string[],
  file: File,
  groupIds: string[],
  caption?: string,
): Promise<{ fileId: string; messageId: string }> {
  if (!_sendChunk || !_sendManifest || !_isConnectedTo || !_connectPeer || !_getBufferedAmount) {
    throw new Error('[fileTransfer] not initialized');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
  }
  // 0 bytes → chunkCount 0，收端永遠等不到「收齊」→ 60 秒後失敗，送出端卻顯示已送出（LEARNINGS §16.3，對應群星 P3-2）
  if (file.size === 0) {
    throw new Error('File is empty');
  }

  const generation = transferGeneration;
  const owner = _owner;
  const sha256 = await computeSha256Hex(file);
  const { keyBase64, cryptoKey } = await generateFileKey();
  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');
  const fileId = generateId('file');
  const messageId = generateId('gfile');
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  // 本地存 Blob（發送端自己預覽用）
  await putBlob(fileId, file, file.type);
  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');

  const manifest: FileManifestPayload = {
    v: PROTOCOL_VERSION,
    messageId,
    fileId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    sha256,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    fileKey: keyBase64,
    caption,
    timestamp: Date.now(),
    groupIds,
  };

  // 每個成員各自排進自己的佇列（對應群星 B32）：記進待送清單 → manifest → chunks → 等 ack。
  //   以前逐成員「送 manifest、等 15 秒、推 chunks」：一個成員離線，後面的人都要多等 15 秒，離線的那位永遠收不到 chunks
  for (const peerPubkey of memberPubkeys) {
    park(owner, peerPubkey, manifest);
    startRound(owner, peerPubkey, manifest, generation, false, async () => ({ file, key: cryptoKey }),
      (err) => console.error(`[fileTransfer] group file send failed for ${peerPubkey.slice(0, 8)}:`, (err as Error)?.name, (err as Error)?.message ?? String(err)));
  }

  if (generation !== transferGeneration) throw new Error('file_transfer_session_changed');
  return { fileId, messageId };
}

/**
 * 推 chunks（見 PushResult）。綁在這一輪的通道上：每塊送出前同步確認還是同一條，不是就整輪作廢、讓出位子 ——
 * 舊一輪的 chunks 絕不進新通道（新通道那頭可能是重開過的頁面，沒有這個檔的 manifest；見 SendRound）。
 */
async function sendChunksToPeer(
  peerPubkey: string,
  file: Blob,
  fileId: string,
  chunkCount: number,
  fileKey: CryptoKey,
  generation: number,
  round: SendRound,
): Promise<PushResult> {
  const sendChunk = _sendChunk, getBuffered = _getBufferedAmount, isConnected = _isConnectedTo;
  const over = (): boolean => round.aborted || generation !== transferGeneration;
  /** 通道換了（對方重開、重連、換通道；沒有通道也算）：整輪作廢，新通道的補送從 manifest 重來 */
  const channelMoved = (): boolean => {
    if (round.channel === currentChannel(peerPubkey)) return false;
    console.error(`[fileTransfer] channel to ${peerPubkey.slice(0, 8)} changed under ${fileId.slice(0, 8)} — this round stops (restarts from the manifest)`);
    abortRound(round);
    return true;
  };
  if (!sendChunk || !getBuffered || !isConnected || over() || channelMoved()) return 'stale';

  const fileSize = file.size;
  let bytesSent = 0;

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunkBuf = await file.slice(start, end).arrayBuffer();
    const chunkBytes = new Uint8Array(chunkBuf);
    const { ciphertext, iv } = await encryptChunkBytes(chunkBytes, fileKey);
    if (over()) return 'stale';
    const frame = encodeChunkFrame(fileId, i, ciphertext.buffer as ArrayBuffer, iv);

    // backpressure：bufferedAmount > 4MB 就等到 < 1MB。以前等滿 30 秒就再推一塊、一直推下去（四機模擬 D1：對方關 App 之後
    //   還往死通道推）。現在：通道換號／拆了 → 當場停；App 說通道不能用（ICE 斷線、殭屍）連續 10 秒 → 停（down），
    //   短暫斷線恢復就接著推（不必從第一塊重來）；30 秒一點都沒排出去 → 卡住了（failed）；有在排只是慢 → 照舊再推
    const bufferedAtWait = getBuffered(peerPubkey);
    for (let waited = 0, offline = 0; getBuffered(peerPubkey) > BACKPRESSURE_HIGH; waited += 50) {
      if (offline >= DISCONNECT_GRACE_MS) return 'down';
      if (waited >= BACKPRESSURE_MAX_WAIT_MS && offline === 0) {
        if (getBuffered(peerPubkey) >= bufferedAtWait) return 'failed';
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
      offline = isConnected(peerPubkey) ? 0 : offline + 50;
      if (over() || channelMoved()) return 'stale';
      if (getBuffered(peerPubkey) <= BACKPRESSURE_LOW) break;
    }

    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      if (over() || channelMoved()) return 'stale';   // 跟 send 同一個同步區段：這塊只會進這一輪綁的那條通道
      ok = sendChunk(peerPubkey, frame);
      if (!ok) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
    if (ok) {
      _debugChunksSent++;
    } else {
      // 5 次 retry 都 false = DataChannel 關了/壞了 → 此 chunk 之後接收端永遠收不齊
      // （receivedCount 到不了 chunkCount → 卡死）。不再靜默丟下一塊、最後還 emit complete，
      // 改成 abort 整支送出 + 回報 failed，讓上層看到失敗（§教訓2 不可靜默失敗）。
      // 待送清單裡還留著：稍後重試或下次連上（resumePendingChunks）再整檔重推
      devWarn('[fileTransfer] chunk permanently failed, aborting send:', i, 'peer:', peerPubkey.slice(0, 8));
      notifyProgress({ fileId, direction: 'send', bytesDone: bytesSent, bytesTotal: fileSize, status: 'failed' });
      return 'failed';
    }

    bytesSent += (end - start);
    if (i % 16 === 0 || i === chunkCount - 1) {
      notifyProgress({
        fileId,
        direction: 'send',
        bytesDone: bytesSent,
        bytesTotal: fileSize,
        status: i === chunkCount - 1 ? 'complete' : 'transferring',
      });
    }

    // 讓 event loop 喘口氣（避免 UI 卡死）
    if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  diagLog(`[DIAG:FILE:SEND] complete: fileId=${fileId.slice(0, 8)} ${chunkCount} chunks → ${peerPubkey.slice(0, 16)}`);
  /**
   * 交給 DataChannel ≠ 送到：還在 bufferedAmount 裡（最多 4MB 才開始背壓）的，App 這時被關就沒了。
   * 排空而且通道還開著才算推完（getBufferedAmount 沒有通道時也回 0，所以要一起看連線）。真的收好以收端的 ack 為準
   */
  for (let waited = 0, offline = 0; ; waited += 100) {
    if (over() || channelMoved()) return 'stale';
    const connected = isConnected(peerPubkey);
    if (connected && getBuffered(peerPubkey) === 0) return 'pushed';
    if (offline >= DISCONNECT_GRACE_MS) return 'down';               // 跟背壓一樣：短暫斷線等它恢復
    if (connected && waited >= 60_000) return 'failed';
    await new Promise((r) => setTimeout(r, 100));
    offline = isConnected(peerPubkey) ? 0 : offline + 100;
  }
}

// ============================================================
// Wire frame encoding (binary)
// ============================================================

function encodeChunkFrame(
  fileId: string,
  chunkIndex: number,
  ciphertext: ArrayBuffer,
  iv: string,
): ArrayBuffer {
  const headerJson = JSON.stringify({ fileId, chunkIndex, iv });
  const headerBytes = new TextEncoder().encode(headerJson);
  const totalLen = 4 + headerBytes.byteLength + ciphertext.byteLength;
  const out = new ArrayBuffer(totalLen);
  const view = new DataView(out);
  view.setUint32(0, headerBytes.byteLength, true);  // little-endian
  new Uint8Array(out, 4, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(out, 4 + headerBytes.byteLength).set(new Uint8Array(ciphertext));
  return out;
}

interface DecodedChunkFrame {
  fileId: string;
  chunkIndex: number;
  ciphertext: Uint8Array;
  iv: string;
}

function decodeChunkFrame(frame: ArrayBuffer): DecodedChunkFrame | null {
  try {
    if (frame.byteLength < 4 || frame.byteLength > 4 + 4096 + MAX_CHUNK_SIZE + 16) return null;
    const view = new DataView(frame);
    const headerLen = view.getUint32(0, true);
    if (headerLen <= 0 || headerLen > 4096 || 4 + headerLen > frame.byteLength) return null;
    const headerBytes = new Uint8Array(frame, 4, headerLen);
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
      fileId: string;
      chunkIndex: number;
      iv: string;
    };
    // 對端送來的 header 先驗格式（對應群星 2026-09-06）：fileId 當 Map key、chunkIndex 當陣列索引
    if (typeof header.fileId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(header.fileId)) return null;
    if (!Number.isInteger(header.chunkIndex) || header.chunkIndex < 0 || header.chunkIndex >= MAX_CHUNK_COUNT) return null;
    if (typeof header.iv !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(header.iv)) return null;
    if (base64ToBytes(header.iv).byteLength !== 12) return null;
    const ciphertext = new Uint8Array(frame, 4 + headerLen);
    if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_CHUNK_SIZE + 16) return null;
    return { fileId: header.fileId, chunkIndex: header.chunkIndex, ciphertext, iv: header.iv };
  } catch (err) {
    devWarn('[fileTransfer] decodeChunkFrame failed:', err);
    return null;
  }
}

async function encryptChunkBytes(
  plaintext: Uint8Array,
  cryptoKey: CryptoKey,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  // copy 出獨立 ArrayBuffer 給 WebCrypto（避免 SharedArrayBuffer / view offset 問題）
  const plainCopy = new Uint8Array(plaintext.byteLength);
  plainCopy.set(plaintext);
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    cryptoKey,
    plainCopy.buffer as ArrayBuffer,
  );
  return { ciphertext: new Uint8Array(buf), iv: bytesToBase64(ivBytes) };
}

async function decryptChunkBytes(
  ciphertext: Uint8Array,
  ivBase64: string,
  cryptoKey: CryptoKey,
): Promise<Uint8Array> {
  const ivBytes = base64ToBytes(ivBase64);
  // copy ciphertext 到獨立 ArrayBuffer
  const ctCopy = new Uint8Array(ciphertext.byteLength);
  ctCopy.set(ciphertext);
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    cryptoKey,
    ctCopy.buffer as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============================================================
// Receiver
// ============================================================

/** AppProvider 在 processEncryptedMessage 解出 type='file_manifest' 時呼叫。 */
export async function handleManifestPayload(
  manifest: FileManifestPayload,
  fromPubkey: string,
): Promise<void> {
  if (!isFileTransferReady()) return;
  const generation = transferGeneration;
  const validFileId = typeof manifest?.fileId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(manifest.fileId);
  if (!manifest || manifest.v !== PROTOCOL_VERSION) {
    devWarn(`[fileTransfer] unsupported manifest version: ${manifest?.v}`);
    if (validFileId) sendCtl(fromPubkey, 'fail', manifest.fileId);   // 再送也收不了：叫送端別再重送
    return;
  }
  if (validFileId && failedRecvFileIds.has(manifest.fileId)) {
    sendCtl(fromPubkey, 'fail', manifest.fileId);   // 上次收齊了但 sha256 對不上：fail 可能掉了，再回一次（不能回 ack）
    return;
  }
  if (receiverStates.has(manifest.fileId)) {
    devLog(`[fileTransfer] manifest already received for fileId=${String(manifest.fileId).slice(0, 8)}, ignoring duplicate`);
    return;
  }
  if (completedRecvFileIds.has(manifest.fileId)) {
    // manifest 重送（sender 重連補送）但檔案已收完 → 別再建 receiver 空等 chunk（會誤判 stalled/failed）
    devLog(`[fileTransfer] manifest for already-completed fileId=${manifest.fileId.slice(0, 8)}, ignoring resend`);
    sendCtl(fromPubkey, 'ack', manifest.fileId);   // 對方沒收到上一次的 ack 才會重送 —— 再回一次
    return;
  }

  /**
   * ⚠️⚠️ **manifest 是對端送來的，收下之前必須驗**（對應群星 2026-09-06）。下面會 `new Array(manifest.chunkCount)`
   * 直接開一個陣列：任何加過好友的人送一個 `chunkCount: 2**31` 的 manifest，收端當場配置巨量陣列 → 分頁 OOM。
   * 驗的全部是「自洽性」而不是信任對端：
   *   1. fileId 格式；size / chunkSize / chunkCount 是正整數且在上限內
   *   2. chunkCount 必須等於 ceil(size / chunkSize) —— 對不上就是偽造或壞掉
   *   3. sha256 是 64 字元 hex（收完要拿它比對）
   *   4. fileKey 解出來必須是 32 bytes（AES-256）
   * 任何一條不過就丟掉，不建 receiver state、不回 ack。
   */
  const rejectManifest = (why: string): void => {
    // console.error 不是 devWarn：prod build 會把 warn 砍掉，這條是安全事件
    console.error(`[fileTransfer] 🔴 拒絕 manifest（${why}）fileId=${String(manifest.fileId).slice(0, 8)} from=${fromPubkey.slice(0, 16)}`);
  };
  const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (typeof manifest.fileId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(manifest.fileId)) return rejectManifest('fileId 格式非法');
  if (!isPosInt(manifest.size) || manifest.size > MAX_FILE_SIZE) return rejectManifest(`size 非法或超過上限: ${manifest.size}`);
  if (!isPosInt(manifest.chunkSize) || manifest.chunkSize > MAX_CHUNK_SIZE) return rejectManifest(`chunkSize 非法: ${manifest.chunkSize}`);
  if (!isPosInt(manifest.chunkCount) || manifest.chunkCount > MAX_CHUNK_COUNT) return rejectManifest(`chunkCount 非法或超過上限: ${manifest.chunkCount}`);
  if (manifest.chunkCount !== Math.ceil(manifest.size / manifest.chunkSize)) {
    return rejectManifest(`chunkCount 與 size/chunkSize 不自洽: ${manifest.chunkCount} != ceil(${manifest.size}/${manifest.chunkSize})`);
  }
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) return rejectManifest('sha256 不是 64 字元 hex');
  let keyBytes: Uint8Array;
  try { keyBytes = base64ToBytes(String(manifest.fileKey)); } catch { return rejectManifest('fileKey 不是 base64'); }
  if (keyBytes.length !== 32) return rejectManifest(`fileKey 不是 32 bytes: ${keyBytes.length}`);

  // 重開過 App（已完成清單只在記憶體）：IndexedDB 裡已經有這個檔 → 直接回 ack，不必再收一次
  if (await readBlob(manifest.fileId).catch(() => null)) {
    if (generation === transferGeneration) sendCtl(fromPubkey, 'ack', manifest.fileId);
    return;
  }
  if (generation !== transferGeneration || receiverStates.has(manifest.fileId)) return;
  if (receiverStates.size >= MAX_ACTIVE_RECEIVERS) {
    console.error(`[fileTransfer] 🔴 manifest refused (more than ${MAX_ACTIVE_RECEIVERS} files at once) from=${fromPubkey.slice(0, 16)} → busy`);
    sendCtl(fromPubkey, 'busy', manifest.fileId);   // 以前靜默丟掉，送端永遠不知道
    return;
  }

  // import fileKey
  const fileKeyImported = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const hasher = await createSHA256();
  if (generation !== transferGeneration || receiverStates.has(manifest.fileId)) return;
  hasher.init();
  receiverStates.set(manifest.fileId, {
    manifest,
    fromPubkey,
    chunkBlobs: new Array(manifest.chunkCount),
    receivedCount: 0,
    bytesReceived: 0,
    fileKeyImported,
    hasher,
    hashedUpTo: 0,
    hashChain: Promise.resolve(),
    stallTimer: null,
  });

  notifyProgress({
    fileId: manifest.fileId,
    direction: 'receive',
    bytesDone: 0,
    bytesTotal: manifest.size,
    status: 'transferring',
  });

  // 開始等 chunks → 啟動中斷偵測（sender 斷線/peer 離線會觸發）
  armStallWatchdog(manifest.fileId);

  diagLog(`[DIAG:FILE:RECV] manifest received: ${manifest.fileId.slice(0, 8)} (${manifest.size}B, ${manifest.chunkCount} chunks) from ${fromPubkey.slice(0, 16)}`);

  // Replay 任何 manifest 之前先到的 chunks（race condition fix）
  const buffered = earlyChunkBuffer.get(manifest.fileId);
  if (buffered && buffered.frames.length > 0) {
    deleteEarlyChunks(manifest.fileId);
    if (buffered.fromPubkey !== fromPubkey) {
      console.error('[fileTransfer] 🔴 dropping early chunks that came from a different peer than the manifest');
      return;
    }
    diagLog(`[DIAG:FILE:RECV] replaying ${buffered.frames.length} early chunks for ${manifest.fileId.slice(0, 8)}`);
    for (const frame of buffered.frames) {
      await handleChunkFrame(frame, fromPubkey);
    }
  }
}

/** AppProvider 在 handleWebRTCMessage 收到 ArrayBuffer 時呼叫。 */
export async function handleChunkFrame(frame: ArrayBuffer, fromPubkey: string): Promise<void> {
  if (!isFileTransferReady()) return;
  const generation = transferGeneration;
  _debugChunksReceived++;
  const decoded = decodeChunkFrame(frame);
  if (!decoded) {
    _debugChunksDecodeFailed++;
    return;
  }

  const state = receiverStates.get(decoded.fileId);
  // 已經收好的檔（送端沒收到 ack 又整檔重推）：直接丟，不佔 early buffer 的位子
  if (!state && completedRecvFileIds.has(decoded.fileId)) return;
  if (!state) {
    // Manifest 還沒到 → buffer 起來，manifest 到達時 replay
    _debugChunksWithoutManifest++;
    let entry = earlyChunkBuffer.get(decoded.fileId);
    if (!entry) {
      // 每個 peer 最多佔 2 格（對應群星 B39）：否則連得上的人灌 8 個假 fileId，好友真正的檔案就一格都排不進來
      let mine = 0;
      for (const e of earlyChunkBuffer.values()) if (e.fromPubkey === fromPubkey) mine++;
      if (mine >= MAX_EARLY_FILES_PER_PEER
          || earlyChunkBuffer.size >= MAX_EARLY_FILES || earlyChunkBytes + frame.byteLength > MAX_EARLY_BYTES) {
        devWarn('[fileTransfer] early chunk buffer full; dropping frame');
        return;
      }
      const ttlTimer = setTimeout(() => {
        const stale = earlyChunkBuffer.get(decoded.fileId);
        if (stale) {
          devWarn(`[fileTransfer] dropping ${stale.frames.length} early chunks for ${decoded.fileId.slice(0, 8)} (no manifest in ${EARLY_CHUNK_BUFFER_TTL_MS}ms)`);
          deleteEarlyChunks(decoded.fileId);
        }
      }, EARLY_CHUNK_BUFFER_TTL_MS);
      entry = { frames: [], bytes: 0, fromPubkey, ttlTimer };
      earlyChunkBuffer.set(decoded.fileId, entry);
    }
    if (entry.fromPubkey !== fromPubkey || entry.frames.length >= MAX_EARLY_FRAMES_PER_FILE
        || earlyChunkBytes + frame.byteLength > MAX_EARLY_BYTES) return;
    entry.frames.push(frame);
    entry.bytes += frame.byteLength;
    earlyChunkBytes += frame.byteLength;
    return;
  }

  // 只收 manifest 那個人送的、索引在範圍內、長度對得上的（對應群星 2026-09-06）：別人拿同一個 fileId 塞不進來
  if (state.fromPubkey !== fromPubkey || decoded.chunkIndex >= state.manifest.chunkCount) {
    devWarn('[fileTransfer] chunk rejected: sender or index mismatch');
    return;
  }
  const expectedPlaintext = decoded.chunkIndex === state.manifest.chunkCount - 1
    ? state.manifest.size - decoded.chunkIndex * state.manifest.chunkSize
    : state.manifest.chunkSize;
  if (decoded.ciphertext.byteLength !== expectedPlaintext + 16) {
    devWarn('[fileTransfer] chunk rejected: ciphertext length mismatch');
    return;
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptChunkBytes(decoded.ciphertext, decoded.iv, state.fileKeyImported);
    if (generation !== transferGeneration) return;
  } catch (err) {
    devWarn('[fileTransfer] chunk decrypt failed:', err, 'idx:', decoded.chunkIndex);
    return;
  }
  if (plaintext.byteLength !== expectedPlaintext) {
    devWarn('[fileTransfer] chunk rejected: plaintext length mismatch');
    return;
  }

  if (state.chunkBlobs[decoded.chunkIndex] === undefined) {
    // 包成 Blob ref：瀏覽器可 disk-spill；不像 Uint8Array 一定占 heap RAM。
    state.chunkBlobs[decoded.chunkIndex] = new Blob([plaintext as BlobPart]);
    state.receivedCount++;
    state.bytesReceived += plaintext.byteLength;

    // 有進度 → 重置 stall watchdog（最後一塊由 finalizeFile 的 clearStallTimer 收掉）
    armStallWatchdog(decoded.fileId);

    // 增量 hash：把連續可用的 chunks 餵進 hasher（亂序到達會等前面的 chunk 補齊）
    advanceHasher(state);

    if (state.receivedCount % 16 === 0 || state.receivedCount === state.manifest.chunkCount) {
      notifyProgress({
        fileId: decoded.fileId,
        direction: 'receive',
        bytesDone: state.bytesReceived,
        bytesTotal: state.manifest.size,
        status: state.receivedCount === state.manifest.chunkCount ? 'complete' : 'transferring',
      });
    }
  } else {
    // 重複的一塊（驗過、解得開）：送端換了通道從第一塊重推。還在動 → 也重置 stall watchdog，
    //   不然重推前面那幾百塊的期間超過 60 秒就被判中斷、整個丟掉
    armStallWatchdog(decoded.fileId);
  }

  if (state.receivedCount === state.manifest.chunkCount) {
    await finalizeFile(decoded.fileId);
  }
}

/**
 * 把連續可用的 chunks 餵給 hasher。Promise chain 序列化，避免亂序 chunk 雙重 hash。
 * 不 await — fire-and-forget，由 finalizeFile await state.hashChain 收尾。
 */
function advanceHasher(state: ReceiverState): void {
  state.hashChain = state.hashChain.then(async () => {
    while (state.hasher && state.chunkBlobs[state.hashedUpTo]) {
      const blob = state.chunkBlobs[state.hashedUpTo]!;
      const buf = await blob.arrayBuffer();
      state.hasher.update(new Uint8Array(buf));
      state.hashedUpTo++;
    }
  }).catch((err) => {
    devWarn('[fileTransfer] hasher chain error:', err);
  });
}

/** 重置接收端 stall watchdog（每收到新 chunk 呼叫一次）。完成/失敗時由 clearStallTimer 清掉。 */
function armStallWatchdog(fileId: string): void {
  const state = receiverStates.get(fileId);
  if (!state) return;
  if (state.stallTimer) clearTimeout(state.stallTimer);
  state.stallTimer = setTimeout(() => { failReceive(fileId, 'stalled'); }, RECEIVE_STALL_MS);
}

function clearStallTimer(state: ReceiverState): void {
  if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
}

/**
 * 接收中斷 → 標 failed（§教訓2 不可靜默卡 transferring）+ 清掉 receiver state（半套傳輸的 chunk
 * Blob 不再永久留在 Map）。manifest 已走 DR 通道、sender 端仍可重送 → 之後重發 manifest 會重建 state。
 */
function failReceive(fileId: string, reason: string): void {
  const state = receiverStates.get(fileId);
  if (!state) return;
  clearStallTimer(state);
  receiverStates.delete(fileId);
  devWarn(`[fileTransfer] receive FAILED (${reason}): ${fileId.slice(0, 8)} at ${state.receivedCount}/${state.manifest.chunkCount}`);
  notifyProgress({
    fileId,
    direction: 'receive',
    bytesDone: state.bytesReceived,
    bytesTotal: state.manifest.size,
    status: 'failed',
  });
}

async function finalizeFile(fileId: string): Promise<void> {
  const generation = transferGeneration;
  const state = receiverStates.get(fileId);
  if (!state) return;
  clearStallTimer(state);
  receiverStates.delete(fileId);
  // 標記已完成 → 之後 sender 重連補送的 manifest 直接忽略（bounded FIFO 防無限膨脹）
  completedRecvFileIds.add(fileId);
  if (completedRecvFileIds.size > COMPLETED_RECV_MAX) {
    completedRecvFileIds.delete(completedRecvFileIds.values().next().value as string);
  }

  // 等所有 hasher.update 完成（hashedUpTo 應追上 chunkCount）
  await state.hashChain;
  if (generation !== transferGeneration) return;
  if (!state.hasher || state.hashedUpTo !== state.manifest.chunkCount) {
    devWarn(`[fileTransfer] finalize: incomplete hash hashedUpTo=${state.hashedUpTo} chunkCount=${state.manifest.chunkCount}`);
    completedRecvFileIds.delete(fileId);   // 沒存成：重送的 manifest 要重收，不能回「早就收好了」的 ack
    notifyProgress({
      fileId,
      direction: 'receive',
      bytesDone: state.bytesReceived,
      bytesTotal: state.manifest.size,
      status: 'failed',
    });
    return;
  }
  const sha256 = state.hasher.digest('hex');
  if (sha256 !== state.manifest.sha256) {
    devWarn(`[fileTransfer] sha256 mismatch! fileId=${fileId.slice(0, 8)} expected=${state.manifest.sha256.slice(0, 12)} got=${sha256.slice(0, 12)}`);
    // 每一塊都驗過（AES-GCM），整檔還是對不上＝送端的檔跟 manifest 不一樣：再送也一樣 → 回 fail 叫送端別再重送。
    //   不能留在「已收完」清單（重送的 manifest 會被回 ack，送端以為送到了）
    completedRecvFileIds.delete(fileId);
    rememberBounded(failedRecvFileIds, fileId);
    if (generation === transferGeneration) sendCtl(state.fromPubkey, 'fail', fileId);
    notifyProgress({
      fileId,
      direction: 'receive',
      bytesDone: state.bytesReceived,
      bytesTotal: state.manifest.size,
      status: 'failed',
    });
    return;
  }

  // 組最終 blob — Blob ctor 從 Blob[] 拼接是 ref-only，不會把 bytes 全載入 RAM。
  const parts = state.chunkBlobs.filter((b): b is Blob => b !== undefined);
  const blob = new Blob(parts as BlobPart[], { type: state.manifest.mimeType });

  /**
   * ⚠️ fileId 是對方給的（稽核 M6，對應 AegisPlay B35）：已經有同 id 的檔就**不覆寫、也不再通知** ——
   * 重送同一個檔不需要再寫一次；拿別人的 fileId 來蓋（群組成員都看得到 id）則是攻擊。
   * 「已收完」清單只在記憶體，重新開 App 後就空了，所以要問 IndexedDB。
   */
  if (await readBlob(fileId).catch(() => null)) {
    console.error(`[fileTransfer] fileId ${fileId.slice(0, 8)} already stored — keeping the existing file, ignoring the incoming one`);
    if (generation === transferGeneration) sendCtl(state.fromPubkey, 'ack', fileId);
    return;
  }
  if (generation !== transferGeneration) return;

  // 寫進 fileBlobStore
  await putBlob(fileId, blob, state.manifest.mimeType);
  if (generation !== transferGeneration) return;
  sendCtl(state.fromPubkey, 'ack', fileId);   // 存好了才回 —— 送端這時才從待送清單移除（B32）

  // 通知 AppProvider 寫進 chatStore
  const rf: ReceivedFile = {
    messageId: state.manifest.messageId,
    fileId,
    fromPubkey: state.fromPubkey,
    name: state.manifest.name,
    mimeType: state.manifest.mimeType,
    size: state.manifest.size,
    caption: state.manifest.caption,
    timestamp: state.manifest.timestamp,
    groupIds: state.manifest.groupIds,
  };
  fileReceivedListeners.forEach((cb) => {
    try {
      const work = Promise.resolve(cb(rf)).catch((error) => console.error('[fileTransfer] received callback failed', error));
      fileReceivedTasks.add(work);
      void work.finally(() => fileReceivedTasks.delete(work));
    } catch (error) { console.error(error); }
  });

  diagLog(`[DIAG:FILE:RECV] complete: ${state.manifest.fileId.slice(0, 8)} (${state.manifest.size}B) from ${state.fromPubkey.slice(0, 16)}`);
}

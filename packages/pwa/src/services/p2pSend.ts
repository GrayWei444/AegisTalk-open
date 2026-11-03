/**
 * P2P Send Service — ADR-016 統一 P2P 訊息發送 + 持久化 outbox
 *
 * 架構：MQTT 純信令，P2P DataChannel 負責所有訊息內容（無 MQTT fallback）
 * - P2P 已連線 → 直接發送
 * - P2P 未連線 → 寫入持久化 outbox（SQLite）+ connectPeer（MQTT 僅信令建 WebRTC）
 * - P2P 連線建立 → flush outbox（只走 DataChannel）
 * - 啟動 → loadOutbox 重新觸發投遞（跨 reload/重啟/crash「訊息絕不消失」）
 * - 背壓機制 → ICE 連續失敗暫停建連
 *
 * ⚠️ 死罪修正（HANDOFF §0.29）：舊版 outbox 是 in-memory Map + 5min 過期 → reload 即丟訊息。
 * 改用 SQLite `pending_messages` 作唯一真相來源（復活 P2P-only 遷移 commit 3a8bbd6 時被孤立的
 * 持久化層）。佇列僅在「P2P 未連線」時用 → 連線需數百 ms~數秒、遠長於 SQLite 寫入，
 * 故 onPeerConnected→flush 時持久化必已完成。
 */

import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import {
  addPendingMessage,
  addGroupPendingMessage,
  getPendingMessagesForRecipient,
  getAllPendingMessages,
  removePendingMessage,
  removePendingMessageForRecipient,
  updatePendingMessageRetry,
  getPendingMessageCount,
  deleteGroupPendingMessagesForRecipient,
} from './storage';

/** 與 dcFraming.DC_MAX_MESSAGE_CHARS 相同（dc_framing_self_test 檢查兩者一致）：超過就永遠送不出去 */
const DC_MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

// ============================================
// 送達回條（1 對 1：群星 B33；群組：對應群星 8708fa6f，多人模擬 S3／S5）
// ============================================
/**
 * 以前 DataChannel `send()` 成功就算送到。對方剛關 App（或剛重開）時，這邊的通道好幾秒內還說 open（連線死了要
 * ~35 秒才偵測得到），或還在送出緩衝裡時 closePeer —— 送進去就沒了，畫面卻顯示已送，不重送就永遠不見。
 * 現在送出後各留一筆「等回條」，對方存好回條才刪；30 秒沒回條、或送出之後 DataChannel 換過（送進舊通道的多半沒到）
 * 就重送，最多 5 次。收端依 messageId 去重。
 *   1 對 1：留**明文**，對方回 DR 加密的 `msg_ack`。重送時用當下的 session **重新加密** —— 不能重送同一份密文：
 *     對方第二次解會失敗、觸發 session 重建。
 *   群組：留**送出去的那份群組金鑰密文本身**（跟 1-1 session 無關，原封不動重送、不重新加密），對方回 `group_msg_ack`。
 *     id 帶收件人：同一則送給 N 人不會互蓋。
 */
export type DeliveryTrack =
  | { messageId: string; plaintext: string }   // 1 對 1：重送時用當下的 session 重新加密
  | { messageId: string; group: true };        // 群組：原封不動重送同一份群組金鑰密文
const INFLIGHT_TYPE = 'plaintext_inflight';
const GROUP_INFLIGHT_TYPE = 'group_inflight';
/** 群組的待送型別（群組金鑰密文、等回條、回條）：只送給現在還同群的人。跟 storage 的 GROUP_OUTBOX_TYPES_SQL 一致 */
const GROUP_OUTBOX_TYPES = new Set(['group_key_message', 'group_inflight', 'group_msg_ack']);
const INFLIGHT_RESEND_AFTER_MS = 30_000;
const INFLIGHT_MAX_RESENDS = 5;
const MAX_ACK_ID_CHARS = 128;
const inflightId = (messageId: string) => `inflight-${messageId}`;
const groupInflightId = (messageId: string, recipientPubkey: string) => `ginflight-${messageId}-${recipientPubkey}`;
const ackKey = (peer: string, messageId: string) => `${peer}|${messageId}`;
const isInflightType = (messageType: string) => messageType === INFLIGHT_TYPE || messageType === GROUP_INFLIGHT_TYPE;

/**
 * 回條只認「我真的送給他、還在等回條」的那幾則（對應群星 b4fdce19，審查 HIGH）。以前任何連得上的人送
 * `group_msg_ack`，每個 id 都記進 recentAcks、各下一條 SQLite DELETE，recentAcks 每次還整份掃一遍 ——
 * 40,000 個假 id ＝ 40,000 條 DELETE、主線程卡 38 秒。現在送出（或從 outbox 讀到）等回條的那則時記下
 * `${收件人}|${messageId}` → 這則是群組的（true）還是 1 對 1 的（false）；回條只處理名單上的，其他的不碰資料庫，
 * 確認時也只刪那一筆。名單有上限：被擠掉的那則照常 30 秒後重送，重送時再記一次。
 * ⚠️ 不在 unregisterP2PFunctions 清：AppProvider 每次 render 都重跑註冊的 effect；登出／換帳號整頁 reload。
 */
const AWAITING_MAX = 20_000;
const awaitingAcks = new Map<string, boolean>();
function expectAck(peer: string, messageId: string, group: boolean): void {
  const key = ackKey(peer, messageId);
  awaitingAcks.delete(key);
  awaitingAcks.set(key, group);
  if (awaitingAcks.size > AWAITING_MAX) {
    const oldest = awaitingAcks.keys().next().value;
    if (oldest !== undefined) awaitingAcks.delete(oldest);
  }
}

/**
 * 回條可能比「等回條」那筆寫進資料庫還早到（P2P 來回幾毫秒，SQLite 寫入可能更久）—— 那筆就會一直留著，
 * 30 秒後白白重送一次。記下最近一分鐘收到的（只記在等的那幾則），寫完發現已經回條了就直接刪掉。
 * 從最舊的一端修剪、硬上限 2000 筆（以前超過 500 筆後每個回條都整份掃一遍）。
 */
const RECENT_ACK_TTL_MS = 60_000;
const RECENT_ACK_MAX = 2_000;
const recentAcks = new Map<string, number>();
function noteAck(key: string, now: number): void {
  recentAcks.delete(key);
  recentAcks.set(key, now);
  for (const [k, at] of recentAcks) {
    if (recentAcks.size <= RECENT_ACK_MAX && now - at <= RECENT_ACK_TTL_MS) break;
    recentAcks.delete(k);
  }
}

/**
 * 每個對象處理回條的額度（token bucket）：一次最多 1000 個 id、每秒回補 100 個。正常情況（重連後一口氣補送幾百則）
 * 用不完；灌回條的人只會拖慢自己（他的回條暫時不算，訊息照常重送）。記錄的對象數有上限，最久沒動的先丟。
 */
const ACK_BUDGET = { capacity: 1_000, refillPerSec: 100, maxPeers: 256 };
const ackBudgets = new Map<string, { tokens: number; at: number }>();
function takeAckBudget(peer: string, cost: number, now: number): boolean {
  const prev = ackBudgets.get(peer);
  // 時鐘往回調時不能扣成負的（程式碼審查 LOW：以前調回一小時，這個人的回條一小時都不算）
  const tokens = prev
    ? Math.min(ACK_BUDGET.capacity, prev.tokens + (Math.max(0, now - prev.at) / 1000) * ACK_BUDGET.refillPerSec)
    : ACK_BUDGET.capacity;
  const ok = tokens >= cost;
  ackBudgets.delete(peer);
  ackBudgets.set(peer, { tokens: ok ? tokens - cost : tokens, at: now });
  if (ackBudgets.size > ACK_BUDGET.maxPeers) {
    const oldest = ackBudgets.keys().next().value;
    if (oldest !== undefined) ackBudgets.delete(oldest);
  }
  return ok;
}

/** outbox 裡「等回條」那筆對應的 messageId（id 的格式見 inflightId／groupInflightId） */
function awaitedMessageId(row: { id: string; messageType: string; recipientPubkey: string }): string | null {
  if (row.messageType === INFLIGHT_TYPE && row.id.startsWith('inflight-')) return row.id.slice('inflight-'.length) || null;
  const suffix = `-${row.recipientPubkey}`;
  if (row.messageType === GROUP_INFLIGHT_TYPE && row.id.startsWith('ginflight-') && row.id.endsWith(suffix)) {
    return row.id.slice('ginflight-'.length, row.id.length - suffix.length) || null;
  }
  return null;
}

/**
 * 連線一直開著、沒有新的 open 事件時也要檢查（對方 30 秒內沒回條就重送）。每個對象最多一個計時器；
 * 檢查完還有在等回條的就再排一次（重送之後、或後來才送的那幾則）
 */
const inflightTimers = new Map<string, ReturnType<typeof setTimeout>>();
function armInflightCheck(recipientPubkey: string): void {
  if (inflightTimers.has(recipientPubkey)) return;
  const generation = accountGeneration;
  const timer = setTimeout(() => {
    inflightTimers.delete(recipientPubkey);
    // 換了帳號的話不跑（那是上一個帳號的待送）；還沒重新註冊（_sendToPeer 是 null）就什麼都不做，下一次 flush 再看
    if (generation === accountGeneration) void flushQueueForPeer(recipientPubkey);
  }, INFLIGHT_RESEND_AFTER_MS + 5_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  inflightTimers.set(recipientPubkey, timer);
}

function clearInflightTimers(): void {
  for (const timer of inflightTimers.values()) clearTimeout(timer);
  inflightTimers.clear();
}

function trackInflight(recipientPubkey: string, track: DeliveryTrack, wirePayload: string): Promise<void> {
  if (!acceptingMessages || !track.messageId || track.messageId.length > MAX_ACK_ID_CHARS) return Promise.resolve();
  const group = 'group' in track;
  const id = group ? groupInflightId(track.messageId, recipientPubkey) : inflightId(track.messageId);
  expectAck(recipientPubkey, track.messageId, group);   // 先記：回條可能比下面的寫入還早到
  armInflightCheck(recipientPubkey);
  // 群組：密文以 messageId 只存一份、這筆只留參照（對應群星 0a544b74，審查 M3）；1 對 1：存明文，重送時重新加密
  const written = group
    ? addGroupPendingMessage({ id, recipientPubkey, messageType: GROUP_INFLIGHT_TYPE, createdAt: Date.now() }, track.messageId, wirePayload)
    : addPendingMessage({ id, recipientPubkey, messageType: INFLIGHT_TYPE, createdAt: Date.now(),
      encryptedPayload: JSON.stringify({ type: INFLIGHT_TYPE, payload: track.plaintext }) });
  return written
    .then(async () => {
      if (recentAcks.has(ackKey(recipientPubkey, track.messageId))) {
        await removePendingMessageForRecipient(id, recipientPubkey, group ? track.messageId : undefined);
      }
    })
    .catch(() => { /* 存不進去：退回舊行為（送了就算） */ });
}

/**
 * AppProvider 收到對方的 `msg_ack`（1 對 1，DR 加密）或 `group_msg_ack`（群組）時呼叫：只清「送給他、還在等」的
 * 那幾筆。回傳確認了幾則（記 log 用）。
 */
export function confirmDelivered(fromPubkey: string, messageIds: unknown): number {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
  const ids = messageIds.slice(0, 50);
  const now = Date.now();
  if (!takeAckBudget(fromPubkey, ids.length, now)) return 0;
  let confirmed = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id.length > MAX_ACK_ID_CHARS) continue;
    const key = ackKey(fromPubkey, id);
    const group = awaitingAcks.get(key);
    if (group === undefined) continue;             // 沒在等（亂造的、別人的、已經確認過的）→ 不碰資料庫
    awaitingAcks.delete(key);
    noteAck(key, now);
    confirmed++;
    const rowId = group ? groupInflightId(id, fromPubkey) : inflightId(id);
    void removePendingMessageForRecipient(rowId, fromPubkey, group ? id : undefined).catch(() => {});
  }
  return confirmed;
}

function trackOf(originalContent: string | undefined): DeliveryTrack | null {
  if (!originalContent) return null;
  try {
    const t = JSON.parse(originalContent) as { messageId?: unknown; plaintext?: unknown; group?: unknown };
    if (typeof t.messageId !== 'string') return null;
    if (t.group === true) return { messageId: t.messageId, group: true };
    return typeof t.plaintext === 'string' ? { messageId: t.messageId, plaintext: t.plaintext } : null;
  } catch { return null; }
}

/** 「待加密」條目（plaintext_pending）本身就是明文，id 在裡面：送出去之後一樣要等回條 */
function trackOfPlaintextPending(encryptedPayload: string): DeliveryTrack | null {
  try {
    const inner = (JSON.parse(encryptedPayload) as { payload?: unknown }).payload;
    if (typeof inner !== 'string') return null;
    const id = (JSON.parse(inner) as { id?: unknown }).id;
    return typeof id === 'string' && id ? { messageId: id, plaintext: inner } : null;
  } catch { return null; }
}

/**
 * 「等回條」的那筆該不該現在重送：送出超過 30 秒，或送出之後這條 DataChannel 換過（重連、對方重開 App、
 * glare 換通道）—— 送進舊通道的東西多半沒到，不必再等 30 秒。
 */
function inflightDue(sentAt: number, recipientPubkey: string): boolean {
  if (Date.now() - sentAt >= INFLIGHT_RESEND_AFTER_MS) return true;
  let openedAt = 0;
  try { openedAt = _channelOpenedAt?.(recipientPubkey) ?? 0; } catch { /* 查不到就照 30 秒規則 */ }
  return openedAt > sentAt;
}

// ============================================
// P2P 函式註冊（由 AppProvider 注入）
// ============================================

type IsConnectedFn = (remotePublicKey: string) => boolean;
type SendToPeerFn = (remotePublicKey: string, data: string) => boolean;
type ConnectPeerFn = (remotePublicKey: string) => Promise<void>;
/** 目前這條 DataChannel 是什麼時候 open 的（沒有回 0） */
type ChannelOpenedAtFn = (remotePublicKey: string) => number;
/** 這個人現在是不是好友／同群成員；好友或群組名單還沒載入回 null（不知道 → 照舊處理） */
export type PeerRelation = { friend: boolean; fellowMember: boolean } | null;
type PeerRelationFn = (remotePublicKey: string) => PeerRelation;

/**
 * 帳號隔離（對應群星 p2pSend owner／generation）：outbox、回條名單、催 session 的節流都是「這個帳號」的。
 * 換帳號（publicKey 變了）或帳號離開這台（shutdownP2PAccount：被踢、換機）時世代加一：還在 await 的 flush／寫入／
 * 加密回來看到世代變了就停手 —— 不會用新帳號的通道送上一個帳號讀出來的密文、不會用上一個帳號的加密器、
 * 也不會在清掉 outbox 之後又寫回一筆。shutdown 之後到下一個帳號註冊之前，什麼都不收、不送。
 */
let accountGeneration = 0;
let accountOwner: string | null = null;
let acceptingMessages = true;
/** 還在寫進 outbox 的那幾筆（shutdownP2PAccount 等它們寫完，才讓呼叫端清 outbox） */
const pendingEnqueues = new Set<Promise<void>>();
let _isConnectedTo: IsConnectedFn | null = null;
let _sendToPeer: SendToPeerFn | null = null;
let _connectPeer: ConnectPeerFn | null = null;
let _channelOpenedAt: ChannelOpenedAtFn | null = null;
let _peerRelation: PeerRelationFn | null = null;

function relationOf(pk: string): PeerRelation {
  try { return _peerRelation?.(pk) ?? null; } catch { return null; }
}

/** 換帳號／帳號離開：記憶體裡屬於上一個帳號的東西全部丟掉 */
function resetAccountState(): void {
  sessionNudgeAt.clear();
  recentAcks.clear();
  awaitingAcks.clear();
  ackBudgets.clear();
  clearInflightTimers();
}

export function registerP2PFunctions(fns: {
  isConnectedTo: IsConnectedFn;
  sendToPeer: SendToPeerFn;
  connectPeer: ConnectPeerFn;
  channelOpenedAt?: ChannelOpenedAtFn;
  /** 好友＋同群成員的名單（對應群星 6d381b43）：loadOutbox 只撥給認得的人、已經不同群的人不送群組的待送 */
  peerRelation?: PeerRelationFn;
}, owner?: string): void {
  if (owner && owner !== accountOwner) {
    if (accountOwner !== null) accountGeneration += 1;   // 換帳號：上一個帳號還在跑的 flush／寫入作廢
    resetAccountState();
    accountOwner = owner;
    acceptingMessages = true;
  }
  if (!acceptingMessages) return;   // shutdownP2PAccount 之後、同一個帳號的舊 effect 晚到：不能重新打開
  _isConnectedTo = fns.isConnectedTo;
  _sendToPeer = fns.sendToPeer;
  _connectPeer = fns.connectPeer;
  _channelOpenedAt = fns.channelOpenedAt ?? null;
  _peerRelation = fns.peerRelation ?? null;
  devLog('[p2pSend] P2P functions registered');
}

export function unregisterP2PFunctions(): void {
  _isConnectedTo = null;
  _sendToPeer = null;
  _connectPeer = null;
  _channelOpenedAt = null;
  _peerRelation = null;
  // 不清 recentAcks、awaitingAcks、重送計時器（程式碼審查 LOW）：AppProvider 每次 render 都重跑註冊的 effect
  //   （useWebRTC 每次回傳新物件），以前每次 render 都清掉 → 比寫入早到的回條白費、30 秒的重送檢查幾乎從來沒跑過。
  //   換帳號、帳號離開時才清（registerP2PFunctions 帶新 owner、shutdownP2PAccount）
}

/**
 * 帳號離開這台裝置（被踢、換機登出）時、清 SQLite outbox **之前**呼叫（對應群星 shutdownP2PAccount）：
 * 先停掉這個帳號所有還在跑的送訊工作、等寫到一半的 outbox 寫完，呼叫端再清 —— 不然清完之後還有一筆寫回去，
 * 下一個帳號開 App 就照收件人送出去。之後到下一個帳號註冊之前什麼都不收、不送。
 */
export async function shutdownP2PAccount(): Promise<void> {
  acceptingMessages = false;
  accountGeneration += 1;
  unregisterP2PFunctions();
  _outboxEncrypt = null;
  outboxEncryptOwner = null;
  _requestSession = null;
  resetAccountState();
  recordConnectSuccess();
  await Promise.all([...pendingEnqueues]);
}

/**
 * 某人已經跟我不同群了（被踢、離開、我退群、群被刪；或刪好友時他也不是同群成員）→ 給他的群組待送全部清掉、
 * 不再等他的回條（對應群星 6d381b43，審查 M2：以前留在 outbox，loadOutbox 每次開 App 都撥給他 30 天、
 * 通道一開就照送）。AppProvider 在名冊變動時呼叫；1 對 1 的待送不動（好友關係另外處理）。
 */
export async function dropGroupOutboxFor(recipientPubkey: string): Promise<void> {
  if (!acceptingMessages) return;
  const prefix = `${recipientPubkey}|`;
  for (const [key, group] of awaitingAcks) if (group && key.startsWith(prefix)) awaitingAcks.delete(key);
  try {
    await deleteGroupPendingMessagesForRecipient(recipientPubkey);
    diagLog(`[DIAG:P2P:OUTBOX] dropped group entries for ${recipientPubkey.slice(0, 16)} (no longer in a shared group)`);
  } catch (err) {
    console.error('[p2pSend] Failed to drop group outbox entries:', (err as Error)?.message || String(err));
  }
}

// ============================================
// 離線 outbox（SQLite 持久化 — 跨 reload/重啟/crash 不丟）
// ============================================

// 每人 outbox 安全上限（防失控）。達上限「不靜默丟新訊息」（§0.29 死罪原則）：
// 改 console.error 警示 + 仍寫入，靠 30 天 TTL（cleanupOldPendingMessages）清最舊。
// 「等回條」那幾筆也算在裡面（收到回條或重送 5 次後就刪）。
const MAX_QUEUE_PER_RECIPIENT = 500;

function newPendingId(): string {
  try {
    return `p2p_${crypto.randomUUID()}`;
  } catch {
    return `p2p_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  }
}

/** 從 P2P envelope JSON 取 type 作 messageType（best-effort，純標註用） */
function envelopeType(payload: string): string {
  try {
    const t = (JSON.parse(payload) as { type?: string })?.type;
    return typeof t === 'string' ? t : 'p2p';
  } catch {
    return 'p2p';
  }
}

// ============================================
// 背壓機制（ADR-016: 連續建連失敗暫停）
// ============================================

let _consecutiveConnectFailures = 0;
let _backpressureUntil = 0;
const BACKPRESSURE_MAX_FAILURES = 3;
const BACKPRESSURE_PAUSE_MS = 10_000; // 10 秒

function isBackpressured(): boolean {
  return Date.now() < _backpressureUntil;
}

function recordConnectFailure(): void {
  _consecutiveConnectFailures++;
  if (_consecutiveConnectFailures >= BACKPRESSURE_MAX_FAILURES) {
    _backpressureUntil = Date.now() + BACKPRESSURE_PAUSE_MS;
    devLog(`[p2pSend] Backpressure: ${_consecutiveConnectFailures} consecutive failures, pausing ${BACKPRESSURE_PAUSE_MS}ms`);
  }
}

function recordConnectSuccess(): void {
  _consecutiveConnectFailures = 0;
  _backpressureUntil = 0;
}

/** 記錄建連成功（供 AppProvider 呼叫） */
export function notifyConnectSuccess(): void {
  recordConnectSuccess();
}

// ============================================
// 無 session 時的「待加密」outbox（2026-08-19，修「訊息無聲消失」）
// ============================================
// 真因：encrypt 在無 session 時 throw「No session with this recipient」→ 訊息不進 store
// 也不進 outbox（恢復讓步窗口、恢復後立刻傳給離線好友都踩）。
// 修法：以 {type:'plaintext_pending'} 形式存進**發送者本機**的同一張 pending_messages
// （只在自己裝置的 SQLite，跟聊天紀錄同等級，絕不經伺服器）；flush 時才用「當下的
// session」加密送出 —— 附帶性質：sessionReset 也不會作廢它們（重置只該清舊「密文」，
// 待加密條目用新 session 加密即可）。

type OutboxEncryptFn = (peerPubkey: string, plaintext: string) => Promise<string | null>;
/** 請對方發起 X3DH（PREKEY_REQUEST，**必須附我方 prekey bundle**）。真的送出去了回 true（MQTT 沒連上回 false，下次再催） */
type RequestSessionFn = (peerPubkey: string) => boolean;
let _outboxEncrypt: OutboxEncryptFn | null = null;
/** 加密器是哪個帳號註冊的：換帳號後不能用上一個帳號的（它的 session 是上一個帳號的） */
let outboxEncryptOwner: string | null = null;
let _requestSession: RequestSessionFn | null = null;
const sessionNudgeAt = new Map<string, number>();
const NUDGE_THROTTLE_MS = 60_000;

/**
 * AppProvider 註冊（對應群星，取代 registerSessionNudge）：`fn` 用當下 session 加密，回序列化 RatchetMessage JSON，
 * 尚無 session 回 null；`owner` 是註冊它的帳號；`requestSession` 催對方發起 X3DH。
 */
export function registerOutboxEncrypt(fn: OutboxEncryptFn, owner?: string, requestSession?: RequestSessionFn): void {
  _outboxEncrypt = fn;
  _requestSession = requestSession ?? null;
  outboxEncryptOwner = owner ?? accountOwner;
}

/**
 * 催對方發起 X3DH（per peer 60s 節流）。這是「無 session 待加密訊息」唯一的出路，
 * 所以 enqueue 當下送一次，之後**每次 flush 卡在『等 session』時再送一次** ——
 * 重連 / 收到 X3DH / 重開 app 都會觸發 flush，等於天然重試，不必另開 timer。
 * 沒送出去（MQTT 斷線）不記節流時間：下一次 flush 馬上再催（以前斷線時那一發丟了也要等 60 秒）。
 * 只用這個帳號註冊的 requestSession（換帳號後不會替上一個帳號催）。
 * ponytail: 重試依附既有 flush 觸發點（peer 連上 / X3DH accept / loadOutbox）。
 *   若對端一直連著又始終不回應，就要等下一次連線事件；真需要固定節奏再加 timer。
 */
function nudgeOutboxSession(peerPubkey: string): void {
  if (!acceptingMessages || outboxEncryptOwner !== accountOwner || !_requestSession) return;
  const now = Date.now();
  if (now - (sessionNudgeAt.get(peerPubkey) ?? -Infinity) < NUDGE_THROTTLE_MS) return;
  try {
    if (_requestSession(peerPubkey)) {
      sessionNudgeAt.set(peerPubkey, now);
      // prod build 只留 console.error（vite esbuild pure）→ 線上要看得到「到底有沒有送出這一發」
      console.error('[p2pSend] no session → PREKEY_REQUEST sent to', peerPubkey.slice(0, 16));
    }
  } catch { /* 留著待送，下一次 flush 再催 */ }
}

/**
 * 無 session 時把「尚未加密的訊息資料」排進本機 outbox，等 session 建立後由 flush 加密送出。
 * 呼叫端仍應照常 storeSendMessage（訊息要出現在自己的聊天畫面）。
 */
export function enqueuePlaintextForSession(recipientPubkey: string, messageDataJson: string): void {
  if (!acceptingMessages) return;
  const generation = accountGeneration;
  void enqueue(recipientPubkey, JSON.stringify({ type: 'plaintext_pending', payload: messageDataJson }));
  console.error('[p2pSend] No session yet — queued plaintext-pending locally for', recipientPubkey.slice(0, 16));
  // 催對方發起 X3DH（沒有 session 就永遠送不出去）
  nudgeOutboxSession(recipientPubkey);
  // 順便催建 P2P（session 由 X3DH 流程負責；transport 先備妥）
  if (_connectPeer && !isBackpressured()) {
    _connectPeer(recipientPubkey).catch(() => { if (generation === accountGeneration) recordConnectFailure(); });
  }
}

/**
 * 寫入持久化 outbox（async；呼叫者同步路徑以 `void enqueue(...)` 觸發、不阻塞）。
 * 僅在 P2P 未連線時走到這裡 —— 之後 connectPeer→onPeerConnected→flush 才送出。
 * 記在 pendingEnqueues：帳號離開時 shutdownP2PAccount 等它寫完，呼叫端才清 outbox。
 */
function enqueue(recipientPubkey: string, payload: string, originalContent?: string, groupMessageId?: string): Promise<void> {
  if (!acceptingMessages) return Promise.resolve();
  const work = persistEnqueue(recipientPubkey, payload, accountGeneration, originalContent, groupMessageId);
  pendingEnqueues.add(work);
  void work.finally(() => pendingEnqueues.delete(work));
  return work;
}

/** `groupMessageId`：群組訊息 → 密文以 messageId 只存一份，這筆只留參照（對應群星 0a544b74，審查 M3） */
async function persistEnqueue(
  recipientPubkey: string, payload: string, generation: number, originalContent?: string, groupMessageId?: string,
): Promise<void> {
  try {
    const count = await getPendingMessageCount(recipientPubkey);
    // 查數量的這段時間換了帳號／帳號離開了 → 不寫（清 outbox 之後不能又寫回一筆上一個帳號的）
    if (!acceptingMessages || generation !== accountGeneration) return;
    if (count >= MAX_QUEUE_PER_RECIPIENT) {
      // 不靜默丟新訊息（§0.29）：警示 + 仍寫入，靠 TTL 清最舊。
      console.error(`[p2pSend] Outbox for ${recipientPubkey.slice(0, 16)} at ${count} (>= ${MAX_QUEUE_PER_RECIPIENT}) — still persisting; TTL reaps oldest`);
    }
    // 群組訊息：送出去之後要轉成「等回條」（originalContent，見 trackOf）
    const entry = { id: newPendingId(), recipientPubkey, messageType: envelopeType(payload), originalContent, createdAt: Date.now() };
    if (groupMessageId) await addGroupPendingMessage(entry, groupMessageId, payload);
    else await addPendingMessage({ ...entry, encryptedPayload: payload });
    diagLog(`[DIAG:P2P:OUTBOX] persisted for ${recipientPubkey.slice(0, 16)} (count=${count + 1})`);
  } catch (err) {
    console.error('[p2pSend] Failed to persist outbox message:', (err as Error)?.message || String(err));
  }
}

/**
 * P2P 連線建立時呼叫：flush 該 peer 在持久化 outbox 裡的所有待送訊息。
 * 內容只走 P2P DataChannel；送成功才從 SQLite 刪除（at-least-once，收端依 message id dedup）。
 * 保序：某筆送失敗（DataChannel 尚未 OPEN）→ 停在該筆，其後保留待下次 flush。
 *
 * ⚠️ 同一個 peer 的 flush 要**排隊**（稽核 M3，對應 AegisPlay B31）：DataChannel open（自己的 channel＋
 * ondatachannel 各一次）、X3DH_INIT 後都會觸發 flush，兩個同時跑會把同一批密文各送一次 → 對方第二次解密失敗
 * → 要求重建 session → 重建時把 outbox 刪掉，排隊中的訊息就沒了。排隊後第二次 flush 重讀佇列，送過的已刪，不會重送。
 */
const flushChains = new Map<string, Promise<number>>();
export function flushQueueForPeer(recipientPubkey: string): Promise<number> {
  const prev = flushChains.get(recipientPubkey) ?? Promise.resolve(0);
  const run = prev.catch(() => 0).then(() => flushQueueForPeerNow(recipientPubkey));
  flushChains.set(recipientPubkey, run);
  void run.finally(() => { if (flushChains.get(recipientPubkey) === run) flushChains.delete(recipientPubkey); }).catch(() => {});
  return run;
}

async function flushQueueForPeerNow(recipientPubkey: string): Promise<number> {
  // 這次 flush 屬於哪個帳號：中途換了帳號（或帳號離開）就停手，讀出來的待送與加密結果都不送（帳號隔離）
  const generation = accountGeneration;
  const encrypt = outboxEncryptOwner === accountOwner ? _outboxEncrypt : null;
  const stale = () => !acceptingMessages || generation !== accountGeneration || !_sendToPeer;
  if (!_sendToPeer) {
    diagLog(`[DIAG:P2P:FLUSH] Skipped for ${recipientPubkey.slice(0, 16)}: _sendToPeer not registered`);
    return 0;
  }

  let pending;
  try {
    pending = await getPendingMessagesForRecipient(recipientPubkey);
  } catch (err) {
    console.error('[p2pSend] Failed to read outbox:', (err as Error)?.message || String(err));
    return 0;
  }
  if (stale()) return 0;
  if (pending.length === 0) {
    diagLog(`[DIAG:P2P:FLUSH] Empty outbox for ${recipientPubkey.slice(0, 16)}`);
    return 0;
  }

  // 已經不同群的人（名冊事件會清掉，這裡擋還沒清到的競態）：群組的待送不送、只跳過不刪（名單載入失敗時不誤刪）
  const relation = relationOf(recipientPubkey);
  const groupBlocked = !!relation && !relation.fellowMember;
  let sentCount = 0;
  for (const msg of pending) {
    if (stale()) break;
    if (groupBlocked && GROUP_OUTBOX_TYPES.has(msg.messageType)) continue;
    // 「等回條」條目（1 對 1：B33；群組：對應群星 8708fa6f）：剛送出的給對方時間回條，不擋後面的；太久沒回條、
    //   或送出後通道換過 → 再送一次（1 對 1 用當下的 session 重新加密；群組原封不動）
    if (isInflightType(msg.messageType)) {
      const group = msg.messageType === GROUP_INFLIGHT_TYPE;
      const awaitedId = awaitedMessageId(msg);
      if (awaitedId) expectAck(recipientPubkey, awaitedId, group);   // 名單被擠掉的、重開 App 後讀到的也認得回條
      if (!inflightDue(msg.lastRetryAt ?? msg.createdAt, recipientPubkey)) continue;
      const giveUp = async () => {
        if (awaitedId) awaitingAcks.delete(ackKey(recipientPubkey, awaitedId));
        await removePendingMessage(msg.id, msg.payloadRef).catch(() => {});
      };
      if (msg.retryCount >= INFLIGHT_MAX_RESENDS) {
        console.error('[p2pSend] no delivery receipt after', INFLIGHT_MAX_RESENDS, 'resends — giving up on', msg.id.slice(0, 20));
        await giveUp();
        continue;
      }
      let resendPayload: string | null = null;
      if (group) {
        resendPayload = msg.encryptedPayload;
        if (!resendPayload) { await giveUp(); continue; }   // 共用的那份密文不見了（不該發生）→ 這筆送不出去，清掉
      } else {
        if (!encrypt) continue;                              // 還沒註冊（冷啟動）→ 下次 flush 再試
        try {
          const inner = (JSON.parse(msg.encryptedPayload) as { payload?: unknown })?.payload;
          const serialized = typeof inner === 'string' ? await encrypt(recipientPubkey, inner) : null;
          if (serialized) resendPayload = JSON.stringify({ type: 'encrypted_message', payload: serialized });
        } catch { /* 這次加密不了：留著，下次 flush 再試 */ }
        if (stale()) break;
        if (!resendPayload) continue;                        // 沒有 session：等 session 建好後的 flush
      }
      if (stale() || !_sendToPeer) break;
      if (resendPayload.length > DC_MAX_MESSAGE_CHARS) {
        console.error('[p2pSend] awaiting-receipt entry can never fit a DataChannel message — giving up on', msg.id.slice(0, 20));
        await giveUp();
        continue;
      }
      let resent = false;
      try { resent = _sendToPeer(recipientPubkey, resendPayload); } catch { /* 通道狀態不對 */ }
      if (!resent) break;                                         // 通道沒開：這筆與其後等下次
      await updatePendingMessageRetry(msg.id).catch(() => {});    // 留著，繼續等回條
      console.error('[p2pSend] resent (no receipt yet) →', recipientPubkey.slice(0, 16), group ? 'group' : '1:1', 'try', msg.retryCount + 1);
      continue;
    }
    // 「待加密」條目：用當下 session 現場加密（無 session → 保留並停在此筆維持順序）
    let wirePayload = msg.encryptedPayload;
    if (msg.payloadRef && !wirePayload) {                  // 共用的群組密文不見了（不該發生）→ 送不出去，清掉
      console.error('[p2pSend] group outbox entry lost its stored ciphertext — removing', msg.id.slice(0, 20));
      await removePendingMessage(msg.id, msg.payloadRef).catch(() => {});
      continue;
    }
    if (msg.messageType === 'plaintext_pending') {
      if (!encrypt) break; // encrypt 尚未註冊（cold start）、或是上一個帳號的 → 下次 flush 再試
      let serialized: string | null = null;
      try {
        const inner = (JSON.parse(msg.encryptedPayload) as { payload?: string })?.payload;
        if (typeof inner === 'string') serialized = await encrypt(recipientPubkey, inner);
      } catch (err) {
        devWarn('[p2pSend] plaintext-pending encrypt error:', err);
        break; // 不是「沒有 session」的加密錯誤：不去催對方重建 session（對應群星），下次 flush 再試
      }
      if (stale()) break;
      if (!serialized) {
        diagLog(`[DIAG:P2P:FLUSH] plaintext-pending waits for session — hold ${recipientPubkey.slice(0, 16)}`);
        nudgeOutboxSession(recipientPubkey); // 重試：第一發可能沒送到（MQTT 當時斷線）
        break; // session 還沒好 → 整批停住保序，等 session 建立後的 flush
      }
      wirePayload = JSON.stringify({ type: 'encrypted_message', payload: serialized });
      console.error('[p2pSend] plaintext-pending encrypted with fresh session →', recipientPubkey.slice(0, 16));
    }
    // 永遠送不出去的超大條目（傳輸統一 X5）：以前每次 flush 都停在這筆，該好友之後的訊息全部卡住 30 天
    if (wirePayload.length > DC_MAX_MESSAGE_CHARS) {
      console.error('[p2pSend] outbox entry can never fit a DataChannel message — removing so it stops blocking', msg.id.slice(0, 20), wirePayload.length);
      await removePendingMessage(msg.id, msg.payloadRef).catch(() => {});
      continue;
    }
    if (stale() || !_sendToPeer) break;
    let sent = false;
    try {
      sent = _sendToPeer(recipientPubkey, wirePayload);
    } catch (err) {
      devWarn('[p2pSend] Error sending outbox message:', err);
    }
    if (!sent) {
      // DataChannel 尚未 OPEN → 保留此筆與其後（維持順序），記一次重試後等下次 flush
      await updatePendingMessageRetry(msg.id).catch(() => {});
      break;
    }
    const removeSent = () => removePendingMessage(msg.id, msg.payloadRef).catch((err) =>
      console.error('[p2pSend] Sent but failed to remove from outbox (may resend):', (err as Error)?.message || String(err)));
    // 送出去了，但還沒收到回條 → 轉成「等回條」（B33）。寫完才換下一筆：緊接著的 flush 看得到它
    const track = trackOf(msg.originalContent)
      ?? (msg.messageType === 'plaintext_pending' ? trackOfPlaintextPending(msg.encryptedPayload) : null);
    if (track && 'group' in track) {
      // 群組：先寫「等回條」再刪排隊那筆 —— 共用的那份密文一直有人參照，不會被刪了又寫（對應群星 0a544b74）
      await trackInflight(recipientPubkey, track, wirePayload);
      await removeSent();
    } else {
      // 1 對 1：先刪排隊那筆（同一則的明文不會同時有兩筆「待送」）
      await removeSent();
      if (track) await trackInflight(recipientPubkey, track, wirePayload);
    }
    sentCount++;
  }

  // 還有在等回條的（剛重送的、還沒到 30 秒的）→ 排下一次檢查
  if (!stale() && pending.some((m) => isInflightType(m.messageType))) armInflightCheck(recipientPubkey);

  if (sentCount > 0) {
    diagLog(`[DIAG:P2P:FLUSH] Sent ${sentCount}/${pending.length} outbox messages to ${recipientPubkey.slice(0, 16)}`);
  } else {
    diagLog(`[DIAG:P2P:FLUSH] Called for ${recipientPubkey.slice(0, 16)} but 0/${pending.length} sent (DataChannel not ready?)`);
  }
  return sentCount;
}

// ============================================
// 主要 API
// ============================================

/**
 * 透過 P2P DataChannel 發送訊息
 *
 * @param recipientPubkey - 接收者公鑰 (base64)
 * @param payload - P2P envelope JSON（已包含 type + payload）
 * @returns true = 已立即發送，false = 已加入佇列（等待 P2P 連線）
 */
export function sendViaP2P(
  recipientPubkey: string,
  payload: string,
  /**
   * 聊天訊息帶上：送出後留一份等對方回條，沒回條就重送。1 對 1（`{ messageId, plaintext }`）留明文、重新加密
   * （群星 B33）；群組（`{ messageId, group: true }`）留送出去的密文、原封不動重送（對應群星 8708fa6f）。
   * 控制訊息（回條本身、信令）不帶
   */
  track?: DeliveryTrack,
): boolean {
  const generation = accountGeneration;
  // 超過上限的訊息分塊也送不出去（傳輸統一 X5）：不進 outbox，免得之後擋住該好友的其他訊息
  if (payload.length > DC_MAX_MESSAGE_CHARS) {
    console.error('[p2pSend] message too large for P2P, not queued:', payload.length, 'chars');
    return false;
  }
  const original = track ? JSON.stringify(track) : undefined;
  const groupMessageId = track && 'group' in track ? track.messageId || undefined : undefined;
  if (!_isConnectedTo || !_sendToPeer || !_connectPeer) {
    devWarn('[p2pSend] P2P functions not registered yet, persisting to outbox');
    void enqueue(recipientPubkey, payload, original, groupMessageId);
    return false;
  }

  // 嘗試直接發送
  if (_isConnectedTo(recipientPubkey)) {
    const sent = _sendToPeer(recipientPubkey, payload);
    if (sent) {
      diagLog('[DIAG:SEND] P2P ok to:', recipientPubkey.slice(0, 16));
      if (track) void trackInflight(recipientPubkey, track, payload);
      return true;
    }
    // DataChannel 狀態不對 → 寫入持久化 outbox（非 MQTT fallback，仍走 P2P）
    devLog('[p2pSend] P2P send failed despite isConnectedTo=true, persisting to outbox');
  }

  // P2P 未連線或發送失敗 → 寫入持久化 outbox + 建立 P2P
  diagLog('[DIAG:SEND] No P2P, persisted to outbox for:', recipientPubkey.slice(0, 16));
  void enqueue(recipientPubkey, payload, original, groupMessageId);

  // ADR-016 背壓：連續失敗時暫停建連
  if (isBackpressured()) {
    devLog('[p2pSend] Backpressured, skipping connectPeer');
    return false;
  }

  _connectPeer(recipientPubkey).catch((err) => {
    if (generation === accountGeneration) recordConnectFailure();
    diagLog('[DIAG:SEND] connectPeer failed:', (err as Error)?.message || String(err));
  });

  return false;
}

/**
 * 啟動時呼叫：把持久化 outbox 裡仍待送的訊息重新觸發投遞 —— 對每個有待送的 peer connectPeer，
 * 連上後 onPeerConnected → flushQueueForPeer 自動送出。這是跨 reload/重啟/crash「訊息絕不消失」的關鍵。
 * （連不上也無妨：presence 翻 online 時 AppProvider 仍會 connectPeer，flush 一律從 SQLite 讀。）
 */
export async function loadOutbox(): Promise<void> {
  const generation = accountGeneration;
  if (!_connectPeer) {
    devWarn('[p2pSend] loadOutbox: P2P functions not registered yet');
    return;
  }
  let all;
  try {
    all = await getAllPendingMessages();
  } catch (err) {
    console.error('[p2pSend] loadOutbox failed to read:', (err as Error)?.message || String(err));
    return;
  }
  if (!acceptingMessages || generation !== accountGeneration) return;
  // 上次留下的「等回條」：對方的回條要認得（不在名單上的回條一律不處理，見 confirmDelivered）
  for (const m of all) {
    const awaitedId = awaitedMessageId(m);
    if (awaitedId) expectAck(m.recipientPubkey, awaitedId, m.messageType === GROUP_INFLIGHT_TYPE);
  }
  // 只撥給「有東西可送」的人：1 對 1 的給好友、群組的給現在還同群的成員（對應群星 6d381b43）。名單還沒載入 → 照舊都撥
  const kinds = new Map<string, { group: boolean; direct: boolean }>();
  for (const m of all) {
    const k = kinds.get(m.recipientPubkey) ?? { group: false, direct: false };
    kinds.set(m.recipientPubkey, GROUP_OUTBOX_TYPES.has(m.messageType) ? { ...k, group: true } : { ...k, direct: true });
  }
  const recipients = [...kinds].filter(([pk, k]) => {
    const relation = relationOf(pk);
    if (!relation || (k.direct && relation.friend) || (k.group && relation.fellowMember)) return true;
    diagLog(`[DIAG:OUTBOX] loadOutbox skips ${pk.slice(0, 16)}: no longer a friend or fellow member`);
    return false;
  }).map(([pk]) => pk);
  if (recipients.length === 0) return;
  console.error(`[p2pSend] loadOutbox: ${all.length} pending across ${recipients.length} peer(s) → reconnecting`);
  for (const pk of recipients) {
    if (!acceptingMessages || generation !== accountGeneration || !_connectPeer || isBackpressured()) break;
    _connectPeer(pk).catch((err) => {
      if (generation === accountGeneration) recordConnectFailure();
      diagLog('[DIAG:OUTBOX] loadOutbox connectPeer failed:', (err as Error)?.message || String(err));
    });
  }
}

/**
 * 取得某 peer 的 outbox 待送數量（診斷用）
 */
export async function getQueueSize(recipientPubkey: string): Promise<number> {
  try {
    return await getPendingMessageCount(recipientPubkey);
  } catch {
    return 0;
  }
}

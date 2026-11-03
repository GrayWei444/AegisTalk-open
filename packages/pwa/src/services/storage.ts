/**
 * Storage Service - 本地持久化儲存
 *
 * 透過 database.ts 統一 SQLite 資料庫實現本地持久化
 * - Android/iOS：原生 SQLite
 * - Web (PWA)：sql.js + IndexedDB（由 @capacitor-community/sqlite 管理）
 *
 * 伺服器零知識：所有資料只存在客戶端
 */

import * as db from './database';
import { wipeRememberedTopics } from './topicMemory';
import type { GroupRole } from '../types';
import type { PushSubscriptionData } from '../types';

let _initialized = false;

/**
 * 初始化資料庫
 */
export async function initStorage(): Promise<void> {
  if (_initialized) return;
  await db.initDatabase();
  _initialized = true;
}

// ============================================
// 聯絡人操作
// ============================================

export interface Contact {
  pubkey: string;
  nickname: string;
  avatar: string;
  addedAt: number;
  trustLevel: 'verified' | 'unverified';
  /** 不再存（開源第 5b 步）：好友的推播訂閱以前經 broker 明文交換、存在這裡；現在推播只走 chat 伺服器（webPush.ts） */
  pushSubscription?: PushSubscriptionData;
  /** 是否跳過詐騙偵測（信任聯絡人白名單） */
  bypassFraudDetection?: boolean;
  /** 對方 X3DH signed pre-key（Base64）— 供帳號恢復後重建 session */
  signedPreKey?: string;
  /** 對方 X3DH signed pre-key 簽章（Base64）*/
  signature?: string;
}

export async function addContact(contact: Contact): Promise<void> {
  await initStorage();

  // 好友的推播訂閱不再存（開源第 5b 步）：一律寫 NULL，舊的由 database.ts 第 13 版遷移清掉
  const pushSubscriptionJson = null;

  // INSERT OR REPLACE 會清掉舊 row，但 signedPreKey/signature 可能由不同來源分批寫入
  // （加好友時有、其他更新時沒帶）→ 用 COALESCE 保留既有值，避免覆蓋成 null
  await db.run(
    `INSERT INTO contacts (pubkey, nickname, avatar, added_at, trust_level, push_subscription, bypass_fraud_detection, signed_pre_key, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       nickname=excluded.nickname, avatar=excluded.avatar, added_at=excluded.added_at,
       trust_level=excluded.trust_level, push_subscription=excluded.push_subscription,
       bypass_fraud_detection=excluded.bypass_fraud_detection,
       signed_pre_key=COALESCE(excluded.signed_pre_key, contacts.signed_pre_key),
       signature=COALESCE(excluded.signature, contacts.signature)`,
    [contact.pubkey, contact.nickname, contact.avatar, contact.addedAt, contact.trustLevel, pushSubscriptionJson, contact.bypassFraudDetection ? 1 : 0, contact.signedPreKey ?? null, contact.signature ?? null]
  );

  // 同時建立對話
  const conversationId = `conv-${contact.pubkey}`;
  await db.run(
    `INSERT OR IGNORE INTO conversations (id, peer_pubkey, type, created_at, updated_at)
     VALUES (?, ?, 'direct', ?, ?)`,
    [conversationId, contact.pubkey, contact.addedAt, contact.addedAt]
  );
}

interface ContactRow {
  pubkey: string;
  nickname: string;
  avatar: string;
  added_at: number;
  trust_level: string;
  push_subscription: string | null;
  bypass_fraud_detection: number;
  signed_pre_key: string | null;
  signature: string | null;
}

function rowToContact(row: ContactRow): Contact {
  return {
    pubkey: row.pubkey,
    nickname: row.nickname,
    avatar: row.avatar,
    addedAt: row.added_at,
    trustLevel: row.trust_level as 'verified' | 'unverified',
    bypassFraudDetection: row.bypass_fraud_detection === 1,
    signedPreKey: row.signed_pre_key ?? undefined,
    signature: row.signature ?? undefined,
  };
}

export async function getContact(pubkey: string): Promise<Contact | null> {
  await initStorage();

  const row = await db.queryOne<ContactRow>(
    `SELECT pubkey, nickname, avatar, added_at, trust_level, push_subscription, bypass_fraud_detection, signed_pre_key, signature FROM contacts WHERE pubkey = ?`,
    [pubkey]
  );

  return row ? rowToContact(row) : null;
}

export async function getAllContacts(): Promise<Contact[]> {
  await initStorage();

  const rows = await db.query<ContactRow>(
    `SELECT pubkey, nickname, avatar, added_at, trust_level, push_subscription, bypass_fraud_detection, signed_pre_key, signature FROM contacts ORDER BY added_at DESC`
  );

  return rows.map(rowToContact);
}

/**
 * 群組的待送（p2pSend 的 envelope 型別）：密文用群組金鑰加密、跟 1-1 session 無關（對應群星 8708fa6f）。
 * 跟 p2pSend 的 GROUP_OUTBOX_TYPES 一致（group_outbox_membership_self_test 比對）
 */
const GROUP_OUTBOX_TYPES_SQL = `'group_key_message', 'group_inflight', 'group_msg_ack'`;

export async function removeContact(pubkey: string): Promise<void> {
  await initStorage();

  // 先刪 messages（子查詢 conversations 還在），再刪 conversations，最後刪 contacts
  await db.run(
    `DELETE FROM messages WHERE conversation_id IN
     (SELECT id FROM conversations WHERE peer_pubkey = ?)`,
    [pubkey]
  );
  await db.run(`DELETE FROM conversations WHERE peer_pubkey = ?`, [pubkey]);
  await db.run(`DELETE FROM contacts WHERE pubkey = ?`, [pubkey]);
  // 給他的待送訊息（含明文的 plaintext_pending）也清掉：否則 loadOutbox 會繼續對前好友撥號 30 天，
  //   對方還接受連線就照送（對應群星 P3-5）。群組的不清：他可能還跟我在同一個群，群訊不分是不是好友
  //   （LINE 式群組，對應群星 8708fa6f）
  await db.run(
    `DELETE FROM pending_messages WHERE recipient_pubkey = ? AND message_type NOT IN (${GROUP_OUTBOX_TYPES_SQL})`,
    [pubkey],
  );
}

/**
 * 設定聯絡人的信任白名單狀態（跳過詐騙偵測）
 */
export async function setContactTrustedStatus(pubkey: string, trusted: boolean): Promise<void> {
  await initStorage();

  await db.run(
    `UPDATE contacts SET bypass_fraud_detection = ? WHERE pubkey = ?`,
    [trusted ? 1 : 0, pubkey]
  );
}

/**
 * 檢查聯絡人是否在信任白名單中
 */
export async function isContactTrusted(pubkey: string): Promise<boolean> {
  await initStorage();

  const row = await db.queryOne<{ bypass_fraud_detection: number }>(
    `SELECT bypass_fraud_detection FROM contacts WHERE pubkey = ?`,
    [pubkey]
  );

  return row?.bypass_fraud_detection === 1;
}

/**
 * 取得所有信任白名單聯絡人
 */
export async function getTrustedContacts(): Promise<Contact[]> {
  await initStorage();

  const rows = await db.query<ContactRow>(
    `SELECT pubkey, nickname, avatar, added_at, trust_level, push_subscription, bypass_fraud_detection
     FROM contacts WHERE bypass_fraud_detection = 1 ORDER BY added_at DESC`
  );

  return rows.map(rowToContact);
}

// ============================================
// 訊息操作
// ============================================

export interface StoredMessage {
  id: string;
  conversationId: string;
  senderPubkey: string;
  content: string;
  type: 'text' | 'image' | 'file' | 'voice' | 'payment';
  createdAt: number;
  ttl: number;
  expiresAt: number | null;
  readAt: number | null;
  isOutgoing: boolean;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  /** 視圖群組：此訊息屬於哪些群組 */
  groupIds?: string[];
  /** 額外元資料（如語音訊息的 voiceData） */
  metadata?: string;
  /** L2 風險評估結果（JSON 字串） */
  riskResult?: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_pubkey: string;
  content: string;
  msg_type: string;
  created_at: number;
  ttl: number;
  expires_at: number | null;
  read_at: number | null;
  is_outgoing: number;
  status: string;
  group_ids: string | null;
  metadata: string | null;
  risk_result: string | null;
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderPubkey: row.sender_pubkey,
    content: row.content,
    type: row.msg_type as StoredMessage['type'],
    createdAt: row.created_at,
    ttl: row.ttl,
    expiresAt: row.expires_at,
    readAt: row.read_at,
    isOutgoing: row.is_outgoing === 1,
    status: row.status as StoredMessage['status'],
    groupIds: row.group_ids ? JSON.parse(row.group_ids) : undefined,
    metadata: row.metadata || undefined,
    riskResult: row.risk_result || undefined,
  };
}

export async function saveMessage(message: StoredMessage): Promise<void> {
  await initStorage();

  // conversations 目前只在 saveContact 建立 → 群組成員若不是好友（非 contact）就沒有對話列，
  // 存他的群訊會撞 messages.conversation_id 的 FOREIGN KEY → 整則訊息被丟掉
  // （E2E 4.6 實證：Bob 解密得出 Charlie 的群訊，卻 FOREIGN KEY constraint failed）。
  // 對話列只是訊息的容器（好友清單來自 contacts，不讀 conversations），缺就補建。
  const peerPubkey = message.conversationId.startsWith('conv-')
    ? message.conversationId.slice('conv-'.length)
    : null;
  if (peerPubkey) {
    await db.run(
      `INSERT OR IGNORE INTO conversations (id, peer_pubkey, type, created_at, updated_at)
       VALUES (?, ?, 'direct', ?, ?)`,
      [message.conversationId, peerPubkey, message.createdAt, message.createdAt]
    );
  }

  const groupIdsJson = message.groupIds ? JSON.stringify(message.groupIds) : null;

  /**
   * ⚠️ id 是對方送來的（稽核 M6，對應 AegisPlay B35）：以前 `INSERT OR REPLACE`，群組成員拿別人（或你自己送出的）
   * 訊息 id 發一則，就把那一列整個換掉。現在先 `INSERT OR IGNORE`，已存在時只允許**同一個寄件者、同一個對話**更新
   * （自己的訊息改狀態那種）。不用 `ON CONFLICT … DO UPDATE`：舊 Android 的 SQLite 不支援。
   */
  const values = [
    message.id,
    message.conversationId,
    message.senderPubkey,
    message.content,
    message.type,
    message.createdAt,
    message.ttl,
    message.expiresAt,
    message.readAt,
    message.isOutgoing ? 1 : 0,
    message.status,
    groupIdsJson,
    message.metadata || null,
    message.riskResult || null,
  ];
  await db.run(
    `INSERT OR IGNORE INTO messages
     (id, conversation_id, sender_pubkey, content, msg_type, created_at, ttl, expires_at, read_at, is_outgoing, status, group_ids, metadata, risk_result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values,
  );
  await db.run(
    `UPDATE messages SET content = ?, msg_type = ?, created_at = ?, ttl = ?, expires_at = ?, read_at = ?,
       is_outgoing = ?, status = ?, group_ids = ?, metadata = ?, risk_result = ?
     WHERE id = ? AND sender_pubkey = ? AND conversation_id = ?`,
    [...values.slice(3), values[0], values[2], values[1]],
  );

  // 更新對話的 updated_at
  await db.run(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`,
    [message.createdAt, message.conversationId]
  );
}

export async function getMessages(peerPubkey: string, limit = 50, offset = 0): Promise<StoredMessage[]> {
  await initStorage();

  const conversationId = `conv-${peerPubkey}`;

  const rows = await db.query<MessageRow>(
    `SELECT id, conversation_id, sender_pubkey, content, msg_type, created_at, ttl, expires_at, read_at, is_outgoing, status, group_ids, metadata, risk_result
     FROM messages
     WHERE conversation_id = ? AND (group_ids IS NULL OR group_ids = '' OR group_ids = '[]')
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [conversationId, limit, offset]
  );

  return rows.map(rowToMessage).reverse();
}

export async function updateMessageStatus(messageId: string, status: StoredMessage['status']): Promise<void> {
  await initStorage();
  await db.run(`UPDATE messages SET status = ? WHERE id = ?`, [status, messageId]);
}

export async function markMessageAsRead(messageId: string): Promise<void> {
  await initStorage();
  await db.run(`UPDATE messages SET read_at = ? WHERE id = ?`, [Date.now(), messageId]);
}

// 把某群組所有「對方傳來、未讀」的訊息標已讀（WHERE 子句與 getGroupUnreadCount 對齊 → 標完該群未讀數=0）。
// 群組訊息＝1-1 訊息多帶 group_ids 標記；讀群組要持久化 read_at，否則 restart 後 getGroupUnreadCount 又數成未讀。
export async function markGroupMessagesAsRead(groupId: string): Promise<void> {
  await initStorage();
  await db.run(
    `UPDATE messages SET read_at = ? WHERE group_ids LIKE ? ESCAPE '\\' AND read_at IS NULL AND is_outgoing = 0`,
    [Date.now(), `%"${escapeLike(groupId)}"%`]
  );
}

export async function deleteMessage(messageId: string): Promise<void> {
  await initStorage();
  await db.run(`DELETE FROM messages WHERE id = ?`, [messageId]);
}

/**
 * 這個寄件者的這則訊息已經存過了嗎（群組訊息收到重送時去重：只回條、不再算未讀，對應群星 8708fa6f）。
 * 要對上寄件者：別人拿同一個 id 寄來的不算（稽核 M6，對應群星 B35）。
 */
export async function hasMessageFrom(messageId: string, senderPubkey: string): Promise<boolean> {
  await initStorage();
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM messages WHERE id = ? AND sender_pubkey = ? LIMIT 1`,
    [messageId, senderPubkey],
  );
  return !!row;
}

// ============================================
// 視圖群組：按群組 ID 查詢訊息
// ============================================

/** 轉義 LIKE pattern 中的特殊字元 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/**
 * 群組「為所有人刪除」的收端（對應群星 P3-1）：只刪「這個群、這個作者寄來」的那一則，別人不能刪我的。
 * 回傳是否真的刪了。
 */
export async function deleteGroupMessageFrom(messageId: string, groupId: string, senderPubkey: string): Promise<boolean> {
  await initStorage();
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM messages WHERE id = ? AND sender_pubkey = ? AND is_outgoing = 0 AND group_ids LIKE ? ESCAPE '\\'`,
    [messageId, senderPubkey, `%"${escapeLike(groupId)}"%`],
  );
  if (!row) return false;
  await deleteMessage(messageId);
  return true;
}

/**
 * 取得屬於特定群組的所有訊息（視圖查詢）
 */
export async function getMessagesByGroupId(groupId: string, limit = 100, offset = 0): Promise<StoredMessage[]> {
  await initStorage();

  const rows = await db.query<MessageRow>(
    `SELECT id, conversation_id, sender_pubkey, content, msg_type, created_at, ttl, expires_at, read_at, is_outgoing, status, group_ids, metadata, risk_result
     FROM messages
     WHERE group_ids LIKE ? ESCAPE '\\'
     ORDER BY created_at ASC
     LIMIT ? OFFSET ?`,
    [`%"${escapeLike(groupId)}"%`, limit, offset]
  );

  return rows.map(rowToMessage);
}

/**
 * 為訊息新增群組 ID（將訊息加入群組視圖）
 */
export async function addGroupIdToMessage(messageId: string, groupId: string): Promise<void> {
  await initStorage();

  const row = await db.queryOne<{ group_ids: string | null }>(
    `SELECT group_ids FROM messages WHERE id = ?`,
    [messageId]
  );
  if (!row) return;

  const groupIds: string[] = row.group_ids ? JSON.parse(row.group_ids) : [];
  if (groupIds.includes(groupId)) return;

  groupIds.push(groupId);
  await db.run(`UPDATE messages SET group_ids = ? WHERE id = ?`, [JSON.stringify(groupIds), messageId]);
}

/**
 * 從訊息移除群組 ID（將訊息從群組視圖移除）
 */
export async function removeGroupIdFromMessage(messageId: string, groupId: string): Promise<void> {
  await initStorage();

  const row = await db.queryOne<{ group_ids: string | null }>(
    `SELECT group_ids FROM messages WHERE id = ?`,
    [messageId]
  );
  if (!row?.group_ids) return;

  const groupIds: string[] = JSON.parse(row.group_ids);
  const newGroupIds = groupIds.filter((id) => id !== groupId);

  await db.run(
    `UPDATE messages SET group_ids = ? WHERE id = ?`,
    [newGroupIds.length > 0 ? JSON.stringify(newGroupIds) : null, messageId]
  );
}

/**
 * 取得群組的訊息數量
 */
export async function getGroupMessageCount(groupId: string): Promise<number> {
  await initStorage();

  const row = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM messages WHERE group_ids LIKE ? ESCAPE '\\'`,
    [`%"${escapeLike(groupId)}"%`]
  );
  return row?.cnt ?? 0;
}

export async function getGroupUnreadCount(groupId: string): Promise<number> {
  await initStorage();

  const row = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM messages WHERE group_ids LIKE ? ESCAPE '\\' AND read_at IS NULL AND is_outgoing = 0`,
    [`%"${escapeLike(groupId)}"%`]
  );
  return row?.cnt ?? 0;
}

export async function deleteExpiredMessages(): Promise<number> {
  await initStorage();

  const now = Date.now();

  await db.run(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?`, [now]);
  await db.run(
    `DELETE FROM messages WHERE ttl = -1 AND read_at IS NOT NULL AND read_at < ?`,
    [now - 30000]
  );

  // 注意：統一 database 不提供 getRowsModified，回傳 run 的 changes
  return 0;
}

// ============================================
// Ratchet 狀態操作
// ============================================

export async function saveRatchetState(peerPubkey: string, stateBlob: string): Promise<void> {
  await initStorage();
  await db.run(
    `INSERT OR REPLACE INTO ratchet_states (peer_pubkey, state_blob, updated_at)
     VALUES (?, ?, ?)`,
    [peerPubkey, stateBlob, Date.now()]
  );
}

export async function getRatchetState(peerPubkey: string): Promise<string | null> {
  await initStorage();

  const row = await db.queryOne<{ state_blob: string }>(
    `SELECT state_blob FROM ratchet_states WHERE peer_pubkey = ?`,
    [peerPubkey]
  );

  return row?.state_blob ?? null;
}

/**
 * 刪除指定 peer 的 ratchet state（移除好友時呼叫）
 *
 * 不刪除這個 row 的話，下次重加好友時 PWA 仍用舊 ratchet 加密訊息，
 * 但對方 X3DH 已 reset 新 session → AEAD decrypt 永遠失敗。
 * （AegisBot 撞過此問題，2026-05-03 修）
 */
export async function deleteRatchetState(peerPubkey: string): Promise<void> {
  await initStorage();
  await db.run(`DELETE FROM ratchet_states WHERE peer_pubkey = ?`, [peerPubkey]);
}

// ============================================
// Phase 5: 待發送訊息隊列（離線訊息）
// ============================================

export interface PendingMessage {
  id: string;
  recipientPubkey: string;
  /** 群組的（有 payloadRef）讀出來時已經從 group_outbox_payloads 補上那份密文 */
  encryptedPayload: string;
  messageType: string;
  originalContent?: string;
  createdAt: number;
  retryCount: number;
  lastRetryAt: number | null;
  /** 群組訊息：密文在 group_outbox_payloads 的哪一筆（＝messageId）；1 對 1 的沒有 */
  payloadRef?: string;
}

interface PendingMessageRow {
  id: string;
  recipient_pubkey: string;
  encrypted_payload: string;
  message_type: string;
  original_content: string | null;
  created_at: number;
  retry_count: number;
  last_retry_at: number | null;
  payload_ref?: string | null;
}

function rowToPendingMessage(row: PendingMessageRow): PendingMessage {
  return {
    id: row.id,
    recipientPubkey: row.recipient_pubkey,
    encryptedPayload: row.encrypted_payload ?? '',
    messageType: row.message_type,
    originalContent: row.original_content || undefined,
    createdAt: row.created_at,
    retryCount: row.retry_count,
    lastRetryAt: row.last_retry_at,
    payloadRef: row.payload_ref || undefined,
  };
}

const PENDING_COLUMNS = `p.id, p.recipient_pubkey, p.message_type, p.original_content, p.created_at, p.retry_count, p.last_retry_at, p.payload_ref`;

export async function addPendingMessage(message: Omit<PendingMessage, 'retryCount' | 'lastRetryAt' | 'payloadRef'>): Promise<void> {
  await initStorage();

  await db.run(
    `INSERT OR REPLACE INTO pending_messages
     (id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at, retry_count, last_retry_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    [
      message.id,
      message.recipientPubkey,
      message.encryptedPayload,
      message.messageType,
      message.originalContent || null,
      message.createdAt,
    ]
  );
}

/**
 * 群組訊息的待送／等回條（對應群星 0a544b74，審查 M3）：密文以 messageId 為鍵只存一份（已經有就不重寫），這一筆只留參照。
 * 兩句在同一個 transaction：不會有「參照寫好了、密文卻剛被另一個收件人的回條刪掉」的空檔。
 */
export async function addGroupPendingMessage(
  message: Omit<PendingMessage, 'retryCount' | 'lastRetryAt' | 'payloadRef' | 'encryptedPayload'>,
  messageId: string,
  payload: string,
): Promise<void> {
  await initStorage();
  await db.runBatch([
    {
      statement: `INSERT OR IGNORE INTO group_outbox_payloads (message_id, payload, created_at) VALUES (?, ?, ?)`,
      values: [messageId, payload, message.createdAt],
    },
    {
      statement: `INSERT OR REPLACE INTO pending_messages
        (id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at, retry_count, last_retry_at, payload_ref)
        VALUES (?, ?, '', ?, ?, ?, 0, NULL, ?)`,
      values: [message.id, message.recipientPubkey, message.messageType, message.originalContent || null, message.createdAt, messageId],
    },
  ]);
}

/** 那份群組密文已經沒有任何待送參照 → 刪掉（還有人參照就留著） */
export async function releaseGroupOutboxPayload(messageId: string): Promise<void> {
  await initStorage();
  await db.run(
    `DELETE FROM group_outbox_payloads WHERE message_id = ? AND NOT EXISTS (SELECT 1 FROM pending_messages WHERE payload_ref = ?)`,
    [messageId, messageId],
  );
}

/** 一次清掉所有沒人參照的群組密文（成批刪待送之後、TTL 清理時） */
async function sweepGroupOutboxPayloads(): Promise<void> {
  await db.run(
    `DELETE FROM group_outbox_payloads WHERE message_id NOT IN
     (SELECT payload_ref FROM pending_messages WHERE payload_ref IS NOT NULL)`,
  );
}

export async function getPendingMessagesForRecipient(recipientPubkey: string): Promise<PendingMessage[]> {
  await initStorage();

  // 群組的那筆只存參照：密文從 group_outbox_payloads 補上（每個收件人各讀各的，資料庫裡只有一份）
  const rows = await db.query<PendingMessageRow>(
    `SELECT ${PENDING_COLUMNS}, COALESCE(g.payload, p.encrypted_payload) AS encrypted_payload
     FROM pending_messages p LEFT JOIN group_outbox_payloads g ON g.message_id = p.payload_ref
     WHERE p.recipient_pubkey = ?
     ORDER BY p.created_at ASC`,
    [recipientPubkey]
  );

  return rows.map(rowToPendingMessage);
}

/** 所有待送（loadOutbox 用：只看誰有待送，群組的不補密文） */
export async function getAllPendingMessages(): Promise<PendingMessage[]> {
  await initStorage();

  const rows = await db.query<PendingMessageRow>(
    `SELECT ${PENDING_COLUMNS}, p.encrypted_payload
     FROM pending_messages p
     ORDER BY p.created_at ASC`
  );

  return rows.map(rowToPendingMessage);
}

/** `payloadRef`：群組的那筆 → 刪完看那份密文還有沒有人參照 */
export async function removePendingMessage(messageId: string, payloadRef?: string): Promise<void> {
  await initStorage();
  await db.run(`DELETE FROM pending_messages WHERE id = ?`, [messageId]);
  if (payloadRef) await releaseGroupOutboxPayload(payloadRef);
}

/**
 * 刪掉給某人的**群組**待送（群組金鑰密文、等回條、回條）—— 他已經跟我不同群了（被踢、離開、我退群、群被刪，
 * 對應群星 6d381b43）。1 對 1 的不動（好友關係另外處理，見 removeContact）。沒人參照的群組密文一起清。
 */
export async function deleteGroupPendingMessagesForRecipient(recipientPubkey: string): Promise<void> {
  await initStorage();
  await db.run(
    `DELETE FROM pending_messages WHERE recipient_pubkey = ? AND message_type IN (${GROUP_OUTBOX_TYPES_SQL})`,
    [recipientPubkey],
  );
  await sweepGroupOutboxPayloads();
}

/**
 * 只刪「送給這個人」的那一筆（回條只能清送給回條者的，見 p2pSend.confirmDelivered）。
 * `payloadRef`：群組的那筆 → 刪完看那份密文還有沒有人參照
 */
export async function removePendingMessageForRecipient(messageId: string, recipientPubkey: string, payloadRef?: string): Promise<void> {
  await initStorage();
  await db.run(`DELETE FROM pending_messages WHERE id = ? AND recipient_pubkey = ?`, [messageId, recipientPubkey]);
  if (payloadRef) await releaseGroupOutboxPayload(payloadRef);
}

/**
 * 我自己的群訊「為所有人刪除」：還沒送到（排隊中）或還在等回條的那幾份一起刪掉，免得之後重送把它送回對方手機
 * （群組等回條、重送見 p2pSend）。id 帶收件人的等回條用前綴比對，排隊中的用 originalContent（p2pSend 寫的 track）比對
 */
export async function removePendingGroupMessage(messageId: string): Promise<void> {
  await initStorage();
  const prefix = `ginflight-${messageId}-`;
  await db.run(
    `DELETE FROM pending_messages WHERE substr(id, 1, ?) = ? OR original_content = ?`,
    [prefix.length, prefix, JSON.stringify({ messageId, group: true })],
  );
  await releaseGroupOutboxPayload(messageId);   // 那份共用的群組密文（對應群星 0a544b74）
}

/**
 * 刪掉某 peer 全部 pending(outbox)密文 —— QR 重加好友 reset 時用。
 * 舊密文是用「舊 session」加密的,session reset 後 flush 出去一定 aead → 必須一起清掉,否則污染新 session。
 */
export async function deletePendingMessagesForRecipient(recipientPubkey: string): Promise<void> {
  await initStorage();
  // sessionReset 只該作廢「舊密文」（舊 ratchet 加密、對方注定解不開）。
  // plaintext_pending（無 session 時排隊的待加密訊息）不刪 —— 新 session 建立後照常加密送出，
  // 這正是「session 重置不丟字」的來源（2026-08-19）。
  // 帶著明文的密文條目（聊天訊息，見 p2pSend DeliveryTrack，群星 B33）不用丟：改回「待加密」，新 session 照樣送出。
  const tracked = await db.query<{ id: string; original_content: string }>(
    `SELECT id, original_content FROM pending_messages
     WHERE recipient_pubkey = ? AND message_type NOT IN ('plaintext_pending', 'plaintext_inflight', ${GROUP_OUTBOX_TYPES_SQL})
       AND original_content IS NOT NULL`,
    [recipientPubkey]
  );
  for (const row of tracked) {
    try {
      const plaintext = (JSON.parse(row.original_content) as { plaintext?: unknown }).plaintext;
      if (typeof plaintext !== 'string') continue;
      await db.run(
        `UPDATE pending_messages SET message_type = 'plaintext_pending', encrypted_payload = ?, original_content = NULL WHERE id = ?`,
        [JSON.stringify({ type: 'plaintext_pending', payload: plaintext }), row.id]
      );
    } catch { /* 解析不了就照舊刪 */ }
  }
  // 「等回條」（plaintext_inflight）也是明文、不綁 session，同樣保留（重送時用新 session 加密）。
  // 群組的（群組金鑰密文、等回條、回條）跟 1-1 session 無關，重置後照樣解得開 —— 以前一起被刪，
  //   對方重加好友就漏掉群訊（對應群星 8708fa6f）
  await db.run(
    `DELETE FROM pending_messages WHERE recipient_pubkey = ? AND message_type NOT IN ('plaintext_pending', 'plaintext_inflight', ${GROUP_OUTBOX_TYPES_SQL})`,
    [recipientPubkey]
  );
}

export async function updatePendingMessageRetry(messageId: string): Promise<void> {
  await initStorage();
  await db.run(
    `UPDATE pending_messages SET retry_count = retry_count + 1, last_retry_at = ? WHERE id = ?`,
    [Date.now(), messageId]
  );
}

export async function getPendingMessageCount(recipientPubkey?: string): Promise<number> {
  await initStorage();

  if (recipientPubkey) {
    const row = await db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pending_messages WHERE recipient_pubkey = ?`,
      [recipientPubkey]
    );
    return row?.cnt ?? 0;
  }

  const row = await db.queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM pending_messages`);
  return row?.cnt ?? 0;
}

// 持久化 outbox TTL：30 天（§0.29「訊息絕不消失」— 取代舊 in-memory 佇列的 5min 過期）。
// 對方一個月內上線即可補送；超過才視為過時清掉，避免無限累積。
const PENDING_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupOldPendingMessages(): Promise<number> {
  await initStorage();

  const cutoff = Date.now() - PENDING_MESSAGE_TTL_MS;
  const changes = await db.run(`DELETE FROM pending_messages WHERE created_at < ?`, [cutoff]);
  // 過期的群組待送參照沒了 → 那份密文也清（只在真的刪到東西時才多寫一次：web 每次寫入都要匯出整個資料庫）
  if (changes > 0) await sweepGroupOutboxPayloads();
  return changes;
}

// ============================================
// Phase 9: 群組（讀取）—— groups／group_members 是狀態鏈的投影，寫入只在 groupLogStore
// ============================================

export interface StoredGroup {
  id: string;
  name: string;
  avatar: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  groupType: string | null;
  guardianSettings: string | null;
}

export interface StoredGroupMember {
  groupId: string;
  pubkey: string;
  role: GroupRole;
  nickname: string | null;
  joinedAt: number;
}

export interface StoredGroupMessage {
  id: string;
  groupId: string;
  senderPubkey: string;
  senderName: string | null;
  content: string;
  type: 'text' | 'image' | 'file' | 'voice' | 'payment';
  createdAt: number;
  ttl: number;
  expiresAt: number | null;
}

interface GroupRow {
  id: string;
  name: string;
  avatar: string | null;
  created_at: number;
  created_by: string;
  updated_at: number;
  group_type: string | null;
  guardian_settings: string | null;
}

interface GroupMemberRow {
  group_id: string;
  pubkey: string;
  role: string;
  nickname: string | null;
  joined_at: number;
}

interface GroupMessageRow {
  id: string;
  group_id: string;
  sender_pubkey: string;
  sender_name: string | null;
  content: string;
  msg_type: string;
  created_at: number;
  ttl: number;
  expires_at: number | null;
}

function rowToGroup(row: GroupRow): StoredGroup {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    groupType: row.group_type,
    guardianSettings: row.guardian_settings,
  };
}

function rowToGroupMember(row: GroupMemberRow): StoredGroupMember {
  return {
    groupId: row.group_id,
    pubkey: row.pubkey,
    role: row.role as GroupRole,
    nickname: row.nickname,
    joinedAt: row.joined_at,
  };
}

function rowToGroupMessage(row: GroupMessageRow): StoredGroupMessage {
  return {
    id: row.id,
    groupId: row.group_id,
    senderPubkey: row.sender_pubkey,
    senderName: row.sender_name,
    content: row.content,
    type: row.msg_type as StoredGroupMessage['type'],
    createdAt: row.created_at,
    ttl: row.ttl,
    expiresAt: row.expires_at,
  };
}

export async function getGroup(groupId: string): Promise<StoredGroup | null> {
  await initStorage();

  const row = await db.queryOne<GroupRow>(
    `SELECT id, name, avatar, created_at, created_by, updated_at, group_type, guardian_settings FROM groups WHERE id = ?`,
    [groupId]
  );

  return row ? rowToGroup(row) : null;
}

export async function getAllGroups(): Promise<StoredGroup[]> {
  await initStorage();

  const rows = await db.query<GroupRow>(
    `SELECT id, name, avatar, created_at, created_by, updated_at, group_type, guardian_settings FROM groups ORDER BY updated_at DESC`
  );

  return rows.map(rowToGroup);
}

export async function getGroupMembers(groupId: string): Promise<StoredGroupMember[]> {
  await initStorage();

  const rows = await db.query<GroupMemberRow>(
    `SELECT group_id, pubkey, role, nickname, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at ASC`,
    [groupId]
  );

  return rows.map(rowToGroupMember);
}

/** 這個人還在我任何一個群組的名冊（資料庫）裡嗎 —— 清他的群組待送之前確認用（AppProvider，程式碼審查 MEDIUM） */
export async function isGroupMemberAnywhere(pubkey: string): Promise<boolean> {
  await initStorage();
  return !!(await db.queryOne(`SELECT 1 AS hit FROM group_members WHERE pubkey = ? LIMIT 1`, [pubkey]));
}

export async function updateGroupMemberNickname(groupId: string, pubkey: string, nickname: string): Promise<void> {
  await initStorage();
  await db.run(`UPDATE group_members SET nickname = ? WHERE group_id = ? AND pubkey = ?`, [nickname, groupId, pubkey]);
}

export async function getGroupsForUser(pubkey: string): Promise<StoredGroup[]> {
  await initStorage();

  const rows = await db.query<GroupRow>(
    `SELECT g.id, g.name, g.avatar, g.created_at, g.created_by, g.updated_at, g.group_type, g.guardian_settings
     FROM groups g
     INNER JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.pubkey = ?
     ORDER BY g.updated_at DESC`,
    [pubkey]
  );

  return rows.map(rowToGroup);
}

export async function saveGroupMessage(message: StoredGroupMessage): Promise<void> {
  await initStorage();

  await db.run(
    `INSERT OR REPLACE INTO group_messages
     (id, group_id, sender_pubkey, sender_name, content, msg_type, created_at, ttl, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.groupId,
      message.senderPubkey,
      message.senderName,
      message.content,
      message.type,
      message.createdAt,
      message.ttl,
      message.expiresAt,
    ]
  );

  await db.run(`UPDATE groups SET updated_at = ? WHERE id = ?`, [message.createdAt, message.groupId]);
}

export async function getGroupMessages(groupId: string, limit = 50, offset = 0): Promise<StoredGroupMessage[]> {
  await initStorage();

  const rows = await db.query<GroupMessageRow>(
    `SELECT id, group_id, sender_pubkey, sender_name, content, msg_type, created_at, ttl, expires_at
     FROM group_messages
     WHERE group_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [groupId, limit, offset]
  );

  return rows.map(rowToGroupMessage).reverse();
}

export async function deleteGroupMessage(messageId: string): Promise<void> {
  await initStorage();
  await db.run(`DELETE FROM group_messages WHERE id = ?`, [messageId]);
}

export async function deleteExpiredGroupMessages(): Promise<number> {
  await initStorage();

  const now = Date.now();
  const changes = await db.run(`DELETE FROM group_messages WHERE expires_at IS NOT NULL AND expires_at < ?`, [now]);
  return changes;
}

export async function getGroupMemberCount(groupId: string): Promise<number> {
  await initStorage();

  const row = await db.queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?`, [groupId]);
  return row?.cnt ?? 0;
}

export async function isGroupMember(groupId: string, pubkey: string): Promise<boolean> {
  await initStorage();

  const row = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ? AND pubkey = ?`,
    [groupId, pubkey]
  );
  return (row?.cnt ?? 0) > 0;
}

export async function isGroupAdmin(groupId: string, pubkey: string): Promise<boolean> {
  await initStorage();

  const row = await db.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ? AND pubkey = ? AND role = 'admin'`,
    [groupId, pubkey]
  );
  return (row?.cnt ?? 0) > 0;
}

// ============================================
// 工具函式
// ============================================

export function getConversationIdForPeer(peerPubkey: string): string {
  return `conv-${peerPubkey}`;
}

export function isInitialized(): boolean {
  return _initialized;
}

/**
 * 待送佇列整個清掉：1 對 1 的密文與排隊的明文、群組的參照、v11 起群組共用的密文（group_outbox_payloads）。
 * 帳號離開這台裝置時用（被踢 deviceClaim.wipeLocalKeys、換機登出 clearAllData）：這兩張表不分帳號，
 * 不清的話下一個帳號一開 App，loadOutbox 就照收件人把上一個帳號的密文撥出去。同一個 transaction，失敗就整個不刪。
 */
const OUTBOX_WIPE: ReadonlyArray<{ statement: string; values: (string | number | null)[] }> = [
  { statement: `DELETE FROM pending_messages`, values: [] },
  { statement: `DELETE FROM group_outbox_payloads`, values: [] },
];

export async function clearAllPendingMessages(): Promise<void> {
  await initStorage();
  await db.runBatch([...OUTBOX_WIPE]);
}

export async function clearAllData(): Promise<void> {
  await initStorage();

  // 以前只刪訊息、對話、聯絡人、ratchet：待送佇列（含群組密文）留給下一個帳號送（見 clearAllPendingMessages）
  await db.runBatch([
    ...OUTBOX_WIPE,
    { statement: `DELETE FROM messages`, values: [] },
    { statement: `DELETE FROM conversations`, values: [] },
    { statement: `DELETE FROM contacts`, values: [] },
    { statement: `DELETE FROM ratchet_states`, values: [] },
    // 好友之間的 presence 秘密（W4，presenceStore）：我的 S 與好友的 S 都是這個帳號的
    { statement: `DELETE FROM settings WHERE key LIKE 'presence_secret:%'`, values: [] },
  ]);
  // mqtt 記著的群組／presence 主題（localStorage；好友的公鑰與他們目前的 tag，審查 W4 #11）
  wipeRememberedTopics();
}

// 啟動時自動清理過期資料
export function startCleanupTask(): void {
  setInterval(() => {
    deleteExpiredMessages();
  }, 60000);

  setInterval(() => {
    cleanupOldPendingMessages();
  }, 60 * 60 * 1000);

  deleteExpiredMessages();
  cleanupOldPendingMessages();
}

export default {
  initStorage,
  isInitialized,
  clearAllData,
  clearAllPendingMessages,
  startCleanupTask,
  // Contacts
  addContact,
  getContact,
  getAllContacts,
  removeContact,
  // Trusted Contacts (Phase 10)
  setContactTrustedStatus,
  isContactTrusted,
  getTrustedContacts,
  // Messages
  saveMessage,
  getMessages,
  updateMessageStatus,
  markMessageAsRead,
  deleteMessage,
  hasMessageFrom,
  deleteExpiredMessages,
  getConversationIdForPeer,
  // View Groups
  getMessagesByGroupId,
  addGroupIdToMessage,
  removeGroupIdFromMessage,
  getGroupMessageCount,
  getGroupUnreadCount,
  // Ratchet
  saveRatchetState,
  getRatchetState,
  // Pending Messages
  addPendingMessage,
  getPendingMessagesForRecipient,
  getAllPendingMessages,
  removePendingMessage,
  removePendingMessageForRecipient,
  removePendingGroupMessage,
  updatePendingMessageRetry,
  getPendingMessageCount,
  cleanupOldPendingMessages,
  // Groups（名冊、群組列只由群組引擎套用狀態鏈時寫，見 groupLogStore；這裡只讀與本機暱稱快取）
  getGroup,
  getAllGroups,
  getGroupMembers,
  updateGroupMemberNickname,
  getGroupsForUser,
  saveGroupMessage,
  getGroupMessages,
  deleteGroupMessage,
  deleteExpiredGroupMessages,
  getGroupMemberCount,
  isGroupMember,
  isGroupAdmin,
};

/**
 * Chat Export Service — Phase 33
 *
 * 匯出聊天記錄為密碼學簽章證據包 (.aegis-evidence)
 * - 每條訊息 SHA-256 hash
 * - 整體 Merkle hash + Ed25519 簽章
 * - 本地操作，不上傳 VPS
 */

import { getMessages, getMessagesByGroupId, type StoredMessage } from './storage';
import type { Identity } from './crypto';

// ============================================
// 型別定義
// ============================================

export interface EvidenceMessage {
  id: string;
  senderPubkey: string;
  senderName: string;
  content: string;
  type: string;
  timestamp: number;
  isOutgoing: boolean;
  riskResult: unknown | null;
  metadata: unknown | null;
  /** SHA-256 hash of (id + senderPubkey + content + timestamp) */
  hash: string;
}

export interface EvidencePackage {
  version: 1;
  format: 'aegis-evidence';
  exportedAt: number;
  exportedBy: string;
  conversation: {
    type: '1-1' | 'group';
    id: string;
    displayName: string;
  };
  dateRange: {
    from: number;
    to: number;
  };
  messageCount: number;
  messages: EvidenceMessage[];
  integrity: {
    /** SHA-256 of all message hashes concatenated */
    messagesHash: string;
    /** Ed25519 signature of messagesHash */
    signature: string;
    /** Exporter's public key (Base64) */
    publicKey: string;
    algorithm: 'Ed25519';
    hashAlgorithm: 'SHA-256';
  };
}

export interface ExportOptions {
  conversationType: '1-1' | 'group';
  /** peer publicKey (1-1) or groupId (group) */
  conversationId: string;
  displayName: string;
  /** Optional date range filter */
  dateFrom?: number;
  dateTo?: number;
  /** Map of publicKey → displayName for sender resolution */
  nameMap: Record<string, string>;
}

// ============================================
// 核心函式
// ============================================

/** SHA-256 hash → hex string */
async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 計算單條訊息的 hash */
async function hashMessage(msg: StoredMessage): Promise<string> {
  const canonical = `${msg.id}|${msg.senderPubkey}|${msg.content}|${msg.createdAt}`;
  return sha256Hex(canonical);
}

/** 查詢並篩選訊息 */
async function fetchMessages(opts: ExportOptions): Promise<StoredMessage[]> {
  const EXPORT_LIMIT = 999999;
  let messages: StoredMessage[];

  if (opts.conversationType === '1-1') {
    messages = await getMessages(opts.conversationId, EXPORT_LIMIT, 0);
  } else {
    messages = await getMessagesByGroupId(opts.conversationId, EXPORT_LIMIT, 0);
  }

  // 時間範圍篩選
  if (opts.dateFrom || opts.dateTo) {
    const from = opts.dateFrom ?? 0;
    const to = opts.dateTo ?? Infinity;
    messages = messages.filter(m => m.createdAt >= from && m.createdAt <= to);
  }

  return messages;
}

/** 將 StoredMessage 轉為 EvidenceMessage */
async function toEvidenceMessage(
  msg: StoredMessage,
  nameMap: Record<string, string>,
  myPublicKey: string,
): Promise<EvidenceMessage> {
  const hash = await hashMessage(msg);
  const senderName = msg.isOutgoing
    ? (nameMap[myPublicKey] || 'Me')
    : (nameMap[msg.senderPubkey] || msg.senderPubkey.slice(0, 16) + '...');

  let riskResult: unknown | null = null;
  if (msg.riskResult) {
    try { riskResult = JSON.parse(msg.riskResult); } catch { /* ignore */ }
  }

  let metadata: unknown | null = null;
  if (msg.metadata) {
    try { metadata = JSON.parse(msg.metadata); } catch { /* ignore */ }
  }

  return {
    id: msg.id,
    senderPubkey: msg.senderPubkey,
    senderName,
    content: msg.content,
    type: msg.type,
    timestamp: msg.createdAt,
    isOutgoing: msg.isOutgoing,
    riskResult,
    metadata,
    hash,
  };
}

/**
 * 匯出聊天記錄為簽章證據包
 */
export async function exportChatEvidence(
  identity: Identity,
  opts: ExportOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<EvidencePackage> {
  // 1. 查詢訊息
  const rawMessages = await fetchMessages(opts);
  if (rawMessages.length === 0) {
    throw new Error('NO_MESSAGES');
  }

  // 2. 轉換 + hash
  const evidenceMessages: EvidenceMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const em = await toEvidenceMessage(rawMessages[i], opts.nameMap, identity.publicKeyBase64);
    evidenceMessages.push(em);
    if (onProgress && i % 50 === 0) {
      onProgress(i + 1, rawMessages.length);
    }
  }
  if (onProgress) {
    onProgress(rawMessages.length, rawMessages.length);
  }

  // 3. Merkle hash: 所有 message hash 串接 → SHA-256
  const allHashes = evidenceMessages.map(m => m.hash).join('');
  const messagesHash = await sha256Hex(allHashes);

  // 4. Ed25519 簽章
  const encoder = new TextEncoder();
  const signatureBytes = identity.sign(encoder.encode(messagesHash));
  const signature = btoa(String.fromCharCode(...signatureBytes));

  // 5. 日期範圍
  const timestamps = evidenceMessages.map(m => m.timestamp);
  const dateFrom = opts.dateFrom ?? Math.min(...timestamps);
  const dateTo = opts.dateTo ?? Math.max(...timestamps);

  return {
    version: 1,
    format: 'aegis-evidence',
    exportedAt: Date.now(),
    exportedBy: identity.publicKeyBase64,
    conversation: {
      type: opts.conversationType,
      id: opts.conversationId,
      displayName: opts.displayName,
    },
    dateRange: { from: dateFrom, to: dateTo },
    messageCount: evidenceMessages.length,
    messages: evidenceMessages,
    integrity: {
      messagesHash,
      signature,
      publicKey: identity.publicKeyBase64,
      algorithm: 'Ed25519',
      hashAlgorithm: 'SHA-256',
    },
  };
}

/**
 * 下載證據包為 .aegis-evidence 檔案
 */
export function downloadEvidence(pkg: EvidencePackage): void {
  const json = JSON.stringify(pkg, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const dateStr = new Date(pkg.exportedAt).toISOString().slice(0, 10);
  const safeName = pkg.conversation.displayName
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af_-]/g, '')
    .slice(0, 20);
  const filename = `${safeName}_${dateStr}.aegis-evidence`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 驗證證據包簽章完整性（供 verify.html 使用）
 */
export async function verifyEvidence(pkg: EvidencePackage): Promise<{
  valid: boolean;
  messagesHashMatch: boolean;
  signatureValid: boolean;
  messageHashErrors: string[];
}> {
  const messageHashErrors: string[] = [];

  // 1. 驗證每條訊息 hash
  for (const msg of pkg.messages) {
    const canonical = `${msg.id}|${msg.senderPubkey}|${msg.content}|${msg.timestamp}`;
    const expected = await sha256Hex(canonical);
    if (expected !== msg.hash) {
      messageHashErrors.push(msg.id);
    }
  }

  // 2. 驗證 messagesHash
  const allHashes = pkg.messages.map(m => m.hash).join('');
  const computedHash = await sha256Hex(allHashes);
  const messagesHashMatch = computedHash === pkg.integrity.messagesHash;

  // 3. 驗證 Ed25519 簽章（需要 WASM crypto 初始化）
  let signatureValid = false;
  try {
    const { Identity } = await import('./crypto');
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(pkg.integrity.messagesHash);
    const signatureBytes = Uint8Array.from(atob(pkg.integrity.signature), c => c.charCodeAt(0));
    const publicKeyBytes = Uint8Array.from(atob(pkg.integrity.publicKey), c => c.charCodeAt(0));
    signatureValid = Identity.verify(publicKeyBytes, messageBytes, signatureBytes);
  } catch {
    // crypto not available — signature check skipped
  }

  return {
    valid: messagesHashMatch && signatureValid && messageHashErrors.length === 0,
    messagesHashMatch,
    signatureValid,
    messageHashErrors,
  };
}

/**
 * Offline Queue Service — ADR-016 群組離線佇列
 *
 * 群組訊息的 BT Seed 快取 + 離線佇列管理。
 * - 每群上限 500 則密文（超過丟最舊的）
 * - 每支手機獨立管理
 * - 所有收到的群組密文都保留（seed cache），供其他成員同步
 */

import { GROUP_CONSTANTS } from '../types';
import { devLog } from '../utils/devLog';

// ============================================
// 類型定義
// ============================================

export interface CachedGroupMessage {
  messageId: string;
  groupId: string;
  /** 完整的 P2P 封包 JSON（含加密資料） */
  payload: string;
  senderId: string;
  timestamp: number;
  cachedAt: number;
}

// ============================================
// In-Memory Seed Cache（群組密文快取）
// ============================================

// groupId → CachedGroupMessage[]（按 timestamp 排序）
const _seedCache = new Map<string, CachedGroupMessage[]>();

/**
 * 快取收到的群組密文（成為 Seed）
 */
export function cacheGroupMessage(msg: CachedGroupMessage): void {
  const messages = _seedCache.get(msg.groupId) || [];

  // 重複檢查
  if (messages.some(m => m.messageId === msg.messageId)) return;

  messages.push(msg);

  // 超過上限，丟最舊的
  while (messages.length > GROUP_CONSTANTS.OFFLINE_QUEUE_LIMIT) {
    messages.shift();
  }

  _seedCache.set(msg.groupId, messages);
}

/**
 * 取得某群組在指定 messageId 之後的所有快取訊息
 * （供 Seed 同步用）
 */
export function getMessagesAfter(
  groupId: string,
  afterMessageId: string | null,
): CachedGroupMessage[] {
  const messages = _seedCache.get(groupId) || [];

  if (!afterMessageId) return [...messages];

  const idx = messages.findIndex(m => m.messageId === afterMessageId);
  if (idx === -1) return [...messages]; // 找不到基準點，返回全部

  return messages.slice(idx + 1);
}

/**
 * 取得某群組的快取訊息數量
 */
export function getCacheSize(groupId: string): number {
  return _seedCache.get(groupId)?.length ?? 0;
}

/**
 * 取得某群組最後一則訊息的 ID
 */
export function getLastMessageId(groupId: string): string | null {
  const messages = _seedCache.get(groupId);
  if (!messages || messages.length === 0) return null;
  return messages[messages.length - 1].messageId;
}

/**
 * 檢查是否已有某則訊息（去重用）
 */
export function hasMessage(groupId: string, messageId: string): boolean {
  const messages = _seedCache.get(groupId) || [];
  return messages.some(m => m.messageId === messageId);
}

/**
 * 清除某群組的快取
 */
export function clearGroupCache(groupId: string): void {
  _seedCache.delete(groupId);
}

/**
 * 清除所有快取
 */
export function clearAllCaches(): void {
  _seedCache.clear();
}

/**
 * 取得所有群組的快取統計
 */
export function getCacheStats(): Map<string, number> {
  const stats = new Map<string, number>();
  for (const [groupId, messages] of _seedCache) {
    stats.set(groupId, messages.length);
  }
  return stats;
}

// ============================================
// Pending Send Queue（待發送佇列）
// ============================================

interface PendingGroupSend {
  recipientPubkey: string;
  payload: string;
  groupId: string;
  queuedAt: number;
}

// groupId → PendingGroupSend[]
const _pendingSends = new Map<string, PendingGroupSend[]>();

/**
 * 加入待發送佇列（對方離線時）
 */
export function enqueuePendingSend(
  groupId: string,
  recipientPubkey: string,
  payload: string,
): void {
  const pending = _pendingSends.get(groupId) || [];

  pending.push({
    recipientPubkey,
    payload,
    groupId,
    queuedAt: Date.now(),
  });

  // 每群上限
  while (pending.length > GROUP_CONSTANTS.OFFLINE_QUEUE_LIMIT) {
    pending.shift();
  }

  _pendingSends.set(groupId, pending);
  devLog(`[offlineQueue] Queued send for ${recipientPubkey.slice(0, 16)} in group ${groupId.slice(0, 8)}`);
}

/**
 * 取得某成員的待發送訊息
 */
export function getPendingSendsFor(recipientPubkey: string): PendingGroupSend[] {
  const result: PendingGroupSend[] = [];
  for (const pending of _pendingSends.values()) {
    result.push(...pending.filter(p => p.recipientPubkey === recipientPubkey));
  }
  return result;
}

/**
 * 清除已發送的待發送訊息
 */
export function clearPendingSendsFor(recipientPubkey: string): void {
  for (const [groupId, pending] of _pendingSends) {
    const remaining = pending.filter(p => p.recipientPubkey !== recipientPubkey);
    if (remaining.length === 0) {
      _pendingSends.delete(groupId);
    } else {
      _pendingSends.set(groupId, remaining);
    }
  }
}

/**
 * Seed Sync Service — ADR-016 BT Seed 離線同步協議
 *
 * 新上線成員 (D) 主動發起同步：
 * 1. D 廣播 sync_request：「我在群組 G 最後收到的訊息 ID 是 X」
 * 2. 在線成員回應 sync_offer：「我有 X 之後的 N 則訊息」
 * 3. D 選擇最齊全的 Seed，接收缺少的密文
 * 4. 如果 D 的 Group Key 過時，Seed 補發新 Key
 */

import * as offlineQueue from './offlineQueue';
import * as groupKeyService from './groupKey';
import { sendViaP2P } from './p2pSend';
import { devLog } from '../utils/devLog';

// ============================================
// 同步協議訊息類型
// ============================================

/** D → 在線成員：請求同步 */
export interface SyncRequest {
  type: 'sync_request';
  groupId: string;
  lastMessageId: string | null;
  lastKeyId: string | null;
  requesterId: string;
}

/** 在線成員 → D：回應可提供的訊息數量 */
export interface SyncOffer {
  type: 'sync_offer';
  groupId: string;
  messagesAvailable: number;
  currentKeyId: string | null;
  offererId: string;
}

/** Seed → D：傳送缺少的訊息 */
export interface SyncTransfer {
  type: 'sync_transfer';
  groupId: string;
  messages: Array<{
    messageId: string;
    payload: string; // 完整 P2P 封包 JSON
  }>;
  /** 如果 D 的 Key 過時，附帶新 Key 分發封包（已用 1-1 Ratchet 加密） */
  keyDistribution?: string; // 加密後的 GroupKeyDistribution JSON
}

// ============================================
// 發起同步（新上線成員呼叫）
// ============================================

/**
 * 上線後對群組發起同步請求
 * 透過 P2P DataChannel 廣播給已連線的群組成員
 */
export function requestSync(
  groupId: string,
  myPublicKey: string,
  connectedMembers: string[],
): void {
  const lastMessageId = offlineQueue.getLastMessageId(groupId);

  // 取得本地最新的 keyId（異步，但先用 null 發出去）
  const request: SyncRequest = {
    type: 'sync_request',
    groupId,
    lastMessageId,
    lastKeyId: null, // 將由 async 路徑更新
    requesterId: myPublicKey,
  };

  // 異步取得 keyId 後發送
  groupKeyService.getActiveGroupKey(groupId).then(key => {
    request.lastKeyId = key?.keyId ?? null;

    const payload = JSON.stringify({
      type: 'seed_sync',
      payload: request,
    });

    for (const memberPk of connectedMembers) {
      sendViaP2P(memberPk, payload);
    }

    devLog(`[seedSync] Sent sync_request for group ${groupId.slice(0, 8)} to ${connectedMembers.length} peers, lastMsg: ${lastMessageId?.slice(0, 8) ?? 'none'}`);
  });
}

// ============================================
// 處理同步請求（Seed 角色）
// ============================================

/**
 * 收到 sync_request → 回應 sync_offer
 */
export async function handleSyncRequest(
  request: SyncRequest,
  myPublicKey: string,
): Promise<void> {
  const available = offlineQueue.getMessagesAfter(request.groupId, request.lastMessageId);
  const activeKey = await groupKeyService.getActiveGroupKey(request.groupId);

  const offer: SyncOffer = {
    type: 'sync_offer',
    groupId: request.groupId,
    messagesAvailable: available.length,
    currentKeyId: activeKey?.keyId ?? null,
    offererId: myPublicKey,
  };

  const payload = JSON.stringify({
    type: 'seed_sync',
    payload: offer,
  });

  sendViaP2P(request.requesterId, payload);
  devLog(`[seedSync] Sent sync_offer to ${request.requesterId.slice(0, 16)}: ${available.length} messages available`);
}

/**
 * 收到確認後，傳送缺少的訊息
 */
export function transferMessages(
  groupId: string,
  afterMessageId: string | null,
  recipientPubkey: string,
  /** 他加入那筆 commit 的時間：之前的密文不給（加人不換金鑰，給了他就讀得到加入前的對話） */
  notBefore = 0,
): void {
  const messages = offlineQueue.getMessagesAfter(groupId, afterMessageId).filter((m) => m.timestamp >= notBefore);

  if (messages.length === 0) {
    devLog(`[seedSync] No messages to transfer for group ${groupId.slice(0, 8)}`);
    return;
  }

  const transfer: SyncTransfer = {
    type: 'sync_transfer',
    groupId,
    messages: messages.map(m => ({
      messageId: m.messageId,
      payload: m.payload,
    })),
  };

  const payload = JSON.stringify({
    type: 'seed_sync',
    payload: transfer,
  });

  sendViaP2P(recipientPubkey, payload);
  devLog(`[seedSync] Transferred ${messages.length} messages to ${recipientPubkey.slice(0, 16)} for group ${groupId.slice(0, 8)}`);
}

// ============================================
// 處理收到的同步資料（請求者角色）
// ============================================

/** 收到的 sync_offer 暫存，選最佳 Seed */
const _pendingOffers = new Map<string, SyncOffer[]>();
const _offerTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 收到 sync_offer → 暫存，等 2 秒收集所有 offer 後選最佳
 */
export function handleSyncOffer(
  offer: SyncOffer,
  myPublicKey: string,
): void {
  const key = `${offer.groupId}:${myPublicKey}`;
  const offers = _pendingOffers.get(key) || [];
  offers.push(offer);
  _pendingOffers.set(key, offers);

  // 清除舊 timer，重設 2 秒
  const existing = _offerTimeouts.get(key);
  if (existing) clearTimeout(existing);

  _offerTimeouts.set(key, setTimeout(() => {
    const collected = _pendingOffers.get(key) || [];
    _pendingOffers.delete(key);
    _offerTimeouts.delete(key);

    if (collected.length === 0) return;

    // 選訊息最多的 Seed
    const best = collected.reduce((a, b) => a.messagesAvailable > b.messagesAvailable ? a : b);

    if (best.messagesAvailable === 0) {
      devLog(`[seedSync] No messages to sync for group ${offer.groupId.slice(0, 8)}`);
      return;
    }

    // 請求 Seed 傳送訊息
    const lastMsgId = offlineQueue.getLastMessageId(offer.groupId);
    const requestPayload = JSON.stringify({
      type: 'seed_sync',
      payload: {
        type: 'sync_accept',
        groupId: offer.groupId,
        lastMessageId: lastMsgId,
        requesterId: myPublicKey,
      },
    });

    sendViaP2P(best.offererId, requestPayload);
    devLog(`[seedSync] Selected seed ${best.offererId.slice(0, 16)} (${best.messagesAvailable} msgs) for group ${offer.groupId.slice(0, 8)}`);
  }, 2000));
}

/**
 * 收到 sync_transfer → 將訊息加入快取
 * 返回收到的訊息數量
 */
/**
 * 快取的密文原本的時間（寄件人送出的那一則 group_key_message 的 timestamp）。拿不到 → 0：
 * 轉給後來加入的人時（transferMessages 的 notBefore）一律當成「他加入之前」不給（審查 W1 LOW：以前記成收到的時間）
 */
function originalTimestamp(payload: string): number {
  try {
    const ts = (JSON.parse(payload) as { payload?: { timestamp?: unknown } })?.payload?.timestamp;
    return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

export function handleSyncTransfer(transfer: SyncTransfer): number {
  let added = 0;

  for (const msg of transfer.messages) {
    if (!offlineQueue.hasMessage(transfer.groupId, msg.messageId)) {
      offlineQueue.cacheGroupMessage({
        messageId: msg.messageId,
        groupId: transfer.groupId,
        payload: msg.payload,
        senderId: '', // 從 payload 中解析
        timestamp: originalTimestamp(msg.payload),
        cachedAt: Date.now(),
      });
      added++;
    }
  }

  devLog(`[seedSync] Received ${added} new messages from sync_transfer for group ${transfer.groupId.slice(0, 8)}`);
  return added;
}

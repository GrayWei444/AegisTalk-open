/**
 * useChat Hook - 加密聊天整合
 *
 * 整合 AppProvider 和 chatStore，提供加密訊息收發功能
 * 注意：訊息接收由 AppProvider 全域處理，此 Hook 主要負責發送
 */

import { useCallback, useEffect } from 'react';
import { useApp } from '../providers/AppProvider';
import { useChatStore } from '../stores/chatStore';
import { mqttService } from '../services/mqtt';
import { sendDeleteMessage } from '../services/directSignal';
import { sendViaP2P, enqueuePlaintextForSession } from '../services/p2pSend';
import { isBlacklisted } from '../services/localBlacklist';
import * as fileTransfer from '../services/fileTransfer';
import type { RatchetMessage } from '../services/crypto';
import { generateId } from '../utils/secureId';
import { devLog } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
interface UseChatOptions {
  onError?: (error: string) => void;
}

/**
 * 加密聊天 Hook
 */
export function useChat(options: UseChatOptions = {}) {
  const { onError } = options;

  const {
    publicKey,
    cryptoReady,
    mqttConnected,
    encryptMessage,
    connectPeer,
    isConnectedTo,
  } = useApp();

  const {
    friends,
    currentFriendId,
    messages,
    sendMessage: storeSendMessage,
    loadFromStorage,
    isLoaded,
  } = useChatStore();

  // 取得當前好友
  const currentFriend = friends.find((f) => f.id === currentFriendId);

  // 關鍵修復：當 currentFriendId 存在但 friends 為空時，重新載入資料
  // 這通常發生在 PWA 從背景恢復時
  useEffect(() => {
    if (currentFriendId && friends.length === 0 && isLoaded) {
      devLog('[useChat] currentFriendId exists but friends empty, reloading...');
      loadFromStorage();
    }
  }, [currentFriendId, friends.length, isLoaded, loadFromStorage]);

  // 訊息接收由 AppProvider 全域處理，不需要在這裡訂閱

  /**
   * 發送加密訊息
   */
  const sendEncryptedMessage = useCallback(
    async (
      content: string,
      type: 'text' | 'image' | 'file' | 'voice' | 'payment' = 'text',
      ttl?: number,
      voiceData?: { duration: number; waveform?: number[]; mimeType?: string; transcript?: string },
      fileData?: { name: string; mimeType: string; size: number; caption?: string },
      paymentData?: import('../types').PaymentData
    ) => {
      if (!currentFriend || !publicKey) {
        onError?.('No friend selected or identity not initialized');
        return false;
      }

      // 封鎖的聯絡人：不可傳訊（過去封鎖只寫 DB local_user_blacklist、沒擋送訊，這裡補上）
      if (await isBlacklisted(currentFriend.publicKey)) {
        onError?.('你已封鎖此聯絡人，無法傳送訊息');
        return false;
      }

      try {
        // 產生訊息 ID（雙方共用同一個 ID）
        const messageId = generateId('msg');

        // 建立訊息資料（包含 ID）
        const messageData = {
          id: messageId,
          content,
          type,
          ttl,
          timestamp: Date.now(),
          // 語音訊息元資料
          ...(type === 'voice' && voiceData ? { voiceData } : {}),
          // 檔案訊息元資料
          ...(type === 'file' && fileData ? { fileData } : {}),
          // 轉帳卡片元資料（AegisPay Phase 0）
          ...(type === 'payment' && paymentData ? { paymentData } : {}),
        };

        // 加密訊息 (返回 RatchetMessage WASM 物件)
        devLog('[useChat] Encrypting message for:', currentFriend.publicKey.slice(0, 16) + '...');
        let encrypted: RatchetMessage;
        try {
          encrypted = await encryptMessage(currentFriend.publicKey, JSON.stringify(messageData)) as RatchetMessage;
        } catch (encErr) {
          if (/no session with this recipient/i.test((encErr as Error)?.message ?? '')) {
            // 無 session（恢復讓步窗口／對方尚未回 X3DH_INIT）→ 訊息**不准無聲消失**（§0.29）：
            // 照常上自己的畫面 + 進本機「待加密」outbox，session 建立後 flush 會加密送出。
            storeSendMessage(content, publicKey, ttl, messageId, type, voiceData, fileData, paymentData);
            // 催對方發起 X3DH 的那一發 PREKEY_REQUEST 已收進 enqueuePlaintextForSession
            // （p2pSend nudgeOutboxSession：附我方 bundle + 60s 節流 + 每次 flush 卡住時重試）。
            enqueuePlaintextForSession(currentFriend.publicKey, JSON.stringify(messageData));
            return true;
          }
          throw encErr;
        }
        devLog('[useChat] Encryption successful');

        // 序列化 RatchetMessage 為 JSON 字串以便透過網路傳輸
        const serializedMessage = encrypted.toJson();
        devLog('[useChat] Serialized message preview:', serializedMessage.slice(0, 100) + '...');

        // 儲存到本地 store（顯示已發送，包含 TTL，使用相同的 messageId）
        storeSendMessage(content, publicKey, ttl, messageId, type, voiceData, fileData, paymentData);

        // P2P-only transport（ADR-016: MQTT 只做信令，絕不傳訊息內容）
        // 對方離線 → p2pSend 本地佇列等 P2P 連線建立後送出
        const p2pPayload = JSON.stringify({
          type: 'encrypted_message',
          payload: serializedMessage,
        });
        // 帶上明文：送出後等對方回條，沒回條就用當下的 session 重新加密重送（群星 B33）
        sendViaP2P(currentFriend.publicKey, p2pPayload, { messageId, plaintext: JSON.stringify(messageData) });

        // Push notification（零內容，僅喚醒離線裝置）
        // ADR-016: 不傳送任何訊息內容、發送者名稱、ID
        // W4：「在線」只認好友秘密主題上解得開、夠新、10 分鐘內有更新的狀態 —— 營運方寫不出假的「在線」讓這裡不發推播，
        //   擋掉他的遺囑也頂多讓我少發 10 分鐘（presenceSecret.ONLINE_TTL_MS）
        //   開源第 4 步：只叫帳戶簽章的 /api/push/notify —— 伺服器送到他登記的 FCM token 與 Web Push 訂閱
        //   （以前 PWA 另外拿著好友經 MQTT 明文傳來的訂閱去打沒有驗證的 push relay，拿掉了）
        if (!mqttService.isFriendOnline(currentFriend.publicKey)) {
          mqttService.triggerFcmNotify(currentFriend.publicKey, { type: 'message' });
        }

        return true;
      } catch (err) {
        console.error('[useChat] Failed to send message:', err);
        onError?.(err instanceof Error ? err.message : 'Failed to send message');
        return false;
      }
    },
    [
      currentFriend,
      publicKey,
      encryptMessage,
      connectPeer,
      storeSendMessage,
      onError,
    ]
  );

  /**
   * 發送大檔（chunked + backpressure，LEARNINGS §1）
   *
   * 走獨立 fileTransfer 路徑：
   *   - manifest 走 Double Ratchet 加密通道（type='file_manifest'）
   *   - chunks 用 ephemeral fileKey 加密後逐塊送 ArrayBuffer
   *   - 自動 backpressure（4MB high / 1MB low watermark）
   *   - blob 存進 fileBlobStore（IndexedDB），不寫進 SQLite
   */
  const sendFile = useCallback(
    async (file: File, caption?: string): Promise<boolean> => {
      if (!currentFriend || !publicKey) {
        onError?.('No friend selected or identity not initialized');
        return false;
      }
      try {
        diagLog('[useChat] sendFile:', file.size, 'bytes to:', currentFriend.publicKey.slice(0, 16));
        const result = await fileTransfer.sendFile(currentFriend.publicKey, file, caption);

        // 寫進 sender 自己的 chatStore — content 留空，靠 fileData.fileId 從 fileBlobStore 取 blob
        await storeSendMessage('', publicKey, undefined, result.messageId, 'file', undefined, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          caption,
          fileId: result.fileId,
        });
        return true;
      } catch (err) {
        console.error('[useChat] sendFile failed:', err);
        onError?.(err instanceof Error ? err.message : 'sendFile failed');
        return false;
      }
    },
    [currentFriend, publicKey, storeSendMessage, onError]
  );

  /**
   * 轉帳狀態控制訊息（加密送出、不落地成可見訊息）：
   * 排程付款狀態（真鏈上）：payment_executed = 到期已上鏈；payment_failed = 失敗；payment_cancelled = 取消
   */
  const sendPaymentControl = useCallback(
    async (type: 'payment_executed' | 'payment_failed' | 'payment_cancelled', txId: string) => {
      if (!currentFriend || !publicKey) return false;
      try {
        const envelope = { type, txId, timestamp: Date.now() };
        const encrypted = await encryptMessage(currentFriend.publicKey, JSON.stringify(envelope)) as RatchetMessage;
        sendViaP2P(currentFriend.publicKey, JSON.stringify({
          type: 'encrypted_message',
          payload: encrypted.toJson(),
        }));
        return true;
      } catch (err) {
        console.error('[useChat] sendPaymentControl failed:', err);
        return false;
      }
    },
    [currentFriend, publicKey, encryptMessage]
  );
  const sendPaymentExecuted = useCallback((txId: string) => sendPaymentControl('payment_executed', txId), [sendPaymentControl]);
  const sendPaymentFailed = useCallback((txId: string) => sendPaymentControl('payment_failed', txId), [sendPaymentControl]);
  const sendPaymentCancelled = useCallback((txId: string) => sendPaymentControl('payment_cancelled', txId), [sendPaymentControl]);

  /**
   * 建立 P2P 連線
   */
  const establishPeerConnection = useCallback(
    async (friendId: string) => {
      const friend = friends.find((f) => f.id === friendId);
      if (!friend) {
        onError?.('Friend not found');
        return false;
      }

      try {
        await connectPeer(friend.publicKey);
        devLog('[useChat] P2P connection established with:', friend.name);
        return true;
      } catch (err) {
        console.error('[useChat] Failed to establish P2P connection:', err);
        // P2P 連線失敗 → 訊息留在本地佇列等待重連
        return false;
      }
    },
    [friends, connectPeer, onError]
  );

  /**
   * 遠端刪除訊息（刪除雙方的訊息）
   */
  const deleteMessageRemotely = useCallback(
    (messageId: string) => {
      if (!currentFriend) {
        onError?.('No friend selected');
        return false;
      }

      try {
        // 發送刪除請求給對方（DIRECT_SEALED kind delete：封給他的身分金鑰、我簽章 —— 營運方不能替我刪他手上的訊息）
        const to = currentFriend.publicKey;
        sendDeleteMessage(to, messageId).catch((err) => console.error('[useChat] delete request not sent:', err));

        // 本地也刪除（由 ChatRoom 處理 burnMessage 呼叫）
        // DIAG: production-visible log for E2E testing (console.error survives prod strip)
        diagLog('[DIAG:DELETE:SEND] messageId=' + messageId + ' to=' + currentFriend.publicKey.slice(0, 16));
        return true;
      } catch (err) {
        console.error('[useChat] Failed to send delete request:', err);
        onError?.(err instanceof Error ? err.message : 'Failed to delete message');
        return false;
      }
    },
    [currentFriend, onError]
  );

  /**
   * 取得當前對話的訊息
   */
  const currentMessages = currentFriendId ? messages[currentFriendId] || [] : [];

  return {
    // 狀態
    isReady: cryptoReady && mqttConnected && !!publicKey,
    // 送訊就緒：只需能加密（crypto + 身份）。不含 mqttConnected —— MQTT 只做信令，
    // 實際送訊走 P2P + 持久化 outbox（沒連就排隊、連上自動 flush）。恢復後 MQTT 重連
    // 空窗期若用完整 isReady 擋送出 → 訊息被靜默丟棄（真機「傳訊息沒反應」真因）。
    canSendMessage: cryptoReady && !!publicKey,
    currentFriend,
    currentMessages,
    friends,

    // 操作
    sendEncryptedMessage,
    sendPaymentExecuted,
    sendPaymentFailed,
    sendPaymentCancelled,
    sendFile,
    establishPeerConnection,
    deleteMessageRemotely,

    // 連線狀態
    isPeerConnected: currentFriend ? isConnectedTo(currentFriend.publicKey) : false,
  };
}

export default useChat;

import { devLog, devWarn } from '../utils/devLog';

/**
 * Push Notification Service
 *
 * 通知權限、本機通知、瀏覽器的 Web Push 訂閱。
 * 開源第 4 步：訂閱不再經 P2P／MQTT 交給好友（明文的 PUSH_SUBSCRIPTION_UPDATE 拿掉了），也不再有寄件人自己拿著好友的訂閱
 * 去打的 push relay（沒有驗證，誰都能叫它推給任何訂閱）。訂閱只登記在 chat 伺服器（services/webPush.ts，帳戶簽章），
 * 寄件人只叫 /api/push/notify（mqtt.triggerFcmNotify）。
 */

import type { PushSubscriptionData } from '../types';

// Re-export for convenience
export type { PushSubscriptionData };

// ============================================
// 類型定義
// ============================================

export interface PushNotificationPayload {
  type: 'message' | 'call' | 'friend_request' | 'group_invite';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// ============================================
// 工具函式
// ============================================

/**
 * 將 ArrayBuffer 轉換為 Base64 URL 字串
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================
// Push Notification Service
// ============================================

class PushNotificationService {

  /**
   * 檢查瀏覽器是否支援 Push API
   */
  isSupported(): boolean {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  /**
   * 檢查通知權限狀態
   */
  getPermissionStatus(): NotificationPermission {
    if (!this.isSupported()) return 'denied';
    return Notification.permission;
  }

  /**
   * 請求通知權限
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) {
      devWarn('[Push] 瀏覽器不支援推播通知');
      return 'denied';
    }

    const permission = await Notification.requestPermission();
    devLog('[Push] 通知權限:', permission);
    return permission;
  }

  /**
   * 這個瀏覽器目前的推播訂閱（開源第 5b 步：不在這裡跳權限詢問、也不在這裡建立訂閱）。
   * 訂閱只由 services/webPush.registerWebPush 建立：使用者已經允許通知（granted）之後、用所選伺服器 server-config 的
   * VAPID 公鑰訂閱，並以帳戶簽章登記到那台伺服器。以前這裡會先跳權限詢問、再用 build 時設的 VAPID 金鑰自己訂閱。
   */
  async subscribe(): Promise<PushSubscriptionData | null> {
    if (!this.isSupported() || Notification.permission !== 'granted') return null;
    return this.getSubscription();
  }

  /**
   * 取消訂閱
   */
  async unsubscribe(): Promise<boolean> {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();
        devLog('[Push] 已取消訂閱');
      }

      return true;
    } catch (error) {
      console.error('[Push] 取消訂閱失敗:', error);
      return false;
    }
  }

  /**
   * 獲取當前訂閱資料
   */
  async getSubscription(): Promise<PushSubscriptionData | null> {
    if (!this.isSupported()) return null;

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) return null;

      return this.serializeSubscription(subscription);
    } catch (error) {
      console.error('[Push] 獲取訂閱失敗:', error);
      return null;
    }
  }

  /**
   * 將 PushSubscription 轉換為可序列化格式
   */
  private serializeSubscription(subscription: PushSubscription): PushSubscriptionData {
    const p256dh = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');

    if (!p256dh || !auth) {
      throw new Error('Invalid subscription keys');
    }

    return {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: arrayBufferToBase64Url(p256dh),
        auth: arrayBufferToBase64Url(auth),
      },
      expirationTime: subscription.expirationTime,
    };
  }

  /**
   * 顯示本地通知（不經過推播）
   * 用於 App 在前台時
   */
  async showLocalNotification(
    title: string,
    options?: NotificationOptions & { vibrate?: number[] }
  ): Promise<void> {
    if (this.getPermissionStatus() !== 'granted') {
      devWarn('[Push] 沒有通知權限');
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      // ServiceWorkerRegistration.showNotification 支援更多選項
      await registration.showNotification(title, {
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        ...options,
      } as NotificationOptions);
    } catch (error) {
      console.error('[Push] 顯示通知失敗:', error);
    }
  }
}

// 單例導出
export const pushNotificationService = new PushNotificationService();

// 便捷函式導出
export const subscribeToPush = () => pushNotificationService.subscribe();
export const unsubscribeFromPush = () => pushNotificationService.unsubscribe();
export const getPushSubscription = () => pushNotificationService.getSubscription();
export const isPushSupported = () => pushNotificationService.isSupported();
export const getPushPermission = () => pushNotificationService.getPermissionStatus();

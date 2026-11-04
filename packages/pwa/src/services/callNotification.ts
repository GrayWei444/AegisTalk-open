import { devLog, devWarn } from '../utils/devLog';

/**
 * 來電通知服務
 *
 * 提供統一的來電通知 API，支援：
 * - PWA: 透過 Service Worker 顯示 Web 通知
 * - Android Capacitor: 使用 Local Notifications
 * - iOS Capacitor: 使用 Local Notifications (未來可整合 CallKit)
 */

import { isNativeApp, getPlatform } from './capacitor';
import { tr } from '../i18n/tr';

/**
 * 來電資料
 */
export interface IncomingCallData {
  callId: string;
  callerName: string;
  callerAvatar?: string;
  isVideoCall?: boolean;
}

/**
 * 請求通知權限
 */
export async function requestNotificationPermission(): Promise<boolean> {
  // 原生 App 使用 Capacitor
  if (isNativeApp()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const result = await LocalNotifications.requestPermissions();
      return result.display === 'granted';
    } catch (err) {
      console.error('[CallNotification] Failed to request native permission:', err);
      return false;
    }
  }

  // PWA 使用 Web Notification API
  if (!('Notification' in window)) {
    devWarn('[CallNotification] Notification API not supported');
    return false;
  }

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission === 'denied') {
    return false;
  }

  const result = await Notification.requestPermission();
  return result === 'granted';
}

/**
 * 檢查通知權限狀態
 */
export async function checkNotificationPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (isNativeApp()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const result = await LocalNotifications.checkPermissions();
      return result.display as 'granted' | 'denied' | 'default';
    } catch {
      return 'denied';
    }
  }

  if (!('Notification' in window)) {
    return 'denied';
  }

  return Notification.permission;
}

/**
 * 顯示來電通知
 *
 * @param data 來電資料
 * @returns 是否成功顯示
 */
export async function showIncomingCallNotification(data: IncomingCallData): Promise<boolean> {
  devLog('[CallNotification] Showing notification:', data);

  // 原生 App
  if (isNativeApp()) {
    return showNativeCallNotification(data);
  }

  // PWA - 透過 Service Worker
  return showWebCallNotification(data);
}

/**
 * 取消來電通知
 */
export async function cancelCallNotification(callId?: string): Promise<void> {
  devLog('[CallNotification] Cancelling notification:', callId);

  // 停止震動（不管是原生還是 PWA 都要停止）
  stopCallVibration();

  if (isNativeApp()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      // 取消所有來電通知
      const pending = await LocalNotifications.getPending();
      const callNotifications = pending.notifications.filter(
        (n) => n.extra?.type === 'incoming_call'
      );
      if (callNotifications.length > 0) {
        await LocalNotifications.cancel({
          notifications: callNotifications.map((n) => ({ id: n.id })),
        });
      }
    } catch (err) {
      console.error('[CallNotification] Failed to cancel native notification:', err);
    }
  } else {
    // PWA - 發送訊息給 Service Worker
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({
      type: 'CANCEL_CALL_NOTIFICATION',
      tag: 'incoming-call',
    });
  }
}

/**
 * PWA: 透過 Service Worker 顯示通知
 */
async function showWebCallNotification(data: IncomingCallData): Promise<boolean> {
  try {
    // 確保 Service Worker 已就緒
    const registration = await navigator.serviceWorker.ready;

    if (!registration.active) {
      console.error('[CallNotification] No active Service Worker');
      return false;
    }

    // 發送訊息給 Service Worker
    registration.active.postMessage({
      type: 'SHOW_CALL_NOTIFICATION',
      payload: data,
    });

    return true;
  } catch (err) {
    console.error('[CallNotification] Failed to show web notification:', err);
    return false;
  }
}

/**
 * 原生 App: 使用 Local Notifications
 */
async function showNativeCallNotification(data: IncomingCallData): Promise<boolean> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const platform = getPlatform();

    // 確保已註冊通知動作類型
    await registerCallNotificationActions();

    // 生成通知 ID (需要數字)
    const notificationId = hashCode(data.callId);

    const isVideoCall = data.isVideoCall || false;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: notificationId,
          title: isVideoCall ? `📹 ${tr('call.incomingVideoCall')}` : `📞 ${tr('call.incomingCall')}`,
          body: isVideoCall
            ? tr('call.isVideoCallingYou', { name: data.callerName })
            : tr('call.isCallingYou', { name: data.callerName }),
          channelId: 'incoming_call_channel',  // 使用高優先級頻道
          actionTypeId: 'INCOMING_CALL',
          ongoing: platform === 'android',  // Android: 持續顯示
          autoCancel: false,
          sound: 'default',  // 播放預設鈴聲
          extra: {
            type: 'incoming_call',
            callId: data.callId,
            callerName: data.callerName,
            isVideoCall: isVideoCall,
          },
        },
      ],
    });

    // 開始震動 (Android)
    if (platform === 'android') {
      startNativeVibration();
    }

    return true;
  } catch (err) {
    console.error('[CallNotification] Failed to show native notification:', err);
    return false;
  }
}

/**
 * 註冊來電通知動作類型（只需執行一次）
 */
let actionsRegistered = false;

async function registerCallNotificationActions(): Promise<void> {
  if (actionsRegistered) return;

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: 'INCOMING_CALL',
          actions: [
            {
              id: 'accept',
              title: `📞 ${tr('call.acceptCall')}`,
              foreground: true,  // 點擊後打開 App
            },
            {
              id: 'reject',
              title: `❌ ${tr('call.rejectCall')}`,
              destructive: true,  // 紅色按鈕
            },
          ],
        },
      ],
    });

    actionsRegistered = true;
    devLog('[CallNotification] Registered call notification actions');
  } catch (err) {
    console.error('[CallNotification] Failed to register actions:', err);
  }
}

/**
 * 開始原生震動（Android）
 */
async function startNativeVibration(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');

    let isVibrating = true;

    // 設定 30 秒後自動停止
    const timeoutId = setTimeout(() => {
      isVibrating = false;
    }, 30000);

    const vibrate = async () => {
      while (isVibrating) {
        await Haptics.impact({ style: ImpactStyle.Heavy });
        await sleep(500);
        if (!isVibrating) break;

        await sleep(200);
        await Haptics.impact({ style: ImpactStyle.Light });
        await sleep(200);
        if (!isVibrating) break;

        await sleep(200);
        await Haptics.impact({ style: ImpactStyle.Heavy });
        await sleep(500);
        if (!isVibrating) break;

        await sleep(2000);
      }
    };

    vibrate();

    // 將 cleanup 函式存到全域，讓 cancelCallNotification 可以呼叫
    (window as unknown as Record<string, unknown>).__stopCallVibration = () => {
      isVibrating = false;
      clearTimeout(timeoutId);
    };
  } catch (err) {
    console.error('[CallNotification] Failed to start vibration:', err);
  }
}

/**
 * 停止震動
 */
export function stopCallVibration(): void {
  const stopFn = (window as unknown as Record<string, () => void>).__stopCallVibration;
  if (stopFn) {
    stopFn();
    delete (window as unknown as Record<string, unknown>).__stopCallVibration;
  }

  // 也停止 Web Vibration API
  if ('vibrate' in navigator) {
    navigator.vibrate(0);
  }
}

/**
 * 設置來電通知監聽器
 * 當用戶點擊通知按鈕時觸發回調
 */
export async function setupCallNotificationListeners(handlers: {
  onAccept: (callId: string, callerName: string, isVideoCall: boolean) => void;
  onReject: (callId: string) => void;
}): Promise<void> {
  // 原生 App
  if (isNativeApp()) {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      const { actionId, notification } = event;
      const extra = notification.extra;

      if (extra?.type === 'incoming_call') {
        stopCallVibration();
        cancelCallNotification(extra.callId);

        if (actionId === 'accept') {
          handlers.onAccept(extra.callId, extra.callerName, extra.isVideoCall || false);
        } else if (actionId === 'reject') {
          handlers.onReject(extra.callId);
        }
      }
    });
  }

  // PWA - 監聽 Service Worker 訊息
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;

    if (data?.type === 'ACCEPT_CALL') {
      handlers.onAccept(data.callId, data.callerName, data.isVideoCall || false);
    } else if (data?.type === 'REJECT_CALL') {
      handlers.onReject(data.callId);
    } else if (data?.type === 'OPEN_CALL') {
      // 用戶點擊通知本身（非按鈕），打開來電介面
      handlers.onAccept(data.callId, data.callerName, data.isVideoCall || false);
    }
  });
}

// ============================================
// 輔助函式
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

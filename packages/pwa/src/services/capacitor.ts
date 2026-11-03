import { devLog, devWarn } from '../utils/devLog';
import type { IdentitySigner } from './mqttCredential';
import { signedPushRegister } from './pushRequest';
import { apiBase } from './apiBase';
import { postSigned } from './signedPost';

/**
 * Phase 15: Capacitor 原生服務整合
 *
 * 提供統一的原生功能 API，自動偵測環境並選擇適當的實作：
 * - 原生 App：使用 Capacitor 插件
 * - PWA：使用 Web API fallback
 */

import { Capacitor } from '@capacitor/core';

// ============================================
// 環境偵測
// ============================================

/** 是否為原生 App */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/** 取得平台 */
export function getPlatform(): 'ios' | 'android' | 'web' {
  return Capacitor.getPlatform() as 'ios' | 'android' | 'web';
}

/** 是否為 iOS */
export function isIOS(): boolean {
  return getPlatform() === 'ios';
}

/** 是否為 Android */
export function isAndroid(): boolean {
  return getPlatform() === 'android';
}

/** 原生 App 有沒有註冊這個外掛（開源第 5d 步：社群版的 Android 沒有官方版才有的外掛，例如守護功能的外掛） */
export function hasNativePlugin(name: string): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(name);
}

// （USB 除錯偵測是官方版登入畫面的安全檢查：src/ext-official/identity/usbDebug.ts）

// ============================================
// 相機服務
// ============================================

export interface CameraResult {
  dataUrl: string;
  format: string;
}

/** 拍照或選擇圖片 */
export async function takePhoto(source: 'camera' | 'photos' = 'camera'): Promise<CameraResult | null> {
  if (isNativeApp()) {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    try {
      const image = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      });
      return {
        dataUrl: image.dataUrl || '',
        format: image.format,
      };
    } catch (err) {
      console.error('[Capacitor] Camera error:', err);
      return null;
    }
  } else {
    // PWA fallback：使用 input[type=file]
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (source === 'camera') {
        input.capture = 'environment';
      }
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const dataUrl = await fileToDataUrl(file);
          resolve({
            dataUrl,
            format: file.type.split('/')[1] || 'jpeg',
          });
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  }
}

// ============================================
// 檔案系統服務
// ============================================

export interface SaveFileOptions {
  data: string; // base64 或文字
  filename: string;
  mimeType: string;
}

/** 儲存檔案到裝置 */
export async function saveFile(options: SaveFileOptions): Promise<boolean> {
  const { data, filename, mimeType } = options;

  if (isNativeApp()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    try {
      // 判斷是 base64 還是純文字
      const isBase64 = data.startsWith('data:') || !data.includes('\n');

      if (isBase64) {
        // 移除 data URL 前綴
        const base64Data = data.includes(',') ? data.split(',')[1] : data;
        await Filesystem.writeFile({
          path: `Download/${filename}`,
          data: base64Data,
          directory: Directory.Documents,
        });
      } else {
        await Filesystem.writeFile({
          path: `Download/${filename}`,
          data,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
        });
      }

      devLog('[Capacitor] File saved:', filename);
      return true;
    } catch (err) {
      console.error('[Capacitor] Save file error:', err);
      return false;
    }
  } else {
    // PWA fallback：觸發瀏覽器下載
    try {
      const blob = base64ToBlob(data, mimeType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error('[PWA] Save file error:', err);
      return false;
    }
  }
}

// ============================================
// 觸覺回饋服務
// ============================================

export type HapticType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

/** 觸發觸覺回饋 */
export async function hapticFeedback(type: HapticType = 'medium'): Promise<void> {
  if (isNativeApp()) {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');

    switch (type) {
      case 'light':
        await Haptics.impact({ style: ImpactStyle.Light });
        break;
      case 'medium':
        await Haptics.impact({ style: ImpactStyle.Medium });
        break;
      case 'heavy':
        await Haptics.impact({ style: ImpactStyle.Heavy });
        break;
      case 'success':
        await Haptics.notification({ type: NotificationType.Success });
        break;
      case 'warning':
        await Haptics.notification({ type: NotificationType.Warning });
        break;
      case 'error':
        await Haptics.notification({ type: NotificationType.Error });
        break;
    }
  } else {
    // PWA fallback：使用 Vibration API
    if ('vibrate' in navigator) {
      const patterns: Record<HapticType, number[]> = {
        light: [10],
        medium: [20],
        heavy: [50],
        success: [10, 50, 10],
        warning: [30, 30, 30],
        error: [50, 50, 50, 50],
      };
      navigator.vibrate(patterns[type] || [20]);
    }
  }
}

// ============================================
// 分享服務
// ============================================

export interface ShareOptions {
  title?: string;
  text?: string;
  url?: string;
  files?: File[];
}

/** 分享內容到其他 App */
export async function share(options: ShareOptions): Promise<boolean> {
  if (isNativeApp()) {
    const { Share } = await import('@capacitor/share');
    try {
      await Share.share({
        title: options.title,
        text: options.text,
        url: options.url,
        dialogTitle: options.title,
      });
      return true;
    } catch (err) {
      console.error('[Capacitor] Share error:', err);
      return false;
    }
  } else {
    // PWA fallback：使用 Web Share API
    if ('share' in navigator) {
      try {
        await navigator.share({
          title: options.title,
          text: options.text,
          url: options.url,
          files: options.files,
        });
        return true;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('[PWA] Share error:', err);
        }
        return false;
      }
    }
    return false;
  }
}

// ============================================
// 推播通知服務
// ============================================

export interface PushNotificationToken {
  value: string;
}

/** 註冊推播通知 */
export async function registerPushNotifications(): Promise<PushNotificationToken | null> {
  if (isNativeApp()) {
    // 先透過原生 plugin 檢查 Firebase 是否已初始化
    // PushNotifications.register() 會呼叫 FirebaseMessaging.getInstance()
    // 若無 google-services.json，原生線程會拋 IllegalStateException (FATAL, JS 無法 catch)
    // （開源第 5d 步：兩個版本都有的 FCMTokenPlugin 問；社群版沒有守護外掛，也可能沒有 google-services.json）
    try {
      const { FCMTokenPlugin } = await import('../plugins/fcmTokenPlugin');
      const { available } = await FCMTokenPlugin.hasFirebase();
      if (!available) {
        devWarn('[Capacitor] Firebase not initialized — skipping push registration (需要 google-services.json)');
        return null;
      }
    } catch (err) {
      devWarn('[Capacitor] Firebase check failed, skipping push registration:', err);
      return null;
    }

    const { PushNotifications } = await import('@capacitor/push-notifications');

    try {
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== 'granted') {
        devWarn('[Capacitor] Push notification permission denied');
        return null;
      }

      await PushNotifications.register();

      return new Promise((resolve) => {
        PushNotifications.addListener('registration', (token) => {
          devLog('[Capacitor] Push token:', token.value);
          resolve(token);
        });

        PushNotifications.addListener('registrationError', (err) => {
          devWarn('[Capacitor] Push registration error:', err);
          resolve(null);
        });
      });
    } catch (err) {
      devWarn('[Capacitor] Push notification error:', err);
      return null;
    }
  } else {
    // PWA fallback：使用 Web Push API
    const { subscribeToPush } = await import('./pushNotification');
    const subscription = await subscribeToPush();
    if (subscription) {
      // 將 Web Push 訂閱轉換為統一的 token 格式
      // 使用 endpoint 作為 token value（用於識別訂閱）
      return { value: subscription.endpoint };
    }
    return null;
  }
}

// ============================================
// FCM Token 註冊（離線推播）
// ============================================

/**
 * 等已解鎖的帳戶簽署函式（AppProvider 解鎖後交給 mqttService；ChatApp 掛載 2 秒後才呼叫這裡，通常已經有了）。
 * 最多等 waitMs；拿不到就不註冊 —— 伺服器只收帳戶簽章的註冊（A5），下次開 App 會再註冊一次。
 */
async function waitIdentitySigner(publicKeyBase64: string, waitMs = 15_000): Promise<IdentitySigner | null> {
  const { mqttService } = await import('./mqtt');
  for (let waited = 0; ; waited += 500) {
    const signer = mqttService.identitySignerFor(publicKeyBase64);
    if (signer || waited >= waitMs) return signer;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * 從 SharedPreferences 讀取 FCM token（Phase 20 備援機制）
 * 當 PushNotifications.register() 失敗時，嘗試讀取
 * AegisFCMService.onNewToken() 已存的 token
 */
async function getFcmTokenFromNative(): Promise<string | null> {
  try {
    const { FCMTokenPlugin } = await import('../plugins/fcmTokenPlugin');
    const { token } = await FCMTokenPlugin.getToken();
    if (token) {
      devLog('[FCM] Got token from SharedPreferences fallback');
      await FCMTokenPlugin.markSynced();
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * 註冊 FCM token 到 VPS，啟用離線推播通知
 * 只在原生 App 上呼叫（PWA 使用 Web Push）
 *
 * Phase 20: 加入 SharedPreferences 備援機制 —
 * PushNotifications 失敗時嘗試從 AegisFCMService 已存的 token 讀取
 *
 * A5（移植群星）：請求由已解鎖的帳戶金鑰簽章，token 掛在簽章者自己的公鑰下（伺服器自己算 hash）。
 * 以前送 client 自算的 pubkeyHash、不驗身分 —— 任何人都能把自己的手機掛到別人名下收他的推播。
 */
export async function registerFcmToken(publicKeyBase64: string): Promise<void> {
  if (!isNativeApp()) return;

  try {
    const signer = await waitIdentitySigner(publicKeyBase64);
    if (!signer) {
      devWarn('[FCM] No unlocked identity — skipping token registration');
      return;
    }
    let tokenValue: string | null = null;

    if (getPlatform() === 'ios') {
      // iOS：VPS firebase_messaging.send 需要「FCM registration token」，但 @capacitor/push-notifications
      //   在 iOS 回的是「APNs token」（不同東西）→ 必須改用 Firebase Messaging SDK 取的 FCM token
      //   （AppDelegate MessagingDelegate → FCMTokenPlugin）。權限/APNs 註冊已在 AppDelegate 啟動時做。
      tokenValue = await getFcmTokenFromNative();
    } else {
      // Android：Capacitor PushNotifications.register() 直接回 FCM token；失敗則退 SharedPreferences。
      const pushToken = await registerPushNotifications();
      tokenValue = pushToken ? pushToken.value : await getFcmTokenFromNative();
    }

    if (!tokenValue) {
      devWarn('[FCM] No push token obtained');
      return;
    }

    const platform = getPlatform() === 'ios' ? 'ios' : 'android';

    // 新帳號：AegisID 註冊在進聊天畫面之後才在背景跑完，那之前伺服器回 403 account_not_registered →
    //   隔一下再簽一次（每次新的 request_id），不然這次開 App 都收不到來電推播。
    //   時間用校正到伺服器的時鐘簽，時鐘差太多（401 clock_skew）用伺服器的時間重簽一次（開源第 4 步，signedPost）
    const { mqttService } = await import('./mqtt');
    const token = tokenValue;
    for (let attempt = 1; ; attempt++) {
      const response = await postSigned(`${apiBase()}/api/push/register-token`,
        (nowMs) => signedPushRegister(signer, token, platform, nowMs), mqttService.signedClock());
      if (response.ok) {
        devLog('[FCM] Token registered with VPS:', tokenValue.slice(0, 20) + '...');
        return;
      }
      if (response.status !== 403 || attempt >= 4) {
        devWarn('[FCM] Token registration failed:', response.status);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
    }
  } catch (err) {
    devWarn('[FCM] Token registration error:', err);
  }
}

// ============================================
// 本地通知服務
// ============================================

export interface LocalNotificationOptions {
  id: number;
  title: string;
  body: string;
  sound?: string;
  data?: Record<string, unknown>;
}

/** 顯示本地通知 */
export async function showLocalNotification(options: LocalNotificationOptions): Promise<void> {
  if (isNativeApp()) {
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    try {
      // 請求權限
      const permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') {
        devWarn('[Capacitor] Local notification permission denied');
        return;
      }

      await LocalNotifications.schedule({
        notifications: [
          {
            id: options.id,
            title: options.title,
            body: options.body,
            sound: options.sound,
            extra: options.data,
          },
        ],
      });
    } catch (err) {
      console.error('[Capacitor] Local notification error:', err);
    }
  } else {
    // PWA fallback：使用 Notification API
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        new Notification(options.title, {
          body: options.body,
          data: options.data,
        });
      }
    }
  }
}

// ============================================
// 狀態列服務
// ============================================

export interface StatusBarOptions {
  style?: 'dark' | 'light';
  backgroundColor?: string;
}

/** 設定狀態列 */
export async function setStatusBar(options: StatusBarOptions): Promise<void> {
  if (isNativeApp()) {
    const { StatusBar, Style } = await import('@capacitor/status-bar');

    try {
      // 確保 WebView 不會延伸到狀態列後方
      await StatusBar.setOverlaysWebView({ overlay: false });

      if (options.style) {
        await StatusBar.setStyle({
          style: options.style === 'dark' ? Style.Dark : Style.Light,
        });
      }

      if (options.backgroundColor && isAndroid()) {
        await StatusBar.setBackgroundColor({ color: options.backgroundColor });
      }
    } catch (err) {
      console.error('[Capacitor] StatusBar error:', err);
    }
  }
}

// ============================================
// 啟動畫面服務
// ============================================

/** 隱藏啟動畫面 */
export async function hideSplashScreen(): Promise<void> {
  if (isNativeApp()) {
    const { SplashScreen } = await import('@capacitor/splash-screen');

    try {
      await SplashScreen.hide();
    } catch (err) {
      console.error('[Capacitor] SplashScreen error:', err);
    }
  }
}

// ============================================
// 鍵盤服務
// ============================================

/** 監聽鍵盤事件 */
export async function setupKeyboardListeners(
  onShow?: (height: number) => void,
  onHide?: () => void
): Promise<() => void> {
  if (isNativeApp()) {
    const { Keyboard } = await import('@capacitor/keyboard');

    const showListener = await Keyboard.addListener('keyboardWillShow', (info) => {
      onShow?.(info.keyboardHeight);
    });

    const hideListener = await Keyboard.addListener('keyboardWillHide', () => {
      onHide?.();
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }

  // PWA: 使用 visualViewport
  if ('visualViewport' in window && window.visualViewport) {
    const viewport = window.visualViewport;
    const initialHeight = viewport.height;

    const handleResize = () => {
      const currentHeight = viewport.height;
      const keyboardHeight = initialHeight - currentHeight;

      if (keyboardHeight > 100) {
        onShow?.(keyboardHeight);
      } else {
        onHide?.();
      }
    };

    viewport.addEventListener('resize', handleResize);
    return () => viewport.removeEventListener('resize', handleResize);
  }

  return () => {};
}

// ============================================
// App 生命週期服務
// ============================================

/** 監聽 App 狀態變化 */
export async function setupAppListeners(
  onStateChange?: (isActive: boolean) => void,
  onBackButton?: () => void
): Promise<() => void> {
  if (isNativeApp()) {
    const { App } = await import('@capacitor/app');

    const stateListener = await App.addListener('appStateChange', (state) => {
      onStateChange?.(state.isActive);
    });

    const backListener = await App.addListener('backButton', () => {
      onBackButton?.();
    });

    return () => {
      stateListener.remove();
      backListener.remove();
    };
  }

  // PWA: 使用 visibilitychange
  const handleVisibility = () => {
    onStateChange?.(document.visibilityState === 'visible');
  };

  document.addEventListener('visibilitychange', handleVisibility);
  return () => document.removeEventListener('visibilitychange', handleVisibility);
}

// ============================================
// 原生生物辨識服務
// ============================================

export interface NativeBiometricResult {
  isAvailable: boolean;
  biometryType?: 'fingerprint' | 'face' | 'iris' | 'multiple';
  errorCode?: number;
}

/** 檢查原生生物辨識是否可用 */
export async function checkNativeBiometric(): Promise<NativeBiometricResult> {
  if (!isNativeApp()) {
    return { isAvailable: false };
  }

  try {
    const { NativeBiometric } = await import('capacitor-native-biometric');
    const result = await NativeBiometric.isAvailable();
    // biometryType 可能是 'touchId', 'faceId', 'fingerprintAuthentication' 等
    // 映射到我們的類型
    let biometryType: NativeBiometricResult['biometryType'] = undefined;
    if (result.biometryType) {
      const typeStr = String(result.biometryType).toLowerCase();
      if (typeStr.includes('finger') || typeStr.includes('touch')) {
        biometryType = 'fingerprint';
      } else if (typeStr.includes('face')) {
        biometryType = 'face';
      } else if (typeStr.includes('iris')) {
        biometryType = 'iris';
      } else {
        biometryType = 'fingerprint'; // 預設為指紋
      }
    }
    return {
      isAvailable: result.isAvailable,
      biometryType,
      errorCode: result.errorCode,
    };
  } catch (err) {
    console.error('[Capacitor] NativeBiometric check error:', err);
    return { isAvailable: false };
  }
}

/** 使用原生生物辨識驗證 */
export async function verifyNativeBiometric(
  reason: string = '請驗證您的身份'
): Promise<boolean> {
  if (!isNativeApp()) {
    return false;
  }

  try {
    const { NativeBiometric } = await import('capacitor-native-biometric');
    await NativeBiometric.verifyIdentity({
      reason,
      title: 'AegisTalk',
      subtitle: '生物辨識驗證',
      description: reason,
    });
    return true;
  } catch (err) {
    console.error('[Capacitor] NativeBiometric verify error:', err);
    return false;
  }
}

/** 儲存憑證到原生安全儲存 */
export async function setNativeBiometricCredentials(
  server: string,
  username: string,
  password: string
): Promise<boolean> {
  if (!isNativeApp()) {
    return false;
  }

  try {
    const { NativeBiometric } = await import('capacitor-native-biometric');
    await NativeBiometric.setCredentials({
      server,
      username,
      password,
    });
    return true;
  } catch (err) {
    console.error('[Capacitor] NativeBiometric setCredentials error:', err);
    return false;
  }
}

/** 從原生安全儲存讀取憑證 */
export async function getNativeBiometricCredentials(
  server: string
): Promise<{ username: string; password: string } | null> {
  if (!isNativeApp()) {
    return null;
  }

  try {
    const { NativeBiometric } = await import('capacitor-native-biometric');
    const result = await NativeBiometric.getCredentials({ server });
    return {
      username: result.username,
      password: result.password,
    };
  } catch (err) {
    console.error('[Capacitor] NativeBiometric getCredentials error:', err);
    return null;
  }
}

/** 刪除原生安全儲存的憑證 */
export async function deleteNativeBiometricCredentials(
  server: string
): Promise<boolean> {
  if (!isNativeApp()) {
    return false;
  }

  try {
    const { NativeBiometric } = await import('capacitor-native-biometric');
    await NativeBiometric.deleteCredentials({ server });
    return true;
  } catch (err) {
    console.error('[Capacitor] NativeBiometric deleteCredentials error:', err);
    return false;
  }
}

// ============================================
// 輔助函數
// ============================================

/** File 轉 Data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Base64 轉 Blob */
function base64ToBlob(dataUrl: string, mimeType: string): Blob {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// ============================================
// 匯出
// ============================================

export default {
  isNativeApp,
  getPlatform,
  isIOS,
  isAndroid,
  takePhoto,
  saveFile,
  hapticFeedback,
  share,
  registerPushNotifications,
  showLocalNotification,
  setStatusBar,
  hideSplashScreen,
  setupKeyboardListeners,
  setupAppListeners,
};

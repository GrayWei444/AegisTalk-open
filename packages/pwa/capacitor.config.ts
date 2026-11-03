import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 版本（開源第 5d 步）：AEGIS_EDITION=chat 的社群版 "AegisTalk Chat (community)"，com.aegisrd.talk.community（自架的人用
//   AEGIS_CHAT_APP_ID 換掉；Android 的 application id 由 app/build.gradle 的 flavour 決定，這裡給 cap 的設定檔與 iOS 用）
const CHAT = (process.env.AEGIS_EDITION ?? 'chat') === 'chat';

/**
 * In-app navigation (security review L3). Capacitor 8 adds every allowNavigation origin to the origins its native bridge
 * answers (Bridge.java), so a page that loads there inside the WebView can call the app's plugins (ring context, FCM token,
 * share …). The community edition allows none: links open outside the app. The official edition keeps its own list with
 * its other private settings (src/ext-official/capacitor.json, not part of the community repository).
 */
function officialNavigation(): string[] {
  const file = resolve(__dirname, 'src/ext-official/capacitor.json');
  let list: unknown;
  try {
    list = (JSON.parse(readFileSync(file, 'utf8')) as { allowNavigation?: unknown }).allowNavigation;
  } catch {
    throw new Error(`the official edition needs ${file}; this checkout builds the community edition (AEGIS_EDITION=chat)`);
  }
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error(`${file}: allowNavigation must be a list of origins`);
  return list;
}
const allowNavigation: string[] = CHAT ? [] : officialNavigation();

const config: CapacitorConfig = {
  appId: CHAT ? (process.env.AEGIS_CHAT_APP_ID || 'com.aegisrd.talk.community') : 'com.aegisrd.talk',
  appName: CHAT ? (process.env.AEGIS_CHAT_APP_NAME || 'AegisTalk Chat (community)') : 'AegisTalk',
  webDir: 'dist',
  // DIAG: enable logging in release builds for debugging
  loggingBehavior: 'production',

  // 伺服器設定
  server: {
    // 生產環境使用本地檔案
    androidScheme: 'https',
    iosScheme: 'https',
    // 允許在 App 裡開的網址（上面 officialNavigation 的說明：社群版沒有）
    allowNavigation,
  },

  // Android 設定
  android: {
    // 允許混合內容 (開發用)
    allowMixedContent: false,
    // 背景色（預設淺色，配合 App 預設主題）
    backgroundColor: '#ffffff',
  },

  // iOS 設定
  ios: {
    // 背景色（預設淺色，配合 App 預設主題）
    backgroundColor: '#ffffff',
    // 內容模式
    // 'never'：內容延伸到 safe area（含 home indicator 下方），否則 WKWebView
    // 自動內縮會在底部露出原生背景色白邊（2026-06-13 iPhone 13 真機實測）
    contentInset: 'never',
    // 捲動行為
    scrollEnabled: true,
  },

  // 插件設定
  plugins: {
    // 推播通知
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    // 相機
    Camera: {
      // 相簿權限描述
      photosUsageDescription: 'AegisTalk 需要存取相簿以傳送圖片',
      // 相機權限描述
      cameraUsageDescription: 'AegisTalk 需要存取相機以拍攝照片和視訊通話',
    },
    // 麥克風
    Microphone: {
      // 麥克風權限描述
      microphoneUsageDescription: 'AegisTalk 需要存取麥克風以進行語音和視訊通話',
    },
    // 檔案存取
    Filesystem: {
      // 檔案存取權限描述
      storageDescription: 'AegisTalk 需要存取儲存空間以儲存下載的檔案',
    },
    // 螢幕方向
    ScreenOrientation: {
      // 預設直向
      defaultOrientation: 'portrait',
    },
    // 鍵盤
    Keyboard: {
      // resize:'native' 縮整個 WebView frame → h-[100dvh]/h-screen 容器與 fixed inset-0 modal
      // 都會讓出鍵盤空間，底部輸入框（聊天/好友碼/群組）自然浮上來。
      // 'body' 只縮 document.body，救不了 dvh/vh 滿版容器 → 輸入框被鍵盤蓋住（原 bug）。
      resize: 'native',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    // 狀態列
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0d1b2a',
      overlaysWebView: false,
    },
    // 啟動畫面（預設淺色，配合 App 預設主題）
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    // SQLite 統一資料庫
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;

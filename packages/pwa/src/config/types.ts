/**
 * AegisTalk 白標配置類型定義
 *
 * Phase 13: 白標抽象架構
 *
 * 這些類型定義了 AegisTalk 的所有可配置項目，
 * 使同一套程式碼可以為不同客戶快速部署專屬版本。
 */

// ============================================
// 品牌配置 (BrandConfig)
// ============================================

/**
 * Logo 配置
 */
export interface LogoConfig {
  /** 淺色主題 Logo URL (用於深色背景) */
  light: string;
  /** 深色主題 Logo URL (用於淺色背景) */
  dark: string;
  /** Favicon URL */
  favicon: string;
  /** PWA App 圖示 (192x192) */
  appIcon192: string;
  /** PWA App 圖示 (512x512) */
  appIcon512: string;
  /** PWA 可遮罩圖示 (512x512, maskable) */
  appIconMaskable: string;
}

/**
 * 顏色配置
 */
export interface ColorConfig {
  /** 主色 (品牌色) - 例如: #26c6da */
  primary: string;
  /** 主色淺色變體 */
  primaryLight: string;
  /** 主色深色變體 */
  primaryDark: string;
  /** 次要色 */
  secondary: string;
  /** 危險/警告色 - 例如: #ef4444 */
  danger: string;
  /** 成功色 - 例如: #22c55e */
  success: string;
  /** 警示色 - 例如: #f59e0b */
  warning: string;
  /** 深色主題背景 */
  darkBg: string;
  /** 深色主題卡片背景 */
  darkCard: string;
  /** 深色主題邊框 */
  darkBorder: string;
  /** 淺色主題背景 */
  lightBg: string;
  /** 淺色主題卡片背景 */
  lightCard: string;
  /** 淺色主題邊框 */
  lightBorder: string;
}

/**
 * 字體配置
 */
export interface FontConfig {
  /** 主要字體堆疊 */
  primary: string;
  /** 等寬字體堆疊 */
  mono: string;
}

/**
 * 法律與隱私配置
 */
export interface LegalConfig {
  /** 隱私政策 URL */
  privacyPolicyUrl: string;
  /** 服務條款 URL */
  termsOfServiceUrl: string;
  /** 公司名稱 */
  companyName: string;
  /** 客服信箱 */
  supportEmail: string;
  /** 版權聲明 */
  copyright: string;
}

/**
 * 品牌配置
 */
export interface BrandConfig {
  /** App 名稱 - 例如: "AegisTalk" 或 "XX 安全通訊" */
  appName: string;
  /** App 簡短名稱 (PWA home screen) */
  appShortName: string;
  /** App 描述 */
  appDescription: string;
  /** 版本號 */
  version: string;
  /** 語言代碼 - 例如: "zh-TW" */
  language: string;
  /** Logo 配置 */
  logo: LogoConfig;
  /** 顏色配置 */
  colors: ColorConfig;
  /** 字體配置 */
  fonts: FontConfig;
  /** 法律配置 */
  legal: LegalConfig;
}

// ============================================
// 功能配置 (FeaturesConfig)
// ============================================

/**
 * 訊息功能配置
 */
export interface MessagingFeatures {
  /** 基本訊息功能 (必須開啟) */
  enabled: true;
  /** 語音訊息 */
  voiceMessage: boolean;
  /** 視訊通話 */
  videoCall: boolean;
  /** 語音通話 */
  voiceCall: boolean;
  /** 群組通話 */
  groupCall: boolean;
  /** 檔案分享 */
  fileSharing: boolean;
  /** 群組檔案分享 */
  groupFileSharing: boolean;
  /** E2E 加密 (必須開啟) */
  e2eEncryption: true;
  /** 群組聊天 */
  groupChat: boolean;
}

/**
 * 防詐功能配置
 */
export interface AegisProtectionFeatures {
  /** L1 語意 AI (Whisper + MiniLM) */
  l1SemanticAI: boolean;
  /** L2 規則引擎 (WASM) */
  l2RuleEngine: boolean;
  /** L3 行為 AI (Isolation Forest) */
  l3BehaviorAI: boolean;
  /** 語音風險分析 */
  voiceRiskAnalysis: boolean;
  /** 社交圖譜信任分數 */
  trustScore: boolean;
  /** PIN 行為指紋 */
  pinBehaviorFingerprint: boolean;
  /** 臉部辨識 (Phase 26) */
  faceRecognition: boolean;
  /** 設備指紋 */
  deviceFingerprint: boolean;
  /** 同源偵測 */
  sameSourceDetection: boolean;
  /** USB 除錯偵測 (Android) */
  usbDebuggingCheck: boolean;
}

/**
 * 附加功能配置
 */
export interface AddonFeatures {
  /** AegisPay 支付整合 */
  aegisPay: boolean;
  /** AegisGuard 防護模組 */
  aegisGuard: boolean;
  /** 推播通知 */
  pushNotifications: boolean;
  /** 開發者工具 */
  devTools: boolean;
  /** 設備轉移 */
  deviceTransfer: boolean;
}

/**
 * 授權類型
 */
export type LicenseType = 'free' | 'pro' | 'enterprise';

/**
 * 授權配置
 */
export interface LicenseConfig {
  /** 授權類型 */
  type: LicenseType;
  /** 授權到期時間 (Unix timestamp, 可選) */
  expiresAt?: number;
  /** 最大用戶數 (可選) */
  maxUsers?: number;
  /** 已授權功能列表 */
  features: string[];
  /** 授權金鑰 (可選) */
  licenseKey?: string;
}

/**
 * 功能配置
 */
export interface FeaturesConfig {
  /** 訊息功能 */
  messaging: MessagingFeatures;
  /** 防詐功能 */
  aegisProtection: AegisProtectionFeatures;
  /** 附加功能 */
  addons: AddonFeatures;
  /** 授權 */
  license: LicenseConfig;
}

// ============================================
// 環境配置 (EnvironmentConfig)
// ============================================

/**
 * 環境名稱
 */
export type EnvironmentName = 'development' | 'staging' | 'uat' | 'production';

/**
 * API 端點配置
 */
export interface ApiEndpoints {
  /** 主 API URL - 例如: https://chat-api.example.com */
  baseUrl: string;
  /** MQTT Broker URL - 例如: wss://chat-mqtt.example.com/mqtt */
  mqttUrl: string;
  /** TURN 伺服器 URL */
  turnServer: string;
  /** STUN 伺服器 URL */
  stunServer: string;
  /** TURN 帳號 (可選) */
  turnUsername?: string;
  /** TURN 密碼 (可選) */
  turnCredential?: string;
}

/**
 * 認證配置
 */
export interface AuthConfig {
  /** OAuth Client ID (可選) */
  clientId?: string;
  /** OAuth Redirect URI (可選) */
  redirectUri?: string;
}

/**
 * 儲存配置
 */
export interface StorageConfig {
  /** IndexedDB 資料庫名稱 */
  indexedDBName: string;
  /** 本地加密金鑰 (可選, 用於額外加密) */
  encryptionKey?: string;
}

/**
 * 除錯配置
 */
export interface DebugConfig {
  /** 是否啟用除錯模式 */
  enabled: boolean;
  /** 日誌等級 */
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** 是否使用 Mock 資料 */
  mockData: boolean;
  /** 是否顯示效能指標 */
  showPerformanceMetrics: boolean;
}

/**
 * UI 配置
 */
export interface UIConfig {
  /** 是否啟用 Safe Area (iPhone 瀏海/動態島、Android 狀態列) */
  safeArea: {
    /** 頂部 Safe Area */
    top: boolean;
    /** 底部 Safe Area */
    bottom: boolean;
  };
  /** 狀態列配置 */
  statusBar: {
    /** 狀態列樣式 (dark: 深色文字, light: 淺色文字) */
    style: 'dark' | 'light';
    /** 狀態列背景色 */
    backgroundColor: string;
    /** 是否覆蓋在內容上方 */
    overlay: boolean;
  };
  /** 導航配置 */
  navigation: {
    /** 是否顯示返回按鈕 */
    showBackButton: boolean;
    /** 手勢導航 */
    gestureNavigation: boolean;
  };
}

/**
 * 環境配置
 */
export interface EnvironmentConfig {
  /** 環境名稱 */
  name: EnvironmentName;
  /** API 端點 */
  api: ApiEndpoints;
  /** 認證配置 */
  auth: AuthConfig;
  /** 儲存配置 */
  storage: StorageConfig;
  /** 除錯配置 */
  debug: DebugConfig;
  /** UI 配置 */
  ui: UIConfig;
}

// ============================================
// 完整配置 (AppConfig)
// ============================================

/**
 * 完整 App 配置
 */
export interface AppConfig {
  /** 品牌配置 */
  brand: BrandConfig;
  /** 功能配置 */
  features: FeaturesConfig;
  /** 環境配置 */
  environment: EnvironmentConfig;
}

// ============================================
// 配置工具類型
// ============================================

/**
 * 深度部分類型 (用於配置覆寫)
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * 配置覆寫類型
 */
export type ConfigOverrides = DeepPartial<AppConfig>;

/**
 * 功能鍵名 (用於 FeatureGate)
 */
export type FeatureKey =
  | keyof MessagingFeatures
  | keyof AegisProtectionFeatures
  | keyof AddonFeatures;

/**
 * 功能路徑 (用於 useFeature hook)
 */
export type FeaturePath =
  | `messaging.${keyof MessagingFeatures}`
  | `aegisProtection.${keyof AegisProtectionFeatures}`
  | `addons.${keyof AddonFeatures}`;

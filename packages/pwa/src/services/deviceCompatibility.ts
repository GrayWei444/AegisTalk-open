/**
 * Device Compatibility Service
 *
 * 偵測裝置版本並判斷功能相容性
 * 最低支援: iOS 14.5+ / Android 8.0+
 */

import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

// ============================================
// 類型定義
// ============================================

export interface DeviceInfo {
  platform: 'ios' | 'android' | 'web';
  osVersion: string;
  osVersionNumber: number;
  model: string;
  manufacturer: string;
  isNative: boolean;
}

export interface CompatibilityResult {
  isSupported: boolean;
  platform: 'ios' | 'android' | 'web';
  currentVersion: string;
  minimumVersion: string;
  missingFeatures: string[];
  upgradeRequired: boolean;
  upgradeMessage: string;
}

export interface FeatureSupport {
  wasm: boolean;
  webrtc: boolean;
  indexeddb: boolean;
  audioWorklet: boolean;
  speechRecognition: boolean;
  webAuthn: boolean;
  pushNotification: boolean;
}

// ============================================
// 版本要求常數
// ============================================

export const MINIMUM_VERSIONS = {
  ios: 14.5,
  android: 8.0, // API 26
} as const;

export const RECOMMENDED_VERSIONS = {
  ios: 17.0,
  android: 12.0, // API 31
} as const;

// ============================================
// 版本解析工具
// ============================================

/**
 * 解析版本字串為數字 (e.g., "14.5.1" -> 14.5)
 */
function parseVersionNumber(version: string): number {
  if (!version) return 0;

  // 取前兩段 (major.minor)
  const parts = version.split('.');
  const major = parseInt(parts[0], 10) || 0;
  const minor = parseInt(parts[1], 10) || 0;

  return major + minor / 10;
}

/**
 * 從 User Agent 解析 iOS 版本
 */
function parseIOSVersionFromUA(): string | null {
  const ua = navigator.userAgent;

  // iPhone/iPad: "CPU iPhone OS 17_2_1 like Mac OS X"
  const iosMatch = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))?/);
  if (iosMatch) {
    const major = iosMatch[1];
    const minor = iosMatch[2];
    const patch = iosMatch[3] || '0';
    return `${major}.${minor}.${patch}`;
  }

  return null;
}

/**
 * 從 User Agent 解析 Android 版本
 */
function parseAndroidVersionFromUA(): string | null {
  const ua = navigator.userAgent;

  // Android: "Android 13; Pixel 6"
  const androidMatch = ua.match(/Android (\d+(?:\.\d+)?)/);
  if (androidMatch) {
    return androidMatch[1];
  }

  return null;
}

// ============================================
// 裝置資訊取得
// ============================================

/**
 * 取得裝置資訊
 */
export async function getDeviceInfo(): Promise<DeviceInfo> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    try {
      const info = await Device.getInfo();
      return {
        platform: info.platform as 'ios' | 'android',
        osVersion: info.osVersion,
        osVersionNumber: parseVersionNumber(info.osVersion),
        model: info.model,
        manufacturer: info.manufacturer,
        isNative: true,
      };
    } catch (err) {
      console.error('[DeviceCompatibility] Failed to get device info:', err);
    }
  }

  // PWA/Web 環境 - 從 User Agent 解析
  const ua = navigator.userAgent;
  let platform: 'ios' | 'android' | 'web' = 'web';
  let osVersion = 'unknown';

  if (/iPhone|iPad|iPod/.test(ua)) {
    platform = 'ios';
    osVersion = parseIOSVersionFromUA() || 'unknown';
  } else if (/Android/.test(ua)) {
    platform = 'android';
    osVersion = parseAndroidVersionFromUA() || 'unknown';
  }

  return {
    platform,
    osVersion,
    osVersionNumber: parseVersionNumber(osVersion),
    model: 'unknown',
    manufacturer: 'unknown',
    isNative: false,
  };
}

// ============================================
// 功能支援偵測
// ============================================

/**
 * 檢測各項功能支援
 */
export function checkFeatureSupport(): FeatureSupport {
  return {
    wasm: typeof WebAssembly !== 'undefined',
    webrtc: 'RTCPeerConnection' in window,
    indexeddb: 'indexedDB' in window,
    audioWorklet: 'AudioWorklet' in window || 'audioWorklet' in ((window as Window & typeof globalThis & { AudioContext?: typeof AudioContext }).AudioContext?.prototype || {}),
    speechRecognition: 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window,
    webAuthn: 'PublicKeyCredential' in window,
    pushNotification: 'PushManager' in window && 'serviceWorker' in navigator,
  };
}

// ============================================
// 相容性檢查
// ============================================

/**
 * 檢查裝置相容性
 */
export async function checkCompatibility(): Promise<CompatibilityResult> {
  const deviceInfo = await getDeviceInfo();
  const featureSupport = checkFeatureSupport();

  const { platform, osVersion, osVersionNumber } = deviceInfo;

  // Web 平台不限制版本
  if (platform === 'web') {
    const missingFeatures: string[] = [];
    if (!featureSupport.wasm) missingFeatures.push('WebAssembly');
    if (!featureSupport.webrtc) missingFeatures.push('WebRTC');
    if (!featureSupport.indexeddb) missingFeatures.push('IndexedDB');

    return {
      isSupported: missingFeatures.length === 0,
      platform,
      currentVersion: 'N/A',
      minimumVersion: 'N/A',
      missingFeatures,
      upgradeRequired: missingFeatures.length > 0,
      upgradeMessage: missingFeatures.length > 0
        ? '您的瀏覽器不支援部分功能，請使用最新版本的 Chrome、Safari 或 Firefox。'
        : '',
    };
  }

  // iOS 版本檢查
  if (platform === 'ios') {
    const minimumVersion = MINIMUM_VERSIONS.ios;
    const isSupported = osVersionNumber >= minimumVersion;
    const missingFeatures: string[] = [];

    if (osVersionNumber < 14.5) {
      missingFeatures.push('AudioWorklet (語音分析)');
    }
    if (osVersionNumber < 17.0) {
      missingFeatures.push('sherpa-onnx 語音辨識');
    }

    return {
      isSupported,
      platform,
      currentVersion: osVersion,
      minimumVersion: `${minimumVersion}`,
      missingFeatures,
      upgradeRequired: !isSupported,
      upgradeMessage: !isSupported
        ? `您的 iOS 版本 (${osVersion}) 過舊，無法使用 AegisTalk。\n\n請升級至 iOS ${minimumVersion} 或更新版本。\n\n升級方式：\n設定 → 一般 → 軟體更新`
        : '',
    };
  }

  // Android 版本檢查
  if (platform === 'android') {
    const minimumVersion = MINIMUM_VERSIONS.android;
    const isSupported = osVersionNumber >= minimumVersion;
    const missingFeatures: string[] = [];

    if (osVersionNumber < 8.0) {
      missingFeatures.push('WebAssembly');
      missingFeatures.push('Service Worker');
    }

    return {
      isSupported,
      platform,
      currentVersion: osVersion,
      minimumVersion: `${minimumVersion}`,
      missingFeatures,
      upgradeRequired: !isSupported,
      upgradeMessage: !isSupported
        ? `您的 Android 版本 (${osVersion}) 過舊，無法使用 AegisTalk。\n\n請升級至 Android ${minimumVersion} 或更新版本。\n\n升級方式：\n設定 → 系統 → 軟體更新`
        : '',
    };
  }

  // 未知平台
  return {
    isSupported: true,
    platform: 'web',
    currentVersion: 'unknown',
    minimumVersion: 'N/A',
    missingFeatures: [],
    upgradeRequired: false,
    upgradeMessage: '',
  };
}

// ============================================
// 快速檢查函數
// ============================================

/**
 * 快速檢查是否支援（不需要 async）
 * 用於需要同步判斷的場景
 */
export function quickCompatibilityCheck(): { isLikelySupported: boolean; platform: string } {
  const ua = navigator.userAgent;

  // 先檢查是否為原生 Capacitor App
  // 如果不是原生環境，視為 Web 並使用功能偵測
  // 這避免 Chrome DevTools 響應式模式的假 User Agent 問題
  const isNativePlatform = Capacitor.isNativePlatform();

  if (!isNativePlatform) {
    // Web 環境（包括桌面瀏覽器的響應式模式）
    // 使用功能偵測而非 User Agent 版本
    return {
      isLikelySupported: typeof WebAssembly !== 'undefined',
      platform: 'web',
    };
  }

  // 以下為原生 App 環境的版本檢查

  // iOS 檢查
  const iosMatch = ua.match(/OS (\d+)[_.](\d+)/);
  if (iosMatch) {
    const version = parseInt(iosMatch[1], 10) + parseInt(iosMatch[2], 10) / 10;
    return {
      isLikelySupported: version >= MINIMUM_VERSIONS.ios,
      platform: 'ios',
    };
  }

  // Android 檢查
  const androidMatch = ua.match(/Android (\d+)/);
  if (androidMatch) {
    const version = parseInt(androidMatch[1], 10);
    return {
      isLikelySupported: version >= MINIMUM_VERSIONS.android,
      platform: 'android',
    };
  }

  // 未知平台預設支援
  return {
    isLikelySupported: typeof WebAssembly !== 'undefined',
    platform: 'web',
  };
}

/**
 * 是否為舊版 iOS（低於 14.5）
 */
export function isOldiOS(): boolean {
  const { isLikelySupported, platform } = quickCompatibilityCheck();
  return platform === 'ios' && !isLikelySupported;
}

/**
 * 是否為舊版 Android（低於 8.0）
 */
export function isOldAndroid(): boolean {
  const { isLikelySupported, platform } = quickCompatibilityCheck();
  return platform === 'android' && !isLikelySupported;
}

// ============================================
// 功能降級建議
// ============================================

export interface DegradedFeatures {
  voiceAnalysis: boolean;
  speechRecognition: boolean;
  biometric: boolean;
  pushNotification: boolean;
}

/**
 * 取得需要降級的功能列表
 */
export async function getDegradedFeatures(): Promise<DegradedFeatures> {
  const deviceInfo = await getDeviceInfo();
  const { platform, osVersionNumber } = deviceInfo;

  if (platform === 'ios') {
    return {
      voiceAnalysis: osVersionNumber < 14.5,
      speechRecognition: osVersionNumber < 17.0,
      biometric: osVersionNumber < 16.0,
      pushNotification: osVersionNumber < 16.4,
    };
  }

  if (platform === 'android') {
    return {
      voiceAnalysis: osVersionNumber < 10.0,
      speechRecognition: osVersionNumber < 10.0,
      biometric: osVersionNumber < 9.0,
      pushNotification: false, // Android FCM 支援較好
    };
  }

  // Web 平台根據 feature detection
  const features = checkFeatureSupport();
  return {
    voiceAnalysis: !features.audioWorklet,
    speechRecognition: !features.speechRecognition,
    biometric: !features.webAuthn,
    pushNotification: !features.pushNotification,
  };
}

// ============================================
// 匯出
// ============================================

export default {
  getDeviceInfo,
  checkCompatibility,
  checkFeatureSupport,
  quickCompatibilityCheck,
  isOldiOS,
  isOldAndroid,
  getDegradedFeatures,
  MINIMUM_VERSIONS,
  RECOMMENDED_VERSIONS,
};

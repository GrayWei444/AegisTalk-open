import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * AegisQrScanner — iOS 原生 QR 掃描（對應 AegisQrScannerPlugin.swift）。
 *
 * 為何原生：WKWebView getUserMedia 無法可靠對焦 + html5-qrcode 只在小 qrbox 解碼 →
 * 密集好友 QR 只有窄距離才掃得到。原生 AVFoundation 連續自動對焦(near) + 全畫面解碼，任何距離都掃得到。
 *
 * web(PWA) 端不可用 → isNativeQrScannerAvailable() 回 false → AddFriendModal 走 html5-qrcode fallback。
 */
export interface AegisQrScannerPlugin {
  /** 開原生全螢幕掃描器；掃到回 { value }，使用者取消回 { cancelled: true }，相機/權限錯誤 reject。 */
  scan(): Promise<{ value?: string; cancelled?: boolean }>;
}

export const AegisQrScanner = registerPlugin<AegisQrScannerPlugin>('AegisQrScanner', {
  // web 沒有原生實作；呼叫端應先用 isNativeQrScannerAvailable() 守門，這裡僅作安全 fallback
  web: {
    async scan() { return { cancelled: true }; },
  },
});

/** 只有 iOS 原生 App 且 plugin 已註冊時為 true（PWA/Android-web 走 html5-qrcode）。 */
export function isNativeQrScannerAvailable(): boolean {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('AegisQrScanner');
}

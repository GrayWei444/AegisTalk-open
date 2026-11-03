/**
 * AegisTalk 預設品牌配置
 *
 * Phase 13: 白標抽象架構
 *
 * 這是 AegisTalk 的預設品牌設定。
 * 白標客戶可以透過覆寫這些值來自訂品牌。
 */

import type { BrandConfig } from './types';

/**
 * AegisTalk 預設品牌配置
 */
export const defaultBrandConfig: BrandConfig = {
  // 基本資訊
  appName: 'AegisTalk',
  appShortName: 'AegisTalk',
  appDescription: 'AI 防詐通訊平台 - 讓每一次對話都有 AI 守護',
  version: '0.10.5',
  language: 'zh-TW',

  // Logo 配置
  logo: {
    light: '/logo-transparent.png',
    dark: '/logo-transparent.png',
    favicon: '/favicon.png',
    appIcon192: '/logo-192.png',
    appIcon512: '/logo-512.png',
    appIconMaskable: '/logo-512-masked.png',
  },

  // 顏色配置 (基於現有 Tailwind 設定)
  colors: {
    // 主色 - Aegis 品牌色 (青色系)
    primary: '#26c6da',
    primaryLight: '#4dd0e1',
    primaryDark: '#00acc1',

    // 次要色
    secondary: '#7c3aed',

    // 狀態色
    danger: '#ef4444',
    success: '#22c55e',
    warning: '#f59e0b',

    // 深色主題
    darkBg: '#0d1b2a',
    darkCard: '#142638',
    darkBorder: '#1e3a5c',

    // 淺色主題
    lightBg: '#f8fafc',
    lightCard: '#ffffff',
    lightBorder: '#e2e8f0',
  },

  // 字體配置
  fonts: {
    primary: [
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue',
      'Arial',
      'Noto Sans TC',
      'sans-serif',
    ].join(', '),
    mono: [
      'SF Mono',
      'Monaco',
      'Inconsolata',
      'Fira Code',
      'Fira Mono',
      'Droid Sans Mono',
      'Source Code Pro',
      'monospace',
    ].join(', '),
  },

  // 法律配置（開源第 5c 步：預設不寫任何服務的網址或信箱 —— 社群版的條款／隱私／支援連結來自所選伺服器的 server-config，
  //   官方版在 main.tsx 用 '@ext/server' 的 brandLegal 補上官方的）
  legal: {
    privacyPolicyUrl: '',
    termsOfServiceUrl: '',
    companyName: 'AegisRD',
    supportEmail: '',
    copyright: '© 2026 AegisRD',
  },
};

export default defaultBrandConfig;

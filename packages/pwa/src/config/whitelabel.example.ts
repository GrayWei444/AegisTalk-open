/**
 * 白標配置範例
 *
 * Phase 13: 白標抽象架構
 *
 * 這是一個白標配置範例，展示如何為不同客戶自訂 AegisTalk。
 * 複製此檔案並修改值來建立自訂配置。
 */

import type { ConfigOverrides } from './types';

// ============================================
// 範例 1: 銀行客戶 (BankSecure)
// ============================================

/**
 * 銀行客戶白標配置
 *
 * 特點：
 * - 自訂品牌名稱和顏色
 * - 啟用支付風控功能
 * - 停用開發者工具
 */
export const bankSecureConfig: ConfigOverrides = {
  brand: {
    appName: 'BankSecure 安全通訊',
    appShortName: 'BankSecure',
    appDescription: '銀行級安全通訊 - 守護您的每一次對話',
    version: '1.0.0',
    language: 'zh-TW',

    colors: {
      // 銀行藍色品牌
      primary: '#1e40af',
      primaryLight: '#3b82f6',
      primaryDark: '#1e3a8a',
      secondary: '#0f766e',
    },

    legal: {
      privacyPolicyUrl: 'https://banksecure.example.com/privacy',
      termsOfServiceUrl: 'https://banksecure.example.com/terms',
      companyName: 'BankSecure Inc.',
      supportEmail: 'support@banksecure.example.com',
      copyright: '© 2026 BankSecure Inc. All rights reserved.',
    },
  },

  features: {
    messaging: {
      videoCall: true,
      voiceCall: true,
      groupCall: false, // 銀行版不支援群組通話
    },
    aegisProtection: {
      l1SemanticAI: false, // 銀行版不需要語意 AI
      l2RuleEngine: true,
      l3BehaviorAI: true,
      voiceRiskAnalysis: true,
    },
    addons: {
      aegisPay: true, // 啟用支付風控
      devTools: false, // 生產環境關閉
    },
    license: {
      type: 'enterprise',
      features: ['messaging.*', 'aegisProtection.*', 'addons.aegisPay'],
    },
  },

  environment: {
    name: 'production',
    api: {
      baseUrl: 'https://api.banksecure.example.com',
      mqttUrl: 'wss://mqtt.banksecure.example.com/mqtt',
    },
    storage: {
      indexedDBName: 'banksecure',
    },
    debug: {
      enabled: false,
      logLevel: 'error',
    },
  },
};

// ============================================
// 範例 2: 保險公司 (InsureChat)
// ============================================

/**
 * 保險公司白標配置
 *
 * 特點：
 * - 綠色品牌
 * - 啟用語音風險分析 (詐騙電話偵測)
 * - 免費版功能限制
 */
export const insureChatConfig: ConfigOverrides = {
  brand: {
    appName: 'InsureChat 安全聊',
    appShortName: 'InsureChat',
    appDescription: '保險業專用安全通訊平台',
    version: '1.0.0',

    colors: {
      // 保險綠色品牌
      primary: '#059669',
      primaryLight: '#10b981',
      primaryDark: '#047857',
      secondary: '#7c3aed',
    },

    legal: {
      privacyPolicyUrl: 'https://insurechat.example.com/privacy',
      termsOfServiceUrl: 'https://insurechat.example.com/terms',
      companyName: 'InsureChat Corp.',
      supportEmail: 'help@insurechat.example.com',
      copyright: '© 2026 InsureChat Corp.',
    },
  },

  features: {
    messaging: {
      videoCall: false, // Pro 版才支援
      voiceCall: true,
      groupCall: false,
      fileSharing: true,
    },
    aegisProtection: {
      l1SemanticAI: false,
      l2RuleEngine: true,
      l3BehaviorAI: false, // Pro 版才支援
      voiceRiskAnalysis: true, // 重點功能：詐騙電話偵測
    },
    addons: {
      aegisPay: false,
      devTools: false,
    },
    license: {
      type: 'free',
      features: [
        'messaging.enabled',
        'messaging.voiceCall',
        'messaging.fileSharing',
        'aegisProtection.l2RuleEngine',
        'aegisProtection.voiceRiskAnalysis',
      ],
    },
  },
};

// ============================================
// 範例 3: 電商平台 (ShopSafe)
// ============================================

/**
 * 電商平台白標配置
 *
 * 特點：
 * - 橘色品牌
 * - 啟用支付風控
 * - 啟用檔案分享 (商品圖片)
 * - 停用語音功能
 */
export const shopSafeConfig: ConfigOverrides = {
  brand: {
    appName: 'ShopSafe 安心購',
    appShortName: 'ShopSafe',
    appDescription: '電商專用安全通訊 - 防詐交易守護者',

    colors: {
      // 電商橘色品牌
      primary: '#ea580c',
      primaryLight: '#f97316',
      primaryDark: '#c2410c',
      secondary: '#0891b2',
    },
  },

  features: {
    messaging: {
      videoCall: false,
      voiceCall: false, // 電商版不需要語音
      voiceMessage: false,
      groupCall: false,
      fileSharing: true, // 重點：商品圖片分享
      groupFileSharing: true,
    },
    aegisProtection: {
      l1SemanticAI: false,
      l2RuleEngine: true, // 詐騙連結偵測
      l3BehaviorAI: true, // 可疑賣家偵測
      voiceRiskAnalysis: false,
    },
    addons: {
      aegisPay: true, // 支付風控
      devTools: false,
    },
    license: {
      type: 'pro',
    },
  },
};

// ============================================
// 使用方式
// ============================================

/**
 * 在 main.tsx 中使用白標配置：
 *
 * ```tsx
 * import { bankSecureConfig } from './config/whitelabel.example';
 *
 * // 初始化配置服務
 * configService.initialize(bankSecureConfig);
 *
 * // 在 React 中使用
 * <ConfigProvider overrides={bankSecureConfig}>
 *   <App />
 * </ConfigProvider>
 * ```
 *
 * 或者使用環境變數動態選擇：
 *
 * ```tsx
 * const configMap = {
 *   banksecure: bankSecureConfig,
 *   insurechat: insureChatConfig,
 *   shopsafe: shopSafeConfig,
 * };
 *
 * const clientId = import.meta.env.VITE_CLIENT_ID || 'default';
 * const overrides = configMap[clientId];
 *
 * configService.initialize(overrides);
 * ```
 */

export default {
  bankSecure: bankSecureConfig,
  insureChat: insureChatConfig,
  shopSafe: shopSafeConfig,
};

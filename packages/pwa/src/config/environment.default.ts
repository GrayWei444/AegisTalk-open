/**
 * AegisTalk 預設環境配置
 *
 * Phase 13: 白標抽象架構
 *
 * 這是 AegisTalk 的預設環境設定。
 * 支援開發、測試、生產等多種環境。
 *
 * 開源第 5c 步：連哪台 chat 伺服器（API、broker、STUN）不在這裡 —— 是執行期選的（services/serverChoice.ts、apiBase.ts；
 * 社群版第一次開啟時問、官方版預設官方站）。這裡的 api.* 只剩建置時環境變數（VITE_API_URL 等）的白標欄位，App 不拿來連線，
 * 預設值一律空白，不寫任何主機。
 */

import type { EnvironmentConfig, EnvironmentName } from './types';

/**
 * 從環境變數取得值，帶有預設值
 */
function getEnvVar(key: string, defaultValue: string): string {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    return (import.meta.env[key] as string) || defaultValue;
  }
  return defaultValue;
}

/**
 * 偵測當前環境名稱
 */
function detectEnvironment(): EnvironmentName {
  // 從環境變數讀取
  const envName = getEnvVar('VITE_ENV_NAME', '');
  if (envName) {
    return envName as EnvironmentName;
  }

  // 從 Vite 模式偵測
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    if (import.meta.env.DEV) return 'development';
    if (import.meta.env.MODE === 'staging') return 'staging';
    if (import.meta.env.MODE === 'uat') return 'uat';
  }

  return 'production';
}

/**
 * 開發環境配置
 */
export const developmentConfig: EnvironmentConfig = {
  name: 'development',
  api: {
    baseUrl: getEnvVar('VITE_API_URL', ''),
    mqttUrl: getEnvVar('VITE_MQTT_URL', 'ws://localhost:8083/mqtt'),
    turnServer: getEnvVar('VITE_TURN_URL', ''),
    stunServer: 'stun:stun.l.google.com:19302',
    turnUsername: getEnvVar('VITE_TURN_USERNAME', ''),
    turnCredential: getEnvVar('VITE_TURN_CREDENTIAL', ''),
  },
  auth: {
    clientId: undefined,
    redirectUri: 'http://localhost:5173/callback',
  },
  storage: {
    indexedDBName: 'aegistalk-dev',
  },
  debug: {
    enabled: true,
    logLevel: 'debug',
    mockData: false,
    showPerformanceMetrics: true,
  },
  ui: {
    safeArea: {
      top: true,
      bottom: true,
    },
    statusBar: {
      style: 'light',
      backgroundColor: '#0d1b2a',
      overlay: false,
    },
    navigation: {
      showBackButton: true,
      gestureNavigation: true,
    },
  },
};

/**
 * Staging 環境配置
 */
export const stagingConfig: EnvironmentConfig = {
  name: 'staging',
  api: {
    baseUrl: getEnvVar('VITE_API_URL', ''),
    mqttUrl: getEnvVar('VITE_MQTT_URL', ''),
    turnServer: getEnvVar('VITE_TURN_URL', ''),
    stunServer: 'stun:stun.l.google.com:19302',
    turnUsername: getEnvVar('VITE_TURN_USERNAME', ''),
    turnCredential: getEnvVar('VITE_TURN_CREDENTIAL', ''),
  },
  auth: {
    clientId: undefined,
    redirectUri: '',
  },
  storage: {
    indexedDBName: 'aegistalk-staging',
  },
  debug: {
    enabled: true,
    logLevel: 'info',
    mockData: false,
    showPerformanceMetrics: true,
  },
  ui: {
    safeArea: {
      top: true,
      bottom: true,
    },
    statusBar: {
      style: 'light',
      backgroundColor: '#0d1b2a',
      overlay: false,
    },
    navigation: {
      showBackButton: true,
      gestureNavigation: true,
    },
  },
};

/**
 * UAT 環境配置
 */
export const uatConfig: EnvironmentConfig = {
  name: 'uat',
  api: {
    baseUrl: getEnvVar('VITE_API_URL', ''),
    mqttUrl: getEnvVar('VITE_MQTT_URL', ''),
    turnServer: getEnvVar('VITE_TURN_URL', ''),
    stunServer: 'stun:stun.l.google.com:19302',
    turnUsername: getEnvVar('VITE_TURN_USERNAME', ''),
    turnCredential: getEnvVar('VITE_TURN_CREDENTIAL', ''),
  },
  auth: {
    clientId: undefined,
    redirectUri: '',
  },
  storage: {
    indexedDBName: 'aegistalk-uat',
  },
  debug: {
    enabled: false,
    logLevel: 'warn',
    mockData: false,
    showPerformanceMetrics: false,
  },
  ui: {
    safeArea: {
      top: true,
      bottom: true,
    },
    statusBar: {
      style: 'light',
      backgroundColor: '#0d1b2a',
      overlay: false,
    },
    navigation: {
      showBackButton: true,
      gestureNavigation: true,
    },
  },
};

/**
 * 生產環境配置
 */
export const productionConfig: EnvironmentConfig = {
  name: 'production',
  api: {
    baseUrl: getEnvVar('VITE_API_URL', ''),
    mqttUrl: getEnvVar('VITE_MQTT_URL', ''),
    turnServer: getEnvVar('VITE_TURN_URL', ''),
    stunServer: 'stun:stun.l.google.com:19302',
    turnUsername: getEnvVar('VITE_TURN_USERNAME', ''),
    turnCredential: getEnvVar('VITE_TURN_CREDENTIAL', ''),
  },
  auth: {
    clientId: undefined,
    redirectUri: '',
  },
  storage: {
    indexedDBName: 'aegistalk',
  },
  debug: {
    enabled: false,
    logLevel: 'error',
    mockData: false,
    showPerformanceMetrics: false,
  },
  ui: {
    safeArea: {
      top: true,
      bottom: true,
    },
    statusBar: {
      style: 'light',
      backgroundColor: '#0d1b2a',
      overlay: false,
    },
    navigation: {
      showBackButton: true,
      gestureNavigation: true,
    },
  },
};

/**
 * 根據環境名稱取得環境配置
 */
export function getEnvironmentConfig(
  envName?: EnvironmentName
): EnvironmentConfig {
  const name = envName || detectEnvironment();

  switch (name) {
    case 'development':
      return developmentConfig;
    case 'staging':
      return stagingConfig;
    case 'uat':
      return uatConfig;
    case 'production':
    default:
      return productionConfig;
  }
}

/**
 * 預設環境配置 (自動偵測)
 */
export const defaultEnvironmentConfig: EnvironmentConfig =
  getEnvironmentConfig();

export default defaultEnvironmentConfig;

import { devLog, devWarn } from '../utils/devLog';

/**
 * ConfigService - 配置服務
 *
 * Phase 13: 白標抽象架構
 *
 * 提供非 React 環境（如 services）存取配置的方式。
 * 這是一個單例服務，在應用啟動時初始化。
 */

import type {
  AppConfig,
  BrandConfig,
  FeaturesConfig,
  EnvironmentConfig,
  ConfigOverrides,
  FeaturePath,
} from './types';
import { defaultBrandConfig } from './brand.default';
import { defaultFeaturesConfig } from './features.default';
import { defaultEnvironmentConfig } from './environment.default';

// ============================================
// 配置合併工具
// ============================================

/**
 * 深度合併兩個物件
 */
 
function deepMerge<T>(target: T, source: any): T {
  if (!source) return target;

  const result = { ...target } as T;
  const sourceObj = source as Record<string, unknown>;
  const targetObj = target as Record<string, unknown>;
  const resultObj = result as Record<string, unknown>;

  for (const key in sourceObj) {
    if (Object.prototype.hasOwnProperty.call(sourceObj, key)) {
      const sourceValue = sourceObj[key];
      const targetValue = targetObj[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        resultObj[key] = deepMerge(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        resultObj[key] = sourceValue;
      }
    }
  }

  return result;
}

// ============================================
// ConfigService 類別
// ============================================

class ConfigService {
  private _config: AppConfig | null = null;
  private _initialized = false;

  /**
   * 初始化配置服務
   */
  initialize(overrides?: ConfigOverrides): void {
    if (this._initialized) {
      devWarn('[ConfigService] Already initialized, ignoring re-init');
      return;
    }

    const baseConfig: AppConfig = {
      brand: defaultBrandConfig,
      features: defaultFeaturesConfig,
      environment: defaultEnvironmentConfig,
    };

    if (!overrides) {
      this._config = baseConfig;
    } else {
      this._config = {
        brand: overrides.brand
          ? deepMerge<BrandConfig>(baseConfig.brand, overrides.brand)
          : baseConfig.brand,
        features: overrides.features
          ? deepMerge<FeaturesConfig>(baseConfig.features, overrides.features)
          : baseConfig.features,
        environment: overrides.environment
          ? deepMerge<EnvironmentConfig>(baseConfig.environment, overrides.environment)
          : baseConfig.environment,
      };
    }

    this._initialized = true;
    devLog('[ConfigService] Initialized with config:', this._config.brand.appName);
  }

  /**
   * 確保已初始化
   */
  private ensureInitialized(): void {
    if (!this._initialized || !this._config) {
      // 自動初始化為預設值
      this.initialize();
    }
  }

  /**
   * 取得完整配置
   */
  get config(): AppConfig {
    this.ensureInitialized();
    return this._config!;
  }

  /**
   * 取得品牌配置
   */
  get brand(): BrandConfig {
    return this.config.brand;
  }

  /**
   * 取得功能配置
   */
  get features(): FeaturesConfig {
    return this.config.features;
  }

  /**
   * 取得環境配置
   */
  get environment(): EnvironmentConfig {
    return this.config.environment;
  }

  /**
   * 檢查功能是否啟用
   */
  isFeatureEnabled(featurePath: FeaturePath): boolean {
    const parts = featurePath.split('.') as [string, string];
    const [category, feature] = parts;

     
    const categoryConfig = this.features[category as keyof typeof this.features] as unknown as Record<string, boolean> | undefined;
    if (!categoryConfig) return false;

    return categoryConfig[feature] === true;
  }

  /**
   * 取得 API URL
   */
  getApiUrl(path?: string): string {
    const baseUrl = this.environment.api.baseUrl;
    if (!path) return baseUrl;
    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * 取得 MQTT URL
   */
  getMqttUrl(): string {
    return this.environment.api.mqttUrl;
  }

  /**
   * 取得 TURN 伺服器設定
   */
  getTurnConfig(): {
    urls: string;
    username?: string;
    credential?: string;
  } {
    return {
      urls: this.environment.api.turnServer,
      username: this.environment.api.turnUsername,
      credential: this.environment.api.turnCredential,
    };
  }

  /**
   * 取得 STUN 伺服器 URL
   */
  getStunUrl(): string {
    return this.environment.api.stunServer;
  }

  /**
   * 是否為開發模式
   */
  get isDevelopment(): boolean {
    return this.environment.name === 'development';
  }

  /**
   * 是否為生產模式
   */
  get isProduction(): boolean {
    return this.environment.name === 'production';
  }

  /**
   * 是否啟用除錯模式
   */
  get isDebugEnabled(): boolean {
    return this.environment.debug.enabled;
  }

  /**
   * 取得日誌等級
   */
  get logLevel(): string {
    return this.environment.debug.logLevel;
  }

  /**
   * 取得 IndexedDB 名稱
   */
  get indexedDBName(): string {
    return this.environment.storage.indexedDBName;
  }
}

// ============================================
// 單例匯出
// ============================================

/**
 * 配置服務單例
 *
 * @example
 * ```typescript
 * import { configService } from '@/config/configService';
 *
 * // 取得 API URL
 * const apiUrl = configService.getApiUrl('/api/chat/server-config');
 *
 * // 檢查功能
 * if (configService.isFeatureEnabled('messaging.videoCall')) {
 *   // ...
 * }
 * ```
 */
export const configService = new ConfigService();

export default configService;

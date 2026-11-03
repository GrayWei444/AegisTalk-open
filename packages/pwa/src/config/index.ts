/**
 * AegisTalk 配置模組
 *
 * Phase 13: 白標抽象架構
 *
 * 匯出所有配置相關的類型、預設值、Provider 和 Hooks。
 */

// 類型定義
export type {
  // 品牌配置類型
  BrandConfig,
  LogoConfig,
  ColorConfig,
  FontConfig,
  LegalConfig,

  // 功能配置類型
  FeaturesConfig,
  MessagingFeatures,
  AegisProtectionFeatures,
  AddonFeatures,
  LicenseConfig,
  LicenseType,

  // 環境配置類型
  EnvironmentConfig,
  EnvironmentName,
  ApiEndpoints,
  AuthConfig,
  StorageConfig,
  DebugConfig,

  // 完整配置類型
  AppConfig,
  ConfigOverrides,
  DeepPartial,
  FeatureKey,
  FeaturePath,
} from './types';

// 預設配置
export { defaultBrandConfig } from './brand.default';
export {
  defaultFeaturesConfig,
  freeFeaturesConfig,
  proFeaturesConfig,
  getFeaturesConfigByLicense,
} from './features.default';
export {
  defaultEnvironmentConfig,
  developmentConfig,
  stagingConfig,
  uatConfig,
  productionConfig,
  getEnvironmentConfig,
} from './environment.default';

// Provider 和 Hooks
export {
  ConfigProvider,
  useConfig,
  useBrand,
  useFeatures,
  useEnvironment,
  useFeature,
  useApiUrl,
} from './ConfigProvider';

// FeatureGate 元件
export {
  FeatureGate,
  MultiFeatureGate,
  LicenseGate,
} from './FeatureGate';

// 配置服務 (非 React 環境使用)
export { configService } from './configService';

// 白標範例配置
export {
  bankSecureConfig,
  insureChatConfig,
  shopSafeConfig,
} from './whitelabel.example';

// 預設匯出 ConfigProvider
export { default } from './ConfigProvider';

/**
 * ConfigProvider - 配置提供者
 *
 * Phase 13: 白標抽象架構
 *
 * 提供全域配置 Context，讓所有元件都能存取品牌、功能、環境配置。
 */

import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
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
        // 遞迴合併物件
        resultObj[key] = deepMerge(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        // 直接覆寫
        resultObj[key] = sourceValue;
      }
    }
  }

  return result;
}

/**
 * 建立完整配置
 */
function createAppConfig(overrides?: ConfigOverrides): AppConfig {
  const baseConfig: AppConfig = {
    brand: defaultBrandConfig,
    features: defaultFeaturesConfig,
    environment: defaultEnvironmentConfig,
  };

  if (!overrides) {
    return baseConfig;
  }

  return {
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

// ============================================
// Context 類型定義
// ============================================

interface ConfigContextValue {
  /** 完整配置 */
  config: AppConfig;
  /** 品牌配置 */
  brand: BrandConfig;
  /** 功能配置 */
  features: FeaturesConfig;
  /** 環境配置 */
  environment: EnvironmentConfig;
  /** 檢查功能是否啟用 */
  isFeatureEnabled: (featurePath: FeaturePath) => boolean;
  /** 取得 API URL */
  getApiUrl: (path?: string) => string;
  /** 取得 MQTT URL */
  getMqttUrl: () => string;
  /** 是否為開發模式 */
  isDevelopment: boolean;
  /** 是否為生產模式 */
  isProduction: boolean;
}

// ============================================
// Context 建立
// ============================================

const ConfigContext = createContext<ConfigContextValue | null>(null);

// ============================================
// Provider 元件
// ============================================

interface ConfigProviderProps {
  children: ReactNode;
  /** 配置覆寫 */
  overrides?: ConfigOverrides;
}

/**
 * ConfigProvider - 配置提供者元件
 *
 * @example
 * ```tsx
 * // 使用預設配置
 * <ConfigProvider>
 *   <App />
 * </ConfigProvider>
 *
 * // 使用自訂配置
 * <ConfigProvider overrides={{
 *   brand: { appName: 'MyApp' },
 *   features: { addons: { devTools: false } }
 * }}>
 *   <App />
 * </ConfigProvider>
 * ```
 */
export function ConfigProvider({ children, overrides }: ConfigProviderProps) {
  // 建立配置
  const config = useMemo(() => createAppConfig(overrides), [overrides]);

  // 檢查功能是否啟用
  const isFeatureEnabled = useCallback(
    (featurePath: FeaturePath): boolean => {
      const parts = featurePath.split('.') as [string, string];
      const [category, feature] = parts;

       
      const categoryConfig = config.features[category as keyof typeof config.features] as unknown as Record<string, boolean> | undefined;
      if (!categoryConfig) return false;

      return categoryConfig[feature] === true;
    },
    [config.features]
  );

  // 取得 API URL
  const getApiUrl = useCallback(
    (path?: string): string => {
      const baseUrl = config.environment.api.baseUrl;
      if (!path) return baseUrl;
      return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    },
    [config.environment.api.baseUrl]
  );

  // 取得 MQTT URL
  const getMqttUrl = useCallback((): string => {
    return config.environment.api.mqttUrl;
  }, [config.environment.api.mqttUrl]);

  // 環境判斷
  const isDevelopment = config.environment.name === 'development';
  const isProduction = config.environment.name === 'production';

  // Context 值
  const value = useMemo<ConfigContextValue>(
    () => ({
      config,
      brand: config.brand,
      features: config.features,
      environment: config.environment,
      isFeatureEnabled,
      getApiUrl,
      getMqttUrl,
      isDevelopment,
      isProduction,
    }),
    [
      config,
      isFeatureEnabled,
      getApiUrl,
      getMqttUrl,
      isDevelopment,
      isProduction,
    ]
  );

  // 將品牌色彩注入 CSS 變數（白標動態覆蓋）
  // 使用 <style> 元素而非 inline style，確保 .dark class 的 CSS 優先級正確
  useEffect(() => {
    const { colors } = config.brand;
    if (!colors) return;

    // 計算品牌色衍生值
    let accentSoft = '';
    if (colors.primary) {
      const hex = colors.primary.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      accentSoft = `rgba(${r}, ${g}, ${b}, 0.08)`;
    }

    // 構建 CSS 文字
    const cssRules: string[] = [];

    // :root 規則（品牌色 + 淺色主題表面色）
    const rootVars: string[] = [];
    if (colors.primary) rootVars.push(`--accent: ${colors.primary}`);
    if (colors.primaryLight) rootVars.push(`--accent-light: ${colors.primaryLight}`);
    if (colors.primaryDark) rootVars.push(`--accent-dark: ${colors.primaryDark}`);
    if (accentSoft) rootVars.push(`--accent-soft: ${accentSoft}`);
    if (colors.primary) rootVars.push(`--bubble-sent: ${colors.primary}`);
    if (colors.lightBg) rootVars.push(`--surface-primary: ${colors.lightBg}`);
    if (colors.lightCard) rootVars.push(`--surface-secondary: ${colors.lightCard}`);
    if (colors.lightBorder) rootVars.push(`--surface-border: ${colors.lightBorder}`);

    if (rootVars.length > 0) {
      cssRules.push(`:root { ${rootVars.join('; ')}; }`);
    }

    // .dark 規則（深色主題表面色）
    const darkVars: string[] = [];
    if (colors.darkBg) darkVars.push(`--surface-primary: ${colors.darkBg}`);
    if (colors.darkCard) darkVars.push(`--surface-secondary: ${colors.darkCard}`);
    if (colors.darkBorder) darkVars.push(`--surface-border: ${colors.darkBorder}`);
    if (colors.primaryLight) {
      // 深色主題使用較亮的品牌色
      darkVars.push(`--accent: ${colors.primaryLight}`);
      const hex = colors.primaryLight.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      darkVars.push(`--accent-soft: rgba(${r}, ${g}, ${b}, 0.08)`);
    }

    if (darkVars.length > 0) {
      cssRules.push(`.dark { ${darkVars.join('; ')}; }`);
    }

    // 注入或更新 <style> 元素
    const styleId = 'aegis-brand-theme';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssRules.join('\n');
  }, [config.brand]);

  return (
    <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
  );
}

// ============================================
// Hooks
// ============================================

/**
 * useConfig - 取得完整配置
 *
 * @example
 * ```tsx
 * const { config, brand, features, environment } = useConfig();
 * ```
 */
export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

/**
 * useBrand - 取得品牌配置
 *
 * @example
 * ```tsx
 * const brand = useBrand();
 * console.log(brand.appName); // "AegisTalk"
 * ```
 */
export function useBrand(): BrandConfig {
  const { brand } = useConfig();
  return brand;
}

/**
 * useFeatures - 取得功能配置
 *
 * @example
 * ```tsx
 * const features = useFeatures();
 * if (features.messaging.videoCall) {
 *   // 顯示視訊通話按鈕
 * }
 * ```
 */
export function useFeatures(): FeaturesConfig {
  const { features } = useConfig();
  return features;
}

/**
 * useEnvironment - 取得環境配置
 *
 * @example
 * ```tsx
 * const env = useEnvironment();
 * const apiUrl = env.api.baseUrl;
 * ```
 */
export function useEnvironment(): EnvironmentConfig {
  const { environment } = useConfig();
  return environment;
}

/**
 * useFeature - 檢查特定功能是否啟用
 *
 * @example
 * ```tsx
 * const isVideoCallEnabled = useFeature('messaging.videoCall');
 * const isL3Enabled = useFeature('aegisProtection.l3BehaviorAI');
 * ```
 */
export function useFeature(featurePath: FeaturePath): boolean {
  const { isFeatureEnabled } = useConfig();
  return isFeatureEnabled(featurePath);
}

/**
 * useApiUrl - 取得 API URL
 *
 * @example
 * ```tsx
 * const getApiUrl = useApiUrl();
 * const url = getApiUrl('/api/chat/server-config');
 * ```
 */
export function useApiUrl(): (path?: string) => string {
  const { getApiUrl } = useConfig();
  return getApiUrl;
}

export default ConfigProvider;

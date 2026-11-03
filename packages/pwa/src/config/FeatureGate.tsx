/**
 * FeatureGate - 功能開關元件
 *
 * Phase 13: 白標抽象架構
 *
 * 根據功能配置決定是否渲染子元件。
 * 用於條件性顯示特定功能的 UI。
 */

import type { ReactNode } from 'react';
import { useFeature } from './ConfigProvider';
import type { FeaturePath } from './types';

// ============================================
// FeatureGate 元件
// ============================================

interface FeatureGateProps {
  /** 功能路徑 - 例如: 'messaging.videoCall' */
  feature: FeaturePath;
  /** 功能啟用時顯示的內容 */
  children: ReactNode;
  /** 功能停用時顯示的內容 (可選) */
  fallback?: ReactNode;
  /** 是否反轉邏輯 (功能停用時顯示 children) */
  inverse?: boolean;
}

/**
 * FeatureGate - 功能開關元件
 *
 * 根據功能配置決定是否渲染子元件。
 *
 * @example
 * ```tsx
 * // 只有視訊通話啟用時才顯示按鈕
 * <FeatureGate feature="messaging.videoCall">
 *   <VideoCallButton />
 * </FeatureGate>
 *
 * // 功能停用時顯示替代內容
 * <FeatureGate
 *   feature="aegisProtection.l3BehaviorAI"
 *   fallback={<p>此功能需要 Pro 版本</p>}
 * >
 *   <BehaviorAnalysisPanel />
 * </FeatureGate>
 *
 * // 反轉邏輯 - 只有功能停用時才顯示
 * <FeatureGate feature="addons.devTools" inverse>
 *   <p>開發者工具已停用</p>
 * </FeatureGate>
 * ```
 */
export function FeatureGate({
  feature,
  children,
  fallback = null,
  inverse = false,
}: FeatureGateProps) {
  const isEnabled = useFeature(feature);
  const shouldRender = inverse ? !isEnabled : isEnabled;

  return <>{shouldRender ? children : fallback}</>;
}

// ============================================
// 多功能條件元件
// ============================================

interface MultiFeatureGateProps {
  /** 功能路徑列表 */
  features: FeaturePath[];
  /** 條件類型: 'all' 所有功能都要啟用, 'any' 任一功能啟用即可 */
  mode?: 'all' | 'any';
  /** 功能條件滿足時顯示的內容 */
  children: ReactNode;
  /** 條件不滿足時顯示的內容 (可選) */
  fallback?: ReactNode;
}

/**
 * MultiFeatureGate - 多功能條件元件
 *
 * 支援多個功能的 AND/OR 條件判斷。
 *
 * @example
 * ```tsx
 * // 所有功能都要啟用
 * <MultiFeatureGate
 *   features={['messaging.videoCall', 'messaging.voiceCall']}
 *   mode="all"
 * >
 *   <CallOptions />
 * </MultiFeatureGate>
 *
 * // 任一功能啟用即可
 * <MultiFeatureGate
 *   features={['aegisProtection.l1SemanticAI', 'aegisProtection.l3BehaviorAI']}
 *   mode="any"
 *   fallback={<p>需要進階 AI 功能</p>}
 * >
 *   <AdvancedProtection />
 * </MultiFeatureGate>
 * ```
 */
export function MultiFeatureGate({
  features,
  mode = 'all',
  children,
  fallback = null,
}: MultiFeatureGateProps) {
  // 注意: 這裡不能在條件中使用 hook，所以需要特殊處理
  // 我們需要一個不違反 hooks 規則的方式來檢查多個功能

  return (
    <MultiFeatureGateInner
      features={features}
      mode={mode}
      fallback={fallback}
    >
      {children}
    </MultiFeatureGateInner>
  );
}

/**
 * 內部元件 - 使用單一 hook 呼叫
 */
function MultiFeatureGateInner({
  features,
  mode,
  children,
  fallback,
}: MultiFeatureGateProps) {
  // 使用 map 收集所有功能狀態，但只能在元件頂層
  // 這裡我們透過 useConfig 取得完整配置來判斷
  const { isFeatureEnabled } = useConfigForMultiGate();

  const results = features.map((f) => isFeatureEnabled(f));

  const shouldRender =
    mode === 'all' ? results.every(Boolean) : results.some(Boolean);

  return <>{shouldRender ? children : fallback}</>;
}

// 為了避免循環引用，直接在這裡引用 context
import { useConfig as useConfigForMultiGate } from './ConfigProvider';

// ============================================
// License Gate 元件
// ============================================

interface LicenseGateProps {
  /** 最低要求的授權類型 */
  minLicense: 'free' | 'pro' | 'enterprise';
  /** 授權符合時顯示的內容 */
  children: ReactNode;
  /** 授權不符時顯示的內容 (可選) */
  fallback?: ReactNode;
}

/**
 * LicenseGate - 授權等級元件
 *
 * 根據授權等級決定是否渲染子元件。
 *
 * @example
 * ```tsx
 * <LicenseGate minLicense="pro" fallback={<UpgradePrompt />}>
 *   <ProFeature />
 * </LicenseGate>
 * ```
 */
export function LicenseGate({
  minLicense,
  children,
  fallback = null,
}: LicenseGateProps) {
  const { features } = useConfigForMultiGate();
  const currentLicense = features.license.type;

  const licenseLevel = {
    free: 0,
    pro: 1,
    enterprise: 2,
  };

  const hasAccess = licenseLevel[currentLicense] >= licenseLevel[minLicense];

  return <>{hasAccess ? children : fallback}</>;
}

// ============================================
// 匯出
// ============================================

export default FeatureGate;

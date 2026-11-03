/**
 * UnsupportedVersionModal - 版本不支援提示元件
 *
 * 當裝置版本過舊無法使用 AegisTalk 時顯示升級提示。
 */

import { useEffect, useState } from 'react';
import { XIcon } from './icons';
import {
  checkCompatibility,
  CompatibilityResult,
  RECOMMENDED_VERSIONS,
} from '../../services/deviceCompatibility';

interface UnsupportedVersionModalProps {
  /** 強制顯示（用於測試）*/
  forceShow?: boolean;
  /** 關閉回調（僅在有降級選項時可用）*/
  onDismiss?: () => void;
  /** 是否允許降級使用 */
  allowDegradedMode?: boolean;
}

/**
 * 版本不支援提示 Modal
 *
 * 功能：
 * - 自動檢測裝置版本
 * - 顯示升級指引（iOS/Android 各自的升級路徑）
 * - 列出缺失的功能
 * - 可選的降級模式（部分功能可用）
 */
export function UnsupportedVersionModal({
  forceShow = false,
  onDismiss,
  allowDegradedMode = false,
}: UnsupportedVersionModalProps) {
  const [compatibility, setCompatibility] = useState<CompatibilityResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const result = await checkCompatibility();
        setCompatibility(result);
      } catch (err) {
        console.error('[UnsupportedVersionModal] Failed to check compatibility:', err);
      } finally {
        setIsLoading(false);
      }
    };
    check();
  }, []);

  // 決定是否顯示
  const shouldShow = forceShow || (!isLoading && compatibility && !compatibility.isSupported && !dismissed);

  if (!shouldShow || !compatibility) {
    return null;
  }

  const { platform, currentVersion, minimumVersion, missingFeatures } = compatibility;

  // 處理降級模式
  const handleDegradedMode = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4">
      <div className="bg-surface-secondary rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
        {/* 標題區域 */}
        <div className="bg-red-500 text-white px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold">系統版本過舊</h2>
              <p className="text-white/80 text-sm">需要升級才能使用 AegisTalk</p>
            </div>
          </div>
        </div>

        {/* 內容區域 */}
        <div className="px-6 py-5 space-y-4">
          {/* 版本資訊 */}
          <div className="bg-surface-tertiary rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-on-surface-secondary">您的版本</span>
              <span className="font-mono text-on-surface-primary">
                {platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'} {currentVersion}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-on-surface-secondary">最低需求</span>
              <span className="font-mono text-green-600 dark:text-green-400">
                {platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : ''} {minimumVersion}+
              </span>
            </div>
          </div>

          {/* 缺失功能列表 */}
          {missingFeatures.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-on-surface-secondary mb-2">
                不支援的功能：
              </h3>
              <ul className="space-y-1">
                {missingFeatures.map((feature, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-2 text-sm text-on-surface-secondary"
                  >
                    <XIcon size={14} className="shrink-0 text-red-500" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 升級指引 */}
          <div className="border-t border-[var(--surface-border)] pt-4">
            <h3 className="text-sm font-medium text-on-surface-secondary mb-2">
              如何升級：
            </h3>
            {platform === 'ios' && (
              <div className="text-sm text-on-surface-secondary space-y-1">
                <p>1. 開啟「設定」App</p>
                <p>2. 點選「一般」</p>
                <p>3. 點選「軟體更新」</p>
                <p>4. 下載並安裝最新版本</p>
              </div>
            )}
            {platform === 'android' && (
              <div className="text-sm text-on-surface-secondary space-y-1">
                <p>1. 開啟「設定」</p>
                <p>2. 點選「系統」或「關於手機」</p>
                <p>3. 點選「軟體更新」或「系統更新」</p>
                <p>4. 下載並安裝最新版本</p>
              </div>
            )}
            {platform === 'web' && (
              <div className="text-sm text-on-surface-secondary">
                <p>請使用最新版本的 Chrome、Safari 或 Firefox 瀏覽器。</p>
              </div>
            )}
          </div>

          {/* 建議版本提示 */}
          {platform !== 'web' && (
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                <strong>建議升級至：</strong>{' '}
                {platform === 'ios'
                  ? `iOS ${RECOMMENDED_VERSIONS.ios}`
                  : `Android ${RECOMMENDED_VERSIONS.android}`}{' '}
                或更新版本以獲得最佳體驗。
              </p>
            </div>
          )}
        </div>

        {/* 按鈕區域 */}
        <div className="px-6 pb-6 space-y-3">
          {/* 降級模式按鈕（僅在允許時顯示）*/}
          {allowDegradedMode && (
            <button
              onClick={handleDegradedMode}
              className="w-full py-3 px-4 bg-surface-elevated text-on-surface-secondary rounded-lg font-medium hover:bg-surface-elevated transition-colors"
            >
              以有限功能繼續使用
            </button>
          )}

          {/* 主要說明 */}
          {!allowDegradedMode && (
            <p className="text-center text-sm text-on-surface-secondary">
              請升級您的裝置後再使用 AegisTalk
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default UnsupportedVersionModal;

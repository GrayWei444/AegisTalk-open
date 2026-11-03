/**
 * PageHeader - 共用頁面標題元件
 *
 * 自動處理 Safe Area，支援白標配置。
 * 根據環境配置決定是否啟用 Safe Area。
 */

import { ReactNode } from 'react';
import { useConfig } from '../../config/ConfigProvider';

interface PageHeaderProps {
  /** 標題文字 */
  title: string;
  /** 返回按鈕回調 */
  onBack?: () => void;
  /** 右側操作區域 */
  rightActions?: ReactNode;
  /** 額外的 CSS 類別 */
  className?: string;
  /** 自訂返回按鈕圖示 */
  backIcon?: ReactNode;
}

/**
 * 共用頁面標題元件
 *
 * 自動根據配置處理：
 * - Safe Area (避免與狀態列重疊)
 * - 返回按鈕顯示
 * - 深色/淺色主題
 */
export function PageHeader({
  title,
  onBack,
  rightActions,
  className = '',
  backIcon,
}: PageHeaderProps) {
  const { environment } = useConfig();
  const uiConfig = environment.ui;

  // 根據配置決定是否加入 safe-area-top
  const safeAreaClass = uiConfig?.safeArea?.top ? 'safe-area-top' : '';

  // 根據配置決定是否顯示返回按鈕
  const showBackButton = onBack && (uiConfig?.navigation?.showBackButton ?? true);

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-surface-secondary border-b border-[var(--surface-border)] ${safeAreaClass} ${className}`}
    >
      {showBackButton && (
        <button
          onClick={onBack}
          className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
          aria-label="返回"
        >
          {backIcon || (
            <span className="text-on-surface-secondary">←</span>
          )}
        </button>
      )}
      <h1 className="text-lg font-semibold text-on-surface-primary flex-1">
        {title}
      </h1>
      {rightActions && (
        <div className="flex items-center gap-2">{rightActions}</div>
      )}
    </div>
  );
}

export default PageHeader;

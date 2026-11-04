/**
 * UserAvatar - 統一用戶頭像元件
 *
 * 所有用戶頭像的單一來源。
 * 顯示上傳圖片或預設 SVG 人形剪影。
 */

import type { RiskLevel } from '../../types';
import { useLanguage } from '../../i18n';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

interface UserAvatarProps {
  /** 頭像值 (base64 / URL / 空字串或 emoji 顯示預設) */
  avatar?: string;
  /** 替代文字 */
  name?: string;
  /** 尺寸 */
  size?: AvatarSize;
  /** 額外 CSS 類別 (例如 ring / border) */
  className?: string;
  /** 風險等級（影響外框顏色：safe綠 / low黃 / medium橙 / high·critical紅） */
  riskLevel?: RiskLevel;
}

const SIZE_MAP: Record<AvatarSize, { container: string; icon: string }> = {
  xs:  { container: 'w-6 h-6',   icon: 'w-3.5 h-3.5' },
  sm:  { container: 'w-8 h-8',   icon: 'w-4 h-4' },
  md:  { container: 'w-10 h-10', icon: 'w-5 h-5' },
  lg:  { container: 'w-12 h-12', icon: 'w-6 h-6' },
  xl:  { container: 'w-16 h-16', icon: 'w-8 h-8' },
  '2xl': { container: 'w-24 h-24', icon: 'w-12 h-12' },
};

function isImageAvatar(avatar?: string): boolean {
  if (!avatar) return false;
  return avatar.startsWith('data:image') || avatar.startsWith('http');
}

// 風險等級 → 外框顏色（分界與伺服器的風險分數分級一致：<20 safe / 20-49 low / 50-79 medium / >=80 high）
const RISK_RING: Record<RiskLevel, string> = {
  safe: 'ring-2 ring-green-400',
  low: 'ring-2 ring-yellow-400',
  medium: 'ring-2 ring-orange-400',
  high: 'ring-2 ring-red-500',
  critical: 'ring-2 ring-red-500',
};


export function UserAvatar({ avatar, name, size = 'md', className = '', riskLevel }: UserAvatarProps) {
  const { t } = useLanguage();
  const { container } = SIZE_MAP[size];
  const ring = riskLevel ? RISK_RING[riskLevel] : '';

  if (isImageAvatar(avatar)) {
    return (
      <img
        src={avatar}
        alt={name || t('settings.avatar')}
        className={`${container} rounded-full object-cover ${ring} ${className}`}
      />
    );
  }

  // 無頭像 → 顯示通用人形剪影 + 驗證狀態外框
  return (
    <div className={`${container} rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center ${ring} ${className}`}>
      <svg className={`${SIZE_MAP[size].icon} text-teal-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    </div>
  );
}

/**
 * GroupAvatar - 統一群組頭像元件
 *
 * 所有群組頭像的單一來源。
 * 顯示上傳圖片、守護群組盾牌圖示、或預設群組 SVG。
 */

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

interface GroupAvatarProps {
  /** 頭像值 (base64 / URL / 空字串顯示預設) */
  avatar?: string;
  /** 群組名稱 */
  name?: string;
  /** 是否為守護群組 */
  isGuardian?: boolean;
  /** 尺寸 */
  size?: AvatarSize;
  /** 額外 CSS 類別 */
  className?: string;
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

export function GroupAvatar({ avatar, name, isGuardian = false, size = 'md', className = '' }: GroupAvatarProps) {
  const { container, icon } = SIZE_MAP[size];

  if (isImageAvatar(avatar)) {
    return (
      <img
        src={avatar}
        alt={name || 'Group'}
        className={`${container} rounded-full object-cover ${className}`}
      />
    );
  }

  // 守護群組 → 盾牌圖示
  if (isGuardian) {
    return (
      <div className={`${container} rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center ${className}`}>
        <svg className={`${icon} text-emerald-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      </div>
    );
  }

  // 一般群組 → 群組人形圖示
  return (
    <div className={`${container} rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center ${className}`}>
      <svg className={`${icon} text-blue-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    </div>
  );
}

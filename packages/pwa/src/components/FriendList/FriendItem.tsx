import type { Friend } from '../../types';
import { useContactRisk } from '../../hooks/useContactRisk';
import { useLanguage } from '../../i18n';
import { UserAvatar } from '../common';

interface FriendItemProps {
  friend: Friend;
  isSelected: boolean;
  onClick: () => void;
  /** 我加了他、他還沒確認（審查 M1）：名字旁標示，例如「等待確認」 */
  pendingLabel?: string;
}

export function FriendItem({ friend, isSelected, onClick, pendingLabel }: FriendItemProps) {
  // 頭像外框依累積風險分數著色（safe綠 / low黃 / medium橙 / high紅）
  const riskLevel = useContactRisk(friend.publicKey);
  const { t } = useLanguage();

  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return t('friendList.justNow');
    if (diff < 3600000) return t('friendList.minutesAgo', { minutes: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('friendList.hoursAgo', { hours: Math.floor(diff / 3600000) });
    return t('friendList.daysAgo', { days: Math.floor(diff / 86400000) });
  };

  return (
    <div
      onClick={onClick}
      className={`
        flex items-center gap-3 px-4 py-3.5 cursor-pointer
        transition-colors duration-150
        ${isSelected
          ? 'bg-accent-soft border-l-2 border-accent'
          : 'hover:bg-surface-tertiary border-l-2 border-transparent'
        }
      `}
    >
      {/* Avatar with risk ring */}
      <div className="relative">
        <UserAvatar avatar={friend.avatar} name={friend.name} size="lg" riskLevel={riskLevel} />
        {/* Online indicator */}
        {friend.online && (
          <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-surface-secondary" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-on-surface-primary text-sm truncate">{friend.name}</span>
            {pendingLabel && (
              <span className="px-1.5 py-0.5 text-[10px] leading-none rounded bg-yellow-500/15 text-yellow-400 whitespace-nowrap shrink-0">
                {pendingLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 ml-2">
            {friend.unreadCount > 0 && (
              <span className="px-1.5 py-0.5 text-xs bg-accent text-white rounded-full min-w-[20px] text-center">
                {friend.unreadCount}
              </span>
            )}
            <span className="text-xs text-on-surface-tertiary whitespace-nowrap">
              {formatTime(friend.lastMessageTime)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

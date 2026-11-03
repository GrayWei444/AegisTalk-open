/**
 * GroupList - 群組列表
 *
 * 顯示使用者加入的所有群組
 * 支援巢狀群組顯示
 */

import { useMemo } from 'react';
import { useGroups, useGroupChat } from '../../hooks/useGroupChat';
import type { Group } from '../../types';
import { ext } from '@ext';
import { GroupAvatar } from '../common';
import { useLanguage } from '../../i18n';

interface GroupListProps {
  onGroupSelect?: (groupId: string) => void;
  selectedGroupId?: string | null;
  /** 排除守護群組（顯示在獨立的「守護」標籤中） */
  excludeGuardian?: boolean;
  /** 建立群組回調（空狀態顯示用） */
  onCreateGroup?: () => void;
}

function GroupItem({
  group,
  isSelected,
  onSelect,
  parentGroupName,
  depth = 0,
}: {
  group: Group;
  isSelected: boolean;
  onSelect: () => void;
  parentGroupName?: string;
  depth?: number;
}) {
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const { t } = useLanguage();
  // ADR-016: 巢狀群組已移除（depth 參數保留但忽略）
  void depth;
  const isGuardian = ext.ui.isGuardianGroup(group);

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors ${
        isSelected
          ? isGuardian
            ? 'bg-emerald-600/20 text-emerald-400'
            : 'bg-blue-600/20 text-blue-400'
          : 'hover:bg-surface-tertiary text-on-surface-secondary'
      }`}
      style={{ paddingLeft: '12px' }}
    >
      {/* 保留原有結構供向後相容 */}
      {false && (
        <div className="flex-shrink-0 text-purple-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      )}

      {/* 群組頭像 */}
      <div className="relative flex-shrink-0">
        <GroupAvatar
          avatar={group.avatar}
          name={group.name}
          isGuardian={isGuardian}
          size="lg"
        />
        {/* ADR-016: 巢狀群組標記已移除 */}
      </div>

      {/* 群組資訊 */}
      <div className="flex-1 overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 truncate">
            <p className="truncate font-medium text-on-surface-primary">{group.name}</p>
            {isGuardian && (
              <span className="flex-shrink-0 rounded bg-emerald-600/20 px-1.5 py-0.5 text-[0.625rem] text-emerald-400">
                {t('nav.guardian')}
              </span>
            )}
            {false && (
              <span className="flex-shrink-0 rounded bg-purple-600/20 px-1.5 py-0.5 text-[0.625rem] text-purple-400">
                {t('groups.isSubgroup')}
              </span>
            )}
          </div>
          <div className="ml-2 flex flex-shrink-0 items-center gap-2">
            {group.unreadCount > 0 && (
              <span className="px-1.5 py-0.5 text-xs bg-accent text-white rounded-full min-w-[20px] text-center">
                {group.unreadCount > 99 ? '99+' : group.unreadCount}
              </span>
            )}
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {formatTime(group.lastMessageTime)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">
            {t('group.nMembers', { count: group.members.length })}
          </span>
          {parentGroupName && (
            <>
              <span className="text-gray-600">·</span>
              <span className="text-xs text-purple-400/70">
                {parentGroupName}
              </span>
            </>
          )}
          {group.lastMessage && (
            <>
              <span className="text-gray-600">·</span>
              <p className="truncate text-sm text-gray-400">{group.lastMessage}</p>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

export function GroupList({ onGroupSelect, selectedGroupId, excludeGuardian, onCreateGroup }: GroupListProps) {
  const { t } = useLanguage();
  const allGroups = useGroups();
  const { selectGroup } = useGroupChat();

  // 排除守護群組（已在獨立的「守護」標籤中顯示）
  const groups = useMemo(
    () => excludeGuardian ? allGroups.filter(g => !ext.ui.isGuardianGroup(g)) : allGroups,
    [allGroups, excludeGuardian]
  );

  const handleSelect = (groupId: string) => {
    selectGroup(groupId);
    onGroupSelect?.(groupId);
  };

  // ADR-016: 巢狀群組已移除，平鋪顯示所有群組
  const sortedGroups = useMemo(() => {
    return groups.map((group) => ({ group, depth: 0 }));
  }, [groups]);

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        </div>
        <p className="text-on-surface-secondary mb-2">{t('group.noGroups')}</p>
        <p className="text-xs text-on-surface-tertiary mb-3">{t('group.noGroupsHint')}</p>
        {onCreateGroup && (
          <button
            onClick={onCreateGroup}
            className="text-accent hover:opacity-80 text-sm"
          >
            {t('group.createGroup')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sortedGroups.map(({ group, depth }) => (
        <GroupItem
          key={group.id}
          group={group}
          isSelected={selectedGroupId === group.id}
          onSelect={() => handleSelect(group.id)}
          depth={depth}
        />
      ))}
    </div>
  );
}

export default GroupList;

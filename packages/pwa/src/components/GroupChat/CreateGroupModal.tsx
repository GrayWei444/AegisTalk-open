/**
 * CreateGroupModal - 建立群組彈窗
 *
 * 功能：
 * - 輸入群組名稱
 * - 選擇初始成員（從好友列表，上限 50 人）
 * - 顯示人數限制
 */

import { useState, useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useGroupChat } from '../../hooks/useGroupChat';
import { GROUP_CONSTANTS } from '../../types';
import { UserAvatar } from '../common';
import { useLanguage } from '../../i18n/context';
import { ext } from '@ext';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (groupId: string) => void;
  /** @deprecated ADR-016: 巢狀群組已移除 */
  defaultParentGroupId?: string;
  /** 切換到建立守護群組（已訂閱時顯示連結） */
  onSwitchToGuardian?: () => void;
}

export function CreateGroupModal({ isOpen, onClose, onCreated, onSwitchToGuardian }: CreateGroupModalProps) {
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const friends = useChatStore((state) => state.friends);
  const { createGroup } = useGroupChat();
  const { t } = useLanguage();
  // 守護群組是官方版的功能（社群版永遠 false）
  const { useCanCreateGuardianGroup } = ext.ui;
  const canCreateGuardianGroup = useCanCreateGuardianGroup();
  const showGuardianLink = onSwitchToGuardian && canCreateGuardianGroup;

  // 可選成員數量（扣除自己）
  const maxSelectableMembers = GROUP_CONSTANTS.MAX_MEMBERS - 1;

  // 是否達到人數上限
  const isMaxReached = selectedMembers.length >= maxSelectableMembers;

  // 可用好友列表
  const availableFriends = useMemo(() => {
    return friends.filter((f) => !selectedMembers.includes(f.publicKey));
  }, [friends, selectedMembers]);

  const handleToggleMember = (publicKey: string) => {
    if (selectedMembers.includes(publicKey)) {
      setSelectedMembers((prev) => prev.filter((pk) => pk !== publicKey));
    } else if (!isMaxReached) {
      setSelectedMembers((prev) => [...prev, publicKey]);
    }
  };

  const handleCreate = async () => {
    if (!groupName.trim()) {
      setError(t('groups.enterGroupName'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const groupId = await createGroup(groupName.trim(), selectedMembers);
      setGroupName('');
      setSelectedMembers([]);
      onCreated?.(groupId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('groups.createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    if (!isCreating) {
      setGroupName('');
      setSelectedMembers([]);
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-surface-secondary p-6 shadow-xl">
        {/* 標題 */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-on-surface-primary">{t('group.createGroup')}</h2>
          <button
            onClick={handleClose}
            disabled={isCreating}
            className="rounded-full p-2 text-on-surface-tertiary hover:bg-surface-elevated hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 守護群組連結（已訂閱時顯示） */}
        {showGuardianLink && (
          <button
            onClick={() => {
              handleClose();
              onSwitchToGuardian!();
            }}
            className="mb-4 flex w-full items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-left transition-colors hover:bg-emerald-500/20"
          >
            <span className="text-lg">{'\u{1F6E1}\u{FE0F}'}</span>
            <span className="flex-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              {t('guardian.orCreateGuardianGroup')}
            </span>
            <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        {/* 群組名稱 */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-on-surface-secondary">{t('group.groupName')}</label>
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={GROUP_CONSTANTS.MAX_NAME_LENGTH}
            placeholder={t('groups.groupNamePlaceholder')}
            className="w-full rounded-lg border border-[var(--surface-border)] bg-surface-tertiary px-4 py-2 text-on-surface-primary placeholder:text-on-surface-tertiary focus:border-[var(--accent)] focus:outline-none"
            disabled={isCreating}
          />
          <p className="mt-1 text-xs text-gray-500">
            {groupName.length}/{GROUP_CONSTANTS.MAX_NAME_LENGTH}
          </p>
        </div>

        {/* 選擇成員 */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-on-surface-secondary">
            {t('groups.inviteMembersOptional')}
            <span className="ml-2 text-gray-500">
              {selectedMembers.length}/{maxSelectableMembers}
            </span>
          </label>

          {/* 已選成員 */}
          {selectedMembers.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {selectedMembers.map((pk) => {
                const friend = friends.find((f) => f.publicKey === pk);
                return (
                  <span
                    key={pk}
                    className="flex items-center gap-1 rounded-full bg-green-400/20 px-3 py-1 text-sm text-green-500"
                  >
                    {friend?.name || pk.slice(0, 8)}
                    <button
                      onClick={() => handleToggleMember(pk)}
                      className="ml-1 rounded-full p-0.5 hover:bg-green-400/30"
                      disabled={isCreating}
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* 好友列表 */}
          <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--surface-border)] bg-surface-tertiary">
            {availableFriends.length === 0 ? (
              <p className="p-4 text-center text-sm text-gray-500">
                {friends.length === 0 ? t('groups.noFriends') : t('groups.allFriendsSelected')}
              </p>
            ) : (
              availableFriends.map((friend) => (
                <button
                  key={friend.publicKey}
                  onClick={() => handleToggleMember(friend.publicKey)}
                  disabled={isMaxReached || isCreating}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-700 ${
                    isMaxReached ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <UserAvatar avatar={friend.avatar} name={friend.name} size="md" />
                  <div className="flex-1">
                    <p className="font-medium text-on-surface-primary">{friend.name}</p>
                    <p className="text-xs text-on-surface-tertiary">
                      {friend.trustLevel === 'verified' ? t('invite.verified') : t('invite.unverified')}
                    </p>
                  </div>
                  <div className="h-5 w-5 rounded-full border-2 border-[var(--surface-border)]" />
                </button>
              ))
            )}
          </div>

          {isMaxReached && (
            <p className="mt-2 text-xs text-amber-500">
              {t('groups.maxMembersReached').replace('{max}', String(GROUP_CONSTANTS.MAX_MEMBERS))}
            </p>
          )}
        </div>

        {/* 錯誤訊息 */}
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/20 p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* 按鈕 */}
        <div className="flex gap-3">
          <button
            onClick={handleClose}
            disabled={isCreating}
            className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 font-medium text-on-surface-secondary hover:bg-surface-elevated"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating || !groupName.trim() || selectedMembers.length === 0}
            className="flex-1 rounded-lg bg-teal-500 px-4 py-2 font-medium text-white hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? t('groups.creating') : t('group.createGroup')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateGroupModal;

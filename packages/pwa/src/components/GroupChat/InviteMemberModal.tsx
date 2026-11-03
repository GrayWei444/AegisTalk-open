/**
 * InviteMemberModal - 邀請成員彈窗
 *
 * 功能：
 * - 搜尋好友
 * - 選擇好友邀請加入群組
 * - 顯示已選成員
 * - 人數限制檢查
 */

import { useState, useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useGroupChat } from '../../hooks/useGroupChat';
import { GROUP_CONSTANTS } from '../../types';
import { useLanguage } from '../../i18n/context';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvited?: () => void;
}

export function InviteMemberModal({ isOpen, onClose, onInvited }: InviteMemberModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [isInviting, setIsInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const friends = useChatStore((state) => state.friends);
  const { currentGroup, members, addMember, isFull } = useGroupChat();
  const { t } = useLanguage();

  // 目前群組成員的公鑰集合
  const existingMemberKeys = useMemo(() => {
    return new Set(members.map((m) => m.publicKey));
  }, [members]);

  // 可邀請的好友（排除已是成員的）
  const availableFriends = useMemo(() => {
    return friends.filter((f) => !existingMemberKeys.has(f.publicKey));
  }, [friends, existingMemberKeys]);

  // 搜尋過濾
  const filteredFriends = useMemo(() => {
    if (!searchQuery.trim()) return availableFriends;

    const query = searchQuery.toLowerCase();
    return availableFriends.filter(
      (f) =>
        f.name.toLowerCase().includes(query) ||
        f.publicKey.toLowerCase().includes(query)
    );
  }, [availableFriends, searchQuery]);

  // 還可邀請多少人
  const remainingSlots = GROUP_CONSTANTS.MAX_MEMBERS - members.length;
  const canInviteMore = selectedMembers.length < remainingSlots;

  const handleToggleMember = (publicKey: string) => {
    if (selectedMembers.includes(publicKey)) {
      setSelectedMembers((prev) => prev.filter((pk) => pk !== publicKey));
    } else if (canInviteMore) {
      setSelectedMembers((prev) => [...prev, publicKey]);
    }
  };

  const handleInvite = async () => {
    if (selectedMembers.length === 0) return;

    setIsInviting(true);
    setError(null);

    try {
      let successCount = 0;

      for (const publicKey of selectedMembers) {
        const friend = friends.find((f) => f.publicKey === publicKey);
        const success = await addMember(publicKey, friend?.name);
        if (success) {
          successCount++;
        }
      }

      if (successCount === 0) {
        setError(t('invite.inviteFailed'));
        return;
      }

      setSelectedMembers([]);
      setSearchQuery('');
      onInvited?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invite.inviteFailed'));
    } finally {
      setIsInviting(false);
    }
  };

  const handleClose = () => {
    if (!isInviting) {
      setSelectedMembers([]);
      setSearchQuery('');
      setError(null);
      onClose();
    }
  };

  if (!isOpen || !currentGroup) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-surface-secondary p-6 shadow-xl">
        {/* 標題 */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-on-surface-primary">{t('invite.title')}</h2>
            <p className="text-sm text-on-surface-tertiary">
              {currentGroup.name} · {t('invite.memberCount').replace('{count}', String(members.length)).replace('{max}', String(GROUP_CONSTANTS.MAX_MEMBERS))}
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={isInviting}
            className="rounded-full p-2 text-on-surface-tertiary hover:bg-surface-tertiary hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 群組已滿提示 */}
        {isFull && (
          <div className="mb-4 rounded-lg bg-amber-500/20 p-3 text-sm text-amber-700 dark:text-amber-400">
            {t('invite.groupFullLimit').replace('{max}', String(GROUP_CONSTANTS.MAX_MEMBERS))}
          </div>
        )}

        {/* 搜尋框 */}
        {!isFull && (
          <div className="mb-4">
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('invite.searchFriends')}
                className="w-full rounded-lg border border-[var(--surface-border)] bg-surface-tertiary px-4 py-2 pl-10 text-on-surface-primary placeholder:text-on-surface-tertiary focus:border-blue-500 focus:outline-none"
                disabled={isInviting}
              />
              <svg
                className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
          </div>
        )}

        {/* 已選成員 */}
        {selectedMembers.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-sm text-on-surface-tertiary">
              {t('invite.selectedCount').replace('{count}', String(selectedMembers.length)).replace('{max}', String(remainingSlots))}
            </p>
            <div className="flex flex-wrap gap-2">
              {selectedMembers.map((pk) => {
                const friend = friends.find((f) => f.publicKey === pk);
                return (
                  <span
                    key={pk}
                    className="flex items-center gap-1 rounded-full bg-blue-600/20 px-3 py-1 text-sm text-blue-400"
                  >
                    {friend?.name || pk.slice(0, 8)}
                    <button
                      onClick={() => handleToggleMember(pk)}
                      className="ml-1 rounded-full p-0.5 hover:bg-blue-600/30"
                      disabled={isInviting}
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* 好友列表 */}
        {!isFull && (
          <div className="mb-4 max-h-64 overflow-y-auto rounded-lg border border-[var(--surface-border)] bg-surface-tertiary">
            {filteredFriends.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500">
                {availableFriends.length === 0
                  ? t('invite.allFriendsInGroup')
                  : t('invite.noMatchingFriends')}
              </div>
            ) : (
              filteredFriends.map((friend) => {
                const isSelected = selectedMembers.includes(friend.publicKey);
                const canSelect = isSelected || canInviteMore;

                return (
                  <button
                    key={friend.publicKey}
                    onClick={() => handleToggleMember(friend.publicKey)}
                    disabled={!canSelect || isInviting}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? 'bg-blue-600/20'
                        : canSelect
                        ? 'hover:bg-gray-700'
                        : 'cursor-not-allowed opacity-50'
                    }`}
                  >
                    {/* 頭像 */}
                    {friend.avatar && (friend.avatar.startsWith('data:image') || friend.avatar.startsWith('http')) ? (
                      <img
                        src={friend.avatar}
                        alt={friend.name}
                        className="h-10 w-10 rounded-full object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-600 text-lg">
                        {friend.avatar || friend.name.charAt(0)}
                      </div>
                    )}

                    {/* 名稱 */}
                    <div className="flex-1">
                      <p className="font-medium text-on-surface-primary">{friend.name}</p>
                      <p className="text-xs text-on-surface-tertiary">
                        {friend.trustLevel === 'verified' ? t('invite.verified') : t('invite.unverified')}
                      </p>
                    </div>

                    {/* 選擇指示器 */}
                    <div
                      className={`h-5 w-5 rounded-full border-2 ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500'
                          : 'border-[var(--surface-border)]'
                      } flex items-center justify-center`}
                    >
                      {isSelected && (
                        <svg className="h-3 w-3 text-on-surface-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}

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
            disabled={isInviting}
            className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 font-medium text-on-surface-secondary hover:bg-surface-tertiary"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleInvite}
            disabled={isInviting || selectedMembers.length === 0 || isFull}
            className="flex-1 rounded-lg bg-green-600 px-4 py-2 font-medium text-on-surface-primary hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isInviting ? t('invite.invitingMembers') : t('invite.inviteCount').replace('{count}', String(selectedMembers.length))}
          </button>
        </div>
      </div>
    </div>
  );
}

export default InviteMemberModal;

/**
 * GroupSettingsModal - 群組設定彈窗
 *
 * 功能：
 * - 檢視/編輯群組名稱和頭像
 * - 查看成員列表
 * - 管理成員（管理員功能）
 * - 離開群組
 */

import { useState, useRef } from 'react';
import { devLog } from '../../utils/devLog';
import { useGroupChat } from '../../hooks/useGroupChat';
import { usePeerOnline } from '../../hooks/usePeerOnline';
import { useChatStore } from '../../stores/chatStore';
import { GROUP_CONSTANTS } from '../../types';
import type { GroupMember, GroupRole } from '../../types';
import { UserAvatar, GroupAvatar } from '../common';
import { useLanguage } from '../../i18n/context';
import { CrownIcon, UserIcon, BanIcon } from '../common/icons';
import { MAX_AVATAR_LENGTH } from '../../services/groupStateCommit';

/**
 * 群組頭像寫在狀態鏈上（每筆 commit、每份邀請都帶著），鏈的規則只收 ≤ MAX_AVATAR_LENGTH 字的 data URL：
 * 從大到小試尺寸與品質，取第一個放得下的小縮圖（以前 200×200 的 JPEG 約 1～3 萬字，一律被鏈拒收，審查 W1 M-3）
 */
const AVATAR_SIZES = [96, 80, 64, 56, 48, 40, 32];
const AVATAR_QUALITIES = [0.7, 0.55, 0.4];

/**
 * 壓縮圖片並轉為 Base64（放得進鏈的大小；放不下 → 丟例外）
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        for (const size of AVATAR_SIZES) {
          const scale = Math.min(1, size / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Failed to get canvas context'));
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          for (const quality of AVATAR_QUALITIES) {
            const base64 = canvas.toDataURL('image/jpeg', quality);
            if (base64.length <= MAX_AVATAR_LENGTH) {
              resolve(base64);
              return;
            }
          }
        }
        reject(new Error('avatar-too-large'));
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function MemberItem({
  member,
  online,
  isAdmin,
  canManage,
  onRemove,
  onChangeRole,
  inviteUndelivered,
  onResendInvite,
}: {
  member: GroupMember;
  /** 小綠點（usePeerOnline） */
  online: boolean;
  isAdmin: boolean;
  canManage: boolean;
  onRemove: () => void;
  onChangeRole: (role: GroupRole) => void;
  /** 我送的邀請重送用完、還沒送到他（W2） */
  inviteUndelivered?: boolean;
  onResendInvite?: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const friends = useChatStore((state) => state.friends);
  const { t } = useLanguage();
  const friend = friends.find((f) => f.publicKey === member.publicKey);

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-tertiary">
      {/* 頭像 */}
      <div className="relative">
        <UserAvatar
          avatar={friend?.avatar}
          name={member.nickname || friend?.name || ''}
          size="md"
        />
        {online && (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface-secondary bg-green-500" />
        )}
      </div>

      {/* 資訊 */}
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-on-surface-primary">
            {member.nickname || friend?.name || member.publicKey.slice(0, 12)}
          </span>
          {isAdmin && (
            <span className="rounded bg-amber-600/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
              {t('group.admin')}
            </span>
          )}
        </div>
        <p className="text-xs text-on-surface-tertiary">
          {member.publicKey.slice(0, 16)}...
        </p>
        {inviteUndelivered && (
          <p className="text-xs text-amber-600">
            {t('group.inviteUndelivered')}{' '}
            <button onClick={onResendInvite} className="underline hover:text-amber-500">{t('group.resendInvite')}</button>
          </p>
        )}
      </div>

      {/* 操作按鈕 */}
      {canManage && !isAdmin && (
        <div className="relative">
          <button
            onClick={() => setShowActions(!showActions)}
            className="rounded-full p-2 text-on-surface-tertiary hover:bg-surface-elevated hover:text-on-surface-primary"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
              />
            </svg>
          </button>

          {showActions && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-lg border border-[var(--surface-border)] bg-surface-tertiary py-1 shadow-xl">
              {member.role === 'member' ? (
                <button
                  onClick={() => {
                    onChangeRole('admin');
                    setShowActions(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface-secondary hover:bg-surface-elevated"
                >
                  <CrownIcon size={16} className="shrink-0" />
                  {t('group.setAsAdmin')}
                </button>
              ) : (
                <button
                  onClick={() => {
                    onChangeRole('member');
                    setShowActions(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-on-surface-secondary hover:bg-surface-elevated"
                >
                  <UserIcon size={16} className="shrink-0" />
                  {t('group.removeAdmin')}
                </button>
              )}
              <button
                onClick={() => {
                  onRemove();
                  setShowActions(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-surface-elevated"
              >
                <BanIcon size={16} className="shrink-0" />
                {t('group.removeMember')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface GroupSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** @deprecated ADR-016: 巢狀群組已移除 */
  onCreateSubgroup?: () => void;
}

export function GroupSettingsModal({ isOpen, onClose }: GroupSettingsModalProps) {
  const {
    currentGroup,
    members,
    isAdmin,
    isFull,
    updateGroupInfo,
    removeMember,
    updateMemberRole,
    leaveGroup,
    forgetGroup,
    deleteGroup,
    resendInvite,
  } = useGroupChat();
  const { t } = useLanguage();
  // 小綠點（W4）：好友看驗過的 presence，非好友的同群成員看 here 與 P2P 通道（我自己：投影的 isOnline）
  const onlinePeers = usePeerOnline(members.map((m) => m.publicKey), isOpen);

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isForgetting, setIsForgetting] = useState(false);
  const [showForgetConfirm, setShowForgetConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ADR-016: 巢狀群組已移除

  if (!isOpen || !currentGroup) return null;

  const handleStartEdit = () => {
    setEditName(currentGroup.name);
    setEditAvatar(currentGroup.avatar || '');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditName('');
    setEditAvatar('');
  };

  /** 鏈或伺服器拒收（例如不是 admin、正在等 admin 換金鑰）：告訴使用者，不要默默沒反應 */
  const reportFailure = (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[GroupSettingsModal] group change failed:', reason);
    alert(t('group.changeFailed', { reason }));
  };

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      const updates: { name?: string; avatar?: string } = {};

      if (editName.trim() && editName !== currentGroup.name) {
        updates.name = editName.trim();
      }
      if (editAvatar !== (currentGroup.avatar || '')) {
        updates.avatar = editAvatar;
      }

      if (Object.keys(updates).length > 0) {
        await updateGroupInfo(updates);
        devLog('[GroupSettingsModal] Group info updated:', updates);
      }
    } catch (err) {
      reportFailure(err);
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert(t('settings.selectImageFile'));
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert(t('settings.imageTooLarge'));
      return;
    }

    setIsUploading(true);
    try {
      const compressedImage = await compressImage(file);
      setEditAvatar(compressedImage);
    } catch (error) {
      console.error('Failed to process image:', error);
      alert(t('settings.imageProcessFailed'));
    } finally {
      setIsUploading(false);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleLeave = async () => {
    setIsLeaving(true);
    try {
      await leaveGroup();
      onClose();
    } catch (err) {
      reportFailure(err);
    } finally {
      setIsLeaving(false);
      setShowLeaveConfirm(false);
    }
  };

  /** 拿不到目前那一代的金鑰時離開不了：只在這台刪掉（不寫 commit，見 useGroupChat.forgetGroup） */
  const handleForget = async () => {
    setIsForgetting(true);
    try {
      await forgetGroup();
      onClose();
    } catch (err) {
      reportFailure(err);
    } finally {
      setIsForgetting(false);
      setShowForgetConfirm(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteGroup();
      onClose();
    } catch (err) {
      reportFailure(err);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-surface-secondary shadow-xl">
        {/* 標題 */}
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <h2 className="text-lg font-bold text-on-surface-primary">{t('group.settings')}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-on-surface-tertiary hover:bg-surface-tertiary hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {/* 群組資訊 */}
          {isEditing ? (
            /* 編輯模式 */
            <div className="mb-6">
              {/* 頭像編輯 */}
              <div className="mb-4 flex flex-col items-center">
                <div className="relative mb-3">
                  <GroupAvatar
                    avatar={editAvatar}
                    name={currentGroup.name}
                    size="2xl"
                    className="ring-4 ring-purple-500"
                  />
                  {isUploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    </div>
                  )}
                </div>

                {/* 頭像操作按鈕 */}
                <div className="flex gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    {t('common.uploadPhoto')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </div>
              </div>

              {/* 名稱編輯 */}
              <div className="mb-4">
                <label className="mb-1 block text-sm text-on-surface-tertiary">{t('group.groupName')}</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={GROUP_CONSTANTS.MAX_NAME_LENGTH}
                  className="w-full rounded-lg border border-[var(--surface-border)] bg-surface-tertiary px-4 py-2 text-on-surface-primary focus:border-purple-500 focus:outline-none"
                  autoFocus
                />
                <p className="mt-1 text-xs text-on-surface-tertiary">
                  {editName.length}/{GROUP_CONSTANTS.MAX_NAME_LENGTH}
                </p>
              </div>

              {/* 儲存/取消按鈕 */}
              <div className="flex gap-2">
                <button
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={isSaving || isUploading}
                  className="flex-1 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-on-surface-primary hover:bg-purple-700 disabled:opacity-50"
                >
                  {isSaving ? t('common.saving') : t('group.saveChanges')}
                </button>
              </div>
            </div>
          ) : (
            /* 顯示模式 */
            <div className="mb-6 flex items-center gap-4">
              <GroupAvatar
                avatar={currentGroup.avatar}
                name={currentGroup.name}
                size="xl"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold text-on-surface-primary">{currentGroup.name}</h3>
                  {isAdmin && (
                    <button
                      onClick={handleStartEdit}
                      className="rounded p-1 text-on-surface-tertiary hover:bg-surface-tertiary hover:text-on-surface-primary"
                      title={t('group.editGroupInfo')}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                        />
                      </svg>
                    </button>
                  )}
                </div>
                <p className="text-sm text-on-surface-tertiary">
                  {members.length}/{GROUP_CONSTANTS.MAX_MEMBERS} {t('group.members')}
                </p>
              </div>
            </div>
          )}

          {/* 成員列表 */}
          <div className="mb-6">
            <h4 className="mb-2 text-sm font-medium text-on-surface-tertiary">{t('group.members')}</h4>
            <div className="rounded-lg border border-[var(--surface-border)]">
              {members.map((member) => (
                <MemberItem
                  key={member.publicKey}
                  member={member}
                  online={!!member.isOnline || onlinePeers.has(member.publicKey)}
                  isAdmin={member.role === 'admin'}
                  canManage={isAdmin}
                  onRemove={() => { removeMember(member.publicKey).catch(reportFailure); }}
                  onChangeRole={(role) => { updateMemberRole(member.publicKey, role).catch(reportFailure); }}
                  inviteUndelivered={currentGroup.unackedInvites?.includes(member.publicKey)}
                  onResendInvite={() => { resendInvite(member.publicKey).catch(reportFailure); }}
                />
              ))}
            </div>

            {isFull && (
              <p className="mt-2 text-xs text-amber-500">
                {t('groups.maxMembersReached').replace('{max}', String(GROUP_CONSTANTS.MAX_MEMBERS))}
              </p>
            )}
          </div>

          {/* ADR-016: 巢狀群組區塊已移除 */}

          {/* 離開群組 / 刪除群組 */}
          <div className="border-t border-[var(--surface-border)] pt-4 space-y-3">
            {/* 離開群組確認 */}
            {showLeaveConfirm ? (
              <div className="rounded-lg bg-red-500/10 p-4">
                <p className="mb-3 text-center text-sm text-red-600 dark:text-red-400">
                  {t('group.leaveConfirm')}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowLeaveConfirm(false)}
                    className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary"
                    disabled={isLeaving}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleLeave}
                    disabled={isLeaving}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-on-surface-primary hover:bg-red-700 disabled:opacity-50"
                  >
                    {isLeaving ? t('common.leaving') : t('group.confirmLeave')}
                  </button>
                </div>
              </div>
            ) : showForgetConfirm ? (
              /* 在這台忘掉這個群組確認 */
              <div className="rounded-lg bg-red-500/10 p-4">
                <p className="mb-3 text-center text-sm text-red-600 dark:text-red-400">
                  {t('group.forgetLocallyConfirm')}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowForgetConfirm(false)}
                    className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary"
                    disabled={isForgetting}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleForget}
                    disabled={isForgetting}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-on-surface-primary hover:bg-red-700 disabled:opacity-50"
                  >
                    {t('group.forgetLocally')}
                  </button>
                </div>
              </div>
            ) : showDeleteConfirm ? (
              /* 刪除群組確認 */
              <div className="rounded-lg bg-red-500/10 p-4">
                <p className="mb-3 text-center text-sm text-red-600 dark:text-red-400">
                  {t('group.deleteConfirm')}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary"
                    disabled={isDeleting}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-on-surface-primary hover:bg-red-700 disabled:opacity-50"
                  >
                    {isDeleting ? t('common.deleting') : t('group.confirmDelete')}
                  </button>
                </div>
              </div>
            ) : (
              /* 操作按鈕 */
              <>
                <button
                  onClick={() => setShowLeaveConfirm(true)}
                  className="w-full rounded-lg border border-[var(--surface-border)] px-4 py-2 text-center font-medium text-on-surface-secondary hover:bg-surface-tertiary"
                >
                  {t('group.leave')}
                </button>
                {/* 拿不到目前那一代的金鑰：離開（寫 leave）做不到 → 只在這台忘掉 */}
                {currentGroup.keyState === 'waiting-key' && (
                  <div className="space-y-1">
                    <p className="text-xs text-on-surface-tertiary">{t('group.forgetLocallyHint')}</p>
                    <button
                      onClick={() => setShowForgetConfirm(true)}
                      className="w-full rounded-lg border border-red-600/50 px-4 py-2 text-center font-medium text-red-600 dark:text-red-400 hover:bg-red-600/10"
                    >
                      {t('group.forgetLocally')}
                    </button>
                  </div>
                )}
                {isAdmin && (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full rounded-lg border border-red-600/50 px-4 py-2 text-center font-medium text-red-600 dark:text-red-400 hover:bg-red-600/10"
                  >
                    {t('group.deleteGroup')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default GroupSettingsModal;

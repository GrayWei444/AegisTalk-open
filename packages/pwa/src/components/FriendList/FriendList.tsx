import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { FriendItem } from './FriendItem';
import { AddFriendModal } from '../Verification/AddFriendModal';
import { GroupList, CreateGroupModal } from '../GroupChat';
import { useGroupUnreadCount } from '../../hooks/useGroupChat';
import { useConfig } from '../../config/ConfigProvider';
import { UserAvatar } from '../common';
import { UsersIcon, ShieldIcon, SearchIcon } from '../common/icons';
import { useLanguage } from '../../i18n';
import { ext } from '@ext';
import { usePendingFriendStore, findPending } from '../../stores/pendingFriendStore';
import { useApp } from '../../providers/AppProvider';

export type TabType = 'friends' | 'groups';

interface FriendListProps {
  onLogout?: () => void;
  onOpenSettings?: () => void;
  onOpenGuard?: () => void;
  onSelectGroup?: (groupId: string) => void;
  /** 外部控制 active tab（bottom nav 使用） */
  activeTabOverride?: TabType;
  /** 隱藏內建 tab bar（由外部 bottom nav 控制時） */
  hideTabBar?: boolean;
  /** 防護頁面是否開啟（桌面/平板：高亮防護分頁） */
  guardActive?: boolean;
}

export function FriendList({ onLogout, onOpenSettings, onOpenGuard, onSelectGroup, activeTabOverride, hideTabBar, guardActive }: FriendListProps) {
  const { t } = useLanguage();
  const { friends, currentFriendId, selectFriend, addFriend, userProfile } = useChatStore();
  // 我加了、對方還沒確認的好友（審查 M1）：清單上標「等待確認」
  const { publicKey } = useApp();
  const pendingEntries = usePendingFriendStore((s) => s.entries);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateGuardianGroup, setShowCreateGuardianGroup] = useState(false);
  const [showGroupTypeMenu, setShowGroupTypeMenu] = useState(false);
  const [internalTab, setInternalTab] = useState<TabType>('friends');
  const activeTab = activeTabOverride ?? internalTab;
  const setActiveTab = (tab: TabType) => setInternalTab(tab);
  const groupTypeMenuRef = useRef<HTMLDivElement>(null);

  // 訂閱狀態
  // 守護群組是官方版的功能（社群版永遠 false，也沒有建立守護群組的彈窗）
  const { useCanCreateGuardianGroup } = ext.ui;
  const canCreateGuardianGroup = useCanCreateGuardianGroup();
  const CreateGuardianGroupModal = ext.ui.CreateGuardianGroupModal;

  // 配置
  const { environment } = useConfig();
  const safeAreaClass = environment.ui?.safeArea?.top ? 'safe-area-top' : '';

  // 點擊外部關閉群組類型選單
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (groupTypeMenuRef.current && !groupTypeMenuRef.current.contains(event.target as Node)) {
        setShowGroupTypeMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 群組相關
  const groupUnreadCount = useGroupUnreadCount();
  const friendUnreadCount = friends.reduce((sum, f) => sum + f.unreadCount, 0);



  const handleFriendAdded = (publicKey: string, isVerified: boolean) => {
    const trustLevel = isVerified ? 'verified' : 'unverified';
    const name = t('friendList.defaultFriendPrefix').replace('{key}', publicKey.slice(0, 8));
    addFriend(publicKey, name, trustLevel);
    setShowAddFriend(false);
  };

  return (
    <div className="h-full flex flex-col bg-surface-primary">
      {/* Header - 根據配置加入 safe-area-top 避免與狀態列/瀏海/動態島重疊 */}
      <div className={`flex items-center justify-between px-4 py-3 border-b border-[var(--surface-border)] bg-surface-secondary ${safeAreaClass}`}>
        <h1 className="text-lg font-semibold text-on-surface-primary">{t('friendList.messages')}</h1>
        <div className="flex items-center gap-1">
          {/* Add Button (Friend or Group based on tab) */}
          <div className="relative" ref={groupTypeMenuRef}>
            <button
              onClick={() => {
                if (activeTab === 'friends') {
                  setShowAddFriend(true);
                } else {
                  setShowGroupTypeMenu(!showGroupTypeMenu);
                }
              }}
              className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
              title={activeTab === 'friends' ? t('friendList.addFriend') : t('group.createGroup')}
            >
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {activeTab === 'friends' ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                )}
              </svg>
            </button>

            {/* 群組類型選單 (Phase 19) */}
            {showGroupTypeMenu && activeTab === 'groups' && (
              <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-[var(--surface-border)] bg-surface-secondary py-1 shadow-xl">
                {/* 普通群組 */}
                <button
                  onClick={() => {
                    setShowCreateGroup(true);
                    setShowGroupTypeMenu(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary"
                >
                  <UsersIcon size={18} className="shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{t('friendList.normalGroup')}</p>
                    <p className="text-xs text-on-surface-tertiary">{t('friendList.normalGroupHint')}</p>
                  </div>
                </button>

                {/* 守護群組（僅訂閱用戶可見） */}
                {canCreateGuardianGroup && (
                <button
                  onClick={() => {
                    setShowCreateGuardianGroup(true);
                    setShowGroupTypeMenu(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary"
                >
                  <ShieldIcon size={18} className="shrink-0 text-emerald-500" />
                  <div>
                    <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{t('friendList.familyGuardianGroup')}</p>
                    <p className="text-xs text-on-surface-tertiary">{t('friendList.guardianGroupHint')}</p>
                  </div>
                </button>
                )}
              </div>
            )}
          </div>
          {/* Settings Button */}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
              title={t('nav.settings')}
            >
              <svg className="w-5 h-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
          {/* AegisTalk: 登出按鈕（取代原本的偽裝頁面按鈕）*/}
          {onLogout && (
            <button
              onClick={onLogout}
              className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
              title={t('friendList.logout')}
            >
              <svg className="w-5 h-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Tab 切換（hideTabBar 時由外部 bottom nav 控制） */}
      {!hideTabBar && (
        <div className="flex border-b border-[var(--surface-border)] bg-surface-secondary">
          <button
            onClick={() => setActiveTab('friends')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'friends' && !guardActive
                ? 'text-accent'
                : 'text-on-surface-secondary hover:text-on-surface-primary'
            }`}
          >
            {t('nav.friends')}
            {friendUnreadCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-accent text-white rounded-full">
                {friendUnreadCount > 99 ? '99+' : friendUnreadCount}
              </span>
            )}
            {activeTab === 'friends' && !guardActive && (
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 bg-accent rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('groups')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'groups' && !guardActive
                ? 'text-accent'
                : 'text-on-surface-secondary hover:text-on-surface-primary'
            }`}
          >
            {t('nav.groups')}
            {groupUnreadCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-accent text-white rounded-full">
                {groupUnreadCount > 99 ? '99+' : groupUnreadCount}
              </span>
            )}
            {activeTab === 'groups' && !guardActive && (
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 bg-accent rounded-full" />
            )}
          </button>
          {/* 防護分頁（桌面/平板專用 — 行動版由 bottom nav 提供）*/}
          {onOpenGuard && (
            <button
              onClick={onOpenGuard}
              className={`flex-1 py-3 text-sm font-medium transition-colors relative flex items-center justify-center gap-1 ${
                guardActive
                  ? 'text-accent'
                  : 'text-on-surface-secondary hover:text-on-surface-primary'
              }`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={guardActive ? 2.5 : 1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
              {t('nav.shield')}
              {guardActive && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 bg-accent rounded-full" />
              )}
            </button>
          )}
        </div>
      )}

      {/* 我的身份卡片 */}
      <div className="px-4 py-3 border-b border-[var(--surface-border)]">
        <div className="flex items-center gap-3 p-3 bg-surface-tertiary rounded-xl">
          {/* 頭像 - 讀取 userProfile.avatar */}
          <UserAvatar avatar={userProfile.avatar} name={userProfile.displayName} size="lg" className="flex-shrink-0" />
          {/* 身份資訊 */}
          <div className="flex-1 min-w-0">
            <p className="text-on-surface-primary font-medium text-sm">{userProfile.displayName || t('friendList.myIdentity')}</p>
            <p className="text-xs text-on-surface-secondary mt-0.5">{t('friendList.tapQRAddFriend')}</p>
          </div>
          {/* QR Code 按鈕 */}
          <button
            onClick={() => setShowAddFriend(true)}
            className="p-2 bg-accent-soft hover:bg-accent/20 rounded-lg transition-colors"
            title={t('friendList.showMyQRCode')}
          >
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-4 py-2 bg-surface-secondary">
        <div className="relative">
          <input
            type="text"
            placeholder={t('common.search')}
            className="w-full input-base rounded-xl px-4 py-2 pl-10 text-sm"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-tertiary">
            <SearchIcon size={16} />
          </span>
        </div>
      </div>

      {/* Content based on active tab */}
      <div className="flex-1 overflow-y-auto bg-surface-secondary">
        {activeTab === 'friends' && (
          friends.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-6 text-center">
              <div className="w-16 h-16 rounded-full bg-surface-tertiary flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <p className="text-on-surface-secondary mb-2">{t('friendList.noFriends')}</p>
              <button
                onClick={() => setShowAddFriend(true)}
                className="text-accent hover:opacity-80 text-sm"
              >
                {t('friendList.clickToAddFriend')}
              </button>
            </div>
          ) : (
            friends.map(friend => (
              <FriendItem
                key={friend.id}
                friend={friend}
                isSelected={friend.id === currentFriendId}
                onClick={() => selectFriend(friend.id)}
                pendingLabel={findPending(pendingEntries, publicKey, friend.publicKey) ? t('friendConfirm.badge') : undefined}
              />
            ))
          )
        )}
        {activeTab === 'groups' && (
          <GroupList onGroupSelect={onSelectGroup} onCreateGroup={() => setShowCreateGroup(true)} />
        )}
      </div>

      {/* Add Friend Modal */}
      <AddFriendModal
        isOpen={showAddFriend}
        onClose={() => setShowAddFriend(false)}
        onFriendAdded={handleFriendAdded}
      />

      {/* Create Group Modal */}
      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onSwitchToGuardian={() => {
          setShowCreateGroup(false);
          setShowCreateGuardianGroup(true);
        }}
      />

      {/* Create Guardian Group Modal (Phase 19) */}
      {CreateGuardianGroupModal && (
      <CreateGuardianGroupModal
        isOpen={showCreateGuardianGroup}
        onClose={() => setShowCreateGuardianGroup(false)}
        onCreated={(groupId) => {
          onSelectGroup?.(groupId);
        }}
      />
      )}
    </div>
  );
}

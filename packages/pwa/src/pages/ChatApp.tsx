import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FriendList, type TabType } from '../components/FriendList/FriendList';
import { ChatRoom } from '../components/ChatRoom/ChatRoom';
import { GroupChatWindow } from '../components/GroupChat/GroupChatWindow';
import { SettingsPage } from './SettingsPage';
import { useChatStore } from '../stores/chatStore';
import { useGroupStore } from '../stores/groupStore';
import { useApp } from '../providers';
import { useGroupUnreadCount } from '../hooks/useGroupChat';
import { useRingDirectory } from '../hooks/useRingDirectory';
import { isNativeApp } from '../services/capacitor';
import { useLanguage } from '../i18n';
import { devLog } from '../utils/devLog';
import { ext } from '@ext';
import { requestNotificationPermission } from '../services/callNotification';
import { registerFcmToken } from '../services/capacitor';
import { registerWebPush } from '../services/webPush';

interface ChatAppProps {
  onLogout: () => void;
}

export function ChatApp({ onLogout }: ChatAppProps) {
  const { currentFriendId, clearSelection, loadFromStorage, isLoaded, userProfile, friends: chatFriends } = useChatStore();
  const { currentGroupId, clearSelection: clearGroupSelection, selectGroup } = useGroupStore();
  const { t } = useLanguage();

  const { cryptoReady, hasIdentity, keysLocked, generateIdentity, isInitializing, storageReady, publicKey, error: appError } = useApp();
  const [isMobile, setIsMobile] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGroupChat, setShowGroupChat] = useState(false);
  const [mobileTab, setMobileTab] = useState<TabType>('friends');

  // 版本的擴充（官方版：網路防護、報平安覆蓋卡片、錢包／防護分頁、行為分析；社群版沒有）
  const openGroup = useCallback((groupId: string) => {
    setMobileTab('groups');
    clearSelection();
    selectGroup(groupId);
    setShowGroupChat(true);
  }, [clearSelection, selectGroup]);
  const { useChatShell } = ext.ui;
  const shell = useChatShell({ publicKey, displayName: userProfile.displayName, openGroup });
  const ShellWrapper = shell.Wrapper;

  // 來電推播的響鈴 token 要在收推播的那一條路驗（開源第 5d 步）：我是誰、好友名單、時鐘差同步過去
  useRingDirectory(publicKey, chatFriends);

  // 聊天畫面掛載後才請求通知權限 + 註冊 FCM
  // 確保用戶已看到聊天 UI，不會在 auth 流程中被打斷
  const notificationRequestedRef = useRef(false);
  useEffect(() => {
    if (notificationRequestedRef.current) return;
    notificationRequestedRef.current = true;
    const timer = setTimeout(() => {
      // 原生 App：FCM token；PWA：使用者允許通知之後（只有 granted 才訂閱，開源第 5b 步）把 Web Push 訂閱登記到所選的
      //   chat 伺服器（帳戶簽章，開源第 4 步 —— 以前訂閱經 MQTT 明文交給好友、好友再拿去打沒有驗證的 relay）
      requestNotificationPermission().then((granted) => {
        if (granted && publicKey && !isNativeApp()) registerWebPush(publicKey).catch(() => {});
      }).catch(() => {});
      if (publicKey) registerFcmToken(publicKey).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [publicKey]);

  // 未讀數（用於 bottom nav badges）
  const groupUnreadCount = useGroupUnreadCount();
  const friendUnreadCount = useMemo(
    () => chatFriends.reduce((sum, f) => sum + f.unreadCount, 0),
    [chatFriends]
  );

  // 當選中群組時，切換到群組聊天視圖
  const handleGroupSelect = useCallback((_groupId: string) => {
    // 清除 1-1 對話選擇（群組 ID 已由 GroupList 通過 selectGroup 設定）
    clearSelection();
    setShowGroupChat(true);
  }, [clearSelection]);

  // 從群組聊天返回
  const handleBackFromGroup = useCallback(() => {
    clearGroupSelection();
    setShowGroupChat(false);
  }, [clearGroupSelection]);

  // 當 currentGroupId 變化時同步 showGroupChat
  useEffect(() => {
    if (currentGroupId) {
      setShowGroupChat(true);
      clearSelection(); // 確保清除 1-1 選擇
    }
  }, [currentGroupId, clearSelection]);

  // 當選中好友時，自動退出群聊（讓個人聊天顯示）
  useEffect(() => {
    if (currentFriendId && showGroupChat) {
      clearGroupSelection();
      setShowGroupChat(false);
    }
  }, [currentFriendId, showGroupChat, clearGroupSelection]);

  // 從本地儲存載入資料
  useEffect(() => {
    if (storageReady && !isLoaded) {
      devLog('[ChatApp] Loading data from storage...');
      loadFromStorage();
    }
  }, [storageReady, isLoaded, loadFromStorage]);

  // 邀請連結的確認視窗（送 INVITE_ACCEPT）2026-10-15 拿掉：產生連結的入口早已移除，對方也不再接受 INVITE_ACCEPT。

  // 自動生成身份（首次使用時，keysLocked 時不產生 — 等待 PIN 解鎖）
  useEffect(() => {
    if (cryptoReady && !hasIdentity && !keysLocked && !isInitializing && !isGenerating) {
      setIsGenerating(true);
      try {
        const newPubKey = generateIdentity();
        devLog('[ChatApp] Generated new identity:', newPubKey.slice(0, 20) + '...');
      } catch (err) {
        console.error('[ChatApp] Failed to generate identity:', err);
      } finally {
        setIsGenerating(false);
      }
    }
  }, [cryptoReady, hasIdentity, keysLocked, isInitializing, isGenerating, generateIdentity]);

  // 注意：X3DH_INIT 和 ENCRYPTED_MESSAGE 的處理已移至 AppProvider 全域處理
  // 這裡不再需要重複監聯，避免衝突

  // Responsive breakpoint detection
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 600;
      devLog('[ChatApp] Window width:', window.innerWidth, 'isMobile:', mobile);
      setIsMobile(mobile);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Debug: 追蹤狀態變化
  useEffect(() => {
    devLog('[ChatApp] State:', {
      isMobile,
      currentFriendId,
      currentGroupId,
      showSettings,
      showGroupChat,
      isInitializing,
      hasIdentity,
    });
  }, [isMobile, currentFriendId, currentGroupId, showSettings, showGroupChat, isInitializing, hasIdentity]);

  // iOS Safari PWA / Chrome PWA: 強制重繪當從背景恢復時
  const [, forceRender] = useState(0);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        devLog('[ChatApp] Visibility changed to visible, forcing re-render');

        // 重新載入資料確保最新
        if (!isLoaded) {
          loadFromStorage();
        }

        // 方法 1: 強制 React 重新渲染
        forceRender(prev => prev + 1);

        // 方法 2: 延遲再次渲染（等 IndexedDB 讀取完成）
        setTimeout(() => {
          forceRender(prev => prev + 1);
        }, 100);

        // 方法 3: 強制瀏覽器重繪 (iOS Safari PWA 特殊處理)
        requestAnimationFrame(() => {
          document.body.style.opacity = '0.999';
          requestAnimationFrame(() => {
            document.body.style.opacity = '1';
            // 再次觸發渲染確保更新
            forceRender(prev => prev + 1);
          });
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLoaded, loadFromStorage]);


  // 顯示載入中畫面或錯誤
  if (isInitializing || isGenerating || !hasIdentity) {
    // 如果有錯誤，顯示錯誤訊息
    if (appError) {
      return (
        <div className="h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6">
          <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-red-500 dark:text-red-400 font-medium mb-2">{t('chatApp.initFailed')}</p>
          <p className="text-on-surface-secondary text-sm text-center mb-4">{appError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-accent hover:opacity-90 text-white rounded-lg font-medium transition-colors"
          >
            {t('chatApp.reload')}
          </button>
          <p className="text-on-surface-tertiary text-xs mt-4 text-center">
            {t('chatApp.persistentErrorHint')}
          </p>
        </div>
      );
    }

    return (
      <div className="h-[100dvh] bg-surface-primary flex flex-col items-center justify-center">
        <div className="w-16 h-16 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-on-surface-secondary">
          {isInitializing ? t('auth.initCryptoModule') : t('auth.generatingKeys')}
        </p>
        <p className="text-on-surface-tertiary text-sm mt-2">{t('chatApp.firstTimeHint')}</p>
      </div>
    );
  }

  // Mobile: single column layout with bottom navigation
  if (isMobile) {
    const isInFullScreen = shell.mobilePanelOpen || showSettings
      || (showGroupChat && !!currentGroupId) || !!currentFriendId;

    return (
      <ShellWrapper myPublicKey={publicKey}>
        <div className="h-[100dvh] bg-surface-primary safe-area-top flex flex-col">
          {isInFullScreen ? (
            // 全螢幕視圖（聊天、設定、守護等）
            <div className="flex-1 min-h-0">
              {shell.mobilePanel ? (
                shell.mobilePanel
              ) : showSettings ? (
                <SettingsPage onBack={() => setShowSettings(false)}  />
              ) : showGroupChat && currentGroupId ? (
                <GroupChatWindow
                  onBack={handleBackFromGroup}
                  onNavigateToFriend={(publicKey) => {
                    // 從群聊點名字 → 跳到個人聊天
                    const friend = chatFriends.find(f => f.publicKey === publicKey);
                    if (friend) {
                      useChatStore.getState().selectFriend(friend.id);
                    }
                  }}
                />
              ) : (
                <ChatRoom onBack={clearSelection} />
              )}
            </div>
          ) : (
            <>
              {/* 列表視圖 + bottom nav */}
              <div className="flex-1 min-h-0 overflow-hidden">
                <FriendList
                  onLogout={onLogout}
                  onOpenSettings={() => setShowSettings(true)}
                  onSelectGroup={handleGroupSelect}
                  activeTabOverride={mobileTab}
                  hideTabBar
                />
              </div>

              {/* Bottom Navigation Bar */}
              <nav className="flex-shrink-0 border-t border-[var(--surface-border)] bg-surface-secondary safe-area-bottom">
                <div className="flex">
                  {/* 好友 */}
                  <button
                    onClick={() => setMobileTab('friends')}
                    className={`flex-1 flex flex-col items-center py-2 pt-2.5 transition-colors ${
                      mobileTab === 'friends' ? 'text-accent' : 'text-on-surface-tertiary'
                    }`}
                  >
                    <div className="relative">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={mobileTab === 'friends' ? 2.5 : 1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                      </svg>
                      {friendUnreadCount > 0 && (
                        <span className="absolute -top-1.5 -right-2.5 min-w-[1.125rem] h-[1.125rem] flex items-center justify-center px-1 text-[0.625rem] font-bold bg-accent text-white rounded-full">
                          {friendUnreadCount > 99 ? '99+' : friendUnreadCount}
                        </span>
                      )}
                    </div>
                    <span className="text-xs mt-0.5 font-medium">{t('nav.friends')}</span>
                  </button>

                  {/* 群組 */}
                  <button
                    onClick={() => setMobileTab('groups')}
                    className={`flex-1 flex flex-col items-center py-2 pt-2.5 transition-colors ${
                      mobileTab === 'groups' ? 'text-accent' : 'text-on-surface-tertiary'
                    }`}
                  >
                    <div className="relative">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={mobileTab === 'groups' ? 2.5 : 1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                      </svg>
                      {groupUnreadCount > 0 && (
                        <span className="absolute -top-1.5 -right-2.5 min-w-[1.125rem] h-[1.125rem] flex items-center justify-center px-1 text-[0.625rem] font-bold bg-accent text-white rounded-full">
                          {groupUnreadCount > 99 ? '99+' : groupUnreadCount}
                        </span>
                      )}
                    </div>
                    <span className="text-xs mt-0.5 font-medium">{t('nav.groups')}</span>
                  </button>

                  {/* 版本的擴充分頁（官方版：錢包、防護） */}
                  {shell.mobileTabs}
                </div>
              </nav>
            </>
          )}
          {shell.overlay}
        </div>
      </ShellWrapper>
    );
  }

  // Tablet/Desktop: AegisGuard view（官方版的防護頁）
  if (shell.desktopPanel) {
    return (
      <ShellWrapper myPublicKey={publicKey}>
        <div className="h-[100dvh] flex flex-col bg-surface-primary">
          <div className="flex flex-1 min-h-0">
            <div className="w-80 border-r border-[var(--surface-border)] flex-shrink-0">
              <FriendList
                onLogout={onLogout}
                onOpenSettings={() => setShowSettings(true)}
                onOpenGuard={shell.openGuard}
                guardActive
                onSelectGroup={handleGroupSelect}
              />
            </div>
            <div className="flex-1">
              {shell.desktopPanel}
            </div>
          </div>
        </div>
      </ShellWrapper>
    );
  }

  // Tablet/Desktop: Settings view
  if (showSettings) {
    return (
      <ShellWrapper myPublicKey={publicKey}>
        <div className="h-[100dvh] flex flex-col bg-surface-primary">
          <div className="flex flex-1 min-h-0">
            <div className="w-80 border-r border-[var(--surface-border)] flex-shrink-0">
              <FriendList
                onLogout={onLogout}
                onOpenSettings={() => setShowSettings(true)}
                onOpenGuard={shell.openGuard}
                onSelectGroup={handleGroupSelect}
              />
            </div>
            <div className="flex-1">
              <SettingsPage onBack={() => setShowSettings(false)}  />
            </div>
          </div>
        </div>
      </ShellWrapper>
    );
  }

  return (
    <ShellWrapper myPublicKey={publicKey}>
      <div className="h-screen flex flex-col bg-surface-primary">
        <div className="flex flex-1 min-h-0">
          <div className="w-80 border-r border-[var(--surface-border)] flex-shrink-0">
            <FriendList
              onLogout={onLogout}
              onOpenSettings={() => setShowSettings(true)}
              onOpenGuard={shell.openGuard}
              onSelectGroup={handleGroupSelect}
            />
          </div>

          {/* Chat room or Group chat - right panel */}
          <div className="flex-1">
            {showGroupChat && currentGroupId ? (
              <GroupChatWindow
                onBack={handleBackFromGroup}
                onNavigateToFriend={(publicKey) => {
                  const friend = chatFriends.find(f => f.publicKey === publicKey);
                  if (friend) {
                    useChatStore.getState().selectFriend(friend.id);
                  }
                }}
              />
            ) : (
              <ChatRoom />
            )}
          </div>
        </div>

        {shell.overlay}
      </div>
    </ShellWrapper>
  );
}

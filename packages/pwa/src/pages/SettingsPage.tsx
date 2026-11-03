import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useThemeStore, type ThemeMode } from '../stores/themeStore';
import { useFontScaleStore, type FontScale } from '../stores/fontScaleStore';
import { useCrypto } from '../hooks/useCrypto';
import { mqttService } from '../services/mqtt';
import { broadcastProfileUpdate } from '../services/directSignal';
import { clearAllOutgoing } from '../services/outgoingQueueStore';
import { flushToStore } from '../services/database';
import { clearGuardianNativeData } from '../services/guardianBackground';
import { shutdownP2PAccount } from '../services/p2pSend';
import { shutdownFileTransfer } from '../services/fileTransfer';
import { DeviceTransferModal } from '../components/DeviceTransfer';
import { PageHeader, UserAvatar } from '../components/common';
import { useLanguage, LANGUAGES, LANGUAGE_LABELS } from '../i18n';
import {
  isNativeApp,
} from '../services/capacitor';
import { checkNotificationPermission } from '../services/callNotification';
import { ChatExportModal } from '../components/ChatExport';
import { ChangePinModal } from '../components/Settings/ChangePinModal';
import { ServerSettings } from '../components/Settings/ServerSettings';
import { ext } from '@ext';

// 最大圖片尺寸（壓縮後）
const MAX_IMAGE_SIZE = 200;
const IMAGE_QUALITY = 0.8;

/**
 * 壓縮圖片並轉為 Base64
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_IMAGE_SIZE) {
            height = (height * MAX_IMAGE_SIZE) / width;
            width = MAX_IMAGE_SIZE;
          }
        } else {
          if (height > MAX_IMAGE_SIZE) {
            width = (width * MAX_IMAGE_SIZE) / height;
            height = MAX_IMAGE_SIZE;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const base64 = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
        resolve(base64);
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** 通知權限設定列 — 直接檢查 OS 權限狀態，不依賴 store 延遲更新 */
function NotificationPermissionRow() {
  const { t } = useLanguage();
  const [granted, setGranted] = useState<boolean | null>(null); // null = 載入中
  const [requesting, setRequesting] = useState(false);

  // 元件掛載時直接向 OS 查詢通知權限
  useEffect(() => {
    checkNotificationPermission().then((status) => {
      setGranted(status === 'granted');
    });
  }, []);

  const handleGrant = async () => {
    setRequesting(true);
    try {
      const result = await ext.ui.requestNotificationPermission();
      setGranted(result);
    } finally {
      setRequesting(false);
    }
  };

  // 載入中不顯示
  if (granted === null) return null;

  return (
    <div className="flex items-center justify-between p-3 bg-surface-tertiary rounded-lg mt-3">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          granted ? 'bg-green-500/20' : 'bg-amber-500/20'
        }`}>
          <svg className={`w-5 h-5 ${granted ? 'text-green-500' : 'text-amber-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
        </div>
        <div className="text-left">
          <p className="text-on-surface-primary text-sm font-medium">{t('settings.notificationPermission')}</p>
          <p className="text-on-surface-secondary text-xs">{t('settings.notificationPermissionDescription')}</p>
        </div>
      </div>
      {granted ? (
        <div className="flex items-center gap-1 text-green-500">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm">{t('settings.notificationGranted')}</span>
        </div>
      ) : (
        <button
          onClick={handleGrant}
          disabled={requesting}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {requesting && (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {t('settings.grantPermission')}
        </button>
      )}
    </div>
  );
}

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const { userProfile, setDisplayName, setAvatar, friends, resetAll } = useChatStore();
  const { identity, signedPreKey, publicKeyBase64 } = useCrypto();
  // 版本的擴充（官方版：協助好友恢復、AegisGuard 防護、AegisPay；社群版沒有）
  const { useSettingsExtras } = ext.ui;
  const extras = useSettingsExtras({ myPubkey: publicKeyBase64 });
  const { mode: themeMode, setMode: setThemeMode } = useThemeStore();
  const { scale: fontScale, setScale: setFontScale } = useFontScaleStore();
  const { t, language, setLanguage } = useLanguage();

  const [editingName, setEditingName] = useState(false);
  const [tempName, setTempName] = useState(userProfile.displayName);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 換機狀態
  const [showDeviceTransfer, setShowDeviceTransfer] = useState(false);
  const [showChatExport, setShowChatExport] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);

  // 臉部辨識/生物辨識設定已從設定頁移除 — 由註冊流程處理

  // 主題選項
  const themeOptions: { value: ThemeMode; label: string }[] = [
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'system', label: t('settings.themeSystem') },
  ];

  const handleSaveName = () => {
    const newName = tempName.trim() || userProfile.displayName;
    setDisplayName(newName);
    setEditingName(false);

    // 廣播給所有好友
    const friendPublicKeys = friends.map((f) => f.publicKey);
    if (friendPublicKeys.length > 0) {
      broadcastProfileUpdate(friendPublicKeys, {
        displayName: newName,
        avatar: userProfile.avatar,
      });
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
      alert(t('settings.imageTooLargeMax'));
      return;
    }

    setIsUploading(true);
    try {
      const compressedImage = await compressImage(file);
      setAvatar(compressedImage);

      // 廣播給所有好友
      const friendPublicKeys = friends.map((f) => f.publicKey);
      if (friendPublicKeys.length > 0) {
        broadcastProfileUpdate(friendPublicKeys, {
          displayName: userProfile.displayName,
          avatar: compressedImage,
        });
      }
    } catch (error) {
      console.error('Failed to process image:', error);
      alert(t('settings.imageProcessFailedRetry'));
    } finally {
      setIsUploading(false);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // 換機成功後處理（根據模式決定是否登出）
  const handleDeviceTransferSuccess = async (mode: 'transfer' | 'multi-device') => {
    if (mode === 'transfer') {
      // 換機模式：A 機登出。MQTT 待送佇列（IndexedDB）不分帳號：先停 MQTT 再清掉，否則下一個帳號會
      //   用這個帳號的身分把排隊的 X3DH_INIT／群組事件送出去（對應群星 P3-4）
      mqttService.disconnect();
      await clearGuardianNativeData();   // 原生端的守護資料一起清（報平安設定、舊版憑證）
      // 驗來電推播用的本機資料（好友名單副本、我是誰、看過的來電；開源第 5d 步）
      await import('../services/ringSync').then((m) => m.clearRingData()).catch((err) => console.error('[Settings] clearing the ring data failed:', err));
      await clearAllOutgoing().catch((err) => console.error('[Settings] clearing MQTT outbox failed:', err));
      // 這個帳號還在跑的傳檔與送訊先停（對應群星 shutdownP2PAccount）：下面清 SQLite outbox 之後不會又寫回一筆。
      //   待送的檔（aegis_file_pending，帶著檔案金鑰）是這個帳號的，一起清
      await shutdownFileTransfer().catch((err) => console.error('[Settings] stopping file transfer failed:', err));
      await shutdownP2PAccount().catch((err) => console.error('[Settings] stopping P2P failed:', err));
      // 等清除帳號做完（storage.clearAllData：含 SQLite 待送與共用的群組密文），再封印存檔才 reload（同 App.exitChat）。
      //   以前 resetAll 沒等就 reload：web 版的刪除還沒存檔就整頁丟掉，下一個帳號照樣載到上一個帳號的待送。
      //   清除失敗照樣登出（帳號已經搬到新裝置）
      await resetAll().catch((err) => console.error('[Settings] account wipe failed:', err));
      await flushToStore({ seal: true }).catch((err) => console.error('[Settings] flush before reload failed:', err));
      const keysToRemove = [
        'mist_keys', 'mist_keys_sqlite_migrated',
        'aegis_biometric_enabled', 'aegis_pin_set',
        'device_recovery_pin_lock', 'aegis_backup_auth_hash',
        'socialRecoveryConfig', 'socialRecoveryShards',
        'aegis_encryption_key', 'aegis_encryption_salt',
        'aegis_face_embedding', 'aegis_file_pending',
      ];
      keysToRemove.forEach(k => localStorage.removeItem(k));
      window.location.reload();
    } else {
      // 多設備模式：A 機保持登入
      setShowDeviceTransfer(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-primary">
      {/* Header - 使用共用 PageHeader 元件 */}
      <PageHeader
        title={t('settings.title')}
        onBack={onBack}
        backIcon={
          <svg className="w-5 h-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        }
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* 帳號資訊區塊 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{t('settings.accountInfo')}</h2>

          {/* 頭像 */}
          <div className="mb-4">
            <div className="flex items-center gap-4">
              <div className="relative">
                <UserAvatar avatar={userProfile.avatar} name={userProfile.displayName} size="xl" className="border-2 border-mist-500" />
                {isUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full">
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="px-4 py-2 bg-mist-500 hover:bg-mist-600 text-white text-sm rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

          {/* 顯示名稱 */}
          <div className="mb-4">
            <label className="text-xs text-on-surface-secondary mb-1 block">{t('settings.displayName')}</label>
            {editingName ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  className="flex-1 bg-surface-tertiary text-on-surface-primary rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-mist-500/50"
                  placeholder={t('settings.displayNamePlaceholder')}
                  autoFocus
                />
                <button
                  onClick={handleSaveName}
                  className="px-3 py-2 bg-mist-500 text-white rounded-lg text-sm hover:bg-mist-600 transition-colors"
                >
                  {t('common.save')}
                </button>
                <button
                  onClick={() => {
                    setTempName(userProfile.displayName);
                    setEditingName(false);
                  }}
                  className="px-3 py-2 bg-surface-tertiary text-on-surface-secondary rounded-lg text-sm hover:opacity-80 transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div
                onClick={() => setEditingName(true)}
                className="flex items-center justify-between bg-surface-tertiary rounded-lg px-3 py-2 cursor-pointer hover:opacity-80 transition-colors"
              >
                <span className="text-on-surface-primary text-sm">
                  {userProfile.displayName || t('common.noData')}
                </span>
                <svg className="w-4 h-4 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </div>
            )}
          </div>

          {/* 變更 PIN（取代原本沒用的公鑰顯示）— 對齊換機轉移樣式：圓形鑰匙圖示 + 粗體標題 + 副標 */}
          {ext.identity.changePin && (
          <button
            onClick={() => setShowChangePin(true)}
            className="w-full flex items-center justify-between p-3 bg-surface-tertiary hover:opacity-80 rounded-lg transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary-500/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4-2a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-on-surface-primary text-sm font-medium">{t('settings.changePin')}</p>
                <p className="text-on-surface-secondary text-xs">{t('settings.changePinDesc')}</p>
              </div>
            </div>
            <svg className="w-5 h-5 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          )}

          {/* 版本的擴充（官方版：協助好友恢復） */}
          {extras.accountItems}
        </div>

        {/* 外觀設定區塊 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{t('settings.appearance')}</h2>

          <div className="space-y-4">
            {/* 主題模式 */}
            <div>
              <span className="text-on-surface-primary text-sm">{t('settings.themeMode')}</span>
              <div className="flex gap-2 mt-2">
                {themeOptions.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setThemeMode(value)}
                    className={`flex-1 flex items-center justify-center py-2.5 rounded-lg text-sm transition-all ${
                      themeMode === value
                        ? 'bg-mist-500 text-white'
                        : 'bg-surface-tertiary text-on-surface-secondary hover:opacity-80'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 語言選擇 */}
            <div>
              <span className="text-on-surface-primary text-sm">{t('settings.language')}</span>
              <div className="flex gap-2 mt-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    onClick={() => setLanguage(lang)}
                    className={`flex-1 flex items-center justify-center py-2.5 rounded-lg text-sm transition-all ${
                      language === lang
                        ? 'bg-mist-500 text-white'
                        : 'bg-surface-tertiary text-on-surface-secondary hover:opacity-80'
                    }`}
                  >
                    {LANGUAGE_LABELS[lang]}
                  </button>
                ))}
              </div>
            </div>

            {/* 字體大小 */}
            <div>
              <span className="text-on-surface-primary text-sm">{t('settings.fontSize')}</span>
              <div className="flex gap-2 mt-2">
                {([
                  { value: 'normal' as FontScale, label: t('settings.fontSizeNormal') },
                  { value: 'large' as FontScale, label: t('settings.fontSizeLarge') },
                  { value: 'xlarge' as FontScale, label: t('settings.fontSizeXLarge') },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setFontScale(value)}
                    className={`flex-1 flex items-center justify-center py-2.5 rounded-lg transition-all ${
                      value === 'normal' ? 'text-sm' : value === 'large' ? 'text-base' : 'text-lg'
                    } ${
                      fontScale === value
                        ? 'bg-mist-500 text-white'
                        : 'bg-surface-tertiary text-on-surface-secondary hover:opacity-80'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 安全設定區塊 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{t('settings.security')}</h2>

          <div className="space-y-3">
            {/* 「封鎖的聯絡人」已移到官方版的守護頁總覽，與「攔截網址」並列 */}

            {/* 通知權限（僅原生 App 顯示） */}
          {isNativeApp() && <NotificationPermissionRow />}
          </div>
        </div>

        {/* 版本的擴充區塊（官方版：AegisGuard 防護、AegisPay） */}
        {extras.sections}

        {/* 伺服器（開源第 5c 步）：目前連哪台、換成自架的或改回預設；換伺服器會鎖定 App，帳號留在這台手機但屬於原伺服器 */}
        <ServerSettings signedIn />

        {/* 換機與恢復區塊 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{t('settings.transferAndRecovery')}</h2>

          <div className="space-y-3">
            {/* 換機傳輸 */}
            <button
              onClick={() => setShowDeviceTransfer(true)}
              className="w-full flex items-center justify-between p-3 bg-surface-tertiary hover:opacity-80 rounded-lg transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-500/20 flex items-center justify-center">
                  <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="text-left">
                  <p className="text-on-surface-primary text-sm font-medium">{t('settings.deviceTransfer')}</p>
                  <p className="text-on-surface-secondary text-xs">{t('settings.deviceTransferDescription')}</p>
                </div>
              </div>
              <svg className="w-5 h-5 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* 說明文字 */}
            <p className="text-xs text-on-surface-tertiary px-1">
              {t('settings.transferHelpText')}
            </p>
          </div>
        </div>

        {/* Phase 33: 聊天記錄匯出 */}
        <div className="p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-sm font-medium text-on-surface-secondary mb-3">{t('chatExport.title')}</h2>
          <div className="space-y-3">
            <button
              onClick={() => setShowChatExport(true)}
              className="w-full flex items-center justify-between p-3 bg-surface-tertiary rounded-lg hover:bg-surface-tertiary/80 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="text-left">
                  <p className="text-on-surface-primary text-sm font-medium">{t('chatExport.export')}</p>
                  <p className="text-on-surface-tertiary text-xs">{t('chatExport.description')}</p>
                </div>
              </div>
              <svg className="w-5 h-5 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* 版本資訊 */}
        <div className="p-4 text-center text-on-surface-tertiary text-xs">
          <p>AegisTalk v0.1.0</p>
          <p className="mt-1 text-on-surface-tertiary">Build 2026-01-18</p>
        </div>
      </div>

      {/* 變更 PIN Modal */}
      {showChangePin && (
        <ChangePinModal onClose={() => setShowChangePin(false)} />
      )}

      {/* 版本的擴充 Modal（官方版：協助好友恢復） */}
      {extras.modals}

      {/* Phase 33: 聊天記錄匯出 Modal */}
      {showChatExport && (
        <ChatExportModal onClose={() => setShowChatExport(false)} />
      )}

      {/* Phase 27: 換機/多設備傳輸 Modal（A 機掃描器） */}
      {showDeviceTransfer && (
        <DeviceTransferModal
          identity={identity}
          signedPreKey={signedPreKey}
          onClose={() => setShowDeviceTransfer(false)}
          onSuccess={(mode) => {
            handleDeviceTransferSuccess(mode);
          }}
        />
      )}

    </div>
  );
}

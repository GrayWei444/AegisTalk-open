import { devLog } from '../../utils/devLog';

/**
 * ProfileSettings - 個人設定面板
 *
 * 可編輯頭像（圖片上傳或 emoji）和顯示名稱
 */

import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { broadcastProfileUpdate } from '../../services/directSignal';
import { UserAvatar } from '../common';
import { useLanguage } from '../../i18n';
import { XIcon } from '../common/icons';

// 最大圖片尺寸（壓縮後）
const MAX_IMAGE_SIZE = 200; // 200x200 px
const IMAGE_QUALITY = 0.8;

interface ProfileSettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 壓縮圖片並轉為 Base64
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // 計算縮放比例
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

        // 繪製到 canvas 並壓縮
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // 轉為 Base64 (JPEG 格式，較小檔案)
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

export function ProfileSettings({ isOpen, onClose }: ProfileSettingsProps) {
  const { userProfile, setDisplayName, setAvatar, friends } = useChatStore();
  const { t } = useLanguage();
  const [name, setName] = useState(userProfile.displayName);
  const [selectedAvatar, setSelectedAvatar] = useState(userProfile.avatar || '👤');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 當 modal 開啟時，同步最新的 userProfile
  useEffect(() => {
    if (isOpen) {
      setName(userProfile.displayName);
      setSelectedAvatar(userProfile.avatar || '👤');
    }
  }, [isOpen, userProfile.displayName, userProfile.avatar]);

  if (!isOpen) return null;

  const handleSave = () => {
    const newName = name.trim() || userProfile.displayName;
    const newAvatar = selectedAvatar;

    devLog('[ProfileSettings] handleSave called');
    devLog('[ProfileSettings] newName:', newName);
    devLog('[ProfileSettings] newAvatar:', newAvatar?.slice(0, 50));
    devLog('[ProfileSettings] friends count:', friends.length);

    // 更新本地
    if (name.trim()) {
      setDisplayName(newName);
    }
    setAvatar(newAvatar);

    // 廣播給所有好友
    const friendPublicKeys = friends.map((f) => f.publicKey);
    if (friendPublicKeys.length > 0) {
      devLog('[ProfileSettings] Broadcasting profile update to', friendPublicKeys.length, 'friends');
      broadcastProfileUpdate(friendPublicKeys, {
        displayName: newName,
        avatar: newAvatar,
      });
    } else {
      devLog('[ProfileSettings] No friends to broadcast to');
    }

    onClose();
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 驗證檔案類型
    if (!file.type.startsWith('image/')) {
      alert(t('settings.selectImageFile'));
      return;
    }

    // 驗證檔案大小（最大 5MB）
    if (file.size > 5 * 1024 * 1024) {
      alert(t('settings.imageTooLargeMax'));
      return;
    }

    setIsUploading(true);
    try {
      const compressedImage = await compressImage(file);
      setSelectedAvatar(compressedImage);
    } catch (error) {
      console.error('Failed to process image:', error);
      alert(t('settings.imageProcessFailedRetry'));
    } finally {
      setIsUploading(false);
    }

    // 清除 input 以便重複選擇同一檔案
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-secondary rounded-2xl p-6 shadow-2xl border border-[var(--surface-border)] max-w-sm w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-on-surface-primary">{t('profile.title')}</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
          >
            <XIcon size={16} className="text-on-surface-tertiary" />
          </button>
        </div>

        {/* Avatar section */}
        <div className="mb-6">
          <label className="block text-sm text-on-surface-tertiary mb-3">{t('profile.avatarLabel')}</label>

          {/* Current avatar preview */}
          <div className="flex justify-center mb-4">
            <div className="relative">
              <UserAvatar avatar={selectedAvatar} name={name} size="2xl" className="border-4 border-mist-500" />
              {isUploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full">
                  <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Avatar action buttons */}
          <div className="flex gap-2 mb-4">
            {/* Upload image button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex-1 px-4 py-2 bg-mist-500 hover:bg-mist-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

        {/* Display name */}
        <div className="mb-6">
          <label className="block text-sm text-on-surface-tertiary mb-2">{t('profile.displayNameLabel')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
            className="w-full px-4 py-3 bg-surface-tertiary text-white rounded-lg outline-none focus:ring-2 focus:ring-mist-500/50 placeholder:text-on-surface-tertiary"
            maxLength={20}
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-surface-tertiary hover:bg-surface-elevated text-white rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={isUploading}
            className="flex-1 px-4 py-3 bg-mist-500 hover:bg-mist-600 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProfileSettings;

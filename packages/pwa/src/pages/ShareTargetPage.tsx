/**
 * Phase 14: Share Target 頁面
 *
 * 處理從其他 App 分享到 AegisTalk 的檔案
 * LINE 風格：直接進入全螢幕聯絡人選擇
 */

import { useState, useEffect } from 'react';
import {
  getPendingShare,
  type ShareTargetData,
} from '../services/fileShare';
import { ForwardModal } from '../components/FileShare/ForwardModal';
import { useLanguage } from '../i18n';

interface ShareTargetPageProps {
  /** 返回主頁面 */
  onBack: () => void;
  /** 分享完成後進入聊天 */
  onComplete: () => void;
}

/** Purge all share-target-data cache entries */
function cleanupShareCache(): void {
  caches.open('share-target-data').then(cache =>
    cache.keys().then(keys => { for (const k of keys) cache.delete(k); })
  ).catch(() => {});
}

export function ShareTargetPage({ onBack, onComplete }: ShareTargetPageProps) {
  const { t } = useLanguage();
  const [shareData, setShareData] = useState<ShareTargetData | null>(null);
  const [loading, setLoading] = useState(true);
  /** 錯誤訊息的翻譯 key */
  const [error, setError] = useState<string | null>(null);

  // 處理 Share Target 資料
  useEffect(() => {
    async function processShareTarget() {
      try {
        // 檢查暫存的分享資料（來自原生 SharePlugin）
        const pending = getPendingShare();
        if (pending) {
          setShareData(pending);
          setLoading(false);
          return;
        }

        // 檢查是否來自 Service Worker 的重定向
        const url = new URL(window.location.href);
        const cacheKey = url.searchParams.get('_cache');
        if (cacheKey) {
          try {
            const cache = await caches.open('share-target-data');
            const response = await cache.match(cacheKey);
            if (response) {
              const data = await response.json() as ShareTargetData;
              await cache.delete(cacheKey);
              window.history.replaceState({}, '', '/share-target');
              setShareData(data);
              setLoading(false);
              return;
            }
          } catch (cacheErr) {
            console.error('[ShareTargetPage] Cache read failed:', cacheErr);
          }
        }

        // sessionStorage（SW 的 FormData）
        const formDataJson = sessionStorage.getItem('aegis_share_target_formdata');
        if (formDataJson) {
          sessionStorage.removeItem('aegis_share_target_formdata');
          const data = JSON.parse(formDataJson) as ShareTargetData;
          setShareData(data);
          setLoading(false);
          return;
        }

        // URL 參數（GET 方式分享）
        const title = url.searchParams.get('title');
        const text = url.searchParams.get('text');
        const shareUrl = url.searchParams.get('url');
        if (title || text || shareUrl) {
          setShareData({ title: title || undefined, text: text || undefined, url: shareUrl || undefined, files: [] });
          setLoading(false);
          return;
        }

        setError('share.noShareContent');
        setLoading(false);
        cleanupShareCache();
      } catch (err) {
        console.error('[ShareTargetPage] Process failed:', err);
        setError('share.processShareError');
        setLoading(false);
        cleanupShareCache();
      }
    }

    processShareTarget();
  }, []);

  const handleCancel = () => {
    cleanupShareCache();
    onBack();
  };

  // 載入中
  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex items-center justify-center safe-area-top">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-mist-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-on-surface-secondary">{t('share.processingShare')}</p>
        </div>
      </div>
    );
  }

  // 錯誤
  if (error || !shareData) {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex items-center justify-center p-4 safe-area-top">
        <div className="bg-surface-secondary rounded-2xl p-6 max-w-sm w-full text-center">
          <h2 className="text-white text-xl font-semibold mb-2">{t('share.cannotProcessShare')}</h2>
          <p className="text-on-surface-secondary mb-6">{t(error || 'common.unknownError')}</p>
          <button
            onClick={handleCancel}
            className="w-full py-3 bg-mist-500 hover:bg-mist-600 text-white rounded-xl transition-colors"
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // 直接顯示全螢幕聯絡人選擇（LINE 風格，跳過檔案預覽）
  return (
    <ForwardModal
      files={shareData.files}
      text={shareData.text}
      url={shareData.url}
      onClose={handleCancel}
      onComplete={onComplete}
    />
  );
}

export default ShareTargetPage;

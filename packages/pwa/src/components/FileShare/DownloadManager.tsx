/**
 * Phase 14: 下載管理 UI
 *
 * 顯示下載進度和下載歷史
 */

import { useState, useEffect } from 'react';
import { downloadManager, type DownloadItem } from '../../services/downloadManager';
import { formatFileSize } from '../../services/fileShare';
import { DownloadIcon, FolderIcon, FileTypeIcon } from '../common/icons';
import { openFile } from '../../services/fileOpener';

interface DownloadManagerProps {
  /** 是否顯示 */
  isOpen: boolean;
  /** 關閉回調 */
  onClose: () => void;
}

export function DownloadManagerUI({ isOpen, onClose }: DownloadManagerProps) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active');

  // 載入下載列表
  useEffect(() => {
    function loadDownloads() {
      setDownloads(downloadManager.getAllDownloads());
    }

    loadDownloads();

    // 定期更新（用於顯示進度中的下載）
    const interval = setInterval(loadDownloads, 1000);
    return () => clearInterval(interval);
  }, []);

  const activeDownloads = downloads.filter(
    d => d.status === 'pending' || d.status === 'downloading'
  );
  const historyDownloads = downloads.filter(
    d => d.status === 'completed' || d.status === 'failed'
  );

  // 開啟已下載的檔案
  const handleOpenFile = async (download: DownloadItem) => {
    if (download.dataUrl) {
      await openFile({
        name: download.name,
        mimeType: download.mimeType,
        dataUrl: download.dataUrl,
      });
    }
  };

  // 移除下載項目
  const handleRemove = (id: string) => {
    downloadManager.removeDownload(id);
    setDownloads(downloadManager.getAllDownloads());
  };

  // 清除歷史
  const handleClearHistory = () => {
    downloadManager.clearHistory();
    setDownloads(downloadManager.getAllDownloads());
  };

  // 格式化時間
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-TW', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center">
      <div className="bg-surface-secondary w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[85vh] flex flex-col">
        {/* 標題列 */}
        <div className="px-4 py-3 border-b border-[var(--surface-border)] flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">下載管理</h2>
          <button
            onClick={onClose}
            className="p-2 text-on-surface-secondary hover:text-on-surface-primary transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 標籤列 */}
        <div className="flex border-b border-[var(--surface-border)]">
          <button
            onClick={() => setActiveTab('active')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'active'
                ? 'text-mist-400 border-b-2 border-mist-500'
                : 'text-on-surface-tertiary hover:text-on-surface-primary'
            }`}
          >
            進行中 ({activeDownloads.length})
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'history'
                ? 'text-mist-400 border-b-2 border-mist-500'
                : 'text-on-surface-tertiary hover:text-on-surface-primary'
            }`}
          >
            歷史 ({historyDownloads.length})
          </button>
        </div>

        {/* 內容區域 */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'active' ? (
            // 進行中的下載
            activeDownloads.length === 0 ? (
              <div className="py-12 text-center">
                <div className="mb-3 flex justify-center text-on-surface-tertiary"><DownloadIcon size={40} /></div>
                <p className="text-on-surface-tertiary">沒有進行中的下載</p>
              </div>
            ) : (
              <div className="divide-y divide-dark-border">
                {activeDownloads.map(download => (
                  <div key={download.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {/* 檔案圖示 */}
                      <FileTypeIcon mimeType={download.mimeType} size={24} />

                      {/* 檔案資訊 */}
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm truncate">{download.name}</p>
                        <p className="text-on-surface-tertiary text-xs">
                          {formatFileSize(download.size * download.progress / 100)} / {formatFileSize(download.size)}
                        </p>
                      </div>

                      {/* 進度 */}
                      <span className="text-mist-400 text-sm font-medium">
                        {download.progress.toFixed(0)}%
                      </span>
                    </div>

                    {/* 進度條 */}
                    <div className="mt-2 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full bg-mist-500 transition-all duration-300"
                        style={{ width: `${download.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            // 下載歷史
            <>
              {historyDownloads.length === 0 ? (
                <div className="py-12 text-center">
                  <div className="mb-3 flex justify-center text-on-surface-tertiary"><FolderIcon size={40} /></div>
                  <p className="text-on-surface-tertiary">沒有下載歷史</p>
                </div>
              ) : (
                <>
                  {/* 清除按鈕 */}
                  {historyDownloads.length > 0 && (
                    <div className="px-4 py-2 border-b border-[var(--surface-border)]">
                      <button
                        onClick={handleClearHistory}
                        className="text-on-surface-tertiary hover:text-red-400 text-sm transition-colors"
                      >
                        清除全部歷史
                      </button>
                    </div>
                  )}

                  <div className="divide-y divide-dark-border">
                    {historyDownloads.map(download => (
                      <div
                        key={download.id}
                        className="px-4 py-3 flex items-center gap-3 hover:bg-surface-elevated transition-colors"
                      >
                        {/* 檔案圖示 */}
                        <FileTypeIcon mimeType={download.mimeType} size={24} />

                        {/* 檔案資訊 */}
                        <div
                          className="flex-1 min-w-0 cursor-pointer"
                          onClick={() => download.status === 'completed' && handleOpenFile(download)}
                        >
                          <p className="text-white text-sm truncate">{download.name}</p>
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-on-surface-tertiary">
                              {formatFileSize(download.size)}
                            </span>
                            <span className="text-on-surface-tertiary">•</span>
                            <span className="text-on-surface-tertiary">
                              {download.completedAt && formatTime(download.completedAt)}
                            </span>
                            {download.status === 'failed' && (
                              <>
                                <span className="text-on-surface-tertiary">•</span>
                                <span className="text-red-400">失敗</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* 操作按鈕 */}
                        <div className="flex items-center gap-1">
                          {download.status === 'completed' && download.dataUrl && (
                            <button
                              onClick={() => handleOpenFile(download)}
                              className="p-2 text-on-surface-tertiary hover:text-mist-400 transition-colors"
                              title="開啟"
                            >
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={() => handleRemove(download.id)}
                            className="p-2 text-on-surface-tertiary hover:text-red-400 transition-colors"
                            title="移除"
                          >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default DownloadManagerUI;

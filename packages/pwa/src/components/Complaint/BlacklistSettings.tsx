/**
 * BlacklistSettings - 黑名單管理設定 (Phase 16)
 *
 * 功能：
 * - 查看本地黑名單
 * - 移除黑名單項目
 * - 同步全域黑名單
 * - 查看統計資料
 */

import { useState, useCallback } from 'react';
import { useBlacklist } from '../../hooks/useBlacklist';
import {
  getComplaintTypeName,
  getBlacklistReasonName,
  type LocalBlacklistEntry,
  type ComplaintType,
} from '../../services/localBlacklist';
import { useLanguage } from '../../i18n';
import { ShieldIcon, BanIcon, AlertTriangleIcon, MaskIcon, ShieldAlertIcon } from '../common/icons';

interface BlacklistSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  myPubkey?: string;
}


/** 投訴類型 → 線條 icon（鏡像 localBlacklist.getComplaintTypeIcon 的 emoji 對應） */
function complaintTypeIcon(type: ComplaintType) {
  switch (type) {
    case 'scam': return <ShieldAlertIcon size={18} className="text-red-400" />;
    case 'harassment': return <BanIcon size={18} className="text-orange-400" />;
    case 'impersonation': return <MaskIcon size={18} className="text-purple-400" />;
    default: return <AlertTriangleIcon size={18} className="text-amber-400" />;
  }
}

export function BlacklistSettings({ isOpen, onClose }: BlacklistSettingsProps) {
  const { t } = useLanguage();
  const { blacklist, stats, unblock } = useBlacklist();
  const [selectedEntry, setSelectedEntry] = useState<LocalBlacklistEntry | null>(null);

  // 移除黑名單項目
  const handleUnblock = useCallback((entry: LocalBlacklistEntry) => {
    const name = entry.nickname || entry.pubkey.slice(0, 16) + '...';
    if (confirm(t('blacklist.confirmUnblock').replace('{name}', name))) {
      unblock(entry.pubkey);
      setSelectedEntry(null);
    }
  }, [unblock, t]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md max-h-[90vh] flex flex-col rounded-2xl bg-surface-secondary shadow-xl mx-4">
        {/* 標題 */}
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <h2 className="text-lg font-semibold text-on-surface-primary">{t('blacklist.title')}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-on-surface-tertiary hover:bg-surface-tertiary hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 統計資訊 */}
        <div className="border-b border-[var(--surface-border)] px-4 py-3">
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-lg bg-surface-tertiary p-2">
              <p className="text-lg font-bold text-on-surface-primary">{stats.total}</p>
              <p className="text-xs text-on-surface-tertiary">{t('blacklist.total')}</p>
            </div>
            <div className="rounded-lg bg-red-900/30 p-2">
              <p className="text-lg font-bold text-red-400">{stats.byComplaint}</p>
              <p className="text-xs text-on-surface-tertiary">{t('blacklist.complaint')}</p>
            </div>
          </div>
        </div>

        {/* 黑名單列表 */}
        <div className="flex-1 overflow-y-auto p-4">
          {blacklist.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="mb-3 flex justify-center text-on-surface-tertiary"><ShieldIcon size={40} /></div>
              <p className="text-on-surface-tertiary">{t('blacklist.empty')}</p>
              <p className="mt-1 text-sm text-on-surface-tertiary">{t('blacklist.emptyHint')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {blacklist.map((entry) => (
                <div
                  key={entry.pubkeyHash}
                  className={`rounded-lg bg-surface-tertiary p-3 transition-colors ${
                    selectedEntry?.pubkeyHash === entry.pubkeyHash
                      ? 'ring-2 ring-red-500'
                      : 'hover:bg-gray-750'
                  }`}
                  onClick={() => setSelectedEntry(
                    selectedEntry?.pubkeyHash === entry.pubkeyHash ? null : entry
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      {/* 頭像 / 類型圖示 */}
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-elevated text-lg">
                        {entry.complaintType
                          ? complaintTypeIcon(entry.complaintType)
                          : <BanIcon size={18} />}
                      </div>

                      {/* 資訊 */}
                      <div>
                        <p className="font-medium text-on-surface-primary">
                          {entry.nickname || entry.pubkey.slice(0, 16) + '...'}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-on-surface-tertiary">
                          <span className={`rounded px-1.5 py-0.5 ${
                            entry.reason === 'complaint'
                              ? 'bg-red-900/50 text-red-400'
                              : 'bg-surface-elevated text-on-surface-tertiary'
                          }`}>
                            {getBlacklistReasonName(entry.reason)}
                          </span>
                          {entry.complaintType && (
                            <span>{getComplaintTypeName(entry.complaintType)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 展開詳情 */}
                  {selectedEntry?.pubkeyHash === entry.pubkeyHash && (
                    <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
                      {/* 備註 */}
                      {entry.notes && (
                        <p className="mb-2 text-sm text-on-surface-tertiary">
                          {t('blacklist.notes').replace('{notes}', entry.notes)}
                        </p>
                      )}

                      {/* 時間 */}
                      <p className="mb-3 text-xs text-on-surface-tertiary">
                        {t('blacklist.addedAt').replace('{time}', new Date(entry.addedAt).toLocaleString())}
                      </p>

                      {/* 操作按鈕 */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleUnblock(entry);
                        }}
                        className="w-full rounded-lg bg-red-600/20 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-600/30"
                      >
                        {t('blacklist.removeFromBlacklist')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

export default BlacklistSettings;

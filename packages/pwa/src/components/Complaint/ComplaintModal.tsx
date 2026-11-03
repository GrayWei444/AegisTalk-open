/**
 * ComplaintModal - 投訴彈窗 (Phase 16)
 *
 * 功能：
 * - 選擇投訴類型
 * - 輸入本地備註（不上傳）
 * - 確認封鎖
 */

import { useState, useCallback } from 'react';
import {
  type ComplaintType,
  getComplaintTypeName,
} from '../../services/localBlacklist';
import { useBlacklist } from '../../hooks/useBlacklist';
import { useLanguage } from '../../i18n';
import { ShieldIcon, ShieldAlertIcon, BanIcon, MaskIcon, AlertTriangleIcon } from '../common/icons';

interface ComplaintModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetPubkey: string;
  targetNickname?: string;
  onComplete?: () => void;
}

const COMPLAINT_TYPES: ComplaintType[] = ['scam', 'harassment', 'impersonation', 'other'];


/** 投訴類型 → 線條 icon（鏡像 localBlacklist.getComplaintTypeIcon） */
function complaintTypeIcon(type: ComplaintType) {
  switch (type) {
    case 'scam': return <ShieldAlertIcon size={24} className="text-red-400" />;
    case 'harassment': return <BanIcon size={24} className="text-orange-400" />;
    case 'impersonation': return <MaskIcon size={24} className="text-purple-400" />;
    default: return <AlertTriangleIcon size={24} className="text-amber-400" />;
  }
}

export function ComplaintModal({
  isOpen,
  onClose,
  targetPubkey,
  targetNickname,
  onComplete,
}: ComplaintModalProps) {
  const { t } = useLanguage();
  const [selectedType, setSelectedType] = useState<ComplaintType | null>(null);
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState<'select' | 'confirm' | 'done'>('select');
  const [error, setError] = useState<string | null>(null);

  const { blockByComplaint, isLoading } = useBlacklist();

  // 重置狀態
  const resetState = useCallback(() => {
    setSelectedType(null);
    setNotes('');
    setStep('select');
    setError(null);
  }, []);

  // 關閉彈窗
  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  // 選擇類型後進入確認
  const handleTypeSelect = useCallback((type: ComplaintType) => {
    setSelectedType(type);
    setStep('confirm');
  }, []);

  // 返回選擇類型
  const handleBack = useCallback(() => {
    setStep('select');
    setError(null);
  }, []);

  // 提交投訴
  const handleSubmit = useCallback(async () => {
    if (!selectedType) return;

    setError(null);

    try {
      await blockByComplaint({
        pubkey: targetPubkey,
        nickname: targetNickname,
        type: selectedType,
        notes: notes.trim() || undefined,
      });

      setStep('done');
      onComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('complaint.submitFailed'));
    }
  }, [selectedType, targetPubkey, targetNickname, notes, blockByComplaint, onComplete, t]);

  if (!isOpen) return null;

  const complaintTypeDescriptions: Record<ComplaintType, string> = {
    scam: t('complaint.scamDescription'),
    harassment: t('complaint.harassmentDescription'),
    impersonation: t('complaint.impersonationDescription'),
    other: t('complaint.otherDescription'),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface-secondary shadow-xl">
        {/* 標題 */}
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <h2 className="text-lg font-semibold text-on-surface-primary">
            {step === 'select' && t('complaint.reportUser')}
            {step === 'confirm' && t('complaint.confirmReport')}
            {step === 'done' && t('complaint.reportComplete')}
          </h2>
          <button
            onClick={handleClose}
            className="rounded-full p-1 text-on-surface-tertiary hover:bg-surface-tertiary hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 內容 */}
        <div className="p-4">
          {/* 目標用戶資訊 */}
          {step !== 'done' && (
            <div className="mb-4 flex items-center gap-3 rounded-lg bg-surface-tertiary p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-elevated text-lg">
                {targetNickname?.[0] || '?'}
              </div>
              <div>
                <p className="font-medium text-on-surface-primary">{targetNickname || t('complaint.unknownUser')}</p>
                <p className="text-xs text-on-surface-tertiary">{targetPubkey.slice(0, 16)}...</p>
              </div>
            </div>
          )}

          {/* 步驟一：選擇類型 */}
          {step === 'select' && (
            <div className="space-y-2">
              <p className="mb-3 text-sm text-on-surface-secondary">{t('complaint.selectReason')}</p>
              {COMPLAINT_TYPES.map((type) => (
                <button
                  key={type}
                  onClick={() => handleTypeSelect(type)}
                  className="flex w-full items-center gap-3 rounded-lg bg-surface-tertiary p-3 text-left transition-colors hover:opacity-80"
                >
                  <span className="flex justify-center">{complaintTypeIcon(type)}</span>
                  <div>
                    <p className="font-medium text-on-surface-primary">{getComplaintTypeName(type)}</p>
                    <p className="text-xs text-on-surface-tertiary">
                      {complaintTypeDescriptions[type]}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* 步驟二：確認 */}
          {step === 'confirm' && selectedType && (
            <div className="space-y-4">
              {/* 選中的類型 */}
              <div className="flex items-center gap-2 rounded-lg bg-red-900/30 p-3">
                <span className="text-2xl">{complaintTypeIcon(selectedType)}</span>
                <div>
                  <p className="font-medium text-red-400">
                    {t('complaint.reportReason').replace('{reason}', getComplaintTypeName(selectedType))}
                  </p>
                </div>
              </div>

              {/* 備註輸入 */}
              <div>
                <label className="mb-1 block text-sm text-on-surface-secondary">
                  {t('complaint.notesLabel')}
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('complaint.notesPlaceholder')}
                  maxLength={200}
                  className="h-20 w-full resize-none rounded-lg input-base px-3 py-2 text-sm"
                />
                <p className="mt-1 text-right text-xs text-on-surface-tertiary">{notes.length}/200</p>
              </div>

              {/* 隱私提示 */}
              <div className="rounded-lg bg-surface-tertiary p-3">
                <p className="text-xs text-on-surface-secondary">
                  <span className="text-green-400">{t('complaint.privacyProtection')}</span>
                  {t('complaint.privacyDescription')}
                </p>
              </div>

              {/* 錯誤訊息 */}
              {error && (
                <div className="rounded-lg bg-red-900/50 p-3 text-sm text-red-400">{error}</div>
              )}

              {/* 按鈕 */}
              <div className="flex gap-3">
                <button
                  onClick={handleBack}
                  disabled={isLoading}
                  className="flex-1 rounded-lg bg-surface-tertiary py-2.5 font-medium text-on-surface-primary transition-colors hover:opacity-80 disabled:opacity-50"
                >
                  {t('common.back')}
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isLoading}
                  className="flex-1 rounded-lg bg-red-600 py-2.5 font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                >
                  {isLoading ? t('common.processing') : t('complaint.confirmReport')}
                </button>
              </div>
            </div>
          )}

          {/* 步驟三：完成 */}
          {step === 'done' && (
            <div className="space-y-4 text-center">
              <div className="flex justify-center text-emerald-400"><ShieldIcon size={48} /></div>
              <div>
                <p className="text-lg font-medium text-on-surface-primary">{t('complaint.reportSubmitted')}</p>
                <p className="mt-1 text-sm text-on-surface-secondary">
                  {t('complaint.reportSubmittedDescription')}
                </p>
              </div>
              <button
                onClick={handleClose}
                className="w-full rounded-lg bg-surface-tertiary py-2.5 font-medium text-on-surface-primary transition-colors hover:opacity-80"
              >
                {t('common.done')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ComplaintModal;

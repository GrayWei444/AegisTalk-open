/**
 * ChatExportModal — Phase 33 聊天記錄匯出
 *
 * 步驟：選擇對話 → PIN 確認 → 匯出進度 → 下載
 */

import { useState, useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useGroupStore } from '../../stores/groupStore';
import { useCrypto } from '../../hooks/useCrypto';
import { useLanguage } from '../../i18n';
import { ext } from '@ext';
import type { ExportOptions } from '../../services/chatExport';

type Step = 'select' | 'pin' | 'exporting' | 'done' | 'error';

interface Props {
  onClose: () => void;
}

export function ChatExportModal({ onClose }: Props) {
  const { t } = useLanguage();
  const { identity, publicKeyBase64 } = useCrypto();
  const friends = useChatStore(s => s.friends);
  const groups = useGroupStore(s => s.groups);

  const [step, setStep] = useState<Step>('select');
  const [selectedType, setSelectedType] = useState<'1-1' | 'group'>('1-1');
  const [selectedId, setSelectedId] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [exportedCount, setExportedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  // 建立 nameMap: publicKey → displayName
  const nameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of friends) {
      map[f.publicKey] = f.name || f.publicKey.slice(0, 8);
    }
    for (const g of groups) {
      for (const m of g.members) {
        if (!map[m.publicKey]) {
          map[m.publicKey] = m.nickname || m.publicKey.slice(0, 8);
        }
      }
    }
    if (publicKeyBase64) {
      map[publicKeyBase64] = t('chatExport.me');
    }
    return map;
  }, [friends, groups, publicKeyBase64, t]);

  const handleSelectConversation = (type: '1-1' | 'group', id: string, name: string) => {
    setSelectedType(type);
    setSelectedId(id);
    setSelectedName(name);
  };

  const handleProceedToPin = () => {
    if (!selectedId) return;
    setStep('pin');
    setPin('');
    setPinError('');
  };

  const handlePinSubmit = async () => {
    if (pin.length < 4) return;
    const valid = await ext.identity.verifyPin(pin);
    if (!valid) {
      setPinError(t('chatExport.wrongPin'));
      setPin('');
      return;
    }
    startExport();
  };

  const startExport = async () => {
    if (!identity) return;
    setStep('exporting');
    setProgress({ current: 0, total: 0 });

    try {
      const { exportChatEvidence, downloadEvidence } = await import('../../services/chatExport');

      const opts: ExportOptions = {
        conversationType: selectedType,
        conversationId: selectedId,
        displayName: selectedName,
        nameMap,
        dateFrom: dateFrom ? new Date(dateFrom).getTime() : undefined,
        dateTo: dateTo ? new Date(dateTo + 'T23:59:59').getTime() : undefined,
      };

      const pkg = await exportChatEvidence(identity, opts, (current, total) => {
        setProgress({ current, total });
      });

      downloadEvidence(pkg);
      setExportedCount(pkg.messageCount);
      setStep('done');
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      if (msg === 'NO_MESSAGES') {
        setErrorMsg(t('chatExport.noMessages'));
      } else {
        setErrorMsg(msg);
      }
      setStep('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-surface-secondary rounded-xl shadow-xl overflow-hidden max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--surface-border)]">
          <h2 className="text-lg font-semibold text-on-surface-primary">{t('chatExport.title')}</h2>
          <button onClick={onClose} className="text-on-surface-tertiary hover:text-on-surface-primary p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          {/* Step 1: Select conversation */}
          {step === 'select' && (
            <div className="space-y-4">
              <p className="text-sm text-on-surface-secondary">{t('chatExport.selectConversation')}</p>

              {/* 無對話 — 顯示提示而非死灰按鈕 */}
              {friends.length === 0 && groups.length === 0 && (
                <div className="py-8 text-center">
                  <p className="text-sm text-on-surface-tertiary">{t('chatExport.noConversations')}</p>
                </div>
              )}

              {/* Friends */}
              {friends.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-on-surface-tertiary mb-2">{t('chatExport.friends')}</h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {friends.map(f => (
                      <button
                        key={f.publicKey}
                        onClick={() => handleSelectConversation('1-1', f.publicKey, f.name || f.publicKey.slice(0, 8))}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          selectedType === '1-1' && selectedId === f.publicKey
                            ? 'bg-primary/20 text-primary'
                            : 'text-on-surface-primary hover:bg-surface-tertiary'
                        }`}
                      >
                        {f.name || f.publicKey.slice(0, 8)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Groups */}
              {groups.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-on-surface-tertiary mb-2">{t('chatExport.groups')}</h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {groups.map(g => (
                      <button
                        key={g.id}
                        onClick={() => handleSelectConversation('group', g.id, g.name)}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          selectedType === 'group' && selectedId === g.id
                            ? 'bg-primary/20 text-primary'
                            : 'text-on-surface-primary hover:bg-surface-tertiary'
                        }`}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Date range */}
              <div>
                <h3 className="text-xs font-medium text-on-surface-tertiary mb-2">{t('chatExport.dateRange')}</h3>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={e => setDateFrom(e.target.value)}
                    className="flex-1 px-2 py-1.5 text-sm rounded bg-surface-tertiary text-on-surface-primary border border-[var(--surface-border)]"
                    placeholder={t('chatExport.from')}
                  />
                  <input
                    type="date"
                    value={dateTo}
                    onChange={e => setDateTo(e.target.value)}
                    className="flex-1 px-2 py-1.5 text-sm rounded bg-surface-tertiary text-on-surface-primary border border-[var(--surface-border)]"
                    placeholder={t('chatExport.to')}
                  />
                </div>
                <p className="text-xs text-on-surface-tertiary mt-1">{t('chatExport.dateRangeHint')}</p>
              </div>

              {/* Proceed button */}
              <button
                onClick={handleProceedToPin}
                disabled={!selectedId}
                className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  selectedId
                    ? 'bg-primary text-white hover:bg-primary/90'
                    : 'bg-gray-500/30 text-gray-500 cursor-not-allowed'
                }`}
              >
                {t('chatExport.next')}
              </button>

              <p className="text-xs text-on-surface-tertiary text-center">{t('chatExport.localOnly')}</p>
            </div>
          )}

          {/* Step 2: PIN confirmation */}
          {step === 'pin' && (
            <div className="space-y-4">
              <p className="text-sm text-on-surface-secondary">{t('chatExport.pinConfirm')}</p>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={pin}
                onChange={e => {
                  setPin(e.target.value.replace(/\D/g, ''));
                  setPinError('');
                }}
                onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
                className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] rounded-lg bg-surface-tertiary text-on-surface-primary border border-[var(--surface-border)] focus:border-primary focus:outline-none"
                autoFocus
                placeholder="****"
              />
              {pinError && <p className="text-sm text-red-400 text-center">{pinError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => setStep('select')}
                  className="flex-1 py-2.5 rounded-lg text-sm bg-surface-tertiary text-on-surface-primary hover:bg-surface-tertiary/80"
                >
                  {t('chatExport.back')}
                </button>
                <button
                  onClick={handlePinSubmit}
                  disabled={pin.length < 4}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-medium ${
                    pin.length >= 4
                      ? 'bg-primary text-white hover:bg-primary/90'
                      : 'bg-gray-500/30 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  {t('chatExport.export')}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Exporting */}
          {step === 'exporting' && (
            <div className="space-y-4 text-center py-6">
              <div className="animate-spin w-10 h-10 border-4 border-primary border-t-transparent rounded-full mx-auto" />
              <p className="text-sm text-on-surface-primary">{t('chatExport.exporting')}</p>
              {progress.total > 0 && (
                <p className="text-xs text-on-surface-tertiary">
                  {progress.current} / {progress.total}
                </p>
              )}
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <div className="space-y-4 text-center py-6">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-on-surface-primary">{t('chatExport.exportSuccess')}</p>
              <p className="text-xs text-on-surface-tertiary">
                {t('chatExport.exportedMessages', { count: String(exportedCount) })}
              </p>
              <p className="text-xs text-on-surface-tertiary">{t('chatExport.verifyHint')}</p>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90"
              >
                {t('chatExport.close')}
              </button>
            </div>
          )}

          {/* Error */}
          {step === 'error' && (
            <div className="space-y-4 text-center py-6">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="text-sm text-red-400">{errorMsg}</p>
              <button
                onClick={() => setStep('select')}
                className="w-full py-2.5 rounded-lg text-sm font-medium bg-surface-tertiary text-on-surface-primary hover:bg-surface-tertiary/80"
              >
                {t('chatExport.back')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

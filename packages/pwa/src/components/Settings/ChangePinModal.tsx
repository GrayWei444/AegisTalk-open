/**
 * 變更 PIN 彈窗 — 三步:輸入舊 PIN → 新 PIN → 確認新 PIN
 * 完成後呼叫版本的換 PIN（ext.identity.changePin）連動重加密本機金鑰與該版本的備份。
 */
import { useState, useCallback } from 'react';
import { PinKeypad } from '../SocialRecovery/PinKeypad';
import { ext } from '@ext';
import type { ChangePinResult } from '../../ext/types';
import { useLanguage } from '../../i18n';

/** 版本的變更 PIN（SettingsPage 只在 ext.identity.changePin 存在時才開這個彈窗） */
function pinChange() {
  const change = ext.identity.changePin;
  if (!change) throw new Error('change_pin_unavailable');
  return change;
}

type Step = 'old' | 'new' | 'confirm' | 'saving' | 'pending' | 'done';

interface ChangePinModalProps {
  onClose: () => void;
}

export function ChangePinModal({ onClose }: ChangePinModalProps) {
  const { t } = useLanguage();
  const [step, setStep] = useState<Step>('old');
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState('');
  const [resetTrigger, setResetTrigger] = useState(0);

  const resetKeypad = useCallback(() => setResetTrigger((n) => n + 1), []);

  const errCodeToMsg = useCallback((code: ChangePinResult['code']): string => {
    switch (code) {
      case 'pending': return t('settings.changePinPending');
      case 'old_wrong': return t('settings.changePinErrOldWrong');
      case 'same_as_old': return t('settings.changePinErrSameAsOld');
      default: return t('settings.changePinErrGeneric');
    }
  }, [t]);

  const handleComplete = useCallback(async (pin: string) => {
    setError('');
    if (step === 'old') {
      setOldPin(pin);
      setStep('new');
      resetKeypad();
      return;
    }
    if (step === 'new') {
      if (pin === oldPin) {
        setError(t('settings.changePinErrSameAsOld'));
        resetKeypad();
        return;
      }
      setNewPin(pin);
      setStep('confirm');
      resetKeypad();
      return;
    }
    if (step === 'confirm') {
      if (pin !== newPin) {
        setError(t('settings.changePinErrMismatch'));
        setStep('new');
        setNewPin('');
        resetKeypad();
        return;
      }
      setStep('saving');
      const r = await pinChange().change(oldPin, newPin);
      if (r.ok) {
        setStep('done');
      } else if (r.code === 'pending') {
        setError(errCodeToMsg(r.code));
        setStep('pending');
      } else {
        setError(errCodeToMsg(r.code));
        setOldPin('');
        setNewPin('');
        setStep('old');
        resetKeypad();
      }
    }
  }, [step, oldPin, newPin, resetKeypad, t, errCodeToMsg]);

  const title =
    step === 'old' ? t('settings.changePinOld')
    : step === 'new' ? t('settings.changePinNew')
    : step === 'confirm' ? t('settings.changePinConfirm')
    : step === 'saving' ? t('settings.changePinSaving')
    : t('settings.changePinDone');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-surface-primary rounded-2xl w-full max-w-sm p-6 safe-area-top">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-on-surface-primary">{t('settings.changePin')}</h2>
          {step !== 'saving' && (
            <button onClick={onClose} className="text-on-surface-tertiary text-sm">{t('common.close')}</button>
          )}
        </div>

        {step === 'pending' ? (
          <div className="space-y-4 text-sm">
            <p role="status">{t('settings.changePinPending')}</p>
            <button className="w-full rounded-xl bg-mist-500 p-3 text-white" onClick={async () => {
              setStep('saving');
              try {
                const effectivePin = await pinChange().resume(oldPin || newPin);
                const result = await pinChange().change(effectivePin, effectivePin);
                setStep(result.ok ? 'done' : 'pending');
              } catch { setStep('pending'); }
            }}>{t('common.retry')}</button>
          </div>
        ) : step === 'done' ? (
          <div className="flex flex-col items-center text-center py-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-on-surface-primary font-medium mb-1">{t('settings.changePinDone')}</p>
            <p className="text-on-surface-tertiary text-sm mb-6">{t('settings.changePinDoneNote')}</p>
            <button
              onClick={onClose}
              className="w-full py-3 bg-mist-500 hover:bg-mist-600 text-white rounded-xl font-medium"
            >
              {t('common.done')}
            </button>
          </div>
        ) : (
          <>
            <p className="text-center text-sm text-on-surface-secondary mb-1">{title}</p>
            <p className="text-center text-xs text-on-surface-tertiary mb-4">{t('settings.changePinNote')}</p>
            {step === 'saving' ? (
              <div className="flex justify-center py-10">
                <div className="w-8 h-8 border-2 border-mist-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <PinKeypad
                length={6}
                onComplete={handleComplete}
                error={error}
                resetTrigger={resetTrigger}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

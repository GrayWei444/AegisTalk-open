/**
 * Phase 27: DeviceTransferScanner — B 機 QR 顯示器
 *
 * 反轉方向：B 機（新設備）顯示 QR Code，等待 A 機掃描+傳送資料
 * B 機零輸入 → 瞬間登入
 *
 * 名稱保持 "Scanner" 以維持向後相容（App.tsx 引用此元件名）
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNewDeviceDisplay } from '../../hooks/useDeviceTransfer';
import { useLanguage } from '../../i18n';
import type { TransferData } from '../../services/deviceTransfer';

interface DeviceTransferScannerProps {
  onSuccess: (data: TransferData) => void;
  onCancel: () => void;
}

export function DeviceTransferScanner({
  onSuccess,
  onCancel,
}: DeviceTransferScannerProps) {
  const { t } = useLanguage();
  const display = useNewDeviceDisplay();
  const [countdown, setCountdown] = useState<number>(0);
  const startedRef = useRef(false);

  // 自動開始顯示 QR
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      display.startDisplay();
    }
  }, [display.startDisplay]);

  // 倒數計時
  useEffect(() => {
    if (!display.expiresAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((display.expiresAt! - Date.now()) / 1000));
      setCountdown(remaining);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [display.expiresAt]);

  // 成功時通知父元件
  useEffect(() => {
    if (display.isSuccess && display.transferData) {
      const timer = setTimeout(() => {
        onSuccess(display.transferData!);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [display.isSuccess, display.transferData, onSuccess]);

  const handleCancel = useCallback(() => {
    display.cancel();
    onCancel();
  }, [display, onCancel]);

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const renderContent = () => {
    // 產生中
    if (display.status === 'generating') {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
          <h3 className="text-lg font-semibold text-on-surface-primary">
            {t('deviceTransfer.generating')}
          </h3>
        </div>
      );
    }

    // 等待 A 機掃描
    if (display.isWaiting && display.qrCode) {
      return (
        <div className="flex flex-col items-center gap-6">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.showQRToOldDevice')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.showQRDescription')}
            </p>
          </div>

          {/* QR Code */}
          <div className="bg-white p-4 rounded-2xl">
            <img
              src={display.qrCode}
              alt={t('deviceTransfer.qrAlt')}
              className="w-64 h-64"
            />
          </div>

          {/* 倒數計時 */}
          <div className={`text-sm ${countdown <= 60 ? 'text-red-400' : 'text-on-surface-tertiary'}`}>
            {countdown > 0
              ? `${t('deviceTransfer.expiresIn')} ${formatTime(countdown)}`
              : t('deviceTransfer.expired')
            }
          </div>

          {/* 過期重新產生 */}
          {countdown <= 0 && (
            <button
              onClick={display.regenerate}
              className="px-6 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
            >
              {t('deviceTransfer.regenerate')}
            </button>
          )}

          {/* 提示 */}
          <div className="bg-surface-tertiary rounded-lg px-4 py-3 text-sm text-on-surface-tertiary">
            {t('deviceTransfer.ensureNetwork')}
          </div>
        </div>
      );
    }

    // 正在接收
    if (display.isReceiving) {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.receiving')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.pleaseWait')}
            </p>
          </div>
        </div>
      );
    }

    // 成功
    if (display.isSuccess) {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-10 h-10 text-green-400" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.success')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.settingUpAccount')}
            </p>
          </div>
        </div>
      );
    }

    // 錯誤
    if (display.isError) {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.failed')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {display.error || t('deviceTransfer.unknownError')}
            </p>
          </div>
          <button
            onClick={display.regenerate}
            className="px-6 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
          >
            {t('deviceTransfer.retry')}
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="min-h-[100dvh] bg-surface-primary flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--surface-border)]">
        <button
          onClick={handleCancel}
          className="p-2 -ml-2 hover:bg-surface-tertiary rounded-full transition-colors"
          disabled={display.isReceiving}
        >
          <svg className="w-5 h-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold text-on-surface-primary">
          {t('deviceTransfer.newDeviceSetup')}
        </h1>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">{renderContent()}</div>
      </div>
    </div>
  );
}

export default DeviceTransferScanner;

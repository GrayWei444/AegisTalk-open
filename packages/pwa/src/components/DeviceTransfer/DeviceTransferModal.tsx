/**
 * Phase 27: DeviceTransferModal — A 機掃描器 + 模式選擇
 *
 * 反轉方向：A 機（舊設備）掃描 B 機 QR → 選擇模式 → 傳送資料
 *
 * 流程：
 * 1. 打開相機掃描 B 機 QR
 * 2. 掃描成功 → 選擇「換機」(A 登出) or「多設備」(A 保留)
 * 3. 確認後加密傳送 TransferData
 * 4. 成功 → 換機模式登出 / 多設備模式關閉
 *
 * 選好模式之後先輸入 PIN（安全審查 M2）：換機會把整個帳號送到掃到的那支手機 —— 手機解鎖著、落在別人手上也不能就這樣送走。
 * ext.identity.verifyPin 會累計錯誤次數、錯 5 次鎖 5 分鐘（跟登入畫面同一個鎖）。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ext } from '@ext';
import { useOldDeviceScanner } from '../../hooks/useDeviceTransfer';
import { useLanguage } from '../../i18n';
import { Identity, SignedPreKey } from '../../services/crypto';
import type { TransferMode } from '../../services/deviceTransfer';

/** The transfer starts only after the PIN was checked. */
export async function confirmTransferWithPin(
  pin: string,
  mode: TransferMode,
  deps: { verifyPin: (pin: string) => Promise<boolean>; confirmTransfer: (mode: TransferMode) => unknown },
): Promise<boolean> {
  if (!(await deps.verifyPin(pin))) return false;
  await deps.confirmTransfer(mode);
  return true;
}

interface DeviceTransferModalProps {
  identity: Identity | null;
  signedPreKey?: SignedPreKey | null;
  onClose: () => void;
  onSuccess: (mode: TransferMode) => void;
}

export function DeviceTransferModal({
  identity,
  signedPreKey,
  onClose,
  onSuccess,
}: DeviceTransferModalProps) {
  const { t } = useLanguage();
  const scanner = useOldDeviceScanner(identity, signedPreKey);
  const [hasCamera, setHasCamera] = useState<boolean | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannerAnimRef = useRef<number>(0);
  const scannerStatusRef = useRef(scanner.status);
  scannerStatusRef.current = scanner.status;
  // 選好的模式，等 PIN 驗過才真的送（安全審查 M2）
  const [pendingMode, setPendingMode] = useState<TransferMode | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const submitPin = useCallback(async () => {
    if (!pendingMode || pin.length < 4 || pinBusy) return;
    setPinBusy(true);
    try {
      const ok = await confirmTransferWithPin(pin, pendingMode, {
        verifyPin: (p) => ext.identity.verifyPin(p),
        confirmTransfer: scanner.confirmTransfer,
      });
      if (!ok) setPinError(t('chatExport.wrongPin'));
    } finally {
      setPin('');
      setPinBusy(false);
    }
  }, [pendingMode, pin, pinBusy, scanner.confirmTransfer, t]);

  // 成功時通知父元件
  useEffect(() => {
    if (scanner.isSuccess && scanner.transferMode) {
      const timer = setTimeout(() => {
        onSuccess(scanner.transferMode!);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [scanner.isSuccess, scanner.transferMode, onSuccess]);

  // =========================================================================
  // Camera
  // =========================================================================

  const stopCamera = useCallback(() => {
    if (scannerAnimRef.current) {
      cancelAnimationFrame(scannerAnimRef.current);
      scannerAnimRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (envErr) {
        // 後鏡頭不可用（如 Samsung 摺疊機收合狀態列舉不到 environment）
        // → fallback 任何可用鏡頭，掃 QR 用前鏡頭也行
        console.warn('[DeviceTransfer] environment camera unavailable, fallback to any camera:', envErr);
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      streamRef.current = stream;
      setHasCamera(true);
      setCameraError(null);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        const jsQR = (await import('jsqr')).default;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const scan = () => {
          if (!videoRef.current || !ctx) return;
          // 只在 idle 或 scanning 時持續掃描
          if (scannerStatusRef.current !== 'idle' && scannerStatusRef.current !== 'scanning') return;

          const video = videoRef.current;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height);

            if (code) {
              handleQRCode(code.data);
              return;
            }
          }

          scannerAnimRef.current = requestAnimationFrame(scan);
        };

        scannerAnimRef.current = requestAnimationFrame(scan);
      }
    } catch (err) {
      setHasCamera(false);
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          setCameraError(t('deviceTransfer.cameraPermissionDenied'));
        } else if (err.name === 'NotFoundError') {
          setCameraError(t('deviceTransfer.cameraNotFound'));
        } else {
          setCameraError(t('deviceTransfer.cameraError'));
        }
      }
    }
  }, []);

  const handleQRCode = async (data: string) => {
    stopCamera();
    await scanner.handleQRScan(data);
  };

  const handleManualSubmit = async () => {
    if (!inputValue.trim()) return;
    await scanner.handleQRScan(inputValue.trim());
  };

  // 初始化相機
  useEffect(() => {
    if (!manualInput && scanner.status === 'idle') {
      startCamera();
    }
    return () => stopCamera();
  }, [manualInput, scanner.status, startCamera, stopCamera]);

  const handleClose = () => {
    stopCamera();
    scanner.cancel();
    onClose();
  };

  // =========================================================================
  // Render
  // =========================================================================

  const renderContent = () => {
    // 驗證中
    if (scanner.isVerifying) {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
          <h3 className="text-lg font-semibold text-on-surface-primary">
            {t('deviceTransfer.verifyingQR')}
          </h3>
        </div>
      );
    }

    // 選好模式 → PIN
    if (scanner.isChooseMode && pendingMode) {
      return (
        <div className="flex flex-col gap-4">
          <h3 className="text-lg font-semibold text-on-surface-primary text-center">{t('auth.enterPin')}</h3>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={8}
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setPinError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitPin(); }}
            data-testid="transfer-pin"
            className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] rounded-lg bg-surface-tertiary text-on-surface-primary border border-[var(--surface-border)] focus:outline-none"
          />
          {pinError && <p className="text-sm text-red-400 text-center" role="alert">{pinError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { setPendingMode(null); setPin(''); setPinError(''); }}
              className="flex-1 py-2.5 rounded-lg text-sm bg-surface-tertiary text-on-surface-primary"
            >
              {t('chatExport.back')}
            </button>
            <button
              onClick={() => void submitPin()}
              disabled={pin.length < 4 || pinBusy}
              className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-primary-500 text-white disabled:opacity-50"
            >
              {t('common.confirm')}
            </button>
          </div>
        </div>
      );
    }

    // 選擇模式
    if (scanner.isChooseMode) {
      return (
        <div className="flex flex-col gap-6">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.chooseMode')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.chooseModeDescription')}
            </p>
          </div>

          {/* 換機模式 */}
          <button
            onClick={() => setPendingMode('transfer')}
            className="w-full p-4 bg-surface-elevated hover:bg-surface-tertiary rounded-xl text-left transition-colors border border-[var(--surface-border)]"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <div>
                <div className="text-on-surface-primary font-medium">
                  {t('deviceTransfer.modeTransfer')}
                </div>
                <div className="text-on-surface-tertiary text-xs mt-0.5">
                  {t('deviceTransfer.modeTransferDesc')}
                </div>
              </div>
            </div>
          </button>

          {/* 多設備模式 */}
          <button
            onClick={() => setPendingMode('multi-device')}
            className="w-full p-4 bg-surface-elevated hover:bg-surface-tertiary rounded-xl text-left transition-colors border border-[var(--surface-border)]"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <div className="text-on-surface-primary font-medium">
                  {t('deviceTransfer.modeMultiDevice')}
                </div>
                <div className="text-on-surface-tertiary text-xs mt-0.5">
                  {t('deviceTransfer.modeMultiDeviceDesc')}
                </div>
              </div>
            </div>
          </button>
        </div>
      );
    }

    // 傳輸中
    if (scanner.isTransferring) {
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.transferring')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.transferringDesc')}
            </p>
          </div>
        </div>
      );
    }

    // 成功
    if (scanner.isSuccess) {
      const isTransfer = scanner.transferMode === 'transfer';
      return (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-10 h-10 text-green-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.success')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {isTransfer
                ? t('deviceTransfer.successTransferDesc')
                : t('deviceTransfer.successMultiDeviceDesc')
              }
            </p>
          </div>
        </div>
      );
    }

    // 錯誤
    if (scanner.isError) {
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
              {scanner.error || t('deviceTransfer.unknownError')}
            </p>
          </div>
          <button
            onClick={() => {
              scanner.cancel();
              if (!manualInput) startCamera();
            }}
            className="px-6 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
          >
            {t('deviceTransfer.retry')}
          </button>
        </div>
      );
    }

    // 手動輸入
    if (manualInput) {
      return (
        <div className="flex flex-col gap-6">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
              {t('deviceTransfer.manualInput')}
            </h3>
            <p className="text-on-surface-tertiary text-sm">
              {t('deviceTransfer.manualInputDesc')}
            </p>
          </div>

          <textarea
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder={t('deviceTransfer.pasteCode')}
            className="w-full h-32 bg-surface-elevated text-white rounded-lg px-4 py-3 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
          />

          <div className="flex gap-3">
            <button
              onClick={() => setManualInput(false)}
              className="flex-1 px-4 py-2 bg-surface-elevated hover:bg-surface-tertiary text-on-surface-secondary rounded-lg transition-colors"
            >
              {t('deviceTransfer.useCamera')}
            </button>
            <button
              onClick={handleManualSubmit}
              disabled={!inputValue.trim()}
              className="flex-1 px-4 py-2 bg-primary-500 hover:bg-primary-600 disabled:bg-surface-elevated disabled:text-on-surface-tertiary text-white rounded-lg transition-colors"
            >
              {t('deviceTransfer.confirm')}
            </button>
          </div>
        </div>
      );
    }

    // 相機掃描模式
    return (
      <div className="flex flex-col gap-6">
        <div className="text-center">
          <h3 className="text-lg font-semibold text-on-surface-primary mb-2">
            {t('deviceTransfer.scanNewDeviceQR')}
          </h3>
          <p className="text-on-surface-tertiary text-sm">
            {t('deviceTransfer.scanNewDeviceQRDesc')}
          </p>
        </div>

        {/* 相機預覽 */}
        <div className="relative aspect-square bg-surface-elevated rounded-2xl overflow-hidden">
          {/* video 永遠 render — videoRef.current 從第一次 render 就有值。
              若靠 hasCamera 條件 render，startCamera 在 setHasCamera(true) 後
              同步讀 videoRef.current 會是 null（re-render 還沒發生）→ stream 接不上 → 黑畫面。 */}
          <video
            ref={videoRef}
            className={`absolute inset-0 w-full h-full object-cover ${hasCamera === true ? '' : 'opacity-0'}`}
            playsInline
            muted
          />
          {hasCamera === false ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-surface-elevated">
              <svg className="w-16 h-16 text-on-surface-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <p className="text-on-surface-tertiary text-sm text-center">{cameraError}</p>
              <button
                onClick={() => setManualInput(true)}
                className="mt-4 px-4 py-2 bg-surface-tertiary hover:bg-surface-elevated text-white rounded-lg text-sm transition-colors"
              >
                {t('deviceTransfer.manualInput')}
              </button>
            </div>
          ) : hasCamera === null ? (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-elevated">
              <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-48 h-48 border-2 border-primary-500 rounded-xl relative">
                <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-primary-500 rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-primary-500 rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-primary-500 rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-primary-500 rounded-br-lg" />
              </div>
            </div>
          )}
        </div>

        {hasCamera && (
          <button
            onClick={() => setManualInput(true)}
            className="text-sm text-on-surface-tertiary hover:text-on-surface-primary transition-colors"
          >
            {t('deviceTransfer.cannotScan')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface-tertiary rounded-2xl w-full max-w-md overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--surface-border)]">
          <h2 className="text-lg font-semibold text-on-surface-primary">
            {t('deviceTransfer.sendToNewDevice')}
          </h2>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-surface-elevated rounded-full transition-colors"
            disabled={scanner.isTransferring}
          >
            <svg className="w-5 h-5 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">{renderContent()}</div>
      </div>
    </div>
  );
}

export default DeviceTransferModal;

/**
 * Phase 27: Device Transfer Hooks
 *
 * 反轉方向：
 *   useNewDeviceDisplay() — B 機顯示 QR Code，等待 A 機傳送資料
 *   useOldDeviceScanner() — A 機掃描 QR → 驗證 → 選模式 → 傳送資料
 *
 * （Phase 8 舊版 hooks 拿掉了：那條路要新機自編身分去發 MQTT，現在新機只有 receive-only 的臨時 token）
 */

import { useState, useCallback, useRef } from 'react';
import {
  generateNewDeviceQR,
  verifyNewDeviceQR,
  parseTransferQR,
  NewDeviceDisplay,
  OldDeviceScanner,
  type DeviceTransferQR,
  type TransferData,
  type TransferMode,
} from '../services/deviceTransfer';
import { Identity, SignedPreKey, toBase64 } from '../services/crypto';
import { mqttService } from '../services/mqtt';
import { useChatStore } from '../stores/chatStore';
import { useGroupStore } from '../stores/groupStore';
import { getGroupEngine } from '../services/groupEngineHost';
import { devLog, devWarn } from '../utils/devLog';
import { tr } from '../i18n/tr';
import { ext } from '@ext';

// ============================================================================
// Types
// ============================================================================

/** B 機（新設備）QR 顯示狀態 */
export type NewDeviceDisplayStatus =
  | 'idle'
  | 'generating'
  | 'waiting'
  | 'receiving'
  | 'success'
  | 'error';

/** A 機（舊設備）掃描+傳送狀態 */
export type OldDeviceScannerStatus =
  | 'idle'
  | 'scanning'
  | 'verifying'
  | 'choose-mode'
  | 'transferring'
  | 'success'
  | 'error';

export interface NewDeviceDisplayState {
  status: NewDeviceDisplayStatus;
  qrCode: string | null;
  qrData: DeviceTransferQR | null;
  transferData: TransferData | null;
  error: string | null;
  expiresAt: number | null;
}

export interface OldDeviceScannerState {
  status: OldDeviceScannerStatus;
  error: string | null;
  /** 選擇的傳輸模式 */
  transferMode: TransferMode | null;
  /** 掃描到的 B 機 tempId */
  targetTempId: string | null;
}

// ============================================================================
// B 機 Hook: 顯示 QR Code，等待 A 傳送
// ============================================================================

/**
 * B 機端 Hook — 產生 QR Code 並等待 A 機傳送資料
 *
 * 流程：產生 QR → 等待 A 掃描+驗證+傳送 → 接收 → 瞬間登入
 */
export function useNewDeviceDisplay() {
  const [state, setState] = useState<NewDeviceDisplayState>({
    status: 'idle',
    qrCode: null,
    qrData: null,
    transferData: null,
    error: null,
    expiresAt: null,
  });

  const displayRef = useRef<NewDeviceDisplay | null>(null);

  const startDisplay = useCallback(async () => {
    setState(prev => ({ ...prev, status: 'generating', error: null }));

    try {
      // B 機沒有帳戶金鑰：向 API 要一張只能訂閱自己收件箱、五分鐘到期的臨時身分（不再自己編 tempId 去連）
      const credential = await mqttService.createTransferCredential();
      mqttService.useTemporaryCredential(credential);
      const { qrData, qrString, tempKey, tempId } = await generateNewDeviceQR(credential.username);

      // 產生 QR 圖片
      const QRCode = await import('qrcode');
      const qrCodeDataUrl = await QRCode.default.toDataURL(qrString, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      });

      setState({
        status: 'waiting',
        qrCode: qrCodeDataUrl,
        qrData,
        transferData: null,
        error: null,
        expiresAt: qrData.expiresAt,
      });

      // B 機用臨時身分連 MQTT（username／clientId 都是伺服器發的 tempId）
      await mqttService.connect(tempId);

      // 等待 A 機傳送
      displayRef.current = new NewDeviceDisplay(tempKey, tempId, {
        onProgress: (status) => {
          devLog('[NewDeviceDisplay] Progress:', status);
          if (status.includes('解密')) {
            setState(prev => ({ ...prev, status: 'receiving' }));
          }
        },
        onComplete: (data) => {
          setState(prev => ({
            ...prev,
            status: 'success',
            transferData: data,
          }));
        },
        onError: (error) => {
          setState(prev => ({ ...prev, status: 'error', error }));
        },
      });

      await displayRef.current.start();
    } catch (err) {
      devWarn('[NewDeviceDisplay] Start error:', err);
      setState({
        status: 'error',
        qrCode: null,
        qrData: null,
        transferData: null,
        error: err instanceof Error ? err.message : tr('deviceTransfer.qrGenerateFailed'),
        expiresAt: null,
      });
    }
  }, []);

  const cancel = useCallback(() => {
    if (displayRef.current) {
      displayRef.current.cancel();
      displayRef.current = null;
    }
    mqttService.disconnect();
    setState({
      status: 'idle',
      qrCode: null,
      qrData: null,
      transferData: null,
      error: null,
      expiresAt: null,
    });
  }, []);

  const regenerate = useCallback(() => {
    cancel();
    startDisplay();
  }, [cancel, startDisplay]);

  return {
    ...state,
    startDisplay,
    cancel,
    regenerate,
    isWaiting: state.status === 'waiting',
    isReceiving: state.status === 'receiving',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
  };
}

// ============================================================================
// A 機 Hook: 掃描 QR → 驗證 → 選模式 → 傳送
// ============================================================================

/**
 * A 機端 Hook — 掃描 B 機 QR → 驗證身份 → 選擇模式 → 加密傳送
 *
 * 流程：掃描 QR → 臉部+PIN 驗證(由外部處理) → 選「換機」or「多設備」→ 傳送
 */
export function useOldDeviceScanner(
  identity: Identity | null,
  signedPreKey?: SignedPreKey | null
) {
  const [state, setState] = useState<OldDeviceScannerState>({
    status: 'idle',
    error: null,
    transferMode: null,
    targetTempId: null,
  });

  const tempKeyRef = useRef<Uint8Array | null>(null);
  const { userProfile, friends } = useChatStore();
  const { groups } = useGroupStore();

  /**
   * 處理掃描到的 QR Code
   */
  const handleQRScan = useCallback(async (qrString: string): Promise<boolean> => {
    setState(prev => ({ ...prev, status: 'verifying', error: null }));

    try {
      const qrData = parseTransferQR(qrString);
      if (!qrData) {
        setState(prev => ({ ...prev, status: 'error', error: tr('deviceTransfer.invalidQrFormat') }));
        return false;
      }

      // Phase 27: 新版 QR (有 tempId)
      const result = verifyNewDeviceQR(qrData);
      if (!result.valid) {
        setState(prev => ({
          ...prev,
          status: 'error',
          error: result.error || tr('deviceTransfer.verifyFailed'),
        }));
        return false;
      }

      tempKeyRef.current = result.tempKey!;

      // 進入「選擇模式」畫面
      setState(prev => ({
        ...prev,
        status: 'choose-mode',
        targetTempId: result.tempId!,
      }));

      return true;
    } catch (err) {
      devWarn('[OldDeviceScanner] QR scan error:', err);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : tr('deviceTransfer.processQrFailed'),
      }));
      return false;
    }
  }, []);

  /**
   * 選擇傳輸模式後，執行傳送
   */
  const confirmTransfer = useCallback(async (mode: TransferMode) => {
    if (!identity || !tempKeyRef.current || !state.targetTempId) {
      setState(prev => ({ ...prev, status: 'error', error: tr('deviceTransfer.missingData') }));
      return;
    }

    setState(prev => ({
      ...prev,
      status: 'transferring',
      transferMode: mode,
    }));

    try {
      // 收集 PIN hash/salt
      const pinHash = localStorage.getItem('mist_pin_hash') ?? undefined;
      const pinSalt = localStorage.getItem('mist_pin_salt') ?? undefined;
      const backupAuthHash = localStorage.getItem('aegis_backup_auth_hash') ?? undefined;
      // 臉部特徵與行為指紋基線（官方版 AegisID 才有；社群版的換機資料不帶這兩樣，開源第 5b 步）
      const { faceEmbedding, behaviorBaseline } = await ext.identity.transferExtras();

      // 建構傳輸資料
      const transferData: TransferData = {
        privateKey: toBase64(identity.privateKey),
        displayName: userProfile.displayName,
        avatar: userProfile.avatar,
        friends: friends.map(f => ({
          publicKey: f.publicKey,
          nickname: f.name,
          verified: f.trustLevel === 'verified',
          addedAt: f.addedAt || Date.now(),
        })),
        // 每個群帶整條狀態鏈（新機重驗後還原；引擎沒有這個群的鏈就不帶）
        groups: groups.flatMap(g => {
          const log = getGroupEngine()?.backupOf(g.id);
          return log ? [{ id: g.id, name: g.name, members: [], createdAt: g.createdAt || Date.now(), log }] : [];
        }),
        signedPreKey: signedPreKey ? {
          privateKey: toBase64(signedPreKey.privateKey),
          id: signedPreKey.id,
          signature: toBase64(signedPreKey.signature),
          timestamp: signedPreKey.timestamp,
        } : undefined,
        // Phase 27 新欄位
        pinHash,
        pinSalt,
        backupAuthHash,
        behaviorBaseline,
        faceEmbedding,
        keepOldDevice: mode === 'multi-device',
      };

      // 確保 MQTT 已連接
      if (!mqttService.isConnected()) {
        await mqttService.connect(identity.publicKeyBase64);
      }

      // 傳送
      const scanner = new OldDeviceScanner(
        tempKeyRef.current,
        state.targetTempId,
        transferData,
        {
          onProgress: (status) => {
            devLog('[OldDeviceScanner] Progress:', status);
          },
          onComplete: () => {
            setState(prev => ({ ...prev, status: 'success' }));
          },
          onError: (error) => {
            setState(prev => ({ ...prev, status: 'error', error }));
          },
        }
      );

      await scanner.send();
    } catch (err) {
      devWarn('[OldDeviceScanner] Transfer error:', err);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : tr('deviceTransfer.failed'),
      }));
    }
  }, [identity, signedPreKey, state.targetTempId, userProfile, friends, groups]);

  const cancel = useCallback(() => {
    tempKeyRef.current = null;
    setState({
      status: 'idle',
      error: null,
      transferMode: null,
      targetTempId: null,
    });
  }, []);

  return {
    ...state,
    handleQRScan,
    confirmTransfer,
    cancel,
    isScanning: state.status === 'scanning',
    isVerifying: state.status === 'verifying',
    isChooseMode: state.status === 'choose-mode',
    isTransferring: state.status === 'transferring',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
  };
}

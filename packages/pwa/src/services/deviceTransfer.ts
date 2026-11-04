/**
 * Device Transfer Service - 統一換機/多設備登入 (Phase 27)
 *
 * 反轉 QR 方向：
 *   B 機（新設備）顯示 QR Code（含伺服器發的五分鐘臨時收件箱與一次性傳輸金鑰）
 *   A 機（舊設備）掃描 QR → 驗臉+輸 PIN → 選擇模式 → 傳送資料
 *   B 機接收 → 瞬間登入（零輸入）
 *
 * 安全原則：
 *   - QR 只在面對面掃描，內含一次性傳輸金鑰（AES-GCM）
 *   - B 機的 MQTT 身分是 /api/mqtt/transfer-token 發的：只能訂閱自己的隨機收件箱、什麼都不能發、5 分鐘到期
 *   - TransferData 含完整認證資料（privateKey, face, PIN, behavior）
 *   - 僅限面對面場景
 */

import { toBase64, fromBase64 } from './crypto';
import { mqttService, MessageType } from './mqtt';
import { toBuffer } from '../utils/toBuffer';
import type { GroupBackup } from './groupBackup';
import { devLog, devWarn } from '../utils/devLog';
import { tr } from '../i18n/tr';

// Transfer payload — friend / group projections used during 1-1 device transfer
interface TransferFriend {
  publicKey: string;
  nickname: string;
  verified: boolean;
  addedAt: number;
}

interface TransferGroup {
  id: string;
  name: string;
  members: Array<{ publicKey: string; nickname?: string; role?: string }>;
  createdAt: number;
  /** 整條簽章狀態鏈＋log 位置＋目前那一代的金鑰（新機重驗後還原，見 services/groupBackup）；沒有就不還原這個群 */
  log?: GroupBackup;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Phase 27 QR Code 資料結構（B 機顯示）
 *
 * B 機產生一次性傳輸金鑰；tempId 是伺服器發的 receive-only MQTT 身分（transfer_…）
 */
export interface DeviceTransferQR {
  type: 'device_transfer';
  /** 臨時加密金鑰（Base64，32 bytes） */
  tempKey: string;
  /** B 機的臨時 MQTT 身份（用於訊息路由）＝ /api/mqtt/transfer-token 的 username */
  tempId: string;
  /** 產生時間 */
  timestamp: number;
  /** 過期時間（5 分鐘） */
  expiresAt: number;
}

/**
 * Phase 27 擴充傳輸資料
 *
 * 包含完整認證資料：privateKey, face embedding, PIN hash/salt, behavior baseline
 * 安全通道（面對面 QR）=> B 機零輸入登入
 */
export interface TransferData {
  /** Base64 編碼的私鑰 */
  privateKey: string;
  /** 顯示名稱 */
  displayName: string;
  /** 頭像 */
  avatar: string;
  /** 好友列表 */
  friends: TransferFriend[];
  /** 群組列表 */
  groups: TransferGroup[];
  /** 簽名預鑰匙 */
  signedPreKey?: {
    privateKey: string;
    id: number;
    signature: string;
    timestamp: number;
  };

  // === Phase 27 新增欄位 ===

  /** PIN hash (Base64) */
  pinHash?: string;
  /** PIN salt (Base64) */
  pinSalt?: string;
  /** PIN 備份恢復 hash (Base64) */
  backupAuthHash?: string;
  /** 行為指紋基線 (JSON string) */
  behaviorBaseline?: string;
  /** 加密的 face embedding (JSON string of StoredFaceEmbedding) */
  faceEmbedding?: string;
  /** 多設備模式：true = A 保留登入，false = A 登出（換機） */
  keepOldDevice?: boolean;
}

/**
 * 傳輸模式
 */
export type TransferMode = 'transfer' | 'multi-device';

/**
 * 加密的傳輸資料
 */
interface EncryptedTransferPayload {
  iv: string;
  ciphertext: string;
  tag: string;
}

// ============================================================================
// Constants
// ============================================================================

const QR_EXPIRY_DURATION = 5 * 60 * 1000; // 5 分鐘
const TRANSFER_TIMEOUT = 60 * 1000;       // 60 秒

// ============================================================================
// QR Code Generation & Verification
// ============================================================================

/**
 * B 機產生 QR Code（新設備端）
 *
 * 不需要 identity（B 機尚無帳號）。tempId 由呼叫端先向伺服器要（mqttService.createTransferCredential）：
 * 以前 B 機自己編一個 tempId 當公鑰去連 MQTT，換到的 token 沒有 ACL。
 */
export async function generateNewDeviceQR(tempId: string): Promise<{
  qrData: DeviceTransferQR;
  qrString: string;
  tempKey: Uint8Array;
  tempId: string;
}> {
  // 產生臨時加密金鑰
  const tempKey = crypto.getRandomValues(new Uint8Array(32));
  const timestamp = Date.now();
  const expiresAt = timestamp + QR_EXPIRY_DURATION;

  const qrData: DeviceTransferQR = {
    type: 'device_transfer',
    tempKey: toBase64(tempKey),
    tempId,
    timestamp,
    expiresAt,
  };

  devLog('[DeviceTransfer] B 機 QR 產生完成，tempId:', tempId);

  return {
    qrData,
    qrString: JSON.stringify(qrData),
    tempKey,
    tempId,
  };
}

/**
 * A 機驗證 QR Code（舊設備端）
 *
 * 不驗簽名（B 機無 identity），只檢查格式和過期
 */
export function verifyNewDeviceQR(qrData: DeviceTransferQR): {
  valid: boolean;
  error?: string;
  tempKey?: Uint8Array;
  tempId?: string;
} {
  try {
    if (qrData.type !== 'device_transfer') {
      return { valid: false, error: tr('deviceTransfer.invalidQrType') };
    }

    if (Date.now() > qrData.expiresAt) {
      return { valid: false, error: tr('deviceTransfer.expired') };
    }

    // tempId 只會是伺服器發的 transfer_…（URL-safe），其他寫法會讓舊裝置往奇怪的主題發
    if (!qrData.tempKey || !qrData.tempId || !/^transfer_[A-Za-z0-9_-]{16,64}$/.test(qrData.tempId)) {
      return { valid: false, error: tr('deviceTransfer.malformedQr') };
    }

    const tempKey = fromBase64(qrData.tempKey);
    return {
      valid: true,
      tempKey,
      tempId: qrData.tempId,
    };
  } catch (err) {
    devWarn('[DeviceTransfer] QR verification error:', err);
    return { valid: false, error: tr('deviceTransfer.verifyError') };
  }
}

/**
 * 解析 QR Code 字串
 */
export function parseTransferQR(qrString: string): DeviceTransferQR | null {
  try {
    const data = JSON.parse(qrString);
    if (data.type === 'device_transfer') {
      return data as DeviceTransferQR;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * 使用臨時金鑰加密傳輸資料
 */
export async function encryptTransferData(
  data: TransferData,
  tempKey: Uint8Array
): Promise<EncryptedTransferPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(tempKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBuffer(plaintext)
  );

  const ciphertextWithTag = new Uint8Array(encrypted);
  const ciphertext = ciphertextWithTag.slice(0, -16);
  const tag = ciphertextWithTag.slice(-16);

  return {
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    tag: toBase64(tag),
  };
}

/**
 * 使用臨時金鑰解密傳輸資料
 */
export async function decryptTransferData(
  payload: EncryptedTransferPayload,
  tempKey: Uint8Array
): Promise<TransferData> {
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);
  const tag = fromBase64(payload.tag);

  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(tag, ciphertext.length);

  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(tempKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(ciphertextWithTag)
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============================================================================
// Phase 27: New Transfer Flow Classes
// ============================================================================

/**
 * B 機端（新設備）：顯示 QR Code，等待 A 機傳送資料
 *
 * 流程：B 顯示 QR → A 掃描 → A 驗證+傳送 → B 接收 → B 瞬間登入
 */
export class NewDeviceDisplay {
  private tempKey: Uint8Array;
  private onProgress?: (status: string) => void;
  private onComplete?: (data: TransferData) => void;
  private onError?: (error: string) => void;
  private unsubscribe?: () => void;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    tempKey: Uint8Array,
    tempId: string,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: (data: TransferData) => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    // tempId kept in constructor signature for API compatibility
    void tempId;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  /**
   * 開始等待 A 機傳送資料
   */
  async start(): Promise<void> {
    this.onProgress?.('等待舊設備掃描...');

    // 訂閱傳輸資料訊息（A 機會發送到 B 的 tempId）
    this.unsubscribe = mqttService.subscribe(
      MessageType.DEVICE_TRANSFER_DATA,
      async (message) => {
        try {
          const payload = message.payload as {
            encryptedPayload: EncryptedTransferPayload;
            timestamp: number;
          };

          this.onProgress?.('正在解密資料...');

          const transferData = await decryptTransferData(
            payload.encryptedPayload,
            this.tempKey
          );

          this.cleanup();
          devLog('[NewDeviceDisplay] Transfer data received successfully');
          this.onComplete?.(transferData);
        } catch (err) {
          devWarn('[NewDeviceDisplay] Receive error:', err);
          this.onError?.(tr('deviceTransfer.receiveError'));
        }
      }
    );

    // 120s 超時（等待 A 機驗證可能較久）
    this.timeoutId = setTimeout(() => {
      this.onError?.(tr('deviceTransfer.waitTimeout'));
      this.cleanup();
    }, TRANSFER_TIMEOUT * 2);
  }

  cancel(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}

/**
 * A 機端（舊設備）：掃描 QR → 驗證身份 → 選模式 → 傳送資料
 *
 * 流程：A 掃描 QR → 臉部+PIN 驗證 → 選「換機」or「多設備」→ 加密傳送 → (換機時 A 登出)
 */
export class OldDeviceScanner {
  private tempKey: Uint8Array;
  private tempId: string;
  private transferData: TransferData;
  private onProgress?: (status: string) => void;
  private onComplete?: () => void;
  private onError?: (error: string) => void;

  constructor(
    tempKey: Uint8Array,
    tempId: string,
    transferData: TransferData,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: () => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    this.tempId = tempId;
    this.transferData = transferData;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  /**
   * 傳送資料到 B 機
   */
  async send(): Promise<void> {
    try {
      this.onProgress?.('正在加密傳輸資料...');

      const encryptedPayload = await encryptTransferData(
        this.transferData,
        this.tempKey
      );

      // 透過 MQTT 發送到 B 機（使用 B 的 tempId 作為路由）
      // B 已連接 MQTT 並訂閱 DEVICE_TRANSFER_DATA
      mqttService.sendDeviceTransferData(this.tempId, {
        encryptedPayload,
        timestamp: Date.now(),
      });

      devLog('[OldDeviceScanner] Transfer data sent to B device');
      this.onProgress?.('資料傳輸完成');
      this.onComplete?.();
    } catch (err) {
      devWarn('[OldDeviceScanner] Send error:', err);
      this.onError?.(tr('deviceTransfer.sendError'));
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export const deviceTransferService = {
  // Phase 27 (new)
  generateNewDeviceQR,
  verifyNewDeviceQR,
  parseTransferQR,
  encryptTransferData,
  decryptTransferData,
  NewDeviceDisplay,
  OldDeviceScanner,
  // （Phase 8 舊版「舊機顯示 QR、新機自編身分去連」整條拿掉：新機現在只拿得到 receive-only 的臨時 token）
};

export default deviceTransferService;

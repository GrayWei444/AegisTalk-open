/**
 * Sealed Sender Service - 隱藏發送者身份
 *
 * E2EE Phase 2 改善：防止 MQTT Broker 追蹤通訊模式
 *
 * 設計原理：
 * - 外層訊息只包含臨時公鑰，發送者身份被加密在內層
 * - MQTT Broker 只能看到「有人發訊息給 Alice」，無法知道是誰
 * - 接收者解密後才能得知發送者身份
 *
 * 加密流程：
 * 1. 生成臨時 X25519 金鑰對
 * 2. 與接收者公鑰進行 ECDH 計算共享密鑰
 * 3. 用共享密鑰加密內層訊息（包含發送者身份）
 * 4. 發送：{ ephemeralPublicKey, sealedContent }
 *
 * 解密流程：
 * 1. 用自己的私鑰和臨時公鑰計算共享密鑰
 * 2. 解密內層訊息
 * 3. 驗證發送者簽名（可選）
 */

import {
  toBase64,
  fromBase64,
  generateRandomBytes,
  Identity,
} from './crypto';
import { toBuffer } from '../utils/toBuffer';
import { devWarn } from '../utils/devLog';

// ============================================
// 類型定義
// ============================================

/**
 * 封印信封（外層，MQTT Broker 可見）
 */
export interface SealedEnvelope {
  // 版本號（用於未來升級）
  v: number;
  // 臨時公鑰 (Base64)
  ek: string;
  // 加密的內層訊息 (Base64)
  ct: string;
  // Nonce/IV (Base64)
  n: string;
}

/**
 * 內層訊息（加密後，只有接收者可見）
 */
interface InnerMessage {
  // 發送者公鑰 (Base64)
  from: string;
  // 訊息類型
  type: string;
  // 訊息內容
  payload: unknown;
  // 時間戳
  ts: number;
  // 發送者簽名 (Base64，可選)
  sig?: string;
}

/**
 * 拆封結果
 */
export interface UnsealResult {
  from: string;
  type: string;
  payload: unknown;
  timestamp: number;
  signature?: string;
  /** 簽章是否已驗證通過（false = 無簽章，向後相容） */
  verified: boolean;
}

// ============================================
// 常數
// ============================================

const SEALED_SENDER_VERSION = 1;

// ============================================
// X25519 ECDH (使用 WebCrypto API)
// ============================================

/**
 * 生成臨時 X25519 金鑰對
 */
async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  ) as Promise<CryptoKeyPair>;
}

/**
 * 導出公鑰為 raw 格式
 */
async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(exported);
}

/**
 * 導入公鑰
 */
async function importPublicKey(keyData: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBuffer(new Uint8Array(keyData)),
    { name: 'X25519' },
    true,
    []
  );
}

/**
 * 導入私鑰
 */
async function importPrivateKey(keyData: Uint8Array): Promise<CryptoKey> {
  // X25519 私鑰需要用 PKCS8 格式導入
  // 先構建 PKCS8 包裝
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, // SEQUENCE, 46 bytes
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x05, // SEQUENCE, 5 bytes
    0x06, 0x03, 0x2b, 0x65, 0x6e, // OID 1.3.101.110 (X25519)
    0x04, 0x22, // OCTET STRING, 34 bytes
    0x04, 0x20, // OCTET STRING, 32 bytes (the key)
  ]);

  const pkcs8 = new Uint8Array(pkcs8Header.length + keyData.length);
  pkcs8.set(pkcs8Header);
  pkcs8.set(keyData, pkcs8Header.length);

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'X25519' },
    false,
    ['deriveBits']
  );
}

/**
 * 計算 ECDH 共享密鑰
 */
async function deriveSharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<Uint8Array> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(sharedBits);
}

/**
 * 從共享密鑰派生 AES 金鑰
 */
async function deriveAesKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  // 使用 HKDF 派生 AES 金鑰
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toBuffer(new Uint8Array(sharedSecret)),
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt: new TextEncoder().encode('AegisTalk-SealedSender-v1'),
      info: new TextEncoder().encode('AES-GCM-256'),
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ============================================
// 封印與拆封
// ============================================

/**
 * 封印訊息（隱藏發送者）
 *
 * @param senderPublicKey - 發送者公鑰 (Base64)
 * @param recipientPublicKey - 接收者公鑰 (raw bytes)
 * @param messageType - 訊息類型
 * @param payload - 訊息內容
 * @param signature - 可選的發送者簽名
 * @returns 封印信封
 */
async function sealMessage(
  senderPublicKey: string,
  recipientPublicKey: Uint8Array,
  messageType: string,
  payload: unknown,
  signature?: string
): Promise<SealedEnvelope> {
  // 1. 生成臨時金鑰對
  const ephemeralKeyPair = await generateEphemeralKeyPair();
  const ephemeralPublicKey = await exportPublicKey(ephemeralKeyPair.publicKey);

  // 2. 導入接收者公鑰
  const recipientKey = await importPublicKey(recipientPublicKey);

  // 3. 計算共享密鑰
  const sharedSecret = await deriveSharedKey(ephemeralKeyPair.privateKey, recipientKey);

  // 4. 派生 AES 金鑰
  const aesKey = await deriveAesKey(sharedSecret);

  // 5. 構建內層訊息
  const innerMessage: InnerMessage = {
    from: senderPublicKey,
    type: messageType,
    payload,
    ts: Date.now(),
    sig: signature,
  };

  // 6. AES-GCM 加密
  const nonce = generateRandomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(innerMessage));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(new Uint8Array(nonce)) },
    aesKey,
    toBuffer(new Uint8Array(plaintext))
  );

  // 7. 組裝封印信封
  return {
    v: SEALED_SENDER_VERSION,
    ek: toBase64(ephemeralPublicKey),
    ct: toBase64(new Uint8Array(ciphertext)),
    n: toBase64(nonce),
  };
}

/**
 * 拆封訊息（解密並取得發送者身份）
 *
 * @param envelope - 封印信封
 * @param recipientPrivateKey - 接收者私鑰 (raw bytes)
 * @returns 拆封結果
 */
async function unsealMessage(
  envelope: SealedEnvelope,
  recipientPrivateKey: Uint8Array
): Promise<UnsealResult> {
  // 1. 檢查版本
  if (envelope.v !== SEALED_SENDER_VERSION) {
    throw new Error(`Unsupported Sealed Sender version: ${envelope.v}`);
  }

  // 2. 解碼 Base64
  const ephemeralPublicKey = fromBase64(envelope.ek);
  const ciphertext = fromBase64(envelope.ct);
  const nonce = fromBase64(envelope.n);

  // 3. 導入金鑰
  const ephemeralKey = await importPublicKey(ephemeralPublicKey);
  const privateKey = await importPrivateKey(recipientPrivateKey);

  // 4. 計算共享密鑰
  const sharedSecret = await deriveSharedKey(privateKey, ephemeralKey);

  // 5. 派生 AES 金鑰
  const aesKey = await deriveAesKey(sharedSecret);

  // 6. AES-GCM 解密
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(new Uint8Array(nonce)) },
    aesKey,
    toBuffer(new Uint8Array(ciphertext))
  );

  // 7. 解析內層訊息
  const innerMessage: InnerMessage = JSON.parse(
    new TextDecoder().decode(plaintext)
  );

  // 8. 簽章驗證（如果存在）
  let verified = false;
  if (innerMessage.sig) {
    try {
      const senderPubKey = fromBase64(innerMessage.from);
      const sigBytes = fromBase64(innerMessage.sig);
      // 簽章覆蓋的資料：type + payload + timestamp
      const signedData = new TextEncoder().encode(
        JSON.stringify({ type: innerMessage.type, payload: innerMessage.payload, ts: innerMessage.ts })
      );
      verified = Identity.verify(senderPubKey, signedData, sigBytes);
      if (!verified) {
        devWarn('[SealedSender] Signature verification FAILED');
        throw new Error('Sealed Sender signature verification failed');
      }
    } catch (err) {
      // 如果 err 是我們自己丟出的驗證失敗，繼續向上拋
      if (err instanceof Error && err.message === 'Sealed Sender signature verification failed') {
        throw err;
      }
      // 其他錯誤（例如 WASM 未初始化）：標記未驗證但不丟棄
      devWarn('[SealedSender] Signature verification error:', err);
      verified = false;
    }
  }
  // 無簽章 → verified = false（向後相容舊訊息）

  return {
    from: innerMessage.from,
    type: innerMessage.type,
    payload: innerMessage.payload,
    timestamp: innerMessage.ts,
    signature: innerMessage.sig,
    verified,
  };
}

// ============================================
// 便利函式
// ============================================

/**
 * 從 Base64 公鑰封印訊息
 */
export async function sealMessageBase64(
  senderPublicKey: string,
  recipientPublicKeyBase64: string,
  messageType: string,
  payload: unknown,
  signature?: string
): Promise<SealedEnvelope> {
  const recipientPublicKey = fromBase64(recipientPublicKeyBase64);
  return sealMessage(senderPublicKey, recipientPublicKey, messageType, payload, signature);
}

/**
 * 從 Base64 私鑰拆封訊息
 */
export async function unsealMessageBase64(
  envelope: SealedEnvelope,
  recipientPrivateKeyBase64: string
): Promise<UnsealResult> {
  const recipientPrivateKey = fromBase64(recipientPrivateKeyBase64);
  return unsealMessage(envelope, recipientPrivateKey);
}


import { devLog } from '../utils/devLog';

/**
 * Crypto Service - WASM 加密模組封裝
 *
 * 提供 TypeScript 友好的介面來使用 Rust WASM 加密功能
 */

import init, {
  IdentityKeyPair,
  X25519KeyPair,
  X3DH,
  X3DHSenderOutput,
  X3DHInitialMessage,
  RatchetSession,
  RatchetMessage,
  AesGcmCipher,
  EncryptedMessage,
  aesEncrypt,
  aesDecrypt,
  signPreKey,
  createPreKeyBundleJson,
  randomBytes,
  base64Encode,
  base64Decode,
  version,
} from '../wasm/pkg/safetalk_core';

// Re-export types
export type {
  X3DHSenderOutput,
  X3DHInitialMessage,
  EncryptedMessage,
};

// Re-export RatchetMessage class (需要 fromJson 靜態方法)
export { RatchetMessage };

// WASM 初始化狀態
let wasmInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * 初始化 WASM 模組
 * 必須在使用任何加密功能前調用
 */
export async function initCrypto(): Promise<void> {
  if (wasmInitialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    devLog('[DIAG] WASM init starting...');
    await init();
    wasmInitialized = true;
    devLog(`[DIAG] WASM initialized OK, version: ${version()}`);
    devLog(`[Crypto] WASM initialized, version: ${version()}`);
  })();

  try {
    await initPromise;
  } finally {
    // Always clear initPromise so a retry is possible after transient failure
    initPromise = null;
  }
}

/**
 * 確保 WASM 已初始化
 */
function ensureInitialized(): void {
  if (!wasmInitialized) {
    throw new Error('Crypto module not initialized. Call initCrypto() first.');
  }
}

// ============================================
// 金鑰管理
// ============================================

/**
 * 身份金鑰對 (Ed25519)
 * 用於簽章和身份驗證，長期使用
 */
export class Identity {
  private keyPair: IdentityKeyPair;

  private constructor(keyPair: IdentityKeyPair) {
    this.keyPair = keyPair;
  }

  /**
   * 生成新的身份金鑰對
   */
  static generate(): Identity {
    ensureInitialized();
    return new Identity(new IdentityKeyPair());
  }

  /**
   * 從私鑰還原
   */
  static fromPrivateKey(privateKey: Uint8Array): Identity {
    ensureInitialized();
    return new Identity(IdentityKeyPair.fromBytes(privateKey));
  }

  /**
   * 取得公鑰 (Base64)
   */
  get publicKeyBase64(): string {
    return this.keyPair.publicKeyBase64();
  }

  /**
   * 取得公鑰位元組
   */
  get publicKey(): Uint8Array {
    return this.keyPair.publicKeyBytes();
  }

  /**
   * 取得私鑰位元組 (敏感！僅用於備份)
   */
  get privateKey(): Uint8Array {
    return this.keyPair.privateKeyBytes();
  }

  /**
   * 簽署訊息
   */
  sign(message: Uint8Array): Uint8Array {
    return this.keyPair.sign(message);
  }

  /**
   * 驗證簽章
   */
  static verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    ensureInitialized();
    return IdentityKeyPair.verifySignature(publicKey, message, signature);
  }

  /**
   * 釋放資源
   */
  free(): void {
    this.keyPair.free();
  }
}

/**
 * 預簽署金鑰 (Signed PreKey)
 * 中期使用的 X25519 金鑰，附帶身份金鑰簽章
 */
export class SignedPreKey {
  private keyPair: X25519KeyPair;
  public readonly id: number;
  public readonly signature: Uint8Array;
  public readonly timestamp: number;

  private constructor(
    keyPair: X25519KeyPair,
    id: number,
    signature: Uint8Array,
    timestamp: number
  ) {
    this.keyPair = keyPair;
    this.id = id;
    this.signature = signature;
    this.timestamp = timestamp;
  }

  /**
   * 生成新的簽署預金鑰
   */
  static generate(identity: Identity, id: number): SignedPreKey {
    ensureInitialized();
    const keyPair = new X25519KeyPair();
    const publicKey = keyPair.publicKeyBytes();
    const signature = signPreKey(identity.privateKey, publicKey);
    const timestamp = Date.now();
    return new SignedPreKey(keyPair, id, signature, timestamp);
  }

  /**
   * 從私鑰還原
   */
  static fromPrivateKey(
    privateKey: Uint8Array,
    id: number,
    signature: Uint8Array,
    timestamp: number
  ): SignedPreKey {
    ensureInitialized();
    const keyPair = X25519KeyPair.fromBytes(privateKey);
    return new SignedPreKey(keyPair, id, signature, timestamp);
  }

  get publicKey(): Uint8Array {
    return this.keyPair.publicKeyBytes();
  }

  get publicKeyBase64(): string {
    return this.keyPair.publicKeyBase64();
  }

  get signatureBase64(): string {
    return toBase64(this.signature);
  }

  get privateKey(): Uint8Array {
    return this.keyPair.privateKeyBytes();
  }

  free(): void {
    this.keyPair.free();
  }
}

/**
 * 一次性預金鑰 (One-Time PreKey)
 * 用完即丟的 X25519 金鑰
 */
export class OneTimePreKey {
  private keyPair: X25519KeyPair;
  public readonly id: number;

  private constructor(keyPair: X25519KeyPair, id: number) {
    this.keyPair = keyPair;
    this.id = id;
  }

  /**
   * 生成新的一次性預金鑰
   */
  static generate(id: number): OneTimePreKey {
    ensureInitialized();
    return new OneTimePreKey(new X25519KeyPair(), id);
  }

  /**
   * 從私鑰還原
   */
  static fromPrivateKey(privateKey: Uint8Array, id: number): OneTimePreKey {
    ensureInitialized();
    return new OneTimePreKey(X25519KeyPair.fromBytes(privateKey), id);
  }

  get publicKey(): Uint8Array {
    return this.keyPair.publicKeyBytes();
  }

  get publicKeyBase64(): string {
    return this.keyPair.publicKeyBase64();
  }

  get privateKey(): Uint8Array {
    return this.keyPair.privateKeyBytes();
  }

  free(): void {
    this.keyPair.free();
  }
}

/**
 * 一次性 X25519 金鑰對（群組金鑰信封的臨時金鑰，見 identitySeal）。回傳位元組複本，WASM 物件立刻釋放。
 */
export function x25519Generate(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  ensureInitialized();
  const keyPair = new X25519KeyPair();
  try {
    return { publicKey: keyPair.publicKeyBytes(), privateKey: keyPair.privateKeyBytes() };
  } finally {
    keyPair.free();
  }
}

/** X25519(私鑰純量, 對方公鑰)：秘密運算留在 WASM（x25519-dalek），不在 JS 裡做 */
export function x25519Dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  ensureInitialized();
  const keyPair = X25519KeyPair.fromBytes(privateKey);
  try {
    return keyPair.diffieHellman(publicKey);
  } finally {
    keyPair.free();
  }
}

// ============================================
// PreKeyBundle
// ============================================

export interface PreKeyBundleData {
  identityKey: Uint8Array;
  signedPreKey: {
    id: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
    timestamp: number;
  };
  oneTimePreKey?: {
    id: number;
    publicKey: Uint8Array;
  };
}

/**
 * 建立 PreKeyBundle JSON
 */
export function createPreKeyBundle(data: PreKeyBundleData): string {
  ensureInitialized();
  return createPreKeyBundleJson(
    data.identityKey,
    data.signedPreKey.id,
    data.signedPreKey.publicKey,
    data.signedPreKey.signature,
    BigInt(data.signedPreKey.timestamp),
    data.oneTimePreKey?.id ?? null,
    data.oneTimePreKey?.publicKey ?? null
  );
}

// ============================================
// X3DH 金鑰交換
// ============================================

export interface X3DHResult {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  ephemeralPrivateKey: Uint8Array;
  usedOneTimePrekeyId?: number;
}

/**
 * X3DH 發起者計算共享密鑰
 */
export function x3dhInitiator(
  senderIdentity: Identity,
  recipientIdentityPublic: Uint8Array,
  recipientSignedPrekeyPublic: Uint8Array,
  recipientSignedPrekeySignature: Uint8Array,
  recipientOneTimePrekeyPublic?: Uint8Array,
  recipientOneTimePrekeyId?: number
): X3DHResult {
  ensureInitialized();

  const output = X3DH.initiatorCalculate(
    senderIdentity.privateKey,
    recipientIdentityPublic,
    recipientSignedPrekeyPublic,
    recipientSignedPrekeySignature,
    recipientOneTimePrekeyPublic ?? null,
    recipientOneTimePrekeyId ?? null
  );

  return {
    sharedSecret: output.sharedSecret,
    ephemeralPublicKey: output.ephemeralPublicKey,
    ephemeralPrivateKey: output.ephemeralPrivateKey,
    usedOneTimePrekeyId: output.usedOneTimePrekeyId,
  };
}

/**
 * X3DH 接收者計算共享密鑰
 */
export function x3dhResponder(
  recipientIdentity: Identity,
  recipientSignedPrekey: SignedPreKey,
  recipientOneTimePrekey: OneTimePreKey | null,
  senderIdentityPublic: Uint8Array,
  senderEphemeralPublic: Uint8Array
): Uint8Array {
  ensureInitialized();

  return X3DH.responderCalculate(
    recipientIdentity.privateKey,
    recipientSignedPrekey.privateKey,
    recipientOneTimePrekey?.privateKey ?? null,
    senderIdentityPublic,
    senderEphemeralPublic
  );
}

/**
 * 建立 X3DH 初始訊息
 */
export function createX3DHMessage(
  senderIdentityPublic: Uint8Array,
  ephemeralPublic: Uint8Array,
  oneTimePrekeyId?: number
): X3DHInitialMessage {
  ensureInitialized();
  return X3DH.createInitialMessage(
    senderIdentityPublic,
    ephemeralPublic,
    oneTimePrekeyId ?? null
  );
}

// ============================================
// Double Ratchet 會話
// ============================================

/**
 * Double Ratchet 會話管理器
 */
export class Session {
  private session: RatchetSession;
  private freed = false;

  private constructor(session: RatchetSession) {
    this.session = session;
  }

  /**
   * 發起者建立會話 (Alice)
   * @param sharedSecret - X3DH 產生的共享密鑰
   * @param remotePublicKey - Bob 的 Signed PreKey 公鑰
   * @param ephemeralPrivateKey - Alice 的 X3DH 臨時私鑰
   * @param ephemeralPublicKey - Alice 的 X3DH 臨時公鑰
   */
  static initAsAlice(
    sharedSecret: Uint8Array,
    remotePublicKey: Uint8Array,
    ephemeralPrivateKey: Uint8Array,
    ephemeralPublicKey: Uint8Array
  ): Session {
    ensureInitialized();
    return new Session(
      RatchetSession.initAsAlice(sharedSecret, remotePublicKey, ephemeralPrivateKey, ephemeralPublicKey)
    );
  }

  /**
   * 接收者建立會話 (Bob)
   * @param remoteEphemeralPublic - Alice 的臨時公鑰，用於衍生發送鏈金鑰（雙向通訊）
   */
  static initAsBob(
    sharedSecret: Uint8Array,
    signedPrekeyPrivate: Uint8Array,
    signedPrekeyPublic: Uint8Array,
    remoteEphemeralPublic: Uint8Array
  ): Session {
    ensureInitialized();
    return new Session(
      RatchetSession.initAsBob(sharedSecret, signedPrekeyPrivate, signedPrekeyPublic, remoteEphemeralPublic)
    );
  }

  /**
   * 從序列化狀態還原
   */
  static deserialize(bytes: Uint8Array): Session {
    ensureInitialized();
    if (bytes.length === 0) {
      throw new Error('Cannot deserialize empty session state');
    }

    try {
      return new Session(RatchetSession.deserialize(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to deserialize session: ${message}`);
    }
  }

  private ensureUsable(): void {
    if (this.freed) {
      throw new Error('Session has already been freed');
    }
  }

  private restoreFromSnapshot(snapshot: Uint8Array): void {
    const restored = RatchetSession.deserialize(snapshot);
    const current = this.session;
    this.session = restored;
    current.free();
  }

  private runWithRollback<T>(operationName: string, operation: () => T): T {
    this.ensureUsable();

    let snapshot: Uint8Array;
    try {
      snapshot = this.session.serialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to snapshot session before ${operationName}: ${message}`);
    }

    try {
      return operation();
    } catch (operationError) {
      try {
        this.restoreFromSnapshot(snapshot);
      } catch (rollbackError) {
        const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Session ${operationName} failed (${operationMessage}) and rollback failed (${rollbackMessage}).`
        );
      }

      throw operationError;
    } finally {
      snapshot.fill(0);
    }
  }

  /**
   * 加密訊息（含 Padding 防側信道分析）
   */
  encrypt(plaintext: string | Uint8Array): RatchetMessage {
    const data = typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext;
    // 先 Padding 再加密，隱藏訊息真實大小
    const paddedData = padMessage(data);
    return this.runWithRollback('encrypt', () => this.session.encrypt(paddedData));
  }

  /**
   * 加密訊息（不含 Padding，用於向後相容或特殊用途）
   */
  encryptRaw(plaintext: string | Uint8Array): RatchetMessage {
    const data = typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext;
    return this.runWithRollback('encryptRaw', () => this.session.encrypt(data));
  }

  /**
   * 解密訊息（含 Unpadding）
   */
  decrypt(message: RatchetMessage): Uint8Array {
    const decrypted = this.runWithRollback('decrypt', () => this.session.decrypt(message));
    // 嘗試 unpad，如果失敗則返回原始數據（向後相容舊訊息）
    try {
      return unpadMessage(decrypted);
    } catch {
      // 舊訊息沒有 padding，直接返回
      return decrypted;
    }
  }

  /**
   * 解密訊息（不含 Unpadding，用於向後相容或特殊用途）
   */
  decryptRaw(message: RatchetMessage): Uint8Array {
    return this.runWithRollback('decryptRaw', () => this.session.decrypt(message));
  }

  /**
   * 解密訊息為字串
   */
  decryptToString(message: RatchetMessage): string {
    const bytes = this.decrypt(message);
    return new TextDecoder().decode(bytes);
  }

  /**
   * 序列化會話狀態
   */
  serialize(): Uint8Array {
    this.ensureUsable();
    return this.session.serialize();
  }

  /**
   * 取得我方當前 DH 公鑰
   */
  get myPublicKey(): Uint8Array {
    this.ensureUsable();
    return this.session.myPublicKey;
  }

  /**
   * 取得我方當前 DH 公鑰 (Base64)
   */
  get myPublicKeyBase64(): string {
    this.ensureUsable();
    return this.session.myPublicKeyBase64;
  }

  /**
   * 釋放資源
   */
  free(): void {
    if (this.freed) {
      return;
    }
    this.session.free();
    this.freed = true;
  }
}

// ============================================
// 訊息 Padding (E2EE 改善 - 防止訊息大小側信道分析)
// ============================================

const PADDING_BLOCK_SIZE = 256; // bytes

/**
 * 對訊息進行 Padding
 * - 將訊息對齊到 256 bytes 邊界
 * - 前 4 bytes 存儲原始長度 (big-endian)
 * - 填充隨機數據（避免壓縮攻擊）
 */
export function padMessage(data: Uint8Array): Uint8Array {
  // 計算 padding 後的長度：向上取整到最近的 256 bytes
  const paddedLength = Math.ceil((data.length + 4) / PADDING_BLOCK_SIZE) * PADDING_BLOCK_SIZE;
  const padded = new Uint8Array(paddedLength);

  // 前 4 bytes 存原始長度 (big-endian)
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(0, data.length, false);

  // 複製原始數據
  padded.set(data, 4);

  // 其餘填隨機數據（不是零，避免壓縮攻擊）
  if (paddedLength - data.length - 4 > 0) {
    const randomPadding = crypto.getRandomValues(
      new Uint8Array(paddedLength - data.length - 4)
    );
    padded.set(randomPadding, data.length + 4);
  }

  return padded;
}

/**
 * 移除訊息 Padding
 * - 讀取前 4 bytes 取得原始長度
 * - 返回原始訊息
 */
export function unpadMessage(padded: Uint8Array): Uint8Array {
  // 最小長度檢查：至少需要 4 bytes 的長度前綴
  if (padded.length < 4) {
    throw new Error('Invalid padding: buffer too small');
  }

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const originalLength = view.getUint32(0, false);

  // 安全檢查：原始長度不能超過 padded 長度 - 4
  if (originalLength > padded.length - 4) {
    throw new Error('Invalid padding: original length exceeds available data');
  }

  return padded.slice(4, 4 + originalLength);
}

// ============================================
// AES-256-GCM 加密
// ============================================

/**
 * AES-256-GCM 加密器
 */
export class AesCipher {
  private cipher: AesGcmCipher;

  constructor(key: Uint8Array) {
    ensureInitialized();
    if (key.length !== 32) {
      throw new Error('AES key must be 32 bytes');
    }
    this.cipher = new AesGcmCipher(key);
  }

  /**
   * 加密資料
   */
  encrypt(plaintext: string | Uint8Array): EncryptedMessage {
    const data = typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext;
    return this.cipher.encrypt(data);
  }

  /**
   * 加密資料 (附帶關聯資料)
   */
  encryptWithAad(plaintext: string | Uint8Array, aad: Uint8Array): EncryptedMessage {
    const data = typeof plaintext === 'string'
      ? new TextEncoder().encode(plaintext)
      : plaintext;
    return this.cipher.encryptWithAad(data, aad);
  }

  /**
   * 解密資料
   */
  decrypt(encrypted: EncryptedMessage): Uint8Array {
    return this.cipher.decrypt(encrypted);
  }

  /**
   * 解密資料為字串
   */
  decryptToString(encrypted: EncryptedMessage): string {
    const bytes = this.decrypt(encrypted);
    return new TextDecoder().decode(bytes);
  }

  /**
   * 解密資料 (附帶關聯資料)
   */
  decryptWithAad(encrypted: EncryptedMessage, aad: Uint8Array): Uint8Array {
    return this.cipher.decryptWithAad(encrypted, aad);
  }

  free(): void {
    this.cipher.free();
  }
}

/**
 * 快速加密函式
 */
export function quickEncrypt(key: Uint8Array, plaintext: string | Uint8Array): EncryptedMessage {
  ensureInitialized();
  const data = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext;
  return aesEncrypt(key, data);
}

/**
 * 快速解密函式
 */
export function quickDecrypt(key: Uint8Array, encrypted: EncryptedMessage): Uint8Array {
  ensureInitialized();
  return aesDecrypt(key, encrypted);
}

// ============================================
// 工具函式
// ============================================

/**
 * 生成隨機位元組
 */
export function generateRandomBytes(length: number): Uint8Array {
  ensureInitialized();
  return randomBytes(length);
}

/**
 * 生成隨機 AES 金鑰 (32 bytes)
 */
export function generateAesKey(): Uint8Array {
  return generateRandomBytes(32);
}

/**
 * Base64 編碼
 */
export function toBase64(data: Uint8Array): string {
  ensureInitialized();
  return base64Encode(data);
}

/**
 * Base64 解碼
 */
export function fromBase64(data: string): Uint8Array {
  ensureInitialized();
  return base64Decode(data);
}

/**
 * 取得 WASM 版本
 */
export function getCryptoVersion(): string {
  ensureInitialized();
  return version();
}

// ============================================
// 預設導出
// ============================================

export default {
  initCrypto,
  Identity,
  SignedPreKey,
  OneTimePreKey,
  createPreKeyBundle,
  x3dhInitiator,
  x3dhResponder,
  createX3DHMessage,
  Session,
  AesCipher,
  quickEncrypt,
  quickDecrypt,
  generateRandomBytes,
  generateAesKey,
  toBase64,
  fromBase64,
  getCryptoVersion,
  // E2EE 改善：訊息 Padding
  padMessage,
  unpadMessage,
  PADDING_BLOCK_SIZE,
};

// Padding 常數導出
export { PADDING_BLOCK_SIZE };

// ============================================
// E2E 測試支援
// ============================================

// 將 crypto 模組暴露到 window 供 E2E 測試使用（僅限開發環境）
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  Object.defineProperty(window, '__AEGIS_CRYPTO__', {
    get: () => ({
      initCrypto,
      Identity,
      SignedPreKey,
      OneTimePreKey,
      createPreKeyBundle,
      x3dhInitiator,
      x3dhResponder,
      createX3DHMessage,
      Session,
      AesCipher,
      quickEncrypt,
      quickDecrypt,
      generateRandomBytes,
      generateAesKey,
      toBase64,
      fromBase64,
      getCryptoVersion,
      // E2EE 改善：訊息 Padding
      padMessage,
      unpadMessage,
      PADDING_BLOCK_SIZE,
    }),
    configurable: true,
  });

  // 暴露 RatchetMessage 類別 (需要 fromJson 靜態方法)
  Object.defineProperty(window, '__RATCHET_MESSAGE_CLASS__', {
    get: () => RatchetMessage,
    configurable: true,
  });

  // 暴露 Session 清除工具（用於 console 除錯）
  Object.defineProperty(window, 'MistSessionTools', {
    value: Object.freeze({
      /**
       * 清除所有 sessions（保留身份金鑰）
       * 用於解決 session 同步問題
       */
      clearSessions: () => {
        localStorage.removeItem('mist_sessions');
        devLog('[MistSessionTools] ✅ Sessions cleared');
        devLog('[MistSessionTools] Please reload the page and re-add your contacts');
        return 'Sessions cleared. Please reload.';
      },
      /**
       * 清除所有資料（完全重置）
       */
      clearAll: () => {
        localStorage.removeItem('mist_sessions');
        localStorage.removeItem('mist_keys');
        localStorage.removeItem('mist_session_version');
        localStorage.removeItem('mist_wasm_core_version');
        devLog('[MistSessionTools] ✅ All crypto data cleared');
        devLog('[MistSessionTools] Please reload the page to regenerate identity');
        return 'All data cleared. Please reload.';
      },
      /**
       * 顯示當前版本資訊
       */
      getVersionInfo: () => {
        const wasmVersion = localStorage.getItem('mist_wasm_core_version');
        const sessionVersion = localStorage.getItem('mist_session_version');
        const info = {
          wasmCoreVersion: wasmVersion,
          sessionProtocolVersion: sessionVersion,
          currentWasmVersion: getCryptoVersion(),
        };
        devLog('[MistSessionTools] Version info:', info);
        return info;
      },
    }),
    configurable: true,
  });
}

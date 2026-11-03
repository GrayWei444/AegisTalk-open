/**
 * Key Encryption Service - PIN 衍生金鑰加密
 *
 * 使用 Argon2id 從 PIN 衍生 AES-256-GCM 加密金鑰（抗 GPU/ASIC 暴力破解），
 * 用於在 localStorage/SQLite 中加密存放私鑰和 session 資料。
 *
 * 流程：
 * 1. 用戶輸入 PIN → deriveKey(pin, salt) → AES-256-GCM CryptoKey
 * 2. 存入時：encrypt(plaintext, key) → { iv, salt, ciphertext } (base64 JSON)
 * 3. 讀取時：decrypt(encrypted, key) → plaintext
 *
 * 生物辨識登入：
 * - PIN 登入時，CryptoKey 快取到 IndexedDB（non-extractable，raw bytes 永不暴露）
 * - sessionStorage 僅存 marker flag，瀏覽器關閉後 marker 消失
 * - 生物辨識登入時，檢查 marker + 從 IndexedDB 恢復 CryptoKey
 */

import { argon2id } from 'hash-wasm';
import { Capacitor } from '@capacitor/core';
import * as db from './database';
import { toBuffer } from '../utils/toBuffer';
import { devLog, devWarn } from '../utils/devLog';

// Argon2id 參數（memory-hard，抗 GPU/ASIC）
const ARGON2_MEMORY = 65536;     // 64 MiB
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;   // 256-bit
const SALT_KEY = 'aegis_key_salt';
const SESSION_MARKER_KEY = 'aegis_ek_active';
const SESSION_IDB_NAME = 'aegis_ek_session';
const SESSION_IDB_STORE = 'keys';

let _encryptionKey: CryptoKey | null = null;

/** Chunked Uint8Array → base64 (safe for arbitrarily large buffers) */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KB chunks — well under call-stack limits
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

/** base64 → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ============================================
// IndexedDB CryptoKey session cache helpers
// Stores non-extractable CryptoKey directly (raw bytes never exposed)
// ============================================

async function _openSessionIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SESSION_IDB_STORE);
    };
  });
}

async function _cacheKeyToIDB(key: CryptoKey): Promise<void> {
  const idb = await _openSessionIDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
      tx.objectStore(SESSION_IDB_STORE).put(key, 'encryptionKey');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

async function _restoreKeyFromIDB(): Promise<CryptoKey | null> {
  const idb = await _openSessionIDB();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readonly');
      const request = tx.objectStore(SESSION_IDB_STORE).get('encryptionKey');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  } finally {
    idb.close();
  }
}

async function _clearKeyFromIDB(): Promise<void> {
  try {
    const idb = await _openSessionIDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
        tx.objectStore(SESSION_IDB_STORE).delete('encryptionKey');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      idb.close();
    }
  } catch { /* ignore */ }
}


/**
 * 從 PIN 衍生 AES-256-GCM 加密金鑰
 *
 * @param pin - 用戶 PIN
 * @param options - salt: 預設 salt; isInitialSetup: 跳過 salt guard（首次註冊時使用）
 */
export async function deriveEncryptionKey(
  pin: string,
  options?: Uint8Array | { salt?: Uint8Array; isInitialSetup?: boolean },
): Promise<CryptoKey> {
  // Backward compat: second arg can be raw Uint8Array salt
  let salt: Uint8Array | undefined;
  let isInitialSetup = false;
  if (options instanceof Uint8Array) {
    salt = options;
  } else if (options) {
    salt = options.salt;
    isInitialSetup = !!options.isInitialSetup;
  }

  if (!salt) {
    // Try localStorage first (fast), fallback to SQLite (durable)
    let stored = localStorage.getItem(SALT_KEY);
    if (!stored) {
      try { stored = await db.getSetting(SALT_KEY) ?? null; } catch (e) { devWarn('[keyEncryption] SQLite salt fallback failed:', e); }
    }
    if (stored) {
      salt = base64ToBytes(stored);
      // Ensure dual-write: sync localStorage ↔ SQLite
      if (!localStorage.getItem(SALT_KEY)) {
        localStorage.setItem(SALT_KEY, stored);
      }
      db.setSetting(SALT_KEY, stored).catch(() => {});
    } else {
      // Guard: if PIN-encrypted data already exists but salt is missing,
      // generating a new salt guarantees lockout — refuse to proceed.
      // Skip guard for initial setup (first-time registration) or when
      // ephemeral key exists (data is ephemeral-encrypted, not PIN-encrypted).
      if (!isInitialSetup) {
        const hasEphemeralKey = await _hasEphemeralKey();
        if (!hasEphemeralKey) {
          let hasEncryptedData = isEncryptedData(localStorage.getItem('mist_keys') ?? '')
            || isEncryptedData(localStorage.getItem('mist_sessions') ?? '');
          if (!hasEncryptedData) {
            try {
              const dbKeys = await db.getSetting('mist_keys');
              if (dbKeys) hasEncryptedData = isEncryptedData(dbKeys);
            } catch { /* SQLite unavailable */ }
          }
          if (!hasEncryptedData) {
            try {
              const dbSessions = await db.getSetting('mist_sessions');
              if (dbSessions) hasEncryptedData = isEncryptedData(dbSessions);
            } catch { /* SQLite unavailable */ }
          }
          if (hasEncryptedData) {
            throw new Error('Salt missing but encrypted data exists — cannot derive correct key. Data would be unrecoverable.');
          }
        }
      }
      salt = crypto.getRandomValues(new Uint8Array(32));
      const saltB64 = bytesToBase64(salt);
      localStorage.setItem(SALT_KEY, saltB64);
      db.setSetting(SALT_KEY, saltB64).catch(() => {});
    }
  }

  // Argon2id memory-hard derivation
  const hashHex = await argon2id({
    password: pin,
    salt: salt as Uint8Array,
    memorySize: ARGON2_MEMORY,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'hex',
  });
  const rawKey = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < rawKey.length; i++) {
    rawKey[i] = parseInt(hashHex.substring(i * 2, i * 2 + 2), 16);
  }

  // Import as non-extractable AES-GCM CryptoKey
  // Biometric login caches CryptoKey object in IndexedDB (structured clone)
  return crypto.subtle.importKey(
    'raw',
    toBuffer(rawKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 設定目前的加密金鑰（PIN 驗證成功後呼叫）
 * 同時快取 CryptoKey 到 IndexedDB 供同一 session 的生物辨識登入使用
 * 並自動遷移任何明文 mist_keys / mist_sessions 為加密格式
 */
export async function setEncryptionKey(key: CryptoKey): Promise<void> {
  _encryptionKey = key;
  // Cache CryptoKey to IDB (non-extractable, raw bytes never exposed)
  // sessionStorage marker ensures IDB key is only used within same browser session
  try {
    await _cacheKeyToIDB(key);
    sessionStorage.setItem(SESSION_MARKER_KEY, '1');
  } catch {
    // IDB or sessionStorage unavailable
  }
  // Auto-migrate any plaintext/ephemeral-encrypted keys to PIN-encrypted format
  // MUST await so that callers can safely read the re-encrypted data afterward
  try {
    await _migrateStoredKeysIfNeeded(key);
  } catch (err) {
    devWarn('[keyEncryption] Migration failed — plaintext keys may remain unencrypted:', err);
  }
}

/**
 * 遷移明文 mist_keys / mist_sessions 為加密格式
 * 在 setEncryptionKey 後自動呼叫，確保 device transfer 寫入的明文金鑰被加密
 */
async function _migrateStoredKeysIfNeeded(key: CryptoKey): Promise<void> {
  const keysToMigrate = ['mist_keys', 'mist_sessions'];
  for (const storageKey of keysToMigrate) {
    try {
      // Check both localStorage and SQLite (test cleanup may clear one but not both)
      const lsData = localStorage.getItem(storageKey);
      let sqlData: string | null = null;
      try { sqlData = await db.getSetting(storageKey) ?? null; } catch { /* ignore */ }
      const data = lsData || sqlData;
      if (!data) continue;

      if (isEncryptedData(data)) {
        // Already encrypted — try decrypt with real key first
        try {
          await decryptData(data, key);
          // Correctly encrypted with current key — ensure dual-write
          if (!lsData && sqlData) localStorage.setItem(storageKey, sqlData);
          if (lsData && !sqlData) db.setSetting(storageKey, lsData).catch(() => {});
          continue;
        } catch {
          // Can't decrypt with real key — try ephemeral key from sessionStorage
          const plaintext = await tryDecryptWithEphemeralKey(data);
          if (plaintext) {
            const encrypted = await encryptData(plaintext, key);
            localStorage.setItem(storageKey, encrypted);
            db.setSetting(storageKey, encrypted).catch(() => {});
            _dropEphemeralKey();
            devLog(`[keyEncryption] Migrated ephemeral-encrypted ${storageKey} to PIN-encrypted`);
          } else {
            /**
             * 兩把都解不開。⚠️ **不可以刪**（對應群星 B21）：以前這裡直接刪，接著 unlockAndReloadKeys 當成「沒有金鑰」
             * → AppProvider 產一個全新身分蓋掉這個帳號 —— 換機收到資料後、第一次輸 PIN 前重啟過（臨時金鑰以前只在
             * sessionStorage）就會走到，帳號身分永久消失。現在搬到隔離區保留原文，並讓解鎖流程知道「有資料但解不開」
             * → 導去刷臉＋PIN 從雲端恢復（AuthScreen）。新帳號確定、或身分已從雲端還原時才清（clearUnreadableKeys）。
             */
            console.error(`[keyEncryption] ${storageKey} unreadable with PIN key and temp key — quarantined, not deleted`);
            localStorage.setItem(`${storageKey}${QUARANTINE_SUFFIX}`, data);
            db.setSetting(`${storageKey}${QUARANTINE_SUFFIX}`, data).catch(() => {});
            localStorage.removeItem(storageKey);
            db.setSetting(storageKey, '').catch(() => {});
          }
        }
        continue;
      }

      // Plaintext JSON found — encrypt it
      const encrypted = await encryptData(data, key);
      localStorage.setItem(storageKey, encrypted);
      db.setSetting(storageKey, encrypted).catch(() => {});
      devLog(`[keyEncryption] Migrated plaintext ${storageKey} to encrypted`);
    } catch (err) {
      console.error(`[keyEncryption] Failed to migrate ${storageKey}:`, err);
    }
  }

}

/**
 * 從 IndexedDB 恢復加密金鑰（生物辨識登入時呼叫）
 *
 * 安全要求：
 * - 必須有 sessionStorage marker（當前 browser session 曾 PIN 登入）
 * - 或者呼叫方已通過 NativeBiometric 驗證（透過 afterBiometric 參數確認）
 *
 * H15: 不再信任 localStorage 'aegis_biometric_enabled' flag
 * （攻擊者可在 DevTools 設定此 flag 繞過 PIN）
 *
 * CryptoKey 為 non-extractable，即使取得 IDB 存取權也無法匯出原始金鑰。
 */
export async function restoreEncryptionKeyFromSession(afterBiometric = false): Promise<boolean> {
  try {
    const hasSessionMarker = !!sessionStorage.getItem(SESSION_MARKER_KEY);

    /**
     * 網頁版不跨 session 留金鑰（對應群星 A7）：以前刷臉登入帶 afterBiometric=true 就跳過 marker，等於 IndexedDB 裡那把
     * 金鑰永遠有效 —— 拿到這個瀏覽器設定檔、或任何一個 XSS，就能解 mist_keys。網頁的刷臉是純 JS，擋不了這個。
     * 所以網頁版只在同一個瀏覽器 session 內沿用；關掉瀏覽器之後要輸 PIN。原生 App 的 WebView 儲存是 App 私有的，維持原行為。
     */
    const trustBiometric = afterBiometric && Capacitor.isNativePlatform();
    if (!hasSessionMarker && !trustBiometric) {
      // No session marker AND not called after biometric auth — stale IDB key, clean up
      _clearKeyFromIDB().catch(() => {});
      return false;
    }

    const key = await _restoreKeyFromIDB();
    if (!key) return false;
    _encryptionKey = key;

    // Ensure session marker is set for subsequent operations in this session
    if (!hasSessionMarker) {
      try { sessionStorage.setItem(SESSION_MARKER_KEY, '1'); } catch { /* ignore */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 檢查 IndexedDB 是否有快取的 CryptoKey（不觸發恢復，不改變狀態）
 * 用於 face-first 登入判定：有快取 = 生物特徵登入可行
 */
export async function canRestoreEncryptionKey(): Promise<boolean> {
  try {
    // 網頁：沒有這個 session 的 marker 就不算（A7，見 restoreEncryptionKeyFromSession）
    if (!Capacitor.isNativePlatform() && !sessionStorage.getItem(SESSION_MARKER_KEY)) return false;
    const key = await _restoreKeyFromIDB();
    return key !== null;
  } catch {
    return false;
  }
}

/**
 * 取得目前的加密金鑰
 */
export function getEncryptionKey(): CryptoKey | null {
  return _encryptionKey;
}

/**
 * 加密資料為 JSON 字串（含 iv + ciphertext）
 */
export async function encryptData(plaintext: string, key?: CryptoKey): Promise<string> {
  const k = key ?? _encryptionKey;
  if (!k) throw new Error('Encryption key not available');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    k,
    encoder.encode(plaintext),
  );

  const payload = {
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(payload);
}

/**
 * 解密資料
 */
export async function decryptData(encrypted: string, key?: CryptoKey): Promise<string> {
  const k = key ?? _encryptionKey;
  if (!k) throw new Error('Encryption key not available');

  const payload = JSON.parse(encrypted);
  if (payload.v !== 1) throw new Error('Unknown encryption version');

  const iv = base64ToBytes(payload.iv);
  const ct = base64ToBytes(payload.ct);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    k,
    toBuffer(ct),
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * 檢查資料是否為加密格式
 */
export function isEncryptedData(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && parsed.v === 1 && typeof parsed.iv === 'string' && typeof parsed.ct === 'string';
  } catch {
    return false;
  }
}

/**
 * 清除加密金鑰（登出時呼叫）
 */
export function clearEncryptionKey(): void {
  _encryptionKey = null;
  try { sessionStorage.removeItem(SESSION_MARKER_KEY); } catch { /* ignore */ }
  _clearKeyFromIDB().catch(() => {});
}

// ============================================
// Ephemeral key helpers (for protecting keys during recovery/transfer)
// ============================================

const EPHEMERAL_KEY_NAME = 'aegis_eph_key';
/** 解不開的金鑰資料搬到這裡（見 _migrateStoredKeysIfNeeded），不刪 */
const QUARANTINE_SUFFIX = '.unreadable';

/** 本機有「存在但解不開」的身分資料 → 不可以自動產新身分，要走恢復（對應群星 B21） */
export function hasUnreadableKeys(): boolean {
  try { return !!localStorage.getItem(`mist_keys${QUARANTINE_SUFFIX}`); } catch { return false; }
}

/** 新帳號確定、或身分已從雲端還原後呼叫：隔離區的舊資料已經用不到了 */
export function clearUnreadableKeys(): void {
  for (const k of ['mist_keys', 'mist_sessions']) {
    try { localStorage.removeItem(`${k}${QUARANTINE_SUFFIX}`); } catch { /* */ }
    db.setSetting(`${k}${QUARANTINE_SUFFIX}`, '').catch(() => {});
  }
}

/**
 * 臨時金鑰也存一份到 IndexedDB（對應群星 B21）：只放 sessionStorage 的話，換機收到資料後、第一次設 PIN 前
 * 重啟 App，臨時金鑰就沒了，那份資料再也解不開。存的是 CryptoKey 物件；PIN 設好、遷移完就刪。
 */
async function _putEphemeralToIDB(key: CryptoKey | null): Promise<void> {
  const idb = await _openSessionIDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_IDB_STORE);
      if (key) store.put(key, 'ephemeralKey'); else store.delete('ephemeralKey');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

async function _getEphemeralFromIDB(): Promise<CryptoKey | null> {
  try {
    const idb = await _openSessionIDB();
    try {
      return await new Promise<CryptoKey | null>((resolve, reject) => {
        const tx = idb.transaction(SESSION_IDB_STORE, 'readonly');
        const request = tx.objectStore(SESSION_IDB_STORE).get('ephemeralKey');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      idb.close();
    }
  } catch { return null; }
}

async function _hasEphemeralKey(): Promise<boolean> {
  try { if (sessionStorage.getItem(EPHEMERAL_KEY_NAME)) return true; } catch { /* */ }
  return (await _getEphemeralFromIDB()) !== null;
}

function _dropEphemeralKey(): void {
  try { sessionStorage.removeItem(EPHEMERAL_KEY_NAME); } catch { /* ignore */ }
  _putEphemeralToIDB(null).catch(() => {});
}

/**
 * 使用隨機臨時金鑰加密資料（recovery/transfer 時使用）
 * 臨時金鑰存在 sessionStorage＋IndexedDB，PIN 設定後自動遷移為正式加密
 */
export async function encryptWithEphemeralKey(plaintext: string): Promise<string> {
  const ephKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const rawKey = await crypto.subtle.exportKey('raw', ephKey);
  const keyB64 = bytesToBase64(new Uint8Array(rawKey));
  try { sessionStorage.setItem(EPHEMERAL_KEY_NAME, keyB64); } catch { /* ignore */ }
  try { await _putEphemeralToIDB(ephKey); } catch { /* IDB 不能用：退回只有 sessionStorage */ }
  return encryptData(plaintext, ephKey);
}

/**
 * 嘗試用臨時金鑰解密：sessionStorage 那份；重啟過（sessionStorage 沒了）就用 IndexedDB 那份
 */
export async function tryDecryptWithEphemeralKey(encrypted: string): Promise<string | null> {
  let keyB64: string | null = null;
  try { keyB64 = sessionStorage.getItem(EPHEMERAL_KEY_NAME); } catch { /* */ }
  try {
    const ephKey = keyB64
      ? await crypto.subtle.importKey('raw', toBuffer(base64ToBytes(keyB64)), { name: 'AES-GCM' }, false, ['decrypt'])
      : await _getEphemeralFromIDB();
    if (!ephKey) return null;
    return await decryptData(encrypted, ephKey);
  } catch {
    return null;
  }
}

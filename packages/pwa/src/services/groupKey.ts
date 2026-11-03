/**
 * Group Key Service — 群組訊息的 AES-256-GCM 加解密與明文簽章，以及每一代金鑰的讀取。
 *
 * 金鑰只由狀態鏈決定（docs/GROUP_LOG_WIRING_W1.md）：每一代（kid）由 genesis／換金鑰的 commit 指定，金鑰從建群、邀請、
 * log 裡的封裝包或 admin 補發（kc 核對過）進來，寫進 group_keys 的是 groupEngine／groupLogStore。這裡只讀：
 *   - 送訊息只用目前那一代（groupEngine.sendingKey，is_active = 1 的那列）；不雙發、不退回上一代。
 *   - 收訊息用訊息標的 kid 找「這個群」那一代的金鑰（(group_id, key_id) 是主鍵：別的群挑一樣的 kid 也換不掉）。
 */

import * as database from './database';

// ============================================
// 類型定義
// ============================================

export interface GroupKeyRecord {
  groupId: string;
  keyId: string;
  /** AES-256-GCM raw key bytes, Base64 encoded */
  keyBase64: string;
  createdAt: number;
  /** 指定這一代的 commit 作者 */
  createdBy: string;
  /** 鏈上目前那一代 */
  isActive: boolean;
  expiresAt: number;
  /** 指定這一代的 commit 在鏈上的位置（越大越新；createdAt 只是這台存進來的時間） */
  epochV: number;
}

export interface EncryptedGroupMessage {
  /** 用哪一代（kid）加密 */
  keyId: string;
  /** AES-256-GCM 密文 (Base64) */
  ciphertext: string;
  /** AES-256-GCM IV (Base64) */
  iv: string;
}

export interface SignedGroupMessage {
  messageId: string;
  groupId: string;
  senderId: string;
  timestamp: number;
  type: string;
  /** 加密後資料 */
  encrypted: EncryptedGroupMessage;
  /** Ed25519 簽名 (簽明文, Base64) */
  signature: string;
}

// ============================================
// 加密 / 解密
// ============================================

/**
 * 用 Group Key 加密明文
 */
export async function encryptWithGroupKey(
  plaintext: string,
  keyBase64: string,
): Promise<{ ciphertext: string; iv: string }> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    encoded.buffer as ArrayBuffer,
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    iv: bytesToBase64(iv),
  };
}

/**
 * 用 Group Key 解密密文（金鑰不對 → WebCrypto 丟例外）
 */
export async function decryptWithGroupKey(
  ciphertextBase64: string,
  ivBase64: string,
  keyBase64: string,
): Promise<string> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const ciphertext = base64ToBytes(ciphertextBase64);
  const iv = base64ToBytes(ivBase64);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    ciphertext.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(plaintextBuf);
}

// ============================================
// 讀金鑰（寫入只在 groupLogStore）
// ============================================

/** 這個群鏈上目前那一代的金鑰（手上沒有 → null） */
export async function getActiveGroupKey(groupId: string): Promise<GroupKeyRecord | null> {
  const rows = await database.query(
    `SELECT * FROM group_keys WHERE group_id = ? AND is_active = 1 AND origin = 'chain' LIMIT 1`,
    [groupId],
  );
  return rows.length === 0 ? null : rowToRecord(rows[0]);
}

/** 這個群的某一代 */
export async function getGroupKey(groupId: string, keyId: string): Promise<GroupKeyRecord | null> {
  const rows = await database.query(
    `SELECT * FROM group_keys WHERE group_id = ? AND key_id = ? AND origin = 'chain'`,
    [groupId, keyId],
  );
  return rows.length === 0 ? null : rowToRecord(rows[0]);
}

/** 這個群手上所有的世代（新的在前） */
export async function getAllGroupKeys(groupId: string): Promise<GroupKeyRecord[]> {
  const rows = await database.query(
    `SELECT * FROM group_keys WHERE group_id = ? AND origin = 'chain' ORDER BY epoch_v DESC`,
    [groupId],
  );
  return rows.map(rowToRecord);
}

// ============================================
// Ed25519 訊息簽名（ADR-016: 簽明文，防偽造）
// ============================================

/** Identity 簽名函式（由外部注入，避免循環依賴） */
type SignFn = (message: Uint8Array) => Uint8Array;
type VerifyFn = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;

let _signFn: SignFn | null = null;
let _verifyFn: VerifyFn | null = null;

/**
 * 註冊簽名函式（由 useCrypto 或 AppProvider 注入）
 */
export function registerSignFunctions(fns: { sign: SignFn; verify: VerifyFn }): void {
  _signFn = fns.sign;
  _verifyFn = fns.verify;
}

/**
 * 簽署明文（Ed25519）
 */
export function signPlaintext(plaintext: string): string {
  if (!_signFn) {
    console.error('[groupKey] Sign function not registered, returning empty signature');
    return '';
  }
  const data = new TextEncoder().encode(plaintext);
  const sig = _signFn(data);
  const sigB64 = bytesToBase64(sig);
  // [GSIG] 診斷：只印長度與簽章開頭，供與接收端 verify 對比。不印明文 —— console.error 在 prod 保留，
  //   會進 logcat／遠端除錯串流（稽核 H14）
  console.error('[GSIG:SIGN] dataLen=', data.length, 'sigLen=', sig.length, 'sigB64head=', sigB64.slice(0, 24));
  return sigB64;
}

/**
 * 驗證簽名（Ed25519）
 * @param senderPublicKeyBase64 - 發送者公鑰 (Base64)
 * @param plaintext - 原始明文
 * @param signatureBase64 - 簽名 (Base64)
 */
export function verifySignature(
  senderPublicKeyBase64: string,
  plaintext: string,
  signatureBase64: string,
): boolean {
  if (!_verifyFn || !signatureBase64) {
    console.error('[GSIG:VERIFY] early-false: verifyFn=', !!_verifyFn, 'sigEmpty=', !signatureBase64);
    return false;
  }

  try {
    const pubKey = base64ToBytes(senderPublicKeyBase64);
    const data = new TextEncoder().encode(plaintext);
    const sig = base64ToBytes(signatureBase64);
    const result = _verifyFn(pubKey, data, sig);
    // [GSIG] 診斷：印出驗的輸入長度 + 結果，供與發送端 sign 對比（不印明文，稽核 H14）
    console.error('[GSIG:VERIFY] result=', result, 'pubKeyLen=', pubKey.length, 'dataLen=', data.length,
      'sigLen=', sig.length, 'sigB64head=', signatureBase64.slice(0, 24),
      'senderId=', senderPublicKeyBase64.slice(0, 24));
    return result;
  } catch (e) {
    console.error('[GSIG:VERIFY] exception=', (e as Error)?.message || String(e), 'senderId=', senderPublicKeyBase64.slice(0, 24), 'sigB64=', signatureBase64.slice(0, 24));
    return false;
  }
}

// ============================================
// 工具函式
// ============================================

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: any): GroupKeyRecord {
  return {
    groupId: row.group_id,
    keyId: row.key_id,
    keyBase64: row.key_base64,
    createdAt: row.created_at,
    createdBy: row.created_by,
    isActive: row.is_active === 1,
    expiresAt: row.expires_at,
    epochV: Number(row.epoch_v),
  };
}

/**
 * The unlocked identity, read for the community login (keys-only registration) and the recovery kit: mist_keys
 * (localStorage, else the app database) decrypted with the session's PIN-derived key. Nothing is kept: the WASM key
 * object is freed after use, and only the base64 strings the caller asked for leave this module.
 */
import { getEncryptionKey, decryptData, isEncryptedData } from '../../services/keyEncryption';
import { getSetting } from '../../services/database';
import { Identity, fromBase64 } from '../../services/crypto';
import type { IdentitySigner } from '../../services/mqttCredential';

export interface UnlockedIdentity {
  publicKey: string;
  privateKey: string;
}

/** The identity of the unlocked account; null if locked or missing. */
export async function readUnlockedIdentity(): Promise<UnlockedIdentity | null> {
  const key = getEncryptionKey();
  if (!key) return null;
  let raw: string | null = null;
  try { raw = localStorage.getItem('mist_keys'); } catch { /* */ }
  if (!raw) raw = (await getSetting('mist_keys').catch(() => null)) ?? null;
  if (!raw || !isEncryptedData(raw)) return null;
  try {
    const parsed = JSON.parse(await decryptData(raw, key)) as { identity?: { publicKey?: unknown; privateKey?: unknown } };
    const { publicKey, privateKey } = parsed.identity ?? {};
    return typeof publicKey === 'string' && typeof privateKey === 'string' ? { publicKey, privateKey } : null;
  } catch {
    return null;
  }
}

/** Run fn with a signer of the unlocked identity (freed afterwards); null if the identity is not unlocked. */
export async function withIdentitySigner<T>(fn: (signer: IdentitySigner) => Promise<T>): Promise<T | null> {
  const unlocked = await readUnlockedIdentity();
  if (!unlocked) return null;
  const identity = Identity.fromPrivateKey(fromBase64(unlocked.privateKey));
  try {
    if (identity.publicKeyBase64 !== unlocked.publicKey) return null;
    return await fn({ publicKey: identity.publicKeyBase64, sign: (data) => identity.sign(data) });
  } finally {
    identity.free();
  }
}

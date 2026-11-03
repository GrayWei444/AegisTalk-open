/**
 * Change PIN in the community edition (open-source step 5b): the official flow (ext-official/identity/changePin.ts) without
 * the AegisID account key, the cloud blob or the biometric copy — the PIN only protects the keys on this phone.
 *
 * The PIN derives the key that encrypts mist_keys / mist_sessions (keyEncryption, same salt), so changing it re-encrypts
 * both. Crash safety, same as the official edition: before changing anything, an encrypted journal holding the new PIN
 * and the re-encrypted values is written under BOTH the old and the new PIN-derived key; then the values, the session key
 * and the PIN hash are replaced; then the journal is deleted. If the app dies in between, the next unlock (with either
 * PIN) finds the journal and finishes the change (resume).
 * The journal is bound to the identity (owner = public key): one left behind by another account is ignored.
 */
import { getEncryptionKey, deriveEncryptionKey, encryptData, decryptData, setEncryptionKey, isEncryptedData } from '../../services/keyEncryption';
import { getSetting, setSetting, deleteSetting, flushToStore } from '../../services/database';
import { pinAuth, isValidPin, PIN_KEYS } from '../../services/pinAuth';
import type { ChangePinResult, PinChange } from '../types';

export const CHAT_PIN_JOURNAL = 'aegis_pin_change_pending_chat_v1';
const AUTH_KEYS = [PIN_KEYS.hash, PIN_KEYS.salt, PIN_KEYS.backupAuthHash];

interface PendingPin {
  newPin: string;
  owner: string;
  values: Record<string, string>;
}

let changing = false;

async function readStored(key: string): Promise<string | null> {
  let v: string | null = null;
  try { v = localStorage.getItem(key); } catch { /* */ }
  return v ?? (await getSetting(key).catch(() => null)) ?? null;
}

async function currentOwner(): Promise<string | null> {
  return readStored('mist_pubkey_raw');
}

/** The journal opened with `pin` (old or new); null = no journal; throws if one exists but neither key opens it. */
async function pending(pin: string): Promise<PendingPin | null> {
  const raw = await readStored(CHAT_PIN_JOURNAL);
  if (!raw) return null;
  const envelopes = JSON.parse(raw) as { old: string; next: string };
  const key = await deriveEncryptionKey(pin);
  const owner = await currentOwner();
  for (const value of [envelopes.old, envelopes.next]) {
    try {
      const data = JSON.parse(await decryptData(value, key)) as PendingPin;
      if (owner && data.owner !== owner) return null;   // another account's leftover: not ours to apply
      return data;
    } catch { /* try the other PIN version */ }
  }
  throw new Error('pending_pin_change_unreadable');
}

async function applyLocal(data: PendingPin): Promise<void> {
  for (const [key, value] of Object.entries(data.values)) {
    await setSetting(key, value);
    localStorage.setItem(key, value);
  }
  await setEncryptionKey(await deriveEncryptionKey(data.newPin));
  await pinAuth().setPin(data.newPin);
  // pinAuth writes the database copy fire-and-forget: wait for the durable copies here
  for (const key of AUTH_KEYS) {
    const value = localStorage.getItem(key);
    if (!value) throw new Error('missing_pin_hash');
    await setSetting(key, value);
  }
  await flushToStore();
}

async function finish(data: PendingPin): Promise<ChangePinResult> {
  await applyLocal(data);
  await deleteSetting(CHAT_PIN_JOURNAL);
  localStorage.removeItem(CHAT_PIN_JOURNAL);
  await flushToStore();
  return { ok: true };
}

export async function changeChatPin(oldPin: string, newPin: string): Promise<ChangePinResult> {
  if (changing) return { ok: false, code: 'pending' };
  if (!isValidPin(newPin)) return { ok: false, code: 'bad_format' };
  changing = true;
  try {
    if (!(await pinAuth().verifyPin(oldPin))) return { ok: false, code: 'old_wrong' };
    const existing = await pending(oldPin);
    if (existing) return existing.newPin === newPin ? await finish(existing) : { ok: false, code: 'pending' };
    if (oldPin === newPin) return { ok: false, code: 'same_as_old' };
    const oldKey = getEncryptionKey();
    const keys = await readStored('mist_keys');
    const owner = await currentOwner();
    if (!oldKey || !keys || !owner) return { ok: false, code: 'rekey_failed' };
    const plaintext = await decryptData(keys, oldKey);
    if (JSON.parse(plaintext)?.identity?.publicKey !== owner) return { ok: false, code: 'rekey_failed' };
    const nextKey = await deriveEncryptionKey(newPin);
    const values: Record<string, string> = { mist_keys: await encryptData(plaintext, nextKey) };
    const sessions = await readStored('mist_sessions');
    if (sessions) values.mist_sessions = await encryptData(isEncryptedData(sessions) ? await decryptData(sessions, oldKey) : sessions, nextKey);
    const data: PendingPin = { newPin, owner, values };
    const json = JSON.stringify(data);
    const journal = JSON.stringify({ old: await encryptData(json, oldKey), next: await encryptData(json, nextKey) });
    // the recovery material is durable before any active key or PIN verifier changes
    localStorage.setItem(CHAT_PIN_JOURNAL, journal);
    await setSetting(CHAT_PIN_JOURNAL, journal);
    await flushToStore();
    return await finish(data);
  } catch (error) {
    console.error('[ChatChangePin] change incomplete; encrypted journal kept', error instanceof Error ? error.name : 'error');
    return { ok: false, code: (await readStored(CHAT_PIN_JOURNAL).catch(() => null)) ? 'pending' : 'rekey_failed' };
  } finally {
    changing = false;
  }
}

/** Unlock with `pin` (already verified): finish an interrupted change; returns the PIN to derive the key from. */
export async function resumeChatPinChange(pin: string): Promise<string> {
  if (changing) throw new Error('pin_change_busy');
  const data = await pending(pin);
  if (!data) return pin;
  await finish(data);
  return data.newPin;
}

export const chatPinChange: PinChange = {
  change: (oldPin, newPin) => changeChatPin(oldPin, newPin),
  resume: (pin) => resumeChatPinChange(pin),
};

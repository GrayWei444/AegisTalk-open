/**
 * Local PIN for the community edition (owner decision 2026-10-26, Option A: login = local PIN, no AegisID SDK).
 *
 * Re-implemented, not vendored: same Argon2id settings, storage keys and lockout as the official app, so a device
 * transfer between the two can carry the hash and the chat export / unlock flows behave the same.
 *   - hash  = Argon2id(PIN, 32-byte random salt), m = 64 MiB, t = 3, p = 4, 32 bytes; base64 in mist_pin_hash / mist_pin_salt
 *   - backup auth hash = Argon2id(PIN, 'AegisTalk-BackupAuth-v1') in aegis_backup_auth_hash (device transfer field)
 *   - 5 wrong PINs → locked for 5 minutes (mist_failed_attempts / mist_lockout_until)
 * Dual write: localStorage (synchronous reads) + the app database (survives an iOS localStorage wipe), like the SDK.
 * The PIN never leaves the device; nothing here talks to a server.
 */
import { argon2id } from 'hash-wasm';

export const PIN_LENGTH = 6;

const ARGON2 = { memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32 } as const;
const BACKUP_AUTH_SALT = new TextEncoder().encode('AegisTalk-BackupAuth-v1');
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export const PIN_KEYS = {
  hash: 'mist_pin_hash',
  salt: 'mist_pin_salt',
  failedAttempts: 'mist_failed_attempts',
  lockoutUntil: 'mist_lockout_until',
  backupAuthHash: 'aegis_backup_auth_hash',
} as const;

/** Durable settings store (the app database); injectable for tests. */
export interface PinSettingsStore {
  getSetting(key: string): Promise<string | null | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
}

/** Synchronous cache (localStorage); injectable for tests. */
export interface PinCache {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function argon(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({ password: pin, salt, ...ARGON2, outputType: 'binary' });
}

/** Constant-time comparison (length difference counts as a mismatch). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export function createPinAuth(store: PinSettingsStore, cache: PinCache) {
  const write = (key: string, value: string) => {
    cache.setItem(key, value);
    store.setSetting(key, value).catch(() => {});
  };
  const remove = (key: string) => {
    cache.removeItem(key);
    store.deleteSetting(key).catch(() => {});
  };
  const read = async (key: string): Promise<string | null> => cache.getItem(key) ?? (await store.getSetting(key)) ?? null;
  const resetFailedAttempts = () => {
    remove(PIN_KEYS.failedAttempts);
    remove(PIN_KEYS.lockoutUntil);
  };

  const api = {
    async hasPin(): Promise<boolean> {
      return !!((await read(PIN_KEYS.hash)) && (await read(PIN_KEYS.salt)));
    },

    async setPin(pin: string): Promise<void> {
      if (!isValidPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits`);
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const hash = await argon(pin, salt);
      write(PIN_KEYS.hash, b64(hash));
      write(PIN_KEYS.salt, b64(salt));
      resetFailedAttempts();
      write(PIN_KEYS.backupAuthHash, b64(await argon(pin, BACKUP_AUTH_SALT)));
    },

    async verifyPin(pin: string): Promise<boolean> {
      if (api.isLockedOut()) return false;
      const storedHash = await read(PIN_KEYS.hash);
      const storedSalt = await read(PIN_KEYS.salt);
      if (!storedHash || !storedSalt) return false;
      try {
        const ok = sameBytes(await argon(pin, unb64(storedSalt)), unb64(storedHash));
        if (ok) resetFailedAttempts();
        else {
          const attempts = api.getFailedAttempts() + 1;
          write(PIN_KEYS.failedAttempts, String(attempts));
          if (attempts >= MAX_ATTEMPTS) write(PIN_KEYS.lockoutUntil, String(Date.now() + LOCKOUT_MS));
        }
        return ok;
      } catch {
        return false;
      }
    },

    async clearPin(): Promise<void> {
      remove(PIN_KEYS.hash);
      remove(PIN_KEYS.salt);
      remove(PIN_KEYS.backupAuthHash);
    },

    getFailedAttempts(): number {
      const n = parseInt(cache.getItem(PIN_KEYS.failedAttempts) ?? '', 10);
      return Number.isFinite(n) ? n : 0;
    },

    isLockedOut(): boolean {
      const until = parseInt(cache.getItem(PIN_KEYS.lockoutUntil) ?? '', 10);
      if (!Number.isFinite(until)) return false;
      if (Date.now() >= until) {
        resetFailedAttempts();
        return false;
      }
      return true;
    },

    /** Milliseconds until the lock ends (0 = not locked). */
    getLockoutRemaining(): number {
      const until = parseInt(cache.getItem(PIN_KEYS.lockoutUntil) ?? '', 10);
      return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
    },

    /** Device transfer, receiving side: the sender's hash, salt and backup auth hash. */
    async restoreFromTransfer(data: { pinHash?: string; pinSalt?: string; backupAuthHash?: string }): Promise<void> {
      if (data.pinHash && data.pinSalt) {
        write(PIN_KEYS.hash, data.pinHash);
        write(PIN_KEYS.salt, data.pinSalt);
      }
      if (data.backupAuthHash) write(PIN_KEYS.backupAuthHash, data.backupAuthHash);
      resetFailedAttempts();
    },
  };
  return api;
}

export type PinAuth = ReturnType<typeof createPinAuth>;

let _default: PinAuth | null = null;

/** The app's PIN store: localStorage + the app database (imported lazily so this module stays light for tests). */
export function pinAuth(): PinAuth {
  if (!_default) {
    const db: PinSettingsStore = {
      getSetting: async (k) => (await import('./database')).getSetting(k),
      setSetting: async (k, v) => (await import('./database')).setSetting(k, v),
      deleteSetting: async (k) => (await import('./database')).deleteSetting(k),
    };
    _default = createPinAuth(db, localStorage);
  }
  return _default;
}

/**
 * Accounts are per server (open-source step 5c; AegisTrans semantics): the account on this phone belongs to the server
 * it was created on, and is never used on another one.
 *
 *   - owner record: { key, server } of the server the local account belongs to (localStorage + the app database).
 *     Written when the account is created, restored or unlocked on the active server (rememberAccountOwner).
 *     An install that has an account but no record (made before step 5c): it belongs to the build's default server
 *     (official edition: the official service); a build without a default (community) adopts the active server.
 *   - ownerMismatch(): there is a local account and it belongs to another server → App shows ServerMismatchScreen:
 *     switch back to that server, or start over here (wipeLocalAccount, then the normal new-account flow).
 *   - wipeLocalAccount(): everything of the account on this phone — keys, PIN, sessions, contacts, messages, groups and
 *     their chains, presence secrets, outboxes, the owner record. Throws if it fails (the caller aborts).
 */
import {
  DEFAULT_SERVER_KEY, getActiveServer, hasDefaultServer, readCustomServer, type CustomServer,
} from './serverChoice';

export const OWNER_KEY = 'aegistalk_owner_server';

export interface AccountOwner {
  key: string;
  /** the chosen server's settings (null: the build's default server) — to switch back */
  server: CustomServer | null;
}

function parseOwner(raw: string | null | undefined): AccountOwner | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as AccountOwner;
    return o && typeof o.key === 'string' && o.key ? { key: o.key, server: o.server ?? null } : null;
  } catch {
    return null;
  }
}

async function db() {
  return import('./database');
}

/** Is there an account on this phone (keys or a PIN)? Checks the database too (iOS can wipe localStorage). */
export async function hasLocalAccount(): Promise<boolean> {
  try {
    if (localStorage.getItem('mist_keys') || localStorage.getItem('mist_pin_hash')) return true;
  } catch { /* no storage */ }
  try {
    const d = await db();
    return !!((await d.getSetting('mist_keys')) || (await d.getSetting('mist_pin_hash')));
  } catch {
    return false;
  }
}

/** The stored owner record (null: none stored). */
export async function storedAccountOwner(): Promise<AccountOwner | null> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(OWNER_KEY); } catch { /* */ }
  if (!raw) {
    try { raw = (await (await db()).getSetting(OWNER_KEY)) ?? null; } catch { /* */ }
  }
  return parseOwner(raw);
}

/** Who owns the local account (null: there is none, or nothing is known and the active server adopts it). */
export async function localAccountOwner(): Promise<AccountOwner | null> {
  const stored = await storedAccountOwner();
  if (stored) return stored;
  if (!(await hasLocalAccount())) return null;
  // made before step 5c: it belongs to the build's default server; a build without one adopts the active server.
  //   Known residual (security review L5, docs/DIRECT_SEALED.md §7): a community account without an owner record (an install
  //   from before the record existed, or both writes of rememberAccountOwner failed) is used on whatever server is active —
  //   the app does not ask first. Every create / restore / unlock writes the record, so this only affects such old installs.
  return hasDefaultServer() ? { key: DEFAULT_SERVER_KEY, server: null } : null;
}

/** The local account belongs to another server than the active one → that owner; otherwise null. */
export async function ownerMismatch(): Promise<AccountOwner | null> {
  const active = getActiveServer();
  if (!active) return null;
  const owner = await localAccountOwner();
  return owner && owner.key !== active.key ? owner : null;
}

/** The local account belongs to the active server (after creating, restoring or unlocking it here). */
export async function rememberAccountOwner(): Promise<void> {
  const active = getActiveServer();
  if (!active) return;
  const value = JSON.stringify({ key: active.key, server: active.isDefault ? null : readCustomServer() });
  try { localStorage.setItem(OWNER_KEY, value); } catch { /* */ }
  try { await (await db()).setSetting(OWNER_KEY, value); } catch { /* */ }
}

const LOCAL_KEYS = [
  'mist_keys', 'mist_sessions', 'mist_pubkey_raw', 'mist_user_profile', 'mist_pin_hash', 'mist_pin_salt',
  'mist_failed_attempts', 'mist_lockout_until', 'aegis_backup_auth_hash', 'aegis_key_salt', 'aegis_identity_deferred',
  'aegis_session_repair_needed', 'aegis_account_unconfirmed', 'aegis_x3dh_accepted_v1', 'aegis_x3dh_init_iat_v1', 'aegis_file_pending',
  'mist_keys.unreadable', 'mist_sessions.unreadable', OWNER_KEY,
];
const ACCOUNT_TABLES = ['groups', 'group_members', 'group_messages', 'group_keys', 'group_commits', 'group_log_state',
  'group_pending_commits', 'local_user_blacklist'];

/**
 * Remove the local account from this phone (before another account takes over on this server). Throws on failure.
 * seal (default): the web database is sealed afterwards (no more writes this page) and the caller reloads; a caller that
 * writes the next account right away (recovery kit restore) passes seal: false.
 */
export async function wipeLocalAccount(options: { seal?: boolean } = {}): Promise<void> {
  const { wipeLocalKeys } = await import('./deviceClaim');
  await wipeLocalKeys();   // keys, sessions, presence secrets, MQTT + SQLite outboxes, file transfers
  const storage = await import('./storage');
  await storage.clearAllData();   // contacts, messages, conversations, ratchets, outboxes
  const d = await db();
  // plus the account tables the edition registered with the database (database.ts registerEditionSchema; community: none)
  for (const t of [...ACCOUNT_TABLES, ...(d.editionAccountTables?.() ?? [])]) {
    await d.run(`DELETE FROM ${t}`).catch(() => 0);   // a table an older schema does not have
  }
  for (const k of LOCAL_KEYS) {
    try { localStorage.removeItem(k); } catch { /* */ }
    await d.deleteSetting(k).catch(() => {});
  }
  const { clearEncryptionKey } = await import('./keyEncryption');
  clearEncryptionKey();
  await d.flushToStore({ seal: options.seal !== false });
}

/**
 * Restore an account from an opened recovery kit (open-source step 5b; the kit format is services/recoveryKit.ts).
 *
 * Called only after openKit succeeded (wrong passphrase / tampered / truncated kits never get here: nothing is written
 * for them). Before writing anything it checks that the kit's private key really is the kit's identity (the public key
 * derived from it must equal blob.publicKey) — a kit whose parts do not belong together writes nothing either.
 * Then, in order: the server the account belongs to, the identity keys (encrypted with the session key derived from
 * the new PIN; the kit's own signed pre-key is restored so friends' stored bundles stay valid), the contacts with their
 * pre-key bundles, the groups from their signed chains (each re-verified, groupBackup.restoreGroupBackups), the display
 * name, and the flags for after the unlock: rebuild the 1-1 sessions (aegis_session_repair_needed) and confirm the
 * account exists on the server (aegis_account_unconfirmed → ChatAuthScreen registers it again, asking for an invite if
 * the server lost it).
 * The dependencies are injected so the review tests run the real order against real chains (scripts/review).
 */
import type { KitContents } from '../../services/recoveryKit';
import { KitError } from '../../services/recoveryKit';
import type { BlobContact } from '../../services/identityBlob';
import type { CustomServer } from '../../services/serverChoice';

export const SESSION_REPAIR_FLAG = 'aegis_session_repair_needed';
export const ACCOUNT_UNCONFIRMED_FLAG = 'aegis_account_unconfirmed';

export interface KitRestoreDeps {
  /** public key (base64) of an Ed25519 private key (base64) */
  publicKeyOf(privateKeyB64: string): string;
  /** the StoredKeys JSON for mist_keys (identity + the kit's signed pre-key, or a new one) */
  storedKeysJson(blob: KitContents['blob']): string;
  /** encrypt with the session key (derived from the new PIN) */
  encrypt(plaintext: string): Promise<string>;
  /** write mist_keys (localStorage + database) */
  saveKeys(encrypted: string): Promise<void>;
  addContact(c: BlobContact): Promise<void>;
  restoreGroups(groups: KitContents['blob']['groups'], me: string): Promise<number>;
  setDisplayName(name: string): void;
  /** store the account's server as the active choice (null: the build's default) */
  saveServer(server: CustomServer | null): void;
  setFlag(key: string): void;
}

export interface KitRestoreResult {
  publicKey: string;
  contacts: number;
  groups: number;
}

export async function applyKit(contents: KitContents, deps: KitRestoreDeps): Promise<KitRestoreResult> {
  const { blob } = contents;
  let derived: string;
  try {
    derived = deps.publicKeyOf(blob.privateKey);
  } catch {
    throw new KitError('invalid_contents');
  }
  if (derived !== blob.publicKey) throw new KitError('invalid_contents');
  const keysJson = deps.storedKeysJson(blob);   // may throw on a bad signed pre-key: still nothing written

  deps.saveServer(contents.server);
  await deps.saveKeys(await deps.encrypt(keysJson));
  let contacts = 0;
  for (const c of blob.contacts) {
    if (c.publicKey === blob.publicKey) continue;
    try {
      await deps.addContact(c);
      contacts++;
    } catch (err) {
      console.error('[kitRestore] contact not restored:', (err as Error)?.message ?? err);
    }
  }
  const groups = blob.groups.length ? await deps.restoreGroups(blob.groups, blob.publicKey) : 0;
  if (blob.displayName) deps.setDisplayName(blob.displayName);
  if (contacts > 0) deps.setFlag(SESSION_REPAIR_FLAG);
  deps.setFlag(ACCOUNT_UNCONFIRMED_FLAG);
  return { publicKey: blob.publicKey, contacts, groups };
}

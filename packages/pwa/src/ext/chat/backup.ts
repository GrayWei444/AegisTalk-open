/**
 * '@ext/backup' (chat): no server-held backup. The social graph providers and the user's own signed pre-key go to the
 * public blob serializer (services/identityBlob.ts) so the offline recovery kit (services/recoveryKit.ts, exported from
 * Settings) can serialize the account; nothing is written anywhere until the user exports a kit.
 */
import type { IdentityBackup } from '../types';
import { setBlobDataProviders, setOwnSignedPreKey } from '../../services/identityBlob';

export const backup: IdentityBackup = {
  setProviders: (providers) => setBlobDataProviders(providers),
  setOwnSignedPreKey: (spk) => setOwnSignedPreKey(spk),
  markDirty: () => {},
  flushNow: async () => ({ success: true, skipped: 'no-backup' }),
  clear: () => setOwnSignedPreKey(null),
};

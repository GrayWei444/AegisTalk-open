/**
 * The account's portable state ("blob v2"): identity key, display name, contacts (with their pre-key bundles), groups
 * (each with its whole signed state chain, see groupBackup.ts) and the user's own signed pre-key.
 *
 * Public module shared by both editions (open-source step 5b): the official edition seals it into the AegisID cloud blob
 * (ext-official/identity/aegisIdBlob.ts), the community edition encrypts it into the offline recovery kit
 * (recoveryKit.ts). Message history and ratchet sessions are never part of it.
 *
 * The social graph comes from providers injected by main.tsx (projection of the stores), so this module does not import
 * the stores.
 */
import type { BlobContact, BlobGroup, BlobSignedPreKey, BlobDataProviders } from '../ext/types';
export type { BlobContact, BlobGroupMember, BlobGroup, BlobSignedPreKey, BlobDataProviders } from '../ext/types';

/** v2 blob — with the social graph */
export interface IdentityBlobV2 {
  version: 2;
  publicKey: string;
  displayName: string;
  /** Base64 Ed25519 private key */
  privateKey: string;
  contacts: BlobContact[];
  groups: BlobGroup[];
  /** the user's own signed pre-key (with its private part): restoring the same one keeps friends' stored bundles valid */
  signedPreKey?: BlobSignedPreKey;
}

/** v1 blob — old format (no version field: publicKey + displayName + privateKey?) */
interface IdentityBlobV1 {
  publicKey: string;
  displayName: string;
  privateKey?: string;
}

let blobProviders: BlobDataProviders | null = null;
let _ownSignedPreKey: BlobSignedPreKey | null = null;

/** main.tsx (through the edition's backup leaf): where the social graph is read from */
export function setBlobDataProviders(providers: BlobDataProviders | null): void {
  blobProviders = providers;
}

export function getBlobDataProviders(): BlobDataProviders | null {
  return blobProviders;
}

/** useCrypto, when it loads or generates the keys */
export function setOwnSignedPreKey(spk: BlobSignedPreKey | null): void {
  _ownSignedPreKey = spk;
}

export function getOwnSignedPreKey(): BlobSignedPreKey | null {
  return _ownSignedPreKey;
}

/** The current state as a v2 blob object; null without providers or identity. */
export function buildBlob(identity: { publicKey: string | null; privateKey: string | null }): IdentityBlobV2 | null {
  if (!blobProviders || !identity.publicKey || !identity.privateKey) return null;
  return {
    version: 2,
    publicKey: identity.publicKey,
    displayName: blobProviders.getDisplayName(),
    privateKey: identity.privateKey,
    contacts: blobProviders.getContacts(),
    groups: blobProviders.getGroups(),
    ...(_ownSignedPreKey ? { signedPreKey: _ownSignedPreKey } : {}),
  };
}

/** The current state as v2 blob JSON; null without providers or identity. */
export function encodeIdentityBlob(identity: { publicKey: string | null; privateKey: string | null }): string | null {
  const blob = buildBlob(identity);
  return blob ? JSON.stringify(blob) : null;
}

/** Parse blob JSON (or an already parsed object); upgrades v1 to v2 (no contacts / groups). null = not a blob. */
export function decodeIdentityBlob(input: string | unknown): IdentityBlobV2 | null {
  let parsed: Partial<IdentityBlobV2 | IdentityBlobV1>;
  try {
    parsed = (typeof input === 'string' ? JSON.parse(input) : input) as Partial<IdentityBlobV2 | IdentityBlobV1>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.publicKey !== 'string' || typeof parsed.displayName !== 'string') {
    return null;
  }
  if ((parsed as IdentityBlobV2).version === 2) {
    const v2 = parsed as IdentityBlobV2;
    return {
      version: 2,
      publicKey: v2.publicKey,
      displayName: v2.displayName,
      privateKey: typeof v2.privateKey === 'string' ? v2.privateKey : '',
      contacts: Array.isArray(v2.contacts) ? v2.contacts : [],
      groups: Array.isArray(v2.groups) ? v2.groups : [],
      ...(v2.signedPreKey ? { signedPreKey: v2.signedPreKey } : {}),
    };
  }
  return {
    version: 2,
    publicKey: parsed.publicKey,
    displayName: parsed.displayName,
    privateKey: typeof (parsed as IdentityBlobV1).privateKey === 'string' ? (parsed as IdentityBlobV1).privateKey! : '',
    contacts: [],
    groups: [],
  };
}

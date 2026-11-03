/**
 * Offline recovery kit (open-source step 5b, owner decision 1: lost phone = the user's own kit; the server keeps no copy).
 *
 * Contents: the account's blob v2 (services/identityBlob.ts: identity key, display name, contacts with their pre-key
 * bundles, groups each with its whole signed state chain, own signed pre-key) plus the server the account belongs to.
 * Message history and ratchet sessions are not in it (sessions are rebuilt after a restore).
 *
 * File (UTF-8 JSON, versioned, every field but `ct` authenticated):
 *   { "format": "aegistalk-recovery-kit", "v": 1, "created": <unix s>, "pass": "generated" | "chosen",
 *     "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 4, "salt": <base64, 16 bytes> },
 *     "cipher": { "alg": "A256GCM", "iv": <base64, 12 bytes> },
 *     "ct": <base64 AES-256-GCM ciphertext + tag> }
 *   key = Argon2id(passphrase, salt, m = 64 MiB, t = 3, p = 4, 32 bytes); AAD = canonical JSON of the header (all fields
 *   but ct, keys sorted). Changing any header field, the salt, the IV or one bit of ct makes the tag check fail. Only this
 *   exact parameter set is accepted (a crafted kit cannot ask for weaker or absurdly expensive parameters).
 *
 * Passphrase: the app generates one (25 characters from a 32-letter alphabet = 125 bits, shown once, grouped by 5) or the
 * user chooses one that passes passphraseStrength (at least 16 characters, an estimated 72 bits or more). A generated
 * passphrase is accepted with or without the dashes, in any case.
 *
 * openKit never writes anything: it parses, checks the header, decrypts and validates the contents; only a caller that
 * got a KitContents back applies it (ext/chat/kitRestore.ts).
 */
import { argon2id } from 'hash-wasm';
import { decodeIdentityBlob, type IdentityBlobV2 } from './identityBlob';
import { parseCustomServer, type CustomServer } from './serverChoice';
import { toBuffer } from '../utils/toBuffer';

export const KIT_FORMAT = 'aegistalk-recovery-kit';
export const KIT_VERSION = 1;
export const KIT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 4 } as const;
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** a kit is a few hundred KB at most (group chains); refuse anything absurd before parsing */
export const KIT_MAX_BYTES = 8 * 1024 * 1024;
export const GENERATED_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // 32 letters: no l, o, 0, 1
export const GENERATED_LENGTH = 25;
export const MIN_CHOSEN_LENGTH = 16;
export const MIN_CHOSEN_BITS = 72;

export type KitErrorCode =
  | 'not_a_kit'            // not JSON, or not this format
  | 'unsupported_version'  // a newer kit version
  | 'corrupt'              // truncated / malformed fields
  | 'wrong_passphrase'     // tag check failed: wrong passphrase, or the file was changed
  | 'invalid_contents'     // decrypted, but not a usable account
  | 'weak_passphrase';     // createKit with a passphrase that fails the strength rule

export class KitError extends Error {
  constructor(readonly code: KitErrorCode) {
    super(`recovery kit: ${code}`);
    this.name = 'KitError';
  }
}

export interface KitContents {
  blob: IdentityBlobV2;
  /** the server the account belongs to (null: the build's default server) */
  server: CustomServer | null;
  created: number;
}

export interface KitPassphrase {
  value: string;
  generated: boolean;
}

interface KitHeader {
  format: typeof KIT_FORMAT;
  v: typeof KIT_VERSION;
  created: number;
  pass: 'generated' | 'chosen';
  kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string };
  cipher: { alg: 'A256GCM'; iv: string };
}

// ───────────────────────────── encoding helpers ─────────────────────────────

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: unknown, expectLen?: number): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new KitError('corrupt');
  let raw: string;
  try { raw = atob(s); } catch { throw new KitError('corrupt'); }
  const out = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (expectLen !== undefined && out.length !== expectLen) throw new KitError('corrupt');
  return out;
}

/** canonical JSON (keys sorted at every level) — the AAD */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const aadOf = (h: KitHeader): ArrayBuffer => toBuffer(new TextEncoder().encode(canonical(h)));

// ───────────────────────────── passphrase ─────────────────────────────

/** A new passphrase: 25 random letters from GENERATED_ALPHABET (125 bits), shown as 5 groups of 5. */
export function generatePassphrase(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(GENERATED_LENGTH);
  let out = '';
  for (let i = 0; i < GENERATED_LENGTH; i++) out += GENERATED_ALPHABET[bytes[i] & 31];
  return out.match(/.{5}/g)!.join('-');
}

/** What the key is derived from: a generated passphrase without separators, lower case; a chosen one NFKC, trimmed, single spaces. */
export function normalizePassphrase(value: string, generated: boolean): string {
  if (generated) return value.toLowerCase().replace(/[\s-]+/g, '');
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function isGeneratedShape(value: string): boolean {
  const n = normalizePassphrase(value, true);
  return n.length === GENERATED_LENGTH && [...n].every((c) => GENERATED_ALPHABET.includes(c));
}

export interface PassphraseStrength {
  ok: boolean;
  /** estimated bits (character pool × length, with penalties for repeats and runs) */
  bits: number;
  reason?: 'too_short' | 'too_simple';
}

/** Strength of a user-chosen passphrase: at least MIN_CHOSEN_LENGTH characters and an estimated MIN_CHOSEN_BITS bits. */
export function passphraseStrength(value: string): PassphraseStrength {
  const p = normalizePassphrase(value, false);
  const chars = [...p];
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[ !-/:-@[-`{-~]/.test(p)) pool += 33;
  if (/[^\x20-\x7e]/.test(p)) pool += 100;
  // effective length: each character after the same one, or continuing a +1/-1 run (abc, 321), counts a quarter
  let effective = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].codePointAt(0)!;
    const prev = i > 0 ? chars[i - 1].codePointAt(0)! : NaN;
    effective += c === prev || Math.abs(c - prev) === 1 ? 0.25 : 1;
  }
  const distinct = new Set(chars).size;
  const bits = Math.floor(effective * Math.log2(Math.max(pool, 2)) * Math.min(1, distinct / 8));
  if (chars.length < MIN_CHOSEN_LENGTH) return { ok: false, bits, reason: 'too_short' };
  if (bits < MIN_CHOSEN_BITS) return { ok: false, bits, reason: 'too_simple' };
  return { ok: true, bits };
}

async function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({
    password: pass, salt, memorySize: KIT_KDF.m, iterations: KIT_KDF.t, parallelism: KIT_KDF.p, hashLength: 32, outputType: 'binary',
  });
  try {
    return await crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

// ───────────────────────────── create ─────────────────────────────

/** Encrypt the account into a kit file (JSON text). Refuses a chosen passphrase that fails passphraseStrength. */
export async function createKit(contents: { blob: IdentityBlobV2; server: CustomServer | null }, passphrase: KitPassphrase,
  now: number = Date.now()): Promise<string> {
  if (passphrase.generated ? !isGeneratedShape(passphrase.value) : !passphraseStrength(passphrase.value).ok) {
    throw new KitError('weak_passphrase');
  }
  validateContents({ blob: contents.blob, server: contents.server, created: Math.floor(now / 1000) });
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header: KitHeader = {
    format: KIT_FORMAT, v: KIT_VERSION, created: Math.floor(now / 1000), pass: passphrase.generated ? 'generated' : 'chosen',
    kdf: { ...KIT_KDF, salt: b64(salt) }, cipher: { alg: 'A256GCM', iv: b64(iv) },
  };
  const plaintext = new TextEncoder().encode(JSON.stringify({ kit: KIT_FORMAT, v: KIT_VERSION, created: header.created,
    blob: contents.blob, server: contents.server }));
  const key = await deriveKey(normalizePassphrase(passphrase.value, passphrase.generated), salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(iv), additionalData: aadOf(header) }, key, toBuffer(plaintext)));
  plaintext.fill(0);
  return JSON.stringify({ ...header, ct: b64(ct) }, null, 1);
}

// ───────────────────────────── open ─────────────────────────────

/** Parse and check the header (no key derivation yet). */
export function parseKitHeader(text: string): KitHeader & { ct: Uint8Array } {
  if (typeof text !== 'string' || text.length > KIT_MAX_BYTES * 2) throw new KitError('corrupt');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    // a kit cut off in the middle is still recognisably one of ours
    throw new KitError(text.includes(`"${KIT_FORMAT}"`) ? 'corrupt' : 'not_a_kit');
  }
  if (!raw || typeof raw !== 'object' || raw.format !== KIT_FORMAT) throw new KitError('not_a_kit');
  if (raw.v !== KIT_VERSION) throw new KitError(typeof raw.v === 'number' && raw.v > KIT_VERSION ? 'unsupported_version' : 'corrupt');
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'cipher,created,ct,format,kdf,pass,v') throw new KitError('corrupt');
  const kdf = raw.kdf as Record<string, unknown>;
  const cipher = raw.cipher as Record<string, unknown>;
  if (!kdf || typeof kdf !== 'object' || Object.keys(kdf).sort().join(',') !== 'alg,m,p,salt,t'
      || kdf.alg !== KIT_KDF.alg || kdf.m !== KIT_KDF.m || kdf.t !== KIT_KDF.t || kdf.p !== KIT_KDF.p) {
    throw new KitError('corrupt');
  }
  if (!cipher || typeof cipher !== 'object' || Object.keys(cipher).sort().join(',') !== 'alg,iv' || cipher.alg !== 'A256GCM') {
    throw new KitError('corrupt');
  }
  if (raw.pass !== 'generated' && raw.pass !== 'chosen') throw new KitError('corrupt');
  if (typeof raw.created !== 'number' || !Number.isSafeInteger(raw.created) || raw.created < 0) throw new KitError('corrupt');
  unb64(kdf.salt, SALT_BYTES);
  unb64(cipher.iv, IV_BYTES);
  const ct = unb64(raw.ct);
  if (ct.length < 17 || ct.length > KIT_MAX_BYTES) throw new KitError('corrupt');
  return {
    format: KIT_FORMAT, v: KIT_VERSION, created: raw.created, pass: raw.pass,
    kdf: { alg: 'argon2id', m: KIT_KDF.m, t: KIT_KDF.t, p: KIT_KDF.p, salt: kdf.salt as string },
    cipher: { alg: 'A256GCM', iv: cipher.iv as string },
    ct,
  };
}

/** Decrypt and validate a kit. Throws KitError; writes nothing. */
export async function openKit(text: string, passphrase: string): Promise<KitContents> {
  const { ct, ...header } = parseKitHeader(text);
  const key = await deriveKey(normalizePassphrase(passphrase, header.pass === 'generated'), unb64(header.kdf.salt, SALT_BYTES));
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(unb64(header.cipher.iv, IV_BYTES)), additionalData: aadOf(header) }, key, toBuffer(ct)));
  } catch {
    throw new KitError('wrong_passphrase');
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new KitError('invalid_contents');
  } finally {
    plain.fill(0);
  }
  if (!body || body.kit !== KIT_FORMAT || body.v !== KIT_VERSION || body.created !== header.created) throw new KitError('invalid_contents');
  return validateContents({ blob: body.blob, server: body.server, created: header.created });
}

const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

/** Shape checks of the decrypted contents (the private key ↔ public key match is checked by the restore, with the real crypto). */
export function validateContents(c: { blob: unknown; server: unknown; created: number }): KitContents {
  const blob = decodeIdentityBlob(c.blob);
  if (!blob || (c.blob as { version?: unknown })?.version !== 2) throw new KitError('invalid_contents');
  if (!B64_32.test(blob.publicKey) || !B64_32.test(blob.privateKey)) throw new KitError('invalid_contents');
  if (blob.displayName.length > 64) throw new KitError('invalid_contents');
  if (!blob.contacts.every((x) => x && typeof x === 'object' && typeof x.publicKey === 'string' && B64_32.test(x.publicKey))) {
    throw new KitError('invalid_contents');
  }
  if (!blob.groups.every((g) => g && typeof g === 'object' && typeof g.id === 'string')) throw new KitError('invalid_contents');
  let server: CustomServer | null = null;
  if (c.server !== null && c.server !== undefined) {
    server = parseCustomServer(c.server);
    if (!server) throw new KitError('invalid_contents');
  }
  return { blob, server, created: c.created };
}

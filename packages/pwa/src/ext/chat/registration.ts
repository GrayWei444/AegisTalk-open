/**
 * Keys-only account registration, client half (open-source step 5b, owner decision 1; server: api/chat/accounts.py).
 *
 *   POST {server}/api/account/register
 *   body = { action: "account_register", pubkey, timestamp, request_id, invite_code?, signature }
 *   signature = Ed25519 over the canonical JSON of every field but signature (keys sorted, = the server's
 *   json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)) by the identity key itself — the server maps that
 *   key to a fresh random account id; no e-mail, phone or face. request_id is new for every request (single use); the
 *   timestamp is on the server-corrected clock and a 401 clock_skew is answered by re-signing once with the server's time
 *   (signedPost.postSigned). Registering a key that already has an account answers created: false (no invite used).
 *
 * Outcome codes map the server's refusals to clear messages: invite_required, invalid_invite, registration_closed,
 * rate_limited (any 429), unreachable (network), failed (anything else, with the status).
 */
import { canonicalJson, type IdentitySigner } from '../../services/mqttCredential';
import { postSigned, type SignedClock } from '../../services/signedPost';
import { apiBase } from '../../services/apiBase';
import type { RegisterOutcome } from '../types';

export const REGISTER_ACTION = 'account_register';
/** = api/chat/accounts.py INVITE_CODE_PATTERN (checked here so a typo never reaches the server's invite-guess limit as a 422) */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type { RegisterOutcome };
export type RegisterError = Extract<RegisterOutcome, { ok: false }>['code'];

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trim and drop spaces a user may paste around or inside the code. */
export function cleanInviteCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/** The signed request body (what the server's AccountRegisterRequest accepts; nothing else — extra fields are a 422). */
export function signedRegisterBody(signer: IdentitySigner, inviteCode: string | undefined, nowMs: number,
  rid: string = requestId()): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    action: REGISTER_ACTION,
    pubkey: signer.publicKey,
    timestamp: Math.floor(nowMs / 1000),
    request_id: rid,
  };
  if (inviteCode !== undefined) fields.invite_code = inviteCode;
  const signature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(fields))));
  return { ...fields, signature };
}

async function detailOf(res: Response): Promise<string | null> {
  try {
    const d = ((await res.json()) as { detail?: unknown }).detail;
    return typeof d === 'string' ? d : null;
  } catch {
    return null;
  }
}

export interface RegisterDeps {
  clock: SignedClock;
  fetchImpl?: typeof fetch;
  base?: string;
}

/** Register (or confirm) the identity's account on the active server. Never throws. */
export async function registerAccount(signer: IdentitySigner, inviteCode: string | undefined, deps: RegisterDeps): Promise<RegisterOutcome> {
  const code = inviteCode === undefined || inviteCode === '' ? undefined : cleanInviteCode(inviteCode);
  if (code !== undefined && !INVITE_CODE_RE.test(code)) return { ok: false, code: 'invalid_invite' };
  let res: Response;
  try {
    res = await postSigned(`${deps.base ?? apiBase()}/api/account/register`, (nowMs) => signedRegisterBody(signer, code, nowMs),
      deps.clock, deps.fetchImpl ?? fetch);
  } catch {
    return { ok: false, code: 'unreachable' };
  }
  if (res.ok) {
    try {
      const body = (await res.json()) as { registered?: unknown; created?: unknown };
      if (body.registered === true) return { ok: true, created: body.created === true };
    } catch { /* fall through */ }
    return { ok: false, code: 'failed', status: res.status };
  }
  if (res.status === 429) return { ok: false, code: 'rate_limited', status: 429 };
  const detail = await detailOf(res);
  if (res.status === 403 && (detail === 'invite_required' || detail === 'invalid_invite' || detail === 'registration_closed')) {
    return { ok: false, code: detail, status: 403 };
  }
  return { ok: false, code: 'failed', status: res.status };
}

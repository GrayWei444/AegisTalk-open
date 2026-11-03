/**
 * X3DH_INIT from an existing friend must be signed by that friend's identity key (open-source step 5b, step-4 leftover).
 *
 * Why: X3DH_INIT travels in the clear on the broker (a stranger's first INIT has no session to seal it with), and the
 * envelope's `from` is whatever the publisher wrote. Receiving an INIT from an existing friend replaces the session with
 * him (sessionReset: clear the session, the outbox ciphertexts and the WebRTC peer; a new ephemeral: acceptSession
 * replaces the ratchet). So anyone who can publish to my inbox — the operator, any account — could force resets with
 * all my friends at will. A stranger's INIT is already authenticated by its `via` (sealed to my identity key, signed by
 * the sender; friendInvites.ts); a friend's INIT (session repair, PREKEY_REQUEST answer, re-add) carried nothing.
 *
 * Now every INIT carries `auth: { iat, sig }`:
 *   sig = Ed25519 by the sender's identity key over
 *         "aegistalk-x3dh-init-v1\n" + canonical JSON { from, to, eph, spk, spkSig, reset, repair, rspk, iat }
 *   (every field that changes what the receiver does; `to` = the recipient, so it cannot be redirected).
 * The receiver checks it against the friend's stored identity key (= his public key) BEFORE anything else (no rename,
 * no bundle update, no session touched), requires iat within INIT_AUTH_MAX_AGE_MS in the past / INIT_AUTH_MAX_FUTURE_MS
 * ahead (on the server-corrected clock), and lets a friend reset the session at most RESET_BUDGET_MAX times per
 * RESET_BUDGET_WINDOW_MS (a flood of distinct, validly signed INITs — a compromised friend's key — cannot keep my
 * session with him in a reset loop). The same INIT twice is already ignored (x3dhReplay.ts).
 */

export const X3DH_INIT_AUTH_DOMAIN = 'aegistalk-x3dh-init-v1';
export const INIT_AUTH_MAX_AGE_MS = 10 * 60_000;
export const INIT_AUTH_MAX_FUTURE_MS = 2 * 60_000;
export const RESET_BUDGET_MAX = 5;
export const RESET_BUDGET_WINDOW_MS = 10 * 60_000;

/** The INIT fields the signature covers (what the receiver acts on). */
export interface InitAuthFields {
  ephemeralPublicKey?: unknown;
  signedPreKey?: unknown;
  signature?: unknown;
  sessionReset?: unknown;
  repair?: unknown;
  recipientSpk?: unknown;
}

export interface InitAuth {
  iat: number;
  sig: string;
}

export type InitAuthVerdict = 'ok' | 'missing' | 'malformed' | 'stale' | 'bad-signature';

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])));
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The signed bytes. */
export function initAuthMessage(from: string, to: string, p: InitAuthFields, iat: number): Uint8Array {
  const body = {
    from, to, iat,
    eph: strOrNull(p.ephemeralPublicKey),
    spk: strOrNull(p.signedPreKey),
    spkSig: strOrNull(p.signature),
    reset: p.sessionReset === true,
    repair: p.repair === true,
    rspk: strOrNull(p.recipientSpk),
  };
  return new TextEncoder().encode(`${X3DH_INIT_AUTH_DOMAIN}\n${canonical(body)}`);
}

/** The auth field the sender adds to an INIT for `to` (signer = the unlocked identity; iat on the server-corrected clock). */
export function signInitAuth(signer: { me: string; sign: (d: Uint8Array) => Uint8Array }, to: string, p: InitAuthFields,
  nowMs: number): InitAuth {
  const iat = Math.floor(nowMs);
  return { iat, sig: b64(signer.sign(initAuthMessage(signer.me, to, p, iat))) };
}

/** Check an existing friend's INIT: signed by `from` (his stored identity key) for me, fresh. */
export function verifyInitAuth(a: {
  from: string;
  to: string;
  payload: InitAuthFields & { auth?: unknown };
  now: number;
  verify: (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean;
}): InitAuthVerdict {
  const auth = a.payload.auth as Partial<InitAuth> | undefined;
  if (auth === undefined || auth === null) return 'missing';
  if (typeof auth !== 'object' || typeof auth.iat !== 'number' || !Number.isSafeInteger(auth.iat) || typeof auth.sig !== 'string') {
    return 'malformed';
  }
  const pub = unb64(a.from);
  const sig = unb64(auth.sig);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return 'malformed';
  if (!(a.now - auth.iat <= INIT_AUTH_MAX_AGE_MS) || !(auth.iat - a.now <= INIT_AUTH_MAX_FUTURE_MS)) return 'stale';
  let ok = false;
  try {
    ok = a.verify(pub, initAuthMessage(a.from, a.to, a.payload, auth.iat), sig);
  } catch {
    ok = false;
  }
  return ok ? 'ok' : 'bad-signature';
}

/** Per-friend reset budget: at most `max` session resets per `windowMs` from one friend. */
export function createResetBudget(max = RESET_BUDGET_MAX, windowMs = RESET_BUDGET_WINDOW_MS) {
  const hits = new Map<string, number[]>();
  return {
    /** spend one reset for `peer`; false = over budget (do not reset) */
    take(peer: string, now: number): boolean {
      const recent = (hits.get(peer) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(peer, recent);
        return false;
      }
      recent.push(now);
      hits.set(peer, recent);
      if (hits.size > 2000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

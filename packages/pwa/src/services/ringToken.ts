/**
 * 來電者簽章的響鈴 token（開源第 5d 步，docs/DIRECT_SEALED.md §4「Push ring」）。
 *
 * 以前：推播的來電（FCM 全螢幕來電、Web Push 的來電通知）只看推播伺服器給的 senderPubkey —— 營運方（或拿到推播伺服器的人）
 * 能讓手機用好友的名字全螢幕響鈴（後面接不通，但「媽媽來電」已經跳出來了）。
 * 現在：發起方用自己的身分金鑰簽一張 token，經推播伺服器原樣帶到對方手機；手機（原生的 AegisFCMService、JS 的 service worker）
 * 用本機存的好友身分金鑰驗過、夠新鮮、這個 callId 沒響過，才全螢幕響鈴、顯示名字。驗不過 → 不響、不顯示名字（最多一則一般通知）。
 *
 * 格式：`r1.<base64url(claims JSON)>.<base64url(Ed25519 簽章)>`
 *   claims ＝ {"v":1,"d":網域前綴,"callId":…,"from":…,"to":…,"iat":…,"nonce":…,"video":…}：只收這一種寫法（固定的欄位、
 *   順序、沒有空白；CLAIMS_RE），三個實作（這裡、api/chat/push.py、原生 RingToken.kt）用同一個樣式比對 —— 不靠各自的
 *   JSON 解析器（重複的欄位、跳脫字元、數字寫法在不同的解析器各說各話）
 *   簽章內容 ＝ UTF-8(`${前綴}:`) ‖ claims JSON 的原始位元組（簽什麼就驗什麼）
 *   callId 就是那一通（DIRECT_SEALED kind 'call'）的 callId；iat 用有上限的伺服器時鐘（boundedNow：本機時鐘＋API 的時鐘差，
 *   最多 ±5 分鐘 —— 安全審查 H1：營運方回假的 server_time，發起方就會簽一張「下週二」的 token，存起來到時候再推）；nonce 16 bytes 亂數
 * 驗（verifyRingToken，原生 RingToken.kt 同一套規則、同一組測試向量）：
 *   形狀 → 網域 → to 是我 → from 等於推播說的寄件人（有給的話）→ from 是好友（存著的身分金鑰；封鎖的不算）→ 簽章 →
 *   新鮮度（有上限的伺服器時鐘 ±5 分鐘；收件端的時鐘差同樣最多採信 ±5 分鐘，審查 H2）→ 這個 callId 沒看過（看過 ＝ 重放；只記驗過的，
 *   偽造的 token 不能先佔掉一個真的 callId）
 * 伺服器看得到 token（它只有公鑰、callId、時間，沒有名字）；它也先驗一次（api/chat/push.py ring_token_ok），擋掉亂塞的內容。
 *
 * 可移植（群星）：不 import App 的任何東西；網域前綴是參數；簽章與驗章由呼叫端注入（App：身分金鑰／WebCrypto；原生：Tink）。
 */

export const RING_TOKEN_TAG = 'r1';
/** AegisTalk 的網域前綴（跟 DIRECT_SEALED、群組信封、好友 via 都不同） */
export const AEGISTALK_RING_PREFIX = 'aegistalk-ring-v1';
/** 新鮮度：有上限的伺服器時鐘 ±5 分鐘（推播在推播服務最多排 5 分鐘；兩支手機的時鐘差） */
export const RING_MAX_AGE_MS = 5 * 60_000;
export const RING_MAX_FUTURE_MS = 5 * 60_000;
/** 簽、驗兩邊最多採信多少 API 時鐘差（＝ presenceSecret.PRESENCE_MAX_CLOCK_SKEW_MS，W5 的 boundedNow） */
export const RING_CLOCK_CAP_MS = 5 * 60_000;
/**
 * 看過的 callId 留多久（以 iat 起算、照本機時鐘清）：一張 token 在任何（時鐘差在上限內的）收件端還收得下的最後一刻是
 * iat ＋ 新鮮度 ＋ 時鐘差上限；再多留一個上限 —— 營運方撥收件端的時鐘也清不掉還有效的記錄（審查 H2）
 */
export const RING_SEEN_RETENTION_MS = RING_MAX_AGE_MS + RING_MAX_FUTURE_MS + 2 * RING_CLOCK_CAP_MS;

/** 時鐘差最多採信 ±RING_CLOCK_CAP_MS（壞資料 → 0） */
export function clampRingOffset(offsetMs: unknown): number {
  if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) return 0;
  return Math.max(-RING_CLOCK_CAP_MS, Math.min(RING_CLOCK_CAP_MS, offsetMs));
}
export const RING_TOKEN_MAX_LEN = 1024;

const PREFIX_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const TOKEN_RE = /^r1\.([A-Za-z0-9_-]{40,800})\.([A-Za-z0-9_-]{86})$/;
/** callSignalGuard.newCallId：16 bytes base64url */
const CALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 身分公鑰：32 bytes 標準 base64（AegisTalk 的帳號就是這把公鑰） */
const PUBKEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
/** claims 的唯一寫法（JSON.stringify 照 RingClaims 的欄位順序產生的就是這個） */
const CLAIMS_RE = new RegExp('^\\{"v":1,"d":"([a-z0-9][a-z0-9-]{2,39})","callId":"([A-Za-z0-9_-]{22})",'
  + '"from":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)","to":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)",'
  + '"iat":([1-9][0-9]{0,15}),"nonce":"([A-Za-z0-9_-]{22})","video":(true|false)\\}$');

export interface RingClaims {
  v: 1;
  d: string;
  callId: string;
  from: string;
  to: string;
  iat: number;
  nonce: string;
  video: boolean;
}

export type RingRejectReason =
  | 'missing' | 'malformed' | 'wrong-domain' | 'no-context' | 'wrong-recipient' | 'sender-mismatch'
  | 'unknown-caller' | 'bad-signature' | 'stale' | 'future' | 'replay';

export type RingVerdict =
  | { ok: true; from: string; callId: string; video: boolean; iat: number }
  | { ok: false; reason: RingRejectReason };

/**
 * 看過的 callId（一個 callId 只響一次）。App：IndexedDB（service worker）／SharedPreferences（原生）；測試：記憶體。
 * 記錄留到 until，過了才照**本機**時鐘清（營運方撥得動的是 API 的時鐘差，撥不動本機時鐘）；還在的就算看過
 */
export interface RingReplayStore {
  seen(callId: string): boolean | Promise<boolean>;
  remember(callId: string, until: number): void | Promise<void>;
}

export type Ed25519Verify = (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean | Promise<boolean>;

// ───────── 編碼 ─────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64urlEncode(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 標準或 base64url（不補 =）→ bytes；不是正規寫法（多餘的位元不是 0、長度不對）→ null */
function b64Decode(s: string, url: boolean): Uint8Array | null {
  const std = url ? s.replace(/-/g, '+').replace(/_/g, '/') : s;
  const body = url ? std : std.replace(/=+$/, '');
  if (!url && std.length % 4 !== 0) return null;
  if (body.length % 4 === 1) return null;
  for (let i = 0; i < body.length; i++) if (!B64.includes(body[i])) return null;
  let bin: string;
  try {
    bin = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // 正規寫法：重新編碼要一模一樣（擋掉同一組 bytes 的第二種寫法）
  const again = url ? b64urlEncode(out) : bytesToB64(out);
  return again === s ? out : null;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function checkPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new Error('ringToken: bad domain prefix');
}

/** 簽章內容：`${prefix}:` ‖ claims JSON 的位元組 */
export function ringSignedBytes(prefix: string, claimsJson: Uint8Array): Uint8Array {
  checkPrefix(prefix);
  return concat(utf8(`${prefix}:`), claimsJson);
}

function randomId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

// ───────── 簽（發起方） ─────────

/**
 * 發起方：這一通（callId）給 to 的響鈴 token。now ＝ 有上限的伺服器時鐘（boundedNow）；sign ＝ 解鎖中的身分金鑰簽章（不給私鑰）
 */
export function signRingToken(p: {
  prefix: string; callId: string; from: string; to: string; video: boolean; now: number;
  sign: (data: Uint8Array) => Uint8Array; nonce?: string;
}): string {
  checkPrefix(p.prefix);
  if (!CALL_ID_RE.test(p.callId)) throw new Error('ringToken: bad callId');
  if (!PUBKEY_RE.test(p.from) || !PUBKEY_RE.test(p.to)) throw new Error('ringToken: bad public key');
  const claims: RingClaims = {
    v: 1, d: p.prefix, callId: p.callId, from: p.from, to: p.to, iat: Math.floor(p.now), nonce: p.nonce ?? randomId(),
    video: p.video === true,
  };
  if (!NONCE_RE.test(claims.nonce)) throw new Error('ringToken: bad nonce');
  const text = JSON.stringify(claims);
  if (!CLAIMS_RE.test(text)) throw new Error('ringToken: claims out of range');
  const json = utf8(text);
  const sig = p.sign(ringSignedBytes(p.prefix, json));
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error('ringToken: bad signature length');
  return `${RING_TOKEN_TAG}.${b64urlEncode(json)}.${b64urlEncode(sig)}`;
}

// ───────── 驗（收件端） ─────────

/** token 的形狀（不驗簽章、不看是誰）：伺服器、收件端都先過這一關。不合格 → null */
export function parseRingToken(token: unknown): { claims: RingClaims; claimsJson: Uint8Array; sig: Uint8Array } | null {
  if (typeof token !== 'string' || token.length > RING_TOKEN_MAX_LEN) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const claimsJson = b64Decode(m[1], true);
  const sig = b64Decode(m[2], true);
  if (!claimsJson || !sig || sig.length !== 64) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(claimsJson);
  } catch {
    return null;
  }
  const c = CLAIMS_RE.exec(text);
  if (!c) return null;
  const iat = Number(c[5]);
  if (!Number.isSafeInteger(iat)) return null;
  return {
    claims: { v: 1, d: c[1], callId: c[2], from: c[3], to: c[4], iat, nonce: c[6], video: c[7] === 'true' },
    claimsJson, sig,
  };
}

/**
 * 收件端：這張 token 能不能讓手機全螢幕響鈴、顯示名字。
 *   me        我的身分公鑰（沒有 ＝ 沒登入／沒同步 → no-context）
 *   sender    推播伺服器說的寄件人（senderPubkey；有給就要等於 from）
 *   friendKey 好友（沒封鎖的）存著的身分金鑰；不是好友 → null
 *   now       有上限的伺服器時鐘（本機時鐘 ＋ clampRingOffset(時鐘差)）
 *   replay    看過的 callId（驗過才記）
 */
export async function verifyRingToken(p: {
  token: unknown; prefix: string; me: string | null | undefined; sender?: string | null;
  friendKey: (publicKey: string) => string | null | Promise<string | null>;
  verify: Ed25519Verify; now: number; replay: RingReplayStore;
}): Promise<RingVerdict> {
  checkPrefix(p.prefix);
  if (p.token === undefined || p.token === null || p.token === '') return { ok: false, reason: 'missing' };
  const parsed = parseRingToken(p.token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { claims, claimsJson, sig } = parsed;
  if (claims.d !== p.prefix) return { ok: false, reason: 'wrong-domain' };
  if (!p.me) return { ok: false, reason: 'no-context' };
  if (claims.to !== p.me) return { ok: false, reason: 'wrong-recipient' };
  if (typeof p.sender === 'string' && p.sender !== claims.from) return { ok: false, reason: 'sender-mismatch' };
  let stored: string | null;
  try {
    stored = await p.friendKey(claims.from);
  } catch {
    stored = null;
  }
  const key = typeof stored === 'string' ? b64Decode(stored, false) : null;
  if (!key || key.length !== 32) return { ok: false, reason: 'unknown-caller' };
  let good = false;
  try {
    good = (await p.verify(key, ringSignedBytes(p.prefix, claimsJson), sig)) === true;
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad-signature' };
  if (!Number.isFinite(p.now)) return { ok: false, reason: 'stale' };
  if (p.now - claims.iat > RING_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  if (claims.iat - p.now > RING_MAX_FUTURE_MS) return { ok: false, reason: 'future' };
  if (await p.replay.seen(claims.callId)) return { ok: false, reason: 'replay' };
  await p.replay.remember(claims.callId, claims.iat + RING_SEEN_RETENTION_MS);
  return { ok: true, from: claims.from, callId: claims.callId, video: claims.video, iat: claims.iat };
}

/**
 * 看過的 callId 要清掉哪些（純函式，IndexedDB 與記憶體共用）：到期（照本機時鐘）的先清；還是滿的（max 筆）就清最早到期的
 * （同一個人一分鐘最多推 6 通來電：塞滿要好幾個好友一起來，而且清掉的也快要因為太舊被擋了）
 */
export function ringSeenToPrune(entries: ReadonlyArray<readonly [string, number]>, deviceNow: number, max: number): string[] {
  const byExpiry = [...entries].sort((a, b) => a[1] - b[1]);
  const out: string[] = [];
  let size = byExpiry.length;
  for (const [k, until] of byExpiry) {
    if (size < max && until >= deviceNow) break;
    out.push(k);
    size -= 1;
  }
  return out;
}

/** 記憶體裡的「看過的 callId」（測試、沒有持久儲存的地方）；clock ＝ 本機時鐘 */
export function createMemoryRingReplay(max = 512, clock: () => number = () => Date.now()): RingReplayStore & { readonly size: number } {
  const seen = new Map<string, number>();
  return {
    seen(callId) {
      for (const k of ringSeenToPrune([...seen.entries()], clock(), Number.POSITIVE_INFINITY)) seen.delete(k);
      return seen.has(callId);
    },
    remember(callId, until) {
      for (const k of ringSeenToPrune([...seen.entries()], clock(), max)) seen.delete(k);
      seen.set(callId, until);
    },
    get size() { return seen.size; },
  };
}

/**
 * 封給「對方身分金鑰」的信封 —— 群組金鑰的分發、補發與索取用（對應群星 4aee0d93）。
 *
 * 為什麼：群組金鑰以前用 1-1 Double Ratchet 加密後經 P2P 送，那條 session 只有**好友之間**才有。
 * 群組成員不一定是好友（LINE 式群組），非好友成員永遠拿不到輪換後的新金鑰，過了 72 小時雙發就讀不到群訊。
 * 現在：用收件人的 Ed25519 身分公鑰（群組名冊上本來就有）轉成 X25519，做一次性 ECDH 封起來，
 * 經收件人的 MQTT 收件匣送（對方離線時 broker 會排隊）。不需要好友關係、不需要 session。
 *
 * 格式：
 *   外層 { v:1, ek, n, ct }（MQTT broker 只看得到這些）
 *   ek  ＝ 這一封專用的 X25519 臨時公鑰
 *   key ＝ HKDF-SHA256(ikm = X25519(ek, 收件人), salt = ek ‖ 收件人 X25519 公鑰, info = INFO)
 *   ct  ＝ AES-256-GCM(key, n, 內層, aad = "aegistalk-gks-v1|寄件人|收件人")
 *   內層 { c: 內容 JSON 字串, s: 寄件人 Ed25519 簽章(DOMAIN ‖ c) }，內容一定帶 from／to／iat（封裝時間）／nonce（16 bytes 亂數）
 * 拆封：只有收件人算得出 key；寄件人身分靠簽章（不靠 broker —— AegisTalk 的 MQTT 收件匣沒有寄件人後綴、
 * broker 也不檢查 from）；內容的 from／to 必須是這一封的寄件人與自己（成員不能把寫給他的那份轉封給別人冒充原寄件人）；
 * iat 超過 7 天、比現在晚 5 分鐘以上或沒有 → 拒收（深度防禦，對應群星 5aa70b48：MQTT 那層的 24 小時新鮮度不在簽章裡，
 * 舊信封被重放時這裡還擋得住）。
 * 網域字串跟群星不同（aegistalk-…）：兩個 App 的信封互不通用。
 * 同一套也封加好友 X3DH_INIT 的 via（FRIEND_VIA_SEAL，程式碼審查 M2 補強）：網域、AAD、HKDF info 都換成自己的，
 * 群組金鑰信封跟 via 信封互相拿不來用。
 *
 * 金鑰轉換跟 crypto-core 的 X3DH 同一套（x3dh.rs ed25519_to_x25519_*）：
 *   公鑰 u = (1 + y) / (1 − y) mod p（只處理公開資料，可以用 BigInt）
 *   私鑰 = clamp(SHA-512(種子)[0..32])
 * X25519 本身由呼叫端注入（App 用 WASM 的 x25519-dalek，不在 JS 裡做秘密運算；測試用 Node crypto）。
 */

const VERSION = 1;
const DOMAIN = 'aegistalk-gks-v1:';
const AAD_PREFIX = 'aegistalk-gks-v1|';
const INFO = 'AegisTalk-GroupKeySeal-v1';

/** 一種信封用途的網域字串：簽章前綴、AES-GCM AAD 前綴、HKDF info */
export interface SealScheme {
  domain: string;
  aadPrefix: string;
  info: string;
}
/** 群組金鑰的分發／補發／索取（預設） */
export const GROUP_KEY_SEAL: SealScheme = { domain: DOMAIN, aadPrefix: AAD_PREFIX, info: INFO };
/** 加好友 X3DH_INIT 的 via（裡面是憑證的 HMAC proof，見 friendInvites） */
export const FRIEND_VIA_SEAL: SealScheme = {
  domain: 'aegistalk-friend-via-v1:', aadPrefix: 'aegistalk-friend-via-v1|', info: 'AegisTalk-FriendVia-v1',
};
const MAX_CT_BYTES = 64 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * 群組控制的定向信封種類（設計 B2）與各自的密文上限：invite（整條狀態鏈＋目前金鑰）、state（缺的 commit 或移除證明）
 * 可到 512 KB，其餘維持 64 KB（ack＝邀請回條、call＝群組通話的 offer／answer／ICE，W2）。
 * 種類在密文裡、拆之前不知道 → 呼叫端有傳 kindLimits 才先放寬到其中最大的（最多 512 KB），
 * 拆開、驗過簽章後再照 body.kind 核對，不在表上的種類一律拒收。
 * 沒傳 kindLimits（好友 via）行為完全不變：64 KB、不看 kind。
 */
export type GroupSealedKind = 'dist' | 'req' | 'invite' | 'ack' | 'call' | 'state' | 'presence';
export const MAX_LARGE_CT_BYTES = 512 * 1024;
export const GROUP_SEALED_KIND_LIMITS: Readonly<Record<GroupSealedKind, number>> = {
  dist: MAX_CT_BYTES, req: MAX_CT_BYTES, invite: MAX_LARGE_CT_BYTES, ack: MAX_CT_BYTES, call: MAX_CT_BYTES,
  state: MAX_LARGE_CT_BYTES, presence: MAX_CT_BYTES,
};
type KindLimits = Readonly<Record<string, number>>;

const validLimit = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function kindLimit(kindLimits: KindLimits, kind: unknown): number {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(kindLimits, kind)) throw new Error('identitySeal: unknown kind');
  const limit = kindLimits[kind];
  if (!validLimit(limit)) throw new Error('identitySeal: bad kind limit');
  return Math.min(limit, MAX_LARGE_CT_BYTES);
}

/** 拆之前的密文上限：沒有 kindLimits ＝ 原本的 64 KB；表上有 NaN／負數之類的設定錯誤 → 一律拒收 */
function openCtLimit(kindLimits: KindLimits | undefined): number {
  if (!kindLimits) return MAX_CT_BYTES;
  const limits = Object.values(kindLimits);
  if (!limits.every(validLimit)) throw new Error('identitySeal: bad kind limit');
  return Math.min(MAX_LARGE_CT_BYTES, Math.max(0, ...limits));
}

export interface SealedToIdentity {
  v: 1;
  /** 臨時 X25519 公鑰 (Base64) */
  ek: string;
  /** AES-GCM nonce (Base64, 12 bytes) */
  n: string;
  /** 密文 (Base64) */
  ct: string;
}

/** X25519 由呼叫端提供（WASM／Node），私鑰位元組不經過 JS 的大數運算 */
export interface X25519Provider {
  generateX25519(): { publicKey: Uint8Array; privateKey: Uint8Array };
  x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
}

// ============================================
// Ed25519 → X25519
// ============================================

const P = (1n << 255n) - 19n;
// Ed25519 曲線參數 d = −121665/121666 mod p
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => powMod(a, P - 2n);

function leToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function bigToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Ed25519 公鑰 → X25519 公鑰。不在曲線上、恆等點、非正規編碼一律丟例外 */
export function edPublicToX25519(edPublicKey: Uint8Array): Uint8Array {
  if (!(edPublicKey instanceof Uint8Array) || edPublicKey.length !== 32) throw new Error('identitySeal: Ed25519 public key must be 32 bytes');
  const signBit = edPublicKey[31] & 0x80;
  const yBytes = Uint8Array.from(edPublicKey);
  yBytes[31] &= 0x7f;
  const y = leToBig(yBytes);
  if (y >= P) throw new Error('identitySeal: non-canonical Ed25519 public key');
  // 點要在曲線上：x² = (y² − 1) / (d·y² + 1) 必須是平方數
  const y2 = mod(y * y);
  const den = mod(D * y2 + 1n);
  if (den === 0n) throw new Error('identitySeal: invalid Ed25519 public key');
  const x2 = mod(mod(y2 - 1n) * inv(den));
  if (x2 === 0n ? signBit !== 0 : powMod(x2, (P - 1n) / 2n) !== 1n) {
    throw new Error('identitySeal: Ed25519 public key is not a curve point');
  }
  const oneMinusY = mod(1n - y);
  if (oneMinusY === 0n) throw new Error('identitySeal: identity point');
  return bigToLe32(mod((1n + y) * inv(oneMinusY)));
}

/** Ed25519 私鑰種子（32 bytes）→ X25519 純量：SHA-512 的前 32 bytes，clamp */
export async function edSeedToX25519Scalar(seed: Uint8Array): Promise<Uint8Array> {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('identitySeal: Ed25519 seed must be 32 bytes');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', toBuf(seed)));
  const scalar = hash.slice(0, 32);
  hash.fill(0);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

// ============================================
// 封／拆
// ============================================

/**
 * 封給 `to` 的身分金鑰。`body` 是要送的內容（不含 from/to，這裡會補上並一起簽名）。
 */
export async function sealToIdentity(
  params: {
    from: string; to: string; body: Record<string, unknown>; sign: (data: Uint8Array) => Uint8Array;
    /** 封裝時間（測試用；預設現在） */
    now?: number;
    /** 用途的網域字串（預設群組金鑰） */
    scheme?: SealScheme;
    /** 依 body.kind 的密文上限（GROUP_SEALED_KIND_LIMITS）；不在表上的種類、封出來超過上限 → 丟例外。沒傳＝不檢查（原本的行為） */
    kindLimits?: KindLimits;
  },
  deps: X25519Provider,
): Promise<SealedToIdentity> {
  const { from, to, body, sign } = params;
  const scheme = params.scheme ?? GROUP_KEY_SEAL;
  const limit = params.kindLimits ? kindLimit(params.kindLimits, body.kind) : undefined;
  const recipientX = edPublicToX25519(fromB64(to, 32));
  // 簽過名的內容帶封裝時間與亂數（跟下面 AES-GCM 的 12 bytes nonce 無關）
  const contentNonce = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const content = JSON.stringify({ ...body, v: VERSION, from, to, iat: params.now ?? Date.now(), nonce: contentNonce });
  const signature = sign(new TextEncoder().encode(scheme.domain + content));
  const inner = new TextEncoder().encode(JSON.stringify({ c: content, s: toB64(signature) }));

  const eph = deps.generateX25519();
  try {
    const shared = deps.x25519(eph.privateKey, recipientX);
    const key = await deriveKey(shared, eph.publicKey, recipientX, scheme);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuf(nonce), additionalData: aad(scheme, from, to) }, key, toBuf(inner)));
    if (limit !== undefined && ct.length > limit) throw new Error('identitySeal: too large for this kind');
    return { v: VERSION, ek: toB64(eph.publicKey), n: toB64(nonce), ct: toB64(ct) };
  } finally {
    eph.privateKey.fill(0);
  }
}

/**
 * 拆開寄給我的信封。`from` 是傳輸層說的寄件人（MQTT 訊息的 from，沒有驗證過），`to` 是我自己。
 * 驗過簽章、內容的 from/to 對得上才回傳內容；任何一項不符都丟例外。
 */
export async function openFromIdentity(
  params: {
    envelope: unknown;
    from: string;
    to: string;
    myX25519Private: Uint8Array;
    verify: (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean;
    /** 拆封時間（測試用；預設現在） */
    now?: number;
    /** 用途的網域字串（預設群組金鑰）；跟封的時候不同就拆不開 */
    scheme?: SealScheme;
    /** 依 body.kind 的密文上限（GROUP_SEALED_KIND_LIMITS）；沒傳＝原本的 64 KB、不看 kind */
    kindLimits?: KindLimits;
  },
  deps: X25519Provider,
): Promise<Record<string, unknown> & { from: string; to: string }> {
  const { envelope, from, to, myX25519Private, verify } = params;
  const scheme = params.scheme ?? GROUP_KEY_SEAL;
  const env = envelope as Partial<SealedToIdentity> | null;
  if (!env || typeof env !== 'object' || env.v !== VERSION
      || typeof env.ek !== 'string' || typeof env.n !== 'string' || typeof env.ct !== 'string') {
    throw new Error('identitySeal: malformed envelope');
  }
  const ek = fromB64(env.ek, 32);
  const nonce = fromB64(env.n, 12);
  const ct = fromB64(env.ct);
  if (ct.length < 16 || ct.length > openCtLimit(params.kindLimits)) throw new Error('identitySeal: bad ciphertext size');
  const myX = edPublicToX25519(fromB64(to, 32));

  const shared = deps.x25519(myX25519Private, ek);
  const key = await deriveKey(shared, ek, myX, scheme);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuf(nonce), additionalData: aad(scheme, from, to) }, key, toBuf(ct)));

  const inner = JSON.parse(new TextDecoder().decode(plain)) as { c?: unknown; s?: unknown };
  if (typeof inner?.c !== 'string' || typeof inner?.s !== 'string') throw new Error('identitySeal: malformed content');
  const signature = fromB64(inner.s, 64);
  if (!verify(fromB64(from, 32), new TextEncoder().encode(scheme.domain + inner.c), signature)) {
    throw new Error('identitySeal: bad signature');
  }
  const body = JSON.parse(inner.c) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || body.v !== VERSION || body.from !== from || body.to !== to) {
    throw new Error('identitySeal: sender/recipient mismatch');
  }
  const now = params.now ?? Date.now();
  if (typeof body.iat !== 'number' || !Number.isFinite(body.iat) || now - body.iat > MAX_AGE_MS || body.iat - now > MAX_FUTURE_MS) {
    throw new Error('identitySeal: stale or undated envelope');
  }
  if (typeof body.nonce !== 'string' || body.nonce.length < 16 || body.nonce.length > 64) {
    throw new Error('identitySeal: missing nonce');
  }
  if (params.kindLimits && ct.length > kindLimit(params.kindLimits, body.kind)) {
    throw new Error('identitySeal: too large for this kind');
  }
  return body as Record<string, unknown> & { from: string; to: string };
}

// ============================================
// 內部
// ============================================

async function deriveKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientX: Uint8Array, scheme: SealScheme): Promise<CryptoKey> {
  // 低階點（含全零）算出來的共享值是全零 —— 攻擊者知道的值，拒收
  if (shared.length !== 32 || shared.every((b) => b === 0)) {
    shared.fill(0);
    throw new Error('identitySeal: non-contributory key exchange');
  }
  const salt = new Uint8Array(64);
  salt.set(ephemeralPublic, 0);
  salt.set(recipientX, 32);
  try {
    const material = await crypto.subtle.importKey('raw', toBuf(shared), 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toBuf(salt), info: toBuf(new TextEncoder().encode(scheme.info)) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    shared.fill(0);
  }
}

function aad(scheme: SealScheme, from: string, to: string): ArrayBuffer {
  return toBuf(new TextEncoder().encode(scheme.aadPrefix + from + '|' + to));
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string, expectedLength?: number): Uint8Array {
  let bin: string;
  try { bin = atob(s); } catch { throw new Error('identitySeal: bad base64'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (expectedLength !== undefined && out.length !== expectedLength) throw new Error('identitySeal: bad length');
  return out;
}

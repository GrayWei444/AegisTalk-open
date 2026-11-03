/**
 * 群組 log 的 entry 格式與新金鑰封裝包（決定 2026-10-22 log 模型；從 groupLog.ts 拆出來）—— 純函式：沒有 I/O、沒有模組層級的可變狀態。
 *   blob ＝ { k: kid（明文）, n, c: AES-GCM(K_log, n, { commit, bundle? }, AAD = "aegistalk-glog-v1|gid|kid") }
 *   K_log ＝ HKDF(K_e, "aegistalk-glog-v1|gid")，K_e ＝ 這筆 commit 的上一代（parent）金鑰；genesis 用第一代金鑰。
 *   bundle ＝ { ek, to: { 成員公鑰: nonce ‖ AES-GCM(HKDF(X25519(ek, 成員), salt = ek ‖ 成員 X25519, info), 新金鑰, AAD = "aegistalk-gkb-v1|gid|kid|成員") } }
 *   commit 的 args.kb ＝ SHA-256(正規 JSON(bundle))。
 * 套用、作者端、交叉比對在 groupLog.ts（它也會把這裡的東西一起 export）。
 */
import { canonicalJson } from './mqttCredential';
import { edPublicToX25519, type X25519Provider } from './identitySeal';
import {
  deepFreeze, fail, fromB64, sha256, toB64, toB64Url, toBuf, utf8, validKid, validPubkey, wellFormedPubkey, type SignedCommit,
} from './groupStateCommit';

const LOG_LABEL = 'aegistalk-glog-v1|';
const KB_INFO = 'AegisTalk-GroupKeyBundle-v1';
const KB_AAD = 'aegistalk-gkb-v1|';
/** 一筆 log entry（blob 字串）的上限；伺服器也照這個擋 */
export const MAX_ENTRY_BYTES = 64 * 1024;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 新金鑰封裝包：一把臨時 X25519 公鑰，每位收件人一份 nonce ‖ 密文 */
export interface KeyBundle {
  ek: string;
  to: Record<string, string>;
}

/** 伺服器 GET 回來的一筆 */
export interface LogEntry {
  seq: number;
  blob: string;
}

// ============================================
// 加解密小工具
// ============================================

async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', toBuf(ikm), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: toBuf(salt), info: toBuf(utf8(info)) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) fail('bad-key');
}

const logKey = (key: Uint8Array, gid: string): Promise<CryptoKey> => hkdfAesKey(key, new Uint8Array(0), LOG_LABEL + gid);

/**
 * 某一代的「只讀 log」金鑰 K_log ＝ HKDF(K_e, salt 空, "aegistalk-glog-v1|" + gid) 的 32 bytes（跟加解密 log entry 用的是同一把）。
 * 只用在加回舊成員的邀請（決定 2026-10-22 M1 補充）：被加回的人拿上一代的 K_log 對照 log、確認自己那筆 add，然後丟掉。
 * 拿得到它的人只能解那一代的 log entry；推不回 K_e，也推不出 K_ctl、群組主題或聊天金鑰（標籤不同）。絕不能拿來送東西。
 */
export async function logKeyBytes(key: Uint8Array, gid: string): Promise<Uint8Array> {
  checkKey(key);
  const material = await crypto.subtle.importKey('raw', toBuf(key), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuf(utf8(LOG_LABEL + gid)) }, material, 256));
}
const logAad = (gid: string, kid: string): ArrayBuffer => toBuf(utf8(`${LOG_LABEL}${gid}|${kid}`));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ============================================
// 新金鑰封裝包
// ============================================

async function bundleAesKey(shared: Uint8Array, ek: Uint8Array, recipientX: Uint8Array): Promise<CryptoKey> {
  // 低階點（含全零）算出來的共享值是全零 —— 攻擊者知道的值
  if (shared.length !== 32 || shared.every((b) => b === 0)) fail('non-contributory-key-exchange');
  try {
    return await hkdfAesKey(shared, concat(ek, recipientX), KB_INFO);
  } finally {
    shared.fill(0);
  }
}

const bundleAad = (gid: string, kid: string, pk: string): ArrayBuffer => toBuf(utf8(`${KB_AAD}${gid}|${kid}|${pk}`));

async function sealCopy(p: { gid: string; kid: string; key: Uint8Array }, pk: string, eph: { publicKey: Uint8Array; privateKey: Uint8Array }, deps: X25519Provider): Promise<string> {
  if (!validPubkey(pk)) fail('bad-recipient');
  const x = edPublicToX25519(fromB64(pk));
  const aes = await bundleAesKey(deps.x25519(eph.privateKey, x), eph.publicKey, x);
  const n = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(n), additionalData: bundleAad(p.gid, p.kid, pk) }, aes, toBuf(p.key)));
  return toB64(concat(n, ct));
}

/**
 * 把新金鑰封給每位收件人。某一位封不了（公鑰不在曲線上、小階點……）只跳過那一位並回報（skipped），不讓整包失敗（審查 H1）：
 * 那位成員套用時會回報 keyMissing、向 admin 要。一位都封不了才丟例外。
 */
export async function sealKeyBundle(
  p: { gid: string; kid: string; key: Uint8Array; recipients: readonly string[] },
  deps: X25519Provider,
): Promise<{ bundle: KeyBundle; skipped: string[] }> {
  checkKey(p.key);
  if (p.recipients.length < 1 || p.recipients.length > 50 || new Set(p.recipients).size !== p.recipients.length) fail('bad-recipients');
  const eph = deps.generateX25519();
  try {
    const to: Record<string, string> = {};
    const skipped: string[] = [];
    for (const pk of p.recipients) {
      try {
        to[pk] = await sealCopy(p, pk, eph, deps);
      } catch {
        skipped.push(String(pk));
      }
    }
    if (Object.keys(to).length === 0) fail('no-recipient');
    return { bundle: deepFreeze({ ek: toB64(eph.publicKey), to }), skipped };
  } finally {
    eph.privateKey.fill(0);
  }
}

/** commit 的 args.kb：封裝包正規 JSON 的 SHA-256（URL-safe base64） */
export async function bundleHash(bundle: KeyBundle): Promise<string> {
  return toB64Url(await sha256(utf8(canonicalJson(bundle))));
}

/** 封裝包的外形（不解密）；不對 → null */
export function parseBundle(raw: unknown): KeyBundle | null {
  const b = raw as Partial<KeyBundle> | null;
  if (!b || typeof b !== 'object' || typeof b.ek !== 'string' || !B64_RE.test(b.ek) || !b.to || typeof b.to !== 'object') return null;
  const entries = Object.entries(b.to);
  if (Object.keys(b).length !== 2 || entries.length < 1 || entries.length > 50) return null;
  // 收件人欄位只拿來找「我」那一份：格式檢查即可（我的公鑰進名冊時已完整檢查過）
  if (!entries.every(([pk, v]) => wellFormedPubkey(pk) && typeof v === 'string' && B64_RE.test(v))) return null;
  return { ek: b.ek, to: Object.fromEntries(entries) as Record<string, string> };
}

/** 打開封給我的那一份；沒有我的、打不開、長度不對 → null */
export async function openKeyBundle(
  p: { bundle: unknown; gid: string; kid: string; me: string; myX25519Private: Uint8Array },
  deps: X25519Provider,
): Promise<Uint8Array | null> {
  const bundle = parseBundle(p.bundle);
  const copy = bundle?.to[p.me];
  if (!bundle || !copy) return null;
  try {
    const ek = fromB64(bundle.ek);
    const raw = fromB64(copy);
    if (ek.length !== 32 || raw.length !== 12 + 48) return null;
    const aes = await bundleAesKey(deps.x25519(p.myX25519Private, ek), ek, edPublicToX25519(fromB64(p.me)));
    const key = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuf(raw.subarray(0, 12)), additionalData: bundleAad(p.gid, p.kid, p.me) }, aes, toBuf(raw.subarray(12))));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// ============================================
// log entry
// ============================================

export async function sealLogEntry(p: { gid: string; kid: string; key: Uint8Array; commit: SignedCommit; bundle?: KeyBundle }): Promise<string> {
  checkKey(p.key);
  if (!validKid(p.kid)) fail('bad-kid');
  const plain = utf8(JSON.stringify(p.bundle ? { commit: p.commit, bundle: p.bundle } : { commit: p.commit }));
  const n = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(n), additionalData: logAad(p.gid, p.kid) }, await logKey(p.key, p.gid), toBuf(plain)));
  const blob = JSON.stringify({ k: p.kid, n: toB64(n), c: toB64(ct) });
  if (blob.length > MAX_ENTRY_BYTES) fail('entry-too-large');
  return blob;
}

/** blob 外層：格式對才回 { kid, n, c }，否則 null（不解密） */
function parseBlob(blob: unknown): { kid: string; n: Uint8Array; c: Uint8Array } | null {
  if (typeof blob !== 'string' || blob.length > MAX_ENTRY_BYTES) return null;
  try {
    const o = JSON.parse(blob) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Object.keys(o).length !== 3 || !validKid(o.k)) return null;
    if (typeof o.n !== 'string' || typeof o.c !== 'string' || !B64_RE.test(o.n) || !B64_RE.test(o.c)) return null;
    const n = fromB64(o.n);
    const c = fromB64(o.c);
    return n.length === 12 && c.length >= 16 ? { kid: o.k, n, c } : null;
  } catch {
    return null;
  }
}

/** 外層的 kid（明文）；格式不對 → null */
export function peekEntryKid(blob: unknown): string | null {
  return parseBlob(blob)?.kid ?? null;
}

export interface OpenedEntry {
  kid: string;
  commit: unknown;
  bundle?: unknown;
}

/** 解開一筆（用那一代的金鑰 K_e）；解不開或格式不對丟 ChainReject */
export async function openLogEntry(p: { blob: unknown; gid: string; key: Uint8Array }): Promise<OpenedEntry> {
  checkKey(p.key);
  return openWith(p.blob, p.gid, () => logKey(p.key, p.gid));
}

/** 解開一筆（用只讀 log 金鑰 K_log，見 logKeyBytes；只有確認加回舊成員的邀請會用） */
export async function openLogEntryWithLogKey(p: { blob: unknown; gid: string; logKey: Uint8Array }): Promise<OpenedEntry> {
  checkKey(p.logKey);
  return openWith(p.blob, p.gid, () => crypto.subtle.importKey('raw', toBuf(p.logKey), { name: 'AES-GCM' }, false, ['decrypt']));
}

async function openWith(blob: unknown, gid: string, aesKey: () => Promise<CryptoKey>): Promise<OpenedEntry> {
  const outer = parseBlob(blob);
  if (!outer) fail('malformed-entry');
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuf(outer.n), additionalData: logAad(gid, outer.kid) },
      await aesKey(), toBuf(outer.c)));
  } catch {
    fail('undecryptable');
  }
  let inner: Record<string, unknown>;
  try {
    inner = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  } catch {
    fail('malformed-entry');
  }
  if (!inner || typeof inner !== 'object' || !('commit' in inner)) fail('malformed-entry');
  const keys = Object.keys(inner);
  if (keys.some((k) => k !== 'commit' && k !== 'bundle')) fail('malformed-entry');
  return { kid: outer.kid, commit: inner.commit, bundle: inner.bundle };
}

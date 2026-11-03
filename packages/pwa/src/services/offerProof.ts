/**
 * WebRTC offer 附「我持有我們共同群組的群組金鑰」的證明（程式碼審查 H1，成員檢查打開之後）。
 *
 * 為什麼：不認得的人的 offer 收著 15 秒還不認得就丟。我這台的名冊（套上的狀態鏈）可能還沒追到對方加入的那一筆
 * （log 還沒抓到、或我剛上線），而對方不一定是我的好友 → 他的 offer 會被丟，群組通話與送檔連不上。
 *
 * 證明：對每個「我名冊上對方也在」的群（最多 3 個）、我手上這個群最新的幾代金鑰（最多 2 代，照鏈上位置）各算一個
 *   HMAC-SHA256(HKDF(群組金鑰, info), "aegistalk-offer-proof-v1|寄件人|收件人|群組|金鑰 id|時間")
 * 每一項只送 { 那一代的群組主題 id（tid）, HMAC } —— **不送群組 id、也不送金鑰 id**（W3：offer 是收件箱上的明文信令，gid 不能上
 * broker；kid 也不行 —— 群組 log 上每一筆都帶明文 kid、看得到 gid，營運方照 kid 就能把 tid 對回 gid，審查 W3 M3）。tid 本來就是
 * broker 看得到的群組主題。HMAC 的輸入照樣綁群組 id 與金鑰 id。
 * 收件人那邊：用 tid 找本機那一代（群組引擎的主題表：目前這一代、或還在重疊期的上一代；群組與 kid 都由本機決定）、群組在本機、
 * 寄件人不在鏈上的「曾被踢／離開」名單（departed）、時間差在 10 分鐘內、HMAC 對得上 → 當成認得的人（照常回 answer）。只有持有群組
 * 金鑰的人算得出來；被踢的人手上的舊金鑰過不了 departed（也推不出新一代的 tid）。
 * 拿到 DataChannel 不等於拿到群訊：群訊只收鏈上目前成員的（鏈上某一代的金鑰＋本人簽章），我也只扇出給鏈上的成員。
 */

import { deriveTopicId } from './groupControl';

const INFO = 'aegistalk-offer-proof-v1';
const MAX_GROUPS = 3;
const KEYS_PER_GROUP = 2;
const MAX_ITEMS = MAX_GROUPS * KEYS_PER_GROUP;
const MAX_SKEW_MS = 10 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TID_RE = /^[A-Za-z0-9_-]{22}$/;
/** 同一個 tid 在本機最多試幾把（正常是一把；不讓一項證明逼我算一堆 HMAC） */
const MAX_CANDIDATES = 4;

/** 一項證明：沒有群組 id、沒有金鑰 id（W3） */
export interface OfferProofItem {
  /** 那一代的群組主題 id（groupControl.deriveTopicId） */
  t: string;
  /** HMAC（Base64），輸入綁寄件人、收件人、群組 id、金鑰 id、時間 */
  m: string;
}

export interface OfferGroupProof {
  v: 1;
  t: number;
  items: OfferProofItem[];
}

/** epochV：鏈上位置（有就照它挑最新的；沒有才看 createdAt） */
type KeyLike = { keyId: string; groupId: string; keyBase64: string; createdAt: number; epochV?: number };
type GroupLike = { id: string; members: ReadonlyArray<{ publicKey: string }>; departed?: ReadonlyArray<string> };

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function macKey(keyBase64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyBase64);
  try {
    const material = await crypto.subtle.importKey('raw', toBuf(raw), 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuf(new TextEncoder().encode(INFO)) },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    );
  } finally {
    raw.fill(0);
  }
}

function proofMessage(from: string, to: string, groupId: string, keyId: string, t: number): ArrayBuffer {
  return toBuf(new TextEncoder().encode(`${INFO}|${from}|${to}|${groupId}|${keyId}|${t}`));
}

/** 送 offer 時附上：我名冊上對方也在的群（最多 3 個），各用最新的兩代金鑰證明。沒有共同的群回 undefined */
export async function createOfferProof(
  me: string,
  remote: string,
  groups: ReadonlyArray<GroupLike>,
  keysOf: (groupId: string) => Promise<KeyLike[]>,
  now = Date.now(),
): Promise<OfferGroupProof | undefined> {
  const shared = groups
    .filter((g) => ID_RE.test(g.id) && g.members.some((m) => m.publicKey === remote) && !(g.departed ?? []).includes(remote))
    .slice(0, MAX_GROUPS);
  const items: OfferProofItem[] = [];
  for (const g of shared) {
    const keys = (await keysOf(g.id))
      .filter((k) => k.groupId === g.id && ID_RE.test(k.keyId))
      .sort((a, b) => (b.epochV ?? b.createdAt) - (a.epochV ?? a.createdAt))
      .slice(0, KEYS_PER_GROUP);
    for (const k of keys) {
      const raw = b64ToBytes(k.keyBase64);
      let t: string;
      try {
        t = await deriveTopicId(raw, g.id);
      } catch {
        continue;   // 不是 22 字元 gid 的群（不該有）：不證明
      } finally {
        raw.fill(0);
      }
      const sig = await crypto.subtle.sign('HMAC', await macKey(k.keyBase64), proofMessage(me, remote, g.id, k.keyId, now));
      items.push({ t, m: bytesToB64(new Uint8Array(sig)) });
    }
  }
  return items.length > 0 ? { v: 1, t: now, items } : undefined;
}

/**
 * 收到不認得的人的 offer：附的證明有沒有一項是「我本機的某個群、我也持有的那把金鑰、寄件人沒被踢／離開」算出來的。
 * 群組、金鑰 id 都不是對方說的（證明裡沒有）：用 tid 找到我本機那一代（主題表），HMAC 用那個群、那一代驗。
 * 格式不對（多了欄位、例如舊版的群組 id／金鑰 id）、時間差太大、一項都對不上 → false
 */
export async function verifyOfferProof(
  remote: string,
  me: string,
  proof: unknown,
  getGroup: (groupId: string) => GroupLike | undefined,
  /** 本機那一代：主題 id 是這個的（群組引擎的主題表＋本機的金鑰；每一把帶著它屬於哪個群、哪一代） */
  keysForTopic: (tid: string) => Promise<KeyLike[]>,
  now = Date.now(),
): Promise<boolean> {
  const p = proof as Partial<OfferGroupProof> | null;
  if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.t !== 'number' || !Array.isArray(p.items)) return false;
  if (Math.abs(now - p.t) > MAX_SKEW_MS || p.items.length > MAX_ITEMS) return false;
  for (const item of p.items) {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 2) continue;
    const { t, m } = item as Partial<OfferProofItem>;
    if (typeof t !== 'string' || typeof m !== 'string' || !TID_RE.test(t)) continue;
    let sig: Uint8Array;
    try {
      sig = b64ToBytes(m);
    } catch {
      continue;
    }
    if (sig.length !== 32) continue;
    for (const key of (await keysForTopic(t)).filter((x) => ID_RE.test(x.keyId) && ID_RE.test(x.groupId)).slice(0, MAX_CANDIDATES)) {
      const group = getGroup(key.groupId);
      if (!group || group.id !== key.groupId || (group.departed ?? []).includes(remote)) continue;
      // 這把真的是這個 tid 的那一代（主題表查到的，再用金鑰本身核對一次）
      const raw = b64ToBytes(key.keyBase64);
      let derived: string;
      try {
        derived = await deriveTopicId(raw, key.groupId);
      } catch {
        continue;
      } finally {
        raw.fill(0);
      }
      if (derived !== t) continue;
      if (await crypto.subtle.verify('HMAC', await macKey(key.keyBase64), toBuf(sig), proofMessage(remote, me, key.groupId, key.keyId, p.t))) return true;
    }
  }
  return false;
}

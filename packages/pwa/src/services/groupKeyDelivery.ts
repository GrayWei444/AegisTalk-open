/**
 * 群組的定向信封 —— 封給收件人的身分金鑰（identitySeal），經對方的 MQTT 收件匣送（對應群星 c64d268c）。
 *
 * 種類（內容格式與收件規則在 groupEngineTypes／groupEngineSealed，docs/GROUP_LOG_WIRING_W1.md、W2.md）：
 *   invite：整條驗過的狀態鏈＋加入那時的金鑰（≤ 512 KB），我的 add 上鏈之後才送
 *   ack：收到邀請、加入了（邀請者據此停止重送）
 *   req／dist：向 admin 要某一代的金鑰、回答（收端一定照鏈核對 kc）
 *   call：群組通話的 offer／answer／ICE（groupCallService；即時，不排隊、不持久化）
 *   presence：好友之間的 presence 秘密（W4，presenceService：share { s, e }／request { have }；只在好友之間收發）
 * 寄件人身分靠信封裡的 Ed25519 簽章：AegisTalk 的 MQTT 收件匣沒有寄件人後綴、broker 不檢查 from。
 * 不需要好友關係、也不需要 session；收件人離線時 broker 排隊（MQTT 持久 session，見 mqtt.ts DURABLE_TYPES）。
 * MQTT broker 只看得到「誰寄了一封群組信封給誰」，群組 id、鏈與金鑰都在信封裡。
 */
import { mqttService, MessageType } from './mqtt';
import { Identity, x25519Dh, x25519Generate } from './crypto';
import {
  edSeedToX25519Scalar, openFromIdentity, sealToIdentity, FRIEND_VIA_SEAL, GROUP_SEALED_KIND_LIMITS, type X25519Provider,
} from './identitySeal';
import type { ViaSealer } from './friendInvites';

/** 這一版收發的種類（GROUP_SEALED_KIND_LIMITS 裡的 state 留給之後；presence 是 W4） */
const KINDS = ['invite', 'ack', 'req', 'dist', 'call', 'presence'] as const;
export type GroupSealedKindW2 = typeof KINDS[number];
const KIND_LIMITS: Readonly<Record<string, number>> = Object.fromEntries(KINDS.map((k) => [k, GROUP_SEALED_KIND_LIMITS[k]]));

export type OpenedGroupSealed = { kind: GroupSealedKindW2; from: string; body: Record<string, unknown> };

type Sealer = {
  me: string;
  sign: (data: Uint8Array) => Uint8Array;
  /** 自己的 X25519 純量（由身分種子推出，只算一次） */
  x25519Private: Promise<Uint8Array>;
};

let sealer: Sealer | null = null;

export const x25519: X25519Provider = { generateX25519: x25519Generate, x25519: x25519Dh };
export const verify = (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean =>
  Identity.verify(publicKey, data, signature);

/** 解鎖中的身分（群組引擎打開新金鑰封裝包、簽 commit 用）；沒有 → null */
export function currentSealer(): { me: string; sign: (d: Uint8Array) => Uint8Array; x25519Private: Promise<Uint8Array> } | null {
  return sealer ? { me: sealer.me, sign: sealer.sign, x25519Private: sealer.x25519Private } : null;
}

/** 登入（身分金鑰解鎖）後由 AppProvider 呼叫；換帳號會被新的取代 */
export function registerGroupKeySealer(identity: {
  publicKeyBase64: string;
  privateKey: Uint8Array;
  sign: (data: Uint8Array) => Uint8Array;
}): void {
  const seed = identity.privateKey;   // WASM 回傳的複本，用完歸零
  const x25519Private = edSeedToX25519Scalar(seed).finally(() => seed.fill(0));
  x25519Private.catch((e) => console.error('[groupKeyDelivery] cannot derive the X25519 key:', (e as Error)?.message));
  const previous = sealer;
  sealer = { me: identity.publicKeyBase64, sign: (d) => identity.sign(d), x25519Private };
  wipe(previous);
}

/** 登出／換帳號：只清掉這個帳號自己註冊的 */
export function unregisterGroupKeySealer(owner?: string): void {
  if (!sealer || (owner && sealer.me !== owner)) return;
  const previous = sealer;
  sealer = null;
  wipe(previous);
}

function wipe(s: Sealer | null): void {
  s?.x25519Private.then((k) => k.fill(0)).catch(() => { /* 本來就沒算出來 */ });
}

/**
 * 封一則群組信封給 `to`（body.kind ∈ invite／ack／req／dist／call／presence；超過那個種類的上限 → 丟例外）。
 * transient：連著才送、不排隊不持久化（通話信令）；回傳有沒有送出去
 */
export async function sendGroupSealed(to: string, body: Record<string, unknown>, opts: { transient?: boolean } = {}): Promise<boolean> {
  const s = sealer;
  if (!s) throw new Error('groupKeyDelivery: identity not unlocked');
  if (!KINDS.includes(body.kind as GroupSealedKindW2)) throw new Error('groupKeyDelivery: unknown kind');
  // 封裝時間用校正到伺服器的時鐘（收端也用它看新不新鮮；群組通話信令只給 2 分鐘，兩支手機的時鐘差不能算進去）
  const envelope = await sealToIdentity({ from: s.me, to, body, sign: s.sign, kindLimits: KIND_LIMITS, now: mqttService.serverNow() }, x25519);
  if (sealer !== s) throw new Error('groupKeyDelivery: account changed while sealing');
  if (opts.transient) return mqttService.sendTransientToUser(to, MessageType.GROUP_KEY_SEALED, envelope);
  mqttService.sendToUser(to, MessageType.GROUP_KEY_SEALED, envelope);
  return true;
}

/**
 * 拆開 MQTT 收到的 GROUP_KEY_SEALED。`from` 是主題後綴驗過的寄件者，拆封時用他的身分金鑰驗簽章、照種類核對大小。
 * 拆不開、簽章不對、種類不認得 → null（只記 log，不丟例外）。內容欄位由 groupEngineTypes 檢查。
 */
export async function openGroupSealed(from: string, payload: unknown): Promise<OpenedGroupSealed | null> {
  const s = sealer;
  if (!s) {
    console.error('[groupKeyDelivery] sealed group message before the identity was unlocked — dropped');
    return null;
  }
  try {
    // 封裝時間的 7 天窗看校正到伺服器的時鐘（W2 #1：手機時鐘差很多的人也收得到邀請、金鑰）。窗短、重放會被看到的種類另外用
    //   有上限的時鐘再判斷一次（W5）：call 由 groupCallService.handleSignal（2 分鐘）、presence 由 presence 服務；邀請／金鑰／索取
    //   的內容由狀態鏈與 kc 判斷，重放進來只是再看一次同樣的東西
    const body = await openFromIdentity(
      { envelope: payload, from, to: s.me, myX25519Private: await s.x25519Private, verify, kindLimits: KIND_LIMITS, now: mqttService.serverNow() },
      x25519,
    );
    if (KINDS.includes(body.kind as GroupSealedKindW2)) return { kind: body.kind as GroupSealedKindW2, from, body };
    console.error('[groupKeyDelivery] sealed group message of an unknown kind from', from.slice(0, 12));
    return null;
  } catch (e) {
    console.error('[groupKeyDelivery] rejected a sealed group message from', from.slice(0, 12), (e as Error)?.message);
    return null;
  }
}

// ============================================
// 加好友 X3DH_INIT 的 via（審查 M2 補強）
// ============================================

/** 冷啟動時 X3DH_INIT 可能比身分解鎖早一點到：拆 via 最多等這麼久，等的是「收件人那個帳號」的身分 */
const SEALER_WAIT_MS = 8000;

async function sealerFor(me: string, waitMs: number): Promise<Sealer | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const s = sealer;
    if (s && s.me === me) return s;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 加好友 X3DH_INIT 的 via：封給對方的身分金鑰、由我簽名（同一個已登入身分，網域字串 FRIEND_VIA_SEAL，
 * 跟群組金鑰信封互不通用）。INIT 是明文、AegisTalk 的 broker 讓任何人讀任何收件匣 —— 只放 HMAC proof 的話，
 * 短碼只有約 2^30 種，看到 proof 就能離線猜出短碼。封起來之後只有收件人看得到 proof。
 */
export const friendViaSealer: ViaSealer = {
  async seal(to, body) {
    const s = sealer;
    if (!s) throw new Error('friendVia: identity not unlocked');
    const envelope = await sealToIdentity({ from: s.me, to, body, sign: s.sign, scheme: FRIEND_VIA_SEAL }, x25519);
    if (sealer !== s) throw new Error('friendVia: account changed while sealing');
    return envelope;
  },
  async open(from, to, envelope) {
    const s = await sealerFor(to, SEALER_WAIT_MS);
    if (!s) throw new Error('friendVia: identity of the recipient is not unlocked');
    return openFromIdentity(
      { envelope, from, to: s.me, myX25519Private: await s.x25519Private, verify, scheme: FRIEND_VIA_SEAL },
      x25519,
    );
  },
};

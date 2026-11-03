/**
 * DIRECT_SEALED（開源第 4 步，docs/DIRECT_SEALED.md）：1 對 1 的所有信令都封給收件人的身分金鑰。
 *
 * 以前 DataChannel 的 offer／answer／ICE、通話的 request／accept／reject／end 與通話的 offer／answer／ICE、個人資料、
 * 預備金鑰的請求、刪除訊息都是收件箱上的明文：broker 看得到 SDP（IP、DTLS 指紋）與名字，持有 broker 的人（營運方、拿到
 * JWT 簽章金鑰的人）能用任何人的名義塞 offer —— 兩邊各塞一則就是通話的中間人。
 *
 * 現在只有一種 MQTT 型別 direct_sealed，payload 是 identitySeal 的信封（同一套：收件人 Ed25519 → X25519、一次性 ECDH、
 * 寄件人 Ed25519 簽章、內容綁 from／to／iat／nonce），網域字串自己一組（跟群組信封、好友 via 互不通用）。
 * 種類（kind）在密文裡：broker 只看得到「誰寄了一封給誰、多大」。
 *
 * 這個檔可以移植（群星）：不 import App 的任何東西（只有 identitySeal），網域前綴是參數（directScheme）。
 *   kind     內容                                                       新鮮度（校正到伺服器的時鐘）  順序
 *   call     1 對 1 通話：request／accept／reject／end／offer／answer／ice／fp  2 分鐘                     callId＋seq（callSignalGuard）；request 每個寄件人 iat 嚴格遞增
 *   dc       DataChannel：offer／answer／ice／fp                           2 分鐘                     pcId＋iat（webrtc）
 *   profile  名字、頭像（加好友的回覆帶 initEph）                         7 天                       每個寄件人 iat 嚴格遞增
 *   prekey   請對方重新發起 X3DH（附我的 bundle）                         24 小時                    每個寄件人 iat 嚴格遞增
 *   delete   刪除我寄給你的一則 1 對 1 訊息                                24 小時                    （刪除本來就是冪等的）
 * 新鮮度一律看校正到伺服器的時鐘（serverNow）：寄件端也用它蓋 iat，手機時鐘差很多的人也收得到（審查 M1：以前通話／DataChannel
 * 用有上限的 boundedNow —— 手機時鐘差 7 分鐘以上就收不到任何 offer，1 對 1 聊天全斷）。營運方謊報伺服器時間能讓錄下來的信令
 * 看起來還新鮮，擋它的是：(寄件人, nonce) 只收一次；request／profile／prekey 要比上一則新（存在本機，重開也記得）；
 * 其餘信令綁 callId／pcId（隨機、這一通／這一條 PC 才有）；就算整組信令重放，DTLS 指紋對不上也接不通（docs/DIRECT_SEALED.md）。
 * 「上一則」的記錄最多記到有上限的時鐘之後 5 分鐘（審查 L1：營運方把兩邊時鐘都撥到一年後，真的那一則的 iat 不能把之後一年的都擋掉）；
 * 比有上限的時鐘晚一天以上的直接拒收。
 * 大小：密文補到固定的幾級（padBuckets；審查 L6）—— broker 從大小分不出 ICE／指紋／來電控制、語音或視訊的 SDP。
 */
import {
  openFromIdentity, sealToIdentity, type SealScheme, type SealedToIdentity, type X25519Provider,
} from './identitySeal';

export type DirectKind = 'call' | 'dc' | 'profile' | 'prekey' | 'delete';
export const DIRECT_KINDS: readonly DirectKind[] = ['call', 'dc', 'profile', 'prekey', 'delete'];

export interface DirectKindRule {
  /** 密文上限（bytes） */
  maxCt: number;
  /** 封裝時間（iat）最舊多久（校正到伺服器的時鐘） */
  maxAgeMs: number;
  /** 同一個寄件人的這一種要 iat 嚴格遞增（重放舊的不能把狀態改回去） */
  ordered: boolean;
  /** 只有這個 sig 要遞增（通話：request —— 重放舊的來電不能讓手機再響；其他信令綁 callId） */
  orderedSig?: string;
  /** 密文補到這幾級之一（bytes，由小到大；最大的一級不超過 maxCt） */
  padBuckets: readonly number[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KB = 1024;
/** 比現在晚多少還收（兩支手機的時鐘差） */
export const DIRECT_MAX_FUTURE_MS = 5 * MINUTE;
/** 要遞增的種類：iat 比有上限的時鐘晚這麼多以上 → 拒收（營運方把時鐘撥得很遠的那種） */
export const DIRECT_ORDERED_MAX_AHEAD_MS = 24 * HOUR;

export const DIRECT_KIND_RULES: Readonly<Record<DirectKind, DirectKindRule>> = {
  // ICE、指紋、來電控制 1 KB；SDP（DataChannel、語音、視訊都一樣）16 KB
  call: { maxCt: 64 * KB, maxAgeMs: 2 * MINUTE, ordered: true, orderedSig: 'request', padBuckets: [1 * KB, 16 * KB, 64 * KB] },
  dc: { maxCt: 64 * KB, maxAgeMs: 2 * MINUTE, ordered: false, padBuckets: [1 * KB, 16 * KB, 64 * KB] },
  // 頭像是壓過的 JPEG data URL（幾十 KB）：跟群組邀請一樣給到 512 KB（identitySeal 的上限）
  profile: { maxCt: 512 * KB, maxAgeMs: 7 * 24 * HOUR, ordered: true, padBuckets: [1 * KB, 64 * KB, 256 * KB, 512 * KB] },
  prekey: { maxCt: 8 * KB, maxAgeMs: 24 * HOUR, ordered: true, padBuckets: [1 * KB, 8 * KB] },
  delete: { maxCt: 8 * KB, maxAgeMs: 24 * HOUR, ordered: false, padBuckets: [1 * KB, 8 * KB] },
};

const KIND_LIMITS: Readonly<Record<string, number>> = Object.fromEntries(DIRECT_KINDS.map((k) => [k, DIRECT_KIND_RULES[k].maxCt]));

const PREFIX_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

/**
 * 一個 App 的 DIRECT_SEALED 網域：簽章前綴 `${prefix}:`、AES-GCM AAD 前綴 `${prefix}|`、HKDF info `${prefix}/hkdf`。
 * 不同前綴封的信封互相拆不開、簽章也不通用（AegisTalk 跟群星各用自己的）。
 */
export function directScheme(prefix: string): SealScheme {
  if (!PREFIX_RE.test(prefix)) throw new Error('directSeal: bad domain prefix');
  return { domain: `${prefix}:`, aadPrefix: `${prefix}|`, info: `${prefix}/hkdf` };
}

/** AegisTalk 的網域（跟 GROUP_KEY_SEAL、FRIEND_VIA_SEAL 都不同） */
export const AEGISTALK_DIRECT: SealScheme = directScheme('aegistalk-direct-v1');

/** 拆開、驗過的內容：identitySeal 補上的 v／from／to／iat／nonce ＋ 寄件人放的欄位 */
export type DirectBody = Record<string, unknown> & { kind: DirectKind; from: string; to: string; iat: number; nonce: string };

export const isDirectKind = (k: unknown): k is DirectKind => typeof k === 'string' && (DIRECT_KINDS as readonly string[]).includes(k);

/** 補大小用的欄位（內容是 'x'；收端拆開後拿掉） */
const PAD_FIELD = '_pad';
const AES_GCM_TAG = 16;
/** identitySeal 的內容 nonce（16 bytes base64）與 Ed25519 簽章（64 bytes base64）的長度 */
const SEAL_NONCE_B64 = 24;
const SEAL_SIG_B64 = 88;

/**
 * 這個 body 封起來的密文多大（照 identitySeal 的組法：{ c: JSON({...body, v, from, to, iat, nonce}), s: 簽章 } ＋ GCM tag）。
 * v 是 identitySeal 的版本（1）；長度對不上 direct_seal_self_test 會抓到
 */
function sealedCtSize(body: Record<string, unknown>, from: string, to: string, iat: number): number {
  const content = JSON.stringify({ ...body, v: 1, from, to, iat, nonce: 'A'.repeat(SEAL_NONCE_B64) });
  return new TextEncoder().encode(JSON.stringify({ c: content, s: 'A'.repeat(SEAL_SIG_B64) })).length + AES_GCM_TAG;
}

/** 拿掉補大小的欄位（複本） */
function withoutPad<T extends Record<string, unknown>>(o: T): T {
  const copy: Record<string, unknown> = { ...o };
  delete copy[PAD_FIELD];
  return copy as T;
}

/** body 補到這一種最小放得下的那一級（放不下最大一級 → 原樣，identitySeal 會拒） */
function padToBucket(body: Record<string, unknown> & { kind: DirectKind }, from: string, to: string, iat: number): Record<string, unknown> {
  const base = { ...body, [PAD_FIELD]: '' };
  const size = sealedCtSize(base, from, to, iat);
  const bucket = DIRECT_KIND_RULES[body.kind].padBuckets.find((b) => b >= size);
  return bucket === undefined ? body : { ...body, [PAD_FIELD]: 'x'.repeat(bucket - size) };
}

/**
 * 封一則給 `to`。body.kind 必須是 DIRECT_KINDS 之一；from／to／iat／nonce 由這裡（identitySeal）蓋上，body 裡寫的不算。
 * now：校正到伺服器的時鐘（收端也用它判新鮮）。密文補到 padBuckets 的一級
 */
export async function sealDirect(
  p: { from: string; to: string; body: Record<string, unknown> & { kind: DirectKind }; sign: (data: Uint8Array) => Uint8Array; now: number; scheme: SealScheme },
  deps: X25519Provider,
): Promise<SealedToIdentity> {
  if (!isDirectKind(p.body.kind)) throw new Error('directSeal: unknown kind');
  const body = padToBucket(withoutPad(p.body), p.from, p.to, p.now);
  return sealToIdentity({ from: p.from, to: p.to, body, sign: p.sign, now: p.now, scheme: p.scheme, kindLimits: KIND_LIMITS }, deps);
}

/**
 * 拆一則寄給我（to）的。storedKey ＝ 寄件人在我這台存的身分金鑰（好友、名冊上的那一把；陌生人 ＝ 他自稱的 from）——
 * 簽章用它驗，不用主題上的寄件人那一節（營運方能在任何主題上發）。AegisTalk 的帳號公鑰就是身分金鑰本身，所以
 * storedKey 一定要跟 from 一字不差。
 * now：校正到伺服器的時鐘 —— identitySeal 本身的 7 天窗與種類自己的窗（DIRECT_KIND_RULES）。任何一項不對都丟例外。
 * 回傳的內容拿掉了補大小的欄位。
 */
export async function openDirect(
  p: {
    envelope: unknown; from: string; to: string; storedKey: string; myX25519Private: Uint8Array;
    verify: (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean;
    now: number; scheme: SealScheme;
  },
  deps: X25519Provider,
): Promise<DirectBody> {
  if (typeof p.storedKey !== 'string' || p.storedKey !== p.from) throw new Error('directSeal: sender is not the stored identity');
  const opened = await openFromIdentity({
    envelope: p.envelope, from: p.storedKey, to: p.to, myX25519Private: p.myX25519Private, verify: p.verify,
    now: p.now, scheme: p.scheme, kindLimits: KIND_LIMITS,
  }, deps);
  if (!isDirectKind(opened.kind)) throw new Error('directSeal: unknown kind');
  const rule = DIRECT_KIND_RULES[opened.kind];
  const iat = opened.iat as number;
  if (p.now - iat > rule.maxAgeMs || iat - p.now > DIRECT_MAX_FUTURE_MS) throw new Error('directSeal: stale or future envelope');
  return withoutPad(opened) as DirectBody;
}

/** 每個寄件人、每一種「要遞增」的最後一個 iat（App 存在 localStorage：重開之後重放舊的也擋得住） */
export interface MarkStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
}

export type ReplayVerdict = 'ok' | 'replay' | 'out-of-order';

/** 判斷用的兩個時鐘：server ＝ 校正到伺服器的（新鮮度）、bounded ＝ 伺服器時鐘差最多採信 ±5 分鐘的（W5；「上一則」記錄的上限） */
export interface DirectClocks {
  server: number;
  bounded: number;
}

/** 要遞增的是哪一條記錄（不用遞增 → null） */
function markKeyOf(body: DirectBody): string | null {
  const rule = DIRECT_KIND_RULES[body.kind];
  if (!rule.ordered) return null;
  if (rule.orderedSig === undefined) return `${body.from}|${body.kind}`;
  return body.sig === rule.orderedSig ? `${body.from}|${body.kind}|${rule.orderedSig}` : null;
}

/**
 * 重放判斷：(寄件人, nonce) 看過就拒（記到那一則過期為止）；ordered 的另外要 iat 比上一則新 —— 記下的「上一則」最多是
 * 有上限的時鐘之後 5 分鐘（營運方撥快時鐘塞進來一則遠在未來的，之後真的也收得到）；比有上限的時鐘晚一天以上的直接拒。
 * 看過的表有上限（滿了先丟過期的，再丟最早到期的 —— 它也快要因為太舊被新鮮度擋掉）。
 */
export class DirectReplayGuard {
  private seen = new Map<string, number>();

  constructor(private readonly marks: MarkStore | null = null, private readonly maxSeen = 4096) {}

  check(body: DirectBody, now: DirectClocks): ReplayVerdict {
    const rule = DIRECT_KIND_RULES[body.kind];
    const key = `${body.from}|${body.nonce}`;
    if (this.seen.has(key)) return 'replay';
    const markKey = this.marks ? markKeyOf(body) : null;
    if (markKey && this.marks) {
      if (body.iat > now.bounded + DIRECT_ORDERED_MAX_AHEAD_MS) return 'out-of-order';
      const last = this.marks.get(markKey);
      if (last !== undefined && !(body.iat > last)) return 'out-of-order';
      this.marks.set(markKey, Math.min(body.iat, now.bounded + DIRECT_MAX_FUTURE_MS));
    }
    this.remember(key, body.iat + rule.maxAgeMs + DIRECT_MAX_FUTURE_MS, now.server);
    return 'ok';
  }

  private remember(key: string, exp: number, now: number): void {
    if (this.seen.size >= this.maxSeen) {
      for (const [k, e] of this.seen) if (e < now) this.seen.delete(k);
      while (this.seen.size >= this.maxSeen) {
        const first = this.seen.keys().next().value;
        if (first === undefined) break;
        this.seen.delete(first);
      }
    }
    this.seen.set(key, exp);
  }

  /** 看過的表多大（測試用） */
  get size(): number { return this.seen.size; }
}

/**
 * 只有好友看得到的上線狀態（W4，設計 §C，docs/GROUP_LOG_WIRING_W4.md）—— 純函式，沒有 I/O、沒有模組層級的可變狀態。
 *
 *   每個人一個秘密 presence 主題  mist/user/{我}/presence/{tag}
 *   tag   = URL-safe base64(HMAC-SHA256(S, "aegistalk-presence-v1|" + e) 的前 16 bytes)   （22 字元）
 *   S     = 32 bytes 亂數；e ＝ 世代（整數，只會變大：新的 e ＝ max(舊的 e + 1, 現在的秒數)，換手機、還原之後也比舊的大）
 *   K_p   = HKDF-SHA256(S, salt = 空, info = "aegistalk-presence-key-v1|" + e) → AES-256-GCM
 *   payload { n: 12 bytes nonce, c: AES-GCM(K_p, n, 明文, AAD = 主題) }   —— 沒有寄件人欄位、沒有公鑰、沒有明文的「在線」
 *   明文  { on: 0|1, ts, cs }   ts ＝ 寫的時間；cs ＝ 這一條連線連上的時間（遺囑、上線、每 4 分鐘的更新同一個 cs）
 *   空的 payload ＝ 主人清掉了這個主題（換了新的秘密，見 presenceService）
 * S 與 e 只放進封給好友身分金鑰的信封（GROUP_KEY_SEALED 的 presence 種類，identitySeal）：
 *   share   { kind: 'presence', s, e }      我的秘密
 *   request { kind: 'presence', have }      我手上你的 e（沒有 ＝ 0）：請你再給我一次
 * 營運方（broker 與 API）沒有 S：推不出 tag（token 範圍只收確切的主題，見 api/chat/mqtt_auth.py mqtt_scope），寫不出解得開的「在線」
 * （以前任何人都能在 mist/user/<我>/presence 上收看我的上線狀態，營運方還能寫一則「在線」讓好友不發推播給我，useChat.ts）；
 * AAD 綁主題：別的主題、別人的密文搬過來也解不開。收到的狀態照 acceptState 排順序（舊連線的、離線之後才到的上線都不算）。
 */
import { toB64, toB64Url, toBuf, utf8 } from './groupStateCommit';
import { isPresenceTag as tagShape, isPresenceTopic as topicShape, isCanonicalPubkey, MAX_ACL_PRESENCE } from './mqttCredential';

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SECRET_RE = /^[A-Za-z0-9+/]{43}=$/;
const TAG_LABEL = 'aegistalk-presence-v1|';
const KEY_LABEL = 'aegistalk-presence-key-v1|';
/** 明文最多這麼長（{"on":1,"ts":…,"cs":…} 不到 60 bytes） */
const MAX_PLAINTEXT = 128;
/** identitySeal 拆開後一定帶的欄位（openFromIdentity 加的） */
const SEAL_FIELDS = ['v', 'from', 'to', 'iat', 'nonce'] as const;

/** 30 天換一次世代（換主題）：舊主題就算被猜到、被記下來，也只看得到換之前的 */
export const PRESENCE_ROTATE_MS = 30 * 24 * 3_600_000;
/** 「在線」只收這麼新的（ts）；離線不看舊不舊（遺囑寫在連上的時候） */
export const ONLINE_FRESH_MS = 5 * 60_000;
/** 任何狀態的 ts 最多比現在晚這麼多（時鐘差） */
export const FUTURE_SKEW_MS = 5 * 60_000;
/** 在線沒有更新超過這麼久 ＝ 當作離線（遺囑被擋掉、被丟掉時，好友頂多誤以為我在線這麼久） */
export const ONLINE_TTL_MS = 10 * 60_000;
/** 連著的時候每隔這麼久重發一次「在線」（新訂閱的好友拿到的 retained 一定夠新，TTL 也不會到） */
export const PRESENCE_REFRESH_MS = 4 * 60_000;
/**
 * 判斷好友狀態新不新鮮用的時鐘，最多照 API 的時鐘差（token 回應的 serverTime）撥這麼多（W5）。營運方能回一個假的 serverTime：
 * 不設上限的話，把一支手機的時鐘往回撥一天，一天前錄下來的「在線」重放進來就算新鮮（好友不發推播給他）。設了上限之後，
 * 錄下來超過 ONLINE_FRESH_MS ＋ 這個上限（10 分鐘，同遺囑被擋掉時的 TTL）的「在線」永遠不新鮮。
 * 代價：本機時鐘真的差超過約 10 分鐘的手機，好友的「在線」會被當成太舊或未來的而不採用 —— 看起來離線、照常發推播（安全的那一邊）
 */
export const PRESENCE_MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** token 一次最多訂幾個好友的 presence（＝api/chat/mqtt_auth.py MQTT_ACL_MAX_PRESENCE） */
export const MAX_PRESENCE_TOPICS = MAX_ACL_PRESENCE;

export interface PresenceSecret {
  /** 32 bytes */
  s: Uint8Array;
  e: number;
}

export interface PresenceState {
  on: 0 | 1;
  ts: number;
  cs: number;
}

function reject(reason: string): never {
  throw new Error(`presenceSecret: ${reason}`);
}

const okEpoch = (e: unknown): e is number => typeof e === 'number' && Number.isSafeInteger(e) && e >= 1;
const okTime = (t: unknown): t is number => typeof t === 'number' && Number.isSafeInteger(t) && t >= 0;

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(o);
  return actual.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function checkSecret(secret: PresenceSecret): void {
  if (!(secret?.s instanceof Uint8Array) || secret.s.length !== 32 || !okEpoch(secret.e)) reject('bad secret');
}

export const isPresenceTag = tagShape;
export const isPresenceTopic = topicShape;

/** owner（標準 base64 公鑰）的 presence 主題（＝mqttCredential.isPresenceTopic 的形狀）；tag 不對、owner 不是標準寫法 → 丟例外 */
export function presenceTopic(owner: string, tag: string): string {
  if (!isCanonicalPubkey(owner) || !tagShape(tag)) reject('bad presence topic');
  const topic = `mist/user/${owner.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}/presence/${tag}`;
  if (!topicShape(topic)) reject('bad presence topic');
  return topic;
}

/** mist/user/{owner}/presence/{tag} → { owner（標準 base64）, tag }；不是這個確切的形狀（含舊的 mist/user/{owner}/presence）→ null */
export function parsePresenceTopic(topic: unknown): { owner: string; tag: string } | null {
  if (!topicShape(topic)) return null;
  const parts = topic.split('/');
  return { owner: `${parts[2].replace(/-/g, '+').replace(/_/g, '/')}=`, tag: parts[4] };
}

async function hmacKey(s: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuf(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** 這一代的 tag：HMAC-SHA256(S, "aegistalk-presence-v1|" + e) 的前 16 bytes，URL-safe base64（22 字元） */
export async function presenceTag(secret: PresenceSecret): Promise<string> {
  checkSecret(secret);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret.s), toBuf(utf8(TAG_LABEL + secret.e))));
  return toB64Url(mac.slice(0, 16));
}

async function presenceKey(secret: PresenceSecret): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', toBuf(secret.s), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuf(utf8(KEY_LABEL + secret.e)) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function checkState(st: PresenceState): PresenceState {
  if (!st || (st.on !== 0 && st.on !== 1) || !okTime(st.ts) || !okTime(st.cs) || st.cs > st.ts) reject('bad presence state');
  return { on: st.on, ts: st.ts, cs: st.cs };
}

/** 主題要是這個秘密這一代的（tag 對得上）：別的主題、別人的、舊一代的 → 丟例外 */
async function checkTopic(secret: PresenceSecret, topic: string): Promise<void> {
  const parsed = parsePresenceTopic(topic);
  if (!parsed || parsed.tag !== (await presenceTag(secret))) reject('topic does not belong to this secret');
}

/** 封一則狀態，發在 topic（一定要是這個秘密這一代的主題）上 */
export async function sealPresence(p: { secret: PresenceSecret; topic: string; state: PresenceState }): Promise<{ n: string; c: string }> {
  checkSecret(p.secret);
  await checkTopic(p.secret, p.topic);
  const st = checkState(p.state);
  const plain = utf8(JSON.stringify({ on: st.on, ts: st.ts, cs: st.cs }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(utf8(p.topic)) }, await presenceKey(p.secret), toBuf(plain));
  return { n: toB64(iv), c: toB64(new Uint8Array(ct)) };
}

function fromB64Strict(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 拆 topic 上收到的一則（JSON 字串或已解析的物件）。主題不是這個秘密這一代的、形狀不對（多欄位、不是 base64）、
 * AAD 或金鑰對不上、明文不是 { on, ts, cs } → 丟例外。新不新鮮、順序由呼叫端用 acceptState 判斷
 */
export async function openPresence(p: { secret: PresenceSecret; topic: string; payload: unknown }): Promise<PresenceState> {
  checkSecret(p.secret);
  await checkTopic(p.secret, p.topic);
  let env: unknown = p.payload;
  if (typeof env === 'string') {
    if (env.length > 512) reject('payload too large');
    try { env = JSON.parse(env); } catch { reject('payload is not JSON'); }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) reject('malformed payload');
  const e = env as Record<string, unknown>;
  if (!exactKeys(e, ['n', 'c']) || typeof e.n !== 'string' || typeof e.c !== 'string' || !B64_RE.test(e.n) || !B64_RE.test(e.c)) reject('malformed payload');
  const iv = fromB64Strict(e.n);
  const ct = fromB64Strict(e.c);
  if (iv.length !== 12 || ct.length < 16 || ct.length > MAX_PLAINTEXT + 16) reject('malformed payload');
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(utf8(p.topic)) }, await presenceKey(p.secret), toBuf(ct)));
  } catch {
    reject('cannot decrypt');
  }
  let o: unknown;
  try { o = JSON.parse(new TextDecoder().decode(plain)); } catch { reject('malformed plaintext'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !exactKeys(o as Record<string, unknown>, ['on', 'ts', 'cs'])) reject('malformed plaintext');
  const r = o as Record<string, unknown>;
  return checkState({ on: r.on as 0 | 1, ts: r.ts as number, cs: r.cs as number });
}

/**
 * 收到的這一則狀態要不要採用（prev ＝ 這個人目前採用的那一則）。營運方能重放看過的密文、擋掉或延後任何一則：
 *   - 未來的時間（超過 FUTURE_SKEW_MS）→ 不收
 *   - 在線要夠新（ONLINE_FRESH_MS）：舊的「在線」重放不能讓已經離線的人復活、讓好友不發推播
 *   - 比目前採用的那一條連線還舊的連線（cs 比較小）→ 不收（換 token 重連時，舊連線的遺囑可能晚到）
 *   - 同一條連線：離線之後才到的上線、比目前採用的還舊的同一種狀態 → 不收
 */
export function acceptState(prev: PresenceState | null, next: PresenceState, now: number): boolean {
  if (next.ts - now > FUTURE_SKEW_MS || next.cs - now > FUTURE_SKEW_MS) return false;
  if (next.on === 1 && now - next.ts > ONLINE_FRESH_MS) return false;
  if (!prev) return true;
  if (next.cs < prev.cs) return false;
  if (next.cs > prev.cs) return true;
  if (prev.on === 0 && next.on === 1) return false;
  if (prev.on === next.on && next.ts < prev.ts) return false;
  return true;
}

/**
 * 判斷好友狀態用的「現在」：本機時鐘，加上 API 的時鐘差 —— 但最多 ±PRESENCE_MAX_CLOCK_SKEW_MS（營運方回的 serverTime 撥不動更多）。
 * 時鐘差不是有限的數字 → 只用本機時鐘
 */
export function presenceClock(deviceNow: number, serverOffsetMs: number): number {
  const off = Number.isFinite(serverOffsetMs) ? serverOffsetMs : 0;
  return deviceNow + Math.max(-PRESENCE_MAX_CLOCK_SKEW_MS, Math.min(PRESENCE_MAX_CLOCK_SKEW_MS, off));
}

/** 現在還算在線嗎（在線、而且最近一次更新沒超過 ONLINE_TTL_MS） */
export function stillOnline(st: PresenceState | null | undefined, now: number): boolean {
  return !!st && st.on === 1 && now - st.ts < ONLINE_TTL_MS;
}

/** 新的世代：比舊的大，也不小於現在的秒數（換手機、還原之後沒有舊的 e，照樣比好友手上的大） */
export function nextEpoch(prev: number | null | undefined, nowMs: number): number {
  return Math.max(okEpoch(prev) ? prev + 1 : 1, Math.floor(nowMs / 1000));
}

export function secretToB64(s: Uint8Array): string {
  if (!(s instanceof Uint8Array) || s.length !== 32) reject('bad secret');
  return toB64(s);
}

export function secretFromB64(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || !SECRET_RE.test(v)) return null;
  const s = fromB64Strict(v);
  return s.length === 32 && toB64(s) === v ? s : null;
}

/** 封進信封的 share：{ kind: 'presence', s, e } */
export function shareBody(secret: PresenceSecret): Record<string, unknown> {
  checkSecret(secret);
  return { kind: 'presence', s: secretToB64(secret.s), e: secret.e };
}

/** 封進信封的 request：{ kind: 'presence', have }（have ＝ 我手上你的 e，沒有 ＝ 0） */
export function requestBody(have: number | null | undefined): Record<string, unknown> {
  return { kind: 'presence', have: okEpoch(have) ? have : 0 };
}

/** 拆開的信封內容（identitySeal 補上的 v／from／to／iat／nonce 之外，欄位一個不多一個不少）→ share／request／null */
export function parsePresenceBody(body: Record<string, unknown>):
  { t: 'share'; secret: PresenceSecret; iat: number } | { t: 'request'; have: number } | null {
  if (!body || typeof body !== 'object' || body.kind !== 'presence') return null;
  if (exactKeys(body, ['kind', 's', 'e', ...SEAL_FIELDS])) {
    const s = secretFromB64(body.s);
    return s && okEpoch(body.e) && okTime(body.iat) ? { t: 'share', secret: { s, e: body.e }, iat: body.iat } : null;
  }
  if (exactKeys(body, ['kind', 'have', ...SEAL_FIELDS])) {
    const have = body.have;
    return typeof have === 'number' && Number.isSafeInteger(have) && have >= 0 ? { t: 'request', have } : null;
  }
  return null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 好友寄來的 share 跟我手上他的那一份比：new（換上）／same（已經有了）／stale（比手上的舊：重放、晚到的舊信封）／
 * conflict（同一代不同的秘密，而且不比手上的晚封）。同一代兩份不同的秘密（同一秒建了兩次，例如 App 啟動時建了兩次服務）：
 * 封裝時間（iat，簽在信封裡）比較晚的那份勝出 —— 主人最後送出去的那份就是他在用的（審查 W4 #3c）
 */
export function compareShare(stored: (PresenceSecret & { iat?: number }) | null | undefined, incoming: PresenceSecret & { iat?: number }):
  'new' | 'same' | 'stale' | 'conflict' {
  if (!stored) return 'new';
  if (incoming.e > stored.e) return 'new';
  if (incoming.e < stored.e) return 'stale';
  if (sameBytes(incoming.s, stored.s)) return 'same';
  return (incoming.iat ?? 0) > (stored.iat ?? 0) ? 'new' : 'conflict';
}

/**
 * 我的秘密要不要換：沒有 → initial；拿過秘密的人裡有誰現在不是能給的人（刪好友、封鎖）→ revoked（新的 S 與 e）；
 * 用了 30 天 → timer；否則 null
 */
export function rotationReason(self: { since: number; sharedWith: readonly string[] } | null, recipients: ReadonlySet<string>, now: number):
  'initial' | 'revoked' | 'timer' | null {
  if (!self) return 'initial';
  if (self.sharedWith.some((pk) => !recipients.has(pk))) return 'revoked';
  if (now - self.since >= PRESENCE_ROTATE_MS) return 'timer';
  return null;
}

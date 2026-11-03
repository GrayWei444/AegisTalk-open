/**
 * 群組控制信封 group_sealed 與每一代的群組主題 id（設計 B2，2026-10-22）—— 純函式，沒有 I/O、沒有模組層級的可變狀態。
 *
 *   tid   = URL-safe base64(HKDF-SHA256(K_e, salt = 空, info = "aegistalk-gtopic-v1|" + gid))[:22]   每換一次金鑰就換主題
 *   K_ctl = HKDF-SHA256(K_e, salt = 空, info = "aegistalk-gctl-v1|" + gid) → AES-256-GCM
 *   信封  { n: 12 bytes nonce, c: AES-GCM(K_ctl, n, 明文, AAD = tid|kid|寄件人) }   broker 只看得到主題（tid）與長度
 *         W3 審查 M3：以前外層還有明文的 kid（k）—— 群組 log 的每一筆也帶明文 kid、而且看得到 gid，同時看得到兩邊的人（營運方）
 *         照 kid 字串就把 tid 對回 gid。主題本身就決定是哪一代（tid 由那一代的金鑰推出來），kid 不必上線：收端從自己的主題表拿
 *   明文  { c: canonicalJson(內層), s: 寄件人 Ed25519(身分金鑰, "aegistalk-gctl-v1:" + c), p: "." × n }
 *         p 把明文補到 PAD_BUCKET 的倍數（審查 W2 #9：不補的話密文長度就看得出是 here、通話還是刪除）
 *   內層  { t, gid, kid, ts, nonce, body }，t ∈ commit／call／here／sync／delete；kid 也在簽章裡（決定 2026-10-22 規則 4）：
 *         成員不能把別人舊一代的內層換成新一代的金鑰重送
 *   body（W2，log 模型：commit 本身在伺服器 log 上，信封裡只有位置）：
 *         commit { head: { seq, id } }   我的 commit 在 log 的 seq 套上了（id ＝ 那筆 commit）
 *         here   { head: { seq, id } }   我的 head（headGossip）
 *         sync   { have: { seq, id } }   請大家報 head，附上我的
 *         call   { action: start|join|leave|end, video: boolean }
 *         delete { messageId }
 * 一律只用一把金鑰加密，不跟上一代雙發。寄件人＝主題後綴對應的成員公鑰（標準 base64）：
 * 換了主題、換了金鑰 id、換了寄件人，AES-GCM 就解不開；內層簽章再證明是寄件人本人寫的（其他成員雖然有 K_ctl，也冒充不了）。
 * 群組主題就是 mist/group/{tid}/{寄件人}（W3，docs/GROUP_LOG_WIRING_W3.md）：sealControl 回傳要發的 tid，收端用同一個推法核對
 * 收到的主題是不是這把金鑰的；tid 對回哪個群由群組引擎的主題表決定（groupTopics.ts）。
 * 新鮮度與重放（ts／nonce 去重）、只收目前這一代由呼叫端判斷（groupEngineControl）。
 */
import { canonicalJson } from './mqttCredential';
import { fromB64, toB64, toB64Url, toBuf, utf8, validCommitId, validGid, validKid, validPubkey, type SignFn, type VerifyFn } from './groupStateCommit';

export const GCTL_DOMAIN = 'aegistalk-gctl-v1:';
const GTOPIC_INFO = 'aegistalk-gtopic-v1|';
const GCTL_INFO = 'aegistalk-gctl-v1|';
/** 明文上限（W2 起 commit 不再放進信封，每一種都很小） */
export const MAX_CONTROL_PLAINTEXT = 16 * 1024;
const MAX_MESSAGE_ID_LENGTH = 128;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;
/** 明文補到這個大小的倍數（每一種實際上都 < 1 KB → 線上一律一樣長） */
export const PAD_BUCKET = 1024;
const PAD_RE = /^\.*$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type ControlKind = 'commit' | 'call' | 'here' | 'sync' | 'delete';
const KINDS: readonly ControlKind[] = ['commit', 'call', 'here', 'sync', 'delete'];
const CALL_ACTIONS = ['start', 'join', 'leave', 'end'];

/** MQTT 型別 group_sealed 的 payload（沒有 kid：收端從主題 id 知道是哪一代） */
export interface GroupSealed {
  n: string;
  c: string;
}

export interface ControlInner {
  t: ControlKind;
  gid: string;
  /** 加密這則訊息的金鑰 id（＝信封的 k），在簽章裡 */
  kid: string;
  ts: number;
  /** 16 bytes 亂數（URL-safe base64），呼叫端去重用 */
  nonce: string;
  body: Record<string, unknown>;
}

export interface OpenedControl extends ControlInner {
  /** 驗過簽章的寄件人公鑰（標準 base64） */
  sender: string;
}

function reject(reason: string): never {
  throw new Error(`groupControl: ${reason}`);
}

function plainObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) reject(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(o);
  if (actual.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))) reject(`malformed ${what}`);
}

/** log 上的位置（groupLog.headGossip）：seq ＝ head 在 log 的 seq，id ＝ head 那筆 commit */
function headOf(v: unknown, what: string): { seq: number; id: string } {
  const h = plainObject(v, what);
  exactKeys(h, ['seq', 'id'], what);
  if (typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 0 || h.seq > MAX_SEQ || !validCommitId(h.id)) reject(`malformed ${what}`);
  return { seq: h.seq, id: h.id };
}

/** 各種類的 body：形狀固定（多的欄位、型別不對 → 拒收） */
function parseBody(t: ControlKind, raw: unknown): Record<string, unknown> {
  const b = plainObject(raw, 'body');
  switch (t) {
    case 'commit':
      exactKeys(b, ['head'], 'commit body');
      return { head: headOf(b.head, 'head') };
    case 'here':
      exactKeys(b, ['head'], 'here body');
      return { head: headOf(b.head, 'head') };
    case 'sync':
      exactKeys(b, ['have'], 'sync body');
      return { have: headOf(b.have, 'have') };
    case 'call':
      exactKeys(b, ['action', 'video'], 'call body');
      if (typeof b.action !== 'string' || !CALL_ACTIONS.includes(b.action) || typeof b.video !== 'boolean') reject('malformed call body');
      return { action: b.action, video: b.video };
    case 'delete':
      exactKeys(b, ['messageId'], 'delete body');
      if (typeof b.messageId !== 'string' || b.messageId.length < 1 || b.messageId.length > MAX_MESSAGE_ID_LENGTH) reject('malformed delete body');
      return { messageId: b.messageId };
  }
}

/** 送之前先檢查 body（留著之後才送的訊息也要現在就知道格式對不對）；不對丟例外，對的話回傳正規化的 body */
export function checkControlBody(t: ControlKind, body: unknown): Record<string, unknown> {
  if (!KINDS.includes(t)) reject('unknown kind');
  return parseBody(t, body);
}

async function hkdfMaterial(key: Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.length !== 32) reject('group key must be 32 bytes');
  return crypto.subtle.importKey('raw', toBuf(key), 'HKDF', false, ['deriveBits', 'deriveKey']);
}

const hkdfParams = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuf(utf8(info)) });

/** 這一代金鑰的群組主題 id（mist/group/{tid}/{寄件人}） */
export async function deriveTopicId(key: Uint8Array, gid: string): Promise<string> {
  if (!validGid(gid)) reject('bad group id');
  const bits = await crypto.subtle.deriveBits(hkdfParams(GTOPIC_INFO + gid), await hkdfMaterial(key), 256);
  return toB64Url(new Uint8Array(bits)).slice(0, 22);
}

async function controlKey(key: Uint8Array, gid: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(hkdfParams(GCTL_INFO + gid), await hkdfMaterial(key), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const aad = (tid: string, kid: string, sender: string): ArrayBuffer => toBuf(utf8(`${tid}|${kid}|${sender}`));

/** 封一則控制訊息：回傳要發布的主題 id 與信封 */
export async function sealControl(params: {
  gid: string;
  kid: string;
  key: Uint8Array;
  sender: string;
  sign: SignFn;
  t: ControlKind;
  body: Record<string, unknown>;
  /** 測試用；預設現在 */
  ts?: number;
  /** 測試用；預設 16 bytes 亂數 */
  nonce?: string;
}): Promise<{ tid: string; envelope: GroupSealed }> {
  const { gid, kid, key, sender, sign, t } = params;
  if (!validGid(gid) || !validKid(kid) || !validPubkey(sender) || !KINDS.includes(t)) reject('bad seal parameters');
  const nonce = params.nonce ?? toB64Url(crypto.getRandomValues(new Uint8Array(16)));
  if (!NONCE_RE.test(nonce)) reject('bad nonce');
  const inner: ControlInner = { t, gid, kid, ts: params.ts ?? Date.now(), nonce, body: parseBody(t, params.body) };
  const c = canonicalJson(inner);
  const unpadded = JSON.stringify({ c, s: toB64(sign(utf8(GCTL_DOMAIN + c))), p: '' });
  const used = utf8(unpadded).length;
  const padded = unpadded.slice(0, -2) + '.'.repeat(Math.ceil(used / PAD_BUCKET) * PAD_BUCKET - used) + '"}';
  const plain = utf8(padded);
  if (plain.length > MAX_CONTROL_PLAINTEXT) reject('message too large');
  const tid = await deriveTopicId(key, gid);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(iv), additionalData: aad(tid, kid, sender) }, await controlKey(key, gid), toBuf(plain));
  return { tid, envelope: { n: toB64(iv), c: toB64(new Uint8Array(ct)) } };
}

function parseEnvelope(envelope: unknown): { iv: Uint8Array; ct: Uint8Array } {
  const e = plainObject(envelope, 'envelope');
  exactKeys(e, ['n', 'c'], 'envelope');
  if (typeof e.n !== 'string' || typeof e.c !== 'string' || !B64_RE.test(e.n) || !B64_RE.test(e.c)) reject('malformed envelope');
  if (e.c.length > Math.ceil((MAX_CONTROL_PLAINTEXT + 16) / 3) * 4) reject('envelope too large');
  const iv = fromB64(e.n);
  const ct = fromB64(e.c);
  if (iv.length !== 12 || ct.length < 16) reject('malformed envelope');
  return { iv, ct };
}

function parseInner(c: string, gid: string, kid: string): ControlInner {
  const inner = plainObject(JSON.parse(c), 'inner');
  exactKeys(inner, ['t', 'gid', 'kid', 'ts', 'nonce', 'body'], 'inner');
  if (canonicalJson(inner) !== c) reject('inner is not canonical');
  if (inner.gid !== gid) reject('wrong group');
  if (inner.kid !== kid) reject('inner key id mismatch');
  if (!KINDS.includes(inner.t as ControlKind)) reject('unknown kind');
  if (typeof inner.ts !== 'number' || !Number.isSafeInteger(inner.ts) || inner.ts < 0) reject('bad ts');
  if (typeof inner.nonce !== 'string' || !NONCE_RE.test(inner.nonce)) reject('bad nonce');
  const t = inner.t as ControlKind;
  return { t, gid, kid, ts: inner.ts, nonce: inner.nonce, body: parseBody(t, inner.body) };
}

/**
 * 拆一則控制訊息。tid＝收到的主題、sender＝主題後綴對應的成員公鑰、kid／key＝那個主題那一代（呼叫端從自己的主題表找，信封上沒有）。
 * 主題不是這把金鑰算出來的、AAD 不符、密文被改、內層簽章不是寄件人的、不是這個群 → 丟例外。
 */
export async function openControl(params: {
  envelope: unknown;
  gid: string;
  tid: string;
  sender: string;
  kid: string;
  key: Uint8Array;
  verify: VerifyFn;
}): Promise<OpenedControl> {
  const { gid, tid, sender, kid, key, verify } = params;
  if (!validGid(gid) || !validPubkey(sender)) reject('bad open parameters');
  if (!validKid(kid)) reject('bad open parameters');
  const env = parseEnvelope(params.envelope);
  if ((await deriveTopicId(key, gid)) !== tid) reject('topic does not belong to this key');
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuf(env.iv), additionalData: aad(tid, kid, sender) }, await controlKey(key, gid), toBuf(env.ct)));
  } catch {
    reject('cannot decrypt');
  }
  let outer: Record<string, unknown>;
  try {
    outer = plainObject(JSON.parse(new TextDecoder().decode(plain)), 'plaintext');
  } catch {
    reject('malformed plaintext');
  }
  // p（補長度）可有可無；有的話只能是 '.'
  if (Object.prototype.hasOwnProperty.call(outer, 'p')) {
    if (typeof outer.p !== 'string' || !PAD_RE.test(outer.p)) reject('malformed plaintext');
    exactKeys(outer, ['c', 's', 'p'], 'plaintext');
  } else exactKeys(outer, ['c', 's'], 'plaintext');
  if (typeof outer.c !== 'string' || typeof outer.s !== 'string' || !B64_RE.test(outer.s)) reject('malformed plaintext');
  const sig = fromB64(outer.s);
  let signed = false;
  try {
    signed = sig.length === 64 && verify(fromB64(sender), utf8(GCTL_DOMAIN + outer.c), sig);
  } catch {
    signed = false;
  }
  if (!signed) reject('bad inner signature');
  let inner: ControlInner;
  try {
    inner = parseInner(outer.c, gid, kid);
  } catch (e) {
    reject((e as Error)?.message?.replace(/^groupControl: /, '') ?? 'malformed inner');
  }
  return { ...inner, sender };
}

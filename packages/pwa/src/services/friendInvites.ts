/**
 * 加好友的「邀請憑證」（稽核 H1／H2，對應 AegisPlay A2 services/friendInvites.ts）。
 *
 * 以前收到**非好友**的 X3DH_INIT 就直接加成好友，信任等級還照對方 payload 填 ——
 * 陌生人送一發 trustLevel:'verified'，就變成你的「已驗證」好友。
 *
 * 現在：對方一定是透過**我給出去的東西**來加我的，我自己記得那些東西 ——
 *   code  我的好友短碼（ATK-XXXXXX）
 *   qr    我畫出來的 QR 裡的 nonce（當面掃 → 唯一算「已驗證」的）；一張 5 分鐘、多人可掃，見 QR_INVITE_TTL_MS；
 *         INIT 晚到也認到畫出來後 30 分鐘，見 QR_INVITE_ACCEPT_MS
 * 對方在 X3DH_INIT 帶 `via`，我對得上才加；對不上就不加、也不建 session（見 AppProvider X3DH_INIT）。
 * 記錄綁帳號（同一台換帳號不互通），各有期限。
 *
 * 以前對不上仍加成「未驗證」好友，只為了相容不帶 via 的舊版 client；App 還沒上線、沒有舊版，2026-10-15 改成跟 AegisPlay 一樣嚴格。
 * 邀請連結（INVITE_ACCEPT）整條拿掉了，App 只剩短碼與 QR 兩條加好友的路，兩條都帶 via。
 *
 * 憑證本身**不上線**（程式碼審查 M2）：X3DH_INIT 是明文，AegisTalk 的 broker 又讓任何 client 訂閱任何人的收件匣 ——
 * 以前 via 直接帶短碼／QR nonce，看到一封就能把同一個憑證換成自己的金鑰重送，變成「已驗證」好友。
 * 現在 via 裡是 { kind, proof }，proof 綁「寄件者公鑰＋這封的 ephemeral 公鑰」（見 viaProof）；收端拿自己記著、
 * 還沒過期的同種憑證（就幾個）逐一重算比對。抄走的 proof 換一把金鑰、換一個 ephemeral 都對不上。
 * 而且 { kind, proof } 封給收件人的身分金鑰、由寄件者簽名（ViaSealer，App 裡是 groupKeyDelivery.friendViaSealer）：
 * 只放 proof 的話，短碼只有約 2^30 種，讀得到收件匣的人拿 proof 就能離線暴力猜出短碼（AegisPlay 同一改法的審查）。
 * 開源第 4 步：加好友的人的名字也放在這個信封裡（{ kind, proof, name }）—— 以前是 X3DH_INIT 明文的 senderName，
 * broker 上看得到誰叫什麼名字、誰在加誰。
 */
import type { SealedToIdentity } from './identitySeal';

export type InviteKind = 'code' | 'qr';
/** 本機才有的憑證：掃到的 QR nonce、輸入的短碼。只用來算 proof，不放進任何訊息 */
export type FriendInvite = { kind: InviteKind; token: string };
/** X3DH_INIT 帶的 via：封給收件人身分金鑰的信封，裡面是 { kind, proof }（不含憑證本身） */
export type FriendVia = SealedToIdentity;

/**
 * 封／拆 via 的那一層：封給 `to` 的身分金鑰、由我簽名；拆開 `from` 寄給 `to`（我）的、驗過 from 的簽章。
 * 拆不開、簽章不對、from／to 對不上就丟例外。App 用已登入身分（groupKeyDelivery.friendViaSealer），測試注入。
 */
export interface ViaSealer {
  seal(to: string, body: Record<string, unknown>): Promise<SealedToIdentity>;
  open(from: string, to: string, envelope: unknown): Promise<Record<string, unknown>>;
}

/** proof 的 domain 字串（AegisPlay 用同一套，字串是 "aegisplay-friend-via-v1"） */
export const FRIEND_VIA_DOMAIN = 'aegistalk-friend-via-v1';
const isKind = (k: unknown): k is InviteKind => k === 'code' || k === 'qr';

const KEY = 'aegis_friend_invites_v1';
const HOURS_24 = 24 * 60 * 60 * 1000;
/**
 * QR 邀請一張 5 分鐘（產品決定 2026-10-15「qrcode 是五分鐘一次」，對應 AegisPlay 5a1edc11）：畫出來起 5 分鐘內，
 * 幾個人掃同一張都認，不是用一次就作廢；過了掃描端就不送，畫面也已換成新的一張（QRCodeVerification 每 5 分鐘換新）。
 * 碼主人這邊收 INIT 認得比較久，見 QR_INVITE_ACCEPT_MS。
 */
export const QR_INVITE_TTL_MS = 5 * 60 * 1000;
/**
 * 掃描端的寬限 30 秒：掃描端拿自己的時鐘比 QR 上的 exp，容兩支手機的時鐘差一點（qrScanExpired）。
 */
export const QR_INVITE_GRACE_MS = 30 * 1000;
/**
 * 碼主人收到 QR 的 INIT：畫出來起 30 分鐘內都認（程式碼審查 M1）。掃描端掃到時就擋掉超過 5 分鐘（＋寬限）的 QR，
 * 但碼主人可能晚很久才處理那封 INIT —— 對方掃完就鎖屏、INIT 在離線佇列。以前 5 分鐘＋30 秒一過就整封拒收，
 * 掃描端還以為加成功了。畫面照舊每 5 分鐘換一張新的。
 */
export const QR_INVITE_ACCEPT_MS = 30 * 60 * 1000;
/**
 * 短碼：伺服器說的到期時間之後再認多久（程式碼審查 M3）。broker 的離線 session 最多留 24 小時 ——
 * 到期前送出的 INIT 最晚在到期後一天內到。以前一律記 7 天，伺服器早就不認的碼本機還認好幾天。
 */
export const SHORT_CODE_BROKER_TAIL_MS = HOURS_24;
/** 伺服器短碼的有效期：伺服器回應沒有可用的到期時間時當它是剛發的；說得比這更久也不採信 */
const SHORT_CODE_SERVER_TTL_MS = HOURS_24;
const MAX_ENTRIES = 500;
/** exp：本機認到什麼時候（毫秒） */
type Entry = { owner: string; kind: InviteKind; token: string; exp: number };

function read(): Entry[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const now = Date.now();
    return Array.isArray(list)
      ? list.filter((e: Entry) => e && typeof e.owner === 'string' && typeof e.token === 'string'
        && isKind(e.kind) && typeof e.exp === 'number' && now < e.exp)
      : [];
  } catch { return []; }
}

const normToken = (kind: InviteKind, s: string) => kind === 'code' ? s.trim().toUpperCase().replace(/^ATK-/, '') : s.trim();

/** 記下一個發出去的憑證，認到 exp。dropOthers：這個帳號同種的其他憑證一起作廢（重新產生短碼） */
function remember(owner: string, kind: InviteKind, token: string, exp: number, dropOthers = false): void {
  if (!owner || !token) return;
  const t = normToken(kind, token);
  const rest = read().filter((e) => !(e.owner === owner && e.kind === kind && (dropOthers || e.token === t)));
  try { localStorage.setItem(KEY, JSON.stringify([...rest, { owner, kind, token: t, exp }].slice(-MAX_ENTRIES))); }
  catch { /* 無 storage：之後這條憑證對不上，對方加不到 —— 寧可失敗也不要放行陌生人 */ }
}

/**
 * 「好友碼」分頁拿到伺服器給的短碼：本機認到「伺服器到期＋SHORT_CODE_BROKER_TAIL_MS」。伺服器的到期時間最多採信到
 * 「現在＋24 小時」（伺服器短碼本來就 24 小時有效）：回應被竄改或伺服器出錯，也不會讓一個碼在本機被認好幾天。
 * replacePrevious：使用者按了「重新產生」（/api/shortcode/refresh 成功）—— 這個帳號以前記的短碼全部作廢，
 * 外流的舊碼馬上不認（以前照樣認 7 天）。只是重新打開分頁（register）不算作廢，舊碼認到它自己到期。
 */
export function rememberShortCode(owner: string, code: string, serverExpiresAtMs: number, { replacePrevious = false } = {}): void {
  const latest = Date.now() + SHORT_CODE_SERVER_TTL_MS;
  const serverExp = Number.isFinite(serverExpiresAtMs) ? Math.min(serverExpiresAtMs, latest) : latest;
  remember(owner, 'code', code, serverExp + SHORT_CODE_BROKER_TAIL_MS, replacePrevious);
}

/** 「我的 QR」要畫一張新的：記下新 nonce，QR 上的 ts／exp 跟我記的是同一個時間點 */
export function issueQrInvite(owner: string, now: number = Date.now()): { nonce: string; issuedAt: number; expiresAt: number } {
  const nonce = newQrNonce();
  remember(owner, 'qr', nonce, now + QR_INVITE_ACCEPT_MS);
  return { nonce, issuedAt: now, expiresAt: now + QR_INVITE_TTL_MS };
}

/**
 * 「我的 QR」畫面每秒問一次：這張還剩幾秒、要不要換新的。用牆上時間算 ——
 * App 在背景時計時器會停，回到前景那一刻就該換新，不能接著停掉前的倒數顯示一張已失效的碼。
 */
export function qrScreenTick(expiresAt: number, now: number): { secondsLeft: number; renew: boolean } {
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return { secondsLeft, renew: secondsLeft === 0 };
}

/** 掃描端：對方 QR 上的 exp 過了沒（容 QR_INVITE_GRACE_MS 的時鐘差；真正把關的是對方收到 INIT 時的 acceptedVia） */
export function qrScanExpired(exp: number, now: number = Date.now()): boolean {
  return now > exp + QR_INVITE_GRACE_MS;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * proof = base64(HMAC-SHA256(key = utf8(正規化的憑證), msg = utf8(FRIEND_VIA_DOMAIN + "|" + 寄件者公鑰 + "|" + ephemeral 公鑰)))
 * 公鑰都是 X3DH_INIT 上那個 base64 字串原樣（寄件者＝message.from，ephemeral＝payload.ephemeralPublicKey）。
 */
async function viaProof(kind: InviteKind, token: string, senderPublicKey: string, ephemeralPublicKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(normToken(kind, token)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${FRIEND_VIA_DOMAIN}|${senderPublicKey}|${ephemeralPublicKey}`)));
  return btoa(String.fromCharCode(...mac));
}

/**
 * 加好友的一方：把手上的憑證變成 X3DH_INIT 要帶的 via —— 算 proof（ephemeral 是這封 INIT 的，建完 session 才知道），
 * 封給收件人 `receiverPublicKey`（短碼查詢／QR 上的 pk）。senderName：我的名字（只在信封裡，broker 看不到）
 */
export async function makeVia(
  invite: FriendInvite, senderPublicKey: string, ephemeralPublicKey: string, receiverPublicKey: string, sealer: ViaSealer,
  senderName?: string,
): Promise<FriendVia> {
  const proof = await viaProof(invite.kind, invite.token, senderPublicKey, ephemeralPublicKey);
  const name = typeof senderName === 'string' ? senderName.slice(0, 64) : '';
  return sealer.seal(receiverPublicKey, { kind: invite.kind, proof, ...(name ? { name } : {}) });
}

/** 比兩個 proof（等長才比，逐字元累加差異，不提早結束） */
function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 收到 X3DH_INIT 的 via：先拆信封（要是寄件者簽的、寄給我 owner 的），裡面的 proof 要等於「我這台記著、
 * 還沒過期的某一個同種憑證」對這個寄件者、這個 ephemeral 算出來的值，才回傳 { kind, name? }；否則 null（不加好友、
 * 不建 session）。沒封的 via（舊格式 token、只有 proof）一律不認。name 是對方自取的名字（呼叫端照樣過 cleanPeerName）
 */
export async function acceptedVia(
  owner: string, senderPublicKey: string, ephemeralPublicKey: unknown, via: unknown, sealer: ViaSealer,
): Promise<{ kind: InviteKind; name?: string } | null> {
  if (!owner || !senderPublicKey || typeof ephemeralPublicKey !== 'string' || !ephemeralPublicKey || !via || typeof via !== 'object') return null;
  let body: Record<string, unknown>;
  try {
    body = await sealer.open(senderPublicKey, owner, via);
  } catch {
    return null;   // 拆不開：不是封給我的、不是他簽的、被改過、格式不對
  }
  if (body.from !== senderPublicKey || body.to !== owner) return null;
  const { kind, proof, name } = body as { kind?: unknown; proof?: unknown; name?: unknown };
  if (!isKind(kind) || typeof proof !== 'string' || proof.length !== 44) return null;   // base64(32 bytes)
  const named = typeof name === 'string' && name ? { name: name.slice(0, 64) } : {};
  for (const e of read().filter((x) => x.owner === owner && x.kind === kind)) {
    try {
      if (sameProof(await viaProof(kind, e.token, senderPublicKey, ephemeralPublicKey), proof)) return { kind, ...named };
    } catch {
      return null;   // 算不了（沒有 WebCrypto）：寧可加不到也不放行
    }
  }
  return null;
}

/**
 * 已經是好友的人又送來 X3DH_INIT（重加、換了名字）：via 信封裡的名字（拆得開 ＝ 他簽的、寄給我的 —— 不必對得上憑證，
 * 他本來就是好友；憑證只決定陌生人能不能加進來）。拆不開、沒有名字 → null
 */
export async function viaName(owner: string, senderPublicKey: string, via: unknown, sealer: ViaSealer): Promise<string | null> {
  if (!owner || !senderPublicKey || !via || typeof via !== 'object') return null;
  try {
    const body = await sealer.open(senderPublicKey, owner, via);
    if (body.from !== senderPublicKey || body.to !== owner) return null;
    return typeof body.name === 'string' && body.name ? body.name.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** QR 的 nonce（url-safe，22 字元；一張 QR 一個，5 分鐘內可多人用） */
export function newQrNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 對方自取的名字：去掉控制字元與角括號、限長（它會出現在好友清單、通知等地方） */
export function cleanPeerName(name: unknown, fallback: string): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '';
  return s || fallback;
}

/**
 * 推播請求（移植群星 A5；伺服器端見 api/chat/push.py register_push_token／register_webpush／push_notify）。
 *
 * - 全部由**已解鎖的帳戶金鑰**簽章：canonical JSON 跟伺服器 `json.dumps(sort_keys=True, separators=(',', ':'),
 *   ensure_ascii=False)` 一字不差（mqttCredential.canonicalJson），request_id 每次新的（伺服器只收一次）。
 * - 時間戳用校正到伺服器的時鐘（nowMs，呼叫端給 mqtt.serverNow；開源第 4 步）：伺服器說時鐘差太多（401 clock_skew）就用它的時間
 *   重簽一次（signedPost.postSigned）。以前用本機時鐘、沒有重試：手機時鐘差 5 分鐘以上就永遠推不出去。
 * - **不送任何名字**：伺服器只收 type 與 isVideoCall（多一個欄位就 422），推播內容由伺服器組；
 *   收件端用已驗簽的寄件者公鑰查本機聯絡人取名字。以前 senderName／protectedName 原樣進 FCM →
 *   任何人都能讓別人的手機跳「〈媽媽〉來電」。
 * - 社群版（開源計畫決定 2）只送 message、incoming_call：守護／報平安不在 v1，chat 伺服器只收這兩種（多送 → 422）。
 *   官方完整版（VITE_AEGIS_EDITION=official）另外送 guardian_alert、check_in。
 * - 送到哪：執行期選的那台伺服器（開源第 5c 步，services/apiBase.apiBase()；以前寫死官方站的 PUSH_API_BASE）。
 * - 來電另外帶來電者簽的響鈴 token（ringToken，services/ringToken.ts；開源第 5d 步）：對方手機驗過才全螢幕響鈴、顯示名字。
 *   token 裡沒有名字（公鑰、callId、時間、亂數、是不是視訊）；伺服器原樣帶到推播裡（它也先驗一次）。
 */
import { canonicalJson, type IdentitySigner } from './mqttCredential';

export type PushHintType = 'message' | 'incoming_call' | 'guardian_alert' | 'check_in';

/** 伺服器收的推播提示：只有型別、「是不是視訊」與（來電的）響鈴 token */
export interface PushHint {
  type: PushHintType;
  isVideoCall?: boolean;
  ringToken?: string;
}

/** 響鈴 token 的外形（細節由 ringToken.parseRingToken 與伺服器驗）：不像的不送 */
const RING_TOKEN_SHAPE = /^r1\.[A-Za-z0-9_-]{40,800}\.[A-Za-z0-9_-]{86}$/;

export type AppEdition = 'community' | 'official';

/** 這個 build 是哪一版（第 5 步的版本切分之前：只看 VITE_AEGIS_EDITION，沒設 ＝ 社群版） */
export function appEdition(env: Record<string, unknown> | undefined = (import.meta as { env?: Record<string, unknown> }).env): AppEdition {
  return env?.VITE_AEGIS_EDITION === 'official' ? 'official' : 'community';
}

/** 這一版送哪些推播型別 */
export function pushHintTypes(edition: AppEdition = appEdition()): ReadonlySet<PushHintType> {
  return new Set<PushHintType>(edition === 'official'
    ? ['message', 'incoming_call', 'guardian_alert', 'check_in']
    : ['message', 'incoming_call']);
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function signed(signer: IdentitySigner, fields: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const body = { ...fields, timestamp: Math.floor(nowMs / 1000), request_id: requestId() };
  const signature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(body))));
  return { ...body, signature };
}

/**
 * 把呼叫端給的提示收斂成伺服器收的形狀（守護 SDK 給的是寬鬆型別，可能多帶欄位）。
 * 這一版不送的型別（社群版的 guardian_alert／check_in）、不認得的型別回 null（不送）；isVideoCall 只在真的是布林時帶；
 * ringToken 只有來電、而且長得像 token 時帶。
 */
export function serverPushHint(hint: { type: string; isVideoCall?: unknown; ringToken?: unknown }, edition: AppEdition = appEdition()): PushHint | null {
  if (!pushHintTypes(edition).has(hint.type as PushHintType)) return null;
  return {
    type: hint.type as PushHintType,
    ...(typeof hint.isVideoCall === 'boolean' ? { isVideoCall: hint.isVideoCall } : {}),
    ...(hint.type === 'incoming_call' && typeof hint.ringToken === 'string' && RING_TOKEN_SHAPE.test(hint.ringToken)
      ? { ringToken: hint.ringToken } : {}),
  };
}

/** POST /api/push/notify 的 body（action 在簽章內；伺服器自己重組 action 驗章） */
export function signedPushNotify(signer: IdentitySigner, recipientPublicKey: string, hint: PushHint, nowMs: number): Record<string, unknown> {
  return signed(signer, {
    action: 'push_notify',
    pubkey: signer.publicKey,
    recipient_pubkey: recipientPublicKey,
    notificationHint: hint,
  }, nowMs);
}

/** POST /api/push/register-token 的 body：token 掛在簽章者自己的公鑰下（伺服器自己算 hash） */
export function signedPushRegister(signer: IdentitySigner, token: string, platform: 'android' | 'ios', nowMs: number): Record<string, unknown> {
  return signed(signer, { action: 'push_register', pubkey: signer.publicKey, token, platform }, nowMs);
}

/**
 * POST /api/push/webpush/register 的 body（瀏覽器的 Web Push 訂閱，取代以前明文的 PUSH_SUBSCRIPTION_UPDATE 與沒有驗證的 mist relay）：
 * 訂閱只掛在簽章者自己的公鑰下；寄件人推播走同一支 /api/push/notify（伺服器送到收件人登記的每一個 FCM token 與 Web Push 訂閱）
 */
export function signedWebPushRegister(
  signer: IdentitySigner, sub: { endpoint: string; p256dh: string; auth: string }, nowMs: number,
): Record<string, unknown> {
  return signed(signer, {
    action: 'webpush_register', pubkey: signer.publicKey, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth,
  }, nowMs);
}

/** POST /api/push/webpush/unregister 的 body（只拿得掉自己的） */
export function signedWebPushUnregister(signer: IdentitySigner, endpoint: string, nowMs: number): Record<string, unknown> {
  return signed(signer, { action: 'webpush_unregister', pubkey: signer.publicKey, endpoint }, nowMs);
}

/**
 * 瀏覽器（PWA）的 Web Push 註冊（開源計畫決定 4、第 4 步）：訂閱只登記在 chat 伺服器、掛在簽章者自己的公鑰下
 * （POST /api/push/webpush/register，帳戶簽章、request_id 一次性、時鐘差 → clock_skew 重簽）。
 *
 * 取代：
 *   - 明文的 PUSH_SUBSCRIPTION_UPDATE（以前把自己的推播訂閱經 broker 傳給每個好友 —— broker 看得到、任何人都能冒名改掉別人存的訂閱）
 *   - 沒有驗證的 mist relay（以前寄件人拿著好友的訂閱去打舊 relay 的 /push —— 誰都能叫它推給任何訂閱）
 * 現在寄件人只叫 /api/push/notify（帳戶簽章，triggerFcmNotify），伺服器送到收件人登記的每一個 FCM token 與 Web Push 訂閱，
 * 內容只由伺服器組（零內容喚醒）。
 * 不在開 App 時跳權限詢問：已經允許通知（例如來電通知那裡允許過）才訂閱。VAPID 公鑰問伺服器（/api/chat/server-config），
 * 伺服器沒開 Web Push（vapid_public_key 是 null）就不訂。
 */
import { devLog, devWarn } from '../utils/devLog';
import { mqttService } from './mqtt';
import { signedWebPushRegister } from './pushRequest';
import { apiBase } from './apiBase';
import { postSigned } from './signedPost';
import { toBuffer } from '../utils/toBuffer';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 這個帳號在這個瀏覽器已經用「這一版的做法」訂閱並登記過（之後沿用那個訂閱；沒有這個記號 → 先退訂再重新訂閱） */
const registeredFlag = (publicKeyBase64: string) => `aegis_webpush_v2:${publicKeyBase64}`;

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key: string): void {
  try { localStorage.setItem(key, '1'); } catch { /* 存不進去：下次開啟再重新訂閱一次 */ }
}

/** 這個訂閱是用這把 VAPID 公鑰訂的嗎（舊版用寫死的金鑰或 build 時設的金鑰訂的 → 推播服務會拒絕伺服器的推播） */
function subscribedWithKey(subscription: PushSubscription, vapid: Uint8Array): boolean {
  const key = subscription.options?.applicationServerKey;
  if (!key) return false;
  const bytes = new Uint8Array(key);
  return bytes.length === vapid.length && bytes.every((b, i) => b === vapid[i]);
}

/** 伺服器的 VAPID 公鑰（server-config；沒開 Web Push → null） */
async function serverVapidKey(): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase()}/api/chat/server-config`, { credentials: 'omit' });
    if (!res.ok) return null;
    const cfg = (await res.json()) as { vapid_public_key?: unknown };
    return typeof cfg.vapid_public_key === 'string' && cfg.vapid_public_key.length > 40 ? cfg.vapid_public_key : null;
  } catch {
    return null;
  }
}

/**
 * 這個公鑰的 Web Push 訂閱登記到伺服器（App 開啟時呼叫一次；原生 App 走 FCM，不呼叫這裡）。
 * 沒有通知權限、沒有 service worker、伺服器沒開 Web Push、身分還沒解鎖 → 什麼都不做
 */
export async function registerWebPush(publicKeyBase64: string): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    const signer = mqttService.identitySignerFor(publicKeyBase64);
    if (!signer) return false;
    const vapid = await serverVapidKey();
    if (!vapid) return false;
    const vapidBytes = urlBase64ToUint8Array(vapid);
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    // 舊的訂閱（舊版訂的、別的 VAPID 金鑰訂的、或這個帳號還沒用這一版登記過）→ 退訂、重新訂閱（審查 M3）：
    //   舊版把訂閱（網址＋金鑰）明文經 broker 交給好友，拿到的人能叫舊的 relay 推任何內容、或把它登記到自己名下；
    //   別的金鑰訂的，推播服務會拒絕伺服器的推播，伺服器卻一直以為登記好了
    if (subscription && (!readFlag(registeredFlag(publicKeyBase64)) || !subscribedWithKey(subscription, vapidBytes))) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBuffer(vapidBytes) });
    }
    const p256dh = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');
    if (!p256dh || !auth) return false;
    const sub = { endpoint: subscription.endpoint, p256dh: bufferToBase64Url(p256dh), auth: bufferToBase64Url(auth) };
    const res = await postSigned(`${apiBase()}/api/push/webpush/register`, (nowMs) => signedWebPushRegister(signer, sub, nowMs),
      mqttService.signedClock());
    if (!res.ok) {
      devWarn('[WebPush] registration refused:', res.status);
      return false;
    }
    writeFlag(registeredFlag(publicKeyBase64));
    devLog('[WebPush] subscription registered');
    return true;
  } catch (err) {
    devWarn('[WebPush] registration failed:', err);
    return false;
  }
}

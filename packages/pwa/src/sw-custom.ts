/**
 * Phase 14: 自定義 Service Worker
 *
 * 處理 Share Target 的 POST 請求
 */

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { pushDisplayFor, type PushDisplay } from './services/pushDisplay';
import { decideRing } from './services/ringDirectory';

declare let self: ServiceWorkerGlobalScope;

// 擴展 NotificationOptions 以支援 vibrate 和 actions
interface ExtendedNotificationOptions extends NotificationOptions {
  vibrate?: number[];
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
}

// Workbox precaching
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ============================================
// MediaPipe CDN 資源快取（WASM + Model ~5MB）
// iPhone Safari 背景終止後 HTTP cache 不可靠，用 SW CacheFirst 確保持久化
// 臉部模型只有官方版用（AegisID）：社群版（__AEGIS_EDITION__ === 'chat'）的 service worker 不帶這兩條規則。
//   沒有 define 的建置（typeof 是 undefined）照舊註冊 —— 官方版的行為不變
// ============================================
if (!(typeof __AEGIS_EDITION__ !== 'undefined' && __AEGIS_EDITION__ === 'chat')) {
registerRoute(
  ({ url }) =>
    url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('mediapipe'),
  new CacheFirst({
    cacheName: 'mediapipe-wasm',
    plugins: [
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 }), // 30 天
    ],
  })
);

registerRoute(
  ({ url }) =>
    url.hostname === 'storage.googleapis.com' && url.pathname.includes('mediapipe-models'),
  new CacheFirst({
    cacheName: 'mediapipe-models',
    plugins: [
      new ExpirationPlugin({ maxEntries: 5, maxAgeSeconds: 30 * 24 * 60 * 60 }), // 30 天
    ],
  })
);
}

// ============================================
// Share Target 處理
// ============================================

// 監聽 fetch 事件，處理 Share Target POST 請求
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // 只處理 share-target 路徑的 POST 請求
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    // Share Target POST received

    event.respondWith(
      (async () => {
        try {
          // 獲取 FormData
          const formData = await event.request.formData();

          // 處理檔案
          const files: Array<{
            name: string;
            type: string;
            size: number;
            data: string;
          }> = [];

          const fileEntries = formData.getAll('files') as File[];
          for (const file of fileEntries) {
            try {
              // 讀取檔案為 base64
              const arrayBuffer = await file.arrayBuffer();
              const base64 = arrayBufferToBase64(arrayBuffer);
              const dataUrl = `data:${file.type || 'application/octet-stream'};base64,${base64}`;

              files.push({
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                data: dataUrl,
              });
            } catch (err) {
              console.error('[SW] Failed to read file:', file.name, err);
            }
          }

          // 建立分享資料
          const shareData = {
            title: formData.get('title') as string | null,
            text: formData.get('text') as string | null,
            url: formData.get('url') as string | null,
            files: files.map((f, index) => ({
              id: `share_${Date.now()}_${index}`,
              name: f.name,
              mimeType: f.type,
              size: f.size,
              dataUrl: f.data,
              receivedAt: Date.now(),
            })),
          };

          // Share data prepared: files=${shareData.files.length}

          // 使用 clients API 發送資料到主頁面
          const allClients = await self.clients.matchAll({ type: 'window' });

          if (allClients.length > 0) {
            // 發送分享資料到第一個 client
            allClients[0].postMessage({
              type: 'SHARE_TARGET_DATA',
              data: shareData,
            });
          }

          // 將資料編碼到 URL，重定向到 share-target 頁面
          // 由於資料可能很大，使用 sessionStorage 暫存
          // 這裡透過 URL 參數通知頁面有新分享
          const redirectUrl = new URL('/share-target', url.origin);
          redirectUrl.searchParams.set('_sw', '1');
          redirectUrl.searchParams.set('_ts', Date.now().toString());

          // 儲存到 Cache API (用於跨 SW-Client 傳輸大資料)
          const cache = await caches.open('share-target-data');
          const cacheKey = `share-data-${Date.now()}`;
          await cache.put(
            cacheKey,
            new Response(JSON.stringify(shareData), {
              headers: { 'Content-Type': 'application/json' },
            })
          );

          redirectUrl.searchParams.set('_cache', cacheKey);

          return Response.redirect(redirectUrl.toString(), 303);
        } catch (err) {
          console.error('[SW] Share Target error:', err);
          // 發生錯誤時，重定向到主頁面
          return Response.redirect('/', 303);
        }
      })()
    );
  }
});

// ArrayBuffer 轉 Base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================
// SW 生命週期
// ============================================

// SW 安裝 — 不 skipWaiting，等所有 tab 關閉後自然接管
// skipWaiting + clients.claim 會在所有平台觸發頁面 reload，
// 且 iOS Safari 的 reload 會清空 localStorage → 使用者被迫重新註冊
self.addEventListener('install', () => {
  console.log('[SW] Installed — will activate on next app launch');
});

// 激活時清理舊快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    purgeStaleShareTargetCache()
  );
  console.log('[SW] Activated');
});

/** Remove share-target-data cache entries older than 1 hour */
async function purgeStaleShareTargetCache(): Promise<void> {
  try {
    const cache = await caches.open('share-target-data');
    const keys = await cache.keys();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) { await cache.delete(request); continue; }
      // Extract timestamp from cache key URL (share-data-<timestamp>)
      const urlPath = new URL(request.url).pathname;
      const tsMatch = urlPath.match(/share-data-(\d+)/);
      if (tsMatch) {
        const ts = parseInt(tsMatch[1], 10);
        if (Date.now() - ts > ONE_HOUR) {
          await cache.delete(request);
        }
      }
    }
  } catch {
    // Cache API unavailable — ignore
  }
}

// 監聽來自 client 的訊息
self.addEventListener('message', (event) => {
  // 處理來電通知請求（從主頁面觸發）
  if (event.data?.type === 'SHOW_CALL_NOTIFICATION') {
    void showLocalCallNotification(event.data.payload);
  }

  // 取消來電通知
  if (event.data?.type === 'CANCEL_CALL_NOTIFICATION') {
    const tag = event.data.tag || 'incoming-call';
    self.registration.getNotifications({ tag }).then((notifications) => {
      notifications.forEach((n) => n.close());
    });
  }
});

// ============================================
// Web Push 來電通知處理
// ============================================

/**
 * 生成長震動模式（約 30 秒的循環震動）
 * 模式：震動 500ms，停 200ms，震動 200ms，停 200ms，震動 500ms，停 2000ms
 * 一個週期約 3.6 秒，重複 8 次 ≈ 30 秒
 */
function generateLongVibrationPattern(): number[] {
  const singlePattern = [500, 200, 200, 200, 500, 2000];
  const pattern: number[] = [];
  // 重複 8 次，約 30 秒
  for (let i = 0; i < 8; i++) {
    pattern.push(...singlePattern);
  }
  return pattern;
}

/**
 * 顯示推播通知（開源第 4 步審查 M4）：只用 pushDisplayFor 決定的固定文字 ——
 * 推播裡的名字、標題、內文、圖示網址一律不採用（推播沒有寄件人簽章，推得動的人能塞任何東西）。
 * 來電的樣子（接聽／拒接、長震動、不會自己消失）只給 display.ring：來電者簽的響鈴 token 驗過（開源第 5d 步，decideRing）；
 * 驗不過的來電推播是一則一般通知（點了開 App；滑掉不算拒接）
 */
async function showPushNotification(display: PushDisplay): Promise<void> {
  if (display.kind === 'incoming_call' && display.ring) {
    const callOptions: ExtendedNotificationOptions = {
      body: display.body,
      icon: '/icon-192x192.png',
      badge: '/icon-72x72.png',
      tag: display.tag,  // 同一時間只顯示一個來電通知
      requireInteraction: true,  // 不會自動消失
      vibrate: generateLongVibrationPattern(),
      data: {
        type: 'incoming_call',
        isVideoCall: display.isVideoCall,
        timestamp: Date.now(),
      },
      actions: [
        {
          action: 'accept',
          title: display.isVideoCall ? '📹 接聽' : '📞 接聽',
        },
        {
          action: 'reject',
          title: '❌ 拒接',
        },
      ],
    };
    await self.registration.showNotification(display.title, callOptions);
    return;
  }
  const guardian = display.kind === 'guardian_alert';
  const options: ExtendedNotificationOptions = {
    body: display.body,
    icon: '/icon-192x192.png',
    badge: '/icon-72x72.png',
    tag: display.tag,
    requireInteraction: guardian,
    vibrate: guardian ? [300, 200, 300] : [200, 100, 200],
    data: {
      // 驗不過的來電推播當一般通知：點了只開 App、滑掉不送「拒接」（不能讓偽造的推播掛掉真的來電）
      type: display.kind === 'incoming_call' ? 'message' : display.kind,
      timestamp: Date.now(),
    },
  };
  await self.registration.showNotification(display.title, options);
}

/**
 * App 視窗自己要顯示的來電通知（postMessage，只有同一個 origin 的頁面送得進來 —— 不是推播）：名字是 App 用封好的來電信令的
 * 寄件人查本機聯絡人得到的，可以顯示；推播來的一律不帶名字（showPushNotification）
 */
async function showLocalCallNotification(payload: unknown): Promise<void> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const name = typeof p.callerName === 'string' ? p.callerName.trim().slice(0, 64) : '';
  await showPushNotification(pushDisplayFor({ type: 'incoming_call' }, Date.now(), { name, video: p.isVideoCall === true }));
}

// 監聽 Push 事件（從伺服器推送）：內容解析不了也照樣顯示一則固定的通知（userVisibleOnly）
self.addEventListener('push', (event: PushEvent) => {
  let data: unknown = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (e) {
    console.error('[SW] Failed to parse push data:', e);
  }
  // 來電：只有來電者簽的響鈴 token 驗過才是來電的樣子、才有名字（本機存的；開源第 5d 步，services/ringDirectory.ts）
  event.waitUntil(decideRing(data, Date.now()).then((ring) => showPushNotification(pushDisplayFor(data, Date.now(), ring))));
});

// 監聽通知點擊事件
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  // Notification clicked

  const notification = event.notification;
  const data = notification.data || {};

  // 關閉通知
  notification.close();

  // 處理來電通知的按鈕
  if (data.type === 'incoming_call') {
    if (event.action === 'accept') {
      // 接聽：打開 App 並傳遞接聽指令
      event.waitUntil(
        openAppWithAction('ACCEPT_CALL', {
          isVideoCall: data.isVideoCall === true,
        })
      );
    } else if (event.action === 'reject') {
      // 拒接：發送拒接指令給已開啟的 client
      event.waitUntil(
        sendMessageToClients({
          type: 'REJECT_CALL',
        })
      );
    } else {
      // 點擊通知本身（非按鈕）：打開 App 顯示來電介面
      event.waitUntil(
        openAppWithAction('OPEN_CALL', {
          isVideoCall: data.isVideoCall === true,
        })
      );
    }
  }
  // 處理守護警告通知 — 開啟 App 到守護頁面
  else if (data.type === 'guardian_alert') {
    event.waitUntil(openAppWithAction('OPEN_GUARDIAN', {}));
  }
  // 處理一般訊息通知
  else {
    event.waitUntil(openApp());
  }
});

// 監聽通知關閉事件（用戶滑掉通知）
self.addEventListener('notificationclose', (event: NotificationEvent) => {
  // Notification dismissed

  const data = event.notification.data || {};

  // 如果是來電通知被關閉，視為拒接
  if (data.type === 'incoming_call') {
    event.waitUntil(
      sendMessageToClients({
        type: 'REJECT_CALL',
        reason: 'notification_dismissed',
      })
    );
  }
});

/**
 * 打開 App 並傳遞動作
 */
async function openAppWithAction(
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  // 如果已有開啟的視窗，focus 並發送訊息
  if (allClients.length > 0) {
    const client = allClients[0] as WindowClient;
    await client.focus();
    client.postMessage({
      type: action,
      ...payload,
    });
  } else {
    // 否則開啟新視窗
    const url = new URL('/', self.location.origin);
    url.searchParams.set('action', action.toLowerCase());

    await self.clients.openWindow(url.toString());
  }
}

/**
 * 打開 App（簡單版）
 */
async function openApp(): Promise<void> {
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  if (allClients.length > 0) {
    const client = allClients[0] as WindowClient;
    await client.focus();
  } else {
    await self.clients.openWindow('/');
  }
}

/**
 * 發送訊息給所有 clients
 */
async function sendMessageToClients(
  message: Record<string, unknown>
): Promise<void> {
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of allClients) {
    client.postMessage(message);
  }
}

/**
 * 頁面這一邊：把驗來電推播（響鈴 token，開源第 5d 步）要的本機資料交給收推播的那一條路，登出時清掉。
 *   網頁版（PWA）：service worker 讀 IndexedDB（services/ringDirectory.ts）—— 我是誰、好友（沒封鎖的）的公鑰 → 名字、時鐘差
 *   原生 App：RingContext 外掛（我是誰、時鐘差）；好友名單原生端自己讀 App 的 SQLite
 * 時鐘差用有上限的那一個（mqtt.boundedNow：最多 ±5 分鐘；安全審查 H2 —— 營運方回假的 serverTime，收件端就會把錄下來的
 * 舊 token 當成新的）。名單沒變（含時鐘差，以秒計）就不重寫。封鎖名單查不了的好友當成封鎖（不響）。
 * 同步與清除一個接一個做（審查 L1）：登出時還在跑的同步（每個好友都要查一次封鎖名單）不能在清掉之後又把名單寫回去 ——
 * 清掉之後就不再同步，直到聊天畫面換了帳號（或重新登入）呼叫 reopenRingSync（登出、換機之後頁面本來就會重新載入）。
 */
import { mqttService } from './mqtt';
import { isBlacklisted } from './localBlacklist';
import { isNativeApp } from './capacitor';
import { clearRingDirectory, saveRingDirectory } from './ringDirectory';
import { clampRingOffset } from './ringToken';
import { RingContext } from '../plugins/ringContext';

let lastKey = '';
let cleared = false;
let chain: Promise<unknown> = Promise.resolve();

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function syncRing(me: string, friends: ReadonlyArray<{ publicKey: string; name: string }>): Promise<void> {
  return queue(async () => {
    if (!me || cleared) return;
    const offsetMs = clampRingOffset(Math.round(mqttService.boundedNow() - Date.now()));
    const native = isNativeApp();
    const entries: Array<[string, string]> = [];
    if (!native) {
      for (const f of friends) {
        if (!f?.publicKey || f.publicKey === me) continue;
        if (await isBlacklisted(f.publicKey).catch(() => true)) continue;
        entries.push([f.publicKey, String(f.name ?? '').trim().slice(0, 64)]);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    const key = JSON.stringify([native, me, Math.round(offsetMs / 1000), entries]);
    if (key === lastKey || cleared) return;
    if (native) {
      await RingContext.set({ me, clockOffsetMs: offsetMs });
    } else {
      await saveRingDirectory({ me, friends: Object.fromEntries(entries), offsetMs, at: Date.now() });
    }
    lastKey = key;
  });
}

/** 聊天畫面為一個（新）登入的帳號掛上：清除之後可以再同步（useRingDirectory 在帳號變了時呼叫；複審 L4：被踢後沒重新載入又登入，不能一直不響） */
export function reopenRingSync(): void {
  cleared = false;
}

/** 帳號離開這台（登出、被踢、換機）：名單、看過的來電、原生端的「我是誰」都清掉。失敗只記 log，不擋登出 */
export function clearRingData(): Promise<void> {
  cleared = true;
  lastKey = '';
  return queue(async () => {
    await clearRingDirectory().catch((err) => console.error('[RingSync] clearing the ring directory failed:', err));
    if (isNativeApp()) {
      await RingContext.clear().catch((err) => console.error('[RingSync] clearing the native ring context failed:', err));
    }
  });
}

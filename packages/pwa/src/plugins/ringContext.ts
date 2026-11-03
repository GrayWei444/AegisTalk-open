import { registerPlugin } from '@capacitor/core';

/**
 * 原生 App 驗來電推播的響鈴 token（開源第 5d 步；Android RingContextPlugin → AegisFCMService／RingToken.kt）要的兩樣東西：
 * 我的身分公鑰、校正到伺服器的時鐘差。好友名單原生端自己讀 App 的 SQLite（LocalSenders），這裡不送。
 * 登出／被踢／換機時 clear()。網頁版沒有原生端：什麼都不做（Web Push 那一條用 IndexedDB，見 services/ringDirectory.ts）。
 */
export interface RingContextPluginInterface {
  set(options: { me: string; clockOffsetMs: number }): Promise<{ saved: boolean }>;
  clear(): Promise<{ cleared: boolean }>;
}

export const RingContext = registerPlugin<RingContextPluginInterface>('RingContext', {
  web: {
    async set() { return { saved: false }; },
    async clear() { return { cleared: true }; },
  },
});

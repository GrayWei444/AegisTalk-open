/**
 * 聊天畫面掛著的期間，把驗來電推播要的本機資料（我是誰、好友名單、時鐘差）同步給收推播的那一條路（services/ringSync.ts；
 * 開源第 5d 步）：好友或封鎖名單變了就同步，另外每 5 分鐘一次（時鐘差）。在背景做，不擋畫面。
 */
import { useEffect, useRef } from 'react';
import { onBlacklistChanged } from '../services/localBlacklist';
import { reopenRingSync, syncRing } from '../services/ringSync';

const RESYNC_MS = 5 * 60_000;

export function useRingDirectory(publicKey: string | null | undefined, friends: ReadonlyArray<{ publicKey: string; name: string }>): void {
  // 這個畫面掛上之後帳號變了（含第一次）：清除過的同步可以再開（登出之後還掛著、同一個帳號沒變 → 不重開）
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!publicKey) return;
    if (syncedFor.current !== publicKey) {
      syncedFor.current = publicKey;
      reopenRingSync();
    }
    const run = () => { syncRing(publicKey, friends).catch((err) => console.error('[RingSync] sync failed:', err)); };
    run();
    const offBlock = onBlacklistChanged(run);
    const timer = setInterval(run, RESYNC_MS);
    return () => { offBlock(); clearInterval(timer); };
  }, [publicKey, friends]);
}

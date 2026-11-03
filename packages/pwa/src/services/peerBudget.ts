/**
 * 每個對象一個小額度（token bucket，對應群星 e1b119c7，審查 LOW）：控制類訊息（群組金鑰信封、索取、回覆索取）
 * 超過額度就不處理。記錄的對象數有上限，最久沒動的先丟（被丟的人下次從滿額開始）—— 對方換再多身分也撐不大這張表。
 * p2pSend 的回條額度是同一套、寫在 p2pSend 裡（那個檔案的測試用 vm 載入，多一個 import 要改一堆測試）。
 */
export interface PeerBudget {
  /** 扣 cost；額度不夠回 false（不扣） */
  take(peer: string, cost?: number, now?: number): boolean;
  clear(): void;
}

export function createPeerBudget(opts: { capacity: number; refillPerSec: number; maxPeers: number }): PeerBudget {
  let buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(peer, cost = 1, now = Date.now()) {
      const prev = buckets.get(peer);
      const tokens = prev
        ? Math.min(opts.capacity, prev.tokens + (Math.max(0, now - prev.at) / 1000) * opts.refillPerSec)
        : opts.capacity;
      const ok = tokens >= cost;
      buckets.delete(peer);
      buckets.set(peer, { tokens: ok ? tokens - cost : tokens, at: now });
      if (buckets.size > opts.maxPeers) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      return ok;
    },
    clear() {
      buckets = new Map();
    },
  };
}

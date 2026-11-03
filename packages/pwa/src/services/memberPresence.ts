/**
 * 同群組、但不是好友的人在不在線（W4，docs/GROUP_LOG_WIRING_W4.md）。好友的上線狀態走秘密 presence（presenceService）；
 * 非好友的同群成員拿不到我的 presence 秘密、我也拿不到他的 —— 改看兩樣東西：
 *   - 群組主題上驗過的 here／sync（群組引擎 deps.onMemberSeen）：他剛真的連上（here 是 QoS0、5 分鐘的新鮮度，broker 不替離線的人排隊）
 *   - P2P：通道開著 ＝ 在線；通道關了（他關 App、斷線）＝ 當作離線（「離線」從 P2P 的狀態推出來）
 * here 之後 HERE_TTL_MS 內沒有通道也沒有新的 here → 不再當作在線（健康檢查不會為一個早就走掉的人一直重連）。
 * 純狀態，時間與通知由呼叫端給（測試可以控制）。
 */
export const HERE_TTL_MS = 10 * 60_000;
const MAX_TRACKED = 1024;

export interface MemberPresence {
  /** 驗過的 here／sync 從 pk 來（他剛連上） */
  seen(pk: string): void;
  /** 跟 pk 的 P2P 通道關了 */
  closed(pk: string): void;
  /** here 之後還在 TTL 內（呼叫端另外看通道開著沒） */
  recentlySeen(pk: string): boolean;
  onChange(cb: (pk: string) => void): () => void;
  reset(): void;
}

export function createMemberPresence(opts: { now?: () => number; ttlMs?: number } = {}): MemberPresence {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? HERE_TTL_MS;
  const seenAt = new Map<string, number>();
  const listeners = new Set<(pk: string) => void>();
  const notify = (pk: string) => {
    for (const cb of listeners) {
      try { cb(pk); } catch (e) { console.error('[memberPresence] listener failed:', e); }
    }
  };
  const recentlySeen = (pk: string): boolean => {
    const at = seenAt.get(pk);
    return at !== undefined && now() - at < ttl;
  };
  return {
    seen(pk) {
      const was = recentlySeen(pk);
      seenAt.delete(pk);
      seenAt.set(pk, now());
      if (seenAt.size > MAX_TRACKED) seenAt.delete(seenAt.keys().next().value as string);
      // 只有「原本不算在線 → 在線」才通知：一個成員一直發 here 不會讓畫面一直重畫（審查 W4 #14）
      if (!was) notify(pk);
    },
    closed(pk) {
      if (seenAt.delete(pk)) notify(pk);
    },
    recentlySeen,
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    reset() {
      seenAt.clear();
    },
  };
}

/** 畫面與健康檢查用的「在線」：好友看驗過的 presence；其他人看最近的 here 與 P2P 通道 */
export function peerOnline(pk: string, d: { friendOnline(pk: string): boolean; recentlySeen(pk: string): boolean; channelOpen(pk: string): boolean }): boolean {
  return d.friendOnline(pk) || d.channelOpen(pk) || d.recentlySeen(pk);
}

/** App 用的那一份（AppProvider 換帳號時 reset） */
export const memberPresence = createMemberPresence();

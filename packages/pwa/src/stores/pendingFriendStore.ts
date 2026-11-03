import { create } from 'zustand';

/**
 * 我加了對方、還在等對方確認的好友（程式碼審查 M1）。
 *
 * 加好友的一方（掃 QR、輸入短碼）送出 X3DH_INIT 時，對方已經進了我的好友清單、session 也建好了；可是對方可能
 * 很久之後才處理那封 INIT（掃完就鎖屏、離線佇列），也可能拒收（憑證過期、被封鎖）。以前畫面馬上說「已加入」——
 * 對方其實沒加的話，我傳過去的訊息他全部丟掉，兩邊都不知道。
 *
 * 現在記成「等待確認」（記著這封 INIT 的 ephemeral），只認兩種確認（AppProvider 呼叫 confirm）：
 *   - 對方收下 INIT 回的 PROFILE_UPDATE，帶著**這封 INIT 的 ephemeral**（initEph）—— 一般的個人資料更新、回舊 INIT 的不算；
 *   - 第一則解得開的對方訊息（解得開＝他用的是這次建的 session）。
 * 對方自己送來的 X3DH_INIT 不算：MQTT 的 from 誰都能填。
 * 好友清單、聊天室看得到這個狀態，可以取消（＝刪掉這個好友；刪好友一律清掉，見 chatStore.removeFriend）。
 * 依帳號分開（同一台手機換帳號不互通）；存在 localStorage，重開 App 還在。
 */

export type PendingVia = 'qr' | 'code';
/** eph：這次送出的 X3DH_INIT 的 ephemeral 公鑰（建 session 前就失敗的話沒有） */
export type PendingFriend = { owner: string; pk: string; via: PendingVia; eph?: string; since: number };

/** 等多久還沒確認，就改說「對方還沒確認，他打開 App 就會加上…」 */
export const FRIEND_CONFIRM_WAIT_MS = 2 * 60 * 1000;

const KEY = 'aegis_friend_pending_v1';
const MAX_ENTRIES = 200;

function isEntry(e: unknown): e is PendingFriend {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return typeof x.owner === 'string' && typeof x.pk === 'string' && (x.via === 'qr' || x.via === 'code')
    && typeof x.since === 'number' && (x.eph === undefined || typeof x.eph === 'string');
}

function load(): PendingFriend[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function save(entries: PendingFriend[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* 無 storage：這次開著的 App 裡照樣顯示，重開後不記得 —— 不影響加好友本身 */
  }
}

export function findPending(entries: readonly PendingFriend[], owner: string | null | undefined, pk: string): PendingFriend | undefined {
  return owner ? entries.find((e) => e.owner === owner && e.pk === pk) : undefined;
}

/**
 * 加好友的一方畫面上該說什麼：還在等（2 分鐘內）、等太久還沒確認、已確認（等待記錄已經被 confirm 拿掉）。
 */
export function addFriendPhase(since: number, stillPending: boolean, now: number): 'waiting' | 'unconfirmed' | 'confirmed' {
  if (!stillPending) return 'confirmed';
  return now - since < FRIEND_CONFIRM_WAIT_MS ? 'waiting' : 'unconfirmed';
}

interface PendingFriendState {
  entries: PendingFriend[];
  /** 加好友時記下（同一個人再加一次就重新計時）；eph 是這次送出的 INIT 的 ephemeral，知道了再記一次 */
  markPending: (owner: string, pk: string, via: PendingVia, eph?: string, now?: number) => void;
  /**
   * 對方確認了。initEph：對方回的 PROFILE_UPDATE 說他收下的是哪封 INIT —— 要等於記著的那封才算；
   * 不給（解得開他的訊息）就直接算。回傳有沒有確認到
   */
  confirm: (owner: string, pk: string, initEph?: string) => boolean;
  /** 使用者取消 */
  cancel: (owner: string, pk: string) => void;
  /** 刪掉這個好友（chatStore.removeFriend）：不管哪個帳號記的，一律不再等他 */
  forgetPeer: (pk: string) => void;
}

export const usePendingFriendStore = create<PendingFriendState>((set, get) => {
  const removeWhere = (drop: (e: PendingFriend) => boolean): boolean => {
    const before = get().entries;
    const entries = before.filter((e) => !drop(e));
    if (entries.length === before.length) return false;
    save(entries);
    set({ entries });
    return true;
  };
  return {
    entries: load(),
    markPending: (owner, pk, via, eph, now = Date.now()) => {
      if (!owner || !pk) return;
      const entry: PendingFriend = eph ? { owner, pk, via, eph, since: now } : { owner, pk, via, since: now };
      const entries = [...get().entries.filter((e) => !(e.owner === owner && e.pk === pk)), entry].slice(-MAX_ENTRIES);
      save(entries);
      set({ entries });
    },
    confirm: (owner, pk, initEph) => removeWhere((e) => e.owner === owner && e.pk === pk
      && (initEph === undefined || (e.eph !== undefined && e.eph === initEph))),
    cancel: (owner, pk) => { removeWhere((e) => e.owner === owner && e.pk === pk); },
    forgetPeer: (pk) => { removeWhere((e) => e.pk === pk); },
  };
});

/**
 * Group Store - 群組狀態（畫面用）
 *
 * 名冊、角色、名稱、頭像、類型、守護設定**只來自套上的狀態鏈**（services/groupEngine，docs/GROUP_LOG_WIRING_W1.md）：
 * 引擎每套上一筆 commit、拿到一代金鑰、加入或離開一個群，就把投影交給 _applyChainGroup／_removeChainGroup。
 * 這裡沒有任何「改名冊」的動作：建群、加人、踢人、離開、改名、改角色都由 useGroupChat 交給引擎寫 commit，
 * 等 commit 在伺服器 log 上套用了才回到這裡。
 * 本機才有的東西（未讀數、目前選的群、成員暱稱快取）照舊在這裡管。
 *
 * 視圖群組設計（訊息）沿用：群組訊息存在 messages 表、以 group_ids 標記（fetchGroupMessages）。
 */

import { create } from 'zustand';
import type { Group, Message } from '../types';
import * as storage from '../services/storage';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { backup } from '@ext/backup';

/** 群組變動 → 帳號備份要重寫（官方版 AegisID 雲端 blob；社群版目前沒有備份） */
function markBlobDirty(): void {
  backup.markDirty();
}

/** 冷啟動重試計數器 (防止 SQLite 尚未就緒時丟失群組) */
let _groupLoadRetryCount = 0;
const MAX_GROUP_LOAD_RETRIES = 3;

/** 引擎在跑的時候，整份重載以引擎記憶體裡的投影為準（資料庫那份可能晚一步） */
let chainProjector: (() => Map<string, Group> | null) | null = null;

export function registerChainProjector(fn: (() => Map<string, Group> | null) | null): void {
  chainProjector = fn;
}

// ============================================
// 狀態類型
// ============================================

interface GroupState {
  /** 所有群組 */
  groups: Group[];
  /** 當前選中的群組 ID */
  currentGroupId: string | null;
  /** 是否已從本地載入 */
  isLoaded: boolean;

  /** 選擇群組 */
  selectGroup: (groupId: string) => void;
  /** 清除選擇 */
  clearSelection: () => void;

  /** 狀態鏈套用後的投影（只有群組引擎呼叫）：新的群、名冊／角色／資訊／金鑰狀態變了 */
  _applyChainGroup: (group: Group) => void;
  /** 這個群在這台不在了（被踢、離開、刪群；只有群組引擎呼叫） */
  _removeChainGroup: (groupId: string) => void;

  /** 更新成員暱稱（本機快取：好友名稱或對方群訊帶的 senderName；不影響任何權限） */
  updateMemberNickname: (groupId: string, publicKey: string, nickname: string) => void;
  /** 取得群組成員 */
  getMembers: (groupId: string) => Group['members'];
  /** 取得除了自己以外的群組成員公鑰 */
  getOtherMemberPublicKeys: (groupId: string, myPublicKey: string) => string[];

  /** 標記為已讀 */
  markAsRead: (groupId: string) => void;
  /** 增加未讀數 */
  incrementUnread: (groupId: string) => void;

  /** 從本地儲存載入（投影表；引擎在跑時以引擎的投影為準） */
  loadFromStorage: (myPublicKey: string) => Promise<void>;
  /** 重置所有資料 */
  resetAll: () => void;
  /** 根據 ID 取得群組 */
  getGroupById: (groupId: string) => Group | undefined;
}

/** 本機才有的欄位留著（未讀、最後一則、暱稱快取），鏈上的欄位用新的 */
function mergeLocal(next: Group, prev: Group | undefined): Group {
  if (!prev) return next;
  const nick = new Map(prev.members.map((m) => [m.publicKey, m.nickname]));
  return {
    ...next,
    members: next.members.map((m) => ({ ...m, nickname: m.nickname ?? nick.get(m.publicKey) })),
    unreadCount: prev.unreadCount,
    lastMessage: prev.lastMessage,
    lastMessageTime: prev.lastMessageTime,
  };
}

// ============================================
// Store 實作
// ============================================

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [],
  currentGroupId: null,
  isLoaded: false,

  selectGroup: (groupId) => {
    set({ currentGroupId: groupId });
    get().markAsRead(groupId);
  },

  clearSelection: () => set({ currentGroupId: null }),

  _applyChainGroup: (group) => {
    set((state) => {
      const prev = state.groups.find((g) => g.id === group.id);
      const merged = mergeLocal(group, prev);
      return {
        groups: prev ? state.groups.map((g) => (g.id === group.id ? merged : g)) : [...state.groups, merged],
        isLoaded: true,
      };
    });
    markBlobDirty();
  },

  _removeChainGroup: (groupId) => {
    if (!get().groups.some((g) => g.id === groupId)) return;
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== groupId),
      currentGroupId: state.currentGroupId === groupId ? null : state.currentGroupId,
    }));
    devLog('[groupStore] Group gone from this device:', groupId);
    markBlobDirty();
  },

  updateMemberNickname: (groupId, publicKey, nickname) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    const member = group.members.find((m) => m.publicKey === publicKey);
    if (!member || member.nickname === nickname) return;

    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId
          ? { ...g, members: g.members.map((m) => (m.publicKey === publicKey ? { ...m, nickname } : m)) }
          : g
      ),
    }));

    if (storage.isInitialized()) {
      storage.updateGroupMemberNickname(groupId, publicKey, nickname).catch(() => {});
    }
  },

  getMembers: (groupId) => {
    const group = get().groups.find((g) => g.id === groupId);
    return group?.members || [];
  },

  getOtherMemberPublicKeys: (groupId, myPublicKey) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return [];
    return group.members.filter((m) => m.publicKey !== myPublicKey).map((m) => m.publicKey);
  },

  markAsRead: (groupId) => {
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, unreadCount: 0 } : g)),
    }));
    // 持久化已讀到 SQLite（fire-and-forget）。否則只動記憶體 → restart 後 getGroupUnreadCount
    //   重新數 read_at IS NULL → 讀過的群組訊息又冒出未讀（1-1 有持久化故無此問題）。
    if (storage.isInitialized()) {
      storage.markGroupMessagesAsRead(groupId).catch((err) =>
        devWarn('[groupStore] markGroupMessagesAsRead failed:', err));
    }
  },

  incrementUnread: (groupId) => {
    // 如果當前正在看這個群組，不增加未讀數
    const { currentGroupId } = get();
    if (currentGroupId === groupId) return;

    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, unreadCount: (g.unreadCount || 0) + 1 } : g)),
    }));
  },

  loadFromStorage: async (myPublicKey) => {
    devLog('[groupStore] loadFromStorage called (retry:', _groupLoadRetryCount, ')');

    if (!storage.isInitialized()) {
      devLog('[groupStore] Storage not initialized yet');
      // 冷啟動時 SQLite 可能尚未就緒，延遲重試
      if (_groupLoadRetryCount < MAX_GROUP_LOAD_RETRIES) {
        _groupLoadRetryCount++;
        const delay = 500 * _groupLoadRetryCount;
        setTimeout(() => {
          if (get().groups.length === 0) get().loadFromStorage(myPublicKey);
        }, delay);
      }
      return;
    }

    try {
      // 投影表（groups／group_members）是群組引擎套用鏈時一起寫的；引擎在跑就用它記憶體裡的（不會比資料庫舊）
      const live = chainProjector?.() ?? null;
      const storedGroups = await storage.getGroupsForUser(myPublicKey);
      const groups: Group[] = [];

      for (const sg of storedGroups) {
        const unreadCount = await storage.getGroupUnreadCount(sg.id);
        const fromChain = live?.get(sg.id);
        if (live && !fromChain) continue;   // 引擎不認得 → 不是這個帳號套上的鏈（殘留的投影）
        if (fromChain) {
          groups.push({ ...fromChain, unreadCount });
          continue;
        }
        const storedMembers = await storage.getGroupMembers(sg.id);
        let guardianSettings: import('../types').GuardianGroupSettings | undefined;
        if (sg.guardianSettings) {
          try { guardianSettings = JSON.parse(sg.guardianSettings); } catch { /* ignore */ }
        }
        groups.push({
          id: sg.id,
          name: sg.name,
          avatar: sg.avatar || undefined,
          members: storedMembers.map((sm) => ({
            publicKey: sm.pubkey,
            nickname: sm.nickname || undefined,
            role: sm.role,
            joinedAt: sm.joinedAt,
            isOnline: sm.pubkey === myPublicKey,
          })),
          createdAt: sg.createdAt,
          createdBy: sg.createdBy,
          updatedAt: sg.updatedAt,
          unreadCount,
          groupType: (sg.groupType as 'normal' | 'guardian') || undefined,
          guardianSettings,
        });
      }
      // 引擎套上了、但投影還沒寫進資料庫的群（剛加入）也要在
      for (const [gid, g] of live ?? new Map<string, Group>()) {
        if (!groups.some((x) => x.id === gid)) groups.push(g);
      }

      // 暱稱快取照舊留著；未讀數以資料庫重數的為準
      set((state) => ({
        groups: groups.map((g) => ({ ...mergeLocal(g, state.groups.find((p) => p.id === g.id)), unreadCount: g.unreadCount })),
        isLoaded: true,
      }));
      _groupLoadRetryCount = 0;
      diagLog('[DIAG:GROUP] loadFromStorage:', groups.length, 'groups', groups.map(g => `${g.id.slice(-8)}(${g.members.length}m)`).join(', '));
    } catch (err) {
      console.error('[groupStore] Failed to load from storage:', err);
      if (_groupLoadRetryCount < MAX_GROUP_LOAD_RETRIES) {
        _groupLoadRetryCount++;
        const delay = 1000 * _groupLoadRetryCount;
        setTimeout(() => get().loadFromStorage(myPublicKey), delay);
      } else {
        set({ isLoaded: true });
        _groupLoadRetryCount = 0;
      }
    }
  },

  resetAll: () => {
    set({
      groups: [],
      currentGroupId: null,
      isLoaded: false,
    });
    devLog('[groupStore] Reset complete');
  },

  getGroupById: (groupId) => {
    return get().groups.find((g) => g.id === groupId);
  },
}));

// ============================================
// 便利 Hooks
// ============================================

export function useCurrentGroup(): Group | undefined {
  return useGroupStore((state) => {
    if (!state.currentGroupId) return undefined;
    return state.groups.find((g) => g.id === state.currentGroupId);
  });
}

/**
 * 取得群組訊息（視圖模式）
 * 從 storage 中查詢帶有此 groupId 的訊息
 */
export async function fetchGroupMessages(groupId: string): Promise<Message[]> {
  // 視圖模式：從 storage 中查詢
  if (!groupId || !storage.isInitialized()) return [];

  const storedMessages = await storage.getMessagesByGroupId(groupId, 100);
  return storedMessages.map((m) => ({
    id: m.id,
    senderId: m.isOutgoing ? 'me' : m.senderPubkey,
    content: m.content,
    timestamp: m.createdAt,
    type: m.type,
    isRead: m.readAt !== null,
    isBurned: false,
    ttl: m.ttl || undefined,
    groupIds: m.groupIds,
    recipientPubkey: m.senderPubkey, // 對於接收的訊息，sender 就是對話對象
  }));
}

export function useGroupCount(): number {
  return useGroupStore((state) => state.groups.length);
}

export default useGroupStore;

import { create } from 'zustand';
import type { Friend, Message, TrustLevel, PushSubscriptionData, L2Result, PaymentData } from '../types';
import * as storage from '../services/storage';
import * as db from '../services/database';
import { broadcastProfileUpdate } from '../services/directSignal';
import { generateId } from '../utils/secureId';
import { devLog, devWarn } from '../utils/devLog';
import { backup } from '@ext/backup';

/** 好友／名字變動 → 帳號備份要重寫（官方版 AegisID 雲端 blob；社群版目前沒有備份） */
function markBlobDirty(): void {
  backup.markDirty();
}
import { clearPeerSession } from '../services/cryptoSessionControl';
import { webrtcService } from '../services/webrtc';
import { usePendingFriendStore } from './pendingFriendStore';

// 用戶設定儲存 key
const USER_PROFILE_KEY = 'mist_user_profile';
// 重登（closeConnection+reload）後 jeep-sqlite（web）連線 readiness 偶發 >幾秒，loadFromStorage
//   可能載到 0 聯絡人並 latch isLoaded:true → 好友清單空掉。下方排程背景重載自癒（不阻塞首屏、
//   不延遲真新用戶）。限制次數避免無限迴圈。
let _emptyReloadCount = 0;
/** 冷啟動時等好友清單載入的上限（findFriendSettled） */
const FRIEND_WAIT_MS = 8_000;

/**
 * 刪好友「真的刪完」（記憶體＋資料庫的 contacts 都沒有他了）之後通知（W5）。presence 換秘密要在這之後再比對一次：
 * 記憶體先少了他、contacts 那一列還在的那幾毫秒裡，presence 的「名單一時是空的 → 再查資料庫」會把他當成還是好友，
 * 這次就不換秘密 —— 被刪的人最晚要等到下一次 5 分鐘的比對（模擬 P1：刪掉之後他還收到一分鐘的上線狀態）
 */
const friendRemovedListeners = new Set<(publicKey: string) => void>();
export function onFriendRemoved(cb: (publicKey: string) => void): () => void {
  friendRemovedListeners.add(cb);
  return () => { friendRemovedListeners.delete(cb); };
}

interface UserProfile {
  displayName: string;
  avatar: string; // image URL or empty string
}

interface ChatState {
  friends: Friend[];
  currentFriendId: string | null;
  messages: Record<string, Message[]>;
  isLoaded: boolean; // 是否已從本地載入
  userProfile: UserProfile;

  // Actions
  selectFriend: (friendId: string) => Promise<void>;
  clearSelection: () => void;
  sendMessage: (
    content: string,
    myPublicKey: string,
    ttl?: number,
    messageId?: string,
    type?: 'text' | 'image' | 'file' | 'voice' | 'payment',
    voiceData?: { duration: number; waveform?: number[]; mimeType?: string; transcript?: string },
    fileData?: { name: string; mimeType: string; size: number; caption?: string; fileId?: string },
    paymentData?: import('../types').PaymentData
  ) => Promise<void>;
  burnMessage: (messageId: string) => Promise<void>;
  markAsRead: (friendId: string) => Promise<void>;
  resetAll: () => Promise<void>;
  loadFromStorage: () => Promise<void>;

  // 用戶設定
  setDisplayName: (name: string) => void;
  setAvatar: (avatar: string) => void;

  // 新增好友操作
  addFriend: (publicKey: string, name: string, trustLevel: TrustLevel, avatar?: string, pushSubscription?: PushSubscriptionData, preKeyBundle?: { signedPreKey: string; signature: string }) => void;
  /** QR 重加好友 authoritative：用新 bundle 無條件覆蓋 contact 的 name/trust/signedPreKey/signature 並等本機 SQLite 寫入(最新 key wins；persist 失敗會 reject)。 */
  reAddFriend: (publicKey: string, name: string, trustLevel: TrustLevel, preKeyBundle: { signedPreKey: string; signature: string }) => Promise<void>;
  updateFriendTrust: (friendId: string, trustLevel: TrustLevel) => void;
  updateFriendProfile: (publicKey: string, profile: { displayName?: string; avatar?: string }) => void;
  removeFriend: (friendId: string) => Promise<void>;
  getFriendByPublicKey: (publicKey: string) => Friend | undefined;

  // 訊息操作
  receiveMessage: (friendId: string, message: Message) => Promise<void>;
  /** 轉帳卡片收款後更新狀態（雙端各自呼叫），並持久化 */
  updatePaymentStatus: (friendId: string, txId: string, status: PaymentData['status'], myPublicKey: string, extra?: Partial<PaymentData>) => Promise<void>;
}

/** contacts 表的一筆 → 記憶體裡的好友（loadFromStorage 與 findFriendSettled 共用） */
function contactToFriend(c: storage.Contact): Friend {
  return {
    id: `friend-${c.pubkey.slice(0, 16)}`,
    publicKey: c.pubkey,
    name: c.nickname,
    avatar: c.avatar || '',
    lastMessage: '',
    lastMessageTime: c.addedAt,
    unreadCount: 0,
    online: false,
    trustLevel: c.trustLevel,
    addedAt: c.addedAt,
    pushSubscription: c.pushSubscription,
    signedPreKey: c.signedPreKey,
    signature: c.signature,
  };
}

// 從 localStorage 載入用戶設定
function loadUserProfile(): UserProfile {
  try {
    const saved = localStorage.getItem(USER_PROFILE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('[chatStore] Failed to load user profile:', e);
  }
  return { displayName: '', avatar: '' };
}

// 保存用戶設定到 localStorage
function saveUserProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {
    console.error('[chatStore] Failed to save user profile:', e);
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  friends: [],
  currentFriendId: null,
  messages: {},
  isLoaded: false,
  userProfile: loadUserProfile(),

  // 設定用戶名稱
  setDisplayName: (name: string) => {
    const newProfile = { ...get().userProfile, displayName: name };
    saveUserProfile(newProfile);
    set({ userProfile: newProfile });
    devLog('[chatStore] Display name updated:', name);
    markBlobDirty();
  },

  // 設定用戶頭像
  setAvatar: (avatar: string) => {
    const newProfile = { ...get().userProfile, avatar };
    saveUserProfile(newProfile);
    set({ userProfile: newProfile });
    devLog('[chatStore] Avatar updated:', avatar);
  },

  // 從本地儲存載入資料
  loadFromStorage: async () => {
    devLog('[chatStore] loadFromStorage called, isInitialized:', storage.isInitialized());

    if (!storage.isInitialized()) {
      devLog('[chatStore] Storage not initialized yet, skipping load');
      return;
    }

    try {
      // 載入聯絡人
      devLog('[chatStore] Loading contacts from storage...');
      const contacts = await storage.getAllContacts();
      // DIAG（prod 可見，BrowserMonitor 抓）：確認重登後到底載到幾筆，是 readiness race 還是真的空。
      console.error(`[DIAG:CHATLOAD] getAllContacts=${contacts.length} isInit=${storage.isInitialized()}`);
      devLog('[chatStore] Raw contacts from storage:', contacts);

      let friends: Friend[] = contacts.map(contactToFriend);

      // 載入每個好友的訊息
      const messages: Record<string, Message[]> = {};
      for (const friend of friends) {
        const storedMessages = await storage.getMessages(friend.publicKey, 100);
        messages[friend.id] = storedMessages.map((m) => {
          // 解析 metadata 還原 voiceData 和 fileData
          let voiceData: Message['voiceData'] = undefined;
          let fileData: Message['fileData'] = undefined;
          let paymentData: Message['paymentData'] = undefined;
          let riskResult: L2Result | undefined = undefined;
          if (m.metadata) {
            try {
              const parsed = JSON.parse(m.metadata);
              if (m.type === 'voice' && parsed.voiceData) {
                voiceData = parsed.voiceData;
              }
              if (m.type === 'file' && parsed.fileData) {
                fileData = parsed.fileData;
              }
              if (m.type === 'payment' && parsed.paymentData) {
                paymentData = parsed.paymentData;
              }
            } catch (e) {
              devWarn('[chatStore] Failed to parse metadata:', e);
            }
          }
          // 解析 riskResult 還原詐騙偵測結果
          if (m.riskResult) {
            try {
              riskResult = JSON.parse(m.riskResult) as L2Result;
            } catch (e) {
              devWarn('[chatStore] Failed to parse riskResult:', e);
            }
          }
          return {
            id: m.id,
            senderId: m.isOutgoing ? 'me' : friend.id,
            content: m.content,
            timestamp: m.createdAt,
            type: m.type,
            isRead: m.readAt !== null,
            isBurned: false,
            ttl: m.ttl || undefined,
            encrypted: true,
            voiceData,
            fileData,
            paymentData,
            riskResult,
          };
        });

        // 更新最後訊息 + 未讀數（immutable update）
        if (storedMessages.length > 0) {
          const lastMsg = storedMessages[storedMessages.length - 1];
          const friendIndex = friends.findIndex((f) => f.id === friend.id);
          if (friendIndex >= 0) {
            const lastMsgText = lastMsg.type === 'voice'
              ? '語音訊息'
              : lastMsg.content.slice(0, 50);
            const unreadCount = storedMessages.filter(
              (m) => m.readAt === null && !m.isOutgoing
            ).length;
            friends = friends.map((f, idx) =>
              idx === friendIndex
                ? { ...f, lastMessage: lastMsgText, lastMessageTime: lastMsg.createdAt, unreadCount }
                : f
            );
          }
        }
      }

      set({ friends, messages, isLoaded: true });
      devLog(`[chatStore] Successfully loaded ${friends.length} friends from storage`);

      // 自癒：載到 0 聯絡人時，可能是重登後連線 readiness race（資料其實在 DB）。背景排程
      //   重載（不阻塞、不延遲新用戶首屏），若稍後 DB ready 就會把好友補上。限 5 次。
      if (friends.length === 0 && _emptyReloadCount < 5) {
        _emptyReloadCount++;
        const attempt = _emptyReloadCount;
        setTimeout(() => {
          void (async () => {
            try {
              const recheck = await storage.getAllContacts();
              if (recheck.length > 0) {
                console.error(`[DIAG:CHATLOAD] self-heal attempt ${attempt}: ${recheck.length} contacts appeared → reload`);
                await get().loadFromStorage();
              }
            } catch { /* ignore */ }
          })();
        }, 2500 * attempt);
      } else if (friends.length > 0) {
        _emptyReloadCount = 0;
      }
    } catch (err) {
      console.error('[chatStore] Failed to load from storage:', err);
      set({ isLoaded: true });
    }
  },

  selectFriend: async (friendId) => {
    // 確保資料已載入
    const { friends, isLoaded } = get();
    if (friends.length === 0 && isLoaded) {
      devLog('[chatStore] selectFriend: friends empty, reloading...');
      await get().loadFromStorage();
    }

    set({ currentFriendId: friendId });
    get().markAsRead(friendId);
  },

  clearSelection: () => set({ currentFriendId: null }),

  sendMessage: async (content, myPublicKey, ttl, messageId, type = 'text', voiceData, fileData, paymentData) => {
    const { currentFriendId, messages, friends } = get();
    if (!currentFriendId) return;

    const friend = friends.find((f) => f.id === currentFriendId);
    if (!friend) return;

    // 使用傳入的 messageId 或產生新的（確保與傳輸的 ID 一致）
    const finalMessageId = messageId || generateId('msg');

    const newMessage: Message = {
      id: finalMessageId,
      senderId: 'me',
      content,
      timestamp: Date.now(),
      type,
      isRead: true,
      isBurned: false,
      ttl: ttl, // 包含 TTL（-1 為閱後即焚，>0 為秒數，undefined 為永久）
      // 語音訊息元資料
      ...(type === 'voice' && voiceData ? { voiceData } : {}),
      // 檔案訊息元資料
      ...(type === 'file' && fileData ? { fileData } : {}),
      // 轉帳卡片元資料
      ...(type === 'payment' && paymentData ? { paymentData } : {}),
    };

    const currentMessages = messages[currentFriendId] || [];
    set({
      messages: {
        ...messages,
        [currentFriendId]: [...currentMessages, newMessage],
      },
    });

    // 語音訊息顯示時長，其他類型顯示內容摘要
    const lastMessageText = type === 'voice'
      ? `語音訊息 ${voiceData ? Math.round(voiceData.duration) + 's' : ''}`
      : type === 'image'
        ? '圖片'
        : type === 'file'
          ? '檔案'
          : type === 'payment'
            ? '轉帳'
            : content.slice(0, 50);

    set({
      friends: get().friends.map((f) =>
        f.id === currentFriendId
          ? { ...f, lastMessage: lastMessageText, lastMessageTime: Date.now() }
          : f
      ),
    });

    // 保存到本地儲存（立即持久化到 IndexedDB）
    if (storage.isInitialized()) {
      const conversationId = storage.getConversationIdForPeer(friend.publicKey);
      // 語音訊息將 voiceData 存在 metadata 欄位，檔案訊息將 fileData 存在 metadata 欄位
      const metadata = type === 'voice' && voiceData
        ? JSON.stringify({ voiceData })
        : type === 'file' && fileData
          ? JSON.stringify({ fileData })
          : type === 'payment' && paymentData
            ? JSON.stringify({ paymentData })
            : undefined;
      await storage.saveMessage({
        id: newMessage.id,
        conversationId,
        senderPubkey: myPublicKey,
        content,
        type,
        createdAt: newMessage.timestamp,
        ttl: ttl ?? 0, // -1 為閱後即焚，>0 為秒數，0 為永久
        expiresAt: ttl && ttl > 0 ? newMessage.timestamp + ttl * 1000 : null,
        readAt: Date.now(),
        isOutgoing: true,
        status: 'sent',
        metadata,
      });
    }
  },

  burnMessage: async (messageId) => {
    devLog('[chatStore] burnMessage called with:', messageId);
    const { messages } = get();

    // 搜尋所有對話，找到並標記該訊息為已燒毀
    let found = false;
    const updatedMessages: Record<string, Message[]> = {};

    for (const [friendId, friendMessages] of Object.entries(messages)) {
      if (!friendMessages || !Array.isArray(friendMessages)) continue;

      const hasMessage = friendMessages.some((m) => m.id === messageId);
      if (hasMessage) {
        found = true;
        devLog('[chatStore] burnMessage: found message in conversation', friendId);
        updatedMessages[friendId] = friendMessages.map((m) =>
          m.id === messageId ? { ...m, isBurned: true } : m
        );
      } else {
        updatedMessages[friendId] = friendMessages;
      }
    }

    if (!found) {
      devLog('[chatStore] burnMessage: message not found in any conversation');
      return;
    }

    set({ messages: updatedMessages });

    // 從本地儲存刪除（messages.content 含檔案 base64，刪 row 即清檔案二進位）
    if (storage.isInitialized()) {
      await storage.deleteMessage(messageId);
    }

    // 防禦性清理：移除 download_history 中關聯此訊息的下載記錄
    try {
      await db.run('DELETE FROM download_history WHERE source_id = ?', [messageId]);
    } catch (err) {
      devWarn('[chatStore] burnMessage: download_history cleanup failed', err);
    }

    devLog('[chatStore] burnMessage: done');
  },

  markAsRead: async (friendId) => {
    const { messages, friends } = get();
    const friendMessages = messages[friendId] || [];

    set({
      friends: friends.map((f) =>
        f.id === friendId ? { ...f, unreadCount: 0 } : f
      ),
      messages: {
        ...messages,
        [friendId]: friendMessages.map((m) => ({ ...m, isRead: true })),
      },
    });

    // 標記本地儲存中的訊息為已讀
    if (storage.isInitialized()) {
      for (const m of friendMessages) {
        if (!m.isRead) {
          await storage.markMessageAsRead(m.id);
        }
      }
    }
  },

  resetAll: async () => {
    set({
      friends: [],
      messages: {},
      currentFriendId: null,
      isLoaded: false,
    });

    // 清除本地儲存
    if (storage.isInitialized()) {
      await storage.clearAllData();
    }
  },

  // 新增好友
  // QR 重加好友 authoritative：最新 key wins。無條件覆蓋 contact 的 name/trust/signedPreKey/signature
  //   並立即持久化到 SQLite contacts（不是 addFriend 那種「已存在就 return」）。
  reAddFriend: async (publicKey, name, trustLevel, preKeyBundle) => {
    const { friends } = get();
    const existing = friends.find((f) => f.publicKey === publicKey);
    const now = Date.now();
    const friend: Friend = existing
      ? { ...existing, name: name || existing.name, trustLevel, signedPreKey: preKeyBundle.signedPreKey, signature: preKeyBundle.signature, addedAt: now }
      : {
          id: `friend-${publicKey.slice(0, 16)}`, publicKey, name: name || `好友 ${publicKey.slice(0, 8)}...`,
          avatar: '', lastMessage: '', lastMessageTime: now, unreadCount: 0, online: true,
          trustLevel, addedAt: now, signedPreKey: preKeyBundle.signedPreKey, signature: preKeyBundle.signature,
        };
    set({ friends: existing ? friends.map((f) => (f.publicKey === publicKey ? friend : f)) : [...friends, friend] });
    markBlobDirty();
    // 等本機 SQLite 真的寫入才回（fire-and-forget 會讓 VPS 是新 key 但本機 DB 舊/空 → reload 對不上）。
    if (storage.isInitialized()) {
      await storage.addContact({
        pubkey: friend.publicKey, nickname: friend.name, avatar: friend.avatar, addedAt: friend.addedAt,
        trustLevel: friend.trustLevel, pushSubscription: friend.pushSubscription,
        signedPreKey: friend.signedPreKey, signature: friend.signature,
      });
    }
    console.error('[chatStore] reAddFriend authoritative overwrite for', publicKey.slice(0, 16));
  },

  addFriend: (publicKey, name, trustLevel, avatar?, pushSubscription?, preKeyBundle?) => {
    const { friends } = get();

    // 檢查是否已存在；若這次帶了 X3DH bundle，回填/更新 bundle，避免恢復後缺 bundle。
    const existingFriend = friends.find((f) => f.publicKey === publicKey);
    if (existingFriend) {
      if (
        preKeyBundle &&
        (existingFriend.signedPreKey !== preKeyBundle.signedPreKey ||
          existingFriend.signature !== preKeyBundle.signature)
      ) {
        const updatedFriend: Friend = {
          ...existingFriend,
          signedPreKey: preKeyBundle.signedPreKey,
          signature: preKeyBundle.signature,
        };
        set({
          friends: friends.map((f) => (f.publicKey === publicKey ? updatedFriend : f)),
        });
        markBlobDirty();
        if (storage.isInitialized()) {
          storage.addContact({
            pubkey: updatedFriend.publicKey,
            nickname: updatedFriend.name,
            avatar: updatedFriend.avatar,
            addedAt: updatedFriend.addedAt,
            trustLevel: updatedFriend.trustLevel,
            pushSubscription: updatedFriend.pushSubscription,
            signedPreKey: updatedFriend.signedPreKey,
            signature: updatedFriend.signature,
          }).catch((err) => {
            console.error('[chatStore] Failed to persist friend prekey bundle:', err);
          });
        }
        devLog('[chatStore] Friend prekey bundle updated:', publicKey.slice(0, 16));
      } else {
        devLog('[chatStore] Friend already exists:', publicKey.slice(0, 16));
      }
      return;
    }

    const friendId = `friend-${publicKey.slice(0, 16)}`;

    const newFriend: Friend = {
      id: friendId,
      publicKey,
      name: name || `好友 ${publicKey.slice(0, 8)}...`,
      avatar: avatar || '',
      lastMessage: '',
      lastMessageTime: Date.now(),
      unreadCount: 0,
      online: true,
      trustLevel,
      addedAt: Date.now(),
      pushSubscription, // 儲存好友的推播訂閱
      // 對方 X3DH prekey bundle — 存起來，帳號恢復後能重建 session（免重加好友）
      signedPreKey: preKeyBundle?.signedPreKey,
      signature: preKeyBundle?.signature,
    };

    set({ friends: [...friends, newFriend] });
    devLog('[chatStore] Friend added:', newFriend.name, trustLevel, pushSubscription ? '(with push)' : '(no push)');
    markBlobDirty();

    // 加完好友後，立即發送自己的個人資料給對方（封給他的身分金鑰，DIRECT_SEALED kind profile）
    const myProfile = get().userProfile;
    broadcastProfileUpdate([publicKey], {
      displayName: myProfile.displayName || '好友',
      avatar: myProfile.avatar || '',
    });

    // 保存到本地儲存
    if (storage.isInitialized()) {
      storage.addContact({
        pubkey: publicKey,
        nickname: newFriend.name,
        avatar: newFriend.avatar,
        addedAt: newFriend.addedAt,
        trustLevel,
        pushSubscription,
        signedPreKey: preKeyBundle?.signedPreKey,
        signature: preKeyBundle?.signature,
      }).then(() => {
        devLog('[chatStore] Friend persisted to storage');
      }).catch((err) => {
        console.error('[chatStore] Failed to persist friend:', err);
      });
    } else {
      console.error('[chatStore] Storage not initialized, friend not persisted!');
    }
  },

  // 更新好友信任等級
  updateFriendTrust: (friendId, trustLevel) => {
    const friend = get().friends.find((f) => f.id === friendId);
    set({
      friends: get().friends.map((f) =>
        f.id === friendId ? { ...f, trustLevel } : f
      ),
    });

    // 更新本地儲存
    if (storage.isInitialized() && friend) {
      storage.addContact({
        pubkey: friend.publicKey,
        nickname: friend.name,
        avatar: friend.avatar,
        addedAt: friend.addedAt,
        trustLevel,
      });
    }
    markBlobDirty();
  },

  // 更新好友的個人資料（收到 PROFILE_UPDATE 時調用）
  updateFriendProfile: (publicKey, profile) => {
    const currentFriends = get().friends;
    const friend = currentFriends.find((f) => f.publicKey === publicKey);
    if (!friend) {
      devLog('[chatStore] Friend not found for profile update:', publicKey.slice(0, 16));
      return;
    }

    const updatedFriend: Friend = {
      ...friend,
      name: profile.displayName || friend.name,
      avatar: profile.avatar || friend.avatar,
    };

    // 建立新的 friends 陣列來觸發 React 重新渲染
    const newFriends = currentFriends.map((f) =>
      f.publicKey === publicKey ? updatedFriend : f
    );

    set({ friends: newFriends });

    devLog('[chatStore] Friend profile updated:', publicKey.slice(0, 16), '->', updatedFriend.name);

    // 更新本地儲存
    if (storage.isInitialized()) {
      storage.addContact({
        pubkey: friend.publicKey,
        nickname: updatedFriend.name,
        avatar: updatedFriend.avatar,
        addedAt: friend.addedAt,
        trustLevel: friend.trustLevel,
        pushSubscription: friend.pushSubscription,
      });
    }
    markBlobDirty();
  },

  // 移除好友
  removeFriend: async (friendId) => {
    const { messages, friends } = get();
    const friend = friends.find((f) => f.id === friendId);
    const newMessages = { ...messages };
    delete newMessages[friendId];

    set({
      friends: friends.filter((f) => f.id !== friendId),
      messages: newMessages,
      currentFriendId:
        get().currentFriendId === friendId ? null : get().currentFriendId,
    });

    // 從本地儲存刪除
    if (storage.isInitialized() && friend) {
      await storage.removeContact(friend.publicKey);
      // 同步清掉 Double Ratchet state — 否則重加好友後仍用舊 ratchet
      // 加密，對方 X3DH 已 reset 新 session → AEAD decrypt 永遠失敗
      await storage.deleteRatchetState(friend.publicKey);
      // ⚠️ 光刪 legacy ratchet_states 不夠：active session 來源是 mist_sessions + useCrypto memory。
      // 必須同步清掉兩者，重加才會走 fresh X3DH。
      await clearPeerSession(friend.publicKey);
      // ⚠️ 也要重置「傳輸層」：crypto reset 不會清 WebRTC PeerConnection。舊 DataChannel 壞掉後
      // 若沿用同一條 stale PC，重加好友會撞 "Live PC, DC not open"→polite 端永遠等對方 re-offer →
      // outbox 永遠 flush 不出去。teardown 後重加才會建 fresh P2P transport。
      webrtcService.disconnect(friend.publicKey);
    }
    // 還在等他確認（我加了他、他還沒回）的話也不等了：不論從哪裡刪好友（審查 M1）
    if (friend) usePendingFriendStore.getState().forgetPeer(friend.publicKey);
    markBlobDirty();
    if (friend) {
      for (const cb of friendRemovedListeners) {
        try { cb(friend.publicKey); } catch (err) { console.error('[chatStore] friend-removed listener failed:', err); }
      }
    }
  },

  // 根據公鑰查找好友
  getFriendByPublicKey: (publicKey) => {
    return get().friends.find((f) => f.publicKey === publicKey);
  },

  // 接收訊息
  receiveMessage: async (friendId, message) => {
    const { messages, friends, currentFriendId } = get();
    const friend = friends.find((f) => f.id === friendId);
    const currentMessages = messages[friendId] || [];
    // 同一則收兩次（outbox 重送、等回條重送時每次重新加密）→ 不再多一個氣泡、不再算一次未讀（群星 B31）
    if (message.id && currentMessages.some((m) => m.id === message.id)) return;

    // 更新訊息列表
    set({
      messages: {
        ...messages,
        [friendId]: [...currentMessages, message],
      },
    });

    // 更新好友列表的最後訊息
    const lastMessageText = message.type === 'voice'
      ? `語音訊息 ${message.voiceData ? Math.round(message.voiceData.duration) + 's' : ''}`
      : message.type === 'payment'
        ? '轉帳'
        : message.content.slice(0, 50);
    set({
      friends: friends.map((f) =>
        f.id === friendId
          ? {
              ...f,
              lastMessage: lastMessageText,
              lastMessageTime: message.timestamp,
              unreadCount:
                currentFriendId === friendId ? 0 : f.unreadCount + 1,
            }
          : f
      ),
    });

    // 保存到本地儲存（立即持久化到 IndexedDB）
    if (storage.isInitialized() && friend) {
      const conversationId = storage.getConversationIdForPeer(friend.publicKey);
      const ttl = message.ttl || 0;
      // 語音訊息將 voiceData 存在 metadata 欄位，檔案訊息將 fileData 存在 metadata 欄位
      let metadata: string | undefined = undefined;
      if (message.type === 'voice' && message.voiceData) {
        metadata = JSON.stringify({ voiceData: message.voiceData });
      } else if (message.type === 'file' && message.fileData) {
        metadata = JSON.stringify({ fileData: message.fileData });
      } else if (message.type === 'payment' && message.paymentData) {
        metadata = JSON.stringify({ paymentData: message.paymentData });
      }
      // 將 riskResult 序列化為 JSON 字串以持久化
      const riskResultJson = message.riskResult ? JSON.stringify(message.riskResult) : undefined;
      await storage.saveMessage({
        id: message.id,
        conversationId,
        senderPubkey: friend.publicKey,
        content: message.content,
        type: message.type,
        createdAt: message.timestamp,
        ttl,
        expiresAt: ttl > 0 ? message.timestamp + ttl * 1000 : null,
        readAt: currentFriendId === friendId ? Date.now() : null,
        isOutgoing: false,
        status: 'delivered',
        metadata,
        riskResult: riskResultJson,
      });
    }
  },

  // 轉帳卡片收款後更新狀態（收款方 claim 成功 / 發送方收到 payment_claimed 控制訊息）
  updatePaymentStatus: async (friendId, txId, status, myPublicKey, extra) => {
    const { messages, friends } = get();
    const friendMessages = messages[friendId] || [];
    const target = friendMessages.find((m) => m.type === 'payment' && m.paymentData?.txId === txId);
    if (!target || !target.paymentData) return;

    const updated: Message = { ...target, paymentData: { ...target.paymentData, ...extra, status } };
    set({
      messages: {
        ...messages,
        [friendId]: friendMessages.map((m) => (m.id === target.id ? updated : m)),
      },
    });

    // 持久化（saveMessage 是 INSERT OR REPLACE，直接覆寫同 id）
    const friend = friends.find((f) => f.id === friendId);
    if (storage.isInitialized() && friend) {
      const conversationId = storage.getConversationIdForPeer(friend.publicKey);
      await storage.saveMessage({
        id: updated.id,
        conversationId,
        senderPubkey: updated.senderId === 'me' ? myPublicKey : friend.publicKey,
        content: updated.content,
        type: 'payment',
        createdAt: updated.timestamp,
        ttl: updated.ttl ?? 0,
        expiresAt: null,
        readAt: updated.isRead ? Date.now() : null,
        isOutgoing: updated.senderId === 'me',
        status: 'delivered',
        metadata: JSON.stringify({ paymentData: updated.paymentData }),
      });
    }
  },
}));

/**
 * 等好友清單載入完成（最多 timeoutMs）。冷啟動時 loadFromStorage 要把每個好友的訊息都載完才一次填好友清單，
 * 這段時間 getFriendByPublicKey 對每個人都回 undefined（部署前審查 HIGH）。回 true＝已載入。
 */
export function whenFriendsLoaded(timeoutMs = FRIEND_WAIT_MS): Promise<boolean> {
  if (useChatStore.getState().isLoaded) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    const timer = setTimeout(() => { unsub(); resolve(false); }, timeoutMs);
    unsub = useChatStore.subscribe((state) => {
      if (!state.isLoaded) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/**
 * 「他是不是我的好友」要在冷啟動也答得對（部署前審查 HIGH）：推播喚醒的 App 先收到好友的來電、WebRTC offer、
 * 重送的 X3DH_INIT、群組邀請時，好友清單常常還沒載入 → 以前一律當陌生人：來電不響、offer 丟掉、已驗證的好友
 * 被降成未驗證、邀請丟掉。現在：記憶體有就直接回；沒有就等清單載入（有上限），再沒有就直接查 contacts 表
 * （清單載到 0 筆的 readiness race 也查得到）。真的不是好友才回 undefined。
 */
export async function findFriendSettled(publicKey: string, timeoutMs = FRIEND_WAIT_MS): Promise<Friend | undefined> {
  const now = useChatStore.getState().getFriendByPublicKey(publicKey);
  if (now) return now;
  await whenFriendsLoaded(timeoutMs);
  const loaded = useChatStore.getState().getFriendByPublicKey(publicKey);
  if (loaded) return loaded;
  if (!storage.isInitialized()) return undefined;
  try {
    const stored = await storage.getContact(publicKey);
    return stored ? contactToFriend(stored) : undefined;
  } catch (err) {
    console.error('[chatStore] findFriendSettled: contacts lookup failed:', err);
    return undefined;
  }
}

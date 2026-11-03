/**
 * useGroupChat Hook - 群組聊天 Hook (ADR-016 Group Key 架構＋狀態鏈)
 *
 * 群組管理（建群、加人、踢人、離開、改名、改角色、守護設定、刪群）：交給群組引擎寫 commit（services/groupEngine）。
 *   commit 先存檔、送到伺服器 log、在 log 上套用了才改名冊 —— 這裡不直接改任何群組狀態，也不送明文的群組事件。
 * 訊息加密：Group Key (AES-256-GCM) 一次加密，全員可解；只用鏈上目前那一代（拿不到就不送，不退回舊的一代、不雙發）
 * 訊息傳輸：P2P DataChannel，無 MQTT fallback；只送給鏈上的名冊（離開的人立刻不在扇出名單上）
 * 訊息簽名：Ed25519 簽明文（明文附我的 log 位置，收端交叉比對）
 * 離線同步：BT Seed — 任何持有密文的成員可轉送
 */

import { useCallback, useEffect, useState } from 'react';
import { useGroupStore, useCurrentGroup } from '../stores/groupStore';
import { useCrypto } from './useCrypto';
import { useChatStore } from '../stores/chatStore';
import { mqttService } from '../services/mqtt'; // FCM 喚醒（群組主題的訂閱跟著群組引擎的主題表，W3）
import { useApp } from '../providers/AppProvider';
import { sendViaP2P } from '../services/p2pSend';
import * as storage from '../services/storage';
import * as groupKeyService from '../services/groupKey';
import { getGroupEngine } from '../services/groupEngineHost';
import { GroupOpError } from '../services/groupEngineTypes';
import { parseGuardianSettings } from '../services/groupState';
import * as fileTransfer from '../services/fileTransfer';
import type { Group, GroupMember, GroupRole, Message, GroupType, GuardianGroupSettings } from '../types';
import { GROUP_CONSTANTS } from '../types';
import { generateId } from '../utils/secureId';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { useLanguage } from '../i18n/context';

/** 引擎的拒收原因 → 畫面看得到的錯誤（原因字串照規則，例如 not-admin、needs-rekey） */
function opError(e: unknown): Error {
  if (e instanceof GroupOpError) return new Error(e.reason);
  return e instanceof Error ? e : new Error(String(e));
}

/** 守護設定只收鏈接受的欄位（多的、型別不對的 → 丟例外，不會寫進去之後被每台拒收） */
function cleanGuardianSettings(settings: GuardianGroupSettings | undefined): GuardianGroupSettings | null {
  if (!settings) return null;
  try {
    return parseGuardianSettings(settings);
  } catch (e) {
    throw new Error(`guardian-settings: ${(e as Error)?.message ?? e}`);
  }
}

/** 建立群組選項 */
interface CreateGroupOptions {
  groupType?: GroupType;
  guardianSettings?: GuardianGroupSettings;
  /** 成員暱稱（pubkey → 顯示名）。不帶會導致群組訊息顯示 pubkey 切片亂碼 */
  memberNicknames?: Record<string, string>;
}

// ============================================
// 類型定義
// ============================================

/** 語音訊息資料 */
interface VoiceMessageData {
  audioData: string;
  duration: number;
  mimeType: string;
  waveform: number[];
}

interface UseGroupChatReturn {
  /** 當前群組 */
  currentGroup: Group | undefined;
  /** 當前群組訊息（視圖模式） */
  messages: Message[];
  /** 群組成員 */
  members: GroupMember[];
  /** 是否為管理員 */
  isAdmin: boolean;
  /** 群組是否已滿 */
  isFull: boolean;

  /** 發送訊息（視圖模式：透過 1-1 傳送給每個成員） */
  sendMessage: (content: string, ttl?: number) => void;
  /** 發送檔案訊息（Phase 10: 群組檔案傳送） */
  sendFileMessage: (file: File, caption?: string) => Promise<void>;
  /** 發送語音訊息 */
  sendVoiceMessage: (voice: VoiceMessageData) => void;
  /** 轉發訊息/檔案到任意群組（不需 selectGroup） */
  forwardToGroup: (
    groupId: string,
    content: string,
    type: 'text' | 'file',
    fileData?: { name: string; mimeType: string; size: number },
  ) => Promise<void>;
  /** 建立群組 */
  createGroup: (name: string, memberPublicKeys?: string[], parentGroupId?: string, options?: CreateGroupOptions) => Promise<string>; // parentGroupId deprecated (ADR-016), kept for API compat
  /** 離開群組 */
  leaveGroup: () => Promise<void>;
  /** 在這台忘掉這個群（拿不到目前那一代的金鑰、離開不了時）：只刪本機資料，不通知任何人 */
  forgetGroup: () => Promise<void>;
  /** 刪除群組（僅管理員） */
  deleteGroup: () => Promise<void>;
  /** 更新群組資訊 */
  updateGroupInfo: (updates: { name?: string; avatar?: string }) => Promise<void>;
  /** 更新守護群組設定 (Phase 19) */
  updateGuardianSettings: (settings: GuardianGroupSettings) => Promise<void>;

  /** 新增成員 */
  addMember: (publicKey: string, nickname?: string) => Promise<boolean>;
  /** 移除成員 */
  removeMember: (publicKey: string) => Promise<void>;
  /** 更新成員角色 */
  updateMemberRole: (publicKey: string, role: GroupRole) => Promise<void>;
  /** 我送的邀請一直沒送到（Group.unackedInvites）：再送一輪 */
  resendInvite: (publicKey: string) => Promise<boolean>;

  /** 選擇群組 */
  selectGroup: (groupId: string) => void;
  /** 清除選擇 */
  clearSelection: () => void;

  /** 刪除群組訊息 */
  deleteGroupMessage: (messageId: string) => Promise<void>;
  /** 沒送出去的那則（等金鑰時打的，泡泡上顯示「未送出」）再送一次；送出去了回 true */
  retryUnsent: (messageId: string) => Promise<boolean>;

  /** 發送報平安訊息到守護群組 (Phase 19) */
  sendCheckIn: (status: 'ok' | 'help') => void;
}

// ============================================
// Hook 實作
// ============================================

export function useGroupChat(): UseGroupChatReturn {
  const { publicKeyBase64, encrypt } = useCrypto();
  const { t } = useLanguage();
  useApp(); // 只為了訂閱 App context（P2P 發送改走 p2pSend.ts）；沒有要取的欄位
  const userProfile = useChatStore((state) => state.userProfile);

  // Store 操作
  const currentGroup = useCurrentGroup();
  const currentGroupId = useGroupStore((state) => state.currentGroupId);

  // 視圖模式：從 storage 中讀取群組訊息
  const [messages, setMessages] = useState<Message[]>([]);

  const {
    selectGroup,
    clearSelection,
    getOtherMemberPublicKeys,
  } = useGroupStore();

  // 計算屬性
  const members = currentGroup?.members || [];
  // 管理權只認鏈上的 admin（名冊是狀態鏈的投影）
  const isAdmin = !!publicKeyBase64 && members.some((m) => m.publicKey === publicKeyBase64 && m.role === 'admin');
  const isFull = members.length >= GROUP_CONSTANTS.MAX_MEMBERS;

  // ============================================
  // 視圖模式：載入群組訊息
  // ============================================

  const loadGroupMessages = useCallback(async () => {
    diagLog('[DIAG:GK5] load ENTER @', Date.now(), 'gid=', currentGroupId ?? 'null', 'init=', storage.isInitialized());
    if (!currentGroupId || !storage.isInitialized()) {
      setMessages([]);
      return;
    }

    const tq = Date.now();
    const storedMessages = await storage.getMessagesByGroupId(currentGroupId, 100);
    if (Date.now() - tq > 300) diagLog('[DIAG:GK5] getMessagesByGroupId took', Date.now() - tq, 'ms');
    diagLog('[DIAG:GK] loadGroupMessages @', Date.now(), ':', currentGroupId, 'found:', storedMessages.length, 'msgs');
    const mappedMessages: Message[] = storedMessages.map((m) => {
      // 解析 metadata 還原 voiceData / fileData / riskResult
      let voiceData: Message['voiceData'] = undefined;
      let fileData: Message['fileData'] = undefined;
      let riskResult: Message['riskResult'] = undefined;
      if (m.metadata) {
        try {
          const parsed = JSON.parse(m.metadata);
          if (m.type === 'voice' && parsed.voiceData) {
            voiceData = parsed.voiceData;
          }
          if (m.type === 'file' && parsed.fileData) {
            fileData = parsed.fileData;
          }
          if (parsed.riskResult) {
            riskResult = parsed.riskResult;
            console.error(`[DIAG:GRISK] loaded msg with riskResult: level=${parsed.riskResult.riskLevel} msg=${m.id.slice(0, 24)} mine=${m.isOutgoing}`);
          }
        } catch (e) {
          devWarn('[useGroupChat] Failed to parse metadata:', e);
        }
      }
      return {
        id: m.id,
        senderId: m.isOutgoing ? 'me' : m.senderPubkey,
        content: m.content,
        timestamp: m.createdAt,
        type: m.type,
        isRead: m.readAt !== null,
        isBurned: false,
        ttl: m.ttl || undefined,
        groupIds: m.groupIds,
        recipientPubkey: m.conversationId.replace('conv-', ''), // 從 conversationId 還原
        voiceData,
        fileData,
        riskResult,
        // 我送的、沒送出去（等金鑰時打的，W5 S13）：泡泡上顯示「未送出・重送」（開源第 4 步）
        ...(m.isOutgoing && m.status === 'failed' ? { sendStatus: 'failed' as const } : {}),
      };
    });

    // 合併 SQLite 結果 + 尚未寫入 SQLite 的 optimistic messages（避免覆蓋自己剛發的訊息）
    setMessages(prev => {
      const sqliteIds = new Set(mappedMessages.map(m => m.id));
      const optimisticOnly = prev.filter(m => m.senderId === 'me' && !sqliteIds.has(m.id));
      if (optimisticOnly.length === 0) return mappedMessages;
      // 合併：SQLite 結果 + 尚未持久化的 optimistic
      const merged = [...mappedMessages, ...optimisticOnly].sort((a, b) => a.timestamp - b.timestamp);
      return merged;
    });
    // [DIAG:GK5] setMessages 後首個 render 幀時刻 — rAF 不 fire = 沒有渲染幀在跑
    const ts = Date.now();
    requestAnimationFrame(() => diagLog('[DIAG:GK5] rAF after setMessages +', Date.now() - ts, 'ms'));

  }, [currentGroupId]);

  // 當切換群組時重新載入訊息
  useEffect(() => {
    loadGroupMessages();
  }, [loadGroupMessages]);

  // 群組主題（MQTT 上的群組控制訊息）的訂閱不在這裡：W3 起跟著群組引擎的主題表（每一代金鑰一個主題 id），
  //   AppProvider 把它設成 token 範圍，mqtt 照範圍訂／退訂

  // 監聽加密群組訊息（由 AppProvider ENCRYPTED_MESSAGE handler 觸發）
  // 訊息持久化由 AppProvider 負責，這裡只刷新視圖
  useEffect(() => {
    const handleGroupMessage = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        groupId: string;
        groupIds: string[];
      };
      diagLog('[DIAG:GK] UI event received @', Date.now(), JSON.stringify(detail.groupIds), 'currentGroupId:', currentGroupId ?? 'null',
        'match:', !!(currentGroupId && detail.groupIds.includes(currentGroupId)));
      if (currentGroupId && detail.groupIds.includes(currentGroupId)) {
        // 延遲載入確保 SQLite saveToStore 完成（web 平台 jeep-sqlite 需要時間）
        // 雙次載入：150ms 快速回應 + 500ms 確保數據一致
        // [DIAG:GK5] test5 取證：timer 排程→fire 逐段時間戳（30s 空白鏈定位，勿刪）
        const t0 = Date.now();
        setTimeout(() => {
          diagLog('[DIAG:GK5] timer150 fired @', Date.now(), '+', Date.now() - t0, 'ms (t0=', t0, ')');
          loadGroupMessages();
        }, 150);
        setTimeout(() => {
          diagLog('[DIAG:GK5] timer500 fired @', Date.now(), '+', Date.now() - t0, 'ms');
          loadGroupMessages();
        }, 500);
      }
    };

    window.addEventListener('aegis:group-message', handleGroupMessage);
    return () => window.removeEventListener('aegis:group-message', handleGroupMessage);
  }, [currentGroupId, loadGroupMessages]);

  // 群組訊息走 P2P DataChannel → processEncryptedMessage → aegis:group-message event

  // ============================================
  // 群組操作
  // ============================================

  /** 目前這個帳號的群組引擎（還沒登入／還沒載完 → 丟錯，畫面顯示） */
  const engine = useCallback(() => {
    const e = getGroupEngine();
    if (!e || !publicKeyBase64) throw new Error(t('common.notLoggedIn'));
    return e;
  }, [publicKeyBase64, t]);

  /**
   * 建群：genesis commit 先存、送到伺服器 log，拿到 seq 後才成為一個群；初始成員的邀請（整條鏈＋第一代金鑰）
   * 在 genesis 上 log 之後才封給他們。群組 id 由 genesis 的雜湊決定。
   */
  const createGroup = useCallback(
    async (name: string, memberPublicKeys: string[] = [], _parentGroupId?: string, options?: CreateGroupOptions): Promise<string> => {
      const e = engine();
      const groupType = options?.groupType === 'guardian' ? 'guardian' : 'normal';
      try {
        const gid = await e.createGroup({
          name: name.trim().slice(0, GROUP_CONSTANTS.MAX_NAME_LENGTH),
          members: memberPublicKeys,
          groupType,
          guardianSettings: groupType === 'guardian' ? cleanGuardianSettings(options?.guardianSettings) : null,
        });
        // 暱稱只是本機快取（好友名稱）
        for (const [pk, nick] of Object.entries(options?.memberNicknames ?? {})) {
          useGroupStore.getState().updateMemberNickname(gid, pk, nick);
        }
        return gid;
      } catch (err) {
        throw opError(err);
      }
    },
    [engine]
  );

  /** 離開：leave commit 在 log 上套用後，引擎把這個群從本機刪掉（換金鑰由留下的 admin 負責） */
  const leaveGroup = useCallback(async () => {
    if (!currentGroupId) return;
    try {
      await engine().leave(currentGroupId);
    } catch (err) {
      throw opError(err);
    }
  }, [currentGroupId, engine]);

  /**
   * 在這台忘掉這個群（W2）：拿不到目前那一代的金鑰（admin 都不在、還原時沒帶到）就寫不了 leave。這裡只刪本機的鏈、金鑰、
   * 待送，不寫 commit —— 名冊上我還在，別人照常；我之後被踢再被加回來會收到新的邀請
   */
  const forgetGroup = useCallback(async () => {
    if (!currentGroupId) return;
    try {
      await engine().forgetGroup(currentGroupId);
    } catch (err) {
      throw opError(err);
    }
  }, [currentGroupId, engine]);

  /** 刪群（只有 admin；規則在鏈上） */
  const deleteGroup = useCallback(async () => {
    if (!currentGroupId) return;
    try {
      await engine().deleteGroup(currentGroupId);
    } catch (err) {
      throw opError(err);
    }
  }, [currentGroupId, engine]);

  const updateGroupInfo = useCallback(
    async (updates: { name?: string; avatar?: string }) => {
      if (!currentGroupId) return;
      const info: { name?: string; avatar?: string } = {};
      if (updates.name !== undefined) info.name = updates.name.trim().slice(0, GROUP_CONSTANTS.MAX_NAME_LENGTH);
      if (updates.avatar !== undefined) info.avatar = updates.avatar;
      try {
        await engine().updateInfo(currentGroupId, info);
      } catch (err) {
        throw opError(err);
      }
    },
    [currentGroupId, engine]
  );

  /** 更新守護群組設定 (Phase 19)：info commit（只有 admin；欄位照鏈的格式） */
  const updateGuardianSettings = useCallback(
    async (settings: GuardianGroupSettings) => {
      if (!currentGroupId) return;
      try {
        await engine().updateInfo(currentGroupId, { groupType: 'guardian', guardianSettings: cleanGuardianSettings(settings) });
        devLog('[useGroupChat] Guardian settings commit sent:', currentGroupId);
      } catch (err) {
        throw opError(err);
      }
    },
    [currentGroupId, engine]
  );

  /**
   * 加人：add commit 上 log 之後，引擎才把邀請（整條鏈、加入那時的金鑰、seq）封給新成員；新成員對照 log 確認後加入。
   * 加回曾經在群裡的人要 admin、同一筆換金鑰（規則在鏈上）。回傳 commit 有沒有寫出去（held ＝ 等 admin 換金鑰後才送）。
   */
  const addMember = useCallback(
    async (memberPublicKey: string, _nickname?: string): Promise<boolean> => {
      if (!currentGroupId) return false;
      try {
        await engine().addMember(currentGroupId, memberPublicKey);
        return true;
      } catch (err) {
        console.error('[useGroupChat] add member refused:', opError(err).message);
        return false;
      }
    },
    [currentGroupId, engine]
  );

  /** 踢人：remove commit 一定同一筆換金鑰（新金鑰封給留下的每個人，放在 log entry 裡） */
  const removeMember = useCallback(
    async (memberPublicKey: string) => {
      if (!currentGroupId) return;
      try {
        await engine().removeMember(currentGroupId, memberPublicKey);
      } catch (err) {
        throw opError(err);
      }
    },
    [currentGroupId, engine]
  );

  /** 邀請重送用完還沒送到的成員：再送一輪（W2） */
  const resendInvite = useCallback(
    async (memberPublicKey: string): Promise<boolean> => {
      if (!currentGroupId) return false;
      try {
        return await engine().resendInvite(currentGroupId, memberPublicKey);
      } catch (err) {
        throw opError(err);
      }
    },
    [currentGroupId, engine]
  );

  const updateMemberRole = useCallback(
    async (memberPublicKey: string, role: GroupRole) => {
      if (!currentGroupId) return;
      try {
        await engine().setRole(currentGroupId, memberPublicKey, role);
      } catch (err) {
        throw opError(err);
      }
    },
    [currentGroupId, engine]
  );

  // ============================================
  // 訊息操作（視圖模式）
  // ============================================

  /**
   * P2P-only 傳輸：透過 WebRTC DataChannel 發送加密訊息
   * ADR-016: MQTT 絕不傳訊息內容，無 fallback
   */
  const sendEncryptedToMember = useCallback(
    (memberPk: string, serializedMessage: string) => {
      const p2pPayload = JSON.stringify({
        type: 'encrypted_message',
        payload: serializedMessage,
      });
      sendViaP2P(memberPk, p2pPayload);
    },
    []
  );

  /**
   * 用鏈上目前那一代的群組金鑰加密、廣播給名冊上的其他成員（一次加密，全員收到相同密文，BT Seed 可轉送）。
   * 拿不到目前那一代（等金鑰中）→ 不送、回 false：不退回上一代（剛被踢的人可能還有）、不雙發、不改走 1 對 1。
   * 簽過名的明文附我的 log 位置（head），收端交叉比對伺服器有沒有給大家看同一條 log。
   */
  const sendGroupKeyEncrypted = useCallback(
    async (
      memberPubkeys: string[],
      plaintextJson: string,
      groupId: string,
      messageId: string,
      msgType: string,
    ): Promise<boolean> => {
      const engine = getGroupEngine();
      const sending = engine ? await engine.sendingKey(groupId) : null;
      if (!engine || !sending) {
        console.error('[useGroupChat] no current-epoch group key for', groupId.slice(0, 8), '— waiting for the key, not sent');
        window.dispatchEvent(new CustomEvent('aegis:group-key-wait', { detail: { groupId } }));
        return false;
      }
      const head = engine.gossip(groupId);
      const plaintext = JSON.stringify({ ...(JSON.parse(plaintextJson) as Record<string, unknown>), ...(head ? { head } : {}) });
      const { ciphertext, iv } = await groupKeyService.encryptWithGroupKey(plaintext, groupKeyService.bytesToBase64(sending.key));

      // 構建 P2P 封包（所有成員收到相同封包）
      const groupMessage: groupKeyService.SignedGroupMessage = {
        messageId,
        groupId,
        senderId: publicKeyBase64!,
        timestamp: Date.now(),
        type: msgType,
        encrypted: { keyId: sending.kid, ciphertext, iv },
        signature: groupKeyService.signPlaintext(plaintext),
      };

      const p2pPayload = JSON.stringify({
        type: 'group_key_message',
        payload: groupMessage,
      });

      // 廣播給所有成員。每人各留一份「等回條」（對應群星 8708fa6f，多人模擬 S3／S5：通道剛死時 readyState 還說
      //   open，以前送進去就算送到、不重送 → 那幾則永遠不見）；對方存好回 group_msg_ack 才清，沒回條就原封不動重送
      for (const memberPk of memberPubkeys) {
        sendViaP2P(memberPk, p2pPayload, { messageId, group: true });
        mqttService.triggerFcmNotify(memberPk, { type: 'message' });
      }

      console.error('[useGroupChat] ✅ Group Key encrypted + broadcast to', memberPubkeys.length, 'members, keyId:', sending.kid);
      return true;
    },
    [publicKeyBase64]
  );

  /** 送不出去（等金鑰）的那則標成失敗（資料庫＋畫面上的泡泡：顯示「未送出・重送」，不會以為送出去了） */
  const markUnsent = useCallback((messageId: string) => {
    storage.updateMessageStatus(messageId, 'failed').catch(() => undefined);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, sendStatus: 'failed' as const } : m)));
  }, []);

  /**
   * 發送群組訊息（視圖模式）
   * 實際透過 1-1 加密對話發送給每個成員，並標記 groupId
   * ADR-016: 加密失敗不 fallback 到明文
   */
  const sendMessage = useCallback(
    async (content: string, ttl?: number) => {
      if (!currentGroupId || !currentGroup || !publicKeyBase64) return;

      const messageId = generateId('gmsg');
      const now = Date.now();

      // 取得其他群組成員的公鑰
      const otherMemberPubkeys = getOtherMemberPublicKeys(currentGroupId, publicKeyBase64);

      // ADR-016: 巢狀群組已移除，只標記當前群組
      const allGroupIds: string[] = [currentGroupId];

      console.error('[useGroupChat] Sending group message to', otherMemberPubkeys.length, 'members');

      // Optimistic update：立即在 UI 顯示自己的訊息（不等 SQLite）
      const optimisticMsg: Message = {
        id: messageId,
        content,
        senderId: 'me',
        timestamp: now,
        type: 'text',
        isRead: true,
        isBurned: false,
        groupIds: allGroupIds,
      };
      setMessages(prev => [...prev, optimisticMsg]);

      // 儲存一份到本地（群組視圖只需一份，避免 N 成員 = N 重複氣泡）。不等它存完就往下加密送出；但送不出去時要等它存完
      //   才標成失敗（W5 S13：以前「存」比「標失敗」晚落地，等金鑰時打的那則在資料庫裡變回 sent，畫面以為送出去了）
      let saved: Promise<unknown> = Promise.resolve();
      if (otherMemberPubkeys.length > 0) {
        const firstPeerConversationId = storage.getConversationIdForPeer(otherMemberPubkeys[0]);
        saved = storage.saveMessage({
          id: messageId,
          conversationId: firstPeerConversationId,
          senderPubkey: publicKeyBase64,
          content,
          type: 'text',
          createdAt: now,
          ttl: ttl ?? 0,
          expiresAt: ttl && ttl > 0 ? now + ttl * 1000 : null,
          readAt: now,
          isOutgoing: true,
          status: 'sent',
          groupIds: allGroupIds,
        }).catch((err) => console.error('[useGroupChat] Failed to save sent message:', err));
      }

      // ADR-016: Group Key 加密 — 一次加密，全員收到相同密文
      const plaintext = JSON.stringify({
        id: messageId,
        content,
        type: 'text' as const,
        timestamp: now,
        ttl,
        groupId: currentGroupId,
        groupIds: allGroupIds,
        senderName: userProfile.displayName || t('common.me'),
      });
      // 送不出去（等金鑰）或封裝時丟例外 → 等那一份存完再標失敗（W5 S13；丟例外也一樣，W5 複審）
      let sent = false;
      try {
        sent = await sendGroupKeyEncrypted(otherMemberPubkeys, plaintext, currentGroupId, messageId, 'text');
      } finally {
        if (!sent) {
          await saved;
          markUnsent(messageId);
        }
      }

      devLog('[useGroupChat] Group message sent (Group Key):', currentGroupId, messageId);
    },
    [currentGroupId, currentGroup, publicKeyBase64, userProfile.displayName, getOtherMemberPublicKeys, sendGroupKeyEncrypted, markUnsent, t]
  );

  /**
   * 重送一則沒送出去的（泡泡上的「重送」）：同一個 id、原本的時間與內容，用鏈上目前那一代的金鑰再送一次。
   * 還是拿不到金鑰 → 維持「未送出」、回 false；送出去了 → 資料庫改回 sent、泡泡上的標記拿掉
   */
  const retryUnsent = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!currentGroupId || !publicKeyBase64) return false;
      const msg = messages.find((m) => m.id === messageId && m.senderId === 'me' && m.sendStatus === 'failed');
      // 只有文字與語音會「等金鑰送不出去」（sendMessage／sendVoiceMessage 的 markUnsent）；檔案另有自己的重傳
      if (!msg || (msg.type !== 'text' && msg.type !== 'voice')) return false;
      // 只送給寫這則的時候就在群裡的人（審查 L8：之後才加入的人不該因為重送收到加入前的訊息）
      const joinedBefore = new Set((currentGroup?.members ?? []).filter((m) => m.joinedAt <= msg.timestamp).map((m) => m.publicKey));
      const otherMemberPubkeys = getOtherMemberPublicKeys(currentGroupId, publicKeyBase64).filter((pk) => joinedBefore.has(pk));
      if (otherMemberPubkeys.length === 0) return false;
      const plaintext = JSON.stringify({
        id: msg.id,
        content: msg.content,
        type: msg.type,
        timestamp: msg.timestamp,
        ...(msg.ttl ? { ttl: msg.ttl } : {}),
        ...(msg.type === 'voice' && msg.voiceData ? { voiceData: msg.voiceData } : {}),
        groupId: currentGroupId,
        groupIds: [currentGroupId],
        senderName: userProfile.displayName || t('common.me'),
      });
      let sent = false;
      try {
        sent = await sendGroupKeyEncrypted(otherMemberPubkeys, plaintext, currentGroupId, msg.id, msg.type);
      } catch (err) {
        console.error('[useGroupChat] retry failed:', err);
      }
      if (!sent) return false;
      await storage.updateMessageStatus(msg.id, 'sent').catch(() => undefined);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, sendStatus: undefined } : m)));
      return true;
    },
    [currentGroupId, currentGroup, publicKeyBase64, messages, getOtherMemberPublicKeys, userProfile.displayName, sendGroupKeyEncrypted, t]
  );

  /**
   * 發送群組檔案訊息（Phase 10: 群組檔案傳送）
   * 透過 1-1 對話發送給每個成員
   */
  const sendFileMessage = useCallback(
    async (file: File, caption?: string) => {
      if (!currentGroupId || !currentGroup || !publicKeyBase64) return;

      const now = Date.now();

      // 取得其他群組成員的公鑰
      const otherMemberPubkeys = getOtherMemberPublicKeys(currentGroupId, publicKeyBase64);
      const allGroupIds: string[] = [currentGroupId];

      devLog('[useGroupChat] Sending group file (chunked) to', otherMemberPubkeys.length, 'members:', file.name);

      // 分塊 P2P（與 1-1 同協定）。舊 inline base64 走 group_key_message 一包送，
      // 超過 DataChannel 單訊息上限（~256KB）整包送不出去 → 群組 PDF 收不到。
      const { fileId, messageId } = await fileTransfer.sendFileToGroup(
        otherMemberPubkeys,
        file,
        allGroupIds,
        caption,
      );

      // 儲存一份到本地（檔案本體在 fileBlobStore，content 留空）
      if (otherMemberPubkeys.length > 0) {
        const firstPeerConversationId = storage.getConversationIdForPeer(otherMemberPubkeys[0]);
        await storage.saveMessage({
          id: messageId,
          conversationId: firstPeerConversationId,
          senderPubkey: publicKeyBase64,
          content: caption ?? '',
          type: 'file',
          createdAt: now,
          ttl: 0,
          expiresAt: null,
          readAt: now,
          isOutgoing: true,
          status: 'sent',
          groupIds: allGroupIds,
          metadata: JSON.stringify({
            fileData: {
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
              caption,
              fileId,
            },
          }),
        }).catch((err) => console.error('[useGroupChat] Failed to save sent file:', err));
      }

      loadGroupMessages();
      devLog('[useGroupChat] Group file sent (chunked):', currentGroupId, file.name);
    },
    [currentGroupId, currentGroup, publicKeyBase64, getOtherMemberPublicKeys, loadGroupMessages]
  );

  /**
   * 發送群組語音訊息
   * 透過加密 1-1 對話發送給每個成員
   */
  const sendVoiceMessage = useCallback(
    async (voice: VoiceMessageData) => {
      if (!currentGroupId || !currentGroup || !publicKeyBase64) return;

      const messageId = generateId('gvoice');
      const now = Date.now();

      const otherMemberPubkeys = getOtherMemberPublicKeys(currentGroupId, publicKeyBase64);
      const allGroupIds: string[] = [currentGroupId];

      // 儲存一份到本地（送不出去時等它存完才標失敗，同 sendMessage）
      let saved: Promise<unknown> = Promise.resolve();
      if (otherMemberPubkeys.length > 0) {
        const firstPeerConversationId = storage.getConversationIdForPeer(otherMemberPubkeys[0]);
        saved = storage.saveMessage({
          id: messageId,
          conversationId: firstPeerConversationId,
          senderPubkey: publicKeyBase64,
          content: voice.audioData,
          type: 'voice',
          createdAt: now,
          ttl: 0,
          expiresAt: null,
          readAt: now,
          isOutgoing: true,
          status: 'sent',
          groupIds: allGroupIds,
          metadata: JSON.stringify({
            voiceData: {
              duration: voice.duration,
              mimeType: voice.mimeType,
              waveform: voice.waveform,
            },
          }),
        }).catch((err) => console.error('[useGroupChat] Failed to save voice message:', err));
      }

      // ADR-016: Group Key 加密
      const plaintext = JSON.stringify({
        id: messageId,
        content: voice.audioData,
        type: 'voice' as const,
        timestamp: now,
        voiceData: { duration: voice.duration, mimeType: voice.mimeType, waveform: voice.waveform },
        groupId: currentGroupId,
        groupIds: allGroupIds,
        senderName: userProfile.displayName || t('common.me'),
      });
      // 送不出去（等金鑰）或封裝時丟例外 → 等那一份存完再標失敗（W5 S13；丟例外也一樣，W5 複審）
      let sent = false;
      try {
        sent = await sendGroupKeyEncrypted(otherMemberPubkeys, plaintext, currentGroupId, messageId, 'voice');
      } finally {
        if (!sent) {
          await saved;
          markUnsent(messageId);
        }
      }

      loadGroupMessages();
      devLog('[useGroupChat] Group voice sent (Group Key):', currentGroupId, messageId);
    },
    [currentGroupId, currentGroup, publicKeyBase64, userProfile.displayName, getOtherMemberPublicKeys, loadGroupMessages, sendGroupKeyEncrypted, markUnsent, t]
  );

  /**
   * 轉發訊息/檔案到任意群組（不依賴 currentGroupId）
   *
   * 用於 ForwardModal — 允許從聊天視窗外把內容轉到群組視圖。
   * 與 sendMessage / sendFileMessage 相同的 Group Key 加密 + 廣播路徑，
   * 但 groupId 由參數帶入而非從 store 取。
   */
  const forwardToGroup = useCallback(
    async (
      groupId: string,
      content: string,
      type: 'text' | 'file',
      fileData?: { name: string; mimeType: string; size: number },
    ) => {
      if (!publicKeyBase64) return;

      const group = useGroupStore.getState().getGroupById(groupId);
      if (!group) {
        devWarn('[useGroupChat] forwardToGroup: group not found', groupId);
        return;
      }

      const otherMemberPubkeys = group.members
        .filter((m) => m.publicKey !== publicKeyBase64)
        .map((m) => m.publicKey);

      if (otherMemberPubkeys.length === 0) {
        devWarn('[useGroupChat] forwardToGroup: no other members in group', groupId);
        return;
      }

      const messageId = generateId(type === 'file' ? 'gfile' : 'gmsg');
      const now = Date.now();
      const allGroupIds: string[] = [groupId];

      // 儲存到本地（用第一位成員的 conversationId，與 sendMessage 一致）
      const firstPeerConversationId = storage.getConversationIdForPeer(otherMemberPubkeys[0]);
      const metadata = type === 'file' && fileData ? JSON.stringify({ fileData }) : undefined;
      await storage.saveMessage({
        id: messageId,
        conversationId: firstPeerConversationId,
        senderPubkey: publicKeyBase64,
        content,
        type,
        createdAt: now,
        ttl: 0,
        expiresAt: null,
        readAt: now,
        isOutgoing: true,
        status: 'sent',
        groupIds: allGroupIds,
        metadata,
      }).catch((err) => console.error('[useGroupChat] forwardToGroup save failed:', err));

      // Group Key 加密廣播
      const plaintext = JSON.stringify({
        id: messageId,
        content,
        type,
        timestamp: now,
        ...(type === 'file' && fileData ? { fileData } : {}),
        groupId,
        groupIds: allGroupIds,
        senderName: userProfile.displayName || t('common.me'),
      });
      if (!(await sendGroupKeyEncrypted(otherMemberPubkeys, plaintext, groupId, messageId, type))) markUnsent(messageId);

      devLog('[useGroupChat] Forward to group (Group Key):', groupId, messageId, type);
    },
    [publicKeyBase64, userProfile.displayName, sendGroupKeyEncrypted, markUnsent, t]
  );

  /**
   * 刪除群組訊息（視圖模式）
   * 刪除本地訊息並通知對應的 1-1 對話對象
   */
  const deleteGroupMessage = useCallback(
    async (messageId: string) => {
      if (!currentGroupId || !publicKeyBase64) return;

      // 從本地刪除
      await storage.deleteMessage(messageId);

      // 自己的訊息才「為所有人刪除」（對應群星 P3-1）：群組主題上一則 group_sealed delete（W2：目前這一代金鑰加密、
      //   我的身分簽章；收端只刪「這個群、我寫的」那一則）。以前是每個成員一則帶 groupId 的明文 DELETE_MESSAGE
      const message = messages.find((m) => m.id === messageId);
      if (message?.senderId === 'me') {
        // 還沒送到／還在等回條的那幾份先刪掉：不然通道恢復後的重送會把刪掉的訊息送回去（刪除通知走 MQTT，
        //   可能比重送早到，收端那時還沒有這則可刪）
        await storage.removePendingGroupMessage(messageId).catch((err) =>
          console.error('[useGroupChat] failed to drop queued copies of a deleted message:', err));
        const sent = await getGroupEngine()?.sendControl(currentGroupId, 'delete', { messageId })
          .catch((err) => { console.error('[useGroupChat] group delete not sent:', err); return 'dropped'; });
        devLog('[useGroupChat] group delete:', sent ?? 'no engine');
      }

      // 刷新訊息視圖
      loadGroupMessages();

      devLog('[useGroupChat] Group message deleted:', messageId);
    },
    [currentGroupId, publicKeyBase64, messages, loadGroupMessages]
  );

  /**
   * 發送報平安訊息到守護群組 (Phase 19)
   * 透過加密通道通知所有群組成員
   */
  const sendCheckIn = useCallback(
    async (status: 'ok' | 'help') => {
      if (!currentGroupId || !currentGroup || !publicKeyBase64) return;

      const otherMemberPubkeys = getOtherMemberPublicKeys(currentGroupId, publicKeyBase64);
      const now = Date.now();

      for (const memberPk of otherMemberPubkeys) {
        try {
          const messageData = {
            id: generateId('checkin'),
            content: '',
            type: 'text' as const,
            timestamp: now,
            groupId: currentGroupId,
            groupIds: [currentGroupId],
            checkIn: {
              type: 'check_in_response',
              status,
              memberPubkey: publicKeyBase64,
              memberName: userProfile.displayName || t('common.family'),
              timestamp: now,
            },
          };
          const encrypted = await encrypt(memberPk, JSON.stringify(messageData));
          const serialized = encrypted.toJson();
          sendEncryptedToMember(memberPk, serialized);
        } catch (err) {
          devWarn('[useGroupChat] sendCheckIn encrypt failed for', memberPk.slice(0, 16), err);
        }

        // 只用 FCM 喚醒（以前另送一則明文的 GROUP_INFO_UPDATED checkinSignal：誰在哪個群報平安都寫在 broker 上，拿掉了）
        mqttService.triggerFcmNotify(memberPk, { type: 'check_in' });
      }

      devLog('[useGroupChat] Check-in sent to group:', currentGroupId, status);
    },
    [currentGroupId, currentGroup, publicKeyBase64, userProfile.displayName, getOtherMemberPublicKeys, encrypt, t, sendEncryptedToMember] // sendCheckIn 仍用 1-1 Ratchet（未來遷移到 Group Key）
  );

  return {
    currentGroup,
    messages,
    members,
    isAdmin,
    isFull,

    sendMessage,
    sendFileMessage,
    sendVoiceMessage,
    forwardToGroup,
    createGroup,
    leaveGroup,
    forgetGroup,
    deleteGroup,
    updateGroupInfo,
    updateGuardianSettings,

    addMember,
    removeMember,
    updateMemberRole,
    resendInvite,

    selectGroup,
    clearSelection,

    deleteGroupMessage,
    retryUnsent,

    sendCheckIn,
  };
}

// ============================================
// 額外 Hooks
// ============================================

/**
 * 取得所有群組
 */
export function useGroups(): Group[] {
  return useGroupStore((state) => state.groups);
}

/**
 * 取得群組未讀總數
 */
export function useGroupUnreadCount(): number {
  return useGroupStore((state) =>
    state.groups.reduce((sum, g) => sum + g.unreadCount, 0)
  );
}

/**
 * 檢查是否有群組功能權限
 */
export function useCanUseGroups(): boolean {
  // 這裡可以整合 policyStore 來檢查訂閱等級
  // 暫時返回 true
  return true;
}

export default useGroupChat;

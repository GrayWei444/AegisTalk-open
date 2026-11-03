/**
 * AppProvider - 應用程式服務提供者
 *
 * 整合 Crypto、MQTT、WebRTC 等核心服務的初始化與狀態管理
 */


import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useCrypto, flushSessionWrites } from '@hooks/useCrypto';
import { useMqtt } from '@hooks/useMqtt';
import { useWebRTC } from '@hooks/useWebRTC';
import { MessageType, type MqttMessage, mqttService, ConnectionState } from '@services/mqtt';
import { isBlacklisted, getLocalBlacklist, onBlacklistChanged } from '@services/localBlacklist';
import { createPresenceService, type PresenceScope, type PresenceService } from '@services/presenceService';
import { presenceStore } from '@services/presenceStore';
import { memberPresence } from '@services/memberPresence';
import { isNativeApp } from '@services/capacitor';
import {
  initStorage,
  isInitialized as isStorageInitialized,
  startCleanupTask,
  cleanupOldPendingMessages,
  saveMessage as storageSaveMessage,
  getConversationIdForPeer,
  deleteRatchetState,
  deletePendingMessagesForRecipient,
  deleteGroupMessageFrom,
  hasMessageFrom,
  isGroupMemberAnywhere,
} from '@services/storage';
import { getSetting as dbGetSetting } from '@services/database';
import { getEncryptionKey } from '@services/keyEncryption';
import { fromBase64, toBase64, RatchetMessage, Identity } from '@services/crypto';
import { voiceCallService } from '@services/voiceCall';
// registerDiscoverableCredential 現在在 useCrypto.generateIdentity() 中處理
import { useChatStore, findFriendSettled, onFriendRemoved } from '@stores/chatStore';
import { usePendingFriendStore } from '@stores/pendingFriendStore';
import { clearPeerSession } from '@services/cryptoSessionControl';
import { wasInitAccepted, rememberAcceptedInit, isInitOlderThanAccepted } from '@services/x3dhReplay';
import { verifyInitAuth, createResetBudget } from '@services/x3dhInitAuth';
import { withInitAuth } from '@services/x3dhInitSend';
import { acceptedVia, cleanPeerName, viaName } from '@services/friendInvites';
import {
  startDirectSignal, onDirect, sendProfileUpdate, sendPrekeyRequest, localStorageMarks,
} from '@services/directSignal';
import { signGroupAck, openGroupAck } from '@services/groupAck';
import { viewGroupIdsToSave } from '@services/groupViewScope';
import {
  registerGroupKeySealer, unregisterGroupKeySealer, openGroupSealed, sendGroupSealed, currentSealer, friendViaSealer,
  verify as identityVerify, x25519 as identityX25519,
} from '@services/groupKeyDelivery';
import { createGroupEngine, type GroupEngine } from '@services/groupEngine';
import type { GroupTopic } from '@services/groupTopics';
import { getGroupEngine, setGroupEngine } from '@services/groupEngineHost';
import { groupLogStore } from '@services/groupLogStore';
import { createGroupLogClient } from '@services/groupLogClient';
import { groupControlSource, routeGroupControl } from '@services/groupControlRoute';
import { createInviteVerifier, makeInviteWorker } from '@services/groupInviteVerify';
import { groupCallService } from '@services/groupCallService';
import { apiBase } from '@services/apiBase';
import { registerChainProjector } from '@stores/groupStore';
import { registerOutboxEncrypt } from '@services/p2pSend';
import { DIRECT_VISIBLE_TYPES, GROUP_VISIBLE_TYPES, visibleTypeOf } from '@services/visibleTypes';
import { useGroupStore } from '@stores/groupStore';
import { autoRequestPersistence } from '@services/persistence';
// ADR-016: Group Key + BT Seed
import * as groupKeyService from '@services/groupKey';
import * as seedSync from '@services/seedSync';
import * as offlineQueue from '@services/offlineQueue';
import { notifyConnectSuccess, sendViaP2P, confirmDelivered, flushQueueForPeer, getQueueSize, dropGroupOutboxFor } from '@services/p2pSend';
import { groupMemberKeys, knownPeerKeys, newlyAdded } from '@services/rosterPeers';
import { createPeerBudget } from '@services/peerBudget';
import * as fileTransfer from '@services/fileTransfer';
import { webrtcService } from '@services/webrtc';
// Phase 35a/b: 單一裝置綁定
import { claimDevice, startHeartbeatLoop, stopHeartbeatLoop, handleKickSignal, wipeLocalKeys } from '@services/deviceClaim';
import { rankScopeGroups, rankScopeTopics } from '@services/mqttCredential';
import type { L2Result } from '../types';
// 版本的擴充：防詐、身分（AegisID）、守護、AegisPay、網路防護、外掛宿主（官方版）；社群版是空的／不做（src/ext）
import { ext } from '@ext';
// i18n 語言設定
import { useLanguageStore } from '../i18n/store';
import { useFontScaleStore } from '../stores/fontScaleStore';
import { getServiceTranslation } from '../i18n/serviceHelper';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { markAppInitCompleted } from '../utils/initFlag';
import { mqttHealthMonitor } from '@services/mqttHealthMonitor';
import { peerHealthMonitor } from '@services/peerHealthMonitor';
import { networkMonitor } from '@services/networkMonitor';

// 應用狀態
interface AppState {
  // Crypto
  cryptoReady: boolean;
  hasIdentity: boolean;
  keysLocked: boolean;
  publicKey: string | null;

  // Storage
  storageReady: boolean;

  // MQTT
  mqttConnected: boolean;

  // WebRTC
  activePeers: string[];

  // 整體狀態
  isInitializing: boolean;
  error: string | null;

  // 是否已進入聊天模式（用於延遲載入重型資源）
  isInChatMode: boolean;
}

// Context 值
interface AppContextValue extends AppState {
  // Crypto 金鑰 (用於 QR Code 產生)
  signedPreKey: {
    publicKeyBase64: string;
    signatureBase64: string;
  } | null;

  // Crypto 操作
  generateIdentity: () => string;
  getPreKeyBundle: () => string | null;
  unlockAndReloadKeys: () => Promise<boolean>;

  // MQTT 操作
  connectMqtt: () => Promise<void>;
  disconnectMqtt: () => void;
  sendToUser: (recipientPublicKey: string, type: MessageType, payload: unknown) => void;
  subscribeMessage: (type: MessageType | '*', callback: (message: MqttMessage) => void) => () => void;

  // WebRTC 操作
  connectPeer: (remotePublicKey: string) => Promise<void>;
  sendToPeer: (remotePublicKey: string, data: string | ArrayBuffer) => boolean;
  disconnectPeer: (remotePublicKey: string) => void;
  isConnectedTo: (remotePublicKey: string) => boolean;

  // 加解密操作
  encryptMessage: (recipientPublicKey: string, plaintext: string) => Promise<unknown>;
  decryptMessage: (senderPublicKey: string, ciphertext: unknown) => Promise<string>;

  // 聊天模式控制（用於延遲載入重型資源）
  enterChatMode: () => void;

  // 會話管理
  createSession: (
    recipientIdentityPublic: Uint8Array,
    recipientSignedPrekeyPublic: Uint8Array,
    recipientSignedPrekeySignature: Uint8Array,
    recipientOneTimePrekeyPublic?: Uint8Array,
    recipientOneTimePrekeyId?: number,
    forceFresh?: boolean
  ) => { session: unknown; ephemeralPublicKey: Uint8Array; usedOneTimePrekeyId?: number };
  acceptSession: (
    senderIdentityPublic: Uint8Array,
    senderEphemeralPublic: Uint8Array,
    usedOneTimePrekeyId?: number,
    forceReset?: boolean
  ) => unknown;
}

const AppContext = createContext<AppContextValue | null>(null);

interface AppProviderProps {
  children: ReactNode;
}

// 群組訊息 ID 去重（防止加密路徑和明文 fallback 路徑雙重處理）
// 使用 Map + 定時清理取代 per-entry setTimeout（避免大量 timer 堆積）
const processedGroupMessageIds = new Map<string, number>();
const GROUP_MSG_DEDUP_TTL = 60_000; // 60 秒後清除
const GROUP_MSG_DEDUP_MAX = 5000; // 最大追蹤數

// 定期清理過期條目
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedGroupMessageIds) {
    if (now - ts > GROUP_MSG_DEDUP_TTL) processedGroupMessageIds.delete(id);
  }
}, 30_000);

function markGroupMessageProcessed(messageId: string): boolean {
  if (processedGroupMessageIds.has(messageId)) return false; // 已處理
  // 防止無限增長
  if (processedGroupMessageIds.size >= GROUP_MSG_DEDUP_MAX) {
    const oldestKey = processedGroupMessageIds.keys().next().value;
    if (oldestKey !== undefined) processedGroupMessageIds.delete(oldestKey);
  }
  processedGroupMessageIds.set(messageId, Date.now());
  return true; // 首次處理
}

/**
 * 群組訊息的送達回條（對應群星 8708fa6f，多人模擬 S3／S5）：寄件者每個成員各留一筆「等回條」，收到就停止重送
 * （p2pSend.confirmDelivered 只清「送給回條者」的那筆）。走 P2P DataChannel 的控制幀，由回條者的身分金鑰簽章（見下面
 * ackGroupMessage）；內容只有 messageId，沒有群組內容。送不出去就進 outbox；寄件者沒收到回條頂多多重送一次，這邊依 id 去重。
 */
/**
 * 正在處理的群訊（寄件者|messageId）。通道換過時寄件者會很快重送同一則（p2pSend inflightDue），兩份幾乎同時到：
 * 「已經存過嗎」的查詢跟存檔中間隔著好幾個 await，兩份都會當成新的處理（未讀、風險分數各算兩次）。
 * 進函式時同步佔位，同一則的第二份直接略過 —— 先到的那份存好就會回條。
 */
const groupMessagesInProgress = new Set<string>();

/**
 * 既有好友的 X3DH_INIT 重置 session 的額度（開源第 5b 步，services/x3dhInitAuth.ts）：每個好友 10 分鐘最多 5 次。
 * 簽章已經擋掉冒名的 INIT；這一關擋的是一個金鑰外洩的好友（或一份重放還在時效內的簽章 INIT）一直把 session 打掉重建
 */
const initResetBudget = createResetBudget();

/**
 * 好友與群組清單都從本機載入了沒（最多等 timeoutMs）。冷啟動時 broker 一口氣補送離線期間的訊息，封給身分金鑰的
 * 群組金鑰可能比清單早到：那時判斷「寄件者是不是好友／成員、群組在不在」都會答錯 → 邀請者的金鑰、非好友接手者的
 * 輪換被當成陌生人的丟掉（程式碼審查 H2）。
 */
function waitForLocalLists(timeoutMs = 15_000): Promise<void> {
  const ready = () => useChatStore.getState().isLoaded && useGroupStore.getState().isLoaded;
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubs: Array<() => void> = [];
    const done = () => { clearTimeout(timer); unsubs.forEach((u) => u()); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    const check = () => { if (ready()) done(); };
    unsubs.push(useChatStore.subscribe(check), useGroupStore.subscribe(check));
    check();
  });
}

/**
 * 回條由我的身分金鑰簽章（開源第 4 步，groupAck）：以前是通道上的明文 { ids } —— 通道被中間人接手的話他替我回條，
 * 寄件人就停止重送、那則群訊永遠到不了。身分還沒解鎖（不該發生：收得到群訊就解鎖了）→ 不回（寄件人照樣重送）
 */
function ackGroupMessage(peer: string, messageId: string): void {
  if (!messageId || messageId.length > 128) return;
  const s = currentSealer();
  if (!s) return;
  const frame = signGroupAck({ from: s.me, to: peer, ids: [messageId], ts: mqttService.serverNow(), sign: s.sign });
  if (frame.ids.length === 0) return;
  sendViaP2P(peer, JSON.stringify(frame));
}

/**
 * 群組金鑰信封與索取的每人額度（對應群星 e1b119c7，審查 LOW）：拆一封信封要 X25519＋HKDF＋AES＋簽章驗證，
 * 回覆索取要再封一封送出去，向寄件者索取也要封一封。正常量（建群、加人、輪換、偶爾補金鑰）遠低於這些額度。
 */
const sealedOpenBudget = createPeerBudget({ capacity: 60, refillPerSec: 1, maxPeers: 512 });
const keyAnswerBudget = createPeerBudget({ capacity: 20, refillPerSec: 1 / 3, maxPeers: 512 });
/**
 * 群組主題上的 group_sealed 每個寄件人的額度（W2）：名冊外的人引擎不解密就丟（便宜），成員的每一則要 AES-GCM＋簽章驗證；
 * 正常量（commit 通知、上線的 here、通話控制、刪除）遠低於這個
 */
const groupControlBudget = createPeerBudget({ capacity: 120, refillPerSec: 2, maxPeers: 512 });

/**
 * presence 服務建好了沒（冷啟動時 broker 補送的 share 可能比服務早到；審查 W4 #1：不等的話那一封就掉了）：最多等 timeoutMs。
 * 只交給同一個帳號的服務（等的時候換了帳號 → null）
 */
async function waitForPresenceService(ref: { current: PresenceService | null }, me: string, timeoutMs = 60_000): Promise<PresenceService | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const service = ref.current;
    if (service) return service.me === me ? service : null;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 群組引擎起來了沒（冷啟動時 broker 補送的邀請可能比引擎早到）：最多等 timeoutMs */
/** 引擎載完（冷啟動時信封可能比引擎早到；邀請等不到就掉了，所以等久一點，審查 W1 M-2） */
async function waitForGroupEngine(timeoutMs = 60_000): Promise<GroupEngine | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const engine = getGroupEngine();
    if (engine?.isReady()) return engine;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * 好友或同群成員（群組信封只收這兩種人的）。好友清單一時載到 0 筆（chatStore 的 readiness race）
 * 時 findFriendSettled 會查 contacts 表 —— 不能因此把好友（例如邀請者）寄的金鑰當成陌生人的丟掉
 */
async function isFriendOrFellowMember(pk: string): Promise<boolean> {
  if (useGroupStore.getState().groups.some((g) => g.members.some((m) => m.publicKey === pk))) return true;
  return !!(useChatStore.getState().getFriendByPublicKey(pk) || await findFriendSettled(pk));
}

export function AppProvider({ children }: AppProviderProps) {
  const [isInitializing, setIsInitializing] = useState(true);
  const [storageReady, setStorageReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P2P→MQTT 統一處理：P2P 收到的 encrypted_message 也走 ENCRYPTED_MESSAGE handler
  const processEncryptedMessageRef = useRef<((from: string, payload: unknown) => Promise<void>) | null>(null);
  // P2P 收到 encrypted frame 但 decrypt handler 還沒掛上 → 先 buffer 這裡，handler ready 後 drain（不准靜默丟）
  const pendingInboundP2PRef = useRef<Array<{ peer: string; payload: unknown }>>([]);
  const aeadRepairRequestRef = useRef<Map<string, number>>(new Map());
  const [isInChatMode, setIsInChatMode] = useState(false);

  // Crypto Hook
  const {
    initialized: cryptoReady,
    loading: cryptoLoading,
    error: cryptoError,
    hasIdentity,
    keysLocked,
    publicKeyBase64: publicKey,
    signedPreKey,
    identity,  // Phase 8: 需要 identity 來進行簽名
    generateIdentity,
    getPreKeyBundle,
    unlockAndReloadKeys,
    encrypt,
    decrypt,
    acceptSession,
    createSession,
    recentlyInitiatedTo, // glare tiebreak 證據（sessionReset 清除前判斷，2026-08-19）
    hasSessionWith, // 重複 X3DH_INIT 去重（sessionReset 清除前判斷，傳輸統一 X6）
  } = useCrypto();

  // 「待加密」outbox 的加密器（2026-08-19 修訊息無聲消失）：flush 時用當下 session 加密；
  // 尚無 session 回 null（flush 會保留條目、停批保序，等 session 建立後再試）。
  useEffect(() => {
    if (!cryptoReady) return;
    registerOutboxEncrypt(async (peerPubkey: string, plaintext: string) => {
      try {
        const m = await encrypt(peerPubkey, plaintext);
        try { return m.toJson(); } finally { (m as { free?: () => void }).free?.(); }
      } catch (e) {
        if (/no session with this recipient/i.test((e as Error)?.message ?? '')) return null;
        throw e;
      }
    }, publicKey ?? undefined, (peerPubkey) => {
      // 無 session 的 outbox 條目 → 請對方發起 X3DH。**必須附上我方 bundle**：對方若沒存過我的
      //   prekey（L688「收 X3DH_INIT 反向加入」的舊 contact、或對方剛恢復），他的 handler 會走
      //   `no bundle (stored or attached) → cannot re-initiate` 直接放棄**且不回報**，我方乾等。
      //   payload 與 SessionRepair 讓步分支（見 repairMissingSessions）保持同一份；對方用既有的 X3DH 流程驗簽。
      //   MQTT 沒連上就回 false：p2pSend 不記這次，下一次 flush 再催（對應群星）
      if (!mqttService.isConnected() || !signedPreKey) return false;
      // 封給對方的身分金鑰（DIRECT_SEALED kind prekey；以前明文，營運方能冒名一直叫人重建 session）
      sendPrekeyRequest(peerPubkey, { signedPreKey: signedPreKey.publicKeyBase64, signature: signedPreKey.signatureBase64 })
        .catch((err) => console.error('[AppProvider] prekey request not sent:', err));
      return true;
    });
  }, [cryptoReady, encrypt, publicKey, signedPreKey]);

  // FamilyGuard 等版本掛鉤用（ext.ui.ProviderWrapper、ext.hooks.usePaymentSweep 收到的 encryptToJson）：加密並序列化為 JSON
  // （Double Ratchet RatchetMessage.toJson()），官方版的 P2P envelope payload 直接放這個字串。
  const encryptToJson = useCallback(
    async (recipientPubkey: string, plaintext: string): Promise<string> => {
      const encrypted = await encrypt(recipientPubkey, plaintext);
      return (encrypted as RatchetMessage).toJson();
    },
    [encrypt],
  );

  // MQTT Hook - 需要 publicKey 參數
  const mqtt = useMqtt(publicKey, { autoConnect: false, isDev: false });

  // MQTT token 必須由已解鎖的帳戶金鑰簽署（伺服器不再收 pubkeyHash）；service 只保存簽署函式，不保存私鑰 bytes。
  //   要在下面任何「連 MQTT」的 effect 之前跑（同一次 render 裡 effect 依宣告順序執行）
  useEffect(() => {
    if (!identity) {
      mqttService.setIdentitySigner(null);
      return;
    }
    mqttService.setIdentitySigner({
      publicKey: identity.publicKeyBase64,
      sign: (data) => identity.sign(data),
    });
    return () => mqttService.setIdentitySigner(null);
  }, [identity]);

  // 守護群組：報平安的本機排程通知、全螢幕卡片的文字、按了「報平安」的接手（官方版；社群版沒有）
  const { useGuardian, usePaymentSweep, useCheckInScheduler } = ext.hooks;
  const { useServiceRegistration } = ext.identity;
  useGuardian(publicKey);

  // ============================================
  // ADR-016: Group Key 訊息處理
  // ============================================

  /**
   * 暫時收不下的群訊（狀態鏈還沒到：群還沒加入、寄件者還不在我套上的名冊、那一代的金鑰還沒拿到），依群組收著，
   * 引擎一有變化（套上新的 commit、拿到金鑰、加入）就重試（retryPendingGroupMessages）。不回條 → 寄件者也會重送。
   * 每群最多 PENDING_GROUP_MSG_PER_GROUP、全部最多 PENDING_GROUP_MSG_MAX、2 分鐘，滿了丟新到的。
   */
  const pendingGroupMessagesRef = useRef<Map<string, Array<{ senderPubkey: string; msg: groupKeyService.SignedGroupMessage; at: number }>>>(new Map());
  const PENDING_GROUP_MSG_MAX = 200;
  const PENDING_GROUP_MSG_PER_GROUP = 50;
  const PENDING_GROUP_MSG_TTL_MS = 120_000;

  const holdGroupMessage = useCallback((groupId: string, senderPubkey: string, msg: groupKeyService.SignedGroupMessage) => {
    const now = Date.now();
    const map = pendingGroupMessagesRef.current;
    let total = 0;
    for (const [gid, list] of map) {
      const fresh = list.filter((x) => now - x.at < PENDING_GROUP_MSG_TTL_MS);
      if (fresh.length) map.set(gid, fresh); else map.delete(gid);
      total += fresh.length;
    }
    const list = map.get(groupId) ?? [];
    if (total >= PENDING_GROUP_MSG_MAX || list.length >= PENDING_GROUP_MSG_PER_GROUP || list.some((x) => x.msg.messageId === msg.messageId)) return;
    map.set(groupId, [...list, { senderPubkey, msg, at: now }]);
  }, []);

  // G6 pending intent sweep（官方版 AegisPay；社群版沒有）
  usePaymentSweep(publicKey, encryptToJson);

  /**
   * 收到群訊（P2P group_key_message）。群組狀態只看套上的狀態鏈（docs/GROUP_LOG_WIRING_W1.md）：
   *  - 只用「這個群鏈上那一代」的金鑰解（kid 不是鏈上的世代、或那一代還沒拿到 → 先收著、補抓 log；不再向寄件者要金鑰，
   *    缺金鑰時引擎向 admin 要）。沒有過渡期的舊金鑰雙發。
   *  - 寄件者要在我套上的名冊上（不在 → 可能是我落後：先收著、補抓 log）。以前的「名冊自癒」拿掉了。
   *  - 簽章是寄件者本人的；明文附的 log 位置交叉比對（我落後 → 抓；同一個位置不同的鏈 → 從基準點重建）
   */
  const handleGroupKeyMessage = useCallback(async (senderPubkey: string, msg: groupKeyService.SignedGroupMessage) => {
    const claimKey = typeof msg?.messageId === 'string' && msg.messageId ? `${senderPubkey}|${msg.messageId}` : null;
    if (claimKey && groupMessagesInProgress.has(claimKey)) return;   // 同一則的另一份正在處理（見 groupMessagesInProgress）
    if (claimKey) groupMessagesInProgress.add(claimKey);
    try {
      const { encrypted, signature, groupId, messageId, senderId } = msg;

      if (!encrypted || typeof encrypted.keyId !== 'string' || typeof encrypted.ciphertext !== 'string'
          || typeof encrypted.iv !== 'string' || typeof groupId !== 'string' || typeof messageId !== 'string') {
        diagLog('[DIAG:GK] ❌ Invalid group_key_message structure:', JSON.stringify(msg).slice(0, 200));
        return;
      }
      if (senderId !== senderPubkey) {
        diagLog('[DIAG:GK] ❌ senderId is not the peer that sent it — ignored');
        return;
      }

      diagLog('[DIAG:GK] Processing:', messageId, 'keyId:', encrypted.keyId, 'from:', senderPubkey.slice(0, 16));
      // 群組裡封鎖的人也看不到他的訊息（稽核 H13，對應 AegisPlay B49）。查詢失敗就當沒封鎖並記一筆，
      //   不能因為封鎖名單一時查不到就把訊息丟掉（部署前審查 LOW）
      const gkBlocked = await isBlacklisted(senderPubkey).catch((err) => {
        console.error('[AppProvider] blacklist lookup failed — treating sender as not blocked:', err);
        return false;
      });
      if (gkBlocked) return;
      // 寄件者沒等到回條會重送同一則（p2pSend 群組等回條）：已經存過 → 只回條，不再算一次未讀
      if (messageId && await hasMessageFrom(messageId, senderPubkey)) {
        diagLog('[DIAG:GK] duplicate (already saved) → ack only:', messageId);
        ackGroupMessage(senderPubkey, messageId);
        return;
      }

      const engine = getGroupEngine();
      if (!engine || !engine.knows(groupId)) {
        // 群還沒加入（邀請確認中）或引擎還沒起來：先收著，加入後重試
        holdGroupMessage(groupId, senderPubkey, msg);
        diagLog('[DIAG:GK] ⏳ group not joined yet — held:', groupId.slice(0, 8));
        return;
      }
      if (!engine.isMember(groupId, senderPubkey)) {
        // 我套上的名冊沒有他：我可能落後（他剛被加進來）→ 收著、補抓 log；被踢的人送的抓完還是不在 → 過期丟掉
        holdGroupMessage(groupId, senderPubkey, msg);
        engine.requestSync(groupId);
        diagLog('[DIAG:GK] ⏳ sender not on my applied roster — held, syncing:', senderPubkey.slice(0, 16));
        return;
      }
      // 金鑰要是「這個群」鏈上的那一代（以前 X 群的成員可以拿 X 的金鑰加密、標成 Y 群送來，稽核 H8）
      const key = engine.decryptKey(groupId, encrypted.keyId);
      if (!key) {
        holdGroupMessage(groupId, senderPubkey, msg);
        engine.requestSync(groupId);
        diagLog('[DIAG:GK] ⏳ no key for', encrypted.keyId, 'in this group yet — held, syncing');
        return;
      }
      let plaintext: string;
      try {
        plaintext = await groupKeyService.decryptWithGroupKey(encrypted.ciphertext, encrypted.iv, groupKeyService.bytesToBase64(key));
      } catch {
        diagLog('[DIAG:GK] ❌ does not decrypt under its epoch key — ignored:', messageId);
        return;
      }

      // 驗證簽名（寄件者本人）
      if (!groupKeyService.verifySignature(senderPubkey, plaintext, signature)) {
        diagLog('[DIAG:GK] ❌ Signature verification failed from', senderPubkey.slice(0, 16));
        return;
      }

      // 解析明文
      const parsed = JSON.parse(plaintext);
      diagLog('[DIAG:GK] ✅ Decrypted:', messageId, 'from', senderPubkey.slice(0, 16), 'chars:', parsed.content?.length ?? 0);
      if (parsed.head) engine.onGossip(groupId, parsed.head, senderPubkey);

      // 快取密文（成為 Seed）
      offlineQueue.cacheGroupMessage({
        messageId,
        groupId,
        payload: JSON.stringify({ type: 'group_key_message', payload: msg }),
        senderId: senderPubkey,
        timestamp: msg.timestamp,
        cachedAt: Date.now(),
      });

      // L2 風險評估（Group Key 主路徑先前完全沒掃 → 群組詐騙文字 0 偵測，§0.14 ③）。防詐是官方版的功能（ext.antiFraud）；
      //   社群版不掃，回 undefined（沒有風險）
      const groupRiskResult: L2Result | undefined = await ext.antiFraud.inspectInbound({
        site: 'group-key', sender: senderPubkey, messageId: parsed.id || '', type: parsed.type || 'text', content: parsed.content,
      });

      // 儲存到 SQLite（視圖群組模式）。明文的 groupIds 只留寄件者所屬的群（稽核 H8）
      const savedGroupIds = viewGroupIdsToSave(senderPubkey, groupId, parsed.groupIds,
        (id) => useGroupStore.getState().getGroupById(id), parsed.groupIds || [groupId]);
      const conversationId = getConversationIdForPeer(senderPubkey);
      await storageSaveMessage({
        id: parsed.id || messageId,
        conversationId,
        senderPubkey,
        content: parsed.content || '',
        type: parsed.type || 'text',
        createdAt: parsed.timestamp || Date.now(),
        ttl: parsed.ttl || 0,
        expiresAt: null,
        readAt: null,
        isOutgoing: false,
        status: 'delivered',
        groupIds: savedGroupIds,
        metadata: parsed.voiceData || parsed.fileData || groupRiskResult ? JSON.stringify({
          voiceData: parsed.voiceData,
          fileData: parsed.fileData,
          riskResult: groupRiskResult,
        }) : undefined,
      });

      // 驗證儲存成功
      diagLog('[DIAG:GK] Saved to SQLite @', Date.now(), 'groupIds:', JSON.stringify(savedGroupIds), 'convId:', conversationId);
      // 存好了 → 回條（寄件者據此停止重送）。解不開、不是成員、簽章不對的都不回：寄件者照常重送幾次
      //   （名冊或金鑰還沒到齊時，晚一點的重送就收得下）
      ackGroupMessage(senderPubkey, messageId);

      // 通知 UI 更新
      window.dispatchEvent(new CustomEvent('aegis:group-message', {
        detail: { groupId, groupIds: savedGroupIds, senderId: senderPubkey },
      }));

      // 更新群組未讀數
      const groupStore = useGroupStore.getState();
      groupStore.incrementUnread(groupId);

      // 自癒：群組明文帶 senderName → 回填成員暱稱
      // （舊版建群不寫成員暱稱，UI 只能顯示 pubkey 切片亂碼；收到訊息即修復）
      if (parsed.senderName && typeof parsed.senderName === 'string') {
        groupStore.updateMemberNickname(groupId, senderPubkey, parsed.senderName);
      }
    } catch (err) {
      diagLog('[DIAG:GK] ❌ Error:', (err as Error)?.message || String(err));
    } finally {
      if (claimKey) groupMessagesInProgress.delete(claimKey);
    }
  }, [holdGroupMessage]);

  /** 引擎有變化（套上新的 commit、拿到一代金鑰、加入了）→ 重試這個群收著的群訊 */
  const retryPendingGroupMessages = useCallback(async (groupId: string) => {
    const list = pendingGroupMessagesRef.current.get(groupId);
    if (!list || list.length === 0) return;
    pendingGroupMessagesRef.current.delete(groupId);
    diagLog('[DIAG:GK] 🔁 Retrying', list.length, 'held group msg(s) for', groupId.slice(0, 8));
    for (const { senderPubkey, msg } of list) await handleGroupKeyMessage(senderPubkey, msg);
  }, [handleGroupKeyMessage]);
  const retryPendingGroupMessagesRef = useRef(retryPendingGroupMessages);
  retryPendingGroupMessagesRef.current = retryPendingGroupMessages;

  const handleSeedSync = useCallback((peerPublicKey: string, payload: unknown) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = payload as any;
      /**
       * 只跟這個群「現在的成員」（套上的鏈）交換群訊快取，結果只回給這條通道的對方（程式碼審查，成員變動輪換打開之後）：
       * 以前任何開得了 DataChannel 的人送 sync_accept（requesterId 還能填別人）就拿得到群訊快取 —— 被踢、離開的人
       * 也拿得到踢人之後的群訊。
       */
      const seedGroup = typeof msg?.groupId === 'string' ? useGroupStore.getState().getGroupById(msg.groupId) : undefined;
      if (!seedGroup || !seedGroup.members.some((m) => m.publicKey === peerPublicKey)
          || (seedGroup.departed ?? []).includes(peerPublicKey)) {
        diagLog('[DIAG:SEED] seed_sync from a non-member ignored:', peerPublicKey.slice(0, 16));
        return;
      }
      switch (msg.type) {
        case 'sync_request':
          seedSync.handleSyncRequest({ ...(msg as seedSync.SyncRequest), requesterId: peerPublicKey }, publicKey || '');
          break;
        case 'sync_offer':
          seedSync.handleSyncOffer(msg as seedSync.SyncOffer, publicKey || '');
          break;
        case 'sync_accept':
          // 加人不換金鑰：他加入之前的密文他也解得開 → 只給他加入（鏈上那筆 add）之後的（設計 B3）
          seedSync.transferMessages(msg.groupId, msg.lastMessageId, peerPublicKey,
            getGroupEngine()?.joinedAt(msg.groupId, peerPublicKey) ?? Number.MAX_SAFE_INTEGER);
          break;
        case 'sync_transfer':
          seedSync.handleSyncTransfer(msg as seedSync.SyncTransfer);
          break;
        default:
          devLog('[AppProvider] Unknown seed_sync type:', msg.type);
      }
    } catch (err) {
      console.error('[AppProvider] Seed sync error:', err);
    }
  }, [publicKey]);

  // WebRTC 訊息處理 — P2P 收到的 chat 訊息統一走 ENCRYPTED_MESSAGE handler
  const handleWebRTCMessage = useCallback((peerPublicKey: string, data: ArrayBuffer | string) => {
    devLog(`[AppProvider] WebRTC message from: ${peerPublicKey.slice(0, 8)}...`);
    if (typeof data !== 'string') {
      // ArrayBuffer = 大檔分塊 binary frame（LEARNINGS §1）
      void fileTransfer.handleChunkFrame(data, peerPublicKey);
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'encrypted_message' && parsed.payload) {
        diagLog('[DIAG:P2P:RECV] encrypted_message from:', peerPublicKey.slice(0, 16));
        const handler = processEncryptedMessageRef.current;
        if (handler) {
          handler(peerPublicKey, parsed.payload).catch((err) => {
            diagLog('[DIAG:P2P:RECV:ERROR]', (err as Error)?.message || String(err));
          });
        } else {
          // ⚠️ 不准靜默丟！frame 已透過 P2P 收到，只是 decrypt handler 還沒掛上（如 crypto 尚未 ready）。
          //   buffer 起來，等 handler ready 的 effect 會 drain。否則就是「收到卻沒解密」的單向收訊失敗。
          console.error('[AppProvider] P2P recv but decrypt handler not ready → buffering frame from', peerPublicKey.slice(0, 16));
          pendingInboundP2PRef.current.push({ peer: peerPublicKey, payload: parsed.payload });
        }
      } else if (parsed.type === 'group_key_message' && parsed.payload) {
        // ADR-016: Group Key 加密的群組訊息
        diagLog('[DIAG:P2P:RECV] group_key_message from:', peerPublicKey.slice(0, 16));
        handleGroupKeyMessage(peerPublicKey, parsed.payload).catch((err) => {
          diagLog('[DIAG:P2P:RECV:ERROR] group_key_message failed:', (err as Error)?.message || String(err));
        });
      } else if (parsed.type === 'group_msg_ack') {
        // 群組訊息的送達回條：要是這條通道的對方用他的身分金鑰簽的、回給我的（groupAck；簽章不對 → 什麼都不清，
        //   寄件人照樣重送）。只清「送給這個 peer、還在等」的等回條（見 ackGroupMessage）。不在等的 id 不碰資料庫、
        //   每個 peer 有額度（p2pSend.confirmDelivered，對應群星 b4fdce19）；確認到東西才記 log
        const me = currentSealer()?.me;
        const ids = me ? openGroupAck({ frame: parsed, from: peerPublicKey, to: me, verify: identityVerify }) : null;
        if (!ids) {
          diagLog('[DIAG:P2P:RECV] group_msg_ack with a bad or missing signature ignored from:', peerPublicKey.slice(0, 16));
          return;
        }
        const confirmed = confirmDelivered(peerPublicKey, ids);
        if (confirmed > 0) diagLog('[DIAG:P2P:RECV] group_msg_ack from:', peerPublicKey.slice(0, 16), 'confirmed:', confirmed);
      } else if (parsed.type === 'seed_sync' && parsed.payload) {
        // ADR-016: BT Seed 同步協議
        diagLog('[DIAG:P2P:RECV] seed_sync from:', peerPublicKey.slice(0, 16));
        handleSeedSync(peerPublicKey, parsed.payload);
      } else {
        devLog('[AppProvider] WebRTC message type:', parsed.type);
      }
    } catch (e) {
      devLog('[AppProvider] WebRTC: failed to parse data as JSON');
    }
  }, []);

  // WebRTC callbacks 用 useCallback 穩定引用，防止 useWebRTC effect 反覆 shutdown/reinit
  const onPeerConnected = useCallback((peerPublicKey: string) => {
    diagLog('[DIAG:P2P] Peer connected:', peerPublicKey.slice(0, 16));
    // P2P 連線建立 → flush 該 peer 的離線佇列
    import('../services/p2pSend').then(({ flushQueueForPeer }) => {
      flushQueueForPeer(peerPublicKey);
    });
    // 待送清單裡還沒送到的檔（對方離線時送的、App 重開前沒送完的、收端還沒 ack 的）：連上就補（對應群星 Codex #16）
    import('../services/fileTransfer').then(({ resumePendingChunks }) => {
      resumePendingChunks(peerPublicKey);
    }).catch(() => {});
    // ADR-016: 記錄建連成功（背壓機制）
    notifyConnectSuccess();
  }, []);

  const onPeerDisconnected = useCallback((peerPublicKey: string) => {
    devLog(`[AppProvider] Peer disconnected: ${peerPublicKey.slice(0, 8)}...`);
    // 同群組的非好友：通道關了 ＝ 當作他離線（W4：他的 presence 我看不到，「離線」從 P2P 的狀態推出來）
    memberPresence.closed(peerPublicKey);
  }, []);

  // WebRTC Hook - 需要 localPublicKey 參數
  const webrtc = useWebRTC(publicKey, {
    onMessage: handleWebRTCMessage,
    onPeerConnected,
    onPeerDisconnected,
  });

  // 註冊 P2P 發送函式（供 p2pSend.ts 使用）+ 啟動時重投遞持久化 outbox
  //   帶上帳號（publicKey）：換帳號時 p2pSend 作廢上一個帳號還在跑的工作（對應群星 owner／generation）。
  //   import 是非同步的：effect 已經清掉（換帳號、重跑）之後才回來的那次不能再註冊舊的 callback
  const outboxLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    import('../services/p2pSend').then(({ registerP2PFunctions, unregisterP2PFunctions, loadOutbox }) => {
      if (cancelled) return;
      registerP2PFunctions({
        // ⚠️ 用 live 的 isDataChannelOpen，不要用 useWebRTC hook 的 isConnectedTo。
        //   後者查 React state `peers` 的 connectionState（會 stale）+ 非 DataChannel 狀態 →
        //   DataChannel 其實 open、它卻回 false → 訊息誤進 outbox、又因通道已開沒新連線事件 → flush
        //   永不觸發 → 訊息卡死（真機「傳訊不通」真因）。isDataChannelOpen 跟 sendToPeer 的需求一致。
        isConnectedTo: (pk: string) => webrtcService.isDataChannelOpen(pk),
        sendToPeer: (pk: string, data: string) => webrtc.send(pk, data),
        connectPeer: async (pk: string) => {
          diagLog('[DIAG:P2P] connectPeer called for:', pk.slice(0, 16));
          await webrtc.connect(pk);
        },
        // 等回條的群訊若是在目前這條通道 open 之前送出的（送進了舊通道），重連一 flush 就重送
        channelOpenedAt: (pk: string) => webrtcService.channelOpenedAt(pk),
        // 好友＋同群成員（對應群星 6d381b43）：loadOutbox 只撥給認得的人、已經不同群的人不送群組的待送。
        //   名單還沒載入 → null（照舊）。名單是空的也當成還不知道：chatStore 重登後可能一時載到 0 筆（readiness race），
        //   那時說「不是好友」會讓 loadOutbox 不撥給有 1 對 1 待送的好友（程式碼審查 LOW）
        peerRelation: (pk: string) => {
          const chat = useChatStore.getState();
          const roster = useGroupStore.getState();
          if (!chat.isLoaded || !roster.isLoaded) return null;
          // 好友清單是空的 → 1 對 1 當成還不知道（重登後可能一時載到 0 筆）；群組清單是空的不算「不知道」
          //   （對應群星 5f497318）：沒有群是正常狀態（剛退出最後一個群），回 null 的話 flush 不擋群組待送 ——
          //   3 秒後的清除沒清到就送給已經不同群的人
          return {
            friend: chat.friends.length === 0 || !!chat.getFriendByPublicKey(pk),
            fellowMember: roster.groups.some((g) => g.members.some((m) => m.publicKey === pk)),
          };
        },
      }, publicKey ?? undefined);
      cleanup = unregisterP2PFunctions;
      // 死罪修正（§0.29）：跨 reload/重啟把仍待送的 outbox 重新觸發投遞。
      //   放在 registerP2PFunctions 之後 → 保證 _connectPeer 已就緒；ref 保證每個帳號只跑一次。
      if (publicKey && outboxLoadedRef.current !== publicKey) {
        outboxLoadedRef.current = publicKey;
        void loadOutbox();
      }
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [webrtc, publicKey]);

  // 大檔分塊傳輸 (LEARNINGS §1)：init/teardown + 收到完成後寫進 chatStore
  useEffect(() => {
    if (!publicKey || !cryptoReady) return;

    /**
     * 這個 effect 是哪一次 fileTransfer session（對應群星）：await（加密、掃描、存檔）回來時 effect 已經清掉
     * （登出、換帳號、encrypt 換了）或 fileTransfer 已經 shutdown → 舊 session 的 manifest／ack 不送、收到的檔不存
     */
    let cancelled = false;
    const session = fileTransfer.fileTransferSession();
    const active = () => !cancelled && session === fileTransfer.fileTransferSession();
    fileTransfer.initFileTransfer({
      sendChunk: (peer, frame) => webrtcService.send(peer, frame),
      sendManifest: async (peer, payload) => {
        if (!active()) return;
        const wrappedMessage = {
          id: payload.messageId,
          content: payload.caption ?? '',
          type: 'file_manifest',
          timestamp: payload.timestamp,
          fileManifest: payload,
        };
        const encrypted = await encrypt(peer, JSON.stringify(wrappedMessage));
        // RatchetMessage 是 WASM 物件，序列化完要 free（對應群星）；換帳號提早 return 也一樣要放掉
        try {
          if (!active()) return;
          const serialized = (encrypted as RatchetMessage).toJson();
          sendViaP2P(peer, JSON.stringify({ type: 'encrypted_message', payload: serialized }));
        } finally { encrypted.free(); }
      },
      getBufferedAmount: (peer) => webrtcService.getBufferedAmount(peer),
      isConnectedTo: (peer) => webrtcService.isDataChannelOpen(peer),
      // 一輪送檔綁在一條通道上：對方重開 App（新通道）時舊的一輪不再往新通道推、改從 manifest 重來（四機模擬 D1）
      channelEpoch: (peer) => webrtcService.channelEpoch(peer),
      connectPeer: async (peer) => { await webrtcService.connect(peer); },
      owner: publicKey,
      // 收端回 ack／busy（對應群星 B32）：跟 manifest 同一條 DR 加密通道，離線時一樣進 outbox
      sendControl: async (peer, payload) => {
        if (!active()) return;
        const encrypted = await encrypt(peer, JSON.stringify({
          id: `ctl-${payload.kind}-${payload.fileId}`, content: '', type: 'file_ctl', timestamp: Date.now(), fileCtl: payload,
        }));
        try {
          if (!active()) return;
          sendViaP2P(peer, JSON.stringify({ type: 'encrypted_message', payload: (encrypted as RatchetMessage).toJson() }));
        } finally { encrypted.free(); }
      },
    });

    const unsubReceived = fileTransfer.onFileReceived(async (rf) => {
      if (!active()) return;
      const friend = useChatStore.getState().getFriendByPublicKey(rf.fromPubkey);
      if (!friend) {
        devWarn('[AppProvider] File received from unknown peer:', rf.fromPubkey.slice(0, 8));
        return;
      }

      // Phase 20.6: 對收到的檔案做 L1+L2 內容掃描（分塊 P2P 路徑）。
      // 重組後的 blob 在 fileBlobStore（key=fileId），掃出高風險 → 附 riskResult，
      // ChatRoom 偵測到對方訊息的 riskResult 為 high/critical 即自動觸發紅盾。
      const riskResult: L2Result | undefined = await ext.antiFraud.inspectInbound({
        site: 'file-blob', sender: rf.fromPubkey, scoreKey: friend.publicKey, fileId: rf.fileId,
        file: { name: rf.name, mimeType: rf.mimeType, size: rf.size },
      });

      if (!active()) return;   // 掃描期間換了帳號／登出：不存進下一個 session
      // 群組檔案（chunked，manifest 帶 groupIds）：存成群組訊息（視圖群組），不進 1-1 視圖。
      // riskResult 持久化進 metadata → GroupChatWindow watch → report-risk → RiskMonitor 紅盾。
      if (rf.groupIds && rf.groupIds.length > 0) {
        // 只存進寄件人所屬的群（稽核 H8）：以前 manifest 的 groupIds 完全不檢查
        const viewGroupIds = viewGroupIdsToSave(rf.fromPubkey, undefined, rf.groupIds,
          (id) => useGroupStore.getState().getGroupById(id), rf.groupIds);
        if (viewGroupIds.length === 0) {
          console.error('[AppProvider] Group file from a non-member of every claimed group — ignored:', rf.fileId.slice(0, 8));
          return;
        }
        const groupId = viewGroupIds[0];
        await storageSaveMessage({
          id: rf.messageId,
          conversationId: getConversationIdForPeer(rf.fromPubkey),
          senderPubkey: rf.fromPubkey,
          content: rf.caption ?? '',
          type: 'file',
          createdAt: rf.timestamp,
          ttl: 0,
          expiresAt: null,
          readAt: null,
          isOutgoing: false,
          status: 'delivered',
          groupIds: viewGroupIds,
          metadata: JSON.stringify({
            fileData: {
              name: rf.name,
              mimeType: rf.mimeType,
              size: rf.size,
              caption: rf.caption,
              fileId: rf.fileId,
            },
            riskResult,
          }),
        }).catch((err) => console.error('[AppProvider] Failed to save group file message:', err));

        if (!active()) return;
        useGroupStore.getState().incrementUnread(groupId);
        window.dispatchEvent(new CustomEvent('aegis:group-message', {
          detail: { groupId, groupIds: viewGroupIds, senderId: rf.fromPubkey },
        }));
        devLog(`[AppProvider] Group file received: ${rf.name} (${rf.size}B) from ${friend.name}, group: ${groupId}`);
        return;
      }

      const newMessage = {
        id: rf.messageId,
        senderId: friend.id,
        content: rf.caption ?? '',
        timestamp: rf.timestamp,
        type: 'file' as const,
        isRead: false,
        isBurned: false,
        encrypted: true,
        riskResult,
        fileData: {
          name: rf.name,
          mimeType: rf.mimeType,
          size: rf.size,
          caption: rf.caption,
          fileId: rf.fileId,
        },
      };
      await useChatStore.getState().receiveMessage(friend.id, newMessage);
      devLog(`[AppProvider] File received: ${rf.name} (${rf.size}B) from ${friend.name}`);
    });

    return () => {
      cancelled = true;
      unsubReceived();
      void fileTransfer.shutdownFileTransfer();
    };
  }, [publicKey, cryptoReady, encrypt]);

  // 從 chatStore 取得方法
  const addFriend = useChatStore((state) => state.addFriend);
  const getFriendByPublicKey = useChatStore((state) => state.getFriendByPublicKey);
  const updateFriendProfile = useChatStore((state) => state.updateFriendProfile);
  const loadFromStorage = useChatStore((state) => state.loadFromStorage);
  const isLoaded = useChatStore((state) => state.isLoaded);

  // 從 groupStore 取得方法
  const loadGroupsFromStorage = useGroupStore((state) => state.loadFromStorage);
  const isGroupsLoaded = useGroupStore((state) => state.isLoaded);
  /**
   * 群組引擎的主題表（W3，groupEngine.topics）：每個群目前這一代的 tid ＋ 換金鑰後還在重疊期的上一代。null ＝ 引擎還沒載完
   * （第一張 MQTT token 等它，見 expectAclScope）。MQTT token 範圍與群組主題的訂閱都照它（gid 不上 broker）
   */
  const [groupTopics, setGroupTopics] = useState<GroupTopic[] | null>(null);
  /**
   * 好友之間的秘密 presence（W4，presenceService）：我的 tag 與好友確切的 presence 主題。null ＝ 服務還沒起來
   * （第一張 MQTT token 等它）。token 不再帶任何公鑰清單（peers）；同群組但不是好友的人不在這裡（看 here 與 P2P）
   */
  const [presenceScope, setPresenceScope] = useState<PresenceScope | null>(null);
  const presenceRef = useRef<PresenceService | null>(null);
  /** 同群成員剛連上（here）→ 連上他、送給他的待送（下面「名冊多了人」的 effect 設） */
  const reachPeerRef = useRef<(pk: string) => void>(() => {});

  // i18n 語言設定
  const loadLanguageFromStorage = useLanguageStore((state) => state.loadFromStorage);

  // 字體大小設定
  const loadFontScaleFromStorage = useFontScaleStore((state) => state.loadFromStorage);

  // AegisGuard 設定（官方版的網路防護；社群版沒有）
  const loadAegisGuardFromStorage = useCallback(() => { ext.vpn?.loadSettings(); }, []);

  // 持久化 publicKey 為明文（E2E／診斷讀它；AuthScreen 的 MQTT 預連線已拿掉 —— token 要解鎖後的簽章）。
  // publicKey 本來就是公開值（friend code、X3DH bundle 都含它），明文存無安全顧慮。
  useEffect(() => {
    if (publicKey) {
      // key 名故意避開 mist_public_key（test 把它當作 SHA256 hash query trust score，會撞號）
      try { localStorage.setItem('mist_pubkey_raw', publicKey); } catch { /* */ }
    }
  }, [publicKey]);

  // 帳號恢復後重建 X3DH session — account-found 恢復只還原 contacts，沒有 ratchet
  // session。對每個有 prekey bundle 但無 session 的好友重新做 X3DH（送 X3DH_INIT），
  // 讓恢復的好友免重加就能聊。由 aegis_session_repair_needed flag 觸發，跑一次。
  const sessionRepairRunningRef = useRef(false);
  const repairMissingSessions = useCallback(async () => {
    if (sessionRepairRunningRef.current) return;
    sessionRepairRunningRef.current = true;
    try {
      const friends = useChatStore.getState().friends;
      let repaired = 0;
      let requested = 0;
      for (const f of friends) {
        try {
          // ⚠️ 唯一發起者 tiebreak（2026-08-19，docs/CRYPTO_X3DH_GLARE_20260819.md）：
          //   兩台**同時**恢復時，兩邊都無條件發起 X3DH → 收端各自 forceReset 丟掉自己的 initiator
          //   → 兩邊都是 Bob、沒有人是 Alice → session 互相對不上 → 每則訊息 aead、永遠送不到。
          //   修法＝只有 **pubkey 較大方**發起；較小方改送 PREKEY_REQUEST 請較大方發起。
          //   方向對齊收端備援 tiebreak（acceptSession 的 glareKeepMine 也是 lex-larger 贏）。
          if (recentlyInitiatedTo(f.publicKey)) {
            // 30s 內已對這人建過新 Alice + 送過 INIT（例如剛回應過對方的 PREKEY_REQUEST）→
            //   那份就是最新的，不要再打掉重建（重建會作廢在途的 INIT）。
            console.error('[SessionRepair] recently initiated → skip', f.publicKey.slice(0, 16));
            continue;
          }
          if (f.signedPreKey && f.signature && publicKey && publicKey > f.publicKey) {
            // 我方持有對方 prekey bundle 且我方 pubkey 較大 → 由我方(重新)發起 X3DH。
            // 🔑 L691 修復：恢復後本機既有 ratchet 必為 stale → 先清掉。否則 createSession 的
            //   idempotency 會 reuse 舊 root key、只換新 ephemeral → 收端依新 ephemeral replace 成
            //   新 ratchet，我方卻停在舊 root key → 兩邊永遠對不上 → aead。清掉才走 fresh path
            //   （新 ratchet ⊕ 新 ephemeral 一致 → 收端 replace 後對齊）。
            await clearPeerSession(f.publicKey);        // 清 active in-memory + mist_sessions
            await deleteRatchetState(f.publicKey);      // 清 legacy ratchet_states（若舊版殘留）
            const { ephemeralPublicKey } = createSession(
              fromBase64(f.publicKey),
              fromBase64(f.signedPreKey),
              fromBase64(f.signature),
              undefined,
              undefined,
              true, // forceFresh：repair 送 sessionReset → 發起方也建全新 Alice，與新 ephemeral 同源
            );
            await flushSessionWrites(); // 等 initiator session 落 DB 再送 X3DH_INIT（同 QR add，避免我方 DB 未穩的 race）
            // 不帶名字（開源第 4 步：名字只走封好的個人資料／via）
            // 帶我身分金鑰的簽章（開源第 5b 步，x3dhInitAuth）：對方是我的好友，沒有簽章的 INIT 他一律不收
            mqttService.sendToUser(f.publicKey, MessageType.X3DH_INIT, withInitAuth(f.publicKey, {
              ephemeralPublicKey: toBase64(ephemeralPublicKey),
              signedPreKey: signedPreKey?.publicKeyBase64,
              signature: signedPreKey?.signatureBase64,
              sessionReset: true,
              // ⚠️ 標明「這是自動 SessionRepair 送的」。收端只對它套 glare tiebreak ——
              //   QR 重加是使用者當面掃的，必須永遠贏（見 useCrypto 的 acceptSession）。
              repair: true,
              // 標明我用的是對方哪把 SPK —— 收端發現是舊的會拒收並回新 bundle（stale-SPK 防線）
              recipientSpk: f.signedPreKey,
            }));
            repaired++;
            console.error('[SessionRepair] Rebuilt X3DH session for', f.publicKey.slice(0, 16));
          } else {
            // 兩種情況都改請**對方**發起（對方的 PREKEY_REQUEST handler 會 clearPeerSession +
            // createSession + 回 X3DH_INIT(reset) 完成對齊）：
            //   a) 我方 pubkey 較小（glare tiebreak 的讓步方，見上）——就算我有 bundle 也不發起；
            //   b) 🔑 L688：此 contact 由「收 X3DH_INIT 反向加入」建立 → 沒存對方 bundle → 發不了。
            // 附上我方 bundle：對方若沒存過我的 prekey（同為 L688 反向加入的舊 contact），
            //   拿這份就能發起（簽章在對方 createSession 內會驗，偽造 bundle 過不了）。
            //   舊版 payload 是 {} → 對方沒 bundle 就 cannot re-initiate 死局，這裡順帶治好。
            //   封給對方的身分金鑰（DIRECT_SEALED kind prekey）
            await sendPrekeyRequest(f.publicKey, signedPreKey
              ? { signedPreKey: signedPreKey.publicKeyBase64, signature: signedPreKey.signatureBase64 } : null);
            requested++;
            console.error('[SessionRepair]', f.signedPreKey ? 'lex-smaller (yield)' : 'no local bundle',
              'for', f.publicKey.slice(0, 16), '→ PREKEY_REQUEST');
          }
        } catch (err) {
          console.error('[SessionRepair] Failed for', f.publicKey.slice(0, 16), err);
        }
      }
      console.error(`[SessionRepair] Done — rebuilt ${repaired}, requested ${requested}`);
      localStorage.removeItem('aegis_session_repair_needed');
    } catch (err) {
      console.error('[SessionRepair] error:', err);
    } finally {
      sessionRepairRunningRef.current = false;
    }
  }, [createSession, signedPreKey, publicKey, recentlyInitiatedTo]);

  // 好友／群組（與群組引擎的主題表）還沒從本機載入 → 第一張 MQTT token 等它們設好範圍再拿（mqtt.expectAclScope，最多 3 秒），
  //   免得先拿一張沒有群組／presence 權限的、連上後又斷線換 token。要在下面「連 MQTT」的 effect 之前跑
  const groupTopicsReady = groupTopics !== null;
  const presenceScopeReady = presenceScope !== null;
  useEffect(() => {
    if (publicKey && !keysLocked && !(isLoaded && isGroupsLoaded && groupTopicsReady && presenceScopeReady)) mqttService.expectAclScope();
  }, [publicKey, keysLocked, isLoaded, isGroupsLoaded, groupTopicsReady, presenceScopeReady]);

  // 初始化流程
  const initCompletedRef = useRef(false);
  const lastPostInitRef = useRef(0);
  useEffect(() => {
    const init = async () => {
      try {
        // 初始化已完成 → 只做反應式任務（MQTT 重連等）
        if (initCompletedRef.current) {
          // Post-init throttle：1 秒內不重複執行
          const now = Date.now();
          if (now - lastPostInitRef.current < 1000) {
            return;
          }
          lastPostInitRef.current = now;
          console.error('[AppProvider] Post-init: pk=', !!publicKey, 'connected=', mqtt.isConnected, 'locked=', keysLocked);
          if (publicKey && !mqtt.isConnected && !keysLocked) {
            console.error('[AppProvider] Post-init: Connecting to MQTT...');
            await mqtt.connect();
            console.log('[AppProvider] Post-init: MQTT connect returned, isConnected=', mqtt.isConnected);
          }
          if (publicKey && mqtt.isConnected) {
            if (!voiceCallService.localPublicKey) {
              console.error('[AppProvider] Post-init: VoiceCall initializing...');
            }
            voiceCallService.initialize(publicKey);
            // 帳號恢復後 — MQTT 一連上就重建好友的 X3DH session（免重加）
            if (localStorage.getItem('aegis_session_repair_needed') === '1') {
              console.error('[AppProvider] Post-init: session repair needed → rebuilding X3DH sessions');
              void repairMissingSessions();
            }
          }
          // MQTT 仍未連線 → 嘗試重連
          if (publicKey && !mqtt.isConnected && !keysLocked) {
            console.error('[AppProvider] Post-init: MQTT still disconnected, retrying...');
            await mqtt.connect();
            if (mqtt.isConnected) {
              voiceCallService.initialize(publicKey);
              console.error('[AppProvider] Post-init: MQTT reconnected + VoiceCall initialized');
            }
          }
          // E2E testing: update status on every post-init cycle
          if (typeof window !== 'undefined') {
            (window as any).__AEGIS_STATUS__ = {
              mqttConnected: mqtt.isConnected,
              hasPublicKey: !!publicKey,
              keysLocked,
              initCompleted: true,
            };
          }
          return;
        }

        // 首次初始化 — 不重複設定 isInitializing（useState 預設已是 true）
        setError(null);

        // 初始化本地儲存
        if (!isStorageInitialized()) {
          devLog('[DIAG] AppProvider: initStorage...');
          devLog('[AppProvider] Initializing storage...');
          await initStorage();
          startCleanupTask(); // 啟動過期訊息清理任務
          devLog('[DIAG] AppProvider: storage initialized OK');
          devLog('[AppProvider] Storage initialized');
        } else {
          devLog('[DIAG] AppProvider: storage already initialized');
          devLog('[AppProvider] Storage already initialized');
        }
        // 無論是新初始化還是已存在，都設為 ready
        setStorageReady(true);

        // iOS localStorage healing — iOS Safari/WKWebView 會在 process 終止後清空 localStorage
        // 必須在 crypto 判斷之前完成，否則 useCrypto 會因為找不到 keys 而生成新身份
        {
          const healKeys = ['mist_keys', 'mist_pin_hash', 'mist_pin_salt', 'aegis_key_salt', 'mist_session_version', 'mist_wasm_core_version', 'aegis_face_bone_ratio', 'aegis_face_embedding'];
          let healCount = 0;
          for (const key of healKeys) {
            if (!localStorage.getItem(key)) {
              try {
                const val = await dbGetSetting(key);
                if (val) {
                  localStorage.setItem(key, val);
                  healCount++;
                }
              } catch { /* SQLite not ready yet — skip */ }
            }
          }
          if (healCount > 0) {
            console.error(`[AppProvider] Healed ${healCount} localStorage keys from SQLite: iOS recovery`);
          }
        }

        // Phase 26b: 臉部辨識模型預載入（non-blocking，只執行一次；iOS 跳過，見 main.tsx；官方版 AegisID，社群版沒有）
        ext.identity.preloadModels();

        // Phase 7: 請求持久化儲存權限（防止瀏覽器自動清除）
        try {
          const isPersisted = await autoRequestPersistence({ force: false });
          if (isPersisted) {
            devLog('[AppProvider] ✅ Storage persistence granted - data is protected');
          } else {
            devWarn('[AppProvider] ⚠️ Storage persistence denied - data may be cleared by browser');
          }
        } catch (error) {
          console.error('[AppProvider] Failed to request persistence:', error);
        }

        // 等待 Crypto 初始化
        devLog(`[DIAG] AppProvider: cryptoReady=${cryptoReady}, cryptoLoading=${cryptoLoading}, cryptoError=${cryptoError}, hasIdentity=${hasIdentity}, keysLocked=${keysLocked}`);
        if (!cryptoReady) {
          if (cryptoError) {
            // Crypto WASM 載入失敗 — 不要永遠轉圈，顯示錯誤
            const msg = cryptoError instanceof Error ? cryptoError.message : String(cryptoError);
            devLog('[DIAG] AppProvider: Crypto init FAILED:', msg);
            console.error('[AppProvider] Crypto init failed:', msg);
            setError(`加密模組初始化失敗: ${msg}`);
            setIsInitializing(false);
            return;
          }
          if (!cryptoLoading) {
            // 未載入中也未成功 — 異常狀態，停止等待
            devLog('[DIAG] AppProvider: Crypto not ready and not loading — ABORTING');
            console.error('[AppProvider] Crypto not ready and not loading — aborting wait');
            setError('加密模組初始化異常');
            setIsInitializing(false);
            return;
          }
          devLog('[DIAG] AppProvider: Crypto still loading, waiting...');
          return; // 仍在載入中 — 等待 useCrypto 自動初始化
        }

        // 如果沒有身份，自動產生（但 keysLocked 時不產生 — 等待 PIN 解鎖）
        // CRITICAL: 必須有 encKey（PIN 已 derive）才能產，否則 saveKeys 會用
        // ephemeral key 加密 → session 一斷就無法解 → 跨 boot 殘留壞掉的 mist_keys
        // → 下次 migration 砍掉 → Post-init 不會補生 → 卡名字頁。
        // 改由 AuthScreen.handleConfirmComplete 在 setEncryptionKey 之後顯式呼叫。
        if (!hasIdentity && !keysLocked && getEncryptionKey() !== null) {
          // ★恢復/註冊流程 deferred guard★：刷臉 1:N + PIN 判定「新帳號 vs 找到帳號」之前，
          //   不要自動補產身份（會產丟棄身份、MQTT latch 它 → account-found 還原後傳輸卡死，Test 35c 實證）。
          //   AuthScreen.pinSetupWork 會設此 flag；確定新帳號(handleNameSubmit)或還原(account-found)後清除。
          //   deferred 時直接 return（不產身份、也不連 MQTT）→ 等判定完身份就緒，effect 因 hasIdentity 變化重跑再連。
          if (localStorage.getItem('aegis_identity_deferred') === '1') {
            console.error('[AppProvider] generateIdentity() DEFERRED — awaiting face/account determination');
            return;
          }
          console.error('[AppProvider] generateIdentity() CALLED (hasIdentity=false, keysLocked=false, encKey present)');
          generateIdentity();
          return; // 等待身份產生後重新進入（initCompletedRef 尚未設為 true）
        }
        if (!hasIdentity && !keysLocked) {
          console.error('[AppProvider] generateIdentity() SKIPPED — encKey not ready (waiting for PIN setup)');
        }

        // 連線 MQTT — 只在 keysLocked=false 時才連線
        // keysLocked=true 表示 PIN 尚未驗證，pubkeyHash 可能未註冊 VPS → 避免 403
        console.error('[AppProvider] Init MQTT check: pk=', !!publicKey, 'connected=', mqtt.isConnected, 'locked=', keysLocked);
        if (publicKey && !mqtt.isConnected && !keysLocked) {
          console.error('[AppProvider] Init: Connecting to MQTT...');
          await mqtt.connect();
          console.error('[AppProvider] Init: MQTT connect returned, isConnected=', mqtt.isConnected);

          // MQTT connect 可能因 pin_hash 未就緒而靜默失敗
          // 設定延遲重試（5 秒後再試一次，確保 pin_hash 已寫入）
          if (!mqttService.isConnected()) {
            console.error('[AppProvider] Init: MQTT failed, scheduling retry in 5s...');
            setTimeout(async () => {
              if (!mqttService.isConnected() && publicKey) {
                console.error('[AppProvider] Init retry: Connecting to MQTT...');
                await mqtt.connect();
                console.error('[AppProvider] Init retry: isConnected=', mqtt.isConnected);
                if (mqtt.isConnected) {
                  voiceCallService.initialize(publicKey);
                  console.error('[AppProvider] Init retry: VoiceCall initialized');
                }
              }
            }, 5000);
          }
        }

        // 初始化語音通話服務
        // 注意：mqtt.isConnected 是 React state（async 更新），await connect() 返回後可能仍 false
        // 用 mqttService.isConnected()（底層真實狀態）來判斷
        const mqttReallyConnected = mqtt.isConnected || mqttService.isConnected();
        console.error('[AppProvider] VoiceCall check: pk=', !!publicKey, 'reactConn=', mqtt.isConnected, 'realConn=', mqttService.isConnected(), 'combined=', mqttReallyConnected);
        if (publicKey && mqttReallyConnected) {
          console.error('[AppProvider] Initializing voice call service...');
          voiceCallService.initialize(publicKey);
        } else {
          console.error('[AppProvider] ⚠️ VoiceCall NOT initialized: pk=', !!publicKey, 'mqttReally=', mqttReallyConnected);
        }

        // 注意：Aegis WASM 和語音模型在進入聊天模式後才載入
        // 避免在註冊/登入畫面造成卡頓

        setIsInitializing(false);
        initCompletedRef.current = true;
        markAppInitCompleted();
        devLog('[DIAG] AppProvider: Initialization COMPLETE');
        devLog('[AppProvider] Initialization complete');

        // E2E testing: expose app status on window
        if (typeof window !== 'undefined') {
          (window as any).__AEGIS_STATUS__ = {
            mqttConnected: mqtt.isConnected || mqttService.isConnected(),
            hasPublicKey: !!publicKey,
            keysLocked,
            initCompleted: true,
            voiceCallReady: !!voiceCallService.localPublicKey,
          };
        }

        // Phase 35c: cloudBackup 已移除，社交圖譜備份改由 aegisIdBlob 處理
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Initialization failed';
        setError(errorMsg);
        setIsInitializing(false);
        console.error('[AppProvider] Init error:', err);
      }
    };

    init();

    // 清理函數：停止自動同步
    return () => {
      ext.antiFraud.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cryptoReady, cryptoLoading, cryptoError, hasIdentity, publicKey, mqtt.isConnected, generateIdentity, keysLocked]);

  // PWA 從背景恢復時通知 Health Monitor + 重新載入資料
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isForeground = document.visibilityState === 'visible';
      // 通知 Health Monitor（前景→立即 probe，背景→慢速間隔）
      mqttHealthMonitor.onVisibilityChange(isForeground);
      peerHealthMonitor.onVisibilityChange(isForeground);

      if (isForeground) {
        devLog(`[DIAG] AppProvider: visibilitychange=visible, storageReady=${storageReady}, publicKey=${!!publicKey}, initCompleted=${initCompletedRef.current}`);

        // localStorage 自動恢復：iOS Safari 背景→前景時可能清除 localStorage
        if (storageReady) {
          (async () => {
            try {
              const healKeys = ['mist_keys', 'mist_pin_hash', 'mist_pin_salt', 'aegis_key_salt', 'aegis_face_bone_ratio', 'aegis_face_embedding'];
              let healCount = 0;
              for (const key of healKeys) {
                if (!localStorage.getItem(key)) {
                  const val = await dbGetSetting(key);
                  if (val) { localStorage.setItem(key, val); healCount++; }
                }
              }
              if (healCount > 0) console.error(`[AppProvider] Healed ${healCount} keys on resume`);
            } catch { /* non-critical */ }
          })();

          devLog('[DIAG] AppProvider: Reloading data from storage after resume...');
          loadFromStorage();
          loadAegisGuardFromStorage();
          if (publicKey) {
            loadGroupsFromStorage(publicKey);
          }
          devLog('[DIAG] AppProvider: Store reload triggered');
          // 排程付款前景補跑（SCHEDULER_PLAN Phase A）：掃我發起、已到期、仍 scheduled 的排程，
          // 逐一用 K_sched 執行（查餘額→足夠才上鏈）→ 回報 VPS。Phase B 由 VPN extension 到期觸發。
          if (publicKey) {
            ext.payments?.onResume(publicKey);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [publicKey, storageReady, loadFromStorage, loadGroupsFromStorage, loadAegisGuardFromStorage]);

  // MQTT Health Monitor + Network Monitor — 一次性啟動（不隨 mqtt.isConnected 反覆重啟）
  // HealthMonitor 內部已處理 MQTT 斷線/重連，不需要外部 Start/Stop 循環
  const healthMonitorStartedRef = useRef(false);
  const networkUnsubRef = useRef<(() => void) | null>(null);
  // presence 認為 online 的好友集合 + 即時 publicKey,給 peerHealthMonitor watchdog 用。
  // 用 ref 讓 watchdog 的 deps closure(start 時只捕捉一次)每拍都讀到最新值。
  const onlinePeersRef = useRef<Set<string>>(new Set());
  const publicKeyRef = useRef<string | null>(null);
  publicKeyRef.current = publicKey;

  useEffect(() => {
    // 啟動條件 = 有身份（publicKey），不是「已連上 MQTT」。
    // 舊 gate（mqtt.isConnected）有 bootstrap 死鎖：首連在 CONNECTED→立刻被踢
    //（殭屍 client session takeover）時，React 把 true→false 批次成一次 render，
    // hook 永遠沒看到 true → HealthMonitor 從未啟動 → mqtt.js 重連又停用 →
    // 永久離線（2026-06-12 E2E run4 實證：服務層 CONNECTED 事件有發、
    // __AEGIS_STATUS__ 恆 false、全程 0 條 HealthMonitor log）。
    // monitor._probe 自帶守門（無 publicKey / 無 pinHash / token cooldown 皆 no-op），提早啟動安全。
    if (!publicKey || healthMonitorStartedRef.current) return;
    healthMonitorStartedRef.current = true;

    mqttHealthMonitor.start();
    // P2P watchdog — 第二層,gate 在 MQTT 上。補掉「presence 重連只在上線邊緣觸發一次、
    // 卡 connecting 後永遠不自救」的洞(LEARNINGS_FROM_AEGISTRANS.md §7 真因 B)。
    peerHealthMonitor.start({
      getOnlineKnownPeers: () => {
        // 好友＋同群組的成員（群訊逐人走 P2P，成員不一定是好友；以前只看好友 → 非好友成員的連線卡住沒人修，
        //   對應群星 64f3d211，多人模擬 S3）
        const known = knownPeerKeys(useChatStore.getState().friends.map((f) => f.publicKey),
          useGroupStore.getState().groups, publicKeyRef.current);
        // presence-online ∪ 連線 failed 的（LEARNINGS §11.2）：連線進終端 failed、presence 又一起 stale
        //   回報 offline 時，光看 presence 這個 peer 永遠不進檢查清單 → 不自救。failed 是直接證據，據此重連。
        //   W4：presence 只有好友才有；同群組的非好友看他最近的 here（memberPresence：通道關了就不算）
        return known.filter((pk) => onlinePeersRef.current.has(pk) || memberPresence.recentlySeen(pk) || webrtcService.isPeerFailed(pk));
      },
      isPeerHealthy: (pk) => webrtcService.isDataChannelOpen(pk),
      isPeerZombie: (pk) => webrtcService.isPeerZombie(pk),   // 殭屍免寬限（§13，watchdog 當拍即重連）
      reconnectPeer: (pk) => {
        // 🔑 根因修復：絕不再無條件 disconnect(=closePeer 拆 PC)。舊版雙方每個 health tick 都拆掉
        //   PeerConnection → 互相摧毀對方剛建好的連線 → DataChannel 開了又關、PC 世代錯位、
        //   stale answer 被 IGNORE → 永不收斂（本「加好友後傳不了訊息」bug 的真因）。
        //   改：只有 initiator(pubkey 字典序較大)呼叫 connect()——connect() 內部對「PC 活著但 DC 沒開」
        //   走同一條 PC 原地 renegotiation 重開 channel(不拆 PC)、只有真死(failed/closed)才 closePeer 重建。
        //   answerer 端完全不動,等 initiator 的 (re-)offer(handleOffer PerfectNeg 同連線回 answer)。
        //   ⚠️ 殭屍破例（LEARNINGS §13 步驟 4，最容易漏的一步）：
        //   單向死亡時，**只有收不到的那一側**偵測得到殭屍。它若剛好是等待側（pubkey 較小），
        //   就會永遠等一個「永遠不會來」的 re-offer —— 因為對端那側看起來一切正常，不會重連。
        //   → 殭屍時等待側必須破例自己發起。不會 livelock：重建成功 → inbound 恢復 → 不再 stale
        //     → 觸發條件自己消失。（tiebreak 的原意是「別拆還活著的 PC」；殭屍沒有東西可保護。）
        const isZombie = webrtcService.isPeerZombie(pk);
        const willInitiate = (!!publicKeyRef.current && publicKeyRef.current > pk) || isZombie;
        diagLog('[DIAG:PeerHealth] reconnectPeer:', pk.slice(0, 8), `willReoffer=${willInitiate} zombie=${isZombie}`, webrtcService.describePeer(pk));
        if (willInitiate) {
          void webrtcService.connect(pk).catch((err) =>
            devLog('[PeerHealth] reconnect failed:', pk.slice(0, 8), err));
        } else {
          devLog('[PeerHealth] answerer waits for initiator (re-)offer:', pk.slice(0, 8));
        }
      },
    });
    networkMonitor.start().catch(err =>
      console.error('[AppProvider] NetworkMonitor start failed:', err)
    );
    networkUnsubRef.current = networkMonitor.onChange((isOnline) => {
      mqttHealthMonitor.onNetworkChange(isOnline);
      peerHealthMonitor.onNetworkChange(isOnline);
    });
  }, [publicKey]);

  // MQTT(重)連上 → P2P 很可能也跟著死了,立即補一次 watchdog 檢查(內部仍 gate 在 isConnected)
  useEffect(() => {
    if (mqtt.isConnected) peerHealthMonitor.probeNow();
  }, [mqtt.isConnected]);

  // 元件卸載時才停止（不在 mqtt.isConnected 變化時停止）
  useEffect(() => {
    return () => {
      mqttHealthMonitor.stop();
      peerHealthMonitor.stop();
      networkMonitor.stop();
      networkUnsubRef.current?.();
      healthMonitorStartedRef.current = false;
    };
  }, []);

  // #6 優雅關閉：App 進背景 / 頁面卸載時主動宣告離線，避免好友看到殘留 online。
  // (LEARNINGS_FROM_AEGISTRANS.md §6;與 AegisTrans 差異:gracefulShutdown 保留 publicKeyBase64,
  //  因 AegisTrans 只在 Electron quit 呼叫、會清 key,而手機 pause/resume 是週期需要重連。)
  // 觸發來源刻意分平台:
  //   原生 App → appStateChange(isActive=false) 才算進背景(tab 切換不算);
  //   Web      → 只在真正卸載/進 bfcache(pagehide) 才宣告離線(桌面切 tab 不該斷線)。
  useEffect(() => {
    let removeNative: (() => void) | null = null;

    const goOffline = () => {
      // 先 suspend HealthMonitor,否則背景 probe 會立刻 forceReconnect 把 online 又宣告回去
      mqttHealthMonitor.suspend();
      void mqttService.gracefulShutdown(500);
    };
    const flushDbOnHide = () => {
      import('../services/database').then(({ flushToStore }) => flushToStore()).catch(() => {});
    };

    const goOnline = () => {
      // resume:解除 suspend + 立即 probe → 偵測 client 已銷毀 → forceReconnect(用保留的 key)
      // 重連完成後 subscribeToDefaultTopics() 會自動 publishPresence(true)
      mqttHealthMonitor.onVisibilityChange(true);
      peerHealthMonitor.onVisibilityChange(true);
    };

    if (isNativeApp()) {
      (async () => {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) goOnline();
          else goOffline();
        });
        removeNative = () => { void sub.remove(); };
      })().catch((err) => console.error('[AppProvider] appStateChange wire failed:', err));
    } else {
      window.addEventListener('pagehide', goOffline);
      window.addEventListener('pageshow', goOnline);
      // 去抖化持久化（database.ts）後，非 force 寫入不再逐筆落地 → 換頁/reload 前補一次 force flush
      //   把在途去抖的寫入落地（不封印：pagehide 可能只是進 bfcache 又回來）。E2E 的 raw reload 也靠這條。
      window.addEventListener('pagehide', flushDbOnHide);
    }

    return () => {
      removeNative?.();
      window.removeEventListener('pagehide', goOffline);
      window.removeEventListener('pageshow', goOnline);
      window.removeEventListener('pagehide', flushDbOnHide);
    };
  }, []);

  // Storage 初始化完成 + 金鑰解鎖後，載入好友和訊息資料
  // 必須等 keysLocked=false：否則 pk=null 時查 SQLite → 0 筆 → isLoaded=true → 之後不會重查
  useEffect(() => {
    if (storageReady && !isLoaded && !keysLocked) {
      console.error('[AppProvider] Loading contacts from storage (keys unlocked)...');
      loadFromStorage();
      loadLanguageFromStorage();
      loadFontScaleFromStorage();
      loadAegisGuardFromStorage();
    }
  }, [storageReady, isLoaded, keysLocked, loadFromStorage, loadLanguageFromStorage, loadFontScaleFromStorage, loadAegisGuardFromStorage]);

  // Storage 初始化完成後，載入群組資料
  useEffect(() => {
    if (storageReady && !isGroupsLoaded && publicKey) {
      devLog('[AppProvider] Loading groups from storage...');
      loadGroupsFromStorage(publicKey);
    }
  }, [storageReady, isGroupsLoaded, publicKey, loadGroupsFromStorage]);

  // 安全網：群組載入完成但為空時，延遲重新載入
  // 修復冷啟動（尤其從通知啟動）時 SQLite 尚未就緒導致群組暫時消失
  const groupRetryRef = useRef(0);
  useEffect(() => {
    if (!isGroupsLoaded || !publicKey || !storageReady) return;

    const currentGroups = useGroupStore.getState().groups;
    if (currentGroups.length > 0) {
      groupRetryRef.current = 0;
      return;
    }

    // 群組為空但可能是 SQLite 延遲，最多重試 3 次
    if (groupRetryRef.current >= 3) return;

    const delay = 1500 * (groupRetryRef.current + 1);
    devLog('[AppProvider] Groups empty after load, scheduling retry in', delay, 'ms (attempt', groupRetryRef.current + 1, ')');

    const timer = setTimeout(() => {
      groupRetryRef.current++;
      devLog('[AppProvider] Retrying group load...');
      // 重置 isLoaded 讓主效果重新觸發
      useGroupStore.setState({ isLoaded: false });
    }, delay);

    return () => clearTimeout(timer);
  }, [isGroupsLoaded, publicKey, storageReady]);

  // 進入聊天模式後，載入重型資源（Aegis WASM、規則同步、語音模型）
  // 這樣可以避免在註冊/登入畫面造成卡頓
  useEffect(() => {
    if (!isInChatMode) return;

    // 防詐（規則引擎、規則同步、語音辨識）是官方版的功能；社群版什麼都不載
    void ext.antiFraud.start();

    return () => {
      ext.antiFraud.stop();
    };
  }, [isInChatMode]);

  // 從 chatStore 取得 receiveMessage 方法
  const receiveMessage = useChatStore((state) => state.receiveMessage);

  // 監聽 X3DH_INIT 訊息 - 接收端建立 session
  useEffect(() => {
    if (!mqtt.isConnected || !cryptoReady) {
      console.error(`[AppProvider:DIAG] X3DH effect SKIP — isConnected=${mqtt.isConnected} cryptoReady=${cryptoReady}`);
      return;
    }
    console.error(`[AppProvider:DIAG] X3DH effect run — subscribe`);

    const unsubscribe = mqtt.subscribe(MessageType.X3DH_INIT, async (message: MqttMessage) => {
      try {
        const senderPublicKeyBase64 = message.from;
        const payload = message.payload as {
          ephemeralPublicKey: string;
          signedPreKey?: string;
          signature?: string;
          sessionReset?: boolean; // 帳號恢復 SessionRepair 重發時帶此旗標 → 收端覆蓋舊 ratchet
          repair?: boolean;       // 來源是自動 SessionRepair（非 QR 重加）→ 收端套 glare tiebreak
          /** 發起方建 X3DH 時用的「收方 SPK」。收端比對自己現在的 SPK —— 不一致＝對方用舊 bundle
           *  建的、註定 aead → 拒收並回附 bundle 的 PREKEY_REQUEST 請對方重建（2026-08-19 byte 實證：
           *  blob 恢復回來的 contact bundle 可能是陳年舊版）。舊版不送此欄位 → 不檢查（向後相容）。 */
          recipientSpk?: string;
          /** 對方是透過我發出的什麼東西加我的（短碼／QR nonce）＋他的名字 —— 封給我的身分金鑰，見 services/friendInvites */
          via?: unknown;
          /** 寄件人身分金鑰的簽章（開源第 5b 步，services/x3dhInitAuth.ts）：既有好友的 INIT 一定要有 */
          auth?: unknown;
        };

        // 不印對方自取的名字：還沒確認是好友或對得上邀請前，payload 一律不進 log
        console.log('[AppProvider] X3DH_INIT received from pk:', senderPublicKeyBase64?.slice(0, 16));

        // ephemeral 公鑰先確認是 32 bytes 再做別的（審查 L2）：以前陌生人分支先加好友，到 acceptSession 才因為壞掉的
        //   ephemeral 丟例外 —— 留下一個沒有 session 的好友（傳訊息都送不到）
        let senderEphemeralPublic: Uint8Array | null = null;
        try {
          senderEphemeralPublic = typeof payload.ephemeralPublicKey === 'string' ? fromBase64(payload.ephemeralPublicKey) : null;
        } catch {
          senderEphemeralPublic = null;
        }
        if (!senderEphemeralPublic || senderEphemeralPublic.length !== 32) {
          console.error('[DIAG:X3DH:RX] INIT 的 ephemeral 公鑰不是 32 bytes → 拒收', senderPublicKeyBase64?.slice(0, 12));
          return;
        }

        // 檢查是否已經是好友（已有 session）。冷啟動時好友清單可能還沒載入 → 先等清單、再查 contacts 表
        //   （findFriendSettled，部署前審查 HIGH）：以前好友重送／修復的 INIT 在這段時間走陌生人分支，
        //   把已驗證的好友覆寫成未驗證
        const existingFriend = await findFriendSettled(senderPublicKeyBase64);
        const senderPreKeyBundle = payload.signedPreKey && payload.signature
          ? { signedPreKey: payload.signedPreKey, signature: payload.signature }
          : undefined;
        /** an existing friend's verified INIT time: becomes his newest-INIT mark once this INIT is accepted (security review M1) */
        let verifiedIat: number | undefined;
        if (existingFriend) {
          /**
           * 既有好友的 INIT 一定要有他身分金鑰的簽章（開源第 5b 步，services/x3dhInitAuth.ts）—— 在任何事之前（改名、更新 bundle、
           * 動 session）。INIT 是 broker 上的明文、from 誰都能填：以前任何能發到我收件匣的人（營運方、任何帳號）都能冒名叫我跟每個
           * 好友重置 session。簽章綁收件人（我）、所有會改變我行為的欄位與時間（10 分鐘內）。
           * 時間用有上限的 boundedNow（安全審查 M1，同 W5 的規則）：serverNow 是手機時鐘加上伺服器給的時差、沒有上限 ——
           * 營運方在 token 回應裡回一個接近舊 INIT 的 iat 的時間，48 小時後就能把錄下來的 INIT 重播進來（重置 session、存舊的
           * bundle、套用舊名字）。boundedNow 對伺服器時鐘最多採信 ±5 分鐘
           */
          const authVerdict = publicKey
            ? verifyInitAuth({ from: senderPublicKeyBase64, to: publicKey, payload, now: mqttService.boundedNow(), verify: identityVerify })
            : 'missing';
          if (authVerdict !== 'ok') {
            console.error('[DIAG:X3DH:RX] 既有好友的 INIT 沒有他身分金鑰的有效簽章 → 拒收', authVerdict, senderPublicKeyBase64.slice(0, 12));
            return;
          }
          // 比這個好友已經接受過的最新一封還舊（安全審查 M1）：每個好友記著「接受過的最新 iat」（存起來、不會過期，
          //   x3dhReplay.ts），更舊的整封不收 —— 在改名、更新 bundle、動 session 之前
          const signedIat = (payload.auth as { iat?: unknown } | undefined)?.iat;
          verifiedIat = typeof signedIat === 'number' ? signedIat : undefined;
          if (publicKey && isInitOlderThanAccepted(publicKey, senderPublicKeyBase64, verifiedIat)) {
            console.error('[DIAG:X3DH:RX] 比這個好友已接受的最新 INIT 還舊 → 拒收', senderPublicKeyBase64.slice(0, 12));
            return;
          }
          // 既有好友當面掃了我的 QR 重加（審查 L3）：他那邊記我「已驗證」，我這邊也升級。只認對得上的 QR proof、只升不降；
          //   短碼重加、修復的 INIT（不帶 via）維持原本的等級
          if (existingFriend.trustLevel !== 'verified' && payload.via && publicKey) {
            const reAddVia = await acceptedVia(publicKey, senderPublicKeyBase64, payload.ephemeralPublicKey, payload.via, friendViaSealer);
            if (reAddVia?.kind === 'qr') useChatStore.getState().updateFriendTrust(existingFriend.id, 'verified');
          }
          /**
           * 對方改名了就跟著改（移植群星 2026-09-08）。以前只在舊名字「看起來像預設值」（Friend／User／好友／用戶 開頭、
           * 或長度 > 50）才更新：已經是好友的人改了暱稱，我這邊永遠是舊名字。短碼加好友時特別明顯 —— 他重加我只有他→我
           * 這一封 INIT，我不會收到他的 PROFILE_UPDATE（那是我回給他的），INIT 是我唯一知道他現在叫什麼的來源。
           * 開源第 4 步：名字不再是 INIT 明文的 senderName，在封給我身分金鑰、他簽名的 via 裡（viaName：拆得開就是他本人寫的）；
           * 修復的 INIT 不帶 via → 不改名（名字的變更另外走封好的個人資料）。
           * 沒有「本機自訂暱稱」：PROFILE_UPDATE 本來就無條件覆蓋 displayName，這裡跟著改是一致的。名字跟新加好友一樣過 cleanPeerName。
           * 同一封 INIT 重到（已接受過）不改：那是當時的名字，之後的 PROFILE_UPDATE 可能已經改過 —— 群星沒擋這條
           */
          const replayedInit = !!publicKey && wasInitAccepted(publicKey, senderPublicKeyBase64, payload.ephemeralPublicKey);
          const signedName = payload.via && publicKey && !replayedInit
            ? await viaName(publicKey, senderPublicKeyBase64, payload.via, friendViaSealer) : null;
          const newName = cleanPeerName(signedName, existingFriend.name);
          if (!replayedInit && newName !== existingFriend.name) {
            console.error('[DIAG:X3DH:RX] 好友改名', senderPublicKeyBase64.slice(0, 12));
            updateFriendProfile(senderPublicKeyBase64, { displayName: newName });
          }
          if (senderPreKeyBundle) {
            addFriend(
              senderPublicKeyBase64,
              existingFriend.name,
              existingFriend.trustLevel,
              existingFriend.avatar,
              existingFriend.pushSubscription,
              senderPreKeyBundle,
            );
          }
        } else {
          // 封鎖過的人（刪好友後）不能自己用 X3DH_INIT 加回來（稽核 H13）：不加好友、不建 session
          if (await isBlacklisted(senderPublicKeyBase64)) {
            console.error('[DIAG:X3DH:RX] 封鎖名單上的人送 INIT → 忽略', senderPublicKeyBase64.slice(0, 12));
            return;
          }
          /**
           * 不是好友：**一定要對得上我發出去的邀請**才加（稽核 H2，對應 AegisPlay A2）—— 他帶的 via 要是我這台
           * 發出、還沒過期的短碼或 QR nonce。對不上（沒帶、猜的、過期的、別的帳號的）就整封拒收：不加好友、不建
           * session、不回送我的個人資料。信任等級也只看 via（當面掃我畫的 QR 才算已驗證），不採用 payload 自稱的。
           * 以前對不上仍加成「未驗證」好友，只為了相容不帶 via 的舊版 client；App 還沒上線、沒有舊版，所以拿掉。
           * via 不帶憑證本身：是封給我身分金鑰、寄件者簽名的 { 種類, 綁寄件者與這封 ephemeral 的 proof }（審查 M2）——
           * 別人的 INIT 被看到也抄不走、也拿不到 proof 去離線猜短碼。
           */
          const via = publicKey ? await acceptedVia(publicKey, senderPublicKeyBase64, payload.ephemeralPublicKey, payload.via, friendViaSealer) : null;
          if (!via) {
            console.error('[DIAG:X3DH:RX] 非好友的 INIT 沒有對得上的邀請憑證 → 拒收', senderPublicKeyBase64.slice(0, 12));
            return;
          }
          const trust = via.kind === 'qr' ? 'verified' as const : 'unverified' as const;
          // 名字在封好的 via 裡（開源第 4 步；以前是 INIT 明文的 senderName）
          const name = cleanPeerName(via.name, getServiceTranslation()('chatApp.defaultFriendName'));
          // 頭像由 PROFILE_UPDATE 處理；Phase 35c: 加好友會由 chatStore 自動觸發 aegisIdBlob.markDirty() flush 至 VPS
          addFriend(senderPublicKeyBase64, name, trust, undefined, undefined, senderPreKeyBundle);
        }

        // 將 Base64 轉換為 Uint8Array 並建立 session
        // 注意: acceptSession 內部已 idempotent — 若已有 session 會直接 return existing
        // （防止 MQTT 重投遞 X3DH_INIT 導致 Bob 端 ratchet 被重置 → aead::Error）
        const senderIdentityPublic = fromBase64(senderPublicKeyBase64);
        if (existingFriend) {
          diagLog('[DIAG:X3DH] X3DH_INIT received for EXISTING friend:', senderPublicKeyBase64.slice(0, 16),
            '— acceptSession 靠 ephemeral 追蹤決定 idempotent/replace');
        }
        // 同一封 INIT 再到一次（MQTT 離線佇列重送／QoS1 重投／App 重啟後重播）→ 不要再清一次 session、outbox、
        //   WebRTC（傳輸統一 X6）。必須在下面的 sessionReset 清除**之前**判斷（clearPeerSession 會連
        //   acceptSession 的記憶體 ephemeral 紀錄一起清掉），紀錄跨重啟有效。
        //   本機已經沒有 session 時照常處理：重新接受才救得回來。
        if (publicKey && hasSessionWith(senderPublicKeyBase64)
            && wasInitAccepted(publicKey, senderPublicKeyBase64, payload.ephemeralPublicKey)) {
          console.error('[DIAG:X3DH] duplicate INIT (same ephemeral already accepted) → ignore', senderPublicKeyBase64.slice(0, 16));
          return;
        }
        // Glare 備援（對端是「兩邊都發起」的舊版時才會走到）：對方的自動 repair INIT 撞上
        //   我 30s 內剛送出的 INIT，且我 pubkey 較大 → 我贏，整封忽略（不清 session、不 accept），
        //   等對方 forceReset 接受我的。⚠️ 必須在 clearPeerSession **之前**判斷 —— 之前把 tiebreak
        //   放在 acceptSession 裡，證據（session + initiatedAt）已先被清掉，永遠不觸發
        //   （docs/CRYPTO_X3DH_GLARE_20260819.md §4.1 插樁實證）。只對 repair 生效：
        //   QR 重加（sessionReset 無 repair）必須永遠贏。新版兩端不會進到這裡（較小方不發起）。
        if (payload.sessionReset && payload.repair === true
            && publicKey && publicKey > senderPublicKeyBase64
            && recentlyInitiatedTo(senderPublicKeyBase64)) {
          console.error('[DIAG:X3DH] GLARE ignore — repair INIT from lex-smaller while my INIT in flight:',
            senderPublicKeyBase64.slice(0, 16));
          return;
        }
        // Stale-SPK 拒收（2026-08-19 byte 實證，docs/CRYPTO_X3DH_GLARE_20260819.md）：
        //   對方從 blob 恢復的 contact bundle 可能存著我「陳年舊版」的 SPK —— 用它建的 X3DH
        //   從 shared_secret 就對不上，接受了也是建一個註定 aead 的 session、第一則訊息必死。
        //   對方有標明用的哪把 SPK 且 ≠ 我現在這把 → 不 accept、不清 session，
        //   回附上我最新 bundle 的 PREKEY_REQUEST 請對方重建（對方 handler 會優先用附帶的 bundle）。
        //   新↔新一輪收斂；舊版對端不送 recipientSpk → 不觸發，維持原行為（aead 自救兜底）。
        if (payload.recipientSpk && signedPreKey && payload.recipientSpk !== signedPreKey.publicKeyBase64) {
          console.error('[DIAG:X3DH] STALE-SPK reject — peer built with my old SPK, requesting rebuild:',
            senderPublicKeyBase64.slice(0, 16));
          await sendPrekeyRequest(senderPublicKeyBase64, { signedPreKey: signedPreKey.publicKeyBase64, signature: signedPreKey.signatureBase64 });
          return;
        }
        // 既有好友重置 session 的額度（開源第 5b 步）：每個好友 10 分鐘最多 RESET_BUDGET_MAX 次，超過就整封不收（不清、不 accept）
        if (existingFriend && !initResetBudget.take(senderPublicKeyBase64, Date.now())) {
          console.error('[DIAG:X3DH:RX] 這個好友重置 session 太頻繁 → 這一封不收', senderPublicKeyBase64.slice(0, 16));
          return;
        }
        // QR re-add authoritative：對方帶 sessionReset → 先清我方舊 session + 舊 outbox 密文，
        //   再 acceptSession 走 fresh path（最新 key wins，不靠 ephemeral 猜）。
        if (payload.sessionReset) {
          await clearPeerSession(senderPublicKeyBase64);
          await deletePendingMessagesForRecipient(senderPublicKeyBase64);
          // 對稱重置「傳輸層」：對方 re-add/恢復帳號送 sessionReset → 我方也要拆掉 stale WebRTC peer，
          //   否則收端沿用舊 dead/stuck PC（polite 端永遠等 re-offer）→ 對方重連也送不進來。
          //   這樣 reset/re-add 兩端都強制重建 transport，不必靠某一方剛好觸發 fresh offer 才復原。
          webrtcService.disconnect(senderPublicKeyBase64);
          diagLog('[DIAG:X3DH] sessionReset → cleared old session + outbox + WebRTC peer for', senderPublicKeyBase64.slice(0, 16));
        }
        // acceptSession 內部靠 ephemeral 追蹤：同 ephemeral(MQTT 重投遞)→skip 保留 ratchet；
        //   異 ephemeral(對方重啟/恢復/重加)→replace。雙建 glare 由發起端唯一發起者 tiebreak 防止。
        acceptSession(senderIdentityPublic, senderEphemeralPublic, undefined,
                      payload.sessionReset === true, payload.repair === true);
        // 收端也等新 responder session 真的落 DB，避免收到 reset 後立刻 reload/crash 丟失 session。
        await flushSessionWrites();
        if (publicKey) rememberAcceptedInit(publicKey, senderPublicKeyBase64, payload.ephemeralPublicKey, verifiedIat);
        // 註：他送 INIT 來不算確認我這邊的「等待確認」（MQTT 的 from 誰都能填）；要等他回的 PROFILE_UPDATE 帶對
        //   我那封 INIT 的 ephemeral，或第一則解得開的訊息（審查 M1，見 stores/pendingFriendStore）

        // session 剛建立 → 立刻嘗試送出「待加密」outbox（無 session 期間排隊的訊息，
        // 2026-08-19 修訊息無聲消失）。P2P 未連上時是 no-op，onPeerConnected 的 flush 會補。
        import('../services/p2pSend').then(({ flushQueueForPeer }) => {
          void flushQueueForPeer(senderPublicKeyBase64);
        });

        // 無論好友是否已存在，都發送 PROFILE_UPDATE 給對方
        // 因為收到 X3DH_INIT 表示對方剛剛加我為好友，需要我的個人資料
        const t = getServiceTranslation();
        let myAvatar: string | undefined;
        let myDisplayName = t('chatApp.defaultFriendName');

        try {
          const saved = localStorage.getItem('mist_user_profile');
          if (saved) {
            const profile = JSON.parse(saved);
            myAvatar = profile.avatar;
            myDisplayName = profile.displayName || t('chatApp.defaultFriendName');
          }
        } catch (e) {
          console.error('[AppProvider] Failed to read localStorage:', e);
        }

        if (!myAvatar) {
          const myProfile = useChatStore.getState().userProfile;
          myAvatar = myProfile.avatar;
          myDisplayName = myProfile.displayName || myDisplayName;
        }

        // 封給對方的身分金鑰（DIRECT_SEALED kind profile；以前明文，broker 看得到名字與頭像）
        await sendProfileUpdate(senderPublicKeyBase64, {
          displayName: myDisplayName,
          avatar: myAvatar,
          // 收下的是哪一封 INIT：對方的「等待確認」只認回這一封的（審查 M1）
          initEph: payload.ephemeralPublicKey,
        });
      } catch (err) {
        console.error('[AppProvider] Failed to process X3DH_INIT:', err);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [mqtt, cryptoReady, acceptSession, addFriend, getFriendByPublicKey, updateFriendProfile, publicKey, recentlyInitiatedTo, hasSessionWith, signedPreKey]);

  // 監聽 PREKEY_REQUEST 訊息（開源第 4 步：DIRECT_SEALED kind prekey）- 對方請求重新建立 session（session 斷線恢復）。
  //   封給我的身分金鑰、他簽章、iat 比他上一則新（directSignal）—— 以前明文：營運方能冒名一直叫我重建 session
  useEffect(() => {
    if (!cryptoReady) return;

    const unsubscribe = onDirect('prekey', async (requesterPubKey, body) => {
      try {
        // 🔑 L688 修復 + 2026-08-19 glare 修復：對方（恢復端 —— 沒存我方 bundle、或 pubkey 較小
        //   的讓步方，見 SessionRepair 的 PREKEY_REQUEST 分支）請我重新發起 session，由我方
        //   (re)initiate X3DH。舊版回傳 PRE_KEY_BUNDLE，但全 app 沒有接收端(dead code)。
        // 冷啟動時好友清單可能還沒載入 → 先等（findFriendSettled，部署前審查 HIGH），否則修復請求被當陌生人丟掉
        const requester = await findFriendSettled(requesterPubKey);
        if (!requester) {
          console.error('[PreKeyReq] not a friend:', requesterPubKey.slice(0, 16), '→ ignore');
          return;
        }
        // 2026-08-19 起 repair 的 PREKEY_REQUEST 會附上請求方自己的 bundle —— 我方沒存過
        //   （L688 反向加入的舊 contact）就用它，順帶補存；偽造 bundle 會在 createSession 驗簽時失敗。
        const reqPayload = body as { signedPreKey?: unknown; signature?: unknown };
        const attached = typeof reqPayload.signedPreKey === 'string' && typeof reqPayload.signature === 'string'
          && reqPayload.signedPreKey && reqPayload.signature
          ? { signedPreKey: reqPayload.signedPreKey, signature: reqPayload.signature }
          : null;
        const stored = requester.signedPreKey && requester.signature
          ? { signedPreKey: requester.signedPreKey, signature: requester.signature }
          : null;
        const bundle = attached ?? stored; // 附帶的最新（對方剛恢復），優先
        if (!bundle) {
          console.error('[PreKeyReq] no bundle (stored or attached) for', requesterPubKey.slice(0, 16), '→ cannot re-initiate');
          return;
        }
        if (attached && (attached.signedPreKey !== requester.signedPreKey || attached.signature !== requester.signature)) {
          addFriend(requesterPubKey, requester.name, requester.trustLevel,
                    requester.avatar, requester.pushSubscription, attached);
        }
        // ⚠️ 收到 PREKEY_REQUEST 一律重新發起，**不做**「我剛發起過就跳過」的去重（2026-08-19 round 2 實證）：
        //   對方全新裝置第一次連線前，broker 上沒有他的 session → 我更早送出的 X3DH_INIT **被 broker
        //   直接丟掉**（clean:false 只保護「已存在」的 session）。此時對方送得出 PREKEY_REQUEST ＝
        //   他現在連著 ＝ 我回的 INIT 一定到得了。曾加過 recentlyInitiatedTo 跳過 → 在途 INIT 其實
        //   已死 → 對方永遠拿不到 session。重複握手無害（同 publisher MQTT 保序，收端以最後的
        //   ephemeral 收斂），漏發致命。
        // 既有 ratchet 視為 stale（對方剛恢復）→ 清掉走 fresh path（同 L691 理由：避免 idempotent reuse 舊 root key）。
        await clearPeerSession(requesterPubKey);        // 清 active in-memory + mist_sessions
        await deleteRatchetState(requesterPubKey);      // 清 legacy ratchet_states（若舊版殘留）
        // 對稱重置「傳輸層」（同 X3DH sessionReset 分支）：修復也要拆掉 stale WebRTC peer，否則
        //   ①收端沿用舊 dead PC；②我方待會重送 manifest 時 DataChannel 還開著 → 直送舊 ratchet 密文
        //   在對方 forceReset 前就被 aead 丟掉。拆掉 → 重送進 outbox，等重連（對方已收斂）flush 才出去。
        webrtcService.disconnect(requesterPubKey);
        const { ephemeralPublicKey } = createSession(
          fromBase64(requesterPubKey),
          fromBase64(bundle.signedPreKey),
          fromBase64(bundle.signature),
          undefined,
          undefined,
          true, // forceFresh：回 X3DH_INIT(reset) → 發起方建全新 Alice，與新 ephemeral 同源
        );
        await flushSessionWrites(); // 等 initiator session 落 DB 再送 X3DH_INIT（同 QR add，避免我方 DB 未穩的 race）
        // 不帶名字（開源第 4 步：名字只走封好的個人資料／via）
        // 帶我身分金鑰的簽章（開源第 5b 步，x3dhInitAuth）：我們是好友，沒有簽章的 INIT 對方一律不收
        mqttService.sendToUser(requesterPubKey, MessageType.X3DH_INIT, withInitAuth(requesterPubKey, {
          ephemeralPublicKey: toBase64(ephemeralPublicKey),
          signedPreKey: signedPreKey?.publicKeyBase64,
          signature: signedPreKey?.signatureBase64,
          sessionReset: true,
          recipientSpk: bundle.signedPreKey, // stale-SPK 防線（收端比對；附帶 bundle 優先所以通常已是最新）
        }));
        console.error('[PreKeyReq] re-initiated X3DH for', requesterPubKey.slice(0, 16));
        // 對方 aead 請求修復 → 我方剛以 forceFresh 重建 session。若近 30s 內我曾送檔給對方，
        //   當時的 manifest 在對方 ratchet 分裂下被 aead 丟了。用「剛建好的新 session」重新加密 manifest
        //   重送：此刻 DataChannel 已被 repair 拆掉 → sendViaP2P 進 outbox，等重連（對方已收 X3DH_INIT
        //   收斂）flush 出去 → 對方解得開、replay 早到的 chunks。deterministic：綁 repair 完成非 arbitrary 重連。
        import('../services/fileTransfer').then(({ resendRecentManifests }) => {
          void resendRecentManifests(requesterPubKey);
        });
      } catch (err) {
        console.error('[AppProvider] Failed to handle prekey_request:', err);
      }
    });

    return () => { unsubscribe(); };
  }, [cryptoReady, createSession, getFriendByPublicKey, signedPreKey, addFriend, recentlyInitiatedTo]);

  // 守護警報／社交恢復的加密與簽章函式、社交恢復自動設定（官方版；社群版沒有）
  useServiceRegistration({ cryptoReady, publicKey, encrypt, identity });

  // 註冊 Ed25519 identity 給 payment 服務（QR Code 簽章）
  useEffect(() => {
    if (cryptoReady && identity) {
      ext.payments?.registerIdentity(
        (data: Uint8Array) => identity.sign(data),
        identity.publicKey
      );
      // ADR-016: 註冊 Group Key 簽名函式
      groupKeyService.registerSignFunctions({
        sign: (data: Uint8Array) => identity.sign(data),
        verify: (pubKey: Uint8Array, data: Uint8Array, sig: Uint8Array) => Identity.verify(pubKey, data, sig),
      });
      // 群組金鑰信封（groupKeyDelivery）：封／拆都用這個解鎖中的身分；登出、換帳號時收回
      const owner = identity.publicKeyBase64;
      registerGroupKeySealer(identity);
      return () => unregisterGroupKeySealer(owner);
    }
  }, [cryptoReady, identity]);

  /**
   * 群組 log 引擎（services/groupEngine，docs/GROUP_LOG_WIRING_W1.md）：身分解鎖、資料庫就緒後建立，換帳號／登出時停掉。
   * 群組名冊、角色、資訊、金鑰只由引擎套上的狀態鏈決定；畫面（groupStore）是它的投影。
   */
  useEffect(() => {
    if (!cryptoReady || !identity || !publicKey || !storageReady || identity.publicKeyBase64 !== publicKey) return;
    const me = publicKey;
    const sign = (d: Uint8Array) => identity.sign(d);
    // 我封鎖的人（定時 here／回 here 要同步判斷：這個帳號的名單，變了就重載；W5 審查 M2）。
    //   第一次載完之前、載入失敗 → 當成還不知道：定時 here、回 here 都先不發（寧可他晚一點看到我在線；失敗 30 秒後再載一次）；
    //   重載重疊時只採最後一次的結果（W5 複審）
    let blockedNow: ReadonlySet<string> | null = null;
    let blockedLoad = 0;
    let blockedRetry: ReturnType<typeof setTimeout> | null = null;
    let engineGone = false;
    const loadBlocked = () => {
      const n = ++blockedLoad;
      if (blockedRetry) { clearTimeout(blockedRetry); blockedRetry = null; }
      void getLocalBlacklist().then((list) => {
        if (!engineGone && n === blockedLoad) blockedNow = new Set(list.map((e) => e.pubkey));
      }).catch((err) => {
        if (engineGone || n !== blockedLoad) return;
        console.error('[AppProvider] blacklist load for the group engine failed:', err);
        blockedNow = null;
        blockedRetry = setTimeout(loadBlocked, 30_000);
      });
    };
    const notBlocked = (pk: string): boolean => blockedNow !== null && !blockedNow.has(pk);
    loadBlocked();
    const offBlockedForEngine = onBlacklistChanged(loadBlocked);
    const engine = createGroupEngine({
      me,
      sign,
      verify: identityVerify,
      x25519: identityX25519,
      myX25519Private: async () => {
        const s = currentSealer();
        if (!s || s.me !== me) throw new Error('identity is locked');
        return s.x25519Private;
      },
      store: groupLogStore,
      log: createGroupLogClient({ base: apiBase(), signer: () => ({ publicKey: me, sign }), serverNow: () => mqttService.serverNow() }),
      sendSealed: async (to, body) => { await sendGroupSealed(to, body); },
      // 群組主題上的 group_sealed（commit 通知、here、sync、通話、刪除；W2 取代 group_log_ping 與明文的群組通話型別）。
      //   主題是 tid（W3，那一代的金鑰推出來的），不是 gid；沒連上回 false（不排隊，引擎留著連上再重封）
      publish: (tid, envelope, { qos }) => mqttService.sendToGroup(tid, MessageType.GROUP_SEALED, envelope, { qos }),
      onControl: (gid, from, t, body) => routeGroupControl(gid, from, t, body, {
        onCall: (g, f, b) => groupCallService.handleControl(g, f, b),
        onDelete: (g, f, messageId) => {
          // 只刪「這個群、這個作者」的那一則（別人不能刪我的）；寄件人已由引擎驗過是成員
          void deleteGroupMessageFrom(messageId, g, f).then((deleted) => {
            if (deleted) window.dispatchEvent(new CustomEvent('aegis:group-message', { detail: { groupId: g, groupIds: [g] } }));
          }).catch((err) => console.error('[AppProvider] group delete failed:', err));
        },
      }),
      // 邀請的整條鏈在 Web Worker 驗（不卡畫面）；Worker 不能用就在這裡驗
      verifyInvite: createInviteVerifier({ verify: identityVerify, makeWorker: makeInviteWorker }),
      project: (gid, group) => {
        const store = useGroupStore.getState();
        if (group) {
          store._applyChainGroup(group);
          return;
        }
        store._removeChainGroup(gid);   // 主題的退訂跟著引擎的主題表（onTopics → token 範圍 → mqtt 退訂）
      },
      isFriend: async (pk) => !!(useChatStore.getState().getFriendByPublicKey(pk) || await findFriendSettled(pk)),
      isBlocked: (pk) => isBlacklisted(pk).catch(() => false),
      nicknameOf: (pk) => useChatStore.getState().getFriendByPublicKey(pk)?.name,
      // 校正到伺服器的時鐘（審查 W2 #1）：控制訊息的 ts、commit／delete 的新鮮度、邀請重送都用它，手機之間的時鐘差不算進去
      now: () => mqttService.serverNow(),
      // 收到的 here／sync／通話控制新不新鮮：API 的時鐘差最多採信 ±5 分鐘（W5 審查 M1：營運方回假的 serverTime 就能讓錄下來的
      //   通話開始在重開後還算新）。手機時鐘差超過 5 分鐘的人這幾種會收不到 → mqtt 另外提示他校正時間（clock-drift）
      receiveNow: () => mqttService.boundedNow(),
      // 沒連上的控制訊息留在引擎裡、連上才封（不讓 mqtt 排一則用舊的一代封好的）；主題訂好了才送加入後的 sync
      connected: () => mqttService.isConnected(),
      topicReady: (tid) => mqttService.isGroupSubscribed(tid),
      // 該訂的群組主題（加入、換金鑰、重疊期到了、被踢）→ 下面的 effect 改 token 範圍，mqtt 照範圍訂／退訂
      onTopics: (topics) => setGroupTopics(topics),
      // 驗過的 here／sync：他剛連上（W4：同群組但不是好友的人看不到彼此的 presence）→ 記下來（小綠點、健康檢查），
      //   我有東西要給他或我是發起方 → 連 P2P（同「名冊多了人」那一套，見下面的 reachPeerRef）
      onMemberSeen: (_gid, from) => {
        if (from === me) return;
        memberPresence.seen(from);
        reachPeerRef.current(from);
      },
      // 他剛連上，但他看不到我（不是好友：沒有我的 presence 秘密），我這邊也沒看到他（最近沒有他的 here、通道沒開）
      //   → 回一則 here 讓他知道我在線（審查 W4 #2；引擎另外限速）。好友不必：他看我的 presence
      //   我封鎖的人不回（W5 審查 M2：不讓他問出我在不在）
      answerHere: (_gid, from) => from !== me && notBlocked(from) && !useChatStore.getState().getFriendByPublicKey(from)
        && !memberPresence.recentlySeen(from) && !webrtcService.isDataChannelOpen(from),
      // 他的 sync／here 要我回 here（追趕、對不上）：我封鎖的人一律不回（W5 複審：不然他每 10 秒發一則 sync 就問得出我在不在；
      //   其他成員照樣回他）
      mayReply: (_gid, from) => notBlocked(from),
      // 定時 here（W5）：名冊上有人看不到我的 presence（不是我給了秘密的好友）→ 連著的時候定時發，他那邊 10 分鐘後才不會
      //   把我當成離線。群裡有我封鎖的人就不定時發（真的連上時的 here 照舊；審查 M2）。P2P 通道開著也照發：我這邊以為開著、
      //   他那邊可能已經關了、把我當成離線（W5 複審；4 分鐘一則 QoS0）
      needsHere: (_gid, members) => {
        const blocked = blockedNow;
        return blocked !== null && !members.some((pk) => blocked.has(pk))
          && members.some((pk) => pk !== me && !(presenceRef.current?.sharesWith(pk) ?? false));
      },
      notice: (n) => {
        diagLog('[DIAG:GLOG]', n.kind, n.gid.slice(0, 8), n.op ?? '', n.reason ?? '');
        window.dispatchEvent(new CustomEvent('aegis:group-notice', { detail: n }));
      },
      onChange: (gid) => { void retryPendingGroupMessagesRef.current(gid); },
    });
    setGroupEngine(engine);
    registerChainProjector(() => engine.projectAll());
    engine.start()
      .then(() => diagLog('[DIAG:GLOG] engine started'))
      .catch((err) => {
        console.error('[AppProvider] group engine failed to start:', err);
        setGroupTopics([]);   // 沒有群組主題也要讓 token 範圍（好友 presence）設得下去
      });
    return () => {
      engineGone = true;
      if (blockedRetry) clearTimeout(blockedRetry);
      offBlockedForEngine();
      engine.stop();
      registerChainProjector(null);
      if (getGroupEngine() === engine) setGroupEngine(null);
      setGroupTopics(null);
    };
  }, [cryptoReady, identity, publicKey, storageReady]);

  /**
   * 好友之間的秘密 presence（W4，services/presenceService，docs/GROUP_LOG_WIRING_W4.md）：身分解鎖、資料庫就緒後建立，換帳號／登出時停掉。
   * 我的秘密只封給好友（封鎖的不算）；刪好友、封鎖、滿 30 天就換（先清舊主題、再換 tag、再封給剩下的好友）。
   * mqtt 用它的 codec 封／拆 presence；token 範圍用它給的 tag 與確切的好友主題（下面 setAclScope 的 effect）。
   */
  useEffect(() => {
    if (!cryptoReady || !identity || !publicKey || !storageReady || identity.publicKeyBase64 !== publicKey) return;
    const me = publicKey;
    // 這個 effect 收掉之後（換帳號、登出）服務裡還在跑的工作：不再用（已經是別人的）身分送、不再改 token 範圍（審查 W4 #3）
    let stopped = false;
    const service = createPresenceService({
      me,
      // 有上限的時鐘（W5 審查 L1：API 回 +30 天的 serverTime 就能逼每次拿 token 都換一次秘密、或把世代 e 撥到很遠的未來）
      now: () => mqttService.boundedNow(),
      store: presenceStore,
      sendSealed: async (to, body) => (stopped || currentSealer()?.me !== me ? false : sendGroupSealed(to, body)),
      friends: () => useChatStore.getState().friends.map((f) => f.publicKey),
      isFriend: async (pk) => !!(useChatStore.getState().getFriendByPublicKey(pk) || await findFriendSettled(pk)),
      blocked: async () => new Set((await getLocalBlacklist()).map((e) => e.pubkey)),
      onScope: (scope) => { if (!stopped) setPresenceScope(scope); },
      clearRetained: (topic) => (stopped ? Promise.resolve(false) : mqttService.clearPresence(topic)),
      connected: () => !stopped && mqttService.isConnected(),
    });
    presenceRef.current = service;
    mqttService.setPresenceCodec(service.codec);
    // 好友清單載完再開始（不然第一次比對時好友是 0 個：不會誤換秘密 —— 拿過的人會再查資料庫 —— 只是新好友要等下一次變動）
    void waitForLocalLists().then(() => (stopped ? undefined : service.start())).catch((err) => {
      console.error('[AppProvider] presence service failed to start:', err);
      if (!stopped) setPresenceScope({ tag: null, topics: [] });   // 沒有 presence 也要讓 token 範圍（群組主題）設得下去
    });
    const reconcile = () => { void service.reconcile(); };
    // 好友的公鑰集合變了才比對（每則訊息都會換掉 friends 陣列 —— 最後一則、未讀數 —— 不必每次都比對、查封鎖名單；審查 W4 #10）
    const friendKeys = (list: readonly { publicKey: string }[]) => list.map((f) => f.publicKey).sort().join(',');
    let lastFriendKeys = friendKeys(useChatStore.getState().friends);
    const offFriends = useChatStore.subscribe((state, prev) => {
      if (state.friends === prev.friends) return;
      const keys = friendKeys(state.friends);
      if (keys === lastFriendKeys) return;
      lastFriendKeys = keys;
      reconcile();
    });
    const offBlocked = onBlacklistChanged(reconcile);
    // 刪好友真的刪完（contacts 那一列也沒了）再比對一次：記憶體先少了他的那一刻，資料庫還查得到他 → 那一次不會換秘密（W5 模擬 P1）
    const offRemoved = onFriendRemoved(reconcile);
    const offConnected = mqttService.onConnected(() => { void service.onConnected(); });
    // 30 天換一次、沒回的 request 再要一次：每 5 分鐘比對一次（不連網，除非真的要送）
    const timer = setInterval(reconcile, 5 * 60_000);
    return () => {
      stopped = true;
      service.stop();
      offFriends();
      offBlocked();
      offRemoved();
      offConnected();
      clearInterval(timer);
      mqttService.setPresenceCodec(null);
      if (presenceRef.current === service) presenceRef.current = null;
      memberPresence.reset();
      setPresenceScope(null);
    };
  }, [cryptoReady, identity, publicKey, storageReady]);

  // MQTT（重）連上 → 每個群補抓 log（離線期間的 commit 通知可能沒收到）、留著的控制訊息送出去；
  //   真的上線（不是換 token 的重連）再在每個群發 here。引擎是在已經連著之後才建的 → 引擎自己在 start() 發（審查 W2 #7）
  useEffect(() => mqttService.onConnected(({ tokenSwap }) => {
    const engine = getGroupEngine();
    engine?.syncAll();
    engine?.flushControl();
    if (!tokenSwap) engine?.announce();
  }), []);

  // 群組主題訂好了（SUBACK）→ 剛加入的群在這時送 sync（之前送的話，大家回的 here 這台還收不到；審查 W2 #2）。
  //   tid 是哪個群由引擎自己的主題表決定
  useEffect(() => mqttService.onGroupSubscribed((tid) => { getGroupEngine()?.onTopicReady(tid); }), []);

  /**
   * 封給我身分金鑰的群組信封（groupKeyDelivery）：邀請、金鑰索取、金鑰回覆 → 群組引擎（規則在 groupEngineSealed：
   * 邀請只收好友、而且要是寫那筆 add 的人；金鑰只收鏈上授權的；只回答 mayReceiveKey 允許的）。
   * 寄件人不必是好友（群組成員之間沒有 1-1 session），身分靠信封裡的簽章。封鎖的人寄來的一律不處理（稽核 H13）。
   */
  useEffect(() => {
    if (!mqtt.isConnected || !publicKey) return;
    const unsubscribe = mqtt.subscribe(MessageType.GROUP_KEY_SEALED, async (message: MqttMessage) => {
      try {
        if (message.from === publicKey) return;
        await waitForLocalLists();   // 冷啟動：清單載完才判斷寄件者與群組（見 waitForLocalLists）
        // 先看額度、再看寄件者是不是好友或同群成員，才拆（對應群星 e1b119c7）：陌生人寄的不必先花一次
        //   X25519＋HKDF＋AES＋簽章驗證（邀請一定來自好友、金鑰只在成員之間）
        if (!sealedOpenBudget.take(message.from)) {
          diagLog('[DIAG:GK] sealed group budget spent for', message.from.slice(0, 16), '— dropped unopened');
          return;
        }
        if (!(await isFriendOrFellowMember(message.from))) {
          diagLog('[DIAG:GK] sealed group message from a stranger — dropped unopened:', message.from.slice(0, 16));
          return;
        }
        const blocked = await isBlacklisted(message.from).catch(() => false);
        if (blocked) return;
        const opened = await openGroupSealed(message.from, message.payload);
        if (!opened) return;
        // 群組通話的 offer／answer／ICE：交給通話服務（它再看寄件人是不是那個群的成員、是不是目前這通電話、新不新鮮）
        if (opened.kind === 'call') {
          groupCallService.handleSignal(opened.from, opened.body, mqttService.boundedNow());
          return;
        }
        // 好友之間的 presence 秘密（W4）：presenceService 只收現在的好友、沒被我封鎖的人寄的（同群組的成員不算）
        if (opened.kind === 'presence') {
          const presence = await waitForPresenceService(presenceRef, publicKey);
          if (presence) await presence.onSealed(opened.from, opened.body);
          else diagLog('[DIAG:PRESENCE] presence envelope arrived but the service is not running — dropped (it will be asked again)');
          return;
        }
        // 回答索取要再封一封送出去：每個請求者有額度（對應群星 e1b119c7）
        if (opened.kind === 'req' && !keyAnswerBudget.take(opened.from)) {
          diagLog('[DIAG:GK] key request budget spent for', opened.from.slice(0, 16), '— not answered');
          return;
        }
        const engine = await waitForGroupEngine();
        if (!engine) {
          console.error('[AppProvider] sealed group message arrived but the group engine is not running — dropped');
          return;
        }
        await engine.onSealed(opened.from, opened.body);
      } catch (err) {
        console.error('[AppProvider] Failed to process GROUP_KEY_SEALED:', err);
      }
    });
    return () => { unsubscribe(); };
  }, [mqtt, publicKey]);

  /**
   * 群組主題上的 group_sealed（W2；W3 主題 id）：主題 id 與寄件人取自實際的主題（mist/group/{tid}/{寄件人}），交給群組引擎 ——
   * 引擎只用自己的主題表把 tid 對回群組（表上沒有 → 不解密就丟）；寄件人不在套上的名冊 → 不解密就丟；只用那個主題那一代的金鑰；
   * 驗內層簽章、新鮮度、去重（groupEngineControl）。冷啟動時 broker 補送的可能比引擎早到：等引擎起來（最多 60 秒）
   */
  useEffect(() => {
    if (!mqtt.isConnected || !publicKey) return;
    const unsubscribe = mqtt.subscribe(MessageType.GROUP_SEALED, (message: MqttMessage) => {
      if (message.from === publicKey) return;
      const src = groupControlSource(message);
      if (!src) return;
      if (!groupControlBudget.take(src.from)) {
        diagLog('[DIAG:GLOG] group control budget spent for', src.from.slice(0, 16), '— dropped unopened');
        return;
      }
      void waitForGroupEngine().then((engine) => engine?.onControl(src.tid, src.from, src.envelope))
        .catch((err) => console.error('[AppProvider] group control failed:', err));
    });
    return () => { unsubscribe(); };
  }, [mqtt, publicKey]);

  // 守護群組的報平安排程與事件（官方版；社群版沒有）
  useCheckInScheduler({ isGroupsLoaded, cryptoReady, publicKey, encrypt, getFriendByPublicKey });

  // 全域 ENCRYPTED_MESSAGE 解密+路由 handler，供 P2P (handleWebRTCMessage) 使用。
  // ⚠️ 只依賴 crypto/publicKey ready —— **不可依賴 mqtt.isConnected**！內容走 P2P DataChannel（Phase 32
  //   已移除 MQTT 內容訂閱），MQTT 只是信令。Android MQTT 一斷，舊條件 `!mqtt.isConnected` 會讓這個 effect
  //   早退 → processEncryptedMessageRef=null → P2P 收到 frame 卻沒 handler → 單向收訊失敗（只剩 P2P:RECV）。
  useEffect(() => {
    if (!cryptoReady || !publicKey) return;

    devLog('[AppProvider] Setting up global ENCRYPTED_MESSAGE listener...');

    /**
     * 1 對 1 的送達回條（群星 B33）：DR 加密的 `msg_ack`（只有 session 的另一端解得開、也只清寄給他的那幾則，
     * 見 p2pSend.confirmDelivered）。通道沒開就進 outbox；回條送不出去的話對方 30 秒後重送，這邊依 id 去重再回一次
     */
    const sendDirectReceipt = (peer: string, messageId: string) => {
      if (!messageId || messageId.length > 128) return;
      void (async () => {
        const ack = await encrypt(peer, JSON.stringify({
          id: `ack-${messageId}`, type: 'msg_ack', content: '', timestamp: Date.now(), ackIds: [messageId],
        }));
        try { sendViaP2P(peer, JSON.stringify({ type: 'encrypted_message', payload: ack.toJson() })); }
        finally { ack.free(); }
      })().catch((err) => diagLog('[DIAG:RECV] receipt not sent:', (err as Error)?.message || String(err)));
    };

    // 共用處理函式：MQTT 和 P2P 都呼叫此函式
    const processEncryptedMessage = async (senderPublicKeyBase64: string, payload: unknown) => {
      try {
        // [DIAG] production-visible
        diagLog('[DIAG:RECV] ENCRYPTED_MESSAGE from:', senderPublicKeyBase64.slice(0, 16) + '...');
        devLog('[AppProvider] Payload type:', typeof payload);

        // 檢查發送者是否為好友
        const friend = getFriendByPublicKey(senderPublicKeyBase64);
        if (!friend) {
          diagLog('[DIAG:RECV] Unknown sender, ignoring');
          return;
        }

        // payload 是 JSON 字串 (來自 RatchetMessage.toJson())，需要先反序列化為 WASM 物件
        devLog('[AppProvider] Converting payload to RatchetMessage...');
        const ratchetMessage = RatchetMessage.fromJson(payload as string);
        devLog('[AppProvider] RatchetMessage created successfully');

        // 解密訊息
        devLog('[AppProvider] Attempting to decrypt...');
        const decrypted = await decrypt(senderPublicKeyBase64, ratchetMessage);
        devLog('[AppProvider] Decryption successful!');
        // 解得開＝他用的是我這次加他時建的 session：我在等他確認的話就算確認（審查 M1）
        usePendingFriendStore.getState().confirm(publicKey, senderPublicKeyBase64);
        const messageData = JSON.parse(decrypted) as {
          id: string;
          content: string;
          type: 'text' | 'image' | 'file' | 'voice' | 'payment';
          ttl?: number;
          timestamp?: number;
          voiceData?: { duration: number; waveform?: number[]; mimeType?: string; transcript?: string };
          fileData?: { name: string; mimeType: string; size: number };
          /** 轉帳卡片（type='payment'）/ 收款完成控制訊息（type='payment_claimed'）的 txId */
          paymentData?: import('../types').PaymentData;
          txId?: string;
          isLoading?: boolean;
          // 群組訊息欄位（有 groupId 即為群組訊息）
          groupId?: string;
          groupIds?: string[];
          senderName?: string;
          // 守護群組欄位
          guardianAlert?: {
            alertId: string;
            alertType: string;
            protectedPubkey: string;
            protectedNickname: string;
            details: Record<string, unknown>;
          };
          checkIn?: {
            type: 'request' | 'response';
            requestId: string;
            targetPubkey?: string;
            targetNickname?: string;
            deadline?: number;
            response?: 'ok' | 'need_help';
            message?: string;
          };
        };

        // [DIAG] production-visible: decrypted ok
        diagLog('[DIAG:RECV] Decrypted msg from:', friend.name, 'groupId:', messageData.groupId ?? 'none', 'chars:', messageData.content?.length ?? 0);

        /**
         * 封鎖的人：解完密（ratchet 要同步）就丟，**所有型別**都丟（稽核 H13，對應 AegisPlay B49）。
         * 以前這個檢查在「一般 1-1 訊息」那段，檔案 manifest、群組訊息、金鑰分發都在它前面就處理掉了。
         */
        // 查詢失敗就當沒封鎖並記一筆：這則已經解完密（ratchet 往前走了，對方不會重送），丟掉就永遠不見（部署前審查 LOW）
        const senderBlocked = await isBlacklisted(senderPublicKeyBase64).catch((err) => {
          console.error('[AppProvider] blacklist lookup failed — treating sender as not blocked:', err);
          return false;
        });
        if (senderBlocked) {
          devLog('[AppProvider] Dropped message from blacklisted sender:', senderPublicKeyBase64.slice(0, 16));
          return;
        }

        // ====== AegisBot agent_status：transient「思考中」狀態（CLAUDE.md §14） ======
        // 不寫進訊息列表，只 dispatch CustomEvent 給 ChatRoom 顯示 inline indicator。
        // status 為空字串 = 任務完成清除狀態。
        if ((messageData as unknown as { type?: string }).type === 'agent_status') {
          const agentStatus = (messageData as unknown as { status?: string }).status || '';
          diagLog('[DIAG:RECV] agent_status from:', senderPublicKeyBase64.slice(0, 16), 'status chars:', agentStatus.length);
          // 官方版（AegisBot）：發 aegis:agent-status 給 ChatRoom；社群版沒有 → 丟掉（不是聊天訊息）
          ext.onAgentStatus?.(senderPublicKeyBase64, agentStatus);
          return;
        }

        // ====== 群組金鑰不再走 1-1 通道：只從建群、邀請、log 裡的封裝包、admin 封給身分金鑰的回覆進來（群組引擎） ======
        {
          const ctl = (messageData as unknown as { type?: string }).type;
          if (ctl === 'group_key_distribution' || ctl === 'group_key_request') {
            diagLog('[DIAG:RECV] group key message over the 1-1 channel ignored (keys come from the chain only):', senderPublicKeyBase64.slice(0, 16));
            return;
          }
        }

        // ====== 對方的送達回條（群星 B33）：不是聊天訊息，把「等回條」的那幾則刪掉 ======
        if ((messageData as unknown as { type?: string }).type === 'msg_ack') {
          const confirmed = confirmDelivered(senderPublicKeyBase64, (messageData as unknown as { ackIds?: unknown }).ackIds);
          if (confirmed > 0) diagLog('[DIAG:RECV] msg_ack from:', senderPublicKeyBase64.slice(0, 16), 'confirmed:', confirmed);
          return;
        }

        // ====== 收端回的檔案 ack／busy（對應群星 B32）：不是聊天訊息，交給 fileTransfer ======
        if ((messageData as unknown as { type?: string }).type === 'file_ctl') {
          const ctl = (messageData as unknown as { fileCtl?: fileTransfer.FileControlPayload }).fileCtl;
          if (ctl) fileTransfer.handleFileControl(senderPublicKeyBase64, ctl);
          return;
        }

        // ====== 大檔分塊傳輸 manifest（LEARNINGS §1） ======
        if ((messageData as unknown as { type?: string }).type === 'file_manifest') {
          const md = messageData as unknown as { fileManifest?: fileTransfer.FileManifestPayload };
          if (md.fileManifest) {
            diagLog('[DIAG:RECV] file_manifest from:', senderPublicKeyBase64.slice(0, 16), 'fileId:', String(md.fileManifest.fileId ?? '').slice(0, 8), 'size:', md.fileManifest.size);
            await fileTransfer.handleManifestPayload(md.fileManifest, senderPublicKeyBase64);
          } else {
            devWarn('[AppProvider] file_manifest missing fileManifest payload');
          }
          return;
        }

        // ====== 社交恢復（忘 PIN）：好友替我保管的 Shamir 碎片 ======
        if ((messageData as unknown as { type?: string }).type === 'recovery_shard') {
          diagLog('[DIAG:RECV] recovery_shard from:', senderPublicKeyBase64.slice(0, 16));
          // 官方版的社交恢復；社群版沒有 → 丟掉（不是聊天訊息）
          await ext.identity.onRecoveryShard?.(senderPublicKeyBase64, messageData);
          return;
        }

        // ====== 群組訊息路由（加密群組訊息） ======
        if (messageData.groupId) {
          const groupId = messageData.groupId;

          // 忽略自己發送的訊息
          if (senderPublicKeyBase64 === publicKey) return;
          // 群組只顯示這幾種型別，其他的一律當文字（照樣做 L2 掃描，見 visibleTypeOf）
          messageData.type = (visibleTypeOf(messageData.type, GROUP_VISIBLE_TYPES) ?? 'text') as typeof messageData.type;

          devLog('[AppProvider] Encrypted group message from:', senderPublicKeyBase64.slice(0, 16), 'group:', groupId);

          // 查找群組。名冊只由狀態鏈決定（稽核 H6：不從一對一訊息「自癒」把寄件者補進名冊）。
          //   這條一對一＋groupId 的路只剩守護群組的報平安／警示在用（一般群訊走群組金鑰，handleGroupKeyMessage）；
          //   本機還沒有的群不再先存（以前好友標一個我之後才加入的群，訊息就以他的名義出現在那個群；報平安本來就要群在）
          const group = useGroupStore.getState().getGroupById(groupId);
          if (!group) {
            devWarn('[AppProvider] Encrypted 1-1 group msg for a group not on this device, ignoring:', groupId.slice(0, 12));
            return;
          }
          if (!group.members.some(m => m.publicKey === senderPublicKeyBase64)) {
            devWarn('[AppProvider] Encrypted group msg from non-member, ignoring:', senderPublicKeyBase64.slice(0, 16));
            return;
          }
          // 自動更新成員暱稱（從加密 payload 中的 senderName）
          if (messageData.senderName) {
            useGroupStore.getState().updateMemberNickname(groupId, senderPublicKeyBase64, messageData.senderName);
          }
          // 明文的 groupIds 只留寄件者所屬的群（稽核 H8）
          const viewGroupIds = viewGroupIdsToSave(senderPublicKeyBase64, groupId, messageData.groupIds,
            (id) => useGroupStore.getState().getGroupById(id), messageData.groupIds || [groupId]);

          // 處理守護群組特殊訊息。只看本機名冊（審查 H2）：群組要在、而且是守護群組，寄件者與我的角色要對 ——
          //   以前群組還沒到（邀請還在路上）也照樣派發，任何好友標一個 groupId 就能讓我跳報平安。
          //   守護是官方版的功能（ext.guardian）；社群版沒有守護 → 這兩種控制訊息直接丟掉（schema 保留，不當文字顯示）
          if (messageData.guardianAlert || messageData.checkIn) {
            if (!ext.guardian) {
              diagLog('[DIAG:RECV] guardian control message dropped (no guardian in this edition), group:', groupId.slice(0, 8));
              return;
            }
            if (ext.guardian.onLegacyGroupMessage({ group, groupId, sender: senderPublicKeyBase64, me: publicKey, messageData })) return;
          }

          // L2 風險評估（群組訊息也能防詐了）— 結果持久化進 metadata，
          // GroupChatWindow watch riskResult → report-risk → RiskMonitor 紅盾（鏡像 1-1，§0.7b）；
          // Phase 20.6: 群組檔案內容 L1+L2 雙層掃描（官方版 ext.antiFraud；社群版不掃）
          const legacyGroupRiskResult: L2Result | undefined = await ext.antiFraud.inspectInbound({
            site: 'group-1to1', sender: senderPublicKeyBase64, type: messageData.type, content: messageData.content,
            fileData: messageData.fileData,
          });

          // 儲存群組訊息到 storage（去重：防止同一訊息被加密和明文路徑雙重處理）
          if (messageData.content && messageData.id && isStorageInitialized() && markGroupMessageProcessed(messageData.id)) {
            const conversationId = getConversationIdForPeer(senderPublicKeyBase64);
            const localNow = Date.now();
            const maxDrift = 5 * 60 * 1000;
            const receivedTs = messageData.timestamp || localNow;
            const now = Math.abs(receivedTs - localNow) <= maxDrift ? receivedTs : localNow;
            storageSaveMessage({
              id: messageData.id,
              conversationId,
              senderPubkey: senderPublicKeyBase64,
              content: messageData.content,
              type: messageData.type || 'text',
              createdAt: now,
              ttl: messageData.ttl ?? 0,
              expiresAt: messageData.ttl && messageData.ttl > 0 ? now + messageData.ttl * 1000 : null,
              readAt: null,
              isOutgoing: false,
              status: 'delivered',
              groupIds: viewGroupIds,
              ...(messageData.fileData || messageData.voiceData || legacyGroupRiskResult ? {
                metadata: JSON.stringify({
                  fileData: messageData.fileData,
                  voiceData: messageData.voiceData,
                  riskResult: legacyGroupRiskResult,
                }),
              } : {}),
            }).catch((err) => console.error('[AppProvider] Failed to save encrypted group message:', err));

            if (group) {
              useGroupStore.getState().incrementUnread(groupId);
            }
            devLog('[AppProvider] Encrypted group message saved:', messageData.id);
          }

          // 自癒：群組明文帶 senderName → 回填成員暱稱
          // （舊版建群不寫成員暱稱，UI 只能顯示 pubkey 切片亂碼；收到訊息即修復）
          if (messageData.senderName && typeof messageData.senderName === 'string') {
            useGroupStore.getState().updateMemberNickname(groupId, senderPublicKeyBase64, messageData.senderName);
          }

          // 通知群組視圖刷新
          window.dispatchEvent(new CustomEvent('aegis:group-message', {
            detail: { groupId, groupIds: viewGroupIds },
          }));
          return;
        }

        // ====== 一般 1-1 訊息（原有邏輯；封鎖已在解密後統一擋掉） ======
        // AegisPay：轉帳狀態控制訊息 — 更新對側卡片狀態，不落地成可見訊息
        // 排程付款狀態更新（真鏈上，→ 收款方卡片）：
        //   payment_executed = 到期已上鏈；payment_failed = 餘額不足/過期/revert；payment_cancelled = 付款方冷卻期取消
        //   （官方版 ext.payments；社群版沒有 → 這些型別不是可見訊息，下面 visibleTypeOf 會丟掉）
        if (ext.payments?.onDirectControl({
          type: messageData.type as string, txId: messageData.txId, dueAt: (messageData as { dueAt?: unknown }).dueAt,
          friendId: friend.id, me: publicKey,
        })) {
          return;
        }
        // 控制訊息到這裡都已各自 return（agent_status／群組金鑰／file_manifest／recovery_shard／轉帳狀態）。
        //   剩下的是要顯示的訊息，只認得 DIRECT_VISIBLE_TYPES（見 visibleTypeOf）
        {
          const visible = visibleTypeOf(messageData.type, DIRECT_VISIBLE_TYPES);
          if (!visible) {
            if (typeof messageData.content !== 'string' || messageData.content.length === 0) {
              diagLog('[DIAG:RECV] unknown control type, not shown:', String(messageData.type).slice(0, 32));
              return;
            }
            messageData.type = 'text';
          }
        }
        // 對方沒等到回條會重送同一則（p2pSend 等回條，群星 B33）：已經收過 → 只再回一次條，不再掃描、不再多一個氣泡、
        //   不再算一次未讀（群星 B31）。記憶體裡有（剛收到）或資料庫裡有（重開過 App）都算
        if (typeof messageData.id === 'string' && messageData.id
            && ((useChatStore.getState().messages[friend.id] ?? []).some((m) => m.id === messageData.id)
              || (isStorageInitialized() && await hasMessageFrom(messageData.id, senderPublicKeyBase64)))) {
          diagLog('[DIAG:RECV] duplicate 1:1 message (already received) → receipt only:', messageData.id.slice(0, 24));
          sendDirectReceipt(senderPublicKeyBase64, messageData.id);
          return;
        }
        devLog('[AppProvider] Decrypted message from:', friend.name, 'type:', messageData.type);
        if (messageData.type === 'voice') {
          devLog('[AppProvider] Voice message voiceData:', JSON.stringify(messageData.voiceData));
        }

        // L2 規則引擎評估訊息風險（官方版 ext.antiFraud；社群版不評估 → undefined）
        const riskResult = await ext.antiFraud.inspectInbound({
          site: 'direct', sender: senderPublicKeyBase64, scoreKey: friend.publicKey, type: messageData.type,
          content: messageData.content, fileData: messageData.fileData,
        });

        // 建立訊息物件並儲存到 store
        const newMessage = {
          id: messageData.id,
          senderId: friend.id,
          content: messageData.content,
          timestamp: messageData.timestamp || Date.now(),
          type: messageData.type,
          isRead: false,
          isBurned: false,
          ttl: messageData.ttl,
          encrypted: true,
          riskResult,
          isLoading: messageData.isLoading,
          ...(messageData.type === 'voice' && messageData.voiceData ? { voiceData: messageData.voiceData } : {}),
          ...(messageData.type === 'file' && messageData.fileData ? { fileData: messageData.fileData } : {}),
          ...(messageData.type === 'payment' && messageData.paymentData ? { paymentData: messageData.paymentData } : {}),
        };

        await receiveMessage(friend.id, newMessage);
        devLog('[AppProvider] Message saved to store');
        // 存好了 → 回條給對方（群星 B33），對方才停止重送
        if (typeof messageData.id === 'string' && messageData.id) sendDirectReceipt(senderPublicKeyBase64, messageData.id);
      } catch (err) {
        const errMsg = (err as Error)?.message || String(err);
        diagLog('[DIAG:RECV:ERROR] Failed to process ENCRYPTED_MESSAGE:', errMsg);

        // ponytail: one repair request per peer per minute; if AEAD keeps failing,
        // the peer's existing PREKEY_REQUEST handler rebuilds the X3DH session.
        if (/aead|decryption failed|no session with this sender/i.test(errMsg) && getFriendByPublicKey(senderPublicKeyBase64)) {
          const now = Date.now();
          const last = aeadRepairRequestRef.current.get(senderPublicKeyBase64) ?? 0;
          if (now - last > 60_000) {
            aeadRepairRequestRef.current.set(senderPublicKeyBase64, now);
            // 附上我方最新 bundle：對方存的可能是舊的（blob 恢復），沒附的話它重建仍用舊 SPK → 永遠 aead
            sendPrekeyRequest(senderPublicKeyBase64, signedPreKey
              ? { signedPreKey: signedPreKey.publicKeyBase64, signature: signedPreKey.signatureBase64 } : null)
              .catch((err) => console.error('[AppProvider] prekey request not sent:', err));
            diagLog('[DIAG:CRYPTO] Requested session repair after decrypt failure for', senderPublicKeyBase64.slice(0, 16));
          }
        }
      }
    };

    // 儲存到 ref，讓 P2P (handleWebRTCMessage) 也能使用
    processEncryptedMessageRef.current = processEncryptedMessage;

    // drain：handler 未就緒時 P2P 收到的 frame 先進 buffer，現在補處理（修「收到卻沒解密」單向失敗）
    if (pendingInboundP2PRef.current.length > 0) {
      const drained = pendingInboundP2PRef.current;
      pendingInboundP2PRef.current = [];
      console.error(`[AppProvider] P2P: draining ${drained.length} buffered inbound frame(s) after decrypt handler ready`);
      for (const { peer, payload } of drained) {
        processEncryptedMessage(peer, payload).catch((err) =>
          diagLog('[DIAG:P2P:RECV:ERROR] drain:', (err as Error)?.message || String(err)));
      }
    }

    // Phase 32: MQTT 訂閱已移除 — 所有訊息內容走 P2P DataChannel
    // processEncryptedMessage 保留供 handleWebRTCMessage 使用

    return () => {
      processEncryptedMessageRef.current = null;
    };
    // 依賴不含 mqtt：handler 不用 mqtt，且絕不能因 MQTT 連線變化 teardown decrypt handler
  }, [cryptoReady, publicKey, decrypt, encrypt, getFriendByPublicKey, receiveMessage, signedPreKey]);

  // 群組訊息內容走 P2P DataChannel — 由 processEncryptedMessage 統一處理

  // 全域監聽 DELETE_MESSAGE - 遠端刪除訊息（開源第 4 步：DIRECT_SEALED kind delete，封給我的身分金鑰、寄件人簽章 ——
  //   以前明文，營運方能冒名刪我手上他寄的訊息）
  useEffect(() => {
    if (!cryptoReady) return;

    devLog('[AppProvider] Setting up sealed delete listener...');

    const unsubscribe = onDirect('delete', (senderPublicKeyBase64, body) => {
      try {
        const messageId = body.messageId;
        if (typeof messageId !== 'string' || !messageId || messageId.length > 128) return;

        diagLog('[DIAG:DELETE:RECV] from=' + senderPublicKeyBase64.slice(0, 16) + ' messageId=' + messageId);

        // 群組訊息的刪除只走群組主題上的 group_sealed（W2：寄件人簽章、目前這一代金鑰，見 groupControlRoute）
        if (body.groupId !== undefined) {
          diagLog('[DIAG:DELETE:REJECT] group delete over the inbox ignored (group_sealed only)');
          return;
        }

        // 檢查發送者是否為好友
        const friend = getFriendByPublicKey(senderPublicKeyBase64);
        if (!friend) {
          diagLog('[DIAG:DELETE:REJECT] unknown sender: ' + senderPublicKeyBase64.slice(0, 16));
          return;
        }

        // Ownership check: only allow sender to delete their own messages
        const { messages, burnMessage } = useChatStore.getState();
        const allMsgs = Object.values(messages).flat();
        const targetMsg = allMsgs.find(m => m.id === messageId);
        if (!targetMsg) {
          diagLog('[DIAG:DELETE:NOTFOUND] messageId=' + messageId + ' allMsgs=' + allMsgs.length);
          return;
        }
        // 訊息 senderId 儲存為 friend.id（如 "friend-XXX"），不是 raw publicKey
        // 對照必須允許 friend.id 或 raw publicKey（舊訊息）
        if (targetMsg.senderId !== friend.id && targetMsg.senderId !== senderPublicKeyBase64) {
          diagLog('[DIAG:DELETE:REJECT:OWNER] senderId=' + (targetMsg.senderId?.slice(0, 16) || 'null') + ' vs friendId=' + friend.id.slice(0, 16) + ' vs claimer=' + senderPublicKeyBase64.slice(0, 16));
          return;
        }

        burnMessage(messageId);

        diagLog('[DIAG:DELETE:BURNED] messageId=' + messageId);
      } catch (err) {
        diagLog('[DIAG:DELETE:ERROR]', err);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [cryptoReady, getFriendByPublicKey]);

  // 全域監聽 PROFILE_UPDATE - 好友個人資料更新（開源第 4 步：DIRECT_SEALED kind profile，封給我的身分金鑰、他簽章、
  //   iat 比他上一則新 —— 以前明文，broker 看得到每個人的名字與頭像、營運方能冒名改掉我手上好友的名字）
  useEffect(() => {
    if (!cryptoReady) return;

    devLog('[AppProvider] Setting up sealed profile listener...');

    const unsubscribe = onDirect('profile', (senderPublicKeyBase64, body) => {
      try {
        const displayName = typeof body.displayName === 'string' ? cleanPeerName(body.displayName, '') : '';
        const avatar = typeof body.avatar === 'string' && body.avatar.length <= 400_000 ? body.avatar : '';

        // 我加了他、正在等他確認：他收下我的 X3DH_INIT 會回這則，帶著那封 INIT 的 ephemeral —— 對得上我送的那封
        //   才算確認（審查 M1）。一般的個人資料更新、回舊 INIT 的都不算。只拿掉等待標記，不會因此多加任何人
        if (publicKey && typeof body.initEph === 'string') {
          usePendingFriendStore.getState().confirm(publicKey, senderPublicKeyBase64, body.initEph);
        }

        // 檢查發送者是否為好友
        const friend = getFriendByPublicKey(senderPublicKeyBase64);

        // 如果好友不存在，可能是時序問題（PROFILE_UPDATE 比 addFriend 先到）
        // 使用遞增延遲多次重試
        if (!friend) {
          const retryUpdate = (attempt: number) => {
            const delay = attempt * 500;
            setTimeout(() => {
              const retryFriend = useChatStore.getState().getFriendByPublicKey(senderPublicKeyBase64);
              if (retryFriend) {
                useChatStore.getState().updateFriendProfile(senderPublicKeyBase64, { displayName, avatar });
              } else if (attempt < 4) {
                retryUpdate(attempt + 1);
              }
            }, delay);
          };
          retryUpdate(1);
          return;
        }

        // 更新好友的個人資料
        updateFriendProfile(senderPublicKeyBase64, { displayName, avatar });
      } catch (err) {
        console.error('[AppProvider] Failed to process sealed profile update:', err);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [cryptoReady, getFriendByPublicKey, updateFriendProfile, publicKey]);

  // （PROFILE_REQUEST 拿掉了：沒有人送。PUSH_SUBSCRIPTION_UPDATE 拿掉了（開源第 4 步）：推播訂閱不再經 broker 交給好友，
  //   只登記在 chat 伺服器（services/webPush.ts，帳戶簽章），寄件人叫 /api/push/notify）

  /**
   * DIRECT_SEALED 的收件（開源第 4 步，services/directSignal.ts）：1 對 1 的所有信令（通話、DataChannel、個人資料、預備金鑰請求、
   * 刪除）都封給我的身分金鑰。用寄件人在我這台存的身分金鑰（好友、同群成員）驗簽章；不認得的人只能送 DataChannel 信令
   * （webrtc 再看群組金鑰證明、先收著）；封鎖的人一律不拆。換帳號／登出時停掉
   */
  useEffect(() => {
    if (!cryptoReady || !publicKey) return;
    const me = publicKey;
    const stop = startDirectSignal({
      me,
      storedIdentity: async (pk) => {
        await waitForLocalLists();
        const friend = useChatStore.getState().getFriendByPublicKey(pk) ?? await findFriendSettled(pk);
        if (friend) return friend.publicKey;
        return useGroupStore.getState().groups.some((g) => g.members.some((m) => m.publicKey === pk)) ? pk : null;
      },
      // 封鎖名單查不了 → 當成封鎖（審查 L5）
      isBlocked: (pk) => isBlacklisted(pk).catch(() => true),
      marks: localStorageMarks(me),
    });
    return stop;
  }, [cryptoReady, publicKey]);

  /**
   * MQTT token 只拿得到自己的群組主題與好友的 presence 主題（伺服器按簽過名的清單發 ACL，對應群星 A8）。
   * 群組是主題 id（W3：群組引擎的主題表，每個群目前這一代＋重疊期的上一代；gid 不上 broker）。
   * presence（W4）：presenceService 給的確切好友主題 mist/user/<他>/presence/<tag> 與我自己的 tag（發布權）——
   *   不再送公鑰清單（peers）：以前 token 範圍列了誰，就拿得到誰的 presence，同群組的非好友、甚至任何知道公鑰的人都看得到。
   *   同群組但不是好友的人不在這裡：他們的「在線」看群組主題上的 here 與 P2P 的狀態（memberPresence）。
   * 名單、主題表、presence 都真的載入完才設，之後每次變動再設（mqtt 端照範圍調整訂閱，範圍多了 token 給不起的才換 token 重連）。
   */
  //   群組依重要性排（守護群組、最近有動靜的在前），目前這一代的主題在前、上一代的在後：超過 token 上限（50）時留前面的，
  //   見 mqttCredential.rankScopeGroups／rankScopeTopics
  const groupRankList = useGroupStore((state) => rankScopeGroups(state.groups).join(','));
  // 引擎遲遲沒給主題表（還在重驗鏈、或起不來）：名單載完 3 秒後先用空的群組主題設範圍 —— 好友的 presence 不要跟著一直等
  //   （審查 W3 L7）；主題表一到，範圍多了群組主題，照常 250ms 後換 token
  const [groupTopicsLate, setGroupTopicsLate] = useState(false);
  useEffect(() => {
    setGroupTopicsLate(false);
    if (groupTopics !== null || !isLoaded || !isGroupsLoaded) return;
    const timer = setTimeout(() => setGroupTopicsLate(true), 3_000);
    return () => clearTimeout(timer);
  }, [groupTopics, isLoaded, isGroupsLoaded]);
  const scopeTopics = groupTopics ?? (groupTopicsLate ? [] : null);
  const groupTopicList = scopeTopics ? rankScopeTopics(groupRankList ? groupRankList.split(',') : [], scopeTopics).join(',') : null;
  // presence 服務遲遲沒起來（存檔載不起來、等好友清單）：名單載完 3 秒後先用「沒有 presence」設範圍 —— 群組主題不要跟著等
  const [presenceLate, setPresenceLate] = useState(false);
  useEffect(() => {
    setPresenceLate(false);
    if (presenceScope !== null || !isLoaded) return;
    const timer = setTimeout(() => setPresenceLate(true), 3_000);
    return () => clearTimeout(timer);
  }, [presenceScope, isLoaded]);
  const presenceReady = presenceScope !== null || presenceLate;
  const presenceTag = presenceScope?.tag ?? null;
  const presenceTopicList = (presenceScope?.topics ?? []).join(',');
  useEffect(() => {
    if (!isLoaded || !isGroupsLoaded || groupTopicList === null || !presenceReady) return;
    mqttService.setAclScope(groupTopicList ? groupTopicList.split(',') : [],
      { tag: presenceTag, topics: presenceTopicList ? presenceTopicList.split(',') : [] }, publicKey);
  }, [isLoaded, isGroupsLoaded, groupTopicList, presenceReady, presenceTag, presenceTopicList, publicKey]);

  // 註：新好友的 PROFILE_UPDATE 已在 chatStore.addFriend 中直接發送
  // 不需要在這裡用 useEffect 監聯，避免重複發送

  // 好友的 presence 主題照範圍由 mqtt 訂／退訂（W4，_syncPresenceTopics）；這裡只在連上時清掉過期的待發送訊息
  useEffect(() => {
    if (mqtt.isConnected) cleanupOldPendingMessages();
  }, [mqtt]);

  /**
   * 名冊多了人（鏈上套上一筆 add、加入一個群、我自己加的）→ 主動連上他、把給他的待送送出去（對應群星 64f3d211，
   * 多人模擬 S3）。以前只有好友上線、健康檢查會連 —— 非好友成員之間沒人發起：對方的 offer 若比「他加入群組」早到
   * 又被當陌生人丟掉（webrtc 現在先收著，見 heldOffers），他那邊排隊給我的群訊就一直卡著。
   * 規則跟 presence 一樣：pubkey 較大的一方發起；較小的一方只有手上有東西要送給他時才自己連（glare 由 Perfect
   * Negotiation 收斂）。好友清單變動也再判斷一次收著的 offer。
   */
  useEffect(() => {
    if (!publicKey) return;
    const reachNewMember = async (pk: string) => {
      // 我封鎖的人（同群的也是）不主動連：他對我發的 offer 本來就不收（useWebRTC inboundPolicy）
      if (await isBlacklisted(pk).catch(() => false)) return;
      if (webrtcService.isDataChannelOpen(pk)) {
        void flushQueueForPeer(pk);
        return;
      }
      const pending = await getQueueSize(pk);
      const iInitiate = publicKey > pk;
      if (pending === 0 && !iInitiate) return;
      diagLog('[DIAG:P2P] new group member → connect:', pk.slice(0, 16), `pending=${pending} initiator=${iInitiate}`);
      webrtcService.connect(pk).catch((err) => devLog('[AppProvider] connect to new member failed:', pk.slice(0, 8), err));
    };
    /**
     * 同群成員的 here（他剛連上，W4：非好友看不到彼此的 presence）→ 跟「名冊多了人」同一套：通道開著就把待送的送出去，
     * 沒開的話我有東西要給他、或我是發起方才連。每個人 10 秒最多一次（一次連上，他在每個群各發一則 here）
     */
    const reachedAt = new Map<string, number>();
    reachPeerRef.current = (pk: string) => {
      const now = Date.now();
      if (now - (reachedAt.get(pk) ?? 0) < 10_000) return;
      reachedAt.set(pk, now);
      if (reachedAt.size > 512) reachedAt.delete(reachedAt.keys().next().value as string);
      diagLog('[DIAG:P2P] group member online (here):', pk.slice(0, 16));
      void reachNewMember(pk);
    };
    let known = new Set(groupMemberKeys(useGroupStore.getState().groups, publicKey));
    let loaded = useGroupStore.getState().isLoaded;
    /**
     * 名冊上少了這個人 → 3 秒後再確認（記憶體名冊仍沒有他、資料庫 group_members 也沒有）才清他的群組待送（程式碼審查
     * MEDIUM）：groupStore 先改記憶體再寫資料庫，整份重載（例如回到前景）可能用寫入前的快照暫時蓋掉剛加的成員 ——
     * 那時清掉，給他的群訊就永遠刪了。真的踢人／離開時 3 秒後兩邊都沒有他。沒清到的照樣不會送出去（flush 只送給同群的）
     */
    const dropTimers = new Set<ReturnType<typeof setTimeout>>();
    const dropIfStillGone = (pk: string) => {
      const timer = setTimeout(() => {
        dropTimers.delete(timer);
        if (known.has(pk)) return;
        void isGroupMemberAnywhere(pk)
          .then((stillListed) => { if (!stillListed) void dropGroupOutboxFor(pk); })
          .catch(() => { /* 查不到就不清：只跳過不刪 */ });
      }, 3_000);
      dropTimers.add(timer);
    };
    const unsubGroups = useGroupStore.subscribe((state) => {
      const next = groupMemberKeys(state.groups, publicKey);
      // 剛從本機載入的不算「新加入」（loadOutbox、presence、健康檢查會處理）；載入／重設時也不算「少了人」
      const steady = loaded && state.isLoaded;
      const added = steady ? newlyAdded(known, next) : [];
      // 名冊上再也找不到的人（被踢、離開、我退群、群被刪）→ 給他的群組待送清掉（對應群星 6d381b43）
      const gone = steady ? newlyAdded(new Set(next), known) : [];
      known = new Set(next);
      loaded = state.isLoaded;
      webrtcService.recheckHeldOffers();
      for (const pk of added) void reachNewMember(pk);
      for (const pk of gone) dropIfStillGone(pk);
    });
    const unsubFriends = useChatStore.subscribe((state, prev) => {
      if (state.friends === prev.friends) return;
      webrtcService.recheckHeldOffers();
      // 刪好友：1 對 1 的待送 removeContact 已清；他也不是同群成員的話，殘留的群組待送一起清
      if (!state.isLoaded || !prev.isLoaded) return;
      const stillFriends = new Set(state.friends.map((f) => f.publicKey));
      for (const f of prev.friends) {
        if (!stillFriends.has(f.publicKey) && !known.has(f.publicKey)) dropIfStillGone(f.publicKey);
      }
    });
    return () => {
      unsubGroups();
      unsubFriends();
      for (const t of dropTimers) clearTimeout(t);
      reachPeerRef.current = () => {};
    };
  }, [publicKey]);

  // 群組主題的訂閱（部署前審查 BLOCKER：以前只在建群／收邀請那一刻訂一次）：W3 起全部照 token 範圍（上面的 setAclScope）——
  //   mqtt 在範圍變了、每次連上（CONNACK）時把範圍裡的主題訂齊、不在範圍裡的退訂；broker 丟了 session 時全部重訂

  /*
   * 以前這裡收明文的 GROUP_INVITE／GROUP_INFO_UPDATED／GROUP_MEMBER_ADDED／REMOVED／LEFT／GROUP_ROLE_UPDATED（誰都能在
   * 群組頻道上冒用成員發、營運方也能插）：全部拿掉。名冊、角色、資訊、刪群只由群組引擎套上的簽章鏈決定；邀請是封給身分
   * 金鑰的 invite（附整條鏈、對照伺服器 log 確認），離開／踢人後的換金鑰由鏈上的 admin 寫 rekey／remove commit。
   */

  // （CHECK_IN_REMINDER 的處理拿掉了（W4）：那是一則明文帶 groupId 的收件箱訊息，broker 看得到誰在哪個守護群組裡被提醒，
  //   App 裡也早就沒有人送。守護人的報平安提醒走 P2P 加密的 checkIn 訊息（上面的 ENCRYPTED_MESSAGE 路由），被守護者這台
  //   另外有官方版自己的本機排程提醒，都不經過 broker）

  // Phase 5: 監聯好友上線，重發待發送訊息（W4：presence 只有好友才有、而且是驗過的；同群組的非好友上線走 here → reachPeerRef）
  useEffect(() => {
    if (!mqtt.isConnected) return;

    devLog('[AppProvider] Setting up presence change listener for resend...');

    const unsubscribe = mqttService.onPresenceChange(async (friendPublicKey, isOnline) => {
      // 維護 online 集合給 peerHealthMonitor watchdog 判斷(上線 add、離線 delete)
      if (isOnline) onlinePeersRef.current.add(friendPublicKey);
      else onlinePeersRef.current.delete(friendPublicKey);

      if (!isOnline) return; // 只處理上線事件

      // 只連「現在還認得的人」（好友＋同群成員，對應群星 e8724711）。被踢、離開、刪好友之後，broker 的持久 session
      //   還留著當時的 presence 訂閱 → 以前會一直對已經不同群的人發 offer（對方當陌生人丟掉）
      const known = knownPeerKeys(useChatStore.getState().friends.map((f) => f.publicKey),
        useGroupStore.getState().groups, publicKeyRef.current);
      if (!known.includes(friendPublicKey)) return;
      // 我封鎖的人上線不主動連（他對我發的 offer 本來就不收）
      if (await isBlacklisted(friendPublicKey).catch(() => false)) return;

      // 已有可送 DataChannel → 連線健康，不打擾。
      // 用 live service 檢查，避免 React state 只看 connectionState=connected 但 DC 未 open。
      if (webrtcService.isDataChannelOpen(friendPublicKey)) return;

      // presence 只是「對方上線」提示，不應拆掉仍活著的 PeerConnection。拆連線會和
      // peerHealthMonitor 的舊 bug 同源：雙方在不同 timer/事件上互拆 PC → 世代錯位。
      // 這裡與 watchdog 使用同一個規則：只有 pubkey 較大的一方主動 connect/re-offer，
      // 較小方等待 offer。connect() 內部會判斷 live PC 原地重開 DC，只有 failed/closed 才重建。
      const willInitiate = !!publicKeyRef.current && publicKeyRef.current > friendPublicKey;
      if (!willInitiate) {
        devLog(`[AppProvider] Friend ${friendPublicKey.slice(0, 8)} online; waiting for initiator offer`);
        return;
      }

      webrtcService.connect(friendPublicKey).catch((err) => {
        devLog(`[AppProvider] connectPeer failed for ${friendPublicKey.slice(0, 8)}:`, err);
      });
    });

    return () => {
      unsubscribe();
    };
  }, [mqtt]);

  // MQTT 連線
  const connectMqtt = useCallback(async () => {
    try {
      await mqtt.connect();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'MQTT connection failed';
      setError(errorMsg);
    }
  }, [mqtt]);

  // 發送訊息給用戶
  const sendToUser = useCallback(
    (recipientPublicKey: string, type: MessageType, payload: unknown) => {
      mqtt.sendToUser(recipientPublicKey, type, payload);
    },
    [mqtt]
  );

  // 訂閱訊息
  const subscribeMessage = useCallback(
    (type: MessageType | '*', callback: (message: MqttMessage) => void) => {
      return mqtt.subscribe(type, callback);
    },
    [mqtt]
  );

  // WebRTC 連線
  const connectPeer = useCallback(
    async (remotePublicKey: string) => {
      if (!publicKey) {
        throw new Error('Identity not initialized');
      }
      await webrtc.connect(remotePublicKey);
    },
    [publicKey, webrtc]
  );

  // 發送到對等端
  const sendToPeer = useCallback(
    (remotePublicKey: string, data: string | ArrayBuffer) => {
      return webrtc.send(remotePublicKey, data);
    },
    [webrtc]
  );

  // 檢查是否已連線
  const isConnectedTo = useCallback(
    (remotePublicKey: string) => {
      return webrtc.isConnectedTo(remotePublicKey);
    },
    [webrtc]
  );

  // 加密訊息
  const encryptMessage = useCallback(
    async (recipientPublicKey: string, plaintext: string) => {
      return encrypt(recipientPublicKey, plaintext);
    },
    [encrypt]
  );

  // 解密訊息
  const decryptMessage = useCallback(
    async (senderPublicKey: string, ciphertext: unknown) => {
      return decrypt(senderPublicKey, ciphertext as RatchetMessage);
    },
    [decrypt]
  );

  // 取得已連線的 peers 公鑰列表
  const activePeers = webrtc.connectedPeers.map((p) => p.publicKeyBase64);

  // 進入聊天模式（觸發重型資源載入）
  const enterChatMode = useCallback(() => {
    if (!isInChatMode) {
      devLog('[AppProvider] enterChatMode called');
      setIsInChatMode(true);
    }
  }, [isInChatMode]);

  // VoiceCall 初始化 + 帳號恢復 session repair：監聽 MQTT 底層 stateChange
  // 不依賴 React state 的 mqtt.isConnected（Post-init effect 有 stale closure 問題）
  useEffect(() => {
    const tryRepair = () => {
      if (localStorage.getItem('aegis_session_repair_needed') === '1') {
        console.error('[AppProvider] MQTT connected → triggering session repair');
        void repairMissingSessions();
      }
    };
    const unsub = mqttService.onStateChange((newState) => {
      if (newState === ConnectionState.CONNECTED && publicKey) {
        if (!voiceCallService.localPublicKey) {
          console.error('[AppProvider] MQTT connected event → initializing VoiceCall');
          voiceCallService.initialize(publicKey);
        }
        tryRepair();
      }
    });
    // 也檢查當前狀態（可能 MQTT 已經連上了）
    if (mqttService.isConnected() && publicKey) {
      if (!voiceCallService.localPublicKey) {
        console.error('[AppProvider] MQTT already connected → initializing VoiceCall');
        voiceCallService.initialize(publicKey);
      }
      tryRepair();
    }
    return unsub;
  }, [publicKey, repairMissingSessions]);

  // E2E: keep __AEGIS_STATUS__ in sync with live MQTT state
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const prev = (window as any).__AEGIS_STATUS__;
      (window as any).__AEGIS_STATUS__ = {
        ...(prev || {}),
        mqttConnected: mqtt.isConnected,
        hasPublicKey: !!publicKey,
        keysLocked,
        voiceCallReady: !!voiceCallService.localPublicKey,
      };
    }
  }, [mqtt.isConnected, publicKey, keysLocked]);

  // Phase 35a/b: 單一裝置綁定
  // 進入聊天模式且 identity 就緒後 → claim device + 啟動 heartbeat + 訂閱 kick 信號
  // E2E 測試模式預設跳過（避免多帳號測試互相搶占）；
  // 但設 AEGIS_E2E_DEVICE_BINDING=true 可在 E2E 下實測真實踢人流程（test 28 用）。
  useEffect(() => {
    if (!isInChatMode || !identity || !publicKey) return;
    if (typeof localStorage !== 'undefined'
        && localStorage.getItem('AEGIS_E2E_TEST') === 'true'
        && localStorage.getItem('AEGIS_E2E_DEVICE_BINDING') !== 'true') {
      devLog('[AppProvider] Phase35: skipped (E2E test mode)');
      return;
    }

    let cancelled = false;

    // 觸發被踢流程：清除本機金鑰 + dispatch UI 事件
    const onKicked = async () => {
      console.error('[AppProvider] Phase35: device kicked — wiping keys');
      await wipeLocalKeys();
      window.dispatchEvent(new CustomEvent('aegis:device-kicked'));
    };

    (async () => {
      try {
        const result = await claimDevice(identity);
        if (cancelled) return;
        devLog('[AppProvider] Phase35: claim result', result);

        if (result.success) {
          startHeartbeatLoop(identity, onKicked);
          // 伺服器只給帳號的活躍裝置 kick 主題（活躍裝置是別台時整張拒絕）：claim 之前拿的 token 沒有 kick、
          //   或剛被拒在冷卻 → 現在換／現在連
          mqttService.onDeviceClaimed();
          if (!mqttService.isConnected()) void mqttService.connect(publicKey).catch((err) => console.error('[AppProvider] Phase35: connect after claim failed', err));
        } else if (result.error?.includes('403')) {
          devLog('[AppProvider] Phase35: skip (account not yet registered)');
        }
      } catch (err) {
        console.error('[AppProvider] Phase35: claim failed', err);
      }
    })();

    // Phase 35b: 監聽 MQTT 即時 kick 信號（不可信來源 → heartbeat 驗證）
    const onKickSignal = async () => {
      const confirmed = await handleKickSignal(identity);
      if (confirmed) {
        await onKicked();
      }
    };
    window.addEventListener('aegis:device-kick-signal', onKickSignal);

    return () => {
      cancelled = true;
      stopHeartbeatLoop();
      window.removeEventListener('aegis:device-kick-signal', onKickSignal);
    };
  }, [isInChatMode, identity, publicKey]);

  const value: AppContextValue = {
    // 狀態
    cryptoReady,
    hasIdentity,
    keysLocked,
    publicKey,
    storageReady,
    mqttConnected: mqtt.isConnected,
    activePeers,
    isInitializing,
    error,
    isInChatMode,

    // Crypto 金鑰
    signedPreKey: signedPreKey ? {
      publicKeyBase64: signedPreKey.publicKeyBase64,
      signatureBase64: signedPreKey.signatureBase64,
    } : null,

    // Crypto 操作
    generateIdentity,
    getPreKeyBundle,
    unlockAndReloadKeys,

    // MQTT 操作
    connectMqtt,
    disconnectMqtt: mqtt.disconnect,
    sendToUser,
    subscribeMessage,

    // WebRTC 操作
    connectPeer,
    sendToPeer,
    disconnectPeer: webrtc.disconnect,
    isConnectedTo,

    // 加解密
    encryptMessage,
    decryptMessage,

    // 聊天模式控制
    enterChatMode,

    // 會話管理
    createSession,
    acceptSession,
  };


  // 官方版：外掛宿主（AegisGuard 外掛）；社群版：直接渲染
  const ProviderWrapper = ext.ui.ProviderWrapper;
  return (
    <AppContext.Provider value={value}>
      <ProviderWrapper
        myPublicKey={!keysLocked ? (publicKey ?? undefined) : undefined}
        encryptToJson={encryptToJson}
      >
        {children}
      </ProviderWrapper>
    </AppContext.Provider>
  );
}

/**
 * 使用 App Context 的 Hook
 */
export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}

export default AppProvider;

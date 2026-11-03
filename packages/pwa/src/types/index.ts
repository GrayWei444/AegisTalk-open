// Mist Demo Types

/** 信任等級 */
export type TrustLevel = 'verified' | 'unverified';

/** Web Push 訂閱資料（用於離線推播） */
export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

export interface Friend {
  id: string;
  publicKey: string; // Base64 公鑰
  name: string;
  avatar: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  online: boolean;
  trustLevel: TrustLevel; // 🟢 已驗證 / 🟡 未驗證
  addedAt: number; // 加入時間
  pushSubscription?: PushSubscriptionData; // 推播訂閱資料（加好友時 P2P 交換）
  signedPreKey?: string; // 對方 X3DH signed pre-key（Base64）— 供帳號恢復後重建 session
  signature?: string; // 對方 X3DH signed pre-key 簽章（Base64）
}

export interface Message {
  id: string;
  senderId: string;
  content: string;
  timestamp: number;
  type: 'text' | 'image' | 'file' | 'voice' | 'payment';
  isRead: boolean;
  isBurned: boolean;
  ttl?: number; // Time to live in seconds
  encrypted?: boolean; // 是否為加密訊息
  isLoading?: boolean; // 是否為載入中狀態（顯示轉圈動畫）
  /** 視圖群組：此訊息屬於哪些群組（可同時屬於多個群組） */
  groupIds?: string[];
  /** 訊息的對話對象公鑰（用於視圖群組的訊息路由） */
  recipientPubkey?: string;
  /** L2 風險評估結果 */
  riskResult?: L2Result;
  /** 我送的群訊沒送出去（等金鑰；資料庫 status 'failed'）：泡泡上顯示「未送出・重送」 */
  sendStatus?: 'failed';
  /** 語音訊息元資料 (type: 'voice' 時使用) */
  voiceData?: {
    /** 語音時長（秒） */
    duration: number;
    /** MIME 類型 (audio/webm, audio/mp4 等) */
    mimeType?: string;
    /** 語音轉文字結果（content 為顯示文字，transcript 為原始辨識結果） */
    transcript?: string;
    /** 波形數據（用於顯示波形動畫，可選） */
    waveform?: number[];
  };
  /** 檔案訊息元資料 (type: 'file' 時使用) */
  fileData?: {
    /** 檔案名稱 */
    name: string;
    /** MIME 類型 */
    mimeType: string;
    /** 檔案大小 (bytes) */
    size: number;
    /** 圖片/檔案說明文字 */
    caption?: string;
    /**
     * 大檔分塊傳輸的 fileId（指向 IndexedDB blob store）。
     * 若無此欄位，則 content 為 base64 dataUrl（舊路徑，向後相容）。
     * 有此欄位時 content 通常為 caption 或空字串，blob 從 fileBlobStore.getBlob(fileId) 取。
     */
    fileId?: string;
  };
  /** 轉帳訊息元資料 (type: 'payment' 時使用，AegisPay Phase 0) */
  paymentData?: PaymentData;
}

/** 聊天內轉帳卡片資料（AegisPay Phase 0 Mock Shell） */
export interface PaymentData {
  /** 交易 ID（即時=鏈上 tx；排程=排程 id） */
  txId: string;
  amount: number;
  note?: string;
  /**
   * 真鏈上模型（A2）：
   * - completed = 低風險即時轉帳，已上鏈
   * - scheduled = 冷卻期排程中（付款方可取消）
   * - executed  = 排程到期已執行上鏈
   * - failed    = 排程失敗（餘額不足/過期/鏈上 revert）
   * - cancelled = 付款方於冷卻期取消（鏈上撤銷授權）
   * - awaiting_activation = G6：收款方尚未開通（無錢包可上鏈）→ 本機 pending intent，
   *   對方開通後 sweep 自動依「送出當下的風控決策」執行（即時 or 排程）。非鎖款（同排程語意）。
   */
  status: 'completed' | 'scheduled' | 'executed' | 'failed' | 'cancelled' | 'awaiting_activation';
  /** 轉帳當下的風控分數（0-100，供顯示/審計） */
  riskScore?: number;
  /** 風控服務費（USDC，只向付款方收，→ AegisPay 收費錢包） */
  fee?: number;
  /** 排程到期時間（unix 秒；即時付款無此欄） */
  dueAt?: number;
  /** 排程 id（scheduled/executed/failed/cancelled 用於取消/查狀態） */
  scheduleId?: string;
  /** 鏈上交易 hash（completed/executed 有值） */
  onChainTxId?: string;
}

export interface ChatRoom {
  friendId: string;
  messages: Message[];
}

/** 加密訊息信封 */
export interface EncryptedEnvelope {
  senderPublicKey: string;
  recipientPublicKey: string;
  ciphertext: string; // Base64
  nonce: string; // Base64
  timestamp: number;
  messageId: string;
}

// ============================================
// 群組相關類型
// ============================================

/** 群組成員角色 */
export type GroupRole = 'admin' | 'member';

/** 群組成員 */
export interface GroupMember {
  publicKey: string;
  nickname?: string;
  role: GroupRole;
  joinedAt: number;
  isOnline?: boolean;
}

/** 群組類型 */
export type GroupType = 'normal' | 'guardian';

/** 群組 */
export interface Group {
  id: string;
  name: string;
  avatar?: string; // emoji or URL
  members: GroupMember[];
  createdAt: number;
  createdBy: string; // 創建者公鑰
  updatedAt: number;
  lastMessage?: string;
  lastMessageTime?: number;
  unreadCount: number;
  // ADR-016: 巢狀群組已移除（parentGroupId / childGroupIds 不再使用）
  /** 群組類型：normal=一般群組, guardian=守護群組 */
  groupType?: GroupType;
  /** 守護群組設定 (僅 groupType='guardian' 時有效) */
  guardianSettings?: GuardianGroupSettings;
  /**
   * 曾被踢或自己離開、現在不在名冊上的成員（公鑰）：由套上的狀態鏈算出來（鏈上的 former），不另外存。
   */
  departed?: string[];
  /**
   * 群組金鑰的狀態（狀態鏈）：ok；waiting-key＝目前這一代的金鑰還沒拿到（向 admin 要了）；
   * waiting-admin-rekey＝有人離開、等 admin 換金鑰（這段期間群組設定的變更先暫停）
   */
  keyState?: GroupKeyState;
  /**
   * head 交叉比對（W2）：有成員報來的 log 位置跟我的對不上（伺服器可能給不同的人看不同的群組歷史，或對方說謊）。
   * 引擎已經向伺服器核對、必要時重建；同一個成員之後報來一致的位置就清掉。畫面顯示警告
   */
  logConflict?: boolean;
  /** 我送出的邀請重送用完、對方還沒收到的成員（群組設定可以「再送一次」；W2） */
  unackedInvites?: string[];
}

/** 見 Group.keyState */
export type GroupKeyState = 'ok' | 'waiting-key' | 'waiting-admin-rekey';

// 從 guardianGroup.ts 導入 (避免循環引用，這裡定義簡化版)
/** 守護群組設定 */
export interface GuardianGroupSettings {
  type: 'guardian';
  checkIn: {
    enabled: boolean;
    frequency: 'daily' | 'every_2_days' | 'weekly';
    notifyTime: string;
    timezone?: string;
    responseDeadline: number;
    customMessage?: string;
  };
  protection: {
    riskAlert: boolean;
    paymentAlert: boolean;
    linkAlert: boolean;
    riskThreshold: number;
  };
}

/** 群組訊息（擴展 Message） */
export interface GroupMessage extends Message {
  groupId: string;
  senderPublicKey: string;
  senderName?: string; // 發送者顯示名稱
}

/** 群組邀請 */
export interface GroupInvite {
  groupId: string;
  groupName: string;
  inviterPublicKey: string;
  inviterName?: string;
  timestamp: number;
  expiresAt: number;
}

/** 群組常數 (ADR-016) */
export const GROUP_CONSTANTS = {
  /** 群組最大人數 */
  MAX_MEMBERS: 50,
  /** 語音/視訊通話最大人數（WebRTC Media Stream 全網狀硬上限） */
  MAX_CALL_MEMBERS: 8,
  /** 群組名稱最大長度 */
  MAX_NAME_LENGTH: 50,
  /** 邀請過期時間（24 小時） */
  INVITE_EXPIRY_MS: 24 * 60 * 60 * 1000,
  /** 每群離線佇列上限 */
  OFFLINE_QUEUE_LIMIT: 500,
  /** 舊 Group Key 保留天數 */
  KEY_RETENTION_DAYS: 30,
  /** Key 輪換過渡期雙發時長（小時） */
  KEY_TRANSITION_HOURS: 72,
  /** DataChannel 閒置超時（毫秒，5 分鐘） */
  IDLE_TIMEOUT_MS: 300_000,
} as const;

// ============================================
// AegisTalk 風險評估類型
// ============================================

/** 風險等級 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** 風險動作建議 */
export type RiskAction = 'allow' | 'warn' | 'block' | 'alert';

/** 觸發的規則 */
export interface TriggeredRule {
  id: string;
  name: string;
  category: string;
  severity: RiskLevel;
  description?: string;
}

/** L2 規則引擎結果 */
export interface L2Result {
  riskLevel: RiskLevel;
  riskScore: number;
  action: RiskAction;
  triggeredRules: TriggeredRule[];
  warnings: string[];
}

/** 風險評估結果 */
export interface RiskResult {
  riskLevel: RiskLevel;
  riskScore: number;
  action: RiskAction;
  warnings: string[];
  triggeredRules: TriggeredRule[];
  l2Result?: L2Result;
}

/** 語音風險關鍵詞 */
export interface VoiceRiskKeyword {
  keyword: string;
  category: string;
  score: number;
}

/** 語音風險結果 */
export interface VoiceRiskResult {
  riskScore: number;
  matchedKeywords: VoiceRiskKeyword[];
  riskCategories: string[];
  shouldAlert: boolean;
}

/** 26 維特徵向量 */
export interface FeatureVector {
  // 訊息特徵 (8 維)
  avgMsgLength: number;
  msgFrequencyPerHour: number;
  initiationRatio: number;
  avgReplyDelay: number;
  replyDelayCv: number;
  consecutiveMsgRatio: number;
  emojiRatio: number;
  questionRatio: number;

  // 內容風險特徵 (6 維)
  urlFrequency: number;
  shortUrlRatio: number;
  moneyWordFrequency: number;
  urgencyWordFrequency: number;
  copyPasteScore: number;
  sensitiveInfoRequestFreq: number;

  // 時間特徵 (4 維)
  lateNightRatio: number;
  timeEntropy: number;
  relationshipDays: number;
  timeToMoneyTalk: number;

  // 語音通話特徵 (4 維)
  callFrequencyPerWeek: number;
  avgCallDuration: number;
  missedCallRatio: number;
  voiceMsgRatio: number;

  // 語音風險特徵 (4 維)
  voiceAvgRiskScore: number;
  voiceMaxRiskScore: number;
  voiceHighRiskRatio: number;
  voiceRiskCategoryDiversity: number;
}

// ============================================
// L3 行為 AI 類型
// ============================================

/** 模型狀態 */
export type ModelState =
  | { type: 'cold_start'; samples_collected: number; samples_needed: number }
  | { type: 'training' }
  | { type: 'ready' }
  | { type: 'needs_retrain' };

/** L3 行為 AI 評估結果 */
export interface L3Result {
  /** 異常分數 (0-100) */
  anomalyScore: number;
  /** 是否異常 */
  isAnomaly: boolean;
  /** 信心度 (0-100) */
  confidence: number;
  /** 模型狀態 */
  modelState: ModelState;
  /** 異常原因 */
  reasons: string[];
  /** 威脅等級 */
  threatLevel: 'Low' | 'Medium' | 'High' | 'Unknown';
}

/** 行為 AI 統計 */
export interface BehaviorAIStats {
  contactModelCount: number;
  globalModelReady: boolean;
  globalSampleCount: number;
}

// ============================================
// 導出守護群組類型
// ============================================

export * from './guardianGroup';

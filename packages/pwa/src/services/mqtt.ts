/**
 * MQTT Service - WebSocket 信令連線
 *
 * 透過 MQTT over WebSocket 進行信令交換
 * 用於 WebRTC 連線建立、X3DH_INIT 等；1 對 1 的信令全部是封好的 DIRECT_SEALED（開源第 4 步，directSignal.ts）
 *
 * E2EE Phase 2 改善：
 * - Sealed Sender：隱藏發送者身份，MQTT Broker 無法追蹤通訊模式
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import {
  unsealMessageBase64,
  type SealedEnvelope,
  type UnsealResult,
} from './sealedSender';
import { devLog, devWarn } from '../utils/devLog';
import { getDeviceIdSync } from './deviceId';
import {
  persistOutgoing,
  loadAllOutgoing,
  removeOutgoing,
  makeOutgoingId,
} from './outgoingQueueStore';
import {
  aclScopeKey,
  aclScopeOverflow,
  isCanonicalPubkey,
  isGroupTopicId,
  isPresenceTopic,
  mqttClientId,
  normalizeAclScope,
  MAX_ACL_GROUPS,
  MAX_ACL_PRESENCE,
  requestMqttToken,
  requestTransferCredential,
  toUrlSafeBase64,
  credentialSubscribeTopics,
  validDeviceId,
  MqttTokenError,
  type AclScope,
  type IdentitySigner,
  type MqttCredential,
} from './mqttCredential';
import { serverPushHint, signedPushNotify } from './pushRequest';
import { apiBase, brokerUrl } from './apiBase';
import { AEGISTALK_RING_PREFIX, signRingToken } from './ringToken';
import { postSigned, type SignedClock } from './signedPost';
import {
  acceptState, ONLINE_TTL_MS, parsePresenceTopic, presenceClock, PRESENCE_MAX_CLOCK_SKEW_MS, PRESENCE_REFRESH_MS, stillOnline, type PresenceState,
} from './presenceSecret';
import type { PresenceCodec, PresenceScope } from './presenceService';
import { GROUP_TOPICS_KEY_PREFIX, PRESENCE_TOPICS_KEY_PREFIX } from './topicMemory';

export type { IdentitySigner, MqttCredential } from './mqttCredential';

// MQTT 設定
const MQTT_CONFIG = {
  // broker 是執行期選的那台伺服器的（開源第 5c 步，services/apiBase.brokerUrl：社群版第一次開啟時選、官方版預設官方站）
  // 開發環境 (本地 EMQX)
  devBroker: 'ws://localhost:8083/mqtt',
  // 停用 mqtt.js 內建重連 — 由 MqttHealthMonitor 控制重連生命週期
  // 原因：OS 殺 socket 後 mqtt.js 重連用同一個 client 實例 → EMQX 不回 CONNACK → 死鎖
  reconnectPeriod: 0,
  connectTimeout: 15000,
  // 從 60s 降到 30s — 更快偵測死連線
  keepalive: 30,
};

// 訊息類型
export enum MessageType {
  // 金鑰交換：加好友的 X3DH_INIT（ephemeral、預備金鑰 bundle、封給收件人的 via；名字在 via 裡，開源第 4 步）
  X3DH_INIT = 'x3dh_init',
  // （邀請連結的「接受邀請」訊息型別 2026-10-16 拿掉：收到這種型別 validateMessage 直接丟，不會進 listener 或暫存）
  /**
   * 1 對 1 的所有信令（開源第 4 步，services/directSeal.ts、directSignal.ts）：封給收件人身分金鑰、寄件人簽章的信封，
   * 種類在密文裡 —— DataChannel 的 offer／answer／ICE、通話的 request／accept／reject／end／offer／answer／ICE、DTLS 指紋、
   * 個人資料、預備金鑰請求、刪除訊息。以前那十幾種明文型別（webrtc_*、call_*、call_webrtc_*、profile_update、profile_request、
   * prekey_request、prekey_bundle、push_subscription_update、delete_message、typing、encrypted_message）全部拿掉：
   * 收到那些型別 validateMessage 直接丟
   */
  DIRECT_SEALED = 'direct_sealed',
  // Phase 8: 換機傳輸（場景 2）
  DEVICE_TRANSFER_REQUEST = 'device_transfer_request',  // 新設備請求傳輸
  DEVICE_TRANSFER_DATA = 'device_transfer_data',        // 舊設備回傳資料
  // Phase 9: 群組聊天（Phase 32: GROUP_MESSAGE / GROUP_FILE 已移除 — 走 P2P encrypted_message）
  // 群組名冊／角色／資訊只由伺服器 log 上的簽章鏈決定（groupEngine）：以前的邀請、成員異動、角色、資訊更新明文訊息都拿掉了
  GROUP_KEY_SEALED = 'group_key_sealed',         // 封給收件人身分金鑰的群組信封：邀請、回條、金鑰索取／回覆、群組通話 offer／answer／ICE
  // 群組主題上唯一的型別（W2）：用目前這一代金鑰加密、寄件人簽章的控制訊息（commit 通知、here、sync、通話、刪除；groupControl）
  //   以前的 group_log_ping 與明文的 group_call_start／join／leave／end／offer／answer／ice 都拿掉了。
  //   主題是 mist/group/{tid}/{寄件人}（W3）：tid 由那一代的金鑰推出來，每換一次金鑰就換，gid 不上 broker
  GROUP_SEALED = 'group_sealed',
  // （以前的 check_in_reminder 拿掉了（W4）：明文帶 groupId 經過 broker，App 裡也早就沒有人送；報平安走 P2P 加密訊息與本機排程）
  // （以前的 presence 型別拿掉了（W4）：上線狀態只在好友之間的秘密主題 mist/user/<他>/presence/<tag> 上，payload 是 {n, c}、
  //   不走這個型別表，見 _receivePresence 與 presenceSecret.ts）
}

// 訊息結構
export interface MqttMessage {
  type: MessageType;
  from: string; // 發送者公鑰 (Base64)
  to?: string; // 接收者公鑰 (Base64)，廣播時為空
  payload: unknown;
  timestamp: number;
  signature?: string; // 訊息簽章
  /** 收件端填：這則實際從哪個 MQTT 主題來（覆寫 payload 裡任何同名欄位；群組控制訊息靠它知道 gid 與寄件人那一節） */
  topic?: string;
}

/**
 * 推播不再搭在 MQTT 訊息上（開源第 4 步）：以前 sendToUser 把 notificationHint（型別、是不是視訊）明文放進訊息 ——
 * broker 看得到「這一則是來電」。現在推播只走 triggerFcmNotify（帳戶簽章的 /api/push/notify），MQTT 上什麼都不帶。
 */

// 連線狀態
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

// 事件回調
type MessageCallback = (message: MqttMessage) => void;
type StateCallback = (state: ConnectionState) => void;
type PresenceCallback = (publicKey: string, isOnline: boolean) => void;
/** 連上了；tokenSwap ＝ 這次是「換 token 的正常重連」（範圍變了、到期前換新），不是真的重新上線 */
type ConnectedCallback = (info: { tokenSwap: boolean }) => void;
type SealedMessageCallback = (result: UnsealResult) => void;

// Sealed Sender 訊息包裝（MQTT 層）
interface SealedMqttMessage {
  sealed: true;
  envelope: SealedEnvelope;
  timestamp: number;
}

// 離線待發訊息
interface OutgoingMessage {
  id: string;
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  timestamp: number;
  /**
   * 排隊最多多久（毫秒；只在本機，不上線）。DIRECT_SEALED 的種類在密文裡、從 payload 看不出來 → 送的人告訴佇列：
   * 通話控制 60 秒（≤ TRANSIENT_STALE_MS 的算即時型別：拆線不放回、佇列滿了先丟）、其他 24 小時。沒有 ＝ 照型別判
   */
  ttlMs?: number;
}

/** 一張拿到手的 token（還沒變成「手上那張」之前也用這個型別傳） */
interface TokenGrant {
  token: string;
  /** 毫秒（伺服器的 exp） */
  expiresAtMs: number;
  username: string;
  /** 用哪個範圍拿的 */
  scopeKey: string;
  scope: AclScope | null;
  topics: Set<string>;
  /** 拿的時候的帳號世代與請求序號（見 _tokenEpoch／_tokenSeq） */
  epoch: number;
  seq: number;
}

// Health Monitor 用的健康資訊
interface MqttHealthInfo {
  state: ConnectionState;
  wsReadyState: number | null; // WebSocket.readyState (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)
  lastMessageReceivedAt: number; // Date.now() timestamp
  clientConnected: boolean;
  publicKey: string | null;
  tokenFailed: boolean; // token 取得失敗（403），cooldown 中不重試
  hasPinHash: boolean;  // PIN hash 存在 = 認證完成，可嘗試連線
}

/**
 * MQTT 服務類別
 */
class MqttService {
  private client: MqttClient | null = null;
  private publicKeyBase64: string | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private connectingPromise: Promise<void> | null = null; // Guard against concurrent connects
  /**
   * 連線世代（對應群星）。拿 token 是 await，那段期間 connectingPromise 還沒建立，「連線中就等同一個 promise」擋不到：
   * 範圍換 token 重連、HealthMonitor 的 forceReconnect 碰在一起時，兩個 connect 各建一個 client（同一個 clientId
   * 兩條連線互相接手），被丟棄那條的 close 還把狀態改成未連線。規則：拿完 token 發現世代變了就放棄；_teardown 也推進世代。
   */
  private _connectGen = 0;

  // 事件監聯器
  private messageListeners: Map<MessageType, Set<MessageCallback>> = new Map();
  private stateListeners: Set<StateCallback> = new Set();
  private connectedListeners: Set<ConnectedCallback> = new Set();

  /** mist/group/{tid}/+ 訂好了（SUBACK 准了） */
  private _groupGranted(topic: string): void {
    const parts = topic.split('/');
    if (parts.length !== 4 || parts[0] !== 'mist' || parts[1] !== 'group' || parts[3] !== '+') return;
    this.grantedGroupTopics.add(parts[2]);
    for (const cb of this.groupSubscribedListeners) {
      try { cb(parts[2]); } catch (err) { console.error('[MQTT] group subscribed listener failed:', err); }
    }
  }
  /** 下一次 connect() 是 _swapToken 叫的（群組 here 只在真的上線時發，換 token 的重連不發） */
  private _swapReconnect = false;

  // 訊息緩衝：MQTT 重連後 broker 立即送出暫存訊息，但 React useEffect 尚未註冊 listener，
  // 導致 X3DH_INIT 等關鍵訊息被丟棄。此緩衝暫存無 listener 的訊息，等 listener 註冊時重播。
  private pendingMessages: Map<string, MqttMessage[]> = new Map();
  private pendingMessageTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Presence（W4：好友之間的秘密主題 mist/user/<他>/presence/<tag>，加解密在 presenceService 的 codec）
  private presenceListeners: Set<PresenceCallback> = new Set();
  /** 好友（標準 base64）→ 目前採用的那一則狀態（解開、照 acceptState 排過順序的） */
  private friendPresence: Map<string, PresenceState> = new Map();
  /**
   * 每個好友 presence 主題（確切的）上最後採用的那一則（W5）：好友的主題被清掉（空的 retained）時他的狀態丟掉，這一份留著 ——
   * 營運方發一則空的、再重放同一個主題上更早錄下來的狀態，照樣排在這一則後面（以前清掉就沒有比較的對象）。主題離開範圍就丟
   */
  private _presenceFloor: Map<string, PresenceState> = new Map();
  /** 上次通知 listener 的在線與否（TTL 到了要補一次「離線」） */
  private _presenceNotified: Map<string, boolean> = new Map();
  /** 已經送出 SUBSCRIBE 的好友 presence 主題（確切的）。該訂哪些只看訂閱範圍（setAclScope 的 presence，presenceService） */
  private subscribedPresenceTopics: Set<string> = new Set();
  /** broker 的 session 裡可能還訂著、已經不要的 presence 主題（同群組主題的 _staleGroupTopics） */
  private _stalePresenceTopics: Set<string> = new Set();
  /** broker 已經回 SUBACK 准了的 presence 主題 */
  private grantedPresenceTopics: Set<string> = new Set();
  private _presenceCodec: PresenceCodec | null = null;
  /** 這一條連線連上的時間（presence 的 cs：遺囑、上線、更新同一個） */
  private _presenceConnStart = 0;
  private _presenceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _presenceExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 收到的 presence 一則一則依序處理（解密是 await：後到的不能先套上） */
  private _presenceChain: Promise<void> = Promise.resolve();
  /** 收 presence 的計數（E2E／模擬看：accepted、notOpened、outOfOrder、cleared） */
  private _presenceStats: Record<string, number> = {};
  /**
   * 已經送出 SUBSCRIBE 的群組主題（mist/group/{tid}/+）。該訂哪些只看訂閱範圍（setAclScope 的群組主題，W3：群組引擎的主題表）：
   * _syncGroupTopics 把多的退訂、少的（這張 token 給得起的）補訂；broker 沒保留 session 時全部重訂（部署前審查 BLOCKER，對應 AegisPlay B41）
   */
  private subscribedGroupTopics: Set<string> = new Set();
  /**
   * broker 的 session 裡可能還訂著、但已經不要的群組主題：退訂還沒確認的，加上 App 上次關掉前訂的（存在 localStorage，
   * 重開後 broker 還留著 session 時要退訂 —— 換金鑰後上一代的主題過了 10 分鐘、被踢、退群的那些，不然 session 一直留著）
   */
  private _staleGroupTopics: Set<string> = new Set();
  /** broker 已經回 SUBACK 准了的群組主題（tid）：群組引擎要等它才送加入後的 sync（W2 審查 #2） */
  private grantedGroupTopics: Set<string> = new Set();
  private groupSubscribedListeners: Set<(tid: string) => void> = new Set();

  // E2EE Phase 2: Sealed Sender
  private privateKeyBase64: string | null = null; // 用於解封訊息
  private sealedMessageListeners: Set<SealedMessageCallback> = new Set();

  // Health Monitor 追蹤
  private _lastMessageReceivedAt = 0; // 最後收到訊息的時間戳
  private _isDev = false; // 記住 isDev 供 forceReconnect 使用

  // 離線訊息緩衝：MQTT 斷線時暫存待發訊息，重連後自動 flush
  private outgoingQueue: OutgoingMessage[] = [];
  /** 已 publish、還沒等到 broker 確認的訊息；_teardown 時放回待送佇列（稽核 M7，對應群星 B37／P1-4） */
  private _inflight = new Map<string, OutgoingMessage>();
  private _persisting = new Map<string, Promise<unknown>>();
  private static readonly MAX_OUTGOING_QUEUE = 200; // 最多緩衝 200 條
  /** 連線中也要持久化＋等 PUBACK 的型別（稽核 M7）：掉了就永遠不會補。通話／信令不在內，過期重送只會搗亂 */
  private static readonly DURABLE_TYPES = new Set<MessageType>([
    MessageType.X3DH_INIT, MessageType.GROUP_KEY_SEALED,
  ]);
  /**
   * 即時的待送：過期的信令會讓對方拆掉正常的連線（稽核 P2-4），晚到的來電會讓人再響一次。拆線時沒確認不重送；離線排太久
   * （TRANSIENT_STALE_MS）不送；佇列滿了先丟它們（對應 AegisPlay 19b17dac）。開源第 4 步起 1 對 1 的信令都是 DIRECT_SEALED、
   * 型別看不出種類：offer／ICE 不排隊（sendTransientToUser），通話控制排隊時帶 ttlMs ≤ TRANSIENT_STALE_MS → 算即時的
   */
  private static readonly TRANSIENT_STALE_MS = 60_000;
  /** 收到的訊息時戳最多比現在晚這麼多（兩邊時鐘的誤差）；再晚就是寫好的「未來訊息」 */
  private static readonly MAX_FUTURE_SKEW_MS = 5 * 60_000;
  private static isDurable(payload: string): boolean {
    try {
      return MqttService.DURABLE_TYPES.has((JSON.parse(payload) as { type?: MessageType }).type as MessageType);
    } catch {
      return false;
    }
  }
  /** 即時的待送（排隊的期限 ≤ TRANSIENT_STALE_MS） */
  private static isTransient(entry: Pick<OutgoingMessage, 'ttlMs'>): boolean {
    return typeof entry.ttlMs === 'number' && entry.ttlMs <= MqttService.TRANSIENT_STALE_MS;
  }
  /** 這一則排隊最多多久 */
  private static queueTtl(entry: Pick<OutgoingMessage, 'ttlMs'>): number {
    return typeof entry.ttlMs === 'number' && entry.ttlMs > 0 ? Math.min(entry.ttlMs, MqttService.FLUSH_STALE_MS) : MqttService.FLUSH_STALE_MS;
  }

  // JWT 認證 token：「手上那張」（連線用的就是它）
  private _mqttToken: string | null = null;
  /** 到期時間（毫秒，伺服器發的 exp） */
  private _mqttTokenExpiresAt = 0;
  /** 伺服器發的 username（URL-safe 公鑰／換機的 transfer_…），CONNECT 時原樣帶上 */
  private _mqttUsername: string | null = null;
  /** 已解鎖的帳戶身分（AppProvider 設）；token 請求要它簽。沒有就不拿 token、不連線 */
  private _identitySigner: IdentitySigner | null = null;
  /** 換機的新裝置：伺服器發的臨時身分，只能訂閱自己的收件箱（不發 presence、不送待送佇列） */
  private _temporaryCredential = false;
  /**
   * 訂閱範圍（對應群星 A8）：要訂閱的群組主題、好友的 presence 主題與我自己的 presence tag，token 請求帶上（簽章內），
   * 伺服器只發這些主題的訂閱權（與我那一個 presence 主題的發布權）。
   * null ＝ 還不知道（好友／群組還沒載入）→ 送空清單，只拿得到自己的收件箱，範圍到了再換一張。
   */
  private _aclScope: AclScope | null = null;
  /** 這份範圍是哪個帳號的名單（AppProvider 設範圍時帶上）：換成別的帳號就不能拿去簽 token */
  private _aclScopeOwner: string | null = null;
  /** 上次回報的「超過上限、訂不到」數量（groups|presence）：數字變了才再記一次、再提示一次 */
  private _scopeOverflowKey = '0|0';
  /** 手上那張 token 是用哪個範圍拿的；範圍多了這張給不起的東西就要換 token 重連（只少了東西不用，見 _tokenCovers） */
  private _tokenScopeKey = '';
  private _tokenScope: AclScope | null = null;
  /** 手上那張 token 能訂閱的主題（伺服器回的 subscribe）：只訂這些，不讓 broker 拒絕；null＝沒有 token（dev broker） */
  private _tokenTopics: Set<string> | null = null;
  /**
   * 帳號世代：換人、上鎖、登出（disconnect）就加一。之前發出去的 token 請求晚回來一律作廢（審查 LOW：
   * 以前登出時正在拿的那張回來照樣寫進來，下一個帳號連線時還帶著上一個帳號的範圍）。
   */
  private _tokenEpoch = 0;
  /** token 請求的序號；手上那張是第幾號。晚回來的舊請求不蓋掉新的（審查 LOW） */
  private _tokenSeq = 0;
  private _adoptedSeq = 0;
  /** 進行中的 token 請求：同一個範圍、同一個帳號世代的人共用，不各發一張 */
  private _tokenRequest: { key: string; epoch: number; promise: Promise<TokenGrant | null> } | null = null;
  /** 正在「先拿新 token、再正常斷線重連」（_swapToken） */
  private _swapping: Promise<void> | null = null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** 到期前多久換新的（EMQX disconnect_after_expire：到期那一刻 broker 會把連線踢掉、發離線遺囑） */
  private static readonly TOKEN_REFRESH_LEAD_MS = 5 * 60_000;
  /** 換新 token 失敗時多久後再試（舊的到期前都還能用） */
  private static readonly TOKEN_REFRESH_RETRY_MS = 30_000;
  /** 正常斷線（DISCONNECT）最多等這麼久，等不到就直接關 */
  private static readonly GRACEFUL_CLOSE_MS = 1500;
  private _scopeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 排定的換 token 重連時間（Date.now() 毫秒），0 ＝沒排 */
  private _scopeReconnectAt = 0;
  /**
   * 範圍多了「這張 token 還訂不到的群組」→ 幾乎馬上換（群組頻道上的成員異動不是 retained，晚訂就永遠收不到；
   * 多人模擬 S2：建群 2 秒後踢人，新成員還在等 2 秒 debounce、沒訂到群組頻道，踢人訊息就漏了）。
   * 我的 presence tag 換了（換秘密：舊主題已經清掉，新主題要盡快能發）→ 一樣 250ms。
   * 只多了好友的 presence 主題 → 2 秒 debounce（presence 是 retained，晚訂也拿得到現況；連續加好友只重連一次）。
   */
  private static readonly SCOPE_RECONNECT_GROUP_MS = 250;
  private static readonly SCOPE_RECONNECT_MS = 2000;
  private _scopeExpectedUntil = 0;
  private _scopeWaiters: Array<() => void> = [];
  private _tokenFetchFailedAt = 0; // 最後一次 token 取得失敗的時間
  /** 最後一次 token 失敗的原因（伺服器的 detail；device_replaced 時 claim 完不用等冷卻） */
  private _lastTokenError: string | null = null;
  /**
   * 伺服器時間 − 本機時間（毫秒）。每次拿 token 都由回應的 serverTime 更新；時鐘差超過簽章時間窗時伺服器回
   * 401 clock_skew＋server_time，用它重簽一次（審查 MEDIUM：以前手機時鐘差 5 分鐘以上就永遠 401、每 60 秒再錯一次、
   * 什麼都不顯示）。訊息外層的時戳、收件的新鮮度（W5 起窗短的 presence／here／通話改用有上限的 boundedNow）、token 到期都用校正後的時間 —— 每台都對齊伺服器，
   * 不會因為某一台時鐘快了幾分鐘，它的訊息在別台都變成「未來的訊息」被丟掉。
   */
  private _clockOffsetMs = 0;
  /** 已經跟使用者說過「手機時間不準」了（連上之後收回） */
  private _clockSkewNoticeShown = false;
  /** 已經跟使用者說過「手機時間差超過 boundedNow 的上限」了（回到上限內收回；W5 複審） */
  private _clockDriftNoticeShown = false;
  private static readonly TOKEN_RETRY_COOLDOWN = 60_000; // 60s cooldown after 403

  /** 校正到伺服器的現在時間（毫秒） */
  private _serverNow(): number {
    return Date.now() + this._clockOffsetMs;
  }

  /** 校正到伺服器的現在時間（毫秒）：其他要簽時間的 API（群組 log 的 append）用同一個時鐘 */
  serverNow(): number {
    return this._serverNow();
  }

  /**
   * 收端判斷「新不新鮮」用的時鐘（W5）：本機時鐘＋API 的時鐘差，但最多撥 ±5 分鐘（presenceSecret.presenceClock）——
   * 回假 serverTime 的營運方不能讓很久以前錄下來的東西（好友的「在線」、群組的通話控制／here／sync、通話信令）看起來還新。
   * 送出去的時間戳照舊用 serverNow（別人用它判斷我的）。手機自己的時鐘差超過上限時這幾種會判斷不準 → _noteClockDrift 提示
   */
  boundedNow(): number {
    return presenceClock(Date.now(), this._clockOffsetMs);
  }

  /** 判斷好友 presence 新不新鮮、TTL 用的時鐘（＝boundedNow） */
  private _presenceNow(): number {
    return this.boundedNow();
  }

  /**
   * 連得上，但手機時鐘跟伺服器差超過 boundedNow 的上限（±5 分鐘）：群組通話、here、好友在線這幾種收端判斷會不準
   * （收不到、或把別人當成離線）→ 請使用者開自動時間（W5 複審）；回到上限內 → 收起來
   */
  private _noteClockDrift(): void {
    const drift = Math.abs(this._clockOffsetMs) > PRESENCE_MAX_CLOCK_SKEW_MS;
    if (drift && !this._clockDriftNoticeShown) {
      this._clockDriftNoticeShown = true;
      MqttService.notice({ kind: 'clock-drift', minutes: Math.max(1, Math.round(Math.abs(this._clockOffsetMs) / 60_000)) });
    } else if (!drift && this._clockDriftNoticeShown) {
      this._clockDriftNoticeShown = false;
      MqttService.notice({ kind: 'clock-drift-ok' });
    }
  }

  /** 跟 UI 說一聲（ConnectionNotice 顯示）；測試／非瀏覽器環境沒有 window 就不做 */
  private static notice(detail: Record<string, unknown>): void {
    if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
    window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail }));
  }

  /**
   * 取得主題設定
   */
  private getTopics(): { inbox: string; group: (tid: string) => string } {
    if (!this.publicKeyBase64) {
      throw new Error('Not connected');
    }
    // 使用 URL 安全的 Base64 作為主題名稱
    const safeKey = toUrlSafeBase64(this.publicKeyBase64);
    return {
      // 訂閱用。最後一節固定是 broker 已驗證的發送者（JWT ACL 只准發布到自己那一節，見 api/chat/mqtt_auth.py mqtt_acl），
      // 收件端據此拒絕冒用 from 的訊息（handleMessage）
      inbox: `mist/user/${safeKey}/inbox/+`,
      // 群組主題 id（W3）：群組引擎用那一代的金鑰推出來的 tid，不是 gid
      group: (tid: string) => `mist/group/${tid}/+`,
      // 好友的 presence 主題（W4）是確切的 mist/user/<他>/presence/<tag>，直接來自範圍（presenceService），這裡不推算
    };
  }

  /** 發布用：收件人的收件箱，最後一節是自己 */
  private inboxTopicFor(recipientPublicKeyBase64: string): string {
    return `mist/user/${toUrlSafeBase64(recipientPublicKeyBase64)}/inbox/${toUrlSafeBase64(this.publicKeyBase64 ?? '')}`;
  }

  /** 發布用：群組主題（tid），最後一節是自己 */
  private groupTopicFor(tid: string): string {
    return `mist/group/${tid}/${toUrlSafeBase64(this.publicKeyBase64 ?? '')}`;
  }

  /**
   * 我自己的 presence 主題（W4）：mist/user/<我>/presence/<tag>，tag 是手上那張 token 申請時帶的（伺服器只給那一個主題的發布權）；
   * 還沒有 tag、換機的臨時身分 → null（不發任何 presence、不設遺囑）。dev broker 沒有 token → 用範圍裡的 tag
   */
  private _myPresenceTopic(): string | null {
    if (!this.publicKeyBase64 || this._temporaryCredential) return null;
    const tag = this._isDev ? this._aclScope?.presenceTag : this._tokenScope?.presenceTag;
    return tag ? `mist/user/${toUrlSafeBase64(this.publicKeyBase64)}/presence/${tag}` : null;
  }

  /**
   * 取得 MQTT JWT token（快取手上那張，到期前 5 分鐘換新；訂閱範圍變了就換一張）。只拿、不換上 —— 換上是 _adopt。
   *
   * 請求由已解鎖的帳戶金鑰簽署（伺服器只認簽章）→ 只有 keys 解鎖之後才拿得到；以前登入畫面就拿 mist_pubkey_raw
   * 去要（只送 pubkeyHash），那種「先連再說」已經拿掉。換機的臨時身分直接用伺服器發的那一張，不續（5 分鐘就夠）。
   * force：手上那張還能用也要一張新的（到期前換新、claim 後要 kick 主題）。
   */
  private async _obtainToken(publicKeyBase64: string, force = false): Promise<TokenGrant | null> {
    if (this._temporaryCredential) {
      return this._mqttToken && this._mqttTokenExpiresAt > this._serverNow() ? this._activeGrant() : null;
    }
    const epoch = this._tokenEpoch;
    // 好友／群組正在載入（AppProvider expectAclScope）→ 等範圍到了再拿，不先拿一張沒範圍的
    await this._awaitExpectedScope();
    if (epoch !== this._tokenEpoch) return null;      // 等的時候登出／換人了
    const scope = this._aclScope;
    const scopeKey = aclScopeKey(scope);
    const active = this._activeGrant();
    if (!force && active && active.scopeKey === scopeKey
        && active.expiresAtMs > this._serverNow() + MqttService.TOKEN_REFRESH_LEAD_MS) {
      return active;
    }
    const pending = this._tokenRequest;
    if (pending && pending.key === scopeKey && pending.epoch === epoch) return pending.promise;

    // Cooldown: 上次 token 取得失敗後 60 秒內不重試（防止 403 spam）
    if (this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN) {
      return null;
    }

    const signer = this._identitySigner;
    if (!signer || signer.publicKey !== publicKeyBase64) {
      // 還沒解鎖（或換帳號中）：不算失敗、不進冷卻 —— 解鎖後 AppProvider 會再連
      console.error('[MQTT] Token fetch needs the unlocked identity — not connecting yet');
      return null;
    }
    const request = { key: scopeKey, epoch,
      promise: this._requestGrant(signer, publicKeyBase64, scope, scopeKey, epoch, ++this._tokenSeq) };
    this._tokenRequest = request;
    void request.promise.finally(() => { if (this._tokenRequest === request) this._tokenRequest = null; });
    return request.promise;
  }

  private async _requestGrant(
    signer: IdentitySigner, publicKeyBase64: string, scope: AclScope | null, scopeKey: string, epoch: number, seq: number,
  ): Promise<TokenGrant | null> {
    try {
      const deviceId = getDeviceIdSync();
      const device = validDeviceId(deviceId) ? deviceId : null;
      const clientId = this._clientIdFor(publicKeyBase64);
      let credential: MqttCredential;
      try {
        credential = await requestMqttToken(signer, clientId, scope, device, this._clockOffsetMs);
      } catch (err) {
        // 手機時鐘差太多：伺服器回了它的時間 → 用它重簽一次（只重試一次；還是不行就照一般失敗處理、提示使用者）
        if (!(err instanceof MqttTokenError) || err.code !== 'clock_skew' || err.serverTime === undefined
            || epoch !== this._tokenEpoch) throw err;
        this._clockOffsetMs = err.serverTime * 1000 - Date.now();
        console.error(`[MQTT] device clock is ${Math.round(this._clockOffsetMs / 60_000)} min off the server — re-signing with server time`);
        credential = await requestMqttToken(signer, clientId, scope, device, this._clockOffsetMs);
      }
      if (epoch !== this._tokenEpoch) {
        console.error('[MQTT] token arrived after logout/account switch — discarded');
        return null;
      }
      if (typeof credential.serverTime === 'number' && Number.isFinite(credential.serverTime)) {
        this._clockOffsetMs = credential.serverTime * 1000 - Date.now();
      }
      if (this._clockSkewNoticeShown) {
        this._clockSkewNoticeShown = false;
        MqttService.notice({ kind: 'clock-ok' });
      }
      this._noteClockDrift();
      this._tokenFetchFailedAt = 0; // 重置失敗記錄
      this._lastTokenError = null;
      devLog('[MQTT] JWT token acquired, expires:', new Date(credential.expiresAt * 1000).toISOString());
      return { token: credential.token, expiresAtMs: credential.expiresAt * 1000, username: credential.username,
        scopeKey, scope, topics: credentialSubscribeTopics(credential, scope), epoch, seq };
    } catch (err) {
      if (epoch !== this._tokenEpoch) return null;
      this._lastTokenError = err instanceof MqttTokenError ? (err.code ?? `http_${err.status}`) : 'network';
      console.error('[MQTT] Failed to fetch MQTT token:', err instanceof MqttTokenError ? `HTTP ${err.status} ${err.code ?? ''}` : err);
      this._tokenFetchFailedAt = Date.now();
      // 用伺服器時間重簽了還是時間不對（時鐘一直在跳）：連不上的原因要讓使用者知道，不要默默每分鐘重試
      if (err instanceof MqttTokenError && err.code === 'clock_skew') {
        const minutes = Math.max(1, Math.round(Math.abs(((err.serverTime ?? 0) * 1000 - Date.now()) / 60_000)));
        this._clockSkewNoticeShown = true;
        MqttService.notice({ kind: 'clock-skew', minutes });
      }
      return null;
    }
  }

  /** 手上那張（沒有就 null） */
  private _activeGrant(): TokenGrant | null {
    if (!this._mqttToken || !this._mqttUsername) return null;
    return { token: this._mqttToken, expiresAtMs: this._mqttTokenExpiresAt, username: this._mqttUsername,
      scopeKey: this._tokenScopeKey, scope: this._tokenScope, topics: this._tokenTopics ?? new Set(), epoch: this._tokenEpoch, seq: this._adoptedSeq };
  }

  /**
   * 換上這張。帳號已經換了（epoch 不同）或手上已經是更新的請求拿到的 → 不換，回手上那張可用的 token（或 null）。
   */
  private _adopt(grant: TokenGrant): string | null {
    if (grant.epoch !== this._tokenEpoch) return null;
    if (grant.seq < this._adoptedSeq) {
      const active = this._activeGrant();
      return active && active.expiresAtMs > this._serverNow() ? active.token : null;
    }
    this._mqttToken = grant.token;
    this._mqttTokenExpiresAt = grant.expiresAtMs;
    this._mqttUsername = grant.username;
    this._tokenScopeKey = grant.scopeKey;
    this._tokenScope = grant.scope;
    this._tokenTopics = grant.topics;
    this._adoptedSeq = grant.seq;
    return grant.token;
  }

  /** 丟掉手上那張 token 與進行中的請求，帳號世代加一（之前發出的請求回來都作廢） */
  private _forgetToken(): void {
    this._tokenEpoch += 1;
    this._tokenRequest = null;
    this._mqttToken = null;
    this._mqttTokenExpiresAt = 0;
    this._mqttUsername = null;
    this._tokenTopics = null;
    this._tokenScopeKey = '';
    this._tokenScope = null;
    this._adoptedSeq = this._tokenSeq;
    this._clearTokenRefresh();
  }

  /**
   * AppProvider：已解鎖的身分（登出／上鎖時傳 null）。換了人，手上的 token 與進行中的請求作廢；
   * 範圍是別的帳號的名單 → 也作廢（不能拿去簽這個帳號的 token）。
   */
  setIdentitySigner(signer: IdentitySigner | null): void {
    if (this._identitySigner?.publicKey !== signer?.publicKey) {
      this._forgetToken();
      if (signer && this._aclScopeOwner && this._aclScopeOwner !== signer.publicKey) {
        this._aclScope = null;
        this._aclScopeOwner = null;
      }
    }
    this._identitySigner = signer;
    if (signer) this._temporaryCredential = false;
  }

  /** 換機的新裝置還沒有身分：向伺服器要一張只能收自己收件箱的臨時 token */
  createTransferCredential(): Promise<MqttCredential> {
    return requestTransferCredential();
  }

  /** 用臨時身分連線（connect 傳 credential.username 當公鑰；clientId 由伺服器指定＝username） */
  useTemporaryCredential(credential: MqttCredential): void {
    if (typeof credential.serverTime === 'number' && Number.isFinite(credential.serverTime)) {
      this._clockOffsetMs = credential.serverTime * 1000 - Date.now();
    }
    this._mqttToken = credential.token;
    this._mqttTokenExpiresAt = credential.expiresAt * 1000;
    this._mqttUsername = credential.username;
    this._tokenScopeKey = '';
    this._tokenScope = null;
    this._tokenTopics = credentialSubscribeTopics(credential, null);
    this._adoptedSeq = ++this._tokenSeq;
    this._temporaryCredential = true;
  }

  /**
   * 連線用的 clientId，也是 token 綁的那一個（JWT `clientid` claim）。
   * 一般：mist_<公鑰前 16>_<deviceId 前 8>；換機的臨時身分：伺服器指定＝那張 token 的 username。
   */
  private _clientIdFor(publicKeyBase64: string): string {
    if (this._temporaryCredential && this._mqttUsername) return this._mqttUsername;
    return mqttClientId(publicKeyBase64, getDeviceIdSync());
  }

  /** 這張 token 給不給訂這個主題（dev broker 沒有 token → 不擋） */
  private _tokenAllows(topic: string): boolean {
    return this._isDev || !!this._tokenTopics?.has(topic);
  }

  /**
   * 手上這張 token 夠不夠這個範圍：一樣的範圍、或只少了群組主題（W3：換金鑰後上一代的主題過了重疊期、被踢、退群）／好友的
   * presence 主題（W4：刪好友、好友換了秘密）→ 夠，不必換 token 重連（多出來的那幾個由 _syncGroupTopics／_syncPresenceTopics 退訂）。
   * 我的 presence tag 不一樣（發布權）→ 換一張。
   */
  private _tokenCovers(scope: AclScope | null): boolean {
    if (aclScopeKey(scope) === this._tokenScopeKey) return true;
    const held = this._tokenScope;
    if (!scope || !held) return false;
    return scope.presenceTag === held.presenceTag && scope.groups.every((t) => held.groups.includes(t))
      && scope.presence.every((t) => held.presence.includes(t));
  }

  /**
   * AppProvider：我現在的群組主題（W3：群組引擎的主題表，重要的在前，見 rankScopeTopics；超過上限時留前面的）與 presence
   * （W4：presenceService —— 我自己的 tag 與好友確切的主題；同群組但不是好友的人不在這裡）。名單載入後與每次變動時呼叫。
   * owner＝這份名單是哪個帳號的（換帳號時不會拿上一個帳號的範圍去簽）。
   * 群組主題與 presence 主題的訂閱馬上照新範圍調整（不要的退訂、這張 token 給得起的補訂）；範圍多了這張 token 給不起的 → 換 token
   * 重連（新的群組主題、我的 tag 換了 250ms，只多了好友的 presence 2 秒 debounce），只少了東西不換。
   */
  setAclScope(groupTopics: string[], presence: PresenceScope, owner?: string | null): void {
    const before = aclScopeKey(this._aclScope);
    this._aclScope = normalizeAclScope(groupTopics, presence.topics, presence.tag);
    this._aclScopeOwner = owner ?? null;
    this._reportScopeOverflow(groupTopics, presence.topics);
    this._forgetPresenceOutside(this._aclScope.presence);
    const waiters = this._scopeWaiters;
    this._scopeWaiters = [];
    for (const w of waiters) w();
    this._syncGroupTopics();
    this._syncPresenceTopics();
    if (aclScopeKey(this._aclScope) === before) return;
    // 還沒連（或還在拿 token）：連上那一刻會比對 token 是用哪個範圍拿的（_rescopeIfStale）
    if (!this.client || this._temporaryCredential || !this._mqttToken) return;
    if (this._tokenCovers(this._aclScope)) return;
    this._scheduleScopeReconnect(this._scopeReconnectDelay());
  }

  /**
   * 群組主題超過 MAX_ACL_GROUPS（好友的 presence 超過 MAX_ACL_PRESENCE）：掉出去的那些收不到群組主題上的控制訊息
   * （或 presence）。以前默默截掉；現在記一行 log，群組被截時讓 UI 提示（ConnectionNotice）。數字沒變不重複提示。
   */
  private _reportScopeOverflow(groups: string[], presence: string[]): void {
    const over = aclScopeOverflow(groups, presence);
    const key = `${over.groups}|${over.presence}`;
    if (key === this._scopeOverflowKey) return;
    this._scopeOverflowKey = key;
    if (over.groups > 0 || over.presence > 0) {
      console.error(`[MQTT] ACL scope over the limit: ${over.groups} group(s) beyond ${MAX_ACL_GROUPS} and ${over.presence} friend presence topic(s) beyond ${MAX_ACL_PRESENCE} get no live updates (least active dropped first)`);
    }
    MqttService.notice(over.groups > 0
      ? { kind: 'scope-overflow', groups: over.groups, max: MAX_ACL_GROUPS }
      : { kind: 'scope-ok' });
  }

  /** 新範圍裡有這張 token 還訂不到的群組主題（剛加入、剛換金鑰）或我的 presence tag 換了 → 短延遲；否則 2 秒 */
  private _scopeReconnectDelay(): number {
    const missingGroup = (this._aclScope?.groups ?? []).some((tid) => !this._tokenTopics?.has(`mist/group/${tid}/+`));
    const tagChanged = (this._aclScope?.presenceTag ?? null) !== (this._tokenScope?.presenceTag ?? null);
    return missingGroup || tagChanged ? MqttService.SCOPE_RECONNECT_GROUP_MS : MqttService.SCOPE_RECONNECT_MS;
  }

  /**
   * 手上的 token 是用舊範圍拿的 → 換 token 重連。範圍若是在「拿 token 的那段 await」期間才設好，
   * setAclScope 那時還沒有 client、不排重連 → 連上時再檢查一次（_rescopeIfStale）。
   */
  private _scheduleScopeReconnect(delayMs: number): void {
    const at = Date.now() + delayMs;
    // 已經排了更早的就不延後（加群之後緊接著加好友，不能把群組那次拖到 2 秒）
    if (this._scopeReconnectTimer && this._scopeReconnectAt <= at) return;
    if (this._scopeReconnectTimer) clearTimeout(this._scopeReconnectTimer);
    this._scopeReconnectAt = at;
    this._scopeReconnectTimer = setTimeout(() => {
      this._scopeReconnectTimer = null;
      this._scopeReconnectAt = 0;
      if (this._tokenCovers(this._aclScope) || !this.publicKeyBase64 || this._temporaryCredential) return;
      void this._swapToken('ACL scope changed');
    }, delayMs);
  }

  private _rescopeIfStale(): void {
    if (!this._aclScope || this._temporaryCredential || this._isDev || !this._mqttToken) return;
    if (!this._tokenCovers(this._aclScope)) this._scheduleScopeReconnect(this._scopeReconnectDelay());
  }

  /**
   * 換一張 token 重連（範圍變了、到期前、claim 完要 kick 主題）。審查 LOW：以前先 end(true) 拆線再去拿 token ——
   * 不送 DISCONNECT，broker 發離線遺囑（好友看到我下線又上線），拿 token 的那段時間（加上失敗時的冷卻）完全斷線。
   * 現在：1. 舊連線照常收送，先拿新 token（拿不到就留著舊連線，到期前都還能用）2. 正常斷線（MQTT DISCONNECT，
   * 沒有遺囑）3. 用新 token 連回來。
   */
  private _swapToken(reason: string): Promise<void> {
    if (this._swapping) return this._swapping;
    const run = async (): Promise<void> => {
      const key = this.publicKeyBase64;
      if (!key || this._temporaryCredential || this._isDev || !this.client) return;
      const epoch = this._tokenEpoch;
      const gen = this._connectGen;
      const grant = await this._obtainToken(key, true);
      // 拿 token 的時候：登出／換人（epoch）、連線被別人重建（gen，例如 HealthMonitor）→ 這次不換
      if (!grant || epoch !== this._tokenEpoch || gen !== this._connectGen || this.publicKeyBase64 !== key || !this.client) return;
      console.error(`[MQTT] ${reason} → new token in hand, clean reconnect`);
      await this._teardown({ graceful: true });
      if (epoch !== this._tokenEpoch || this.publicKeyBase64 !== key) return;
      if (!this._adopt(grant)) return;
      this._swapReconnect = true;
      await this.connect(key, this._isDev);
    };
    const swap = run()
      .catch((e) => console.error('[MQTT] token swap failed:', e))
      .finally(() => { if (this._swapping === swap) this._swapping = null; });
    this._swapping = swap;
    return swap;
  }

  /** 連上後排「到期前 5 分鐘換新 token」（換不成就 30 秒後再試） */
  private _scheduleTokenRefresh(): void {
    this._clearTokenRefresh();
    if (this._temporaryCredential || this._isDev || !this._mqttToken) return;
    const delay = Math.max(MqttService.TOKEN_REFRESH_RETRY_MS,
      this._mqttTokenExpiresAt - MqttService.TOKEN_REFRESH_LEAD_MS - this._serverNow());
    this._tokenRefreshTimer = setTimeout(() => {
      this._tokenRefreshTimer = null;
      if (!this.client?.connected) return;      // 沒連著：下次 connect 本來就會拿新的
      void this._swapToken('token expires soon').then(() => {
        if (this.client?.connected && !this._tokenRefreshTimer) this._scheduleTokenRefresh();
      });
    }, delay);
  }

  private _clearTokenRefresh(): void {
    if (this._tokenRefreshTimer) clearTimeout(this._tokenRefreshTimer);
    this._tokenRefreshTimer = null;
  }

  /**
   * AppProvider：這台剛 claim 成為帳號的活躍裝置（/api/devices/claim）。伺服器只給活躍裝置 kick 主題，
   * 活躍裝置是別台時整張拒絕（device_replaced）—— claim 之前拿的 token 沒有 kick 主題、或剛被拒在冷卻，現在就換。
   */
  onDeviceClaimed(): void {
    if (this._lastTokenError === 'device_replaced') {
      this._tokenFetchFailedAt = 0;
      this._lastTokenError = null;
    }
    const deviceId = getDeviceIdSync();
    if (!validDeviceId(deviceId) || this._temporaryCredential || this._isDev) return;
    if (this.client?.connected && this._mqttToken && !this._tokenTopics?.has(`aegis/device/${deviceId}/kicked`)) {
      void this._swapToken('device claimed');
    }
  }

  /**
   * AppProvider：好友／群組馬上就會從本機載入（接著 setAclScope）。第一張 token 等它一下（最多 withinMs），
   * 不先拿一張沒有範圍的、連上 2 秒後又斷線換 token —— 那次重連正好落在補送離線訊息、建 P2P 的時候。
   */
  expectAclScope(withinMs = 3000): void {
    if (!this._aclScope) this._scopeExpectedUntil = Date.now() + withinMs;
  }

  private async _awaitExpectedScope(): Promise<void> {
    const wait = this._scopeExpectedUntil - Date.now();
    if (this._aclScope || this._temporaryCredential || wait <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this._scopeWaiters = this._scopeWaiters.filter((w) => w !== done);
        resolve();
      }, wait);
      this._scopeWaiters.push(done);
    });
  }

  /**
   * 連線到 MQTT Broker
   *
   * Guards against concurrent connect() calls and properly cleans up
   * any existing client before creating a new one, preventing zombie connections.
   */
  async connect(publicKeyBase64: string, isDev = false): Promise<void> {
    // 這次是不是換 token 的重連：在任何 return 之前讀掉（沒用上也不能留給下一次真的上線）
    const tokenSwap = this._swapReconnect;
    this._swapReconnect = false;
    // Guard: if already connected with the same key, skip
    if (this.client?.connected && this.publicKeyBase64 === publicKeyBase64) {
      console.error('[MQTT] Already connected, skipping');
      // 校正狀態機 desync：底層 client 確實連著，但 this.state 可能被某個短暫的
      // 'offline'/'close' 事件留在 RECONNECTING/DISCONNECTED（socket 其實自己復原了）。
      // 若不校正：getState() != CONNECTED → useMqtt 的 React isConnected 卡 false →
      // AppProvider 的「已連線」分支（session repair / presence / P2P 就緒）永遠不跑 →
      // 兩邊都傳不出、好友還在卻傳不動（「失去好友、無法傳訊」的真因）。
      // setState() 會同步通知 useMqtt 的 onStateChange listener，把 React state 推成 true。
      if (this.state !== ConnectionState.CONNECTED) {
        console.error('[MQTT] client connected but state was', this.state, '→ reconciling to CONNECTED');
        this.setState(ConnectionState.CONNECTED);
      }
      return;
    }

    // Guard: if a connect is already in progress, return the same promise
    if (this.connectingPromise) {
      console.error('[MQTT] Connect already in progress, waiting...');
      return this.connectingPromise;
    }

    // Guard: if client exists but not disconnected (e.g. still closing), tear it down first
    if (this.client && !this.client.disconnected && this.publicKeyBase64 === publicKeyBase64) {
      devWarn('[MQTT] Client exists in limbo state, tearing down first');
      this._teardown();
    }

    // 還沒選伺服器（社群版第一次開啟、選之前）：沒有 broker 可連 —— 不進 CONNECTING
    if (!isDev) brokerUrl();

    // Early check: if token is in cooldown, don't even start (prevents CONNECTING→DISCONNECTED churn)
    if (!isDev && this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN) {
      console.error('[MQTT] Token in cooldown, skipping connect. Remaining:', Math.round((MqttService.TOKEN_RETRY_COOLDOWN - (Date.now() - this._tokenFetchFailedAt)) / 1000) + 's');
      return;
    }

    // Clean up any existing client BEFORE creating a new one
    if (this.client) {
      devWarn('[MQTT] Cleaning up previous client before reconnect');
      this._teardown();
    }

    this.publicKeyBase64 = publicKeyBase64;
    this._isDev = isDev;
    this.setState(ConnectionState.CONNECTING);

    const broker = isDev ? MQTT_CONFIG.devBroker : brokerUrl();

    const safeKey = toUrlSafeBase64(publicKeyBase64);

    // JWT 認證：取得 token 作為 MQTT password
    const gen = ++this._connectGen;
    const grant = isDev ? null : await this._obtainToken(publicKeyBase64);
    if (gen !== this._connectGen) {
      console.error('[MQTT] connect superseded while fetching token — not opening a second client');
      return this.connectingPromise ?? undefined;
    }
    // 換上這張（帳號已換 → null；手上已有更新的 → 用更新的那張）
    const jwtToken = grant ? this._adopt(grant) : null;

    // If token fetch failed in production, don't attempt connection (EMQX will reject)
    if (!isDev && !jwtToken) {
      console.error('[MQTT] No JWT token, aborting connect. tokenFailed:', this._tokenFetchFailedAt > 0, 'signer:', !!this._identitySigner);
      this.setState(ConnectionState.DISCONNECTED);
      this.connectingPromise = null;
      return;
    }
    if (isDev) this._tokenTopics = null;
    const temporary = this._temporaryCredential;

    // 遺囑（W4）：我的秘密 presence 主題上一則封好的「離線」（cs ＝ 這一條連線連上的時間；好友那邊比這條舊的連線的遺囑晚到也不採用）。
    //   主題是這張 token 有發布權的那一個；還沒有 tag、正在換秘密（舊主題不再發東西）、換機的臨時身分 → 不設遺囑
    this._presenceConnStart = this._serverNow();
    const willTopic = temporary ? null : this._myPresenceTopic();
    const willPayload = willTopic ? await this._sealPresence(willTopic, 0) : null;
    if (gen !== this._connectGen) {
      console.error('[MQTT] connect superseded while sealing the will — not opening a second client');
      return this.connectingPromise ?? undefined;
    }

    const options: IClientOptions = {
      // token 綁 clientId（JWT clientid claim）：mist_<公鑰前 16>_<deviceId 前 8>，換機臨時身分＝伺服器指定
      clientId: this._clientIdFor(publicKeyBase64),
      clean: false,
      reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
      connectTimeout: MQTT_CONFIG.connectTimeout,
      keepalive: MQTT_CONFIG.keepalive,
      // username 要跟 JWT 的 username claim 一字不差（broker verify_claims），JWT 作為 password
      username: isDev ? safeKey : (this._mqttUsername ?? safeKey),
      password: jwtToken ?? undefined,
      // 協定版本
      protocolVersion: 5,
      // MQTT 5.0: 持久 session，離線時 broker 暫存 QoS 1 訊息（24 小時）
      // 確保好友邀請、加密訊息等在對方離線期間不會丟失
      properties: {
        sessionExpiryInterval: 86_400,
      },
      // Last Will Testament：非正常斷線時 broker 替我在秘密 presence 主題上發「離線」（retained）
      ...(willTopic && willPayload ? { will: {
        topic: willTopic,
        payload: willPayload, // MQTT.js 會自動處理字串轉換
        qos: 1 as const,
        retain: true,
      } } : {}),
    };

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      devLog(`[MQTT] Connecting to ${broker}...`);
      const client = mqtt.connect(broker, options);
      this.client = client;
      // 被丟棄的 client（已被 teardown 或被新的取代）不准再改共用狀態
      const stale = () => this.client !== client;
      let settled = false;

      client.on('connect', (connack?: { sessionPresent?: boolean }) => {
        if (stale()) return;
        devLog('[MQTT] Connected OK');
        this._lastMessageReceivedAt = Date.now();
        this.setState(ConnectionState.CONNECTED);
        this.subscribeToDefaultTopics();
        /**
         * broker 沒有保留我的 session（重啟、24h 過期、新的 client）→ 好友 presence 與群組主題的訂閱都沒了
         * （部署前審查 BLOCKER，對應 AegisPlay B41）。以前群組頻道只在建群／收到邀請時訂一次，之後收不到
         * 成員變動、各台名冊岔開；presence 那份還記著「訂過了」，再也不訂。
         * 群組主題與 presence 主題（W4）都照範圍由 _syncGroupTopics／_syncPresenceTopics 重訂（這張 token 給得起的）。
         */
        if (!connack?.sessionPresent) {
          // broker 沒留 session：之前准過的群組主題都不算數了，等重新訂閱的 SUBACK（加入後的 sync 才不會早送）；
          //   上次留下、要退訂的也一起沒了
          this.grantedGroupTopics.clear();
          this.subscribedGroupTopics.clear();
          this._staleGroupTopics.clear();
          // presence 也是：全部重訂（重訂的時候 broker 會補送每個好友 retained 的現況）
          this.grantedPresenceTopics.clear();
          this.subscribedPresenceTopics.clear();
          this._stalePresenceTopics.clear();
        } else {
          // broker 還留著 session：上次 App 關掉前訂的群組主題可能還在裡面 → 不要的退訂（_syncGroupTopics）
          this._loadLeftoverGroupTopics();
          this._loadLeftoverPresenceTopics();
          // 上一條連線送了 SUBSCRIBE、還沒等到 SUBACK 就換了 client（換 token、HealthMonitor 重連）：那個回呼不會再來 ——
          //   沒確認的當成沒訂，重送（SUBSCRIBE 可以重複；審查 W3 M2：以前永遠不重送，加入後的 sync 也永遠不送）
          for (const t of [...this.subscribedGroupTopics]) {
            if (!this.grantedGroupTopics.has(t.split('/')[2])) this.subscribedGroupTopics.delete(t);
          }
          for (const t of [...this.subscribedPresenceTopics]) {
            if (!this.grantedPresenceTopics.has(t)) this.subscribedPresenceTopics.delete(t);
          }
        }
        // 範圍是在拿 token 期間才設好的 → 這張 token 的權限是舊的，換一張（見 _scheduleScopeReconnect）
        this._rescopeIfStale();
        this._syncGroupTopics();
        this._syncPresenceTopics();
        for (const cb of this.connectedListeners) {
          try { cb({ tokenSwap }); } catch (err) { console.error('[MQTT] connected listener failed:', err); }
        }
        // 到期前 5 分鐘先換新的再正常重連（不然到期那一刻 broker 踢線、發離線遺囑）
        this._scheduleTokenRefresh();
        // 先把 IDB 持久化的 queue 撈回記憶體，再 flush — 涵蓋 tab/browser 重啟後補送（臨時身分不能發布）
        if (!temporary) {
          this._loadPersistedQueue()
            .then(() => this._flushOutgoingQueue())
            .catch(err => devWarn('[MQTT] connect: load+flush failed:', err));
        }
        if (!settled) { settled = true; resolve(); }
      });

      client.on('reconnect', () => {
        if (stale()) return;
        devWarn('[MQTT] Reconnecting...');
        this.setState(ConnectionState.RECONNECTING);
      });

      client.on('close', () => {
        if (stale()) return;
        devWarn('[MQTT] Connection closed');
        this.setState(ConnectionState.DISCONNECTED);
      });

      // MQTT 5.0: server-initiated disconnect with reason code
      client.on('disconnect', (packet: { reasonCode?: number; properties?: { reasonString?: string } }) => {
        devWarn(`[MQTT] Disconnect from server: code=${packet?.reasonCode}, reason=${packet?.properties?.reasonString || 'none'}`);
      });

      client.on('offline', () => {
        devWarn('[MQTT] Client went offline');
      });

      // 追蹤所有收到的封包（包括 PINGRESP）來偵測連線存活
      // mqtt.js 的 PINGREQ/PINGRESP 不會觸發 'message' 事件
      client.on('packetreceive', () => {
        this._lastMessageReceivedAt = Date.now();
      });

      client.on('error', (error) => {
        // Must use console.error (not devWarn) — devWarn is stripped in release,
        // causing mqtt.js errors to become Uncaught Errors
        console.error('[MQTT] Error:', error?.message || error);
        if (!stale()) this.setState(ConnectionState.ERROR);
        // Only reject the initial connect promise, not reconnect errors
        if (!settled) { settled = true; reject(error); }
      });

      client.on('message', (topic, payload, packet) => {
        this._lastMessageReceivedAt = Date.now();
        this.handleMessage(topic, payload, packet?.retain === true);
      });

      // 連線超時。被 teardown／取代的舊 client 也要把自己的 promise 了結（它的 listener 已被移除，不會再 resolve），
      // 但**只看自己**：this.state 此時可能是新連線的 CONNECTING／CONNECTED（對應群星 Codex review #9）
      setTimeout(() => {
        if (!settled && (stale() || this.state === ConnectionState.CONNECTING)) {
          settled = true;
          reject(new Error(stale() ? 'Connection superseded' : 'Connection timeout'));
        }
      }, MQTT_CONFIG.connectTimeout);
    });
    const promise = this.connectingPromise;
    // 只清掉「自己」——新連線可能已經換上自己的 promise
    void promise.finally(() => { if (this.connectingPromise === promise) this.connectingPromise = null; }).catch(() => {});

    return promise;
  }

  /**
   * SUBACK 裡每個主題的原因碼（≥ 0x80 ＝ 被拒）。mqtt.js 5：只要有一個被拒，callback 就拿到 err、第二個參數是**要求的** qos、
   * 真正的原因碼在第三個參數（＝err.packet）的 granted；全部准了 err 才是 null、第二個參數是准的 qos（審查 W3 L4）。
   * 對不起來（連線斷了之類的 err，沒有 SUBACK）→ null：當成全部沒訂到
   */
  private static subackCodes(err: unknown, granted: ReadonlyArray<{ qos: number }> | undefined, packet: unknown, n: number): number[] | null {
    const fromPacket = (packet as { granted?: unknown } | undefined)?.granted
      ?? (err as { packet?: { granted?: unknown } } | null)?.packet?.granted;
    if (Array.isArray(fromPacket) && fromPacket.length === n && fromPacket.every((c) => typeof c === 'number')) return fromPacket as number[];
    if (!err && Array.isArray(granted) && granted.length === n) return granted.map((g) => g.qos);
    return null;
  }

  /** localStorage 裡記著的、這個帳號在 broker session 裡可能訂著的群組主題（_persistGroupTopics） */
  private _groupTopicsStoreKey(): string | null {
    return this.publicKeyBase64 && !this._temporaryCredential ? `${GROUP_TOPICS_KEY_PREFIX}${toUrlSafeBase64(this.publicKeyBase64)}` : null;
  }

  /** 訂著的＋還沒確認退訂的群組主題寫進 localStorage：App 重開後 broker 還留著 session 時，才知道要退訂哪些 */
  private _persistGroupTopics(): void {
    const key = this._groupTopicsStoreKey();
    if (!key) return;
    try {
      const all = [...new Set([...this.subscribedGroupTopics, ...this._staleGroupTopics])];
      if (all.length) localStorage.setItem(key, JSON.stringify(all));
      else localStorage.removeItem(key);
    } catch { /* 沒有 localStorage（測試）或寫不進去：最壞是重開後少退訂幾個舊主題（session 到期就沒了） */ }
  }

  /** 上次 App 關掉前訂的群組主題（broker 說 session 還在）：現在沒追蹤的都當成「可能還訂著」，交給 _syncGroupTopics 退訂 */
  private _loadLeftoverGroupTopics(): void {
    const key = this._groupTopicsStoreKey();
    if (!key) return;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
      if (!Array.isArray(raw)) return;
      for (const t of raw) {
        if (typeof t !== 'string' || this.subscribedGroupTopics.has(t)) continue;
        const parts = t.split('/');
        if (parts.length === 4 && parts[0] === 'mist' && parts[1] === 'group' && isGroupTopicId(parts[2]) && parts[3] === '+') {
          this._staleGroupTopics.add(t);
        }
      }
    } catch { /* 讀不到：同上 */ }
  }

  /**
   * 群組主題的訂閱照訂閱範圍調整（W3）：範圍裡沒有的（換金鑰後上一代的過了重疊期、被踢、退群、上次留下的）退訂；
   * 範圍裡有、這張 token 給得起、還沒訂的補訂（給不起的等換 token 重連後再來）。SUBACK 准了才算訂好（_groupGranted →
   * 群組引擎 onTopicReady）；被拒的不追蹤，下次再試。連著才做；連上時（CONNACK）、範圍變了時都會呼叫。
   */
  private _syncGroupTopics(): void {
    const client = this.client;
    if (!client?.connected || !this.publicKeyBase64 || this._temporaryCredential) return;
    const topics = this.getTopics();
    const desired = new Set((this._aclScope?.groups ?? []).map((tid) => topics.group(tid)));
    for (const t of desired) this._staleGroupTopics.delete(t);
    const drop = [...new Set([...this.subscribedGroupTopics, ...this._staleGroupTopics])].filter((t) => !desired.has(t));
    if (drop.length) {
      for (const t of drop) {
        this.subscribedGroupTopics.delete(t);
        this.grantedGroupTopics.delete(t.split('/')[2]);
        this._staleGroupTopics.add(t);   // 確認退訂之前還算「可能訂著」：App 這時關掉，下次重開再退一次
      }
      client.unsubscribe(drop, (err?: Error) => {
        if (this.client !== client || err) return;
        for (const t of drop) this._staleGroupTopics.delete(t);
        this._persistGroupTopics();
      });
    }
    const fresh = [...desired].filter((t) => !this.subscribedGroupTopics.has(t) && this._tokenAllows(t));
    if (fresh.length) {
      for (const t of fresh) this.subscribedGroupTopics.add(t);
      client.subscribe(fresh, { qos: 1 }, (err, granted, packet) => {
        if (this.client !== client) return;
        // 每個主題各自看准了沒（mqtt.js 5：同一批有一個被拒，整批是 err —— 准了的那幾個照樣算訂好，見 subackCodes）
        const codes = MqttService.subackCodes(err, granted, packet, fresh.length);
        fresh.forEach((t, i) => {
          if (!this.subscribedGroupTopics.has(t)) return;   // 等 SUBACK 的時候已經不要了（已退訂）
          const code = codes?.[i];
          if (code === undefined || code >= 0x80) {
            // 沒訂成：不追蹤，下次（範圍變了、重連）再試
            this.subscribedGroupTopics.delete(t);
            if (code !== undefined) console.error('[MQTT] Group topic subscription refused by ACL');
          } else {
            this._groupGranted(t);
          }
        });
        if (!codes) devWarn('[MQTT] Failed to subscribe to group topics:', err);
        this._persistGroupTopics();
      });
    }
    this._persistGroupTopics();
  }

  // ============================================
  // 好友的 presence 主題訂閱（W4）：跟群組主題同一套規則，照範圍（presenceService 給的確切主題）訂／退訂
  // ============================================

  private _presenceTopicsStoreKey(): string | null {
    return this.publicKeyBase64 && !this._temporaryCredential ? `${PRESENCE_TOPICS_KEY_PREFIX}${toUrlSafeBase64(this.publicKeyBase64)}` : null;
  }

  private _persistPresenceTopics(): void {
    const key = this._presenceTopicsStoreKey();
    if (!key) return;
    try {
      const all = [...new Set([...this.subscribedPresenceTopics, ...this._stalePresenceTopics])];
      if (all.length) localStorage.setItem(key, JSON.stringify(all));
      else localStorage.removeItem(key);
    } catch { /* 沒有 localStorage：最壞是重開後少退訂幾個舊主題（session 到期就沒了） */ }
  }

  /** 上次 App 關掉前訂的 presence 主題（broker 還留著 session）：現在沒追蹤的交給 _syncPresenceTopics 退訂（前好友、換了秘密的舊主題） */
  private _loadLeftoverPresenceTopics(): void {
    const key = this._presenceTopicsStoreKey();
    if (!key) return;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
      if (!Array.isArray(raw)) return;
      for (const t of raw) if (isPresenceTopic(t) && !this.subscribedPresenceTopics.has(t)) this._stalePresenceTopics.add(t);
    } catch { /* 讀不到：同上 */ }
  }

  /**
   * presence 主題的訂閱照範圍調整：範圍裡沒有的（刪好友、好友換了秘密、上次留下的）退訂；範圍裡有、這張 token 給得起、
   * 還沒訂的補訂（訂的那一刻 broker 補送 retained 的現況）。SUBACK 准了才算訂好；被拒的不追蹤，下次再試。
   */
  private _syncPresenceTopics(): void {
    const client = this.client;
    if (!client?.connected || !this.publicKeyBase64 || this._temporaryCredential) return;
    const desired = new Set(this._aclScope?.presence ?? []);
    for (const t of desired) this._stalePresenceTopics.delete(t);
    const drop = [...new Set([...this.subscribedPresenceTopics, ...this._stalePresenceTopics])].filter((t) => !desired.has(t));
    if (drop.length) {
      for (const t of drop) {
        this.subscribedPresenceTopics.delete(t);
        this.grantedPresenceTopics.delete(t);
        this._stalePresenceTopics.add(t);
      }
      client.unsubscribe(drop, (err?: Error) => {
        if (this.client !== client || err) return;
        for (const t of drop) this._stalePresenceTopics.delete(t);
        this._persistPresenceTopics();
      });
    }
    const fresh = [...desired].filter((t) => !this.subscribedPresenceTopics.has(t) && this._tokenAllows(t));
    if (fresh.length) {
      for (const t of fresh) this.subscribedPresenceTopics.add(t);
      client.subscribe(fresh, { qos: 1 }, (err, granted, packet) => {
        if (this.client !== client) return;
        const codes = MqttService.subackCodes(err, granted, packet, fresh.length);
        fresh.forEach((t, i) => {
          if (!this.subscribedPresenceTopics.has(t)) return;
          const code = codes?.[i];
          if (code === undefined || code >= 0x80) {
            this.subscribedPresenceTopics.delete(t);
            if (code !== undefined) console.error('[MQTT] Presence subscription refused by ACL');
          } else {
            this.grantedPresenceTopics.add(t);
          }
        });
        if (!codes) devWarn('[MQTT] Failed to subscribe to presence topics:', err);
        this._persistPresenceTopics();
      });
    }
    this._persistPresenceTopics();
  }

  /**
   * 斷開連線（用戶主動：登出、清除帳號、被踢、換機取消／完成）。上一個帳號的一切都不帶到下一個：
   * 手上的 token、**還在路上的 token 請求**（帳號世代加一，回來就丟）、還在拿 token 的 connect（連線世代加一）、
   * 範圍、待送與訂閱清單。審查 LOW：以前只有「已經有 client」才清 —— 正在拿 token（還沒有 client）時登出，
   * 範圍留著，下一個帳號的第一張 token 就用上一個帳號的群組／好友去要。
   */
  disconnect(): void {
    if (this.client) {
      devLog('[MQTT] Disconnecting (user-initiated)');
      this._teardown();
    } else {
      this._connectGen += 1;          // 拿 token 中的 connect 回來後不建 client
      this.connectingPromise = null;
      if (this.state !== ConnectionState.DISCONNECTED) this.setState(ConnectionState.DISCONNECTED);
    }
    this._forgetToken();
    if (this._scopeReconnectTimer) clearTimeout(this._scopeReconnectTimer);
    this._scopeReconnectTimer = null;
    this._scopeReconnectAt = 0;
    this.publicKeyBase64 = null;
    // 記憶體裡的待送訊息、訂閱清單（IDB 那份由清除帳號處理）
    this.outgoingQueue = [];
    // presence：好友的狀態是這個帳號的（下一個帳號的 listener 不能拿到）；localStorage 那份訂閱清單留著，下次這個帳號連上時退訂
    this.subscribedPresenceTopics.clear();
    this._stalePresenceTopics.clear();
    this.grantedPresenceTopics.clear();
    this.friendPresence.clear();
    this._presenceFloor.clear();
    this._presenceNotified.clear();
    if (this._presenceExpiryTimer) clearTimeout(this._presenceExpiryTimer);
    this._presenceExpiryTimer = null;
    // 群組主題：記憶體的清掉；localStorage 那份（這個帳號 broker session 裡可能還訂著的）留著，下次這個帳號連上時退訂
    this.subscribedGroupTopics.clear();
    this._staleGroupTopics.clear();
    this.grantedGroupTopics.clear();
    this._aclScope = null;
    this._aclScopeOwner = null;
    this._scopeOverflowKey = '0|0';
    this._scopeExpectedUntil = 0;
    const waiters = this._scopeWaiters;
    this._scopeWaiters = [];
    for (const w of waiters) w();
    this._tokenFetchFailedAt = 0;
    this._lastTokenError = null;
    // 換機取消／完成：臨時身分不能留給下一次連線用（token 已在 _forgetToken 丟掉）
    this._temporaryCredential = false;
    // 還沒有 listener 而暫存的訊息是寄給這個帳號的：不能重播給下一個帳號的 listener
    for (const typeKey of [...this.pendingMessages.keys()]) this._dropPending(typeKey);
  }

  /**
   * 優雅關閉 — App 進背景 / 頁面卸載時主動宣告離線後才斷線。
   *
   * 為什麼需要：_teardown 用 `client.end(true)` 直接關掉 socket、**不送** MQTT DISCONNECT（mqtt.js 的 forced 路徑），
   * 所以 broker 最後會發 LWT（離線 presence）—— 但要等它發現連線斷了；App 被凍結時 socket 可能還半開著，
   * 好友端就一直看到 online=true，直到 broker keepalive 逾時(~45s)。
   * 這裡先在我的秘密 presence 主題上 publish 封好的「離線」（qos:1, retain:true）並等 PUBACK，
   * 確保好友「立即」看到離線。（換 token 重連時反過來：_teardown({ graceful }) 送 DISCONNECT，不要遺囑。）
   *
   * 與 disconnect() 不同：**保留 publicKeyBase64**。
   * 手機 pause/resume 是週期(非登出)，保留 key 讓 forceReconnect()/HealthMonitor
   * 在 resume 時能用 savedKey 重連。(AegisTrans 會清 key,但它只在 Electron quit 呼叫,情境不同。)
   */
  async gracefulShutdown(timeoutMs = 1200): Promise<void> {
    if (!this.client || !this.publicKeyBase64) return;
    const client = this.client;
    const presenceTopic = this._myPresenceTopic();
    let noWill = false;

    try {
      // 封（AES-GCM）也算在逾時裡：背景時間有限
      const deadline = Date.now() + timeoutMs;
      const payload = presenceTopic
        ? await Promise.race([this._sealPresence(presenceTopic, 0), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))])
        : null;
      // 正在換秘密（或剛換、token 還是舊的）：codec 不封這個主題 → 這條連線的遺囑是舊秘密封的，不能讓 broker 發在清掉的舊主題上
      //   → 正常斷線（DISCONNECT，沒有遺囑；審查 W4 #6）
      if (presenceTopic && !this._presenceCodec?.current(presenceTopic)) {
        noWill = true;
        return;
      }
      if (payload && presenceTopic && this.client === client) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          // 硬逾時：背景時間有限(尤其 web unload),不能無限等 PUBACK
          const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
          try {
            client.publish(presenceTopic, payload, { qos: 1, retain: true }, () => { clearTimeout(timer); done(); });
          } catch {
            clearTimeout(timer);
            done();
          }
        });
        devLog('[MQTT] gracefulShutdown: offline presence published');
      }
    } finally {
      // 銷毀 client 但保留 publicKeyBase64(見上方註解)
      if (noWill) await this._teardown({ graceful: true });
      else this._teardown();
    }
  }

  /**
   * 完全銷毀現有 MQTT client（共用方法）
   * 用於 forceReconnect / disconnect / connect 前清理。
   * 預設 end(true)：直接關 socket、不送 DISCONNECT（死連線等不到回應），broker 會發離線遺囑。
   * graceful（換 token 重連，_swapToken）：連著的話送 MQTT DISCONNECT（reason 0，broker 不發遺囑、session 保留），
   * 等 socket 關掉（最多 GRACEFUL_CLOSE_MS）再回來。狀態一律當下就清，回傳的 promise 只代表舊連線關好了。
   */
  private _teardown(opts: { graceful?: boolean } = {}): Promise<void> {
    let closed: Promise<void> = Promise.resolve();
    if (this.client) {
      const client = this.client;
      try {
        client.removeAllListeners();
        // 防 Uncaught「connack timeout」：若 client 是在「連線中(CONNECTING)」被 teardown，
        //   mqtt.js 內部的 connack 計時器可能在 removeAllListeners 之後才觸發 'error' →
        //   此時已無 handler → 變成 Uncaught Error，會打斷正在進行的恢復流程(connect 重試/
        //   Health Monitor)，導致恢復後 MQTT 連不上、傳不出訊息(Test 35c fix1 實證)。
        //   補一個 no-op error handler，吞掉這個垂死 client 的殘留錯誤(它即將被丟棄)。
        client.on('error', () => { /* swallow late errors on dying client */ });
        if (opts.graceful && client.connected) {
          closed = new Promise<void>((resolve) => {
            const force = setTimeout(() => {
              try { client.end(true); } catch { /* already gone */ }
              resolve();
            }, MqttService.GRACEFUL_CLOSE_MS);
            client.end(false, { reasonCode: 0 }, () => { clearTimeout(force); resolve(); });
          });
        } else {
          client.end(true);
        }
      } catch {
        // Ignore cleanup errors
      }
      this.client = null;
    }
    this._clearTokenRefresh();
    if (this._presenceRefreshTimer) clearTimeout(this._presenceRefreshTimer);
    this._presenceRefreshTimer = null;
    // 還沒等到 PUBACK 的 durable 訊息（稽核 M7）：clean:false 時 mqtt.js end(true) 不會回呼 publish callback，
    //   client 丟掉後它們永遠停在 inflight、_loadPersistedQueue 也跳過 → 直到 App 重啟才補送。
    //   放回待送佇列，下次連上重送（收端可去重：X3DH 有 x3dhReplay，群組事件可重放）。
    //   即時的（通話控制）不放回，也從 IDB 拔掉（否則下次 connect 的 _loadPersistedQueue 又載回來）。
    //   送出中的都比佇列裡的早排入（flush 會清空佇列）→ 放在最前面，同一毫秒排入的也不會顛倒。
    const requeued: OutgoingMessage[] = [];
    for (const msg of this._inflight.values()) {
      if (MqttService.isTransient(msg)) {
        void (this._persisting.get(msg.id) ?? Promise.resolve()).then(() => removeOutgoing(msg.id))
          .catch(e => devWarn('[MQTT] removeOutgoing on teardown failed:', e));
      } else {
        requeued.push(msg);
      }
    }
    const requeuedIds = new Set(requeued.map(m => m.id));
    this.outgoingQueue = [...requeued, ...this.outgoingQueue.filter(m => !requeuedIds.has(m.id))];
    this._inflight.clear();
    this._sortOutgoingQueue();
    this._dropSupersededInits();   // 放回的舊 X3DH_INIT 若已有更新的一封在排，不再重送舊的
    this._connectGen += 1;   // 拿 token 中的舊 connect 回來後不准再建 client
    this.connectingPromise = null;
    this.setState(ConnectionState.DISCONNECTED);
    return closed;
  }

  /**
   * 強制重新連線 — 完全銷毀 client + 新建連線
   *
   * 由 MqttHealthMonitor 呼叫，不再有 guard 阻止。
   * 這是應對 OS 殺 socket 後唯一有效的恢復方式。
   */
  async forceReconnect(): Promise<void> {
    const savedKey = this.publicKeyBase64;
    if (!savedKey) {
      console.error('[MQTT] forceReconnect: no publicKey, skipping');
      return;
    }

    // If mqtt.js reports connected AND the underlying WebSocket is actually open,
    // skip force reconnect — the connection is alive
    if (this.client?.connected) {
      const ws = (this.client as unknown as { stream?: { socket?: WebSocket } })?.stream?.socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        devLog('[MQTT] forceReconnect: already connected (ws=OPEN), skipping');
        return;
      }
      // WebSocket is not OPEN despite mqtt.js thinking it's connected — zombie state
      devWarn(`[MQTT] forceReconnect: zombie detected (ws.readyState=${ws?.readyState})`);
    }

    // 不再有 "mqtt.js is internally reconnecting" guard
    // reconnectPeriod=0 已停用 mqtt.js 內建重連，此 guard 不再需要

    devWarn('[MQTT] forceReconnect: tearing down...');
    this._teardown();
    devLog('[MQTT] forceReconnect: reconnecting...');
    await this.connect(savedKey, this._isDev);
  }

  /**
   * 訂閱預設主題
   */
  private subscribeToDefaultTopics(): void {
    if (!this.client) return;

    const topics = this.getTopics();

    // 訂閱個人收件箱
    this.client.subscribe(topics.inbox, { qos: 1 }, (err) => {
      if (err) {
        devWarn('[MQTT] Failed to subscribe to inbox:', err);
      } else {
        devLog('[MQTT] Subscribed to inbox');
      }
    });

    // （mist/broadcast 廣播頻道拿掉了：沒有功能在用，任何人都能往裡面發；token 的 ACL 也不給它）

    // 換機的臨時身分只收得到自己的收件箱：沒有 kick、不發 presence
    if (this._temporaryCredential) return;

    // Phase 35b: 訂閱本裝置的 kick 通道（VPS 即時踢下線推播）—— token 只給簽過名的那台裝置的 kick 主題
    try {
      const deviceId = (typeof localStorage !== 'undefined' && localStorage.getItem('aegis_device_id')) || '';
      if (deviceId && this.client && this._tokenAllows(`aegis/device/${deviceId}/kicked`)) {
        const kickTopic = `aegis/device/${deviceId}/kicked`;
        this.client.subscribe(kickTopic, { qos: 1 }, (err) => {
          if (err) {
            devWarn('[MQTT] Failed to subscribe to kick topic:', err);
          } else {
            devLog('[MQTT] Subscribed to kick topic:', kickTopic);
          }
        });
      }
    } catch (e) {
      devWarn('[MQTT] kick subscribe error:', e);
    }

    // 上線（W4：封好的「在線」發在我的秘密 presence 主題上，retained 讓新訂閱的好友拿到現況），之後每 4 分鐘更新一次
    void this._publishPresence(1);
    this._schedulePresenceRefresh();
  }

  // 群組主題的訂閱沒有個別的 subscribe／unsubscribe（W3）：照訂閱範圍（setAclScope）由 _syncGroupTopics 調整

  // ============================================
  // Presence（W4：只有好友看得到，docs/GROUP_LOG_WIRING_W4.md）
  //   我的：mist/user/<我>/presence/<tag>，payload 由 presenceService 的 codec 封（AES-GCM、AAD＝主題），retained
  //   好友的：範圍裡確切的主題（presenceService 給），收到的交給 codec 拆、照 acceptState 排順序
  //   同群組但不是好友的人不在這裡（群組主題上的 here 與 P2P 的狀態，memberPresence.ts）
  // ============================================

  /** AppProvider：presenceService 的加解密（登出／換帳號時 null） */
  setPresenceCodec(codec: PresenceCodec | null): void {
    this._presenceCodec = codec;
  }

  /** 封一則我的狀態（ts ＝ 現在、cs ＝ 這一條連線連上的時間）；沒有 codec、正在換秘密、不是我目前的主題 → null */
  private async _sealPresence(topic: string, on: 0 | 1): Promise<string | null> {
    const codec = this._presenceCodec;
    if (!codec) return null;
    const cs = this._presenceConnStart;
    try {
      return await codec.seal(topic, { on, ts: Math.max(this._serverNow(), cs), cs });
    } catch (err) {
      console.error('[MQTT] sealing presence failed:', (err as Error)?.message ?? err);
      return null;
    }
  }

  /** 在我的秘密主題上發一則狀態（retained、QoS1）。還沒有 tag、正在換秘密（舊主題不再發東西）→ 不發 */
  private async _publishPresence(on: 0 | 1): Promise<void> {
    const client = this.client;
    const topic = this._myPresenceTopic();
    if (!client || !topic) return;
    const payload = await this._sealPresence(topic, on);
    // 封的時候換了 client、換了 tag（換秘密、換 token）、或剛開始換秘密（舊主題已經清掉或正要清，審查 W4 #6）→ 不發在舊的上面
    if (!payload || this.client !== client || !client.connected || this._myPresenceTopic() !== topic
        || !this._presenceCodec?.current(topic)) return;
    client.publish(topic, payload, { qos: 1, retain: true });
    devLog(`[MQTT] Published presence: ${on ? 'online' : 'offline'}`);
  }

  /** 連著的時候每 PRESENCE_REFRESH_MS 重發一次「在線」：好友那邊在線的 TTL 才不會到，新訂閱的人拿到的 retained 也夠新 */
  private _schedulePresenceRefresh(): void {
    if (this._presenceRefreshTimer) clearTimeout(this._presenceRefreshTimer);
    this._presenceRefreshTimer = null;
    if (this._temporaryCredential) return;
    const timer = setTimeout(() => {
      if (this._presenceRefreshTimer !== timer) return;
      this._presenceRefreshTimer = null;
      if (!this.client?.connected) return;
      void this._publishPresence(1);
      this._schedulePresenceRefresh();
    }, PRESENCE_REFRESH_MS);
    (timer as { unref?: () => void }).unref?.();
    this._presenceRefreshTimer = timer;
  }

  /**
   * presenceService：換秘密之前先清掉舊主題上 broker 存著的最後狀態（空的 retained）。只發在這張 token 有發布權的那一個主題
   * （＝我目前的主題）上；等 PUBACK（最多 5 秒）。沒連上、不是我目前的主題、broker 拒絕 → false（先不換，下次連上再試）
   */
  clearPresence(topic: string): Promise<boolean> {
    const client = this.client;
    if (!client?.connected || topic !== this._myPresenceTopic()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      try {
        client.publish(topic, '', { qos: 1, retain: true }, (err) => { clearTimeout(timer); resolve(!err && this.client === client); });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /** 範圍裡沒有某個好友的主題了（刪好友、範圍變小）：他的狀態丟掉（通知一次離線） */
  private _forgetPresenceOutside(topics: readonly string[]): void {
    const keep = new Set(topics);
    for (const t of [...this._presenceFloor.keys()]) if (!keep.has(t)) this._presenceFloor.delete(t);
    const owners = new Set(topics.map((t) => t.split('/')[2]));
    for (const pk of [...this.friendPresence.keys()]) {
      if (owners.has(toUrlSafeBase64(pk))) continue;
      this.friendPresence.delete(pk);
      this._notifyPresence(pk);
    }
  }

  /** 這個好友在不在線變了才通知（第一次知道他離線、而且根本沒有他的狀態 → 不通知） */
  private _notifyPresence(pk: string): void {
    const online = stillOnline(this.friendPresence.get(pk), this._presenceNow());
    const was = this._presenceNotified.get(pk);
    if (was === online || (was === undefined && !online && !this.friendPresence.has(pk))) return;
    this._presenceNotified.set(pk, online);
    devLog(`[MQTT] Friend ${pk.slice(0, 8)}... is now ${online ? 'online' : 'offline'}`);
    this.presenceListeners.forEach((callback) => {
      try { callback(pk, online); } catch (err) { console.error('[MQTT] presence listener failed:', err); }
    });
  }

  /** 在線的 TTL（ONLINE_TTL_MS）到的那一刻補一次通知（遺囑被擋掉、被丟掉時，好友不會一直以為我在線、一直不發推播） */
  private _armPresenceExpiry(): void {
    if (this._presenceExpiryTimer) clearTimeout(this._presenceExpiryTimer);
    this._presenceExpiryTimer = null;
    const now = this._presenceNow();
    let next = Infinity;
    for (const [pk, st] of [...this.friendPresence]) {
      if (stillOnline(st, now)) next = Math.min(next, st.ts + ONLINE_TTL_MS);
      else if (this._presenceNotified.get(pk)) this._notifyPresence(pk);   // TTL 已經過了：補通知「離線」
    }
    if (next === Infinity) return;
    const timer = setTimeout(() => {
      if (this._presenceExpiryTimer !== timer) return;
      this._presenceExpiryTimer = null;
      this._armPresenceExpiry();
    }, Math.max(0, next - now) + 50);
    (timer as { unref?: () => void }).unref?.();
    this._presenceExpiryTimer = timer;
  }

  /**
   * 好友的 presence 主題上收到一則（W4）。payload 沒有寄件人、沒有明文：交給 codec 用他的秘密拆（不是他目前那一個主題、
   * 解不開 → 丟，營運方寫的「在線」也在這裡被擋掉）。空的 ＝ 他清掉了這個主題（換了秘密）→ 先當他離線，codec 跟他要新的。
   * 照 acceptState 排順序（舊的在線、舊連線晚到的遺囑不採用）；一則一則依序處理（解密是 await，後到的不能先套上）
   */
  private _receivePresence(topic: string, payload: Buffer): void {
    const raw = payload.toString();
    this._presenceChain = this._presenceChain.then(async () => {
      const codec = this._presenceCodec;
      if (!codec) return;
      if (raw.length === 0) {
        // 只有他「目前」的主題被清掉才把他的狀態清掉（舊主題上的空訊息不動他現在的狀態，審查 W4 #8）
        const current = codec.cleared(topic);
        const owner = parsePresenceTopic(topic)?.owner;
        this._presenceStat(current ? 'cleared' : 'cleared-other-topic');
        if (current && owner && this.friendPresence.delete(owner)) this._notifyPresence(owner);
        return;
      }
      const opened = await codec.open(topic, raw);
      if (!opened) {
        this._presenceStat('notOpened');
        devLog('[MQTT] presence not opened (not a current friend topic, or forged)');
        return;
      }
      // 他的狀態被清掉了（空的 retained）也照這個主題上最後採用的那一則排順序（W5：清掉之後重放同一個主題上更早的不算）
      const prev = this.friendPresence.get(opened.owner) ?? this._presenceFloor.get(topic) ?? null;
      if (!acceptState(prev, opened.state, this._presenceNow())) {
        this._presenceStat('outOfOrder');
        devLog('[MQTT] stale or out-of-order presence ignored');
        return;
      }
      this._presenceStat(opened.state.on ? 'acceptedOnline' : 'acceptedOffline');
      this.friendPresence.set(opened.owner, opened.state);
      this._presenceFloor.set(topic, opened.state);
      this._notifyPresence(opened.owner);
      this._armPresenceExpiry();
    }).catch((err) => devWarn('[MQTT] presence handling failed:', err));
  }

  private _presenceStat(k: string): void {
    this._presenceStats[k] = (this._presenceStats[k] ?? 0) + 1;
  }

  /** 收 presence 的計數（E2E 與模擬的 PRESENCE 檢查用）；svc. 開頭的是 presence 服務自己的（拆不開、還沒載完…） */
  presenceStats(): Record<string, number> {
    const svc = this._presenceCodec?.stats?.() ?? {};
    return { ...this._presenceStats, ...Object.fromEntries(Object.entries(svc).map(([k, v]) => [`svc.${k}`, v])) };
  }

  /**
   * 監聽好友 presence 變化（W4：只有好友；同群組的非好友看 memberPresence）
   */
  onPresenceChange(callback: PresenceCallback): () => void {
    this.presenceListeners.add(callback);
    /**
     * 補送目前已知的狀態（對應群星）。presence 只在「變化」時通知，而 retained presence 在訂閱當下就到 ——
     * 換範圍重連後常常比 AppProvider 重新掛上的監聽器早幾毫秒，之後的重發都是「沒變化」→ 上層永遠不知道對方在線。
     */
    const now = this._presenceNow();
    for (const [pk, st] of this.friendPresence) {
      const online = stillOnline(st, now);
      queueMicrotask(() => { if (this.presenceListeners.has(callback)) callback(pk, online); });
    }
    return () => {
      this.presenceListeners.delete(callback);
    };
  }

  /**
   * 好友現在在線嗎（驗過、解得開、夠新的「在線」，而且 TTL 內有更新）：useChat 據此決定要不要發推播
   */
  isFriendOnline(friendPublicKey: string): boolean {
    return stillOnline(this.friendPresence.get(friendPublicKey), this._presenceNow());
  }

  /**
   * 發送訊息給指定用戶（沒連上就排進待送佇列，連上再送）。
   * 外層只有 { type, from, to, payload, timestamp }：推播提示不再搭在 MQTT 上（要推播的呼叫端自己叫 triggerFcmNotify）。
   * @param opts.ttlMs 排隊最多多久（DIRECT_SEALED 的種類在密文裡，佇列看不出來：送的人說）
   */
  sendToUser(
    recipientPublicKeyBase64: string,
    type: MessageType,
    payload: unknown,
    opts: { ttlMs?: number } = {},
  ): void {
    if (!this.publicKeyBase64) {
      throw new Error('No public key configured');
    }

    // 收件人的收件箱，最後一節是自己（ACL 只准這樣發）
    const topic = this.inboxTopicFor(recipientPublicKeyBase64);
    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,  // 保持原始格式用於識別
      to: recipientPublicKeyBase64,
      payload,
      timestamp: this._serverNow(),
    };

    const jsonPayload = JSON.stringify(message);

    // 離線時緩衝到 outgoingQueue，重連後自動 flush
    if (!this.client?.connected) {
      this._enqueueOutgoing(topic, jsonPayload, 1, opts.ttlMs);
      return;
    }

    if (MqttService.DURABLE_TYPES.has(type)) this._publishDurable(topic, jsonPayload);
    else this.client.publish(topic, jsonPayload, MqttService.publishOptions(opts.ttlMs));
  }

  /** 即時信令在 broker 的離線佇列裡最多留多久（秒；MQTT 5 message expiry） */
  private static readonly TRANSIENT_EXPIRY_S = 120;

  /**
   * QoS1；有期限的（通話信令 60 秒、個人資料等 24 小時）也告訴 broker（MQTT 5 message expiry）：收件人離線時 broker 替他排的
   * 過了期限就丟，不會在他連上時一口氣倒進來（審查 L4：一堆過期的 ICE 用光額度、擠掉剛到的來電）
   */
  private static publishOptions(ttlMs?: number): { qos: 1; properties?: { messageExpiryInterval: number } } {
    if (typeof ttlMs !== 'number' || !(ttlMs > 0)) return { qos: 1 };
    return { qos: 1, properties: { messageExpiryInterval: Math.max(1, Math.ceil(ttlMs / 1000)) } };
  }

  /**
   * 發送訊息到群組主題（W2 起只有 group_sealed；W3 主題是 tid ＝ 這則訊息那一代的金鑰推出來的）。
   * 只在連著的時候送、**不排隊**：排著的那則是用當時那一代封的，連上的時候可能已經換了一代 —— 送出去就是在上一代的主題上
   * 用上一代的金鑰發新東西（被踢的人看得到）。沒連上回 false：群組引擎把它留著，連上再用那時的這一代重封（groupEngineControl）。
   * qos 0（here／sync）只給現在在線的人；qos 1 broker 替離線的成員排隊。
   */
  sendToGroup(tid: string, type: MessageType, payload: unknown, opts: { qos?: 0 | 1 } = {}): boolean {
    if (!this.publicKeyBase64) {
      throw new Error('No public key configured');
    }
    if (!isGroupTopicId(tid) || !this.client?.connected) return false;

    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,
      payload,
      timestamp: this._serverNow(),
    };
    this.client.publish(this.groupTopicFor(tid), JSON.stringify(message), { qos: opts.qos ?? 1 });
    return true;
  }

  /**
   * 即時的定向訊息（群組通話的 offer／answer／ICE；1 對 1 的 DataChannel 與通話的 offer／answer／ICE／DTLS 指紋 ——
   * 都封給收件人身分金鑰）：連著才送（QoS1），不持久化、不排隊 —— 過了幾秒的信令只會搗亂（收端也看封裝時間丟掉舊的）。
   * broker 替離線的收件人排的 2 分鐘後過期（MQTT 5 message expiry，審查 L4）。
   * 型別是 durable 的 GROUP_KEY_SEALED 也一樣走這條。
   */
  sendTransientToUser(recipientPublicKeyBase64: string, type: MessageType, payload: unknown): boolean {
    if (!this.publicKeyBase64) throw new Error('No public key configured');
    if (!this.client?.connected) return false;
    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,
      to: recipientPublicKeyBase64,
      payload,
      timestamp: this._serverNow(),
    };
    this.client.publish(this.inboxTopicFor(recipientPublicKeyBase64), JSON.stringify(message),
      MqttService.publishOptions(MqttService.TRANSIENT_EXPIRY_S * 1000));
    return true;
  }

  /**
   * 驗證 MQTT 訊息結構
   * 防止惡意 / 畸形訊息被處理
   */
  private validateMessage(parsed: unknown): parsed is MqttMessage {
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;

    // 必要欄位檢查
    if (typeof msg.type !== 'string' || !msg.type) return false;
    if (typeof msg.from !== 'string' || !msg.from) return false;
    if (typeof msg.timestamp !== 'number') return false;

    // from 的寫法（只收標準 base64）在 senderMatchesTopic 檢查：兩條收件路徑驗完格式都接著核對寄件者

    // type 必須是已知的 MessageType 值
    const knownTypes = Object.values(MessageType) as string[];
    if (!knownTypes.includes(msg.type)) return false;

    // 時間戳新鮮度檢查（防止重放攻擊）
    // 持久化訊息允許 24h（EMQX session 保留期），其他（換機傳輸）5 分鐘
    // 群組信封（邀請、金鑰）走 QoS1，broker 會排隊到 24h，收端也要給 24h，
    // 否則離線超過 5 分鐘的人永遠收不到（傳輸統一 X3，稽核 H9）。group_sealed 也是（群組訊息的刪除）：
    // 外層時戳不在簽章裡，真正的新鮮度由引擎看內層簽過名的 ts、依種類判斷（here／通話幾分鐘、delete 24 小時）。
    // direct_sealed 一樣：外層給 24h，真正的新鮮度看信封裡簽過名的 iat、照種類判（信令 2 分鐘、個人資料 7 天…，directSeal）
    const PERSISTENT_MSG_TYPES = [
      'x3dh_init', 'group_key_sealed', 'group_sealed', 'direct_sealed',
    ];
    const MESSAGE_FRESHNESS_MS = PERSISTENT_MSG_TYPES.includes(msg.type as string)
      ? 24 * 60 * 60 * 1000
      : 5 * 60 * 1000;
    // （presence 不走這裡（W4）：秘密主題上的 payload 是 {n, c}，時間在密文裡，見 _receivePresence／presenceSecret.acceptState）
    // 未來的時戳只容許 MAX_FUTURE_SKEW_MS（審查 MEDIUM）：以前用絕對值，時戳寫成「24 小時後」的訊息
    //   現在收、24 小時後還收 —— 新鮮度窗口被拉長成 48 小時
    const age = this._serverNow() - (msg.timestamp as number);
    const timeDiff = Math.abs(age);
    if (age < -MqttService.MAX_FUTURE_SKEW_MS || age > MESSAGE_FRESHNESS_MS) {
      console.warn('[MQTT] Message rejected: timestamp too old/future, type:', msg.type, 'diff:', Math.round(timeDiff / 1000) + 's');
      return false;
    }

    return true;
  }

  /**
   * 主題上的寄件者 ＝ 訊息裡的 from？最後一節是寄件者（mist/user/<我>/inbox/<from>、mist/group/<tid>/<from>）。
   * （presence 不走這裡（W4）：秘密主題上沒有 from，主人由主題第三節＋好友的秘密決定）
   * from 必須是 32 bytes 公鑰的標準 base64（isCanonicalPubkey，44 字元）：同一把金鑰的其他寫法主題也對得上，
   * 但對不上封鎖名單與好友清單 → 繞過封鎖、變成另一個聯絡人。一般與 sealed 兩條收件路徑都經過這裡。
   */
  private static senderMatchesTopic(topic: string, type: string, from: string): boolean {
    if (!isCanonicalPubkey(from)) return false;
    const parts = topic.split('/');
    const sender = toUrlSafeBase64(from);
    const inbox = parts.length === 5 && parts[0] === 'mist' && parts[1] === 'user' && parts[3] === 'inbox';
    const group = parts.length === 4 && parts[0] === 'mist' && parts[1] === 'group';
    // 群組主題上只收 group_sealed（W2）：任何人都能往群組主題發東西，明文的舊型別一律不處理；group_sealed 也不能走收件箱
    if (group !== (type === MessageType.GROUP_SEALED)) return false;
    return (inbox || group) && parts[parts.length - 1] === sender;
  }

  /**
   * 還沒有 listener 的訊息先暫存，等 listener 註冊時重播（對應群星 B38 加上限）。
   * 以前不限數量、每來一則就把計時器重設 —— 連得上我收件箱的人（好友、同群成員）持續灌一個還沒人聽的型別
   * （例如登入畫面時的通話信令），記憶體就一直長（200 × 256KB 實測 50MB），計時器也永遠不到期。
   * sealed 路徑以前另外一份、也沒有上限，現在共用這一份。
   * 現在：只收認得的型別；每型別 50 則；一般型別合計 4MB、30 秒；關鍵型別（X3DH、prekey、群組金鑰信封……
   * AppProvider 的 listener 要等 cryptoReady，可能晚幾十秒）各自 1MB、120 秒，不跟一般型別共用額度 ——
   * 灌一堆沒人聽的型別擠不掉剛到的 X3DH_INIT。滿了就丟新到的那則 —— direct_sealed 例外：丟最舊的（審查 L4：重連時一堆
   * 排著的舊信令先到，滿了丟新的 ＝ 丟掉剛到、叫醒手機的那通來電；舊的反正多半已經過期）。
   */
  private static readonly KNOWN_TYPES = new Set<string>(Object.values(MessageType));
  private static readonly PENDING_PER_TYPE = 50;
  private static readonly PENDING_MAX_BYTES = 4 * 1024 * 1024;
  private static readonly PENDING_CRITICAL_MAX_BYTES = 1024 * 1024;
  private static readonly CRITICAL_PENDING = new Set<string>([
    MessageType.X3DH_INIT, MessageType.GROUP_KEY_SEALED, MessageType.GROUP_SEALED,
    // 預備金鑰請求、個人資料在裡面（directSignal 等身分解鎖才掛 listener）
    MessageType.DIRECT_SEALED,
  ]);
  private pendingBytes = new Map<string, number>();
  private pendingTotalBytes = 0;

  private _bufferUnhandled(message: MqttMessage): void {
    const typeKey = message.type as string;
    if (!MqttService.KNOWN_TYPES.has(typeKey)) return;      // 不認得的型別永遠不會有 listener
    let size = 0;
    try { size = JSON.stringify(message.payload ?? null).length; } catch { return; }
    let pending = this.pendingMessages.get(typeKey) || [];
    const critical = MqttService.CRITICAL_PENDING.has(typeKey);
    const over = (extra: number) => (critical
      ? (this.pendingBytes.get(typeKey) ?? 0) + extra > MqttService.PENDING_CRITICAL_MAX_BYTES
      : this.pendingTotalBytes + extra > MqttService.PENDING_MAX_BYTES);
    if (pending.length >= MqttService.PENDING_PER_TYPE || over(size)) {
      const dropOldest = typeKey === MessageType.DIRECT_SEALED && critical && size <= MqttService.PENDING_CRITICAL_MAX_BYTES;
      if (!dropOldest) {
        console.error(`[MQTT] no-listener buffer full for ${typeKey} — dropping`);
        return;
      }
      // 丟最舊的，直到放得下這一則
      const kept = [...pending];
      let bytes = this.pendingBytes.get(typeKey) ?? 0;
      while (kept.length > 0 && (kept.length >= MqttService.PENDING_PER_TYPE || bytes + size > MqttService.PENDING_CRITICAL_MAX_BYTES)) {
        const old = kept.shift() as MqttMessage;
        try { bytes -= JSON.stringify(old.payload ?? null).length; } catch { /* 放得進來就算得出大小 */ }
      }
      console.error(`[MQTT] no-listener buffer full for ${typeKey} — dropped ${pending.length - kept.length} oldest`);
      pending = kept;
      this.pendingBytes.set(typeKey, Math.max(0, bytes));
    }
    pending.push(message);
    this.pendingMessages.set(typeKey, pending);
    this.pendingBytes.set(typeKey, (this.pendingBytes.get(typeKey) ?? 0) + size);
    if (!critical) this.pendingTotalBytes += size;
    devLog(`[MQTT] Buffered message type=${typeKey} (no listener yet, ${pending.length} pending)`);
    // 每來一則重新計時（最後一則也有完整的等待時間）；一直有人送也只佔得到上面的額度
    const bufferTimeout = critical ? 120_000 : 30_000;
    const existingTimer = this.pendingMessageTimers.get(typeKey);
    if (existingTimer) clearTimeout(existingTimer);
    this.pendingMessageTimers.set(typeKey, setTimeout(() => {
      const remaining = this.pendingMessages.get(typeKey);
      if (remaining && remaining.length > 0) {
        console.warn(`[MQTT] Discarding ${remaining.length} buffered ${typeKey} messages after ${bufferTimeout / 1000}s (no listener registered)`);
      }
      this._dropPending(typeKey);
    }, bufferTimeout));
  }

  private _dropPending(typeKey: string): void {
    this.pendingMessages.delete(typeKey);
    if (!MqttService.CRITICAL_PENDING.has(typeKey)) {
      this.pendingTotalBytes = Math.max(0, this.pendingTotalBytes - (this.pendingBytes.get(typeKey) ?? 0));
    }
    this.pendingBytes.delete(typeKey);
    const timer = this.pendingMessageTimers.get(typeKey);
    if (timer) clearTimeout(timer);
    this.pendingMessageTimers.delete(typeKey);
  }

  /**
   * 處理收到的訊息。retained＝broker 存著、訂閱時補送的那一則。
   */
  private handleMessage(topic: string, payload: Buffer, retained = false): void {
    /**
     * retained 只該出現在 presence（審查 MEDIUM）。收件箱一個寄件者一個主題，任何人都能往我每個收件箱主題
     * 留一則 retained，每次重新訂閱就重播一次（而且 broker 的保留量沒有上限）；群組頻道也一樣。
     * broker 端另有規則只准 presence retain（docs/MQTT_BROKER.md），這裡是收端的那一道。
     * W4：presence 只有確切的秘密主題 mist/user/<他>/presence/<tag>（舊的 mist/user/<他>/presence 已經不是 presence 主題）
     */
    const presence = isPresenceTopic(topic as unknown);   // （as unknown：只要布林值，不要把 topic 收窄成 never）
    if (retained && !presence) {
      console.error('[MQTT] Dropped a retained message on a non-presence topic:', topic.split('/').slice(0, 2).join('/'));
      return;
    }
    // 好友的秘密 presence：payload 是 {n, c}（或清掉主題的空 payload），不是一般的訊息格式 → 交給 codec（_receivePresence）
    if (presence) {
      this._receivePresence(topic, payload);
      return;
    }
    try {
      const parsed = JSON.parse(payload.toString());

      // Phase 35b: 即時踢下線通知（不解密，dispatch 事件給上層驗證）
      if (topic.startsWith('aegis/device/') && topic.endsWith('/kicked') && parsed.type === 'kicked') {
        devLog('[MQTT] Device kick signal received on:', topic);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('aegis:device-kick-signal', { detail: parsed }));
        }
        return;
      }

      // E2EE Phase 2: 檢查是否為 Sealed 訊息
      if (parsed.sealed === true && parsed.envelope) {
        devLog('[MQTT] Received sealed message');
        this.handleSealedMessage(topic, parsed as SealedMqttMessage);
        return;
      }

      // 驗證訊息結構
      if (!this.validateMessage(parsed)) {
        devWarn('[MQTT] Rejected malformed message on topic:', topic);
        return;
      }

      // 實際的主題由這裡填（payload 裡帶的 topic 欄位一律蓋掉）
      const message: MqttMessage = { ...parsed, topic };

      // 寄件者認證（對應群星）：JWT ACL 把可發布的主題最後一節綁在連線的 username（＝寄件者公鑰），
      // 這裡再把那一節跟訊息裡的 from 對上 —— 改寫 payload 的 from 也冒充不了別人。
      // 以前 from 是寄件者自己填的、收件箱主題沒有寄件者那一節，任何人都能用任何人的名義送 X3DH_INIT／群組事件。
      if (!MqttService.senderMatchesTopic(topic, message.type, message.from)) {
        console.error('[MQTT] Message rejected: topic sender does not match payload sender, type=' + message.type);
        return;
      }

      // 忽略自己發送的訊息
      if (message.from === this.publicKeyBase64) {
        return;
      }

      devLog(`[MQTT] Received ${message.type} from ${message.from.slice(0, 8)}...`);

      // 通知監聽器
      const listeners = this.messageListeners.get(message.type);
      if (listeners && listeners.size > 0) {
        listeners.forEach((callback) => callback(message));
      } else {
        // 無 listener：暫存訊息，等 listener 註冊時重播
        // 修復 MQTT 重連競爭條件：broker 送出暫存訊息時 React useEffect 尚未註冊 listener
        this._bufferUnhandled(message);
      }

      // 通知全局監聯器
      const allListeners = this.messageListeners.get('*' as MessageType);
      if (allListeners) {
        allListeners.forEach((callback) => callback(message));
      }
    } catch (error) {
      devWarn('[MQTT] Failed to parse message:', error);
    }
  }

  /**
   * 設定連線狀態
   */
  private setState(state: ConnectionState): void {
    this.state = state;
    this.stateListeners.forEach((callback) => callback(state));
  }

  /**
   * 取得當前連線狀態
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 監聽特定類型的訊息
   */
  onMessage(type: MessageType | '*', callback: MessageCallback): () => void {
    const typeKey = type as MessageType;
    if (!this.messageListeners.has(typeKey)) {
      this.messageListeners.set(typeKey, new Set());
    }
    this.messageListeners.get(typeKey)!.add(callback);
    // DIAG(2026-08-19 round6): x3dh listener 消失追蹤 — prod 可見
    if (typeKey === 'x3dh_init' || typeKey === 'direct_sealed') {
      console.error(`[MQTT:DIAG] +listener ${typeKey} (count=${this.messageListeners.get(typeKey)!.size})`);
    }

    // 重播緩衝訊息：修復 MQTT 重連時 listener 尚未註冊導致訊息丟失
    const pendingKey = type as string;
    const pending = this.pendingMessages.get(pendingKey);
    if (pending && pending.length > 0) {
      console.error(`[MQTT:DIAG] Replaying ${pending.length} buffered ${pendingKey} messages`);
      const toReplay = [...pending];
      this._dropPending(pendingKey);
      // 微延遲確保所有 listener 都已註冊完畢
      queueMicrotask(() => {
        for (const msg of toReplay) {
          try {
            callback(msg);
          } catch (err) {
            devWarn(`[MQTT] Error replaying buffered ${pendingKey}:`, err);
          }
        }
      });
    }

    // 返回取消監聽的函式
    return () => {
      this.messageListeners.get(typeKey)?.delete(callback);
      if (typeKey === 'x3dh_init' || typeKey === 'direct_sealed') {
        console.error(`[MQTT:DIAG] -listener ${typeKey} (count=${this.messageListeners.get(typeKey)?.size ?? 0})`);
      }
    };
  }

  /** 群組主題訂好了（SUBACK 准了；含重新訂閱）：群組引擎在這時送加入後的 sync（引擎自己把 tid 對回群組） */
  onGroupSubscribed(callback: (tid: string) => void): () => void {
    this.groupSubscribedListeners.add(callback);
    return () => { this.groupSubscribedListeners.delete(callback); };
  }

  /** 這個群組主題 broker 已經准了嗎（帳號登出、退訂、被拒、broker 沒留 session 才清） */
  isGroupSubscribed(tid: string): boolean {
    return this.grantedGroupTopics.has(tid);
  }

  /** 每次連上（CONNACK）；tokenSwap 見 ConnectedCallback */
  onConnected(callback: ConnectedCallback): () => void {
    this.connectedListeners.add(callback);
    return () => { this.connectedListeners.delete(callback); };
  }

  /**
   * 監聽連線狀態變化
   */
  onStateChange(callback: StateCallback): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  // （1 對 1 的信令 —— DataChannel／通話的 offer、answer、ICE，通話的 request／accept／reject／end，個人資料、預備金鑰請求 ——
  //   開源第 4 步起都是 DIRECT_SEALED：services/directSignal.ts 封好再用 sendToUser／sendTransientToUser 送。以前這裡的明文
  //   sendOffer／sendCall*／sendProfileUpdate／sendPushSubscriptionUpdate／sendTyping 全部拿掉了）

  // ============================================
  // Phase 8: 社交恢復
  // ============================================

  /**
   * 發送分片給守護者（設定社交恢復時分發）
   */
  /**
   * 訂閱特定訊息類型
   * 這是一個便利方法，用於 hook 中訂閱訊息
   */
  subscribe(type: MessageType | '*', callback: MessageCallback): () => void {
    return this.onMessage(type, callback);
  }

  /**
   * 檢查是否已連接
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.client?.connected === true;
  }

  // ============================================
  // Phase 8: 換機傳輸（場景 2）
  // ============================================

  /**
   * 發送換機傳輸請求（新設備發送）
   */
  sendDeviceTransferRequest(
    targetPublicKey: string,
    payload: {
      timestamp: number;
    }
  ): void {
    this.sendToUser(targetPublicKey, MessageType.DEVICE_TRANSFER_REQUEST, payload);
    devLog(`[MQTT] Device transfer request sent to ${targetPublicKey.slice(0, 8)}...`);
  }

  /**
   * 發送換機傳輸資料（舊設備發送）
   */
  sendDeviceTransferData(
    targetPublicKey: string,
    payload: {
      encryptedPayload: {
        iv: string;
        ciphertext: string;
        tag: string;
      };
      timestamp: number;
    }
  ): void {
    this.sendToUser(targetPublicKey, MessageType.DEVICE_TRANSFER_DATA, payload);
    devLog(`[MQTT] Device transfer data sent to ${targetPublicKey.slice(0, 8)}...`);
  }

  // ============================================
  // 離線訊息緩衝 + Health Monitor API
  // ============================================

  /**
   * 緩衝離線待發訊息
   */
  private _enqueueOutgoing(topic: string, payload: string, qos: 0 | 1 | 2, ttlMs?: number): void {
    if (this.outgoingQueue.length >= MqttService.MAX_OUTGOING_QUEUE) {
      // 滿了先丟即時的（通話控制…），再丟最舊的一般訊息（個人資料更新…），都沒有才丟最舊的
      //   （同時從 IDB 清掉）：拆線放回的加好友／成員變更排在最前面，以前離線一陣子的 ICE 或改幾次暱稱
      //   就把它們擠掉了（對應 AegisPlay 19b17dac、27179ddb，第二輪審查 M3、第三輪審查 L5）
      const transientAt = this.outgoingQueue.findIndex(m => MqttService.isTransient(m));
      const ordinaryAt = this.outgoingQueue.findIndex(m => !MqttService.isDurable(m.payload));
      const dropAt = transientAt >= 0 ? transientAt : ordinaryAt >= 0 ? ordinaryAt : 0;
      const dropped = this.outgoingQueue[dropAt];
      this.outgoingQueue = this.outgoingQueue.filter((_, i) => i !== dropAt);
      if (dropped) {
        removeOutgoing(dropped.id).catch(err => devWarn('[MQTT] removeOutgoing on overflow failed:', err));
      }
    }
    const entry: OutgoingMessage = {
      id: makeOutgoingId(),
      topic,
      payload,
      qos,
      timestamp: Date.now(),
      ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
    };
    this.outgoingQueue.push(entry);
    this._dropSupersededInits();
    const put = persistOutgoing(entry).catch(err => devWarn('[MQTT] persistOutgoing failed:', err));
    this._persisting.set(entry.id, put);
    void put.finally(() => this._persisting.delete(entry.id));
    devLog(`[MQTT] Queued outgoing message (${this.outgoingQueue.length} pending)`);
  }

  /**
   * 依排入時間排回原順序：拆線放回的、送失敗補回的、從 IDB 載回的都接在後面，
   *   不排的話「移除成員」可能比之後的「加回成員」晚送 → 各台名冊岔開；群名連改兩次停在舊的。
   */
  private _sortOutgoingQueue(): void {
    this.outgoingQueue = [...this.outgoingQueue].sort((a, b) => a.timestamp - b.timestamp);
  }

  private static messageType(payload: string): string | undefined {
    try {
      return (JSON.parse(payload) as { type?: string }).type;
    } catch {
      return undefined;
    }
  }

  /**
   * 同一個收件人排了好幾封加好友（X3DH_INIT）只留最新那封，舊的從記憶體與 IDB 一起刪（部署前審查 LOW）。
   * 離線時重掃幾次 QR，以前重連後全部依序送出，對方每收一封就清一次 session、待送訊息與 WebRTC 連線，
   * 最後才停在最新那封；中間那幾封對應的 session 本機早就換掉了。
   */
  private _dropSupersededInits(): void {
    const newestByTopic = new Map<string, OutgoingMessage>();
    for (const m of this.outgoingQueue) {
      if (MqttService.messageType(m.payload) !== MessageType.X3DH_INIT) continue;
      const seen = newestByTopic.get(m.topic);
      if (!seen || m.timestamp >= seen.timestamp) newestByTopic.set(m.topic, m);
    }
    const superseded = this.outgoingQueue.filter((m) => MqttService.messageType(m.payload) === MessageType.X3DH_INIT
      && newestByTopic.get(m.topic) !== m);
    if (superseded.length === 0) return;
    const ids = new Set(superseded.map((m) => m.id));
    this.outgoingQueue = this.outgoingQueue.filter((m) => !ids.has(m.id));
    for (const m of superseded) {
      void (this._persisting.get(m.id) ?? Promise.resolve()).then(() => removeOutgoing(m.id))
        .catch(err => devWarn('[MQTT] removeOutgoing (superseded X3DH_INIT) failed:', err));
    }
  }

  /** 待送訊息的寄件人不是目前這個帳號（沒有 from 的舊格式不算） */
  private _isForeignOutgoing(payload: string): boolean {
    if (!this.publicKeyBase64) return false;
    try {
      const from = (JSON.parse(payload) as { from?: unknown }).from;
      return typeof from === 'string' && from !== this.publicKeyBase64;
    } catch {
      return false;
    }
  }

  /**
   * 加好友、群組邀請／成員變更這類「掉了就永遠不會補」的訊息，連線中也走持久化＋等 PUBACK（稽核 M7）。
   * 以前連線中直接 publish、什麼都不留：`connected` 其實是殭屍連線時就靜默消失。
   * 信令（offer／ICE）不走這條 —— 過期的信令重送只會搗亂。
   */
  private _publishDurable(topic: string, payload: string): void {
    this._enqueueOutgoing(topic, payload, 1);
    this._flushOutgoingQueue();
  }

  /**
   * 重連後 flush 所有緩衝的待發訊息
   *
   * Stale 閾值對齊 bot/EMQX 的 24h session — encrypted_message 在
   * mqtt.ts:validateMessage 也是用 24h 判斷新鮮度，這裡跟著放寬，
   * 讓使用者背景幾小時回來訊息能補送。
   */
  private static readonly FLUSH_STALE_MS = 24 * 60 * 60_000;

  private _flushOutgoingQueue(): void {
    if (!this.client?.connected || this.outgoingQueue.length === 0) return;

    const count = this.outgoingQueue.length;
    devLog(`[MQTT] Flushing ${count} queued outgoing messages`);

    this._sortOutgoingQueue();
    const queue = [...this.outgoingQueue];
    this.outgoingQueue = [];

    for (const msg of queue) {
      // 超過 24h 視為過時（對齊 bot 端 freshness 上限）；帶 ttlMs 的照它（通話控制 60 秒：對方早就放棄那通電話了，
      //   對應 AegisPlay 19b17dac）
      const age = Date.now() - msg.timestamp;
      if (age > MqttService.queueTtl(msg)) {
        devWarn(`[MQTT] Dropped stale outgoing message (age=${Math.round(age / 1000)}s)`);
        removeOutgoing(msg.id).catch(err => devWarn('[MQTT] removeOutgoing on stale failed:', err));
        continue;
      }
      try {
        /**
         * 等 broker 確認（QoS1 的 PUBACK）才從 IDB 拔掉（稽核 M7）。
         * 以前 publish() 一呼叫就刪 —— 連線其實已經死了（手機切網路、broker 重啟）的話，
         * X3DH_INIT／群組邀請就這樣不見了。沒確認前留在 IDB，下次啟動會再送；
         * 送出中的記在 `_inflight`，擋掉重複載入；拆線時放回待送佇列。
         */
        this._inflight.set(msg.id, msg);
        const client = this.client;
        // 有期限的：broker 那邊只留剩下的時間（MQTT 5 message expiry）
        const expiry = typeof msg.ttlMs === 'number' ? MqttService.publishOptions(MqttService.queueTtl(msg) - age).properties : undefined;
        client.publish(msg.topic, msg.payload, { qos: msg.qos, ...(expiry ? { properties: expiry } : {}) }, (err) => {
          // 已被丟棄的 client 晚到的回呼：_teardown 已把它放回佇列（可能已用新連線重送），不再動
          if (this.client !== client) return;
          this._inflight.delete(msg.id);
          if (!err) {
            // put 還沒寫完就先刪 → put 之後又寫回去，下次啟動重送一次；等 put 完再刪
            void (this._persisting.get(msg.id) ?? Promise.resolve()).then(() => removeOutgoing(msg.id))
              .catch(e => devWarn('[MQTT] removeOutgoing on ack failed:', e));
          } else if (!this.outgoingQueue.some(m => m.id === msg.id)) {
            this.outgoingQueue.push(msg);      // 還在 IDB；記憶體補回來，下次連上再送
          }
        });
      } catch (err) {
        this._inflight.delete(msg.id);
        devWarn('[MQTT] Failed to flush queued message:', err);
        // 沒送出 → 留在 IDB，下次重連再 flush（但記憶體那條已經清掉了，重 enqueue）
        this.outgoingQueue.push(msg);
      }
    }
  }

  /**
   * 舊版排進 IDB 的待送訊息沒有寄件者那一節（mist/user/<收件人>/inbox）：補上自己那一節再送，
   * 否則 ACL 不准發、更新後那幾則就永遠送不出去（對應群星 _upgradeOutgoingTopic）。寄件者取自 payload 的 from
   * （載入前已濾掉 from 不是自己的）。舊的 mist/broadcast 已經沒有發布權、也沒有功能在用 → 回 null（丟掉）。
   * 群組主題上的一律丟掉（W3）：群組訊息不再排隊（見 sendToGroup），留下來的是舊版用 gid 當主題的 —— 送出去 broker 就看到 gid。
   */
  private static upgradeOutgoingTopic(topic: string, payload: string): string | null {
    if (topic.startsWith('mist/group/') || topic === 'mist/broadcast') return null;
    if (/^mist\/user\/[^/]+\/inbox\/[^/]+$/.test(topic)) return topic;
    try {
      const from = (JSON.parse(payload) as { from?: unknown }).from;
      if (typeof from !== 'string') return topic;
      if (/^mist\/user\/[^/]+\/inbox$/.test(topic)) {
        return `${topic}/${toUrlSafeBase64(from)}`;
      }
    } catch { /* 格式壞掉的，收件端自己會拒收 */ }
    return topic;
  }

  /**
   * 從 IDB 載回上次 tab/browser 死掉時殘留的待發訊息。
   * 應在每次 connect 成功時呼叫，flush 前。
   */
  private async _loadPersistedQueue(): Promise<void> {
    try {
      const persisted = await loadAllOutgoing();
      if (persisted.length === 0) return;
      // 跟 in-memory 合併，避免重複（用 id 去重，記憶體優先）
      const memIds = new Set([...this.outgoingQueue.map(m => m.id), ...this._inflight.keys()]);
      // 別的帳號留下的（清除帳號時 IndexedDB 一時打不開、沒清到）不載、順手刪掉，不能用這個帳號的連線送出去
      //   （對應 AegisPlay 19b17dac，第二輪審查 L5）
      const foreign = persisted.filter(p => this._isForeignOutgoing(p.payload));
      for (const p of foreign) removeOutgoing(p.id).catch(err => devWarn('[MQTT] removeOutgoing (foreign) failed:', err));
      const fresh = persisted.filter(p => !memIds.has(p.id) && !this._isForeignOutgoing(p.payload)).flatMap((p) => {
        const topic = MqttService.upgradeOutgoingTopic(p.topic, p.payload);
        if (topic === null) {
          removeOutgoing(p.id).catch(err => devWarn('[MQTT] removeOutgoing (retired topic) failed:', err));
          return [];
        }
        return [topic === p.topic ? p : { ...p, topic }];
      });
      this.outgoingQueue.push(...fresh);
      this._sortOutgoingQueue();
      this._dropSupersededInits();
      devLog(`[MQTT] Loaded ${fresh.length} persisted outgoing messages from IDB`);
    } catch (err) {
      devWarn('[MQTT] Failed to load persisted outgoing queue:', err);
    }
  }

  /**
   * 觸發 FCM 推播通知（fire-and-forget）
   * ADR-016: 零內容推播，僅喚醒 App。A5（移植群星）：請求由已解鎖的帳戶金鑰簽章，只送型別與「是不是視訊」——
   * 伺服器驗簽後只把已驗簽的寄件者公鑰交給收件端，名字由收件端查本機。沒有已解鎖的身分（或換帳號中）就不推。
   * 來電（hint.callId ＝ 這一通的 callId）另外帶我簽的響鈴 token（開源第 5d 步，ringToken.ts）：對方手機只認 token，
   * 不認推播伺服器說的寄件人 —— 營運方不能讓對方手機用我的名字響鈴。
   */
  triggerFcmNotify(recipientPublicKeyBase64: string, hint: { type: string; isVideoCall?: unknown; callId?: string }): void {
    const signer = this._identitySigner;
    if (!signer || !this.publicKeyBase64 || signer.publicKey !== this.publicKeyBase64) return;
    if (!serverPushHint({ type: hint.type })) return;
    const callId = hint.type === 'incoming_call' && typeof hint.callId === 'string' ? hint.callId : null;
    /**
     * token 的 iat 用有上限的時鐘（boundedNow，API 的時鐘差最多採信 ±5 分鐘；安全審查 H1：用 serverNow 的話，營運方回一個
     * 「下週二」的 server_time，我就會簽一張下週二才生效的 token 給他存著）；請求本身照舊用校正到伺服器的時鐘（nowMs）
     */
    const build = (withToken: boolean) => (nowMs: number) => {
      let ringToken: string | undefined;
      if (callId && withToken) {
        try {
          ringToken = signRingToken({ prefix: AEGISTALK_RING_PREFIX, callId, from: signer.publicKey, to: recipientPublicKeyBase64,
            video: hint.isVideoCall === true, now: this.boundedNow(), sign: (d) => signer.sign(d) });
        } catch (err) {
          devWarn('[MQTT] ring token not signed:', (err as Error)?.message);
        }
      }
      const serverHint = serverPushHint({ type: hint.type, isVideoCall: hint.isVideoCall, ringToken });
      if (!serverHint) throw new Error('push type not sent by this edition');
      return signedPushNotify(signer, recipientPublicKeyBase64, serverHint, nowMs);
    };
    // 執行期選的那台伺服器（開源第 5c 步）；重送 422 那次也送同一台
    const url = `${apiBase()}/api/push/notify`;
    // 用校正到伺服器的時鐘簽；時鐘差太多（401 clock_skew）就用伺服器的時間重簽一次（開源第 4 步，signedPost）。
    //   我的手機時鐘差超過 10 分鐘時有上限的 token 時間會被伺服器當成太舊（422 invalid_ring_token）：不帶 token 再送一次 ——
    //   對方只會收到一則不響鈴、不帶名字的通知（App 裡照樣響：來電信令是封好的）
    postSigned(url, build(true), this.signedClock())
      .then(async (res) => {
        if (!callId || res.status !== 422) return;
        const detail = await res.clone().json().then((b: { detail?: unknown }) => b?.detail).catch(() => null);
        if (detail === 'invalid_ring_token') await postSigned(url, build(false), this.signedClock());
      })
      .catch(() => { /* fire-and-forget */ });
  }

  /** 帳戶簽章的 API 請求用的時鐘（推播、信任分數、Web Push 註冊；signedPost） */
  signedClock(): SignedClock {
    return { now: () => this._serverNow(), adopt: (serverTimeSec) => this.adoptServerTime(serverTimeSec) };
  }

  /**
   * API 說它現在幾秒（clock_skew 的 server_time）：跟 token 的 serverTime 一樣拿來校正。收端判新鮮度用的 boundedNow 照樣有上限，
   * 回假時間的營運方撥不動錄下來的東西（W5）；差太多照樣跳 clock-drift 提示
   */
  adoptServerTime(serverTimeSec: number): void {
    if (typeof serverTimeSec !== 'number' || !Number.isFinite(serverTimeSec)) return;
    this._clockOffsetMs = serverTimeSec * 1000 - Date.now();
    this._noteClockDrift();
  }

  /**
   * 已解鎖、而且是這個公鑰的簽署函式（FCM token 註冊用，見 capacitor.registerFcmToken）。
   * 只回簽署函式，不給私鑰。
   */
  identitySignerFor(publicKeyBase64: string): IdentitySigner | null {
    const signer = this._identitySigner;
    return signer && signer.publicKey === publicKeyBase64 ? signer : null;
  }

  /**
   * 取得連線健康資訊（供 MqttHealthMonitor 使用）
   */
  getHealthInfo(): MqttHealthInfo {
    const ws = (this.client as unknown as { stream?: { socket?: WebSocket } })?.stream?.socket;
    return {
      state: this.state,
      wsReadyState: ws?.readyState ?? null,
      lastMessageReceivedAt: this._lastMessageReceivedAt,
      clientConnected: this.client?.connected ?? false,
      publicKey: this.publicKeyBase64,
      tokenFailed: this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN,
      hasPinHash: !!localStorage.getItem('mist_pin_hash'),
    };
  }

  /**
   * 重置 token 失敗狀態（VPS 註冊成功後呼叫）
   */
  resetTokenFailure(): void {
    this._tokenFetchFailedAt = 0;
    this._mqttToken = null;
    this._mqttTokenExpiresAt = 0;
  }

  /**
   * 處理 Sealed 訊息
   */
  private async handleSealedMessage(topic: string, sealedMessage: SealedMqttMessage): Promise<void> {
    if (!this.privateKeyBase64) {
      devWarn('[MQTT] Cannot unseal message: private key not configured');
      return;
    }

    try {
      const result = await unsealMessageBase64(
        sealedMessage.envelope,
        this.privateKeyBase64
      );

      // 解開後的內容照一般訊息的規則驗（型別、標準寫法的 from、時戳），寄件者也要跟主題上的寄件者對上（同 handleMessage）
      const standardMessage: MqttMessage = {
        type: result.type as MessageType,
        from: result.from,
        payload: result.payload,
        timestamp: result.timestamp,
        signature: result.signature,
      };
      if (!this.validateMessage(standardMessage) || !MqttService.senderMatchesTopic(topic, result.type, result.from)) {
        console.error('[MQTT] Sealed message rejected: malformed, stale, or topic sender does not match decrypted sender');
        return;
      }

      devLog(`[MQTT] Unsealed message from ${result.from.slice(0, 8)}..., type: ${result.type}`);

      // 通知 Sealed 訊息監聽器
      this.sealedMessageListeners.forEach((callback) => callback(result));

      const listeners = this.messageListeners.get(result.type as MessageType);
      if (listeners && listeners.size > 0) {
        listeners.forEach((callback) => callback(standardMessage));
      } else {
        // 緩衝無 listener 的 sealed 訊息（同 handleMessage，同一套上限）
        this._bufferUnhandled(standardMessage);
      }

      const allListeners = this.messageListeners.get('*' as MessageType);
      if (allListeners) {
        allListeners.forEach((callback) => callback(standardMessage));
      }
    } catch (error) {
      devWarn('[MQTT] Failed to unseal message:', error);
    }
  }
}

// 單例導出
export const mqttService = new MqttService();

export default mqttService;

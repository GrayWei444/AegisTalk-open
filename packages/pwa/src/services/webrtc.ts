/**
 * WebRTC Service - P2P 連線管理
 *
 * 透過 WebRTC 建立端對端加密的 P2P 連線
 * 使用 MQTT 作為信令通道
 */

import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { getIceServers } from './iceServers';
import { splitFrame, FrameAssembler, utf8Length } from './dcFraming';
import { onDirect, sendDirect } from './directSignal';
import type { DirectBody } from './directSeal';
import { createFingerprintCheck, readFingerprints, type DtlsFingerprints, type FingerprintCheck, type FingerprintFailure } from './dtlsFingerprint';

/**
 * DataChannel 的信令（開源第 4 步，docs/DIRECT_SEALED.md）：DIRECT_SEALED 的 kind 'dc'（封給對方身分金鑰、對方簽章，
 * directSignal 驗過簽章、新鮮度、重放才交過來 —— 這裡收到的每一則都是 authenticated）。
 *   pc   寄件人自己那條 PC 的世代 id
 *   rpc  寄件人知道的「我這邊」那條 PC 的世代 id（answer：它回的是哪一則 offer；fp：它在核對哪一條）
 * 以前三種明文型別（webrtc_offer／answer／ice）：營運方能用任何人的名義塞 offer，新的 pcId 還會讓我拆掉正在用的連線。
 */
type DcSig = 'offer' | 'answer' | 'ice' | 'fp';
interface DcSignal {
  from: string;
  sig: DcSig;
  pc: string;
  rpc?: string;
  /** 封裝時間（信封裡簽過名的；比較兩則 offer 誰新） */
  iat: number;
  data: Record<string, unknown>;
  groupProof?: unknown;
  /** 一定是 true：只有 directSignal 驗過的信封會變成 DcSignal（拆連線之類的決定只認它） */
  authenticated: true;
}
const DC_SIGS: readonly DcSig[] = ['offer', 'answer', 'ice', 'fp'];
const PC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_DC_DATA_JSON = 32 * 1024;

/** kind 'dc' 的內容 → DcSignal（形狀不對 → null） */
export function parseDcSignal(from: string, body: Record<string, unknown>): DcSignal | null {
  const { sig, pc, rpc, data, groupProof, iat } = body;
  if (typeof sig !== 'string' || !(DC_SIGS as readonly string[]).includes(sig)) return null;
  if (typeof pc !== 'string' || !PC_ID_RE.test(pc)) return null;
  if (rpc !== undefined && (typeof rpc !== 'string' || !PC_ID_RE.test(rpc))) return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  try {
    if (JSON.stringify(data).length > MAX_DC_DATA_JSON) return null;
  } catch {
    return null;
  }
  if ((sig === 'offer' || sig === 'answer') && ((data as { type?: unknown }).type !== sig || typeof (data as { sdp?: unknown }).sdp !== 'string')) return null;
  if (sig === 'answer' && rpc === undefined) return null;
  if (sig === 'fp' && rpc === undefined) return null;
  return {
    from, sig: sig as DcSig, pc, ...(rpc !== undefined ? { rpc } : {}), iat, data: data as Record<string, unknown>,
    ...(sig === 'offer' && groupProof !== undefined ? { groupProof } : {}), authenticated: true,
  };
}

/** 對方先到的 ICE（標明它是哪一條 PC 的） */
interface TaggedCandidate { candidate: RTCIceCandidateInit; pc: string }

/** 一條 PC 的世代 id（跟著每一則信令送出去） */
function newPcId(): string {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `pc-${Date.now().toString(36)}-${Array.from(r, (b) => (b % 36).toString(36)).join('')}`;
}

/**
 * 誰可以對我發 WebRTC offer（useWebRTC 注入）。兩個查詢都可以是非同步的：
 * 冷啟動時要等好友清單載入才答得出來（部署前審查 HIGH）。
 */
export interface InboundPolicy {
  /** 我封鎖的人：一律不回 answer */
  isBlocked: (pk: string) => boolean | Promise<boolean>;
  /** 好友或任一群組的成員 */
  isKnown: (pk: string) => boolean | Promise<boolean>;
}

/**
 * offer 附的群組金鑰證明（services/offerProof，程式碼審查 H1）：送 offer 時產生；收到不認得的人的 offer 時檢查 ——
 * 證明他持有我本機某個群的群組金鑰（而且不在鏈上的「曾被踢／離開」名單），就當成認得的人。我的狀態鏈還沒補到
 * 他加入的那筆時，他的 offer 才不會被丟。
 */
export interface OfferProofHooks {
  create: (remotePk: string) => Promise<unknown>;
  verify: (remotePk: string, proof: unknown) => Promise<boolean>;
}

// IPv6 優先設定
const IPV6_FIRST_ENABLED = true;

// ICE 連線類型（用於監控）
export enum IceCandidateType {
  HOST = 'host',       // 直連（IPv4/IPv6）
  SRFLX = 'srflx',     // STUN 反射
  PRFLX = 'prflx',     // Peer 反射
  RELAY = 'relay',     // TURN 中繼
}

// 連線狀態
export enum PeerConnectionState {
  NEW = 'new',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed',
  CLOSED = 'closed',
}

// 資料通道狀態
export enum DataChannelState {
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed',
}

// Peer 連線資訊
export interface PeerInfo {
  publicKeyBase64: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  connectionState: PeerConnectionState;
  dataChannelState: DataChannelState;
  isInitiator: boolean;
  // IPv6 優先：暫存「出去的」candidates 以便排序
  pendingCandidates: RTCIceCandidate[];
  candidateFlushTimer: NodeJS.Timeout | null;
  // 「進來的」ICE candidate 若 remoteDescription 還沒 set（或還不知道對方是哪一條 PC），先存這裡，
  // setRemoteDescription(offer/answer) 後再 flush（只補對方那一條 PC 的）。修 trickle-ICE race：
  // candidate 早於 offer/answer 經 MQTT 到達 → addIceCandidate throw
  // 「remote description was null」→ 被丟 → ICE 缺候選永遠卡 checking。
  incomingCandidates: TaggedCandidate[];
  // ── 殭屍 DataChannel 偵測（LEARNINGS_FROM_AEGISTRANS §13）──
  //   readyState 會停在 'open'、connectionState 停在 'connected'，但底層傳輸早就死了
  //   （iOS 被系統凍結最常見；單向 NAT rebinding 也會）。此時 send() 不 throw →
  //   訊息靜默蒸發、連 outbox 都不進。唯一可靠的活性訊號是「最近真的收到過東西嗎」。
  /** 最後一次從這條 DataChannel 收到「任何」inbound（含心跳）的時間 */
  lastDcInboundAt: number;
  /** 是否觀察到對端會送心跳 —— 只有會送的 peer 才套 staleness（相容舊版對端，否則舊 peer 恆判死→無限重建） */
  hbCapable: boolean;
  /** 目前送訊用的那條 DataChannel 是什麼時候 open 的（p2pSend：在更早的通道送出、還沒回條的群訊立刻重送） */
  dcOpenedAt?: number;
  /** 目前送訊用的那條 DataChannel 的編號（每開一條新通道就換號，全服務遞增；fileTransfer 用它認「還是不是同一條」） */
  dcEpoch?: number;
  /** 這條 PC 的 ICE／連線暫時 disconnected 過、還沒恢復（恢復時要補發一次 OPEN，見 trackIceRecovery） */
  iceInterrupted?: boolean;
  /** E2E only：模擬「通道還 open、但傳輸已死」—— 丟棄所有 inbound，readyState 完全不動 */
  simulatedDead?: boolean;
  /** 超過 DataChannel 上限的訊息會分塊送（dcFraming，傳輸統一 X5）；這裡重組對方送來的片段 */
  rxFrames?: FrameAssembler;
  // ── PC 世代（generation）──
  //   對端把自己的 PC 砍掉重建（殭屍拆除 / 完整重啟）後會用**新的 PC** 發 offer。
  //   我方若只看「自己的 PC 還活著」就在舊 PC 上回 answer，等於對著一個已經不存在的 PC 講話
  //   → ICE/DTLS 參數全是舊世代 → 永遠連不上，只能靠反覆重試硬撞（實測要 ~50s 才碰巧收斂）。
  //   對策：offer 帶上發送端的 pcId；收端發現 pcId 跟記憶中的不同 → 對端重建了 → 砍掉自己的舊 PC 重來。
  /** 我這條 PC 的世代 id（跟著每個 offer 送出去） */
  localPcId: string;
  /** 對端 PC 的世代 id（從它的 offer 或 answer 學到） */
  remotePcId?: string;
  /** 學到 remotePcId 的那一則的封裝時間：比它舊的 offer 帶別的 pcId → 是舊的（重放、晚到），不准拆現在的連線 */
  remotePcIat?: number;
  // ── DTLS 指紋（開源第 4 步）──
  /** 這條 PC 的指紋核對（ICE 連上才開始） */
  fp: FingerprintCheck;
  /** 兩邊的指紋對過了：之前這條通道不算開著（不送、收到的先壓著，見 heldInbound） */
  verified: boolean;
  /** 指紋還沒驗過時收到的（驗過才往上送；對不上就丟） */
  heldInbound: Array<ArrayBuffer | string>;
  heldInboundBytes: number;
}

/** 指紋驗過之前最多壓著幾則／多少 bytes（超過的丟掉 —— 對方也還沒驗過，正常不會送東西過來） */
const MAX_HELD_INBOUND = 256;
const MAX_HELD_INBOUND_BYTES = 8 * 1024 * 1024;
/** DataChannel 的指紋多久沒驗過就拆掉 */
const DC_FINGERPRINT_TIMEOUT_MS = 30_000;

// 訊息回調
type MessageCallback = (peerPublicKey: string, data: ArrayBuffer | string) => void;
type StateCallback = (peerPublicKey: string, state: PeerConnectionState) => void;
type DataChannelStateCallback = (peerPublicKey: string, state: DataChannelState) => void;

/**
 * WebRTC P2P 連線服務
 */
class WebRTCService {
  private peers: Map<string, PeerInfo> = new Map();
  private localPublicKeyBase64: string | null = null;
  // Perfect Negotiation：正在送 offer 的 peer（判 offer collision 用，glare 不再靠 closePeer 拆連線）
  private makingOffer: Set<string> = new Set();
  // 每個 peer「本輪連線嘗試」起始時間戳（DataChannel open 即清）。用來打破 stuck-at-new livelock：
  //   PC 卡在 new/connecting/checking、DataChannel 一直沒 open 超過 deadline → 視為死、closePeer 重建。
  private connectAttemptAt: Map<string, number> = new Map();
  /** DataChannel 編號（PeerInfo.dcEpoch）：每條通道 open 時加一 */
  private dcEpochSeq = 0;

  // 事件監聽器
  private messageListeners: Set<MessageCallback> = new Set();
  private stateListeners: Set<StateCallback> = new Set();
  private dataChannelStateListeners: Set<DataChannelStateCallback> = new Set();

  // MQTT 訂閱取消函式
  private mqttUnsubscribes: (() => void)[] = [];

  /**
   * 誰可以對我發 offer（稽核 M5，對應 AegisPlay B39）。以前任何人送一則 WEBRTC_OFFER 就能跟我建直連 ——
   * 看得到我的 IP、能往我這裡灌 DataChannel。現在：我自己連過去的（已有 peer），或 `inboundPolicy`
   * （useWebRTC 注入）認得、且不是我封鎖的人。其餘靜默丟掉。App 還沒注入前一律拒絕（useWebRTC 在
   * initialize 之後同一個 tick 就注入）。不認得的人的 offer 先收著 15 秒（見 heldOffers）。
   */
  private inboundPolicy: InboundPolicy | null = null;

  setInboundPolicy(policy: InboundPolicy): void { this.inboundPolicy = policy; }

  private offerProofs: OfferProofHooks | null = null;
  setOfferProofs(hooks: OfferProofHooks | null): void { this.offerProofs = hooks; }

  /** 送 offer 時附的群組金鑰證明（沒有共同的群、或算不出來就不附） */
  private async offerProofFor(remotePk: string): Promise<unknown> {
    try {
      return (await this.offerProofs?.create(remotePk)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** offer 還在等 policy 時先到的 ICE（不收著的話 trickle 進來的 candidate 全丟，連線常常建不起來） */
  private gateWaitCandidates: Map<string, TaggedCandidate[]> = new Map();

  /**
   * 'allow'：回 answer。'deny'：丟掉（封鎖的人、還沒有 policy、封鎖名單查不到）。
   * 'unknown'：還不認得 —— 先收著，名冊（狀態鏈補抓中）／好友可能還在路上（見 heldOffers）。
   */
  private async offerVerdict(pk: string, proof?: unknown): Promise<'allow' | 'deny' | 'unknown'> {
    if (this.peers.has(pk)) return 'allow';
    const policy = this.inboundPolicy;
    if (!policy) return 'deny';
    try {
      if ((await policy.isBlocked(pk)) === true) return 'deny';
    } catch {
      return 'deny';
    }
    try {
      if ((await policy.isKnown(pk)) === true) return 'allow';
    } catch { /* 查不到：看證明 */ }
    // 名冊上沒有他：offer 附的群組金鑰證明對得上就當成認得的人（見 OfferProofHooks）
    if (proof !== undefined && this.offerProofs) {
      try {
        if (await this.offerProofs.verify(pk, proof)) {
          diagLog('[DIAG:WebRTC] offer from a peer missing from my roster, accepted on its group-key proof:', pk.slice(0, 16));
          return 'allow';
        }
      } catch { /* 證明驗不了：當成不認得 */ }
    }
    return 'unknown';
  }

  /**
   * 不認得的人的 offer 先收著（對應群星 64f3d211，多人模擬 S3）。App 重開時 broker 一口氣補送離線期間的訊息：
   * 「D 加入群組」在群組頻道、D 的 offer 在收件匣，名冊事件的 listener 要等畫面掛上才註冊、事後才重播 ——
   * offer 先到就被當成陌生人丟掉，D 那邊的待送一直等不到連線（D 不是發起方、也不是我的好友，沒人會再連）。
   * 現在：收著 15 秒（連同它的 ICE），名冊／好友更新時（AppProvider 呼叫 recheckHeldOffers）與每 0.5 秒再判斷；
   * 認得了就照常處理，期限內還是不認得才丟。收著期間不回 answer、不建連線 —— 陌生人照樣看不到我的 IP。
   */
  private heldOffers = new Map<string, { offer: DcSignal; at: number; ice: TaggedCandidate[] }>();
  private heldOfferChecking = new Set<string>();
  private heldOfferTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HELD_OFFER_MS = 15_000;
  private static readonly HELD_OFFER_MAX_PEERS = 16;
  private static readonly HELD_OFFER_MAX_ICE = 32;
  /**
   * 收著的位子不能被人頭一直佔著（對應群星 81b7bb45，審查 LOW）：以前同一個陌生人每 10 秒重送 offer，15 秒就重新算 →
   * 16 個人頭永遠佔滿，真的新成員連收都收不進來。現在從**第一次**收著算 15 秒（重送只換 offer、不延長）；
   * 過期丟掉後同一個人 60 秒內再送也不收著（名冊已經認得他的話照常處理，見 offerVerdict）。冷卻名單有上限。
   */
  private heldOfferCooldown = new Map<string, number>();
  private static readonly HELD_OFFER_COOLDOWN_MS = 60_000;
  private static readonly HELD_OFFER_COOLDOWN_MAX = 256;

  private holdOffer(msg: DcSignal, earlyCandidates: TaggedCandidate[]): void {
    const pk = msg.from;
    const now = Date.now();
    const existing = this.heldOffers.get(pk);
    if (!existing) {
      if ((this.heldOfferCooldown.get(pk) ?? 0) > now) {
        diagLog('[DIAG:WebRTC] offer from a stranger ignored (recently dropped):', pk.slice(0, 16));
        return;
      }
      if (this.heldOffers.size >= WebRTCService.HELD_OFFER_MAX_PEERS) {
        diagLog('[DIAG:WebRTC] offer from a stranger ignored (hold list full):', pk.slice(0, 16));
        return;
      }
    }
    // 同一個人又送新的 offer → 用新的（舊的 ICE 屬於舊 offer，一起作廢）；收著的時間照第一次算
    this.heldOffers.set(pk, { offer: msg, at: existing?.at ?? now, ice: earlyCandidates.slice(0, WebRTCService.HELD_OFFER_MAX_ICE) });
    diagLog('[DIAG:WebRTC] offer from an unknown peer held (roster/friends may still be loading):', pk.slice(0, 16));
    if (!this.heldOfferTimer) {
      this.heldOfferTimer = setInterval(() => this.recheckHeldOffers(), 500);
      (this.heldOfferTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private coolDownHeldOffer(pk: string, now: number): void {
    this.heldOfferCooldown.delete(pk);
    this.heldOfferCooldown.set(pk, now + WebRTCService.HELD_OFFER_COOLDOWN_MS);
    for (const [k, until] of this.heldOfferCooldown) {
      if (this.heldOfferCooldown.size <= WebRTCService.HELD_OFFER_COOLDOWN_MAX && until > now) break;
      this.heldOfferCooldown.delete(k);
    }
  }

  /** 名冊／好友更新後呼叫（也每 0.5 秒自己跑）：收著的 offer 現在認得了就照常處理，過期的丟掉 */
  recheckHeldOffers(): void {
    const now = Date.now();
    for (const [pk, held] of [...this.heldOffers]) {
      if (now - held.at > WebRTCService.HELD_OFFER_MS) {
        this.heldOffers.delete(pk);
        this.coolDownHeldOffer(pk, now);
        diagLog('[DIAG:WebRTC] offer from a stranger ignored:', pk.slice(0, 16));
        continue;
      }
      if (this.heldOfferChecking.has(pk)) continue;
      this.heldOfferChecking.add(pk);
      void this.offerVerdict(pk, held.offer.groupProof).then(async (verdict) => {
        this.heldOfferChecking.delete(pk);
        const current = this.heldOffers.get(pk);
        if (!current || current !== held) return;           // 期間換了新 offer 或已處理：下一輪再看
        if (verdict === 'deny') {
          this.heldOffers.delete(pk);
          return;
        }
        if (verdict !== 'allow') return;
        this.heldOffers.delete(pk);
        diagLog('[DIAG:WebRTC] held offer released (peer is now known):', pk.slice(0, 16), `after ${Date.now() - held.at}ms`);
        await this.acceptOfferWithCandidates(held.offer, held.ice);
      }).catch((err) => {
        this.heldOfferChecking.delete(pk);
        console.error('[WebRTC] held offer failed:', err);
      });
    }
    if (this.heldOffers.size === 0 && this.heldOfferTimer) {
      clearInterval(this.heldOfferTimer);
      this.heldOfferTimer = null;
    }
  }

  /**
   * 初始化 WebRTC 服務
   */
  initialize(localPublicKeyBase64: string): void {
    // 防止重複初始化（同一 key 不需要重新訂閱 MQTT）
    if (this.localPublicKeyBase64 === localPublicKeyBase64 && this.mqttUnsubscribes.length > 0) {
      return;
    }
    // 清理舊的訂閱（如果換了 key）
    if (this.mqttUnsubscribes.length > 0) {
      this.mqttUnsubscribes.forEach((unsub) => unsub());
      this.mqttUnsubscribes = [];
    }
    this.localPublicKeyBase64 = localPublicKeyBase64;

    // 信令：DIRECT_SEALED 的 kind 'dc'（directSignal 驗過寄件人的簽章、新鮮度、重放才交過來）
    this.mqttUnsubscribes.push(
      onDirect('dc', (from, body) => this.handleDirect(from, body)),
    );

    this.startDcHeartbeat();

    // E2E debug seam（僅測試環境）：模擬殭屍 DataChannel。無法用真實手段重現
    //   （要讓 OS 凍結 App / NAT rebinding），故給一個精確的注入點：丟棄該 peer 所有 inbound、
    //   readyState 與 connectionState 完全不動 —— 正是真實殭屍的樣子。
    if (typeof window !== 'undefined' && localStorage.getItem('AEGIS_E2E_TEST') === 'true') {
      (window as unknown as { __simulateDcDeath?: (pk?: string) => number }).__simulateDcDeath = (pk?: string) => {
        let n = 0;
        this.peers.forEach((peer, key) => {
          if (pk && key !== pk) return;
          peer.simulatedDead = true;
          n++;
        });
        console.error(`[DIAG:WebRTC] E2E simulateDcDeath: ${n} peer(s) now drop all inbound (readyState untouched)`);
        return n;
      };
    }

    diagLog('[DIAG:WebRTC] Service initialized, sealed offer/answer/ICE/fp handler registered');
    devLog('[WebRTC] Service initialized');
  }

  /**
   * 關閉服務
   */
  shutdown(): void {
    this.stopDcHeartbeat();
    this.heldOffers.clear();
    this.heldOfferChecking.clear();
    this.heldOfferCooldown.clear();
    if (this.heldOfferTimer) {
      clearInterval(this.heldOfferTimer);
      this.heldOfferTimer = null;
    }
    // 取消 MQTT 訂閱
    this.mqttUnsubscribes.forEach((unsub) => unsub());
    this.mqttUnsubscribes = [];

    // 關閉所有連線
    this.peers.forEach((peer) => {
      peer.fp.stop();
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();
    this.gateWaitCandidates.clear();

    this.localPublicKeyBase64 = null;
    devLog('[WebRTC] Service shut down');
  }

  // DataChannel 一直沒 open、PC 卡在 new/connecting/checking 超過此時間 → 視為死、重建。
  //   只殺「從未 open 的卡死連線」（活/已 open 的在 connect() 上方早就 return）→ 不會週期性拆活連線，
  //   不重蹈 b0f0948 死亡螺旋。peerHealthMonitor STUCK_GRACE_MS=20s + probe 10s，這裡放 25s 給握手餘裕。
  private static readonly STUCK_REBUILD_MS = 25_000;

  // ── 殭屍 DataChannel（LEARNINGS §13）──
  /** 心跳間隔：每 10s 對每條 open DataChannel 送一幀 */
  private static readonly DC_HEARTBEAT_MS = 10_000;
  /** 超過這麼久沒有任何 inbound（漏 ~3 拍）→ 判定通道已死 */
  private static readonly DC_STALE_MS = 35_000;
  /** 心跳幀（不進 message listener，只更新活性） */
  private static readonly DC_HEARTBEAT_FRAME = '{"type":"__dc_hb"}';
  private dcHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── 大訊息分塊（傳輸統一 X5）──
  /** 分塊時每片上限：取對端宣告的 SCTP max-message-size（未宣告時 RFC 預設 64KB），最多 240KB 留餘裕 */
  private static frameLimitFor(peer: PeerInfo): number {
    const advertised = peer.connection?.sctp?.maxMessageSize;
    const max = typeof advertised === 'number' && advertised > 0 ? advertised : 65_536;
    return Math.max(16 * 1024, Math.min(240 * 1024, max - 1024));
  }
  /**
   * 不分塊的上限＝舊版直接 send() 送得出去的大小：對端宣告的上限，拿不到 sctp 時用 Chromium 的 256KB。
   * 舊版收端不認得分塊幀，這個範圍內一律單幀送，新舊版混用時以前收得到的訊息照樣收得到。
   */
  private static singleFrameLimitFor(peer: PeerInfo): number {
    // 最多 256KB：對端宣告得更大（Firefox 宣告 1GB）時不去試單幀 —— libwebrtc 在 reliable 通道送超過上限的
    //   訊息可能直接把通道關掉，每次 flush 都斷線（對應 AegisPlay 170125d8，第二輪審查 L1）
    const advertised = peer.connection?.sctp?.maxMessageSize;
    return Math.min(262_144, typeof advertised === 'number' && advertised > 0 ? advertised : 262_144);
  }
  /** 送出緩衝（bufferedAmount）快滿時不送分塊訊息，交給 outbox 下次 flush（Chromium 上限 16MB，滿了 send 會 throw） */
  private static readonly DC_SEND_BUFFER_LIMIT = 12 * 1024 * 1024;

  /**
   * 心跳：每 10s 對每條 open DataChannel 送一幀。對端收到任何 inbound 就會更新它的
   * lastDcInboundAt → 只要傳輸還活著，雙方都不會被判 stale。
   * 送不出去（send throw）代表通道真的壞了 → 直接標記 stale（讓 isDataChannelOpen 回 false）。
   */
  private startDcHeartbeat(): void {
    if (this.dcHeartbeatTimer) return;
    this.dcHeartbeatTimer = setInterval(() => {
      this.peers.forEach((peer) => {
        if (peer.dataChannel?.readyState !== 'open') return;
        try {
          peer.dataChannel.send(WebRTCService.DC_HEARTBEAT_FRAME);
        } catch {
          // send 幾乎不會 throw，但真 throw 就是鐵證：通道已死 → 立刻視為 stale
          peer.lastDcInboundAt = 0;
        }
      });
    }, WebRTCService.DC_HEARTBEAT_MS);
  }

  private stopDcHeartbeat(): void {
    if (this.dcHeartbeatTimer) {
      clearInterval(this.dcHeartbeatTimer);
      this.dcHeartbeatTimer = null;
    }
  }

  /**
   * 殭屍判定（LEARNINGS §13）：readyState='open' 但「很久沒收到任何東西」= 傳輸已死。
   *
   * ⚠️ 相容性 gate：只有**觀察到對端會送心跳**（hbCapable）的 peer 才套 staleness。
   *    否則舊版對端永遠不送心跳 → 一律被判死 → 無限重建。舊 peer 維持原本 readyState 行為。
   */
  /** 診斷用：peer 當下五維狀態一行（watchdog/取證印） */
  describePeer(pk: string): string {
    const p = this.peers.get(pk);
    if (!p) return 'no-peer';
    return `conn=${p.connection.connectionState} ice=${p.connection.iceConnectionState} sig=${p.connection.signalingState} dc=${p.dataChannel?.readyState ?? 'none'} hb=${p.hbCapable} lastIn=${Date.now() - p.lastDcInboundAt}ms`;
  }

  isPeerZombie(remotePublicKeyBase64: string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.dataChannel?.readyState !== 'open') return false;
    if (!peer.hbCapable) return false;
    return Date.now() - peer.lastDcInboundAt > WebRTCService.DC_STALE_MS;
  }

  /** PC 卡在 new/connecting/checking、DataChannel 未 open、且本輪嘗試已超過 deadline → 該重建。 */
  private isStaleStuck(remotePublicKeyBase64: string, peer: PeerInfo): boolean {
    if (peer.dataChannel?.readyState === 'open') return false;
    // 只算「握手早期就卡死」：connected/completed 的活 PC（DataChannel 暫關）走 reopen-in-place，
    //   絕不在此重建 → 不碰活連線、不重蹈 b0f0948 死亡螺旋。
    const cs = peer.connection.connectionState;
    const ice = peer.connection.iceConnectionState;
    const earlyPhase = cs === 'new' || cs === 'connecting' || ice === 'new' || ice === 'checking';
    if (!earlyPhase) return false;
    const started = this.connectAttemptAt.get(remotePublicKeyBase64);
    return started !== undefined && Date.now() - started > WebRTCService.STUCK_REBUILD_MS;
  }

  /**
   * 發起連線到指定 Peer
   */
  async connect(remotePublicKeyBase64: string): Promise<void> {
    if (!this.localPublicKeyBase64) {
      throw new Error('WebRTC service not initialized');
    }

    // 殭屍（LEARNINGS §13 步驟 3）：readyState='open' 但傳輸已死 → PC 本身沒救，
    //   原地 renegotiation 無效，必須先拆掉，再走下面的 fresh 建立流程。
    //   （放在 existingPeer 分支「之前」：拆完重讀，才不會落進「PC 還活著→reopen-in-place」那支，
    //     對著已被 closePeer 的 peer 做原地重開。）
    if (this.isPeerZombie(remotePublicKeyBase64)) {
      diagLog('[DIAG:WebRTC] ZOMBIE peer (open but no inbound >35s) → teardown + fresh rebuild:', remotePublicKeyBase64.slice(0, 16));
      this.closePeer(remotePublicKeyBase64);
    }

    const existingPeer = this.peers.get(remotePublicKeyBase64);
    if (existingPeer) {
      const connState = existingPeer.connection.connectionState;
      const iceState = existingPeer.connection.iceConnectionState;
      const dcState = existingPeer.dataChannel?.readyState;

      // DataChannel 已開啟 → 不重連（殭屍已在上面被拆掉，走不到這裡）。
      //   ⚠️ PC 已經 failed／closed（終端、不會自己恢復）時 readyState 還會停在 'open'：對方關了 App、這條通道才開一下
      //   還沒收過心跳（殭屍判定沒啟用）。那不是開著 —— 往下走「真的死了 → 拆掉重建」。以前這裡直接 return，
      //   該由我發起重連時（pubkey 較大）peerHealth 每 30 秒叫一次 connect 都白叫，對方重開 App 後幾分鐘連不回來（四機模擬 D1）
      const terminal = connState === 'failed' || connState === 'closed' || iceState === 'failed';
      if (dcState === 'open' && !terminal) {
        devLog(`[WebRTC] Already connected to ${remotePublicKeyBase64.slice(0, 8)}...`);
        return;
      }
      const inProgress = !terminal && (connState === 'new' || connState === 'connecting' ||
        iceState === 'new' || iceState === 'checking');
      if (inProgress && !this.isStaleStuck(remotePublicKeyBase64, existingPeer)) {
        // 連線進行中且還在 deadline 內 → 等待，不打斷
        diagLog('[DIAG:WebRTC] Connection in progress, waiting:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        return;
      }
      if (inProgress) {
        // 🔑 livelock 修復：卡在 new/connecting/checking、DataChannel 從未 open 超過 deadline →
        //   offer 多半送進已死的對端（peer full restart）；原地 reopen/等待都無效 → 砍掉重建 fresh。
        //   （3.6: Bob 完整重啟後 Alice 對舊 PC 永遠卡 new/new，watchdog 反覆 reconnect→connect() 早退）
        diagLog('[DIAG:WebRTC] Stuck (no DataChannel past deadline) → teardown + fresh rebuild:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        this.closePeer(remotePublicKeyBase64);
        // ↓ fall through to fresh connect
      } else if (connState !== 'failed' && connState !== 'closed' && iceState !== 'failed') {
        // 🔑 根因修復：PC 仍活著（connected/disconnected）但 DataChannel 沒開 → 絕不 closePeer 重建。
        //   重建會與對端各自重建互相搶 → PC 世代錯位 → channel 開了又關、永不收斂。
        //   改在「同一條 PC」上原地 renegotiation 重開 DataChannel，且只有單一發起者(impolite)動作。
        diagLog('[DIAG:WebRTC] Live PC, DC not open → reopen channel in-place:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        await this.reopenDataChannelInPlace(remotePublicKeyBase64);
        return;
      } else {
        // 真的死了（failed/closed）→ 清理後重連
        diagLog('[DIAG:WebRTC] Cleaning dead peer (rebuild):', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        this.closePeer(remotePublicKeyBase64);
      }
    }

    devLog(`[WebRTC] Initiating connection to ${remotePublicKeyBase64.slice(0, 8)}...`);

    // 建立 RTCPeerConnection
    const connection = this.createPeerConnection(remotePublicKeyBase64, true);

    // 建立資料通道
    const dataChannel = connection.createDataChannel('mist', {
      ordered: true,
    });
    this.setupDataChannel(dataChannel, remotePublicKeyBase64);

    // 儲存 Peer 資訊
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now());
    this.peers.set(remotePublicKeyBase64, {
      publicKeyBase64: remotePublicKeyBase64,
      connection,
      dataChannel,
      connectionState: PeerConnectionState.CONNECTING,
      dataChannelState: DataChannelState.CONNECTING,
      isInitiator: true,
      pendingCandidates: [],
      candidateFlushTimer: null,
      incomingCandidates: [],
      lastDcInboundAt: Date.now(),
      hbCapable: false,
      localPcId: newPcId(),
      fp: this.makeFingerprintCheck(remotePublicKeyBase64, connection),
      verified: false,
      heldInbound: [],
      heldInboundBytes: 0,
    });

    // 建立 Offer（Perfect Negotiation：makingOffer 期間若收到對方 offer = collision）
    this.makingOffer.add(remotePublicKeyBase64);
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      const groupProof = await this.offerProofFor(remotePublicKeyBase64);

      // 封給對方送 Offer（DIRECT_SEALED kind dc）
      // 帶上本 PC 的世代 id：對端據此判斷「我是不是換了一條新的 PC」（見 PeerInfo.localPcId）；
      //   附群組金鑰證明：對方名冊上若少了我，憑它認得我（見 OfferProofHooks）
      const sent = this.peers.get(remotePublicKeyBase64);
      if (sent && sent.connection === connection) {
        this.sendDcSignal(remotePublicKeyBase64, 'offer', { pc: sent.localPcId, data: { type: 'offer', sdp: offer.sdp ?? '' }, groupProof });
      }
      devLog(`[WebRTC] Sent offer to ${remotePublicKeyBase64.slice(0, 8)}...`);
    } catch (error) {
      // Perfect Negotiation glare 讓位：polite 端在本 offer 流程 pending 期間接受了對方
      // 的 offer（sig 變 have-remote-offer）→ 這裡的 setLocalDescription 必然 throw
      // 「wrong state」— 這不是連線壞，是讓位成功的正常代價。此時絕不可 closePeer：
      // 拆的正是 handleOffer 要回 answer 的那條 PC（2026-07-19 glare round2 絕對時戳取證：
      // closePeer → 對方 offer 永無 answer、ICE candidate no peer → 雙方 35s+ 卡死）。
      if (connection.signalingState === 'have-remote-offer') {
        diagLog('[DIAG:WebRTC] offer aborted by glare-yield (sig=have-remote-offer), keep PC:', remotePublicKeyBase64.slice(0, 16));
        return; // 連線改由對方 offer 的 answer 流程建立，不算失敗
      }
      console.error('[WebRTC] Failed to create offer:', error);
      this.closePeer(remotePublicKeyBase64);
      throw error;
    } finally {
      this.makingOffer.delete(remotePublicKeyBase64);
    }
  }

  /**
   * 🔑 根因修復：DataChannel 關閉但 PC 仍活著時，在「同一條 RTCPeerConnection」上原地重開 channel，
   *   不拆 PC。拆 PC → 雙方各自重建 → PC 世代錯位、互搶、stale answer 被 IGNORE → 永不收斂（本 bug 真因）。
   *
   * 單一發起者：只有 impolite（pubkey 較大）重開並送 offer；polite 端不動，等 impolite 的 re-offer
   *   （其 handleOffer 走 PerfectNeg 同連線回 answer + ondatachannel 收新 channel）→ 雙方收斂到同一條 PC。
   */
  private async reopenDataChannelInPlace(remotePublicKeyBase64: string): Promise<void> {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return;

    const polite = !!this.localPublicKeyBase64 && this.localPublicKeyBase64 < remotePublicKeyBase64;
    if (polite) {
      diagLog('[DIAG:WebRTC] reopen: polite side waits for impolite re-offer:', remotePublicKeyBase64.slice(0, 16));
      return;
    }
    if (this.makingOffer.has(remotePublicKeyBase64) || peer.connection.signalingState !== 'stable') {
      diagLog('[DIAG:WebRTC] reopen: skip (offer/negotiation in progress):', remotePublicKeyBase64.slice(0, 16), `sig=${peer.connection.signalingState}`);
      return;
    }

    diagLog('[DIAG:WebRTC] reopen DataChannel in-place (same PC, NO teardown):', remotePublicKeyBase64.slice(0, 16));
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now()); // 新一輪 renegotiation 嘗試起算
    const dataChannel = peer.connection.createDataChannel('mist', { ordered: true });
    this.setupDataChannel(dataChannel, remotePublicKeyBase64);
    peer.dataChannel = dataChannel;
    peer.isInitiator = true;

    this.makingOffer.add(remotePublicKeyBase64);
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const groupProof = await this.offerProofFor(remotePublicKeyBase64);
      // 帶上本 PC 的世代 id（同一條 PC：對方認得出是原地重開）；附群組金鑰證明（同上）
      this.sendDcSignal(remotePublicKeyBase64, 'offer', { pc: peer.localPcId, rpc: peer.remotePcId,
        data: { type: 'offer', sdp: offer.sdp ?? '' }, groupProof });
      devLog(`[WebRTC] Re-offered (reopen DC) to ${remotePublicKeyBase64.slice(0, 8)}...`);
    } catch (error) {
      console.error('[WebRTC] reopen renegotiation failed:', error);
    } finally {
      this.makingOffer.delete(remotePublicKeyBase64);
    }
  }

  /**
   * 斷開與指定 Peer 的連線
   */
  disconnect(remotePublicKeyBase64: string): void {
    this.closePeer(remotePublicKeyBase64);
  }

  /**
   * 發送資料到指定 Peer
   */
  send(remotePublicKeyBase64: string, data: ArrayBuffer | string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      devWarn(`[WebRTC] Cannot send to ${remotePublicKeyBase64.slice(0, 8)}...: channel not open`);
      return false;
    }
    // DTLS 指紋還沒對過：不送（中間人看不到我送的任何東西；呼叫端走 outbox，對上時 OPEN 會 flush）
    if (!peer.verified) {
      devWarn(`[WebRTC] Cannot send to ${remotePublicKeyBase64.slice(0, 8)}...: DTLS fingerprints not verified yet`);
      return false;
    }

    try {
      if (typeof data === 'string') {
        const partLimit = WebRTCService.frameLimitFor(peer);
        let frames = splitFrame(data, partLimit, WebRTCService.singleFrameLimitFor(peer));
        if (frames?.length === 1 && data.length * 3 > partLimit && utf8Length(data) > partLimit) {
          // 超過分塊片長、但在對端宣告的上限內 → 照舊單幀送。對端宣告的比本機實際能送的大
          //   （例如 Firefox 宣告 1GB、Chromium 只能送 256KB）時 send 會丟錯，這時才改分塊
          try {
            peer.dataChannel.send(data);
            return true;
          } catch {
            frames = splitFrame(data, partLimit);
          }
        }
        if (!frames) {
          console.error('[WebRTC] Message too large for DataChannel:', data.length, 'chars');
          return false;
        }
        if (frames.length > 1 && peer.dataChannel.bufferedAmount + data.length > WebRTCService.DC_SEND_BUFFER_LIMIT) {
          devWarn('[WebRTC] Send buffer nearly full; leaving the large message for the next flush');
          return false;
        }
        for (const frame of frames) peer.dataChannel.send(frame);
      } else {
        peer.dataChannel.send(data);
      }
      return true;
    } catch (error) {
      console.error('[WebRTC] Failed to send:', error);
      return false;
    }
  }

  /**
   * 廣播資料到所有已連線的 Peers
   */
  broadcast(data: ArrayBuffer | string): void {
    this.peers.forEach((peer, key) => {
      if (peer.dataChannel?.readyState === 'open') {
        this.send(key, data);
      }
    });
  }

  /**
   * 取得所有已連線的 Peers
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.connectionState === PeerConnectionState.CONNECTED)
      .map(([key]) => key);
  }

  /**
   * 取得 Peer 連線狀態
   */
  getPeerState(remotePublicKeyBase64: string): PeerConnectionState | null {
    return this.peers.get(remotePublicKeyBase64)?.connectionState ?? null;
  }

  /**
   * 取得指定 peer 的 DataChannel bufferedAmount，給 fileTransfer backpressure 用。
   * 對方沒連線或 DC 不存在時回 0（呼叫端可視為「無壓力」直接送，反正 send() 會回 false）。
   */
  getBufferedAmount(remotePublicKeyBase64: string): number {
    return this.peers.get(remotePublicKeyBase64)?.dataChannel?.bufferedAmount ?? 0;
  }

  /**
   * 目前送訊用的那條 DataChannel 是什麼時候 open 的（沒有回 0）。p2pSend 用：在這之前送出、還在等回條的群訊
   * 是送進舊通道的（通道剛死時 readyState 還會說 open 好幾秒），新通道一開就重送，不必再等 30 秒（對應群星 8708fa6f）。
   */
  channelOpenedAt(remotePublicKeyBase64: string): number {
    return this.peers.get(remotePublicKeyBase64)?.dcOpenedAt ?? 0;
  }

  /**
   * 目前送訊用的那條 DataChannel 的編號（沒有回 0）。對方重開 App、重連、換通道都會換號；ICE 短暫斷線後自己恢復
   * （同一條通道）不換。fileTransfer 用：一輪送檔綁在送出 manifest 的那條通道上，換號了就整輪重來（manifest 在舊通道那頭）。
   */
  channelEpoch(remotePublicKeyBase64: string): number {
    return this.peers.get(remotePublicKeyBase64)?.dcEpoch ?? 0;
  }

  /** 檢查指定 peer 的 DataChannel 是否真的可送（給 fileTransfer / p2pSend 用）。 */
  isDataChannelOpen(remotePublicKeyBase64: string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer?.dataChannel?.readyState !== 'open') return false;
    // DTLS 指紋還沒對過（開源第 4 步）：不算開著
    if (!peer.verified) return false;
    // ⚠️ 真因：底層 RTCPeerConnection 已 failed/disconnected/closed 後，dataChannel.readyState
    //   仍會殘留 'open' → 送進去等於丟黑洞，p2pSend 卻回報「P2P ok」且訊息不進 outbox →
    //   換網/背景喚醒後雙方互傳卻都收不到（2026-06-29 真機 log connectionState=failed 證實）。
    //   必須同時確認 connection 本身還活著，否則一律當未連線 → 進持久化 outbox 等重連 flush。
    const cs = peer.connection.connectionState;
    if (cs === 'failed' || cs === 'disconnected' || cs === 'closed') return false;
    // ⚠️ 殭屍（LEARNINGS §13）：cs='connected' + readyState='open' 但底層傳輸已死。
    //   上面那組狀態檢查涵蓋不到（2026-06-29 只修了 failed/disconnected 那一半）。
    //   判死後回 false → p2pSend 改走持久化 outbox（訊息不再靜默蒸發）、watchdog 也看得到它不健康。
    if (this.isPeerZombie(remotePublicKeyBase64)) {
      diagLog('[DIAG:WebRTC] ZOMBIE DataChannel (open but no inbound >35s):', remotePublicKeyBase64.slice(0, 16));
      return false;
    }
    return true;
  }

  /**
   * 連線是否已進入「終端 failed」狀態（LEARNINGS §11.2）。peerHealthMonitor 用：presence 可能 stale
   * （對方其實還在、卻回報 offline）→ 光靠 presence 判斷會讓 failed 的 peer 沒人救（實測失敗後卡數分鐘，
   * 直到對方剛好送 offer 才靠 handleOffer 復原）。connectionState==='failed' 是直接證據、不是 presence
   * 猜測 → 據此主動重連。只認 'failed'（終端、不自復）；'disconnected' 是暫時、ICE 會自復，不列入（否則打斷自復）。
   */
  isPeerFailed(remotePublicKeyBase64: string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return false;
    return peer.connection.connectionState === 'failed'
      || peer.connection.iceConnectionState === 'failed';
  }

  /**
   * 監聽收到的訊息
   */
  onMessage(callback: MessageCallback): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * 監聯連線狀態變化
   */
  onStateChange(callback: StateCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * 監聽資料通道狀態變化
   */
  onDataChannelStateChange(callback: DataChannelStateCallback): () => void {
    this.dataChannelStateListeners.add(callback);
    return () => this.dataChannelStateListeners.delete(callback);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * 建立 RTCPeerConnection
   */
  private createPeerConnection(remotePublicKeyBase64: string, isInitiator: boolean): RTCPeerConnection {
    const connection = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });

    // ICE Candidate 事件 - IPv6 優先處理，過濾 relay（TURN）candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        // ❌ 過濾 relay candidates — 訊息內容不可經過 TURN 伺服器
        if (event.candidate.type === 'relay' || event.candidate.candidate?.includes('relay')) {
          devLog(`[WebRTC] ❌ Filtered relay candidate (TURN disabled)`);
          return;
        }
        if (IPV6_FIRST_ENABLED) {
          // 收集 candidates，延遲發送以便排序
          this.queueCandidate(remotePublicKeyBase64, event.candidate);
        } else {
          // 不啟用 IPv6 優先時，直接發送
          this.sendIce(remotePublicKeyBase64, event.candidate);
        }
      } else {
        // ICE gathering 完成，立即發送所有暫存的 candidates
        if (IPV6_FIRST_ENABLED) {
          this.flushCandidates(remotePublicKeyBase64);
        }
      }
    };

    // signaling 狀態（offer/answer 世代錯位、rollback 可見）
    connection.onsignalingstatechange = () => {
      diagLog(`[DIAG:WebRTC] signalingState=${connection.signalingState} init=${isInitiator} peer=${remotePublicKeyBase64.slice(0, 16)}`);
    };
    // ICE candidate 層錯誤（STUN/配對失敗通常無人監聽 → 沉默）
    connection.onicecandidateerror = (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      diagLog(`[DIAG:WebRTC] icecandidateerror code=${e.errorCode} text=${e.errorText?.slice(0, 80)} peer=${remotePublicKeyBase64.slice(0, 16)}`);
    };

    // ICE 連線狀態變化
    connection.oniceconnectionstatechange = () => {
      // DIAG: 印原始 ICE 狀態轉換（new→checking→connected/failed/disconnected），
      //   用來讀「DataChannel 為何沒 OPEN」—— 卡 checking？failed？disconnected？
      diagLog(`[DIAG:WebRTC] iceConnectionState=${connection.iceConnectionState} init=${isInitiator} peer=${remotePublicKeyBase64.slice(0, 16)}`);
      const state = this.mapIceConnectionState(connection.iceConnectionState);
      this.updatePeerState(remotePublicKeyBase64, state);
      this.trackIceRecovery(remotePublicKeyBase64, connection, state);

      // 連線成功時，記錄使用的連線類型；開始核對 DTLS 指紋（對上之前這條通道不算開著）
      if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
        this.logConnectionType(connection, remotePublicKeyBase64);
        const peer = this.peers.get(remotePublicKeyBase64);
        if (peer && peer.connection === connection) peer.fp.start();
      }
    };

    // 連線狀態變化
    connection.onconnectionstatechange = () => {
      diagLog(`[DIAG:WebRTC] connectionState=${connection.connectionState} init=${isInitiator} peer=${remotePublicKeyBase64.slice(0, 16)}`);
      const state = this.mapConnectionState(connection.connectionState);
      this.updatePeerState(remotePublicKeyBase64, state);
      this.trackIceRecovery(remotePublicKeyBase64, connection, state);
    };

    // ICE gathering 狀態（看 candidate 收集是否完成）
    connection.onicegatheringstatechange = () => {
      diagLog(`[DIAG:WebRTC] iceGatheringState=${connection.iceGatheringState} peer=${remotePublicKeyBase64.slice(0, 16)}`);
    };

    // 接收資料通道 —— 所有連線都掛（Perfect Negotiation：glare 時 polite 端 rollback 後變 answerer，
    //   需經 ondatachannel 收 impolite 端的 channel；一般 initiator 流程不觸發，無害）。
    connection.ondatachannel = (event) => {
      // 不在此立刻 peer.dataChannel = event.channel：新收到的通道可能還沒 open，立刻覆蓋 send slot
      //   會把「正在用、還開著」的舊通道換成半開通道 → send 壞掉（對端仍從舊通道收 = 收得到卻送不出，
      //   LEARNINGS §11.1）。只 setupDataChannel（掛 onopen/onmessage）；等它 onopen 真的開了，
      //   再由 onopen promote 成 send slot。onmessage 立即生效 → 收訊不受影響。
      this.setupDataChannel(event.channel, remotePublicKeyBase64);
    };

    return connection;
  }

  /**
   * 設定資料通道事件處理
   */
  private setupDataChannel(channel: RTCDataChannel, remotePublicKeyBase64: string): void {
    channel.binaryType = 'arraybuffer';
    diagLog(`[DIAG:WebRTC] setupDataChannel readyState=${channel.readyState} peer=${remotePublicKeyBase64.slice(0, 16)}`);

    channel.onopen = () => {
      // 新通道開啟 → 重置活性時鐘（否則沿用舊的 lastDcInboundAt 會被立刻判 stale）
      const p = this.peers.get(remotePublicKeyBase64);
      if (p) p.lastDcInboundAt = Date.now();
      diagLog('[DIAG:WebRTC] DataChannel OPEN with:', remotePublicKeyBase64.slice(0, 16));
      this.connectAttemptAt.delete(remotePublicKeyBase64); // 連上了 → 清掉「本輪嘗試」計時
      // 🔑「收得到卻送不出」修復（LEARNINGS §11.1）：send() 只認 peer.dataChannel 一個 slot。
      //   多通道情境（自建 + ondatachannel 收到 + reopen 新建）slot 可能是「還沒 open / 半開」的通道，
      //   對端訊息卻從另一條已 open 的通道進來（onmessage 每條都掛）→ 收得到、送失敗。
      //   對策：哪條通道「真的 open 了」才設為 send slot → send 永遠用一條確定開著的通道。
      const peer = this.peers.get(remotePublicKeyBase64);
      if (peer) {
        peer.dataChannel = channel;
        // DTLS 指紋還沒對過：通道開了也先不算（不送、收到的先壓著）—— 對上時 onPeerVerified 補發 OPEN
        if (!peer.verified) {
          diagLog('[DIAG:WebRTC] DataChannel open, waiting for the DTLS fingerprint check:', remotePublicKeyBase64.slice(0, 16));
          return;
        }
        this.announceOpen(remotePublicKeyBase64, peer);
      }
      // （peer 已經不在了 —— 拆掉之後才開的舊通道 —— 不算開著）
    };

    channel.onclose = () => {
      diagLog(`[DIAG:WebRTC] DataChannel CLOSED with: ${remotePublicKeyBase64.slice(0, 16)}`);
      this.updateDataChannelState(remotePublicKeyBase64, DataChannelState.CLOSED);
    };

    channel.onerror = (error) => {
      diagLog(`[DIAG:WebRTC] DataChannel ERROR with ${remotePublicKeyBase64.slice(0, 16)}: ${(error as RTCErrorEvent)?.error?.message || 'unknown'}`);
    };

    channel.onmessage = (event) => {
      const peer = this.peers.get(remotePublicKeyBase64);
      // E2E 模擬殭屍：丟棄所有 inbound、不更新活性、readyState 不動 → 精確重現「open 但已死」。
      //   （綁在「當前這條通道」上：closePeer 會刪掉整個 peer entry → 重建後的新通道不帶此旗標，
      //     否則重建後仍被丟包 → 永遠好不了 = 測試自己造成的假失敗，見 LEARNINGS §13 踩過的坑）
      if (peer?.simulatedDead) return;

      // 活性訊號（LEARNINGS §13）：收到「任何」inbound 都算通道還活著（含心跳）。
      //   這是唯一可靠的訊號 —— readyState 是個會說謊的旗標。
      if (peer) peer.lastDcInboundAt = Date.now();

      // 心跳幀：只更新活性，不往上送（也不該被當成訊息解密）。
      //   收到心跳 = 對端是新版、會送心跳 → 開啟 staleness 判定（相容性 gate）。
      if (typeof event.data === 'string' && event.data === WebRTCService.DC_HEARTBEAT_FRAME) {
        if (peer && !peer.hbCapable) {
          peer.hbCapable = true;
          diagLog('[DIAG:WebRTC] peer is heartbeat-capable → staleness 判定啟用:', remotePublicKeyBase64.slice(0, 16));
        }
        return;
      }

      // DTLS 指紋還沒對過（對方先驗完、先送了）：先壓著，對上才往上送；對不上整條拆掉、這些一起丟
      if (peer && !peer.verified) {
        const size = typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength ?? 0;
        if (peer.heldInbound.length >= MAX_HELD_INBOUND || peer.heldInboundBytes + size > MAX_HELD_INBOUND_BYTES) {
          this.count('held-inbound-dropped');
          return;
        }
        peer.heldInbound.push(event.data);
        peer.heldInboundBytes += size;
        return;
      }

      this.deliver(remotePublicKeyBase64, event.data);
    };
  }

  /** 收到的一則（分塊幀湊齊才往上送整則訊息，dcFraming，傳輸統一 X5） */
  private deliver(remotePublicKeyBase64: string, raw: ArrayBuffer | string): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    let data = raw;
    if (typeof data === 'string' && peer) {
      if (!peer.rxFrames) peer.rxFrames = new FrameAssembler();
      const whole = peer.rxFrames.push(data);
      if (whole === null) return;
      if (whole !== undefined) data = whole;
    }
    this.messageListeners.forEach((callback) => {
      callback(remotePublicKeyBase64, data);
    });
  }

  /** 這條通道真的可以用了（開著＋指紋對過）：設成送訊用的那一條、換號、通知 OPEN */
  private announceOpen(remotePublicKeyBase64: string, peer: PeerInfo): void {
    peer.dcOpenedAt = Date.now();
    peer.dcEpoch = ++this.dcEpochSeq;
    this.updateDataChannelState(remotePublicKeyBase64, DataChannelState.OPEN);
  }

  // ───────── 封好的信令（DIRECT_SEALED kind 'dc'）與 DTLS 指紋 ─────────

  private counters: Record<string, number> = {};
  private count(k: string): void { this.counters[k] = (this.counters[k] ?? 0) + 1; }

  /** 模擬／測試：計數、每個 peer 的指紋狀態（不含金鑰） */
  debugState(): { counters: Record<string, number>; peers: Record<string, { verified: boolean; fp: string; localPcId: string; remotePcId: string | null }> } {
    const peers: Record<string, { verified: boolean; fp: string; localPcId: string; remotePcId: string | null }> = {};
    this.peers.forEach((p, k) => { peers[k] = { verified: p.verified, fp: p.fp.state, localPcId: p.localPcId, remotePcId: p.remotePcId ?? null }; });
    return { counters: { ...this.counters }, peers };
  }

  /** 模擬：跟這個 peer 那條 PC 我這端讀到的 DTLS 指紋（兩邊交叉比對「沒有中間人」用） */
  async debugFingerprints(remotePublicKeyBase64: string): Promise<DtlsFingerprints | null> {
    const peer = this.peers.get(remotePublicKeyBase64);
    return peer ? readFingerprints(peer.connection) : null;
  }

  /** 封給對方送出去（連著才送：過期的信令只會搗亂） */
  private sendDcSignal(remote: string, sig: DcSig, fields: { pc: string; rpc?: string; data: Record<string, unknown>; groupProof?: unknown }): void {
    sendDirect(remote, {
      kind: 'dc', sig, pc: fields.pc, ...(fields.rpc ? { rpc: fields.rpc } : {}), data: fields.data,
      ...(fields.groupProof !== undefined ? { groupProof: fields.groupProof } : {}),
    }, { transient: true })
      .then((sent) => { if (!sent) diagLog(`[DIAG:WebRTC] ${sig} to ${remote.slice(0, 16)} not sent (offline or locked)`); })
      .catch((err) => console.error(`[WebRTC] ${sig} failed:`, err));
  }

  private sendIce(remote: string, candidate: RTCIceCandidate): void {
    const peer = this.peers.get(remote);
    if (!peer) return;
    const json = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
    this.sendDcSignal(remote, 'ice', { pc: peer.localPcId, rpc: peer.remotePcId, data: { ...(json as unknown as Record<string, unknown>) } });
  }

  /** 送我的指紋（獨立的方法：模擬竄改自己送出去的指紋，測「對不上就拆」） */
  private sendFingerprint(remote: string, fp: DtlsFingerprints, got: boolean): void {
    const peer = this.peers.get(remote);
    if (!peer?.remotePcId) return;
    this.sendDcSignal(remote, 'fp', { pc: peer.localPcId, rpc: peer.remotePcId, data: { local: fp.local, remote: fp.remote, got } });
  }

  /** directSignal 交過來的 kind 'dc'（寄件人已由信封的簽章證明） */
  private handleDirect(from: string, body: DirectBody): void {
    const msg = parseDcSignal(from, body);
    if (!msg) { this.count('dc-malformed'); return; }
    const run = msg.sig === 'offer' ? this.handleOffer(msg)
      : msg.sig === 'answer' ? this.handleAnswer(msg)
        : msg.sig === 'ice' ? this.handleIceCandidate(msg)
          : Promise.resolve(this.handleFingerprint(msg));
    run.catch((err) => console.error(`[WebRTC] ${msg.sig} handling failed:`, err));
  }

  /** 對方的指紋：一定要是我現在這條 PC 配的那一條（pc ＝ 我記得的對方、rpc ＝ 我自己） */
  private handleFingerprint(msg: DcSignal): void {
    const peer = this.peers.get(msg.from);
    if (!peer || msg.pc !== peer.remotePcId || msg.rpc !== peer.localPcId) { this.count('fp-stale'); return; }
    peer.fp.receive(msg.data);
  }

  /** 一條 PC 的指紋核對：對上 → 這條通道才算開著；對不上 → 拆掉、跟使用者說；驗不了 → 拆掉（健康檢查會重連） */
  private makeFingerprintCheck(remote: string, connection: RTCPeerConnection): FingerprintCheck {
    const current = () => { const p = this.peers.get(remote); return p && p.connection === connection ? p : null; };
    return createFingerprintCheck({
      read: () => readFingerprints(connection),
      send: (fp, got) => { if (current()) this.sendFingerprint(remote, fp, got); },
      onVerified: () => { const p = current(); if (p) this.onPeerVerified(remote, p); },
      onFail: (reason) => { if (current()) this.onPeerUnverified(remote, reason); },
      timeoutMs: DC_FINGERPRINT_TIMEOUT_MS,
    });
  }

  private onPeerVerified(remote: string, peer: PeerInfo): void {
    if (peer.verified) return;
    peer.verified = true;
    this.count('fp-verified');
    diagLog('[DIAG:WebRTC] DTLS fingerprints verified with:', remote.slice(0, 16));
    if (peer.dataChannel?.readyState === 'open') this.announceOpen(remote, peer);
    // 驗過之前收到的（對方先驗完、先送了）現在往上送
    const held = peer.heldInbound;
    peer.heldInbound = [];
    peer.heldInboundBytes = 0;
    for (const data of held) this.deliver(remote, data);
  }

  private onPeerUnverified(remote: string, reason: FingerprintFailure): void {
    this.count(`fp-${reason}`);
    console.error(`[WebRTC] DTLS fingerprint check failed (${reason}) with ${remote.slice(0, 16)} — dropping the connection`);
    if (reason === 'mismatch' && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'link-unverified', reason } }));
    }
    this.closePeer(remote);
  }

  /**
   * 處理收到的 Offer（封好、寄件人簽章的 —— 只有 directSignal 驗過的會到這裡）
   */
  private async handleOffer(msg: DcSignal): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    if (msg.authenticated !== true) return;

    if (!this.peers.has(remotePublicKeyBase64) && !this.gateWaitCandidates.has(remotePublicKeyBase64)) {
      this.gateWaitCandidates.set(remotePublicKeyBase64, []);
    }
    const verdict = await this.offerVerdict(remotePublicKeyBase64, msg.groupProof);
    const earlyCandidates = this.gateWaitCandidates.get(remotePublicKeyBase64) ?? [];
    this.gateWaitCandidates.delete(remotePublicKeyBase64);
    if (verdict === 'unknown') {
      this.holdOffer(msg, earlyCandidates);   // 名冊事件可能還在後面（見 heldOffers）；15 秒內還不認得才丟
      return;
    }
    if (verdict === 'deny') {
      diagLog('[DIAG:WebRTC] offer from a stranger ignored:', remotePublicKeyBase64.slice(0, 16));
      return;
    }
    // 收著的舊 offer 作廢（這一則已經可以處理了）
    this.heldOffers.delete(remotePublicKeyBase64);
    await this.acceptOfferWithCandidates(msg, earlyCandidates);
  }

  /**
   * 處理 offer，連同它之前就到了的 ICE（等閘門、收著期間）。這段期間本機可能已經自己建了連線（名冊多了人就主動連、
   * 有待送就連）：那時 acceptOffer 走既有連線的分支，不會用 earlyCandidates —— 補進那條連線，不能丟
   * （少了對方的 candidate，嚴格 NAT 或只能走中繼時就連不上）。
   */
  private async acceptOfferWithCandidates(msg: DcSignal, candidates: TaggedCandidate[]): Promise<void> {
    const pk = msg.from;
    const hadPeer = this.peers.has(pk);
    await this.acceptOffer(msg, hadPeer ? [] : candidates);
    if (!hadPeer) return;
    for (const c of candidates) {
      await this.addRemoteCandidate(pk, c);
    }
  }

  /** 已經過閘門的 offer：照 Perfect Negotiation 處理 */
  private async acceptOffer(msg: DcSignal, earlyCandidates: TaggedCandidate[]): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: msg.data.sdp as string };
    diagLog('[DIAG:WebRTC] Received offer from:', remotePublicKeyBase64.slice(0, 16));
    devLog(`[WebRTC] Received offer from ${remotePublicKeyBase64.slice(0, 8)}...`);

    const offerPcId = msg.pc;

    const existingPeer = this.peers.get(remotePublicKeyBase64);
    if (existingPeer) {
      // ⚠️ 對端換了新 PC（世代不同）→ 我方這條舊 PC 是跟「已經不存在的 PC」配對的，
      //   在它上面回 answer 等於對空氣講話（ICE/DTLS 參數全是舊世代）→ 必須砍掉重建。
      //   實測（殭屍 E2E）：少了這段，Alice 拆除重建後 Bob 仍在舊 PC 上 reopen-in-place →
      //   世代錯位 → 要反覆重試 ~50s 才碰巧收斂；補上後一輪就通。
      //   開源第 4 步：只有封好、對方簽章的 offer 能走到這裡（authenticated）；而且要比我學到對方目前那條 PC 的那一則新
      //   （重放、晚到的舊 offer 帶的是舊世代 —— 不准拿它拆掉正在用的連線，群星 aegisplay-call-check.md 的 DC 劫持）
      if (existingPeer.remotePcId && offerPcId !== existingPeer.remotePcId) {
        if (msg.authenticated !== true || (existingPeer.remotePcIat !== undefined && !(msg.iat > existingPeer.remotePcIat))) {
          this.count('offer-stale-generation');
          diagLog('[DIAG:WebRTC] offer for an older PC generation ignored:', remotePublicKeyBase64.slice(0, 16));
          return;
        }
        diagLog('[DIAG:WebRTC] peer rebuilt its PC (new generation) → teardown my stale PC:',
          remotePublicKeyBase64.slice(0, 16), `old=${existingPeer.remotePcId} new=${offerPcId}`);
        this.closePeer(remotePublicKeyBase64);
        await this.createResponderConnection(remotePublicKeyBase64, offer, offerPcId, msg.iat);
        return;
      }
      if (!existingPeer.remotePcId) {
        existingPeer.remotePcId = offerPcId;
        existingPeer.remotePcIat = msg.iat;
      }

      // 🔑 根因修復：只有「PC 真的終止」(failed/closed) 才算死、才重建。
      //   DataChannel 關閉 或 暫時 disconnected 都「不算死」—— 保留同一條 PC，由發起端原地
      //   renegotiation 重開 channel（見 connect()/reopenDataChannelInPlace）。
      //   舊版把 dataChannelState===CLOSED / disconnected 也當死 → 一次短暫關閉就讓雙方各自
      //   closePeer 重建 → PC 世代錯位、互相搶、stale answer 被 IGNORE → channel 開了又關、永不收斂（本 bug 真因）。
      const existingDead =
        existingPeer.connectionState === PeerConnectionState.FAILED ||
        existingPeer.connectionState === PeerConnectionState.CLOSED;
      // 對端送來「fresh offer」但我方對它的 PC 早就卡死（new/new、DataChannel 從未 open 超過 deadline，
      //   例：對端完整重啟）→ 在這條死 PC 上跑 PerfectNeg 回 answer 也連不上。直接砍掉、建 fresh responder。
      const staleStuck = this.isStaleStuck(remotePublicKeyBase64, existingPeer);

      if (!existingDead && !staleStuck) {
        // ── Perfect Negotiation（W3C/MDN 標準）取代舊「closePeer 拆掉重建」──
        //   舊作法在 glare 時關掉既有連線重建 → 丟失進行中的 ICE 狀態 → 卡 conn=new（nat run 2/7/12 實證）。
        //   改在「同一條 RTCPeerConnection」上處理 offer collision，保留 ICE：
        //     impolite（pubkey 較大）+ collision → 忽略對方 offer（保留自己的 offer，等對方 answer）。
        //     polite（pubkey 較小）或非 collision → setRemoteDescription(offer)（have-local-offer 時隱式 rollback）
        //       → 同一連線回 answer，不拆連線、不丟 ICE。
        const pc = existingPeer.connection;
        const polite = !!this.localPublicKeyBase64 && this.localPublicKeyBase64 < remotePublicKeyBase64;
        const collision = this.makingOffer.has(remotePublicKeyBase64) || pc.signalingState !== 'stable';

        if (collision && !polite) {
          diagLog('[DIAG:WebRTC] PerfectNeg impolite IGNORING colliding offer:', remotePublicKeyBase64.slice(0, 16), `sig=${pc.signalingState} making=${this.makingOffer.has(remotePublicKeyBase64)}`);
          return;
        }

        try {
          diagLog(`[DIAG:WebRTC] PerfectNeg accept offer polite=${polite} collision=${collision} sig=${pc.signalingState} peer:`, remotePublicKeyBase64.slice(0, 16));
          // have-local-offer + 收 offer → setRemoteDescription 隱式 rollback（同一連線、保留 ICE）
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          await this.flushIncomingCandidates(remotePublicKeyBase64);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (this.peers.get(remotePublicKeyBase64) !== existingPeer) return;
          this.sendDcSignal(remotePublicKeyBase64, 'answer', { pc: existingPeer.localPcId, rpc: offerPcId,
            data: { type: 'answer', sdp: answer.sdp ?? '' } });
          existingPeer.isInitiator = false; // 我方現在是 answerer
          diagLog('[DIAG:WebRTC] PerfectNeg sent answer on SAME connection:', remotePublicKeyBase64.slice(0, 16));
        } catch (error) {
          console.error('[WebRTC] PerfectNeg failed, falling back to rebuild:', error);
          this.closePeer(remotePublicKeyBase64);
          await this.createResponderConnection(remotePublicKeyBase64, offer, offerPcId, msg.iat);
        }
        return;
      }

      // 既有連線真的死了/卡死 → 合法重連：closePeer + 建新 responder
      diagLog('[DIAG:WebRTC] Existing peer DEAD/STUCK - rebuild responder:', remotePublicKeyBase64.slice(0, 16), `conn=${existingPeer.connectionState} dc=${existingPeer.dataChannelState} stuck=${staleStuck}`);
      this.closePeer(remotePublicKeyBase64);
    }

    // 沒有既有 peer（或 dead 已關）→ 建新 responder 連線並回 answer
    await this.createResponderConnection(remotePublicKeyBase64, offer, offerPcId, msg.iat, existingPeer ? [] : earlyCandidates);
  }

  /** 建新 responder 連線並回 answer（一般非 glare 路徑 / dead 重連用）。earlyCandidates：閘門等待中先到的 ICE */
  private async createResponderConnection(remotePublicKeyBase64: string, offer: RTCSessionDescriptionInit, offerPcId: string, offerIat: number, earlyCandidates: TaggedCandidate[] = []): Promise<void> {
    const connection = this.createPeerConnection(remotePublicKeyBase64, false);
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now());
    const peer: PeerInfo = {
      publicKeyBase64: remotePublicKeyBase64,
      connection,
      dataChannel: null,
      connectionState: PeerConnectionState.CONNECTING,
      dataChannelState: DataChannelState.CONNECTING,
      isInitiator: false,
      pendingCandidates: [],
      candidateFlushTimer: null,
      incomingCandidates: [...earlyCandidates],   // setRemoteDescription 後由 flushIncomingCandidates 補加
      lastDcInboundAt: Date.now(),
      hbCapable: false,
      localPcId: newPcId(),
      remotePcId: offerPcId,   // 記住對端 PC 世代 → 它下次換 PC 時我方認得出來
      remotePcIat: offerIat,
      fp: this.makeFingerprintCheck(remotePublicKeyBase64, connection),
      verified: false,
      heldInbound: [],
      heldInboundBytes: 0,
    };
    this.peers.set(remotePublicKeyBase64, peer);

    try {
      await connection.setRemoteDescription(new RTCSessionDescription(offer));
      await this.flushIncomingCandidates(remotePublicKeyBase64);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (this.peers.get(remotePublicKeyBase64) !== peer) return;
      this.sendDcSignal(remotePublicKeyBase64, 'answer', { pc: peer.localPcId, rpc: offerPcId, data: { type: 'answer', sdp: answer.sdp ?? '' } });
      diagLog('[DIAG:WebRTC] Sent answer to:', remotePublicKeyBase64.slice(0, 16));
    } catch (error) {
      console.error('[WebRTC] Failed to handle offer:', error);
      if (this.peers.get(remotePublicKeyBase64) === peer) this.closePeer(remotePublicKeyBase64);
    }
  }

  /**
   * 處理收到的 Answer：一定要是回我現在這條 PC 的那一則 offer（rpc ＝ 我的 localPcId），而且我正在等 answer（have-local-offer）
   */
  private async handleAnswer(msg: DcSignal): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: msg.data.sdp as string };

    diagLog('[DIAG:WebRTC] Received answer from:', remotePublicKeyBase64.slice(0, 16));

    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) {
      devWarn(`[WebRTC] No pending connection for ${remotePublicKeyBase64.slice(0, 8)}...`);
      return;
    }
    if (msg.rpc !== peer.localPcId) {
      this.count('answer-other-generation');
      diagLog('[DIAG:WebRTC] IGNORING answer for another PC generation:', remotePublicKeyBase64.slice(0, 16));
      return;
    }

    // 檢查 signaling state - 只有在 have-local-offer 狀態才能接收 answer
    // 如果已經是 stable 狀態，表示連線已經建立或被其他 offer 取代
    if (peer.connection.signalingState !== 'have-local-offer') {
      // ⚠️ 卡 new 嫌疑點：glare 讓位重建後 peer 變 responder（非 have-local-offer），此時對端
      //   針對「我方原 offer」回的 answer 會被丟掉 → 若新連線又沒走完 → 兩邊都沒連起 → 卡 new。
      this.count('answer-wrong-state');
      diagLog('[DIAG:WebRTC] IGNORING answer - wrong signalingState:', peer.connection.signalingState, 'peer:', remotePublicKeyBase64.slice(0, 16), `isInit=${peer.isInitiator} conn=${peer.connectionState}`);
      return;
    }

    // 原地重開（reopenDataChannelInPlace）的 answer 一定來自對方同一條 PC。換了一條（對方重建了）→ 對方的 DTLS 憑證換了，
    //   這條 PC 驗過的指紋不再代表對方：拆掉，由健康檢查重新連（審查 L2：以前收下、DTLS 重新握手，verified 卻還是 true）
    if (peer.remotePcId && msg.pc !== peer.remotePcId) {
      this.count('answer-new-generation');
      diagLog('[DIAG:WebRTC] answer from a different PC generation on a live PC → teardown:', remotePublicKeyBase64.slice(0, 16));
      this.closePeer(remotePublicKeyBase64);
      return;
    }

    // 對方那一條 PC（之後它的 ICE、指紋都要對這一條）—— 在 await 之前記下：同一個人的下一則（ICE）可能在等的時候就到
    peer.remotePcId = msg.pc;
    peer.remotePcIat = msg.iat;
    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      // remoteDescription 已 set → 補加先前因「還沒 set」而 buffer 的早到 candidate
      await this.flushIncomingCandidates(remotePublicKeyBase64);
    } catch (error) {
      console.error('[WebRTC] Failed to set remote description:', error);
      if (this.peers.get(remotePublicKeyBase64) === peer) this.closePeer(remotePublicKeyBase64);
    }
  }

  /**
   * 處理收到的 ICE Candidate：只給對方「目前那一條 PC」的（還不知道是哪一條 —— 等 answer 中 —— 先收著）
   */
  private async handleIceCandidate(msg: DcSignal): Promise<void> {
    await this.addRemoteCandidate(msg.from, { candidate: msg.data as RTCIceCandidateInit, pc: msg.pc });
  }

  private async addRemoteCandidate(remotePublicKeyBase64: string, tagged: TaggedCandidate): Promise<void> {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) {
      // offer 還在等閘門（冷啟動等好友清單）→ 先收著，建連線時一起補加（上限防灌）
      const waiting = this.gateWaitCandidates.get(remotePublicKeyBase64);
      if (waiting && waiting.length < 50) {
        waiting.push(tagged);
        return;
      }
      // offer 還收著（對方還不認得，見 heldOffers）→ ICE 跟著收，offer 放行後補上
      const held = this.heldOffers.get(remotePublicKeyBase64);
      if (held) {
        if (held.ice.length < WebRTCService.HELD_OFFER_MAX_ICE) held.ice.push(tagged);
        return;
      }
      diagLog('[DIAG:WebRTC] ICE candidate but no peer for:', remotePublicKeyBase64.slice(0, 16));
      return;
    }

    // 別的世代的 PC 的 ICE（重放、晚到、對方已經換了一條）→ 不給這一條
    if (peer.remotePcId && tagged.pc !== peer.remotePcId) {
      this.count('ice-other-generation');
      return;
    }

    // remoteDescription 還沒 set（或還不知道對方是哪一條 PC）→ addIceCandidate 會 throw「remote description was null」
    // 而把 candidate 丟掉（trickle-ICE race：candidate 經 MQTT 早於 offer/answer 到達）。
    // 改成先 buffer，等 setRemoteDescription(offer/answer) 後由 flushIncomingCandidates 補加。
    if (!peer.connection.remoteDescription || !peer.remotePcId) {
      if (peer.incomingCandidates.length < 64) peer.incomingCandidates.push(tagged);
      diagLog('[DIAG:WebRTC] ICE buffered (no remoteDescription yet):',
        remotePublicKeyBase64.slice(0, 12), `pending=${peer.incomingCandidates.length}`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(tagged.candidate));
      diagLog('[DIAG:WebRTC] ICE candidate added from:', remotePublicKeyBase64.slice(0, 16), 'type:', tagged.candidate.candidate?.split(' ')[7] || 'unknown');
    } catch (error) {
      diagLog('[DIAG:WebRTC] ICE candidate FAILED:', (error as Error)?.message);
    }
  }

  /**
   * setRemoteDescription 之後呼叫：把先前因 remoteDescription 未就緒而 buffer 的
   * 早到 candidate 一次補加（只補對方目前那一條 PC 的）。清空 buffer，之後到的 candidate 走正常 addIceCandidate 路徑。
   */
  private async flushIncomingCandidates(remotePublicKeyBase64: string): Promise<void> {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.incomingCandidates.length === 0) return;
    const buffered = peer.incomingCandidates;
    peer.incomingCandidates = [];
    diagLog('[DIAG:WebRTC] flushing buffered ICE:', String(buffered.length),
      'for', remotePublicKeyBase64.slice(0, 12));
    for (const c of buffered) {
      if (peer.remotePcId && c.pc !== peer.remotePcId) continue;
      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(c.candidate));
      } catch (error) {
        diagLog('[DIAG:WebRTC] buffered ICE add FAILED:', (error as Error)?.message);
      }
    }
  }

  /**
   * E2E 測試用：強制關閉指定 peer（或全部），模擬 DataChannel 中斷
   * - 呼叫 closePeer 內部方法做真實清理
   * - T27 測試用：驗證 p2pSend queue + 重連後 flush
   */
  public forceClosePeerForE2E(remotePublicKeyBase64?: string): number {
    if (remotePublicKeyBase64) {
      const existed = this.peers.has(remotePublicKeyBase64);
      if (existed) this.closePeer(remotePublicKeyBase64);
      return existed ? 1 : 0;
    }
    // 無參數 → 關閉所有
    const count = this.peers.size;
    const keys = Array.from(this.peers.keys());
    keys.forEach((k) => this.closePeer(k));
    return count;
  }

  /**
   * E2E 測試用：回傳指定 peer 的 DataChannel readyState
   * - 無 peer → 'none'
   * - peer 存在但無 dataChannel → 'no-channel'
   * - peer 存在且有 dataChannel → 'connecting' | 'open' | 'closing' | 'closed'
   */
  public getPeerStateForE2E(remotePublicKeyBase64: string): string {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return 'none';
    if (!peer.dataChannel) return 'no-channel';
    return peer.dataChannel.readyState;
  }

  /**
   * 關閉 Peer 連線
   */
  private closePeer(remotePublicKeyBase64: string): void {
    this.connectAttemptAt.delete(remotePublicKeyBase64);
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.fp.stop();
      peer.heldInbound = [];
      peer.heldInboundBytes = 0;
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(remotePublicKeyBase64);
      this.updatePeerState(remotePublicKeyBase64, PeerConnectionState.CLOSED);
      devLog(`[WebRTC] Closed connection with ${remotePublicKeyBase64.slice(0, 8)}...`);
    }
  }

  /**
   * 更新 Peer 連線狀態
   */
  private updatePeerState(remotePublicKeyBase64: string, state: PeerConnectionState): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.connectionState = state;
    }
    this.stateListeners.forEach((callback) => callback(remotePublicKeyBase64, state));
  }

  /**
   * 短暫斷線後 ICE 自己恢復（對應群星 B34）：DataChannel 一直是 open，**不會再有 open 事件** → onPeerConnected 不會跑，
   * 斷線那段時間排進 outbox 的訊息（那時 isDataChannelOpen 回 false）就一直卡著，之後直送的訊息還會插隊到它們前面。
   * 恢復時補發一次 OPEN，讓它跟新連上一樣去 flush outbox、補送檔案。
   * ICE 與連線狀態兩個事件都會走到這裡（瀏覽器通常先發 iceconnectionstatechange，那時 connectionState 可能還是
   * disconnected）：記下「斷過」，等這條 PC 的 connectionState 真的回到 connected 才補發，只發一次。
   * 群星只在 connectionstatechange 比對前一個狀態 —— 但 ICE 事件已經先把狀態改成 connected，比不出「剛恢復」。
   */
  private trackIceRecovery(remotePublicKeyBase64: string, connection: RTCPeerConnection, state: PeerConnectionState): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.connection !== connection) return;      // 已經換了一條 PC（舊 PC 的晚到事件）
    if (state === PeerConnectionState.DISCONNECTED) {
      peer.iceInterrupted = true;
      return;
    }
    if (state !== PeerConnectionState.CONNECTED || !peer.iceInterrupted || connection.connectionState !== 'connected') return;
    peer.iceInterrupted = false;
    if (peer.dataChannel?.readyState !== 'open') return;    // 通道也斷了：重開時 onopen 自己會發 OPEN
    if (!peer.verified) return;                             // 指紋還沒對過：對上時 onPeerVerified 才發 OPEN
    diagLog(`[DIAG:WebRTC] ICE recovered with channel still open → re-announce OPEN for ${remotePublicKeyBase64.slice(0, 16)}`);
    this.updateDataChannelState(remotePublicKeyBase64, DataChannelState.OPEN);
  }

  /**
   * 更新資料通道狀態
   */
  private updateDataChannelState(remotePublicKeyBase64: string, state: DataChannelState): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.dataChannelState = state;
    }
    this.dataChannelStateListeners.forEach((callback) => callback(remotePublicKeyBase64, state));
  }

  /**
   * 暫存 ICE Candidate 以便 IPv6 優先排序
   */
  private queueCandidate(remotePublicKeyBase64: string, candidate: RTCIceCandidate): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return;

    peer.pendingCandidates.push(candidate);

    // 清除舊的計時器
    if (peer.candidateFlushTimer) {
      clearTimeout(peer.candidateFlushTimer);
    }

    // 設定新的計時器，100ms 後發送（等待收集更多 candidates）
    peer.candidateFlushTimer = setTimeout(() => {
      this.flushCandidates(remotePublicKeyBase64);
    }, 100);
  }

  /**
   * 排序並發送所有暫存的 ICE Candidates
   * 優先順序：IPv6 host > IPv4 host > IPv6 srflx > IPv4 srflx > prflx
   */
  private flushCandidates(remotePublicKeyBase64: string): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.pendingCandidates.length === 0) return;

    // 清除計時器
    if (peer.candidateFlushTimer) {
      clearTimeout(peer.candidateFlushTimer);
      peer.candidateFlushTimer = null;
    }

    // 排序 candidates：IPv6 優先
    const sortedCandidates = [...peer.pendingCandidates].sort((a, b) => {
      const scoreA = this.getCandidatePriority(a);
      const scoreB = this.getCandidatePriority(b);
      return scoreB - scoreA; // 高分優先
    });

    // 記錄排序結果
    devLog(`[WebRTC] IPv6-first: 發送 ${sortedCandidates.length} 個 candidates`);
    sortedCandidates.forEach((c, i) => {
      const isIPv6 = c.address?.includes(':');
      devLog(`  ${i + 1}. ${isIPv6 ? '🟢 IPv6' : '🟡 IPv4'} ${c.type} ${c.address}:${c.port}`);
    });

    // 按排序順序發送
    sortedCandidates.forEach((candidate) => {
      this.sendIce(remotePublicKeyBase64, candidate);
    });

    // 清空暫存
    peer.pendingCandidates = [];
  }

  /**
   * 計算 ICE Candidate 優先分數
   * 分數越高越優先
   */
  private getCandidatePriority(candidate: RTCIceCandidate): number {
    let score = 0;
    const isIPv6 = candidate.address?.includes(':');
    const type = candidate.type;

    // IPv6 加 1000 分
    if (isIPv6) score += 1000;

    // 類型分數
    switch (type) {
      case 'host':  // 直連最優先
        score += 100;
        break;
      case 'srflx': // STUN 反射次之
        score += 50;
        break;
      case 'prflx': // Peer 反射
        score += 25;
        break;
      case 'relay': // TURN 中繼最低（已移除，但保留邏輯）
        score += 0;
        break;
    }

    return score;
  }

  /**
   * 映射 ICE 連線狀態
   */
  private mapIceConnectionState(state: RTCIceConnectionState): PeerConnectionState {
    switch (state) {
      case 'new':
        return PeerConnectionState.NEW;
      case 'checking':
        return PeerConnectionState.CONNECTING;
      case 'connected':
      case 'completed':
        return PeerConnectionState.CONNECTED;
      case 'disconnected':
        return PeerConnectionState.DISCONNECTED;
      case 'failed':
        return PeerConnectionState.FAILED;
      case 'closed':
        return PeerConnectionState.CLOSED;
      default:
        return PeerConnectionState.NEW;
    }
  }

  /**
   * 映射連線狀態
   */
  private mapConnectionState(state: RTCPeerConnectionState): PeerConnectionState {
    switch (state) {
      case 'new':
        return PeerConnectionState.NEW;
      case 'connecting':
        return PeerConnectionState.CONNECTING;
      case 'connected':
        return PeerConnectionState.CONNECTED;
      case 'disconnected':
        return PeerConnectionState.DISCONNECTED;
      case 'failed':
        return PeerConnectionState.FAILED;
      case 'closed':
        return PeerConnectionState.CLOSED;
      default:
        return PeerConnectionState.NEW;
    }
  }

  /**
   * 記錄連線類型（用於監控 P2P 連線品質）
   * - host: IPv4/IPv6 直連（最佳）
   * - srflx: STUN 反射（NAT 打洞）
   * - prflx: Peer 反射
   * - relay: TURN 中繼（最後手段）
   */
  private async logConnectionType(connection: RTCPeerConnection, peerKey: string): Promise<void> {
    try {
      const stats = await connection.getStats();
      let candidateType = 'unknown';
      let localAddress = '';
      let remoteAddress = '';

      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localId = report.localCandidateId;
          const remoteId = report.remoteCandidateId;

          stats.forEach((candidate) => {
            if (candidate.id === localId) {
              candidateType = candidate.candidateType || 'unknown';
              localAddress = `${candidate.address}:${candidate.port}`;
            }
            if (candidate.id === remoteId) {
              remoteAddress = `${candidate.address}:${candidate.port}`;
            }
          });
        }
      });

      // 判斷是否為 IPv6
      const isIPv6 = localAddress.includes(':') && !localAddress.startsWith('[');
      const ipVersion = isIPv6 ? 'IPv6' : 'IPv4';

      // 根據連線類型顯示不同的標記
      const typeLabel = {
        host: `🟢 ${ipVersion} 直連`,
        srflx: `🟡 ${ipVersion} STUN`,
        prflx: `🟡 ${ipVersion} Peer反射`,
        relay: '🔴 TURN中繼',
        unknown: '⚪ 未知',
      }[candidateType] || '⚪ 未知';

      devLog(
        `[WebRTC] ${typeLabel} | ${peerKey.slice(0, 8)}... | ${localAddress} ↔ ${remoteAddress}`
      );

      // 如果使用 TURN relay → 立即斷開（訊息內容不可經過伺服器）
      if (candidateType === 'relay') {
        console.error('[WebRTC] ❌ TURN relay detected — disconnecting (privacy violation)');
        this.disconnect(peerKey);
        return;
      }

      // 如果成功使用 IPv6 直連，慶祝一下
      if (candidateType === 'host' && isIPv6) {
        devLog('[WebRTC] 🎉 成功使用 IPv6 直連！最佳連線品質');
      }
    } catch (error) {
      console.error('[WebRTC] Failed to get connection stats:', error);
    }
  }
}

// 單例導出
export const webrtcService = new WebRTCService();

export default webrtcService;

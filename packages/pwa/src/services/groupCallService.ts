/**
 * GroupCallService - 多人群組通話服務
 *
 * Phase 10: 實現 WebRTC Full Mesh 多人通話
 *
 * 架構：
 * - Full Mesh: N 個參與者需要 N*(N-1)/2 個 PeerConnection
 * - 每個參與者維護 Map<peerId, PeerInfo>
 * - 最大支援 8 人（GROUP_CONSTANTS.MAX_MEMBERS）
 * 信令（W2，docs/GROUP_LOG_WIRING_W2.md）：
 * - start／join／leave／end：群組主題上的 group_sealed 控制訊息 call { action, video }（目前這一代金鑰加密、寄件人簽章；
 *   群組引擎驗過寄件人是套上的名冊上的成員、新鮮、沒重複才交給 handleControl）。群名不送，收端用本機名冊的
 * - offer／answer／ICE：封給對方身分金鑰的信封（GROUP_KEY_SEALED kind call，即時、不排隊；handleSignal）。
 *   以前七種明文型別（group_call_*）經 broker 可讀、可偽造，都拿掉了
 * DTLS 指紋（開源第 5d 步，移植 1 對 1 的 dtlsFingerprint；docs/DIRECT_SEALED.md §4「Group calls」）：
 * - 每條 PeerConnection 的 ICE 連上之後，兩邊經同一條封好的信令（signal 'fp'）交換「我的／我看到的對方」憑證指紋；
 *   對得上才算這位參與者接通 —— 在那之前送給他的麥克風／鏡頭是關著的複本（每條 PC 各一份 track.clone()，enabled = false）、
 *   他的聲音與影像不交給畫面
 * - 對不上、30 秒內驗不了、讀不到指紋 → 拆掉那一條 PC（其他參與者照常）、跟使用者說（aegis:mqtt-notice kind group-call-unverified）
 */

import { GROUP_CONSTANTS } from '../types';
import { getIceServers } from './iceServers';
import { devLog, devWarn } from '../utils/devLog';
import { useGroupStore } from '../stores/groupStore';
import { isBlacklisted } from './localBlacklist';
import { getGroupEngine } from './groupEngineHost';
import { sendGroupSealed } from './groupKeyDelivery';
import {
  createFingerprintCheck, fingerprintsFromSdp, readFingerprints, type DtlsFingerprints, type FingerprintCheck, type FingerprintFailure,
} from './dtlsFingerprint';

// 群組通話狀態
export enum GroupCallState {
  IDLE = 'idle',                   // 閒置
  STARTING = 'starting',           // 發起中
  JOINING = 'joining',             // 加入中
  CONNECTED = 'connected',         // 通話中
  ENDED = 'ended',                 // 已結束
}

// 參與者資訊
export interface Participant {
  peerId: string;                  // 參與者公鑰
  peerName?: string;               // 顯示名稱
  connection: RTCPeerConnection | null;
  remoteStream: MediaStream | null;
  isConnected: boolean;
  isMuted: boolean;
  isVideoEnabled: boolean;
  joinedAt: number;
}

// 群組通話資訊
export interface GroupCallInfo {
  groupId: string;
  groupName?: string;
  state: GroupCallState;
  isVideoCall: boolean;
  participants: Map<string, Participant>;
  startTime?: number;
  duration?: number;
  localMuted: boolean;
  localVideoEnabled: boolean;
}

// 回調類型
type GroupCallStateCallback = (state: GroupCallState, info?: GroupCallInfo) => void;
type ParticipantCallback = (peerId: string, participant: Participant) => void;
type IncomingGroupCallCallback = (groupId: string, groupName: string, initiatorId: string, isVideoCall: boolean) => void;

type CallAction = 'start' | 'join' | 'leave' | 'end';
type CallSignal = 'offer' | 'answer' | 'ice' | 'fp';
const SIGNALS: readonly CallSignal[] = ['offer', 'answer', 'ice', 'fp'];
/** 一條 PC 的指紋多久沒驗過就拆掉（同 1 對 1） */
const GROUP_FP_TIMEOUT_MS = 30_000;

/**
 * 一條 PeerConnection 的指紋核對與媒體閘門（開源第 5d 步）：驗過之前送出去的是關著的複本、收到的串流先收著
 */
interface PeerGate {
  connection: RTCPeerConnection;
  check: FingerprintCheck;
  verified: boolean;
  iceConnected: boolean;
  /** 送給這一條 PC 的本機 track 複本（kind 照原本的） */
  clones: MediaStreamTrack[];
  /** 對方的串流：驗過才交給畫面（participant.remoteStream） */
  heldStream: MediaStream | null;
  /** 驗過的對方憑證指紋（之後對方再送 offer 重新協商時，SDP 裡的指紋要還是這些） */
  verifiedRemote: string[];
}
/** 封給身分金鑰的信令：封裝時間（iat）超過這麼久就不理（對方早就放棄那次連線了）；比現在晚太多也不理 */
const SIGNAL_MAX_AGE_MS = 2 * 60_000;
const SIGNAL_MAX_FUTURE_MS = 5 * 60_000;
const MAX_SIGNAL_JSON = 32 * 1024;
/** 看過的信令（寄件人|信封 nonce → 到期時間）：同一封重放不再處理（審查 W2 #3）；上限 */
const MAX_SEEN_SIGNALS = 2048;

/**
 * 群組通話服務
 */
class GroupCallService {
  public localPublicKey: string | null = null;
  private localStream: MediaStream | null = null;

  // 當前群組通話
  private currentCall: GroupCallInfo | null = null;
  private callTimer: NodeJS.Timeout | null = null;

  // 參與者連線 Map
  private participants: Map<string, Participant> = new Map();

  // 待處理的 ICE candidates（在 connection 建立前收到的）
  private pendingIceCandidates: Map<string, RTCIceCandidateInit[]> = new Map();

  private seenSignals: Map<string, number> = new Map();

  /** 每位參與者那一條 PC 的指紋核對與媒體閘門（開源第 5d 步） */
  private peerGates: Map<string, PeerGate> = new Map();
  /** 計數（模擬與測試看：指紋驗過／失敗） */
  private counters: Record<string, number> = {};

  // 事件監聽器
  private stateListeners: Set<GroupCallStateCallback> = new Set();
  private participantListeners: Set<ParticipantCallback> = new Set();
  private incomingCallListeners: Set<IncomingGroupCallCallback> = new Set();

  /**
   * 初始化服務（收訊由 AppProvider 轉進來：群組引擎驗過的 call 控制訊息 → handleControl；拆開的通話信令 → handleSignal）
   */
  initialize(localPublicKeyBase64: string): void {
    this.localPublicKey = localPublicKeyBase64;
    devLog('[GroupCall] Service initialized');
  }

  /**
   * 關閉服務
   */
  shutdown(): void {
    this.endCall();
    this.localPublicKey = null;
    devLog('[GroupCall] Service shut down');
  }

  /** 群組主題上的 call 控制訊息（只用目前這一代金鑰送；等 admin 換金鑰時引擎先留著，換完才送） */
  private broadcast(groupId: string, action: CallAction, video: boolean): void {
    const engine = getGroupEngine();
    if (!engine) {
      console.error(`[GroupCall] ${action}: group engine not running — not sent`);
      return;
    }
    engine.sendControl(groupId, 'call', { action, video })
      .then((r) => { if (r !== 'sent') console.error(`[GroupCall] ${action} ${r} (waiting for the group key)`); })
      .catch((err) => console.error(`[GroupCall] ${action} failed:`, err));
  }

  /** offer／answer／ICE：封給對方的身分金鑰，連著才送 */
  private signal(peerId: string, groupId: string, kind: CallSignal, data: unknown): void {
    sendGroupSealed(peerId, { kind: 'call', gid: groupId, signal: kind, data }, { transient: true })
      .then((sent) => { if (!sent) devWarn(`[GroupCall] ${kind} to ${peerId.slice(0, 8)} not sent (offline)`); })
      .catch((err) => console.error(`[GroupCall] ${kind} to ${peerId.slice(0, 8)} failed:`, err));
  }

  /**
   * 發起群組通話
   * @param groupId 群組 ID
   * @param groupName 群組名稱
   * @param memberPublicKeys 群組成員公鑰列表
   * @param withVideo 是否開啟視訊
   */
  async startGroupCall(
    groupId: string,
    groupName: string,
    memberPublicKeys: string[],
    withVideo: boolean = false
  ): Promise<void> {
    if (!this.localPublicKey) {
      throw new Error('GroupCall service not initialized');
    }

    if (this.currentCall && this.currentCall.state !== GroupCallState.IDLE) {
      throw new Error('Already in a group call');
    }

    // 檢查通話人數限制（ADR-016: 語音/視訊 8 人硬上限）
    if (memberPublicKeys.length + 1 > GROUP_CONSTANTS.MAX_CALL_MEMBERS) {
      throw new Error(`群組通話最多支援 ${GROUP_CONSTANTS.MAX_CALL_MEMBERS} 人`);
    }

    devLog(`[GroupCall] Starting ${withVideo ? 'video' : 'voice'} call in group ${groupId}`);

    // 初始化通話狀態
    this.currentCall = {
      groupId,
      groupName,
      state: GroupCallState.STARTING,
      isVideoCall: withVideo,
      participants: new Map(),
      startTime: Date.now(),
      localMuted: false,
      localVideoEnabled: withVideo,
    };
    this.notifyStateChange();

    // 取得本地媒體串流
    await this.setupLocalStream(withVideo);

    // 廣播通話開始（群名不送：收端用本機名冊的）
    this.broadcast(groupId, 'start', withVideo);

    // 更新狀態為連線中
    this.currentCall.state = GroupCallState.CONNECTED;
    this.notifyStateChange();

    // 開始計時
    this.startCallTimer();

    devLog(`[GroupCall] Call started, waiting for participants...`);
  }

  /**
   * 加入群組通話
   * @param groupId 群組 ID
   * @param withVideo 是否開啟視訊
   */
  async joinGroupCall(groupId: string, withVideo: boolean = false): Promise<void> {
    if (!this.localPublicKey) {
      throw new Error('GroupCall service not initialized');
    }

    if (this.currentCall && this.currentCall.state !== GroupCallState.IDLE) {
      throw new Error('Already in a group call');
    }

    devLog(`[GroupCall] Joining call in group ${groupId}`);

    // 初始化通話狀態
    this.currentCall = {
      groupId,
      state: GroupCallState.JOINING,
      isVideoCall: withVideo,
      participants: new Map(),
      startTime: Date.now(),
      localMuted: false,
      localVideoEnabled: withVideo,
    };
    this.notifyStateChange();

    // 取得本地媒體串流
    await this.setupLocalStream(withVideo);

    // 廣播加入
    this.broadcast(groupId, 'join', withVideo);

    // 更新狀態為連線中
    this.currentCall.state = GroupCallState.CONNECTED;
    this.notifyStateChange();

    // 開始計時
    this.startCallTimer();
  }

  /**
   * 離開群組通話
   */
  leaveCall(): void {
    if (!this.currentCall || !this.localPublicKey) {
      return;
    }

    devLog('[GroupCall] Leaving call');

    // 廣播離開
    this.broadcast(this.currentCall.groupId, 'leave', false);

    this.cleanupCall();
  }

  /**
   * 結束整個群組通話（僅發起人可用）
   */
  endCall(): void {
    if (!this.currentCall || !this.localPublicKey) {
      return;
    }

    devLog('[GroupCall] Ending call');

    // 廣播結束
    this.broadcast(this.currentCall.groupId, 'end', false);

    this.cleanupCall();
  }

  /**
   * 切換靜音
   */
  toggleMute(): boolean {
    if (!this.localStream || !this.currentCall) {
      return false;
    }

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.currentCall.localMuted = !audioTrack.enabled;
      this.applyAllGates();   // 送給每位參與者的複本（驗過指紋的才開）
      this.notifyStateChange();
      devLog(`[GroupCall] Mute: ${this.currentCall.localMuted}`);
    }

    return this.currentCall.localMuted;
  }

  /**
   * 切換視訊
   */
  toggleVideo(): boolean {
    if (!this.localStream || !this.currentCall || !this.currentCall.isVideoCall) {
      return false;
    }

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.currentCall.localVideoEnabled = videoTrack.enabled;
      this.applyAllGates();
      this.notifyStateChange();
      devLog(`[GroupCall] Video: ${this.currentCall.localVideoEnabled}`);
    }

    return this.currentCall.localVideoEnabled;
  }

  /**
   * 取得當前通話資訊
   */
  getCurrentCall(): GroupCallInfo | null {
    return this.currentCall;
  }

  /**
   * 取得本地媒體串流
   */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /**
   * 取得參與者的遠端串流
   */
  getParticipantStream(peerId: string): MediaStream | null {
    return this.participants.get(peerId)?.remoteStream || null;
  }

  /**
   * 取得所有參與者
   */
  getParticipants(): Map<string, Participant> {
    return new Map(this.participants);
  }

  /**
   * 監聽通話狀態變化
   */
  onStateChange(callback: GroupCallStateCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * 監聽參與者變化
   */
  onParticipantChange(callback: ParticipantCallback): () => void {
    this.participantListeners.add(callback);
    return () => this.participantListeners.delete(callback);
  }

  /**
   * 監聯來電（群組通話邀請）
   */
  onIncomingCall(callback: IncomingGroupCallCallback): () => void {
    this.incomingCallListeners.add(callback);
    return () => this.incomingCallListeners.delete(callback);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * 設定本地媒體串流
   */
  private async setupLocalStream(withVideo: boolean): Promise<void> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: withVideo ? {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
        } : false,
      });
      devLog(`[GroupCall] Local ${withVideo ? 'video' : 'audio'} stream acquired`);
    } catch (error) {
      console.error('[GroupCall] Failed to get user media:', error);
      throw error;
    }
  }

  /**
   * 建立與參與者的 PeerConnection
   */
  private createPeerConnection(peerId: string): RTCPeerConnection {
    const connection = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });
    // 這條 PC 的 DTLS 指紋核對（ICE 連上才 start；之前收到對方的先收著）與媒體閘門
    this.attachGate(peerId, connection);

    // ICE Candidate 事件
    connection.onicecandidate = (event) => {
      if (event.candidate && this.currentCall) {
        devLog(`[GroupCall] Local ICE candidate for ${peerId.slice(0, 8)}: type=${event.candidate.type}`);
        // 封給這個參與者
        this.signal(peerId, this.currentCall.groupId, 'ice', event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
      }
    };

    // ICE 連線狀態變化
    connection.oniceconnectionstatechange = () => {
      devLog(`[GroupCall] ICE state for ${peerId.slice(0, 8)}: ${connection.iceConnectionState}`);

      const gate = this.peerGates.get(peerId);
      if (!gate || gate.connection !== connection) return;
      const participant = this.participants.get(peerId);
      if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
        gate.iceConnected = true;
        // 接通要等 DTLS 指紋兩邊對過（onPeerVerified）；以前 ICE 一連上就算接通
        gate.check.start();
        if (participant && gate.verified && !participant.isConnected) {
          participant.isConnected = true;
          this.notifyParticipantChange(peerId, participant);
        }
      } else if (connection.iceConnectionState === 'failed' || connection.iceConnectionState === 'disconnected') {
        gate.iceConnected = false;
        if (participant) {
          participant.isConnected = false;
          this.notifyParticipantChange(peerId, participant);
        }
      }
    };

    // 接收遠端音軌：指紋驗過之前先收著（不播、不交給畫面）
    connection.ontrack = (event) => {
      devLog(`[GroupCall] Received remote track from ${peerId.slice(0, 8)}`);
      const gate = this.peerGates.get(peerId);
      if (!gate || gate.connection !== connection) return;
      gate.heldStream = event.streams[0] ?? gate.heldStream;
      this.applyGate(peerId);
    };

    return connection;
  }

  /**
   * 與新參與者建立連線（作為發起方）
   */
  private async connectToParticipant(peerId: string, peerName?: string): Promise<void> {
    if (!this.localPublicKey || !this.localStream || !this.currentCall) {
      return;
    }

    // 避免自我連線
    if (peerId === this.localPublicKey) {
      return;
    }

    // 檢查是否已有連線
    if (this.participants.has(peerId)) {
      devLog(`[GroupCall] Already connected to ${peerId.slice(0, 8)}`);
      return;
    }

    devLog(`[GroupCall] Connecting to participant ${peerId.slice(0, 8)}...`);

    // 建立參與者記錄
    const participant: Participant = {
      peerId,
      peerName,
      connection: null,
      remoteStream: null,
      isConnected: false,
      isMuted: false,
      isVideoEnabled: this.currentCall.isVideoCall,
      joinedAt: Date.now(),
    };
    this.participants.set(peerId, participant);
    this.currentCall.participants.set(peerId, participant);

    // 建立 PeerConnection
    const connection = this.createPeerConnection(peerId);
    participant.connection = connection;

    // 添加本地音軌（這條 PC 專用的複本，指紋驗過之前 enabled = false）
    this.addGatedTracks(peerId, connection);

    // 處理待處理的 ICE candidates
    const pendingCandidates = this.pendingIceCandidates.get(peerId);
    if (pendingCandidates) {
      for (const candidate of pendingCandidates) {
        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      }
      this.pendingIceCandidates.delete(peerId);
    }

    // 誰發起 offer：回應 join 的這一方（已經在通話裡的人）一律發起。以前只有公鑰字典序較大的一方發起 —— 加入的人公鑰較大時
    //   兩邊都在等對方的 offer，那一對永遠接不起來（加入的人不會收到先來的人的 join；開源第 5d 步模擬 G1 抓到）。
    //   兩邊同時發起（幾乎同時加入、互相收到 join）由 onOffer 照公鑰字典序讓步（glare）
    devLog(`[GroupCall] Creating offer for ${peerId.slice(0, 8)}`);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (!this.currentCall || participant.connection !== connection) return;   // 等的時候通話結束、或這條 PC 換掉了
    this.signal(peerId, this.currentCall.groupId, 'offer', { type: offer.type, sdp: offer.sdp });

    this.notifyParticipantChange(peerId, participant);
  }

  /**
   * 發話者一律是驗過的寄件人（control：群組引擎驗過內層簽章、主題後綴；signal：身分信封的簽章），不用內容自稱的 id；
   * 而且必須是本機名冊（套上的狀態鏈）上這個群的成員（對應群星 P2-10）。以前任何人在群組主題發明文的 GROUP_CALL_START
   * 就能偽造「X 發起群組通話」，發 OFFER 就能加入媒體。
   */
  private isMember(groupId: string, pk: string): boolean {
    const group = useGroupStore.getState().getGroupById(groupId);
    if (group && group.members.some((m) => m.publicKey === pk)) return true;
    devWarn(`[GroupCall] call message from a non-member of ${groupId.slice(0, 12)} — ignored`);
    return false;
  }

  /** 群組引擎交過來的 call 控制訊息（已驗：寄件人是成員、目前這一代、新鮮、沒重複） */
  handleControl(groupId: string, from: string, body: Record<string, unknown>): void {
    if (!this.localPublicKey || from === this.localPublicKey || !this.isMember(groupId, from)) return;
    const video = body.video === true;
    switch (body.action) {
      case 'start':
        this.onStart(groupId, from, video).catch((err) => console.error('[GroupCall] start handling failed:', err));
        return;
      case 'join':
        this.onJoin(groupId, from);
        return;
      case 'leave':
        this.onLeave(groupId, from);
        return;
      case 'end':
        this.onEnd(groupId, from);
    }
  }

  /**
   * 拆開的通話信令（GROUP_KEY_SEALED kind call：{ gid, signal: offer|answer|ice, data, iat, nonce }）。
   * 寄件人由信封的簽章證明；這裡再看他是不是那個群的成員、是不是我目前這通電話、信令是不是新鮮的、這封有沒有看過。
   * now：App 給 mqttService.boundedNow（W5：API 的時鐘差最多採信 ±5 分鐘 —— 營運方回假的 serverTime 撥不動錄下來的信令；
   * 封的那一端用 serverNow 填 iat，審查 W2 #1：兩支手機的時鐘差兩分鐘就全部被當成過期。手機自己差超過 5 分鐘的人收不到，mqtt 會提示校正）
   */
  handleSignal(from: string, body: Record<string, unknown>, now: number = Date.now()): void {
    const { gid, signal, data, iat, nonce } = body;
    if (typeof gid !== 'string' || gid.length > 64 || !SIGNALS.includes(signal as CallSignal) || !data || typeof data !== 'object') return;
    if (typeof iat !== 'number' || now - iat > SIGNAL_MAX_AGE_MS || iat - now > SIGNAL_MAX_FUTURE_MS) {
      devWarn(`[GroupCall] stale ${String(signal)} from ${from.slice(0, 8)} — ignored`);
      return;
    }
    if (JSON.stringify(data).length > MAX_SIGNAL_JSON) return;
    if (!this.localPublicKey || from === this.localPublicKey || !this.isMember(gid, from)) return;
    // 先記下這一封（就算現在不是我在通話的群也記：之後加入那通電話時，重放進來的舊信令照樣擋掉）
    if (typeof nonce !== 'string' || !this.firstSeen(`${from}|${nonce}`, iat + SIGNAL_MAX_AGE_MS + SIGNAL_MAX_FUTURE_MS, now)) {
      devWarn(`[GroupCall] replayed ${String(signal)} from ${from.slice(0, 8)} — ignored`);
      return;
    }
    if (!this.currentCall || this.currentCall.groupId !== gid) return;
    // 對方的 DTLS 指紋（開源第 5d 步）：交給他那一條 PC 的核對（還沒 start 也先收著）
    if (signal === 'fp') {
      const gate = this.peerGates.get(from);
      if (gate) gate.check.receive(data);
      return;
    }
    const run = signal === 'offer' ? this.onOffer(from, data as RTCSessionDescriptionInit)
      : signal === 'answer' ? this.onAnswer(from, data as RTCSessionDescriptionInit)
        : this.onIce(from, data as RTCIceCandidateInit);
    run.catch((err) => console.error(`[GroupCall] ${String(signal)} handling failed:`, err));
  }

  /** 第一次看到這一封才回 true（過期的先清掉；滿了丟最早到期的 —— 它也快要因為 iat 太舊被擋了） */
  private firstSeen(key: string, exp: number, now: number): boolean {
    if (this.seenSignals.has(key)) return false;
    if (this.seenSignals.size >= MAX_SEEN_SIGNALS) {
      for (const [k, e] of this.seenSignals) if (e < now) this.seenSignals.delete(k);
      while (this.seenSignals.size >= MAX_SEEN_SIGNALS) {
        const first = this.seenSignals.keys().next().value;
        if (first === undefined) break;
        this.seenSignals.delete(first);
      }
    }
    this.seenSignals.set(key, exp);
    return true;
  }

  private async onStart(groupId: string, initiator: string, video: boolean): Promise<void> {
    // 我封鎖的成員發起的群組通話不響（一對一來電已經擋了；部署前審查 LOW）。查不到封鎖名單就當沒封鎖
    if (await isBlacklisted(initiator).catch(() => false)) return;
    devLog(`[GroupCall] Incoming group call from ${initiator.slice(0, 8)} in group ${groupId}`);
    if (this.currentCall && this.currentCall.state !== GroupCallState.IDLE) {
      devLog('[GroupCall] Already in a call, ignoring');
      return;
    }
    // 群名用本機名冊的（信令裡沒有群名）
    const groupName = useGroupStore.getState().getGroupById(groupId)?.name ?? '';
    this.incomingCallListeners.forEach((callback) => {
      callback(groupId, groupName, initiator, video);
    });
  }

  private onJoin(groupId: string, participantId: string): void {
    if (!this.currentCall || this.currentCall.groupId !== groupId) return;
    devLog(`[GroupCall] Participant joined: ${participantId.slice(0, 8)}`);
    this.connectToParticipant(participantId).catch((err) => console.error('[GroupCall] connecting to a participant failed:', err));
  }

  /** 只能宣告「自己」離開（寄件人就是離開的人） */
  private onLeave(groupId: string, participantId: string): void {
    if (!this.currentCall || this.currentCall.groupId !== groupId) return;
    devLog(`[GroupCall] Participant left: ${participantId.slice(0, 8)}`);
    this.removeParticipant(participantId);
  }

  private onEnd(groupId: string, endedBy: string): void {
    if (!this.currentCall || this.currentCall.groupId !== groupId) return;
    devLog(`[GroupCall] Call ended by ${endedBy.slice(0, 8)}`);
    this.cleanupCall();
  }

  private async onOffer(fromId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.currentCall || !this.localPublicKey || !this.localStream) return;
    devLog(`[GroupCall] Received offer from ${fromId.slice(0, 8)}`);

    // 取得或建立參與者連線
    let participant = this.participants.get(fromId);
    if (!participant) {
      participant = {
        peerId: fromId,
        connection: null,
        remoteStream: null,
        isConnected: false,
        isMuted: false,
        isVideoEnabled: this.currentCall.isVideoCall,
        joinedAt: Date.now(),
      };
      this.participants.set(fromId, participant);
      this.currentCall.participants.set(fromId, participant);
    }

    if (!participant.connection) {
      participant.connection = this.createPeerConnection(fromId);

      // 添加本地音軌（這條 PC 專用的複本，指紋驗過之前 enabled = false）
      this.addGatedTracks(fromId, participant.connection);
    }

    // 已經驗過指紋的連線上又來一則 offer（重新協商）：SDP 裡的指紋要還是驗過的那些，否則拆掉（深度防禦，5d 複審 L5：信令哪天出了漏洞，
    //   換了憑證的重新協商不能沿用「已驗過」）
    const gate = this.peerGates.get(fromId);
    if (gate?.verified && gate.connection === participant.connection) {
      const fps = fingerprintsFromSdp(offer.sdp);
      if (fps.length === 0 || !fps.every((fp) => gate.verifiedRemote.includes(fp))) {
        this.onPeerUnverified(fromId, 'mismatch');
        return;
      }
    }

    // 兩邊同時發起（glare）：公鑰字典序較大的一方堅持自己的 offer、不理對方的（對方會撤回、接我的）；較小的一方撤回自己的
    if (participant.connection.signalingState === 'have-local-offer') {
      if (this.localPublicKey > fromId) {
        devLog(`[GroupCall] Glare with ${fromId.slice(0, 8)}: keeping my offer`);
        return;
      }
      await participant.connection.setLocalDescription({ type: 'rollback' });
    }

    // 設定遠端描述並建立 answer
    await participant.connection.setRemoteDescription(new RTCSessionDescription(offer));

    // 處理待處理的 ICE candidates
    const pendingCandidates = this.pendingIceCandidates.get(fromId);
    if (pendingCandidates) {
      for (const candidate of pendingCandidates) {
        await participant.connection.addIceCandidate(new RTCIceCandidate(candidate));
      }
      this.pendingIceCandidates.delete(fromId);
    }

    const answer = await participant.connection.createAnswer();
    await participant.connection.setLocalDescription(answer);

    this.signal(fromId, this.currentCall.groupId, 'answer', { type: answer.type, sdp: answer.sdp });

    devLog(`[GroupCall] Sent answer to ${fromId.slice(0, 8)}`);
  }

  private async onAnswer(fromId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const participant = this.participants.get(fromId);
    if (!participant?.connection) {
      devWarn(`[GroupCall] No connection for ${fromId.slice(0, 8)}`);
      return;
    }
    devLog(`[GroupCall] Received answer from ${fromId.slice(0, 8)}`);
    await participant.connection.setRemoteDescription(new RTCSessionDescription(answer));
  }

  private async onIce(fromId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const participant = this.participants.get(fromId);
    if (!participant?.connection) {
      // 連線尚未建立，先緩存（每人最多 64 個）
      devLog(`[GroupCall] Caching ICE candidate from ${fromId.slice(0, 8)}`);
      const list = this.pendingIceCandidates.get(fromId) ?? [];
      if (list.length < 64) this.pendingIceCandidates.set(fromId, [...list, candidate]);
      return;
    }
    devLog(`[GroupCall] Adding ICE candidate from ${fromId.slice(0, 8)}`);
    await participant.connection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  // ───────── DTLS 指紋（開源第 5d 步） ─────────

  /** 建這條 PC 的指紋核對與閘門（換了 PC 就換一份：舊的那一份停掉） */
  private attachGate(peerId: string, connection: RTCPeerConnection): void {
    this.stopGate(peerId);
    const check = createFingerprintCheck({
      read: () => readFingerprints(connection),
      send: (fp, got) => { if (this.peerGates.get(peerId)?.connection === connection) this.sendFingerprint(peerId, fp, got); },
      onVerified: () => { if (this.peerGates.get(peerId)?.connection === connection) this.onPeerVerified(peerId); },
      onFail: (reason) => { if (this.peerGates.get(peerId)?.connection === connection) this.onPeerUnverified(peerId, reason); },
      timeoutMs: GROUP_FP_TIMEOUT_MS,
    });
    this.peerGates.set(peerId, { connection, check, verified: false, iceConnected: false, clones: [], heldStream: null, verifiedRemote: [] });
  }

  /** 送我的指紋給這位參與者（獨立一個方法：模擬竄改自己送出去的指紋，測「對不上就拆掉」） */
  private sendFingerprint(peerId: string, fp: DtlsFingerprints, got: boolean): void {
    if (!this.currentCall) return;
    this.signal(peerId, this.currentCall.groupId, 'fp', { local: fp.local, remote: fp.remote, got });
  }

  /**
   * 本機的麥克風／鏡頭給這條 PC：每條 PC 一份複本（track.clone()），指紋驗過之前 enabled = false（只送靜音與黑畫面）。
   * 原本的 track 不直接加：同一個 track 給所有 PC，沒辦法只關掉還沒驗過的那一條
   */
  private addGatedTracks(peerId: string, connection: RTCPeerConnection): void {
    if (!this.localStream) return;
    const gate = this.peerGates.get(peerId);
    for (const track of this.localStream.getTracks()) {
      const clone = track.clone();
      clone.enabled = false;
      connection.addTrack(clone, this.localStream);
      if (gate && gate.connection === connection) gate.clones.push(clone);
    }
    this.applyGate(peerId);
  }

  /** 照這條 PC 驗過了沒、使用者的靜音／關鏡頭，開關送出去的複本與收到的串流 */
  private applyGate(peerId: string): void {
    const gate = this.peerGates.get(peerId);
    if (!gate) return;
    const muted = this.currentCall?.localMuted ?? false;
    const videoOn = this.currentCall?.localVideoEnabled ?? false;
    for (const t of gate.clones) t.enabled = gate.verified && (t.kind === 'audio' ? !muted : videoOn);
    gate.heldStream?.getTracks().forEach((t) => { t.enabled = gate.verified; });
    const participant = this.participants.get(peerId);
    if (participant && gate.verified && gate.heldStream && participant.remoteStream !== gate.heldStream) {
      participant.remoteStream = gate.heldStream;
      this.notifyParticipantChange(peerId, participant);
    }
  }

  private applyAllGates(): void {
    for (const peerId of this.peerGates.keys()) this.applyGate(peerId);
  }

  /** 指紋對上了：這位參與者才算接通（送我的聲音／影像、播他的） */
  private onPeerVerified(peerId: string): void {
    const gate = this.peerGates.get(peerId);
    if (!gate) return;
    gate.verified = true;
    gate.verifiedRemote = gate.check.mine?.remote ?? [];
    this.count('fp-verified');
    this.applyGate(peerId);
    const participant = this.participants.get(peerId);
    if (participant && gate.iceConnected && !participant.isConnected) {
      participant.isConnected = true;
      this.notifyParticipantChange(peerId, participant);
    }
  }

  /** 指紋對不上（中間有人）或驗不了：拆掉這一條 PC（其他參與者照常）、跟使用者說 */
  private onPeerUnverified(peerId: string, reason: FingerprintFailure): void {
    this.count(`fp-${reason}`);
    console.error(`[GroupCall] DTLS fingerprint check with ${peerId.slice(0, 8)} failed (${reason}) — dropping that connection`);
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'group-call-unverified', reason } }));
    }
    this.removeParticipant(peerId);
  }

  /** 停掉這位參與者的指紋核對、送出去的複本 */
  private stopGate(peerId: string): void {
    const gate = this.peerGates.get(peerId);
    if (!gate) return;
    this.peerGates.delete(peerId);
    gate.check.stop();
    gate.clones.forEach((t) => t.stop());
    gate.clones = [];
    gate.heldStream = null;
  }

  private count(k: string): void {
    this.counters[k] = (this.counters[k] ?? 0) + 1;
  }

  /** 模擬／測試：每位參與者的連線與指紋狀態、計數（不含任何金鑰） */
  debugState(): { groupId: string | null; peers: Record<string, { ice: boolean; verified: boolean; fp: string; connected: boolean; stream: boolean }>; counters: Record<string, number> } {
    const peers: Record<string, { ice: boolean; verified: boolean; fp: string; connected: boolean; stream: boolean }> = {};
    for (const [pk, g] of this.peerGates) {
      const p = this.participants.get(pk);
      peers[pk] = { ice: g.iceConnected, verified: g.verified, fp: g.check.state, connected: !!p?.isConnected, stream: !!p?.remoteStream };
    }
    return { groupId: this.currentCall?.groupId ?? null, peers, counters: { ...this.counters } };
  }

  /** 模擬：我跟這位參與者那一條 PC 讀到的 DTLS 指紋（兩邊交叉比對「中間沒有人」用） */
  async debugFingerprints(peerId: string): Promise<DtlsFingerprints | null> {
    const gate = this.peerGates.get(peerId);
    return gate ? readFingerprints(gate.connection) : null;
  }

  /**
   * 移除參與者
   */
  private removeParticipant(peerId: string): void {
    this.stopGate(peerId);
    const participant = this.participants.get(peerId);
    if (participant) {
      // 關閉連線
      if (participant.connection) {
        participant.connection.close();
      }
      this.participants.delete(peerId);
      this.currentCall?.participants.delete(peerId);
      this.notifyParticipantChange(peerId, { ...participant, isConnected: false });
      devLog(`[GroupCall] Removed participant ${peerId.slice(0, 8)}`);
    }
  }

  /**
   * 清理通話
   */
  private cleanupCall(): void {
    // 停止計時器
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }

    // 關閉所有連線（指紋核對、送出去的複本一起停）
    [...this.peerGates.keys()].forEach((peerId) => this.stopGate(peerId));
    this.participants.forEach((participant) => {
      if (participant.connection) {
        participant.connection.close();
      }
    });
    this.participants.clear();
    this.pendingIceCandidates.clear();

    // 停止本地串流
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    // 更新狀態
    if (this.currentCall) {
      this.currentCall.state = GroupCallState.ENDED;
      this.notifyStateChange();
    }

    // 延遲清空，讓 UI 有時間顯示結束狀態
    setTimeout(() => {
      this.currentCall = null;
      this.notifyStateChange();
    }, 2000);

    devLog('[GroupCall] Call cleaned up');
  }

  /**
   * 開始通話計時
   */
  private startCallTimer(): void {
    this.callTimer = setInterval(() => {
      if (this.currentCall && this.currentCall.startTime) {
        this.currentCall.duration = Math.floor((Date.now() - this.currentCall.startTime) / 1000);
        this.notifyStateChange();
      }
    }, 1000);
  }

  /**
   * 通知狀態變化
   */
  private notifyStateChange(): void {
    const state = this.currentCall?.state || GroupCallState.IDLE;
    this.stateListeners.forEach((callback) => {
      callback(state, this.currentCall || undefined);
    });
  }

  /**
   * 通知參與者變化
   */
  private notifyParticipantChange(peerId: string, participant: Participant): void {
    this.participantListeners.forEach((callback) => {
      callback(peerId, participant);
    });
  }
}

// 單例導出
export const groupCallService = new GroupCallService();

export default groupCallService;

/**
 * VoiceCallService - 語音通話管理
 *
 * 負責管理 WebRTC 音訊串流和通話狀態
 *
 * Phase 5 更新：整合 VoiceAnalyzer 進行語音分析
 *
 * 開源第 4 步（docs/DIRECT_SEALED.md）：
 *  - 信令全部是 DIRECT_SEALED 的 kind 'call'（封給對方身分金鑰、對方簽章；directSignal）：request／accept／reject／end／
 *    offer／answer／ice／fp，每一則帶 callId（發起方產生）與 seq。以前七種明文型別經 broker 可讀、可偽造（中間人、冒名來電）。
 *  - 狀態機（callSignalGuard）：只收目前這一通、對方寄的、seq 遞增的；被叫方這一通只接一則 offer、發起方不接 offer；
 *    answer 只在 have-local-offer；ICE 只給目前這一通（還沒有 PC／remoteDescription 就先收著）。
 *  - DTLS 指紋（dtlsFingerprint）：ICE 連上後兩邊交換「我的／我看到的對方」憑證指紋（kind 'call' 的 fp），對得上才算接通
 *    （CONNECTED）；在那之前自己的麥克風／鏡頭不送（track.enabled = false）、對方的聲音不播。對不上或 30 秒內驗不了 → 掛斷、
 *    跟使用者說（aegis:mqtt-notice kind call-unverified）。
 *  - 審查後（M2／L3）：信令一則一則依序處理（來電還在查好友時到的掛斷不會被丟）；全部排隊最多 60 秒（以前 offer／ICE 沒連上就丟）；
 *    接聽後 45 秒還沒接通就掛斷（以前少一則信令就永遠「連線中」）；超過 35 秒的來電不響（撥的人 30 秒就放棄了）；
 *    封鎖名單查不了 ＝ 不響。
 */

import { mqttService } from './mqtt';
// 通話語音分析（對方說的話做防詐偵測）是官方版的功能（@ext/callAnalysis ＝ ext.antiFraud.callAnalysis）；社群版沒有 → 不分析
import { callAnalysis } from '@ext/callAnalysis';
import type { AudioSlice } from '../ext/types';
import { getIceServers } from './iceServers';
import { findFriendSettled } from '../stores/chatStore';
import { isBlacklisted } from './localBlacklist';
import { devLog, devWarn } from '../utils/devLog';
import { onDirect, sendDirect, CALL_CONTROL_TTL_MS } from './directSignal';
import type { DirectBody } from './directSeal';
import { createCallGuard, newCallId, parseCallSignal, type CallSig, type CallSignal } from './callSignalGuard';
import {
  createFingerprintCheck, readFingerprints, type DtlsFingerprints, type FingerprintCheck, type FingerprintFailure,
} from './dtlsFingerprint';

// 通話狀態
export enum CallState {
  IDLE = 'idle',                 // 閒置
  REQUESTING = 'requesting',     // 發起中（等待對方接聽）
  INCOMING = 'incoming',         // 來電中
  CONNECTING = 'connecting',     // 連線中
  CONNECTED = 'connected',       // 通話中
  ENDED = 'ended',               // 已結束
}

// 通話結束原因
export enum CallEndReason {
  NORMAL = 'normal',             // 正常掛斷
  DECLINED = 'declined',         // 對方拒絕
  NO_ANSWER = 'no_answer',       // 無人接聽
  BUSY = 'busy',                 // 對方忙線
  FAILED = 'failed',             // 連線失敗
  NETWORK_ERROR = 'network',     // 網路錯誤
  UNVERIFIED = 'unverified',     // DTLS 指紋對不上或驗不了（可能有人在中間）
}

/** 對方的 ICE 在 PC／remoteDescription 建好之前先收著幾個 */
const MAX_PENDING_ICE = 64;
/** 指紋多久沒驗過就掛斷 */
const FINGERPRINT_TIMEOUT_MS = 30_000;
/** 接聽（CONNECTING）之後多久還沒接通（指紋驗過）就掛斷：ICE 最多十幾秒＋指紋 */
const CONNECT_TIMEOUT_MS = 45_000;
/** 來電（request）封了多久以上就不響：撥的人響 30 秒就放棄（校正到伺服器的時鐘） */
const CALL_REQUEST_MAX_AGE_MS = 35_000;

// 通話資訊
export interface CallInfo {
  peerId: string;                // 對方公鑰
  peerName?: string;             // 對方名稱
  state: CallState;
  startTime?: number;            // 通話開始時間
  duration?: number;             // 通話時長（秒）
  isMuted: boolean;              // 是否靜音
  isSpeakerOn: boolean;          // 是否擴音
  isVideoCall: boolean;          // 是否為視訊通話
  isVideoEnabled: boolean;       // 視訊是否開啟
  // Phase 5: 語音分析狀態
  isAnalyzing?: boolean;         // 是否正在分析語音
  sliceCount?: number;           // 已分析的切片數量
}

// 回調類型
type CallStateCallback = (state: CallState, info?: CallInfo) => void;
type IncomingCallCallback = (callerId: string, isVideoCall: boolean) => void;
type AudioSliceCallback = (slice: AudioSlice) => void;

/**
 * 語音通話服務
 */
class VoiceCallService {
  public localPublicKey: string | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;

  // 通話狀態
  private callState: CallState = CallState.IDLE;
  private currentCall: CallInfo | null = null;
  private callTimer: NodeJS.Timeout | null = null;
  private ringTimer: NodeJS.Timeout | null = null;
  /** 接聽之後等接通的期限（CONNECT_TIMEOUT_MS） */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 收到的信令一則一則處理（審查 L3：來電還在查好友清單時，同一個人的掛斷先跑完就被丟了） */
  private signalChain: Promise<void> = Promise.resolve();

  // 事件監聽器
  private stateListeners: Set<CallStateCallback> = new Set();
  private incomingCallListeners: Set<IncomingCallCallback> = new Set();
  private audioSliceListeners: Set<AudioSliceCallback> = new Set();

  // 信令訂閱（directSignal 的 kind 'call'）取消函式
  private mqttUnsubscribes: (() => void)[] = [];

  // 語音分析取消函式
  private analyzerUnsubscribe: (() => void) | null = null;

  /** 目前這一通的 callId／角色／對方的 seq（callSignalGuard） */
  private guard = createCallGuard();
  /** 這條 PC 的 DTLS 指紋核對（ICE 連上才開始） */
  private fpCheck: FingerprintCheck | null = null;
  /** 指紋驗過了沒：之前不送自己的聲音／影像、不播對方的 */
  private verified = false;
  /** PC／remoteDescription 還沒好時先到的對方 ICE（只收目前這一通的） */
  private pendingIce: RTCIceCandidateInit[] = [];
  /** 被叫方接聽後在拿麥克風：offer 先到要等它（以前 offer 比 getUserMedia 早到 → 被叫方送不出聲音） */
  private localStreamReady: Promise<void> | null = null;
  /** 計數（模擬與測試看：被擋掉的信令與原因） */
  private counters: Record<string, number> = {};

  private count(k: string): void {
    this.counters[k] = (this.counters[k] ?? 0) + 1;
  }

  /**
   * 初始化服務
   */
  initialize(localPublicKeyBase64: string): void {
    console.error('[VoiceCall] initialize() called, pk:', localPublicKeyBase64.slice(0, 16));
    // 防止重複初始化（AppProvider 可能多次呼叫）
    if (this.localPublicKey === localPublicKeyBase64 && this.mqttUnsubscribes.length > 0) {
      console.error('[VoiceCall] Already initialized, skipping');
      return;
    }

    // 清理舊的訂閱
    this.mqttUnsubscribes.forEach(unsub => unsub());
    this.mqttUnsubscribes = [];

    this.localPublicKey = localPublicKeyBase64;

    // 通話信令：DIRECT_SEALED 的 kind 'call'（directSignal 已驗過簽章、新鮮度、重放；這裡看它屬不屬於目前這一通）
    this.mqttUnsubscribes.push(
      onDirect('call', (from, body) => this.handleSignal(from, body)),
    );

    devLog('[VoiceCall] Service initialized');
  }

  /**
   * 關閉服務
   */
  shutdown(): void {
    this.endCall();
    this.mqttUnsubscribes.forEach((unsub) => unsub());
    this.mqttUnsubscribes = [];
    this.localPublicKey = null;
    devLog('[VoiceCall] Service shut down');
  }

  /** 模擬／測試：目前的狀態與計數（不含任何金鑰） */
  debugState(): { callState: CallState; callId: string | null; role: string | null; verified: boolean; fp: string | null; counters: Record<string, number> } {
    const g = this.guard.current();
    return { callState: this.callState, callId: g?.callId ?? null, role: g?.role ?? null, verified: this.verified,
      fp: this.fpCheck?.state ?? null, counters: { ...this.counters } };
  }

  /** 模擬：這通電話我這端讀到的 DTLS 指紋（兩邊交叉比對「沒有中間人」用） */
  async debugFingerprints(): Promise<DtlsFingerprints | null> {
    return this.peerConnection ? readFingerprints(this.peerConnection) : null;
  }

  // ───────── 送信令 ─────────

  /**
   * 送一則這一通的信令：全部排隊最多 60 秒（審查 M2：以前 offer／answer／ICE／fp 沒連上就丟、沒有重送 → 那一通永遠連不上）；
   * 同一個人的照順序送（directSignal）。callId／peer 沒給 ＝ 目前這一通；seq 是這一通裡我的流水號
   */
  private sendSignal(sig: CallSig, extra: { data?: Record<string, unknown>; video?: boolean; reason?: string } = {},
    target?: { peer: string; callId: string; seq: number }): void {
    const g = this.guard.current();
    const peer = target?.peer ?? g?.peer;
    const callId = target?.callId ?? g?.callId;
    if (!peer || !callId) return;
    const seq = target?.seq ?? this.guard.nextSeq();
    sendDirect(peer, { kind: 'call', sig, callId, seq, ...extra }, { ttlMs: CALL_CONTROL_TTL_MS })
      .then((sent) => { if (!sent) devWarn(`[VoiceCall] ${sig} not sent (locked)`); })
      .catch((err) => console.error(`[VoiceCall] ${sig} failed:`, err));
  }

  /** 送我的指紋（獨立一個方法：模擬竄改自己送出去的指紋，測「對不上就掛斷」） */
  private sendFingerprint(fp: DtlsFingerprints, got: boolean): void {
    this.sendSignal('fp', { data: { local: fp.local, remote: fp.remote, got } });
  }

  // ───────── 收信令 ─────────

  /**
   * directSignal 交過來的 kind 'call'（寄件人已由信封的簽章證明）。一則一則依序處理；接聽與 offer 要等麥克風（權限詢問可能
   * 很久）—— 那兩種不擋後面的（掛斷、ICE 照樣處理）
   */
  private handleSignal(from: string, body: DirectBody): void {
    const s = parseCallSignal(body);
    if (!s) { this.count('malformed'); return; }
    const run = (): Promise<void> | void => {
      if (s.sig === 'request') return this.handleCallRequest(from, s, body.iat);
      // 其他的一定屬於目前這一通：對方寄的、同一個 callId；改狀態的還要 seq 比他上一則大（別通的、倒退的都丟）
      if (!this.guard.take(from, s)) { this.count(`not-current:${s.sig}`); return; }
      const detach = (p: Promise<void>) => { p.catch((err) => console.error(`[VoiceCall] ${s.sig} handling failed:`, err)); };
      switch (s.sig) {
        case 'accept': detach(this.handleCallAccept()); return;
        case 'reject': return this.handleCallReject(s);
        case 'end': return this.handleCallEnd();
        case 'offer': detach(this.handleOffer(s)); return;
        case 'answer': return this.handleAnswer(s);
        case 'ice': return this.handleIceCandidate(s);
        case 'fp': this.fpCheck?.receive(s.data); return;
      }
    };
    this.signalChain = this.signalChain.then(run).catch((err) => console.error(`[VoiceCall] ${s.sig} handling failed:`, err));
  }

  /**
   * 發起通話
   * @param peerId 對方公鑰
   * @param peerName 對方名稱
   * @param withVideo 是否開啟視訊（預設為 false）
   */
  async startCall(peerId: string, peerName?: string, withVideo: boolean = false): Promise<void> {
    devLog(`[VoiceCall] startCall - current state: ${this.callState}, peerId: ${peerId.slice(0, 8)}..., withVideo: ${withVideo}, localPublicKey: ${this.localPublicKey ? 'set' : 'NOT SET'}`);

    if (!this.localPublicKey) {
      console.error('[VoiceCall] Service not initialized! Cannot start call.');
      throw new Error('VoiceCall service not initialized');
    }

    if (this.callState !== CallState.IDLE) {
      devWarn(`[VoiceCall] Already in a call (state=${this.callState})`);
      throw new Error('Already in a call');
    }

    devLog(`[VoiceCall] Starting ${withVideo ? 'video' : 'voice'} call to ${peerId.slice(0, 8)}...`);

    // 更新狀態
    this.callState = CallState.REQUESTING;
    this.currentCall = {
      peerId,
      peerName,
      state: CallState.REQUESTING,
      isMuted: false,
      isSpeakerOn: false,
      isVideoCall: withVideo,
      isVideoEnabled: withVideo,
    };
    this.verified = false;
    this.pendingIce = [];
    // 這一通的 id（之後每一則信令都帶它；對方的、別通的、重放的都對不上）
    const callId = newCallId();
    this.guard.begin('caller', peerId, callId);
    this.notifyStateChange();

    // 發送通話請求（附帶視訊旗標，封給對方的身分金鑰）。不帶自己的名字（A5）：對方手機用我的公鑰查他自己的聯絡人，
    //   不是他的好友就不響 —— 以前送自填的名字，任何人都能冒充「媽媽」打來
    this.sendSignal('request', { video: withVideo });
    // 來電推播：帳戶簽章的 /api/push/notify（以前推播提示明文搭在 MQTT 訊息上，broker 看得到「這是來電」）；
    //   帶這一通的 callId → 推播裡有我簽的響鈴 token（開源第 5d 步：對方手機驗過才全螢幕響鈴、顯示名字）
    mqttService.triggerFcmNotify(peerId, { type: 'incoming_call', isVideoCall: withVideo, callId });

    // 設定 30 秒無人接聽超時（告訴對方別再響了）
    this.ringTimer = setTimeout(() => {
      if (this.callState === CallState.REQUESTING) {
        devLog('[VoiceCall] No answer, ending call');
        this.sendSignal('end');
        this.endCallWithReason(CallEndReason.NO_ANSWER);
      }
    }, 30000);
  }

  /**
   * 接聽來電
   */
  async acceptCall(): Promise<void> {
    if (this.callState !== CallState.INCOMING || !this.currentCall) {
      devWarn('[VoiceCall] No incoming call to accept');
      return;
    }

    devLog(`[VoiceCall] Accepting call from ${this.currentCall.peerId.slice(0, 8)}...`);

    // 清除響鈴計時器
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }

    // 更新狀態
    this.callState = CallState.CONNECTING;
    this.currentCall.state = CallState.CONNECTING;
    this.notifyStateChange();
    this.startConnectTimer();

    // 發送接受訊號
    this.sendSignal('accept');

    // 開始建立 WebRTC 連線（作為被呼叫方，等待 offer；offer 先到的話它會等這個）
    const ready = this.setupLocalStream();
    this.localStreamReady = ready;
    try {
      await ready;
    } catch (error) {
      console.error('[VoiceCall] Failed to get media stream:', error);
      this.sendSignal('end');
      this.endCallWithReason(CallEndReason.FAILED);
    }
  }

  /**
   * 拒絕來電
   */
  rejectCall(reason?: string): void {
    if (this.callState !== CallState.INCOMING || !this.currentCall) {
      devWarn('[VoiceCall] No incoming call to reject');
      return;
    }

    devLog(`[VoiceCall] Rejecting call from ${this.currentCall.peerId.slice(0, 8)}...`);

    // 清除響鈴計時器
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }

    // 發送拒絕訊號
    this.sendSignal('reject', { reason: reason === 'no_answer' ? 'no_answer' : 'declined' });

    // 重置狀態
    this.resetCall();
  }

  /**
   * 結束通話
   */
  endCall(): void {
    if (this.callState === CallState.IDLE) {
      return;
    }

    devLog('[VoiceCall] Ending call');

    // 發送結束訊號（這一通的 callId；已經結束的那一通不再送）
    if (this.currentCall && this.callState !== CallState.ENDED) {
      this.sendSignal('end');
    }

    this.endCallWithReason(CallEndReason.NORMAL);
  }

  /**
   * 切換靜音（指紋驗過之前只記下來：那時麥克風本來就不送，見 applyMediaGate）
   */
  toggleMute(): boolean {
    if (!this.localStream || !this.currentCall) {
      return false;
    }

    if (this.localStream.getAudioTracks()[0]) {
      this.currentCall.isMuted = !this.currentCall.isMuted;
      this.applyMediaGate();
      this.notifyStateChange();
      devLog(`[VoiceCall] Mute: ${this.currentCall.isMuted}`);
    }

    return this.currentCall.isMuted;
  }

  /**
   * 指紋驗過之前：自己的麥克風／鏡頭不送（enabled = false 只送靜音與黑畫面）、對方的聲音與影像不播；
   * 驗過之後照使用者的靜音／關鏡頭設定
   */
  private applyMediaGate(): void {
    const call = this.currentCall;
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = this.verified && !(call?.isMuted ?? false); });
    this.localStream?.getVideoTracks().forEach((t) => { t.enabled = this.verified && (call?.isVideoEnabled ?? false); });
    this.remoteStream?.getTracks().forEach((t) => { t.enabled = this.verified; });
  }

  /**
   * 取得當前通話資訊
   */
  getCurrentCall(): CallInfo | null {
    return this.currentCall;
  }

  /**
   * 取得通話狀態
   */
  getCallState(): CallState {
    return this.callState;
  }

  /**
   * 取得遠端音訊串流
   */
  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  /**
   * 監聽通話狀態變化
   */
  onStateChange(callback: CallStateCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * 監聽來電
   */
  onIncomingCall(callback: IncomingCallCallback): () => void {
    this.incomingCallListeners.add(callback);
    return () => this.incomingCallListeners.delete(callback);
  }

  /**
   * 監聽音訊切片（Phase 5）
   */
  onAudioSlice(callback: AudioSliceCallback): () => void {
    this.audioSliceListeners.add(callback);
    return () => this.audioSliceListeners.delete(callback);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * 設定本地媒體串流（音訊 + 可選視訊）
   */
  private async setupLocalStream(): Promise<void> {
    const withVideo = this.currentCall?.isVideoCall ?? false;
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
      devLog(`[VoiceCall] Local ${withVideo ? 'video' : 'audio'} stream acquired`);
      // 指紋驗過之前不送（applyMediaGate）
      this.applyMediaGate();
    } catch (error) {
      console.error('[VoiceCall] Failed to get user media:', error);
      throw error;
    }
  }

  /**
   * 切換視訊開關（指紋驗過之前只記下來，見 applyMediaGate）
   */
  toggleVideo(): boolean {
    if (!this.localStream || !this.currentCall || !this.currentCall.isVideoCall) {
      return false;
    }

    if (this.localStream.getVideoTracks()[0]) {
      this.currentCall.isVideoEnabled = !this.currentCall.isVideoEnabled;
      this.applyMediaGate();
      this.notifyStateChange();
      devLog(`[VoiceCall] Video: ${this.currentCall.isVideoEnabled}`);
    }

    return this.currentCall.isVideoEnabled;
  }

  /**
   * 取得本地視訊串流
   */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /**
   * 建立 RTCPeerConnection
   */
  private createPeerConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });
    // 這條 PC 的 DTLS 指紋核對（ICE 連上才 start；之前收到對方的先收著）
    this.fpCheck?.stop();
    this.verified = false;
    const check = createFingerprintCheck({
      read: () => readFingerprints(connection),
      send: (fp, got) => { if (this.peerConnection === connection) this.sendFingerprint(fp, got); },
      onVerified: () => { if (this.peerConnection === connection) this.onFingerprintVerified(); },
      onFail: (reason) => { if (this.peerConnection === connection) this.onFingerprintFailed(reason); },
      timeoutMs: FINGERPRINT_TIMEOUT_MS,
    });
    this.fpCheck = check;

    // ICE Candidate 事件（封給對方，帶這一通的 callId）
    connection.onicecandidate = (event) => {
      if (event.candidate && this.currentCall && this.peerConnection === connection) {
        // 記錄 candidate 類型 (host=直連, srflx=STUN, relay=TURN)
        const c = event.candidate;
        const isIPv6 = c.address?.includes(':');
        devLog(`[VoiceCall] Local ICE candidate: type=${c.type}, protocol=${c.protocol}, address=${c.address}, IPv6=${isIPv6}`);
        const json = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
        this.sendSignal('ice', { data: { ...(json as Record<string, unknown>) } });
      } else if (!event.candidate) {
        // ICE gathering 完成
        devLog('[VoiceCall] ICE gathering completed');
      }
    };

    // ICE 連線狀態變化
    connection.oniceconnectionstatechange = () => {
      devLog(`[VoiceCall] ICE state: ${connection.iceConnectionState}`);
      if (this.peerConnection !== connection) return;

      if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
        // 記錄最終選擇的連線方式
        this.logSelectedCandidatePair(connection);
        // 接通要等 DTLS 指紋兩邊對過（onFingerprintVerified）；以前 ICE 一連上就算接通
        check.start();
      } else if (connection.iceConnectionState === 'failed') {
        this.sendSignal('end');
        this.endCallWithReason(CallEndReason.NETWORK_ERROR);
      } else if (connection.iceConnectionState === 'disconnected') {
        devWarn('[VoiceCall] ICE disconnected, waiting for reconnection...');
      }
    };

    // ICE gathering 狀態（收集完成時記錄）
    connection.onicegatheringstatechange = () => {
      devLog(`[VoiceCall] ICE gathering state: ${connection.iceGatheringState}`);
    };

    // 接收遠端音軌（指紋驗過之前不播）
    connection.ontrack = (event) => {
      if (this.peerConnection !== connection) return;
      devLog('[VoiceCall] Received remote track');
      this.remoteStream = event.streams[0];
      this.applyMediaGate();
    };

    return connection;
  }

  /** 接聽之後 CONNECT_TIMEOUT_MS 內沒接通（少了一則信令、ICE 一直沒連上）→ 掛斷，不要永遠停在「連線中」（審查 M2） */
  private startConnectTimer(): void {
    this.clearConnectTimer();
    const callId = this.guard.current()?.callId;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.callState !== CallState.CONNECTING || this.guard.current()?.callId !== callId) return;
      this.count('connect-timeout');
      devWarn('[VoiceCall] not connected in time — hanging up');
      this.sendSignal('end', { reason: 'failed' });
      this.endCallWithReason(CallEndReason.FAILED);
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  /** 指紋對上了：才算接通（送自己的聲音、播對方的、開始計時） */
  private onFingerprintVerified(): void {
    this.verified = true;
    this.count('fp-verified');
    this.applyMediaGate();
    this.onCallConnected();
  }

  /** 指紋對不上（中間有人）或驗不了：掛斷、跟使用者說 */
  private onFingerprintFailed(reason: FingerprintFailure): void {
    this.count(`fp-${reason}`);
    console.error(`[VoiceCall] DTLS fingerprint check failed (${reason}) — hanging up`);
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'call-unverified', reason } }));
    }
    this.sendSignal('end');
    this.endCallWithReason(CallEndReason.UNVERIFIED);
  }

  /** 先到的對方 ICE（PC 的 remoteDescription 設好之後）補上 */
  private async flushPendingIce(connection: RTCPeerConnection): Promise<void> {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) {
      if (this.peerConnection !== connection) return;
      try {
        await connection.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        devWarn('[VoiceCall] buffered ICE candidate rejected:', err);
      }
    }
  }

  /**
   * 記錄選擇的 ICE candidate pair（診斷用）
   */
  private async logSelectedCandidatePair(connection: RTCPeerConnection): Promise<void> {
    try {
      const stats = await connection.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          devLog(`[VoiceCall] ✅ Selected candidate pair:`, {
            localType: report.localCandidateId,
            remoteType: report.remoteCandidateId,
            bytesSent: report.bytesSent,
            bytesReceived: report.bytesReceived,
          });
        }
        // 記錄 local candidate 詳情
        if (report.type === 'local-candidate' && report.isRemote === false) {
          devLog(`[VoiceCall] Local candidate: ${report.candidateType} ${report.protocol} ${report.address}:${report.port}`);
        }
        // 記錄 remote candidate 詳情
        if (report.type === 'remote-candidate') {
          devLog(`[VoiceCall] Remote candidate: ${report.candidateType} ${report.protocol} ${report.address}:${report.port}`);
        }
      });
    } catch (err) {
      devWarn('[VoiceCall] Failed to get stats:', err);
    }
  }

  /**
   * 處理通話請求（kind 'call' 的 request：開始一通新的；callId 是對方產生的）
   */
  private async handleCallRequest(callerId: string, s: CallSignal, iat: number): Promise<void> {
    const isVideoCall = s.video ?? false;

    devLog(`[VoiceCall] handleCallRequest - current state: ${this.callState}, from: ${callerId.slice(0, 8)}..., isVideoCall: ${isVideoCall}`);

    // 撥的人響 30 秒就放棄：太舊的來電（晚到的、App 被推播叫醒前排著的、重開之後被重放的）不響（審查 L3）
    if (!(mqttService.serverNow() - iat <= CALL_REQUEST_MAX_AGE_MS)) { this.count('request-stale'); return; }

    // 只有好友能打給我（稽核 M17，對應 AegisPlay B39）：以前任何拿到公鑰的人都能讓我的手機響，
    // 接起來就是一條直連 —— 對方看得到我的 IP。不回 reject，連「我在線上」都不透露。
    // 推播喚醒的 App 收到來電時好友清單常常還沒載入 → 先等清單（findFriendSettled，部署前審查 HIGH）
    if (!(await findFriendSettled(callerId))) { this.count('request-not-friend'); return; }
    // 封鎖的人不能讓我響鈴（稽核 H13，對應 AegisPlay B49）
    //   封鎖名單查不了 → 不響（審查 L5：不在查不了的時候放行）
    if (await isBlacklisted(callerId).catch(() => true)) { this.count('request-blocked'); return; }

    // 同一通的 request 又到一次（佇列重送）：不再響一次
    if (this.guard.current()?.callId === s.callId) { this.count('request-duplicate'); return; }

    // 如果正在通話中，自動拒絕（回那一通的 callId；不動我現在這一通）
    if (this.callState !== CallState.IDLE) {
      devLog(`[VoiceCall] Busy (state=${this.callState}), rejecting call from ${callerId.slice(0, 8)}...`);
      this.sendSignal('reject', { reason: 'busy' }, { peer: callerId, callId: s.callId, seq: 1 });
      return;
    }

    devLog(`[VoiceCall] Incoming ${isVideoCall ? 'video' : 'voice'} call from ${callerId.slice(0, 8)}...`);

    // 這一通：我是被叫方，只收這個 callId、對方 seq 比這則大的信令
    this.guard.begin('callee', callerId, s.callId, s.seq);
    this.verified = false;
    this.pendingIce = [];
    this.localStreamReady = null;

    // 更新狀態
    this.callState = CallState.INCOMING;
    this.currentCall = {
      peerId: callerId,
      state: CallState.INCOMING,
      isMuted: false,
      isSpeakerOn: false,
      isVideoCall,
      isVideoEnabled: isVideoCall,
    };
    this.notifyStateChange();

    // 通知來電（附帶視訊旗標）
    this.incomingCallListeners.forEach((callback) => callback(callerId, isVideoCall));

    // 設定 30 秒自動拒絕
    this.ringTimer = setTimeout(() => {
      if (this.callState === CallState.INCOMING) {
        devLog('[VoiceCall] Incoming call timeout');
        this.rejectCall('no_answer');
      }
    }, 30000);
  }

  /**
   * 處理通話接受（目前這一通、我是發起方、還在等對方接）
   */
  private async handleCallAccept(): Promise<void> {
    if (this.callState !== CallState.REQUESTING || !this.currentCall || this.guard.current()?.role !== 'caller') {
      this.count('accept-refused');
      return;
    }
    const callId = this.guard.current()?.callId;

    devLog(`[VoiceCall] Call accepted by ${this.currentCall.peerId.slice(0, 8)}...`);

    // 清除響鈴計時器
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }

    // 更新狀態
    this.callState = CallState.CONNECTING;
    this.currentCall.state = CallState.CONNECTING;
    this.notifyStateChange();
    this.startConnectTimer();

    // 開始建立 WebRTC 連線（作為呼叫方，發送 offer）
    try {
      await this.setupLocalStream();
      if (this.guard.current()?.callId !== callId) return;     // 拿麥克風的時候掛斷了
      await this.initiateConnection();
    } catch (error) {
      console.error('[VoiceCall] Failed to initiate connection:', error);
      this.sendSignal('end');
      this.endCallWithReason(CallEndReason.FAILED);
    }
  }

  /**
   * 處理通話拒絕（目前這一通）
   */
  private handleCallReject(s: CallSignal): void {
    devLog(`[VoiceCall] handleCallReject - state: ${this.callState}, reason: ${s.reason}`);
    if (!this.currentCall) return;
    const reason = s.reason === 'busy' ? CallEndReason.BUSY : CallEndReason.DECLINED;
    this.endCallWithReason(reason);
  }

  /**
   * 處理通話結束（目前這一通；上一通晚到或被重放的 end 帶的是別的 callId，guard 已經擋掉）
   */
  private handleCallEnd(): void {
    devLog(`[VoiceCall] handleCallEnd - state: ${this.callState}`);
    if (!this.currentCall) return;
    devLog('[VoiceCall] Call ended by remote');
    this.endCallWithReason(CallEndReason.NORMAL);
  }

  /**
   * 發起 WebRTC 連線（呼叫方）
   */
  private async initiateConnection(): Promise<void> {
    if (!this.currentCall || !this.localStream) {
      return;
    }

    // 建立 PeerConnection
    const pc = this.createPeerConnection();
    this.peerConnection = pc;

    // 添加本地音軌（指紋驗過之前 enabled = false，見 applyMediaGate）
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream!);
    });

    // 建立並發送 Offer（封給對方，帶這一通的 callId）
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.peerConnection !== pc) return;
    this.sendSignal('offer', { data: { type: offer.type, sdp: offer.sdp ?? '' } });

    devLog('[VoiceCall] Sent call offer');
  }

  /**
   * 處理 WebRTC Offer：只有被叫方、這一通的第一則（以前通話中收到的每一則 offer 都重建連線 ——
   * 最後一則贏，兩邊各塞一則就是中間人）
   */
  private async handleOffer(s: CallSignal): Promise<void> {
    if (this.callState !== CallState.CONNECTING || !this.currentCall || !this.guard.mayTakeOffer()) {
      this.count('offer-refused');
      return;
    }
    this.guard.markOfferTaken();
    const callId = s.callId;

    devLog('[VoiceCall] Received offer, setting up connection...');

    const offer = s.data as unknown as RTCSessionDescriptionInit;
    devLog(`[VoiceCall] Offer type: ${offer.type}, sdp length: ${offer.sdp?.length}`);

    // 接聽時開始拿麥克風：offer 先到就等它（以前不等 → 被叫方送不出聲音）
    if (this.localStreamReady) {
      try { await this.localStreamReady; } catch { return; }
    }
    if (this.guard.current()?.callId !== callId || !this.currentCall) return;

    // 建立 PeerConnection
    const pc = this.createPeerConnection();
    this.peerConnection = pc;

    // 添加本地音軌（指紋驗過之前 enabled = false）
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // 設定遠端描述，補上先到的 ICE
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }));
    await this.flushPendingIce(pc);

    // 建立並發送 Answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (this.peerConnection !== pc) return;
    this.sendSignal('answer', { data: { type: answer.type, sdp: answer.sdp ?? '' } });

    devLog('[VoiceCall] Sent call answer');
  }

  /**
   * 處理 WebRTC Answer：只有發起方、而且正在等 answer（have-local-offer）
   */
  private async handleAnswer(s: CallSignal): Promise<void> {
    const pc = this.peerConnection;
    if (!pc || !this.currentCall || !this.guard.mayTakeAnswer(pc.signalingState)) {
      this.count('answer-refused');
      return;
    }

    devLog('[VoiceCall] Received answer');

    const answer = s.data as unknown as RTCSessionDescriptionInit;
    devLog(`[VoiceCall] Answer type: ${answer.type}, sdp length: ${answer.sdp?.length}`);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer.sdp }));
      devLog('[VoiceCall] Remote description set successfully');
      await this.flushPendingIce(pc);
    } catch (err) {
      console.error('[VoiceCall] Failed to set remote description:', err);
    }
  }

  /**
   * 處理 ICE Candidate（目前這一通；PC／remoteDescription 還沒好就先收著）
   */
  private async handleIceCandidate(s: CallSignal): Promise<void> {
    const candidate = s.data as unknown as RTCIceCandidateInit;
    const pc = this.peerConnection;
    if (!this.currentCall) return;
    if (!pc || !pc.remoteDescription) {
      if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(candidate);
      return;
    }
    devLog(`[VoiceCall] Remote ICE candidate: type=${candidate.candidate?.split(' ')[7]}, candidate=${candidate.candidate?.slice(0, 80)}...`);

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      devLog('[VoiceCall] Remote ICE candidate added successfully');
    } catch (err) {
      console.error('[VoiceCall] Failed to add remote ICE candidate:', err);
    }
  }

  /**
   * 通話連線成功
   */
  private onCallConnected(): void {
    if (this.callState === CallState.CONNECTED || !this.currentCall) {
      return;
    }

    devLog('[VoiceCall] Call connected!');

    this.clearConnectTimer();
    this.callState = CallState.CONNECTED;
    this.currentCall.state = CallState.CONNECTED;
    this.currentCall.startTime = Date.now();
    this.notifyStateChange();

    // 開始計時
    this.startCallTimer();

    // Phase 5: 啟動語音分析
    this.startVoiceAnalysis();
  }

  /**
   * 啟動語音分析（Phase 5）
   */
  private async startVoiceAnalysis(): Promise<void> {
    const analysis = callAnalysis;
    if (!analysis) return;
    // 分析對方的聲音（remoteStream）— 偵測對方是否說詐騙話術。
    // ⚠️ 修復 2026-06-12：CONNECTED 事件常早於 ontrack → 舊版立刻 fallback 分析
    // localStream（自己的麥克風）→ 詐騙者的語音從沒被分析（E2E 8.5 實證：
    // 切片 RMS 恆定 0.12 = Alice 自己 fake mic 的 beep，非 Bob 的詐騙語音）。
    // 改為輪詢等 remoteStream（最多 10s），等不到才退 localStream（自我警示語意）。
    for (let waited = 0; !this.remoteStream && waited < 10_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.callState !== CallState.CONNECTED) return; // 通話已結束
    }
    if (!this.remoteStream) {
      console.error('[VoiceCall] remoteStream not ready after 10s — falling back to local mic analysis');
    }
    const streamToAnalyze = this.remoteStream || this.localStream;
    if (!streamToAnalyze) {
      devWarn('[VoiceCall] No stream for voice analysis');
      return;
    }

    try {
      // 初始化語音分析器
      await analysis.initialize();

      // 訂閱切片事件
      this.analyzerUnsubscribe = analysis.onSlice((slice) => {
        devLog(`[VoiceCall] Audio slice received: ${slice.startTime.toFixed(1)}s - ${slice.endTime.toFixed(1)}s`);

        // 更新切片計數
        if (this.currentCall) {
          this.currentCall.sliceCount = (this.currentCall.sliceCount || 0) + 1;
          this.notifyStateChange();
        }

        // 通知外部監聯器
        this.audioSliceListeners.forEach((callback) => {
          try {
            callback(slice);
          } catch (error) {
            console.error('[VoiceCall] Audio slice callback error:', error);
          }
        });
      });

      // 分析對方的音訊串流（偵測詐騙話術）
      console.error(`[VoiceCall] Starting voice analysis on ${this.remoteStream ? 'remote' : 'local'} stream`);
      await analysis.start(streamToAnalyze);

      // 同時啟動 VoiceRiskAnalyzer session（L2 詐騙偵測）
      const sessionId = `call_${this.currentCall?.peerId || 'unknown'}_${Date.now()}`;
      analysis.startSession(sessionId).catch(err => {
        console.error('[VoiceCall] Failed to start risk analysis session:', err);
      });

      if (this.currentCall) {
        this.currentCall.isAnalyzing = true;
        this.notifyStateChange();
      }

      devLog('[VoiceCall] Voice analysis started');
    } catch (error) {
      console.error('[VoiceCall] Failed to start voice analysis:', error);
      // 語音分析失敗不影響通話
    }
  }

  /**
   * 停止語音分析（Phase 5）
   */
  private stopVoiceAnalysis(): void {
    if (this.analyzerUnsubscribe) {
      this.analyzerUnsubscribe();
      this.analyzerUnsubscribe = null;
    }

    callAnalysis?.stop();
    devLog('[VoiceCall] Voice analysis stopped');
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
   * 結束通話（帶原因）
   */
  private endCallWithReason(reason: CallEndReason): void {
    devLog(`[VoiceCall] Call ended: ${reason}`);

    // 清理計時器
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    this.clearConnectTimer();

    // 這一通結束：之後帶這個 callId 的信令一律不屬於任何一通；指紋核對停掉；連線與麥克風馬上關
    //   （以前等 2 秒才關 —— 驗不過指紋的那條連線還多送 2 秒）
    this.guard.end();
    this.fpCheck?.stop();
    this.fpCheck = null;
    this.pendingIce = [];
    this.localStreamReady = null;
    this.closeMedia();

    // 更新狀態
    this.callState = CallState.ENDED;
    if (this.currentCall) {
      this.currentCall.state = CallState.ENDED;
    }
    this.notifyStateChange();

    // 延遲重置，讓 UI 有時間顯示結束狀態
    setTimeout(() => {
      this.resetCall();
    }, 2000);
  }

  /** 關掉 PC、停掉自己的麥克風／鏡頭、放掉對方的串流 */
  private closeMedia(): void {
    this.stopVoiceAnalysis();
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    this.remoteStream = null;
    this.verified = false;
  }

  /**
   * 重置通話狀態
   */
  private resetCall(): void {
    devLog(`[VoiceCall] resetCall - previous state: ${this.callState}`);

    // 關掉連線與串流、這一通的狀態（拒接走這裡，不經過 endCallWithReason）
    this.clearConnectTimer();
    this.closeMedia();
    this.guard.end();
    this.fpCheck?.stop();
    this.fpCheck = null;
    this.pendingIce = [];
    this.localStreamReady = null;

    // 重置狀態
    this.callState = CallState.IDLE;
    this.currentCall = null;
    this.notifyStateChange();

    devLog('[VoiceCall] Call reset - state is now IDLE');
  }

  /**
   * 通知狀態變化
   */
  private notifyStateChange(): void {
    this.stateListeners.forEach((callback) => {
      callback(this.callState, this.currentCall || undefined);
    });
  }
}

// 單例導出
export const voiceCallService = new VoiceCallService();

export default voiceCallService;

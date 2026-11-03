/**
 * 1 對 1 通話信令的狀態機（開源第 4 步，docs/DIRECT_SEALED.md；群星 aegisplay-call-check.md 的同一個攻擊）。
 *
 * 以前（群星同款）：
 *   - 通話中（CONNECTING）收到的每一則 offer 都接：關掉現在的連線、用新的 offer 重建 —— 最後一則贏（兩邊都是）。
 *     營運方兩邊各塞一則 offer（from＝對方）→ 兩邊都跟他的 DTLS 指紋連線 ＝ 中間人。
 *   - answer 不看自己是不是發起方、是不是正在等 answer；ICE 不看是哪一通。
 *   - 結束／拒接只看寄件人：上一通的 end 晚到（或被重放）會把新的一通掛掉。
 * 現在每一通有 callId（發起方產生，16 bytes 亂數），每一則信令帶 callId 與 seq（寄件人這一通裡的流水號，嚴格遞增）：
 *   - 只收「目前這一通、對方寄的」信令；會改狀態的（request／accept／reject／end／offer／answer）還要 seq 比上一則大
 *     （其他通的、順序倒退的都丟）。ICE 與指紋不看順序：同一則重放由 directSignal 的 nonce 擋
 *   - 被叫方這一通只接一則 offer；發起方永遠不接 offer
 *   - 發起方只在 have-local-offer（等 answer）時接 answer
 * 純邏輯、不碰 WebRTC 與 MQTT：可以直接移植到群星（信令的傳輸是 directSeal 的 kind 'call'）。
 */

export type CallSig = 'request' | 'accept' | 'reject' | 'end' | 'offer' | 'answer' | 'ice' | 'fp';
export const CALL_SIGS: readonly CallSig[] = ['request', 'accept', 'reject', 'end', 'offer', 'answer', 'ice', 'fp'];
export type CallRole = 'caller' | 'callee';

const CALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_SEQ = 1_000_000;
const MAX_DATA_JSON = 32 * 1024;
const REASONS = new Set(['declined', 'busy', 'no_answer', 'failed', 'unverified']);

/** 一通電話的 id：16 bytes 亂數（base64url，22 字元） */
export function newCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CallSignal {
  sig: CallSig;
  callId: string;
  seq: number;
  /** offer／answer：{ type, sdp }；ice：candidate；fp：DTLS 指紋（dtlsFingerprint） */
  data?: Record<string, unknown>;
  /** request：是不是視訊 */
  video?: boolean;
  /** reject：原因 */
  reason?: string;
}

/** 拆開的 kind 'call' 內容 → 信令（形狀不對 → null） */
export function parseCallSignal(body: Record<string, unknown>): CallSignal | null {
  const { sig, callId, seq, data, video, reason } = body;
  if (typeof sig !== 'string' || !(CALL_SIGS as readonly string[]).includes(sig)) return null;
  if (typeof callId !== 'string' || !CALL_ID_RE.test(callId)) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return null;
  const needsData = sig === 'offer' || sig === 'answer' || sig === 'ice' || sig === 'fp';
  if (needsData) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    try {
      if (JSON.stringify(data).length > MAX_DATA_JSON) return null;
    } catch {
      return null;
    }
    if ((sig === 'offer' || sig === 'answer') && (data as { type?: unknown }).type !== sig) return null;
    if ((sig === 'offer' || sig === 'answer') && typeof (data as { sdp?: unknown }).sdp !== 'string') return null;
  } else if (data !== undefined) {
    return null;
  }
  if (video !== undefined && typeof video !== 'boolean') return null;
  if (reason !== undefined && (typeof reason !== 'string' || !REASONS.has(reason))) return null;
  return {
    sig: sig as CallSig, callId, seq,
    ...(needsData ? { data: data as Record<string, unknown> } : {}),
    ...(video !== undefined ? { video } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export interface CallGuardView {
  callId: string;
  peer: string;
  role: CallRole;
  lastSeq: number;
  offerTaken: boolean;
}

export interface CallGuard {
  /** 開始一通（發起方：自己產生的 callId；被叫方：request 的 callId 與 seq） */
  begin(role: CallRole, peer: string, callId: string, firstPeerSeq?: number): void;
  /** 這一通結束（之後的信令一律不屬於任何一通） */
  end(): void;
  current(): CallGuardView | null;
  /** 我下一則要送的 seq（這一通裡遞增；一開始是 1） */
  nextSeq(): number;
  /** 這一則屬於目前這一通（寄件人是對方、callId 一樣；改狀態的還要 seq 比對方上一則大）→ true 並記下 seq；否則 false、什麼都不動 */
  take(from: string, s: CallSignal): boolean;
  /** 被叫方、這一通還沒接過 offer */
  mayTakeOffer(): boolean;
  markOfferTaken(): void;
  /** 發起方、而且正在等 answer（RTCPeerConnection 的 signalingState 是 have-local-offer） */
  mayTakeAnswer(signalingState: string | null | undefined): boolean;
}

export function createCallGuard(): CallGuard {
  let state: (CallGuardView & { mySeq: number }) | null = null;
  return {
    begin(role, peer, callId, firstPeerSeq = 0) {
      state = { callId, peer, role, lastSeq: firstPeerSeq, offerTaken: false, mySeq: 0 };
    },
    end() { state = null; },
    current() {
      if (!state) return null;
      const { callId, peer, role, lastSeq, offerTaken } = state;
      return { callId, peer, role, lastSeq, offerTaken };
    },
    nextSeq() {
      if (!state) return 1;
      state.mySeq += 1;
      return state.mySeq;
    },
    take(from, s) {
      if (!state || from !== state.peer || s.callId !== state.callId) return false;
      // ICE 與指紋不看順序（審查 M2：晚一點到的 ICE 不該因為後面的先到就被丟；同一則重放由 directSignal 的 nonce 擋）
      if (s.sig === 'ice' || s.sig === 'fp') return true;
      if (!(s.seq > state.lastSeq)) return false;
      state.lastSeq = s.seq;
      return true;
    },
    mayTakeOffer() { return !!state && state.role === 'callee' && !state.offerTaken; },
    markOfferTaken() { if (state) state.offerTaken = true; },
    mayTakeAnswer(signalingState) { return !!state && state.role === 'caller' && signalingState === 'have-local-offer'; },
  };
}

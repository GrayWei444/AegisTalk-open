/**
 * DTLS 指紋核對（開源第 4 步，docs/DIRECT_SEALED.md）：ICE 連上之後，兩邊各自把「我這端的憑證指紋」與「我實際連到的對方憑證指紋」
 * 經已驗證的通道（DIRECT_SEALED，寄件人身分簽章）告訴對方；對方看到的「對方」必須是我、我看到的「對方」必須是他，否則中間有人 →
 * 掛斷／拆掉連線、跟使用者說。信令本身已經封起來了（營運方塞不進 offer），這是第二道：信令哪天出了漏洞，中間人照樣被抓到。
 *
 * 指紋從 getStats() 拿（transport 的 localCertificateId／remoteCertificateId → certificate 的 fingerprintAlgorithm／fingerprint，
 * 也就是 DTLS 握手實際用的憑證）；拿不到才看 SDP 的 a=fingerprint（DTLS 會拿對方的憑證去比對方 SDP 的指紋，所以兩者一致）。
 * 寫法正規化成「演算法小寫 + 空白 + 十六進位大寫冒號分隔」。
 *
 * 時序（createFingerprintCheck）：PC 建好就建一個，ICE 連上時 start() —— 讀自己的、送出去（got：我已經驗過你的了嗎）；
 * 收到對方的（receive）就比，對得上就 onVerified、對方還沒拿到我的就再回一次；對不上 → onFail('mismatch')。
 * 送出去的每 resendMs 重送一次，直到對方說他拿到了；timeoutMs 內沒驗過 → onFail('timeout')。
 * 純邏輯（PC 只用到 getStats／localDescription／remoteDescription，計時器可注入）：可以直接移植到群星。
 */

export interface DtlsFingerprints {
  /** 我這端的憑證指紋 */
  local: string[];
  /** 我實際連到的對方憑證指紋 */
  remote: string[];
}

/** 對方送來的（多一個 got：他驗過我的了沒） */
export interface FingerprintMessage extends DtlsFingerprints {
  got: boolean;
}

const HEX_FP = /^[0-9A-F]{2}(:[0-9A-F]{2}){15,63}$/;
const ALG = /^sha-(1|224|256|384|512)$/;
const MAX_FPS = 4;

/** 演算法＋指紋 → 正規寫法（不合格 → null） */
export function normalizeFingerprint(alg: unknown, value: unknown): string | null {
  if (typeof alg !== 'string' || typeof value !== 'string') return null;
  const a = alg.trim().toLowerCase();
  const v = value.trim().toUpperCase();
  return ALG.test(a) && HEX_FP.test(v) ? `${a} ${v}` : null;
}

/** SDP 裡的 a=fingerprint（session 層與每個 m= 段的，去重） */
export function fingerprintsFromSdp(sdp: unknown): string[] {
  if (typeof sdp !== 'string') return [];
  const out = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    const fp = normalizeFingerprint(m[1], m[2]);
    if (fp) out.add(fp);
  }
  return [...out].slice(0, MAX_FPS);
}

type StatsLike = { forEach(cb: (report: Record<string, unknown>) => void): void; get?(id: string): unknown };

function certFingerprint(stats: Map<string, Record<string, unknown>>, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const cert = stats.get(id);
  return cert ? normalizeFingerprint(cert.fingerprintAlgorithm, cert.fingerprint) : null;
}

/**
 * 這條 PC 的指紋：getStats 的 transport（DTLS 已連上的）→ 兩張憑證；拿不到的那一邊用 SDP 的。
 * 兩邊都要有，否則 null（還沒連上、或瀏覽器不給）。
 */
export async function readFingerprints(pc: {
  getStats(): Promise<StatsLike>;
  localDescription?: { sdp?: string } | null;
  remoteDescription?: { sdp?: string } | null;
}): Promise<DtlsFingerprints | null> {
  const local = new Set<string>();
  const remote = new Set<string>();
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((r) => { if (typeof r.id === 'string') byId.set(r.id, r); });
    for (const r of byId.values()) {
      if (r.type !== 'transport' || (r.dtlsState !== undefined && r.dtlsState !== 'connected')) continue;
      const l = certFingerprint(byId, r.localCertificateId);
      const rm = certFingerprint(byId, r.remoteCertificateId);
      if (l) local.add(l);
      if (rm) remote.add(rm);
    }
  } catch { /* 拿不到 stats：用 SDP */ }
  if (local.size === 0) for (const fp of fingerprintsFromSdp(pc.localDescription?.sdp)) local.add(fp);
  if (remote.size === 0) for (const fp of fingerprintsFromSdp(pc.remoteDescription?.sdp)) remote.add(fp);
  if (local.size === 0 || remote.size === 0) return null;
  return { local: [...local].slice(0, MAX_FPS), remote: [...remote].slice(0, MAX_FPS) };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && b.length > 0 && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

/** 我看到的對方 ＝ 他說的他自己、他看到的對方 ＝ 我自己（兩邊都不能是空的） */
export function fingerprintsMatch(mine: DtlsFingerprints, theirs: DtlsFingerprints): boolean {
  return sameSet(mine.local, theirs.remote) && sameSet(mine.remote, theirs.local);
}

/** 對方送來的 data（形狀不對 → null） */
export function parseFingerprintMessage(data: unknown): FingerprintMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const list = (v: unknown): string[] | null => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_FPS) return null;
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string' || x.length > 250) return null;
      const [alg, fp] = x.split(' ');
      const norm = normalizeFingerprint(alg, fp);
      if (!norm || norm !== x) return null;
      out.push(norm);
    }
    return out;
  };
  const local = list(d.local);
  const remote = list(d.remote);
  if (!local || !remote || typeof d.got !== 'boolean') return null;
  return { local, remote, got: d.got };
}

export type FingerprintFailure = 'mismatch' | 'timeout' | 'unreadable';
export type FingerprintCheckState = 'idle' | 'started' | 'verified' | 'failed' | 'stopped';

export interface FingerprintCheck {
  /** ICE 連上了：讀自己的、送出去、開始計時 */
  start(): void;
  /** 對方送來的（還沒 start 也可以先收著） */
  receive(data: unknown): void;
  /** PC 關了、通話結束：不再送、不再回呼 */
  stop(): void;
  readonly state: FingerprintCheckState;
  /** 讀到的自己這一邊（測試／模擬看） */
  readonly mine: DtlsFingerprints | null;
}

export interface FingerprintCheckOptions {
  read: () => Promise<DtlsFingerprints | null>;
  send: (fp: DtlsFingerprints, got: boolean) => void;
  onVerified: () => void;
  onFail: (reason: FingerprintFailure) => void;
  /** 多久沒驗過就算失敗（預設 30 秒） */
  timeoutMs?: number;
  /** 多久重送一次（預設 5 秒） */
  resendMs?: number;
  /** 讀不到自己的指紋時重讀幾次、每次間隔多久（預設 10 次 × 300 ms） */
  readTries?: number;
  readIntervalMs?: number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}

export function createFingerprintCheck(o: FingerprintCheckOptions): FingerprintCheck {
  const timers = o.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const resendMs = o.resendMs ?? 5_000;
  const readTries = o.readTries ?? 10;
  const readIntervalMs = o.readIntervalMs ?? 300;
  let state: FingerprintCheckState = 'idle';
  let mine: DtlsFingerprints | null = null;
  let pending: FingerprintMessage | null = null;
  let theirsOk = false;
  let peerGotMine = false;
  let timeoutHandle: unknown = null;
  let resendHandle: unknown = null;
  let resendsLeft = Math.max(1, Math.ceil((2 * timeoutMs) / resendMs));

  const live = () => state === 'started' || state === 'verified';
  const clearAll = () => {
    if (timeoutHandle !== null) timers.clearTimeout(timeoutHandle);
    if (resendHandle !== null) timers.clearTimeout(resendHandle);
    timeoutHandle = null;
    resendHandle = null;
  };
  const fail = (reason: FingerprintFailure) => {
    if (!live()) return;
    state = 'failed';
    clearAll();
    o.onFail(reason);
  };
  const scheduleResend = () => {
    if (resendHandle !== null) timers.clearTimeout(resendHandle);
    resendHandle = null;
    if (!live() || !mine || peerGotMine || resendsLeft <= 0) return;
    resendHandle = timers.setTimeout(() => {
      resendHandle = null;
      if (!live() || !mine || peerGotMine) return;
      resendsLeft -= 1;
      o.send(mine, theirsOk);
      scheduleResend();
    }, resendMs);
  };
  const evaluate = (theirs: FingerprintMessage) => {
    if (!mine || !live()) return;
    if (!fingerprintsMatch(mine, theirs)) {
      fail('mismatch');
      return;
    }
    if (theirs.got) peerGotMine = true;
    const first = !theirsOk;
    theirsOk = true;
    // 他還沒拿到我的（他說 got:false）→ 回一次（帶 got:true，他驗完就不必再回）
    if (!theirs.got) o.send(mine, true);
    if (first && state === 'started') {
      state = 'verified';
      if (timeoutHandle !== null) timers.clearTimeout(timeoutHandle);
      timeoutHandle = null;
      o.onVerified();
    }
    scheduleResend();
  };
  const readMine = async (triesLeft: number): Promise<void> => {
    if (!live()) return;
    let fp: DtlsFingerprints | null = null;
    try { fp = await o.read(); } catch { fp = null; }
    if (!live()) return;
    if (!fp) {
      if (triesLeft <= 1) { fail('unreadable'); return; }
      await new Promise<void>((resolve) => { timers.setTimeout(resolve, readIntervalMs); });
      return readMine(triesLeft - 1);
    }
    mine = fp;
    o.send(fp, theirsOk);
    scheduleResend();
    if (pending) {
      const p = pending;
      pending = null;
      evaluate(p);
    }
  };
  return {
    start() {
      if (state !== 'idle') return;
      state = 'started';
      timeoutHandle = timers.setTimeout(() => { timeoutHandle = null; if (state === 'started') fail('timeout'); }, timeoutMs);
      void readMine(readTries);
    },
    receive(data) {
      if (state === 'failed' || state === 'stopped') return;
      const theirs = parseFingerprintMessage(data);
      if (!theirs) return;
      if (!mine) { pending = theirs; return; }
      evaluate(theirs);
    },
    stop() {
      if (state === 'stopped') return;
      state = 'stopped';
      clearAll();
    },
    get state() { return state; },
    get mine() { return mine; },
  };
}

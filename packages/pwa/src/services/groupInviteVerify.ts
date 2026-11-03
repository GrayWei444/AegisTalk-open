/**
 * 邀請的整條鏈放到 Web Worker 驗（W1 待辦，W2 docs/GROUP_LOG_WIRING_W2.md）。實測（VPS 上的 Node、嚴格 Ed25519）：
 * 52 筆 0.14 秒、202 筆 0.38 秒、502 筆 0.82 秒、1002 筆 1.6 秒，約 1.6 ms／筆；手機更慢 —— 在主執行緒會卡畫面。
 * Worker 用同一份 WASM 驗簽、同一份 verifyInvite；結果是純資料（structured clone），回來後重新 deepFreeze。
 * 沒有 Worker（測試、舊 WebView）、Worker 載不起來、當掉、回了怪東西 → 在主執行緒驗（絕不跳過），之後不再用 Worker。
 * 逾時（很長的鏈、手機很忙；時限隨鏈長，至少 60 秒）→ 收掉那個 Worker、換一個新的再試一次（審查 W2 #10）；新的也逾時 →
 * 丟 'invite-verify-timeout'：加入的流程（runJoin）照退避稍後再試，不在主執行緒驗一條這麼長的鏈（審查 W2 複審 #10）。
 */
import { deepFreeze, verifyInvite, type InviteResult, type VerifyFn } from './groupState';
import { diagLog } from '../utils/diagLog';

export interface InviteVerifyParams {
  chain: unknown[];
  gid: string;
  me: string;
  key: { kid: string; key: Uint8Array };
}

/** Worker 的最小介面（測試可以給假的） */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** 每筆 commit 給 Worker 的時間（實測 VPS 1.6 ms／筆，手機留十幾倍） */
const PER_COMMIT_TIMEOUT_MS = 25;

/** App 用的 Worker（Vite 依這個寫法把 groupInviteWorker.ts 另外打包） */
export function makeInviteWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./groupInviteWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

export function createInviteVerifier(p: {
  verify: VerifyFn;
  makeWorker?: () => WorkerLike | null;
  timeoutMs?: number;
}): (params: InviteVerifyParams) => Promise<InviteResult> {
  let worker: WorkerLike | null | undefined;
  let seq = 0;
  const waiting = new Map<number, { resolve: (r: InviteResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  /** 收掉現在這個 Worker；permanent ＝ 之後都在主執行緒驗，否則下次重建一個新的 */
  function retire(why: string, permanent: boolean): void {
    if (permanent) console.error('[groupInvite] worker unavailable, verifying on the main thread:', why);
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      waiting.delete(id);
      w.reject(new Error(why));
    }
    try { worker?.terminate(); } catch { /* 已經沒了 */ }
    worker = permanent ? null : undefined;
  }

  function get(): WorkerLike | null {
    if (worker !== undefined) return worker;
    try {
      worker = p.makeWorker?.() ?? null;
    } catch (e) {
      worker = null;
      console.error('[groupInvite] cannot start the worker:', (e as Error)?.message ?? e);
    }
    if (!worker) return null;
    worker.onmessage = (ev) => {
      const { id, result, error } = (ev.data ?? {}) as { id?: number; result?: InviteResult; error?: string };
      const w = typeof id === 'number' ? waiting.get(id) : undefined;
      if (!w) return;
      waiting.delete(id as number);
      clearTimeout(w.timer);
      if (error !== undefined || !result || typeof result.ok !== 'boolean') w.reject(new Error(error ?? 'bad worker reply'));
      else w.resolve(result);
    };
    worker.onerror = (ev) => retire(String((ev as { message?: string })?.message ?? 'worker error'), true);
    return worker;
  }

  const onMainThread = (params: InviteVerifyParams) => verifyInvite({ ...params, verify: p.verify });

  function inWorker(w: WorkerLike, params: InviteVerifyParams): Promise<InviteResult> {
    return new Promise<InviteResult>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('timeout'));
      }, p.timeoutMs ?? Math.max(DEFAULT_TIMEOUT_MS, params.chain.length * PER_COMMIT_TIMEOUT_MS));
      waiting.set(id, { resolve, reject, timer });
      w.postMessage({ id, chain: params.chain, gid: params.gid, me: params.me, kid: params.key.kid, key: params.key.key });
    });
  }

  return async (params) => {
    const t0 = Date.now();
    let timeouts = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = get();
      if (!w) break;
      try {
        const r = await inWorker(w, params);
        diagLog('[DIAG:GLOG] invite chain verified in the worker:', params.chain.length, 'commits in', Date.now() - t0, 'ms');
        return r.ok ? { ok: true, view: deepFreeze(r.view), addedBy: r.addedBy } : r;
      } catch (e) {
        const why = (e as Error)?.message ?? String(e);
        // 逾時：換一個新的 Worker 再試一次；載不起來、當掉、回了怪東西：之後都在主執行緒（onerror 已經處理過的不再處理）
        if (worker === w) retire(why, why !== 'timeout');
        if (why !== 'timeout') break;
        timeouts++;
      }
    }
    if (timeouts === 2) throw new Error('invite-verify-timeout');   // 稍後再試（runJoin 退避），不卡主執行緒
    // 沒有 Worker 或 Worker 回不了：在這裡驗，不跳過
    const r = await onMainThread(params);
    diagLog('[DIAG:GLOG] invite chain verified on the main thread:', params.chain.length, 'commits in', Date.now() - t0, 'ms');
    return r;
  };
}

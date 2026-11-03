/**
 * 群組 log 的 HTTP client（伺服器端 api/group_log_routes.py）：
 *   append：POST /api/group-log/{gid} {blob, pubkey, timestamp, request_id, signature}，帳號簽章跟 /api/mqtt/token 同一套：
 *     簽排序過的 {action: "group_log_append", pubkey, gid, blob_sha256, timestamp, request_id}（blob_sha256 ＝ blob 的
 *     UTF-8 bytes 的 SHA-256 hex，伺服器自己算一次核對），時間用校正到伺服器的時鐘，request_id 每次新的。
 *   fetch：GET /api/group-log/{gid}?after=&limit= → {entries: [{seq, blob}], head, more}（不用簽章，見 routes 的說明）。
 * 網路錯誤、5xx、429、409（request_id 撞到）會退避重試；400／401／403／413／507 不重試（重送也一樣）。
 * 純 fetch 包裝，沒有模組層級狀態：signer 與時鐘由呼叫端給（App 用解鎖中的身分與 mqttService 的伺服器時間）。
 */
import { canonicalJson } from './mqttCredential';
import type { LogEntry } from './groupLogEntry';

export interface LogSigner {
  publicKey: string;
  sign: (data: Uint8Array) => Uint8Array;
}

export interface LogPage {
  entries: LogEntry[];
  head: number;
  more: boolean;
}

export interface GroupLogClient {
  append(gid: string, blob: string): Promise<number>;
  fetch(gid: string, after: number, limit?: number): Promise<LogPage>;
}

export class GroupLogHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`group-log:${status}:${code}`);
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const PAGE_LIMIT = 200;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function errorOf(r: Response): Promise<GroupLogHttpError> {
  let code = 'error';
  try {
    const detail = ((await r.json()) as { detail?: unknown }).detail;
    if (typeof detail === 'string') code = detail;
  } catch { /* 不是 JSON */ }
  return new GroupLogHttpError(r.status, code);
}

function validEntries(raw: unknown): LogEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LogEntry[] = [];
  for (const e of raw) {
    const o = e as { seq?: unknown; blob?: unknown } | null;
    if (!o || typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 1 || typeof o.blob !== 'string') return null;
    out.push({ seq: o.seq, blob: o.blob });
  }
  return out;
}

export function createGroupLogClient(p: {
  base: string;
  signer: () => LogSigner | null;
  /** 校正到伺服器的現在時間（ms） */
  serverNow: () => number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}): GroupLogClient {
  const doFetch: FetchFn = p.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (e) {
        last = e;
        if (e instanceof GroupLogHttpError && !RETRYABLE.has(e.status)) throw e;
        if (i < MAX_ATTEMPTS - 1) await sleep(Math.min(8000, 500 * 2 ** i));
      }
    }
    throw last;
  }

  async function appendOnce(gid: string, blob: string): Promise<number> {
    const signer = p.signer();
    if (!signer) throw new GroupLogHttpError(0, 'identity-locked');
    const timestamp = Math.floor(p.serverNow() / 1000);
    const requestId = randomHex(16);
    const signed = { action: 'group_log_append', pubkey: signer.publicKey, gid, blob_sha256: await sha256Hex(blob), timestamp, request_id: requestId };
    const signature = b64(signer.sign(new TextEncoder().encode(canonicalJson(signed))));
    const r = await doFetch(`${p.base}/api/group-log/${encodeURIComponent(gid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob, pubkey: signer.publicKey, timestamp, request_id: requestId, signature }),
    });
    if (!r.ok) throw await errorOf(r);
    const seq = ((await r.json()) as { seq?: unknown }).seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new GroupLogHttpError(r.status, 'bad-response');
    return seq;
  }

  async function fetchOnce(gid: string, after: number, limit: number): Promise<LogPage> {
    const r = await doFetch(`${p.base}/api/group-log/${encodeURIComponent(gid)}?after=${after}&limit=${limit}`, { method: 'GET' });
    if (!r.ok) throw await errorOf(r);
    const body = (await r.json()) as { entries?: unknown; head?: unknown; more?: unknown };
    const entries = validEntries(body.entries);
    if (!entries || typeof body.head !== 'number' || !Number.isSafeInteger(body.head) || typeof body.more !== 'boolean') {
      throw new GroupLogHttpError(r.status, 'bad-response');
    }
    return { entries, head: body.head, more: body.more };
  }

  return {
    append: (gid, blob) => withRetry(() => appendOnce(gid, blob)),
    fetch: (gid, after, limit = PAGE_LIMIT) => {
      if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(new GroupLogHttpError(0, 'bad-after'));
      return withRetry(() => fetchOnce(gid, after, Math.min(PAGE_LIMIT, Math.max(1, limit))));
    },
  };
}

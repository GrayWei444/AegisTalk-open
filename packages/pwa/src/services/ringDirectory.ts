/**
 * 推播來電的 JS 那一條路（service worker 收到的 Web Push；開源第 5d 步，docs/DIRECT_SEALED.md §4「Push ring」）要的本機資料，
 * 與「這則推播能不能響鈴、顯示誰」的判斷（decideRing）。原生 App 的那一條在 AegisFCMService／RingToken.kt，規則相同。
 *
 * 推播本身沒有任何名字（伺服器只帶 type、isVideoCall、senderPubkey 與來電者簽的 ringToken）。響不響、叫什麼名字只看：
 *   - 這台存的資料：我是誰、好友（沒封鎖的）的公鑰 → 名字、API 的時鐘差（最多採信 ±5 分鐘）—— 頁面登入後同步進來（ringSync.ts），
 *     登出／被踢／換機時清掉
 *   - token 驗得過（ringToken.verifyRingToken：好友簽的、寄給我、±5 分鐘、這個 callId 沒響過）
 * 驗不過（偽造、陌生人、封鎖的、重放、太舊、沒有 token、資料還沒同步）→ null：service worker 只顯示一則不帶名字的一般通知。
 *
 * 存在 IndexedDB（service worker 讀得到；localStorage 讀不到）：
 *   aegis-ring / dir   'current' → { me, friends: { 公鑰: 名字 }, offsetMs, at }
 *   aegis-ring / seen  callId → 到期時間（一個 callId 只響一次）
 * 這個檔不碰 window、document、Capacitor：service worker 的 bundle 也用它。
 */
import {
  AEGISTALK_RING_PREFIX, clampRingOffset, ringSeenToPrune, verifyRingToken, type Ed25519Verify, type RingReplayStore,
} from './ringToken';

export interface RingDirectory {
  /** 我的身分公鑰 */
  me: string;
  /** 好友（沒封鎖的）：身分公鑰 → 本機存的名字 */
  friends: Record<string, string>;
  /** 有上限的伺服器時鐘 − 本機時鐘（毫秒，最多 ±5 分鐘：讀、寫都再夾一次） */
  offsetMs: number;
  /** 寫入的時間（本機時鐘） */
  at: number;
}

export interface RingDecision {
  /** 本機存的名字（不是推播給的） */
  name: string;
  /** token 簽的「是不是視訊」 */
  video: boolean;
  /** 那一通的 callId */
  callId: string;
}

const DB_NAME = 'aegis-ring';
const DB_VERSION = 1;
const DIR = 'dir';
const SEEN = 'seen';
const CURRENT = 'current';
/** 看過的 callId 最多記幾個（多的先丟最早到期的） */
const MAX_SEEN = 256;
const MAX_FRIENDS = 5000;
const MAX_NAME = 64;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(DIR)) db.createObjectStore(DIR);
      if (!db.objectStoreNames.contains(SEEN)) db.createObjectStore(SEEN);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** 名單的形狀（讀回來的、要寫的都過一次）：不合格 → null */
export function cleanRingDirectory(x: unknown): RingDirectory | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const d = x as Record<string, unknown>;
  if (typeof d.me !== 'string' || !d.me || typeof d.offsetMs !== 'number' || !Number.isFinite(d.offsetMs)) return null;
  if (!d.friends || typeof d.friends !== 'object' || Array.isArray(d.friends)) return null;
  const friends: Record<string, string> = {};
  let n = 0;
  for (const [pk, name] of Object.entries(d.friends as Record<string, unknown>)) {
    if (typeof pk !== 'string' || typeof name !== 'string' || pk === d.me) continue;
    if (++n > MAX_FRIENDS) break;
    friends[pk] = name.trim().slice(0, MAX_NAME);
  }
  return { me: d.me, friends, offsetMs: clampRingOffset(d.offsetMs), at: typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : 0 };
}

export async function saveRingDirectory(dir: RingDirectory): Promise<void> {
  const clean = cleanRingDirectory(dir);
  if (!clean) throw new Error('ringDirectory: bad directory');
  await withDb(async (db) => {
    const tx = db.transaction([DIR, SEEN], 'readwrite');
    const prev = cleanRingDirectory(await req(tx.objectStore(DIR).get(CURRENT)));
    // 換了帳號：上一個帳號看過的 callId 不必留
    if (prev && prev.me !== clean.me) tx.objectStore(SEEN).clear();
    tx.objectStore(DIR).put(clean, CURRENT);
    await done(tx);
  });
}

export async function loadRingDirectory(): Promise<RingDirectory | null> {
  return withDb(async (db) => cleanRingDirectory(await req(db.transaction(DIR, 'readonly').objectStore(DIR).get(CURRENT))));
}

/** 登出／被踢／換機：名單與看過的 callId 都清掉 */
export async function clearRingDirectory(): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([DIR, SEEN], 'readwrite');
    tx.objectStore(DIR).clear();
    tx.objectStore(SEEN).clear();
    await done(tx);
  });
}

/** IndexedDB 裡的「看過的 callId」：記錄留到 until，照本機時鐘清（ringToken.ringSeenToPrune） */
export function idbRingReplay(clock: () => number = () => Date.now()): RingReplayStore {
  return {
    seen: (callId) => withDb(async (db) => {
      const until = await req(db.transaction(SEEN, 'readonly').objectStore(SEEN).get(callId));
      return typeof until === 'number' && until >= clock();
    }),
    remember: (callId, until) => withDb(async (db) => {
      const tx = db.transaction(SEEN, 'readwrite');
      const store = tx.objectStore(SEEN);
      const keys = await req(store.getAllKeys());
      const untils = await req(store.getAll());
      const entries = keys.map((k, i) => [String(k), typeof untils[i] === 'number' ? (untils[i] as number) : 0] as const);
      for (const k of ringSeenToPrune(entries, clock(), MAX_SEEN)) store.delete(k);
      store.put(until, callId);
      await done(tx);
    }),
  };
}

/** WebCrypto 的 Ed25519 驗章（service worker 沒有 App 的 WASM）；瀏覽器不支援 → false（不響，只顯示一般通知） */
export const webCryptoEd25519Verify: Ed25519Verify = async (publicKey, data, signature) => {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return false;
    const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const key = await subtle.importKey('raw', buf(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, key, buf(signature), buf(data));
  } catch {
    return false;
  }
};

export interface DecideRingDeps {
  directory: () => Promise<RingDirectory | null>;
  replay: RingReplayStore;
  verify: Ed25519Verify;
  prefix?: string;
}

/**
 * 推播的內容 → 能不能響鈴、顯示誰（純邏輯，資料由 deps 給：測試、模擬直接呼叫）。
 * 只有 type incoming_call、token 驗過、寄件人是名單上的好友才回名字；其他一律 null。
 */
export async function decideRingWith(data: unknown, deviceNow: number, deps: DecideRingDeps): Promise<RingDecision | null> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'incoming_call' || typeof d.ringToken !== 'string') return null;
  const dir = await deps.directory().catch(() => null);
  if (!dir) return null;
  const verdict = await verifyRingToken({
    token: d.ringToken,
    prefix: deps.prefix ?? AEGISTALK_RING_PREFIX,
    me: dir.me,
    sender: typeof d.senderPubkey === 'string' ? d.senderPubkey : null,
    friendKey: (pk) => (Object.prototype.hasOwnProperty.call(dir.friends, pk) ? pk : null),
    verify: deps.verify,
    now: deviceNow + clampRingOffset(dir.offsetMs),
    replay: deps.replay,
  });
  if (!verdict.ok) return null;
  return { name: dir.friends[verdict.from] ?? '', video: verdict.video, callId: verdict.callId };
}

/** service worker 用：IndexedDB 的名單與看過的 callId、WebCrypto 驗章 */
export function decideRing(data: unknown, deviceNow: number): Promise<RingDecision | null> {
  return decideRingWith(data, deviceNow, { directory: loadRingDirectory, replay: idbRingReplay(), verify: webCryptoEd25519Verify })
    .catch(() => null);
}

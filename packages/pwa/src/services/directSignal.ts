/**
 * DIRECT_SEALED 的 App 這一層（開源第 4 步，docs/DIRECT_SEALED.md；格式與規則在 directSeal.ts）。
 *
 * 送：sendDirect(to, { kind, ... }) 用解鎖中的身分封好，經 MQTT 型別 direct_sealed 送到對方收件箱；同一個收件人照呼叫的順序送。
 *   - DataChannel 的信令：transient（連著才送、不排隊；broker 那邊 2 分鐘過期 —— 過期的信令只會搗亂）
 *   - 通話的信令：排隊，但排超過 60 秒就不送（ttlMs；broker 那邊同樣過期）
 *   - 個人資料、預備金鑰請求、刪除：排隊（離線時 broker 替對方排 24 小時）
 * 收：startDirectSignal(deps) 掛 MQTT 的 direct_sealed：
 *   1. 同一個寄件人的一則一則依序處理（拆封是 await，後到的 ICE 不能比 offer 先套上）
 *   2. 寄件人在我這台存的身分金鑰（好友或同群成員）→ 一般額度；不認得的 → 很小的額度（每人＋全部合計）。封鎖的人
 *      （封鎖名單查不了也一樣）一律不拆
 *   3. 用存著的那把金鑰驗簽章（不是主題上的寄件人那一節），內容綁 from／to／iat／nonce，照種類判新鮮度（directSeal，
 *      校正到伺服器的時鐘）
 *   4. 不認得的人只能送 DataChannel 信令（群組成員、我的名冊還沒追上 —— webrtc 再看群組金鑰證明或先收著）；其他種類一律丟
 *   5. 同一則（寄件人＋nonce）只收一次；個人資料、預備金鑰請求、來電還要 iat 比上一則新（存在 localStorage，重開也記得）
 *   6. 交給那一種的 handler（onDirect）；還沒註冊的先收著一下（冷啟動時通話／webrtc 服務比 MQTT 晚掛上）
 * 計數（directStats）給模擬與測試看。
 */
import { mqttService, MessageType, type MqttMessage } from './mqtt';
import { currentSealer, verify, x25519 } from './groupKeyDelivery';
import {
  AEGISTALK_DIRECT, DirectReplayGuard, openDirect, sealDirect, isDirectKind,
  type DirectBody, type DirectKind, type MarkStore,
} from './directSeal';
import { createPeerBudget } from './peerBudget';

export type DirectHandler = (from: string, body: DirectBody) => void | Promise<void>;

const handlers = new Map<DirectKind, DirectHandler>();
/** 還沒有 handler 的（冷啟動）：每一種最多 PENDING_PER_KIND 則、PENDING_MS 內 */
const pendingByKind = new Map<DirectKind, Array<{ from: string; body: DirectBody; at: number }>>();
const PENDING_PER_KIND = 64;
const PENDING_MS = 60_000;
const stats: Record<string, number> = {};
const stat = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

/** 通話控制（request／accept／reject／end）排隊最多多久（離線排太久，對方早就放棄那通電話了） */
export const CALL_CONTROL_TTL_MS = 60_000;
const DURABLE_TTL_MS = 24 * 60 * 60_000;

/** 註冊某一種的 handler（同一種只有一個；回傳的函式只會拿掉自己）。之前收著的這一種馬上交給它 */
export function onDirect(kind: DirectKind, handler: DirectHandler): () => void {
  handlers.set(kind, handler);
  const waiting = pendingByKind.get(kind);
  if (waiting?.length) {
    pendingByKind.delete(kind);
    const now = Date.now();
    queueMicrotask(() => {
      for (const w of waiting) {
        if (now - w.at > PENDING_MS || handlers.get(kind) !== handler) continue;
        void Promise.resolve().then(() => handler(w.from, w.body)).catch((err) => console.error(`[DirectSignal] ${kind} handler failed:`, err));
      }
    });
  }
  return () => { if (handlers.get(kind) === handler) handlers.delete(kind); };
}

export function directStats(): Record<string, number> {
  return { ...stats };
}

export interface DirectSendOptions {
  /** 連著才送、不排隊（信令） */
  transient?: boolean;
  /** 排隊最多多久（預設 24 小時） */
  ttlMs?: number;
}

/** 每個收件人一條送出的順序（封是 await：後呼叫的不能比先呼叫的早上 broker —— 通話的 seq、ICE 在 offer 之後） */
const sendChains = new Map<string, Promise<unknown>>();

async function sealAndSend(to: string, body: Record<string, unknown> & { kind: DirectKind }, opts: DirectSendOptions): Promise<boolean> {
  const s = currentSealer();
  if (!s) return false;
  const envelope = await sealDirect({ from: s.me, to, body, sign: s.sign, now: mqttService.serverNow(), scheme: AEGISTALK_DIRECT }, x25519);
  if (currentSealer()?.me !== s.me) return false;
  stat(`sent:${body.kind}`);
  if (opts.transient) return mqttService.sendTransientToUser(to, MessageType.DIRECT_SEALED, envelope);
  mqttService.sendToUser(to, MessageType.DIRECT_SEALED, envelope, { ttlMs: opts.ttlMs ?? DURABLE_TTL_MS });
  return true;
}

/**
 * 封好送給 to；沒有解鎖的身分、或封的時候換了帳號 → false（transient 的：沒連上也是 false）。
 * 同一個收件人的照呼叫的順序上 broker（審查 M2：以前兩則同時封，先封好的先送 —— 通話的 seq 倒退、被收端丟掉）
 */
export function sendDirect(to: string, body: Record<string, unknown> & { kind: DirectKind }, opts: DirectSendOptions = {}): Promise<boolean> {
  const prev = sendChains.get(to) ?? Promise.resolve();
  const next = prev.then(() => sealAndSend(to, body, opts));
  const settled = next.catch(() => undefined);
  sendChains.set(to, settled);
  void settled.then(() => { if (sendChains.get(to) === settled) sendChains.delete(to); });
  return next;
}

// ───────── 幾種固定的送法 ─────────

export interface ProfilePayload { displayName: string; avatar?: string; initEph?: string }

/** 個人資料（名字、頭像）給一個好友；initEph：收下他哪一封 X3DH_INIT（他的「等待確認」只認這個，審查 M1） */
export function sendProfileUpdate(to: string, profile: ProfilePayload): Promise<boolean> {
  return sendDirect(to, {
    kind: 'profile', displayName: profile.displayName, avatar: profile.avatar ?? '',
    ...(typeof profile.initEph === 'string' ? { initEph: profile.initEph } : {}),
  });
}

/** 個人資料給每個好友（每人各封一封） */
export function broadcastProfileUpdate(friendPublicKeys: readonly string[], profile: ProfilePayload): void {
  for (const pk of friendPublicKeys) {
    sendProfileUpdate(pk, { displayName: profile.displayName, avatar: profile.avatar })
      .catch((err) => console.error('[DirectSignal] profile update failed:', err));
  }
}

/** 請對方重新發起 X3DH（附我的 bundle：他沒存過、或存的是舊的） */
export function sendPrekeyRequest(to: string, bundle: { signedPreKey?: string; signature?: string } | null): Promise<boolean> {
  return sendDirect(to, {
    kind: 'prekey',
    ...(bundle?.signedPreKey && bundle.signature ? { signedPreKey: bundle.signedPreKey, signature: bundle.signature } : {}),
  });
}

/** 刪掉我寄給他的一則 1 對 1 訊息 */
export function sendDeleteMessage(to: string, messageId: string): Promise<boolean> {
  return sendDirect(to, { kind: 'delete', messageId });
}

// ───────── 收 ─────────

export interface DirectReceiveDeps {
  me: string;
  /** 寄件人在我這台存的身分金鑰（好友、同群成員）；不認得 → null。冷啟動時清單可能還在載：可以等一下 */
  storedIdentity(pk: string): Promise<string | null>;
  isBlocked(pk: string): Promise<boolean>;
  /** 個人資料／預備金鑰請求的「上一則 iat」（每個帳號一份） */
  marks: MarkStore;
  /** 時鐘（測試注入；預設 mqttService） */
  serverNow?: () => number;
  boundedNow?: () => number;
}

const SEALER_WAIT_MS = 8_000;

async function sealerFor(me: string): Promise<ReturnType<typeof currentSealer>> {
  const deadline = Date.now() + SEALER_WAIT_MS;
  for (;;) {
    const s = currentSealer();
    if (s && s.me === me) return s;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 一個帳號的 MarkStore（localStorage；壞掉、沒有 localStorage → 記憶體） */
export function localStorageMarks(owner: string, maxEntries = 2000): MarkStore {
  const key = `aegis_direct_marks_v1:${owner}`;
  let mem: Record<string, number> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) mem[k] = v;
    }
  } catch { mem = {}; }
  return {
    get: (k) => mem[k],
    set: (k, v) => {
      mem[k] = v;
      const keys = Object.keys(mem);
      if (keys.length > maxEntries) {
        // 最舊的先丟（iat 最小的）
        keys.sort((a, b) => mem[a] - mem[b]).slice(0, keys.length - maxEntries).forEach((x) => { delete mem[x]; });
      }
      try { localStorage.setItem(key, JSON.stringify(mem)); } catch { /* 存不進去：這次開著的期間照樣記得 */ }
    },
  };
}

/** 開始收（AppProvider：身分解鎖、帳號確定之後）；回傳停止的函式。同時只有一份在收（再呼叫一次會先停掉上一份） */
let activeStop: (() => void) | null = null;

export function startDirectSignal(deps: DirectReceiveDeps): () => void {
  activeStop?.();
  const guard = new DirectReplayGuard(deps.marks);
  const knownBudget = createPeerBudget({ capacity: 120, refillPerSec: 2, maxPeers: 512 });
  // 不認得的人（名冊還沒追上的群組成員）：一次 DataChannel 建線是 offer＋十幾個 ICE＋指紋（審查 L4：以前 12 則就用完）
  const strangerBudget = createPeerBudget({ capacity: 40, refillPerSec: 0.5, maxPeers: 256 });
  const strangerTotal = createPeerBudget({ capacity: 120, refillPerSec: 2, maxPeers: 1 });
  const serverNow = deps.serverNow ?? (() => mqttService.serverNow());
  const boundedNow = deps.boundedNow ?? (() => mqttService.boundedNow());
  const chains = new Map<string, Promise<void>>();
  let stopped = false;

  const dispatch = (from: string, body: DirectBody) => {
    const handler = handlers.get(body.kind);
    if (handler) {
      void Promise.resolve().then(() => handler(from, body)).catch((err) => console.error(`[DirectSignal] ${body.kind} handler failed:`, err));
      return;
    }
    const list = (pendingByKind.get(body.kind) ?? []).filter((x) => Date.now() - x.at <= PENDING_MS);
    if (list.length >= PENDING_PER_KIND) { stat('pending-full'); return; }
    pendingByKind.set(body.kind, [...list, { from, body, at: Date.now() }]);
  };

  const handleOne = async (msg: MqttMessage): Promise<void> => {
    const from = msg.from;
    if (stopped || from === deps.me) return;
    if (msg.to !== deps.me) { stat('wrong-recipient'); return; }
    const stored = await deps.storedIdentity(from).catch(() => null);
    if (stopped) return;
    if (stored) {
      if (!knownBudget.take(from)) { stat('budget'); return; }
    } else if (!strangerBudget.take(from) || !strangerTotal.take('*')) {
      stat('budget-stranger');
      return;
    }
    // 封鎖名單查不了 → 當成封鎖（審查 L5：不在查不了的時候放行）
    if (await deps.isBlocked(from).catch(() => true)) { stat('blocked'); return; }
    const s = await sealerFor(deps.me);
    if (!s || stopped) { stat('locked'); return; }
    let body: DirectBody;
    try {
      body = await openDirect({
        envelope: msg.payload, from, to: deps.me, storedKey: stored ?? from, myX25519Private: await s.x25519Private, verify,
        now: serverNow(), scheme: AEGISTALK_DIRECT,
      }, x25519);
    } catch (e) {
      stat('bad-envelope');
      console.error('[DirectSignal] rejected a sealed message from', from.slice(0, 12), (e as Error)?.message);
      return;
    }
    if (stopped || !isDirectKind(body.kind)) return;
    // 不認得的人只能送 DataChannel 信令（webrtc 再看他是不是名冊還沒追上的成員：群組金鑰證明、先收著）
    if (!stored && body.kind !== 'dc') { stat(`stranger:${body.kind}`); return; }
    const verdict = guard.check(body, { server: serverNow(), bounded: boundedNow() });
    if (verdict !== 'ok') { stat(`${verdict}:${body.kind}`); return; }
    stat(`ok:${body.kind}`);
    dispatch(from, body);
  };

  const unsubscribe = mqttService.onMessage(MessageType.DIRECT_SEALED, (msg) => {
    if (stopped || typeof msg.from !== 'string') return;
    if (!chains.has(msg.from) && chains.size >= 1024) { stat('too-many-senders'); return; }
    const prev = chains.get(msg.from) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => handleOne(msg))
      .catch((err) => console.error('[DirectSignal] processing failed:', err))
      .finally(() => { if (chains.get(msg.from) === next) chains.delete(msg.from); });
    chains.set(msg.from, next);
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    chains.clear();
    pendingByKind.clear();
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
}

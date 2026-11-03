/**
 * 群組 log 引擎（groupEngine.ts）共用的型別、封給身分金鑰的信封內容檢查。
 *
 * 信封內容（identitySeal，GROUP_KEY_SEALED，種類上限 GROUP_SEALED_KIND_LIMITS）：
 *   invite { gid, chain: 線上格式的鏈, kid, key, headSeq, baseSeq, parentLogKey? }   我的 add 上鏈之後才送（decision 12）
 *   ack    { gid, id }                                                            收到邀請、加入了（id ＝ 邀請鏈最後那筆）；
 *                                                                                  邀請者沒等到就有限次數重送（W2）
 *   req    { gid, kid }                                                           等某一代的金鑰（keyMissing／waiting）
 *   dist   { gid, kid, key }                                                      回答 req；收端一定照鏈核對 kc
 *   call   通話的 offer／answer／ICE（groupCallService；不經過引擎）
 * 群組主題上的廣播是 group_sealed（groupControl.ts、groupEngineControl.ts；W2 取代 W1 的 group_log_ping）。
 */
import { fromB64, toB64, validCommitId, validGid, validKid, type SignFn, type VerifyFn } from './groupStateCommit';
import type { InviteResult } from './groupState';
import type { X25519Provider } from './identitySeal';
import type { GroupLogClient } from './groupLogClient';
import type { GroupLogStore } from './groupLogStore';
import type { GroupSealed } from './groupControl';
import type { GroupTopic } from './groupTopics';
import type { Group } from '../types';

const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/** UI 用的通知（不含金鑰與內容） */
export interface EngineNotice {
  gid: string;
  kind: 'append-failed' | 'rejected' | 'held' | 'key-wait' | 'conflict' | 'invite-rejected' | 'invite-unacked' | 'removed' | 'left'
    | 'deleted' | 'not-joined' | 'forgotten';
  op?: string;
  reason?: string;
}

export interface EngineDeps {
  me: string;
  sign: SignFn;
  verify: VerifyFn;
  x25519: X25519Provider;
  /** 身分金鑰推出來的 X25519 純量（打開新金鑰封裝包） */
  myX25519Private: () => Promise<Uint8Array>;
  store: GroupLogStore;
  log: GroupLogClient;
  /** 封給 to 的身分金鑰、經他的收件匣送（kind ∈ invite／ack／req／dist） */
  sendSealed: (to: string, body: Record<string, unknown>) => Promise<void>;
  /**
   * 群組主題 mist/group/{tid}/{我} 上發一則 group_sealed（tid ＝ 封它的那一代金鑰推出來的；here／sync 用 QoS0：不替離線的人排隊）。
   * 回 false ＝ 沒送出去（MQTT 沒連上；mqtt 不排隊）：引擎留著，連上再用那時的這一代重封
   */
  publish: (tid: string, envelope: GroupSealed, opts: { qos: 0 | 1 }) => boolean | void;
  /** 驗過的 call／delete 控制訊息（寄件人是套上的名冊上的成員、目前這一代、新鮮、沒重複） */
  onControl?: (gid: string, from: string, t: 'call' | 'delete', body: Record<string, unknown>) => void;
  /**
   * 驗過的 here／sync 從這個成員來（W4）：他剛真的連上（QoS0、5 分鐘的新鮮度，broker 不替離線的人排隊）。
   * 同群組但不是好友的人看不到彼此的 presence —— App 靠這個知道他在線、去連 P2P（memberPresence.ts）
   */
  onMemberSeen?: (gid: string, from: string) => void;
  /**
   * 他的 here 到了，要不要回一則我的 here（W4 審查 #2）：他剛連上，但他看不到我的 presence（不是好友）、我這邊也沒看到他
   * （通道沒開、最近沒有他的 here）—— 不回的話他不知道我在線。在 onMemberSeen 之前問；引擎另外限速
   * （我 10 秒內發過 here 就不回、同一個人 10 秒最多回一次）。沒給 ＝ 不回（W2 的行為）
   */
  answerHere?: (gid: string, from: string) => boolean;
  /**
   * 這個成員的 sync／here 可以讓我回一則 here 嗎（W5 複審：App 給「不是我封鎖的人」—— 不然被封鎖的同群成員每 10 秒發一則 sync，
   * 看我有沒有回就知道我在不在線）。他的追趕不受影響：其他成員照樣回、他自己也會輪詢。沒給 ＝ 都可以
   */
  mayReply?: (gid: string, from: string) => boolean;
  /**
   * 這個群要不要定時發 here（W5）：名冊上有不是我好友的人 —— 他看不到我的 presence，只靠群組主題上的 here 知道我還在
   * （memberPresence 10 分鐘沒有新的 here 就當我離線）。members ＝ 套上的名冊（含我）。沒給 ＝ 不定時發（只在真的連上時發）
   */
  needsHere?: (gid: string, members: readonly string[]) => boolean;
  /** 定時 here 的間隔（預設 HERE_REFRESH_MS；測試可以縮短） */
  hereRefreshMs?: number;
  /** 驗邀請整條鏈（App 放到 Web Worker；沒給 ＝ 在這裡跑 groupState.verifyInvite） */
  verifyInvite?: (p: { chain: unknown[]; gid: string; me: string; key: { kid: string; key: Uint8Array } }) => Promise<InviteResult>;
  /** 套上的狀態 → 畫面（null ＝ 這個群在這台不在了） */
  project: (gid: string, group: Group | null) => void;
  isFriend: (pk: string) => Promise<boolean>;
  isBlocked: (pk: string) => Promise<boolean>;
  nicknameOf: (pk: string) => string | undefined;
  now: () => number;
  /**
   * 收到的 here／sync／call 新不新鮮用的時鐘（W5）：App 給 mqtt 的 boundedNow（API 的時鐘差最多採信 ±5 分鐘）—— 營運方回一個假的
   * serverTime 就能讓錄下來的通話開始／here 在重開 App（去重表是空的）之後看起來還新。commit／delete（24 小時的窗、重放只是
   * 再抓一次／再刪一次）照舊看 now：手機時鐘差很多的人才不會收不到「為所有人刪除」（W5 複審）。沒給 ＝ now
   */
  receiveNow?: () => number;
  notice?: (n: EngineNotice) => void;
  /** 群組的鏈、金鑰或名冊變了（重試暫存的群訊、標記備份要更新） */
  onChange?: (gid: string) => void;
  /** 測試可以縮短；預設 120 秒 */
  pollMs?: number;
  /** 同一個群兩次同步至少隔多久（預設 2 秒；測試用 0） */
  minSyncIntervalMs?: number;
  /** 邀請額度（每分鐘：每個寄件人、全部）；預設 2／20，測試可以放寬 */
  inviteBudget?: { perSender: number; total: number };
  /** 回 here 之前隨機等 0～這麼多毫秒（大家不要同時回）；預設 1000，測試用 0 */
  replyJitterMs?: number;
  /** MQTT 現在連著嗎（沒連著的控制訊息留在引擎裡，連上才用那時的這一代封；沒給 ＝ 一直連著） */
  connected?: () => boolean;
  /** 這個群組主題（tid）訂好了嗎（加入後的 sync 等目前這一代的主題訂好才送，不然大家的回覆收不到；沒給 ＝ 訂好了） */
  topicReady?: (tid: string) => boolean;
  /**
   * 該訂的群組主題變了（W3：加入、換金鑰、上一代過了重疊期、被踢／離開）：整份清單（App 拿去當 token 範圍並調整訂閱）。
   * 引擎啟動載完時一定發一次（可能是空的）
   */
  onTopics?: (topics: GroupTopic[]) => void;
  /** 換金鑰後上一代的主題留多久（預設 10 分鐘；測試可以縮短） */
  topicOverlapMs?: number;
  /** 換到新主題之後控制訊息先等多久（預設 SWITCH_GRACE_MS；測試可以改） */
  switchGraceMs?: number;
}

/** 呼叫端看得懂的失敗原因（規則拒收的原因照 ChainReject 的字串） */
export class GroupOpError extends Error {
  constructor(readonly reason: string) {
    super(`group: ${reason}`);
  }
}

export type ProposeStatus = 'applied' | 'pending' | 'held';

export interface InviteBody {
  gid: string;
  chain: unknown[];
  kid: string;
  key: Uint8Array;
  headSeq: number;
  baseSeq: number;
  parentLogKey?: Uint8Array;
}

const okSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_SEQ;

function key32(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length !== 44) return null;
  try {
    const k = fromB64(v);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

export function parseInvite(body: Record<string, unknown>): InviteBody | null {
  const { gid, chain, kid, headSeq, baseSeq } = body;
  if (!validGid(gid) || !Array.isArray(chain) || chain.length < 1 || !validKid(kid) || !okSeq(headSeq) || !okSeq(baseSeq)) return null;
  const key = key32(body.key);
  if (!key) return null;
  const parentLogKey = body.parentLogKey === undefined ? undefined : key32(body.parentLogKey);
  if (parentLogKey === null) return null;
  return { gid, chain, kid, key, headSeq, baseSeq, ...(parentLogKey ? { parentLogKey } : {}) };
}

export function parseKeyRequest(body: Record<string, unknown>): { gid: string; kid: string } | null {
  return validGid(body.gid) && validKid(body.kid) ? { gid: body.gid, kid: body.kid } : null;
}

export function parseKeyDist(body: Record<string, unknown>): { gid: string; kid: string; key: Uint8Array } | null {
  const key = key32(body.key);
  return validGid(body.gid) && validKid(body.kid) && key ? { gid: body.gid, kid: body.kid, key } : null;
}

export const keyB64 = (k: Uint8Array): string => toB64(k);

/** 邀請的回條：{ gid, id }（id ＝ 邀請鏈最後那筆 commit） */
export function parseInviteAck(body: Record<string, unknown>): { gid: string; id: string } | null {
  return validGid(body.gid) && validCommitId(body.id) ? { gid: body.gid, id: body.id } : null;
}


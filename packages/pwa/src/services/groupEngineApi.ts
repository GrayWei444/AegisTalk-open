/**
 * 群組 log 引擎（groupEngine.ts）的介面與執行期狀態的型別：畫面／App 用的 GroupEngine、每個群的 Runtime、引擎內部的 Action。
 * 只有型別；實作在 groupEngine.ts（另有 groupEngineSealed／groupEngineControl／groupEngineGossip）。
 */
import type { HeadGossip, LogReplica } from './groupLog';
import type { GuardianGroupSettings, GroupType, MemberRole, VerifiedCommit } from './groupState';
import type { GroupBackup } from './groupBackup';
import type { ProposeStatus } from './groupEngineTypes';
import type { HeldControl, OutKind, ReceiveResult, SendResult } from './groupEngineControl';
import type { PendingRow } from './groupLogStore';
import type { GroupTopic, TopicEntry } from './groupTopics';
import type { Group } from '../types';

export interface Runtime {
  gid: string;
  rep: LogReplica;
  /** kid → 金鑰（鏈上授權過的，或我自己還沒上鏈的換金鑰） */
  keys: Map<string, Uint8Array>;
  pending: Map<string, PendingRow>;
  rekeySeenAt: number | null;
  /** 這次開 App 已經送出的待送 commit（沒送過的在同步完補送） */
  appended: Set<string>;
  /** 已經處理過的過時 commit（rebuild 會再報一次） */
  rebased: Set<string>;
  /** 被規則或伺服器拒收的我的 commit：id → 原因（propose 回報給畫面） */
  rejected: Map<string, string>;
  askedAt: Map<string, number>;
  lastRebuildAt: number;
  rekeyTimer: ReturnType<typeof setTimeout> | null;
  /** 下一次重送邀請（還沒收到回條的）的計時器 */
  inviteTimer: ReturnType<typeof setTimeout> | null;
  /** 要送、但現在不能送的控制訊息（needsRekey、金鑰還沒到；只在記憶體） */
  outbox: HeldControl[];
  /** 這個群的主題表（W3，groupTopics.ts）：目前這一代的 tid ＋ 換金鑰後還在重疊期的上一代 */
  topics: TopicEntry[];
  /** 主題表重算的序號（非同步重算交錯時，只有最新的那次寫進去） */
  topicSeq: number;
  /** 上一代主題到期的計時器 */
  topicTimer: ReturnType<typeof setTimeout> | null;
  /** 這台最近一次換到新主題的時間（grace 裡控制訊息先留著；W3 審查 M1） */
  switchedAt: number | null;
  /** grace 結束時把留著的放出去 */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** head 交叉比對對不上的成員 → 原因與他報的 head（畫面 Group.logConflict） */
  conflicts: Map<string, { reason: string; head: HeadGossip }>;
  /**
   * 說他比我新的成員（交叉比對 i-am-behind）→ 他第一次這麼說的 head 與那時已經開始的同步輪數（round）。在那之後才開始的一輪
   * 抓完 log 還是比他舊、伺服器也說沒有更新的了 → 伺服器對我扣著 log（W5 S12：只扣不換，交叉比對永遠是「我落後」、
   * 不會是 conflict）→ 一樣顯示 logConflict。追上了才換下一筆（用輪數不用時鐘：換 token 時鐘差會跳）
   */
  behindPeers: Map<string, { head: HeadGossip; round: number }>;
  /** syncOnce 開始過幾輪（behindPeers 判斷「他說了之後才開始的一輪」） */
  syncRound: number;
  lastReplyAt: number;
  /** 回過誰的 sync、什麼時候（每個請求者 10 秒最多回一次） */
  repliedTo: Map<string, number>;
  lastAnnounceAt: number;
  /** 剛加入：群組主題訂好之後送一則 sync（請大家報 head） */
  syncOnTopic: boolean;
  gone: boolean;
}

export type Action =
  | { t: 'append'; id: string }
  /** 送邀請（第一次，或還沒收到回條、到了重送的時間） */
  | { t: 'invite'; id: string }
  | { t: 'ask-key'; kid: string }
  | { t: 'rebase'; vc: VerifiedCommit }
  | { t: 'held' }
  | { t: 'rekey' }
  | { t: 'drop'; id: string };

export interface CreateGroupParams {
  name: string;
  members: string[];
  avatar?: string;
  groupType?: GroupType;
  guardianSettings?: GuardianGroupSettings | null;
}

export interface InfoUpdate {
  name?: string;
  avatar?: string;
  groupType?: GroupType;
  guardianSettings?: GuardianGroupSettings | null;
}

export interface GroupEngine {
  start(): Promise<void>;
  stop(): void;
  isReady(): boolean;
  syncAll(): void;
  requestSync(gid: string): void;
  createGroup(p: CreateGroupParams): Promise<string>;
  addMember(gid: string, pk: string): Promise<ProposeStatus>;
  removeMember(gid: string, pk: string): Promise<ProposeStatus>;
  setRole(gid: string, pk: string, role: MemberRole): Promise<ProposeStatus>;
  updateInfo(gid: string, info: InfoUpdate): Promise<ProposeStatus>;
  leave(gid: string): Promise<ProposeStatus>;
  deleteGroup(gid: string): Promise<ProposeStatus>;
  /** 送群訊用的金鑰：只會是目前這一代、kc 核對過的；拿不到 → null（畫面「等金鑰」，不退回舊的一代） */
  sendingKey(gid: string): Promise<{ kid: string; key: Uint8Array } | null>;
  /** 解群訊用：只給這個群鏈上那一代的金鑰 */
  decryptKey(gid: string, kid: string): Uint8Array | null;
  /** 這個群在本機（已加入）嗎；kid 是鏈上的某一代嗎 */
  knows(gid: string): boolean;
  isEpoch(gid: string, kid: string): boolean;
  isMember(gid: string, pk: string): boolean;
  /** 成員加入那筆 commit 的時間（seed sync 不給他加入之前的密文） */
  joinedAt(gid: string, pk: string): number | null;
  gossip(gid: string): HeadGossip | null;
  /** 群訊明文帶的 head（寄件人已驗過是成員、簽章是他的） */
  onGossip(gid: string, theirs: unknown, from: string): void;
  onSealed(from: string, body: Record<string, unknown>): Promise<void>;
  /**
   * 群組主題上收到的 group_sealed：tid、from 取自主題（mist/group/{tid}/{寄件人}）。tid 只靠引擎自己的主題表對回群組
   * （目前這一代，或換金鑰後還在重疊期的上一代）；表上沒有 → 'unknown-topic'，不解密
   */
  onControl(tid: string, from: string, envelope: unknown): Promise<ReceiveResult>;
  /** 每個已加入的群現在該訂的主題（目前這一代＋重疊期的上一代；App 拿去當 token 範圍、訂閱；也會經 deps.onTopics 通知） */
  topics(): GroupTopic[];
  /** 群組通話信令（call）、刪除群訊（delete）：只用目前這一代送；needsRekey／等金鑰時先留著 */
  sendControl(gid: string, t: Extract<OutKind, 'call' | 'delete'>, body: Record<string, unknown>): Promise<SendResult>;
  /** MQTT 真的連上（不是換 token 的重連）：每個群補進度後發一則 here（head） */
  announce(): void;
  /** 每次連上（含換 token）：留著的控制訊息送出去 */
  flushControl(): void;
  /** 邀請重送用完還是沒回條（Group.unackedInvites）：使用者按「再送一次」→ 重新開始一輪重送；沒有那份紀錄 → false */
  resendInvite(gid: string, pk: string): Promise<boolean>;
  /** 這個群組主題剛訂好（App 從 mqtt 的 SUBACK 轉過來；tid 引擎自己對回群組）：剛加入的群在這時送 sync */
  onTopicReady(tid: string): void;
  /** 在這台忘掉這個群（拿不到目前那一代的金鑰、也離開不了時）：只刪本機的鏈、金鑰、待送，不寫任何 commit */
  forgetGroup(gid: string): Promise<void>;
  /** 控制訊息的計數（診斷與測試） */
  controlStats(): Readonly<Record<string, number>>;
  backupOf(gid: string): GroupBackup | null;
  /** 每個已加入的群現在的投影（groupStore 整份重載時用；引擎還沒載完 → null） */
  projectAll(): Map<string, Group> | null;
  /**
   * 引擎跑著的時候，備份還原（帳號恢復、換機）才把群寫進本機：把本機有、引擎還沒載的群載進來（重驗）並補抓 log。
   * 回傳載入了幾個
   */
  adoptStored(): Promise<number>;
}

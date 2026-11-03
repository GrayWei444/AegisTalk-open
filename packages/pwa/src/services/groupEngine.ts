/**
 * 群組 log 引擎（docs/GROUP_LOG_WIRING_W1.md）：把純函式的狀態鏈（groupState／groupLog）接到存檔、伺服器 log 與畫面。
 *
 * 群組狀態只來自「伺服器 log 上照順序套用的簽章鏈」：
 *   - 畫面上的動作只寫 commit：buildCommitEntry（裡面 checkCommit）→ 先存檔（commit 與新金鑰，flush）→ append
 *     → 抓 log、套用 → 套上了才改名冊／金鑰／畫面，並在群組主題發 commit 通知（group_sealed，groupEngineControl）。
 *     過時的（staleOwn）在新的 head 上重寫；換金鑰的一定換新金鑰。
 *   - 每個群一條排隊（同一個群的抓 log、寫 commit、邀請、金鑰一次只做一件）。
 *   - 補進度：啟動、MQTT 重連、收到 commit 通知、交叉比對發現落後、每 2 分鐘。缺號 → 從 processedSeq 重抓；
 *     交叉比對 conflict → 畫面警告、問伺服器、必要時從 firstSeq 重抓、rebuildLog（groupEngineGossip）。
 *     等金鑰 → 用封給身分金鑰的 req 向 admin 要。
 *   - 被踢、離開、刪群、邀請沒對上、使用者在本機忘掉這個群 → 這個群在本機的鏈、金鑰、待送全部刪掉。
 * 邀請（含回條與重送）、金鑰的索取與回覆在 groupEngineSealed.ts；群組主題上的控制訊息在 groupEngineControl.ts。
 * 群組主題（W3，docs/GROUP_LOG_WIRING_W3.md）：每個群一張主題表（groupTopics.ts）—— 目前這一代的 tid（金鑰推出來的）
 *   ＋換金鑰後再留 10 分鐘的上一代。鏈或金鑰一變就重算，整份變了告訴 App（deps.onTopics → token 範圍、訂閱）。收到的
 *   group_sealed 只靠這張表把 tid 對回群組；送出只用目前這一代的主題（結束一代的那筆換金鑰的通知在切換之前發）。
 */
import {
  applyLog, buildCommitEntry, currentEpochKey, headGossip, rebaseDraft, sealGenesisEntry, startLog,
  type LogApplyResult, type LogDeps, type LogReplica,
} from './groupLog';
import {
  carriesNewEpoch, createGenesis, encodeCommitRow, epochOfKey, keyAuthorised, loadChainFromRows, memberOf, rejectReason, rotationOrder, shouldRekeyNow,
  waitingForAdminRekey, wireOf, randomB64Url, ChainReject, ROTATOR_STEP_SECONDS,
  type ChainView, type GroupOp, type GroupState, type SignedCommit, type VerifiedCommit,
} from './groupState';
import { GroupLogHttpError } from './groupLogClient';
import { projectGroup, projectionRow } from './groupProjection';
import { backupOf as backupOfRuntime } from './groupBackup';
import { GroupOpError, type EngineDeps, type EngineNotice, type ProposeStatus } from './groupEngineTypes';
import {
  ackedBy, askForKey, handleSealed, resendInvite, resumeJoins, scheduleInviteResend, sendInvite, inviteDue, unackedInvitees,
  type EngineCtx,
} from './groupEngineSealed';
import { createControlPlane, epochAt } from './groupEngineControl';
import { createGossip } from './groupEngineGossip';
import { deriveTopicId } from './groupControl';
import { nextExpiry, nextTopics, previousEpoch, previousUntil, topicListKey, SWITCH_GRACE_MS, TOPIC_OVERLAP_MS, type GroupTopic } from './groupTopics';
import type { EpochKeyRow, PendingRow, ReplicaMeta } from './groupLogStore';
import type { Action, CreateGroupParams, GroupEngine, Runtime } from './groupEngineApi';
import type { Group, GroupKeyState } from '../types';

export { GroupOpError } from './groupEngineTypes';
export type { EngineDeps, EngineNotice, ProposeStatus } from './groupEngineTypes';
export type { Action, CreateGroupParams, GroupEngine, InfoUpdate, Runtime } from './groupEngineApi';

/** 一次同步最多抓幾頁（每頁 ≤ 200 筆）；剩下的下一輪 */
const MAX_PAGES = 20;
const MAX_GAP_RETRIES = 3;
const SETTLE_ROUNDS = 4;
/** 真的連上（不是換 token）時每個群發一則 here：同一個群最少隔這麼久（網路一直斷斷續續時不要洗版） */
const ANNOUNCE_MIN_INTERVAL_MS = 15_000;
/**
 * 定時 here（W5）：同群組的非好友看不到彼此的 presence，只靠 here 知道對方還在（memberPresence 10 分鐘沒有新的 here 就當作離線）。
 * 名冊上有非好友的群，連著的時候每 4 分鐘發一則（QoS0、不排隊；TTL 內有兩次機會），間隔加 0～10% 的亂數（大家不要同時發）
 */
export const HERE_REFRESH_MS = 4 * 60_000;
/** 寫不出去但之後可能可以的原因（held 的動作留著下次再放） */
const TRANSIENT_REASONS = new Set(['no-key', 'key-mismatch', 'needs-rekey', 'stopped']);
/** 伺服器明確拒收、重送也一樣的（待送列丟掉、通知畫面） */
const PERMANENT_HTTP = new Set([400, 403, 404, 413, 422]);
const SYNC_DEBOUNCE_MS = 300;
const SYNC_MIN_INTERVAL_MS = 2_000;
/** needsRekey 期間只收這幾種（groupStateRules ALLOWED_WHILE_REKEY_PENDING）；其他的先 held */
const ALLOWED_WHILE_REKEY: readonly string[] = ['rekey', 'remove', 'leave'];

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export function createGroupEngine(deps: EngineDeps): GroupEngine {
  const me = deps.me;
  const runtimes = new Map<string, Runtime>();
  const queues = new Map<string, Promise<unknown>>();
  const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSyncAt = new Map<string, number>();
  let stopped = false;
  let ready = false;
  /** 引擎還沒載完時就連上了：載完再發 here */
  let announcePending = false;
  let started: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hereTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上次告訴 App 的主題清單（topicListKey）：一樣就不再通知 */
  let emittedTopics: string | null = null;
  const overlapMs = deps.topicOverlapMs ?? TOPIC_OVERLAP_MS;

  const notice = (n: EngineNotice) => { try { deps.notice?.(n); } catch { /* UI 的事 */ } };
  const log = (...a: unknown[]) => console.error('[groupEngine]', ...a);

  function queue<T>(gid: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(gid) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => {
      if (stopped) throw new GroupOpError('stopped');
      return fn();
    });
    const tail = next.catch(() => undefined);
    queues.set(gid, tail);
    void tail.then(() => { if (queues.get(gid) === tail) queues.delete(gid); });
    return next;
  }

  const keyFor = (rt: Runtime) => (kid: string) => rt.keys.get(kid) ?? null;
  /** 引擎停了（換帳號、登出）：還在跑的工作不能再寫資料庫或畫面 */
  const guard = (): void => { if (stopped) throw new GroupOpError('stopped'); };

  /** 待送列裡簽好的 commit（壞掉的列 → null） */
  function signedOf(p: PendingRow): SignedCommit | null {
    if (!p.signed) return null;
    try {
      const sc = JSON.parse(p.signed) as SignedCommit;
      return sc && sc.c && Number.isSafeInteger(sc.c.v) && typeof sc.c.op === 'string' && sc.c.args && typeof sc.c.args === 'object' ? sc : null;
    } catch {
      return null;
    }
  }

  /** 會換金鑰的 op（rekey、remove、加回曾經在群裡的人） */
  const rotates = (state: GroupState, op: string, args: Record<string, unknown>): boolean =>
    op === 'rekey' || op === 'remove' || (op === 'add' && typeof args.pk === 'string' && state.former.includes(args.pk));

  /**
   * 我有一筆還沒套上的換金鑰 commit。新一代的 kid ＝ H(head, 作者)：同一個 head 上我再寫一筆換金鑰的，kid 會跟它一樣、
   * 金鑰不同（審查 W1 HIGH-2）→ 這段期間其他換金鑰的動作先 held，等它套上或被重寫。
   */
  const rotationPending = (rt: Runtime): boolean => [...rt.pending.values()].some((p) => {
    if (p.state !== 'append' || p.op === 'create') return false;
    const sc = signedOf(p);
    return !!sc && carriesNewEpoch(sc.c);
  });

  /** 這筆 commit 帶的新一代 kid —— 只有還沒上鏈的才回傳（鏈上那一代的金鑰絕不能因為我那筆被丟掉而刪掉） */
  function unappliedKidOf(rt: Runtime, c: { args: Record<string, unknown> } | null | undefined): string | null {
    const kid = c && typeof c.args.kid === 'string' ? c.args.kid : null;
    return kid && !epochOfKey(rt.rep.view.state, kid) ? kid : null;
  }

  /** 這個 op 現在要不要先 held：needsRekey 期間不收的；或我還有一筆換金鑰沒套上、這筆又要換金鑰 */
  function mustHold(rt: Runtime, op: string, args: Record<string, unknown>): boolean {
    const state = rt.rep.view.state;
    return (state.needsRekey && !ALLOWED_WHILE_REKEY.includes(op)) || (rotates(state, op, args) && rotationPending(rt));
  }

  async function dropPending(rt: Runtime, ids: string[], kids: string[] = []): Promise<void> {
    guard();
    await deps.store.persistGroupLog({ gid: rt.gid, pendingDrop: ids, dropKids: kids });
    for (const id of ids) rt.pending.delete(id);
    for (const kid of kids) rt.keys.delete(kid);
  }

  async function logDeps(rt: Runtime, extra?: Map<string, Uint8Array>): Promise<LogDeps> {
    const lookup = keyFor(rt);
    return {
      verify: deps.verify, x25519: deps.x25519, myX25519Private: await deps.myX25519Private(),
      keyFor: (kid) => extra?.get(kid) ?? lookup(kid),
    };
  }

  function metaOf(rt: Runtime): ReplicaMeta {
    const r = rt.rep;
    return {
      gid: rt.gid, me, headV: r.view.state.head.v, headId: r.view.state.head.id, processedSeq: r.processedSeq, headSeq: r.headSeq,
      firstSeq: r.firstSeq, baseV: r.baseV, joinAt: r.joinAt, status: r.status, appliedAt: { ...r.appliedAt }, waiting: r.waiting,
      rekeySeenAt: rt.rekeySeenAt,
    };
  }

  function keyStateOf(rt: Runtime): GroupKeyState {
    const state = rt.rep.view.state;
    if (rt.rep.waiting || !rt.keys.has(state.epoch.kid)) return 'waiting-key';
    return waitingForAdminRekey(state) ? 'waiting-admin-rekey' : 'ok';
  }

  const activeKidOf = (rt: Runtime): string | null => (rt.keys.has(rt.rep.view.state.epoch.kid) ? rt.rep.view.state.epoch.kid : null);
  const actorAt = (view: ChainView, v: number): string => view.chain[v - 1]?.c.actor ?? '';

  /** 對不上的成員已經不在名冊上 → 那一筆警告不算了 */
  function logConflictOf(rt: Runtime): boolean {
    for (const pk of rt.conflicts.keys()) if (!memberOf(rt.rep.view.state, pk)) rt.conflicts.delete(pk);
    return rt.conflicts.size > 0;
  }

  function viewOf(rt: Runtime): Group {
    return projectGroup(rt.rep.view, {
      me, nicknameOf: deps.nicknameOf, keyState: keyStateOf(rt), logConflict: logConflictOf(rt), unackedInvites: unackedInvitees(rt),
    });
  }

  function project(rt: Runtime): void {
    if (stopped) return;
    deps.project(rt.gid, viewOf(rt));
    try { deps.onChange?.(rt.gid); } catch { /* 呼叫端的事 */ }
    control.onChange(rt);   // 鏈或金鑰變了：留著的控制訊息送出去
    refreshTopics(rt).catch((e) => log('topic refresh failed:', (e as Error)?.message ?? e));
  }

  // ============================================
  // 群組主題（W3）
  // ============================================

  /** 每個已加入的群的主題表 → App 看的清單 */
  function topicList(): GroupTopic[] {
    const out: GroupTopic[] = [];
    for (const rt of runtimes.values()) {
      if (rt.gone || rt.rep.status !== 'member') continue;
      for (const e of rt.topics) out.push({ gid: rt.gid, tid: e.tid, kid: e.kid, current: e.until === null });
    }
    return out;
  }

  /** 清單變了才告訴 App（啟動完之前不發：start 載完一次發整份） */
  function emitTopics(force = false): void {
    if (stopped || (!ready && !force)) return;
    const list = topicList();
    const key = topicListKey(list);
    if (!force && key === emittedTopics) return;
    emittedTopics = key;
    try { deps.onTopics?.(list); } catch (e) { log('onTopics failed:', (e as Error)?.message ?? e); }
  }

  /** 收到的主題 → 哪個群的哪一列（只有這張表能把 tid 對回群組） */
  function findTopic(tid: string): { rt: Runtime; kid: string; current: boolean } | null {
    for (const rt of runtimes.values()) {
      if (rt.gone) continue;
      const e = rt.topics.find((x) => x.tid === tid);
      if (e) return { rt, kid: e.kid, current: e.until === null };
    }
    return null;
  }

  const currentTid = (rt: Runtime): string | null => rt.topics.find((e) => e.until === null)?.tid ?? null;

  /**
   * 鏈或金鑰變了：重算這個群的主題表（目前這一代要用核對過的金鑰推 tid，非同步）。期間又有變化 → 交給較新的那次。
   * 剛加入、等主題訂好才送的 sync：目前這一代的主題已經訂好了（或 App 不管訂閱）就現在送
   */
  async function refreshTopics(rt: Runtime): Promise<void> {
    const seq = ++rt.topicSeq;
    const chainKid = rt.rep.view.state.epoch.kid;
    let current: { tid: string; kid: string } | null = null;
    if (!rt.gone && rt.rep.status === 'member') {
      const cur = await currentEpochKey(rt.rep, keyFor(rt));
      if (cur.ok) current = { kid: cur.kid, tid: await deriveTopicId(cur.key, rt.gid) };
    }
    if (seq !== rt.topicSeq || rt.gone || stopped || rt.rep.view.state.epoch.kid !== chainKid) return;
    const before = currentTid(rt);
    rt.topics = nextTopics(rt.topics, chainKid, current, deps.now(), overlapMs);
    const now = currentTid(rt);
    // 換到新的主題：grace 裡控制訊息先留著（大家還在訂），grace 過了放出去（W3 審查 M1）
    if (before && now && before !== now) startSwitchGrace(rt);
    scheduleTopicExpiry(rt);
    emitTopics();
    const tid = currentTid(rt);
    if (rt.syncOnTopic && tid && (deps.topicReady?.(tid) ?? true)) {
      rt.syncOnTopic = false;
      control.send(rt, 'sync').catch((e) => log('sync failed:', (e as Error)?.message ?? e));
    }
  }

  function startSwitchGrace(rt: Runtime): void {
    rt.switchedAt = deps.now();
    if (rt.graceTimer) clearTimeout(rt.graceTimer);
    rt.graceTimer = setTimeout(() => {
      rt.graceTimer = null;
      if (!rt.gone && !stopped) control.onChange(rt);
    }, (deps.switchGraceMs ?? SWITCH_GRACE_MS) + 50);
  }

  /** 主題表跟鏈對不上（重算之後鏈又動了、或 absorb 半路出錯沒走到 project；W3 審查 L5）→ 再算一次 */
  function topicsBehindChain(rt: Runtime): boolean {
    return (rt.topics.find((e) => e.until === null)?.kid ?? null) !== rt.rep.view.state.epoch.kid;
  }

  /** 上一代的主題到期時重算（拿掉它、退訂） */
  function scheduleTopicExpiry(rt: Runtime): void {
    if (rt.topicTimer) clearTimeout(rt.topicTimer);
    rt.topicTimer = null;
    const at = nextExpiry(rt.topics);
    if (at === null || rt.gone || stopped) return;
    rt.topicTimer = setTimeout(() => {
      rt.topicTimer = null;
      if (!rt.gone && !stopped) refreshTopics(rt).catch((e) => log('topic refresh failed:', (e as Error)?.message ?? e));
    }, Math.max(0, at - deps.now()) + 50);
  }

  /**
   * App 重開（主題表只在記憶體）：目前這一代是不到 10 分鐘前換的 → 上一代的主題補回表上，留到換金鑰那筆 commit 的時間
   * ＋重疊期（broker 替我排在那個主題上的、還沒換過來的成員晚送的，照樣收）。上一代的金鑰不在手上就算了
   */
  async function seedPreviousTopic(rt: Runtime): Promise<void> {
    const state = rt.rep.view.state;
    const prev = previousEpoch(state);
    const key = prev ? rt.keys.get(prev.kid) : undefined;
    const startedAt = rt.rep.view.chain[state.epoch.v - 1]?.c.ts;
    if (!prev || !key || typeof startedAt !== 'number') return;
    const until = previousUntil(startedAt, deps.now(), overlapMs);
    if (until === null || !(await keyAuthorised(state, prev.kid, prev.kc, key))) return;
    rt.topics = [{ tid: await deriveTopicId(key, rt.gid), kid: prev.kid, until }];
  }

  async function newRuntime(gid: string, rep: LogReplica, keys: Map<string, Uint8Array>, pending: PendingRow[] = [],
    rekeySeenAt: number | null = null): Promise<Runtime> {
    const rt: Runtime = {
      gid, rep, keys, pending: new Map(pending.map((p) => [p.id, p])), rekeySeenAt, appended: new Set(), rebased: new Set(),
      rejected: new Map(), askedAt: new Map(), lastRebuildAt: 0, rekeyTimer: null, inviteTimer: null, outbox: [],
      conflicts: new Map(), behindPeers: new Map(), syncRound: 0, lastReplyAt: 0, repliedTo: new Map(), lastAnnounceAt: 0, syncOnTopic: false, gone: false,
      topics: [], topicSeq: 0, topicTimer: null, switchedAt: null, graceTimer: null,
    };
    runtimes.set(gid, rt);
    return rt;
  }

  /** 新的 runtime（建群、加入、還原）：整條鏈、位置、金鑰、投影一次寫進去 */
  async function persistWhole(rt: Runtime, keys: EpochKeyRow[], extra: { pendingUpsert?: PendingRow[]; pendingDrop?: string[] } = {},
    flush = false): Promise<void> {
    guard();
    await deps.store.persistGroupLog({
      gid: rt.gid, replaceFromV: 0, rows: rt.rep.view.chain.map((vc) => encodeCommitRow(rt.gid, vc)), meta: metaOf(rt), keys,
      activeKid: activeKidOf(rt), projection: projectionRow(rt.rep.view, deps.nicknameOf), ...extra,
    }, { flush });
  }

  async function dropGroup(rt: Runtime, why: EngineNotice['kind']): Promise<void> {
    guard();
    rt.gone = true;
    if (rt.rekeyTimer) clearTimeout(rt.rekeyTimer);
    if (rt.inviteTimer) clearTimeout(rt.inviteTimer);
    if (rt.topicTimer) clearTimeout(rt.topicTimer);
    if (rt.graceTimer) clearTimeout(rt.graceTimer);
    rt.outbox = [];
    rt.topics = [];
    control.forget(rt.gid);
    runtimes.delete(rt.gid);
    emitTopics();   // 被踢、離開、刪群、忘掉：這個群的主題（含上一代的）馬上不訂了
    await deps.store.deleteGroupLog(rt.gid);   // 確認中的邀請（join 列）留著：被踢之後又被加回來的邀請
    deps.project(rt.gid, null);
    notice({ gid: rt.gid, kind: why });
    try { deps.onChange?.(rt.gid); } catch { /* 呼叫端的事 */ }
    resumeJoins(ctx).catch((e) => log('resume joins failed:', (e as Error)?.message ?? e));
  }

  // ============================================
  // 套用 log 的結果
  // ============================================

  function nothingNew(rt: Runtime, res: LogApplyResult): boolean {
    return res.applied.length === 0 && res.skipped.length === 0 && res.newKeys.length === 0 && res.keyMissing.length === 0
      && res.replica.processedSeq === rt.rep.processedSeq && JSON.stringify(res.waiting) === JSON.stringify(rt.rep.waiting)
      && res.replica.status === rt.rep.status;
  }

  async function absorb(rt: Runtime, res: LogApplyResult, opts: { replaceFromV?: number } = {}): Promise<Action[]> {
    guard();
    if (opts.replaceFromV === undefined && nothingNew(rt, res)) {
      return res.waiting ? [{ t: 'ask-key', kid: res.waiting.kid }] : [];
    }
    /**
     * 我自己的 commit 套上了 → 群組主題上發 commit 通知，用那筆 entry 的那一代、發在那一代的主題上（W3）：
     *   - 現在這一代的（含結束它的那筆換金鑰、我的 leave）在切換之前發 —— 被踢、剛離開、還沒換過來的人都在這個主題上，
     *     看得懂通知的人本來就打得開那筆 entry，不多洩漏；切換之後這個主題上不會再有我發的東西
     *   - 新一代的（換金鑰之後同一批套上的）切換之後發；中間被跳過的那幾代不發（只是提示，大家自己會抓）
     */
    const own = res.applied.filter((a) => a.commit.c.actor === me && a.commit.c.v >= 2 && rt.pending.has(a.commit.id));
    const after = res.replica.view.state;
    const fromKid = rt.rep.view.state.epoch.kid;
    const entryOf = (a: LogApplyResult['applied'][number]) => epochAt(after, a.commit.c.v - 1);
    for (const a of own) if (entryOf(a).kid === fromKid) await control.notifyCommit(rt, a, entryOf(a), after);
    guard();
    rt.rep = res.replica;
    for (const k of res.newKeys) rt.keys.set(k.kid, k.key);
    const status = rt.rep.status;
    if (status !== 'member') {
      await dropGroup(rt, status === 'joining' ? 'not-joined' : status);
      return [];
    }
    const actions: Action[] = [];
    const appliedIds = new Set(res.applied.map((a) => a.commit.id));
    const inChain = new Set(rt.rep.view.chain.map((vc) => vc.id));
    const upserts: PendingRow[] = [];
    const drops: string[] = [];
    const dropKids: string[] = [];
    for (const p of rt.pending.values()) {
      if (p.state !== 'append') continue;
      if (appliedIds.has(p.id) || inChain.has(p.id)) {
        if (p.op === 'add') upserts.push({ ...p, state: 'invite', blob: null });
        else drops.push(p.id);
        continue;
      }
      const skip = res.skipped.find((s) => s.id === p.id && s.reason !== 'stale' && s.reason !== 'duplicate');
      if (skip) {
        drops.push(p.id);
        const kid = unappliedKidOf(rt, signedOf(p)?.c);
        if (kid) dropKids.push(kid);
        rt.rejected.set(p.id, skip.reason);
        notice({ gid: rt.gid, kind: 'rejected', op: p.op, reason: skip.reason });
      }
    }
    for (const vc of res.staleOwn) if (!rt.rebased.has(vc.id) && rt.pending.has(vc.id)) actions.push({ t: 'rebase', vc });
    const state = rt.rep.view.state;
    if (state.needsRekey && rt.rekeySeenAt === null) rt.rekeySeenAt = deps.now();
    if (!state.needsRekey) rt.rekeySeenAt = null;
    for (const kid of dropKids) rt.keys.delete(kid);
    if (res.waiting) {
      if (res.waiting.reason === 'key-mismatch') {
        rt.keys.delete(res.waiting.kid);
        dropKids.push(res.waiting.kid);
      }
      actions.push({ t: 'ask-key', kid: res.waiting.kid });
    }
    for (const m of res.keyMissing) actions.push({ t: 'ask-key', kid: m.kid });
    const view = rt.rep.view;
    await deps.store.persistGroupLog({
      gid: rt.gid, rows: res.applied.map((a) => encodeCommitRow(rt.gid, a.commit)), replaceFromV: opts.replaceFromV, meta: metaOf(rt),
      keys: res.newKeys.map((k): EpochKeyRow => ({ kid: k.kid, key: k.key, v: k.v, actor: actorAt(view, k.v), origin: 'chain' })),
      dropKids, activeKid: activeKidOf(rt), projection: projectionRow(view, deps.nicknameOf), pendingUpsert: upserts, pendingDrop: drops,
    });
    for (const id of drops) rt.pending.delete(id);
    for (const u of upserts) {
      rt.pending.set(u.id, u);
      actions.push({ t: 'invite', id: u.id });
    }
    project(rt);
    if (after.epoch.kid !== fromKid) {
      for (const a of own) if (entryOf(a).kid === after.epoch.kid) void control.notifyCommit(rt, a, entryOf(a), after);
    }
    return actions;
  }

  /** 抓 log 到最新、套用；回傳要接著做的事 */
  async function syncOnce(rt: Runtime): Promise<Action[]> {
    const round = ++rt.syncRound;
    const actions: Action[] = [];
    let gapRetries = 0;
    let more = false;
    for (let page = 0; page < MAX_PAGES && !rt.gone && !stopped; page++) {
      const got = await deps.log.fetch(rt.gid, rt.rep.processedSeq);
      more = got.more;
      if (got.entries.length === 0) break;
      const res = await applyLog(rt.rep, got.entries, await logDeps(rt));
      actions.push(...(await absorb(rt, res)));
      if (rt.gone) return [];
      if (res.waiting) { more = false; break; }
      if (res.gap) {
        if (++gapRetries > MAX_GAP_RETRIES) break;
        continue;
      }
      if (!got.more) break;
    }
    if (rt.gone) return [];
    if (more) requestSync(rt.gid);   // 這一輪抓到上限還沒完：排下一輪（不卡住這個群的排隊）
    // 抓完了（沒有 more、沒卡在等金鑰）還比某個成員報的 head 舊 → 伺服器對我扣著 log（W5：顯示 logConflict）
    gossip.checkBehind(rt, !more && !rt.rep.waiting, round);
    return [...actions, ...trailingActions(rt)];
  }

  function trailingActions(rt: Runtime): Action[] {
    const out: Action[] = [];
    if (topicsBehindChain(rt)) refreshTopics(rt).catch((e) => log('topic refresh failed:', (e as Error)?.message ?? e));
    if (!rt.rep.waiting) {
      const head = rt.rep.view.state.head;
      const inChain = new Set(rt.rep.view.chain.map((vc) => vc.id));
      for (const p of rt.pending.values()) {
        if (p.state !== 'append' || p.op === 'create' || inChain.has(p.id)) continue;
        const sc = signedOf(p);
        // 這個位置已經被別的 commit 佔了，我那筆永遠接不上（審查 W1 HIGH-1：別人的換金鑰先落地時，我那筆外層是上一代、
        //   被當 other-epoch 跳過，不會出現在 staleOwn）→ 在新的 head 上重寫，不再重送舊的
        if (!sc) out.push({ t: 'drop', id: p.id });   // 壞掉的列：判斷不了位置，不要每次重開都再送一次
        else if (sc.c.v <= head.v) out.push({ t: 'rebase', vc: { ...sc, id: p.id } });
        else if (p.blob && !rt.appended.has(p.id)) out.push({ t: 'append', id: p.id });
      }
    }
    for (const p of rt.pending.values()) if (p.state === 'invite' || inviteDue(p, deps.now())) out.push({ t: 'invite', id: p.id });
    scheduleInviteResend(ctx, rt);
    const state = rt.rep.view.state;
    // 目前這一代的金鑰不在手上（還原時沒帶到、封裝包壞了、存錯的被丟掉）：不等下一筆 entry，現在就向 admin 要
    if (!rt.keys.has(state.epoch.kid)) out.push({ t: 'ask-key', kid: state.epoch.kid });
    if (!state.needsRekey && [...rt.pending.values()].some((p) => p.state === 'held' && !mustHold(rt, p.op, parseArgs(p) ?? {}))) {
      out.push({ t: 'held' });
    }
    const order = rotationOrder(state);
    if (state.needsRekey && order.includes(me) && rt.rekeySeenAt !== null) {
      const waited = (deps.now() - rt.rekeySeenAt) / 1000;
      if (shouldRekeyNow(state, me, waited)) {
        // 我已經有一筆換金鑰（rekey、remove、加回舊成員）在路上：它套上就清掉 needsRekey，不再寫一筆（kid 會撞）
        if (!rotationPending(rt)) out.push({ t: 'rekey' });
      } else {
        scheduleRekeyCheck(rt, (order.indexOf(me) * ROTATOR_STEP_SECONDS - waited) * 1000);
      }
    }
    return out;
  }

  function scheduleRekeyCheck(rt: Runtime, inMs: number): void {
    if (rt.rekeyTimer) return;
    rt.rekeyTimer = setTimeout(() => {
      rt.rekeyTimer = null;
      if (!rt.gone && !stopped) requestSync(rt.gid);
    }, Math.max(1000, inMs + 500));
  }

  /** 做完要做的事；回傳有沒有寫東西進 log（有的話再同步一次） */
  async function perform(rt: Runtime, actions: Action[]): Promise<boolean> {
    let wrote = false;
    const seen = new Set<string>();
    for (const a of actions) {
      if (rt.gone || stopped) break;
      const key = a.t === 'rebase' ? `rebase:${a.vc.id}` : 'id' in a ? `${a.t}:${a.id}` : 'kid' in a ? `${a.t}:${a.kid}` : a.t;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (a.t === 'append') {
          const p = rt.pending.get(a.id);
          if (p?.state === 'append' && p.blob) wrote = (await appendRow(rt, p)) || wrote;
        } else if (a.t === 'invite') await sendInvite(ctx, rt, a.id);
        else if (a.t === 'ask-key') await askForKey(ctx, rt, a.kid);
        else if (a.t === 'rebase') wrote = (await rebase(rt, a.vc)) || wrote;
        else if (a.t === 'held') wrote = (await releaseHeld(rt)) || wrote;
        else if (a.t === 'rekey') wrote = (await authorOrHold(rt, 'rekey', {}, true)) || wrote;
        else if (a.t === 'drop') await dropPending(rt, [a.id]);
      } catch (e) {
        log(`${a.t} failed for ${rt.gid.slice(0, 8)}:`, (e as Error)?.message ?? e);
      }
    }
    return wrote;
  }

  async function settle(rt: Runtime, rounds = SETTLE_ROUNDS): Promise<void> {
    for (let i = 0; i < rounds && !rt.gone && !stopped; i++) {
      let actions: Action[];
      try {
        actions = await syncOnce(rt);
      } catch (e) {
        log(`sync ${rt.gid.slice(0, 8)} failed:`, (e as Error)?.message ?? e);
        return;
      }
      if (actions.length === 0) return;
      if (!(await perform(rt, actions))) return;
    }
  }

  // ============================================
  // 寫 commit
  // ============================================

  async function appendRow(rt: Runtime, p: PendingRow): Promise<boolean> {
    try {
      await deps.log.append(rt.gid, p.blob as string);
      rt.appended.add(p.id);   // 套上之後（absorb）才在群組主題發 commit 通知：那時才知道它真的是那個 seq 的 head
      return true;
    } catch (e) {
      if (e instanceof GroupLogHttpError && PERMANENT_HTTP.has(e.status)) {
        // 伺服器明確拒收、重送也一樣：丟掉這筆（與它還沒上鏈的新金鑰），不要每次同步都再送一次
        const reason = `server:${e.code}`;
        await dropPending(rt, [p.id], [unappliedKidOf(rt, signedOf(p)?.c)].filter((k): k is string => !!k));
        rt.rejected.set(p.id, reason);
        notice({ gid: rt.gid, kind: 'rejected', op: p.op, reason });
        return false;
      }
      notice({ gid: rt.gid, kind: 'append-failed', op: p.op, reason: (e as Error)?.message });
      return false;
    }
  }

  /** 在目前的 head 上寫一筆：先存（commit、新金鑰，flush），再 append。規則不過丟 GroupOpError */
  async function author(rt: Runtime, op: Exclude<GroupOp, 'create'>, args: Record<string, unknown>, replaces?: string): Promise<string> {
    const current = await currentEpochKey(rt.rep, keyFor(rt));
    if (!current.ok) {
      if (current.reason !== 'not-member') await askForKey(ctx, rt, current.kid);
      throw new GroupOpError(current.reason);
    }
    const state = rt.rep.view.state;
    const rekeys = op === 'rekey' || op === 'remove' || (op === 'add' && typeof args.pk === 'string' && state.former.includes(args.pk));
    let built;
    try {
      built = await buildCommitEntry({
        view: rt.rep.view, actor: me, sign: deps.sign, op, args, ts: deps.now(), epochKey: current.key,
        newEpoch: rekeys ? { key: randomKey() } : undefined,
      }, deps.x25519);
    } catch (e) {
      throw new GroupOpError(rejectReason(e));
    }
    const row: PendingRow = {
      gid: rt.gid, id: built.id, op, signed: JSON.stringify(built.signed), blob: built.blob, args: null, state: 'append', createdAt: deps.now(),
    };
    const keys: EpochKeyRow[] = built.newEpoch
      ? [{ kid: built.newEpoch.kid, key: built.newEpoch.key, v: built.signed.c.v, actor: me, origin: 'pending' }] : [];
    guard();
    // 放出 held 的動作時，同一筆寫入把 held 列換成待送列（中途關 App 不會兩筆都在、也不會都不在）
    await deps.store.persistGroupLog({ gid: rt.gid, pendingUpsert: [row], keys, pendingDrop: replaces ? [replaces] : [] }, { flush: true });
    if (replaces) rt.pending.delete(replaces);
    rt.pending.set(row.id, row);
    if (built.newEpoch) rt.keys.set(built.newEpoch.kid, built.newEpoch.key);
    await appendRow(rt, row);
    return row.id;
  }

  async function holdDraft(rt: Runtime, op: string, args: Record<string, unknown>): Promise<void> {
    guard();
    const row: PendingRow = {
      gid: rt.gid, id: `held-${randomB64Url(12)}`, op, signed: null, blob: null, args: JSON.stringify(args), state: 'held', createdAt: deps.now(),
    };
    await deps.store.persistGroupLog({ gid: rt.gid, pendingUpsert: [row] });
    rt.pending.set(row.id, row);
    notice({ gid: rt.gid, kind: 'held', op });
  }

  /** 現在不能寫的先 held（mustHold）；回傳有沒有寫進 log */
  async function authorOrHold(rt: Runtime, op: Exclude<GroupOp, 'create'>, args: Record<string, unknown>, quiet = false): Promise<boolean> {
    if (op === 'rekey' && rotationPending(rt)) return false;   // 已經有一筆換金鑰在路上
    if (mustHold(rt, op, args)) {
      await holdDraft(rt, op, args);
      return false;
    }
    try {
      await author(rt, op, args);
      return true;
    } catch (e) {
      const reason = e instanceof GroupOpError ? e.reason : rejectReason(e);
      if (reason === 'needs-rekey') {
        await holdDraft(rt, op, args);
        return false;
      }
      if (!quiet) throw e;
      notice({ gid: rt.gid, kind: 'rejected', op, reason });
      return false;
    }
  }

  /** 我寫的 commit 過時了：同一個 op 與 args 在新的 head 上重寫（不再需要的就不寫） */
  async function rebase(rt: Runtime, vc: VerifiedCommit): Promise<boolean> {
    rt.rebased.add(vc.id);
    if (!rt.pending.has(vc.id)) return false;
    // 過時那筆帶的新一代：還沒上鏈才刪（審查 W1 HIGH-2：同一個作者在同一個 head 上的兩筆 kid 一樣，先到的那筆已經是鏈上這一代）
    const staleKid = unappliedKidOf(rt, vc.c);
    await dropPending(rt, [vc.id], staleKid ? [staleKid] : []);
    const draft = rebaseDraft(vc);
    if (!draft) return false;
    const state = rt.rep.view.state;
    if (draft.op === 'rekey' && !state.needsRekey) return false;
    if ((draft.op === 'remove' || draft.op === 'role') && !memberOf(state, draft.args.pk as string)) return false;
    if (draft.op === 'add' && memberOf(state, draft.args.pk as string)) return false;
    return authorOrHold(rt, draft.op, draft.args, true);
  }

  function parseArgs(p: PendingRow): Record<string, unknown> | null {
    try {
      const a = JSON.parse(p.args ?? '{}') as unknown;
      return a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  /**
   * 放出 held 的動作（照時間順序）。還不能寫的（needsRekey、還有一筆換金鑰在路上、金鑰還沒到）留著下次再放；
   * 只有規則明確拒收的才丟掉並通知 —— 暫時的錯誤不會讓使用者的動作消失。
   */
  async function releaseHeld(rt: Runtime): Promise<boolean> {
    let wrote = false;
    const held = [...rt.pending.values()].filter((p) => p.state === 'held').sort((a, b) => a.createdAt - b.createdAt);
    for (const p of held) {
      if (rt.gone || stopped || rt.rep.view.state.needsRekey) break;
      const args = parseArgs(p);
      if (!args) {
        await dropPending(rt, [p.id]);
        continue;
      }
      const op = p.op as Exclude<GroupOp, 'create'>;
      if (mustHold(rt, op, args)) continue;
      try {
        await author(rt, op, args, p.id);
        wrote = true;
      } catch (e) {
        const reason = e instanceof GroupOpError ? e.reason : rejectReason(e);
        if (TRANSIENT_REASONS.has(reason)) continue;
        await dropPending(rt, [p.id]);
        rt.rejected.set(p.id, reason);
        notice({ gid: rt.gid, kind: 'rejected', op: p.op, reason });
      }
    }
    return wrote;
  }

  /** 畫面上的動作：先補到最新，再寫；needsRekey 期間不收的先 held */
  function propose(gid: string, op: Exclude<GroupOp, 'create'>, args: Record<string, unknown>): Promise<ProposeStatus> {
    if (!ready) return Promise.reject(new GroupOpError('not-ready'));
    return queue(gid, async () => {
      const rt = runtimes.get(gid);
      if (!rt) throw new GroupOpError('unknown-group');
      try {
        const actions = await syncOnce(rt);
        if (actions.length) await perform(rt, actions);
      } catch (e) {
        log('pre-sync failed:', (e as Error)?.message ?? e);
      }
      if (rt.gone || rt.rep.status !== 'member') throw new GroupOpError('not-member');
      if (mustHold(rt, op, args)) {
        await holdDraft(rt, op, args);
        return 'held' as const;
      }
      const id = await author(rt, op, args);
      await settle(rt);
      if (rt.rep.view.chain.some((vc) => vc.id === id)) return 'applied' as const;
      const rejected = rt.rejected.get(id);
      if (rejected) throw new GroupOpError(rejected);
      return 'pending' as const;   // 還在路上，或過時了、已經在新的 head 上重寫
    });
  }

  // ============================================
  // 建群、同步、重建
  // ============================================

  async function createGroup(p: CreateGroupParams): Promise<string> {
    if (stopped || !ready) throw new GroupOpError(stopped ? 'stopped' : 'not-ready');
    const key = randomKey();
    const kid = randomB64Url(16);
    let genesis;
    try {
      genesis = await createGenesis({
        creator: me, sign: deps.sign, name: p.name, avatar: p.avatar, groupType: p.groupType, guardianSettings: p.guardianSettings ?? null,
        members: [...new Set(p.members.filter((pk) => pk !== me))], key, kid, ts: deps.now(),
      });
    } catch (e) {
      throw new GroupOpError(e instanceof ChainReject ? e.reason : rejectReason(e));
    }
    const { gid, commit } = genesis;
    const blob = await sealGenesisEntry({ gid, genesis: wireOf(commit), kid, key });
    const row: PendingRow = { gid, id: commit.id, op: 'create', signed: JSON.stringify(wireOf(commit)), blob, args: null, state: 'append', createdAt: deps.now() };
    const keyRow: EpochKeyRow = { kid, key, v: 1, actor: me, origin: 'chain' };
    await deps.store.persistGroupLog({ gid, rows: [encodeCommitRow(gid, commit)], keys: [keyRow], pendingUpsert: [row] }, { flush: true });
    let seq: number;
    try {
      seq = await deps.log.append(gid, blob);
    } catch (e) {
      await deps.store.deleteGroupLog(gid);
      throw new GroupOpError(`append-failed:${(e as Error)?.message ?? e}`);
    }
    return queue(gid, async () => {
      const view = (await loadChainFromRows(gid, [encodeCommitRow(gid, commit)], deps.verify));
      if (!view.ok) throw new GroupOpError(view.reason);
      const rt = await newRuntime(gid, startLog({ view: view.view, me, headSeq: seq }), new Map([[kid, key]]));
      const invite: PendingRow = { ...row, state: 'invite', blob: null };
      rt.pending.set(invite.id, invite);
      await persistWhole(rt, [], { pendingUpsert: [invite] });
      project(rt);
      await perform(rt, [{ t: 'invite', id: commit.id }]);
      requestSync(gid);
      return gid;
    });
  }

  /**
   * 要求補抓這個群的 log（ping、交叉比對落後、收到還不認得的寄件者、計時器）。合併成一次；同一個群兩次同步至少隔
   * SYNC_MIN_INTERVAL_MS —— 成員狂送 ping 或名冊外的人狂送群訊，也只讓這台每隔幾秒抓一次 log。
   */
  function requestSync(gid: string): void {
    if (stopped || syncTimers.has(gid)) return;
    const wait = Math.max(SYNC_DEBOUNCE_MS, (lastSyncAt.get(gid) ?? 0) + (deps.minSyncIntervalMs ?? SYNC_MIN_INTERVAL_MS) - deps.now());
    syncTimers.set(gid, setTimeout(() => {
      syncTimers.delete(gid);
      const rt = runtimes.get(gid);
      if (!rt || rt.gone) return;
      lastSyncAt.set(gid, deps.now());
      queue(gid, () => settle(rt)).catch((e) => log('settle failed:', (e as Error)?.message ?? e));
    }, wait));
  }

  function syncAll(): void {
    for (const gid of runtimes.keys()) requestSync(gid);
    resumeJoins(ctx).catch((e) => log('resume joins failed:', (e as Error)?.message ?? e));
  }

  /** 真的連上（不是換 token）：每個群先補進度、再發 here（我的 head）。還沒載完 → 載完再發 */
  function announce(): void {
    if (stopped) return;
    if (!ready) { announcePending = true; return; }
    for (const rt of runtimes.values()) {
      if (rt.gone || rt.rep.status !== 'member' || deps.now() - rt.lastAnnounceAt < ANNOUNCE_MIN_INTERVAL_MS) continue;
      rt.lastAnnounceAt = deps.now();
      queue(rt.gid, async () => {
        await settle(rt);
        if (!rt.gone) await control.send(rt, 'here');
      }).catch((e) => log('announce failed:', (e as Error)?.message ?? e));
    }
  }

  /**
   * 定時 here（W5）：名冊上有不是我好友的人（deps.needsHere）的群，每 HERE_REFRESH_MS 發一則（他看不到我的 presence）。
   * 沒連上不發（here 是 QoS0，不排隊）；這一輪之前的半個間隔內已經發過 here（連上、回覆別人）的群跳過。
   * 不能送（needsRekey、等金鑰、剛換主題）照 control.send 的規則先留著（只留最新的一則）
   */
  function refreshHere(): void {
    if (stopped || !ready || !deps.needsHere || !(deps.connected?.() ?? true)) return;
    const every = deps.hereRefreshMs ?? HERE_REFRESH_MS;
    for (const rt of runtimes.values()) {
      if (rt.gone || rt.rep.status !== 'member') continue;
      const last = control.lastHere(rt.gid);
      // 時鐘被撥回去（since < 0）當成很久以前：不然定時 here 會停到時鐘追上來為止（審查 W5 L3）
      const since = last === null ? Infinity : deps.now() - last;
      if (since >= 0 && since < every / 2) continue;
      let needed = false;
      try {
        needed = deps.needsHere(rt.gid, rt.rep.view.state.members.map((m) => m.pk));
      } catch (e) {
        log('needs-here check failed:', (e as Error)?.message ?? e);
      }
      if (needed) control.send(rt, 'here').catch((e) => log('periodic here failed:', (e as Error)?.message ?? e));
    }
  }

  function scheduleHere(): void {
    if (stopped || !deps.needsHere) return;
    const every = deps.hereRefreshMs ?? HERE_REFRESH_MS;
    hereTimer = setTimeout(() => {
      hereTimer = null;
      try {
        refreshHere();
      } catch (e) {
        log('periodic here failed:', (e as Error)?.message ?? e);
      } finally {
        scheduleHere();   // 一次出錯不能讓之後的定時 here 全停（審查 W5 L3）
      }
    }, every + Math.floor(Math.random() * every * 0.1));
  }

  /**
   * 在這台忘掉一個群：拿不到目前那一代的金鑰（admin 都不在、還原時沒帶到）又離開不了（離開要那一代的金鑰寫 leave）。
   * 只刪本機的鏈、位置、金鑰、待送、確認中的邀請，不寫任何 commit：名冊上我還在，別人照常；之後被踢再被加回來會收到新的邀請。
   */
  function forgetGroup(gid: string): Promise<void> {
    return queue(gid, async () => {
      guard();
      // 確認中的邀請先刪：dropGroup 會接著 resumeJoins，不能又從它加回來
      await deps.store.persistGroupLog({ gid, pendingDrop: ['join'] });
      const rt = runtimes.get(gid);
      if (rt) await dropGroup(rt, 'forgotten');
      else {
        await deps.store.deleteGroupLog(gid);
        deps.project(gid, null);
      }
    });
  }

  // ============================================
  // 啟動
  // ============================================

  type StoredGroup = Awaited<ReturnType<EngineDeps['store']['loadGroupLogs']>>[number];

  /**
   * 本機存的一個群：整條鏈重驗、頭對得上才載入（對不上 → 整個刪掉）。驗鏈的時候被停掉（換帳號、登出）→ 不再改資料庫、
   * 不再投影到畫面（那已經是別的帳號的畫面；W5 複審）
   */
  async function loadStored(s: StoredGroup): Promise<boolean> {
    if (stopped) return false;
    let loaded = await loadChainFromRows(s.meta.gid, s.rows, deps.verify);
    if (stopped) return false;
    if (loaded.ok && loaded.view.state.head.id !== s.meta.headId) {
      // 鏈列比位置新（舊的工作在位置寫入之後才寫鏈列）：鏈列截到位置記的 head，對得上就用，不整個丟掉
      const upTo = await loadChainFromRows(s.meta.gid, s.rows.filter((r) => r.v <= s.meta.headV), deps.verify);
      if (stopped) return false;
      if (upTo.ok && upTo.view.state.head.id === s.meta.headId) {
        await deps.store.persistGroupLog({ gid: s.meta.gid, replaceFromV: s.meta.headV });
        loaded = upTo;
      }
    }
    if (stopped) return false;
    if (!loaded.ok || loaded.view.state.head.id !== s.meta.headId) {
      log(`stored chain of ${s.meta.gid.slice(0, 8)} does not verify (${loaded.ok ? 'head mismatch' : loaded.reason}) — dropped`);
      await deps.store.deleteGroupLog(s.meta.gid);
      deps.project(s.meta.gid, null);
      return false;
    }
    const m = s.meta;
    const rep: LogReplica = {
      me, view: loaded.view, processedSeq: m.processedSeq, headSeq: m.headSeq, firstSeq: m.firstSeq, baseV: m.baseV, joinAt: m.joinAt,
      appliedAt: m.appliedAt, waiting: m.waiting, status: m.status,
    };
    const rt = await newRuntime(m.gid, rep, new Map(s.keys.map((k) => [k.kid, k.key])), s.pending, m.rekeySeenAt);
    control.restore(rt);   // 上次沒送出去的「為所有人刪除」
    await seedPreviousTopic(rt);
    if (stopped) return false;
    project(rt);
    return true;
  }

  function start(): Promise<void> {
    started ??= (async () => {
      await deps.store.cleanupOrphans();
      for (const s of await deps.store.loadGroupLogs(me)) {
        if (stopped) return;
        await loadStored(s);
      }
      // 每個群的主題表算好再一次告訴 App（第一張 MQTT token 就帶齊群組主題，不先拿一張沒有的再換）
      await Promise.all([...runtimes.values()].map((rt) => refreshTopics(rt).catch(() => undefined)));
      if (stopped) return;   // 載入途中被停掉（換帳號）：不要再掛輪詢與定時 here（審查 W5 L4）
      ready = true;
      emitTopics(true);
      pollTimer = setInterval(() => { if (!stopped) syncAll(); }, deps.pollMs ?? 120_000);
      scheduleHere();
      syncAll();
      // 連上比引擎載完早（announcePending），或引擎是在已經連著的時候才建（換帳號、身分重新解鎖；審查 W2 #7）
      if (announcePending || deps.connected?.()) { announcePending = false; announce(); }
    })();
    return started;
  }

  async function adoptStored(): Promise<number> {
    if (!started || stopped) return 0;   // 還沒啟動：啟動時本來就會載入
    await started;
    let n = 0;
    for (const s of await deps.store.loadGroupLogs(me)) {
      if (runtimes.has(s.meta.gid)) continue;
      await queue(s.meta.gid, async () => {
        if (stopped || runtimes.has(s.meta.gid) || !(await loadStored(s))) return;
        n++;
        requestSync(s.meta.gid);
      });
    }
    return n;
  }

  function stop(): void {
    stopped = true;
    ready = false;
    if (pollTimer) clearInterval(pollTimer);
    if (hereTimer) clearTimeout(hereTimer);
    hereTimer = null;
    for (const t of syncTimers.values()) clearTimeout(t);
    syncTimers.clear();
    for (const rt of runtimes.values()) {
      if (rt.rekeyTimer) clearTimeout(rt.rekeyTimer);
      if (rt.inviteTimer) clearTimeout(rt.inviteTimer);
      if (rt.topicTimer) clearTimeout(rt.topicTimer);
      if (rt.graceTimer) clearTimeout(rt.graceTimer);
    }
    runtimes.clear();
  }

  const ctx: EngineCtx = {
    deps, runtimes, queue, logDeps, newRuntime, persistWhole, project, settle, absorb, perform, notice, requestSync,
    isStopped: () => stopped,
    /**
     * 剛加入：目前這一代的主題訂好了就送 sync，還沒訂好（或 tid 還在算）就等 onTopicReady／主題表算好（審查 W2 #2：
     * 主題還沒訂好時大家的回覆收不到）
     */
    syncWhenSubscribed: (rt) => {
      const tid = currentTid(rt);
      if (tid && (deps.topicReady?.(tid) ?? true)) control.send(rt, 'sync').catch((e) => log('sync failed:', (e as Error)?.message ?? e));
      else rt.syncOnTopic = true;
    },
  };

  const gossip = createGossip({
    deps, runtimes, queue, logDeps, absorb, perform, trailingActions, settle, notice, project, requestSync, isStopped: () => stopped,
  });

  const control = createControlPlane({
    deps, runtimes, requestSync, isStopped: () => stopped,
    gossip: (rt, theirs, from) => gossip.verdict(rt, theirs, from),
    ackedBy: (rt, from) => { ackedBy(ctx, rt, from).catch((e) => log('invite ack failed:', (e as Error)?.message ?? e)); },
  });

  const live = (gid: string): Runtime | undefined => {
    const rt = runtimes.get(gid);
    return rt && !rt.gone && rt.rep.status === 'member' ? rt : undefined;
  };

  return {
    start, stop, isReady: () => ready && !stopped, syncAll, requestSync, createGroup,
    addMember: (gid, pk) => propose(gid, 'add', { pk }),
    removeMember: (gid, pk) => propose(gid, 'remove', { pk }),
    setRole: (gid, pk, role) => propose(gid, 'role', { pk, role }),
    updateInfo: (gid, info) => propose(gid, 'info', { ...info }),
    leave: (gid) => propose(gid, 'leave', {}),
    deleteGroup: (gid) => propose(gid, 'delete', {}),
    async sendingKey(gid) {
      const rt = live(gid);
      if (!rt) return null;
      const got = await currentEpochKey(rt.rep, keyFor(rt));
      return got.ok ? { kid: got.kid, key: got.key } : null;
    },
    decryptKey(gid, kid) {
      const rt = runtimes.get(gid);
      if (!rt || !epochOfKey(rt.rep.view.state, kid)) return null;
      return rt.keys.get(kid) ?? null;
    },
    knows: (gid) => !!live(gid),
    isEpoch: (gid, kid) => !!runtimes.get(gid) && !!epochOfKey((runtimes.get(gid) as Runtime).rep.view.state, kid),
    isMember: (gid, pk) => !!live(gid) && !!memberOf((live(gid) as Runtime).rep.view.state, pk),
    joinedAt(gid, pk) {
      const rt = live(gid);
      const m = rt ? memberOf(rt.rep.view.state, pk) : undefined;
      return rt && m ? rt.rep.view.chain[m.addedAtV - 1]?.c.ts ?? null : null;
    },
    gossip: (gid) => (live(gid) ? headGossip((live(gid) as Runtime).rep) : null),
    onGossip(gid, theirs, from) {
      const rt = live(gid);
      if (rt) gossip.verdict(rt, theirs, from);
    },
    onSealed: (from, body) => handleSealed(ctx, from, body),
    async onControl(tid, from, envelope) {
      // tid → 群組只看自己的主題表（目前這一代＋重疊期的上一代）；表上沒有 → 不解密就丟
      const hit = findTopic(tid);
      return hit ? control.receive(hit.rt.gid, from, envelope, { tid, kid: hit.kid }) : control.unknownTopic();
    },
    topics: () => (ready && !stopped ? topicList() : []),
    async sendControl(gid, t, body) {
      const rt = live(gid);
      if (!rt) throw new GroupOpError('unknown-group');
      return control.send(rt, t, body);
    },
    announce,
    resendInvite(gid, pk) {
      return queue(gid, async () => {
        const rt = live(gid);
        return rt ? resendInvite(ctx, rt, pk) : false;
      });
    },
    flushControl() {
      for (const rt of runtimes.values()) control.onChange(rt);
    },
    onTopicReady(tid) {
      const hit = findTopic(tid);
      const rt = hit?.current ? live(hit.rt.gid) : undefined;
      if (!rt || !rt.syncOnTopic) return;
      rt.syncOnTopic = false;
      control.send(rt, 'sync').catch((e) => log('sync failed:', (e as Error)?.message ?? e));
    },
    forgetGroup,
    controlStats: () => control.stats(),
    backupOf: (gid) => (live(gid) ? backupOfRuntime(live(gid) as Runtime) : null),
    adoptStored,
    projectAll() {
      if (!ready || stopped) return null;
      const out = new Map<string, Group>();
      for (const rt of runtimes.values()) {
        if (rt.gone || rt.rep.status !== 'member') continue;
        out.set(rt.gid, viewOf(rt));
      }
      return out;
    },
  };
}

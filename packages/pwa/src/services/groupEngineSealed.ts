/**
 * 群組 log 引擎：封給身分金鑰的信封（邀請、金鑰索取與回覆）。核心在 groupEngine.ts。
 *
 * 邀請（decision 12，審查 M1）：我的 add 在 log 上套用之後才送；附整條驗過的鏈（到把他加進來的那筆）、加入那時的金鑰、
 *   headSeq／baseSeq，加回舊成員再附上一代的只讀 log 金鑰。收到的人：寄件人要是好友、沒被封鎖、而且就是寫那筆 add 的人；
 *   verifyInvite（App 在 Web Worker 跑）→ 從 baseSeq 抓伺服器 log → confirmInvite（自己那筆要在正典套用裡、剛好在 headSeq）才加入。
 *   確認中的邀請存成 join 列：沒抓到 log（網路）就退避重試，重開 App、重連、每次輪詢也會再試（24 小時後放棄）；
 *   本機還留著這個群（離線時被踢又被加回）也先存著，舊的群刪掉之後再試。邀請有額度（驗整條鏈很花 CPU）。
 * 回條與重送（W2）：加入成功（或已經是成員又收到同一份邀請）→ 回 ack { gid, id }。送出的邀請存成 sent 列，
 *   沒等到回條（或對方在群組主題上任何一則驗過的控制訊息）就照 INVITE_RESEND_MS 重送，最多 1 + INVITE_RESEND_MS.length 次；
 *   對方已經不在名冊上 → 不再送。
 * 金鑰：只收鏈上那一代、kc 對得上的（keyAuthorised），寄件人要是成員；只回答 mayReceiveKey 允許的人。
 */
import { confirmInvite, inviteParams, logKeyBytes, type LogApplyResult, type LogDeps, type LogEntry } from './groupLog';
import {
  epochOfKey, keyAuthorised, mayReceiveKey, memberOf, rotationOrder, verifyInvite, wireOf, commitIdOf, parseCommit, type GroupState,
  type InviteResult,
} from './groupState';
import {
  keyB64, parseInvite, parseInviteAck, parseKeyDist, parseKeyRequest, type EngineDeps, type EngineNotice, type InviteBody,
} from './groupEngineTypes';
import type { EpochKeyRow, PendingRow } from './groupLogStore';
import type { Action, Runtime } from './groupEngine';
import type { LogReplica } from './groupLog';

export interface EngineCtx {
  deps: EngineDeps;
  runtimes: Map<string, Runtime>;
  queue<T>(gid: string, fn: () => Promise<T>): Promise<T>;
  logDeps(rt: Runtime, extra?: Map<string, Uint8Array>): Promise<LogDeps>;
  newRuntime(gid: string, rep: LogReplica, keys: Map<string, Uint8Array>): Promise<Runtime>;
  persistWhole(rt: Runtime, keys: EpochKeyRow[], extra?: { pendingUpsert?: PendingRow[]; pendingDrop?: string[] }, flush?: boolean): Promise<void>;
  project(rt: Runtime): void;
  settle(rt: Runtime): Promise<void>;
  absorb(rt: Runtime, res: LogApplyResult): Promise<Action[]>;
  perform(rt: Runtime, actions: Action[]): Promise<boolean>;
  notice(n: EngineNotice): void;
  requestSync(gid: string): void;
  isStopped(): boolean;
  /** 剛加入：群組主題訂好之後送 sync（請大家報 head） */
  syncWhenSubscribed(rt: Runtime): void;
}

const KEY_ASK_INTERVAL_MS = 30_000;
const JOIN_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];
/** 抓到 headSeq 為止（跟著 more）；只是防呆的上限 */
const MAX_JOIN_PAGES = 1000;
/** 一直確認不了的邀請（網路、log 還沒到）最多留這麼久 */
const JOIN_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/**
 * 邀請額度（審查 W1 M-5：每份最大 512 KB、要驗整條鏈的簽章）：每個寄件人每分鐘幾份、全部每分鐘幾份。超過的先存著、
 * 一分鐘後再處理（不丟掉）；確認中的邀請最多存這麼多份
 */
const INVITES_PER_SENDER_PER_MIN = 2;
const INVITES_PER_MIN = 20;
const INVITE_DEFER_MS = 60_000;
const MAX_PENDING_JOINS = 50;
/** 每個寄件人最多存幾份確認中的邀請（滿了淘汰他自己最舊的那份，不會擠掉別人的，審查 W1 複審） */
const MAX_JOINS_PER_SENDER = 3;
/** 沒有 admin 可問金鑰時，改問其他成員最多幾個 */
const MAX_KEY_ASK_FALLBACK = 8;
const JOIN_ID = 'join';
/** 邀請送出後沒收到回條：隔這麼久重送（第 1 次送出之後最多再送這麼多次），之後放棄並通知畫面 */
export const INVITE_RESEND_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

const log = (...a: unknown[]) => console.error('[groupEngine]', ...a);

/** 這把 kid 在哪個版本指定、誰指定的 */
function keyRowOf(rt: Runtime, kid: string, key: Uint8Array): EpochKeyRow | null {
  const view = rt.rep.view;
  const e = epochOfKey(view.state, kid);
  return e ? { kid, key, v: e.v, actor: view.chain[e.v - 1]?.c.actor ?? '', origin: 'chain' } : null;
}

function seqOf(rt: Runtime, id: string): number | null {
  for (const [seq, head] of Object.entries(rt.rep.appliedAt)) if (head === id) return Number(seq);
  return null;
}

/** 版本 v 那時正在用的那一代 */
function epochAt(state: GroupState, v: number) {
  return state.epochs.filter((e) => e.v <= v).reduce((a, e) => (e.v > a.v ? e : a));
}

export async function handleSealed(ctx: EngineCtx, from: string, body: Record<string, unknown>): Promise<void> {
  if (ctx.isStopped()) return;
  if (body.kind === 'invite') await onInvite(ctx, from, body);
  else if (body.kind === 'ack') await onInviteAck(ctx, from, body);
  else if (body.kind === 'req') await onKeyRequest(ctx, from, body);
  else if (body.kind === 'dist') await onKeyDist(ctx, from, body);
}

// ============================================
// 送邀請（inviter）
// ============================================

/** sent 列（args 欄）：要收回條的人、已收到的、送了幾次、下次重送的時間 */
interface SentInvite {
  to: string[];
  acked: string[];
  sends: number;
  nextAt: number;
}

/** sent 列、或重送用完的 unacked 列的紀錄（壞掉的 → null） */
function sentOf(p: PendingRow): SentInvite | null {
  if ((p.state !== 'sent' && p.state !== 'unacked') || !p.args) return null;
  try {
    const s = JSON.parse(p.args) as Partial<SentInvite>;
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');
    return strings(s.to) && strings(s.acked) && Number.isSafeInteger(s.sends) && typeof s.nextAt === 'number'
      ? { to: s.to, acked: s.acked, sends: s.sends as number, nextAt: s.nextAt } : null;
  } catch {
    return null;
  }
}

/** 這一列是送出去、還沒收齊回條、到了重送時間的邀請（紀錄壞掉的 sent 列也算：重送一次、把紀錄寫回正確的樣子） */
export function inviteDue(p: PendingRow, now: number): boolean {
  if (p.state !== 'sent') return false;
  const s = sentOf(p);
  return !s || s.nextAt <= now;
}

/** 排下一次重送（每次同步後重排；到時候 requestSync → trailingActions 會送） */
export function scheduleInviteResend(ctx: EngineCtx, rt: Runtime): void {
  if (rt.inviteTimer) clearTimeout(rt.inviteTimer);
  rt.inviteTimer = null;
  if (rt.gone || ctx.isStopped()) return;
  let next = Infinity;
  for (const p of rt.pending.values()) if (p.state === 'sent') next = Math.min(next, sentOf(p)?.nextAt ?? Infinity);
  if (!Number.isFinite(next)) return;
  rt.inviteTimer = setTimeout(() => {
    rt.inviteTimer = null;
    if (!rt.gone && !ctx.isStopped()) ctx.requestSync(rt.gid);
  }, Math.max(1000, next - ctx.deps.now() + 100));
}

/** 送邀請（第一次、或到了重送時間還沒收齊回條）。送完記成 sent 列；重送次數用完就放棄（通知畫面） */
export async function sendInvite(ctx: EngineCtx, rt: Runtime, id: string): Promise<void> {
  const p = rt.pending.get(id);
  const now = ctx.deps.now();
  if (!p || (p.state !== 'invite' && !inviteDue(p, now))) return;
  const prev = sentOf(p);
  const { gid } = rt;
  const view = rt.rep.view;
  const state = view.state;
  const done = async () => {
    if (ctx.isStopped()) return;
    await ctx.deps.store.persistGroupLog({ gid, pendingDrop: [id] });
    rt.pending.delete(id);
  };
  const send = (to: string, body: Record<string, unknown>) => ctx.deps.sendSealed(to, { kind: 'invite', gid, ...body });
  /** 送完：還有人沒回條 → 記下次重送；次數用完 → 放棄 */
  const sent = async (to: string[]) => {
    const sends = (prev?.sends ?? 0) + 1;
    const acked = prev?.acked ?? [];
    if (sends > INVITE_RESEND_MS.length) {
      // 重送用完：不再自己送，但留著紀錄（unacked）—— 群組設定裡看得到「邀請還沒送到」、可以按一下再送一輪（審查 W2 複審 #11）
      if (ctx.isStopped()) return;
      const row: PendingRow = { ...p, state: 'unacked', blob: null, args: JSON.stringify({ to, acked, sends, nextAt: -1 }) };
      await ctx.deps.store.persistGroupLog({ gid, pendingUpsert: [row] });
      rt.pending.set(id, row);
      ctx.notice({ gid, kind: 'invite-unacked', reason: `${to.filter((pk) => !acked.includes(pk)).length}` });
      ctx.project(rt);
      return;
    }
    if (ctx.isStopped()) return;
    const row: PendingRow = { ...p, state: 'sent', blob: null, args: JSON.stringify({ to, acked, sends, nextAt: now + INVITE_RESEND_MS[sends - 1] }) };
    await ctx.deps.store.persistGroupLog({ gid, pendingUpsert: [row] });
    rt.pending.set(id, row);
  };
  /**
   * 還要等回條的人：要是「這一次」加進來的那個成員（addedAtV ＝ 那筆 add 的版本；genesis ＝ 1）。踢掉又加回來的人
   * 不再收到舊的那份邀請（舊的鏈、加入那時的舊金鑰；審查 W2 #6）—— 新的 add 有自己的一列
   */
  const waiting = (to: string[], addV: number) =>
    to.filter((pk) => memberOf(state, pk)?.addedAtV === addV && !(prev?.acked ?? []).includes(pk));

  if (p.op === 'create') {
    // 建群時就在名冊上的人：鏈只有 genesis、金鑰是第一代、headSeq ＝ baseSeq ＝ genesis 的 seq
    const genesis = view.chain[0];
    const seq = seqOf(rt, genesis.id);
    const kid = genesis.c.args.kid as string;
    const key = rt.keys.get(kid);
    if (genesis.id !== id || seq === null || !key) {
      log(`genesis invite of ${gid.slice(0, 8)} cannot be built — dropped`);
      await done();
      return;
    }
    const to = prev?.to ?? (genesis.c.args.members as string[]).filter((pk) => memberOf(state, pk));
    const targets = waiting(to, 1);
    if (targets.length === 0) { await done(); return; }
    for (const pk of targets) await send(pk, { chain: [wireOf(genesis)], kid, key: keyB64(key), headSeq: seq, baseSeq: seq });
    await sent(to);
    return;
  }

  const add = view.chain.find((x) => x.id === id)?.c;
  const params = inviteParams(rt.rep, id);
  if (!add || add.op !== 'add' || !params) {
    log(`invite for ${id.slice(0, 8)} cannot be built (not an applied add, or beyond the retained seqs) — dropped`);
    await done();
    return;
  }
  const target = add.args.pk as string;
  if (waiting([target], add.v).length === 0) {
    await done();   // 回條到了，或邀請還沒送（收到）就又被踢了
    return;
  }
  // 一般加人：加入那時正在用的那一代；加回舊成員：那筆 add 自己換的新一代，另附上一代的只讀 log 金鑰
  const kid = params.parentKid ? (add.args.kid as string) : epochAt(state, add.v).kid;
  const key = rt.keys.get(kid);
  const parentKey = params.parentKid ? rt.keys.get(params.parentKid) : undefined;
  if (!key || (params.parentKid && !parentKey)) {
    log(`invite for ${id.slice(0, 8)}: the key of that epoch is not held — dropped`);
    await done();
    return;
  }
  await send(target, {
    chain: params.chain, kid, key: keyB64(key), headSeq: params.headSeq, baseSeq: params.baseSeq,
    ...(parentKey ? { parentLogKey: keyB64(await logKeyBytes(parentKey, gid)) } : {}),
  });
  await sent([target]);
}

/** from 收到了我的邀請（他的 ack，或他在群組主題上一則驗過的控制訊息）：onlyId ＝ 只算那一份邀請 */
async function markAcked(ctx: EngineCtx, rt: Runtime, from: string, onlyId?: string): Promise<void> {
  for (const p of [...rt.pending.values()]) {
    if (onlyId && p.id !== onlyId) continue;
    const s = sentOf(p);
    if (!s || !s.to.includes(from) || s.acked.includes(from)) continue;
    const acked = [...s.acked, from];
    if (ctx.isStopped() || rt.gone) return;
    if (s.to.every((pk) => acked.includes(pk))) {
      await ctx.deps.store.persistGroupLog({ gid: rt.gid, pendingDrop: [p.id] });
      rt.pending.delete(p.id);
    } else {
      const row: PendingRow = { ...p, args: JSON.stringify({ ...s, acked }) };
      await ctx.deps.store.persistGroupLog({ gid: rt.gid, pendingUpsert: [row] });
      rt.pending.set(p.id, row);
    }
    if (p.state === 'unacked') ctx.project(rt);   // 畫面上的「邀請還沒送到」消掉
  }
}

/** 邀請重送用完還沒回條的成員（畫面：群組設定「邀請還沒送到 · 再送一次」）；只算「那一次」加進來、現在還在的人 */
export function unackedInvitees(rt: Runtime): string[] {
  const out = new Set<string>();
  const state = rt.rep.view.state;
  for (const p of rt.pending.values()) {
    if (p.state !== 'unacked') continue;
    const s = sentOf(p);
    const addV = p.op === 'create' ? 1 : rt.rep.view.chain.find((x) => x.id === p.id)?.c.v;
    if (!s || !addV) continue;
    for (const pk of s.to) if (!s.acked.includes(pk) && memberOf(state, pk)?.addedAtV === addV) out.add(pk);
  }
  return [...out];
}

/** 使用者按「再送一次」：把那一份邀請的紀錄重設成剛送出（重送的次數重新算），馬上送 */
export async function resendInvite(ctx: EngineCtx, rt: Runtime, pk: string): Promise<boolean> {
  const p = [...rt.pending.values()].find((x) => x.state === 'unacked' && (sentOf(x)?.to ?? []).includes(pk));
  const s = p ? sentOf(p) : null;
  if (!p || !s || ctx.isStopped()) return false;
  const row: PendingRow = { ...p, state: 'sent', args: JSON.stringify({ ...s, sends: 0, nextAt: ctx.deps.now() }) };
  await ctx.deps.store.persistGroupLog({ gid: rt.gid, pendingUpsert: [row] });
  rt.pending.set(p.id, row);
  await sendInvite(ctx, rt, p.id);
  ctx.project(rt);
  scheduleInviteResend(ctx, rt);
  return true;
}

const waitsForAck = (rt: Runtime, from: string): boolean =>
  [...rt.pending.values()].some((p) => { const s = sentOf(p); return !!s && s.to.includes(from) && !s.acked.includes(from); });

/** 群組主題上收到 from 一則驗過的控制訊息：他已經是成員、有目前這一代的金鑰 → 等於收到我的邀請了 */
export async function ackedBy(ctx: EngineCtx, rt: Runtime, from: string): Promise<void> {
  if (!waitsForAck(rt, from)) return;
  await ctx.queue(rt.gid, () => markAcked(ctx, rt, from));
}

async function onInviteAck(ctx: EngineCtx, from: string, body: Record<string, unknown>): Promise<void> {
  const a = parseInviteAck(body);
  const rt = a ? ctx.runtimes.get(a.gid) : undefined;
  if (!a || !rt || rt.gone || !waitsForAck(rt, from)) return;
  await ctx.queue(a.gid, () => markAcked(ctx, rt, from, a.id));
}

/** 邀請鏈最後那筆的 id（回條用；格式不對 → null） */
async function inviteHeadId(inv: InviteBody): Promise<string | null> {
  try {
    const last = inv.chain[inv.chain.length - 1] as { c?: unknown };
    return await commitIdOf(parseCommit(last?.c));
  } catch {
    return null;
  }
}

/**
 * 我已經是成員、而且套到了那份邀請的 add 之後 → 邀請用不到了，回條給邀請者（他就不再重送）。只回給寫那筆 add（或建群）、
 * 而且現在還是成員的人：不然一個知道 gid 與 commit id 的好友（例如被踢的前成員）就能問出我還在不在群裡（審查 W2 #8）
 */
async function ackIfJoined(ctx: EngineCtx, from: string, inv: InviteBody): Promise<boolean> {
  const me = ctx.deps.me;
  const rt = ctx.runtimes.get(inv.gid);
  if (!rt || rt.gone || rt.rep.status !== 'member' || !memberOf(rt.rep.view.state, me) || rt.rep.processedSeq < inv.headSeq) return false;
  if (!memberOf(rt.rep.view.state, from)) return false;
  const id = await inviteHeadId(inv);
  const c = id ? rt.rep.view.chain.find((x) => x.id === id)?.c : undefined;
  const addsMe = !!c && c.actor === from
    && ((c.op === 'add' && c.args.pk === me) || (c.op === 'create' && (c.args.members as string[]).includes(me)));
  if (!addsMe) return false;
  await ctx.deps.sendSealed(from, { kind: 'ack', gid: inv.gid, id }).catch((e) => log('invite ack failed:', (e as Error)?.message ?? e));
  return true;
}

// ============================================
// 收邀請（invitee）
// ============================================

const joining = new WeakMap<EngineCtx, Set<string>>();
const joiningOf = (ctx: EngineCtx): Set<string> => {
  let s = joining.get(ctx);
  if (!s) joining.set(ctx, (s = new Set()));
  return s;
};

/**
 * 存一份新的確認中邀請之前：同一個寄件人已經存了 MAX_JOINS_PER_SENDER 份 → 淘汰他最舊的那份（同一個群的會被覆寫，不算）；
 * 全部已經 MAX_PENDING_JOINS 份 → 不存。回傳能不能存
 */
async function makeRoomForJoin(ctx: EngineCtx, from: string, gid: string): Promise<boolean> {
  const heads = (await ctx.deps.store.listJoinHeads()).filter((h) => h.gid !== gid);
  const mine = heads.filter((h) => h.sender === from).sort((a, b) => a.createdAt - b.createdAt);
  let total = heads.length;
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_JOINS_PER_SENDER + 1))) {
    if (joiningOf(ctx).has(old.gid)) continue;
    await ctx.deps.store.persistGroupLog({ gid: old.gid, pendingDrop: [JOIN_ID] });
    total--;
  }
  return total < MAX_PENDING_JOINS;
}

const deferTimers = new WeakMap<EngineCtx, ReturnType<typeof setTimeout>>();
function deferResume(ctx: EngineCtx): void {
  if (deferTimers.has(ctx)) return;
  deferTimers.set(ctx, setTimeout(() => {
    deferTimers.delete(ctx);
    if (!ctx.isStopped()) resumeJoins(ctx).catch((e) => log('deferred invites failed:', (e as Error)?.message ?? e));
  }, INVITE_DEFER_MS));
}

/** 邀請額度：最近一分鐘收到的（每個 ctx 一份） */
const inviteTimes = new WeakMap<EngineCtx, { all: number[]; by: Map<string, number[]> }>();
function inviteAllowed(ctx: EngineCtx, from: string): boolean {
  let t = inviteTimes.get(ctx);
  if (!t) inviteTimes.set(ctx, (t = { all: [], by: new Map() }));
  const now = ctx.deps.now();
  const recent = (xs: number[]) => xs.filter((x) => now - x < 60_000);
  t.all = recent(t.all);
  const mine = recent(t.by.get(from) ?? []);
  const budget = ctx.deps.inviteBudget ?? { perSender: INVITES_PER_SENDER_PER_MIN, total: INVITES_PER_MIN };
  if (t.all.length >= budget.total || mine.length >= budget.perSender) return false;
  t.all.push(now);
  mine.push(now);
  t.by.set(from, mine);
  if (t.by.size > 256) for (const k of [...t.by.keys()].slice(0, t.by.size - 256)) t.by.delete(k);
  return true;
}

function encodeJoin(from: string, inv: InviteBody): string {
  return JSON.stringify({
    from, gid: inv.gid, chain: inv.chain, kid: inv.kid, key: keyB64(inv.key), headSeq: inv.headSeq, baseSeq: inv.baseSeq,
    ...(inv.parentLogKey ? { parentLogKey: keyB64(inv.parentLogKey) } : {}),
  });
}

async function onInvite(ctx: EngineCtx, from: string, body: Record<string, unknown>): Promise<void> {
  const inv = parseInvite(body);
  if (!inv) return;
  // 邀請一定來自好友（沿用以前的規則），封鎖的人拉不進群
  if (!(await ctx.deps.isFriend(from)) || (await ctx.deps.isBlocked(from))) {
    log(`invite to ${inv.gid.slice(0, 8)} from a non-friend or blocked sender — ignored`);
    return;
  }
  // join 列的 signed 欄放邀請者公鑰（額度與淘汰用，不必讀出整份邀請）
  const row: PendingRow = {
    gid: inv.gid, id: JOIN_ID, op: 'join', signed: from, blob: null, args: encodeJoin(from, inv), state: 'join', createdAt: ctx.deps.now(),
  };
  if (ctx.isStopped()) return;
  if (!(await makeRoomForJoin(ctx, from, inv.gid))) {
    log(`invite to ${inv.gid.slice(0, 8)}: too many invites waiting to be confirmed — ignored`);
    return;
  }
  if (!inviteAllowed(ctx, from)) {
    // 額度用完：先存著，一分鐘後（resumeJoins）再驗，不在這裡花 CPU
    await ctx.deps.store.persistGroupLog({ gid: inv.gid, pendingUpsert: [row] });
    log(`invite to ${inv.gid.slice(0, 8)}: invite budget spent for ${from.slice(0, 12)} — deferred`);
    deferResume(ctx);
    return;
  }
  if (ctx.runtimes.has(inv.gid)) {
    // 我已經加入、而且套到了這份邀請的 add：邀請者沒收到回條在重送 → 再回一次條就好
    if (await ackIfJoined(ctx, from, inv)) return;
    // 本機還有這個群：可能是離線時被踢、又被加回來，「被踢」還沒同步到。先存著、去同步；舊的群刪掉後 resumeJoins 會接手。
    //   先確認伺服器 log 真的到了 headSeq（到不了的永遠用不到，不存）
    try {
      if ((await ctx.deps.log.fetch(inv.gid, Math.max(0, inv.headSeq - 1), 1)).head < inv.headSeq) return;
    } catch {
      return;
    }
    if (ctx.isStopped()) return;
    await ctx.deps.store.persistGroupLog({ gid: inv.gid, pendingUpsert: [row] });
    ctx.requestSync(inv.gid);
    return;
  }
  const set = joiningOf(ctx);
  if (set.has(inv.gid)) {
    if (!ctx.isStopped()) await ctx.deps.store.persistGroupLog({ gid: inv.gid, pendingUpsert: [row] });   // 換成最新的那份
    return;
  }
  set.add(inv.gid);
  await ctx.queue(inv.gid, async () => {
    if (ctx.runtimes.has(inv.gid)) { set.delete(inv.gid); return; }
    await ctx.deps.store.persistGroupLog({ gid: inv.gid, pendingUpsert: [row] });
    await runJoin(ctx, from, inv, 0, row.createdAt);
  }).catch((e) => { set.delete(inv.gid); throw e; });
}

/** 從 after 之後抓到 upTo（含）為止（跟著 more；審查 W1 M-2：不能因為頁數上限就說 log-incomplete） */
async function fetchFrom(ctx: EngineCtx, gid: string, after: number, upTo: number): Promise<{ entries: LogEntry[]; head: number }> {
  const entries: LogEntry[] = [];
  let head = 0;
  let cursor = after;
  for (let page = 0; page < MAX_JOIN_PAGES && !ctx.isStopped(); page++) {
    const got = await ctx.deps.log.fetch(gid, cursor);
    entries.push(...got.entries);
    head = got.head;
    if (!got.more || got.entries.length === 0) break;
    cursor = got.entries[got.entries.length - 1].seq;
    if (cursor >= upTo) break;
  }
  return { entries, head };
}

type JoinOutcome = { retry: string } | null;

/** 跑一次加入；要重試就排下一次（一直確認不了、超過 24 小時才放棄）。joining 集合在整串重試結束時才清 */
async function runJoin(ctx: EngineCtx, from: string, inv: InviteBody, attempt: number, since: number): Promise<void> {
  const set = joiningOf(ctx);
  let out: JoinOutcome;
  try {
    out = await tryJoin(ctx, from, inv);
  } catch (e) {
    out = { retry: `error:${(e as Error)?.message ?? e}` };
  }
  if (!out || ctx.isStopped()) {
    set.delete(inv.gid);
    return;
  }
  if (ctx.deps.now() - since > JOIN_GIVE_UP_MS) {
    set.delete(inv.gid);
    await ctx.deps.store.persistGroupLog({ gid: inv.gid, pendingDrop: [JOIN_ID] }).catch(() => undefined);
    ctx.notice({ gid: inv.gid, kind: 'invite-rejected', reason: `gave-up:${out.retry}` });
    return;
  }
  if (attempt + 1 >= JOIN_RETRY_MS.length) {
    set.delete(inv.gid);   // 這一串退避用完：留著 join 列，下一次重連／輪詢（resumeJoins）從頭再試
    log(`invite to ${inv.gid.slice(0, 8)} still unconfirmed (${out.retry}) — will retry on the next sync`);
    return;
  }
  setTimeout(() => {
    if (ctx.isStopped()) { set.delete(inv.gid); return; }
    ctx.queue(inv.gid, async () => {
      if (ctx.runtimes.has(inv.gid)) { set.delete(inv.gid); return; }
      await runJoin(ctx, from, inv, attempt + 1, since);
    }).catch((e) => { set.delete(inv.gid); log('join retry failed:', (e as Error)?.message ?? e); });
  }, JOIN_RETRY_MS[attempt]);
}

async function tryJoin(ctx: EngineCtx, from: string, inv: InviteBody): Promise<JoinOutcome> {
  const { deps } = ctx;
  const { gid } = inv;
  const drop = async (reason: string): Promise<JoinOutcome> => {
    await deps.store.persistGroupLog({ gid, pendingDrop: [JOIN_ID] });
    ctx.notice({ gid, kind: 'invite-rejected', reason });
    log(`invite to ${gid.slice(0, 8)} rejected: ${reason}`);
    return null;
  };
  // 先便宜地看伺服器 log 有沒有到 headSeq（假的邀請多半在這裡就擋下，不必先驗整條鏈的簽章）
  let probe: { head: number };
  try {
    probe = await deps.log.fetch(gid, Math.max(0, inv.headSeq - 1), 1);
  } catch (e) {
    return { retry: `fetch:${(e as Error)?.message ?? e}` };
  }
  if (probe.head < inv.headSeq) return drop('head-seq-beyond-log');
  const verifyParams = { chain: inv.chain, gid, me: deps.me, key: { kid: inv.kid, key: inv.key } };
  const verified: InviteResult = deps.verifyInvite
    ? await deps.verifyInvite(verifyParams)
    : await verifyInvite({ ...verifyParams, verify: deps.verify });
  if (!verified.ok) return drop(verified.reason);
  if (verified.addedBy !== from) return drop('sender-is-not-the-adder');

  let got: { entries: LogEntry[]; head: number };
  try {
    got = await fetchFrom(ctx, gid, Math.max(0, inv.baseSeq - 1), inv.headSeq);
  } catch (e) {
    return { retry: `fetch:${(e as Error)?.message ?? e}` };
  }
  const extra = new Map([[inv.kid, inv.key]]);
  const logDeps: LogDeps = {
    verify: deps.verify, x25519: deps.x25519, myX25519Private: await deps.myX25519Private(), keyFor: (kid) => extra.get(kid) ?? null,
  };
  const conf = await confirmInvite({
    view: verified.view, me: deps.me, key: { kid: inv.kid, key: inv.key }, headSeq: inv.headSeq, baseSeq: inv.baseSeq,
    entries: got.entries, logHead: got.head, parentLogKey: inv.parentLogKey,
  }, logDeps);
  if (!conf.ok) {
    if (conf.retry) return { retry: conf.reason };
    return drop(conf.reason);
  }
  const res = conf.result;
  if (res.replica.status !== 'member') return drop(`status-${res.replica.status}`);
  if (ctx.isStopped()) return null;
  for (const k of res.newKeys) extra.set(k.kid, k.key);
  // 加回舊成員：基準點從上一代開始，只有用只讀 log 金鑰才解得開；那把確認完就丟了 → 之後的重建從加入那筆開始
  //   （那一代的金鑰在手上）。一般的加人照舊從加入那一代開始（重建時會再對照一次邀請）
  const join = res.replica.joinAt;
  const readd = !!join && verified.view.state.epoch.v === join.v;
  const replica = readd && join ? { ...res.replica, firstSeq: inv.headSeq, baseV: join.v } : res.replica;
  const rt = await ctx.newRuntime(gid, replica, extra);
  const keyRows = [...extra].map(([kid, key]) => keyRowOf(rt, kid, key)).filter((r): r is EpochKeyRow => r !== null);
  await ctx.persistWhole(rt, keyRows, { pendingDrop: [JOIN_ID] });
  ctx.project(rt);
  const asks: Action[] = res.keyMissing.map((m) => ({ t: 'ask-key' as const, kid: m.kid }));
  if (res.waiting) asks.push({ t: 'ask-key', kid: res.waiting.kid });
  if (asks.length) await ctx.perform(rt, asks);
  ctx.requestSync(gid);
  // 回條給邀請者（他就不再重送）；請大家報 head（馬上交叉比對我確認的這條 log 跟大家的一樣嗎）
  await deps.sendSealed(from, { kind: 'ack', gid, id: verified.view.state.head.id }).catch((e) => log('invite ack failed:', (e as Error)?.message ?? e));
  ctx.syncWhenSubscribed(rt);
  return null;
}

/**
 * 重開 App／重連／輪詢：還在確認中的邀請再試（同一個群已經在試的不重複）。本機還有這個群：我已經是成員、而且套到了
 * 那筆 add 之後 → 邀請用不到了，丟掉；否則（可能還沒同步到「被踢」）留著等。每次都重新看寄件人還是不是好友、有沒有被封鎖。
 */
export async function resumeJoins(ctx: EngineCtx): Promise<void> {
  const set = joiningOf(ctx);
  for (const row of await ctx.deps.store.loadPendingJoins()) {
    if (ctx.isStopped()) return;
    if (set.has(row.gid)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(row.args ?? '{}') as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const inv = parseInvite(raw);
    const from = typeof raw.from === 'string' ? raw.from : null;
    if (!inv || !from || ctx.deps.now() - row.createdAt > JOIN_GIVE_UP_MS) {
      await ctx.deps.store.persistGroupLog({ gid: row.gid, pendingDrop: [JOIN_ID] });
      if (inv) ctx.notice({ gid: row.gid, kind: 'invite-rejected', reason: 'gave-up' });
      continue;
    }
    const rt = ctx.runtimes.get(row.gid);
    if (rt) {
      // 已經是成員、套到了那筆 add 之後：邀請用不到了 → 丟掉（那筆 add 在我的鏈上就回條，邀請者就不再重送）
      if (!rt.gone && rt.rep.status === 'member' && memberOf(rt.rep.view.state, ctx.deps.me) && rt.rep.processedSeq >= inv.headSeq) {
        await ackIfJoined(ctx, from, inv);
        await ctx.deps.store.persistGroupLog({ gid: row.gid, pendingDrop: [JOIN_ID] });
      }
      continue;
    }
    if (!(await ctx.deps.isFriend(from)) || (await ctx.deps.isBlocked(from))) {
      await ctx.deps.store.persistGroupLog({ gid: row.gid, pendingDrop: [JOIN_ID] });
      log(`pending invite to ${row.gid.slice(0, 8)}: the sender is no longer a friend or is blocked — dropped`);
      continue;
    }
    if (!inviteAllowed(ctx, from)) {
      deferResume(ctx);
      continue;
    }
    set.add(row.gid);
    void ctx.queue(row.gid, async () => {
      if (ctx.runtimes.has(row.gid)) { set.delete(row.gid); return; }
      await runJoin(ctx, from, inv, 0, row.createdAt);
    }).catch((e) => { set.delete(row.gid); log('resume join failed:', (e as Error)?.message ?? e); });
  }
}

// ============================================
// 金鑰
// ============================================

/** 等某一代的金鑰：向 admin（與寫那筆換金鑰的人）要；同一把 30 秒最多問一次 */
export async function askForKey(ctx: EngineCtx, rt: Runtime, kid: string): Promise<void> {
  const now = ctx.deps.now();
  if (now - (rt.askedAt.get(kid) ?? 0) < KEY_ASK_INTERVAL_MS) return;
  rt.askedAt.set(kid, now);
  const view = rt.rep.view;
  const state = view.state;
  const targets = new Set(rotationOrder(state));
  const epoch = epochOfKey(state, kid);
  const actor = epoch ? view.chain[epoch.v - 1]?.c.actor : undefined;
  if (actor && memberOf(state, actor)) targets.add(actor);
  targets.delete(ctx.deps.me);
  // 沒有 admin 可問（例如我是唯一的 admin、自己的那份不見了）：問其他成員（mayReceiveKey 允許他們回答）
  if (targets.size === 0) {
    for (const m of state.members) if (m.pk !== ctx.deps.me && targets.size < MAX_KEY_ASK_FALLBACK) targets.add(m.pk);
  }
  ctx.notice({ gid: rt.gid, kind: 'key-wait' });
  for (const to of targets) {
    await ctx.deps.sendSealed(to, { kind: 'req', gid: rt.gid, kid }).catch((e) => log('key request failed:', (e as Error)?.message ?? e));
  }
}

async function onKeyRequest(ctx: EngineCtx, from: string, body: Record<string, unknown>): Promise<void> {
  const req = parseKeyRequest(body);
  const rt = req ? ctx.runtimes.get(req.gid) : undefined;
  if (!req || !rt || rt.gone || rt.rep.status !== 'member') return;
  const state = rt.rep.view.state;
  const epoch = epochOfKey(state, req.kid);
  // 只給現在的成員、而且不早於他加入時正在用的那一代（被踢、離開的人要不到；加入前的不給）
  if (!epoch || !mayReceiveKey(state, from, epoch.v)) return;
  const key = rt.keys.get(req.kid);
  if (!key || !(await keyAuthorised(state, req.kid, epoch.kc, key))) return;
  await ctx.deps.sendSealed(from, { kind: 'dist', gid: req.gid, kid: req.kid, key: keyB64(key) });
}

async function onKeyDist(ctx: EngineCtx, from: string, body: Record<string, unknown>): Promise<void> {
  const d = parseKeyDist(body);
  if (!d) return;
  await ctx.queue(d.gid, async () => {
    const rt = ctx.runtimes.get(d.gid);
    if (!rt || rt.gone || rt.keys.has(d.kid)) return;
    const state = rt.rep.view.state;
    const epoch = epochOfKey(state, d.kid);
    // 寄件人要是現在的成員；金鑰要是鏈上那一代、kc 對得上 —— 其他一律不收
    if (!memberOf(state, from) || !epoch || !(await keyAuthorised(state, d.kid, epoch.kc, d.key))) return;
    if (ctx.isStopped()) return;
    rt.keys.set(d.kid, d.key);
    const row = keyRowOf(rt, d.kid, d.key);
    await ctx.deps.store.persistGroupLog({
      gid: d.gid, keys: row ? [row] : [], activeKid: rt.keys.has(state.epoch.kid) ? state.epoch.kid : null,
    });
    ctx.project(rt);
    if (rt.rep.waiting?.kid === d.kid) ctx.requestSync(d.gid);
  });
}

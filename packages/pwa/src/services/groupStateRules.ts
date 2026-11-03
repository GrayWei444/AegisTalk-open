/**
 * 群組狀態鏈的規則（設計 B1／B5，決定 2026-10-22）：狀態、權限、狀態轉移、金鑰承諾、建群 —— 純函式，沒有 I/O、沒有模組層級的可變狀態。
 * 副本（分叉、緩衝、同步、邀請驗證、存表）在 groupState.ts，它也會把這裡的東西一起 export；呼叫端只 import groupState。
 *
 * 狀態：members {pk, role, addedAtV}、info {name, avatar, groupType, guardianSettings, addPolicy}、
 *   epoch {kid, kc, v}（kc = HMAC(K, "aegistalk-gkc-v1|" + gid + "|" + kid)；genesis 那一代 gid 是空字串）、epochs、
 *   needsRekey、former（曾被踢或離開的人）、demoted（曾被降級的人）、deleted。
 * 權限（對照 v-1 的狀態）：
 *   add    admin；addPolicy = 'members' 時任何成員（一般群組預設 members、守護群組預設 admins）；對象不是成員；未滿 50 人；
 *          對象在 former 裡 → 只有 admin 能加，而且一定帶新的 {kid, kc, kb}（加回來＝同一筆換金鑰）；第一次加入的人不能帶
 *   remove admin；對象是成員、不是自己；一定帶新的 {kid, kc}
 *   leave  本人；最後一個 admin 離開 → 從沒被降級過的成員裡 addedAtV 最小的（同版本取公鑰小的）自動成為 admin
 *          （都被降級過 → 全部裡 addedAtV 最小的；審查 L4）；needsRekey
 *   needsRekey 期間（有人離開、admin 還沒換金鑰）只收 rekey、remove（admin）與 leave；info、add、role、delete 一律拒收
 *          （needs-rekey，審查 M4）：離開的人手上還有舊金鑰、GET 不用登入，舊金鑰下不能再有新內容；也擋住「加分身→分身離開」無限長鏈
 *   rekey  只有 admin（log 模型決定 2：會換金鑰的 commit 只有 admin 能寫；成員不能用「換一把沒人拿得到的金鑰」卡住群組）。
 *          新一代的 kid 由位置與作者決定（epochKidFor，審查 L5），不會重複。
 *          有人離開 → needsRekey：成員先暫停控制訊息、P2P 不再送給離開的人，等 admin 換；哪位 admin 先動手由 shouldRekeyNow 用本機時間決定
 *   role／info／delete  admin；最後一個 admin 不能降級；delete 之後什麼都不收
 */
import { canonicalJson } from './mqttCredential';
import {
  checkDerivedKid, commitIdOf, deepFreeze, fail, genesisGid, parseCommit, rejectReason, signCommit, toB64Url, toBuf, utf8, MAX_MEMBERS, ZERO_ID,
  type AddPolicy, type Commit, type GroupOp, type GroupType, type GuardianGroupSettings, type MemberRole, type SignFn, type VerifiedCommit,
} from './groupStateCommit';

/** 輪換順序第 i 位在本機看到需要輪換之後 i × 這麼多秒還沒看到 rekey，就自己來（只在本機判斷，不寫進鏈） */
export const ROTATOR_STEP_SECONDS = 60;
const GKC_PREFIX = 'aegistalk-gkc-v1|';

export interface ChainMember {
  pk: string;
  role: MemberRole;
  addedAtV: number;
}

export interface GroupInfo {
  name: string;
  avatar: string;
  groupType: GroupType;
  guardianSettings: GuardianGroupSettings | null;
  addPolicy: AddPolicy;
}

export interface Epoch {
  kid: string;
  kc: string;
  /** 指定這把金鑰的 commit 版本 */
  v: number;
}

export interface GroupState {
  gid: string;
  /** 建群的人（＝genesis 的 actor；不是邀請我的人） */
  createdBy: string;
  createdAt: number;
  head: { v: number; id: string };
  /** 依公鑰排序 */
  members: readonly ChainMember[];
  info: GroupInfo;
  epoch: Epoch;
  /** 所有指定過的金鑰世代（舊的用來解舊訊息） */
  epochs: readonly Epoch[];
  needsRekey: boolean;
  /** 曾被踢或自己離開的人（依公鑰排序）：再加回來要同一筆換金鑰 */
  former: readonly string[];
  /** 曾經從 admin 被降成成員的人（依公鑰排序）：最後一個 admin 離開時不自動升他（審查 L4） */
  demoted: readonly string[];
  deleted: boolean;
}

export type CheckResult = { ok: true; state: GroupState } | { ok: false; reason: string };

// ============================================
// 狀態轉移
// ============================================

const sortMembers = (members: ChainMember[]): ChainMember[] => members.sort((a, b) => (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));

export function memberOf(state: GroupState, pk: string): ChainMember | undefined {
  return state.members.find((m) => m.pk === pk);
}

export function isAdmin(state: GroupState, pk: string): boolean {
  return memberOf(state, pk)?.role === 'admin';
}

/** 輪換順序：只有 admin，依公鑰排（成員不能換金鑰） */
export function rotationOrder(state: GroupState): string[] {
  return state.members.filter((m) => m.role === 'admin').map((m) => m.pk);
}

/**
 * 給呼叫端：現在該我換金鑰了嗎。鏈上只記 needsRekey；時間一律用本機的：
 * 從這台第一次看到 needsRekey 的 head 起算（呼叫端自己記），admin 第 i 位等 i × 60 秒還沒看到 rekey 就自己來。
 * 同時有好幾位 admin 送出 → 伺服器 log 先到的上，其他的 prev 過時、作者在新 head 上重看（多半已不需要）。
 */
export function shouldRekeyNow(state: GroupState, me: string, localSecondsSinceNeedsRekeySeen: number): boolean {
  if (!state.needsRekey || state.deleted || !Number.isFinite(localSecondsSinceNeedsRekeySeen)) return false;
  const i = rotationOrder(state).indexOf(me);
  return i >= 0 && localSecondsSinceNeedsRekeySeen >= i * ROTATOR_STEP_SECONDS;
}

/** 畫面狀態「等 admin 換金鑰」：有人離開後、admin 換金鑰之前，成員暫停群組控制訊息 */
export function waitingForAdminRekey(state: GroupState): boolean {
  return state.needsRekey && !state.deleted;
}

/** 這筆 commit 會換金鑰（rekey、remove、加回舊成員）→ 要帶新金鑰封裝包 */
export function carriesNewEpoch(c: Pick<Commit, 'op' | 'args'>): boolean {
  return c.op === 'rekey' || c.op === 'remove' || (c.op === 'add' && c.args.kid !== undefined);
}

/** 這筆 commit 套用之後的名冊（封裝新金鑰的對象）；只看 op 與對象，跟 kid／kc／kb 無關 */
export function rosterAfter(state: GroupState, op: GroupOp, pk?: string): string[] {
  const now = state.members.map((m) => m.pk);
  if (op === 'remove') return now.filter((x) => x !== pk);
  if (op === 'add' && pk && !now.includes(pk)) return [...now, pk].sort();
  return now;
}

const withPk = (list: readonly string[], pk: string): readonly string[] => (list.includes(pk) ? list : [...list, pk].sort());
const withFormer = (state: GroupState, pk: string): readonly string[] => withPk(state.former, pk);

function freshKid(state: GroupState, kid: string): void {
  if (state.epochs.some((e) => e.kid === kid)) fail('kid-reused');
}

function mergeInfo(info: GroupInfo, args: Record<string, unknown>): GroupInfo {
  const groupType = (args.groupType as GroupType | undefined) ?? info.groupType;
  const settingsGiven = Object.prototype.hasOwnProperty.call(args, 'guardianSettings');
  let guardianSettings = settingsGiven ? (args.guardianSettings as GuardianGroupSettings | null) : info.guardianSettings;
  if (groupType !== 'guardian') {
    if (settingsGiven && guardianSettings) fail('guardian-settings-on-normal-group');
    guardianSettings = null;
  }
  // 改成守護群組、沒指定加人規則 → 守護群組的預設（只有 admin 能加人）
  const becameGuardian = groupType === 'guardian' && info.groupType !== 'guardian';
  const addPolicy = (args.addPolicy as AddPolicy | undefined) ?? (becameGuardian ? 'admins' : info.addPolicy);
  return {
    name: (args.name as string | undefined) ?? info.name,
    avatar: (args.avatar as string | undefined) ?? info.avatar,
    groupType, guardianSettings, addPolicy,
  };
}

function withEpoch(state: GroupState, c: Commit): Pick<GroupState, 'epoch' | 'epochs' | 'needsRekey'> {
  freshKid(state, c.args.kid as string);
  const epoch: Epoch = { kid: c.args.kid as string, kc: c.args.kc as string, v: c.v };
  return { epoch, epochs: [...state.epochs, epoch], needsRekey: false };
}

function leaveMembers(state: GroupState, leaver: string): ChainMember[] {
  const rest = state.members.filter((m) => m.pk !== leaver);
  if (rest.length === 0 || rest.some((m) => m.role === 'admin')) return [...rest];
  // 最後一個 admin 走了：從沒被降級過的人裡最早加入的（addedAtV 最小，同版本取公鑰小的）接手；都被降級過才從全部裡挑（審查 L4）
  const neverDemoted = rest.filter((m) => !state.demoted.includes(m.pk));
  const pool = neverDemoted.length > 0 ? neverDemoted : rest;
  const successor = [...pool].sort((a, b) => a.addedAtV - b.addedAtV || (a.pk < b.pk ? -1 : 1))[0].pk;
  return rest.map((m) => (m.pk === successor ? { ...m, role: 'admin' as const } : m));
}

/** needsRekey 期間還收的 op（審查 M4） */
const ALLOWED_WHILE_REKEY_PENDING: readonly GroupOp[] = ['rekey', 'remove', 'leave'];

/** 檢查權限（對照 v-1 的 state），回傳套用後的新狀態（凍結）；不合格丟 ChainReject。groupState 內部用 */
export function transition(state: GroupState, c: Commit, id: string): GroupState {
  return deepFreeze(nextState(state, c, id));
}

function nextState(state: GroupState, c: Commit, id: string): GroupState {
  if (c.gid !== state.gid) fail('wrong-group');
  if (c.v !== state.head.v + 1 || c.prev !== state.head.id) fail('not-next');
  if (state.deleted) fail('group-deleted');
  const actor = memberOf(state, c.actor);
  if (!actor) fail('actor-not-member');
  if (state.needsRekey && !ALLOWED_WHILE_REKEY_PENDING.includes(c.op)) fail('needs-rekey');
  const admin = actor.role === 'admin';
  const next = { ...state, head: { v: c.v, id } };
  const target = typeof c.args.pk === 'string' ? c.args.pk : '';
  switch (c.op as Exclude<GroupOp, 'create'>) {
    case 'add': {
      if (!admin && state.info.addPolicy !== 'members') fail('add-admins-only');
      if (memberOf(state, target)) fail('already-member');
      if (state.members.length >= MAX_MEMBERS) fail('group-full');
      // 規則 5：曾經在群裡的人（被踢或離開）加回來，一定同一筆換金鑰；第一次加入的人不換
      const former = state.former.includes(target);
      const rekeys = c.args.kid !== undefined;
      if (former && !admin) fail('readd-admin-only');
      if (former && !rekeys) fail('readd-needs-rekey');
      if (!former && rekeys) fail('add-rekey-only-for-former');
      const members = sortMembers([...state.members, { pk: target, role: 'member', addedAtV: c.v }]);
      return rekeys ? { ...next, members, ...withEpoch(state, c) } : { ...next, members };
    }
    case 'remove':
      if (!admin) fail('not-admin');
      if (target === c.actor) fail('remove-self');
      if (!memberOf(state, target)) fail('target-not-member');
      return { ...next, members: state.members.filter((m) => m.pk !== target), former: withFormer(state, target), ...withEpoch(state, c) };
    case 'leave':
      return { ...next, members: leaveMembers(state, c.actor), former: withFormer(state, c.actor), needsRekey: true };
    case 'rekey':
      // log 模型決定 2：只有 admin 能換金鑰（成員換一把不給別人的金鑰就能讓群組永遠卡住）
      if (!admin) fail('not-admin');
      return { ...next, ...withEpoch(state, c) };
    case 'role': {
      if (!admin) fail('not-admin');
      const member = memberOf(state, target);
      if (!member) fail('target-not-member');
      if (member.role === c.args.role) fail('no-change');
      if (member.role === 'admin' && state.members.filter((m) => m.role === 'admin').length === 1) fail('last-admin');
      const members = state.members.map((m) => (m.pk === target ? { ...m, role: c.args.role as MemberRole } : m));
      return member.role === 'admin' ? { ...next, members, demoted: withPk(state.demoted, target) } : { ...next, members };
    }
    case 'info': {
      if (!admin) fail('not-admin');
      const info = mergeInfo(state.info, c.args);
      if (canonicalJson(info) === canonicalJson(state.info)) fail('no-change');
      return { ...next, info };
    }
    case 'delete':
      if (!admin) fail('not-admin');
      return { ...next, deleted: true };
    default:
      return fail('create-must-be-genesis');
  }
}

/** genesis → 第一版狀態（核對 gid）。groupState 內部用 */
export function genesisState(genesis: VerifiedCommit, gid: string): GroupState {
  const { c, id } = genesis;
  if (c.op !== 'create' || c.v !== 1) fail('not-genesis');
  if (genesisGid(id) !== gid) fail('gid-mismatch');
  const a = c.args;
  const epoch: Epoch = { kid: a.kid as string, kc: a.kc as string, v: 1 };
  const initial = (a.members as string[]).map((pk): ChainMember => ({ pk, role: 'member', addedAtV: 1 }));
  return deepFreeze({
    gid, createdBy: c.actor, createdAt: c.ts, head: { v: 1, id },
    members: sortMembers([{ pk: c.actor, role: 'admin', addedAtV: 1 }, ...initial]),
    info: {
      name: a.name as string, avatar: a.avatar as string, groupType: a.groupType as GroupType,
      guardianSettings: a.guardianSettings as GuardianGroupSettings | null, addPolicy: a.addPolicy as AddPolicy,
    },
    epoch, epochs: [epoch], needsRekey: false, former: [], demoted: [], deleted: false,
  });
}

/** 呼叫端送出前先檢查：這筆 commit 能不能接在 state 後面（簽章另驗） */
export async function checkCommit(state: GroupState, commit: Commit): Promise<CheckResult> {
  try {
    const c = parseCommit(commit);
    const next = transition(state, c, await commitIdOf(c));
    await checkDerivedKid(c);
    return { ok: true, state: next };
  } catch (e) {
    return { ok: false, reason: rejectReason(e) };
  }
}

/** 接在目前 head 之後的下一筆（gid、v、prev 自動填） */
export function proposeCommit(state: GroupState, actor: string, op: Exclude<GroupOp, 'create'>, args: Record<string, unknown>, ts: number): Commit {
  return { gid: state.gid, v: state.head.v + 1, prev: state.head.id, op, actor, args, ts };
}

// ============================================
// 金鑰（B5）
// ============================================

/** kc = HMAC-SHA256(K, "aegistalk-gkc-v1|" + gid + "|" + kid)，URL-safe base64；genesis 那一代 gid 是空字串 */
export async function keyCommitment(key: Uint8Array, gid: string, kid: string): Promise<string> {
  if (!(key instanceof Uint8Array) || key.length !== 32) fail('bad-key');
  const hmacKey = await crypto.subtle.importKey('raw', toBuf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmacKey, toBuf(utf8(`${GKC_PREFIX}${gid}|${kid}`)));
  return toB64Url(new Uint8Array(mac));
}

const kcGidOf = (state: GroupState, epoch: Epoch): string => (epoch.v === 1 ? '' : state.gid);

export function epochOfKey(state: GroupState, kid: string): Epoch | undefined {
  return state.epochs.find((e) => e.kid === kid);
}

/** 收到一把金鑰：鏈上有驗過的 create／remove／rekey 指定這個 {kid, kc}，而且金鑰算出來的 kc 對得上 */
export async function keyAuthorised(state: GroupState, kid: string, kc: string, key: Uint8Array): Promise<boolean> {
  const epoch = epochOfKey(state, kid);
  if (!epoch || epoch.kc !== kc) return false;
  try {
    return (await keyCommitment(key, kcGidOf(state, epoch), kid)) === kc;
  } catch {
    return false;
  }
}

/**
 * 回答金鑰索取：請求者在目前驗過的名冊上，而且那把金鑰的世代不早於「他加入時正在用的那一代」。
 * 加人不換金鑰（B3），所以新成員加入時用的那一代（epoch.v < addedAtV）一定要給得出去；更早結束的世代不給。
 */
export function mayReceiveKey(state: GroupState, requester: string, keyEpochV: number): boolean {
  const member = memberOf(state, requester);
  if (!member || state.deleted) return false;
  if (!state.epochs.some((e) => e.v === keyEpochV)) return false;
  const inForce = state.epochs.filter((e) => e.v <= member.addedAtV).reduce((a, e) => Math.max(a, e.v), 1);
  return keyEpochV >= inForce;
}

// ============================================
// 建群
// ============================================

export interface GenesisParams {
  creator: string;
  sign: SignFn;
  name: string;
  avatar?: string;
  groupType?: GroupType;
  guardianSettings?: GuardianGroupSettings | null;
  /** 不指定：守護群組 admins、一般群組 members */
  addPolicy?: AddPolicy;
  /** 一開始就在群裡的其他人（不含自己） */
  members?: string[];
  key: Uint8Array;
  kid: string;
  ts: number;
  /** 16 bytes 亂數（URL-safe base64）；測試用，預設隨機 */
  nonce?: string;
}

export async function createGenesis(p: GenesisParams): Promise<{ gid: string; commit: VerifiedCommit; state: GroupState }> {
  const groupType = p.groupType ?? 'normal';
  const nonce = p.nonce ?? toB64Url(crypto.getRandomValues(new Uint8Array(16)));
  const commit: Commit = {
    gid: '', v: 1, prev: ZERO_ID, op: 'create', actor: p.creator, ts: p.ts,
    args: {
      name: p.name, avatar: p.avatar ?? '', groupType, guardianSettings: p.guardianSettings ?? null,
      addPolicy: p.addPolicy ?? (groupType === 'guardian' ? 'admins' : 'members'), members: p.members ?? [],
      kid: p.kid, kc: await keyCommitment(p.key, '', p.kid), nonce,
    },
  };
  const signed = signCommit(commit, p.sign, p.creator);
  const verified: VerifiedCommit = deepFreeze({ ...signed, id: await commitIdOf(signed.c) });
  const gid = genesisGid(verified.id);
  return { gid, commit: verified, state: genesisState(verified, gid) };
}

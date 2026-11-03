/**
 * 群組狀態鏈（設計 B1／B4／B5；log 模型，決定 2026-10-22）—— 純函式：沒有 I/O、沒有 React、沒有模組層級的可變狀態。
 * 名冊、角色、群組資訊、目前的金鑰世代只能經「驗過簽章、照上一版狀態檢查過權限」的 commit 改變（規則在 groupStateRules.ts）。
 *
 * 排序交給伺服器的 append-only log（groupLog.ts）：鏈就是「log 順序裡、prev 接得上目前 head、簽章與權限都對」的 commit。
 * 沒有分叉選擇、沒有旁支：prev 不是目前 head 的一律過時（stale），作者在新的 head 上重送。
 * 被踢的人、被降級的前 admin 在舊位置簽的 commit 永遠過時；在 head 簽的照目前狀態檢查權限。
 * 這個檔案只管「一條直線的鏈」：從 genesis 一筆一筆接、邀請驗證、存表。回傳的東西全部凍結。
 */
import {
  commitBody, deepFreeze, fail, parseCommit, rejectReason, toVerifiedCommit, validCommitId, validGid,
  type SignedCommit, type VerifiedCommit, type VerifyFn,
} from './groupStateCommit';
import { genesisState, keyAuthorised, memberOf, transition, type GroupState } from './groupStateRules';

export * from './groupStateCommit';
export * from './groupStateRules';

/** 邀請附的整條鏈最多幾筆（信封本身另有 512 KB 上限） */
export const MAX_INVITE_COMMITS = 4096;

/** 一條驗過的直線鏈：chain[i].c.v === i + 1，state 是 head 之後的狀態 */
export interface ChainView {
  gid: string;
  chain: readonly VerifiedCommit[];
  state: GroupState;
}

export type ChainResult = { ok: true; view: ChainView } | { ok: false; reason: string };

/**
 * 接一筆（線上格式 {c, s}）：簽章、prev ＝ 目前 head、權限都對才接上，回傳新的 view（舊的不變）。
 * 已經在鏈上的 → 'duplicate'；prev 不是 head → 'stale'（作者要在新的 head 上重送）；其他照 ChainReject 的原因。
 */
export async function appendCommit(view: ChainView, raw: unknown, verify: VerifyFn): Promise<ChainResult> {
  try {
    const vc = await toVerifiedCommit(raw, verify);
    return { ok: true, view: appendVerified(view, vc) };
  } catch (e) {
    return { ok: false, reason: rejectReason(e) };
  }
}

/** 已驗過簽章的一筆接到 head 後面；不合格丟 ChainReject（groupLog 用） */
export function appendVerified(view: ChainView, vc: VerifiedCommit): ChainView {
  if (vc.c.v === 1 || view.chain.some((x) => x.id === vc.id)) fail('duplicate');
  if (vc.c.gid !== view.gid) fail('wrong-group');
  if (vc.c.prev !== view.state.head.id) fail('stale');
  const state = transition(view.state, vc.c, vc.id);
  return deepFreeze({ gid: view.gid, chain: [...view.chain, vc], state });
}

/** 從 genesis 開始、一筆接一筆的完整鏈（不接受缺號、亂序）：邀請驗證與 DB 載入共用 */
export async function loadChain(gid: string, commits: readonly unknown[], verify: VerifyFn, maxCommits = MAX_INVITE_COMMITS): Promise<ChainResult> {
  try {
    if (!validGid(gid)) fail('bad-gid');
    if (!Array.isArray(commits) || commits.length < 1 || commits.length > maxCommits) fail('bad-chain-length');
    const genesis = await toVerifiedCommit(commits[0], verify);
    let view: ChainView = deepFreeze({ gid, chain: [genesis], state: genesisState(genesis, gid) });
    for (const raw of commits.slice(1)) {
      const vc = await toVerifiedCommit(raw, verify);
      if (vc.c.v !== view.state.head.v + 1 || vc.c.prev !== view.state.head.id) fail('not-next');
      view = appendVerified(view, vc);
    }
    return { ok: true, view };
  } catch (e) {
    return { ok: false, reason: rejectReason(e) };
  }
}

/** 只有 genesis 的鏈（建群的人自己、或測試） */
export function startChain(gid: string, genesis: unknown, verify: VerifyFn): Promise<ChainResult> {
  return loadChain(gid, [genesis], verify);
}

export type InviteResult = { ok: true; view: ChainView; addedBy: string } | { ok: false; reason: string };

/**
 * 新成員收到邀請（B4，好友檢查由呼叫端做）：SHA-256(genesis) 對得上 gid；每一筆簽章與權限依序都對；
 * 最後一筆是把我加進來的（add 我、或只有 genesis 而 genesis 列了我）；附的金鑰就是目前那一代（kc 對得上）。
 * 這只證明鏈與金鑰本身沒問題：被踢的人、被降級的前 admin 在舊位置做的邀請也過得了（審查 M1）。
 * 一定還要用 groupLog.confirmInvite 對照伺服器 log（我那筆在正典套用裡、剛好在邀請說的 seq），通過才算加入。
 */
export async function verifyInvite(params: {
  chain: unknown;
  gid: string;
  me: string;
  key: { kid: string; key: Uint8Array };
  verify: VerifyFn;
}): Promise<InviteResult> {
  const { chain, gid, me, key, verify } = params;
  if (!Array.isArray(chain)) return { ok: false, reason: 'bad-chain-length' };
  const loaded = await loadChain(gid, chain, verify);
  if (!loaded.ok) return loaded;
  const { view } = loaded;
  const last = view.chain[view.chain.length - 1].c;
  const addsMe = (last.op === 'add' && last.args.pk === me) || (last.op === 'create' && (last.args.members as string[]).includes(me));
  if (!addsMe) return { ok: false, reason: 'last-commit-does-not-add-me' };
  const state = view.state;
  if (state.deleted || !memberOf(state, me)) return { ok: false, reason: 'not-a-member' };
  if (state.epoch.kid !== key.kid || !(await keyAuthorised(state, key.kid, state.epoch.kc, key.key))) {
    return { ok: false, reason: 'key-mismatch' };
  }
  return { ok: true, view, addedBy: last.actor };
}

/** 線上格式（給邀請、存表） */
export const wireOf = ({ c, s }: VerifiedCommit): SignedCommit => ({ c, s });

/** 表 group_commits(gid, v, id, prev, body, sig) 的一列；body 是正規 JSON（＝算 id 的那份） */
export interface GroupCommitRow {
  gid: string;
  v: number;
  id: string;
  prev: string;
  body: string;
  sig: string;
}

export function encodeCommitRow(gid: string, vc: VerifiedCommit): GroupCommitRow {
  return { gid, v: vc.c.v, id: vc.id, prev: vc.c.prev, body: commitBody(vc.c), sig: vc.s };
}

/** 一列 → 線上格式；欄位跟 body 不一致丟 ChainReject（id 由 loadChainFromRows 重算核對） */
export function decodeCommitRow(row: GroupCommitRow): SignedCommit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch {
    fail('row-bad-json');
  }
  const c = parseCommit(parsed);
  if (commitBody(c) !== row.body) fail('row-not-canonical');
  if (c.v !== row.v || c.prev !== row.prev || !validCommitId(row.id)) fail('row-mismatch');
  if (c.v === 1 ? !validGid(row.gid) : c.gid !== row.gid) fail('row-gid-mismatch');
  return { c, s: row.sig };
}

export async function loadChainFromRows(gid: string, rows: readonly GroupCommitRow[], verify: VerifyFn): Promise<ChainResult> {
  try {
    const sorted = [...rows].sort((a, b) => a.v - b.v);
    if (sorted.some((r) => r.gid !== gid)) fail('row-gid-mismatch');
    // 本機存的整條鏈不設筆數上限（上限只給別人送來的邀請）
    const loaded = await loadChain(gid, sorted.map(decodeCommitRow), verify, Number.POSITIVE_INFINITY);
    if (loaded.ok && loaded.view.chain.some((c, i) => c.id !== sorted[i].id)) fail('row-id-mismatch');
    return loaded;
  } catch (e) {
    return { ok: false, reason: rejectReason(e) };
  }
}

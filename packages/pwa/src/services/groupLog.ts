/**
 * 群組 log 模型（決定 2026-10-22，MLS delivery-service 式）—— 純函式：沒有 I/O、沒有模組層級的可變狀態。
 *
 * 伺服器只排序：每個群一條 append-only log（gid → seq），先到先排；內容對伺服器是不透明的 blob（格式在 groupLogEntry.ts）。
 * 客戶端照 log 順序套用：k 不是我目前這一代 → 不解密直接跳過；是目前這一代但我還沒有金鑰 → 停在這裡等（之後從這個 seq 繼續）；
 *   解不開、簽章不對、prev 不是 head（過時）、權限不對 → 跳過（每台都一樣）；其餘接上。我自己被跳過的過時 commit 回報給呼叫端重送。
 * 換金鑰的 commit（rekey、remove、加回舊成員；只有 admin 能寫）在 log entry 裡帶新金鑰的封裝包，commit 的 args.kb 綁住它：
 *   套用這筆＝拿到新金鑰；我的那份打不開或跟 kc 對不上 → 照樣套用，回報 keyMissing（畫面警告、向 admin 用 sealed req 要）。
 * head 交叉比對：每則群組訊息／here 帶 (seq, head id)；對不上＝伺服器給不同的人看不同的 log（發現、不防止）。
 * 這個檔案：作者端（buildCommitEntry、rebaseDraft）、套用（applyLog）、交叉比對；entry 與封裝包的格式也一起 export。
 */
import type { X25519Provider } from './identitySeal';
import { appendVerified, wireOf, type ChainView } from './groupState';
import {
  checkCommit, carriesNewEpoch, genesisState, keyAuthorised, keyCommitment, memberOf, proposeCommit, rosterAfter, transition, type GroupState,
} from './groupStateRules';
import {
  commitIdOf, deepFreeze, epochKidFor, fail, rejectReason, signCommit, toVerifiedCommit, validCommitId,
  type GroupOp, type SignFn, type SignedCommit, type VerifiedCommit, type VerifyFn,
} from './groupStateCommit';
import {
  bundleHash, openKeyBundle, openLogEntry, openLogEntryWithLogKey, parseBundle, peekEntryKid, sealKeyBundle, sealLogEntry,
  type KeyBundle, type LogEntry, type OpenedEntry,
} from './groupLogEntry';

export * from './groupLogEntry';

/** head 交叉比對留最近這麼多個「seq → 套上的 commit」 */
const MAX_APPLIED_AT = 4096;

// ============================================
// 寫一筆（作者端）
// ============================================

export interface BuiltEntry {
  signed: SignedCommit;
  id: string;
  /** 要 POST 給伺服器的 blob */
  blob: string;
  /** 換金鑰的 commit：新的一代（送出前呼叫端要先存好金鑰與 commit） */
  newEpoch?: { kid: string; key: Uint8Array };
  /** 封不了新金鑰的收件人（應該不會發生：成員公鑰進名冊時已檢查過）；他們會回報 keyMissing、向 admin 要 */
  skippedRecipients: string[];
}

/**
 * 在目前 head 上寫一筆並封成 log entry（用目前這一代的金鑰加密）。會換金鑰的 op（rekey、remove、加回舊成員）一定要給 newEpoch
 * （新金鑰；kid 由位置與作者決定，epochKidFor，回傳在 newEpoch.kid）：這裡算 kc、把新金鑰封給套用後名冊上的每一個人（含自己）、
 * kb 寫進 args。先用 checkCommit 檢查，不合格丟 ChainReject。
 * 重送（rebase）換金鑰的 commit 一定要用新的金鑰：過時那筆的封裝包已經給了當時的名冊（kid 會自動不同，金鑰要呼叫端換新的）。
 */
export async function buildCommitEntry(
  p: {
    view: ChainView; actor: string; sign: SignFn; op: Exclude<GroupOp, 'create'>; args: Record<string, unknown>; ts: number;
    epochKey: Uint8Array; newEpoch?: { key: Uint8Array; kid?: string };
  },
  deps: X25519Provider,
): Promise<BuiltEntry> {
  const state = p.view.state;
  const rekeys = p.op === 'rekey' || p.op === 'remove' || (p.op === 'add' && state.former.includes(p.args.pk as string));
  if (rekeys !== !!p.newEpoch) fail(rekeys ? 'needs-new-epoch' : 'no-new-epoch-for-this-op');
  let args = { ...p.args };
  let bundle: KeyBundle | undefined;
  let skippedRecipients: string[] = [];
  let newEpoch: BuiltEntry['newEpoch'];
  if (p.newEpoch) {
    const kid = await epochKidFor(state.head.id, p.actor);
    if (p.newEpoch.kid !== undefined && p.newEpoch.kid !== kid) fail('kid-not-derived');
    if (state.epochs.some((e) => e.kid === kid)) fail('kid-reused');
    const key = p.newEpoch.key;
    newEpoch = { kid, key };
    const sealed = await sealKeyBundle({ gid: state.gid, kid, key, recipients: rosterAfter(state, p.op, p.args.pk as string | undefined) }, deps);
    bundle = sealed.bundle;
    skippedRecipients = sealed.skipped;
    args = { ...args, kid, kc: await keyCommitment(key, state.gid, kid), kb: await bundleHash(bundle) };
  }
  const commit = proposeCommit(state, p.actor, p.op, args, p.ts);
  const checked = await checkCommit(state, commit);
  if (!checked.ok) fail(checked.reason);
  const signed = signCommit(commit, p.sign, p.actor);
  const blob = await sealLogEntry({ gid: state.gid, kid: state.epoch.kid, key: p.epochKey, commit: signed, bundle });
  return { signed, id: await commitIdOf(signed.c), blob, newEpoch, skippedRecipients };
}

/** genesis 的 log entry（用第一代金鑰） */
export function sealGenesisEntry(p: { gid: string; genesis: SignedCommit; kid: string; key: Uint8Array }): Promise<string> {
  return sealLogEntry({ gid: p.gid, kid: p.kid, key: p.key, commit: p.genesis });
}

/** 過時的 commit 重送前的草稿：同一個 op 與 args（換金鑰的拿掉 kid／kc／kb，要用新的金鑰重新建） */
export function rebaseDraft(stale: VerifiedCommit): { op: Exclude<GroupOp, 'create'>; args: Record<string, unknown>; needsNewEpoch: boolean } | null {
  if (stale.c.op === 'create') return null;
  const needsNewEpoch = carriesNewEpoch(stale.c);
  const { kid: _kid, kc: _kc, kb: _kb, ...rest } = stale.c.args;
  return { op: stale.c.op, args: needsNewEpoch ? rest : { ...stale.c.args }, needsNewEpoch };
}

// ============================================
// 套用 log（每位成員）
// ============================================

/**
 * member／removed／left／deleted：照鏈上的狀態。joining：邀請加入、正在對照 log 確認（從我那一代金鑰開始的地方套到把我加進來的那筆）；
 * not-joined：log 的正典套用裡沒有把我加進來的那筆（邀請是假的或在過時的分支上，審查 M1）
 */
export type LogStatus = 'joining' | 'member' | 'removed' | 'left' | 'deleted' | 'not-joined';

/** 停下來等某一代的金鑰：手上沒有（no-key），或手上那把對不上鏈上的 kc（key-mismatch：呼叫端要丟掉它、向 admin 要） */
export interface KeyWait {
  kid: string;
  seq: number;
  reason: 'no-key' | 'key-mismatch';
}

export interface LogReplica {
  me: string;
  view: ChainView;
  /** 已經處理到的 seq（下次從這之後抓；一定連號） */
  processedSeq: number;
  /** head 是在哪個 seq 套上的 */
  headSeq: number;
  /** 基準點：這台從哪個 seq 開始知道 log（建群的人＝genesis 的 seq）。重建（rebuildLog）從這裡重來 */
  firstSeq: number;
  /** 基準點那時的鏈版本：view.chain 的前 baseV 筆在基準點之前（重建時保留） */
  baseV: number;
  /** 邀請加入：把我加進來的那筆（版本與 id）；status 是 joining 時要在 log 裡套到它才算加入。建群的人是 null */
  joinAt: { v: number; id: string } | null;
  /** 最近套上的 commit：seq → id（head 交叉比對） */
  appliedAt: Readonly<Record<string, string>>;
  /** 卡在某一代的金鑰：停在這個 seq，拿到金鑰後從這裡繼續 */
  waiting: KeyWait | null;
  status: LogStatus;
}

/** 我還在不在群裡；不在的話，是自己離開（最後那筆是我的 leave）還是被踢 */
function statusOf(state: GroupState, me: string, last?: VerifiedCommit): LogStatus {
  if (state.deleted) return 'deleted';
  if (memberOf(state, me)) return 'member';
  return last && last.c.op === 'leave' && last.c.actor === me ? 'left' : 'removed';
}

/** 從一條驗過的鏈開始跟 log（建群的人：genesis 與它的 seq）：headSeq ＝ head 那筆在 log 的 seq，也是基準點 */
export function startLog(p: { view: ChainView; me: string; headSeq: number }): LogReplica {
  if (!Number.isSafeInteger(p.headSeq) || p.headSeq < 0) fail('bad-seq');
  return deepFreeze({
    me: p.me, view: p.view, processedSeq: p.headSeq, headSeq: p.headSeq, firstSeq: p.headSeq, baseV: p.view.state.head.v, joinAt: null,
    appliedAt: { [String(p.headSeq)]: p.view.state.head.id }, waiting: null, status: statusOf(p.view.state, p.me),
  });
}

export interface Skipped {
  seq: number;
  reason: string;
  id?: string;
  actor?: string;
}

export interface LogApplyResult {
  replica: LogReplica;
  applied: { seq: number; commit: VerifiedCommit }[];
  skipped: Skipped[];
  /** 我寫的、因為 prev 過時被跳過的：在新的 head 上重送（rebaseDraft） */
  staleOwn: VerifiedCommit[];
  /** 從換金鑰 commit 的封裝包拿到的新金鑰（呼叫端存起來） */
  newKeys: { kid: string; key: Uint8Array; v: number }[];
  /** 換金鑰 commit 已套用、但我的那份打不開或對不上 kc：畫面警告、向 admin 要（sealed req） */
  keyMissing: { kid: string; v: number }[];
  /** 停在等這一代的金鑰（null ＝ 沒卡住） */
  waiting: KeyWait | null;
  /** 伺服器給的 entries 缺了這幾號（from..to）：停在缺號前面，呼叫端從 processedSeq 重抓（null ＝ 沒缺） */
  gap: { from: number; to: number } | null;
}

export interface LogDeps {
  verify: VerifyFn;
  /** 呼叫端存的金鑰（kid → 32 bytes）；沒有回 null。拿到的一律先核對 kc 才用 */
  keyFor: (kid: string) => Uint8Array | null | undefined;
  myX25519Private: Uint8Array;
  x25519: X25519Provider;
}

async function newEpochKey(view: ChainView, vc: VerifiedCommit, bundle: unknown, rep: LogReplica, deps: LogDeps): Promise<Uint8Array | null> {
  const { kid, kc, kb } = vc.c.args as { kid: string; kc: string; kb: string };
  const parsed = parseBundle(bundle);
  if (!parsed || (await bundleHash(parsed)) !== kb) return null;
  const key = await openKeyBundle({ bundle: parsed, gid: view.gid, kid, me: rep.me, myX25519Private: deps.myX25519Private }, deps.x25519);
  if (!key) return null;
  return (await keyCommitment(key, view.gid, kid)) === kc ? key : null;
}

/**
 * 目前這一代的金鑰：先用這次套用從封裝包拿到的，再問呼叫端；呼叫端給的一律核對 kc（審查 M3：存錯的金鑰不能讓整代的 entry
 * 被當成「解不開」跳過 —— 那樣跳過之後就再也回不來）。
 */
async function epochKeyFor(state: GroupState, found: Map<string, Uint8Array>, keyFor: LogDeps['keyFor']): Promise<{ key: Uint8Array } | { wait: KeyWait['reason'] }> {
  const { kid, kc } = state.epoch;
  const cached = found.get(kid);
  if (cached) return { key: cached };
  const key = keyFor(kid);
  if (!key) return { wait: 'no-key' };
  if (!(await keyAuthorised(state, kid, kc, key))) return { wait: 'key-mismatch' };
  found.set(kid, key);
  return { key };
}

/**
 * 套上一筆之後的狀態。joining（審查 M1）：基準點是我那一代金鑰開始的地方、把我加進來的那筆不換金鑰 →
 * 到我那筆之前出現換金鑰的 commit、或那個版本套上的不是我那筆 → 我那筆永遠接不上了（not-joined）。
 */
function statusAfter(rep: LogReplica, view: ChainView, vc: VerifiedCommit): LogStatus {
  if (rep.status !== 'joining' || !rep.joinAt) return statusOf(view.state, rep.me, vc);
  if (view.state.head.v < rep.joinAt.v) return carriesNewEpoch(vc.c) ? 'not-joined' : 'joining';
  return view.state.head.id === rep.joinAt.id ? statusOf(view.state, rep.me, vc) : 'not-joined';
}

function withApplied(rep: LogReplica, seq: number, view: ChainView, vc: VerifiedCommit): LogReplica {
  const appliedAt = { ...rep.appliedAt, [String(seq)]: view.state.head.id };
  const keys = Object.keys(appliedAt);
  if (keys.length > MAX_APPLIED_AT) {
    for (const k of keys.map(Number).sort((a, b) => a - b).slice(0, keys.length - MAX_APPLIED_AT)) delete appliedAt[String(k)];
  }
  return { ...rep, view, processedSeq: seq, headSeq: seq, appliedAt, waiting: null, status: statusAfter(rep, view, vc) };
}

/**
 * 依 seq 順序套用伺服器給的 entries（seq ≤ processedSeq 的忽略）。同樣的 log、同樣的規則 → 每台得到同一條鏈。
 * 一定連號（審查 M3）：缺號 → 停在缺號前面、回報 gap（呼叫端重抓），不會把後面那筆當成過時跳過。
 * 目前這一代的金鑰沒有或對不上 kc → 停在這一筆等（waiting），拿到正確的金鑰後從這裡繼續。
 * 我不在群裡了（被踢、離開、群刪了），或邀請在 log 裡對不上（not-joined）就停。
 */
export function applyLog(start: LogReplica, entries: readonly LogEntry[], deps: LogDeps): Promise<LogApplyResult> {
  return runLog(start, entries, deps, null);
}

/** 只讀 log 金鑰（加回舊成員確認邀請時用）：只解 kid 這一代、只在 joining 時用；不進金鑰表、不出現在結果裡、不能拿來送東西 */
interface ReadOnlyLogKey {
  kid: string;
  logKey: Uint8Array;
}

/** 打開目前這一代的一筆：先用 kc 核對過的金鑰；joining 時、kid 是只讀那一代才用只讀 log 金鑰；都沒有 → 等 */
async function openEntry(rep: LogReplica, blob: string, kid: string, found: Map<string, Uint8Array>, deps: LogDeps, readOnly: ReadOnlyLogKey | null):
  Promise<{ opened: OpenedEntry } | { wait: KeyWait['reason'] }> {
  const got = await epochKeyFor(rep.view.state, found, deps.keyFor);
  if ('key' in got) return { opened: await openLogEntry({ blob, gid: rep.view.gid, key: got.key }) };
  if (readOnly && rep.status === 'joining' && kid === readOnly.kid) {
    return { opened: await openLogEntryWithLogKey({ blob, gid: rep.view.gid, logKey: readOnly.logKey }) };
  }
  return { wait: got.wait };
}

async function runLog(start: LogReplica, entries: readonly LogEntry[], deps: LogDeps, readOnly: ReadOnlyLogKey | null): Promise<LogApplyResult> {
  let rep = start;
  const applied: LogApplyResult['applied'] = [];
  const skipped: Skipped[] = [];
  const staleOwn: VerifiedCommit[] = [];
  const newKeys: LogApplyResult['newKeys'] = [];
  const keyMissing: LogApplyResult['keyMissing'] = [];
  let gap: LogApplyResult['gap'] = null;
  const found = new Map<string, Uint8Array>();
  const seen = new Set<number>();
  const ordered = [...entries]
    .filter((e) => e && Number.isSafeInteger(e.seq) && e.seq > start.processedSeq)
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => !seen.has(e.seq) && seen.add(e.seq).size > 0);   // 同一個 seq 只看第一筆
  const skip = (seq: number, reason: string, vc?: VerifiedCommit) => {
    skipped.push({ seq, reason, ...(vc ? { id: vc.id, actor: vc.c.actor } : {}) });
    rep = { ...rep, processedSeq: seq, waiting: null };
  };
  for (const e of ordered) {
    if (rep.status !== 'member' && rep.status !== 'joining') break;
    if (e.seq !== rep.processedSeq + 1) {
      gap = { from: rep.processedSeq + 1, to: e.seq - 1 };
      break;
    }
    const kid = peekEntryKid(e.blob);
    if (!kid) { skip(e.seq, 'malformed-entry'); continue; }
    if (kid !== rep.view.state.epoch.kid) { skip(e.seq, 'other-epoch'); continue; }
    let got: Awaited<ReturnType<typeof openEntry>>;
    try {
      got = await openEntry(rep, e.blob, kid, found, deps, readOnly);
    } catch (err) {
      skip(e.seq, rejectReason(err));
      continue;
    }
    if ('wait' in got) {
      rep = { ...rep, waiting: { kid, seq: e.seq, reason: got.wait } };
      break;
    }
    const opened = got.opened;
    let vc: VerifiedCommit;
    try {
      vc = await toVerifiedCommit(opened.commit, deps.verify);
    } catch (err) {
      skip(e.seq, rejectReason(err));
      continue;
    }
    let view: ChainView;
    try {
      view = appendVerified(rep.view, vc);
    } catch (err) {
      const reason = rejectReason(err);
      if (reason === 'stale' && vc.c.actor === rep.me) staleOwn.push(vc);
      skip(e.seq, reason, vc);
      continue;
    }
    if (carriesNewEpoch(vc.c) && memberOf(view.state, rep.me)) {
      const fresh = await newEpochKey(view, vc, opened.bundle, rep, deps);
      if (fresh) {
        found.set(vc.c.args.kid as string, fresh);
        newKeys.push({ kid: vc.c.args.kid as string, key: fresh, v: vc.c.v });
      } else {
        keyMissing.push({ kid: vc.c.args.kid as string, v: vc.c.v });
      }
    }
    rep = withApplied(rep, e.seq, view, vc);
    applied.push({ seq: e.seq, commit: vc });
  }
  return { replica: deepFreeze(rep), applied, skipped, staleOwn, newKeys, keyMissing, waiting: rep.waiting, gap };
}

/** 鏈的前 v 筆與當時的狀態（不重驗簽章：view.chain 裡的都驗過；只照規則重算狀態） */
function viewAt(view: ChainView, v: number): ChainView {
  if (!Number.isSafeInteger(v) || v < 1 || v > view.chain.length) fail('bad-base');
  if (v === view.chain.length) return view;
  let state = genesisState(view.chain[0], view.gid);
  for (const vc of view.chain.slice(1, v)) state = transition(state, vc.c, vc.id);
  return deepFreeze({ gid: view.gid, chain: view.chain.slice(0, v), state });
}

/**
 * 從基準點（firstSeq／baseV）整個重來（審查 M3）：head 交叉比對出現 conflict（伺服器給過我不同的 log）、或修好金鑰之後用。
 * entries ＝ 伺服器從 firstSeq 之後的 log（要連號；分頁的話照 gap 繼續抓、再呼叫 applyLog）。
 * 結果跟「一台從基準點開始、拿到同一份 log 的新客戶端」一樣；之前照錯的 log 套上的全部丟掉。
 * staleOwn 會把我被跳過的 commit 再報一次：呼叫端用 commit id 去重，已經重送過的不要再送。
 */
export async function rebuildLog(rep: LogReplica, entries: readonly LogEntry[], deps: LogDeps): Promise<LogApplyResult> {
  const base = viewAt(rep.view, rep.baseV);
  const joining = rep.joinAt !== null && rep.joinAt.v > rep.baseV;
  const start: LogReplica = deepFreeze({
    ...rep, view: base, processedSeq: rep.firstSeq, headSeq: rep.firstSeq,
    appliedAt: { [String(rep.firstSeq)]: base.state.head.id }, waiting: null, status: joining ? 'joining' : statusOf(base.state, rep.me),
  });
  return applyLog(start, entries, deps);
}

// ============================================
// 邀請對照 log（審查 M1）
// ============================================

export interface InviteParams {
  /** 鏈到把新成員加進來的那筆為止（線上格式） */
  chain: SignedCommit[];
  /** 那筆 add 在 log 的 seq */
  headSeq: number;
  /** 加入之前那一代金鑰開始的 seq（新成員從這裡對照 log；genesis 那一代就是 genesis 的 seq） */
  baseSeq: number;
  /**
   * 加回舊成員（那筆 add 本身換金鑰）：上一代的 kid。inviter 要另附那一代的只讀 log 金鑰（logKeyBytes(上一代金鑰, gid)），
   * 被加回的人才解得開自己那筆 add、對照 log；一般的加人是 null
   */
  parentKid: string | null;
}

function seqApplied(rep: LogReplica, id: string): number | null {
  for (const [seq, head] of Object.entries(rep.appliedAt)) if (head === id) return Number(seq);
  return null;
}

/**
 * inviter 看到自己的 add 上鏈之後，邀請要附的東西（另附加入那時的金鑰）。找不到（還沒套上、不是 add、超出保留範圍）→ null。
 */
export function inviteParams(rep: LogReplica, addId: string): InviteParams | null {
  const at = rep.view.chain.findIndex((x) => x.id === addId);
  if (at < 0 || rep.view.chain[at].c.op !== 'add') return null;
  // 加入之前（版本 at，也就是 add 的 v − 1）正在用的那一代：一般加人＝加入時那一代；加回舊成員＝被換掉的上一代
  const before = rep.view.state.epochs.filter((e) => e.v <= at).reduce((a, e) => (e.v > a.v ? e : a));
  const headSeq = seqApplied(rep, addId);
  const baseSeq = seqApplied(rep, rep.view.chain[before.v - 1].id);
  if (headSeq === null || baseSeq === null) return null;
  return { chain: rep.view.chain.slice(0, at + 1).map(wireOf), headSeq, baseSeq, parentKid: carriesNewEpoch(rep.view.chain[at].c) ? before.kid : null };
}

export type ConfirmReason =
  | 'bad-invite-seq' | 'head-seq-beyond-log' | 'log-incomplete' | 'add-not-in-log' | 'head-seq-mismatch'
  | 'missing-parent-log-key' | 'bad-parent-log-key';

export type ConfirmResult = { ok: true; result: LogApplyResult } | { ok: false; reason: ConfirmReason; retry: boolean };

const reject = (reason: ConfirmReason, retry = false): ConfirmResult => ({ ok: false, reason, retry });

/** genesis 的初始成員：genesis 那筆用第一代金鑰加密，我拿得到 → 直接核對 headSeq 那筆就是 genesis */
async function confirmGenesisMember(p: ConfirmParams, deps: LogDeps): Promise<ConfirmResult> {
  if (p.baseSeq !== p.headSeq) return reject('bad-invite-seq');
  const entry = p.entries.find((e) => e && e.seq === p.headSeq);
  if (!entry) return reject('log-incomplete', true);
  try {
    const opened = await openLogEntry({ blob: entry.blob, gid: p.view.gid, key: p.key.key });
    if ((await toVerifiedCommit(opened.commit, deps.verify)).id !== p.view.chain[0].id) return reject('add-not-in-log');
  } catch {
    return reject('add-not-in-log');
  }
  const res = await applyLog(startLog({ view: p.view, me: p.me, headSeq: p.headSeq }), p.entries, deps);
  return { ok: true, result: res };
}

export interface ConfirmParams {
  /** verifyInvite 驗過的鏈（最後一筆把我加進來） */
  view: ChainView;
  me: string;
  /** 邀請附的金鑰（加入那時的那一代，verifyInvite 核對過 kc） */
  key: { kid: string; key: Uint8Array };
  headSeq: number;
  baseSeq: number;
  /** 伺服器從 baseSeq 起（含 baseSeq）的 log，至少到 headSeq；要連號 */
  entries: readonly LogEntry[];
  /** 伺服器回的 head（最大 seq） */
  logHead: number;
  /**
   * 只有加回舊成員的邀請：上一代的只讀 log 金鑰（logKeyBytes）。只用來解上一代的 log entry、確認自己那筆 add；
   * 不進金鑰表、不出現在結果裡，確認完呼叫端就丟掉，絕不能拿來送東西。一般的加人不看它
   */
  parentLogKey?: Uint8Array;
}

/**
 * 新成員對照伺服器 log 確認邀請（審查 M1）：從我那一代金鑰開始的地方（baseSeq，那時的鏈＝邀請鏈的前段）用邀請附的金鑰套 log，
 * 把我加進來的那筆一定要在正典套用裡、而且剛好在 headSeq 套上，才收；否則拒收並回報原因（不會默默卡住）：
 *   head-seq-beyond-log：伺服器的 head 比 headSeq 還小（seq 太大或伺服器說謊）
 *   add-not-in-log：套到 headSeq 還沒有我那筆，或中途換了金鑰／接了別的 commit（被踢的人、被降級的前 admin 在舊位置做的邀請）
 *   head-seq-mismatch：我那筆有上鏈，但不在 headSeq
 *   log-incomplete（retry）：entries 還沒到 headSeq（缺號或沒抓完），抓完再呼叫一次
 *   missing-parent-log-key／bad-parent-log-key：加回舊成員的邀請沒附、或附錯上一代的只讀 log 金鑰
 * 加回舊成員（那筆 add 本身換金鑰、用上一代金鑰加密）：從上一代開始的地方用邀請附的上一代只讀 log 金鑰套 log（決定 2026-10-22 M1 補充）；
 * 那把只解得開上一代的 log entry，只在這次確認裡用；套上我那筆之後，新一代的金鑰從我那筆的封裝包拿（也跟邀請附的一致）。
 * 成功時回傳的 replica 已經是成員（基準點＝那一代開始的地方，之後 conflict 時 rebuildLog 會再對照一次），entries 裡 headSeq 之後的也套了。
 */
export async function confirmInvite(p: ConfirmParams, deps: LogDeps): Promise<ConfirmResult> {
  const okSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!okSeq(p.headSeq) || !okSeq(p.baseSeq) || !okSeq(p.logHead) || p.baseSeq > p.headSeq) return reject('bad-invite-seq');
  if (p.logHead < p.headSeq) return reject('head-seq-beyond-log');
  const state = p.view.state;
  const join = { v: state.head.v, id: state.head.id };
  const withKey: LogDeps = { ...deps, keyFor: (kid) => (kid === p.key.kid ? p.key.key : deps.keyFor(kid)) };
  if (join.v === 1) return confirmGenesisMember(p, withKey);
  const readd = state.epoch.v === join.v;
  if (readd && p.parentLogKey === undefined) return reject('missing-parent-log-key');
  if (readd && !(p.parentLogKey instanceof Uint8Array && p.parentLogKey.length === 32)) return reject('bad-parent-log-key');
  if (p.baseSeq === p.headSeq) return reject('bad-invite-seq');
  // 從加入之前那一代開始的地方：一般加人＝目前這一代；加回舊成員＝被我那筆換掉的上一代
  const before = readd ? state.epochs[state.epochs.length - 2] : state.epoch;
  const base = viewAt(p.view, before.v);
  const start: LogReplica = deepFreeze({
    me: p.me, view: base, processedSeq: p.baseSeq, headSeq: p.baseSeq, firstSeq: p.baseSeq, baseV: base.state.head.v, joinAt: join,
    appliedAt: { [String(p.baseSeq)]: base.state.head.id }, waiting: null, status: 'joining' as const,
  });
  const readOnly = readd ? { kid: before.kid, logKey: p.parentLogKey as Uint8Array } : null;
  const res = await runLog(start, p.entries, withKey, readOnly);
  const mine = res.applied.find((a) => a.commit.id === join.id);
  if (mine) return mine.seq === p.headSeq ? { ok: true, result: res } : reject('head-seq-mismatch');
  // 我那筆在 headSeq、外層是上一代的 kid，卻用附的只讀金鑰解不開 → 附錯了
  if (readd && res.skipped.some((x) => x.seq === p.headSeq && x.reason === 'undecryptable')) return reject('bad-parent-log-key');
  if (res.replica.status === 'not-joined' || res.replica.processedSeq >= p.headSeq) return reject('add-not-in-log');
  return reject('log-incomplete', true);
}

/**
 * 送東西（群組控制訊息、log entry）要用的金鑰（審查 L1）：只會是目前這一代、kc 核對過的那一把。
 * 拿不到 → { ok: false }：呼叫端暫停群組控制訊息、畫面「等金鑰」、向 admin 用 sealed req 要。
 * 絕不退回上一代：換金鑰的 commit 一旦套上，上一代的金鑰可能在剛被踢的人手上（營運方＋被踢的人換掉封裝包時，大家都會停在這裡）。
 */
export async function currentEpochKey(rep: LogReplica, keyFor: LogDeps['keyFor']):
  Promise<{ ok: true; kid: string; key: Uint8Array } | { ok: false; kid: string; reason: 'no-key' | 'key-mismatch' | 'not-member' }> {
  const kid = rep.view.state.epoch.kid;
  if (rep.status !== 'member') return { ok: false, kid, reason: 'not-member' };
  const got = await epochKeyFor(rep.view.state, new Map(), keyFor);
  return 'key' in got ? { ok: true, kid, key: got.key } : { ok: false, kid, reason: got.wait };
}

// ============================================
// head 交叉比對（伺服器給不同的人看不同的 log → 發現）
// ============================================

export interface HeadGossip {
  seq: number;
  id: string;
}

/** 我要附在群組訊息／here 裡的 (seq, head id) */
export function headGossip(rep: LogReplica): HeadGossip {
  return { seq: rep.headSeq, id: rep.view.state.head.id };
}

/**
 * same：一樣；i-am-behind：對方套到更後面的 seq → 我去抓；they-are-behind：對方的 head 是我走過的；
 * unknown：比我知道的還早（邀請加入之前、或超出保留範圍）；conflict：同一個 seq 兩邊套了不同的東西（或我跳過了對方套上的）
 * → 伺服器給了不同的 log（或有人說謊）：畫面警告、重抓。
 */
export function compareGossip(rep: LogReplica, theirs: unknown): 'same' | 'i-am-behind' | 'they-are-behind' | 'unknown' | 'conflict' {
  const t = theirs as Partial<HeadGossip> | null;
  if (!t || typeof t.seq !== 'number' || !Number.isSafeInteger(t.seq) || t.seq < 0 || !validCommitId(t.id)) return 'unknown';
  if (t.seq === rep.headSeq) return t.id === rep.view.state.head.id ? 'same' : 'conflict';
  if (t.seq > rep.processedSeq) return 'i-am-behind';
  const retained = Object.keys(rep.appliedAt).map(Number);
  if (t.seq < rep.firstSeq || t.seq < Math.min(...retained)) return 'unknown';
  const mine = rep.appliedAt[String(t.seq)];
  if (mine === undefined) return 'conflict';
  return mine === t.id ? 'they-are-behind' : 'conflict';
}

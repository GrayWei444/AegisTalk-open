/**
 * 群組 log 引擎：head 交叉比對（決定 2026-10-22 head gossip；W2 docs/GROUP_LOG_WIRING_W2.md）。核心在 groupEngine.ts。
 *
 * 每則簽過名的群訊（group_key_message 的明文）與每則 here／commit／sync 控制訊息都帶寄件人的 (seq, head id)：
 *   我落後 → 去抓；同一個 seq 對不上 → 畫面警告（Group.logConflict，記在是哪個成員對不上）、先問伺服器那一號
 *   （跟我當時處理的一樣 → 是對方被給了不同的 log，或對方亂說：不重建），伺服器真的改了給我的歷史 → 從基準點重抓、重建
 *   （會倒退的重建不採用）。之後同一個成員報來一致的 head、或重建之後我的鏈跟他報的一致，那一筆警告就清掉。
 */
import { compareGossip, openLogEntry, peekEntryKid, rebuildLog, type HeadGossip, type LogApplyResult, type LogDeps } from './groupLog';
import { checkCommit, genesisState, memberOf, toVerifiedCommit, transition, type VerifiedCommit } from './groupState';
import type { EngineDeps, EngineNotice } from './groupEngineTypes';
import type { GossipVerdict } from './groupEngineControl';
import type { Action, Runtime } from './groupEngine';

const REBUILD_MIN_INTERVAL_MS = 60_000;
/** 重建時跟著 more 一直抓（截斷的重建不採用）；這只是防呆的上限 */
const MAX_REBUILD_PAGES = 1000;
/** 畫面警告最多記幾個成員（名冊上限 50） */
const MAX_CONFLICT_PEERS = 64;

export interface GossipHost {
  deps: EngineDeps;
  runtimes: Map<string, Runtime>;
  queue<T>(gid: string, fn: () => Promise<T>): Promise<T>;
  logDeps(rt: Runtime): Promise<LogDeps>;
  absorb(rt: Runtime, res: LogApplyResult, opts?: { replaceFromV?: number }): Promise<Action[]>;
  perform(rt: Runtime, actions: Action[]): Promise<boolean>;
  trailingActions(rt: Runtime): Action[];
  settle(rt: Runtime): Promise<void>;
  notice(n: EngineNotice): void;
  project(rt: Runtime): void;
  requestSync(gid: string): void;
  isStopped(): boolean;
}

export interface Gossip {
  /** 比對 from 的 head：落後 → 抓；對不上 → 警告＋檢查伺服器＋必要時重建；一致 → 清掉 from 的警告 */
  verdict(rt: Runtime, theirs: unknown, from: string): GossipVerdict;
  /**
   * 第 round 輪同步剛抓完 log（complete ＝ 沒有 more、沒卡在等金鑰）：說過他比我新的成員 ——
   *   我現在追上了他說的那一號 → 再比一次（一樣 → 忘掉、清掉 server-behind-peer；那一號的 id 跟他說的不一樣 → 分叉：畫面警告 head-differs。
   *   這裡不馬上問伺服器／重建：剛抓到的就是伺服器現在給的，馬上再問一次多半還是一樣、又佔掉這個群一分鐘一次的重建額度；
   *   下一則對不上的 head（任何成員的）照一般的交叉比對處理）
   *   在他那句話之後才開始的這一輪抓完了還是比他舊 → 伺服器只給我看到前面一段（扣著後面的不給，W5 S12）→ 畫面警告 server-behind-peer
   *   （他那句話之前就開始的、沒抓完的都不算；他已經有別的、更嚴重的警告 → 不蓋掉）
   */
  checkBehind(rt: Runtime, complete: boolean, round: number): void;
}

export function createGossip(host: GossipHost): Gossip {
  const { deps } = host;
  const log = (...a: unknown[]) => console.error('[groupEngine]', ...a);

  function markConflict(rt: Runtime, from: string, reason: string, head: HeadGossip): void {
    if (rt.gone) return;
    const was = rt.conflicts.get(from);
    if (!was && rt.conflicts.size >= MAX_CONFLICT_PEERS) return;
    rt.conflicts.set(from, { reason, head });
    if (!was) host.project(rt);
  }

  /** 重建之後：當時對不上的 head 現在跟我的鏈一致了 → 那幾筆警告清掉 */
  function recheckConflicts(rt: Runtime): void {
    let changed = false;
    for (const [pk, c] of rt.conflicts) {
      const v = compareGossip(rt.rep, c.head);
      if (v === 'same' || v === 'they-are-behind') { rt.conflicts.delete(pk); changed = true; }
    }
    if (changed) host.project(rt);
  }

  function clearConflict(rt: Runtime, from: string): void {
    if (rt.gone || !rt.conflicts.delete(from)) return;
    host.project(rt);
  }

  /**
   * 交叉比對說 seq 那裡不一樣：伺服器現在給我的那一筆，跟我當時處理的一樣嗎？（審查 W1 HIGH-3：一則成員自己簽的群訊就能
   * 宣稱任何 head；只憑對方一句話就重建是破壞性的）。伺服器對我前後一致 → 重建只會得到同一條鏈，不做；
   * 只有伺服器現在給的跟我當時套上的不同（或當時套得上、我卻沒套）才算伺服器改了歷史。打不開那一筆（沒有那一代的金鑰）→ 不重建。
   */
  async function serverChangedHistory(rt: Runtime, seq: number): Promise<boolean> {
    if (seq < rt.rep.firstSeq || seq > rt.rep.processedSeq) return false;
    const got = await deps.log.fetch(rt.gid, seq - 1, 1);
    const entry = got.entries.find((e) => e.seq === seq);
    if (!entry) return true;   // 我處理過的那一號，伺服器現在說沒有
    const mine = rt.rep.appliedAt[String(seq)];
    const kid = peekEntryKid(entry.blob);
    const key = kid ? rt.keys.get(kid) : undefined;
    if (!key) return false;
    let vc: VerifiedCommit;
    try {
      vc = await toVerifiedCommit((await openLogEntry({ blob: entry.blob, gid: rt.gid, key })).commit, deps.verify);
    } catch {
      return mine !== undefined;   // 我當時在這一號套上了東西，現在卻是打不開／不合格的 entry
    }
    if (mine !== undefined) return mine !== vc.id;
    // 我當時跳過了這一號：只有它在那時真的套得上（接在那時的 head 後面、是那時那一代的 kid、規則收）才表示伺服器換了內容
    //   （審查 W1 複審：成員先 append 一筆會被規則拒收的 commit，再宣稱 head 在那一號，就能每分鐘逼一次整份重建）
    let headThen: string | undefined;
    let best = -1;
    for (const [k, id] of Object.entries(rt.rep.appliedAt)) {
      const n = Number(k);
      if (n < seq && n > best) { best = n; headThen = id; }
    }
    const chain = rt.rep.view.chain;
    const at = headThen === undefined ? -1 : chain.findIndex((x) => x.id === headThen);
    if (at < 0 || vc.c.prev !== headThen || chain.some((x) => x.id === vc.id)) return false;
    let stateThen = genesisState(chain[0], rt.gid);
    for (const x of chain.slice(1, at + 1)) stateThen = transition(stateThen, x.c, x.id);
    return kid === stateThen.epoch.kid && (await checkCommit(stateThen, vc.c)).ok;
  }

  /**
   * 伺服器改了給我的歷史：從基準點整個重抓、在暫存的 replica 上重建（每個群一分鐘最多一次）。重建的結果只有「完整、
   * 還是成員、沒卡在等金鑰或缺號、不比現在落後、而且包含我現在的 head」才採用；否則保留現在的狀態、只通知畫面
   * （不倒退名冊、不刪群：伺服器對不同的人給不同的 log 時，沒辦法知道哪一條才對，丟掉已經套上的 commit 反而危險，
   * 例如被踢的人回到名冊上）。
   */
  function requestRebuild(gid: string, theirs: HeadGossip, from: string): void {
    const rt = host.runtimes.get(gid);
    if (!rt || deps.now() - rt.lastRebuildAt < REBUILD_MIN_INTERVAL_MS) return;
    rt.lastRebuildAt = deps.now();
    host.queue(gid, async () => {
      if (rt.gone) return;
      if (!(await serverChangedHistory(rt, theirs.seq))) {
        markConflict(rt, from, 'peer-disagrees', theirs);
        host.notice({ gid, kind: 'conflict', reason: 'peer-disagrees' });
        return;
      }
      markConflict(rt, from, 'server-changed-history', theirs);
      host.notice({ gid, kind: 'conflict', reason: 'server-changed-history' });
      const entries = [];
      let after = rt.rep.firstSeq;
      let complete = false;
      for (let page = 0; page < MAX_REBUILD_PAGES && !host.isStopped(); page++) {
        const got = await deps.log.fetch(gid, after);
        entries.push(...got.entries);
        if (!got.more || got.entries.length === 0) { complete = true; break; }
        after = got.entries[got.entries.length - 1].seq;
      }
      const res = complete ? await rebuildLog(rt.rep, entries, await host.logDeps(rt)) : null;
      const headId = rt.rep.view.state.head.id;
      const keepsHead = !!res && res.replica.view.chain.some((vc) => vc.id === headId);
      if (!res || res.replica.status !== 'member' || res.waiting || res.gap || res.replica.processedSeq < rt.rep.processedSeq || !keepsHead) {
        const why = !res ? 'truncated' : res.replica.status !== 'member' ? `status-${res.replica.status}` : res.waiting ? 'waiting-key'
          : res.gap ? 'gap' : !keepsHead ? 'would-regress' : 'behind';
        log(`rebuild of ${gid.slice(0, 8)} not adopted (${why}) — keeping the current chain`);
        markConflict(rt, from, `rebuild-not-adopted:${why}`, theirs);
        host.notice({ gid, kind: 'conflict', reason: `rebuild-not-adopted:${why}` });
        return;
      }
      const actions = await host.absorb(rt, res, { replaceFromV: rt.rep.baseV });
      recheckConflicts(rt);
      if (!rt.gone && (await host.perform(rt, [...actions, ...host.trailingActions(rt)]))) await host.settle(rt);
    }).catch((e) => log('rebuild failed:', (e as Error)?.message ?? e));
  }

  function verdict(rt: Runtime, theirs: unknown, from: string): GossipVerdict {
    if (rt.gone || rt.rep.status !== 'member' || !memberOf(rt.rep.view.state, from)) return 'unknown';
    const v = compareGossip(rt.rep, theirs);
    if (v === 'i-am-behind') {
      // 只記他第一次說的（追上那一號之前不換）：活躍的群每則群訊都帶 head，一直換成最新的，就永遠等不到「他說了之後才開始的一輪」
      if (!rt.behindPeers.has(from) && rt.behindPeers.size < MAX_CONFLICT_PEERS) rt.behindPeers.set(from, { head: theirs as HeadGossip, round: rt.syncRound });
      host.requestSync(rt.gid);
    } else if (v === 'conflict') {
      markConflict(rt, from, 'head-differs', theirs as HeadGossip);
      requestRebuild(rt.gid, theirs as HeadGossip, from);
    } else if (v === 'same' || v === 'they-are-behind') {
      rt.behindPeers.delete(from);
      clearConflict(rt, from);
    }
    return v;
  }

  function checkBehind(rt: Runtime, complete: boolean, round: number): void {
    if (rt.gone || rt.behindPeers.size === 0) return;
    for (const [pk, { head, round: saidAt }] of [...rt.behindPeers]) {
      const reason = rt.conflicts.get(pk)?.reason;
      if (!memberOf(rt.rep.view.state, pk)) {
        rt.behindPeers.delete(pk);
        if (reason === 'server-behind-peer') clearConflict(rt, pk);
        continue;
      }
      if (rt.rep.processedSeq >= head.seq) {
        rt.behindPeers.delete(pk);
        // 追上了那一號：伺服器給我的那一號跟他說的不一樣 → 分叉（不是扣著）：警告；重建交給下一則對不上的 head
        const v = compareGossip(rt.rep, head);
        if (v === 'conflict') {
          if (!reason || reason === 'server-behind-peer') markConflict(rt, pk, 'head-differs', head);
        } else if (reason === 'server-behind-peer') clearConflict(rt, pk);
        continue;
      }
      if (!complete || round <= saidAt) continue;
      if (reason && reason !== 'server-behind-peer') continue;   // 已經有更嚴重的警告（對不上、伺服器改了歷史…）：不蓋掉
      if (!reason) host.notice({ gid: rt.gid, kind: 'conflict', reason: 'server-behind-peer' });
      markConflict(rt, pk, 'server-behind-peer', head);
    }
  }

  return { verdict, checkBehind };
}

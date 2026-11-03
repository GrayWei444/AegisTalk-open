/**
 * 群組控制訊息 group_sealed 的收發（W2，docs/GROUP_LOG_WIRING_W2.md；W3 主題 id，docs/GROUP_LOG_WIRING_W3.md）。
 * 信封格式在 groupControl.ts，主題表在 groupTopics.ts，引擎核心在 groupEngine.ts。
 *
 * 群組主題上只剩一種 MQTT 型別 group_sealed：AES-GCM（K_ctl ＝ 目前這一代金鑰推出來的），AAD ＝ tid|kid|寄件人，
 * 內層由寄件人的身分金鑰簽（"aegistalk-gctl-v1:"，簽章裡有 kid）。主題 mist/group/{tid}/{寄件人}：tid 由那一代的金鑰推出來
 * （W3），所以主題本身就決定了是哪一代。種類：
 *   commit  我的 commit 在 log 上套用了：{ head: { seq, id } }（取代 W1 的 group_log_ping）。用那筆 entry 本身的那一代加密
 *           （換金鑰的 commit ＝ 上一代）：看得懂通知的人本來就打得開那筆 entry，不多洩漏；剛被踢的人也因此會去抓、發現自己被踢
 *   here    上線（真的連上，不含換 token 的重連）時的 head，QoS0；對方落後或對不上時回一則 here。名冊上有非好友時另外
 *           每 4 分鐘發一則（W5，groupEngine refreshHere：非好友看不到我的 presence，10 分鐘沒有 here 就當我離線）
 *   sync    請大家報 head（加入之後、重建之後）：收到的人回 here
 *           here／sync 也代表寄件人剛連上：W4 起非好友的同群成員看不到彼此的 presence，App 靠 deps.onMemberSeen 知道誰在線；
 *           他看不到我（deps.answerHere：不是好友、我這邊也沒看到他）→ 回一則 here 讓他知道我在線（W4 審查 #2；我 10 秒內發過
 *           here 就不回 —— 他剛收到的那一則就是 —— 同一個人 10 秒最多回一次）。我封鎖的人的 here／sync 一律不回（deps.mayReply，W5）
 *   call   群組通話 start／join／leave／end（offer／answer／ICE 改走封給身分金鑰的信封，見 groupCallService）
 *   delete  為所有人刪除自己的群訊
 * 收端（W3）：引擎先用自己的主題表把 tid 對回 (gid, 那一代)（表上沒有 → 不解密就丟）；寄件人（主題後綴）不在我套上的名冊
 *   → 不解密就丟；用那個主題那一代的金鑰拆（信封上沒有 kid，W3 審查 M3）。表上只有目前這一代與換金鑰後還在重疊期的上一代：
 *   上一代主題上的晚到訊息（還沒換過來的成員送的）用上一代的金鑰拆、照樣驗簽章／新鮮度／去重，call／delete 照常交給 App，
 *   here／sync 只拿來交叉比對（不回：對方聽不到新一代的主題）。更舊的、過了重疊期的主題不在表上 → 丟。
 *   以前（W2）「對方比我新一代 → 先收著」不需要了：比我新的人發在新一代的主題上，我還沒訂到；我靠 log 與舊主題上的換金鑰通知跟上。
 *   拆開後驗內層簽章、依種類看新鮮度（簽過名的 ts）、用 (寄件人, ts, nonce) 去重 —— 去重表每個 (群, 寄件人) 各自一份、
 *   各有上限；滿了丟掉最舊的那一筆並把那個寄件人的「下限」提高到它的 ts（ts 不超過下限的一律當重放），一個成員灌爆不了
 *   別人的那一份（審查 W2 #3）。重開 App 之後表是空的：重放的頂多是 24 小時內真的發過的 delete／commit（再刪一次、再抓一次）
 *   或幾分鐘內的 here／通話控制。
 * 送端：只用 currentEpochKey（目前這一代、kc 核對過）；有人離開、等 admin 換金鑰（needsRekey）、金鑰還沒到、或 MQTT 沒連上
 *   → 先留著（記憶體，有上限），能送的時候才用那時的這一代封、送（通話信令超過 60 秒就丟）。封完再看一次（封的那段 await
 *   裡可能剛套上某人的 leave）：不能送了就放回去（審查 W2 #5），所以不會有東西用離開的人手上那一代送出去。
 *   W3：任何一則（含 commit 通知）真的交給 MQTT 的那一刻，封它的那一代一定是我套上的鏈的目前這一代 —— 換金鑰之後，
 *   上一代的主題上不會再有我發的任何東西。結束一代的那筆換金鑰的通知（被踢的人靠它知道自己被踢）在切換**之前**發
 *   （groupEngine.absorb）。mqtt 沒連上不排隊（回 false），留著連上再用那時的這一代重封。commit 通知沒連上就不送（只是提示）。
 *   剛換到新的一代（W3 審查 M1）：其他成員要幾秒（換 token、重連、SUBACK）才訂到新的主題 —— 這段 grace（SWITCH_GRACE_MS）裡
 *   here／sync／通話／刪除照樣先留著，grace 過了才用這一代送（不然在 needsRekey 期間留著的那幾則一放出去，只有寫換金鑰的
 *   admin 收得到）。
 */
import { compareGossip, currentEpochKey, headGossip, type HeadGossip } from './groupLog';
import { epochOfKey, keyAuthorised, memberOf, type Epoch, type GroupState, type VerifiedCommit } from './groupState';
import {
  checkControlBody, openControl, sealControl, type ControlKind, type GroupSealed, type OpenedControl,
} from './groupControl';
import { randomB64Url } from './groupStateCommit';
import type { PendingRow } from './groupLogStore';
import { SWITCH_GRACE_MS } from './groupTopics';
import type { EngineDeps } from './groupEngineTypes';
import type { Runtime } from './groupEngine';

export type GossipVerdict = ReturnType<typeof compareGossip>;
/** 畫面／App 送得出去的種類（commit 通知只由引擎在自己的 commit 套用後送） */
export type OutKind = Exclude<ControlKind, 'commit'>;
export type SendResult = 'sent' | 'held' | 'dropped';
export type ReceiveResult =
  | 'ok' | 'self' | 'stopped' | 'unknown-topic' | 'unknown-group' | 'non-member' | 'malformed' | 'no-key' | 'old-epoch'
  | 'bad-envelope' | 'stale' | 'replay';

export interface HeldControl {
  t: OutKind;
  /** here／sync 不存 body：放出去的時候才用當時的 head */
  body: Record<string, unknown> | null;
  at: number;
  /** delete 也存進資料庫（ctl 列）：離線時按的「為所有人刪除」重開 App 也還在（審查 W2 複審 #5b） */
  row?: string;
}

/** 收端看簽過名的 ts：超過這麼久的不收（broker 替離線的人排隊最多 24 小時；delete／commit 給 24 小時） */
const WINDOW_MS: Readonly<Record<ControlKind, number>> = {
  here: 5 * 60_000, sync: 5 * 60_000, call: 2 * 60_000, commit: 24 * 3_600_000, delete: 24 * 3_600_000,
};
const FUTURE_SKEW_MS = 5 * 60_000;
/** here／sync 只給在線的人（QoS0，broker 不替離線的人排隊） */
const QOS: Readonly<Record<ControlKind, 0 | 1>> = { here: 0, sync: 0, call: 1, commit: 1, delete: 1 };
/** 留著沒送的：每個群最多幾則；通話信令留超過這麼久就丟（對方早就放棄了） */
const OUTBOX_MAX = 64;
const CALL_STALE_MS = 60_000;
/** 去重表：每個 (群, 寄件人) 最多記幾則（滿了丟最舊的、提高下限） */
const SEEN_PER_SENDER = 128;
/** 回 here：因為別人的 here 對不上而回，每個群最少隔多久；回某個人的 sync，每個請求者最少隔多久 */
const REPLY_MIN_INTERVAL_MS = 10_000;
/** 記著回過誰的 sync：最多幾個（名冊上限 50） */
const MAX_REPLIED_TO = 64;

export interface ControlHost {
  deps: EngineDeps;
  runtimes: Map<string, Runtime>;
  isStopped(): boolean;
  requestSync(gid: string): void;
  /** head 交叉比對（群訊、here、commit、sync 共用）：落後 → 抓；對不上 → 畫面警告、問伺服器、必要時重建 */
  gossip(rt: Runtime, theirs: HeadGossip, from: string): GossipVerdict;
  /** 驗過的控制訊息從 from 來：我送給他的邀請算他收到了 */
  ackedBy(rt: Runtime, from: string): void;
}

export interface ControlPlane {
  send(rt: Runtime, t: OutKind, body?: Record<string, unknown>): Promise<SendResult>;
  /**
   * 我的 commit 在 log 上套用了：用那筆 entry 的那一代（entry）送 commit 通知（不會被 needsRekey 擋）。那一代必須是
   * 送出那一刻我套上的鏈的目前這一代（否則不送）；state 用來核對那一代的金鑰（kc）
   */
  notifyCommit(rt: Runtime, applied: { seq: number; commit: VerifiedCommit }, entry: Epoch, state: GroupState): Promise<void>;
  /** 鏈或金鑰變了、MQTT 連上了：留著的送出去（可以的話） */
  onChange(rt: Runtime): void;
  /** 引擎載入一個群：資料庫裡留著的 delete（ctl 列）放回要送的 */
  restore(rt: Runtime): void;
  /** 這個群在這台不在了：去重表也清掉 */
  forget(gid: string): void;
  /**
   * 收到一則 group_sealed。at ＝ 引擎的主題表查到的那一列（收到的主題 tid、那一代的 kid）：gid 只從這裡來，
   * 不看 payload 裡自稱的任何群組 id
   */
  receive(gid: string, from: string, envelope: unknown, at: { tid: string; kid: string }): Promise<ReceiveResult>;
  /** 主題表上沒有這個 tid（不是我的群、過了重疊期、被踢了）：記數、不解密 */
  unknownTopic(): ReceiveResult;
  /** 我上次在這個群發 here（或排了要回的 here）的時間；沒有 → null（定時 here 用：剛發過就不必再發） */
  lastHere(gid: string): number | null;
  stats(): Readonly<Record<string, number>>;
}

/** 版本 v 那時正在用的那一代 */
export function epochAt(state: GroupState, v: number): Epoch {
  return state.epochs.filter((e) => e.v <= v).reduce((a, e) => (e.v > a.v ? e : a));
}

export function createControlPlane(host: ControlHost): ControlPlane {
  const { deps } = host;
  /** (群, 寄件人) → 下限 ts 與記著的 (ts|nonce → 到期時間) */
  const seen = new Map<string, { floor: number; entries: Map<string, { ts: number; exp: number }> }>();
  const counters: Record<string, number> = {};
  const count = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };
  const log = (...a: unknown[]) => console.error('[groupControl]', ...a);
  /** 群 → 我上次在這個群發 here（或排了要回的 here）的時間：10 秒內發過，別人的 here 就不必為了「讓他知道我在」再回 */
  const hereAt = new Map<string, number>();
  const keyFor = (rt: Runtime) => (kid: string) => rt.keys.get(kid) ?? null;
  /**
   * 收端的新鮮度看這個（W5：here／sync／call 用 API 時鐘差有上限的時鐘；commit／delete 照舊用 now，見 EngineDeps.receiveNow）。
   * 去重表的過期清理用兩個裡面比較早的：兩種時鐘下都過期的那一筆，重放進來不管用哪一個時鐘判斷都太舊
   */
  const receiveNow = (): number => (deps.receiveNow ?? deps.now)();
  const freshnessNow = (t: ControlKind): number => (t === 'commit' || t === 'delete' ? deps.now() : receiveNow());
  const pruneNow = (): number => Math.min(deps.now(), receiveNow());
  const live = (rt: Runtime) => !rt.gone && !host.isStopped() && rt.rep.status === 'member';
  const connected = (): boolean => deps.connected?.() ?? true;

  /** 剛換到新的一代、還在 grace 裡（大家還在訂新的主題；W3 審查 M1） */
  const switching = (rt: Runtime): boolean =>
    rt.switchedAt !== null && deps.now() - rt.switchedAt < (deps.switchGraceMs ?? SWITCH_GRACE_MS);

  /** needsRekey（剛有人離開，他手上還有這一代）、拿不到目前這一代的金鑰、MQTT 沒連上、或剛換主題 → 不能送 */
  const blocked = (rt: Runtime): boolean =>
    rt.rep.view.state.needsRekey || rt.rep.waiting !== null || !rt.keys.has(rt.rep.view.state.epoch.kid) || !connected() || switching(rt);

  /**
   * 封、送到那一代的主題（tid 由 kid 那一代的金鑰推出來）。封完再看一次（封的那段 await 裡可能剛換了一代、剛套上某人的 leave、
   * 斷線了）：
   *   - 任何一則：kid 已經不是我套上的鏈的目前這一代 → 不送（W3：換金鑰之後上一代的主題上不再有我發的東西）
   *   - guarded（commit 通知以外）：needsRekey、金鑰不在、沒連上 → 不送
   *   - mqtt 不收（沒連上，不排隊）→ 不送
   * 回傳：sent；retry ＝ 封的時候剛好不能送（呼叫端放回 outbox，現在其實又可以的話馬上再放）；refused ＝ mqtt 不收（放回 outbox，
   * 等下一次連上／鏈變了再放 —— 不馬上重試：connected() 跟 mqtt 一時說法不一時才不會一直空轉）
   */
  async function publish(rt: Runtime, kid: string, key: Uint8Array, t: ControlKind, body: Record<string, unknown>, guarded: boolean): Promise<'sent' | 'retry' | 'refused'> {
    const { tid, envelope } = await sealControl({ gid: rt.gid, kid, key, sender: deps.me, sign: deps.sign, t, body, ts: deps.now() });
    if (rt.gone || host.isStopped()) return 'retry';
    if (rt.rep.view.state.epoch.kid !== kid) { count(guarded ? 'resealed-later' : 'dropped:not-current-epoch'); return 'retry'; }
    if (guarded && blocked(rt)) { count('resealed-later'); return 'retry'; }
    if (deps.publish(tid, envelope as GroupSealed, { qos: QOS[t] }) === false) { count(`not-sent:${t}`); return 'refused'; }
    if (t === 'here') hereAt.set(rt.gid, deps.now());
    count(`sent:${t}`);
    return 'sent';
  }

  /** ctl 列（留著的 delete）：存、刪；失敗只記 log（下次重開頂多少一則或多送一則，收端會去重） */
  function persistRow(rt: Runtime, row: PendingRow): void {
    rt.pending.set(row.id, row);
    deps.store.persistGroupLog({ gid: rt.gid, pendingUpsert: [row] }).catch((e) => log('saving a held delete failed:', (e as Error)?.message ?? e));
  }
  function dropRow(rt: Runtime, id: string | undefined): void {
    if (!id) return;
    rt.pending.delete(id);
    deps.store.persistGroupLog({ gid: rt.gid, pendingDrop: [id] }).catch((e) => log('dropping a held delete failed:', (e as Error)?.message ?? e));
  }

  function hold(rt: Runtime, t: OutKind, body: Record<string, unknown> | null, at = deps.now(), row?: string): void {
    const kept = t === 'here' || t === 'sync' ? rt.outbox.filter((h) => h.t !== t) : rt.outbox;
    let rowId = row;
    if (t === 'delete' && !rowId && !host.isStopped() && !rt.gone) {
      rowId = `ctl-${randomB64Url(12)}`;
      persistRow(rt, { gid: rt.gid, id: rowId, op: 'delete', signed: null, blob: null, args: JSON.stringify(body), state: 'ctl', createdAt: at });
    }
    const next: HeldControl[] = [...kept, { t, body, at, ...(rowId ? { row: rowId } : {}) }];
    for (const gone of next.slice(0, Math.max(0, next.length - OUTBOX_MAX))) { count('dropped:outbox-full'); dropRow(rt, gone.row); }
    rt.outbox = next.slice(-OUTBOX_MAX);
    count(`held:${t}`);
  }

  /** 放回去之後：要是現在其實可以送（封的那段時間裡已經又可以了），再放一次（審查 W2 複審 #5a：不然要等下一次變化） */
  function releaseSoon(rt: Runtime): void {
    if (live(rt) && !blocked(rt) && rt.outbox.length) setTimeout(() => { release(rt).catch((e) => log('release failed:', (e as Error)?.message ?? e)); }, 0);
  }

  const bodyOf = (rt: Runtime, t: OutKind, body: Record<string, unknown> | null): Record<string, unknown> =>
    t === 'here' ? { head: headGossip(rt.rep) } : t === 'sync' ? { have: headGossip(rt.rep) } : (body ?? {});

  async function send(rt: Runtime, t: OutKind, body: Record<string, unknown> = {}): Promise<SendResult> {
    if (!live(rt)) return 'dropped';
    const stored = t === 'here' || t === 'sync' ? null : checkControlBody(t, body);   // 格式不對現在就丟例外，不要留到之後
    if (blocked(rt)) {
      hold(rt, t, stored);
      return 'held';
    }
    const cur = await currentEpochKey(rt.rep, keyFor(rt));
    if (!cur.ok) {
      hold(rt, t, stored);
      return 'held';
    }
    const outcome = await publish(rt, cur.kid, cur.key, t, bodyOf(rt, t, stored), true);
    if (outcome === 'sent') return 'sent';
    if (!live(rt)) return 'dropped';
    hold(rt, t, stored);
    if (outcome === 'retry') releaseSoon(rt);
    return 'held';
  }

  async function release(rt: Runtime): Promise<void> {
    if (rt.outbox.length === 0 || !live(rt) || blocked(rt)) return;
    const cur = await currentEpochKey(rt.rep, keyFor(rt));
    if (!cur.ok || rt.outbox.length === 0 || blocked(rt)) return;
    const out = rt.outbox;
    rt.outbox = [];
    const now = deps.now();
    for (let i = 0; i < out.length; i++) {
      const h = out[i];
      if (h.t === 'call' && now - h.at > CALL_STALE_MS) { count('expired:call'); continue; }
      let outcome: 'sent' | 'retry' | 'refused';
      try {
        outcome = await publish(rt, cur.kid, cur.key, h.t, bodyOf(rt, h.t, h.body), true);
        if (outcome === 'sent') {
          count(`released:${h.t}`);
          dropRow(rt, h.row);
          continue;
        }
      } catch (e) {
        log(`release ${h.t} failed:`, (e as Error)?.message ?? e);
        dropRow(rt, h.row);
        continue;
      }
      // 封的時候不能送了（needsRekey、換了一代、斷線）或 mqtt 不收：這一則跟後面的放回去，下次再放
      if (live(rt)) for (const r of out.slice(i)) hold(rt, r.t, r.body, r.at, r.row);
      if (outcome === 'retry') releaseSoon(rt);
      return;
    }
  }

  function restore(rt: Runtime): void {
    for (const p of rt.pending.values()) {
      if (p.state !== 'ctl' || rt.outbox.some((h) => h.row === p.id)) continue;
      try {
        const body = checkControlBody('delete', JSON.parse(p.args ?? 'null'));
        const held: HeldControl = { t: 'delete', body, at: p.createdAt, row: p.id };
        rt.outbox = [...rt.outbox, held].slice(-OUTBOX_MAX);
      } catch {
        dropRow(rt, p.id);
      }
    }
  }

  function forget(gid: string): void {
    for (const k of [...seen.keys()]) if (k.startsWith(`${gid}|`)) seen.delete(k);
    hereAt.delete(gid);
  }

  async function notifyCommit(rt: Runtime, applied: { seq: number; commit: VerifiedCommit }, entry: Epoch, state: GroupState): Promise<void> {
    if (rt.gone || host.isStopped() || applied.commit.c.v < 2) return;
    if (!connected()) { count('dropped:commit-offline'); return; }   // 只是提示：大家會自己抓（連上、輪詢）
    try {
      const key = rt.keys.get(entry.kid);
      if (!key || !(await keyAuthorised(state, entry.kid, entry.kc, key))) return;
      await publish(rt, entry.kid, key, 'commit', { head: { seq: applied.seq, id: applied.commit.id } }, false);
    } catch (e) {
      log('commit notification failed:', (e as Error)?.message ?? e);
    }
  }

  /** 這一則（寄件人, ts, nonce）看過了嗎；沒看過就記下（每個 (群, 寄件人) 一份、有上限、滿了提高下限） */
  function seenBefore(gid: string, from: string, ts: number, nonce: string, exp: number): boolean {
    const key = `${gid}|${from}`;
    let s = seen.get(key);
    if (!s) seen.set(key, (s = { floor: -1, entries: new Map() }));
    const id = `${ts}|${nonce}`;
    if (ts <= s.floor || s.entries.has(id)) return true;
    const now = pruneNow();
    if (s.entries.size >= SEEN_PER_SENDER) {
      for (const [k, e] of s.entries) if (e.exp < now) s.entries.delete(k);   // 過期的：重放進來也會因為太舊被擋
    }
    while (s.entries.size >= SEEN_PER_SENDER) {
      let oldest: [string, { ts: number; exp: number }] | null = null;
      for (const e of s.entries) if (!oldest || e[1].ts < oldest[1].ts) oldest = e;
      if (!oldest) break;
      s.entries.delete(oldest[0]);
      s.floor = Math.max(s.floor, oldest[1].ts);
    }
    if (ts <= s.floor) return true;
    s.entries.set(id, { ts, exp });
    return false;
  }

  const drop = (why: ReceiveResult): ReceiveResult => { count(`dropped:${why}`); return why; };

  /** 這個主題（tid、那一代）現在還在這個群的主題表上嗎（目前這一代，或還在重疊期的上一代） */
  const listed = (rt: Runtime, at: { tid: string; kid: string }): boolean => rt.topics.some((e) => e.tid === at.tid && e.kid === at.kid);

  function unknownTopic(): ReceiveResult {
    if (host.isStopped()) return 'stopped';
    count('received');
    return drop('unknown-topic');
  }

  async function receive(gid: string, from: string, envelope: unknown, at: { tid: string; kid: string }): Promise<ReceiveResult> {
    if (host.isStopped()) return 'stopped';
    if (from === deps.me) return 'self';
    count('received');
    const rt = host.runtimes.get(gid);
    if (!rt || !live(rt) || !listed(rt, at)) return drop('unknown-group');
    const state = rt.rep.view.state;
    // 能在群組主題發訊的不一定是成員：寄件人（主題後綴）不在我套上的名冊 → 不解密
    if (!memberOf(state, from)) return drop('non-member');
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return drop('malformed');
    // 主題就決定了是哪一代（tid 由那一代的金鑰推出來、綁在 AAD 裡）：用那一代的金鑰拆；別的一代封的，AAD／金鑰對不上 → 解不開
    const kid = at.kid;
    const key = epochOfKey(state, kid) ? rt.keys.get(kid) : undefined;
    if (!key) return drop('no-key');
    let opened: OpenedControl;
    count('decrypt');   // 走到這裡才花 AES-GCM＋簽章驗證（表上沒有的主題、名冊外的人、對不上的一代到不了這裡）
    try {
      opened = await openControl({ envelope, gid, tid: at.tid, sender: from, kid, key, verify: deps.verify });
    } catch {
      return drop('bad-envelope');
    }
    // 拆的時候（await）：這個主題可能已經不在表上（過了重疊期、被踢、群沒了），或他已經不在名冊上了
    if (!live(rt) || !listed(rt, at)) return drop('old-epoch');
    if (!memberOf(rt.rep.view.state, from)) return drop('non-member');
    const now = freshnessNow(opened.t);
    if (opened.ts > now + FUTURE_SKEW_MS || now - opened.ts > WINDOW_MS[opened.t]) return drop('stale');
    if (seenBefore(gid, from, opened.ts, opened.nonce, opened.ts + WINDOW_MS[opened.t] + FUTURE_SKEW_MS)) return drop('replay');
    // 上一代的主題上、還沒換過來的成員送的（重疊期內）
    const previous = kid !== rt.rep.view.state.epoch.kid;
    count(previous ? `opened-previous:${opened.t}` : `opened:${opened.t}`);
    host.ackedBy(rt, from);
    dispatch(rt, opened, previous);
    return 'ok';
  }

  /**
   * 回一則 here。to ＝ 回某人的 sync／讓剛連上的他知道我在（每個人各自限速：剛加入的人一定收得到回覆）；沒給 ＝ 整個群限速。
   * 回傳有沒有排（限速擋掉 ＝ false）
   */
  function reply(rt: Runtime, to?: string): boolean {
    const now = deps.now();
    if (to) {
      if (now - (rt.repliedTo.get(to) ?? 0) < REPLY_MIN_INTERVAL_MS) return false;
      rt.repliedTo.delete(to);
      rt.repliedTo.set(to, now);
      if (rt.repliedTo.size > MAX_REPLIED_TO) rt.repliedTo.delete(rt.repliedTo.keys().next().value as string);
    } else {
      if (now - rt.lastReplyAt < REPLY_MIN_INTERVAL_MS) return false;
      rt.lastReplyAt = now;
    }
    hereAt.set(rt.gid, now);
    const jitter = deps.replyJitterMs ?? 1000;
    const go = () => { send(rt, 'here').catch((e) => log('here reply failed:', (e as Error)?.message ?? e)); };
    if (jitter > 0) setTimeout(go, Math.floor(Math.random() * jitter));
    else go();
    return true;
  }

  /**
   * 他的 here：他剛連上，要不要讓他知道我在（他看不到我的 presence —— 不是好友 —— 我這邊也沒看到他：App 的 answerHere）。
   * 我 10 秒內在這個群發過 here（例如我剛連上、他這則就是回我的）→ 不回：他已經收到我的了。要在 onMemberSeen 之前問
   */
  function shouldAnswer(rt: Runtime, from: string): boolean {
    if (deps.now() - (hereAt.get(rt.gid) ?? -Infinity) < REPLY_MIN_INTERVAL_MS) return false;
    try {
      return deps.answerHere?.(rt.gid, from) === true;
    } catch (e) {
      log('answer-here check failed:', (e as Error)?.message ?? e);
      return false;
    }
  }

  /** 這個成員的 here／sync 可以讓我回 here 嗎（deps.mayReply：App 給「不是我封鎖的人」，W5 複審；出錯 ＝ 不回） */
  function mayReplyTo(rt: Runtime, from: string): boolean {
    if (!deps.mayReply) return true;
    try {
      if (deps.mayReply(rt.gid, from) === true) return true;
    } catch (e) {
      log('may-reply check failed:', (e as Error)?.message ?? e);
    }
    count('not-replied:refused');
    return false;
  }

  /** here／sync：寄件人剛連上（W4：非好友的同群成員靠這個知道彼此在線，deps.onMemberSeen） */
  function memberSeen(rt: Runtime, from: string): void {
    try {
      deps.onMemberSeen?.(rt.gid, from);
    } catch (e) {
      log('member-seen handler failed:', (e as Error)?.message ?? e);
    }
  }

  /** previous：上一代主題上的晚到訊息 —— here／sync 不回（我回在新一代的主題上，對方還沒換過來、聽不到） */
  function dispatch(rt: Runtime, m: OpenedControl, previous: boolean): void {
    switch (m.t) {
      case 'commit': {
        const head = m.body.head as HeadGossip;
        if (head.seq > rt.rep.processedSeq) host.requestSync(rt.gid);
        host.gossip(rt, head, m.sender);
        return;
      }
      case 'here': {
        // 我封鎖的人：他的 here 照樣拿來比對 head、記他在線，但不因為他回任何 here（不讓他問出我在不在線）
        const may = !previous && mayReplyTo(rt, m.sender);
        const answer = may && shouldAnswer(rt, m.sender);
        memberSeen(rt, m.sender);
        const verdict = host.gossip(rt, m.body.head as HeadGossip, m.sender);
        const replied = may && (verdict === 'they-are-behind' || verdict === 'conflict') && reply(rt);
        if (answer && !replied && reply(rt, m.sender)) count('answered-here');
        return;
      }
      case 'sync':
        memberSeen(rt, m.sender);
        host.gossip(rt, m.body.have as HeadGossip, m.sender);
        if (!previous && mayReplyTo(rt, m.sender)) reply(rt, m.sender);
        return;
      case 'call':
      case 'delete':
        try {
          deps.onControl?.(rt.gid, m.sender, m.t, m.body);
        } catch (e) {
          log(`${m.t} handler failed:`, (e as Error)?.message ?? e);
        }
    }
  }

  function onChange(rt: Runtime): void {
    if (rt.gone || host.isStopped()) return;
    release(rt).catch((e) => log('release failed:', (e as Error)?.message ?? e));
  }

  return {
    send, notifyCommit, onChange, receive, unknownTopic, restore, forget, lastHere: (gid) => hereAt.get(gid) ?? null, stats: () => ({ ...counters }),
  };
}

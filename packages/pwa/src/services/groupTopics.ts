/**
 * 群組在 MQTT 上的主題 id（W3，docs/GROUP_LOG_WIRING_W3.md）—— 純函式，沒有 I/O。
 *
 * 群組主題 mist/group/{tid}/{寄件人}，tid = groupControl.deriveTopicId(這一代的金鑰, gid)
 *   = URL-safe base64(HKDF-SHA256(K_e, "aegistalk-gtopic-v1|" + gid))[:22]
 * 每換一次金鑰就換主題；gid 從來不上 broker（主題、token 範圍、payload 都沒有）。被踢、離開的人推不出新一代的 tid。
 *
 * 每個群一張主題表：
 *   - 目前這一代：鏈上目前那一代的金鑰在手上、kc 核對過（currentEpochKey）才有；金鑰還沒到 → 沒有（訂不了、也讀不了）
 *   - 上一代：換金鑰之後再留 TOPIC_OVERLAP_MS（還沒換過來的成員在上一代主題上送的晚到訊息、broker 替我排隊的，照樣收得到），
 *     每個群最多留 MAX_PREVIOUS_TOPICS 個（短時間連續換金鑰，訂閱數也不會一直長）
 * 收端只靠這張表把 tid 對回 gid（不看 payload 裡自稱的任何群組 id）；發送只用目前這一代（groupEngineControl）。
 */
import type { Epoch, GroupState } from './groupState';

/** 換金鑰之後，上一代的主題再留多久 */
export const TOPIC_OVERLAP_MS = 10 * 60_000;
/** 每個群最多同時留幾個上一代的主題 */
export const MAX_PREVIOUS_TOPICS = 2;
/**
 * 換到新的一代之後，群組主題上的 here／sync／通話／刪除先等這麼久才送（W3 審查 M1）：其他成員看到換金鑰通知、套上、換 token、
 * 重連、SUBACK 要一兩秒才訂得到新的主題；在那之前發在新主題上的，他們收不到（broker 不替還沒訂的主題排隊）
 */
export const SWITCH_GRACE_MS = 5_000;

export interface TopicEntry {
  tid: string;
  /** 這個主題是哪一代（那一代的金鑰推出來的） */
  kid: string;
  /** null ＝ 目前這一代；否則留到這個時間（引擎的時鐘，毫秒） */
  until: number | null;
}

/** 給 App（token 範圍、訂閱）與測試看的一列 */
export interface GroupTopic {
  gid: string;
  tid: string;
  kid: string;
  /** 目前這一代（否則是換金鑰後還留著的上一代） */
  current: boolean;
}

/**
 * 鏈或金鑰變了之後，一個群的主題表。
 * chainKid ＝ 鏈上目前那一代；current ＝ 那一代的主題（金鑰在手上、核對過；沒有 → null）。
 *   - 原本「目前」的那一代如果已經不是鏈上目前的 → 變成上一代，留到 now + overlapMs
 *   - 原本「目前」的跟鏈上一樣、但現在拿不到核對過的金鑰（核對不過被丟掉）→ 拿掉
 *   - 過期的上一代拿掉；上一代最多 MAX_PREVIOUS_TOPICS 個（留得最久的優先）
 */
export function nextTopics(prev: readonly TopicEntry[], chainKid: string, current: { tid: string; kid: string } | null,
  now: number, overlapMs: number = TOPIC_OVERLAP_MS): TopicEntry[] {
  const previous: TopicEntry[] = [];
  for (const e of prev) {
    if (e.kid === chainKid) continue;   // 鏈上目前這一代：只由 current 決定
    if (e.until === null) previous.push({ tid: e.tid, kid: e.kid, until: now + overlapMs });
    else if (e.until > now) previous.push(e);
  }
  previous.sort((a, b) => (b.until as number) - (a.until as number));
  const out: TopicEntry[] = current && current.kid === chainKid ? [{ tid: current.tid, kid: current.kid, until: null }] : [];
  let kept = 0;
  for (const e of previous) {
    if (kept >= MAX_PREVIOUS_TOPICS) break;
    if (out.some((o) => o.tid === e.tid)) continue;
    out.push(e);
    kept++;
  }
  return out;
}

/**
 * App 重開時（主題表在記憶體，沒存）：目前這一代是 startedAt（換金鑰那筆 commit 的 ts，作者的時鐘）開始的；
 * 還在重疊期內 → 上一代的主題留到 min(startedAt, now) + overlapMs（作者把 ts 寫在未來也延長不了）。過了 → null。
 */
export function previousUntil(startedAt: number, now: number, overlapMs: number = TOPIC_OVERLAP_MS): number | null {
  if (!Number.isFinite(startedAt)) return null;
  const until = Math.min(startedAt, now) + overlapMs;
  return now < until ? until : null;
}

/** 鏈上目前這一代的上一代（沒有 → null） */
export function previousEpoch(state: GroupState): Epoch | null {
  const i = state.epochs.findIndex((e) => e.kid === state.epoch.kid);
  return i > 0 ? state.epochs[i - 1] : null;
}

/** 表上最早到期的時間（沒有要到期的 → null） */
export function nextExpiry(entries: readonly TopicEntry[]): number | null {
  let next: number | null = null;
  for (const e of entries) if (e.until !== null && (next === null || e.until < next)) next = e.until;
  return next;
}

/** 整份主題清單有沒有變（給 App 的通知只在變了才發） */
export function topicListKey(list: readonly GroupTopic[]): string {
  return list.map((t) => `${t.gid}:${t.tid}:${t.current ? 1 : 0}`).sort().join(',');
}

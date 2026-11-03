/**
 * 群組 log 的本機存檔（docs/GROUP_LOG_WIRING_W1.md）：套上的鏈、log 位置、自己還沒上鏈的 commit、每一代的金鑰，
 * 加上給畫面與舊程式讀的投影（groups／group_members）。一次寫入的東西放在同一個 runBatch（同一個交易）：
 * 鏈、位置、金鑰與投影不會只寫一半。
 *
 * 自己寫的 commit 與新金鑰在送出（append）之前要真的落地（flush: true → database.flushToStore，web 上等 IndexedDB
 * 寫完）；套用別人的 commit 走一般的去抖存檔就好：沒存到的話重開後從舊的 processedSeq 重抓、重套一次，結果一樣。
 */
import * as db from './database';
import type { GroupCommitRow } from './groupState';
import type { KeyWait, LogStatus } from './groupLog';

export type PendingState = 'append' | 'invite' | 'sent' | 'unacked' | 'held' | 'join' | 'ctl';

/**
 * 自己的 commit：append＝送出前已存、等它在 log 上套用；invite＝我加的人已上鏈、邀請還沒送；sent＝邀請送了、還沒收齊回條
 * （args 放重送紀錄，W2）；unacked＝重送用完還是沒回條（畫面可以再送一次）；held＝等 admin 換金鑰；join＝確認中的邀請；
 * ctl＝還沒送出去的「為所有人刪除」（W2：離線、等換金鑰時，重開 App 也還在）
 */
export interface PendingRow {
  gid: string;
  id: string;
  op: string;
  /** 簽好的 commit（線上格式 JSON）；join 列放邀請者公鑰 */
  signed: string | null;
  /** 要 POST 的 log entry */
  blob: string | null;
  /** held 的草稿 args、join 的邀請內容、sent 的重送紀錄（JSON） */
  args: string | null;
  state: PendingState;
  createdAt: number;
}

/** LogReplica 去掉 view（view 由 group_commits 重建） */
export interface ReplicaMeta {
  gid: string;
  me: string;
  headV: number;
  headId: string;
  processedSeq: number;
  headSeq: number;
  firstSeq: number;
  baseV: number;
  joinAt: { v: number; id: string } | null;
  status: LogStatus;
  appliedAt: Record<string, string>;
  waiting: KeyWait | null;
  /** 本機第一次看到 needsRekey 的時間（ms）；沒有就 null */
  rekeySeenAt: number | null;
}

export interface EpochKeyRow {
  kid: string;
  key: Uint8Array;
  /** 指定這把金鑰的 commit 版本 */
  v: number;
  /** 那筆 commit 的作者 */
  actor: string;
  /** chain＝鏈上授權過（kc 對得上）；pending＝我自己還沒上鏈的換金鑰 */
  origin: 'chain' | 'pending';
}

/** groups／group_members 的投影（暱稱是本機快取，不在這裡改） */
export interface GroupProjectionRow {
  name: string;
  avatar: string | null;
  createdAt: number;
  createdBy: string;
  groupType: string | null;
  guardianSettings: string | null;
  members: Array<{ pubkey: string; role: 'admin' | 'member'; joinedAt: number; nickname: string | null }>;
}

export interface StoredGroupLog {
  meta: ReplicaMeta;
  rows: GroupCommitRow[];
  pending: PendingRow[];
  keys: EpochKeyRow[];
}

export interface PersistGroupLog {
  gid: string;
  /** 新套上的 commit 列（rebuild 時連同 replaceFromV 一起給：v > replaceFromV 的舊列先刪） */
  rows?: readonly GroupCommitRow[];
  replaceFromV?: number;
  meta?: ReplicaMeta;
  keys?: readonly EpochKeyRow[];
  /** 鏈上目前那一代（手上有金鑰才給）；給了就只有它 is_active = 1；null ＝ 這一代沒有金鑰（全部 0） */
  activeKid?: string | null;
  dropKids?: readonly string[];
  projection?: GroupProjectionRow;
  pendingUpsert?: readonly PendingRow[];
  pendingDrop?: readonly string[];
}

type Statement = { statement: string; values: (string | number | null)[] };

const KEY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function metaStatement(m: ReplicaMeta, now: number): Statement {
  return {
    statement: `INSERT OR REPLACE INTO group_log_state
      (gid, me, head_v, head_id, processed_seq, head_seq, first_seq, base_v, join_v, join_id, status, applied_at, waiting, rekey_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [m.gid, m.me, m.headV, m.headId, m.processedSeq, m.headSeq, m.firstSeq, m.baseV, m.joinAt?.v ?? null, m.joinAt?.id ?? null,
      m.status, JSON.stringify(m.appliedAt), m.waiting ? JSON.stringify(m.waiting) : null, m.rekeySeenAt, now],
  };
}

function keyStatement(gid: string, k: EpochKeyRow, now: number): Statement {
  // 鏈上授權過的那一列不會被「還沒上鏈」的覆寫（同一個 kid 只會有一把對得上 kc 的金鑰）
  return {
    statement: `INSERT INTO group_keys (group_id, key_id, key_base64, created_at, created_by, is_active, expires_at, origin, epoch_v)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(group_id, key_id) DO UPDATE SET
        key_base64 = CASE WHEN group_keys.origin = 'chain' THEN group_keys.key_base64 ELSE excluded.key_base64 END,
        origin = CASE WHEN group_keys.origin = 'chain' THEN 'chain' ELSE excluded.origin END,
        epoch_v = excluded.epoch_v, created_by = excluded.created_by`,
    values: [gid, k.kid, toB64(k.key), now, k.actor, now + KEY_RETENTION_MS, k.origin, k.v],
  };
}

function projectionStatements(gid: string, p: GroupProjectionRow, now: number): Statement[] {
  const out: Statement[] = [{
    statement: `INSERT INTO groups (id, name, avatar, created_at, created_by, updated_at, group_type, guardian_settings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, created_at = excluded.created_at,
        created_by = excluded.created_by, updated_at = excluded.updated_at, group_type = excluded.group_type,
        guardian_settings = excluded.guardian_settings`,
    values: [gid, p.name, p.avatar, p.createdAt, p.createdBy, now, p.groupType, p.guardianSettings],
  }];
  const keep = p.members.map((m) => m.pubkey);
  out.push({
    statement: `DELETE FROM group_members WHERE group_id = ?${keep.length ? ` AND pubkey NOT IN (${keep.map(() => '?').join(', ')})` : ''}`,
    values: [gid, ...keep],
  });
  for (const m of p.members) {
    out.push({
      statement: `INSERT INTO group_members (group_id, pubkey, role, nickname, joined_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_id, pubkey) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at,
          nickname = COALESCE(group_members.nickname, excluded.nickname)`,
      values: [gid, m.pubkey, m.role, m.nickname, m.joinedAt],
    });
  }
  return out;
}

function pendingStatement(p: PendingRow): Statement {
  return {
    statement: `INSERT OR REPLACE INTO group_pending_commits (gid, id, op, signed, blob, args, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [p.gid, p.id, p.op, p.signed, p.blob, p.args, p.state, p.createdAt],
  };
}

/** 一次寫完；flush：web 上等它真的寫進 IndexedDB（自己的 commit 與新金鑰送出前用） */
export async function persistGroupLog(p: PersistGroupLog, opts: { flush?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const sets: Statement[] = [];
  if (p.replaceFromV !== undefined) {
    sets.push({ statement: `DELETE FROM group_commits WHERE gid = ? AND v > ?`, values: [p.gid, p.replaceFromV] });
  }
  for (const r of p.rows ?? []) {
    sets.push({ statement: `INSERT OR REPLACE INTO group_commits (gid, v, id, prev, body, sig) VALUES (?, ?, ?, ?, ?, ?)`,
      values: [p.gid, r.v, r.id, r.prev, r.body, r.sig] });
  }
  if (p.meta) sets.push(metaStatement(p.meta, now));
  for (const k of p.keys ?? []) sets.push(keyStatement(p.gid, k, now));
  for (const kid of p.dropKids ?? []) sets.push({ statement: `DELETE FROM group_keys WHERE group_id = ? AND key_id = ?`, values: [p.gid, kid] });
  if (p.activeKid !== undefined) {
    sets.push({ statement: `UPDATE group_keys SET is_active = CASE WHEN key_id = ? THEN 1 ELSE 0 END WHERE group_id = ?`,
      values: [p.activeKid ?? '', p.gid] });
  }
  if (p.projection) sets.push(...projectionStatements(p.gid, p.projection, now));
  for (const row of p.pendingUpsert ?? []) sets.push(pendingStatement(row));
  for (const id of p.pendingDrop ?? []) {
    sets.push({ statement: `DELETE FROM group_pending_commits WHERE gid = ? AND id = ?`, values: [p.gid, id] });
  }
  if (sets.length === 0) return;
  await db.runBatch(sets);
  if (opts.flush) await db.flushToStore();
}

/**
 * 群組不在了（被踢、離開、刪群、邀請沒對上）：鏈、位置、金鑰、待送、投影全部刪掉。確認中的邀請（join 列）留著：
 * 離線時被踢又被加回來，邀請會比「被踢」先處理到；刪掉舊的群之後要靠它重新加入（審查 W1 M-2）
 */
export async function deleteGroupLog(gid: string): Promise<void> {
  await db.runBatch([
    { statement: `DELETE FROM group_commits WHERE gid = ?`, values: [gid] },
    { statement: `DELETE FROM group_log_state WHERE gid = ?`, values: [gid] },
    { statement: `DELETE FROM group_pending_commits WHERE gid = ? AND state != 'join'`, values: [gid] },
    { statement: `DELETE FROM group_keys WHERE group_id = ?`, values: [gid] },
    { statement: `DELETE FROM group_members WHERE group_id = ?`, values: [gid] },
    { statement: `DELETE FROM groups WHERE id = ?`, values: [gid] },
  ]);
}

interface StateRow {
  gid: string; me: string; head_v: number; head_id: string; processed_seq: number; head_seq: number; first_seq: number; base_v: number;
  join_v: number | null; join_id: string | null; status: string; applied_at: string; waiting: string | null; rekey_seen_at: number | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToMeta(r: StateRow): ReplicaMeta {
  return {
    gid: r.gid, me: r.me, headV: Number(r.head_v), headId: r.head_id, processedSeq: Number(r.processed_seq), headSeq: Number(r.head_seq),
    firstSeq: Number(r.first_seq), baseV: Number(r.base_v),
    joinAt: r.join_v !== null && r.join_id ? { v: Number(r.join_v), id: r.join_id } : null,
    status: r.status as LogStatus, appliedAt: parseJson<Record<string, string>>(r.applied_at, {}),
    waiting: parseJson<KeyWait | null>(r.waiting, null), rekeySeenAt: r.rekey_seen_at === null ? null : Number(r.rekey_seen_at),
  };
}

/** 這個帳號在這台的所有群組 log（啟動時載入；me 不同的列不是這個帳號的） */
export async function loadGroupLogs(me: string): Promise<StoredGroupLog[]> {
  const states = await db.query<StateRow>(`SELECT * FROM group_log_state WHERE me = ?`, [me]);
  const out: StoredGroupLog[] = [];
  for (const s of states) {
    const rows = await db.query<GroupCommitRow>(`SELECT gid, v, id, prev, body, sig FROM group_commits WHERE gid = ? ORDER BY v`, [s.gid]);
    out.push({
      meta: rowToMeta(s),
      rows: rows.map((r) => ({ ...r, v: Number(r.v) })),
      pending: await loadPending(s.gid),
      keys: await loadKeys(s.gid),
    });
  }
  return out;
}

async function loadPending(gid: string): Promise<PendingRow[]> {
  const rows = await db.query<{ gid: string; id: string; op: string; signed: string | null; blob: string | null; args: string | null; state: string; created_at: number }>(
    `SELECT gid, id, op, signed, blob, args, state, created_at FROM group_pending_commits WHERE gid = ? ORDER BY created_at`, [gid]);
  return rows.map((r) => ({ gid: r.gid, id: r.id, op: r.op, signed: r.signed, blob: r.blob, args: r.args, state: r.state as PendingState,
    createdAt: Number(r.created_at) }));
}

/** 還在確認中的邀請（群組還沒有 log 狀態）：啟動時重試 */
export async function loadPendingJoins(): Promise<PendingRow[]> {
  const rows = await db.query<{ gid: string }>(`SELECT DISTINCT gid FROM group_pending_commits WHERE state = 'join'`);
  const out: PendingRow[] = [];
  for (const r of rows) out.push(...(await loadPending(r.gid)).filter((p) => p.state === 'join'));
  return out;
}

/** 確認中的邀請：群、邀請者（join 列的 signed 欄）、時間 —— 不讀整份邀請（收邀請時的上限與淘汰用） */
export async function listJoinHeads(): Promise<Array<{ gid: string; sender: string | null; createdAt: number }>> {
  const rows = await db.query<{ gid: string; signed: string | null; created_at: number }>(
    `SELECT gid, signed, created_at FROM group_pending_commits WHERE state = 'join'`);
  return rows.map((r) => ({ gid: r.gid, sender: r.signed, createdAt: Number(r.created_at) }));
}

async function loadKeys(gid: string): Promise<EpochKeyRow[]> {
  const rows = await db.query<{ key_id: string; key_base64: string; epoch_v: number; created_by: string; origin: string }>(
    `SELECT key_id, key_base64, epoch_v, created_by, origin FROM group_keys WHERE group_id = ?`, [gid]);
  const out: EpochKeyRow[] = [];
  for (const r of rows) {
    try {
      const key = fromB64(r.key_base64);
      if (key.length !== 32) continue;
      out.push({ kid: r.key_id, key, v: Number(r.epoch_v), actor: r.created_by, origin: r.origin === 'pending' ? 'pending' : 'chain' });
    } catch { /* 壞掉的列：當作沒有，需要時向 admin 要 */ }
  }
  return out;
}

/**
 * 建群寫到一半就關 App（genesis 已存、還沒拿到 seq）留下的列：沒有 log 狀態的鏈、金鑰、待送（確認中的邀請除外）。
 * 啟動時、引擎還沒接受任何動作之前清掉；使用者重新建一次就好（伺服器上多一筆沒人用的 entry，無害）。
 */
export async function cleanupOrphans(): Promise<void> {
  const live = `SELECT gid FROM group_log_state`;
  const joins = `SELECT gid FROM group_pending_commits WHERE state = 'join'`;
  await db.runBatch([
    { statement: `DELETE FROM group_commits WHERE gid NOT IN (${live})`, values: [] },
    { statement: `DELETE FROM group_keys WHERE group_id NOT IN (${live}) AND group_id NOT IN (${joins})`, values: [] },
    { statement: `DELETE FROM group_pending_commits WHERE state != 'join' AND gid NOT IN (${live})`, values: [] },
  ]);
}

export const groupLogStore = { persistGroupLog, deleteGroupLog, loadGroupLogs, loadPendingJoins, listJoinHeads, cleanupOrphans };
export type GroupLogStore = typeof groupLogStore;

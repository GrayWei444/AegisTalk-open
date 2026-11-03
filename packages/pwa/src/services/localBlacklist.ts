/**
 * Local Blacklist Service - 本地黑名單服務 (Phase 16)
 *
 * 功能：
 * - 本地黑名單管理（SQLite）
 * - 即時阻擋被封鎖用戶的訊息/通話
 * - 投訴記錄（本地保存，不上傳描述）
 *
 * 隱私設計：
 * - 投訴描述只存本地，不上傳
 * - 上傳時只傳 pubkey hash
 */

import * as db from './database';
import { getServiceTranslation } from '../i18n/serviceHelper';

// ============================================
// 類型定義
// ============================================

/** 投訴類型 */
export type ComplaintType = 'scam' | 'harassment' | 'impersonation' | 'other';

/** 黑名單來源 */
export type BlacklistReason = 'complaint' | 'manual';

/** 本地黑名單項目 */
export interface LocalBlacklistEntry {
  /** 被封鎖者的公鑰 */
  pubkey: string;
  /** 公鑰 Hash（用於匿名上報） */
  pubkeyHash: string;
  /** 加入時間 */
  addedAt: number;
  /** 來源原因 */
  reason: BlacklistReason;
  /** 投訴類型（如果是投訴） */
  complaintType?: ComplaintType;
  /** 本地備註（不上傳） */
  notes?: string;
  /** 被封鎖者暱稱（方便顯示） */
  nickname?: string;
  /** 是否已上報到伺服器 */
  reported?: boolean;
}

/** 投訴資料 */
export interface ComplaintData {
  pubkey: string;
  nickname?: string;
  type: ComplaintType;
  notes?: string;
}

// ============================================
// 變動通知（W4：封鎖好友 → presence 秘密要換，presenceService.reconcile）
// ============================================

const changeListeners = new Set<() => void>();

/** 封鎖名單有變動（加入、移除、清空）時呼叫；回傳取消函式 */
export function onBlacklistChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

function notifyChanged(): void {
  for (const cb of changeListeners) {
    try { cb(); } catch (e) { console.error('[localBlacklist] change listener failed:', e); }
  }
}

// ============================================
// SQLite 列型別（與 DB column 對應）
// ============================================

interface BlacklistRow {
  pubkey_hash: string;
  reason: string;
  complaint_type: string | null;
  reported: number;
  created_at: number;
  pubkey: string;
  notes: string | null;
  nickname: string | null;
}

// ============================================
// Hash 工具
// ============================================

/**
 * 計算公鑰的 SHA256 Hash
 * 用於匿名上報，無法反推原始公鑰
 */
export async function hashPubkey(pubkey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pubkey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 同步版本的簡易 Hash（用於快速查詢）
 */
export function hashPubkeySync(pubkey: string): string {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    const char = pubkey.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return 'pk_' + Math.abs(hash).toString(16).padStart(8, '0');
}

// ============================================
// localStorage → SQLite 一次性遷移
// ============================================

const BLACKLIST_STORAGE_KEY = 'aegis_local_blacklist';

let migrated = false;

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    const old = localStorage.getItem(BLACKLIST_STORAGE_KEY);
    if (old) {
      const entries = JSON.parse(old) as LocalBlacklistEntry[];
      const count = await db.queryOne<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM local_user_blacklist',
        [],
      );
      if (!count || count.cnt === 0) {
        for (const e of entries) {
          await db.run(
            'INSERT OR IGNORE INTO local_user_blacklist (pubkey_hash, reason, complaint_type, reported, created_at, pubkey, notes, nickname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              e.pubkeyHash,
              e.reason,
              e.complaintType || null,
              e.reported ? 1 : 0,
              e.addedAt,
              e.pubkey,
              e.notes || null,
              e.nickname || null,
            ],
          );
        }
      }
      localStorage.removeItem(BLACKLIST_STORAGE_KEY);
    }
  } catch {
    /* ignore migration errors */
  }
}

// ============================================
// 列 → 物件 映射
// ============================================

function rowToEntry(row: BlacklistRow): LocalBlacklistEntry {
  return {
    pubkey: row.pubkey ?? '',
    pubkeyHash: row.pubkey_hash,
    addedAt: row.created_at,
    reason: row.reason as BlacklistReason,
    complaintType: (row.complaint_type as ComplaintType) ?? undefined,
    notes: row.notes ?? undefined,
    nickname: row.nickname ?? undefined,
    reported: row.reported === 1,
  };
}

// ============================================
// 本地黑名單管理
// ============================================

/**
 * 取得所有本地黑名單
 */
export async function getLocalBlacklist(): Promise<LocalBlacklistEntry[]> {
  await ensureMigrated();
  const rows = await db.query<BlacklistRow>(
    'SELECT pubkey_hash, reason, complaint_type, reported, created_at, pubkey, notes, nickname FROM local_user_blacklist ORDER BY created_at DESC',
    [],
  );
  return rows.map(rowToEntry);
}

/**
 * 檢查用戶是否在黑名單中
 */
export async function isBlacklisted(pubkey: string): Promise<boolean> {
  await ensureMigrated();
  const row = await db.queryOne<{ x: number }>(
    'SELECT 1 as x FROM local_user_blacklist WHERE pubkey = ?',
    [pubkey],
  );
  return row !== null;
}

/**
 * 取得黑名單項目
 */
export async function getBlacklistEntry(
  pubkey: string,
): Promise<LocalBlacklistEntry | undefined> {
  await ensureMigrated();
  const row = await db.queryOne<BlacklistRow>(
    'SELECT pubkey_hash, reason, complaint_type, reported, created_at, pubkey, notes, nickname FROM local_user_blacklist WHERE pubkey = ?',
    [pubkey],
  );
  return row ? rowToEntry(row) : undefined;
}

/**
 * 加入黑名單（透過投訴）
 */
export async function addToBlacklistByComplaint(
  complaint: ComplaintData,
): Promise<LocalBlacklistEntry> {
  await ensureMigrated();

  // 檢查是否已存在
  const existing = await getBlacklistEntry(complaint.pubkey);
  if (existing) {
    // 更新現有記錄
    const now = Date.now();
    await db.run(
      'UPDATE local_user_blacklist SET complaint_type = ?, notes = ?, created_at = ? WHERE pubkey = ?',
      [complaint.type, complaint.notes || null, now, complaint.pubkey],
    );
    return {
      ...existing,
      complaintType: complaint.type,
      notes: complaint.notes,
      addedAt: now,
    };
  }

  // 計算 hash
  const pubkeyHash = await hashPubkey(complaint.pubkey);
  const now = Date.now();

  await db.run(
    'INSERT INTO local_user_blacklist (pubkey_hash, reason, complaint_type, reported, created_at, pubkey, notes, nickname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      pubkeyHash,
      'complaint',
      complaint.type,
      0,
      now,
      complaint.pubkey,
      complaint.notes || null,
      complaint.nickname || null,
    ],
  );
  notifyChanged();

  return {
    pubkey: complaint.pubkey,
    pubkeyHash,
    addedAt: now,
    reason: 'complaint',
    complaintType: complaint.type,
    notes: complaint.notes,
    nickname: complaint.nickname,
    reported: false,
  };
}

/**
 * 手動加入黑名單（不投訴）
 */
export async function addToBlacklistManual(
  pubkey: string,
  nickname?: string,
  notes?: string,
): Promise<LocalBlacklistEntry> {
  await ensureMigrated();

  // 檢查是否已存在
  const existing = await getBlacklistEntry(pubkey);
  if (existing) {
    return existing;
  }

  const pubkeyHash = await hashPubkey(pubkey);
  const now = Date.now();

  await db.run(
    'INSERT INTO local_user_blacklist (pubkey_hash, reason, complaint_type, reported, created_at, pubkey, notes, nickname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [pubkeyHash, 'manual', null, 0, now, pubkey, notes || null, nickname || null],
  );
  notifyChanged();

  return {
    pubkey,
    pubkeyHash,
    addedAt: now,
    reason: 'manual',
    notes,
    nickname,
    reported: false,
  };
}

/**
 * 從黑名單移除
 */
export async function removeFromBlacklist(pubkey: string): Promise<boolean> {
  await ensureMigrated();
  const changes = await db.run(
    'DELETE FROM local_user_blacklist WHERE pubkey = ?',
    [pubkey],
  );
  if (changes > 0) notifyChanged();
  return changes > 0;
}

/**
 * 清除所有黑名單
 */
export async function clearBlacklist(): Promise<void> {
  await ensureMigrated();
  await db.run('DELETE FROM local_user_blacklist', []);
  notifyChanged();
}

/**
 * 取得黑名單統計
 */
export async function getBlacklistStats(): Promise<{
  total: number;
  byComplaint: number;
  byManual: number;
}> {
  await ensureMigrated();

  const total = await db.queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM local_user_blacklist',
    [],
  );
  const byComplaint = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM local_user_blacklist WHERE reason = 'complaint'",
    [],
  );
  const byManual = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM local_user_blacklist WHERE reason = 'manual'",
    [],
  );

  return {
    total: total?.cnt ?? 0,
    byComplaint: byComplaint?.cnt ?? 0,
    byManual: byManual?.cnt ?? 0,
  };
}

// ============================================
// 投訴類型工具
// ============================================

/**
 * 取得投訴類型的顯示名稱
 */
export function getComplaintTypeName(type: ComplaintType): string {
  const t = getServiceTranslation();
  const keys: Record<ComplaintType, string> = {
    scam: 'localBlacklistService.complaintScam',
    harassment: 'localBlacklistService.complaintHarassment',
    impersonation: 'localBlacklistService.complaintImpersonation',
    other: 'localBlacklistService.complaintOther',
  };
  return t(keys[type]);
}

/**
 * 取得投訴類型的圖示
 */
export function getComplaintTypeIcon(type: ComplaintType): string {
  const icons: Record<ComplaintType, string> = {
    scam: '🚨',
    harassment: '🚫',
    impersonation: '🎭',
    other: '⚠️',
  };
  return icons[type];
}

/**
 * 取得黑名單來源的顯示名稱
 */
export function getBlacklistReasonName(reason: BlacklistReason): string {
  const t = getServiceTranslation();
  const keys: Record<BlacklistReason, string> = {
    complaint: 'localBlacklistService.reasonComplaint',
    manual: 'localBlacklistService.reasonManual',
  };
  return t(keys[reason]);
}

// ============================================
// 導出
// ============================================

export const localBlacklistService = {
  // 查詢
  getLocalBlacklist,
  isBlacklisted,
  onBlacklistChanged,
  getBlacklistEntry,
  getBlacklistStats,

  // 操作
  addToBlacklistByComplaint,
  addToBlacklistManual,
  removeFromBlacklist,
  clearBlacklist,

  // 工具
  hashPubkey,
  hashPubkeySync,
  getComplaintTypeName,
  getComplaintTypeIcon,
  getBlacklistReasonName,
};

export default localBlacklistService;

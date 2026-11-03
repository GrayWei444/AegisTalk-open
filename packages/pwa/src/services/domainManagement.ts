/**
 * 使用者域名黑白名單管理服務
 *
 * SQLite 儲存（透過 database.ts）的使用者觸發域名攔截名單。
 * 類似 AegisVPN 的 getUserBlacklist / getUserWhitelist 模式：
 * - 使用者手動新增 (manual)
 * - 偵測到威脅時使用者點擊封鎖 (auto_block)
 *
 * 注意：這與官方版 L2 規則引擎同步下來的系統黑名單（51萬+ 筆）不同！
 * 這裡只存使用者自己觸發的攔截域名。
 */

import * as db from './database';

// ============================================
// 類型定義
// ============================================

/** 黑名單來源 */
export type DomainBlockSource = 'auto_block' | 'manual';

/** 使用者域名黑名單項目 */
export interface BlacklistEntry {
  domain: string;
  source: DomainBlockSource;
  createdAt: string;
  note: string;
  blockCount: number;
}

/** 使用者域名白名單項目 */
export interface WhitelistEntry {
  domain: string;
  note: string;
  createdAt: string;
}

// ============================================
// 內部工具
// ============================================

function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  // 移除 protocol
  d = d.replace(/^https?:\/\//, '');
  // 移除 path
  d = d.split('/')[0];
  // 移除 port
  d = d.split(':')[0];
  return d;
}

// ============================================
// localStorage → SQLite 一次性遷移
// ============================================

let migrated = false;

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  migrated = true;

  // Migrate blacklist
  try {
    const old = localStorage.getItem('aegis_user_domain_blacklist');
    if (old) {
      const entries = JSON.parse(old) as BlacklistEntry[];
      const count = await db.queryOne<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM user_blacklist',
        [],
      );
      if (!count || count.cnt === 0) {
        for (const e of entries) {
          await db.run(
            'INSERT OR IGNORE INTO user_blacklist (domain, source, added_at, note, block_count, reason) VALUES (?, ?, ?, ?, ?, ?)',
            [
              e.domain,
              e.source,
              new Date(e.createdAt).getTime(),
              e.note || '',
              e.blockCount || 1,
              e.note || '',
            ],
          );
        }
      }
      localStorage.removeItem('aegis_user_domain_blacklist');
    }
  } catch {
    /* ignore */
  }

  // Migrate whitelist
  try {
    const old = localStorage.getItem('aegis_user_domain_whitelist');
    if (old) {
      const entries = JSON.parse(old) as WhitelistEntry[];
      const count = await db.queryOne<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM user_whitelist',
        [],
      );
      if (!count || count.cnt === 0) {
        for (const e of entries) {
          await db.run(
            'INSERT OR IGNORE INTO user_whitelist (domain, added_at, note) VALUES (?, ?, ?)',
            [e.domain, new Date(e.createdAt).getTime(), e.note || ''],
          );
        }
      }
      localStorage.removeItem('aegis_user_domain_whitelist');
    }
  } catch {
    /* ignore */
  }
}

// ============================================
// SQLite row 型別（內部用）
// ============================================

interface BlacklistRow {
  domain: string;
  source: string;
  added_at: number;
  note: string;
  block_count: number;
}

interface WhitelistRow {
  domain: string;
  added_at: number;
  note: string;
}

// ============================================
// 黑名單操作
// ============================================

/** 取得所有使用者黑名單域名 */
export async function getUserBlacklist(): Promise<BlacklistEntry[]> {
  await ensureMigrated();
  const rows = await db.query<BlacklistRow>(
    'SELECT domain, source, added_at, note, block_count FROM user_blacklist ORDER BY added_at DESC',
    [],
  );
  return rows.map((r) => ({
    domain: r.domain,
    source: (r.source as DomainBlockSource) || 'manual',
    createdAt: new Date(r.added_at).toISOString(),
    note: r.note || '',
    blockCount: r.block_count ?? 1,
  }));
}

/** 新增域名到黑名單 */
export async function addToUserBlacklist(
  domain: string,
  source: DomainBlockSource = 'manual',
  note: string = '',
): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;

  const existing = await db.queryOne<{ domain: string }>(
    'SELECT domain FROM user_blacklist WHERE domain = ?',
    [normalized],
  );

  if (existing) {
    await db.run(
      'UPDATE user_blacklist SET block_count = block_count + 1, note = CASE WHEN ? != \'\' THEN ? ELSE note END WHERE domain = ?',
      [note, note, normalized],
    );
    return true;
  }

  await db.run(
    'INSERT INTO user_blacklist (domain, source, added_at, note, block_count, reason) VALUES (?, ?, ?, ?, ?, ?)',
    [normalized, source, Date.now(), note, 1, note],
  );
  return true;
}

/** 從黑名單移除域名 */
export async function removeFromUserBlacklist(domain: string): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  const changes = await db.run(
    'DELETE FROM user_blacklist WHERE domain = ?',
    [normalized],
  );
  return changes > 0;
}

/** 檢查域名是否在使用者黑名單 */
export async function isDomainBlacklisted(domain: string): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  const row = await db.queryOne<{ domain: string }>(
    'SELECT 1 as domain FROM user_blacklist WHERE domain = ?',
    [normalized],
  );
  return row !== null;
}

// ============================================
// 白名單操作
// ============================================

/** 取得所有使用者白名單域名 */
export async function getUserWhitelist(): Promise<WhitelistEntry[]> {
  await ensureMigrated();
  const rows = await db.query<WhitelistRow>(
    'SELECT domain, added_at, note FROM user_whitelist ORDER BY added_at DESC',
    [],
  );
  return rows.map((r) => ({
    domain: r.domain,
    createdAt: new Date(r.added_at).toISOString(),
    note: r.note || '',
  }));
}

/** 新增域名到白名單 */
export async function addToUserWhitelist(
  domain: string,
  note: string = '',
): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;

  const existing = await db.queryOne<{ domain: string }>(
    'SELECT domain FROM user_whitelist WHERE domain = ?',
    [normalized],
  );
  if (existing) return false;

  await db.run(
    'INSERT INTO user_whitelist (domain, added_at, note) VALUES (?, ?, ?)',
    [normalized, Date.now(), note],
  );
  return true;
}

/** 從白名單移除域名 */
export async function removeFromUserWhitelist(domain: string): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  const changes = await db.run(
    'DELETE FROM user_whitelist WHERE domain = ?',
    [normalized],
  );
  return changes > 0;
}

/** 檢查域名是否在使用者白名單 */
export async function isDomainWhitelisted(domain: string): Promise<boolean> {
  await ensureMigrated();
  const normalized = normalizeDomain(domain);
  const row = await db.queryOne<{ domain: string }>(
    'SELECT 1 as domain FROM user_whitelist WHERE domain = ?',
    [normalized],
  );
  return row !== null;
}

// ============================================
// 統計
// ============================================

/** 取得使用者黑白名單統計 */
export async function getUserDomainStats(): Promise<{
  blacklistTotal: number;
  whitelistTotal: number;
  autoBlocked: number;
  manualBlocked: number;
}> {
  await ensureMigrated();
  const blTotal = await db.queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM user_blacklist',
    [],
  );
  const wlTotal = await db.queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM user_whitelist',
    [],
  );
  const autoBlocked = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM user_blacklist WHERE source = 'auto_block'",
    [],
  );
  const manualBlocked = await db.queryOne<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM user_blacklist WHERE source = 'manual'",
    [],
  );
  return {
    blacklistTotal: blTotal?.cnt ?? 0,
    whitelistTotal: wlTotal?.cnt ?? 0,
    autoBlocked: autoBlocked?.cnt ?? 0,
    manualBlocked: manualBlocked?.cnt ?? 0,
  };
}

// ============================================
// 搜尋
// ============================================

/** 搜尋黑名單 */
export async function searchUserBlacklist(query: string): Promise<BlacklistEntry[]> {
  await ensureMigrated();
  if (!query.trim()) return getUserBlacklist();
  const q = `%${query.toLowerCase()}%`;
  const rows = await db.query<BlacklistRow>(
    'SELECT domain, source, added_at, note, block_count FROM user_blacklist WHERE domain LIKE ? OR note LIKE ? ORDER BY added_at DESC',
    [q, q],
  );
  return rows.map((r) => ({
    domain: r.domain,
    source: (r.source as DomainBlockSource) || 'manual',
    createdAt: new Date(r.added_at).toISOString(),
    note: r.note || '',
    blockCount: r.block_count ?? 1,
  }));
}

/** 搜尋白名單 */
export async function searchUserWhitelist(query: string): Promise<WhitelistEntry[]> {
  await ensureMigrated();
  if (!query.trim()) return getUserWhitelist();
  const q = `%${query.toLowerCase()}%`;
  const rows = await db.query<WhitelistRow>(
    'SELECT domain, added_at, note FROM user_whitelist WHERE domain LIKE ? OR note LIKE ? ORDER BY added_at DESC',
    [q, q],
  );
  return rows.map((r) => ({
    domain: r.domain,
    createdAt: new Date(r.added_at).toISOString(),
    note: r.note || '',
  }));
}

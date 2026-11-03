/**
 * useBlacklist Hook - 黑名單功能整合 (Phase 16)
 *
 * 提供：
 * - 查詢用戶是否在黑名單
 * - 投訴/封鎖用戶
 * - 移除黑名單
 * - 同步全域黑名單
 */

import { useState, useCallback, useEffect } from 'react';
import {
  isBlacklisted,
  getLocalBlacklist,
  addToBlacklistByComplaint,
  addToBlacklistManual,
  removeFromBlacklist,
  getBlacklistStats,
  type ComplaintData,
  type LocalBlacklistEntry,
} from '../services/localBlacklist';

// ============================================
// 類型定義
// ============================================

interface BlacklistStats {
  total: number;
  byComplaint: number;
  byManual: number;
}

const EMPTY_STATS: BlacklistStats = {
  total: 0,
  byComplaint: 0,
  byManual: 0,
};

interface UseBlacklistReturn {
  // 狀態
  isLoading: boolean;
  blacklist: LocalBlacklistEntry[];
  stats: BlacklistStats;

  // 查詢
  isUserBlacklisted: (pubkey: string) => Promise<boolean>;

  // 操作
  blockByComplaint: (data: ComplaintData) => Promise<LocalBlacklistEntry>;
  blockManually: (pubkey: string, nickname?: string, notes?: string) => Promise<LocalBlacklistEntry>;
  unblock: (pubkey: string) => Promise<boolean>;

  // 刷新
  refresh: () => void;
}

// ============================================
// Hook 實作
// ============================================

export function useBlacklist(): UseBlacklistReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [blacklist, setBlacklist] = useState<LocalBlacklistEntry[]>([]);
  const [stats, setStats] = useState<BlacklistStats>(EMPTY_STATS);

  // 刷新本地狀態
  const refresh = useCallback(() => {
    getLocalBlacklist().then(setBlacklist).catch(() => setBlacklist([]));
    getBlacklistStats().then(setStats).catch(() => setStats(EMPTY_STATS));
  }, []);

  // 初始化
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 檢查用戶是否在黑名單
  const isUserBlacklisted = useCallback(async (pubkey: string): Promise<boolean> => {
    return isBlacklisted(pubkey);
  }, []);

  // 透過投訴封鎖用戶
  const blockByComplaint = useCallback(
    async (data: ComplaintData): Promise<LocalBlacklistEntry> => {
      setIsLoading(true);
      try {
        const entry = await addToBlacklistByComplaint(data);
        refresh();
        return entry;
      } finally {
        setIsLoading(false);
      }
    },
    [refresh]
  );

  // 手動封鎖用戶
  const blockManually = useCallback(
    async (pubkey: string, nickname?: string, notes?: string): Promise<LocalBlacklistEntry> => {
      setIsLoading(true);
      try {
        const entry = await addToBlacklistManual(pubkey, nickname, notes);
        refresh();
        return entry;
      } finally {
        setIsLoading(false);
      }
    },
    [refresh]
  );

  // 解除封鎖
  const unblock = useCallback(
    async (pubkey: string): Promise<boolean> => {
      const result = await removeFromBlacklist(pubkey);
      refresh();
      return result;
    },
    [refresh]
  );

  return {
    isLoading,
    blacklist,
    stats,
    isUserBlacklisted,
    blockByComplaint,
    blockManually,
    unblock,
    refresh,
  };
}

// ============================================
// 導出
// ============================================

export type { LocalBlacklistEntry, ComplaintData };
export default useBlacklist;

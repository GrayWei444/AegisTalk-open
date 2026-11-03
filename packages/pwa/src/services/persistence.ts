import { devLog, devWarn } from '../utils/devLog';

/**
 * Persistence Service - 儲存持久化管理
 *
 * 使用 StorageManager API 防止瀏覽器自動清除 IndexedDB
 */

export interface PersistenceStatus {
  isPersisted: boolean;
  canPersist: boolean;
  quota: {
    usage: number;
    quota: number;
    usagePercentage: number;
  };
}

/**
 * 檢查持久化狀態與儲存配額
 */
export async function checkPersistenceStatus(): Promise<PersistenceStatus> {
  // 檢查瀏覽器支援
  if (!navigator.storage) {
    devWarn('[Persistence] Storage API not supported');
    return {
      isPersisted: false,
      canPersist: false,
      quota: { usage: 0, quota: 0, usagePercentage: 0 },
    };
  }

  try {
    // 檢查是否已持久化
    const isPersisted = navigator.storage.persisted
      ? await navigator.storage.persisted()
      : false;

    // 取得儲存配額資訊
    const estimate = navigator.storage.estimate
      ? await navigator.storage.estimate()
      : { usage: 0, quota: 0 };

    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const usagePercentage = quota > 0 ? (usage / quota) * 100 : 0;

    devLog('[Persistence] Status:', {
      isPersisted,
      usage: `${(usage / 1024 / 1024).toFixed(2)} MB`,
      quota: `${(quota / 1024 / 1024).toFixed(2)} MB`,
      usagePercentage: `${usagePercentage.toFixed(2)}%`,
    });

    return {
      isPersisted,
      canPersist: !!navigator.storage.persist,
      quota: {
        usage,
        quota,
        usagePercentage,
      },
    };
  } catch (error) {
    console.error('[Persistence] Failed to check status:', error);
    return {
      isPersisted: false,
      canPersist: false,
      quota: { usage: 0, quota: 0, usagePercentage: 0 },
    };
  }
}

/**
 * 請求持久化權限
 *
 * @returns true 如果授權成功，false 如果拒絕或不支援
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage || !navigator.storage.persist) {
    devWarn('[Persistence] Storage.persist() not supported');
    return false;
  }

  try {
    const isPersisted = await navigator.storage.persist();

    if (isPersisted) {
      devLog('[Persistence] ✅ Persistence granted! IndexedDB will not be auto-cleared.');
    } else {
      devWarn('[Persistence] ❌ Persistence denied. Data may be cleared by browser.');
    }

    return isPersisted;
  } catch (error) {
    console.error('[Persistence] Failed to request persistence:', error);
    return false;
  }
}

/**
 * 自動請求持久化（根據策略）
 *
 * 策略：
 * 1. 如果已經持久化 → 不再請求，返回 true
 * 2. 如果 API 不支援 → 不請求，返回 true（視為已處理，避免警告）
 * 3. 每次都嘗試請求（Chrome PWA 應該會自動授權）
 */
export async function autoRequestPersistence(options: {
  force?: boolean;
  minUsagePercentage?: number;
} = {}): Promise<boolean> {
  const { force = false } = options;

  const status = await checkPersistenceStatus();

  // 已經持久化，無需再請求
  if (status.isPersisted && !force) {
    devLog('[Persistence] Already persisted, skipping request');
    return true;
  }

  // 無法請求持久化（API 不支援）- 不算失敗，只是不支援
  if (!status.canPersist) {
    devLog('[Persistence] Storage.persist() not supported by this browser');
    return true; // 返回 true 避免警告
  }

  // 嘗試請求持久化
  return requestPersistence();
}


/**
 * 格式化儲存空間大小
 */
export function formatStorageSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * 取得儲存空間警告等級
 */
export function getStorageWarningLevel(usagePercentage: number): 'safe' | 'warning' | 'critical' {
  if (usagePercentage < 70) return 'safe';
  if (usagePercentage < 90) return 'warning';
  return 'critical';
}

export default {
  checkPersistenceStatus,
  requestPersistence,
  autoRequestPersistence,
  formatStorageSize,
  getStorageWarningLevel,
};

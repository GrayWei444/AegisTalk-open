/**
 * Phase 14: 下載管理服務
 *
 * 管理檔案下載進度、下載歷史（SQLite 儲存）
 */

import * as db from './database';
import { generateId } from '../utils/secureId';

// ============================================
// 類型定義
// ============================================

export interface DownloadItem {
  /** 唯一 ID */
  id: string;
  /** 檔案名稱 */
  name: string;
  /** MIME 類型 */
  mimeType: string;
  /** 檔案大小 (bytes) */
  size: number;
  /** 下載進度 (0-100) */
  progress: number;
  /** 下載狀態 */
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  /** 開始時間 */
  startedAt: number;
  /** 完成時間 */
  completedAt?: number;
  /** 錯誤訊息 */
  error?: string;
  /** 檔案內容 (下載完成後) */
  dataUrl?: string;
  /** 來源 (訊息 ID 或好友 pubkey) */
  sourceId?: string;
}

export interface DownloadProgress {
  id: string;
  progress: number;
  status: DownloadItem['status'];
}

type DownloadListener = (progress: DownloadProgress) => void;

// ============================================
// 儲存常數
// ============================================

const MAX_HISTORY_ITEMS = 50;

// ============================================
// 下載管理器
// ============================================

interface DownloadRow {
  id: string;
  filename: string;
  mime_type: string | null;
  size: number | null;
  created_at: number;
  status: string | null;
  data_url: string | null;
  source_id: string | null;
  started_at: number | null;
  completed_at: number | null;
}

class DownloadManager {
  private downloads: Map<string, DownloadItem> = new Map();
  private listeners: Map<string, Set<DownloadListener>> = new Map();
  constructor() {
    // Fire-and-forget: load history from SQLite (async)
    this.loadHistory().catch(() => {});
  }

  /**
   * 載入下載歷史（從 SQLite，含 localStorage 遷移）
   */
  private async loadHistory(): Promise<void> {
    // Migrate from localStorage first
    try {
      const json = localStorage.getItem('aegis_download_history');
      if (json) {
        const items = JSON.parse(json) as DownloadItem[];
        const count = await db.queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM download_history', []);
        if (!count || count.cnt === 0) {
          for (const item of items.filter(i => i.status === 'completed')) {
            await db.run(
              'INSERT OR IGNORE INTO download_history (id, filename, mime_type, size, created_at, status, data_url, source_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [item.id, item.name, item.mimeType, item.size, item.startedAt, 'completed', item.dataUrl || null, item.sourceId || null, item.startedAt, item.completedAt || null]
            );
          }
        }
        localStorage.removeItem('aegis_download_history');
      }
    } catch { /* ignore */ }

    // Load from SQLite
    try {
      const rows = await db.query<DownloadRow>(
        "SELECT * FROM download_history WHERE status = ? ORDER BY completed_at DESC LIMIT ?",
        ['completed', MAX_HISTORY_ITEMS]
      );
      for (const row of rows) {
        this.downloads.set(row.id, {
          id: row.id,
          name: row.filename,
          mimeType: row.mime_type || '',
          size: row.size || 0,
          progress: 100,
          status: 'completed',
          startedAt: row.started_at || row.created_at,
          completedAt: row.completed_at ?? undefined,
          dataUrl: row.data_url ?? undefined,
          sourceId: row.source_id ?? undefined,
        });
      }
    } catch (err) {
      console.error('[DownloadManager] Failed to load from SQLite:', err);
    }
  }

  /**
   * 儲存下載歷史到 SQLite
   */
  private async saveHistory(): Promise<void> {
    const completed = Array.from(this.downloads.values())
      .filter(item => item.status === 'completed')
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, MAX_HISTORY_ITEMS);

    // Upsert completed items to SQLite
    for (const item of completed) {
      await db.run(
        'INSERT OR REPLACE INTO download_history (id, filename, mime_type, size, created_at, status, data_url, source_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [item.id, item.name, item.mimeType, item.size, item.startedAt, 'completed', item.dataUrl || null, item.sourceId || null, item.startedAt, item.completedAt || null]
      );
    }
  }

  /**
   * 開始下載
   */
  startDownload(item: Omit<DownloadItem, 'progress' | 'status' | 'startedAt'>): string {
    const download: DownloadItem = {
      ...item,
      progress: 0,
      status: 'pending',
      startedAt: Date.now(),
    };

    this.downloads.set(download.id, download);
    this.notifyListeners(download.id, {
      id: download.id,
      progress: 0,
      status: 'pending',
    });

    return download.id;
  }

  /**
   * 更新下載進度
   */
  updateProgress(id: string, progress: number): void {
    const download = this.downloads.get(id);
    if (!download) return;

    download.progress = progress;
    download.status = 'downloading';

    this.notifyListeners(id, {
      id,
      progress,
      status: 'downloading',
    });
  }

  /**
   * 標記下載完成
   */
  completeDownload(id: string, dataUrl?: string): void {
    const download = this.downloads.get(id);
    if (!download) return;

    download.progress = 100;
    download.status = 'completed';
    download.completedAt = Date.now();
    if (dataUrl) {
      download.dataUrl = dataUrl;
    }

    this.notifyListeners(id, {
      id,
      progress: 100,
      status: 'completed',
    });

    this.saveHistory().catch(() => { /* ignore */ });
  }

  /**
   * 標記下載失敗
   */
  failDownload(id: string, error: string): void {
    const download = this.downloads.get(id);
    if (!download) return;

    download.status = 'failed';
    download.error = error;

    this.notifyListeners(id, {
      id,
      progress: download.progress,
      status: 'failed',
    });
  }

  /**
   * 取得下載項目
   */
  getDownload(id: string): DownloadItem | undefined {
    return this.downloads.get(id);
  }

  /**
   * 取得所有下載
   */
  getAllDownloads(): DownloadItem[] {
    return Array.from(this.downloads.values())
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * 取得下載歷史（已完成的）
   */
  getHistory(): DownloadItem[] {
    return Array.from(this.downloads.values())
      .filter(item => item.status === 'completed')
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }

  /**
   * 取得進行中的下載
   */
  getActiveDownloads(): DownloadItem[] {
    return Array.from(this.downloads.values())
      .filter(item => item.status === 'pending' || item.status === 'downloading');
  }

  /**
   * 移除下載項目
   */
  removeDownload(id: string): void {
    this.downloads.delete(id);
    this.listeners.delete(id);
    this.saveHistory().catch(() => { /* ignore */ });
    db.run('DELETE FROM download_history WHERE id = ?', [id]).catch(() => { /* ignore */ });
  }

  /**
   * 清除所有下載歷史
   */
  clearHistory(): void {
    const activeDownloads = this.getActiveDownloads();
    this.downloads.clear();
    // 保留進行中的下載
    activeDownloads.forEach(d => this.downloads.set(d.id, d));
    db.run('DELETE FROM download_history', []).catch(() => { /* ignore */ });
  }

  /**
   * 訂閱下載進度
   */
  subscribe(id: string, listener: DownloadListener): () => void {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(listener);

    // 返回取消訂閱函數
    return () => {
      this.listeners.get(id)?.delete(listener);
    };
  }

  /**
   * 通知監聽器
   */
  private notifyListeners(id: string, progress: DownloadProgress): void {
    this.listeners.get(id)?.forEach(listener => {
      try {
        listener(progress);
      } catch (err) {
        console.error('[DownloadManager] Listener error:', err);
      }
    });
  }
}

// 單例
export const downloadManager = new DownloadManager();

// ============================================
// Hook 輔助函數
// ============================================

/**
 * 生成下載 ID
 */
export function generateDownloadId(): string {
  return generateId('dl');
}

/**
 * 格式化下載速度
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * 格式化剩餘時間
 */
export function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分鐘`;
  return `${(seconds / 3600).toFixed(1)} 小時`;
}

export default downloadManager;

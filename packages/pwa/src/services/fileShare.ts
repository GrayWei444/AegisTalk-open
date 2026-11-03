/**
 * Phase 14: 檔案分享服務
 *
 * 處理檔案分享相關功能：
 * - Share Target 接收檔案
 * - 檔案轉發
 * - 分享到其他 App
 */

import { getAllContacts, type Contact } from './storage';
import { generateId } from '../utils/secureId';
import { devLog, devWarn } from '../utils/devLog';

// ============================================
// 類型定義
// ============================================

export interface SharedFile {
  /** 唯一 ID */
  id: string;
  /** 檔案名稱 */
  name: string;
  /** MIME 類型 */
  mimeType: string;
  /** 檔案大小 (bytes) */
  size: number;
  /** 檔案內容 (base64 data URL) */
  dataUrl: string;
  /** 接收時間 */
  receivedAt: number;
}

export interface ShareTargetData {
  /** 分享標題 */
  title?: string;
  /** 分享文字 */
  text?: string;
  /** 分享連結 */
  url?: string;
  /** 分享的檔案 */
  files: SharedFile[];
}

export interface ForwardTarget {
  /** 好友 pubkey */
  pubkey: string;
  /** 好友名稱 */
  name: string;
  /** 好友頭像 */
  avatar?: string;
}

// ============================================
// 常數
// ============================================

const PENDING_SHARE_KEY = 'aegis_pending_share';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// ============================================
// Share Target 處理
// ============================================

/**
 * 從 FormData 解析分享的檔案
 */
export async function parseShareTargetFormData(formData: FormData): Promise<ShareTargetData> {
  const title = formData.get('title') as string | null;
  const text = formData.get('text') as string | null;
  const url = formData.get('url') as string | null;
  const fileEntries = formData.getAll('files') as File[];

  const files: SharedFile[] = [];

  for (const file of fileEntries) {
    if (file.size > MAX_FILE_SIZE) {
      devWarn(`[FileShare] 檔案過大，跳過: ${file.name} (${file.size} bytes)`);
      continue;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      files.push({
        id: generateFileId(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl,
        receivedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[FileShare] 讀取檔案失敗: ${file.name}`, err);
    }
  }

  return {
    title: title || undefined,
    text: text || undefined,
    url: url || undefined,
    files,
  };
}

/**
 * 將 File 轉換為 data URL
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 生成檔案 ID
 */
function generateFileId(): string {
  return generateId('file');
}

/**
 * 暫存待處理的分享資料
 * 用於 Share Target 頁面跳轉後保留資料
 */
export function savePendingShare(data: ShareTargetData): void {
  try {
    sessionStorage.setItem(PENDING_SHARE_KEY, JSON.stringify(data));
    devLog('[FileShare] 已暫存分享資料:', {
      title: data.title,
      text: data.text?.substring(0, 50),
      fileCount: data.files.length,
    });
  } catch (err) {
    console.error('[FileShare] 暫存分享資料失敗:', err);
  }
}

/**
 * 取得並清除待處理的分享資料
 */
export function getPendingShare(): ShareTargetData | null {
  try {
    const json = sessionStorage.getItem(PENDING_SHARE_KEY);
    if (!json) return null;

    sessionStorage.removeItem(PENDING_SHARE_KEY);
    return JSON.parse(json) as ShareTargetData;
  } catch (err) {
    console.error('[FileShare] 讀取分享資料失敗:', err);
    return null;
  }
}

/**
 * 檢查是否有待處理的分享
 */
export function hasPendingShare(): boolean {
  return sessionStorage.getItem(PENDING_SHARE_KEY) !== null;
}

// ============================================
// 檔案轉發
// ============================================

/**
 * 取得可轉發的好友列表
 */
export async function getForwardTargets(): Promise<ForwardTarget[]> {
  try {
    const contacts = await getAllContacts();
    return contacts.map((contact: Contact) => ({
      pubkey: contact.pubkey,
      name: contact.nickname || contact.pubkey.substring(0, 8),
      avatar: contact.avatar,
    }));
  } catch (err) {
    console.error('[FileShare] 取得好友列表失敗:', err);
    return [];
  }
}

/**
 * 轉發檔案給指定好友
 * 返回訊息 ID
 */
export async function forwardFile(
  file: SharedFile,
  targetPubkey: string,
  _onProgress?: (progress: number) => void
): Promise<string> {
  // 這裡需要呼叫 chatStore 或 useChat 來發送訊息
  // 由於是服務層，返回 Promise 讓呼叫端處理
  devLog('[FileShare] 準備轉發檔案:', {
    fileName: file.name,
    targetPubkey: targetPubkey.substring(0, 8),
  });

  // 返回一個 placeholder ID，實際發送由呼叫端處理
  return generateFileId();
}

/**
 * 批量轉發檔案
 */
export async function forwardFiles(
  files: SharedFile[],
  targetPubkeys: string[],
  onProgress?: (current: number, total: number) => void
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  const total = files.length * targetPubkeys.length;
  let current = 0;

  for (const file of files) {
    for (const pubkey of targetPubkeys) {
      try {
        await forwardFile(file, pubkey);
        success++;
      } catch {
        failed++;
      }
      current++;
      onProgress?.(current, total);
    }
  }

  return { success, failed };
}

// ============================================
// 分享到其他 App (Web Share API)
// ============================================

/**
 * 檢查是否支援 Web Share API
 */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.share;
}

/**
 * 檢查是否支援分享檔案
 */
export function canShareFiles(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.canShare;
}

/**
 * 分享文字/連結到其他 App
 */
export async function shareText(data: { title?: string; text?: string; url?: string }): Promise<boolean> {
  if (!canShare()) {
    devWarn('[FileShare] Web Share API 不支援');
    return false;
  }

  try {
    await navigator.share(data);
    return true;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 使用者取消，不算錯誤
      return false;
    }
    console.error('[FileShare] 分享失敗:', err);
    return false;
  }
}

/**
 * 分享檔案到其他 App
 */
export async function shareFile(file: SharedFile): Promise<boolean> {
  if (!canShareFiles()) {
    devWarn('[FileShare] 檔案分享不支援');
    return false;
  }

  try {
    // 從 data URL 建立 File 物件
    const response = await fetch(file.dataUrl);
    const blob = await response.blob();
    const fileObj = new File([blob], file.name, { type: file.mimeType });

    const shareData = { files: [fileObj] };

    if (navigator.canShare && !navigator.canShare(shareData)) {
      devWarn('[FileShare] 無法分享此檔案類型');
      return false;
    }

    await navigator.share(shareData);
    return true;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return false;
    }
    console.error('[FileShare] 分享檔案失敗:', err);
    return false;
  }
}

// ============================================
// 工具函數
// ============================================

/**
 * 取得檔案類型的圖示
 */
export function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '📊';
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '📽️';
  if (mimeType.includes('audio')) return '🎵';
  if (mimeType.includes('video')) return '🎬';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '📦';
  if (mimeType.includes('text')) return '📃';
  return '📎';
}

/**
 * 格式化檔案大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 取得檔案的副檔名
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.substring(lastDot + 1).toLowerCase();
}

/**
 * 檢查是否為支援預覽的檔案類型
 */
export function isPreviewable(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf'
  );
}

export default {
  parseShareTargetFormData,
  savePendingShare,
  getPendingShare,
  hasPendingShare,
  getForwardTargets,
  forwardFile,
  forwardFiles,
  canShare,
  canShareFiles,
  shareText,
  shareFile,
  getFileIcon,
  formatFileSize,
  getFileExtension,
  isPreviewable,
};

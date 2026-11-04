/**
 * 檔案開啟服務 — 抄 AegisTrans 已驗證做法（LEARNINGS SOP，2026-07-15）
 *
 * 三個語意分開（AegisTrans fileOpener.ts 原註解實測結論）：
 * - openFile「儲存」：native 寫 Documents（檔案管理員看得到），不彈面板；web 走另存/下載
 * - previewFile「開啟」：native 用 FileOpener plugin（Android ACTION_VIEW / iOS
 *   UIDocumentInteractionController）彈「開啟方式」— **Share sheet 不會列 PDF reader/
 *   PowerPoint 這類 viewer app，只會列 LINE/Gmail 這類分享 app**，所以「用其他 App 開啟」
 *   必須用 FileOpener；沒 app 能開才 fallback Share
 * - shareFile「分享」：顯式 Share sheet
 *
 * AegisTalk 加值：寫檔統一 6MB 分塊（write+append）— 77MB 檔一整包 base64 過
 * Capacitor bridge 會爆記憶體（AegisTrans 一包寫，尚未回饋）。
 */

import { devLog, devWarn } from '../utils/devLog';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FileOpener } from '@capawesome-team/capacitor-file-opener';
import { tr } from '../i18n/tr';

// ============================================
// sender-supplied filename → filesystem path 防注入（抄 AegisTrans C-3 2026-05-07）
// 對方送來的 manifest.name 不能直接當 writeFile path：../../ 逃逸、絕對路徑、
// NUL/控制字元、>255 bytes 截斷。取 basename → 過濾 → 截 200 bytes → fallback file.bin。
// ============================================
function sanitizeFileName(raw: string): string {
  if (!raw || typeof raw !== 'string') return 'file.bin';
  let name = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f:?*<>|"]/g, '_');
  if (name.startsWith('.') || name.startsWith('-')) name = '_' + name;
  const enc = new TextEncoder();
  if (enc.encode(name).byteLength > 200) {
    const dotIdx = name.lastIndexOf('.');
    const ext = dotIdx > 0 && dotIdx > name.length - 16 ? name.slice(dotIdx) : '';
    let base = ext ? name.slice(0, name.length - ext.length) : name;
    while (enc.encode(base + ext).byteLength > 200 && base.length > 0) {
      base = base.slice(0, -1);
    }
    name = base + ext;
  }
  return name.trim() || 'file.bin';
}

// ============================================
// 類型定義
// ============================================

export interface FileOpenOptions {
  /** 檔案名稱 */
  name: string;
  /** MIME 類型 */
  mimeType: string;
  /** 檔案內容 (base64 data URL 或 blob URL) */
  dataUrl: string;
}

export interface FileOpenResult {
  /** 是否成功 */
  success: boolean;
  /** 錯誤訊息 */
  error?: string;
}

// ============================================
// 檢測功能支援
// ============================================

/**
 * 檢查是否支援 File System Access API (用於儲存到特定位置)
 */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * 檢查是否為原生 App (Capacitor)
 */
export function isNativeApp(): boolean {
  return typeof (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform === 'function'
    && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor!.isNativePlatform!();
}

/**
 * 檢查是否為 iOS
 */
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * 檢查是否為 Android
 */
export function isAndroid(): boolean {
  return /Android/.test(navigator.userAgent);
}

// ============================================
// 檔案開啟功能
// ============================================

/**
 * 「儲存」— native 寫 Documents（不彈面板，檔案管理員/檔案 App 看得到）；
 * web 走 File System Access API / <a download>。
 */
export async function openFile(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, mimeType, dataUrl } = options;

  if (isNativeApp()) {
    return saveNativeOnly(options);
  }

  try {
    devLog('[FileOpener] Opening file:', name, mimeType);

    // 將 data URL 轉為 Blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // 建立 Object URL
    const objectUrl = URL.createObjectURL(blob);

    // 方法 1: 嘗試使用 File System Access API (Chrome 86+)
    if (supportsFileSystemAccess() && !isIOS()) {
      try {
        const handle = await (window as { showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<FileSystemFileHandle> }).showSaveFilePicker!({
          suggestedName: name,
          types: [{
            description: getFileTypeDescription(mimeType),
            accept: { [mimeType]: [getFileExtension(name)] },
          }],
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        URL.revokeObjectURL(objectUrl);
        devLog('[FileOpener] File saved via File System Access API');
        return { success: true };
      } catch (err) {
        // 使用者取消或不支援
        if ((err as Error).name !== 'AbortError') {
          devWarn('[FileOpener] File System Access API failed, falling back:', err);
        }
      }
    }

    // 方法 2: 使用 <a> 標籤下載
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = name;

    // iOS Safari 處理
    if (isIOS()) {
      // iOS Safari 對於某些檔案類型會直接預覽而不是下載
      // 使用 target="_blank" 在新視窗開啟
      if (canPreviewInBrowser(mimeType)) {
        link.target = '_blank';
        link.removeAttribute('download');
      }
    }

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 延遲釋放 URL
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);

    devLog('[FileOpener] File download triggered');
    return { success: true };
  } catch (err) {
    console.error('[FileOpener] Failed to open file:', err);
    return {
      success: false,
      error: (err as Error).message || '無法開啟檔案',
    };
  }
}

/**
 * 「開啟」— native 用 FileOpener 彈系統「開啟方式」（viewer apps）；
 * web 可預覽就新視窗開，不能就退回下載。
 */
export async function previewFile(options: FileOpenOptions): Promise<FileOpenResult> {
  const { dataUrl, mimeType } = options;

  if (isNativeApp()) {
    return openWithSystemAppNative(options);
  }

  try {
    if (!canPreviewInBrowser(mimeType)) {
      // Web（非 native）無法叫系統「用其他 App 開啟」→ 退回下載（開不了就存下來）
      return openFile(options);
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const newWindow = window.open(objectUrl, '_blank');
    if (!newWindow) {
      URL.revokeObjectURL(objectUrl);
      return { success: false, error: '無法開啟新視窗，請檢查彈出視窗阻擋器設定' };
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return { success: true };
  } catch (err) {
    console.error('[FileOpener] Failed to preview file:', err);
    return { success: false, error: (err as Error).message || '無法預覽檔案' };
  }
}

/**
 * 「用其他 App 開啟」— FilePreviewModal 的按鈕入口。
 * native = FileOpener「開啟方式」（沒 app 能開自動 fallback Share sheet）；web = previewFile。
 */
export async function openWithSystemApp(options: FileOpenOptions): Promise<FileOpenResult> {
  return previewFile(options);
}

/**
 * 「分享」— 顯式 Share sheet（LINE/Gmail/儲存到檔案…）。
 */
export async function shareFile(options: FileOpenOptions): Promise<FileOpenResult> {
  if (isNativeApp()) {
    return saveAndShareNative({ ...options }, tr('file.shareTo'));
  }
  // Web Share API（手機瀏覽器有效）
  const navAny = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[] }) => Promise<void> };
  if (navAny.share && navAny.canShare) {
    try {
      const resp = await fetch(options.dataUrl);
      const blob = await resp.blob();
      const file = new File([blob], options.name, { type: options.mimeType });
      if (navAny.canShare({ files: [file] })) {
        await navAny.share({ files: [file] });
        return { success: true };
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        return { success: false, error: e.message || '分享失敗' };
      }
      return { success: true }; // 使用者取消
    }
  }
  return openFile(options);
}

/**
 * 儲存檔案到下載目錄
 */
export async function saveFile(options: FileOpenOptions): Promise<FileOpenResult> {
  // 目前實作與 openFile 相同
  return openFile(options);
}

// ============================================
// 輔助函數
// ============================================

/**
 * 檢查檔案是否可以在瀏覽器中預覽
 */
export function canPreviewInBrowser(mimeType: string): boolean {
  // SVG 可含 <script>/<foreignObject>，禁止直接預覽（XSS 風險）
  if (mimeType === 'image/svg+xml') return false;

  // 可以在瀏覽器中直接預覽的類型
  const previewableTypes = [
    'image/',
    'video/',
    'audio/',
    'application/pdf',
    'text/plain',
    'text/css',
    'application/json',
  ];

  return previewableTypes.some(type => mimeType.startsWith(type));
}

/**
 * 執行檔副檔名清單（抄 AegisTrans）。命中 → UI 在「開啟」前彈警告（傳輸不阻擋）。
 * 對應產品原則：程式檔不直接開，其他盡量開。
 */
const EXECUTABLE_EXTS: ReadonlySet<string> = new Set([
  // Windows
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr', '.vbs', '.wsf',
  // Android
  '.apk', '.aab', '.xapk',
  // macOS
  '.dmg', '.pkg', '.app',
  // Linux
  '.deb', '.rpm', '.appimage', '.run',
  // Cross-platform
  '.jar', '.sh', '.bash',
]);

/** 副檔名是不是執行檔（用於 UI 在開啟前提醒風險）。 */
export function isExecutableFile(filename: string): boolean {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? EXECUTABLE_EXTS.has(ext) : false;
}

/**
 * 取得檔案類型描述
 */
function getFileTypeDescription(mimeType: string): string {
  if (mimeType.startsWith('image/')) return tr('file.imageFile');
  if (mimeType.startsWith('video/')) return tr('file.videoFile');
  if (mimeType.startsWith('audio/')) return tr('file.audioFile');
  if (mimeType === 'application/pdf') return tr('file.pdfDocument');
  if (mimeType.includes('word') || mimeType.includes('document')) return tr('file.wordDocument');
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return tr('file.excelSpreadsheet');
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return tr('file.powerpointPresentation');
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return tr('file.archiveFile');
  if (mimeType.startsWith('text/')) return tr('file.textFile');
  return tr('file.genericFile');
}

/**
 * 從檔名取得副檔名
 */
function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.substring(lastDot);
}

/**
 * 取得建議的 MIME 類型
 */
export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

// ============================================
// Native (Capacitor) 實作
// ============================================

/**
 * 分塊寫檔（AegisTalk 改良）：blob:/data: → 6MB slice base64 write+append。
 * 塊長 3 的倍數 → 串接 base64 合法。回傳寫好的 uri。
 */
async function writeFileChunked(dataUrl: string, path: string, directory: Directory): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const CHUNK = 6 * 1024 * 1024;
  const toBase64 = (b: Blob) => new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = fr.result as string; resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(b);
  });
  for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
    const b64 = await toBase64(blob.slice(off, off + CHUNK));
    if (off === 0) {
      await Filesystem.writeFile({ path, data: b64, directory, recursive: true });
    } else {
      await Filesystem.appendFile({ path, data: b64, directory });
    }
  }
  const { uri } = await Filesystem.getUri({ path, directory });
  return uri;
}

/**
 * Native「開啟」：寫到 Cache → FileOpener（Android ACTION_VIEW / iOS 開啟方式）。
 * 沒 app 能開（No app / UNAVAILABLE）→ fallback Share sheet。
 */
async function openWithSystemAppNative(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, mimeType, dataUrl } = options;
  try {
    const uri = await writeFileChunked(dataUrl, sanitizeFileName(name), Directory.Cache);
    console.error(`[FileOpener] cache saved: ${uri}, opening with mime=${mimeType}`);
    await FileOpener.openFile({ path: uri, mimeType });
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] openWithSystemApp failed: ${e?.message || String(e)}`);
    if (e?.message?.includes('No app') || e?.message?.includes('UNAVAILABLE')) {
      console.error('[FileOpener] no app handles mime, falling back to share');
      return saveAndShareNative(options, tr('file.openWith'));
    }
    return { success: false, error: e?.message || '無法開啟檔案' };
  }
}

/**
 * Native「另存」：只寫 Documents，不開 Share sheet。檔案 App「文件」看得到。
 */
async function saveNativeOnly(options: FileOpenOptions): Promise<FileOpenResult> {
  const { name, dataUrl } = options;
  try {
    const uri = await writeFileChunked(dataUrl, sanitizeFileName(name), Directory.Documents);
    console.error(`[FileOpener] saved (no share): ${uri}`);
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] native save failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法儲存檔案' };
  }
}

/**
 * Native「分享/開啟 fallback」：寫 Documents → Share sheet。使用者取消不算錯（檔已存）。
 */
async function saveAndShareNative(options: FileOpenOptions, dialogTitle: string = tr('file.openOrShare')): Promise<FileOpenResult> {
  const { name, dataUrl } = options;
  try {
    const uri = await writeFileChunked(dataUrl, sanitizeFileName(name), Directory.Documents);
    console.error(`[FileOpener] saved native: ${uri}`);
    try {
      await Share.share({ title: name, text: name, url: uri, dialogTitle });
    } catch (shareErr) {
      const e = shareErr as Error;
      if (e?.message?.toLowerCase().includes('cancel')) {
        devLog('[FileOpener] share cancelled, file saved at', uri);
      } else {
        console.error(`[FileOpener] share failed (file is saved): ${e?.message || String(e)}`);
      }
    }
    return { success: true };
  } catch (err) {
    const e = err as Error;
    console.error(`[FileOpener] native save failed: ${e?.message || String(e)}`);
    return { success: false, error: e?.message || '無法儲存檔案' };
  }
}

export default {
  openFile,
  openWithSystemApp,
  previewFile,
  shareFile,
  saveFile,
  canPreviewInBrowser,
  supportsFileSystemAccess,
  isNativeApp,
  isIOS,
  isAndroid,
  getMimeType,
  isExecutableFile,
};

/**
 * FilePreviewModal - 檔案預覽 Modal
 * 根據檔案類型選擇適當的預覽方式
 * - PDF: 使用 PDFViewer 元件
 * - 圖片: 直接顯示
 * - 其他: 顯示下載提示
 */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PDFViewer } from './PDFViewer';
import { openFile, openWithSystemApp, isNativeApp, isExecutableFile } from '../../services/fileOpener';
import { useLanguage } from '../../i18n/context';

interface FileInfo {
  /** 檔案名稱 */
  name: string;
  /** 檔案類型 (MIME type) */
  mimeType: string;
  /** 檔案大小 (bytes) */
  size: number;
  /** 檔案內容 (base64 data URL) */
  dataUrl: string;
}

interface FilePreviewModalProps {
  file: FileInfo;
  onClose: () => void;
}

/** 取得檔案類型的圖示 */
function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '\u{1F5BC}\u{FE0F}';
  if (mimeType === 'application/pdf') return '\u{1F4C4}';
  if (mimeType.includes('word') || mimeType.includes('document')) return '\u{1F4DD}';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '\u{1F4CA}';
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '\u{1F4FD}\u{FE0F}';
  if (mimeType.includes('audio')) return '\u{1F3B5}';
  if (mimeType.includes('video')) return '\u{1F3AC}';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '\u{1F4E6}';
  if (mimeType.includes('text')) return '\u{1F4C3}';
  return '\u{1F4CE}';
}

/** 格式化檔案大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const { t } = useLanguage();
  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  // §14.4（LEARNINGS）：文字預覽字級可調（rem 旋鈕，禁 hardcode px）
  const [textScale, setTextScale] = useState(0.875);

  const isPDF = file.mimeType === 'application/pdf';
  const isImage = file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml';
  // WKWebView/瀏覽器原生就能播/顯示的類型 — 能在 app 內開的盡量開（用戶 2026-07-15 定調）
  const isVideo = file.mimeType.startsWith('video/');
  const isAudio = file.mimeType.startsWith('audio/');
  const isText = file.mimeType.startsWith('text/') || file.mimeType === 'application/json';

  // 純文字類：讀出內容直接顯示。§14.4：>1MB 不再整份塞 <pre>（凍畫面）→ 截前 1MB + 提示。
  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    const MAX_TEXT = 1024 * 1024;
    fetch(file.dataUrl)
      .then((r) => r.blob())
      .then((b) => {
        const truncated = b.size > MAX_TEXT;
        return (truncated ? b.slice(0, MAX_TEXT) : b).text().then((txt) => {
          if (!cancelled) { setTextContent(txt); setTextTruncated(truncated); }
        });
      })
      .catch(() => { /* 讀不出 → 維持 fallback */ });
    return () => { cancelled = true; };
  }, [isText, file.dataUrl]);

  // 下載檔案（使用 fileOpener 服務）
  const handleDownload = async () => {
    try {
      setDownloading(true);

      const result = await openFile({
        name: file.name,
        mimeType: file.mimeType,
        dataUrl: file.dataUrl,
      });

      if (!result.success) {
        console.error('[FilePreviewModal] Download failed:', result.error);
      } else if (isNativeApp()) {
        // native 是靜默寫 Documents（AegisTrans 語意）→ 告知使用者存哪
        window.alert(t('file.savedToDocuments'));
      }

      setDownloading(false);
    } catch (err) {
      console.error('[FilePreviewModal] Download failed:', err);
      setDownloading(false);
    }
  };

  // 原生：系統「開啟方式」面板（LINE 式）— PPTX/DOCX/XLSX 等交給手機上裝的 App
  const handleOpenWith = async () => {
    // 程式檔不直接開（產品原則：除了程式檔盡量能開）→ 開啟前警告，使用者可取消
    if (isExecutableFile(file.name) && !window.confirm(t('file.executableWarning'))) return;
    try {
      setOpening(true);
      const result = await openWithSystemApp({
        name: file.name,
        mimeType: file.mimeType,
        dataUrl: file.dataUrl,
      });
      if (!result.success) console.error('[FilePreviewModal] Open-with failed:', result.error);
    } finally {
      setOpening(false);
    }
  };

  // ESC 鍵關閉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // PDF 預覽 — portal 到 body：跳脫聊天列表的 stacking context，
  //   PDFViewer 的 fixed inset-0 才能真正蓋過聊天 header（修工具列與 app header 重疊）。
  if (isPDF) {
    return createPortal(
      <PDFViewer src={file.dataUrl} fileName={file.name} onClose={onClose} />,
      document.body
    );
  }

  // 圖片/影片/音訊/純文字 — app 內直接開（同一個全螢幕 viewer 骨架）
  if (isImage || isVideo || isAudio || (isText && textContent !== null)) {
    // portal 到 body — 同 PDFViewer：跳脫訊息氣泡 transform/stacking context，
    //   否則 iOS 上 header 的關閉/下載按鈕收不到點擊（真機實測：影片播了但跳不出去）。
    return createPortal(
      <div
        className="fixed inset-0 z-50 bg-black/90 flex flex-col"
        onClick={onClose}
      >
        <div
          className="flex items-center justify-between px-4 py-3 bg-surface-tertiary border-b border-[var(--surface-border)]"
          // iPhone 瀏海：header 頂到 y=0 時，X/下載按鈕落在狀態列下點不到（真機實測「跳不出影片」）。
          //   同 PDFViewer 的修法 — safe-area inset 往下推。web 上 env()=0 無影響。
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xl">{getFileIcon(file.mimeType)}</span>
            <span className="text-white text-sm truncate">{file.name}</span>
            <span className="text-on-surface-tertiary text-xs">({formatFileSize(file.size)})</span>
          </div>

          <div className="flex items-center gap-2">
            {isText && textContent !== null && (
              <>
                <button onClick={() => setTextScale((v) => Math.max(0.625, +(v - 0.125).toFixed(3)))}
                  className="px-2 py-1.5 bg-surface-elevated text-white text-sm rounded" title="A−">A−</button>
                <button onClick={() => setTextScale((v) => Math.min(1.5, +(v + 0.125).toFixed(3)))}
                  className="px-2 py-1.5 bg-surface-elevated text-white text-sm rounded" title="A+">A+</button>
                <button onClick={() => setTextScale(0.875)}
                  className="px-2 py-1.5 bg-surface-elevated text-white text-sm rounded" title="reset">↺</button>
              </>
            )}
            {isNativeApp() && (
              <button
                onClick={handleOpenWith}
                disabled={opening}
                className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-elevated text-white text-sm rounded transition-colors disabled:opacity-50"
              >
                {t('file.openWithApp')}
              </button>
            )}
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="px-3 py-1.5 bg-mist-500 hover:bg-mist-600 text-white text-sm rounded transition-colors disabled:opacity-50"
            >
              {downloading ? t('file.downloading') : t('file.download')}
            </button>

            <button
              onClick={onClose}
              className="p-2 text-white hover:bg-surface-elevated rounded transition-colors"
              title={t('common.close')}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div
          className="flex-1 overflow-auto flex items-center justify-center p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {isImage && (
            <img
              src={file.dataUrl}
              alt={file.name}
              className="max-w-full max-h-full object-contain"
            />
          )}
          {isVideo && (
            /* eslint-disable-next-line jsx-a11y/media-has-caption */
            <video src={file.dataUrl} controls autoPlay playsInline className="max-w-full max-h-full" />
          )}
          {isAudio && (
            /* eslint-disable-next-line jsx-a11y/media-has-caption */
            <audio src={file.dataUrl} controls autoPlay className="w-full max-w-md" />
          )}
          {isText && textContent !== null && (
            <div className="w-full h-full overflow-auto bg-surface-secondary rounded-lg p-4">
              {textTruncated && (
                <p className="text-xs text-amber-400 mb-2">{t('file.textTruncated')}</p>
              )}
              <pre className="text-white whitespace-pre-wrap break-words" style={{ fontSize: `${textScale}rem` }}>
                {textContent}
              </pre>
            </div>
          )}
        </div>
      </div>,
      document.body
    );
  }

  // 其他檔案類型 - 顯示下載提示（同樣 portal，fallback 的按鈕在 iOS 才點得到）
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div
        className="bg-surface-secondary rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-[var(--surface-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center mb-6">
          <span className="text-6xl mb-4">{getFileIcon(file.mimeType)}</span>
          <h3 className="text-white text-lg font-medium text-center break-all">
            {file.name}
          </h3>
          <span className="text-on-surface-tertiary text-sm mt-1">
            {formatFileSize(file.size)}
          </span>
        </div>

        <p className="text-on-surface-secondary text-sm text-center mb-6">
          {t('file.unsupportedPreviewDownload')}
        </p>

        <div className="flex flex-col gap-3">
          {isNativeApp() && (
            <button
              onClick={handleOpenWith}
              disabled={opening}
              className="w-full px-4 py-2.5 bg-mist-500 hover:bg-mist-600 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {t('file.openWithApp')}
            </button>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-surface-elevated hover:bg-surface-elevated text-white rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className={`flex-1 px-4 py-2.5 ${isNativeApp() ? 'bg-surface-elevated hover:bg-surface-elevated' : 'bg-mist-500 hover:bg-mist-600'} text-white rounded-lg transition-colors disabled:opacity-50`}
            >
              {downloading ? t('file.downloading') : t('file.downloadFile')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default FilePreviewModal;

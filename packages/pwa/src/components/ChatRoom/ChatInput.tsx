import { useState, KeyboardEvent, useRef, useCallback, DragEvent, useEffect } from 'react';
import { useLanguage } from '../../i18n';
import { VoiceRecordButton } from './VoiceRecordButton';
import { ext } from '@ext';
import { PaperclipIcon, AudioLinesIcon, WalletIcon } from '../common/icons';
import type { VoiceRecordingResult } from '../../services/voiceMessage';

/**
 * ChatInput - 訊息輸入元件
 *
 * 支援文字輸入、語音訊息錄製、檔案傳送、檔案拖拉和支付功能
 * 支援圖片預覽與文字說明同時發送
 */

/** 檔案傳送結果（chunked P2P） */
export interface FileMessageData {
  /** 完整檔案物件（用於 chunked P2P 傳輸） */
  file: File;
  /** 圖片/檔案說明文字 */
  caption?: string;
  /**
   * Base64 data URL — 僅用於 sender 本機圖片預覽，不走網路傳輸
   * （新 chunked 路徑：blob 存進 fileBlobStore，不再用 base64 傳遞）
   */
  dataUrl?: string;
}

/** 待發送的檔案（圖片或文件） */
interface PendingFile {
  file: File;
  dataUrl: string;
  caption: string;
  isImage: boolean;
}

interface ChatInputProps {
  onSend: (content: string) => void;
  /** 語音訊息（音訊檔案） */
  onSendVoiceMessage?: (result: VoiceRecordingResult) => void;
  /** 檔案訊息 */
  onSendFile?: (file: FileMessageData) => void;
  /** 從外部拖拉進來的檔案（由 ChatRoom 傳入） */
  droppedFile?: File | null;
  /** 清除已處理的拖拉檔案 */
  onDroppedFileProcessed?: () => void;
  /** 聊天內轉帳（AegisPay Phase 0；未啟用時不顯示選單項） */
  onTransfer?: () => void;
}

/** 最大檔案大小 (500MB) — chunked P2P 上限，超過 OOM 風險 */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** 圖片類型 */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** 文件類型（支援預覽和說明文字） */
const DOCUMENT_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/csv'];

export function ChatInput({ onSend, onSendVoiceMessage, onSendFile, droppedFile, onDroppedFileProcessed, onTransfer }: ChatInputProps) {
  const { t } = useLanguage();
  const [message, setMessage] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  // 語音即時聽寫（button B）：啟用時 headless VoiceInput 把辨識文字即時填入輸入框
  const [isVoiceInputActive, setIsVoiceInputActive] = useState(false);
  // 聽寫要裝置上的語音辨識（官方版才有；社群版沒有聽寫鈕）
  const VoiceInput = ext.ui.VoiceInput;
  // 聽寫起點：開始聽寫當下輸入框既有文字，辨識結果接在其後（每次以此重算，不重複累加）
  const dictationBaseRef = useRef('');
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captionInputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    if (message.trim()) {
      onSend(message.trim());
      setMessage('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME 組字中（中日韓輸入法）按 Enter 是「確認候選字」，不可當送出。
    // 否則送出後 compositionend 觸發 onChange 把剛確認的字重新填回 → 輸入框清不掉（PWA/桌面 IME 限定）。
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // 檢查是否為圖片
  const isImageFile = (file: File): boolean => {
    return IMAGE_TYPES.includes(file.type);
  };

  // 檢查是否為文件（支援預覽和說明文字）
  const isDocumentFile = (file: File): boolean => {
    return DOCUMENT_TYPES.includes(file.type);
  };

  // 處理檔案（共用於選擇和拖拉）— 改用 chunked P2P 傳輸（LEARNINGS §1）
  const processFile = useCallback(async (file: File) => {
    if (!onSendFile) return;

    // 檢查檔案大小
    if (file.size > MAX_FILE_SIZE) {
      alert(t('group.fileTooLarge', { size: `${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` }));
      return;
    }

    // 圖片/文件：顯示預覽（讀 dataUrl 僅供本機預覽用，不會走網路傳輸）
    if (isImageFile(file) || isDocumentFile(file)) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setPendingFile({
        file,
        dataUrl,
        caption: '',
        isImage: isImageFile(file),
      });
      setTimeout(() => captionInputRef.current?.focus(), 100);
      return;
    }

    // 其他檔案直接發送（無預覽，不需要 dataUrl — 走 chunked P2P）
    setIsUploading(true);
    try {
      onSendFile({ file });
    } catch (err) {
      console.error('[ChatInput] 發送檔案失敗:', err);
      alert(t('chat.fileSendFailed'));
    } finally {
      setIsUploading(false);
    }
  }, [onSendFile, t]);

  // 處理從外部傳入的拖拉檔案
  useEffect(() => {
    if (droppedFile) {
      processFile(droppedFile);
      onDroppedFileProcessed?.();
    }
  }, [droppedFile, processFile, onDroppedFileProcessed]);

  // 發送檔案（可能帶有文字說明）
  const handleSendFile = useCallback(async () => {
    if (!pendingFile || !onSendFile) return;

    setIsUploading(true);
    try {
      // 走 chunked P2P：傳遞 File + caption，dataUrl 僅 sender 本機預覽用
      onSendFile({
        file: pendingFile.file,
        caption: pendingFile.caption.trim() || undefined,
        dataUrl: pendingFile.dataUrl,  // sender 本機立即顯示縮圖
      });

      // 清除預覽
      setPendingFile(null);
    } catch (err) {
      console.error('[ChatInput] 發送檔案失敗:', err);
      alert(t('chat.fileSendFailed'));
    } finally {
      setIsUploading(false);
    }
  }, [pendingFile, onSendFile, t]);

  // 取消檔案預覽
  const handleCancelFile = useCallback(() => {
    setPendingFile(null);
  }, []);

  // 更新檔案說明文字
  const handleCaptionChange = useCallback((caption: string) => {
    if (pendingFile) {
      setPendingFile({ ...pendingFile, caption });
    }
  }, [pendingFile]);

  // 處理檔案預覽的鍵盤事件
  const handleCaptionKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendFile();
    } else if (e.key === 'Escape') {
      handleCancelFile();
    }
  };

  // 處理檔案選擇
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    await processFile(file);

    // 清空 input 以便再次選擇相同檔案
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // 處理拖拉
  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSendFile) {
      setIsDragOver(true);
    }
  }, [onSendFile]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (!onSendFile) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // 只處理第一個檔案
      await processFile(files[0]);
    }
  }, [onSendFile, processFile]);

  // 處理貼上圖片
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items || !onSendFile) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await processFile(file);
        }
        return;
      }
    }
  }, [onSendFile, processFile]);

  return (
    <div
      className={`relative flex flex-col bg-surface-secondary border-t border-[var(--surface-border)] transition-colors ${
        isDragOver ? 'bg-accent-soft border-accent' : ''
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 檔案預覽區域 */}
      {pendingFile && (
        <div className="relative p-3 border-b border-[var(--surface-border)]">
          <div className="flex items-end gap-2 overflow-hidden">
            {/* 預覽：圖片或文件圖示 */}
            <div className="relative flex-shrink-0">
              {pendingFile.isImage ? (
                <img
                  src={pendingFile.dataUrl}
                  alt={t('chat.previewAlt')}
                  className="w-16 h-16 object-cover rounded-lg"
                />
              ) : (
                <div className="w-16 h-16 bg-surface-tertiary rounded-lg flex flex-col items-center justify-center">
                  <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-xs text-on-surface-secondary mt-1 truncate max-w-[56px] px-1">
                    {pendingFile.file.name.split('.').pop()?.toUpperCase() || t('file.genericFile')}
                  </span>
                </div>
              )}
              {/* 刪除按鈕 */}
              <button
                onClick={handleCancelFile}
                className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center shadow-md transition-colors"
                title={t('common.cancel')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 說明文字輸入 */}
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary truncate">
                {pendingFile.isImage ? t('chat.captionLabel') : pendingFile.file.name}
              </span>
              <input
                ref={captionInputRef}
                type="text"
                value={pendingFile.caption}
                onChange={(e) => handleCaptionChange(e.target.value)}
                onKeyDown={handleCaptionKeyDown}
                placeholder={pendingFile.isImage ? t('chat.captionPlaceholder') : t('chat.documentCaptionPlaceholder')}
                className="w-full input-base rounded-lg px-3 py-2 text-sm"
              />
            </div>

            {/* 發送按鈕 */}
            <button
              onClick={handleSendFile}
              disabled={isUploading}
              className="flex-shrink-0 p-2.5 bg-accent hover:opacity-90 text-white rounded-full transition-all disabled:opacity-50"
              title={t('common.send')}
            >
              {isUploading ? (
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}

      {/* 拖拉提示覆蓋層 */}
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-soft border-2 border-dashed border-accent rounded-lg z-10 pointer-events-none">
          <span className="text-accent font-medium">{t('chat.dropToSendFile')}</span>
        </div>
      )}

      {/* button B 即時聽寫：掛載即聽，辨識文字即時填入下方輸入框（headless，無面板/讀秒/傳送鈕） */}
      {isVoiceInputActive && VoiceInput && (
        <VoiceInput
          onLiveText={(text) => {
            const base = dictationBaseRef.current;
            setMessage(base ? `${base} ${text}` : text);
          }}
          onStop={() => setIsVoiceInputActive(false)}
        />
      )}

      {/* 主輸入區域 */}
      <div className="flex items-center gap-2 p-3">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          className="hidden"
          accept="*/*"
        />

        {/* More menu button (+ 號) */}
        <div className="relative">
          <button
            onClick={() => setShowMoreMenu(!showMoreMenu)}
            className={`p-2 hover:bg-surface-tertiary rounded-full transition-all text-on-surface-secondary ${
              showMoreMenu ? 'rotate-45 bg-surface-tertiary' : ''
            }`}
            title={t('chat.moreOptions')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>

          {/* 更多選單 */}
          {showMoreMenu && (
            <>
              {/* 遮罩層 */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowMoreMenu(false)}
              />

              {/* 選單內容 */}
              <div className="absolute bottom-12 left-0 z-50 bg-surface-secondary rounded-xl shadow-lg border border-[var(--surface-border)] p-1.5 min-w-[160px]">
                {/* 檔案 */}
                <button
                  onClick={() => {
                    fileInputRef.current?.click();
                    setShowMoreMenu(false);
                  }}
                  disabled={isUploading}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-tertiary rounded-lg transition-colors text-left"
                >
                  <PaperclipIcon size={18} className="shrink-0" />
                  <span className="text-on-surface-primary text-sm">{t('group.sendFile')}</span>
                </button>

                {/* 轉帳（AegisPay Phase 0） */}
                {onTransfer && (
                  <button
                    onClick={() => {
                      onTransfer();
                      setShowMoreMenu(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-tertiary rounded-lg transition-colors text-left"
                  >
                    <WalletIcon size={18} className="shrink-0" />
                    <span className="text-on-surface-primary text-sm">{t('transfer.transferTitle')}</span>
                  </button>
                )}

              </div>
            </>
          )}
        </div>

        {/* button B 語音即時聽寫（說話轉文字，方便長輩不打字）— 再按一次停止；聽寫中圖示轉紅脈動 */}
        {VoiceInput && (
        <button
          onClick={() => {
            if (isVoiceInputActive) {
              setIsVoiceInputActive(false);
            } else {
              dictationBaseRef.current = message.trim();
              setIsVoiceInputActive(true);
            }
          }}
          className={`p-2 rounded-full transition-all ${
            isVoiceInputActive
              ? 'bg-red-500 text-white animate-pulse'
              : 'hover:bg-surface-tertiary text-on-surface-secondary'
          }`}
          title={t('chat.voiceInputHint')}
        >
          <AudioLinesIcon size={20} />
        </button>
        )}

        {/* Input field — textarea for multi-line support */}
        <div className="flex-1">
          <textarea
            ref={(el) => {
              if (el) {
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }
            }}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('group.typeMessage')}
            rows={1}
            className="w-full input-base rounded-2xl px-4 py-2.5 text-sm resize-none overflow-y-auto"
            style={{ maxHeight: '120px' }}
          />
        </div>

        {/* Voice record button (show when no text) */}
        {!message.trim() && onSendVoiceMessage && (
          <VoiceRecordButton onRecordComplete={onSendVoiceMessage} />
        )}

        {/* Send button (show when has text) */}
        {message.trim() && (
          <button
            onClick={handleSend}
            className="p-2.5 bg-accent hover:opacity-90 text-white rounded-full transition-all"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

import { devLog } from '../../utils/devLog';
import { useState, useRef, useEffect, useCallback } from 'react';
import type { Message, RiskResult, RiskLevel } from '../../types';
import { usePrivacyMode } from '../../stores/policyStore';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { FilePreviewModal } from '../FilePreview';
import { shareText, canShare } from '../../services/fileShare';
import { MessageContent } from '../common/MessageContent';
import { UserAvatar } from '../common';
import { ext } from '@ext';
import { TrashIcon, CopyIcon, ForwardIcon, ShareIcon, FlameIcon, FileTypeIcon, DownloadIcon, ShieldIcon } from '../common/icons';
import { openFile } from '../../services/fileOpener';
import { getBlob } from '../../services/fileBlobStore';
import { useLanguage } from '../../i18n';

// L2 風險警告已移至 ScamAlertModal 彈窗顯示


/** 格式化檔案大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// §14.2 內嵌媒體門檻（用戶 2026-07-15 定 200MB；preload=metadata 只載中繼資料不吃流量）
const INLINE_MEDIA_MAX = 200 * 1024 * 1024;

interface MessageBubbleProps {
  message: Message;
  onBurn: () => void;
  onDeleteRemotely?: () => void;
  /** 發送者頭像（用於對方的訊息） */
  senderAvatar?: string;
  /** 發送者名字（用於對方的訊息） */
  senderName?: string;
  /** 發送者信任狀態（頭像外框顏色） */
  riskLevel?: RiskLevel;
  /** 語音訊息風險偵測回調 */
  onVoiceRiskDetected?: (riskResult: RiskResult, transcript: string) => void;
  /** 點擊轉發按鈕 */
  onForward?: (message: Message) => void;
  /** 轉帳卡片收款（AegisPay Phase 0；收款方 pending 卡片顯示按鈕） */
  /** 匯款方後悔期取消（Δ3） */
  onCancelPayment?: (message: Message) => Promise<void>;
  /** 未開通收款人點「前往開通」 */
  onActivateAegisPay?: () => void;
}

export function MessageBubble({ message, onBurn, onDeleteRemotely, senderAvatar, senderName, riskLevel, onVoiceRiskDetected, onForward, onCancelPayment, onActivateAegisPay }: MessageBubbleProps) {
  const { t } = useLanguage();
  const privacyModeEnabled = usePrivacyMode();
  const PaymentCard = ext.ui.PaymentCard;
  // 如果隱私模式關閉，預設顯示訊息；如果開啟，需要點擊才顯示
  const [isRevealed, setIsRevealed] = useState(!privacyModeEnabled);
  const [ttlRemaining, setTtlRemaining] = useState<number | null>(null);
  const ttlTimer = useRef<NodeJS.Timeout | null>(null);
  const burnTimer = useRef<NodeJS.Timeout | null>(null);
  const autoHideTimer = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true); // 追蹤元件是否已掛載
  const isMine = message.senderId === 'me';

  // Risk left-border: subtle indicator for flagged messages (received only)
  const riskBorderClass = (() => {
    if (isMine || !message.riskResult) return '';
    if (message.riskResult.riskLevel === 'critical') return 'msg-risk-critical';
    if (message.riskResult.riskLevel === 'high') return 'msg-risk-high';
    return '';
  })();

  // Tap-to-reveal risk detail
  const [showRiskDetail, setShowRiskDetail] = useState(false);

  // 使用 ref 存儲最新的回調，避免 useEffect 依賴變化導致 timer 被清除
  const onBurnRef = useRef(onBurn);
  const onDeleteRemotelyRef = useRef(onDeleteRemotely);

  // 保持 ref 更新
  useEffect(() => {
    onBurnRef.current = onBurn;
    onDeleteRemotelyRef.current = onDeleteRemotely;
  }, [onBurn, onDeleteRemotely]);

  // Memoize handlers to prevent useEffect issues
  const handleBurn = useCallback(() => {
    onBurnRef.current();
  }, []);

  // 銷毀訊息並通知對方（用於閱後即焚和 TTL 到期）
  const handleBurnWithSync = useCallback(() => {
    devLog('[MessageBubble] handleBurnWithSync called, isMounted:', isMountedRef.current);

    try {
      if (onDeleteRemotelyRef.current) {
        // 同步刪除：通知對方並刪除本地
        devLog('[MessageBubble] Calling onDeleteRemotely');
        onDeleteRemotelyRef.current();
      } else {
        // 僅本地刪除
        devLog('[MessageBubble] Calling onBurn');
        onBurnRef.current();
      }
    } catch (err) {
      console.error('[MessageBubble] Error burning message:', err);
    }
  }, []);

  // 閱後即焚標記
  const isBurnAfterRead = message.ttl === -1;
  const [hasBeenRead, setHasBeenRead] = useState(false);

  // TTL countdown effect - 開始倒數計時（僅適用於 TTL > 0 的訊息）
  useEffect(() => {
    if (isRevealed && message.ttl && message.ttl > 0 && ttlRemaining === null) {
      setTtlRemaining(message.ttl);
    }
  }, [isRevealed, message.ttl, ttlRemaining]);

  useEffect(() => {
    if (ttlRemaining !== null && ttlRemaining > 0) {
      devLog('[MessageBubble] TTL countdown:', ttlRemaining);
      ttlTimer.current = setTimeout(() => {
        setTtlRemaining(ttlRemaining - 1);
      }, 1000);
      return () => {
        if (ttlTimer.current) clearTimeout(ttlTimer.current);
      };
    } else if (ttlRemaining === 0) {
      // TTL 到期：同步刪除雙方訊息
      devLog('[MessageBubble] TTL expired, burning message');
      handleBurnWithSync();
    }
  }, [ttlRemaining, handleBurnWithSync]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (ttlTimer.current) clearTimeout(ttlTimer.current);
      if (burnTimer.current) clearTimeout(burnTimer.current);
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    };
  }, []);

  // 檔案預覽狀態 (hooks must be before early returns)
  const [showFilePreview, setShowFilePreview] = useState(false);

  // Chunked file blob URL — fileData.fileId 存在時從 fileBlobStore 取 blob 建 ObjectURL
  // 舊的 base64-in-content 訊息 fallback 用 message.content（顯式向後相容）
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const fileId = message.fileData?.fileId;
  useEffect(() => {
    if (!fileId) {
      setBlobUrl(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    getBlob(fileId).then((blob) => {
      if (cancelled) return;
      if (blob) {
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      } else {
        setBlobUrl(null);
      }
    }).catch(() => {
      if (!cancelled) setBlobUrl(null);
    });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [fileId]);

  // 統一檔案顯示 URL：優先 chunked blob URL，否則 fallback 到舊的 base64 dataUrl
  const fileDisplayUrl = blobUrl || message.content;

  // 長按選單狀態
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 點擊外部關閉選單
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };

    if (showContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showContextMenu]);

  // If message is burned, don't render anything (after all hooks)
  if (message.isBurned) {
    return null;
  }

  // 點擊切換顯示/隱藏（僅在隱私模式開啟時有效）
  const handleToggleReveal = () => {
    // 隱私模式關閉時，不處理點擊
    if (!privacyModeEnabled) return;

    if (!isRevealed) {
      // 顯示訊息
      setIsRevealed(true);

      // 閱後即焚：顯示後 5 秒自動銷毀（雙向同步）
      if (isBurnAfterRead && !hasBeenRead) {
        setHasBeenRead(true);
        burnTimer.current = setTimeout(() => {
          setIsRevealed(false);
          setTimeout(() => {
            // 使用 handleBurnWithSync 確保雙向刪除
            handleBurnWithSync();
          }, 300);
        }, 5000); // 給用戶 5 秒閱讀時間
      } else if (ttlRemaining === null) {
        // 一般訊息：5 秒後自動隱藏
        autoHideTimer.current = setTimeout(() => {
          setIsRevealed(false);
        }, 5000);
      }
    } else {
      // 點擊隱藏（TTL 倒數中或閱後即焚的訊息無法手動隱藏）
      if (ttlRemaining === null && !isBurnAfterRead) {
        if (autoHideTimer.current) {
          clearTimeout(autoHideTimer.current);
        }
        setIsRevealed(false);
      }
    }
  };

  const handleBurnClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 接收者刪除也同步通知發送者
    if (onDeleteRemotelyRef.current) {
      onDeleteRemotelyRef.current();
    } else {
      handleBurn();
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  const isImage = message.type === 'image';
  const isVoice = message.type === 'voice';
  const isFile = message.type === 'file';
  // 檢查是否為圖片檔案（type='file' 但 mimeType 是 image/*）
  const isImageFile = isFile && message.fileData?.mimeType?.startsWith('image/');

  // 長按開始
  const handleLongPressStart = (e: React.TouchEvent | React.MouseEvent) => {
    if (privacyModeEnabled && !isRevealed) return; // 隱私模式下未顯示時不能長按

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    longPressTimer.current = setTimeout(() => {
      setMenuPosition({ x: clientX, y: clientY });
      setShowContextMenu(true);
    }, 500); // 500ms 長按
  };

  // 長按取消
  const handleLongPressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // 複製訊息
  const handleCopy = async () => {
    try {
      if (message.type === 'text') {
        await navigator.clipboard.writeText(message.content);
      }
      setShowContextMenu(false);
    } catch (err) {
      console.error('[MessageBubble] 複製失敗:', err);
    }
  };

  // 分享訊息
  const handleShare = async () => {
    if (message.type === 'text' && canShare()) {
      await shareText({ text: message.content });
    }
    setShowContextMenu(false);
  };

  // 轉發訊息
  const handleForward = () => {
    setShowContextMenu(false);
    onForward?.(message);
  };

  // 渲染頭像
  const renderAvatar = () => {
    return <UserAvatar avatar={senderAvatar} name={senderName} size="sm" className="flex-shrink-0" riskLevel={riskLevel} />;
  };

  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mb-2`}>
      <div className="max-w-[70%]">
        {/* 發送者資訊（頭像 + 名字）- LINE 風格，頭像在名字左邊 */}
        {!isMine && (
          <div className="flex items-center gap-1.5 mb-1 ml-1">
            {renderAvatar()}
            {senderName && (
              <span className="text-xs text-on-surface-tertiary">
                {senderName}
              </span>
            )}
          </div>
        )}

        {/* 轉帳卡片（AegisPay Phase 0；只有官方版有，社群版當一般訊息） */}
        {message.type === 'payment' && message.paymentData && PaymentCard ? (
          <PaymentCard
            paymentData={message.paymentData}
            isMine={isMine}
            onCancel={onCancelPayment ? () => onCancelPayment(message) : undefined}
            onActivateRequest={onActivateAegisPay}
          />
        ) : isVoice && message.voiceData ? (
          <VoiceMessageBubble
            audioData={message.content}
            duration={message.voiceData.duration}
            mimeType={message.voiceData.mimeType}
            waveform={message.voiceData.waveform}
            isMine={isMine}
            transcript={message.voiceData.transcript}
            onRiskDetected={onVoiceRiskDetected}
          />
        ) : isImageFile && message.fileData ? (
          /* 圖片檔案訊息 - 顯示圖片預覽 + 說明文字 */
          <div
            onClick={() => setShowFilePreview(true)}
            onTouchStart={handleLongPressStart}
            onTouchEnd={handleLongPressEnd}
            onTouchMove={handleLongPressEnd}
            onMouseDown={handleLongPressStart}
            onMouseUp={handleLongPressEnd}
            onMouseLeave={handleLongPressEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuPosition({ x: e.clientX, y: e.clientY });
              setShowContextMenu(true);
            }}
            className={`
              relative rounded-2xl select-none cursor-pointer
              transition-all duration-200 overflow-hidden p-1
              ${riskBorderClass}
              ${isMine
                ? 'bg-mist-500 text-white rounded-br-md'
                : 'bg-surface-tertiary text-on-surface-primary rounded-bl-md'
              }
            `}
          >
            {/* 圖片預覽 — chunked: blob URL；legacy: base64 dataUrl */}
            {fileDisplayUrl ? (
              <img
                src={fileDisplayUrl}
                alt={message.fileData.name}
                className="rounded-xl max-w-full"
                style={{ maxHeight: '300px' }}
              />
            ) : (
              <div className="rounded-xl flex items-center justify-center text-xs text-white/70" style={{ width: 200, height: 150 }}>
                {t('file.downloading')}
              </div>
            )}
            {/* 說明文字（如果有） */}
            {message.fileData.caption && (
              <p className={`mt-2 px-2 pb-1 text-sm ${isMine ? 'text-white' : 'text-on-surface-primary'}`}>
                {message.fileData.caption}
              </p>
            )}
          </div>
        ) : isFile && message.fileData ? (
          /* 一般檔案訊息 - 顯示檔案卡片 */
          <div
            onClick={() => setShowFilePreview(true)}
            onTouchStart={handleLongPressStart}
            onTouchEnd={handleLongPressEnd}
            onTouchMove={handleLongPressEnd}
            onMouseDown={handleLongPressStart}
            onMouseUp={handleLongPressEnd}
            onMouseLeave={handleLongPressEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuPosition({ x: e.clientX, y: e.clientY });
              setShowContextMenu(true);
            }}
            className={`
              relative rounded-2xl select-none cursor-pointer
              transition-all duration-200 overflow-hidden px-4 py-3
              ${riskBorderClass}
              ${isMine
                ? 'bg-mist-500 text-white rounded-br-md'
                : 'bg-surface-tertiary text-on-surface-primary rounded-bl-md'
              }
            `}
          >
            <div className="flex flex-col gap-2">
              {/* §14.2（LEARNINGS）：≤25MB 影/音直接內嵌可播（像 LINE），不必點開 modal。
                  controls 自吃點擊 → stopPropagation 免誤開 preview。 */}
              {fileDisplayUrl && message.fileData.size <= INLINE_MEDIA_MAX && message.fileData.mimeType?.startsWith('video/') && (
                /* eslint-disable-next-line jsx-a11y/media-has-caption */
                <video src={fileDisplayUrl} controls playsInline preload="metadata"
                  className="w-full max-h-64 rounded-lg bg-black" onClick={(e) => e.stopPropagation()} />
              )}
              {fileDisplayUrl && message.fileData.size <= INLINE_MEDIA_MAX && message.fileData.mimeType?.startsWith('audio/') && (
                /* eslint-disable-next-line jsx-a11y/media-has-caption */
                <audio src={fileDisplayUrl} controls preload="metadata"
                  className="w-full" onClick={(e) => e.stopPropagation()} />
              )}
              {/* §14.6（LEARNINGS）：檔名完整顯示（break-all 換行不截斷），大小+按鈕移下排 —
                  舊版單排 [icon][truncate 檔名][鈕] 長檔名被截成 SolarS...，看不到副檔名。 */}
              <div className="flex items-start gap-3">
                <div className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xl ${
                  isMine ? 'bg-white/20' : 'bg-mist-500/20'
                }`}>
                  <FileTypeIcon mimeType={message.fileData.mimeType} size={20} />
                </div>
                <p className={`flex-1 text-sm font-medium break-all ${isMine ? 'text-white' : 'text-on-surface-primary'}`}>
                  {message.fileData.name}
                </p>
              </div>
              <div className="flex items-center justify-between">
                <p className={`text-xs ${isMine ? 'text-white/70' : 'text-on-surface-tertiary'}`}>
                  {formatFileSize(message.fileData.size)}
                </p>
                {/* 下載按鈕 — 所有檔案(含 PDF)都在氣泡內直接下載，不必先開閱讀器才看得到下載 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (fileDisplayUrl && message.fileData) {
                      openFile({ name: message.fileData.name, mimeType: message.fileData.mimeType, dataUrl: fileDisplayUrl });
                    }
                  }}
                  disabled={!fileDisplayUrl}
                  className={`shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-40 ${isMine ? 'text-white/80 hover:bg-white/15' : 'text-on-surface-tertiary hover:bg-black/10'}`}
                  title={t('file.saveToDevice')}
                >
                  <DownloadIcon size={18} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            onClick={() => {
              // If risk border is present, toggle risk detail on tap
              if (riskBorderClass && !privacyModeEnabled) {
                setShowRiskDetail(!showRiskDetail);
              }
              handleToggleReveal();
            }}
            onTouchStart={handleLongPressStart}
            onTouchEnd={handleLongPressEnd}
            onTouchMove={handleLongPressEnd}
            onMouseDown={handleLongPressStart}
            onMouseUp={handleLongPressEnd}
            onMouseLeave={handleLongPressEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!privacyModeEnabled || isRevealed) {
                setMenuPosition({ x: e.clientX, y: e.clientY });
                setShowContextMenu(true);
              }
            }}
            className={`
              relative rounded-2xl
              transition-all duration-200 overflow-hidden
              ${riskBorderClass}
              ${privacyModeEnabled ? 'cursor-pointer' : ''}
              ${privacyModeEnabled && !isRevealed ? 'select-none' : 'select-text'}
              ${isImage ? 'p-1' : 'px-4 py-2'}
              ${isMine
                ? 'bg-mist-500 text-white rounded-br-md'
                : 'bg-surface-tertiary text-on-surface-primary rounded-bl-md'
              }
            `}
          >
            {/* Blur overlay - 僅在隱私模式開啟且未顯示時出現 */}
            {privacyModeEnabled && (
              <div
                className={`
                  absolute inset-0 rounded-2xl backdrop-blur-md bg-surface-primary/50 z-10
                  transition-opacity duration-200
                  ${isRevealed ? 'opacity-0 pointer-events-none' : 'opacity-100'}
                  ${isMine ? 'rounded-br-md' : 'rounded-bl-md'}
                `}
              >
                <div className="w-full h-full flex items-center justify-center text-on-surface-secondary text-sm min-h-[60px]">
                  {isImage ? t('chat.tapToViewImage') : t('chat.tapToView')}
                </div>
              </div>
            )}

            {/* Actual message content */}
            {isImage ? (
              <img
                src={message.content}
                alt={t('chat.imageMessageAlt')}
                className={`rounded-xl max-w-full transition-opacity duration-200 ${isRevealed || !privacyModeEnabled ? 'opacity-100' : 'opacity-0'}`}
                style={{ maxHeight: '300px' }}
              />
            ) : (
              <span className={`transition-opacity duration-200 ${isRevealed || !privacyModeEnabled ? 'opacity-100' : 'opacity-0'} ${privacyModeEnabled && !isRevealed ? '' : 'select-text'} ${message.isLoading ? 'flex items-center gap-2' : ''}`}>
                {/* Loading spinner for status messages */}
                {message.isLoading && (
                  <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                )}
                <MessageContent content={message.content} />
              </span>
            )}

            {/* TTL indicator */}
            {message.ttl && message.ttl > 0 && (
              <div className={`absolute -top-1 -right-1 text-white text-xs px-1.5 py-0.5 rounded-full z-20 ${
                ttlRemaining !== null && ttlRemaining <= 3 ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
              }`}>
                {ttlRemaining !== null ? `${ttlRemaining}s` : `${message.ttl}s`}
              </div>
            )}
            {/* 閱後即焚指示器 */}
            {isBurnAfterRead && (
              <div className={`absolute -top-1 -right-1 text-white px-1.5 py-0.5 rounded-full z-20 flex items-center justify-center ${
                hasBeenRead ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
              }`}>
                <FlameIcon size={12} />
              </div>
            )}

            {/* L2 風險標記已移至彈窗，不在訊息上顯示 */}
          </div>
        )}

        {/* 檔案預覽 Modal */}
        {showFilePreview && isFile && message.fileData && fileDisplayUrl && (
          <FilePreviewModal
            file={{
              name: message.fileData.name,
              mimeType: message.fileData.mimeType,
              size: message.fileData.size,
              dataUrl: fileDisplayUrl,
            }}
            onClose={() => setShowFilePreview(false)}
          />
        )}

        {/* Risk detail tooltip - shown on tap of risk-bordered message */}
        {showRiskDetail && riskBorderClass && message.riskResult && (
          <div className="mt-1 px-3 py-2 bg-surface-tertiary rounded-lg text-xs text-on-surface-secondary max-w-[75%] animate-fade-in">
            <ShieldIcon size={12} className="inline-block mr-1 align-[-1px]" />
            {message.riskResult.warnings?.[0] || t('risk.riskDetected')}
          </div>
        )}

        {/* Message info row */}
        <div className={`flex items-center gap-2 mt-1 text-xs text-on-surface-tertiary ${isMine ? 'justify-end' : 'justify-start'}`}>
          <span>{formatTime(message.timestamp)}</span>
          {isMine && message.isRead && <span>{t('chat.read')}</span>}

          {/* Delete button for sent messages - always deletes for both sides */}
          {isMine && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                // 直接雙方刪除
                if (onDeleteRemotelyRef.current) {
                  onDeleteRemotelyRef.current();
                } else {
                  handleBurn();
                }
              }}
              className="hover:text-red-400 transition-colors p-1"
              title={t('group.deleteMessage')}
            >
              <TrashIcon size={14} />
            </button>
          )}

          {/* Burn button - only for received messages */}
          {!isMine && (
            <button
              onClick={handleBurnClick}
              className="hover:text-red-400 transition-colors p-1"
              title={t('chat.destroyMessage')}
            >
              <TrashIcon size={14} />
            </button>
          )}
        </div>

        {/* 長按選單 */}
        {showContextMenu && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 bg-surface-secondary rounded-xl shadow-xl border border-[var(--surface-border)] overflow-hidden"
            style={{
              left: Math.min(menuPosition.x, window.innerWidth - 150),
              top: Math.min(menuPosition.y, window.innerHeight - 200),
            }}
          >
            <div className="py-1">
              {/* 複製 - 僅文字訊息 */}
              {message.type === 'text' && (
                <button
                  onClick={handleCopy}
                  className="w-full px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary flex items-center gap-3"
                >
                  <CopyIcon size={18} />
                  <span>{t('common.copy')}</span>
                </button>
              )}

              {/* 轉發 */}
              {onForward && (
                <button
                  onClick={handleForward}
                  className="w-full px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary flex items-center gap-3"
                >
                  <ForwardIcon size={18} />
                  <span>{t('common.forward')}</span>
                </button>
              )}

              {/* 分享到其他 App - 僅文字訊息且支援 Web Share */}
              {message.type === 'text' && canShare() && (
                <button
                  onClick={handleShare}
                  className="w-full px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary flex items-center gap-3"
                >
                  <ShareIcon size={18} />
                  <span>{t('common.share')}</span>
                </button>
              )}

              {/* 刪除 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowContextMenu(false);
                  if (onDeleteRemotelyRef.current) {
                    onDeleteRemotelyRef.current();
                  } else {
                    handleBurn();
                  }
                }}
                className="w-full px-4 py-2.5 text-left text-red-500 hover:bg-surface-tertiary flex items-center gap-3"
              >
                <TrashIcon size={18} />
                <span>{t('common.delete')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

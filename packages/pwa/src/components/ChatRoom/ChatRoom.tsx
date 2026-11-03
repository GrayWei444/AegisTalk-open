import { devLog, devWarn } from '../../utils/devLog';
import { useRef, useEffect, useCallback, useState, useMemo, DragEvent } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useChat } from '../../hooks/useChat';
import { useVoiceCall } from '../../hooks/useVoiceCall';
import { useContactRisk } from '../../hooks/useContactRisk';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';
import { SyncingIndicator } from '../common/SyncingIndicator';
import { isFileTransferReady } from '../../services/fileTransfer';
import { ScamAlertModal } from './ScamAlertModal';
import { CallState } from '../../services/voiceCall';
import { ProfileSettings } from '../Settings';
import { ForwardModal } from '../FileShare';
import { useApp } from '../../providers/AppProvider';
import { PendingFriendBanner } from './PendingFriendBanner';
import { ext } from '@ext';
import { ComplaintModal } from '../Complaint';
import { setContactTrustedStatus, isContactTrusted } from '../../services/storage';
import type { VoiceRecordingResult } from '../../services/voiceMessage';
import type { RiskResult, RiskLevel, Message } from '../../types';
import type { FileMessageData } from './ChatInput';
import type { SharedFile } from '../../services/fileShare';
import { UserAvatar } from '../common';
import { UserIcon, ShieldIcon, UnlockIcon, BanIcon, TrashIcon, FolderIcon, DotIcon } from '../common/icons';
import { useLanguage } from '../../i18n';
import { onPluginEvent, emitPluginEvent } from '../../plugins/PluginEventBus';

/** 已顯示過警告的訊息 ID（module-level，ChatRoom unmount 後仍保留，避免重複彈窗） */
// 已警告過的訊息 ID：持久化到 localStorage，避免重登後對「同一則舊風險訊息」重複彈窗。
// （過去只存記憶體 → reload 後訊息的 riskResult 還在 SQLite → 自動重觸發，用戶按「我知道了」也擋不住）
const _ALERTED_IDS_KEY = 'aegis_alerted_msg_ids';
function _loadAlertedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(_ALERTED_IDS_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch { return new Set<string>(); }
}
function _persistAlertedId(id: string): void {
  try {
    const ids = _loadAlertedIds();
    ids.add(id);
    // ponytail: 上限保留最近 500 則，避免 localStorage 無限長；更舊的本來也不會再彈
    localStorage.setItem(_ALERTED_IDS_KEY, JSON.stringify([...ids].slice(-500)));
  } catch { /* ignore */ }
}
const _globalAlertedMessageIds = _loadAlertedIds();
interface ChatRoomProps {
  onBack?: () => void;
}

export function ChatRoom({ onBack }: ChatRoomProps) {
  const { t } = useLanguage();
  const { burnMessage, updateFriendTrust, removeFriend, loadFromStorage, friends, currentFriendId: storeCurrentFriendId, updatePaymentStatus, userProfile } = useChatStore();
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showComplaintModal, setShowComplaintModal] = useState(false);
  // 信任聯絡人白名單狀態
  const [isTrustedContact, setIsTrustedContact] = useState(false);

  // 拖放狀態
  const [isDragOver, setIsDragOver] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const dragCounterRef = useRef(0);
  const {
    isReady,
    currentFriend,
    currentMessages,
    sendEncryptedMessage,
    sendPaymentCancelled,
    sendFile,
    deleteMessageRemotely,
    isPeerConnected,
    canSendMessage,
  } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 供 risk-alert listener 以 messageId 反查完整 riskResult/content（避免 stale closure：
  // listener 的 useEffect deps 僅 [currentFriend, t]，不隨 currentMessages 重建）
  const currentMessagesRef = useRef<Message[]>(currentMessages);
  currentMessagesRef.current = currentMessages;
  const friendRiskLevel = useContactRisk(currentFriend?.publicKey);

  // 強制重新渲染計數器（用於從背景恢復）
  const [, forceRender] = useState(0);

  // 關鍵修復：當有 currentFriendId 但找不到 currentFriend 時，重新載入資料
  useEffect(() => {
    if (storeCurrentFriendId && !currentFriend && friends.length === 0) {
      devLog('[ChatRoom] currentFriendId exists but no friends, forcing reload...');
      loadFromStorage();
      // 延遲再試一次
      const timer = setTimeout(() => {
        loadFromStorage();
        forceRender(prev => prev + 1);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [storeCurrentFriendId, currentFriend, friends.length, loadFromStorage]);

  // 語音通話 Hook - 只需要 startCall 和 callState
  // 來電提示和通話 UI 由全域的 GlobalVoiceCallUI 處理
  const { startCall, callState } = useVoiceCall();

  // 載入信任聯絡人白名單狀態
  useEffect(() => {
    if (currentFriend) {
      isContactTrusted(currentFriend.publicKey).then((trusted) => {
        setIsTrustedContact(trusted);
      });
    }
  }, [currentFriend]);

  // 切換信任狀態
  const handleToggleTrust = useCallback(async () => {
    if (!currentFriend) return;
    const newTrusted = !isTrustedContact;
    await setContactTrustedStatus(currentFriend.publicKey, newTrusted);
    setIsTrustedContact(newTrusted);
    devLog('[ChatRoom] Contact trust status changed:', newTrusted);
  }, [currentFriend, isTrustedContact]);

  // 追蹤已忽略的 intervention cards
  const [dismissedInterventions, setDismissedInterventions] = useState<Set<string>>(new Set());

  const { publicKey: myPublicKey, cryptoReady } = useApp();

  // §14.5（LEARNINGS，抄 AegisTrans Timeline）：登入後 crypto/fileTransfer 初始化窗口
  //   presence 已顯示在線但送訊/送檔會失效 → ready 前顯示「同步中…」+ 鎖輸入，好了自動解鎖。
  const [syncReady, setSyncReady] = useState(false);
  useEffect(() => {
    if (syncReady) return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      if (cryptoReady && isFileTransferReady()) { setSyncReady(true); return; }
      setTimeout(check, 400);
    };
    check();
    return () => { cancelled = true; };
  }, [syncReady, cryptoReady]);
  // L2 詐騙警告彈窗狀態
  const [scamAlert, setScamAlert] = useState<{
    isOpen: boolean;
    riskResult: RiskResult | null;
    messageContent: string;
    messageId?: string;  // 用於「這不是詐騙」功能
  }>({ isOpen: false, riskResult: null, messageContent: '' });

  // 版本的擴充用的回呼（官方版：L3 行為分析警示、AegisPay 轉帳；社群版沒有）
  const showScamAlert = useCallback((riskResult: RiskResult, messageContent: string) => {
    setScamAlert({ isOpen: true, riskResult, messageContent });
  }, []);
  const sendPaymentMessage = useCallback((paymentData: NonNullable<Message['paymentData']>) => {
    sendEncryptedMessage('', 'payment', undefined, undefined, undefined, paymentData);
  }, [sendEncryptedMessage]);

  // 追蹤已顯示過警告的訊息 ID，避免重複彈窗（從 module-level 持久化讀取）
  const [alertedMessageIds, setAlertedMessageIds] = useState<Set<string>>(new Set(_globalAlertedMessageIds));

  // 追蹤被標記為安全（非詐騙）的訊息 ID
  const [markedSafeMessages, setMarkedSafeMessages] = useState<Set<string>>(new Set());

  // 轉發訊息狀態
  const [forwardMessage, setForwardMessage] = useState<{
    isOpen: boolean;
    files: SharedFile[];
    text?: string;
  }>({ isOpen: false, files: [] });

  // AegisBot 思考過程 inline 顯示（CLAUDE.md §14）— 對方送 agent_status 時顯示
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  useEffect(() => {
    setAgentStatus(null); // 切換好友先清掉舊狀態
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { fromPubkey?: string; status?: string };
      if (!currentFriend || detail.fromPubkey !== currentFriend.publicKey) return;
      setAgentStatus(detail.status && detail.status.trim() ? detail.status : null);
    };
    window.addEventListener('aegis:agent-status', handler);
    return () => window.removeEventListener('aegis:agent-status', handler);
  }, [currentFriend]);

  // AegisGuard RiskMonitor 紅盾警示：收到 risk_alert 事件且對象為當前好友時彈出 ScamAlertModal
  useEffect(() => {
    const off = onPluginEvent('host', 'aegisguard:risk-alert', (detail) => {
      const ev = detail as {
        severity?: RiskLevel;
        title?: string;
        description?: string;
        contactPubkey?: string;
        messageId?: string;
      } | null;
      if (!ev || !currentFriend) return;
      // 有指定對象時只對當前好友彈窗；未指定（全域 network 攔截）則一律顯示
      if (ev.contactPubkey && ev.contactPubkey !== currentFriend.publicKey) return;
      const level: RiskLevel = ev.severity ?? 'high';
      // 優先以 messageId 反查原訊息的完整 riskResult / 內容（保留 L2 規則/fastText 細節），
      // 反查不到（如 network 攔截無對應訊息）才退回事件描述合成 riskResult。
      const original = ev.messageId
        ? currentMessagesRef.current.find((m) => m.id === ev.messageId)
        : undefined;
      setScamAlert({
        isOpen: true,
        riskResult: original?.riskResult ?? {
          riskLevel: level,
          riskScore: level === 'critical' ? 90 : level === 'high' ? 70 : 40,
          action: level === 'critical' ? 'block' : 'warn',
          warnings: ev.description ? [ev.description] : [],
          triggeredRules: [{
            id: 'aegisguard_risk_monitor',
            name: ev.title ?? t('chat.behaviorAnomalyDetection'),
            severity: level,
            category: 'risk_monitor',
          }],
        },
        messageContent: original?.content ?? ev.description ?? '',
        messageId: ev.messageId,
      });
    });
    return off;
  }, [currentFriend, t]);


  // 處理訊息轉發
  const handleForwardMessage = useCallback((message: Message) => {
    if (message.type === 'file' && message.fileData) {
      // 檔案訊息
      setForwardMessage({
        isOpen: true,
        files: [{
          id: message.id,
          name: message.fileData.name,
          mimeType: message.fileData.mimeType,
          size: message.fileData.size,
          dataUrl: message.content,
          receivedAt: message.timestamp,
        }],
      });
    } else if (message.type === 'image') {
      // 圖片訊息
      setForwardMessage({
        isOpen: true,
        files: [{
          id: message.id,
          name: 'image.jpg',
          mimeType: 'image/jpeg',
          size: message.content.length,
          dataUrl: message.content,
          receivedAt: message.timestamp,
        }],
      });
    } else {
      // 文字訊息
      setForwardMessage({
        isOpen: true,
        files: [],
        text: message.content,
      });
    }
  }, []);

  // 偵測新的高風險訊息並彈出警告
  const latestRiskyMessage = useMemo(() => {
    // 找出最新的高風險訊息（對方發送的）
    const riskyMessages = currentMessages.filter(
      (msg) =>
        msg.senderId !== 'me' &&
        msg.riskResult &&
        (msg.riskResult.riskLevel === 'high' || msg.riskResult.riskLevel === 'critical') &&
        !alertedMessageIds.has(msg.id)
    );
    return riskyMessages.length > 0 ? riskyMessages[riskyMessages.length - 1] : null;
  }, [currentMessages, alertedMessageIds]);

  // 當有新的高風險訊息時：紅盾改由 AegisGuard RiskMonitor 產生（emit report-risk →
  // RiskMonitor.reportRisk → risk-alert → 上方 listener 彈 ScamAlertModal），
  // 本 effect 僅負責標記已警告（避免 remount 重複彈窗）。守護人通知獨立於下方
  // effect 處理。
  useEffect(() => {
    if (latestRiskyMessage && latestRiskyMessage.riskResult && currentFriend) {
      emitPluginEvent('host', 'aegisguard:report-risk', {
        source: 'conversation',
        level: latestRiskyMessage.riskResult.riskLevel,
        score: latestRiskyMessage.riskResult.riskScore,
        description:
          latestRiskyMessage.riskResult.warnings[0] ?? latestRiskyMessage.content,
        contactPubkey: currentFriend.publicKey,
        messageId: latestRiskyMessage.id,
        timestamp: Date.now(),
      });
      // 標記為已警告（module-level + localStorage 持久化，避免 remount/重登時重複彈窗）
      _globalAlertedMessageIds.add(latestRiskyMessage.id);
      _persistAlertedId(latestRiskyMessage.id);
      setAlertedMessageIds((prev) => new Set([...prev, latestRiskyMessage.id]));
    }
  }, [latestRiskyMessage, currentFriend]);

  // 版本的擴充（官方版：守護人通知、L3 行為分析警示、AegisPay 轉帳）—— 放在紅盾 effect 之後，effect 的順序跟以前一樣
  const { useChatRoomExtras } = ext.ui;
  const extras = useChatRoomExtras({
    currentFriend,
    myPublicKey,
    myName: userProfile.displayName,
    messages: currentMessages,
    messagesRef: currentMessagesRef,
    sendPaymentMessage,
    sendPaymentCancelled,
    updatePaymentStatus,
    showScamAlert,
  });

  // 發送訊息（使用加密）
  const handleSendMessage = useCallback(
    (content: string, ttl?: number) => {
      // 送訊只需 canSendMessage（crypto + 身份就緒）；不要求完整 isReady（含 mqttConnected）。
      // MQTT 只做信令，訊息走 P2P + 持久化 outbox：P2P 沒連就排隊、連上自動 flush，絕不丟棄。
      // 真因（真機「傳訊息沒反應」）：恢復後 MQTT 重連空窗期 isReady=false →
      //   舊版 `if(isReady)` 把訊息靜默吞掉。改用 canSendMessage 後，訊息進持久化 outbox 不丟。
      if (canSendMessage) {
        sendEncryptedMessage(content, 'text', ttl);
      }
    },
    [canSendMessage, sendEncryptedMessage]
  );

  // 發送語音訊息
  const handleSendVoiceMessage = useCallback(
    (result: VoiceRecordingResult) => {
      if (isReady) {
        // 語音訊息的 content 是 Base64 音訊數據
        // voiceData 包含時長、波形等元資料（transcript 改在接收端產生）
        sendEncryptedMessage(result.audioData, 'voice', undefined, {
          duration: result.duration,
          waveform: result.waveform,
          mimeType: result.mimeType,
        });
      }
    },
    [isReady, sendEncryptedMessage]
  );

  // 發送檔案訊息（chunked P2P，LEARNINGS §1）
  const handleSendFile = useCallback(
    (data: FileMessageData) => {
      if (isReady) {
        sendFile(data.file, data.caption);
      }
    },
    [isReady, sendFile]
  );

  // 拖放事件處理
  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        // 傳給 ChatInput 處理（顯示預覽和說明文字輸入）
        setDroppedFile(files[0]);
      }
    },
    []
  );

  // 清除已處理的拖放檔案
  const handleDroppedFileProcessed = useCallback(() => {
    setDroppedFile(null);
  }, []);

  // 發起語音通話
  const handleStartCall = useCallback((withVideo: boolean = false) => {
    devLog('[ChatRoom] handleStartCall called, withVideo:', withVideo, 'currentFriend:', currentFriend?.name);
    if (currentFriend) {
      devLog('[ChatRoom] Starting call to:', currentFriend.publicKey.slice(0, 16) + '...');
      startCall(currentFriend.publicKey, currentFriend.name, withVideo);
    } else {
      devWarn('[ChatRoom] No currentFriend, cannot start call');
    }
  }, [currentFriend, startCall]);

  // 刪除好友
  const handleDeleteFriend = useCallback(() => {
    if (currentFriend) {
      // 也是「取消加好友」的路（還在等他確認時，PendingFriendBanner 的取消走這裡）：removeFriend 會一併拿掉等待記錄
      removeFriend(currentFriend.id);
      setShowDeleteConfirm(false);
      setShowMenu(false);
      onBack?.();
    }
  }, [currentFriend, removeFriend, onBack]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages.length]);

  // PWA 背景恢復處理 - 確保訊息列表正確顯示
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        devLog('[ChatRoom] Visibility changed to visible, reloading messages...');

        // 重新載入資料
        loadFromStorage();

        // 強制重新渲染
        forceRender(prev => prev + 1);

        // 延遲再次渲染（等待 store 更新）
        setTimeout(() => {
          forceRender(prev => prev + 1);
          // 滾動到底部
          messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        }, 100);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [loadFromStorage]);

  // 當 currentFriendId 存在但 currentFriend 還沒載入時，顯示載入中
  // 這解決了 PWA 從背景恢復時畫面空白的問題
  if (storeCurrentFriendId && !currentFriend) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-primary">
        <div className="text-center text-on-surface-secondary">
          <div className="w-8 h-8 border-2 border-mist-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (!currentFriend) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-primary">
        <div className="text-center text-on-surface-secondary">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-mist-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
            />
          </svg>
          <p>{t('chat.selectConversation')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`h-full flex flex-col bg-surface-primary relative ambient-border ${extras.ambientClass}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 拖放檔案覆蓋層 */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-mist-500/20 backdrop-blur-sm border-4 border-dashed border-mist-500 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <div className="mb-4 flex justify-center"><FolderIcon size={56} className="text-mist-500" /></div>
            <p className="text-xl font-medium text-mist-600 dark:text-mist-400">
              {t('chat.dropToSendFile')}
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-secondary border-b border-[var(--surface-border)]">
        {/* Back button - only on mobile */}
        {onBack && (
          <button
            onClick={onBack}
            className="p-2 -ml-2 hover:bg-surface-tertiary rounded-full transition-colors sm:hidden"
          >
            <span className="text-on-surface-secondary">←</span>
          </button>
        )}

        {/* Friend avatar */}
        <div className="relative">
          <UserAvatar avatar={currentFriend.avatar} name={currentFriend.name} size="md" />
          {currentFriend.online && (
            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-surface-secondary" />
          )}
        </div>

        {/* Friend info */}
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="font-medium text-on-surface-primary">{currentFriend.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            {agentStatus ? (
              /* AegisBot 思考中 — 三個跳動小點 + 狀態文字（取代 online/連線指示） */
              <span className="text-xs text-mist-400 flex items-center gap-1.5 min-w-0">
                <span className="flex gap-0.5 flex-shrink-0">
                  <span className="w-1 h-1 bg-mist-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1 h-1 bg-mist-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1 h-1 bg-mist-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                <span className="truncate">{agentStatus}</span>
              </span>
            ) : (
              <>
                <p className="text-xs text-on-surface-secondary">
                  {currentFriend.online ? t('friendList.online') : t('chat.offline')}
                </p>
                {/* Connection indicator */}
                {isPeerConnected && (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    P2P
                  </span>
                )}
                {isReady && !isPeerConnected && (
                  <span className="text-xs text-mist-400">E2E</span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Video call button */}
        <button
          onClick={() => handleStartCall(true)}
          disabled={callState !== CallState.IDLE}
          className={`p-2.5 rounded-full transition-colors ${
            callState !== CallState.IDLE
              ? 'opacity-50 cursor-not-allowed bg-surface-tertiary'
              : 'bg-blue-500/20 hover:bg-blue-500/30'
          }`}
          title={t('group.videoCall')}
        >
          <svg
            className="w-6 h-6 text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        </button>

        {/* Voice call button */}
        <button
          onClick={() => handleStartCall(false)}
          disabled={callState !== CallState.IDLE}
          className={`p-2.5 rounded-full transition-colors ${
            callState !== CallState.IDLE
              ? 'opacity-50 cursor-not-allowed bg-surface-tertiary'
              : 'bg-green-500/20 hover:bg-green-500/30'
          }`}
          title={t('group.voiceCall')}
        >
          <svg
            className="w-6 h-6 text-green-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
            />
          </svg>
        </button>

        {/* Menu button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 hover:bg-surface-tertiary rounded-full transition-colors"
          >
            <span className="text-on-surface-secondary">⋮</span>
          </button>

          {/* Dropdown menu */}
          {showMenu && (
            <>
              {/* Backdrop */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowMenu(false)}
              />
              {/* Menu */}
              <div className="absolute right-0 top-full mt-1 w-40 bg-surface-secondary rounded-lg shadow-xl border border-[var(--surface-border)] overflow-hidden z-50">
                <button
                  onClick={() => {
                    setShowProfileSettings(true);
                    setShowMenu(false);
                  }}
                  className="w-full px-4 py-3 text-left text-on-surface-primary hover:bg-surface-tertiary flex items-center gap-2"
                >
                  <UserIcon size={16} className="shrink-0" />
                  <span>{t('chat.profileSettings')}</span>
                </button>
                {/* 信任聯絡人白名單 Toggle */}
                <button
                  onClick={() => {
                    handleToggleTrust();
                    setShowMenu(false);
                  }}
                  className="w-full px-4 py-3 text-left hover:bg-surface-tertiary flex items-center gap-2"
                >
                  {isTrustedContact
                    ? <ShieldIcon size={16} className="shrink-0 text-green-500" />
                    : <UnlockIcon size={16} className="shrink-0" />}
                  <span className={isTrustedContact ? 'text-green-500 dark:text-green-400' : 'text-on-surface-primary'}>
                    {isTrustedContact ? t('chat.trustedWhitelisted') : t('chat.addToTrustWhitelist')}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setShowComplaintModal(true);
                    setShowMenu(false);
                  }}
                  className="w-full px-4 py-3 text-left text-red-600 dark:text-red-400 hover:bg-surface-tertiary flex items-center gap-2"
                >
                  <BanIcon size={16} className="shrink-0" />
                  <span>{t('chat.blockUser')}</span>
                </button>
                <button
                  onClick={() => {
                    setShowDeleteConfirm(true);
                    setShowMenu(false);
                  }}
                  className="w-full px-4 py-3 text-left text-red-600 dark:text-red-400 hover:bg-surface-tertiary flex items-center gap-2"
                >
                  <TrashIcon size={16} className="shrink-0" />
                  <span>{t('chat.deleteFriend')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 我加了他、他還沒確認（審查 M1）：說清楚，可以取消（＝刪好友，走原本的確認視窗） */}
      {myPublicKey && (
        <PendingFriendBanner
          owner={myPublicKey}
          friendPublicKey={currentFriend.publicKey}
          friendName={currentFriend.name}
          onCancel={() => setShowDeleteConfirm(true)}
        />
      )}

      {/* Verification banner - for unverified friends */}
      {currentFriend.trustLevel === 'unverified' && (
        <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DotIcon size={10} className="text-yellow-400 shrink-0" />
              <span className="text-sm text-yellow-400/80">
                {t('chat.friendNotVerified')}
              </span>
            </div>
            <button
              onClick={() => updateFriendTrust(currentFriend.id, 'verified')}
              className="px-3 py-1 text-xs bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
            >
              {t('chat.markAsVerified')}
            </button>
          </div>
        </div>
      )}


      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 bg-surface-primary">
        <div>
        {currentMessages
          .filter(message => !message.isBurned)
          .map(message => {
            // 如果訊息被標記為安全，清除 riskResult 以隱藏風險邊框
            const displayMessage = markedSafeMessages.has(message.id)
              ? { ...message, riskResult: undefined }
              : message;
            return (
          <div key={message.id}>
            <MessageBubble
              message={displayMessage}
              onBurn={() => burnMessage(message.id)}
              onDeleteRemotely={() => {
                deleteMessageRemotely(message.id);
                burnMessage(message.id);
              }}
              senderAvatar={message.senderId !== 'me' ? currentFriend.avatar : undefined}
              senderName={message.senderId !== 'me' ? currentFriend.name : undefined}
              riskLevel={message.senderId !== 'me' ? friendRiskLevel : undefined}
              onCancelPayment={extras.onCancelPayment}
              onActivateAegisPay={extras.onActivatePayments}
              onVoiceRiskDetected={(riskResult, transcript) => {
                setScamAlert({
                  isOpen: true,
                  riskResult,
                  messageContent: t('chat.voiceMessageContent').replace('{content}', transcript),
                  messageId: message.id,
                });
              }}
              onForward={handleForwardMessage}
            />
            {/* Inline Intervention Card - critical risk messages only */}
            {message.senderId !== 'me' &&
             message.riskResult?.riskLevel === 'critical' &&
             !dismissedInterventions.has(message.id) &&
             !markedSafeMessages.has(message.id) && (
              <div className="mx-4 my-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-xl flex items-center gap-3 animate-fade-in">
                <ShieldIcon size={18} className="flex-shrink-0 text-red-500" />
                <p className="flex-1 text-sm text-red-700 dark:text-red-300">
                  {message.riskResult.warnings?.[0] || t('chat.matchesScamPattern')}
                </p>
                <button
                  onClick={() => setDismissedInterventions(prev => new Set([...prev, message.id]))}
                  className="text-xs text-gray-500 dark:text-gray-400 px-2 py-1 flex-shrink-0"
                >
                  {t('risk.iKnow')}
                </button>
                <button
                  onClick={() => {
                    setShowComplaintModal(true);
                    setDismissedInterventions(prev => new Set([...prev, message.id]));
                  }}
                  className="text-xs text-red-600 dark:text-red-400 font-medium px-2 py-1 flex-shrink-0"
                >
                  {t('chat.report')}
                </button>
              </div>
            )}
          </div>
            );
          })}
        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area — §14.5：同步窗口顯示指示器鎖輸入（presence online ≠ 可送訊） */}
      {syncReady ? (
        <ChatInput
          onSend={handleSendMessage}
          onSendVoiceMessage={handleSendVoiceMessage}
          onSendFile={handleSendFile}
          droppedFile={droppedFile}
          onDroppedFileProcessed={handleDroppedFileProcessed}
          onTransfer={extras.onTransfer}
        />
      ) : (
        <SyncingIndicator className="bg-surface-secondary border-t border-[var(--surface-border)] py-4" />
      )}

      {/* 版本的擴充 Modal（官方版：AegisPay 轉帳、開通） */}
      {extras.modals}

      {/* 來電提示和通話 UI 由全域的 GlobalVoiceCallUI 處理 */}

      {/* 刪除好友確認 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-surface-secondary rounded-2xl p-6 shadow-2xl border border-[var(--surface-border)] max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-on-surface-primary mb-2">{t('chat.deleteFriend')}</h3>
            <p className="text-on-surface-secondary mb-6">
              {t('chat.deleteFriendConfirm').replace('{name}', currentFriend.name)}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteFriend}
                className="flex-1 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 個人設定 */}
      <ProfileSettings
        isOpen={showProfileSettings}
        onClose={() => setShowProfileSettings(false)}
      />

      {/* 檢舉用戶彈窗 (Phase 16) */}
      {currentFriend && (
        <ComplaintModal
          isOpen={showComplaintModal}
          onClose={() => setShowComplaintModal(false)}
          targetPubkey={currentFriend.publicKey}
          targetNickname={currentFriend.name}
          onComplete={() => {
            // 檢舉完成後可以選擇刪除好友或繼續
            devLog('[ChatRoom] Complaint completed for:', currentFriend.name);
          }}
        />
      )}

      {/* L2 詐騙警告彈窗 */}
      {scamAlert.riskResult && (
        <ScamAlertModal
          isOpen={scamAlert.isOpen}
          onClose={() => setScamAlert({ isOpen: false, riskResult: null, messageContent: '' })}
          riskResult={scamAlert.riskResult}
          messageContent={scamAlert.messageContent}
          onMarkSafe={scamAlert.messageId ? () => {
            setMarkedSafeMessages(prev => new Set([...prev, scamAlert.messageId!]));
            devLog('[ChatRoom] Message marked as safe:', scamAlert.messageId);
          } : undefined}
          onBlockUser={currentFriend ? () => {
            import('../../services/localBlacklist').then(({ addToBlacklistManual }) => {
              addToBlacklistManual(currentFriend.publicKey, currentFriend.name, 'Blocked from scam alert').then(() => {
                devLog('[ChatRoom] User blocked from ScamAlert:', currentFriend.name);
              }).catch((err) => console.error('[ChatRoom] Block failed:', err));
            });
          } : undefined}
          onReportAndBlock={currentFriend ? () => {
            import('../../services/localBlacklist').then(({ addToBlacklistByComplaint }) => {
              addToBlacklistByComplaint({
                pubkey: currentFriend.publicKey,
                nickname: currentFriend.name,
                type: 'scam',
                notes: scamAlert.messageContent || 'AI detected scam content',
              }).then(() => {
                devLog('[ChatRoom] User reported+blocked from ScamAlert:', currentFriend.name);
              }).catch((err) => console.error('[ChatRoom] Report+block failed:', err));
            });
          } : undefined}
        />
      )}

      {/* 轉發訊息 Modal */}
      {forwardMessage.isOpen && (
        <ForwardModal
          files={forwardMessage.files}
          messageContent={forwardMessage.text}
          onClose={() => setForwardMessage({ isOpen: false, files: [] })}
          onComplete={() => setForwardMessage({ isOpen: false, files: [] })}
        />
      )}

    </div>
  );
}

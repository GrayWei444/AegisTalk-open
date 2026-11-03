import { devLog } from '../../utils/devLog';
import { TrashIcon, FlameIcon } from '../common/icons';

/**
 * GroupChatWindow - 群組聊天視窗 (視圖群組架構)
 *
 * 顯示群組訊息並提供發送功能
 * 訊息實際儲存在 1-1 對話中，通過 groupIds 過濾顯示
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useGroupChat } from '../../hooks/useGroupChat';
import { useVoiceCall } from '../../hooks/useVoiceCall';
import { useGroupCall } from '../../hooks/useGroupCall';
import { GroupSettingsModal } from './GroupSettingsModal';
import { InviteMemberModal } from './InviteMemberModal';
import { CreateGroupModal } from './CreateGroupModal';
import { GroupCallUI } from './GroupCallUI';
import { CallState } from '../../services/voiceCall';
import { GroupCallState } from '../../services/groupCallService';
import { useCrypto } from '../../hooks/useCrypto';
import type { Message } from '../../types';
// 守護群組（Phase 19）是官方版的功能：ext.ui.useGroupGuardian
import { ext } from '@ext';
// URL risk scanning - shared component
import { MessageContent } from '../common/MessageContent';
import { GroupAvatar, UserAvatar } from '../common';
// 群組檔案預覽（chunked fileBlobStore + legacy inline base64 雙路徑）
import { FilePreviewModal } from '../FilePreview';
import { getBlob } from '../../services/fileBlobStore';
import { formatFileSize } from '../../services/fileShare';
// 群組紅盾（鏡像 1-1 ChatRoom：riskResult → report-risk → RiskMonitor → ScamAlertModal，§0.7b）
import { ScamAlertModal } from '../ChatRoom/ScamAlertModal';
import { ChatBubbleIcon, FileTypeIcon, FileTextIcon, DownloadIcon, LockIcon, HourglassIcon, PaperclipIcon, CheckIcon } from '../common/icons';
import { onPluginEvent, emitPluginEvent } from '../../plugins/PluginEventBus';
import { useChatStore } from '../../stores/chatStore';
import type { RiskResult, RiskLevel } from '../../types';
import { useContactRiskMap } from '../../hooks/useContactRisk';
import { useLanguage } from '../../i18n/context';
import { VoiceRecordButton } from '../ChatRoom/VoiceRecordButton';
import { VoiceMessageBubble } from '../ChatRoom/VoiceMessageBubble';
import type { VoiceRecordingResult } from '../../services/voiceMessage';

/** TTL 選項定義 - AegisTalk 簡化版 (不使用閱後即焚) */
type TTLOption = {
  value: number | null;
  /** i18n key for label (resolved via t() at render time) */
  labelKey: string;
};

const TTL_OPTIONS: TTLOption[] = [
  { value: null, labelKey: 'group.permanent' },
];

// 已警告過的群組高風險訊息（module-level 持久化，避免 remount 重複彈紅盾；鏡像 ChatRoom）
const _globalGroupAlertedMessageIds = new Set<string>();

interface GroupChatWindowProps {
  onBack?: () => void;
  onNavigateToFriend?: (publicKey: string) => void;
}

function MessageBubble({
  message,
  isOwn,
  onDelete,
  senderName,
  onClickSender,
  riskLevel,
  onRetry,
}: {
  message: Message;
  isOwn: boolean;
  onDelete?: () => void;
  senderName?: string;
  onClickSender?: () => void;
  riskLevel?: RiskLevel;
  /** 我送的、沒送出去的那則：「重送」（開源第 4 步：以前泡泡看起來跟送出去的一樣） */
  onRetry?: () => void;
}) {
  const { t } = useLanguage();
  const [ttlRemaining, setTtlRemaining] = useState<number | null>(null);
  const [hasBeenRead, setHasBeenRead] = useState(false);
  const ttlTimer = useRef<NodeJS.Timeout | null>(null);
  const burnTimer = useRef<NodeJS.Timeout | null>(null);

  // 群組檔案訊息：chunked 走 fileBlobStore（fileId）、legacy 走 inline base64（content）
  const [showFilePreview, setShowFilePreview] = useState(false);
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
  const fileDisplayUrl = blobUrl || (message.content?.startsWith('data:') ? message.content : null);

  const isBurnAfterRead = message.ttl === -1;

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // TTL countdown - 開始倒數計時
  useEffect(() => {
    if (message.ttl && message.ttl > 0 && ttlRemaining === null) {
      setTtlRemaining(message.ttl);
    }
  }, [message.ttl, ttlRemaining]);

  useEffect(() => {
    if (ttlRemaining !== null && ttlRemaining > 0) {
      ttlTimer.current = setTimeout(() => {
        setTtlRemaining(ttlRemaining - 1);
      }, 1000);
      return () => {
        if (ttlTimer.current) clearTimeout(ttlTimer.current);
      };
    } else if (ttlRemaining === 0) {
      // TTL 到期：刪除訊息
      onDelete?.();
    }
  }, [ttlRemaining, onDelete]);

  // 閱後即焚：顯示後 5 秒自動銷毀
  useEffect(() => {
    if (isBurnAfterRead && !hasBeenRead && !isOwn) {
      setHasBeenRead(true);
      burnTimer.current = setTimeout(() => {
        onDelete?.();
      }, 5000);
      return () => {
        if (burnTimer.current) clearTimeout(burnTimer.current);
      };
    }
  }, [isBurnAfterRead, hasBeenRead, isOwn, onDelete]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (ttlTimer.current) clearTimeout(ttlTimer.current);
      if (burnTimer.current) clearTimeout(burnTimer.current);
    };
  }, []);

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[75%] ${isOwn ? 'order-2' : 'order-1'}`}>
        {/* 發送者頭像 + 名稱（非自己的訊息，可點擊跳到個人聊天） */}
        {!isOwn && (
          <div
            className={`flex items-center gap-1.5 mb-1 ${onClickSender ? 'cursor-pointer hover:opacity-80' : ''}`}
            onClick={(e) => { if (onClickSender) { e.stopPropagation(); onClickSender(); } }}
          >
            <UserAvatar name={senderName || message.senderId.slice(0, 4)} size="xs" className="flex-shrink-0" riskLevel={riskLevel} />
            <span className={`text-xs ${onClickSender ? 'text-accent hover:underline' : 'text-gray-500'}`}>
              {senderName || message.senderId.slice(0, 8)}
            </span>
          </div>
        )}

        {/* 訊息內容 */}
        <div className="relative">
          <div
            className={`rounded-2xl px-4 py-2 ${
              isOwn
                ? 'rounded-br-md text-white'
                : 'rounded-bl-md'
            }`}
            style={isOwn
              ? { backgroundColor: 'var(--bubble-sent)', color: 'var(--bubble-sent-text)' }
              : { backgroundColor: 'var(--bubble-received)', color: 'var(--bubble-received-text)' }
            }
          >
            {message.type === 'voice' && message.voiceData ? (
              <VoiceMessageBubble
                audioData={message.content}
                duration={message.voiceData.duration}
                mimeType={message.voiceData.mimeType}
                waveform={message.voiceData.waveform}
                isMine={isOwn}
                transcript={message.voiceData.transcript}
              />
            ) : message.type === 'file' && message.fileData ? (
              /* 檔案卡片（曾直接掉進文字渲染 → base64 當文字、無法開啟預覽） */
              <div
                onClick={() => setShowFilePreview(true)}
                className="flex items-center gap-3 cursor-pointer select-none py-1"
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl flex-shrink-0 ${
                  isOwn ? 'bg-white/20' : 'bg-mist-500/20'
                }`}>
                  <FileTypeIcon mimeType={message.fileData.mimeType} size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{message.fileData.name}</p>
                  <p className="text-xs opacity-70">{formatFileSize(message.fileData.size)}</p>
                </div>
                <div className="opacity-70">
                  {message.fileData.mimeType === 'application/pdf'
                    ? <FileTextIcon size={16} />
                    : <DownloadIcon size={16} />}
                </div>
              </div>
            ) : (
              <MessageContent content={message.content} />
            )}
          </div>

          {/* TTL 指示器 */}
          {message.ttl && message.ttl > 0 && (
            <div className={`absolute -top-1 -right-1 text-white text-xs px-1.5 py-0.5 rounded-full z-10 ${
              ttlRemaining !== null && ttlRemaining <= 3 ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
            }`}>
              {ttlRemaining !== null ? `${ttlRemaining}s` : `${message.ttl}s`}
            </div>
          )}

          {/* 閱後即焚指示器 */}
          {isBurnAfterRead && (
            <div className={`absolute -top-1 -right-1 text-white px-1.5 py-0.5 rounded-full z-10 flex items-center justify-center ${
              hasBeenRead ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
            }`}>
              <FlameIcon size={12} />
            </div>
          )}
        </div>

        {/* 時間和刪除按鈕 */}
        <div
          className={`mt-1 flex items-center gap-2 text-xs text-gray-500 ${
            isOwn ? 'justify-end' : 'justify-start'
          }`}
        >
          <span>{formatTime(message.timestamp)}</span>
          {isOwn && message.sendStatus === 'failed' && (
            <span className="flex items-center gap-1 text-red-400" role="status" data-send-status="failed">
              <span>{t('group.notSent')}</span>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="underline hover:text-red-300 transition-colors"
                  title={t('group.retrySend')}
                >
                  {t('group.retrySend')}
                </button>
              )}
            </span>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="text-red-400 hover:text-red-300 transition-colors p-1"
              title={t('group.deleteMessage')}
            >
              <TrashIcon size={14} />
            </button>
          )}
        </div>

        {/* 檔案預覽 Modal */}
        {showFilePreview && message.type === 'file' && message.fileData && fileDisplayUrl && (
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
      </div>
    </div>
  );
}

export function GroupChatWindow({ onBack, onNavigateToFriend }: GroupChatWindowProps) {
  const [inputText, setInputText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateSubgroup, setShowCreateSubgroup] = useState(false);
  const [showCallMembers, setShowCallMembers] = useState(false);
  const [showMemberList, setShowMemberList] = useState(false);
  const [showGroupCallUI, setShowGroupCallUI] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedTTL, setSelectedTTL] = useState<number | null>(null);
  const [showTTLMenu, setShowTTLMenu] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const callMenuRef = useRef<HTMLDivElement>(null);
  const ttlMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { publicKeyBase64 } = useCrypto();
  const { t } = useLanguage();

  const {
    currentGroup,
    messages,
    members,
    sendMessage,
    sendFileMessage,
    clearSelection,
    deleteGroupMessage,
    updateGuardianSettings,
    sendCheckIn,
    sendVoiceMessage,
    retryUnsent,
    isAdmin: _isAdmin,
    isFull,
  } = useGroupChat();

  // 語音通話 Hook - 只需要 startCall 和 callState
  // 來電提示和通話 UI 由全域的 GlobalVoiceCallUI 處理
  const { startCall, callState } = useVoiceCall();

  // 多人群組通話 Hook (Phase 10)
  const { callState: groupCallState, hasIncomingCall } = useGroupCall();

  // 群組引擎的通知（W2 審查 #11）：邀請一直沒送到、變更先暫停、被拒收 → 這個群的畫面上顯示幾秒
  const [engineNotice, setEngineNotice] = useState<string | null>(null);
  const currentGroupIdForNotice = currentGroup?.id;
  useEffect(() => {
    if (!currentGroupIdForNotice) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onNotice = (event: Event) => {
      const n = (event as CustomEvent).detail as { gid?: string; kind?: string; op?: string; reason?: string } | undefined;
      if (!n || n.gid !== currentGroupIdForNotice) return;
      const text = n.kind === 'invite-unacked' ? t('group.noticeInviteUnacked')
        : n.kind === 'held' ? t('group.noticeHeld')
          : n.kind === 'rejected' ? t('group.changeFailed', { reason: n.reason ?? '' })
            : null;
      if (!text) return;
      setEngineNotice(text);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setEngineNotice(null), 8000);
    };
    window.addEventListener('aegis:group-notice', onNotice);
    return () => {
      window.removeEventListener('aegis:group-notice', onNotice);
      if (timer) clearTimeout(timer);
    };
  }, [currentGroupIdForNotice, t]);

  // 取得其他成員（不含自己）
  const otherMembers = members.filter((m) => m.publicKey !== publicKeyBase64);

  // 成員信任狀態（頭像外框顏色）
  const memberPubkeys = useMemo(() => otherMembers.map(m => m.publicKey), [otherMembers]);
  const riskMap = useContactRiskMap(memberPubkeys);

  // 發送者名稱 fallback：成員暱稱缺失（舊版建群不寫暱稱）時改查好友名單，
  // 避免顯示 pubkey 切片亂碼
  const friends = useChatStore((s) => s.friends);
  const friendNameByPubkey = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of friends) map.set(f.publicKey, f.name);
    return map;
  }, [friends]);

  // ======================================
  // 群組紅盾（鏡像 1-1 ChatRoom §0.7b：riskResult → report-risk → RiskMonitor → ScamAlertModal）
  // ======================================
  const [alertedMessageIds, setAlertedMessageIds] = useState<Set<string>>(new Set(_globalGroupAlertedMessageIds));
  const [scamAlert, setScamAlert] = useState<{
    isOpen: boolean;
    riskResult: RiskResult | null;
    messageContent: string;
    messageId?: string;
    senderPubkey?: string;
  }>({ isOpen: false, riskResult: null, messageContent: '' });

  // listener 以 ref 取最新訊息，避免 stale closure
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // RiskMonitor 紅盾警示：警示對象是本群成員時彈出 ScamAlertModal
  useEffect(() => {
    const off = onPluginEvent('host', 'aegisguard:risk-alert', (detail) => {
      const ev = detail as {
        severity?: RiskLevel;
        title?: string;
        description?: string;
        contactPubkey?: string;
        messageId?: string;
      } | null;
      if (!ev || !currentGroup) {
        console.error(`[DIAG:GRISK] risk-alert dropped: hasEv=${!!ev} hasGroup=${!!currentGroup}`);
        return;
      }
      if (!ev.contactPubkey || !currentGroup.members.some((m) => m.publicKey === ev.contactPubkey)) {
        console.error(`[DIAG:GRISK] risk-alert filtered: contact=${(ev.contactPubkey || 'none').slice(0, 16)} members=${currentGroup.members.map((m) => m.publicKey.slice(0, 8)).join(',')}`);
        return;
      }
      console.error(`[DIAG:GRISK] risk-alert ACCEPTED: severity=${ev.severity} msg=${(ev.messageId || '').slice(0, 24)}`);
      const level: RiskLevel = ev.severity ?? 'high';
      const original = ev.messageId
        ? messagesRef.current.find((m) => m.id === ev.messageId)
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
        senderPubkey: ev.contactPubkey,
      });
    });
    return off;
  }, [currentGroup, t]);

  // 偵測新的高風險群組訊息 → report-risk（紅盾統一由 RiskMonitor 產生）
  const latestRiskyMessage = useMemo(() => {
    const risky = messages.filter(
      (msg) =>
        msg.senderId !== 'me' &&
        msg.riskResult &&
        (msg.riskResult.riskLevel === 'high' || msg.riskResult.riskLevel === 'critical') &&
        !alertedMessageIds.has(msg.id)
    );
    return risky.length > 0 ? risky[risky.length - 1] : null;
  }, [messages, alertedMessageIds]);

  useEffect(() => {
    if (latestRiskyMessage && latestRiskyMessage.riskResult && currentGroup) {
      console.error(`[DIAG:GRISK] report-risk emit: level=${latestRiskyMessage.riskResult.riskLevel} sender=${latestRiskyMessage.senderId.slice(0, 16)} msg=${latestRiskyMessage.id.slice(0, 24)}`);
      emitPluginEvent('host', 'aegisguard:report-risk', {
        source: 'conversation',
        level: latestRiskyMessage.riskResult.riskLevel,
        score: latestRiskyMessage.riskResult.riskScore,
        description:
          latestRiskyMessage.riskResult.warnings[0] ?? latestRiskyMessage.content,
        contactPubkey: latestRiskyMessage.senderId,
        messageId: latestRiskyMessage.id,
        timestamp: Date.now(),
      });
      _globalGroupAlertedMessageIds.add(latestRiskyMessage.id);
      setAlertedMessageIds((prev) => new Set([...prev, latestRiskyMessage.id]));
    }
  }, [latestRiskyMessage, currentGroup]);

  // ======================================
  // 守護群組相關狀態 (Phase 19)：官方版的功能；社群版沒有守護（isGuardianGroup 永遠 false，什麼都不畫）
  // ======================================
  const { useGroupGuardian } = ext.ui;
  const guardian = useGroupGuardian({ currentGroup, publicKey: publicKeyBase64, sendCheckIn, updateGuardianSettings });
  const isCurrentGroupGuardian = guardian.isGuardianGroup;

  // 發起語音通話給特定成員（1-1 通話）
  const handleStartCallToMember = useCallback(
    (memberPk: string, memberName?: string) => {
      startCall(memberPk, memberName);
      setShowCallMembers(false);
    },
    [startCall]
  );

  // 處理檔案選擇（Phase 10: 群組檔案傳送）
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // 檢查檔案大小（10MB 限制）
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        alert(t('group.fileTooLarge', { size: '10MB' }));
        return;
      }
      // 0 位元組收端會拒收（sendFileToGroup 也會丟錯）；直接說檔案是空的，不要顯示「讀取失敗」
      //   （對應 AegisPlay ee7b0729）
      if (file.size === 0) {
        alert(t('group.fileEmpty'));
        return;
      }

      setIsUploading(true);

      try {
        // 分塊 P2P 發送（與 1-1 同協定；舊 inline base64 超過 DataChannel 上限會送不出去）
        await sendFileMessage(file);
      } catch (err) {
        console.error('[GroupChatWindow] 讀取檔案失敗:', err);
        alert(t('group.fileReadFailed'));
      } finally {
        setIsUploading(false);
        // 清空 input 以便再次選擇相同檔案
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [sendFileMessage, t]
  );

  // 點擊外部關閉選單
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
      if (callMenuRef.current && !callMenuRef.current.contains(event.target as Node)) {
        setShowCallMembers(false);
      }
      if (ttlMenuRef.current && !ttlMenuRef.current.contains(event.target as Node)) {
        setShowTTLMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 檢查 TTL 選項是否可用 - AegisTalk 簡化版，所有選項都可用
  const isOptionAvailable = (_option: TTLOption): boolean => {
    return true;
  };

  // 取得當前 TTL 選項
  const getCurrentTTLOption = () => {
    return TTL_OPTIONS.find(opt => opt.value === selectedTTL) || TTL_OPTIONS[0];
  };

  // 滾動到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 發送訊息
  const handleSend = () => {
    if (!inputText.trim()) return;

    // 將 null 轉為 undefined（永久訊息）
    const ttlValue = selectedTTL === null ? undefined : selectedTTL;
    sendMessage(inputText.trim(), ttlValue);
    setInputText('');
    // 發送後重置 TTL 為永久（避免意外發送閱後即焚）
    setSelectedTTL(null);
    inputRef.current?.focus();
  };

  // Enter 發送訊息
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 返回
  const handleBack = () => {
    clearSelection();
    onBack?.();
  };

  if (!currentGroup) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-primary">
        <p className="text-gray-500">{t('group.selectGroupToChat')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-primary">
      {/* 標題列 */}
      <div className="flex items-center gap-3 border-b border-gray-800 px-4 py-3 relative z-10">
        <button
          onClick={handleBack}
          className="rounded-full p-2 text-gray-400 hover:bg-surface-tertiary hover:text-on-surface-primary"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <GroupAvatar avatar={currentGroup.avatar} name={currentGroup.name} size="md" isGuardian={isCurrentGroupGuardian} />

        <div className="flex-1 min-w-0 relative">
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-white truncate">{currentGroup.name}</h2>
          </div>
          <p
            className="text-xs text-gray-400 cursor-pointer hover:text-gray-200"
            onClick={() => setShowMemberList(prev => !prev)}
          >
            {t('group.nMembers', { count: members.length })}
            {guardian.headerBadges}
            <span className="ml-1 text-[0.625rem]">{showMemberList ? '▲' : '▼'}</span>
          </p>
          {/* 成員下拉列表 — 點擊跳到個人聊天 */}
          {showMemberList && (
            <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--surface-border)] bg-surface-secondary py-1 shadow-2xl">
              <div className="px-4 py-2 border-b border-[var(--surface-border)]">
                <p className="text-xs font-medium text-gray-400">{t('group.nMembers', { count: members.length })}</p>
              </div>
              {otherMembers.map((member) => (
                <button
                  key={member.publicKey}
                  onClick={() => {
                    setShowMemberList(false);
                    onNavigateToFriend?.(member.publicKey);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-gray-300 hover:bg-surface-tertiary transition-colors"
                >
                  <UserAvatar name={member.nickname} size="sm" className="flex-shrink-0" riskLevel={riskMap.get(member.publicKey)} />
                  <span className="flex-1 truncate text-sm">
                    {member.nickname || member.publicKey.slice(0, 12) + '...'}
                  </span>
                  <span className="text-xs text-accent">{'>'}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 多人群組通話按鈕 (Phase 10) */}
        <button
          onClick={() => setShowGroupCallUI(true)}
          disabled={
            callState !== CallState.IDLE ||
            groupCallState !== GroupCallState.IDLE ||
            otherMembers.length === 0
          }
          className={`rounded-full p-2.5 transition-colors ${
            callState !== CallState.IDLE ||
            groupCallState !== GroupCallState.IDLE ||
            otherMembers.length === 0
              ? 'cursor-not-allowed bg-surface-tertiary opacity-50'
              : 'bg-purple-500/20 hover:bg-purple-500/30'
          }`}
          title={t('group.groupCall')}
        >
          <svg
            className="h-5 w-5 text-purple-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
        </button>

        {/* 1-1 群組通話按鈕 */}
        <div className="relative" ref={callMenuRef}>
          <button
            onClick={() => setShowCallMembers(!showCallMembers)}
            disabled={callState !== CallState.IDLE || otherMembers.length === 0}
            className={`rounded-full p-2.5 transition-colors ${
              callState !== CallState.IDLE || otherMembers.length === 0
                ? 'cursor-not-allowed bg-surface-tertiary opacity-50'
                : 'bg-green-500/20 hover:bg-green-500/30'
            }`}
            title={t('group.personalCall')}
          >
            <svg
              className="h-5 w-5 text-green-400"
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

          {/* 選擇成員撥打 */}
          {showCallMembers && otherMembers.length > 0 && (
            <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-[var(--surface-border)] bg-surface-tertiary py-1 shadow-xl">
              <div className="border-b border-[var(--surface-border)] px-4 py-2">
                <p className="text-sm font-medium text-white">{t('group.selectMemberToCall')}</p>
                <p className="text-xs text-gray-500">{t('group.oneToOneVoiceCall')}</p>
              </div>
              {otherMembers.map((member) => (
                <button
                  key={member.publicKey}
                  onClick={() => handleStartCallToMember(member.publicKey, member.nickname)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-gray-300 hover:bg-gray-700"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-green-500 to-teal-500 text-sm">
                    {member.nickname?.charAt(0) || member.publicKey.slice(0, 2)}
                  </div>
                  <span className="flex-1 truncate">
                    {member.nickname || member.publicKey.slice(0, 12) + '...'}
                  </span>
                  <svg
                    className="h-5 w-5 text-green-400"
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
              ))}
            </div>
          )}
        </div>

        {/* 右上角選單 */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="rounded-full p-2 text-gray-400 hover:bg-surface-tertiary hover:text-on-surface-primary"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
              />
            </svg>
          </button>

          {/* 下拉選單 */}
          {showMenu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-[var(--surface-border)] bg-surface-secondary py-1 shadow-xl">
              {/* 邀請成員 */}
              <button
                onClick={() => {
                  setShowInvite(true);
                  setShowMenu(false);
                }}
                disabled={isFull}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
                <span>{t('group.inviteMembers')}</span>
                {isFull && <span className="text-xs text-on-surface-tertiary">{t('group.groupFull')}</span>}
              </button>

              {/* 建立子群組 */}
              <button
                onClick={() => {
                  setShowCreateSubgroup(true);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary"
              >
                <svg className="h-5 w-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <span>{t('group.createSubgroup')}</span>
              </button>

              <div className="my-1 border-t border-[var(--surface-border)]" />

              {/* 守護設定（僅守護群組的守護人可見） */}
              {guardian.menuItem(() => setShowMenu(false))}

              {/* 群組設定 */}
              <button
                onClick={() => {
                  setShowSettings(true);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-on-surface-primary hover:bg-surface-tertiary"
              >
                <svg className="h-5 w-5 text-on-surface-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>{t('group.settings')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 守護群組卡片區域 (Phase 19) */}
      {guardian.panel}

      {/* 群組金鑰狀態（狀態鏈）：等金鑰、或有人離開後等 admin 換金鑰 */}
      {currentGroup?.keyState && currentGroup.keyState !== 'ok' && (
        <div role="status" className="border-b border-[var(--surface-border)] bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
          {currentGroup.keyState === 'waiting-key' ? t('group.keyWaiting') : t('group.waitingAdminRekey')}
        </div>
      )}

      {/* 群組引擎的通知（邀請沒送到、變更暫停、被拒收） */}
      {engineNotice && (
        <div role="status" className="border-b border-[var(--surface-border)] bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
          {engineNotice}
        </div>
      )}

      {/* head 交叉比對（W2）：有成員報來的群組歷史跟我的對不上 */}
      {currentGroup?.logConflict && (
        <div role="alert" className="border-b border-[var(--surface-border)] bg-red-500/10 px-4 py-2 text-xs text-red-600 dark:text-red-400">
          {t('group.logConflict')}
        </div>
      )}

      {/* 訊息列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex justify-center"><ChatBubbleIcon size={40} className="text-gray-400" /></div>
            <p className="text-gray-400">{t('group.startConversation')}</p>
            <p className="mt-1 text-sm text-gray-500">
              {t('group.sendFirstMessage')}
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              // 取得發送者名稱
              const sender = members.find((m) => m.publicKey === msg.senderId);
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isOwn={msg.senderId === 'me'}
                  onDelete={() => deleteGroupMessage(msg.id)}
                  senderName={sender?.nickname}
                  onClickSender={msg.senderId !== 'me' && onNavigateToFriend ? () => onNavigateToFriend(msg.senderId) : undefined}
                  riskLevel={msg.senderId !== 'me' ? riskMap.get(msg.senderId) : undefined}
                  onRetry={msg.senderId === 'me' && msg.sendStatus === 'failed' && (msg.type === 'text' || msg.type === 'voice')
                    ? () => { void retryUnsent(msg.id); } : undefined}
                />
              );
            })}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* 輸入區 */}
      <div className="border-t border-gray-800 p-3">
        <div className="flex items-center gap-2">
          {/* TTL 選擇按鈕 */}
          <div className="relative" ref={ttlMenuRef}>
            <button
              onClick={() => setShowTTLMenu(!showTTLMenu)}
              className={`p-2 rounded-full transition-colors ${
                selectedTTL !== null
                  ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30'
                  : 'hover:bg-gray-700 text-gray-400'
              }`}
              title={t('group.messageTTL')}
            >
              <ChatBubbleIcon size={20} />
            </button>

            {/* TTL 選單 */}
            {showTTLMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-40 rounded-lg border border-[var(--surface-border)] bg-surface-tertiary shadow-xl overflow-hidden z-50">
                <div className="px-3 py-2 border-b border-[var(--surface-border)]">
                  <span className="text-xs text-gray-400">{t('group.messageTTL')}</span>
                </div>
                {TTL_OPTIONS.map((option) => {
                  const available = isOptionAvailable(option);
                  return (
                    <button
                      key={option.labelKey}
                      onClick={() => {
                        if (available) {
                          setSelectedTTL(option.value);
                          setShowTTLMenu(false);
                        }
                      }}
                      disabled={!available}
                      className={`w-full px-3 py-2 flex items-center gap-2 text-sm transition-colors ${
                        !available
                          ? 'text-gray-600 cursor-not-allowed'
                          : selectedTTL === option.value
                            ? 'bg-teal-500/20 text-teal-400'
                            : 'text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      <ChatBubbleIcon size={16} className="shrink-0" />
                      <span>{t(option.labelKey)}</span>
                      {!available && (
                        <LockIcon size={12} className="ml-auto text-gray-600" />
                      )}
                      {available && selectedTTL === option.value && (
                        <CheckIcon size={14} className="ml-auto text-teal-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 檔案傳送按鈕 (Phase 10) */}
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
            accept="*/*"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className={`p-2 rounded-full transition-colors ${
              isUploading
                ? 'opacity-50 cursor-not-allowed bg-surface-tertiary'
                : 'hover:bg-gray-700 text-gray-400'
            }`}
            title={t('group.sendFile')}
          >
            {isUploading ? <HourglassIcon size={20} /> : <PaperclipIcon size={20} />}
          </button>

          {/* 輸入框 */}
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('group.typeMessage')}
              rows={1}
              className="w-full resize-none rounded-xl border border-[var(--surface-border)] bg-surface-tertiary px-4 py-2.5 text-on-surface-primary placeholder:text-on-surface-tertiary focus:border-[var(--accent)] focus:outline-none"
              style={{
                minHeight: '44px',
                maxHeight: '120px',
              }}
            />
            {/* TTL 指示器 */}
            {selectedTTL !== null && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">
                {t(getCurrentTTLOption().labelKey)}
              </div>
            )}
          </div>

          {/* 語音按鈕（無文字時顯示） */}
          {!inputText.trim() && sendVoiceMessage && (
            <VoiceRecordButton onRecordComplete={(result: VoiceRecordingResult) => sendVoiceMessage(result)} />
          )}

          {/* 發送按鈕（有文字時顯示） */}
          {inputText.trim() && (
            <button
              onClick={handleSend}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent)] text-white hover:opacity-90 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 群組設定 Modal */}
      <GroupSettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onCreateSubgroup={() => {
          setShowSettings(false);
          setShowCreateSubgroup(true);
        }}
      />

      {/* 邀請成員 Modal */}
      <InviteMemberModal
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
      />

      {/* 建立群組 Modal */}
      <CreateGroupModal
        isOpen={showCreateSubgroup}
        onClose={() => setShowCreateSubgroup(false)}
      />

      {/* 多人群組通話 UI (Phase 10) */}
      {currentGroup && (
        <GroupCallUI
          groupId={currentGroup.id}
          groupName={currentGroup.name}
          isOpen={showGroupCallUI || hasIncomingCall}
          onClose={() => setShowGroupCallUI(false)}
        />
      )}

      {/* 1-1 來電提示和通話 UI 由全域的 GlobalVoiceCallUI 處理 */}

      {/* 守護群組設定 Modal (Phase 19) */}
      {guardian.modal}

      {/* L2 詐騙警告彈窗（鏡像 1-1 ChatRoom，封鎖/檢舉對象 = 該訊息發送成員） */}
      {scamAlert.riskResult && (
        <ScamAlertModal
          isOpen={scamAlert.isOpen}
          onClose={() => setScamAlert({ isOpen: false, riskResult: null, messageContent: '' })}
          riskResult={scamAlert.riskResult}
          messageContent={scamAlert.messageContent}
          onBlockUser={scamAlert.senderPubkey ? () => {
            const pk = scamAlert.senderPubkey!;
            const name = currentGroup?.members.find((m) => m.publicKey === pk)?.nickname
              || friendNameByPubkey.get(pk)
              || pk.slice(0, 8);
            import('../../services/localBlacklist').then(({ addToBlacklistManual }) => {
              addToBlacklistManual(pk, name, 'Blocked from group scam alert').then(() => {
                devLog('[GroupChatWindow] Member blocked from ScamAlert:', name);
              }).catch((err) => console.error('[GroupChatWindow] Block failed:', err));
            });
          } : undefined}
          onReportAndBlock={scamAlert.senderPubkey ? () => {
            const pk = scamAlert.senderPubkey!;
            const name = currentGroup?.members.find((m) => m.publicKey === pk)?.nickname
              || friendNameByPubkey.get(pk)
              || pk.slice(0, 8);
            import('../../services/localBlacklist').then(({ addToBlacklistByComplaint }) => {
              addToBlacklistByComplaint({
                pubkey: pk,
                nickname: name,
                type: 'scam',
                notes: scamAlert.messageContent || 'AI detected scam content',
              }).then(() => {
                devLog('[GroupChatWindow] Member reported+blocked from ScamAlert:', name);
              }).catch((err) => console.error('[GroupChatWindow] Report+block failed:', err));
            });
          } : undefined}
        />
      )}
    </div>
  );
}

export default GroupChatWindow;

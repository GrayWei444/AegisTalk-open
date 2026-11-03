import { devLog } from '../../utils/devLog';

/**
 * Phase 14: 轉發 Modal（LINE 風格全螢幕選擇）
 *
 * 選擇好友或群組進行檔案/訊息轉發
 * - 發送後訊息會儲存到本地聊天紀錄
 * - 大檔案傳送時顯示 LINE 風格進度條
 */

import { useState, useEffect, useCallback } from 'react';
import { getFileIcon, type SharedFile } from '../../services/fileShare';
import { getAllContacts, getAllGroups, type Contact as StorageContact, type StoredGroup } from '../../services/storage';
import * as storage from '../../services/storage';
import { useApp } from '../../providers/AppProvider';
import { sendViaP2P } from '../../services/p2pSend';
import type { RatchetMessage } from '../../services/crypto';
import { generateId } from '../../utils/secureId';
import { useChatStore } from '../../stores/chatStore';
import { useGroupChat } from '../../hooks/useGroupChat';

interface ForwardModalProps {
  /** 要轉發的檔案 */
  files?: SharedFile[];
  /** 要轉發的文字 */
  text?: string;
  /** 要轉發的連結 */
  url?: string;
  /** 要轉發的訊息 (從聊天室轉發) */
  messageContent?: string;
  /** 關閉 Modal */
  onClose: () => void;
  /** 轉發完成 */
  onComplete: () => void;
}

type TargetType = 'friend' | 'group';

interface ForwardTarget {
  id: string;
  name: string;
  avatar?: string;
  type: TargetType;
}

/** 傳送進度狀態 */
interface SendProgress {
  currentTarget: string;
  currentFile: string;
  current: number;
  total: number;
  phase: 'encrypting' | 'sending' | 'done';
}

/** 格式化檔案大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ForwardModal({
  files = [],
  text,
  url,
  messageContent,
  onClose,
  onComplete,
}: ForwardModalProps) {
  const [targets, setTargets] = useState<ForwardTarget[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [activeTab, setActiveTab] = useState<TargetType>('friend');
  const { encryptMessage, publicKey } = useApp();
  const { forwardToGroup } = useGroupChat();

  // 載入好友 + 群組
  useEffect(() => {
    async function loadTargets() {
      try {
        const [allContacts, allGroups] = await Promise.all([
          getAllContacts(),
          getAllGroups(),
        ]);

        const friendTargets: ForwardTarget[] = allContacts.map((c: StorageContact) => ({
          id: c.pubkey,
          name: c.nickname || c.pubkey.substring(0, 8),
          avatar: c.avatar,
          type: 'friend' as const,
        }));

        const groupTargets: ForwardTarget[] = allGroups
          .filter((g: StoredGroup) => g.name)
          .map((g: StoredGroup) => ({
            id: g.id,
            name: g.name,
            type: 'group' as const,
          }));

        setTargets([...friendTargets, ...groupTargets]);
      } catch (err) {
        devLog('[ForwardModal] Failed to load targets:', err);
      }
    }
    loadTargets();
  }, []);

  // 篩選（依當前 tab）
  const filteredTargets = targets.filter((t) => {
    const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSearch && t.type === activeTab;
  });

  const selectedTargets = targets.filter((t) => selectedIds.includes(t.id));

  const toggleTarget = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const removeSelected = (id: string) => {
    setSelectedIds((prev) => prev.filter((p) => p !== id));
  };

  /** 儲存已發送訊息到本地（chatStore + SQLite） */
  const saveMessageLocally = useCallback(async (
    targetPubkey: string,
    messageId: string,
    content: string,
    type: 'text' | 'file',
    fileData?: { name: string; mimeType: string; size: number },
  ) => {
    if (!publicKey) return;

    const timestamp = Date.now();
    const store = useChatStore.getState();

    // 更新 Zustand store 中的訊息列表
    const currentMessages = store.messages[targetPubkey] || [];
    const newMessage = {
      id: messageId,
      senderId: 'me' as const,
      content,
      timestamp,
      type,
      isRead: true,
      isBurned: false,
      ...(type === 'file' && fileData ? { fileData } : {}),
    };

    useChatStore.setState({
      messages: {
        ...store.messages,
        [targetPubkey]: [...currentMessages, newMessage],
      },
    });

    // 更新好友的最後訊息顯示
    const lastMessageText = type === 'file' ? '檔案' : content.slice(0, 50);
    useChatStore.setState({
      friends: useChatStore.getState().friends.map((f) =>
        f.id === targetPubkey
          ? { ...f, lastMessage: lastMessageText, lastMessageTime: timestamp }
          : f
      ),
    });

    // 持久化到 SQLite
    if (storage.isInitialized()) {
      const conversationId = storage.getConversationIdForPeer(targetPubkey);
      const metadata = type === 'file' && fileData
        ? JSON.stringify({ fileData })
        : undefined;
      await storage.saveMessage({
        id: messageId,
        conversationId,
        senderPubkey: publicKey,
        content,
        type,
        createdAt: timestamp,
        ttl: 0,
        expiresAt: null,
        readAt: timestamp,
        isOutgoing: true,
        status: 'sent',
        metadata,
      });
    }
  }, [publicKey]);

  // 發送加密訊息（P2P 優先 + 本地儲存）
  const sendMessageToUser = useCallback(async (
    targetPubkey: string,
    content: string,
    type: 'text' | 'file' = 'text',
    fileData?: { name: string; mimeType: string; size: number },
  ) => {
    if (!publicKey || !encryptMessage) {
      throw new Error('Encryption not ready');
    }

    const messageId = generateId('msg');
    const messageData = {
      id: messageId,
      content,
      type,
      timestamp: Date.now(),
      ...(type === 'file' && fileData ? { fileData } : {}),
    };

    // 加密
    const encrypted = await encryptMessage(targetPubkey, JSON.stringify(messageData)) as RatchetMessage;
    const serializedMessage = encrypted.toJson();

    // P2P-only transport
    const p2pPayload = JSON.stringify({ type: 'encrypted_message', payload: serializedMessage });
    sendViaP2P(targetPubkey, p2pPayload, { messageId, plaintext: JSON.stringify(messageData) });   // 等回條（群星 B33）

    // 儲存到本地聊天紀錄
    await saveMessageLocally(targetPubkey, messageId, content, type, fileData);

    devLog('[ForwardModal] Sent to:', targetPubkey.substring(0, 8), '(P2P)');
  }, [publicKey, encryptMessage, saveMessageLocally]);

  // 執行轉發（支援好友 + 群組）
  const handleForward = async () => {
    if (selectedIds.length === 0) return;

    setSending(true);

    // 計算總項目數
    const hasTextContent = !!(text || url || messageContent);
    const totalPerTarget = (hasTextContent ? 1 : 0) + files.length;
    const total = selectedTargets.length * totalPerTarget;
    let current = 0;

    try {
      for (const target of selectedTargets) {
        // 發送文字內容
        if (hasTextContent) {
          const content = messageContent || [text, url].filter(Boolean).join('\n');
          setProgress({
            currentTarget: target.name,
            currentFile: '文字訊息',
            current,
            total,
            phase: 'encrypting',
          });

          if (target.type === 'group') {
            await forwardToGroup(target.id, content, 'text');
          } else {
            await sendMessageToUser(target.id, content);
          }
          current++;
          setProgress({
            currentTarget: target.name,
            currentFile: '文字訊息',
            current,
            total,
            phase: 'sending',
          });
        }

        // 發送檔案
        for (const file of files) {
          setProgress({
            currentTarget: target.name,
            currentFile: file.name,
            current,
            total,
            phase: 'encrypting',
          });

          try {
            if (target.type === 'group') {
              await forwardToGroup(target.id, file.dataUrl, 'file', {
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
              });
            } else {
              await sendMessageToUser(target.id, file.dataUrl, 'file', {
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
              });
            }
          } catch (err) {
            devLog(`[ForwardModal] Failed to forward: ${file.name}`, err);
          }
          current++;
          setProgress({
            currentTarget: target.name,
            currentFile: file.name,
            current,
            total,
            phase: 'sending',
          });
        }
      }

      // 完成動畫
      setProgress({
        currentTarget: '',
        currentFile: '',
        current: total,
        total,
        phase: 'done',
      });

      // 短暫顯示完成狀態
      await new Promise((r) => setTimeout(r, 600));
      onComplete();
    } catch (err) {
      devLog('[ForwardModal] Forward failed:', err);
      setSending(false);
      setProgress(null);
    }
  };

  const getAvatarDisplay = (target: ForwardTarget, size = 'w-11 h-11') => {
    if (target.avatar) {
      return (
        <img src={target.avatar} alt={target.name} className={`${size} rounded-full object-cover`} />
      );
    }
    const isGroup = target.type === 'group';
    return (
      <div className={`${size} rounded-full flex items-center justify-center text-white font-semibold ${
        isGroup ? 'bg-gradient-to-br from-emerald-500 to-emerald-700' : 'bg-gradient-to-br from-mist-500 to-mist-700'
      }`}>
        {isGroup ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        ) : (
          target.name.charAt(0).toUpperCase()
        )}
      </div>
    );
  };

  const friendCount = targets.filter((t) => t.type === 'friend').length;
  const groupCount = targets.filter((t) => t.type === 'group').length;

  // 計算總檔案大小（用於顯示）
  const totalFileSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="fixed inset-0 z-50 bg-surface-primary flex flex-col safe-area-top">
      {/* LINE 風格傳送進度覆蓋層 */}
      {sending && progress && (
        <div className="absolute inset-0 z-60 bg-black/70 flex items-center justify-center">
          <div className="bg-surface-secondary rounded-2xl p-6 mx-8 w-full max-w-sm shadow-xl">
            {progress.phase === 'done' ? (
              /* 完成狀態 */
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-on-surface-primary font-medium">傳送完成</p>
              </div>
            ) : (
              /* 傳送中 */
              <div className="flex flex-col gap-4">
                {/* 標題 */}
                <div className="text-center">
                  <p className="text-on-surface-primary font-medium text-base">傳送中...</p>
                  <p className="text-on-surface-tertiary text-xs mt-1">
                    {progress.currentTarget}
                  </p>
                </div>

                {/* 當前檔案名稱 */}
                <div className="flex items-center gap-2 bg-surface-elevated rounded-lg px-3 py-2">
                  {files.length > 0 && (
                    <span className="text-base">{getFileIcon(files[0]?.mimeType || '')}</span>
                  )}
                  <span className="text-on-surface-secondary text-sm truncate flex-1">
                    {progress.currentFile}
                  </span>
                  {totalFileSize > 0 && (
                    <span className="text-on-surface-tertiary text-xs flex-shrink-0">
                      {formatFileSize(totalFileSize)}
                    </span>
                  )}
                </div>

                {/* 進度條 */}
                <div>
                  <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-mist-500 to-mist-400 rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between mt-1.5">
                    <span className="text-on-surface-tertiary text-xs">
                      {progress.phase === 'encrypting' ? '加密中...' : '傳送中...'}
                    </span>
                    <span className="text-on-surface-tertiary text-xs">
                      {progress.current}/{progress.total}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 頂部標題列 */}
      <header className="flex-shrink-0 bg-surface-secondary border-b border-[var(--surface-border)] px-4 py-3 flex items-center justify-between">
        <button
          onClick={onClose}
          disabled={sending}
          className="p-1 text-on-surface-secondary hover:text-on-surface-primary transition-colors disabled:opacity-50"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <h2 className="text-on-surface-primary font-semibold text-lg">傳送給...</h2>

        <button
          onClick={handleForward}
          disabled={selectedIds.length === 0 || sending}
          className="px-5 py-1.5 bg-mist-500 hover:bg-mist-600 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-40"
        >
          傳送
        </button>
      </header>

      {/* 搜尋框 */}
      <div className="flex-shrink-0 px-4 py-2 bg-surface-primary">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-tertiary"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜尋..."
            className="w-full pl-9 pr-4 py-2 bg-surface-elevated text-white placeholder:text-on-surface-tertiary rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-mist-500/50"
          />
        </div>
      </div>

      {/* 已選擇的聯絡人（chips） */}
      {selectedTargets.length > 0 && (
        <div className="flex-shrink-0 px-4 py-2 border-b border-[var(--surface-border)] bg-surface-primary">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {selectedTargets.map((target) => (
              <button
                key={target.id}
                onClick={() => removeSelected(target.id)}
                className="flex-shrink-0 flex items-center gap-1.5 bg-mist-500/20 border border-mist-500/30 rounded-full pl-1 pr-2.5 py-1"
              >
                {getAvatarDisplay(target, 'w-6 h-6 text-xs')}
                <span className="text-mist-300 text-xs whitespace-nowrap">{target.name}</span>
                <svg className="w-3.5 h-3.5 text-mist-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tab 標題：好友 / 群組 */}
      <div className="flex-shrink-0 flex border-b border-[var(--surface-border)] bg-surface-primary">
        <button
          onClick={() => setActiveTab('friend')}
          disabled={sending}
          className={`flex-1 py-2.5 text-sm font-medium relative text-center transition-colors ${
            activeTab === 'friend' ? 'text-mist-400' : 'text-on-surface-tertiary'
          }`}
        >
          好友 ({friendCount})
          {activeTab === 'friend' && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-mist-500 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('group')}
          disabled={sending}
          className={`flex-1 py-2.5 text-sm font-medium relative text-center transition-colors ${
            activeTab === 'group' ? 'text-mist-400' : 'text-on-surface-tertiary'
          }`}
        >
          群組 ({groupCount})
          {activeTab === 'group' && (
            <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-mist-500 rounded-full" />
          )}
        </button>
      </div>

      {/* 聯絡人/群組列表 */}
      <div className="flex-1 overflow-auto">
        {filteredTargets.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-on-surface-tertiary text-sm">
              {searchQuery
                ? '找不到符合的結果'
                : activeTab === 'group'
                  ? '尚無群組'
                  : '尚無好友'}
            </p>
          </div>
        ) : (
          <div>
            {filteredTargets.map((target) => {
              const isSelected = selectedIds.includes(target.id);
              return (
                <div
                  key={target.id}
                  className={`px-4 py-3 flex items-center gap-3 cursor-pointer active:bg-surface-elevated transition-colors ${
                    isSelected ? 'bg-mist-500/5' : ''
                  }`}
                  onClick={() => !sending && toggleTarget(target.id)}
                >
                  {/* 頭像 */}
                  {getAvatarDisplay(target)}

                  {/* 名稱 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-on-surface-primary truncate">{target.name}</p>
                  </div>

                  {/* 勾選 */}
                  <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                    isSelected
                      ? 'bg-mist-500 border-mist-500 scale-100'
                      : 'border-on-surface-tertiary/40 scale-95'
                  }`}>
                    {isSelected && (
                      <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部：轉發內容預覽 */}
      <div className="flex-shrink-0 border-t border-[var(--surface-border)] bg-surface-secondary px-4 py-3">
        <div className="flex items-center gap-2 overflow-x-auto">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex-shrink-0 flex items-center gap-1.5 bg-surface-elevated px-2.5 py-1.5 rounded-lg text-xs"
            >
              <span>{getFileIcon(file.mimeType)}</span>
              <span className="text-on-surface-secondary truncate max-w-[100px]">{file.name}</span>
              <span className="text-on-surface-tertiary">({formatFileSize(file.size)})</span>
            </div>
          ))}
          {(text || messageContent) && (
            <div className="flex-shrink-0 bg-surface-elevated px-2.5 py-1.5 rounded-lg text-xs text-on-surface-secondary truncate max-w-[150px]">
              {messageContent || text}
            </div>
          )}
          {url && (
            <div className="flex-shrink-0 bg-surface-elevated px-2.5 py-1.5 rounded-lg text-xs text-mist-400 truncate max-w-[150px]">
              {url}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ForwardModal;

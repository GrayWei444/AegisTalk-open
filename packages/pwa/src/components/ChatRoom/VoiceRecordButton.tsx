/**
 * VoiceRecordButton - 語音錄製按鈕元件
 *
 * Phase 9: 支援長按錄音，顯示錄音時長和音量波形
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { voiceMessageService, formatDuration, type VoiceRecordingResult } from '../../services/voiceMessage';
import { useLanguage } from '../../i18n';

interface VoiceRecordButtonProps {
  /** 錄音完成回調 */
  onRecordComplete: (result: VoiceRecordingResult) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

type RecordState = 'idle' | 'recording' | 'processing';

export function VoiceRecordButton({ onRecordComplete, disabled }: VoiceRecordButtonProps) {
  const { t } = useLanguage();
  const [state, setState] = useState<RecordState>('idle');
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0);
  const longPressTimer = useRef<number | null>(null);
  const isRecording = useRef(false);

  // 設定回調
  useEffect(() => {
    voiceMessageService.setStateCallback(setState);
    voiceMessageService.setDurationCallback(setDuration);
    voiceMessageService.setVolumeCallback(setVolume);

    return () => {
      voiceMessageService.setStateCallback(() => {});
      voiceMessageService.setDurationCallback(() => {});
      voiceMessageService.setVolumeCallback(() => {});
    };
  }, []);

  // 開始錄音
  const startRecording = useCallback(async () => {
    if (disabled || isRecording.current) return;

    try {
      isRecording.current = true;
      await voiceMessageService.startRecording();
    } catch (err) {
      console.error('[VoiceRecordButton] Failed to start recording:', err);
      isRecording.current = false;
      setState('idle');
    }
  }, [disabled]);

  // 停止錄音
  const stopRecording = useCallback(async () => {
    if (!isRecording.current) return;

    try {
      const result = await voiceMessageService.stopRecording();
      if (result && result.duration >= 0.5) {
        // 至少 0.5 秒才有效
        onRecordComplete(result);
      }
    } catch (err) {
      console.error('[VoiceRecordButton] Failed to stop recording:', err);
    } finally {
      isRecording.current = false;
    }
  }, [onRecordComplete]);

  // 取消錄音（保留給未來使用）
  const _cancelRecording = useCallback(() => {
    if (isRecording.current) {
      voiceMessageService.cancelRecording();
      isRecording.current = false;
    }
  }, []);
  void _cancelRecording; // 避免 unused warning

  // 點擊切換錄音狀態
  const handleClick = useCallback(async () => {
    if (disabled) return;

    if (isRecording.current) {
      // 正在錄音，點擊停止
      await stopRecording();
    } else {
      // 沒有錄音，點擊開始
      await startRecording();
    }
  }, [disabled, startRecording, stopRecording]);

  // 長按開始（保留給桌面端）
  const handlePointerDown = useCallback(() => {
    if (disabled || isRecording.current) return;

    // 設定 500ms 後開始錄音（長按觸發）
    longPressTimer.current = window.setTimeout(() => {
      startRecording();
    }, 500);
  }, [disabled, startRecording]);

  // 長按結束
  const handlePointerUp = useCallback(() => {
    // 清除長按計時器
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }

    // 如果是長按錄音模式，停止錄音
    if (isRecording.current && duration >= 0.3) {
      stopRecording();
    }
  }, [stopRecording, duration]);

  // 取消（離開按鈕）
  const handlePointerLeave = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // 計算波形條的高度
  const getWaveBarHeight = (baseVolume: number) => {
    const minHeight = 8;
    const maxHeight = 24;
    return minHeight + baseVolume * (maxHeight - minHeight);
  };

  // 渲染波形
  const renderWaveform = () => {
    const bars = 5;
    return (
      <div className="flex items-center gap-0.5 h-6">
        {Array.from({ length: bars }).map((_, i) => {
          // 添加一些隨機性使波形更生動
          const randomFactor = 0.7 + Math.random() * 0.3;
          const barVolume = volume * randomFactor;
          const height = getWaveBarHeight(barVolume);

          return (
            <div
              key={i}
              className="w-1 bg-white rounded-full transition-all duration-75"
              style={{ height: `${height}px` }}
            />
          );
        })}
      </div>
    );
  };

  // 處理中狀態
  if (state === 'processing') {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-surface-elevated text-white rounded-full">
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">{t('common.processing')}</span>
      </div>
    );
  }

  // 錄音中狀態
  if (state === 'recording') {
    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-3 px-4 py-2 bg-red-500 text-white rounded-full animate-pulse cursor-pointer"
      >
        {/* 紅點指示器 */}
        <div className="w-3 h-3 bg-white rounded-full animate-pulse" />

        {/* 波形 */}
        {renderWaveform()}

        {/* 時長 */}
        <span className="text-sm font-medium min-w-[40px]">{formatDuration(duration)}</span>

        {/* 提示 */}
        <span className="text-xs opacity-80">{t('voiceMessage.tapToSend')}</span>
      </button>
    );
  }

  // 空閒狀態
  return (
    <button
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      disabled={disabled}
      className={`
        p-2 rounded-full transition-all select-none
        ${disabled
          ? 'bg-gray-300 text-on-surface-tertiary cursor-not-allowed'
          : 'hover:bg-surface-tertiary text-on-surface-secondary active:bg-red-500 active:text-white active:scale-110'
        }
      `}
      title={t('voiceMessage.recordHint')}
    >
      <svg
        className="w-5 h-5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
        />
      </svg>
    </button>
  );
}

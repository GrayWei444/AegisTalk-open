import { devLog, devWarn } from '../../utils/devLog';
import { ShieldIcon } from '../common/icons';

/**
 * VoiceMessageBubble - 語音訊息氣泡元件
 *
 * Phase 9: 顯示語音訊息，支援播放、波形動畫
 * 接收端語音轉文字：點擊播放時進行語音辨識，轉完後 L2 評估
 * 設計風格：類似 LINE 的簡潔設計
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { voiceMessageService, formatDuration } from '../../services/voiceMessage';
import { ext } from '@ext';
import type { RiskResult } from '../../types';

interface VoiceMessageBubbleProps {
  /** Base64 編碼的音訊數據 */
  audioData: string;
  /** 音訊時長（秒） */
  duration: number;
  /** MIME 類型 */
  mimeType?: string;
  /** 波形數據 */
  waveform?: number[];
  /** 是否為自己發送的訊息 */
  isMine: boolean;
  /** 語音轉文字結果（從發送端傳來，可能為空） */
  transcript?: string;
  /** L2 風險警告回調 */
  onRiskDetected?: (riskResult: RiskResult, transcript: string) => void;
}

type PlayState = 'idle' | 'loading' | 'playing' | 'paused';
type TranscribeState = 'idle' | 'transcribing' | 'done' | 'error';

export function VoiceMessageBubble({
  audioData,
  duration,
  mimeType = 'audio/webm',
  waveform = [],
  isMine,
  transcript: initialTranscript,
  onRiskDetected,
}: VoiceMessageBubbleProps) {
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [currentTime, setCurrentTime] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);

  // 接收端語音轉文字狀態
  const [transcribeState, setTranscribeState] = useState<TranscribeState>(
    initialTranscript ? 'done' : 'idle'
  );
  const [localTranscript, setLocalTranscript] = useState<string | undefined>(initialTranscript);
  const [hasEvaluatedRisk, setHasEvaluatedRisk] = useState(false);
  const [voiceRiskLevel, setVoiceRiskLevel] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const progressInterval = useRef<number | null>(null);
  const transcriptBuffer = useRef<string>('');

  // 清理音訊資源
  const cleanup = useCallback(() => {
    if (progressInterval.current) {
      clearInterval(progressInterval.current);
      progressInterval.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      voiceMessageService.revokePlaybackUrl(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // 元件卸載時清理
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  // L2 風險評估
  const evaluateRisk = useCallback((text: string) => {
    // 防詐規則引擎（官方版才有；社群版 isReady 永遠 false → 不評估）
    const engine = ext.antiFraud.text;
    if (!engine.isReady() || hasEvaluatedRisk || isMine) return;

    try {
      // 簡體轉繁體（確保能匹配繁體規則）
      const traditionalText = engine.normalize(text);
      devLog('[VoiceMessageBubble] L2 evaluating:', traditionalText);

      const riskResult = engine.quickEvaluate(traditionalText);
      setHasEvaluatedRisk(true);

      if (riskResult.riskLevel !== 'safe' && riskResult.riskLevel !== 'low') {
        console.error('[VoiceMessageBubble] Risk detected:', riskResult.riskLevel);
        setVoiceRiskLevel(riskResult.riskLevel);
        onRiskDetected?.(riskResult, traditionalText);
      }
    } catch (e) {
      devWarn('[VoiceMessageBubble] L2 evaluation failed:', e);
    }
  }, [hasEvaluatedRisk, isMine, onRiskDetected]);

  // 接收端語音轉文字
  const transcribeAudio = useCallback(async () => {
    devLog('[VoiceMessageBubble] transcribeAudio called', {
      isMine,
      localTranscript,
      transcribeState,
    });

    // 只有接收的訊息才需要轉文字
    if (isMine || localTranscript || transcribeState !== 'idle') {
      devLog('[VoiceMessageBubble] Skipping transcription:', {
        isMine,
        hasLocalTranscript: !!localTranscript,
        transcribeState,
      });
      return;
    }

    // 裝置上的語音辨識（官方版才有；社群版沒有 → 不轉文字）
    const speechRecognition = ext.antiFraud.speech;
    if (!speechRecognition) return;

    // 檢查語音辨識是否可用
    console.error('[VoiceMessageBubble] Speech status:', speechRecognition.getStatus());
    if (!speechRecognition.isReady()) {
      console.error('[VoiceMessageBubble] Not ready, initializing...');
      try {
        await speechRecognition.initialize();
        console.error('[VoiceMessageBubble] Initialized OK, status:', speechRecognition.getStatus());
      } catch (e) {
        console.error('[VoiceMessageBubble] Init failed:', e);
        setTranscribeState('error');
        return;
      }
    }

    setTranscribeState('transcribing');
    transcriptBuffer.current = '';

    try {
      // 將 Base64 轉為 AudioBuffer
      const blob = base64ToBlob(audioData, mimeType);
      const arrayBuffer = await blob.arrayBuffer();

      // 建立 AudioContext 並解碼
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // 取得單聲道音訊數據
      const channelData = audioBuffer.getChannelData(0);

      // 如果取樣率不是 16kHz，需要重新取樣
      let samples: Float32Array;
      if (audioBuffer.sampleRate !== 16000) {
        samples = resampleTo16kHz(channelData, audioBuffer.sampleRate);
      } else {
        samples = channelData;
      }

      // 使用 Paraformer 串流辨識 API
      console.error('[VoiceMessageBubble] Recognizing audio, samples:', samples.length);
      const result = speechRecognition.recognizeAudio(samples);

      // 清理 AudioContext
      await audioContext.close();

      // 取得最終結果
      let finalTranscript = result?.text?.trim() || '';
      console.error('[VoiceMessageBubble] Transcription complete:', finalTranscript || '(empty)');

      if (finalTranscript) {
        // recognizeAudio 已依 i18n 語系轉好字形（zh-TW→繁、zh-CN→簡）→ 顯示直接用，不再強制轉繁
        //   （否則 zh-CN 使用者字幕會被誤轉繁）。detection 端在 evaluateRisk 內另做正規化比對。
        setLocalTranscript(finalTranscript);
        setTranscribeState('done');

        // 進行 L2 風險評估（evaluateRisk 內部先把簡體轉成繁體 → detection 仍正規化成繁體）
        evaluateRisk(finalTranscript);
      } else {
        setTranscribeState('done');
      }
    } catch (e) {
      console.error('[VoiceMessageBubble] Transcription failed:', e);
      setTranscribeState('error');
    }
  }, [isMine, localTranscript, transcribeState, audioData, mimeType, evaluateRisk]);

  // 播放/暫停切換
  const togglePlay = useCallback(async () => {
    if (playState === 'loading') return;

    // 暫停當前播放
    if (playState === 'playing' && audioRef.current) {
      audioRef.current.pause();
      setPlayState('paused');
      return;
    }

    // 繼續播放
    if (playState === 'paused' && audioRef.current) {
      audioRef.current.play();
      setPlayState('playing');
      return;
    }

    // 開始新的播放
    try {
      setPlayState('loading');

      // 建立播放 URL
      urlRef.current = voiceMessageService.createPlaybackUrl(audioData, mimeType);
      const audio = new Audio(urlRef.current);
      audioRef.current = audio;

      // 監聽事件
      audio.onended = () => {
        setPlayState('idle');
        setCurrentTime(0);
        cleanup();
      };

      audio.onerror = (e) => {
        console.error('[VoiceMessageBubble] Audio error:', e);
        setPlayState('idle');
        cleanup();
      };

      // 開始播放
      await audio.play();
      setPlayState('playing');

      // 更新進度
      progressInterval.current = window.setInterval(() => {
        if (audio && !audio.paused) {
          setCurrentTime(audio.currentTime);
        }
      }, 100);

      // 接收端：開始播放時觸發語音轉文字（只做一次）
      devLog('[VoiceMessageBubble] Play started, checking transcription trigger:', {
        isMine,
        localTranscript,
        transcribeState,
        shouldTranscribe: !isMine && !localTranscript && transcribeState === 'idle',
      });
      if (!isMine && !localTranscript && transcribeState === 'idle') {
        devLog('[VoiceMessageBubble] Triggering transcription...');
        transcribeAudio();
      }
    } catch (err) {
      console.error('[VoiceMessageBubble] Failed to play:', err);
      setPlayState('idle');
      cleanup();
    }
  }, [playState, audioData, mimeType, cleanup, isMine, localTranscript, transcribeState, transcribeAudio]);

  // 計算播放進度百分比
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 渲染簡化波形 (類似 LINE 風格，只有幾條線)
  const renderWaveform = () => {
    // 簡化為 15 條波形線
    const barCount = 15;
    const bars = waveform.length > 0
      ? waveform.slice(0, barCount)
      : Array.from({ length: barCount }, () => Math.random() * 0.5 + 0.3);

    return (
      <div className="flex items-center gap-[2px] h-5">
        {bars.map((value, i) => {
          const barProgress = (i / bars.length) * 100;
          const isPlayed = barProgress <= progress;
          const height = Math.max(4, value * 16);

          return (
            <div
              key={i}
              className={`w-[2px] rounded-full transition-colors duration-100 ${
                isPlayed
                  ? isMine
                    ? 'bg-white'
                    : 'bg-mist-500'
                  : isMine
                    ? 'bg-white/40'
                    : 'bg-gray-400'
              }`}
              style={{ height: `${height}px` }}
            />
          );
        })}
      </div>
    );
  };

  // 播放按鈕圖示
  const renderPlayButton = () => {
    if (playState === 'loading') {
      return (
        <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      );
    }

    if (playState === 'playing') {
      return (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
        </svg>
      );
    }

    return (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z" />
      </svg>
    );
  };

  // 渲染轉文字狀態
  const renderTranscriptSection = () => {
    // 自己發的訊息不需要轉文字
    if (isMine) return null;

    // 有轉文字結果
    if (localTranscript) {
      return (
        <div className="flex flex-col gap-1 items-start">
          <button
            onClick={() => setShowTranscript(!showTranscript)}
            className="text-xs text-on-surface-secondary hover:text-mist-500 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            {showTranscript ? '隱藏' : '文字'}
          </button>

          {showTranscript && (
            <div className="text-xs px-2 py-1 rounded-lg max-w-[200px] bg-surface-secondary text-on-surface-secondary">
              {localTranscript}
            </div>
          )}
        </div>
      );
    }

    // 正在轉文字
    if (transcribeState === 'transcribing') {
      return (
        <div className="flex items-center gap-1 text-xs text-on-surface-tertiary">
          <div className="w-2 h-2 border border-gray-400 border-t-transparent rounded-full animate-spin" />
          <span>辨識中...</span>
        </div>
      );
    }

    // 轉文字失敗
    if (transcribeState === 'error') {
      return (
        <div className="text-xs text-red-400">
          辨識失敗
        </div>
      );
    }

    // 尚未開始（提示點擊播放）
    return (
      <div className="text-xs text-on-surface-tertiary">
        點擊播放以辨識文字
      </div>
    );
  };

  const isRisky = !!voiceRiskLevel;

  return (
    <div className="flex flex-col gap-1">
      {/* 主要氣泡 */}
      <div
        onClick={togglePlay}
        className={`
          flex items-center gap-2 px-3 py-2 rounded-2xl cursor-pointer
          ${isRisky
            ? 'bg-red-100 dark:bg-red-900/30 text-red-900 dark:text-red-200 rounded-bl-md ring-2 ring-red-500/60'
            : isMine
              ? 'bg-mist-500 text-white rounded-br-md'
              : 'bg-gray-200 dark:bg-surface-secondary text-on-surface-primary rounded-bl-md'
          }
        `}
      >
        {/* 播放按鈕 */}
        <div
          className={`
            flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors
            ${isMine
              ? 'bg-white/20 hover:bg-white/30'
              : 'bg-mist-500/20 hover:bg-mist-500/30 text-mist-500'
            }
          `}
        >
          {renderPlayButton()}
        </div>

        {/* 波形 */}
        {renderWaveform()}

        {/* 時長 */}
        <span className="text-xs opacity-80 min-w-[32px] text-right">
          {formatDuration(playState === 'playing' || playState === 'paused' ? currentTime : duration)}
        </span>
      </div>

      {/* 語音風險警告標記 */}
      {isRisky && (
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400">
          <ShieldIcon size={12} className="shrink-0" />
          <span>
            {voiceRiskLevel === 'critical' ? '極高風險語音' :
             voiceRiskLevel === 'high' ? '高風險語音' :
             '可疑語音內容'}
          </span>
        </div>
      )}

      {/* 語音轉文字區域 */}
      {renderTranscriptSection()}
    </div>
  );
}

// 工具函數：Base64 轉 Blob
function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

// 工具函數：重新取樣到 16kHz
function resampleTo16kHz(samples: Float32Array, originalSampleRate: number): Float32Array {
  const ratio = originalSampleRate / 16000;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const fraction = srcIndex - srcIndexFloor;

    // 線性內插
    result[i] = samples[srcIndexFloor] * (1 - fraction) + samples[srcIndexCeil] * fraction;
  }

  return result;
}

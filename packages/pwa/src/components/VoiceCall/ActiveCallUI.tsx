/**
 * ActiveCallUI - 通話中介面
 * 包含回鈴音和連線音效
 * 支援視訊通話
 */

import { useEffect, useRef } from 'react';
import { CallState } from '../../services/voiceCall';
import { devWarn } from '../../utils/devLog';
import { PhoneIcon, PhoneOffIcon, VideoIcon, SmartphoneIcon } from '../common/icons';
import { useLanguage } from '../../i18n';

interface ActiveCallUIProps {
  peerName: string;
  peerAvatar?: string;
  callState: CallState;
  duration: number;
  isMuted: boolean;
  onMuteToggle: () => void;
  onEndCall: () => void;
  // Phase 5: 語音分析狀態
  isAnalyzing?: boolean;
  sliceCount?: number;
  // 視訊通話
  isVideoCall?: boolean;
  isVideoEnabled?: boolean;
  onVideoToggle?: () => void;
  localStream?: MediaStream | null;
  remoteStream?: MediaStream | null;
}

/**
 * 格式化通話時間
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * 取得狀態文字
 */
function getStateText(state: CallState, t: (key: string) => string): string {
  switch (state) {
    case CallState.REQUESTING:
      return t('call.dialing');
    case CallState.CONNECTING:
      return t('group.connecting');
    case CallState.CONNECTED:
      return t('call.inCall');
    case CallState.ENDED:
      return t('call.ended');
    default:
      return '';
  }
}

export function ActiveCallUI({
  peerName,
  peerAvatar,
  callState,
  duration,
  isMuted,
  onMuteToggle,
  onEndCall,
  isAnalyzing = false,
  sliceCount = 0,
  isVideoCall = false,
  isVideoEnabled = false,
  onVideoToggle,
  localStream,
  remoteStream,
}: ActiveCallUIProps) {
  const { t } = useLanguage();
  const isConnected = callState === CallState.CONNECTED;
  const isEnded = callState === CallState.ENDED;
  const isDialing = callState === CallState.REQUESTING || callState === CallState.CONNECTING;

  // 音效 ref
  const ringbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const connectAudioRef = useRef<HTMLAudioElement | null>(null);
  const hangupAudioRef = useRef<HTMLAudioElement | null>(null);
  const prevStateRef = useRef<CallState>(callState);

  // 視訊 ref
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // 設定本地視訊
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // 設定遠端視訊
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // 處理撥號/回鈴音
  useEffect(() => {
    if (isDialing) {
      // 播放回鈴音
      const audio = new Audio('/sounds/ringback.wav');
      audio.loop = true;
      audio.volume = 0.5;
      ringbackAudioRef.current = audio;
      audio.play().catch(err => {
        devWarn('[ActiveCallUI] 無法播放回鈴音:', err);
      });
    } else {
      // 停止回鈴音
      if (ringbackAudioRef.current) {
        ringbackAudioRef.current.pause();
        ringbackAudioRef.current.currentTime = 0;
        ringbackAudioRef.current = null;
      }
    }

    return () => {
      if (ringbackAudioRef.current) {
        ringbackAudioRef.current.pause();
        ringbackAudioRef.current = null;
      }
    };
  }, [isDialing]);

  // 播放連線成功音效
  useEffect(() => {
    if (prevStateRef.current !== CallState.CONNECTED && callState === CallState.CONNECTED) {
      const audio = new Audio('/sounds/connect.wav');
      audio.volume = 0.6;
      connectAudioRef.current = audio;
      audio.play().catch(err => {
        devWarn('[ActiveCallUI] 無法播放連線音:', err);
      });
    }
    prevStateRef.current = callState;
  }, [callState]);

  // 播放掛斷音效
  useEffect(() => {
    if (isEnded) {
      const audio = new Audio('/sounds/hangup.wav');
      audio.volume = 0.5;
      hangupAudioRef.current = audio;
      audio.play().catch(err => {
        devWarn('[ActiveCallUI] 無法播放掛斷音:', err);
      });
    }
  }, [isEnded]);

  // 視訊通話模式
  if (isVideoCall && isConnected) {
    return (
      <div className="fixed inset-0 z-50 bg-black">
        {/* 遠端視訊（全螢幕） */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />

        {/* 本地視訊（小視窗） */}
        <div className="absolute top-4 right-4 w-32 h-44 rounded-lg overflow-hidden shadow-lg border-2 border-white/20">
          {isVideoEnabled ? (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-surface-tertiary flex items-center justify-center">
              <span className="text-white/50 text-sm">{t('call.cameraOff')}</span>
            </div>
          )}
        </div>

        {/* 頂部狀態列 */}
        <div className="absolute top-4 left-4 flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/50 rounded-full backdrop-blur">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-white text-sm">{formatDuration(duration)}</span>
          </div>
          <span className="text-white font-medium">{peerName}</span>
        </div>

        {/* Phase 5: 語音分析指示器 */}
        {isAnalyzing && (
          <div className="absolute top-14 left-4 flex items-center gap-2 px-3 py-1.5 bg-aegis-500/30 rounded-full backdrop-blur">
            <div className="w-2 h-2 rounded-full bg-aegis-400 animate-pulse" />
            <span className="text-xs text-aegis-400">
              {t('call.aiProtecting')} {sliceCount > 0 && `(${sliceCount})`}
            </span>
          </div>
        )}

        {/* 底部控制列 */}
        <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-6">
          {/* 靜音 */}
          <button
            onClick={onMuteToggle}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all backdrop-blur ${
              isMuted
                ? 'bg-red-500/80 text-white'
                : 'bg-white/20 text-white hover:bg-white/30'
            }`}
          >
            {isMuted ? (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>

          {/* 視訊開關 */}
          <button
            onClick={onVideoToggle}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all backdrop-blur ${
              !isVideoEnabled
                ? 'bg-red-500/80 text-white'
                : 'bg-white/20 text-white hover:bg-white/30'
            }`}
          >
            {isVideoEnabled ? (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            )}
          </button>

          {/* 掛斷 */}
          <button
            onClick={onEndCall}
            className="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors shadow-lg"
          >
            <svg className="w-6 h-6 text-white transform rotate-135" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // 語音通話模式（原有 UI）
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-gradient-to-b from-surface-primary to-surface-secondary py-12 px-6">
      {/* 頂部：對方資訊 */}
      <div className="flex flex-col items-center">
        {/* 頭像容器 */}
        <div className="relative mb-4">
          {/* 撥號中脈衝光環 */}
          {isDialing && (
            <>
              <div className="absolute inset-0 w-28 h-28 rounded-full bg-mist-500/30 animate-ping" />
              <div className="absolute inset-0 w-28 h-28 rounded-full bg-mist-500/20 animate-pulse" />
            </>
          )}
          {/* 通話中綠色光環 */}
          {isConnected && !isVideoCall && (
            <div className="absolute inset-0 w-28 h-28 rounded-full bg-green-500/20 animate-pulse" />
          )}

          {/* 頭像 */}
          {peerAvatar && peerAvatar.startsWith('data:image') ? (
            <img
              src={peerAvatar}
              alt={peerName}
              className={`relative w-28 h-28 rounded-full object-cover border-2 ${
                isConnected ? 'border-green-500/50' : isEnded ? 'border-red-500/50' : 'border-mist-500/50'
              }`}
            />
          ) : (
            <div
              className={`relative w-28 h-28 rounded-full bg-gradient-to-br from-mist-500 to-mist-700 flex items-center justify-center border-2 ${
                isConnected ? 'border-green-500/50' : isEnded ? 'border-red-500/50' : 'border-mist-500/50'
              }`}
            >
              <span className="text-4xl text-white font-semibold">
                {peerName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}

          {/* 狀態圖示 */}
          <div
            className={`absolute -bottom-1 -right-1 w-8 h-8 rounded-full flex items-center justify-center ${
              isConnected ? 'bg-green-500' : isEnded ? 'bg-red-500' : 'bg-mist-500'
            }`}
          >
            <span className="text-sm">
              {isEnded ? <PhoneOffIcon size={14} /> : isConnected ? (isVideoCall ? <VideoIcon size={14} /> : <PhoneIcon size={14} />) : <SmartphoneIcon size={14} />}
            </span>
          </div>
        </div>

        {/* 名稱 */}
        <h2 className="text-2xl font-semibold text-on-surface-primary mb-1">{peerName}</h2>

        {/* 狀態/時間 */}
        <p className="text-on-surface-tertiary text-lg flex items-center gap-2">
          {isDialing && <span className="inline-block w-2 h-2 rounded-full bg-mist-500 animate-pulse" />}
          {isConnected && <span className="inline-block w-2 h-2 rounded-full bg-green-500" />}
          {isConnected ? formatDuration(duration) : getStateText(callState, t)}
          {isVideoCall && isDialing && <span className="text-sm text-mist-400 ml-2">{t('group.videoCall')}</span>}
        </p>
      </div>

      {/* 中間：波紋動畫 + 語音分析狀態（語音通話中顯示） */}
      {isConnected && !isVideoCall && (
        <div className="flex flex-col items-center gap-4">
          {/* 波紋動畫 */}
          <div className="relative flex items-center justify-center">
            <div className="absolute w-32 h-32 rounded-full bg-mist-500/10 animate-ping" />
            <div className="absolute w-24 h-24 rounded-full bg-mist-500/20 animate-pulse" />
            <div className="w-16 h-16 rounded-full bg-mist-500/30 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-mist-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
              </svg>
            </div>
          </div>

          {/* Phase 5: 語音分析指示器 */}
          {isAnalyzing && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-aegis-500/20 rounded-full">
              <div className="w-2 h-2 rounded-full bg-aegis-400 animate-pulse" />
              <span className="text-xs text-aegis-400">
                {t('call.aiProtecting')} {sliceCount > 0 && `(${sliceCount})`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 底部：控制按鈕 */}
      <div className="flex flex-col items-center gap-6">
        {/* 功能按鈕 */}
        {!isEnded && (
          <div className="flex gap-8 mb-4">
            {/* 靜音 */}
            <button
              onClick={onMuteToggle}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
                isMuted
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-surface-tertiary text-white hover:bg-surface-elevated'
              }`}
              disabled={!isConnected}
            >
              {isMuted ? (
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"
                  />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                  />
                </svg>
              )}
            </button>

            {/* 擴音（placeholder） */}
            <button
              className="w-14 h-14 rounded-full bg-surface-tertiary text-white hover:bg-surface-elevated flex items-center justify-center transition-all opacity-50"
              disabled
            >
              <svg
                className="w-6 h-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                />
              </svg>
            </button>
          </div>
        )}

        {/* 掛斷按鈕 */}
        {!isEnded && (
          <button
            onClick={onEndCall}
            className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors shadow-lg"
          >
            <svg
              className="w-8 h-8 text-white transform rotate-135"
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
        )}
      </div>
    </div>
  );
}

export default ActiveCallUI;

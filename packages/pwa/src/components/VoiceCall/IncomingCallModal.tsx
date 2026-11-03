import { devLog, devWarn } from '../../utils/devLog';

/**
 * IncomingCallModal - 來電提示視窗
 * 包含響鈴和震動功能
 *
 * 震動支援：
 * - Android PWA/Capacitor：Vibration API
 * - iOS Capacitor：Haptics API（持續循環呼叫）
 * - iOS PWA：不支援震動
 */

import { useEffect, useRef, useCallback } from 'react';
import { isNativeApp, isIOS } from '../../services/capacitor';

interface IncomingCallModalProps {
  callerName: string;
  callerAvatar?: string;
  onAccept: () => void;
  onReject: () => void;
  isVideoCall?: boolean;
}

/**
 * 檢查是否支援震動 API（Web Vibration API）
 */
function canVibrate(): boolean {
  return 'vibrate' in navigator;
}

/**
 * 開始震動模式（來電震動）
 *
 * 策略：
 * 1. iOS Capacitor：使用 Haptics API 循環呼叫
 * 2. Android/Web：使用 Vibration API
 *
 * 返回清理函式
 */
function startVibrationPattern(): () => void {
  let isVibrating = true;
  let cleanupFn: (() => void) | null = null;

  // iOS Capacitor：使用 Haptics API
  if (isNativeApp() && isIOS()) {
    // 動態導入 Haptics
    import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) => {
      // 來電震動模式：重擊 - 暫停 - 輕擊 - 暫停 - 重擊 - 長暫停
      // 模擬 pattern: [500, 200, 200, 200, 500, 2000]
      const hapticPattern = async () => {
        if (!isVibrating) return;

        // 第一次重擊
        await Haptics.impact({ style: ImpactStyle.Heavy });
        await sleep(500);
        if (!isVibrating) return;

        // 暫停 200ms
        await sleep(200);
        if (!isVibrating) return;

        // 輕擊
        await Haptics.impact({ style: ImpactStyle.Light });
        await sleep(200);
        if (!isVibrating) return;

        // 暫停 200ms
        await sleep(200);
        if (!isVibrating) return;

        // 第二次重擊
        await Haptics.impact({ style: ImpactStyle.Heavy });
        await sleep(500);
        if (!isVibrating) return;

        // 長暫停後重複
        await sleep(2000);
        if (isVibrating) {
          hapticPattern();
        }
      };

      hapticPattern();
    }).catch(err => {
      devWarn('[IncomingCall] Haptics API 不可用:', err);
    });

    cleanupFn = () => {
      isVibrating = false;
    };
  }
  // Android/Web：使用 Vibration API
  else if (canVibrate()) {
    // 來電震動模式：震動 500ms，停 200ms，震動 200ms，停 200ms，震動 500ms，停 2000ms
    const pattern = [500, 200, 200, 200, 500, 2000];

    const vibrate = () => {
      if (isVibrating) {
        navigator.vibrate(pattern);
        // 每個週期後重新開始
        setTimeout(() => {
          if (isVibrating) vibrate();
        }, pattern.reduce((a, b) => a + b, 0));
      }
    };

    vibrate();

    cleanupFn = () => {
      isVibrating = false;
      navigator.vibrate(0); // 停止震動
    };
  }

  return cleanupFn || (() => {
    isVibrating = false;
  });
}

/**
 * 輔助函式：等待指定毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function IncomingCallModal({
  callerName,
  callerAvatar,
  onAccept,
  onReject,
  isVideoCall = false,
}: IncomingCallModalProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopVibrationRef = useRef<(() => void) | null>(null);

  // 停止所有音效和震動
  const stopAllEffects = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (stopVibrationRef.current) {
      stopVibrationRef.current();
      stopVibrationRef.current = null;
    }
  }, []);

  // 播放來電鈴聲和震動
  useEffect(() => {
    // 創建音訊元素
    const audio = new Audio('/sounds/ringtone.wav');
    audio.loop = true;
    audio.volume = 0.7;
    audioRef.current = audio;

    // 嘗試播放音訊
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((error) => {
        devLog('[IncomingCall] 無法自動播放音訊，需要用戶互動:', error);
      });
    }

    // 開始震動
    stopVibrationRef.current = startVibrationPattern();

    // 清理
    return () => {
      stopAllEffects();
    };
  }, [stopAllEffects]);

  // 處理接聽
  const handleAccept = () => {
    stopAllEffects();
    onAccept();
  };

  // 處理拒絕
  const handleReject = () => {
    stopAllEffects();
    onReject();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-secondary rounded-3xl p-8 shadow-2xl border border-[var(--surface-border)] max-w-sm w-full mx-4">
        {/* 來電者頭像 */}
        <div className="flex flex-col items-center">
          {/* 頭像容器帶脈衝動畫 */}
          <div className="relative mb-4">
            {/* 脈衝光環 */}
            <div className="absolute inset-0 w-24 h-24 rounded-full bg-green-500/30 animate-ping" />
            <div className="absolute inset-0 w-24 h-24 rounded-full bg-green-500/20 animate-pulse" />

            {/* 頭像 */}
            {callerAvatar && callerAvatar.startsWith('data:image') ? (
              <img
                src={callerAvatar}
                alt={callerName}
                className="relative w-24 h-24 rounded-full object-cover border-2 border-green-500/50"
              />
            ) : (
              <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-mist-500 to-mist-700 flex items-center justify-center border-2 border-green-500/50">
                <span className="text-3xl text-white font-semibold">
                  {callerName.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
          </div>

          {/* 來電者名稱 */}
          <h2 className="text-xl font-semibold text-on-surface-primary mb-1">{callerName}</h2>
          <p className="text-on-surface-tertiary mb-8 flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${isVideoCall ? 'bg-blue-500' : 'bg-green-500'}`} />
            {isVideoCall ? 'Incoming video call...' : 'Incoming call...'}
          </p>

          {/* 操作按鈕 */}
          <div className="flex gap-8">
            {/* 拒絕 */}
            <button
              onClick={handleReject}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors shadow-lg active:scale-95"
            >
              <svg
                className="w-8 h-8 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>

            {/* 接聽 */}
            <button
              onClick={handleAccept}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors shadow-lg animate-bounce active:scale-95 ${
                isVideoCall ? 'bg-blue-500 hover:bg-blue-600' : 'bg-green-500 hover:bg-green-600'
              }`}
            >
              {isVideoCall ? (
                <svg
                  className="w-8 h-8 text-white"
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
              ) : (
                <svg
                  className="w-8 h-8 text-white"
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
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IncomingCallModal;

import { devLog } from '../../utils/devLog';

/**
 * Phase 10: PIN Keypad Component with Behavior Collection
 *
 * 數字鍵盤元件，支援觸控行為收集
 * 用於偵測模擬器/腳本批量建號
 *
 * 設計原則：
 * - 強制使用觸控 UI，防止系統鍵盤彈出
 * - 收集觸控特徵用於行為指紋
 * - 與現有 PIN 設定頁面樣式一致
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { useThemeStore } from '../../stores/themeStore';

interface PinKeypadProps {
  /** PIN 長度（預設 6） */
  length?: number;
  /** 當 PIN 完成時的回調 */
  onComplete: (pin: string) => void;
  /** 當 PIN 變化時的回調 */
  onChange?: (pin: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 錯誤訊息 */
  error?: string;
  /** 重置觸發器 */
  resetTrigger?: number;
  /** 行為收集回調 - touchstart */
  onKeyTouchStart?: (key: string, event: React.TouchEvent) => void;
  /** 行為收集回調 - touchend */
  onKeyTouchEnd?: (key: string, event: React.TouchEvent) => void;
  /** 行為收集回調 - mousedown (桌面/模擬器) */
  onKeyMouseDown?: (key: string, event: React.MouseEvent) => void;
  /** 行為收集回調 - mouseup (桌面/模擬器) */
  onKeyMouseUp?: (key: string, event: React.MouseEvent) => void;
}

// 鍵盤佈局
const KEYPAD_LAYOUT = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'del'],
];

export function PinKeypad({
  length = 6,
  onComplete,
  onChange,
  disabled = false,
  error,
  resetTrigger,
  onKeyTouchStart,
  onKeyTouchEnd,
  onKeyMouseDown,
  onKeyMouseUp,
}: PinKeypadProps) {
  const [pin, setPin] = useState<string>('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const lastResetTrigger = useRef(resetTrigger);
  // 追蹤是否使用觸控，避免 touch + mouse 雙重觸發
  const isTouchActive = useRef(false);
  // 取得當前主題
  const { effectiveTheme } = useThemeStore();
  const isDark = effectiveTheme === 'dark';

  // 重置
  useEffect(() => {
    if (resetTrigger !== lastResetTrigger.current) {
      lastResetTrigger.current = resetTrigger;
      setPin('');
    }
  }, [resetTrigger]);

  // 處理 App 從背景恢復 - 重置觸控狀態避免卡住
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        devLog('[PinKeypad] App resumed, resetting touch state');
        isTouchActive.current = false;
        setActiveKey(null);
        // 強制重新渲染
        forceUpdate(prev => prev + 1);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 處理按鍵邏輯（統一處理）
  const processKeyPress = useCallback(
    (key: string) => {
      if (key === 'del') {
        // 刪除
        setPin((prev) => {
          const newPin = prev.slice(0, -1);
          onChange?.(newPin);
          return newPin;
        });
      } else if (key !== '' && pin.length < length) {
        // 輸入數字
        setPin((prev) => {
          const newPin = prev + key;
          onChange?.(newPin);

          // 如果完成，觸發回調
          if (newPin.length === length) {
            // 延遲一點讓 UI 更新
            setTimeout(() => {
              onComplete(newPin);
            }, 100);
          }

          return newPin;
        });
      }
    },
    [pin, length, onChange, onComplete]
  );

  // 追蹤最後一次按鍵事件，避免同一次觸控的 touchend + click 雙重觸發
  // 使用事件 ID（時間戳 + key）來追蹤，而不是單純的 key
  const lastEventRef = useRef<{ key: string; time: number; eventType: string } | null>(null);

  // 檢查是否為同一次觸控的重複事件（touchend 後緊跟 click）
  // 注意：這裡只防止 50ms 內的重複，不影響正常的快速連按
  const isDuplicateEvent = useCallback((key: string, eventType: string): boolean => {
    const now = Date.now();
    const last = lastEventRef.current;

    // 如果是同一個 key，且在 50ms 內，且事件類型不同（touch → mouse），則為重複
    if (last && last.key === key && now - last.time < 50 && last.eventType !== eventType) {
      devLog('[PinKeypad] Ignoring duplicate event:', key, eventType);
      return true;
    }

    lastEventRef.current = { key, time: now, eventType };
    return false;
  }, []);

  // 處理觸控開始
  // 注意：不使用 e.preventDefault()，因為 React 的 onTouchStart 是 passive 的
  // 改用 isTouchActive flag 來防止 touch + mouse 雙重觸發
  const handleTouchStart = useCallback(
    (key: string, e: React.TouchEvent) => {
      if (disabled) return;
      // 不呼叫 preventDefault，避免 passive event listener 警告
      // 使用 isTouchActive flag 來過濾後續的 mouse 事件
      isTouchActive.current = true;
      setActiveKey(key);
      onKeyTouchStart?.(key, e);
    },
    [disabled, onKeyTouchStart]
  );

  // 處理觸控結束
  const handleTouchEnd = useCallback(
    (key: string, e: React.TouchEvent) => {
      if (disabled) return;
      // 不呼叫 preventDefault，使用 isDuplicateEvent 來過濾重複
      setActiveKey(null);
      onKeyTouchEnd?.(key, e);

      // 檢查是否重複觸發（只過濾 50ms 內的 touch→mouse 重複）
      if (!isDuplicateEvent(key, 'touch')) {
        processKeyPress(key);
      }

      // 延遲重置觸控狀態（縮短為 100ms，避免影響快速連按）
      setTimeout(() => {
        isTouchActive.current = false;
      }, 100);
    },
    [disabled, onKeyTouchEnd, processKeyPress, isDuplicateEvent]
  );

  // 處理滑鼠按下（只在非觸控設備時觸發）
  const handleMouseDown = useCallback(
    (key: string, e: React.MouseEvent) => {
      if (disabled || isTouchActive.current) return;
      setActiveKey(key);
      onKeyMouseDown?.(key, e);
    },
    [disabled, onKeyMouseDown]
  );

  // 處理滑鼠放開（只在非觸控設備時觸發）
  const handleMouseUp = useCallback(
    (key: string, e: React.MouseEvent) => {
      if (disabled || isTouchActive.current) return;
      setActiveKey(null);
      onKeyMouseUp?.(key, e);

      // 檢查是否重複觸發（只過濾 50ms 內的 touch→mouse 重複）
      if (!isDuplicateEvent(key, 'mouse')) {
        processKeyPress(key);
      }
    },
    [disabled, onKeyMouseUp, processKeyPress, isDuplicateEvent]
  );

  // 渲染 PIN 顯示（漸層邊框樣式）
  const renderPinDisplay = () => {
    return (
      <div className="flex justify-center gap-2 mb-8">
        {Array.from({ length }).map((_, index) => {
          const isFilled = index < pin.length;
          const isError = !!error;

          // 根據主題選擇未填入時的邊框顏色
          // 淺色主題：用較深的灰色讓方框可見
          // 深色主題：用較亮的灰色
          const emptyBorderColor = isDark ? '#6b7280' : '#d1d5db';

          return (
            <div
              key={index}
              className="rounded-lg p-[2px] transition-all duration-200"
              style={{
                background: isError
                  ? '#ef4444'
                  : isFilled
                    ? 'linear-gradient(135deg, #4dd0e1, #26c6da, #00acc1)'
                    : emptyBorderColor,
              }}
            >
              <div
                className="rounded-[6px] bg-surface-secondary flex items-center justify-center"
                style={{ width: '44px', height: '52px' }}
              >
                {isFilled && (
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{
                      background: 'linear-gradient(135deg, #4dd0e1, #00acc1)',
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // 渲染鍵盤（更大的按鈕，適合手機操作）
  const renderKeypad = () => {
    return (
      <div className="grid grid-cols-3 gap-5 w-full max-w-[296px] mx-auto">
        {KEYPAD_LAYOUT.flat().map((key, index) => {
          if (key === '') {
            return <div key={index} className="w-[72px] h-[72px]" />;
          }

          const isDelete = key === 'del';
          const isActive = activeKey === key;

          return (
            <button
              key={index}
              type="button"
              disabled={disabled}
              onTouchStart={(e) => handleTouchStart(key, e)}
              onTouchEnd={(e) => handleTouchEnd(key, e)}
              onMouseDown={(e) => handleMouseDown(key, e)}
              onMouseUp={(e) => handleMouseUp(key, e)}
              onMouseLeave={() => setActiveKey(null)}
              className={`
                w-[72px] h-[72px] rounded-full
                flex items-center justify-center
                text-3xl font-semibold
                transition-all duration-100
                select-none touch-manipulation
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer active:scale-95'}
                ${isActive
                  ? 'bg-primary-500 text-white scale-95'
                  : 'bg-surface-tertiary text-on-surface-primary hover:bg-surface-elevated'
                }
              `}
              aria-label={isDelete ? '刪除' : key}
            >
              {isDelete ? (
                <svg
                  className="w-7 h-7"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414-6.414a2 2 0 011.414-.586H19a2 2 0 012 2v10a2 2 0 01-2 2h-8.172a2 2 0 01-1.414-.586L3 12z"
                  />
                </svg>
              ) : (
                key
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center">
      {renderPinDisplay()}
      {renderKeypad()}

      {error && (
        <p className="mt-4 text-sm text-red-400 text-center">{error}</p>
      )}
    </div>
  );
}

export default PinKeypad;

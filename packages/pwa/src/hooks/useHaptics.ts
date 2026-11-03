import { devLog, devWarn } from '../utils/devLog';

/**
 * useHaptics - 震動反饋 Hook
 *
 * 提供風險警告的觸覺反饋功能
 * - 在原生 App 中使用 Capacitor Haptics
 * - 在瀏覽器中使用 Vibration API（如果支援）
 */

import { useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 震動模式配置
 */
const VIBRATION_PATTERNS = {
  // 中等風險：輕微震動 1 次
  medium: {
    native: async () => {
      await Haptics.impact({ style: ImpactStyle.Medium });
    },
    web: [100], // 100ms
  },
  // 高風險：中等震動 2 次
  high: {
    native: async () => {
      await Haptics.notification({ type: NotificationType.Warning });
    },
    web: [150, 100, 150], // 震-停-震
  },
  // 極高風險：強烈震動 3 次
  critical: {
    native: async () => {
      await Haptics.notification({ type: NotificationType.Error });
      await new Promise(resolve => setTimeout(resolve, 200));
      await Haptics.notification({ type: NotificationType.Error });
    },
    web: [200, 100, 200, 100, 200], // 震-停-震-停-震
  },
};

export function useHaptics() {
  /**
   * 根據風險等級觸發震動
   */
  const vibrateForRisk = useCallback(async (level: RiskLevel) => {
    if (level === 'low') return; // 低風險不震動

    const pattern = VIBRATION_PATTERNS[level];
    if (!pattern) return;

    try {
      if (Capacitor.isNativePlatform()) {
        // 原生 App：使用 Capacitor Haptics
        await pattern.native();
        devLog('[useHaptics] Native vibration for:', level);
      } else {
        // 瀏覽器：使用 Vibration API
        if ('vibrate' in navigator) {
          navigator.vibrate(pattern.web);
          devLog('[useHaptics] Web vibration for:', level);
        } else {
          devLog('[useHaptics] Vibration not supported');
        }
      }
    } catch (error) {
      devWarn('[useHaptics] Vibration failed:', error);
    }
  }, []);

  /**
   * 檢查是否應該震動（風險等級升高時）
   */
  const shouldVibrate = useCallback((
    previousLevel: RiskLevel | null,
    currentLevel: RiskLevel
  ): boolean => {
    const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const prevIndex = previousLevel ? levels.indexOf(previousLevel) : -1;
    const currIndex = levels.indexOf(currentLevel);

    // 只有升高到 medium 以上才震動
    return currIndex > prevIndex && currIndex >= 1;
  }, []);

  /**
   * 根據風險變化自動觸發震動
   */
  const vibrateOnRiskChange = useCallback(async (
    previousLevel: RiskLevel | null,
    currentLevel: RiskLevel
  ) => {
    if (shouldVibrate(previousLevel, currentLevel)) {
      await vibrateForRisk(currentLevel);
      return true;
    }
    return false;
  }, [shouldVibrate, vibrateForRisk]);

  return {
    vibrateForRisk,
    shouldVibrate,
    vibrateOnRiskChange,
  };
}

export default useHaptics;

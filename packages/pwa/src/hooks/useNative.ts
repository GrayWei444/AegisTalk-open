/**
 * Phase 15: 原生功能 Hook
 *
 * 提供 React 元件使用原生功能的 Hook
 */

import { useEffect, useCallback, useState } from 'react';
import {
  isNativeApp,
  getPlatform,
  isIOS,
  isAndroid,
  hapticFeedback,
  setStatusBar,
  hideSplashScreen,
  setupKeyboardListeners,
  setupAppListeners,
  showLocalNotification,
  type HapticType,
  type StatusBarOptions,
} from '../services/capacitor';

// ============================================
// 平台偵測 Hook
// ============================================

export interface PlatformInfo {
  isNative: boolean;
  platform: 'ios' | 'android' | 'web';
  isIOS: boolean;
  isAndroid: boolean;
}

/** 取得平台資訊 */
export function usePlatform(): PlatformInfo {
  return {
    isNative: isNativeApp(),
    platform: getPlatform(),
    isIOS: isIOS(),
    isAndroid: isAndroid(),
  };
}

// ============================================
// 觸覺回饋 Hook
// ============================================

/** 觸覺回饋 Hook */
export function useHaptics() {
  const trigger = useCallback(async (type: HapticType = 'medium') => {
    await hapticFeedback(type);
  }, []);

  return {
    light: () => trigger('light'),
    medium: () => trigger('medium'),
    heavy: () => trigger('heavy'),
    success: () => trigger('success'),
    warning: () => trigger('warning'),
    error: () => trigger('error'),
    trigger,
  };
}

// ============================================
// 鍵盤 Hook
// ============================================

export interface KeyboardState {
  isVisible: boolean;
  height: number;
}

/** 鍵盤狀態 Hook */
export function useKeyboard(): KeyboardState {
  const [state, setState] = useState<KeyboardState>({
    isVisible: false,
    height: 0,
  });

  useEffect(() => {
    const cleanup = setupKeyboardListeners(
      (height) => setState({ isVisible: true, height }),
      () => setState({ isVisible: false, height: 0 })
    );

    return () => {
      cleanup.then((fn) => fn?.());
    };
  }, []);

  return state;
}

// ============================================
// App 生命週期 Hook
// ============================================

export interface AppState {
  isActive: boolean;
}

/** App 狀態 Hook */
export function useAppState(
  onBackground?: () => void,
  onForeground?: () => void
): AppState {
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    const cleanup = setupAppListeners((active) => {
      setIsActive(active);
      if (active) {
        onForeground?.();
      } else {
        onBackground?.();
      }
    });

    return () => {
      cleanup.then((fn) => fn?.());
    };
  }, [onBackground, onForeground]);

  return { isActive };
}

// ============================================
// 返回鍵 Hook (Android)
// ============================================

/** Android 返回鍵 Hook */
export function useBackButton(handler: () => void): void {
  useEffect(() => {
    if (!isAndroid()) return;

    const cleanup = setupAppListeners(undefined, handler);

    return () => {
      cleanup.then((fn) => fn?.());
    };
  }, [handler]);
}

// ============================================
// 狀態列 Hook
// ============================================

/** 設定狀態列 */
export function useStatusBar(options: StatusBarOptions): void {
  useEffect(() => {
    setStatusBar(options);
  }, [options, options.style, options.backgroundColor]);
}

// ============================================
// 啟動畫面 Hook
// ============================================

/** 隱藏啟動畫面 */
export function useSplashScreen(autoHide = true): { hide: () => Promise<void> } {
  useEffect(() => {
    if (autoHide && isNativeApp()) {
      // 延遲一點再隱藏，確保 UI 已載入
      const timer = setTimeout(() => {
        hideSplashScreen();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoHide]);

  return {
    hide: hideSplashScreen,
  };
}

// ============================================
// 本地通知 Hook
// ============================================

let notificationId = 0;

/** 本地通知 Hook */
export function useLocalNotifications() {
  const notify = useCallback(async (title: string, body: string, data?: Record<string, unknown>) => {
    notificationId += 1;
    await showLocalNotification({
      id: notificationId,
      title,
      body,
      data,
    });
  }, []);

  return { notify };
}

// ============================================
// Safe Area Hook
// ============================================

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 取得 Safe Area Insets */
export function useSafeArea(): SafeArea {
  const [safeArea, setSafeArea] = useState<SafeArea>({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });

  useEffect(() => {
    // 使用 CSS env() 變數
    const computeInsets = () => {
      const style = getComputedStyle(document.documentElement);
      setSafeArea({
        top: parseInt(style.getPropertyValue('--sat') || '0') || 0,
        bottom: parseInt(style.getPropertyValue('--sab') || '0') || 0,
        left: parseInt(style.getPropertyValue('--sal') || '0') || 0,
        right: parseInt(style.getPropertyValue('--sar') || '0') || 0,
      });
    };

    // 設定 CSS 變數
    document.documentElement.style.setProperty('--sat', 'env(safe-area-inset-top)');
    document.documentElement.style.setProperty('--sab', 'env(safe-area-inset-bottom)');
    document.documentElement.style.setProperty('--sal', 'env(safe-area-inset-left)');
    document.documentElement.style.setProperty('--sar', 'env(safe-area-inset-right)');

    computeInsets();
    window.addEventListener('resize', computeInsets);
    return () => window.removeEventListener('resize', computeInsets);
  }, []);

  return safeArea;
}

// ============================================
// 整合 Hook
// ============================================

/** 整合所有原生功能的 Hook */
export function useNative() {
  const platform = usePlatform();
  const haptics = useHaptics();
  const keyboard = useKeyboard();
  const safeArea = useSafeArea();

  return {
    platform,
    haptics,
    keyboard,
    safeArea,
  };
}

export default useNative;

import { devLog } from '../utils/devLog';
import { create } from 'zustand';
import * as db from '../services/database';

/**
 * Theme Store - 主題管理
 *
 * 支援深色和淺色模式
 */

export type ThemeMode = 'dark' | 'light' | 'system';

const THEME_STORAGE_KEY = 'aegistalk_theme';

interface ThemeState {
  mode: ThemeMode;
  effectiveTheme: 'dark' | 'light';
  setMode: (mode: ThemeMode) => void;
  loadFromStorage: () => Promise<void>;
}

// 獲取系統主題
function getSystemTheme(): 'dark' | 'light' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light'; // 預設淺色（配合 Splash 背景）
}

// 計算實際主題
function getEffectiveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return getSystemTheme();
  }
  return mode;
}

// 從 localStorage 載入
function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && ['dark', 'light', 'system'].includes(saved)) {
      return saved as ThemeMode;
    }
  } catch (e) {
    console.error('[themeStore] Failed to load theme:', e);
  }
  return 'system'; // 預設跟隨系統主題
}

// 保存到 localStorage + SQLite
function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (e) {
    console.error('[themeStore] Failed to save theme:', e);
  }
  db.setSetting(THEME_STORAGE_KEY, mode).catch(() => {});
}

// 套用主題到 DOM
function applyTheme(theme: 'dark' | 'light'): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
    devLog('[themeStore] Applied theme:', theme);
  }
}

export const useThemeStore = create<ThemeState>((set) => {
  const initialMode = loadTheme();
  const initialEffective = getEffectiveTheme(initialMode);

  // 初始套用
  applyTheme(initialEffective);

  return {
    mode: initialMode,
    effectiveTheme: initialEffective,

    setMode: (mode: ThemeMode) => {
      const effective = getEffectiveTheme(mode);
      saveTheme(mode);
      applyTheme(effective);
      set({ mode, effectiveTheme: effective });
      devLog('[themeStore] Theme changed to:', mode, '(effective:', effective + ')');
    },

    loadFromStorage: async () => {
      try {
        await db.migrateFromLocalStorage(THEME_STORAGE_KEY);
        const saved = await db.getSetting(THEME_STORAGE_KEY);
        if (saved && ['dark', 'light', 'system'].includes(saved)) {
          const mode = saved as ThemeMode;
          const effective = getEffectiveTheme(mode);
          applyTheme(effective);
          set({ mode, effectiveTheme: effective });
        }
      } catch {
        // fallback: re-read localStorage
        const mode = loadTheme();
        const effective = getEffectiveTheme(mode);
        applyTheme(effective);
        set({ mode, effectiveTheme: effective });
      }
    },
  };
});

// 監聽系統主題變化
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const state = useThemeStore.getState();
    if (state.mode === 'system') {
      const effective = e.matches ? 'dark' : 'light';
      applyTheme(effective);
      useThemeStore.setState({ effectiveTheme: effective });
    }
  });
}

// 便利 hooks
export function useTheme() {
  return useThemeStore((state) => state.effectiveTheme);
}

export function useThemeMode() {
  return useThemeStore((state) => state.mode);
}

import { devLog } from '../utils/devLog';
import { create } from 'zustand';
import * as db from '../services/database';

/**
 * Font Scale Store - 字體大小管理
 *
 * 透過 html font-size 放大小～中字（Tailwind rem-based）提升可讀性。
 * normal 即為新基準；large/xlarge 進一步放大。
 * 注意：大字（text-xl/2xl/3xl，如好友碼/標題/金額）在 index.css 用 min(rem,px)
 * 設上限 → 不會隨此縮放無限變大（以「大部分人能看清楚」為標準，超過上限不調整）。
 */

export type FontScale = 'normal' | 'large' | 'xlarge';

const FONT_SCALE_STORAGE_KEY = 'aegistalk_font_scale';

// 每級對應的 html font-size 百分比（瀏覽器預設 16px → 100%）
const SCALE_PERCENT: Record<FontScale, string> = {
  normal: '112.5%',  // 18px — 全 app 放大後的新基準
  large: '131.25%',  // 21px
  xlarge: '150%',    // 24px
};

const VALID_SCALES: FontScale[] = ['normal', 'large', 'xlarge'];

interface FontScaleState {
  scale: FontScale;
  setScale: (scale: FontScale) => void;
  loadFromStorage: () => Promise<void>;
}

// 從 localStorage 載入
function loadScale(): FontScale {
  try {
    const saved = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (saved && VALID_SCALES.includes(saved as FontScale)) {
      return saved as FontScale;
    }
  } catch (e) {
    console.error('[fontScaleStore] Failed to load font scale:', e);
  }
  return 'normal';
}

// 保存到 localStorage + SQLite
function saveScale(scale: FontScale): void {
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, scale);
  } catch (e) {
    console.error('[fontScaleStore] Failed to save font scale:', e);
  }
  db.setSetting(FONT_SCALE_STORAGE_KEY, scale).catch(() => {});
}

// 套用字體大小到 DOM
function applyScale(scale: FontScale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-font-scale', SCALE_PERCENT[scale]);
    devLog('[fontScaleStore] Applied font scale:', scale, SCALE_PERCENT[scale]);
  }
}

export const useFontScaleStore = create<FontScaleState>((set) => {
  const initialScale = loadScale();

  // 初始套用
  applyScale(initialScale);

  return {
    scale: initialScale,

    setScale: (scale: FontScale) => {
      saveScale(scale);
      applyScale(scale);
      set({ scale });
      devLog('[fontScaleStore] Font scale changed to:', scale);
    },

    loadFromStorage: async () => {
      try {
        await db.migrateFromLocalStorage(FONT_SCALE_STORAGE_KEY);
        const saved = await db.getSetting(FONT_SCALE_STORAGE_KEY);
        if (saved && VALID_SCALES.includes(saved as FontScale)) {
          const scale = saved as FontScale;
          applyScale(scale);
          set({ scale });
        }
      } catch {
        const scale = loadScale();
        applyScale(scale);
        set({ scale });
      }
    },
  };
});

// 便利 hook
export function useFontScale() {
  return useFontScaleStore((state) => state.scale);
}

import { devLog } from '../utils/devLog';
import { syncNotificationStrings } from '../services/notificationStringsPlugin';

/**
 * Language Store - 語言管理
 *
 * 鏡像 themeStore.ts 模式 — localStorage + SQLite 雙寫
 */

import { create } from 'zustand';
import * as db from '../services/database';
import { deviceLanguage, setTrLanguage } from './tr';
import type { Language } from './types';

const LANGUAGE_STORAGE_KEY = 'aegistalk_language';
const VALID_LANGUAGES: readonly string[] = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'];

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
  loadFromStorage: () => Promise<void>;
}

/**
 * 還沒選過語言時（第一次開啟）：社群版跟著裝置／瀏覽器的語言（deviceLanguage，五種之一；都不是 → 繁中）。
 * 社群版的第一個畫面（選伺服器）在登入之前，沒有地方換語言。官方版照舊從繁中開始。
 */
function defaultLanguage(): Language {
  const chat = typeof __AEGIS_EDITION__ !== 'undefined' && __AEGIS_EDITION__ === 'chat';
  if (!chat || typeof navigator === 'undefined') return 'zh-TW';
  return deviceLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]) ?? 'zh-TW';
}

function loadLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved && VALID_LANGUAGES.includes(saved)) {
      return saved as Language;
    }
  } catch (e) {
    console.error('[languageStore] Failed to load language:', e);
  }
  return defaultLanguage();
}

function saveLanguage(lang: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch (e) {
    console.error('[languageStore] Failed to save language:', e);
  }
  db.setSetting(LANGUAGE_STORAGE_KEY, lang).catch(() => {});
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: loadLanguage(),

  setLanguage: (lang: Language) => {
    saveLanguage(lang);
    set({ language: lang });
    devLog('[languageStore] Language changed to:', lang);
    // 同步通知文字到原生層
    syncNotificationStrings().catch(() => {});
  },

  loadFromStorage: async () => {
    try {
      await db.migrateFromLocalStorage(LANGUAGE_STORAGE_KEY);
      const saved = await db.getSetting(LANGUAGE_STORAGE_KEY);
      if (saved && VALID_LANGUAGES.includes(saved)) {
        set({ language: saved as Language });
      }
    } catch {
      const lang = loadLanguage();
      set({ language: lang });
    }
    // 同步通知文字到原生層
    syncNotificationStrings().catch(() => {});
  },
}));

// tr()（./tr，服務層不經 store 的翻譯）跟著目前的語言
setTrLanguage(useLanguageStore.getState().language);
useLanguageStore.subscribe((s) => setTrLanguage(s.language));

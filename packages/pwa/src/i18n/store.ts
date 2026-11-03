import { devLog } from '../utils/devLog';
import { syncNotificationStrings } from '../services/notificationStringsPlugin';

/**
 * Language Store - 語言管理
 *
 * 鏡像 themeStore.ts 模式 — localStorage + SQLite 雙寫
 */

import { create } from 'zustand';
import * as db from '../services/database';
import type { Language } from './types';

const LANGUAGE_STORAGE_KEY = 'aegistalk_language';
const VALID_LANGUAGES: readonly string[] = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'];

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
  loadFromStorage: () => Promise<void>;
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
  return 'zh-TW';
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

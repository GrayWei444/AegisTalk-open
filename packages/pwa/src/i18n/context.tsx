/**
 * LanguageProvider + useLanguage hook
 *
 * 提供 t() 翻譯函數和語言切換功能。
 */

import { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useLanguageStore } from './store';
import type { Language, TranslationKeys } from './types';

import zhTW from './locales/zh-TW';
import zhCN from './locales/zh-CN';
import en from './locales/en';
import ja from './locales/ja';
import ko from './locales/ko';

const LOCALES: Record<Language, TranslationKeys> = {
  'zh-TW': zhTW,
  'zh-CN': zhCN,
  'en': en,
  'ja': ja,
  'ko': ko,
};

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * 根據 dot-notation key 從翻譯物件中取值
 */
function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * 替換 {param} 占位符
 */
function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (_, key) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{${key}}`;
  });
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  const locale = useMemo(() => LOCALES[language] || LOCALES['zh-TW'], [language]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const value = getNestedValue(locale as unknown as Record<string, unknown>, key);
      if (value === undefined) {
        // Fallback: 嘗試 zh-TW
        const fallback = getNestedValue(LOCALES['zh-TW'] as unknown as Record<string, unknown>, key);
        return interpolate(fallback ?? key, params);
      }
      return interpolate(value, params);
    },
    [locale],
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * 取得翻譯函數和語言狀態
 */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return ctx;
}

/**
 * i18n Service Helper
 *
 * 提供給非 React 環境（service、store）使用的翻譯函數。
 * 從 Zustand language store 取得當前語言，查詢對應翻譯。
 */

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

/**
 * 服務層翻譯函數
 *
 * 用法：
 * ```typescript
 * import { getServiceTranslation } from '../i18n/serviceHelper';
 * const t = getServiceTranslation();
 * const text = t('guardianAlertService.highRiskConversation', { riskScore: 85 });
 * ```
 */
export function getServiceTranslation(): (key: string, params?: Record<string, string | number>) => string {
  const language = useLanguageStore.getState().language;
  const locale = LOCALES[language] || LOCALES['zh-TW'];

  return (key: string, params?: Record<string, string | number>): string => {
    const value = getNestedValue(locale as unknown as Record<string, unknown>, key);
    if (value === undefined) {
      const fallback = getNestedValue(LOCALES['zh-TW'] as unknown as Record<string, unknown>, key);
      return interpolate(fallback ?? key, params);
    }
    return interpolate(value, params);
  };
}

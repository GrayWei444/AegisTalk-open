/**
 * t() for code outside React (services, stores, hooks that throw or store a message).
 *
 * Imports only the locale tables: the review tests bundle such services on their own, and the language store
 * (./store) would pull in the database and Capacitor. The store keeps the current language here (setTrLanguage);
 * until it does (and in those tests) the language is zh-TW, the app's default.
 *
 *   tr('deviceTransfer.verifyFailed'), tr('group.callMaxMembers', { max: 8 })
 */
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

let current: Language = 'zh-TW';

export function setTrLanguage(language: Language): void {
  if (language in LOCALES) current = language;
}

function lookup(locale: TranslationKeys, key: string): string | undefined {
  let node: unknown = locale;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** key in `language` (falls back to zh-TW, then to the key itself); {param} placeholders filled from params */
export function translate(language: Language, key: string, params?: Record<string, string | number>): string {
  const text = lookup(LOCALES[language] ?? LOCALES['zh-TW'], key) ?? lookup(LOCALES['zh-TW'], key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m));
}

/** the first supported language among the device's (navigator.languages), or null: zh-Hans / zh-CN / zh-SG → zh-CN, other zh → zh-TW */
export function deviceLanguage(tags: readonly string[]): Language | null {
  for (const tag of tags) {
    const t = (tag || '').toLowerCase();
    if (t.startsWith('zh')) return /^zh-(cn|sg)\b|-hans\b/.test(t) ? 'zh-CN' : 'zh-TW';
    if (t.startsWith('en')) return 'en';
    if (t.startsWith('ja')) return 'ja';
    if (t.startsWith('ko')) return 'ko';
  }
  return null;
}

/** key in the app's current language */
export function tr(key: string, params?: Record<string, string | number>): string {
  return translate(current, key, params);
}

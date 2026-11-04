/**
 * i18n Service Helper
 *
 * 提供給非 React 環境（service、store）使用的翻譯函數。
 * 從 Zustand language store 取得當前語言，查詢對應翻譯（查表與替換占位符在 ./tr）。
 * 不想帶進 language store（資料庫、Capacitor）的程式用 ./tr 的 tr()。
 */

import { useLanguageStore } from './store';
import { translate } from './tr';

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
  return (key: string, params?: Record<string, string | number>): string => translate(language, key, params);
}

/**
 * DIAG log gating utility.
 *
 * 用於暫時性的診斷日誌（[DIAG:...] prefix），可在生產環境按需開啟。
 *
 * 開啟條件（任一即印）：
 *  1. `import.meta.env.DEV` — 開發模式永遠印
 *  2. `localStorage.AEGIS_E2E_TEST === 'true'` — E2E 測試永遠印（AegisTest 抓 log 用）
 *  3. `localStorage.AEGIS_DIAG === '1'` — 生產環境用戶手動開啟
 *
 * 用法：
 *   import { diagLog } from '../utils/diagLog';
 *   diagLog('[DIAG:RATCHET:SEND]', recipient.slice(0, 16), msgNum);
 *
 * 注意：保持 console.error 通道（紅色，AegisTest BrowserMonitor 抓的就是 error）
 *      避免被 console.log 過濾掉。
 */

function isDiagEnabled(): boolean {
  // Dev mode 永遠印（Vite 編譯期常量，prod build 自動 dead-code-eliminate）
  if (import.meta.env.DEV) return true;

  // 動態檢查 localStorage — 不快取，避免 flag 設置在第一次調用後失效
  try {
    if (typeof localStorage === 'undefined') return false;
    return (
      localStorage.getItem('AEGIS_E2E_TEST') === 'true' ||
      localStorage.getItem('AEGIS_DIAG') === '1'
    );
  } catch {
    return false;
  }
}

/**
 * 印出 DIAG log（走 console.error 通道，與既有 BrowserMonitor 對齊）。
 * 生產環境若未開啟 flag，整個 call 直接 no-op。
 */
export function diagLog(...args: unknown[]): void {
  if (isDiagEnabled()) {
    // 絕對時戳前綴：跨進程（Alice/Bob/spec）同鐘拼時間線用。stdout 行序≠時序
    // （BrowserMonitor 轉發與 spec log 交錯），2026-07-17 test5 兩天誤判的根因 — 勿移除。
    console.error(`@${Date.now()}`, ...args);
  }
}

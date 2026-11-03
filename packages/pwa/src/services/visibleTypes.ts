/**
 * 解密後「要顯示成聊天訊息」的型別（對應群星 2026-10-01 審查）。
 *
 * 控制訊息（agent_status、群組金鑰、送達回條、檔案控制、file_manifest、recovery_shard、轉帳狀態……）在 AppProvider
 * 各自處理完就 return，不會走到顯示。走到顯示的只認得下面這幾種：以前不認得的型別照原樣存、照原樣顯示，L2 防詐
 * 只掃 text → 對方把文字標成別的型別就繞過掃描；新版多了控制型別（例如送達回條）時舊版還會多一個空白氣泡。
 *
 * 規則（AppProvider 套用）：不在名單上 → 有內容的當文字（照樣掃描），沒有內容的（不認得的控制訊息）不顯示。
 * 轉帳卡片（payment）是 AegisTalk 的功能，只在 1 對 1。
 */
export const DIRECT_VISIBLE_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'voice', 'payment']);
export const GROUP_VISIBLE_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'voice']);

/** 名單上的型別原樣回傳；不在名單上（或根本不是字串）回 null */
export function visibleTypeOf(type: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof type === 'string' && allowed.has(type) ? type : null;
}

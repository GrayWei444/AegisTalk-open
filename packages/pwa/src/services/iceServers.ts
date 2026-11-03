/**
 * ICE Servers 設定
 *
 * 架構原則：所有訊息內容不經過任何伺服器
 * - STUN：只用於發現公網 IP（不轉發資料）
 * - TURN：禁用（資料會經過 TURN 伺服器，違反隱私原則）
 * - 連線方式：LAN 直連 / IPv6 / STUN NAT 穿越
 *
 * STUN 伺服器來自執行期選的那台 chat 伺服器（開源第 5c 步：server-config 的 stun_urls，官方版預設官方站自己的）；
 * 伺服器沒列 → 用內建的公共 STUN（Google）。伺服器列了就只用它列的：自架者設了自己的 STUN，App 就不另外去問 Google。
 */

import { serverStunUrls } from './apiBase';

/** 伺服器沒有列 STUN 時的內建公共 STUN（docs/SELF_HOSTING.md「Known limits」） */
export const BUILTIN_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] as const;

/**
 * 只返回 STUN 伺服器（無 TURN）
 *
 * 連線優先順序：
 * 1. host（LAN 直連 / IPv6）
 * 2. srflx（STUN NAT 穿越）
 * 3. 無法連線 → 訊息佇列等待下次直連機會
 */
export function getIceServers(): RTCIceServer[] {
  const urls = serverStunUrls() ?? BUILTIN_STUN_URLS;
  // ❌ 不加 TURN — 訊息內容不可經過任何伺服器
  return urls.filter((u) => /^stuns?:/.test(u)).map((u) => ({ urls: u }));
}

/**
 * Phase 35a: 單一裝置綁定 Client
 *
 * 透過 VPS `/api/devices/*` 端點宣告當前裝置為帳號的唯一活躍裝置。
 * 同帳號登入新裝置時，舊裝置會在下一次 heartbeat 被踢下線。
 *
 * 認證方式：Ed25519 簽章
 *   - 簽章 payload 包含 `action` 欄位避免跨動作 replay
 *   - 5 分鐘時間戳容忍視窗
 *
 * 注意：本服務不直接讀取金鑰，由呼叫端傳入 Identity 實例（與 useCrypto 一致）。
 */

import { Capacitor } from '@capacitor/core';
import { Identity } from './crypto';
import { getDeviceId } from './deviceId';
import { devLog } from '../utils/devLog';
import { wipeRememberedTopics } from './topicMemory';
import { backup } from '@ext/backup';
import { apiBase } from './apiBase';

// ============================================================================
// Constants
// ============================================================================

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 分鐘

// ============================================================================
// Types
// ============================================================================

export type DevicePlatform = 'android' | 'ios' | 'pwa' | 'web';

export interface ClaimResult {
  success: boolean;
  kicked_previous: boolean;
  previous_device_id?: string;
  error?: string;
}

export interface HeartbeatResult {
  valid: boolean;
  reason?: 'account_not_found' | 'no_active_device' | 'replaced_by_new_device';
  error?: string;
}

export interface DeviceInfoResult {
  has_device: boolean;
  device_id?: string;
  platform?: string;
  display_label?: string;
  last_seen?: number;
  created_at?: number;
  error?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function detectPlatform(): DevicePlatform {
  const native = Capacitor.getPlatform();
  if (native === 'android') return 'android';
  if (native === 'ios') return 'ios';
  // 區分 PWA 安裝模式 vs 一般瀏覽器
  if (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) {
    return 'pwa';
  }
  return 'web';
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 規範化簽章訊息：JSON.stringify 並排序 key、無空白
 * 必須與 VPS 端 `json.dumps(payload, sort_keys=True, separators=(',', ':'))` 一致
 */
function canonicalize(payload: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  Object.keys(payload).sort().forEach(k => { sorted[k] = payload[k]; });
  return JSON.stringify(sorted);
}

function signPayload(identity: Identity, payload: Record<string, unknown>): string {
  const message = new TextEncoder().encode(canonicalize(payload));
  const signature = identity.sign(message);
  return bytesToBase64(signature);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 宣告當前裝置為帳號的活躍裝置
 *
 * - 若同帳號已有其他裝置 → 自動踢掉舊裝置（kicked_previous = true）
 * - 若帳號未在 AegisID 註冊 → 失敗（403），需先完成註冊
 *
 * @param identity 當前用戶的 Identity 實例（用於簽章）
 * @param displayLabel 顯示用標籤（例如「Gray 的 iPhone」），可選
 */
export async function claimDevice(
  identity: Identity,
  displayLabel?: string
): Promise<ClaimResult> {
  try {
    const deviceId = await getDeviceId();
    const platform = detectPlatform();
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = {
      device_id: deviceId,
      platform,
      display_label: displayLabel ?? '',
      timestamp,
      action: 'claim',
    };

    const signature = signPayload(identity, payload);
    const pubkey = identity.publicKeyBase64;

    const result = await postJson<{
      success: boolean;
      kicked_previous: boolean;
      previous_device_id: string | null;
    }>('/api/devices/claim', {
      device_id: deviceId,
      platform,
      display_label: displayLabel ?? null,
      timestamp,
      pubkey,
      signature,
    });

    devLog('[DeviceClaim] Claim result:', result);
    return {
      success: result.success,
      kicked_previous: result.kicked_previous,
      previous_device_id: result.previous_device_id ?? undefined,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[DeviceClaim] Claim failed:', msg);
    return { success: false, kicked_previous: false, error: msg };
  }
}

/**
 * 發送 heartbeat，確認當前裝置仍為活躍裝置
 *
 * 若 `valid: false` 表示已被新裝置踢下線（reason='replaced_by_new_device'）
 * 或帳號尚未註冊（reason='account_not_found'）
 */
export async function sendHeartbeat(identity: Identity): Promise<HeartbeatResult> {
  try {
    const deviceId = await getDeviceId();
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = {
      device_id: deviceId,
      timestamp,
      action: 'heartbeat',
    };

    const signature = signPayload(identity, payload);
    const pubkey = identity.publicKeyBase64;

    const result = await postJson<{
      valid: boolean;
      reason: string | null;
    }>('/api/devices/heartbeat', {
      device_id: deviceId,
      timestamp,
      pubkey,
      signature,
    });

    return {
      valid: result.valid,
      reason: (result.reason as HeartbeatResult['reason']) ?? undefined,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    // 網路失敗不算被踢，回傳 valid=true 避免誤殺
    console.error('[DeviceClaim] Heartbeat failed:', msg);
    return { valid: true, error: msg };
  }
}

/**
 * 查詢當前帳號綁定的裝置資訊
 */
export async function getDeviceInfo(identity: Identity): Promise<DeviceInfoResult> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = {
      timestamp,
      action: 'info',
    };

    const signature = signPayload(identity, payload);
    const pubkey = identity.publicKeyBase64;

    const result = await postJson<{
      has_device: boolean;
      device_id: string | null;
      platform: string | null;
      display_label: string | null;
      last_seen: number | null;
      created_at: number | null;
    }>('/api/devices/info', {
      timestamp,
      pubkey,
      signature,
    });

    return {
      has_device: result.has_device,
      device_id: result.device_id ?? undefined,
      platform: result.platform ?? undefined,
      display_label: result.display_label ?? undefined,
      last_seen: result.last_seen ?? undefined,
      created_at: result.created_at ?? undefined,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[DeviceClaim] Info failed:', msg);
    return { has_device: false, error: msg };
  }
}

// ============================================================================
// Heartbeat Loop
// ============================================================================

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _onKickedCallback: (() => void) | null = null;

/**
 * 啟動 heartbeat 迴圈（每 5 分鐘）
 *
 * 若偵測到被新裝置踢下線，呼叫 `onKicked` callback。
 * App 應在 callback 中：清空本機 session、登出 MQTT、跳轉到「您已被踢下線」頁面。
 *
 * 同一個 identity 多次呼叫會自動取代舊的 timer。
 */
export function startHeartbeatLoop(
  identity: Identity,
  onKicked: () => void
): void {
  stopHeartbeatLoop();
  _onKickedCallback = onKicked;

  const tick = async () => {
    const result = await sendHeartbeat(identity);
    if (!result.valid && result.reason === 'replaced_by_new_device') {
      devLog('[DeviceClaim] Kicked by new device — invoking callback');
      stopHeartbeatLoop();
      _onKickedCallback?.();
    }
  };

  // 立即執行一次，再開始定時
  tick().catch(() => {});
  _heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  devLog('[DeviceClaim] Heartbeat loop started (interval=5min)');
}

export function stopHeartbeatLoop(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
    devLog('[DeviceClaim] Heartbeat loop stopped');
  }
  _onKickedCallback = null;
}

/**
 * Phase 35b: 處理 MQTT 即時 kick 信號
 *
 * 收到不可信的 MQTT 通知後，立即呼叫 heartbeat 端點驗證
 * （避免攻擊者偽造 kick 訊息把使用者踢下線）。
 *
 * 確認被踢後 → 觸發 onKicked callback。
 */
export async function handleKickSignal(identity: Identity): Promise<boolean> {
  devLog('[DeviceClaim] Verifying kick signal via heartbeat...');
  const result = await sendHeartbeat(identity);
  if (!result.valid && result.reason === 'replaced_by_new_device') {
    devLog('[DeviceClaim] Kick confirmed by VPS');
    stopHeartbeatLoop();
    _onKickedCallback?.();
    return true;
  }
  devLog('[DeviceClaim] Kick signal NOT confirmed (likely spoofed):', result);
  return false;
}

/**
 * Phase 35b: 清除本機所有金鑰與敏感資料（被踢時呼叫）
 *
 * 立即清除：
 * - localStorage 中的 mist_keys / mist_sessions / aegis_device_id 等
 * - SQLite 中的 settings (mist_keys, mist_sessions)
 * - IndexedDB 已不再使用（已遷移到 SQLite）
 *
 * **不清除**:
 * - PIN hash / salt（讓使用者用 PIN 重新解鎖時還能用）
 * - 但被踢的場景下使用者通常會直接被導回 AuthScreen 重新登入
 */
export async function wipeLocalKeys(): Promise<void> {
  try {
    // 清除 localStorage 敏感金鑰
    const KEYS_TO_CLEAR = [
      'mist_keys',
      'mist_sessions',
      'mist_pubkey_raw', // MQTT 預連線用的 raw pubkey
      'aegis_device_id', // 下次登入會生成新 deviceId
    ];
    for (const k of KEYS_TO_CLEAR) {
      try { localStorage.removeItem(k); } catch {}
    }

    // 清除 SQLite settings
    try {
      const db = await import('./database');
      for (const k of KEYS_TO_CLEAR) {
        await db.deleteSetting(k).catch(() => {});
      }
    } catch {}

    // 好友之間的 presence 秘密（W4）：帳號已經不在這台了，我的與好友的 S 都不留
    try {
      const { wipePresenceSecrets } = await import('./presenceStore');
      await wipePresenceSecrets();
    } catch (err) {
      console.error('[DeviceClaim] wiping presence secrets failed:', err);
    }

    // 停用帳號備份（官方版 v2 blob sync）— 避免 ghost flush
    try {
      backup.clear();
    } catch {}

    // 原生端的守護資料（報平安設定、舊版憑證、還沒交給 JS 的「報平安」）：帳號已經不在這台了
    try {
      const { clearGuardianNativeData } = await import('./guardianBackground');
      await clearGuardianNativeData();
    } catch (err) {
      console.error('[DeviceClaim] clearing the native guardian data failed:', err);
    }

    // 驗來電推播用的本機資料（好友名單副本、我是誰、看過的來電；開源第 5d 步）
    try {
      const { clearRingData } = await import('./ringSync');
      await clearRingData();
    } catch (err) {
      console.error('[DeviceClaim] clearing the ring data failed:', err);
    }

    // MQTT 待送佇列（IndexedDB）不分帳號：先停 MQTT（不再排入新的），再清掉。否則下一個登入的帳號會
    //   用這個帳號的身分把排隊的 X3DH_INIT／群組事件送出去，打掉對方跟新裝置的 session（對應群星 P3-4）
    try {
      const { mqttService } = await import('./mqtt');
      mqttService.disconnect();
      const { clearAllOutgoing } = await import('./outgoingQueueStore');
      await clearAllOutgoing();
    } catch (err) {
      console.error('[DeviceClaim] clearing MQTT outbox failed:', err);
    }
    // mqtt 記著的群組／presence 主題（localStorage；好友的公鑰與他們目前的 tag，審查 W4 #11）：停了 MQTT 之後才清（不會再寫回來）
    wipeRememberedTopics();

    // 先停掉這個帳號還在跑的傳檔與送訊（對應群星 shutdownP2PAccount／shutdownFileTransfer）：被踢的頁面還要倒數幾秒
    //   才 reload，這段時間裡還在 await 的 flush／重送／傳檔不能再送出去、也不能在下面清完 outbox 之後又寫回一筆。
    //   待送清單裡的檔（aegis_file_pending，帶著檔案金鑰）也是這個帳號的，一起清
    try {
      const { shutdownFileTransfer } = await import('./fileTransfer');
      await shutdownFileTransfer();
      const { shutdownP2PAccount } = await import('./p2pSend');
      await shutdownP2PAccount();
      try { localStorage.removeItem('aegis_file_pending'); } catch {}
    } catch (err) {
      console.error('[DeviceClaim] stopping P2P / file transfer failed:', err);
    }

    // SQLite 的待送（1 對 1 密文與排隊的明文、群組的參照、v11 起共用的群組密文）也不分帳號：下一個帳號開 App 時
    //   loadOutbox 會照收件人把它們撥出去（群組密文還帶著這個帳號的簽章）。上面已停 MQTT；清完在 web 上馬上存檔
    //   （不封印：被踢的頁面倒數幾秒才 reload），使用者一按「立即重新整理」也不會把刪除丟掉
    try {
      const { clearAllPendingMessages } = await import('./storage');
      await clearAllPendingMessages();
      const { flushToStore } = await import('./database');
      await flushToStore();
    } catch (err) {
      console.error('[DeviceClaim] clearing the SQLite outbox failed:', err);
    }

    devLog('[DeviceClaim] Local keys wiped');
  } catch (err) {
    console.error('[DeviceClaim] wipeLocalKeys failed:', err);
  }
}

/**
 * Phase 27: Device ID Management
 *
 * 每台設備有唯一 UUID v4 裝置 ID
 * 用於 MQTT clientId 區分多設備連線
 *
 * 儲存策略：localStorage (sync cache) + SQLite (durable)
 */

import * as db from './database';
import { devLog } from '../utils/devLog';

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'aegis_device_id';

// ============================================================================
// UUID v4 Generator
// ============================================================================

function generateUUIDv4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Set version 4 (0100)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 取得或建立裝置 ID
 *
 * 首次呼叫時生成 UUID v4 並持久化
 * 後續呼叫返回已儲存的 ID
 */
export async function getDeviceId(): Promise<string> {
  // Try localStorage first (fast sync)
  let deviceId = localStorage.getItem(STORAGE_KEY);
  if (deviceId) return deviceId;

  // Fallback to SQLite
  try {
    deviceId = await db.getSetting(STORAGE_KEY) ?? null;
  } catch {
    // SQLite not ready yet
  }

  if (deviceId) {
    // Restore to localStorage for fast access
    localStorage.setItem(STORAGE_KEY, deviceId);
    return deviceId;
  }

  // Generate new device ID
  deviceId = generateUUIDv4();
  localStorage.setItem(STORAGE_KEY, deviceId);
  db.setSetting(STORAGE_KEY, deviceId).catch(() => {});
  devLog('[DeviceId] Generated new device ID:', deviceId.slice(0, 8));
  return deviceId;
}

/**
 * 同步取得裝置 ID（僅從 localStorage，可能為 null）
 *
 * 用於需要同步存取的場景（如 MQTT clientId 建構）
 */
export function getDeviceIdSync(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * 確保裝置 ID 已初始化（app 啟動時呼叫）
 */
export async function ensureDeviceId(): Promise<string> {
  return getDeviceId();
}

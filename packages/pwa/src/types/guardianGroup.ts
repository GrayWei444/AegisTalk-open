/**
 * Guardian Group Types - 家庭守護群組類型定義 (Phase 19)
 *
 * 設計理念：
 * - 利用群組權限系統，無需複雜角色設定
 * - 群主/管理員 = 守護人 (收警告通知)
 * - 一般成員 = 被守護者 (被保護)
 */

// ============================================
// 群組類型
// ============================================

/** 群組類型 */
export type GroupType = 'normal' | 'guardian';

/** 報平安頻率 */
export type CheckInFrequency = 'daily' | 'every_2_days' | 'weekly';

/** 報平安狀態 */
export type CheckInStatusType = 'ok' | 'pending' | 'overdue';

// ESM import — require() 不可用於 Vite production builds
import { getServiceTranslation } from '../i18n/serviceHelper';

/** 守護人警告類型 */
export type GuardianAlertType =
  | 'check_in_overdue'      // 報平安逾期
  | 'high_risk_conversation' // 高風險對話
  | 'payment_intent'         // 轉帳意圖
  | 'suspicious_link';       // 可疑連結

// ============================================
// 守護群組設定
// ============================================

/** 報平安設定 */
export interface CheckInConfig {
  /** 是否啟用 */
  enabled: boolean;
  /** 報平安頻率 */
  frequency: CheckInFrequency;
  /** 每日推播時間 (HH:mm 格式) */
  notifyTime: string;
  /** 時區 (IANA 格式，如 'Asia/Taipei') */
  timezone?: string;
  /** 回應期限 (小時)，預設 48 */
  responseDeadline: number;
  /** 自訂問候語，空 = 用預設翻譯。支援 {name} 佔位符 */
  customMessage?: string;
}

/** 守護功能設定 */
export interface ProtectionConfig {
  /** 高風險對話警告 */
  riskAlert: boolean;
  /** 轉帳意圖警告 */
  paymentAlert: boolean;
  /** 可疑連結警告 */
  linkAlert: boolean;
  /** 風險閾值 (0-100)，超過此值才通知 */
  riskThreshold: number;
}

/** 守護群組設定 (儲存在群組元資料中) */
export interface GuardianGroupSettings {
  /** 群組類型標記 */
  type: 'guardian';
  /** 報平安設定 */
  checkIn: CheckInConfig;
  /** 守護功能設定 */
  protection: ProtectionConfig;
}

// ============================================
// 報平安相關
// ============================================

/** 單一成員的報平安狀態 */
export interface MemberCheckInStatus {
  /** 群組 ID */
  groupId: string;
  /** 成員公鑰 */
  memberPubkey: string;
  /** 成員暱稱 */
  memberNickname: string;
  /** 上次報平安時間 */
  lastCheckIn?: number;
  /** 下次應報平安時間 */
  nextDue: number;
  /** 狀態 */
  status: CheckInStatusType;
  /** 連續未回應次數 */
  missedCount: number;
}

/** 報平安記錄 */
export interface CheckInRecord {
  /** 記錄 ID */
  id: string;
  /** 群組 ID */
  groupId: string;
  /** 成員公鑰 */
  memberPubkey: string;
  /** 請求時間 */
  requestedAt: number;
  /** 回應時間 */
  respondedAt?: number;
  /** 狀態 */
  status: 'pending' | 'confirmed' | 'missed';
  /** 回應方式 */
  responseType?: 'button' | 'message';
}

/** 報平安請求訊息 (顯示在群組內) */
export interface CheckInRequestMessage {
  type: 'check_in_request';
  /** 請求 ID */
  requestId: string;
  /** 目標成員公鑰 */
  targetPubkey: string;
  /** 目標成員暱稱 */
  targetNickname: string;
  /** 截止時間 */
  deadline: number;
  /** 顯示訊息 */
  message: string;
}

/** 報平安回應 */
export interface CheckInResponse {
  type: 'check_in_response';
  /** 請求 ID */
  requestId: string;
  /** 回應者公鑰 */
  responderPubkey: string;
  /** 回應 */
  response: 'ok' | 'need_help';
  /** 附加訊息 */
  message?: string;
}

// ============================================
// 守護人警告
// ============================================

/** 守護人警告通知 */
export interface GuardianAlert {
  /** 警告 ID */
  id: string;
  /** 群組 ID */
  groupId: string;
  /** 被守護者公鑰 */
  protectedPubkey: string;
  /** 被守護者暱稱 */
  protectedNickname: string;
  /** 警告類型 */
  type: GuardianAlertType;
  /** 詳細資訊 */
  details: {
    /** 風險分數 (0-100) */
    riskScore?: number;
    /** 相關聯絡人公鑰 */
    contactPubkey?: string;
    /** 相關聯絡人暱稱 */
    contactNickname?: string;
    /** 可疑連結 URL */
    linkUrl?: string;
    /** 描述 */
    description?: string;
    /** 連續未報平安次數 */
    missedCount?: number;
  };
  /** 建立時間 */
  createdAt: number;
  /** 狀態 */
  status: 'pending' | 'acknowledged' | 'dismissed';
  /** 處理時間 */
  handledAt?: number;
}

// ============================================
// 守護群組建立流程
// ============================================

/** 建立守護群組步驟 */
export type CreateGuardianGroupStep = 1 | 2 | 3;

/** 建立守護群組表單資料 */
export interface CreateGuardianGroupForm {
  /** 步驟 1: 群組名稱 */
  groupName: string;
  /** 步驟 2: 選擇的成員公鑰 */
  selectedMembers: string[];
  /** 步驟 3: 報平安頻率 */
  checkInFrequency: CheckInFrequency;
}

// ============================================
// 預設值
// ============================================

/** 預設報平安設定 */
export const DEFAULT_CHECK_IN_CONFIG: CheckInConfig = {
  enabled: true,
  frequency: 'every_2_days',
  notifyTime: '09:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  responseDeadline: 48,
};

/** 預設守護功能設定 */
export const DEFAULT_PROTECTION_CONFIG: ProtectionConfig = {
  riskAlert: true,
  paymentAlert: true,
  linkAlert: true,
  riskThreshold: 70,
};

/** 預設守護群組設定 */
export const DEFAULT_GUARDIAN_SETTINGS: GuardianGroupSettings = {
  type: 'guardian',
  checkIn: DEFAULT_CHECK_IN_CONFIG,
  protection: DEFAULT_PROTECTION_CONFIG,
};

// ============================================
// 工具函式
// ============================================

/** 計算下次報平安時間 */
export function calculateNextCheckInDue(
  lastCheckIn: number | undefined,
  frequency: CheckInFrequency,
  groupCreatedAt?: number
): number {
  // 如果從沒報過平安，用群組建立時間當基準（而非 Date.now()）
  // 這樣剛建群不會立刻顯示報平安卡片，要等第一個 interval 過了才會
  const base = lastCheckIn || groupCreatedAt || Date.now();
  const intervals: Record<CheckInFrequency, number> = {
    daily: 24 * 60 * 60 * 1000,
    every_2_days: 48 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
  };
  return base + intervals[frequency];
}

/** 判斷報平安狀態 */
export function getCheckInStatus(
  lastCheckIn: number | undefined,
  nextDue: number,
  responseDeadline: number,
  frequency?: CheckInFrequency
): CheckInStatusType {
  const now = Date.now();
  const deadlineMs = responseDeadline * 60 * 60 * 1000;

  if (lastCheckIn) {
    // 用 frequency 間隔判斷是否已到下次報平安時間
    const intervals: Record<CheckInFrequency, number> = {
      daily: 24 * 60 * 60 * 1000,
      every_2_days: 48 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
    };
    const intervalMs = intervals[frequency || 'every_2_days'];
    if (now - lastCheckIn < intervalMs) {
      return 'ok';
    }
  }
  // 還沒到 nextDue → 不需要報平安（群組剛建、或上次報平安後週期還沒到）
  if (now < nextDue) {
    return 'ok';
  }
  if (now > nextDue + deadlineMs) {
    return 'overdue';
  }
  return 'pending';
}

/** 格式化頻率顯示 */
export function formatFrequency(frequency: CheckInFrequency): string {
  const t = getServiceTranslation();
  const keys: Record<CheckInFrequency, string> = {
    daily: 'guardian.frequencyDaily',
    every_2_days: 'guardian.frequencyEvery2Days',
    weekly: 'guardian.frequencyWeekly',
  };
  return t(keys[frequency]);
}

/** 格式化警告類型顯示 */
export function formatAlertType(type: GuardianAlertType): string {
  const t = getServiceTranslation();
  const keys: Record<GuardianAlertType, string> = {
    check_in_overdue: 'guardian.alertTypeCheckInOverdue',
    high_risk_conversation: 'guardian.alertTypeHighRisk',
    payment_intent: 'guardian.alertTypePaymentIntent',
    suspicious_link: 'guardian.alertTypeSuspiciousLink',
  };
  return t(keys[type]);
}

/**
 * NotificationStringsPlugin — Capacitor 橋接
 *
 * 將 i18n 翻譯文字同步到 Android 原生層 SharedPreferences，
 * 供 AegisFCMService、IncomingCallActivity 使用。
 */

import { registerPlugin } from '@capacitor/core';
import { getServiceTranslation } from '../i18n/serviceHelper';
import { savePushStrings } from './pushStrings';

interface NotificationStringsPluginType {
  sync(options: { strings: string }): Promise<{ synced: boolean }>;
}

const NotificationStringsNative = registerPlugin<NotificationStringsPluginType>('NotificationStrings');

/**
 * 同步所有通知文字到原生層
 * 應在：App 啟動 + 語言切換時呼叫
 */
export async function syncNotificationStrings(): Promise<void> {
  const t = getServiceTranslation();

  // Web Push：service worker 顯示的通知文字（它讀不到語言設定，讀這份）
  savePushStrings({
    callTitle: t('call.incomingCall'),
    videoCallTitle: t('call.incomingVideoCall'),
    callBody: t('call.isCallingYou', { name: '{name}' }),
    videoCallBody: t('call.isVideoCallingYou', { name: '{name}' }),
    openToAnswer: t('push.openToAnswer'),
    callHint: t('push.callHint'),
    guardian: t('push.guardianNotification'),
    checkIn: t('push.checkInNotification'),
    message: t('call.newMessage'),
    accept: t('call.acceptCall'),
    reject: t('call.rejectCall'),
  }).catch(() => {});

  // Only on native Android
  const isNative = typeof (window as unknown as Record<string, unknown>).Capacitor !== 'undefined';
  if (!isNative) return;

  const strings = {
    // Message notifications
    newMessage: t('call.newMessage'),
    messageSent: t('chat.pushMessageTitle', { name: '{name}' }),

    // Call notifications
    incomingCall: t('call.incomingCall'),
    incomingVideoCall: t('call.incomingVideoCall'),
    isCallingYou: t('call.isCallingYou', { name: '{name}' }),
    unknownCaller: t('common.unknown'),

    // Guardian alerts
    guardianAlert: t('guardian.guardianAlerts'),
    checkInOverdue: t('guardian.overdueNotifyTitle'),
    riskDetected: t('risk.riskDetected'),
    paymentWarning: t('guardian.paymentWarning'),
    suspiciousLink: t('guardian.alertTypeSuspiciousLink'),
    familyMember: t('guardian.familyMember'),
    notCheckedIn: t('guardian.overdueNotifyBody', { name: '{name}' }),
    fraudDetected: t('guardianAlertService.highRiskConversation', { riskScore: '{name}' })
      .replace('{name}', '{name}'),
    riskyTransfer: t('guardianAlertService.paymentIntent'),
    suspiciousLinkDetected: t('guardianAlertService.suspiciousLink', { linkUrl: '' }).trim(),
    newGuardianNotification: t('guardian.newNotification'),

    // Check-in
    checkInReminder: t('guardian.checkInReminderTitle'),
    checkInBody: t('guardian.checkInReminderBody'),
    checkInConfirmed: t('guardian.checkInResponseTitle'),
    hasCheckedIn: t('guardian.checkInResponseBody', { name: '{name}' }),
    checkIn: t('guardian.checkIn'),
    checkInNotification: t('guardian.checkInNotification'),

    // Notification channels
    channelMessages: t('notification.channelMessages'),
    channelMessagesDesc: t('notification.channelMessagesDesc'),
    channelCalls: t('notification.channelCalls'),
    channelCallsDesc: t('notification.channelCallsDesc'),
    channelGuardian: t('guardian.guardianAlerts'),
    channelGuardianDesc: t('notification.channelGuardianDesc'),
    channelGuardianProtection: t('guardian.serviceTitle'),
    channelGuardianProtectionDesc: t('guardian.serviceBody'),
  };

  try {
    await NotificationStringsNative.sync({ strings: JSON.stringify(strings) });
  } catch {
    // Not on Android or plugin not available — ignore
  }
}

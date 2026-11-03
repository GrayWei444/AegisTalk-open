/**
 * NotificationStringsPlugin — Capacitor 橋接
 *
 * 將 i18n 翻譯文字同步到 Android 原生層 SharedPreferences，
 * 供 AegisFCMService、IncomingCallActivity 使用。
 */

import { registerPlugin } from '@capacitor/core';
import { getServiceTranslation } from '../i18n/serviceHelper';

interface NotificationStringsPluginType {
  sync(options: { strings: string }): Promise<{ synced: boolean }>;
}

const NotificationStringsNative = registerPlugin<NotificationStringsPluginType>('NotificationStrings');

/**
 * 同步所有通知文字到原生層
 * 應在：App 啟動 + 語言切換時呼叫
 */
export async function syncNotificationStrings(): Promise<void> {
  // Only on native Android
  const isNative = typeof (window as unknown as Record<string, unknown>).Capacitor !== 'undefined';
  if (!isNative) return;

  const t = getServiceTranslation();

  const strings = {
    // Message notifications
    newMessage: t('call.newMessage', undefined) !== 'call.newMessage'
      ? t('call.newMessage')
      : t('chat.pushMessageTitle', { name: '' }).trim() || 'You have a new message',
    messageSent: t('chat.pushMessageTitle', { name: '{name}' }),

    // Call notifications
    incomingCall: t('call.incomingCall'),
    incomingVideoCall: t('call.incomingVideoCall'),
    isCallingYou: t('call.isCallingYou', { name: '{name}' }),
    unknownCaller: t('common.unknown', undefined) !== 'common.unknown'
      ? t('common.unknown')
      : t('call.unknownCaller', undefined) !== 'call.unknownCaller'
        ? t('call.unknownCaller')
        : '未知',

    // Guardian alerts
    guardianAlert: t('guardian.guardianAlerts'),
    checkInOverdue: t('guardian.overdueNotifyTitle'),
    riskDetected: t('guardian.riskDetected', undefined) !== 'guardian.riskDetected'
      ? t('guardian.riskDetected')
      : '偵測到風險',
    paymentWarning: t('guardian.paymentWarning', undefined) !== 'guardian.paymentWarning'
      ? t('guardian.paymentWarning')
      : '付款警告',
    suspiciousLink: t('guardian.suspiciousLink', undefined) !== 'guardian.suspiciousLink'
      ? t('guardian.suspiciousLink')
      : '可疑連結',
    familyMember: t('guardian.familyMember'),
    notCheckedIn: t('guardian.overdueNotifyBody', { name: '{name}' }),
    fraudDetected: t('guardianAlertService.highRiskConversation', { riskScore: '{name}' })
      .replace('{name}', '{name}'),
    riskyTransfer: t('guardianAlertService.paymentIntent'),
    suspiciousLinkDetected: t('guardianAlertService.suspiciousLink', { linkUrl: '' }).trim(),
    newGuardianNotification: t('guardian.newNotification', undefined) !== 'guardian.newNotification'
      ? t('guardian.newNotification')
      : '收到新的守護通知',

    // Check-in
    checkInReminder: t('guardian.checkInReminderTitle'),
    checkInBody: t('guardian.checkInReminderBody'),
    checkInConfirmed: t('guardian.checkInResponseTitle'),
    hasCheckedIn: t('guardian.checkInResponseBody', { name: '{name}' }),
    checkIn: t('guardian.checkIn'),
    checkInNotification: t('guardian.checkInNotification', undefined) !== 'guardian.checkInNotification'
      ? t('guardian.checkInNotification')
      : '報平安通知',

    // Notification channels
    channelMessages: t('notification.channelMessages', undefined) !== 'notification.channelMessages'
      ? t('notification.channelMessages')
      : '訊息',
    channelMessagesDesc: t('notification.channelMessagesDesc', undefined) !== 'notification.channelMessagesDesc'
      ? t('notification.channelMessagesDesc')
      : '新訊息通知',
    channelCalls: t('notification.channelCalls', undefined) !== 'notification.channelCalls'
      ? t('notification.channelCalls')
      : '來電',
    channelCallsDesc: t('notification.channelCallsDesc', undefined) !== 'notification.channelCallsDesc'
      ? t('notification.channelCallsDesc')
      : '來電通知',
    channelGuardian: t('guardian.guardianAlerts'),
    channelGuardianDesc: t('notification.channelGuardianDesc', undefined) !== 'notification.channelGuardianDesc'
      ? t('notification.channelGuardianDesc')
      : '守護警報通知',
    channelGuardianProtection: t('guardian.serviceTitle', undefined) !== 'guardian.serviceTitle'
      ? t('guardian.serviceTitle')
      : '守護保護',
    channelGuardianProtectionDesc: t('guardian.serviceBody', undefined) !== 'guardian.serviceBody'
      ? t('guardian.serviceBody')
      : '守護保護服務運行中',
  };

  try {
    await NotificationStringsNative.sync({ strings: JSON.stringify(strings) });
  } catch {
    // Not on Android or plugin not available — ignore
  }
}

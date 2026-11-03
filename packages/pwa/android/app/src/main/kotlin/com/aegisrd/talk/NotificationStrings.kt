package com.aegisrd.talk

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * NotificationStrings — 原生通知多國語系工具
 *
 * 透過 SharedPreferences 橋接 JS i18n 系統。
 * JS 層在語言切換 / App 啟動時呼叫 NotificationStringsPlugin.sync()，
 * 將翻譯文字存入 SharedPreferences，原生服務直接讀取。
 */
object NotificationStrings {

    private const val TAG = "NotifStrings"
    private const val PREFS_NAME = "notification_strings"
    private const val KEY_JSON = "strings_json"

    // ==================== Data class ====================

    data class Strings(
        // Message notifications
        val newMessage: String = "You have a new message",
        val messageSent: String = "{name} sent a message",

        // Call notifications
        val incomingCall: String = "Incoming call",
        val incomingVideoCall: String = "Incoming video call",
        val isCallingYou: String = "{name} is calling you",
        val unknownCaller: String = "Unknown",

        // Guardian alerts
        val guardianAlert: String = "Guardian Alert",
        val checkInOverdue: String = "Check-in Overdue",
        val riskDetected: String = "Risk Detected",
        val paymentWarning: String = "Payment Warning",
        val suspiciousLink: String = "Suspicious Link",
        val familyMember: String = "Family",
        val notCheckedIn: String = "{name} has not checked in on time",
        val fraudDetected: String = "Potential fraud detected for {name}",
        val riskyTransfer: String = "{name} may be making a risky transfer",
        val suspiciousLinkDetected: String = "Suspicious link detected for {name}",
        val newGuardianNotification: String = "New guardian notification received",

        // Check-in
        val checkInReminder: String = "Check-in Reminder",
        val checkInBody: String = "Time to check in with your family",
        val checkInConfirmed: String = "Check-in Confirmed",
        val hasCheckedIn: String = "{name} has checked in",
        val checkIn: String = "Check-in",
        val checkInNotification: String = "Check-in notification",

        // Notification channels
        val channelMessages: String = "Messages",
        val channelMessagesDesc: String = "New message notifications",
        val channelCalls: String = "Incoming Calls",
        val channelCallsDesc: String = "Incoming voice and video calls",
        val channelGuardian: String = "Guardian Alerts",
        val channelGuardianDesc: String = "Guardian protection alerts",
        val channelGuardianProtection: String = "Guardian Protection",
        val channelGuardianProtectionDesc: String = "Shows when guardian protection is active",
    )

    // ==================== Load / Save ====================

    fun load(context: Context): Strings {
        return try {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val jsonStr = prefs.getString(KEY_JSON, null) ?: return Strings()
            val json = JSONObject(jsonStr)
            val defaults = Strings()

            Strings(
                newMessage = json.optString("newMessage", defaults.newMessage),
                messageSent = json.optString("messageSent", defaults.messageSent),
                incomingCall = json.optString("incomingCall", defaults.incomingCall),
                incomingVideoCall = json.optString("incomingVideoCall", defaults.incomingVideoCall),
                isCallingYou = json.optString("isCallingYou", defaults.isCallingYou),
                unknownCaller = json.optString("unknownCaller", defaults.unknownCaller),
                guardianAlert = json.optString("guardianAlert", defaults.guardianAlert),
                checkInOverdue = json.optString("checkInOverdue", defaults.checkInOverdue),
                riskDetected = json.optString("riskDetected", defaults.riskDetected),
                paymentWarning = json.optString("paymentWarning", defaults.paymentWarning),
                suspiciousLink = json.optString("suspiciousLink", defaults.suspiciousLink),
                familyMember = json.optString("familyMember", defaults.familyMember),
                notCheckedIn = json.optString("notCheckedIn", defaults.notCheckedIn),
                fraudDetected = json.optString("fraudDetected", defaults.fraudDetected),
                riskyTransfer = json.optString("riskyTransfer", defaults.riskyTransfer),
                suspiciousLinkDetected = json.optString("suspiciousLinkDetected", defaults.suspiciousLinkDetected),
                newGuardianNotification = json.optString("newGuardianNotification", defaults.newGuardianNotification),
                checkInReminder = json.optString("checkInReminder", defaults.checkInReminder),
                checkInBody = json.optString("checkInBody", defaults.checkInBody),
                checkInConfirmed = json.optString("checkInConfirmed", defaults.checkInConfirmed),
                hasCheckedIn = json.optString("hasCheckedIn", defaults.hasCheckedIn),
                checkIn = json.optString("checkIn", defaults.checkIn),
                checkInNotification = json.optString("checkInNotification", defaults.checkInNotification),
                channelMessages = json.optString("channelMessages", defaults.channelMessages),
                channelMessagesDesc = json.optString("channelMessagesDesc", defaults.channelMessagesDesc),
                channelCalls = json.optString("channelCalls", defaults.channelCalls),
                channelCallsDesc = json.optString("channelCallsDesc", defaults.channelCallsDesc),
                channelGuardian = json.optString("channelGuardian", defaults.channelGuardian),
                channelGuardianDesc = json.optString("channelGuardianDesc", defaults.channelGuardianDesc),
                channelGuardianProtection = json.optString("channelGuardianProtection", defaults.channelGuardianProtection),
                channelGuardianProtectionDesc = json.optString("channelGuardianProtectionDesc", defaults.channelGuardianProtectionDesc),
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load notification strings: ${e.message}")
            Strings()
        }
    }

    fun save(context: Context, jsonStr: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_JSON, jsonStr)
            .apply()
        Log.d(TAG, "Notification strings saved (${jsonStr.length} bytes)")
    }

    // ==================== Helpers ====================

    /** Replace {name} placeholder */
    fun format(template: String, name: String): String {
        return template.replace("{name}", name)
    }
}

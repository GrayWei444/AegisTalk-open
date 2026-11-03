package com.aegisrd.talk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * AegisTalk FCM Service — Phase 20 多類型離線通知
 *
 * 接收 VPS FCM data message，根據 type 路由到不同通知樣式：
 * - message: 一般訊息通知（零內容，不顯示是誰）
 * - incoming_call: 全螢幕來電通知（30s 震動 + IncomingCallActivity）
 * - guardian_alert: 守護警報通知（高優先級）
 * - check_in: 報平安提醒通知
 *
 * A5（移植群星，code review 2026-09-29）：伺服器只給**已驗簽的**寄件者公鑰 senderPubkey，不轉發任何名字。
 * 名字一律查本機聯絡人（LocalSenders），陌生人／已封鎖的守護警報與報平安不顯示。
 *
 * 開源第 5d 步（docs/DIRECT_SEALED.md §4「Push ring」）：senderPubkey 是推播伺服器說的 —— 營運方能讓手機用好友的名字
 * 全螢幕響鈴。現在全螢幕來電只看**來電者自己簽的響鈴 token**（ringToken，RingToken.kt）：好友簽的、寄給我、±5 分鐘
 * （校正到伺服器的時鐘，RingContextStore）、這個 callId 沒響過，才全螢幕響鈴、顯示本機存的名字。驗不過（偽造、陌生人、
 * 封鎖、重放、太舊、沒有 token、還沒登入／讀不到資料庫）→ 不響、不顯示名字，只有一則一般通知。
 * 守護警報／報平安只在官方版（社群版的伺服器也不送）。
 *
 * 所有 FCM 都是 data message（非 notification message），
 * 確保 App 在背景/被殺死時都能觸發 onMessageReceived()。
 *
 * 通知文字透過 NotificationStrings 從 SharedPreferences 讀取（JS i18n 同步）。
 */
class AegisFCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "AegisFCM"

        // Notification channels
        private const val MSG_CHANNEL_ID = "aegistalk_messages"
        private const val CALL_CHANNEL_ID = "aegistalk_calls"
        private const val GUARDIAN_CHANNEL_ID = "aegistalk_guardian"

        // Notification IDs (different IDs so they don't overwrite each other)
        private const val MSG_NOTIFICATION_ID = 500
        private const val CALL_NOTIFICATION_ID = 501
        private const val GUARDIAN_NOTIFICATION_ID = 502
        private const val CHECKIN_NOTIFICATION_ID = 503
    }

    private val manager: NotificationManager by lazy {
        getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    }

    private fun strings(): NotificationStrings.Strings = NotificationStrings.load(this)

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        val type = data["type"] ?: "message"
        if (BuildConfig.DEBUG) Log.d(TAG, "FCM received: type=$type, from=${message.from}, foreground=${MainActivity.isInForeground}")

        // App 在前景時，訊息已透過 MQTT/P2P 即時收到，不需要額外通知
        // incoming_call 例外（需要全螢幕來電 UI）
        if (MainActivity.isInForeground && type != "incoming_call") {
            if (BuildConfig.DEBUG) Log.d(TAG, "App is in foreground, skipping notification for type=$type")
            return
        }

        // Ensure channels exist
        createNotificationChannels()

        when (type) {
            "incoming_call" -> showIncomingCallNotification(data)
            // 守護功能只在官方版（開源第 5d 步）：社群版當一般訊息（零內容）
            "guardian_alert" -> if (EditionPlugins.OFFICIAL) showGuardianAlertNotification(data) else showMessageNotification(data)
            "check_in" -> if (EditionPlugins.OFFICIAL) showCheckInNotification(data) else showMessageNotification(data)
            else -> showMessageNotification(data)
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (BuildConfig.DEBUG) Log.d(TAG, "FCM token refreshed: ${token.take(20)}...")

        // Store new token in SharedPreferences for JS layer to pick up
        val prefs = getSharedPreferences("fcm_prefs", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("fcm_token", token)
            .putBoolean("token_needs_sync", true)
            .apply()
    }

    // ============================================
    // Message notification (standard)
    // ============================================

    @Suppress("UNUSED_PARAMETER")
    private fun showMessageNotification(data: Map<String, String>) {
        val s = strings()
        // 零內容推播（ADR-016）：伺服器不給寄件者，也就不顯示是誰
        val body = s.newMessage

        val launchIntent = createLaunchIntent("from_fcm" to "true")
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, MSG_CHANNEL_ID)
            .setContentTitle(appLabel())   // 官方版 "AegisTalk"；社群版是它自己的名字
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setDefaults(NotificationCompat.DEFAULT_VIBRATE or NotificationCompat.DEFAULT_SOUND)
            .build()

        manager.notify(MSG_NOTIFICATION_ID, notification)
    }

    // ============================================
    // Incoming call notification (full-screen)
    // ============================================

    private fun showIncomingCallNotification(data: Map<String, String>) {
        val s = strings()
        // 來電者簽的響鈴 token（開源第 5d 步）：只有好友能讓我響（同 voiceCall.handleCallRequest）—— 好友 ＝ 本機聯絡人、沒封鎖
        //   （LocalSenders.Friend；同群但不是好友、陌生人、封鎖、讀不到資料庫都不算；封鎖名單查不了 ＝ 封鎖，審查 L2）
        val ctx = RingContextStore.load(this)
        var friendName = ""
        val verdict = RingToken.verify(
            token = data["ringToken"], prefix = RingToken.PREFIX, me = ctx.me, sender = data["senderPubkey"],
            friendKey = { pk ->
                when (val c = LocalSenders.lookup(this, pk, blockListFailsClosed = true)) {
                    is LocalSenders.Sender.Friend -> { friendName = c.name; pk }
                    else -> null
                }
            },
            verifier = RingToken::ed25519, nowMs = System.currentTimeMillis() + RingToken.clampOffset(ctx.offsetMs), seen = RingSeenStore(this),
        )
        if (verdict !is RingToken.Verdict.Ok) {
            if (BuildConfig.DEBUG) Log.d(TAG, "incoming-call push not ringing: ${(verdict as RingToken.Verdict.Rejected).reason}")
            showUnverifiedCallNotification()
            return
        }
        val callerName = friendName.ifEmpty { s.unknownCaller }
        // 視訊與否看 token 裡來電者簽的，不看推播伺服器給的 isVideoCall
        val isVideo = verdict.video

        // Full-screen intent for lock screen display
        val fullScreenIntent = Intent(this, IncomingCallActivity::class.java).apply {
            putExtra("callerName", callerName)
            putExtra("isVideoCall", isVideo)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val fullScreenPending = PendingIntent.getActivity(
            this, 1, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Tap intent (opens app)
        val launchIntent = createLaunchIntent(
            "from_fcm_call" to "true",
            "callerName" to callerName,
            "isVideoCall" to isVideo.toString()
        )
        val tapPending = PendingIntent.getActivity(
            this, 2, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (isVideo) s.incomingVideoCall else s.incomingCall
        val body = NotificationStrings.format(s.isCallingYou, callerName)

        val notification = NotificationCompat.Builder(this, CALL_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(tapPending)
            .setAutoCancel(true)
            .setTimeoutAfter(30_000)
            .setOngoing(true)
            .setVibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000))
            .build()

        manager.notify(CALL_NOTIFICATION_ID, notification)
    }

    /**
     * 響鈴 token 驗不過的來電推播（開源第 5d 步）：不全螢幕、不響鈴、不顯示名字 —— 一則一般通知（訊息頻道），點了開 App
     * （真的來電由 App 用封好的來電信令決定）。App 在前景就什麼都不顯示（來電信令直接進 App）。
     */
    private fun showUnverifiedCallNotification() {
        if (MainActivity.isInForeground) return
        val s = strings()
        val launchIntent = createLaunchIntent("from_fcm" to "true")
        val pendingIntent = PendingIntent.getActivity(
            this, 5, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, MSG_CHANNEL_ID)
            .setContentTitle(appLabel())
            .setContentText(s.incomingCall)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(MSG_NOTIFICATION_ID, notification)
    }

    private fun appLabel(): String = try {
        applicationInfo.loadLabel(packageManager).toString()
    } catch (e: Exception) {
        "AegisTalk"
    }

    // ============================================
    // Guardian alert notification
    // ============================================

    private fun showGuardianAlertNotification(data: Map<String, String>) {
        val s = strings()
        // 零內容喚醒：警報內容（哪一種、哪位家人）走 E2E 加密的 P2P 訊息，打開 App 才看得到。
        // 以前伺服器轉發寄件者自填的 alertType／protectedName → 陌生人能讓人鎖屏跳「〈媽媽〉偵測到詐騙」。
        if (LocalSenders.lookup(this, data["senderPubkey"]) == LocalSenders.Sender.Stranger) {
            if (BuildConfig.DEBUG) Log.d(TAG, "guardian alert from a stranger — not shown")
            return
        }
        val title = s.guardianAlert
        val body = s.newGuardianNotification

        val launchIntent = createLaunchIntent("from_guardian_alert" to "true")
        val pendingIntent = PendingIntent.getActivity(
            this, 3, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, GUARDIAN_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        manager.notify(GUARDIAN_NOTIFICATION_ID, notification)
    }

    // ============================================
    // Check-in reminder notification
    // ============================================

    private fun showCheckInNotification(data: Map<String, String>) {
        val s = strings()
        // 報平安是同群組成員之間的事（不一定是好友）：陌生人／已封鎖的不顯示
        if (LocalSenders.lookup(this, data["senderPubkey"]) == LocalSenders.Sender.Stranger) {
            if (BuildConfig.DEBUG) Log.d(TAG, "check-in from a stranger — not shown")
            return
        }

        val launchIntent = createLaunchIntent("from_checkin" to "true")
        val pendingIntent = PendingIntent.getActivity(
            this, 4, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, MSG_CHANNEL_ID)
            .setContentTitle(s.checkInReminder)
            .setContentText(s.checkInBody)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setDefaults(NotificationCompat.DEFAULT_VIBRATE or NotificationCompat.DEFAULT_SOUND)
            .build()

        manager.notify(CHECKIN_NOTIFICATION_ID, notification)
    }

    // ============================================
    // Helpers
    // ============================================

    private fun createLaunchIntent(vararg extras: Pair<String, String>): Intent {
        return packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            extras.forEach { (key, value) -> putExtra(key, value) }
        } ?: Intent()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val s = strings()

        // Messages channel
        val msgChannel = NotificationChannel(
            MSG_CHANNEL_ID,
            s.channelMessages,
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = s.channelMessagesDesc
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 200, 100, 200)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }

        // Calls channel (highest priority, bypass DND)
        val callChannel = NotificationChannel(
            CALL_CHANNEL_ID,
            s.channelCalls,
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = s.channelCallsDesc
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setBypassDnd(true)
        }

        // Guardian channel
        val guardianChannel = NotificationChannel(
            GUARDIAN_CHANNEL_ID,
            s.channelGuardian,
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = s.channelGuardianDesc
            enableVibration(true)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setBypassDnd(true)
        }

        manager.createNotificationChannel(msgChannel)
        manager.createNotificationChannel(callChannel)
        manager.createNotificationChannel(guardianChannel)
    }
}

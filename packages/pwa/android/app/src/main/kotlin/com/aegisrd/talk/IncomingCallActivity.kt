package com.aegisrd.talk

import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView

/**
 * IncomingCallActivity — FCM 全螢幕來電通知 (Phase 20)
 *
 * 當 App 被殺死後收到語音/視訊來電的 FCM 通知時，
 * 顯示全螢幕來電畫面（鎖屏也能顯示）。
 *
 * - Accept: 開啟 App 並傳遞來電資訊
 * - Reject: 關閉活動
 * - 30 秒後自動消失 → 顯示「未接來電」通知
 */
class IncomingCallActivity : Activity() {

    companion object {
        private const val TAG = "IncomingCall"
        private const val AUTO_DISMISS_MS = 30_000L
        private const val CALL_NOTIFICATION_ID = 501
    }

    private var callerName = ""
    private var isVideoCall = false
    private val handler = Handler(Looper.getMainLooper())

    private val autoDismissRunnable = Runnable {
        Log.i(TAG, "Auto-dismiss after 30s, showing missed call notification")
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show on lock screen + turn screen on
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )

        setContentView(R.layout.activity_incoming_call)

        callerName = intent.getStringExtra("callerName") ?: NotificationStrings.load(this).unknownCaller
        isVideoCall = intent.getBooleanExtra("isVideoCall", false)

        setupUI()

        // Auto-dismiss after 30 seconds
        handler.postDelayed(autoDismissRunnable, AUTO_DISMISS_MS)

        Log.i(TAG, "Showing incoming call: caller=$callerName, video=$isVideoCall")
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoDismissRunnable)
        super.onDestroy()
    }

    private fun setupUI() {
        val titleView: TextView = findViewById(R.id.callTitleTextView)
        val callerView: TextView = findViewById(R.id.callerNameTextView)
        val acceptButton: Button = findViewById(R.id.acceptCallButton)
        val rejectButton: Button = findViewById(R.id.rejectCallButton)

        val s = NotificationStrings.load(this)
        titleView.text = if (isVideoCall) s.incomingVideoCall else s.incomingCall
        callerView.text = callerName

        acceptButton.setOnClickListener { handleAccept() }
        rejectButton.setOnClickListener { handleReject() }
    }

    private fun handleAccept() {
        Log.i(TAG, "User accepted call from $callerName")
        handler.removeCallbacks(autoDismissRunnable)

        // Dismiss the call notification
        dismissCallNotification()

        // Launch main app with call info
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("from_fcm_call", true)
            putExtra("callerName", callerName)
            putExtra("isVideoCall", isVideoCall)
            putExtra("call_action", "accept")
        }
        if (launchIntent != null) {
            startActivity(launchIntent)
        }

        finish()
    }

    private fun handleReject() {
        Log.i(TAG, "User rejected call from $callerName")
        handler.removeCallbacks(autoDismissRunnable)
        dismissCallNotification()
        finish()
    }

    private fun dismissCallNotification() {
        try {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(CALL_NOTIFICATION_ID)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to dismiss call notification: ${e.message}")
        }
    }
}

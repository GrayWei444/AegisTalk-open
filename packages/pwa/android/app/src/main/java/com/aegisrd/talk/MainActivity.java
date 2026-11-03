package com.aegisrd.talk;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;

public class MainActivity extends BridgeActivity {

    /**
     * App 前景狀態旗標 — 供 AegisFCMService 判斷是否顯示通知
     * true = Activity 可見（onResume ~ onPause）
     */
    public static volatile boolean isInForeground = false;

    @Override
    public void onResume() {
        super.onResume();
        isInForeground = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        isInForeground = false;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask 模式下，分享 Intent 走 onNewIntent()
        // 必須 setIntent() 讓 getIntent() 回傳最新的 Intent
        setIntent(intent);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // WebView debugging: only enabled in debug builds
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // 兩個版本都有的外掛
        registerPlugin(FCMTokenPlugin.class);
        registerPlugin(SharePlugin.class);
        registerPlugin(NotificationStringsPlugin.class);
        // 來電推播的響鈴 token 要的「我是誰」與時鐘差（開源第 5d 步，AegisFCMService）
        registerPlugin(RingContextPlugin.class);
        // 這個版本才有的外掛（開源第 5d 步：官方版 src/official/java/.../EditionPlugins.java；社群版沒有）。
        // 官方版的 NetworkShieldPlugin + AegisRuleEnginePlugin auto-register from @aegisrd/guard
        for (Class<? extends Plugin> plugin : EditionPlugins.all()) {
            registerPlugin(plugin);
        }
        super.onCreate(savedInstanceState);

        // 建立通知頻道
        createNotificationChannels();
    }

    /**
     * 建立所有通知頻道
     */
    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager notificationManager = getSystemService(NotificationManager.class);
            if (notificationManager == null) return;

            // 1. 來電通知頻道（高優先級，支援 Heads-up）
            NotificationChannel callChannel = new NotificationChannel(
                "incoming_call_channel",
                "來電通知",
                NotificationManager.IMPORTANCE_HIGH
            );
            callChannel.setDescription("顯示來電通知，包含接聽和拒接按鈕");
            callChannel.enableVibration(true);
            callChannel.setVibrationPattern(new long[]{0, 500, 200, 200, 200, 500, 2000});
            callChannel.setBypassDnd(true);
            callChannel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
            Uri ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            AudioAttributes ringtoneAttr = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            callChannel.setSound(ringtoneUri, ringtoneAttr);
            notificationManager.createNotificationChannel(callChannel);

            // 2. 守護警報頻道（高優先級，報平安提醒 + 期限檢查）：守護功能只在官方版（開源第 5d 步）
            if (!EditionPlugins.OFFICIAL) return;
            NotificationChannel guardianChannel = new NotificationChannel(
                "guardian_alert_channel",
                "守護通知",
                NotificationManager.IMPORTANCE_HIGH
            );
            guardianChannel.setDescription("報平安提醒、守護警報通知");
            guardianChannel.enableVibration(true);
            guardianChannel.setVibrationPattern(new long[]{0, 300, 200, 300});
            guardianChannel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
            Uri notifUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes notifAttr = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            guardianChannel.setSound(notifUri, notifAttr);
            notificationManager.createNotificationChannel(guardianChannel);
        }
    }
}

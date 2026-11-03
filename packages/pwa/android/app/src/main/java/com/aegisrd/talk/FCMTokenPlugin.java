package com.aegisrd.talk;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;

/**
 * FCMTokenPlugin — Phase 20 FCM Token 管理
 *
 * 讀取 AegisFCMService.onNewToken() 存在 SharedPreferences 的 FCM token，
 * 供 JS 層取得並上報到 VPS API。
 */
@CapacitorPlugin(name = "FCMTokenPlugin")
public class FCMTokenPlugin extends Plugin {
    private static final String TAG = "FCMTokenPlugin";
    private static final String FCM_PREFS = "fcm_prefs";

    /**
     * Get the current FCM token from SharedPreferences.
     * Returns { token: string | null, needsSync: boolean }
     */
    @PluginMethod
    public void getToken(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(FCM_PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString("fcm_token", null);
        boolean needsSync = prefs.getBoolean("token_needs_sync", false);

        JSObject ret = new JSObject();
        ret.put("token", token);
        ret.put("needsSync", needsSync);
        call.resolve(ret);
    }

    /**
     * Firebase 有沒有初始化（開源第 5d 步：兩個版本都有這個外掛；社群版沒放 google-services.json ＝ 沒有 FCM）。
     * PushNotifications.register() 在 Firebase 沒初始化時會讓原生線程當掉（JS 接不到），JS 先問這裡。
     */
    @PluginMethod
    public void hasFirebase(PluginCall call) {
        boolean available = false;
        try {
            FirebaseApp.getInstance();
            available = true;
        } catch (IllegalStateException e) {
            Log.w(TAG, "Firebase not initialized (no google-services.json in this build)");
        }
        JSObject ret = new JSObject();
        ret.put("available", available);
        call.resolve(ret);
    }

    /**
     * Mark the token as synced (clear the needs_sync flag).
     */
    @PluginMethod
    public void markSynced(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(FCM_PREFS, Context.MODE_PRIVATE);
        prefs.edit().putBoolean("token_needs_sync", false).apply();

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
        Log.d(TAG, "FCM token marked as synced");
    }
}

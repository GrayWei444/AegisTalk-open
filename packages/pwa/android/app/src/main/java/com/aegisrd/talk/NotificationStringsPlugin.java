package com.aegisrd.talk;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * NotificationStringsPlugin — Capacitor 橋接
 *
 * JS 層呼叫 sync() 將翻譯文字存入 SharedPreferences，
 * 供 AegisFCMService、IncomingCallActivity 等原生端使用。
 */
@CapacitorPlugin(name = "NotificationStrings")
public class NotificationStringsPlugin extends Plugin {

    @PluginMethod()
    public void sync(PluginCall call) {
        String stringsJson = call.getString("strings");
        if (stringsJson == null || stringsJson.isEmpty()) {
            call.reject("strings parameter required");
            return;
        }

        NotificationStrings.INSTANCE.save(getContext(), stringsJson);

        JSObject ret = new JSObject();
        ret.put("synced", true);
        call.resolve(ret);
    }
}

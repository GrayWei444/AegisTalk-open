package com.aegisrd.talk;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.regex.Pattern;

/**
 * 原生驗來電推播的響鈴 token 要的「我是誰」與時鐘差（開源第 5d 步；JS：src/plugins/ringContext.ts、services/ringSync.ts）。
 * AegisFCMService 收到 incoming_call 時用它們驗 token（RingToken）；登出／被踢／換機時 clear()。兩個版本都有。
 */
@CapacitorPlugin(name = "RingContext")
public class RingContextPlugin extends Plugin {
    private static final Pattern PUBKEY = Pattern.compile("^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$");
    /** 時鐘差最多採信一年（再多就是壞資料） */
    private static final double MAX_OFFSET_MS = 365.0 * 24 * 60 * 60 * 1000;

    @PluginMethod
    public void set(PluginCall call) {
        String me = call.getString("me");
        Double offset = call.getDouble("clockOffsetMs");
        if (me == null || !PUBKEY.matcher(me).matches()) {
            call.reject("me must be an identity public key");
            return;
        }
        if (offset == null || offset.isNaN() || offset.isInfinite() || Math.abs(offset) > MAX_OFFSET_MS) {
            call.reject("clockOffsetMs out of range");
            return;
        }
        RingContextStore.INSTANCE.save(getContext(), me, Math.round(offset));
        JSObject ret = new JSObject();
        ret.put("saved", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        RingContextStore.INSTANCE.clear(getContext());
        JSObject ret = new JSObject();
        ret.put("cleared", true);
        call.resolve(ret);
    }
}

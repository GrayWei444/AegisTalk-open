package com.aegisrd.talk;

import com.getcapacitor.Plugin;

import java.util.Collections;
import java.util.List;

/**
 * 社群版（flavour chat，開源第 5d 步）：沒有官方版才有的原生外掛（USB 偵錯偵測、守護／報平安、Google Drive、原生 ONNX、
 * MoonPay；NetworkShield／規則引擎的 @aegisrd/guard 也不編進來）。官方版的同名類別在 src/official/java。
 */
final class EditionPlugins {
    private EditionPlugins() {}

    /** 這個版本是不是官方版（守護的通知頻道、FCM 的守護推播型別） */
    static final boolean OFFICIAL = false;

    static List<Class<? extends Plugin>> all() {
        return Collections.emptyList();
    }
}

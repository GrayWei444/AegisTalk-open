package com.aegisrd.talk

import android.content.Context

/**
 * 原生驗響鈴 token（RingToken）要的本機資料（開源第 5d 步）：
 *   RingContextStore  我的身分公鑰、校正到伺服器的時鐘差 —— JS 登入後經 RingContextPlugin.set 寫進來，登出／被踢／換機時 clear
 *   RingSeenStore     看過的 callId（一個 callId 只響一次），最多記 MAX_SEEN 個
 * 好友名單不在這裡：AegisFCMService 用 LocalSenders 讀 App 自己的 SQLite（封鎖的不算好友）。
 */
object RingContextStore {
    private const val PREFS = "ring_context"
    private const val KEY_ME = "me"
    private const val KEY_OFFSET = "clock_offset_ms"

    data class Ctx(val me: String?, val offsetMs: Long)

    /** 時鐘差最多採信 ±5 分鐘（RingToken.clampOffset；寫、讀都夾 —— 安全審查 H2） */
    fun load(context: Context): Ctx {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Ctx(p.getString(KEY_ME, null), RingToken.clampOffset(p.getLong(KEY_OFFSET, 0L)))
    }

    fun save(context: Context, me: String, offsetMs: Long) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ME, me)
            .putLong(KEY_OFFSET, RingToken.clampOffset(offsetMs))
            .commit()
    }

    /** 帳號離開這台：「我是誰」、時鐘差、看過的 callId 都清掉（commit：清完才回，reload 前就落地） */
    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        RingSeenStore.clear(context)
    }
}

/** 看過的 callId：記錄留到 untilMs，照**本機**時鐘清（營運方撥得動 API 的時鐘差，撥不動本機時鐘；安全審查 H2） */
class RingSeenStore(context: Context, private val clock: () -> Long = { System.currentTimeMillis() }) : RingToken.Seen {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun seen(callId: String): Boolean = prefs.getLong(callId, -1L) >= clock()

    override fun remember(callId: String, untilMs: Long) {
        val edit = prefs.edit()
        val all = prefs.all.entries.mapNotNull { e -> (e.value as? Long)?.let { e.key to it } }
        RingToken.seenToPrune(all, clock(), MAX_SEEN).forEach { edit.remove(it) }
        edit.putLong(callId, untilMs).commit()
    }

    companion object {
        private const val PREFS = "ring_seen"
        private const val MAX_SEEN = 256

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }
}

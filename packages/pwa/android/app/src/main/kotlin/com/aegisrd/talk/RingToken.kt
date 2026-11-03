package com.aegisrd.talk

import com.google.crypto.tink.subtle.Ed25519Verify
import java.io.ByteArrayOutputStream

/**
 * 來電推播的響鈴 token（開源第 5d 步，docs/DIRECT_SEALED.md §4「Push ring」）— 原生這一條路（AegisFCMService）的驗證。
 *
 * 規則跟 JS 的 packages/pwa/src/services/ringToken.ts 一模一樣，用同一組測試向量
 * （app/src/test/resources/ring_token_vectors.json，由 scripts/review/ring_token_self_test.mjs 產生、JS 與這裡各驗一次）：
 *   token ＝ "r1." + base64url(claims) + "." + base64url(Ed25519 簽章)
 *   claims 只收一種寫法：{"v":1,"d":前綴,"callId":…,"from":…,"to":…,"iat":…,"nonce":…,"video":…}（CLAIMS_RE，不用 JSON 解析器）
 *   簽章內容 ＝ "前綴:" ‖ claims 的原始位元組
 *   形狀 → 網域 → to 是我 → from 等於推播說的寄件人 → from 是好友（沒封鎖）→ 簽章 → ±5 分鐘（有上限的伺服器時鐘：
 *   本機時鐘＋API 的時鐘差，差最多採信 ±5 分鐘 —— 安全審查 H2）→ 這個 callId 沒響過（只記驗過的；記錄留 20 分鐘、照本機時鐘清）
 * 驗過才全螢幕響鈴、顯示本機存的名字；其他一律不響、不顯示名字（AegisFCMService 只顯示一則一般通知）。
 * 純 Kotlin：不碰 Android API（JVM 單元測試直接跑）；Ed25519 用 Tink（純 Java，minSdk 24 也能用）。
 */
object RingToken {
    const val PREFIX = "aegistalk-ring-v1"
    const val MAX_AGE_MS = 5 * 60_000L
    const val MAX_FUTURE_MS = 5 * 60_000L
    const val MAX_LEN = 1024
    /** API 的時鐘差最多採信多少（＝ JS 的 RING_CLOCK_CAP_MS、W5 的 boundedNow） */
    const val CLOCK_CAP_MS = 5 * 60_000L
    /** 看過的 callId 留多久（以 iat 起算，照本機時鐘清；＝ JS 的 RING_SEEN_RETENTION_MS） */
    const val SEEN_RETENTION_MS = MAX_AGE_MS + MAX_FUTURE_MS + 2 * CLOCK_CAP_MS

    /** 時鐘差夾到 ±CLOCK_CAP_MS */
    fun clampOffset(offsetMs: Long): Long = offsetMs.coerceIn(-CLOCK_CAP_MS, CLOCK_CAP_MS)
    /** JS Number.isSafeInteger 的上限：iat 超過它 JS 那邊不收，這裡也不收 */
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    private val PREFIX_RE = Regex("^[a-z0-9][a-z0-9-]{2,39}$")
    private val TOKEN_RE = Regex("^r1\\.([A-Za-z0-9_-]{40,800})\\.([A-Za-z0-9_-]{86})$")
    private val CLAIMS_RE = Regex(
        "^\\{\"v\":1,\"d\":\"([a-z0-9][a-z0-9-]{2,39})\",\"callId\":\"([A-Za-z0-9_-]{22})\"," +
            "\"from\":\"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)\",\"to\":\"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)\"," +
            "\"iat\":([1-9][0-9]{0,15}),\"nonce\":\"([A-Za-z0-9_-]{22})\",\"video\":(true|false)\\}$"
    )

    sealed class Verdict {
        data class Ok(val from: String, val callId: String, val video: Boolean, val iat: Long) : Verdict()
        data class Rejected(val reason: String) : Verdict()
    }

    /** 看過的 callId（一個 callId 只響一次）：App 存在 SharedPreferences（RingSeenStore），測試用記憶體；留到 untilMs，照本機時鐘清 */
    interface Seen {
        fun seen(callId: String): Boolean
        fun remember(callId: String, untilMs: Long)
    }

    /** 要清掉哪些（＝ JS 的 ringSeenToPrune）：照本機時鐘過期的先清；還是滿的（max 筆）就清最早到期的 */
    fun seenToPrune(entries: Collection<Pair<String, Long>>, deviceNowMs: Long, max: Int): List<String> {
        val out = ArrayList<String>()
        var size = entries.size
        for ((k, until) in entries.sortedBy { it.second }) {
            if (size < max && until >= deviceNowMs) break
            out.add(k)
            size -= 1
        }
        return out
    }

    /** Ed25519 驗章（Tink）；任何例外 ＝ 不對 */
    fun ed25519(publicKey: ByteArray, data: ByteArray, signature: ByteArray): Boolean = try {
        Ed25519Verify(publicKey).verify(signature, data)
        true
    } catch (e: Exception) {
        false
    }

    private class Parsed(
        val prefix: String, val callId: String, val from: String, val to: String, val iat: Long, val video: Boolean,
        val claims: ByteArray, val sig: ByteArray,
    )

    private fun parse(token: String): Parsed? {
        if (token.length > MAX_LEN) return null
        val m = TOKEN_RE.matchEntire(token) ?: return null
        val claims = B64.decode(m.groupValues[1], url = true) ?: return null
        val sig = B64.decode(m.groupValues[2], url = true) ?: return null
        if (sig.size != 64 || claims.any { it < 0 }) return null     // claims 只能是 ASCII（樣式本來就只有 ASCII）
        val c = CLAIMS_RE.matchEntire(String(claims, Charsets.US_ASCII)) ?: return null
        val iat = c.groupValues[5].toLongOrNull() ?: return null
        if (iat > MAX_SAFE_INTEGER) return null
        return Parsed(c.groupValues[1], c.groupValues[2], c.groupValues[3], c.groupValues[4], iat, c.groupValues[7] == "true", claims, sig)
    }

    /**
     * token：推播的 ringToken；me：我的身分公鑰（RingContext）；sender：推播說的寄件人（senderPubkey，有給就要等於 from）；
     * friendKey：好友（沒封鎖的）存著的身分金鑰，不是好友 → null；nowMs：有上限的伺服器時鐘（本機 ＋ clampOffset(時鐘差)）。
     */
    fun verify(
        token: String?, prefix: String, me: String?, sender: String?,
        friendKey: (String) -> String?, verifier: (ByteArray, ByteArray, ByteArray) -> Boolean, nowMs: Long, seen: Seen,
    ): Verdict {
        require(PREFIX_RE.matches(prefix)) { "bad ring token prefix" }
        if (token.isNullOrEmpty()) return Verdict.Rejected("missing")
        val p = parse(token) ?: return Verdict.Rejected("malformed")
        if (p.prefix != prefix) return Verdict.Rejected("wrong-domain")
        if (me.isNullOrEmpty()) return Verdict.Rejected("no-context")
        if (p.to != me) return Verdict.Rejected("wrong-recipient")
        if (sender != null && sender != p.from) return Verdict.Rejected("sender-mismatch")
        val stored = try { friendKey(p.from) } catch (e: Exception) { null }
        val key = stored?.let { B64.decode(it, url = false) }
        if (key == null || key.size != 32) return Verdict.Rejected("unknown-caller")
        val signed = "$prefix:".toByteArray(Charsets.US_ASCII) + p.claims
        val good = try { verifier(key, signed, p.sig) } catch (e: Exception) { false }
        if (!good) return Verdict.Rejected("bad-signature")
        if (nowMs - p.iat > MAX_AGE_MS) return Verdict.Rejected("stale")
        if (p.iat - nowMs > MAX_FUTURE_MS) return Verdict.Rejected("future")
        if (seen.seen(p.callId)) return Verdict.Rejected("replay")
        seen.remember(p.callId, p.iat + SEEN_RETENTION_MS)
        return Verdict.Ok(p.from, p.callId, p.video, p.iat)
    }
}

/** base64（標準，補 =）／base64url（不補 =）：只收正規寫法（重新編碼要一模一樣），跟 ringToken.ts 的 b64Decode 一樣 */
internal object B64 {
    private const val STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(bytes: ByteArray, url: Boolean): String {
        val alphabet = if (url) URL else STD
        val sb = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xff
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else -1
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xff else -1
            sb.append(alphabet[b0 shr 2])
            sb.append(alphabet[((b0 and 0x03) shl 4) or (if (b1 >= 0) b1 shr 4 else 0)])
            if (b1 >= 0) sb.append(alphabet[((b1 and 0x0f) shl 2) or (if (b2 >= 0) b2 shr 6 else 0)]) else if (!url) sb.append('=')
            if (b2 >= 0) sb.append(alphabet[b2 and 0x3f]) else if (!url) sb.append('=')
            i += 3
        }
        return sb.toString()
    }

    fun decode(s: String, url: Boolean): ByteArray? {
        val alphabet = if (url) URL else STD
        if (!url && s.length % 4 != 0) return null
        val body = if (url) s else s.trimEnd('=')
        if (body.length % 4 == 1) return null
        val out = ByteArrayOutputStream()
        var buf = 0
        var bits = 0
        for (ch in body) {
            val v = alphabet.indexOf(ch)
            if (v < 0) return null
            buf = ((buf shl 6) or v) and 0xffffff
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buf shr bits) and 0xff)
            }
        }
        val bytes = out.toByteArray()
        return if (encode(bytes, url) == s) bytes else null
    }
}

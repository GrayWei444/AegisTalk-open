package com.aegisrd.talk

import com.google.crypto.tink.subtle.Ed25519Sign
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生的響鈴 token 驗證（RingToken.kt，開源第 5d 步）：
 *   1. 跨實作的測試向量（src/test/resources/ring_token_vectors.json，由 scripts/review/ring_token_self_test.mjs 產生、JS 也驗同一份）
 *   2. 這裡自己用 Tink 簽的 token：好友簽的、寄給我、新鮮 → 響；偽造的簽章、寄給別人、重放、太舊、陌生人 → 不響；
 *      偽造的不能先佔掉真的 callId
 *   3. base64 只收正規寫法
 */
class RingTokenTest {
    /** 跟 RingSeenStore 同一套：留到 untilMs，照「本機」時鐘（device）清 */
    private class MemSeen(var device: Long = 1_900_000_000_000L, val max: Int = 256) : RingToken.Seen {
        val m = HashMap<String, Long>()
        override fun seen(callId: String) = (m[callId] ?: -1L) >= device
        override fun remember(callId: String, untilMs: Long) {
            RingToken.seenToPrune(m.entries.map { it.key to it.value }, device, max).forEach { m.remove(it) }
            m[callId] = untilMs
        }
    }

    private class Id {
        val pair: Ed25519Sign.KeyPair = Ed25519Sign.KeyPair.newKeyPair()
        val pk: String = B64.encode(pair.publicKey, url = false)
        fun sign(data: ByteArray): ByteArray = Ed25519Sign(pair.privateKey).sign(data)
    }

    private val now = 1_900_000_000_000L
    private val friend = Id()
    private val me = Id()
    private val mallory = Id()
    private val other = Id()
    private var counter = 0

    private fun callId(): String = "callId-%015d".format(++counter)
    private fun nonce(): String = "nonce-%016d".format(counter)

    private fun token(
        from: Id = friend, to: Id = me, signer: Id = from, iat: Long = now, callId: String = callId(), video: Boolean = false,
        prefix: String = RingToken.PREFIX,
    ): String {
        val claims = "{\"v\":1,\"d\":\"$prefix\",\"callId\":\"$callId\",\"from\":\"${from.pk}\",\"to\":\"${to.pk}\"," +
            "\"iat\":$iat,\"nonce\":\"${nonce()}\",\"video\":$video}"
        val bytes = claims.toByteArray(Charsets.US_ASCII)
        val sig = signer.sign("$prefix:".toByteArray(Charsets.US_ASCII) + bytes)
        return "r1." + B64.encode(bytes, url = true) + "." + B64.encode(sig, url = true)
    }

    private fun verify(
        token: String?, sender: String? = friend.pk, myKey: String? = me.pk, friends: Set<String> = setOf(friend.pk),
        seen: RingToken.Seen = MemSeen(), at: Long = now,
    ): String = when (val v = RingToken.verify(token, RingToken.PREFIX, myKey, sender, { pk -> if (pk in friends) pk else null },
        RingToken::ed25519, at, seen)) {
        is RingToken.Verdict.Ok -> "ok"
        is RingToken.Verdict.Rejected -> v.reason
    }

    @Test
    fun crossImplementationVectors() {
        val stream = javaClass.classLoader!!.getResourceAsStream("ring_token_vectors.json")
        val v = JSONObject(stream!!.bufferedReader().readText())
        val friends = v.getJSONArray("friends").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        val cases = v.getJSONArray("cases")
        val seen = MemSeen()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val tok = if (c.isNull("token")) null else c.getString("token")
            val myKey = if (c.isNull("me")) null else c.getString("me")
            val sender = if (c.isNull("sender")) null else c.getString("sender")
            val verdict = RingToken.verify(tok, v.getString("prefix"), myKey, sender, { pk -> if (pk in friends) pk else null },
                RingToken::ed25519, v.getLong("now"), seen)
            val got = if (verdict is RingToken.Verdict.Ok) "ok" else (verdict as RingToken.Verdict.Rejected).reason
            assertEquals(c.getString("name"), c.getString("expect"), got)
            if (verdict is RingToken.Verdict.Ok) assertEquals(c.getString("name"), c.getBoolean("video"), verdict.video)
        }
        assertTrue("vectors present", cases.length() >= 20)
    }

    @Test
    fun validTokenRings() {
        val id = callId()
        val v = RingToken.verify(token(callId = id, video = true), RingToken.PREFIX, me.pk, friend.pk, { if (it == friend.pk) it else null },
            RingToken::ed25519, now, MemSeen())
        assertEquals(RingToken.Verdict.Ok(friend.pk, id, true, now), v)
    }

    @Test
    fun forgedSignatureDoesNotRing() {
        assertEquals("bad-signature", verify(token(signer = mallory)))
    }

    @Test
    fun wrongRecipientDoesNotRing() {
        assertEquals("wrong-recipient", verify(token(to = other)))
        assertEquals("no-context", verify(token(), myKey = null))
        assertEquals("sender-mismatch", verify(token(), sender = mallory.pk))
    }

    @Test
    fun replayDoesNotRing() {
        val seen = MemSeen()
        val id = callId()
        val t = token(callId = id)
        assertEquals("ok", verify(t, seen = seen))
        assertEquals("replay", verify(t, seen = seen))
        assertEquals("replay", verify(token(callId = id), seen = seen))
    }

    @Test
    fun staleOrFutureDoesNotRing() {
        assertEquals("stale", verify(token(iat = now - RingToken.MAX_AGE_MS - 1)))
        assertEquals("future", verify(token(iat = now + RingToken.MAX_FUTURE_MS + 1)))
        assertEquals("ok", verify(token(iat = now - RingToken.MAX_AGE_MS)))
        assertEquals("ok", verify(token(iat = now + RingToken.MAX_FUTURE_MS)))
    }

    @Test
    fun unknownFriendDoesNotRing() {
        assertEquals("unknown-caller", verify(token(from = mallory), sender = mallory.pk))
        assertEquals("unknown-caller", verify(token(), friends = emptySet()))
        assertEquals("missing", verify(null))
        assertEquals("wrong-domain", verify(token(prefix = "other-ring-v1")))
    }

    @Test
    fun forgedTokensDoNotBurnTheCallId() {
        val seen = MemSeen()
        val id = callId()
        assertEquals("bad-signature", verify(token(callId = id, signer = mallory), seen = seen))
        assertEquals("unknown-caller", verify(token(callId = id, from = mallory), sender = mallory.pk, seen = seen))
        assertEquals("ok", verify(token(callId = id), seen = seen))
    }

    @Test
    fun clockOffsetIsCappedAndSeenCallsOutliveTheirWindow() {
        // 安全審查 H2：API 的時鐘差最多採信 ±5 分鐘
        assertEquals(RingToken.CLOCK_CAP_MS, RingToken.clampOffset(365L * 24 * 3_600_000))
        assertEquals(-RingToken.CLOCK_CAP_MS, RingToken.clampOffset(-20 * 60_000L))
        assertEquals(1234L, RingToken.clampOffset(1234L))
        // 營運方謊報時鐘：本機時鐘慢 20 分鐘、說差 20 分鐘 → 只採信 5 分鐘 → 現在的 token 看起來是 15 分鐘後的
        val device = now - 20 * 60_000L
        assertEquals("future", verify(token(), at = device + RingToken.clampOffset(20 * 60_000L)))
        // 響過的記錄照本機時鐘留到 iat ＋ 20 分鐘：營運方把時鐘差撥回去（最多 5 分鐘）重放，記錄一定還在
        val seen = MemSeen(device = now)
        val id = callId()
        val t = token(callId = id)
        assertEquals("ok", verify(t, seen = seen))
        seen.device = now + 9 * 60_000L
        token(callId = callId()).also { assertEquals("ok", verify(it, seen = seen, at = now + 4 * 60_000L)) }   // 別的來電觸發清理
        assertEquals("still remembered 9 min later (device clock)", "replay", verify(t, seen = seen, at = seen.device - RingToken.CLOCK_CAP_MS))
        seen.device = now + RingToken.SEEN_RETENTION_MS + 1
        verify(token(callId = callId(), iat = seen.device), seen = seen, at = seen.device)
        assertFalse("pruned only after iat + 20 min on the device clock", seen.m.containsKey(id))
        // 滿了才清最早到期的
        assertEquals(listOf("a"), RingToken.seenToPrune(listOf("a" to 5L, "b" to 9L), 0L, 2))
        assertEquals(listOf("a"), RingToken.seenToPrune(listOf("b" to 9L, "a" to 1L), 2L, 10))
        assertEquals(emptyList<String>(), RingToken.seenToPrune(listOf("a" to 5L), 0L, 10))
    }

    @Test
    fun base64IsCanonical() {
        val bytes = ByteArray(64) { it.toByte() }
        val url = B64.encode(bytes, url = true)
        assertEquals(86, url.length)
        assertTrue(B64.decode(url, url = true)!!.contentEquals(bytes))
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val spare = url.dropLast(1) + alphabet[alphabet.indexOf(url.last()) + 1]
        assertNull("the same bytes written with spare bits set", B64.decode(spare, url = true))
        val seven = ByteArray(32) { 7.toByte() }
        val std = B64.encode(seven, url = false)
        assertEquals(44, std.length)
        assertTrue(std.endsWith("="))
        assertTrue(B64.decode(std, url = false)!!.contentEquals(seven))
        assertNull(B64.decode(std.dropLast(1), url = false))
        assertNull(B64.decode("a-b_", url = false))
        assertNull(B64.decode("ab+/", url = true))
        assertFalse(RingToken.ed25519(ByteArray(32), ByteArray(1), ByteArray(64)))
    }
}

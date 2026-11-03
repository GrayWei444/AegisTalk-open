package com.aegisrd.talk

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log

/**
 * 推播／背景訊息的寄件者 → 這台手機自己的聯絡人（移植群星 A5，code review 2026-09-29）。
 *
 * 伺服器（推播簽章）與 broker（主題上的寄件者那一節）只保證「是哪一把公鑰送的」；要顯示的名字一律查本機
 * （App 的 SQLite），不信任寄件者自己帶的名字 —— 以前任何人都能讓別人的手機鎖屏跳「〈媽媽〉來電」、
 * 「〈媽媽〉偵測到詐騙」。
 *
 * 資料庫：capacitor-sqlite 的 `aegistalkSQLite.db`（database.ts DB_NAME＋"SQLite.db"；
 * capacitor.config androidIsEncryption=false，所以這裡讀得到）。表：contacts、group_members、groups、
 * local_user_blacklist（pubkey 欄位是後來 migration 加的，跟 JS isBlacklisted 用同一欄）。
 */
object LocalSenders {
    private const val TAG = "LocalSenders"
    private const val DB_FILE = "aegistalkSQLite.db"

    sealed class Sender {
        /** 好友（聯絡人）；name 是本機存的暱稱，可能是空字串 */
        data class Friend(val name: String) : Sender()
        /** 不是好友、但跟我在同一個群組（守護群組的家人常常不是好友） */
        data class GroupMember(val name: String) : Sender()
        /** 不認識，或已封鎖 */
        object Stranger : Sender()
        /** 讀不到資料庫（第一次啟動、檔案被鎖）—— 不知道 */
        object Unknown : Sender()
    }

    sealed class Membership {
        data class Member(val groupName: String) : Membership()
        object NotMember : Membership()
        object Unknown : Membership()
    }

    private fun <T> withDb(context: Context, unknown: T, block: (SQLiteDatabase) -> T): T {
        val file = context.getDatabasePath(DB_FILE)
        if (!file.exists()) return unknown
        return try {
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use(block)
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.w(TAG, "local lookup failed", e)
            unknown
        }
    }

    private fun blocked(db: SQLiteDatabase, pubkey: String, failClosed: Boolean = false): Boolean = try {
        db.rawQuery("SELECT 1 FROM local_user_blacklist WHERE pubkey = ?", arrayOf(pubkey)).use { it.moveToFirst() }
    } catch (e: Exception) {
        failClosed   // 舊資料庫還沒有 pubkey 欄位：一般通知照舊（不擋），全螢幕來電當成封鎖（開源第 5d 步審查 L2）
    }

    /**
     * 已驗證的寄件者公鑰 → 本機認不認識他、叫什麼。已封鎖算 Stranger。
     * blockListFailsClosed：封鎖名單查不了就當成封鎖（全螢幕來電用；同 JS 那邊的 isBlacklisted(...).catch(() => true)）
     */
    fun lookup(context: Context, pubkey: String?, blockListFailsClosed: Boolean = false): Sender {
        if (pubkey.isNullOrEmpty()) return Sender.Unknown
        return withDb(context, Sender.Unknown) { db ->
            when {
                blocked(db, pubkey, blockListFailsClosed) -> Sender.Stranger
                else -> db.rawQuery("SELECT nickname FROM contacts WHERE pubkey = ?", arrayOf(pubkey)).use { c ->
                    if (c.moveToFirst()) Sender.Friend(c.getString(0) ?: "") else null
                } ?: db.rawQuery("SELECT nickname FROM group_members WHERE pubkey = ? LIMIT 1", arrayOf(pubkey)).use { c ->
                    if (c.moveToFirst()) Sender.GroupMember(c.getString(0) ?: "") else Sender.Stranger
                }
            }
        }
    }

    /** 寄件者是不是本機名冊上 groupId 的成員；是的話順便回本機存的群組名稱（不用寄件者自己填的） */
    fun membership(context: Context, groupId: String, pubkey: String?): Membership {
        if (groupId.isEmpty() || pubkey.isNullOrEmpty()) return Membership.NotMember
        return withDb(context, Membership.Unknown) { db ->
            if (blocked(db, pubkey)) return@withDb Membership.NotMember
            val member = db.rawQuery("SELECT 1 FROM group_members WHERE group_id = ? AND pubkey = ?",
                arrayOf(groupId, pubkey)).use { it.moveToFirst() }
            if (!member) return@withDb Membership.NotMember
            val name = db.rawQuery("SELECT name FROM groups WHERE id = ?", arrayOf(groupId)).use { c ->
                if (c.moveToFirst()) c.getString(0) ?: "" else ""
            }
            Membership.Member(name)
        }
    }
}

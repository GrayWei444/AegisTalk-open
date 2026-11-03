"""
用量計數（SQLite，跨重啟、灌很多 key 也擠不掉別人的計數）：

  admit_topics      每個帳號（沒帳號就是那把金鑰）24 小時內 token 拿到的不同群組／presence 主題數（W5 §6：限制猜主題）
  count_events／record_event   新帳號註冊的每 IP、全部的每小時／每天上限（accounts.py）

存的不是主題、IP 本身，而是 HMAC（截短），金鑰 ＝ 這個資料庫自己的隨機鹽再用伺服器的秘密（configure，chat_app／main.py 用
AEGIS_MQTT_JWT_SECRET 推出來）混過：只為了比對「同一個」。只拿到資料庫的人沒有那個秘密，不能把 2^32 個 IPv4 全算一遍對回去
（第 3 步審查 M；沒有呼叫 configure 的測試只用資料庫的鹽）。換 MQTT secret ＝ 計數重來。主題雜湊最多留 TOPIC_WINDOW 秒、
註冊事件最多留 1 天。營運方本來就看得到 token 請求裡的主題與連線 IP，這裡只是不讓它們在磁碟上留得比額度需要的更久。
"""
import hashlib
import hmac
import os
from typing import Iterable

TOPIC_WINDOW = 86400
EVENT_KEEP = 86400
_pepper = {"key": b""}


def configure(server_secret: str) -> None:
    """雜湊金鑰另外混進伺服器的秘密（不在資料庫裡）；啟動時呼叫一次"""
    _pepper["key"] = hmac.new(server_secret.encode(), b"aegistalk-chat-usage-v1", hashlib.sha256).digest()


def create_tables(cursor) -> None:
    cursor.execute("CREATE TABLE IF NOT EXISTS chat_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    cursor.execute("""CREATE TABLE IF NOT EXISTS mqtt_topic_grants (
        owner TEXT NOT NULL, topic_hash TEXT NOT NULL, first_at INTEGER NOT NULL,
        PRIMARY KEY (owner, topic_hash))""")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_mqtt_topic_grants_time ON mqtt_topic_grants(first_at)")
    cursor.execute("CREATE TABLE IF NOT EXISTS usage_events (scope TEXT NOT NULL, created_at INTEGER NOT NULL)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_scope ON usage_events(scope, created_at)")


def salt(cursor, name: str) -> bytes:
    """這個資料庫自己的隨機鹽（第一次用到時產生並存起來）"""
    cursor.execute("INSERT OR IGNORE INTO chat_meta (k, v) VALUES (?, ?)", (f"salt:{name}", os.urandom(32).hex()))
    db_salt = bytes.fromhex(cursor.execute("SELECT v FROM chat_meta WHERE k = ?", (f"salt:{name}",)).fetchone()[0])
    return hmac.new(_pepper["key"], db_salt, hashlib.sha256).digest() if _pepper["key"] else db_salt


def keyed_hash(key: bytes, value: str) -> str:
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()[:32]


def admit_topics(cursor, owner: str, topics: Iterable[str], now: int, per_day: int) -> bool:
    """
    owner 在 24 小時內拿到的不同主題加上這次新的，超過 per_day → False（什麼都不記）；否則記下新的、回 True。
    已經拿過的主題不重算（每小時換一次 token 不會吃額度）；呼叫端在同一個交易裡 commit。
    """
    key = salt(cursor, "topics")
    cursor.execute("DELETE FROM mqtt_topic_grants WHERE first_at <= ?", (now - TOPIC_WINDOW,))
    wanted = list(dict.fromkeys(keyed_hash(key, t) for t in topics))
    if not wanted:
        return True
    have = {r[0] for r in cursor.execute("SELECT topic_hash FROM mqtt_topic_grants WHERE owner = ?", (owner,))}
    new = [h for h in wanted if h not in have]
    if len(have) + len(new) > per_day:
        return False
    cursor.executemany("INSERT INTO mqtt_topic_grants (owner, topic_hash, first_at) VALUES (?, ?, ?)",
                       [(owner, h, now) for h in new])
    return True


def event_scope(cursor, kind: str, value: str = "") -> str:
    """計數的範圍：kind 加上 value（IP 之類）的鹽雜湊；value 空 ＝ 全部"""
    return f"{kind}|{keyed_hash(salt(cursor, 'events'), value)}" if value else f"{kind}|*"


def count_events(cursor, scope: str, since: int) -> int:
    return int(cursor.execute("SELECT COUNT(*) FROM usage_events WHERE scope = ? AND created_at > ?", (scope, since)).fetchone()[0])


def record_event(cursor, scope: str, now: int) -> None:
    cursor.execute("DELETE FROM usage_events WHERE created_at <= ?", (now - EVENT_KEEP,))
    cursor.execute("INSERT INTO usage_events (scope, created_at) VALUES (?, ?)", (scope, now))

"""
帳戶簽章與一次性 request_id（chat 端點共用；搬自 api/main.py，行為不變）。

- 請求由帳戶身份金鑰（Ed25519）簽：簽章內容＝要簽的欄位（不含 signature）按 key 排序的 JSON，
  時間戳 ±DEVICE_TIMESTAMP_TOLERANCE 秒內有效，公鑰與簽章只收標準 base64 寫法。
- 公鑰 → 帳號：pubkey_account_map（pubkey_hash ＝ sha256(base64 公鑰字串)）。官方站由 AegisID 寫入，
  獨立的 chat 伺服器由 keys-only 註冊（accounts.py，POST /api/account/register）寫入；
  create_chat_routers 的 account_source 就是這個查詢（預設 resolve_account_key）。
- 時鐘差：check_clock 在驗簽之前回 401 {code: clock_skew, server_time}（client 校正後重簽）。
- 「重放會拿到新東西」的端點用 consume_request_nonce：同一個 (scope, action, request_id) 第二次 → 409。
"""
import base64 as _b64
import hashlib
import json as _json
import time
from typing import Callable, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

DEVICE_TIMESTAMP_TOLERANCE = 300  # 5 分鐘

#: 簽章在 ±300 秒（DEVICE_TIMESTAMP_TOLERANCE）內有效，nonce 只需要活過那個窗口
REQUEST_NONCE_TTL = 2 * 300 + 60


def create_tables(cursor) -> None:
    """一次性 request_id 與 pubkey → 帳號（init_database 呼叫）"""
    # 一次性 request_id（MQTT token）：簽章在 ±300 秒內有效，重放會替重放的人換到一張新憑證
    cursor.execute("""CREATE TABLE IF NOT EXISTS request_nonces (
        scope TEXT NOT NULL, action TEXT NOT NULL, nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(scope, action, nonce))""")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_request_nonces_created ON request_nonces(created_at)")

    # pubkey → account_key 映射表（一個 account_key 可對應多個 pubkey）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pubkey_account_map (
            pubkey_hash TEXT PRIMARY KEY,
            account_key TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_pam_account_key ON pubkey_account_map(account_key)
    """)


def b64_canonical(value: str) -> bytes:
    """只接受 bytes 的標準（含 padding）base64 寫法：解得開、而且重新編碼要一字不差。"""
    raw = _b64.b64decode(value, validate=True)
    if _b64.b64encode(raw).decode() != value:
        raise ValueError("non-canonical base64")
    return raw


def is_pubkey_b64(value: object) -> bool:
    """Ed25519 公鑰的標準 base64（44 字元、32 bytes）。"""
    try:
        return isinstance(value, str) and len(b64_canonical(value)) == 32
    except Exception:
        return False


def verify_device_signature(
    pubkey_b64: str,
    signature_b64: str,
    payload: dict,
    timestamp: int,
) -> bool:
    """驗證 Ed25519 簽章 + 時間戳新鮮度

    payload 為要簽章的 dict（不含 pubkey/signature 欄位），按 key 排序後 JSON 序列化。
    """
    # 時間戳容忍窗
    now = int(time.time())
    if abs(now - timestamp) > DEVICE_TIMESTAMP_TOLERANCE:
        return False

    try:
        # **只收標準寫法**（對應群星 B4）。非嚴格解碼時同一把金鑰有很多種字串寫法（改掉最後一個字元沒用到的位元、
        # 夾雜非字母字元），而 pubkey → 帳號、nonce 範圍都是拿字串本身算 hash —— 換個寫法就繞過了。
        pubkey_bytes = b64_canonical(pubkey_b64)
        signature_bytes = b64_canonical(signature_b64)
        if len(pubkey_bytes) != 32 or len(signature_bytes) != 64:
            return False

        # 簽章對象：JSON.stringify(payload) — 客戶端需用相同的 sorted JSON
        # ⚠️ ensure_ascii=False 是必要的：Python 預設把非 ASCII 寫成 \uXXXX，JS 的 JSON.stringify 輸出原字元，
        #   簽章內容只要有一個中文字（例如裝置名稱）兩邊就對不上、一律 401（對應群星 2026-08-18）。
        #   純 ASCII 的 payload 加不加輸出完全一樣。
        message = _json.dumps(payload, sort_keys=True, separators=(',', ':'),
                              ensure_ascii=False).encode('utf-8')

        verify_key = Ed25519PublicKey.from_public_bytes(pubkey_bytes)
        verify_key.verify(signature_bytes, message)
        return True
    except (InvalidSignature, ValueError, Exception):
        return False


def check_clock(timestamp: int) -> None:
    """
    手機時鐘差太多（時間戳在 ±DEVICE_TIMESTAMP_TOLERANCE 外）→ 401 {"code": "clock_skew", "server_time": 伺服器現在幾秒}，
    跟 /api/mqtt/token 同一個形狀：client 用 server_time 校正後重簽一次。伺服器時間不是秘密；簽章錯的請求照樣在之後 401。
    在驗簽**之前**呼叫（不然時鐘差的請求只會拿到 invalid_signature_or_timestamp，client 不知道該校正）。
    """
    now = int(time.time())
    if not isinstance(timestamp, int) or abs(now - timestamp) > DEVICE_TIMESTAMP_TOLERANCE:
        raise HTTPException(status_code=401, detail={"code": "clock_skew", "server_time": now})


def pubkey_hash_of(pubkey: str) -> str:
    """pubkey_account_map 的 key：sha256(base64 字串本身)（跟 AegisID 寫入端一致，不是解碼後的 bytes）"""
    return hashlib.sha256(pubkey.encode()).hexdigest()


def consume_request_nonce(cursor, scope: str, action: str, nonce: str) -> None:
    """
    一次性 request_id：同一個 (scope, action, nonce) 第二次出現 → 409（對應群星 B18）。
    用在「重放會拿到新東西」的端點（MQTT token：重放＝替偷看到請求的人換一張新的連線憑證），
    所以**不回快取結果**（那會把同一張 token 交給重放的人）。
    """
    now = int(time.time())
    cursor.execute("DELETE FROM request_nonces WHERE created_at < ?", (now - REQUEST_NONCE_TTL,))
    cursor.execute("INSERT OR IGNORE INTO request_nonces (scope, action, nonce, created_at) VALUES (?,?,?,?)",
                   (scope, action, nonce, now))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail="request_replayed")


def resolve_account_key(cursor, pubkey_hash: str) -> Optional[str]:
    """透過 pubkey_account_map 解析 pubkey_hash → account_key（create_chat_routers 預設的 account_source）"""
    cursor.execute(
        "SELECT account_key FROM pubkey_account_map WHERE pubkey_hash = ?",
        (pubkey_hash,)
    )
    row = cursor.fetchone()
    return row["account_key"] if row else None


#: account_source(cursor, pubkey_hash) → account_key 或 None
AccountSource = Callable[..., Optional[str]]


def make_signed_account(db: Callable, account_source: AccountSource) -> Callable[[str, str, dict, int], Tuple[str, str]]:
    """
    signed_account(pubkey, signature, payload, timestamp) → (account_key, pubkey_hash)：
    驗帳戶簽章（±300 秒、只收標準 base64）並解析 account_key（對應群星 _wallet_account）。
    簽章不對 → 401；公鑰沒有對到帳號 → 403。db() 是回傳 sqlite 連線（row_factory = Row）的 context manager。
    """
    def signed_account(pubkey: str, signature: str, payload: dict, timestamp: int) -> Tuple[str, str]:
        if not verify_device_signature(pubkey, signature, payload, timestamp):
            raise HTTPException(status_code=401, detail="invalid_signature_or_timestamp")
        # 跟 pubkey_account_map 寫入端一致：hash base64 字串本身
        pubkey_hash = hashlib.sha256(pubkey.encode()).hexdigest()
        with db() as conn:
            account_key = account_source(conn.cursor(), pubkey_hash)
        if not account_key:
            raise HTTPException(status_code=403, detail="account_not_registered")
        return account_key, pubkey_hash

    return signed_account

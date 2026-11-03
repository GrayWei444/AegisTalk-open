"""
好友短碼系統（Friend Short Code）。

6 位短碼 → 一份公開的 X3DH 預備金鑰組（公鑰、signed pre-key、簽章、暱稱），24 小時有效。

register／refresh 要兩個簽章（開源計畫第 3 步，移植群星 _authorize_shortcode；以前不驗簽 —— 知道別人公鑰的人
能覆蓋別人短碼背後的預備金鑰、名字，或用 refresh 作廢別人的短碼）：
  - request_signature：帳戶身分金鑰（public_key）簽 {"action": "register_shortcode"|"refresh_shortcode", public_key,
    signed_pre_key, signature, display_name, timestamp, request_id}（排序 JSON，同 signing.verify_device_signature）
  - signature：同一把身分金鑰對 signed_pre_key 原始 bytes 的簽章（X3DH 的 signed pre-key 簽章；查到碼的人本來就要驗它）
  - 公鑰要對到已註冊的帳號（403；匿名金鑰不能在這張表寫東西）、時鐘差 → 401 clock_skew、request_id 只能用一次（409）
  - 每 IP 每分鐘 30 次；過期一天的碼順手清掉
查詢每 IP 每分鐘 30 次（稽核 M11）。
"""
import base64 as _b64
import secrets
import time
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .ratelimit import mem_rate_hit, rate_key
from .signing import check_clock, consume_request_nonce, is_pubkey_b64, pubkey_hash_of, verify_device_signature

SHORTCODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 排除 I/O/0/1
SHORTCODE_LENGTH = 6
SHORTCODE_TTL = 86400  # 24 小時
#: 註冊／換新每 IP 每分鐘（只擋驗兩個簽章的 CPU）
SHORTCODE_WRITE_IP_LIMIT = 30


def create_tables(cursor) -> None:
    """Phase 20: 好友短碼"""
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS friend_shortcodes (
            short_code TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            signed_pre_key TEXT NOT NULL,
            signature TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_shortcodes_pubkey ON friend_shortcodes(public_key)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_shortcodes_expires ON friend_shortcodes(expires_at)")


def generate_short_code() -> str:
    """產生 6 位隨機短碼"""
    return "".join(secrets.choice(SHORTCODE_CHARSET) for _ in range(SHORTCODE_LENGTH))


class ShortCodeRegisterRequest(BaseModel):
    """註冊／換新短碼請求（register 與 refresh 同一個形狀，簽章的 action 不同）"""
    model_config = ConfigDict(extra="forbid")
    public_key: str = Field(..., min_length=40, max_length=128)
    # 群星 B1：以前沒有長度上限 —— 一次請求就能寫進 600KB 的 prekey
    signed_pre_key: str = Field(..., min_length=10, max_length=128)
    signature: str = Field(..., min_length=10, max_length=128)
    display_name: str = Field(..., min_length=1, max_length=50)
    timestamp: int
    request_id: str = Field(..., min_length=16, max_length=128)
    request_signature: str = Field(..., min_length=80, max_length=128)
    #: client 把簽章內容原樣送來（含 action）；驗章一律用端點自己的 action，送別的值只會讓簽章對不上（401）
    action: Optional[str] = Field(None, max_length=32)


class ShortCodeResponse(BaseModel):
    """短碼回應"""
    short_code: str
    expires_at: int
    remaining_seconds: int
    is_new: bool


class ShortCodeLookupResponse(BaseModel):
    """短碼查詢回應（與前端 lookupShortCode 格式一致）"""
    v: int = 1
    pk: str
    spk: str
    sig: str
    name: str
    expires_at: int


def shortcode_signed_payload(body: ShortCodeRegisterRequest, action: str) -> dict:
    """request_signature 簽的內容（排序 JSON）"""
    return {"action": action, "public_key": body.public_key, "signed_pre_key": body.signed_pre_key,
            "signature": body.signature, "display_name": body.display_name,
            "timestamp": body.timestamp, "request_id": body.request_id}


def prekey_signature_ok(public_key: str, signed_pre_key: str, signature: str) -> bool:
    """X3DH：身分金鑰（Ed25519）對 signed pre-key 原始 bytes 的簽章（同 crypto-core x3dh.rs verify_signed_prekey）"""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        Ed25519PublicKey.from_public_bytes(_b64.b64decode(public_key, validate=True)).verify(
            _b64.b64decode(signature, validate=True), _b64.b64decode(signed_pre_key, validate=True))
        return True
    except Exception:
        return False


def _purge_expired(cursor, now: int) -> None:
    """群星 B1：過期的短碼以前永遠不刪（lookup 只是不回）。過期一天後清掉"""
    cursor.execute("DELETE FROM friend_shortcodes WHERE expires_at < ?", (now - 86400,))


def _new_code(cursor) -> str:
    for _ in range(10):
        code = generate_short_code()
        if not cursor.execute("SELECT 1 FROM friend_shortcodes WHERE short_code = ?", (code,)).fetchone():
            return code
    raise HTTPException(status_code=503, detail="shortcode_space_busy")


def create_shortcode_router(db: Callable, proxy_guard, account_source: Optional[Callable] = None) -> APIRouter:
    """
    /api/shortcode/register|refresh|lookup（proxy_guard: config.ProxyGuard，每 IP 限速用；
    account_source(cursor, pubkey_hash) → 帳號或 None，預設 signing.resolve_account_key）
    """
    from .signing import resolve_account_key
    router = APIRouter()
    lookup_rate: dict = {}   # ip -> [epoch,...]
    write_rate: dict = {}    # ip -> [epoch,...]
    account_of = account_source or resolve_account_key

    def authorize(req: Request, body: ShortCodeRegisterRequest, action: str) -> str:
        """限速 → 時鐘 → 兩個簽章 → 帳號；回傳 pubkey_hash"""
        if not mem_rate_hit(write_rate, rate_key(proxy_guard.client_ip(req)), 60, SHORTCODE_WRITE_IP_LIMIT, time.time()):
            raise HTTPException(status_code=429, detail="rate_limited")
        check_clock(body.timestamp)
        if not is_pubkey_b64(body.public_key):
            raise HTTPException(status_code=401, detail="invalid_shortcode_signature")
        if not verify_device_signature(body.public_key, body.request_signature, shortcode_signed_payload(body, action), body.timestamp):
            raise HTTPException(status_code=401, detail="invalid_shortcode_signature")
        if not prekey_signature_ok(body.public_key, body.signed_pre_key, body.signature):
            raise HTTPException(status_code=401, detail="invalid_prekey_signature")
        scope = pubkey_hash_of(body.public_key)
        with db() as conn:
            if not account_of(conn.cursor(), scope):
                raise HTTPException(status_code=403, detail="account_not_registered")
        return scope

    @router.post("/api/shortcode/register", response_model=ShortCodeResponse)
    def register_shortcode(request: ShortCodeRegisterRequest, req: Request):
        """註冊或取得現有短碼。若已有未過期的短碼則更新它背後的預備金鑰並返回，否則建立新的。"""
        scope = authorize(req, request, "register_shortcode")
        now = int(time.time())
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            consume_request_nonce(cursor, scope, "register_shortcode", request.request_id)
            _purge_expired(cursor, now)
            row = cursor.execute("""
                SELECT short_code, expires_at FROM friend_shortcodes
                WHERE public_key = ? AND expires_at > ?
                ORDER BY expires_at DESC LIMIT 1
            """, (request.public_key, now)).fetchone()
            if row:
                # 已有未過期短碼：更新 signed_pre_key/signature/display_name（B 重新安裝或金鑰重產後，舊短碼仍指向舊 key）
                cursor.execute("UPDATE friend_shortcodes SET signed_pre_key = ?, signature = ?, display_name = ? WHERE short_code = ?",
                               (request.signed_pre_key, request.signature, request.display_name, row["short_code"]))
                conn.commit()
                return ShortCodeResponse(short_code=row["short_code"], expires_at=row["expires_at"],
                                         remaining_seconds=row["expires_at"] - now, is_new=False)
            code = _new_code(cursor)
            expires_at = now + SHORTCODE_TTL
            cursor.execute("""
                INSERT INTO friend_shortcodes
                (short_code, public_key, signed_pre_key, signature, display_name, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (code, request.public_key, request.signed_pre_key, request.signature, request.display_name, now, expires_at))
            conn.commit()
            return ShortCodeResponse(short_code=code, expires_at=expires_at, remaining_seconds=SHORTCODE_TTL, is_new=True)

    @router.post("/api/shortcode/refresh", response_model=ShortCodeResponse)
    def refresh_shortcode(request: ShortCodeRegisterRequest, req: Request):
        """強制產生新短碼，舊碼立即失效。"""
        scope = authorize(req, request, "refresh_shortcode")
        now = int(time.time())
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            consume_request_nonce(cursor, scope, "refresh_shortcode", request.request_id)
            cursor.execute("DELETE FROM friend_shortcodes WHERE public_key = ?", (request.public_key,))
            _purge_expired(cursor, now)
            code = _new_code(cursor)
            expires_at = now + SHORTCODE_TTL
            cursor.execute("""
                INSERT INTO friend_shortcodes
                (short_code, public_key, signed_pre_key, signature, display_name, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (code, request.public_key, request.signed_pre_key, request.signature, request.display_name, now, expires_at))
            conn.commit()
            return ShortCodeResponse(short_code=code, expires_at=expires_at, remaining_seconds=SHORTCODE_TTL, is_new=True)

    @router.get("/api/shortcode/lookup/{code}", response_model=ShortCodeLookupResponse)
    def lookup_shortcode(code: str, req: Request):
        """查詢短碼，返回好友資訊。每 IP 每分鐘 30 次。"""
        # 稽核 M11：以前不限速 —— 32^6 的碼空間、24h 有效，掃描就能收集公鑰與暱稱，
        #   掃到的人還能拿著碼直接加碼主人好友。正常人只會輸入一次碼，30 次/分很寬。
        if not mem_rate_hit(lookup_rate, rate_key(proxy_guard.client_ip(req)), 60, 30, time.time()):
            raise HTTPException(status_code=429, detail="rate_limited")
        cleaned = code.strip().upper().replace("ATK-", "")
        now = int(time.time())

        with db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT public_key, signed_pre_key, signature, display_name, expires_at
                FROM friend_shortcodes
                WHERE short_code = ? AND expires_at > ?
            """, (cleaned, now))
            row = cursor.fetchone()

            if not row:
                raise HTTPException(status_code=404, detail="Short code not found or expired")

            return ShortCodeLookupResponse(
                v=1,
                pk=row["public_key"],
                spk=row["signed_pre_key"],
                sig=row["signature"],
                name=row["display_name"],
                expires_at=row["expires_at"],
            )

    return router

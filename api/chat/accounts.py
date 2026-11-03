"""
Keys-only 帳號（開源計畫決定 1，伺服器那一半）：沒有 AegisID 的 chat 伺服器上，帳號＝一把身分金鑰（Ed25519）。

  POST /api/account/register   body {pubkey, timestamp, request_id, invite_code?, signature}
    簽章內容＝{"action": "account_register", pubkey, timestamp, request_id, invite_code（有給才有）}（排序 JSON，
    同 signing.verify_device_signature）；時鐘差 → 401 {code: clock_skew, server_time}；request_id 只能用一次（409）。
    成功 → pubkey_account_map 多一列（account_key 是伺服器自己的隨機值，永不在 wire 上出現）→ 裝置 claim、推播、
    群組 log、短碼、MQTT token 都認得這個帳號（官方站同一張表由 AegisID 寫）。
    已經註冊過的金鑰 → 200 {"created": false}（不吃邀請碼、不算額度）。

政策 CHAT_REGISTRATION（自架預設 invite，決定 7）：
  open    誰都能註冊（仍受下面的上限）
  invite  要邀請碼（python -m chat.invites create；碼只存 SHA-256，可設次數與期限）：沒給 403 invite_required、
          不對／用完／過期 403 invalid_invite；每個 IP 每小時猜錯 INVITE_FAILURES_PER_IP_HOUR 次之後 429
  closed  不開放新帳號（403 registration_closed；已經有帳號的照常用）
上限（新帳號才算，存在 SQLite、跨重啟）：每個 IP 每小時／每天、全部每小時／每天（ChatConfig.register_limits）→ 429
另有每 IP 每分鐘 REQUESTS_PER_IP_MIN 次的粗略上限（只擋驗簽的 CPU）。IP 只存鹽雜湊、留 1 天（usage.py）。
"""
import hashlib
import secrets
import time
from typing import Callable, List, Optional

from .signing import consume_request_nonce, pubkey_hash_of, resolve_account_key
from . import usage

ACTION = "account_register"
REQUESTS_PER_IP_MIN = 30
INVITE_FAILURES_PER_IP_HOUR = 10
INVITE_CODE_PATTERN = r"^[A-Za-z0-9_-]{16,64}$"


class AccountError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def create_tables(cursor) -> None:
    """邀請碼（只存 SHA-256）；pubkey_account_map 在 signing.create_tables，計數在 usage.create_tables"""
    cursor.execute("""CREATE TABLE IF NOT EXISTS account_invites (
        code_hash TEXT PRIMARY KEY, uses_left INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')""")


def invite_hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def create_invite(cursor, *, uses: int = 1, days: float = 7, note: str = "", now: Optional[int] = None) -> str:
    """新的邀請碼（24 個 URL-safe 字元、144 bits）；回傳碼本身（只有這一次看得到）"""
    if uses < 1 or days <= 0:
        raise ValueError("uses must be >= 1 and days > 0")
    now = int(time.time()) if now is None else now
    code = secrets.token_urlsafe(18)
    cursor.execute("INSERT INTO account_invites (code_hash, uses_left, expires_at, created_at, note) VALUES (?, ?, ?, ?, ?)",
                   (invite_hash(code), uses, now + int(days * 86400), now, note[:200]))
    return code


def list_invites(cursor, now: Optional[int] = None) -> List[dict]:
    now = int(time.time()) if now is None else now
    rows = cursor.execute("SELECT code_hash, uses_left, expires_at, created_at, note FROM account_invites ORDER BY created_at").fetchall()
    return [{"id": r[0][:12], "uses_left": r[1], "expires_at": r[2], "created_at": r[3], "note": r[4],
             "active": r[1] > 0 and r[2] > now} for r in rows]


def revoke_invite(cursor, code_or_id: str) -> int:
    """用碼本身或 list 顯示的 id（hash 前 12 字元）作廢"""
    if len(code_or_id) >= 16:
        cursor.execute("DELETE FROM account_invites WHERE code_hash = ?", (invite_hash(code_or_id),))
        if cursor.rowcount:
            return cursor.rowcount
    if len(code_or_id) == 12 and all(c in "0123456789abcdef" for c in code_or_id):
        cursor.execute("DELETE FROM account_invites WHERE substr(code_hash, 1, 12) = ?", (code_or_id,))
        return cursor.rowcount
    return 0


def register_signed_payload(pubkey: str, timestamp: int, request_id: str, invite_code: Optional[str]) -> dict:
    payload = {"action": ACTION, "pubkey": pubkey, "timestamp": timestamp, "request_id": request_id}
    if invite_code is not None:
        payload["invite_code"] = invite_code
    return payload


def _check_limits(cursor, limits, ip: str, now: int) -> None:
    ip_scope = usage.event_scope(cursor, "register-ip", ip)
    all_scope = usage.event_scope(cursor, "register")
    for scope, per_hour, per_day in ((ip_scope, limits.ip_per_hour, limits.ip_per_day),
                                     (all_scope, limits.per_hour, limits.per_day)):
        if usage.count_events(cursor, scope, now - 3600) >= per_hour or usage.count_events(cursor, scope, now - 86400) >= per_day:
            raise AccountError(429, "registration_rate_limited")


def register_account(conn, *, pubkey: str, request_id: str, invite_code: Optional[str], policy: str, limits,
                     ip: str, now: Optional[int] = None, account_source: Callable = resolve_account_key) -> bool:
    """
    簽章已驗過的金鑰註冊（一個交易：BEGIN IMMEDIATE）。回傳 True ＝ 新帳號、False ＝ 本來就有。
    檢查順序：request_id 沒用過 → 已經有帳號（直接成功）→ 政策 → 上限 → 邀請碼（扣一次）→ 寫入。任何一項不過整筆不寫。
    """
    now = int(time.time()) if now is None else now
    key_hash = pubkey_hash_of(pubkey)
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.cursor()
        consume_request_nonce(cursor, key_hash, ACTION, request_id)
        if account_source(cursor, key_hash):
            conn.commit()
            return False
        if policy == "closed":
            raise AccountError(403, "registration_closed")
        if policy == "invite" and not invite_code:
            raise AccountError(403, "invite_required")
        _check_limits(cursor, limits, ip, now)
        if policy == "invite":
            row = cursor.execute("SELECT uses_left, expires_at FROM account_invites WHERE code_hash = ?",
                                 (invite_hash(invite_code),)).fetchone()
            if not row or row[0] <= 0 or row[1] <= now:
                raise AccountError(403, "invalid_invite")
            cursor.execute("UPDATE account_invites SET uses_left = uses_left - 1 WHERE code_hash = ?", (invite_hash(invite_code),))
        cursor.execute("INSERT INTO pubkey_account_map (pubkey_hash, account_key, created_at) VALUES (?, ?, ?)",
                       (key_hash, "chat_" + secrets.token_hex(16), now))
        usage.record_event(cursor, usage.event_scope(cursor, "register-ip", ip), now)
        usage.record_event(cursor, usage.event_scope(cursor, "register"), now)
        conn.commit()
        return True
    except BaseException:
        conn.rollback()
        raise


def create_account_router(cfg, db: Callable, proxy_guard, account_source: Callable = resolve_account_key):
    """POST /api/account/register（cfg: ChatConfig 的 registration 與 register_limits）"""
    from fastapi import APIRouter, HTTPException, Request
    from pydantic import BaseModel, ConfigDict, Field

    from .ratelimit import mem_rate_hit, mem_rate_peek, rate_key
    from .signing import check_clock, is_pubkey_b64, verify_device_signature

    policy = cfg.registration
    if policy not in ("open", "invite", "closed"):
        raise ValueError(f"unknown registration policy {policy!r}")
    router = APIRouter()
    request_rate: dict = {}
    invite_failures: dict = {}

    class AccountRegisterRequest(BaseModel):
        model_config = ConfigDict(extra="forbid")
        pubkey: str = Field(..., min_length=40, max_length=128)
        timestamp: int
        request_id: str = Field(..., min_length=16, max_length=128)
        invite_code: Optional[str] = Field(None, pattern=INVITE_CODE_PATTERN)
        signature: str = Field(..., min_length=80, max_length=128)
        #: client 把簽章內容原樣送來（含 action）；驗章一律用固定的 "account_register"
        action: Optional[str] = Field(None, max_length=32)

    @router.post("/api/account/register")
    def account_register(body: AccountRegisterRequest, req: Request):
        ip = rate_key(proxy_guard.client_ip(req))   # IPv6：整個 /64 算一個
        now_f = time.time()
        if not mem_rate_hit(request_rate, ip, 60, REQUESTS_PER_IP_MIN, now_f):
            raise HTTPException(status_code=429, detail="rate_limited")
        if not mem_rate_peek(invite_failures, ip, 3600, INVITE_FAILURES_PER_IP_HOUR, now_f):
            raise HTTPException(status_code=429, detail="too_many_invite_attempts")
        check_clock(body.timestamp)
        if not is_pubkey_b64(body.pubkey):
            raise HTTPException(status_code=401, detail="invalid_signature_or_timestamp")
        payload = register_signed_payload(body.pubkey, body.timestamp, body.request_id, body.invite_code)
        if not verify_device_signature(body.pubkey, body.signature, payload, body.timestamp):
            raise HTTPException(status_code=401, detail="invalid_signature_or_timestamp")
        with db() as conn:
            try:
                created = register_account(conn, pubkey=body.pubkey, request_id=body.request_id, invite_code=body.invite_code,
                                           policy=policy, limits=cfg.register_limits, ip=ip, now=int(now_f),
                                           account_source=account_source)
            except AccountError as e:
                if e.code == "invalid_invite":
                    mem_rate_hit(invite_failures, ip, 3600, INVITE_FAILURES_PER_IP_HOUR + 1, now_f)
                raise HTTPException(status_code=e.status, detail=e.code)
        return {"registered": True, "created": created, "registration": policy}

    return router

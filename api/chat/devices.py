"""
Phase 35: 單設備強制登入（搬自 api/main.py）。

一個 account_key 任一時刻只允許 1 台設備在線。
新設備 claim 瞬間 INSERT OR REPLACE → 舊設備 row 被覆蓋 →
舊設備下次 heartbeat 收 valid:false → 立即登出（Phase 35b：另外用 MQTT 即時通知舊裝置，mqtt_auth.publish_mqtt_kick）。

簽章驗證：所有 endpoint 需 Ed25519 簽章 + 5 分鐘時間戳容忍窗。
pubkey 反查 pubkey_account_map → account_key（永不在 wire 上明文出現）。帳號來源：官方站 AegisID，獨立的 chat 伺服器
keys-only 註冊（POST /api/account/register）—— 兩邊都寫 pubkey_account_map，所以沒有帳號的回應不再提 AegisID。
端點是一般函式（FastAPI 放進 threadpool）：SQLite 與踢裝置推播（paho，對外連線）不卡 event loop。
"""
import hashlib
import time
from typing import Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .mqtt_auth import publish_mqtt_kick
from .signing import verify_device_signature


def create_tables(cursor) -> None:
    """Phase 35: 單設備強制登入 — 一個 account_key 一台設備"""
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS talk_active_device (
            account_key   TEXT PRIMARY KEY,
            device_id     TEXT NOT NULL,
            pubkey_hash   TEXT NOT NULL,
            platform      TEXT NOT NULL,
            display_label TEXT,
            last_seen     INTEGER NOT NULL,
            created_at    INTEGER NOT NULL
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_active_device_pubkey ON talk_active_device(pubkey_hash)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_active_device_last_seen ON talk_active_device(last_seen)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_active_device_device_id ON talk_active_device(device_id)")


class DeviceClaimRequest(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64)
    platform: str = Field(..., pattern=r"^(android|ios|pwa|web)$")
    display_label: Optional[str] = Field(default=None, max_length=64)
    timestamp: int = Field(...)
    pubkey: str = Field(..., min_length=20)
    signature: str = Field(..., min_length=80)


class DeviceClaimResponse(BaseModel):
    success: bool
    kicked_previous: bool
    previous_device_id: Optional[str] = None


class DeviceHeartbeatRequest(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64)
    timestamp: int = Field(...)
    pubkey: str = Field(..., min_length=20)
    signature: str = Field(..., min_length=80)


class DeviceHeartbeatResponse(BaseModel):
    valid: bool
    reason: Optional[str] = None


class DeviceInfoRequest(BaseModel):
    timestamp: int = Field(...)
    pubkey: str = Field(..., min_length=20)
    signature: str = Field(..., min_length=80)


class DeviceInfoResponse(BaseModel):
    has_device: bool
    device_id: Optional[str] = None
    platform: Optional[str] = None
    display_label: Optional[str] = None
    last_seen: Optional[int] = None
    created_at: Optional[int] = None


def create_devices_router(cfg, db: Callable, account_source: Callable) -> APIRouter:
    """/api/devices/claim|heartbeat|info（cfg: ChatConfig，踢裝置推播用它的 broker 與 secret）"""
    router = APIRouter()

    @router.post("/api/devices/claim", response_model=DeviceClaimResponse)
    def device_claim(body: DeviceClaimRequest):
        """註冊本設備為唯一在線設備（自動踢前一台）"""
        payload = {
            "device_id": body.device_id,
            "platform": body.platform,
            "display_label": body.display_label or "",
            "timestamp": body.timestamp,
            "action": "claim",
        }
        if not verify_device_signature(body.pubkey, body.signature, payload, body.timestamp):
            raise HTTPException(status_code=401, detail="Invalid signature or timestamp")

        # pubkey_hash 必須與 pubkey_account_map 寫入端一致：aegisIdBlob.ts 用 sha256(base64 字串)，
        # 故此處 hash base64 文字本身，不可 hash 解碼後 bytes（否則查無 account_key → 永遠 403）。
        pubkey_hash = hashlib.sha256(body.pubkey.encode()).hexdigest()
        now = int(time.time())

        with db() as conn:
            cursor = conn.cursor()
            account_key = account_source(cursor, pubkey_hash)
            if not account_key:
                # 沒有帳號的 pubkey 不能 claim（防止匿名 claim）
                raise HTTPException(status_code=403, detail="account_not_registered")

            # 取得既有 row（若有）
            cursor.execute(
                "SELECT device_id FROM talk_active_device WHERE account_key = ?",
                (account_key,),
            )
            existing = cursor.fetchone()
            previous_device_id = existing["device_id"] if existing else None
            kicked_previous = bool(previous_device_id and previous_device_id != body.device_id)

            # INSERT OR REPLACE — 自動踢
            cursor.execute("""
                INSERT INTO talk_active_device
                (account_key, device_id, pubkey_hash, platform, display_label, last_seen, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_key) DO UPDATE SET
                    device_id = excluded.device_id,
                    pubkey_hash = excluded.pubkey_hash,
                    platform = excluded.platform,
                    display_label = excluded.display_label,
                    last_seen = excluded.last_seen,
                    created_at = CASE
                        WHEN talk_active_device.device_id = excluded.device_id THEN talk_active_device.created_at
                        ELSE excluded.created_at
                    END
            """, (
                account_key,
                body.device_id,
                pubkey_hash,
                body.platform,
                body.display_label,
                now,
                now,
            ))
            conn.commit()

        # Phase 35b: 即時 MQTT 推播通知舊裝置（best-effort）
        if kicked_previous and previous_device_id:
            publish_mqtt_kick(cfg, previous_device_id)

        return DeviceClaimResponse(
            success=True,
            kicked_previous=kicked_previous,
            previous_device_id=previous_device_id if kicked_previous else None,
        )

    @router.post("/api/devices/heartbeat", response_model=DeviceHeartbeatResponse)
    def device_heartbeat(body: DeviceHeartbeatRequest):
        """更新 last_seen；若本設備已被踢則 valid:false"""
        payload = {
            "device_id": body.device_id,
            "timestamp": body.timestamp,
            "action": "heartbeat",
        }
        if not verify_device_signature(body.pubkey, body.signature, payload, body.timestamp):
            raise HTTPException(status_code=401, detail="Invalid signature or timestamp")

        # pubkey_hash 必須與 pubkey_account_map 寫入端一致（見 device_claim）
        pubkey_hash = hashlib.sha256(body.pubkey.encode()).hexdigest()
        now = int(time.time())

        with db() as conn:
            cursor = conn.cursor()
            account_key = account_source(cursor, pubkey_hash)
            if not account_key:
                return DeviceHeartbeatResponse(valid=False, reason="account_not_found")

            cursor.execute(
                "SELECT device_id FROM talk_active_device WHERE account_key = ?",
                (account_key,),
            )
            row = cursor.fetchone()
            if not row:
                return DeviceHeartbeatResponse(valid=False, reason="no_active_device")
            if row["device_id"] != body.device_id:
                return DeviceHeartbeatResponse(valid=False, reason="replaced_by_new_device")

            # 更新 last_seen
            cursor.execute(
                "UPDATE talk_active_device SET last_seen = ? WHERE account_key = ?",
                (now, account_key),
            )
            conn.commit()

        return DeviceHeartbeatResponse(valid=True)

    @router.post("/api/devices/info", response_model=DeviceInfoResponse)
    def device_info(body: DeviceInfoRequest):
        """查詢本帳號當前佔位設備"""
        payload = {
            "timestamp": body.timestamp,
            "action": "info",
        }
        if not verify_device_signature(body.pubkey, body.signature, payload, body.timestamp):
            raise HTTPException(status_code=401, detail="Invalid signature or timestamp")

        # pubkey_hash 必須與 pubkey_account_map 寫入端一致（見 device_claim）
        pubkey_hash = hashlib.sha256(body.pubkey.encode()).hexdigest()

        with db() as conn:
            cursor = conn.cursor()
            account_key = account_source(cursor, pubkey_hash)
            if not account_key:
                return DeviceInfoResponse(has_device=False)

            cursor.execute("""
                SELECT device_id, platform, display_label, last_seen, created_at
                FROM talk_active_device WHERE account_key = ?
            """, (account_key,))
            row = cursor.fetchone()
            if not row:
                return DeviceInfoResponse(has_device=False)

            return DeviceInfoResponse(
                has_device=True,
                device_id=row["device_id"],
                platform=row["platform"],
                display_label=row["display_label"],
                last_seen=row["last_seen"],
                created_at=row["created_at"],
            )

    return router

"""
GET /api/chat/server-config：App 選這台伺服器時要知道的公開連線資訊（不用登入、沒有任何秘密）。

  service          "aegistalk-chat"
  api_version      1
  mqtt_url         broker 的 wss:// 網址（CHAT_PUBLIC_MQTT_URL）
  stun_urls        App 用來找 NAT 位址的 STUN（空 ＝ App 用自己的預設）
  vapid_public_key Web Push 的應用伺服器公鑰（沒開 Web Push 是 null）
  push             {"webpush": bool, "fcm": bool, "types": [...]}（這台收哪些推播型別）
  backup           {"server": false}（v1 沒有伺服器保管的備份；新手機靠舊手機轉移或離線恢復包）
  registration     open | invite | closed（keys-only 註冊）；external ＝ 帳號在別處建立（官方站：AegisID），社群版不能在這裡註冊
  name、links      顯示用（CHAT_SERVER_NAME、CHAT_PRIVACY_URL／TERMS／SUPPORT）
"""
from typing import Optional

SERVICE = "aegistalk-chat"
API_VERSION = 1


def server_config(cfg, registration: str) -> dict:
    return {
        "service": SERVICE,
        "api_version": API_VERSION,
        "mqtt_url": cfg.public_mqtt_url,
        "stun_urls": list(cfg.stun_urls),
        "vapid_public_key": cfg.vapid_public_key if cfg.webpush_enabled else None,
        "push": {"webpush": cfg.webpush_enabled, "fcm": cfg.fcm_enabled, "types": list(cfg.push_types)},
        "backup": {"server": False},
        "registration": registration,
        "name": cfg.server_name or None,
        "links": dict(cfg.links),
    }


def create_server_config_router(cfg, registration: Optional[str] = None):
    """registration：None ＝ cfg.registration（keys-only 註冊有掛）；官方站給 "external" """
    from fastapi import APIRouter
    from fastapi.responses import JSONResponse

    body = server_config(cfg, registration or cfg.registration)
    router = APIRouter()

    @router.get("/api/chat/server-config")
    def get_server_config():
        return JSONResponse(body, headers={"Cache-Control": "public, max-age=300"})

    return router

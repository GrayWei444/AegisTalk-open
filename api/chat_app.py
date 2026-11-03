"""
AegisTalk chat server, standalone and self-hostable (open-source plan step 3).

Run from the api/ directory:

    uvicorn chat_app:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers

`--no-proxy-headers`: this app resolves the client IP itself (CHAT_TRUSTED_PROXIES + CHAT_PROXY_TOKEN);
uvicorn must not rewrite it first.

Every setting is an environment variable (api/.env.example lists all of them). create_app() checks them
(chat.config.ChatConfig.from_env) and refuses to start on any problem: a missing or short secret, two equal
secrets, a plain ws:// broker URL, an unwritable database folder, a half-set VAPID pair, an unreadable FCM
file, an unclear reverse-proxy setup, or a chat module that fails to import. Nothing is auto-generated.

Mounted: the chat routers (api/chat/*: keys-only accounts, MQTT tokens, devices, push, short codes,
server-config), the group log (api/group_log_routes.py) and GET /health. This module and everything it imports
stay free of AegisID, anti-fraud, operations, payments and AegisTrans code (scripts/review/chat_app_self_test.py
checks the import graph).
"""
import importlib
import os
import sqlite3
import sys
from contextlib import contextmanager
from typing import Mapping, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

#: every chat module the server needs (imported up front: one that fails means the server does not start)
CHAT_MODULES = ("chat.config", "chat.signing", "chat.ratelimit", "chat.usage", "chat.accounts", "chat.mqtt_auth",
                "chat.devices", "chat.push", "chat.shortcode", "chat.server_config", "group_log_routes")


def _import_all() -> None:
    from chat.config import ChatConfigError
    failed = []
    for name in CHAT_MODULES:
        try:
            importlib.import_module(name)
        except Exception as e:   # ImportError, or an error while the module runs
            failed.append(f"{name} failed to import ({type(e).__name__}: {e})")
    if failed:
        raise ChatConfigError(failed)


def create_app(environ: Optional[Mapping[str, str]] = None) -> FastAPI:
    _import_all()
    from chat import create_chat_routers, create_chat_tables
    from chat.config import ChatConfig, ChatConfigError
    from chat.push import init_firebase
    from chat.ratelimit import rate_key
    from chat.signing import make_signed_account, resolve_account_key
    from group_log_routes import create_group_log_router, init_group_log_db

    cfg = ChatConfig.from_env(environ)
    db_path = cfg.db_path
    from chat import usage
    usage.configure(cfg.mqtt_jwt_secret)   # 用量表裡 IP／主題的雜湊金鑰不只靠資料庫裡的鹽

    @contextmanager
    def get_db():
        conn = sqlite3.connect(db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    # tables and the group-log file are created before the app exists: a broken database stops the start
    with get_db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        create_chat_tables(conn.cursor())
        conn.commit()
    init_group_log_db(cfg.group_log_db_path)
    if cfg.fcm_enabled:
        init_firebase(cfg.fcm_credentials)

    guard = cfg.proxy_guard()
    try:
        routers = create_chat_routers(cfg, get_db, resolve_account_key, guard, keys_only_accounts=True)
    except ImportError as e:
        raise ChatConfigError([f"a chat router failed to import ({e})"]) from e
    signed_account = make_signed_account(get_db, resolve_account_key)

    app = FastAPI(title="AegisTalk chat server", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(cfg.app_origins),
        allow_credentials=False,   # requests carry signatures, never cookies
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    for router in routers:
        app.include_router(router)
    app.include_router(create_group_log_router(
        db_path=cfg.group_log_db_path,
        get_real_client_ip=lambda req: rate_key(guard.client_ip(req)),   # 限流用：IPv6 整個 /64 算一個
        signed_account=lambda pubkey, signature, payload, timestamp: signed_account(pubkey, signature, payload, timestamp)[0],
    ))

    @app.get("/health")
    def health():
        return {"ok": True, "service": "aegistalk-chat"}

    print(f"[chat] {cfg.describe()}", file=sys.stderr, flush=True)
    if not cfg.trusted_proxies:
        print("[chat] no reverse proxy configured: the client IP is the TCP peer, X-Forwarded-For is ignored", file=sys.stderr, flush=True)
    return app


if __name__ == "__main__":
    # python chat_app.py ＝ the uvicorn command above on 127.0.0.1:8000 (CHAT_BIND_HOST / CHAT_BIND_PORT to change)
    import uvicorn
    uvicorn.run(create_app(), host=os.environ.get("CHAT_BIND_HOST", "127.0.0.1"),
                port=int(os.environ.get("CHAT_BIND_PORT", "8000")), proxy_headers=False)

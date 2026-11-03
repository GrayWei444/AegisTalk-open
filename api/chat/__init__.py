"""
AegisTalk chat 伺服器（開源）。獨立執行：api/chat_app.py；官方站的 api/main.py 掛同樣的 router（外加 AegisID、防詐、營運等私有部分）。

  config.py        ChatConfig（環境變數；不對就拒絕啟動）、ProxyGuard（client IP 與反向代理的判斷）
  signing.py       帳戶 Ed25519 簽章、一次性 request_id、公鑰 → 帳號（pubkey_account_map）、時鐘差回應
  accounts.py      POST /api/account/register（keys-only 帳號；只有獨立 chat 伺服器掛）、邀請碼
  invites.py       python -m chat.invites create|list|revoke
  mqtt_auth.py     /api/mqtt/token、/api/mqtt/transfer-token、token 的 ACL／範圍、踢裝置推播
  devices.py       /api/devices/claim|heartbeat|info（一個帳號一台在線裝置）
  push.py          /api/push/notify、FCM（/api/push/register-token）、Web Push（/api/push/webpush/register|unregister）
  shortcode.py     /api/shortcode/register|refresh（簽章）、/api/shortcode/lookup
  server_config.py GET /api/chat/server-config（公開的連線資訊）
  usage.py         SQLite 的用量計數（token 主題數、註冊上限）
  ratelimit.py     記憶體滑動窗限流
  vapid.py         python -m chat.vapid（產生 Web Push 金鑰）

    cfg = ChatConfig.from_env()
    for router in create_chat_routers(cfg, get_db, resolve_account_key, cfg.proxy_guard(), keys_only_accounts=True):
        app.include_router(router)

群組 log（api/group_log_routes.py）另外掛，append 的帳號簽章用 signing.make_signed_account。
子模組在用到時才 import：`import chat.mqtt_auth`／`chat.signing` 不會連帶載入其他子模組；firebase_admin、pywebpush 只在開了
那種推播時才載入。
"""
from typing import Callable, List, Optional

from .config import DIRECT_CLIENTS, ChatConfig, ChatConfigError, ProxyGuard

__all__ = ["ChatConfig", "ChatConfigError", "ProxyGuard", "create_chat_routers", "create_chat_tables"]


def create_chat_tables(cursor) -> None:
    """chat 用到的資料表（request_nonces、pubkey_account_map、fcm_tokens、push_rate_limit、webpush_subscriptions、
    friend_shortcodes、talk_active_device、account_invites、chat_meta、mqtt_topic_grants、usage_events），
    全部 CREATE … IF NOT EXISTS；呼叫端自己 commit。"""
    from . import accounts, devices, push, shortcode, signing, usage
    signing.create_tables(cursor)
    push.create_tables(cursor)
    shortcode.create_tables(cursor)
    devices.create_tables(cursor)
    usage.create_tables(cursor)
    accounts.create_tables(cursor)


def create_chat_routers(cfg: ChatConfig, db: Callable, account_source: Callable,
                        proxy_guard: Optional[ProxyGuard] = None, *, keys_only_accounts: bool = False) -> List:
    """
    chat 的所有 router。
      cfg                 ChatConfig
      db                  db() → sqlite3 連線（row_factory = sqlite3.Row）的 context manager
      account_source      account_source(cursor, pubkey_hash) → account_key 或 None（signing.resolve_account_key，查 pubkey_account_map）
      proxy_guard         ProxyGuard（cfg.proxy_guard()）；None ＝ 前面沒有反向代理
      keys_only_accounts  True（獨立 chat 伺服器）：掛 POST /api/account/register（cfg.registration 政策）、
                          沒有帳號的金鑰拿不到 MQTT token；server-config 的 registration 是那個政策。
                          False（官方站）：帳號由 AegisID 建立，不掛註冊；server-config 說 "external"。
    任何一個子模組 import 失敗都會在這裡丟出來（呼叫端拒絕啟動）。
    """
    from . import devices, mqtt_auth, push, server_config, shortcode
    guard = proxy_guard or DIRECT_CLIENTS
    routers = [
        server_config.create_server_config_router(cfg, None if keys_only_accounts else "external"),
        mqtt_auth.create_mqtt_router(cfg, db, account_source, guard, require_account=keys_only_accounts),
        devices.create_devices_router(cfg, db, account_source),
        shortcode.create_shortcode_router(db, guard, account_source),
    ]
    if keys_only_accounts:
        from . import accounts
        routers.append(accounts.create_account_router(cfg, db, guard, account_source))
    if cfg.fcm_enabled or cfg.webpush_enabled:
        sender = (push.WebPushSender(cfg.vapid_private_key, cfg.vapid_subject, allowed_hosts=cfg.webpush_hosts)
                  if cfg.webpush_enabled else None)
        routers.append(push.create_push_router(db, account_source, guard, hint_types=cfg.push_types, fcm=cfg.fcm_enabled,
                                               webpush=sender, webpush_hosts=cfg.webpush_hosts))
    return routers

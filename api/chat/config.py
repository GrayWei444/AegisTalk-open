"""
Chat 伺服器的設定（ChatConfig）與「請求從哪裡來」的判斷（ProxyGuard）。

開源計畫第 3 步：ChatConfig.from_env() **檢查完才回傳**，有任何一項不對就丟 ChatConfigError（一次列出全部問題），
伺服器不啟動 —— 獨立的 chat 伺服器（api/chat_app.py）與官方站（api/main.py 的 chat 部分）都一樣。
**任何秘密都不自動產生**（以前沒設 AEGIS_MQTT_JWT_SECRET 就亂數產生一個：每次重啟都不同、EMQX 認不得）。

拒絕啟動的情況：
  - 必要設定沒給：AEGIS_MQTT_JWT_SECRET、AEGIS_DB_PATH、CHAT_PUBLIC_MQTT_URL、CHAT_APP_ORIGINS、CHAT_TRUSTED_PROXIES
  - 秘密短於 32 字元，或任兩個秘密相同（MQTT secret、反向代理 token，再加上呼叫端給的其他秘密，例如官方站的 AEGIS_API_SECRET）
  - CHAT_PUBLIC_MQTT_URL 不是 wss://（只有 localhost 可以 ws://）；CHAT_APP_ORIGINS 不是 origin、是 *、或 http:// 不是本機
  - 反向代理設定前後矛盾：CHAT_TRUSTED_PROXIES 列了位址卻沒有 CHAT_PROXY_TOKEN、設 none 卻給了 token、位址寫錯、信任 0.0.0.0/0
  - VAPID 金鑰只給一半、公私鑰不成對、沒有 CHAT_VAPID_SUBJECT、沒裝 pywebpush
  - CHAT_FCM_CREDENTIALS 給了但讀不到、不是 service account JSON、沒裝 firebase-admin
  - 資料庫所在的資料夾寫不進去
  - 數字設定不是整數、超出範圍；選項不在清單裡
設定與預設值的完整清單：api/.env.example。
"""
import base64
import hmac
import ipaddress
import json
import os
import tempfile
from dataclasses import dataclass, field
import sys
from importlib.util import find_spec
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

#: 秘密的最短長度（openssl rand -hex 32 ＝ 64 字元）
MIN_SECRET_LENGTH = 32
#: 帳號註冊的政策（決定 7：自架預設 invite）；官方站的帳號由 AegisID 建立 ＝ "external"
REGISTRATION_POLICIES = ("open", "invite", "closed")
#: token 的 acl claim 格式：rules ＝ EMQX ≥ 5.7 的規則清單（能限制 retain；固定版本 5.8.9 實測過），legacy ＝ {pub, sub, all}（5.3 起）
ACL_FORMATS = ("rules", "legacy")
#: chat 伺服器收的推播型別（決定 2：守護／報平安不在 v1）。官方站另外收 guardian_alert、check_in
CHAT_PUSH_TYPES = ("message", "incoming_call")
ALL_PUSH_TYPES = ("message", "incoming_call", "guardian_alert", "check_in")
#: Web Push 只送到這些推播服務（後綴比對；不能讓任何人登記一個指向內網的網址，伺服器就去 POST 它）
DEFAULT_WEBPUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
                         "web.push.apple.com", "notify.windows.com")
#: 反向代理注入的 header（官方站的 Caddy 就是用這個名字）
PROXY_TOKEN_HEADER = "X-Aegis-Internal"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
#: 一張 token 最多 50 個群組主題 ＋ 150 個好友 presence 主題（mqtt_auth.MQTT_ACL_MAX_*）：每天的上限至少要夠一張滿的
MIN_TOKEN_TOPICS_PER_DAY = 200


class ChatConfigError(RuntimeError):
    """設定不對：problems 是每一項問題（一行一個），訊息裡不含任何秘密的值"""

    def __init__(self, problems: Sequence[str]):
        self.problems = list(problems)
        super().__init__("chat server refuses to start (see api/.env.example):\n  - " + "\n  - ".join(self.problems))


@dataclass(frozen=True)
class RegisterLimits:
    """新帳號（keys-only 註冊）的上限：每個 IP、全部加起來，每小時／每天"""
    ip_per_hour: int = 3
    ip_per_day: int = 10
    per_hour: int = 60
    per_day: int = 500


@dataclass(frozen=True)
class ChatConfig:
    #: 簽 MQTT JWT 的 secret（必須與 EMQX JWT authenticator 的 secret 一致，docs/MQTT_BROKER.md §2）；repr 不印出來
    mqtt_jwt_secret: str = field(repr=False)
    #: SQLite 主資料庫、群組 log 自己的檔案
    db_path: str = ""
    group_log_db_path: str = ""
    #: App 連 broker 用的網址（GET /api/chat/server-config 告訴 App）
    public_mqtt_url: str = ""
    #: 瀏覽器可以呼叫 API 的 origin（CORS）
    app_origins: Tuple[str, ...] = ()
    #: 受信任的反向代理（空 ＝ 前面沒有反向代理，API 直接面對 client）與它注入的 token
    trusted_proxies: Tuple[Any, ...] = ()
    proxy_token: str = field(default="", repr=False)
    #: keys-only 帳號註冊的政策與上限（官方站不掛註冊端點）
    registration: str = "invite"
    register_limits: RegisterLimits = RegisterLimits()
    #: 伺服器自己發「踢裝置」推播時連的 broker（tcp，只綁本機／內部網路）
    mqtt_host: str = "127.0.0.1"
    mqtt_port: int = 1883
    mqtt_acl_format: str = "rules"
    #: 同一把簽章金鑰（帳號）24 小時內最多拿到幾個不同的群組／presence 主題（限制猜主題）
    token_topics_per_day: int = 2000
    #: 推播：FCM service account（None ＝ 不開 FCM）、Web Push 的 VAPID（None ＝ 不開）
    fcm_credentials: Optional[str] = None
    vapid_public_key: Optional[str] = None
    vapid_private_key: Optional[str] = field(default=None, repr=False)
    vapid_subject: Optional[str] = None
    webpush_hosts: Tuple[str, ...] = DEFAULT_WEBPUSH_HOSTS
    push_types: Tuple[str, ...] = CHAT_PUSH_TYPES
    #: 公開的連線資訊（server-config）
    stun_urls: Tuple[str, ...] = ()
    server_name: str = ""
    links: Mapping[str, str] = field(default_factory=dict)

    @property
    def fcm_enabled(self) -> bool:
        return bool(self.fcm_credentials)

    @property
    def webpush_enabled(self) -> bool:
        return bool(self.vapid_private_key and self.vapid_public_key)

    def proxy_guard(self) -> "ProxyGuard":
        return make_proxy_guard(self.trusted_proxies, self.proxy_token)

    def describe(self) -> str:
        """啟動時印的一行摘要（沒有任何秘密）"""
        proxies = ",".join(str(n) for n in self.trusted_proxies) or "none (clients connect directly)"
        push = [name for name, on in (("webpush", self.webpush_enabled), ("fcm", self.fcm_enabled)) if on] or ["off"]
        return (f"chat config: db={self.db_path} group_log={self.group_log_db_path} mqtt_url={self.public_mqtt_url} "
                f"origins={','.join(self.app_origins)} trusted_proxies={proxies} registration={self.registration} "
                f"acl_format={self.mqtt_acl_format} push={'+'.join(push)} push_types={','.join(self.push_types)}")

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None, *,
                 other_secrets: Optional[Mapping[str, Optional[str]]] = None) -> "ChatConfig":
        """
        讀環境變數並檢查；有問題丟 ChatConfigError（全部列出）。
        other_secrets：呼叫端自己的其他秘密 {名稱: 值}（官方站的 AEGIS_API_SECRET）—— 一樣要有、≥ 32 字元、跟其他秘密都不同。
        """
        env = os.environ if environ is None else environ
        p = _Problems()
        get = lambda name: (env.get(name) or "").strip()  # noqa: E731

        mqtt_secret = p.secret("AEGIS_MQTT_JWT_SECRET", env.get("AEGIS_MQTT_JWT_SECRET") or "")
        db_path = p.required("AEGIS_DB_PATH", get("AEGIS_DB_PATH"))
        group_log_db_path = get("AEGIS_GROUP_LOG_DB_PATH") or (
            os.path.join(os.path.dirname(db_path), "group_log.db") if db_path else "")
        for name, path in (("AEGIS_DB_PATH", db_path), ("AEGIS_GROUP_LOG_DB_PATH", group_log_db_path)):
            if path:
                p.writable_db(name, path)

        mqtt_url = p.required("CHAT_PUBLIC_MQTT_URL", get("CHAT_PUBLIC_MQTT_URL"))
        if mqtt_url:
            p.check(_broker_url_ok(mqtt_url), "CHAT_PUBLIC_MQTT_URL must be a wss:// URL (ws:// only for localhost)")
        origins = tuple(o.strip().rstrip("/") for o in get("CHAT_APP_ORIGINS").split(",") if o.strip())
        p.check(bool(origins), "CHAT_APP_ORIGINS is required (comma-separated origins of the web app and app shells)")
        for o in origins:
            p.check(_origin_ok(o), f"CHAT_APP_ORIGINS: {o!r} is not an allowed origin "
                                   "(https://host[:port], http://localhost[:port], capacitor://localhost; no paths, no *)")

        proxies, proxy_token = _proxy_settings(p, get("CHAT_TRUSTED_PROXIES"), env.get("CHAT_PROXY_TOKEN") or "")

        registration = get("CHAT_REGISTRATION") or "invite"
        p.check(registration in REGISTRATION_POLICIES, f"CHAT_REGISTRATION must be one of {', '.join(REGISTRATION_POLICIES)}")
        limits = RegisterLimits(
            ip_per_hour=p.integer("CHAT_REGISTER_PER_IP_HOUR", get("CHAT_REGISTER_PER_IP_HOUR"), RegisterLimits.ip_per_hour, 0, 10_000),
            ip_per_day=p.integer("CHAT_REGISTER_PER_IP_DAY", get("CHAT_REGISTER_PER_IP_DAY"), RegisterLimits.ip_per_day, 0, 100_000),
            per_hour=p.integer("CHAT_REGISTER_PER_HOUR", get("CHAT_REGISTER_PER_HOUR"), RegisterLimits.per_hour, 0, 1_000_000),
            per_day=p.integer("CHAT_REGISTER_PER_DAY", get("CHAT_REGISTER_PER_DAY"), RegisterLimits.per_day, 0, 10_000_000),
        )

        mqtt_port = p.integer("AEGIS_MQTT_PORT", get("AEGIS_MQTT_PORT"), 1883, 1, 65535)
        acl_format = get("CHAT_MQTT_ACL_FORMAT") or "rules"
        p.check(acl_format in ACL_FORMATS, f"CHAT_MQTT_ACL_FORMAT must be one of {', '.join(ACL_FORMATS)}")
        topics_per_day = p.integer("CHAT_TOKEN_TOPICS_PER_DAY", get("CHAT_TOKEN_TOPICS_PER_DAY"), 2000,
                                   MIN_TOKEN_TOPICS_PER_DAY, 1_000_000)

        fcm = get("CHAT_FCM_CREDENTIALS") or None
        if fcm:
            p.fcm(fcm)
        vapid_public, vapid_private, vapid_subject = _vapid_settings(
            p, get("CHAT_VAPID_PUBLIC_KEY"), env.get("CHAT_VAPID_PRIVATE_KEY") or "", get("CHAT_VAPID_SUBJECT"))
        hosts_raw = get("CHAT_WEBPUSH_HOSTS")
        webpush_hosts = tuple(h.strip().lower().lstrip(".") for h in hosts_raw.split(",") if h.strip()) if hosts_raw else DEFAULT_WEBPUSH_HOSTS
        for h in webpush_hosts:
            p.check(_hostname_ok(h), f"CHAT_WEBPUSH_HOSTS: {h!r} is not a host name")

        stun = tuple(s.strip() for s in get("CHAT_STUN_URLS").split(",") if s.strip())
        for s in stun:
            p.check(s.startswith(("stun:", "stuns:")) and len(s) <= 256 and " " not in s, f"CHAT_STUN_URLS: {s!r} is not a stun:/stuns: URL")
        name = get("CHAT_SERVER_NAME")
        p.check(len(name) <= 64, "CHAT_SERVER_NAME is longer than 64 characters")
        links: Dict[str, str] = {}
        for key, var in (("privacy", "CHAT_PRIVACY_URL"), ("terms", "CHAT_TERMS_URL"), ("support", "CHAT_SUPPORT_URL")):
            url = get(var)
            if url:
                p.check(_https_url_ok(url), f"{var} must be an https:// URL")
                links[key] = url

        others = {k: (v or "") for k, v in (other_secrets or {}).items()}
        for k, v in others.items():
            p.secret(k, v)
        p.distinct({"AEGIS_MQTT_JWT_SECRET": mqtt_secret, "CHAT_PROXY_TOKEN": proxy_token,
                    "CHAT_VAPID_PRIVATE_KEY": vapid_private or "", **others})
        p.raise_if_any()
        return cls(
            mqtt_jwt_secret=mqtt_secret, db_path=db_path, group_log_db_path=group_log_db_path, public_mqtt_url=mqtt_url,
            app_origins=origins, trusted_proxies=proxies, proxy_token=proxy_token, registration=registration,
            register_limits=limits, mqtt_host=get("AEGIS_MQTT_HOST") or "127.0.0.1", mqtt_port=mqtt_port,
            mqtt_acl_format=acl_format, token_topics_per_day=topics_per_day, fcm_credentials=fcm,
            vapid_public_key=vapid_public, vapid_private_key=vapid_private, vapid_subject=vapid_subject,
            webpush_hosts=webpush_hosts, stun_urls=stun, server_name=name, links=links,
        )


class _Problems:
    """收集設定問題（訊息不含秘密的值）"""

    def __init__(self) -> None:
        self.items: List[str] = []

    def check(self, ok: bool, message: str) -> bool:
        if not ok:
            self.items.append(message)
        return ok

    def required(self, name: str, value: str) -> str:
        self.check(bool(value), f"{name} is required")
        return value

    def secret(self, name: str, value: str) -> str:
        if not value:
            self.items.append(f"{name} is required (generate one with: openssl rand -hex 32)")
        elif len(value) < MIN_SECRET_LENGTH or value != value.strip():
            self.items.append(f"{name} must be at least {MIN_SECRET_LENGTH} characters without surrounding spaces "
                              "(openssl rand -hex 32)")
        return value

    def distinct(self, secrets_by_name: Mapping[str, str]) -> None:
        names = [n for n, v in secrets_by_name.items() if v]
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if hmac.compare_digest(secrets_by_name[a].encode(), secrets_by_name[b].encode()):
                    self.items.append(f"{a} and {b} must be different secrets")

    def integer(self, name: str, raw: str, default: int, low: int, high: int) -> int:
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            self.items.append(f"{name} must be an integer")
            return default
        self.check(low <= value <= high, f"{name} must be between {low} and {high}")
        return value

    def writable_db(self, name: str, path: str) -> None:
        if not os.path.isabs(path):
            self.items.append(f"{name} must be an absolute path")
            return
        folder = os.path.dirname(path)
        try:
            os.makedirs(folder, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=folder, prefix=".chat-write-check-"):
                pass
        except OSError as e:
            self.items.append(f"{name}: the folder {folder} is not writable ({e.strerror or e})")
            return
        if os.path.exists(path) and not (os.path.isfile(path) and os.access(path, os.R_OK | os.W_OK)):
            self.items.append(f"{name}: {path} exists but is not a readable and writable file")

    def fcm(self, path: str) -> None:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            self.items.append(f"CHAT_FCM_CREDENTIALS: cannot read a JSON file at {path} ({type(e).__name__})")
            return
        self.check(isinstance(data, dict) and data.get("type") == "service_account",
                   "CHAT_FCM_CREDENTIALS must be a Firebase service account JSON (\"type\": \"service_account\")")
        self.check(_installed("firebase_admin"),
                   "CHAT_FCM_CREDENTIALS is set but firebase-admin is not installed (pip install -r requirements-fcm.txt)")

    def raise_if_any(self) -> None:
        if self.items:
            raise ChatConfigError(self.items)


def _installed(module: str) -> bool:
    """套件裝了沒（不 import 它；已經載入的也算）"""
    if module in sys.modules:
        return True
    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _broker_url_ok(url: str) -> bool:
    parts = urlsplit(url)
    if not parts.hostname or parts.username or parts.password:
        return False
    return parts.scheme == "wss" or (parts.scheme == "ws" and parts.hostname in LOCAL_HOSTS)


def _https_url_ok(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "https" and bool(parts.hostname) and not parts.username and len(url) <= 512


def _hostname_ok(host: str) -> bool:
    """至少兩節（"com" 這種單一節的後綴等於放行整個頂級網域）"""
    labels = host.split(".")
    return len(labels) >= 2 and len(host) <= 253 and all(
        label and len(label) <= 63 and all(c.isalnum() or c == "-" for c in label) for label in labels)


def _origin_ok(origin: str) -> bool:
    """https://host[:port]、http://localhost[:port]（開發）、capacitor://localhost（iOS 殼）；不能有路徑、不能是 *"""
    if origin == "capacitor://localhost":
        return True
    try:
        parts = urlsplit(origin)
        _ = parts.port   # 不合法的 port 丟 ValueError
    except ValueError:
        return False
    if parts.path or parts.query or parts.fragment or parts.username or not parts.hostname or "*" in origin:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and parts.hostname in LOCAL_HOSTS


def _proxy_settings(p: _Problems, raw: str, token: str) -> Tuple[Tuple[Any, ...], str]:
    """CHAT_TRUSTED_PROXIES（none 或 IP／CIDR 清單）＋ CHAT_PROXY_TOKEN：一定要明說，不再有「沒設就當沒有代理」"""
    if not raw:
        p.items.append("CHAT_TRUSTED_PROXIES is required: the reverse proxy's address(es) as IPs/CIDRs "
                       "(e.g. 127.0.0.1 or 172.30.0.1), or 'none' when clients connect to the API directly")
        return (), token
    if raw.lower() == "none":
        p.check(not token, "CHAT_PROXY_TOKEN is set but CHAT_TRUSTED_PROXIES is 'none' (the token would be ignored)")
        return (), ""
    nets, bad = [], False
    for item in (x.strip() for x in raw.split(",")):
        if not item:
            continue
        try:
            net = ipaddress.ip_network(item, strict=False)
        except ValueError:
            p.items.append(f"CHAT_TRUSTED_PROXIES: {item!r} is not an IP address or CIDR")
            bad = True
            continue
        if net.prefixlen < (8 if net.version == 4 else 16):
            # 0.0.0.0/0、0.0.0.0/1＋128.0.0.0/1 這種：等於信任所有位址（審查 INFO：以前只擋 /0）
            p.items.append(f"CHAT_TRUSTED_PROXIES: {item!r} trusts far too many addresses (anyone could set X-Forwarded-For); "
                           "list the proxy's own address or network")
            bad = True
            continue
        nets.append(net)
    p.check(bool(nets) or bad, "CHAT_TRUSTED_PROXIES lists no address")
    p.secret("CHAT_PROXY_TOKEN", token)
    return tuple(nets), token


def _b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _vapid_settings(p: _Problems, public: str, private: str, subject: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """VAPID 一對金鑰（base64url：公鑰 65 bytes 未壓縮 P-256 點、私鑰 32 bytes）＋ subject；只給一半 → 拒絕"""
    if not public and not private:
        p.check(not subject, "CHAT_VAPID_SUBJECT is set but the VAPID key pair is not")
        return None, None, None
    if not (public and private):
        p.items.append("CHAT_VAPID_PUBLIC_KEY and CHAT_VAPID_PRIVATE_KEY must be set together (Web Push is off when both are empty)")
        return None, None, None
    p.check(subject.startswith("mailto:") or _https_url_ok(subject),
            "CHAT_VAPID_SUBJECT must be a mailto: address or an https:// URL (push services contact you there)")
    p.check(_installed("pywebpush"),
            "VAPID keys are set but pywebpush is not installed (pip install -r requirements-webpush.txt)")
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        raw_private = _b64url(private)
        raw_public = _b64url(public)
        if len(raw_private) != 32 or len(raw_public) != 65:
            raise ValueError("length")
        key = ec.derive_private_key(int.from_bytes(raw_private, "big"), ec.SECP256R1())
        derived = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        p.check(hmac.compare_digest(derived, raw_public), "CHAT_VAPID_PUBLIC_KEY does not belong to CHAT_VAPID_PRIVATE_KEY")
    except (ValueError, TypeError):
        p.items.append("CHAT_VAPID_PUBLIC_KEY / CHAT_VAPID_PRIVATE_KEY are not base64url P-256 keys "
                       "(generate them with: python -m chat.vapid)")
    return public, private, subject


def direct_client_ip(req: Any) -> str:
    """前面沒有反向代理：TCP 連線的對方就是 client"""
    return req.client.host if req.client else "unknown"


@dataclass(frozen=True)
class ProxyGuard:
    """
    chat 路由怎麼看一個請求：
      client_ip(req)   → 限流用的 client IP（有反向代理時：只採信受信任代理帶來的 X-Forwarded-For）
      internal_ok(req) → 請求是不是經過受信任的反向代理（對方位址在 CHAT_TRUSTED_PROXIES 裡、帶著 CHAT_PROXY_TOKEN）。
                         只證明「經過代理」，不代表使用者身分 —— 身分一律看帳戶簽章。沒有反向代理時一律 True。
    """
    client_ip: Callable[[Any], str]
    internal_ok: Callable[[Any], bool]


#: 前面沒有反向代理（CHAT_TRUSTED_PROXIES=none）：client IP 就是 TCP 對方，沒有 internal header 可以核對
DIRECT_CLIENTS = ProxyGuard(client_ip=direct_client_ip, internal_ok=lambda req: True)


def _ip(text: str) -> Optional[Any]:
    try:
        ip = ipaddress.ip_address(text.strip())
    except ValueError:
        return None
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped or ip


def make_proxy_guard(trusted: Sequence[Any], token: str) -> ProxyGuard:
    """
    有反向代理時的判斷：
      - 對方（TCP peer）在 trusted 裡**而且**帶著正確的 token（X-Aegis-Internal）＝ 經過我們的代理
      - 只有這種請求才看 X-Forwarded-For：從右邊往左找第一個不是我們代理的位址（Caddy 會蓋掉 client 自己送的；
        nginx 之類「附加」的寫法，最左邊是 client 自己填的，不能採信）。寫壞的、全都是代理 → 用代理自己的位址
      - 其他請求帶的 X-Forwarded-For 一律不理（client IP ＝ TCP 對方）
    """
    if not trusted:
        return DIRECT_CLIENTS
    nets = tuple(trusted)
    secret = token.encode()

    def trusted_peer(req: Any) -> bool:
        peer = _ip(req.client.host) if req.client else None
        return peer is not None and any(peer in n for n in nets)

    def internal_ok(req: Any) -> bool:
        got = req.headers.get(PROXY_TOKEN_HEADER, "")
        return bool(got) and trusted_peer(req) and hmac.compare_digest(got.encode(), secret)

    def client_ip(req: Any) -> str:
        peer = req.client.host if req.client else "unknown"
        if not internal_ok(req):
            return peer
        hops = [h.strip() for line in req.headers.getlist("x-forwarded-for") for h in line.split(",") if h.strip()]
        for hop in reversed(hops):
            ip = _ip(hop)
            if ip is None:
                return peer
            if not any(ip in n for n in nets):
                return str(ip)
        return peer

    return ProxyGuard(client_ip=client_ip, internal_ok=internal_ok)

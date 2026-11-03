#!/usr/bin/env python3
"""
chat 伺服器的設定檢查（api/chat/config.py ChatConfig.from_env，開源計畫第 3 步）與反向代理的 client IP 判斷（make_proxy_guard）。

  1. 一份完整的設定通過；describe() 沒有任何秘密
  2. 每一條拒絕規則各自觸發（訊息點名那個設定、不含秘密的值），而且一次列出全部問題：
     缺必要設定、秘密 < 32 字元／前後空白／任兩個相同、broker 網址不是 wss://（localhost 例外）、CORS origin 不合法、
     反向代理設定矛盾或寫錯、0.0.0.0/0、VAPID 只給一半／不成對／沒 subject、FCM 檔案讀不到／不是 service account、
     資料庫資料夾寫不進去、數字設定不是整數／超出範圍、選項不在清單裡
  3. ProxyGuard：沒有代理時 client IP ＝ TCP 對方、X-Forwarded-For 不理；有代理時只有「受信任位址＋正確 token」的請求採信
     X-Forwarded-For（從右邊往左第一個不是代理的位址；寫壞的 → 代理自己的位址）；IPv4-mapped IPv6 也認得
不連任何服務。Run: python3 scripts/review/chat_config_self_test.py   （需要 cryptography；VAPID 的檢查需要 pywebpush 已安裝）
"""
import base64
import importlib.util
import ipaddress
import os
import stat
import sys
import tempfile
from pathlib import Path

API_DIR = Path(os.environ.get("AEGISTALK_API_DIR", str(Path(__file__).resolve().parents[2] / "api")))
sys.path.insert(0, str(API_DIR))
from chat.config import (DEFAULT_WEBPUSH_HOSTS, PROXY_TOKEN_HEADER, ChatConfig, ChatConfigError,  # noqa: E402
                         make_proxy_guard)

TMP = tempfile.mkdtemp(prefix="chat-config-")
MQTT = "m" * 40
PROXY = "p" * 40
fcm_ok = os.path.join(TMP, "fcm.json")
Path(fcm_ok).write_text('{"type": "service_account", "project_id": "x"}')
fcm_bad = os.path.join(TMP, "not-service.json")
Path(fcm_bad).write_text('{"type": "authorized_user"}')
HAVE_FIREBASE = importlib.util.find_spec("firebase_admin") is not None
HAVE_WEBPUSH = importlib.util.find_spec("pywebpush") is not None


def vapid_pair():
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    key = ec.generate_private_key(ec.SECP256R1())
    enc = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")  # noqa: E731
    return (enc(key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)),
            enc(key.private_numbers().private_value.to_bytes(32, "big")))


VAPID_PUB, VAPID_PRIV = vapid_pair()
OTHER_PUB, _ = vapid_pair()
BASE = {
    "AEGIS_MQTT_JWT_SECRET": MQTT,
    "AEGIS_DB_PATH": os.path.join(TMP, "db", "chat.db"),
    "CHAT_PUBLIC_MQTT_URL": "wss://mqtt.example.com/mqtt",
    "CHAT_APP_ORIGINS": "https://chat.example.com, https://localhost,capacitor://localhost,http://localhost:5173",
    "CHAT_TRUSTED_PROXIES": "127.0.0.1,172.30.0.0/24",
    "CHAT_PROXY_TOKEN": PROXY,
}
failed = 0


def check(name, fn):
    global failed
    try:
        fn()
        print("PASS", name)
    except Exception as e:
        failed += 1
        print("FAIL", name, "\n    ", f"{type(e).__name__}: {str(e)[:600]}")


def refused(changes, *expected, secrets=(MQTT, PROXY)):
    env = {k: v for k, v in {**BASE, **changes}.items() if v is not None}
    try:
        ChatConfig.from_env(env)
    except ChatConfigError as e:
        text = str(e)
        for want in expected:
            assert want in text, f"{changes}: expected {want!r} in\n{text}"
        for s in secrets:
            assert not s or s not in text, f"{changes}: the message leaks a secret"
        return e.problems
    raise AssertionError(f"{changes}: started although it should refuse")


def full_config():
    env = {**BASE, "CHAT_REGISTRATION": "open", "CHAT_STUN_URLS": "stun:stun.example.com:3478",
           "CHAT_SERVER_NAME": "Example", "CHAT_PRIVACY_URL": "https://example.com/privacy",
           "AEGIS_MQTT_HOST": "emqx", "AEGIS_MQTT_PORT": "1883", "CHAT_REGISTER_PER_IP_HOUR": "5"}
    if HAVE_WEBPUSH:
        env.update(CHAT_VAPID_PUBLIC_KEY=VAPID_PUB, CHAT_VAPID_PRIVATE_KEY=VAPID_PRIV, CHAT_VAPID_SUBJECT="mailto:ops@example.com")
    if HAVE_FIREBASE:
        env["CHAT_FCM_CREDENTIALS"] = fcm_ok
    cfg = ChatConfig.from_env(env)
    assert cfg.db_path == BASE["AEGIS_DB_PATH"] and cfg.group_log_db_path == os.path.join(TMP, "db", "group_log.db")
    assert cfg.app_origins == ("https://chat.example.com", "https://localhost", "capacitor://localhost", "http://localhost:5173")
    assert [str(n) for n in cfg.trusted_proxies] == ["127.0.0.1/32", "172.30.0.0/24"] and cfg.proxy_token == PROXY
    assert cfg.registration == "open" and cfg.register_limits.ip_per_hour == 5 and cfg.register_limits.per_day == 500
    assert cfg.mqtt_acl_format == "rules" and cfg.token_topics_per_day == 2000 and cfg.push_types == ("message", "incoming_call")
    assert cfg.webpush_hosts == DEFAULT_WEBPUSH_HOSTS and cfg.links == {"privacy": "https://example.com/privacy"}
    assert cfg.webpush_enabled == HAVE_WEBPUSH and cfg.fcm_enabled == HAVE_FIREBASE
    text = cfg.describe() + repr(cfg)
    for s in (MQTT, PROXY, VAPID_PRIV):
        assert s not in text, "describe()/repr() must not show a secret"
    # 預設：invite、沒有推播
    d = ChatConfig.from_env(BASE)
    assert d.registration == "invite" and not d.webpush_enabled and not d.fcm_enabled
    # 沒有反向代理（明說 none）
    direct = ChatConfig.from_env({**BASE, "CHAT_TRUSTED_PROXIES": "none", "CHAT_PROXY_TOKEN": ""})
    assert direct.trusted_proxies == () and direct.proxy_token == ""
    # ws:// 只給 localhost
    assert ChatConfig.from_env({**BASE, "CHAT_PUBLIC_MQTT_URL": "ws://localhost:8083/mqtt"}).public_mqtt_url.startswith("ws://")


def required_settings():
    for name in ("AEGIS_MQTT_JWT_SECRET", "AEGIS_DB_PATH", "CHAT_PUBLIC_MQTT_URL", "CHAT_APP_ORIGINS", "CHAT_TRUSTED_PROXIES"):
        refused({name: None}, name)
    problems = refused({"AEGIS_MQTT_JWT_SECRET": None, "AEGIS_DB_PATH": None, "CHAT_APP_ORIGINS": None})
    assert len(problems) >= 3, f"every problem is listed at once ({problems})"


def secret_rules():
    refused({"AEGIS_MQTT_JWT_SECRET": "x" * 31}, "AEGIS_MQTT_JWT_SECRET must be at least 32")
    refused({"AEGIS_MQTT_JWT_SECRET": " " + "x" * 40}, "AEGIS_MQTT_JWT_SECRET must be at least 32")
    refused({"CHAT_PROXY_TOKEN": "y" * 20}, "CHAT_PROXY_TOKEN must be at least 32")
    refused({"CHAT_PROXY_TOKEN": MQTT}, "AEGIS_MQTT_JWT_SECRET and CHAT_PROXY_TOKEN must be different")
    try:
        ChatConfig.from_env(BASE, other_secrets={"AEGIS_API_SECRET": PROXY})
        raise AssertionError("an extra secret equal to another must be refused")
    except ChatConfigError as e:
        assert "CHAT_PROXY_TOKEN and AEGIS_API_SECRET must be different" in str(e), str(e)
    try:
        ChatConfig.from_env(BASE, other_secrets={"AEGIS_API_SECRET": ""})
        raise AssertionError("a missing extra secret must be refused")
    except ChatConfigError as e:
        assert "AEGIS_API_SECRET is required" in str(e), str(e)


def url_and_origin_rules():
    for bad in ("ws://mqtt.example.com/mqtt", "http://mqtt.example.com", "mqtt.example.com", "wss://user:pw@mqtt.example.com/mqtt", "wss:///mqtt"):
        refused({"CHAT_PUBLIC_MQTT_URL": bad}, "CHAT_PUBLIC_MQTT_URL must be a wss://")
    for bad in ("*", "https://chat.example.com/", "https://chat.example.com/app", "http://chat.example.com", "https://*.example.com",
                "ftp://x.example.com", "https://chat.example.com:99999", "capacitor://evil"):
        if bad == "https://chat.example.com/":
            # 結尾的 / 只是寫法（rstrip）：接受
            ChatConfig.from_env({**BASE, "CHAT_APP_ORIGINS": bad})
            continue
        refused({"CHAT_APP_ORIGINS": bad}, "CHAT_APP_ORIGINS")
    refused({"CHAT_APP_ORIGINS": " , "}, "CHAT_APP_ORIGINS is required")
    refused({"CHAT_STUN_URLS": "turn:turn.example.com"}, "CHAT_STUN_URLS")
    refused({"CHAT_PRIVACY_URL": "http://example.com/privacy"}, "CHAT_PRIVACY_URL must be an https://")
    refused({"CHAT_SERVER_NAME": "x" * 65}, "CHAT_SERVER_NAME")
    refused({"CHAT_WEBPUSH_HOSTS": "fcm.googleapis.com,bad host"}, "CHAT_WEBPUSH_HOSTS")
    refused({"CHAT_WEBPUSH_HOSTS": "com"}, "CHAT_WEBPUSH_HOSTS: 'com' is not a host name")   # 單一節 ＝ 整個頂級網域


def proxy_rules():
    refused({"CHAT_TRUSTED_PROXIES": "none", "CHAT_PROXY_TOKEN": PROXY}, "CHAT_PROXY_TOKEN is set but CHAT_TRUSTED_PROXIES is 'none'")
    refused({"CHAT_PROXY_TOKEN": None}, "CHAT_PROXY_TOKEN is required")
    refused({"CHAT_TRUSTED_PROXIES": "127.0.0.1,proxy.example.com"}, "is not an IP address or CIDR")
    for broad in ("0.0.0.0/0", "::/0", "0.0.0.0/1,128.0.0.0/1", "10.0.0.0/7", "2000::/3"):
        refused({"CHAT_TRUSTED_PROXIES": broad}, "trusts far too many addresses")
    ChatConfig.from_env({**BASE, "CHAT_TRUSTED_PROXIES": "10.0.0.0/8,fd00::/16"})   # 一整個私有網段還算合理
    refused({"CHAT_TRUSTED_PROXIES": ","}, "CHAT_TRUSTED_PROXIES lists no address")


def choice_and_number_rules():
    refused({"CHAT_REGISTRATION": "public"}, "CHAT_REGISTRATION must be one of open, invite, closed")
    refused({"CHAT_MQTT_ACL_FORMAT": "v2"}, "CHAT_MQTT_ACL_FORMAT must be one of rules, legacy")
    refused({"AEGIS_MQTT_PORT": "abc"}, "AEGIS_MQTT_PORT must be an integer")
    refused({"AEGIS_MQTT_PORT": "70000"}, "AEGIS_MQTT_PORT must be between 1 and 65535")
    refused({"CHAT_TOKEN_TOPICS_PER_DAY": "199"}, "CHAT_TOKEN_TOPICS_PER_DAY must be between 200")
    refused({"CHAT_REGISTER_PER_DAY": "-1"}, "CHAT_REGISTER_PER_DAY must be between 0")


def push_rules():
    refused({"CHAT_VAPID_PUBLIC_KEY": VAPID_PUB}, "must be set together", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({"CHAT_VAPID_PRIVATE_KEY": VAPID_PRIV}, "must be set together", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({"CHAT_VAPID_SUBJECT": "mailto:a@b.c"}, "CHAT_VAPID_SUBJECT is set but the VAPID key pair is not")
    pair = {"CHAT_VAPID_PUBLIC_KEY": VAPID_PUB, "CHAT_VAPID_PRIVATE_KEY": VAPID_PRIV}
    refused(pair, "CHAT_VAPID_SUBJECT must be a mailto:", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({**pair, "CHAT_VAPID_SUBJECT": "ops@example.com"}, "CHAT_VAPID_SUBJECT must be a mailto:", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({**pair, "CHAT_VAPID_PUBLIC_KEY": OTHER_PUB, "CHAT_VAPID_SUBJECT": "mailto:a@b.c"},
            "does not belong to CHAT_VAPID_PRIVATE_KEY", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({**pair, "CHAT_VAPID_PRIVATE_KEY": "not-a-key", "CHAT_VAPID_SUBJECT": "mailto:a@b.c"}, "are not base64url P-256 keys")
    if not HAVE_WEBPUSH:
        refused({**pair, "CHAT_VAPID_SUBJECT": "mailto:a@b.c"}, "pywebpush is not installed", secrets=(MQTT, PROXY, VAPID_PRIV))
    refused({"CHAT_FCM_CREDENTIALS": os.path.join(TMP, "missing.json")}, "CHAT_FCM_CREDENTIALS: cannot read")
    refused({"CHAT_FCM_CREDENTIALS": fcm_bad}, "must be a Firebase service account JSON")
    garbage = os.path.join(TMP, "garbage.json")
    Path(garbage).write_text("{not json")
    refused({"CHAT_FCM_CREDENTIALS": garbage}, "CHAT_FCM_CREDENTIALS: cannot read")
    if not HAVE_FIREBASE:
        refused({"CHAT_FCM_CREDENTIALS": fcm_ok}, "firebase-admin is not installed")


def db_rules():
    refused({"AEGIS_DB_PATH": "relative/chat.db"}, "AEGIS_DB_PATH must be an absolute path")
    ro = os.path.join(TMP, "readonly")
    os.makedirs(ro)
    os.chmod(ro, stat.S_IRUSR | stat.S_IXUSR)
    try:
        if os.geteuid() != 0:   # root 寫得進任何資料夾
            refused({"AEGIS_DB_PATH": os.path.join(ro, "chat.db")}, f"AEGIS_DB_PATH: the folder {ro} is not writable")
            refused({"AEGIS_GROUP_LOG_DB_PATH": os.path.join(ro, "log.db")}, "AEGIS_GROUP_LOG_DB_PATH: the folder")
    finally:
        os.chmod(ro, stat.S_IRWXU)
    folder = os.path.join(TMP, "isdir")
    os.makedirs(os.path.join(folder, "chat.db"))
    refused({"AEGIS_DB_PATH": os.path.join(folder, "chat.db")}, "exists but is not a readable and writable file")


class Req:
    def __init__(self, peer, headers=()):
        self.client = type("C", (), {"host": peer})() if peer else None
        self._h = [(k.lower(), v) for k, v in headers]
        self.headers = self

    def get(self, name, default=None):
        return next((v for k, v in self._h if k == name.lower()), default)

    def getlist(self, name):
        return [v for k, v in self._h if k == name.lower()]


def proxy_guard():
    direct = make_proxy_guard((), "")
    assert direct.client_ip(Req("203.0.113.5", [("X-Forwarded-For", "1.2.3.4")])) == "203.0.113.5"
    assert direct.internal_ok(Req("203.0.113.5")) is True
    g = make_proxy_guard((ipaddress.ip_network("172.30.0.1/32"), ipaddress.ip_network("10.0.0.0/8")), PROXY)
    tok = (PROXY_TOKEN_HEADER, PROXY)
    cases = [
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "198.51.100.7")]), "198.51.100.7", True),
        # client 自己塞在左邊的不算（nginx 附加式）；中間經過另一層信任的代理
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "1.1.1.1, 198.51.100.7, 10.1.2.3")]), "198.51.100.7", True),
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "1.1.1.1"), ("X-Forwarded-For", "198.51.100.8")]), "198.51.100.8", True),
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "2001:db8::5")]), "2001:db8::5", True),
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "garbage, 198.51.100.7")]), "198.51.100.7", True),
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "198.51.100.7, garbage")]), "172.30.0.1", True),
        (Req("172.30.0.1", [tok, ("X-Forwarded-For", "10.0.0.5")]), "172.30.0.1", True),
        (Req("172.30.0.1", [tok]), "172.30.0.1", True),
        (Req("::ffff:172.30.0.1", [tok, ("X-Forwarded-For", "198.51.100.9")]), "198.51.100.9", True),
        # 受信任的位址、沒有／錯的 token：不算經過代理
        (Req("172.30.0.1", [("X-Forwarded-For", "198.51.100.7")]), "172.30.0.1", False),
        (Req("172.30.0.1", [(PROXY_TOKEN_HEADER, PROXY[:-1] + "x"), ("X-Forwarded-For", "198.51.100.7")]), "172.30.0.1", False),
        # 不受信任的位址帶了對的 token（token 外流、或繞過代理）：也不算
        (Req("203.0.113.9", [tok, ("X-Forwarded-For", "198.51.100.7")]), "203.0.113.9", False),
        (Req(None, [tok]), "unknown", False),
        (Req("testclient", [tok, ("X-Forwarded-For", "198.51.100.7")]), "testclient", False),
    ]
    for req, ip, internal in cases:
        assert g.client_ip(req) == ip and g.internal_ok(req) is internal, (req._h, req.client and req.client.host, g.client_ip(req), g.internal_ok(req))


check("a complete configuration starts; describe()/repr() show no secret; invite and no push by default; 'none' proxy; ws:// for localhost", full_config)
check("required settings missing → refused, all problems listed at once", required_settings)
check("secrets: < 32 characters, surrounding spaces, two equal (incl. the caller's own) → refused", secret_rules)
check("broker URL wss:// only (localhost may use ws://); CORS origins, STUN, links, server name, push hosts validated", url_and_origin_rules)
check("reverse proxy: 'none' with a token, list without token, bad addresses, ranges broader than /8 (v4) or /16 (v6) → refused", proxy_rules)
check("choices and numbers out of range → refused", choice_and_number_rules)
check("push: half-set or mismatched VAPID pair, no/invalid subject, unreadable/foreign FCM file, missing packages → refused", push_rules)
check("database: relative path, unwritable folder, a directory in the way → refused", db_rules)
check("ProxyGuard: X-Forwarded-For only via a trusted address with the token; right-most non-proxy hop; untrusted/forged ignored", proxy_guard)


def ipv6_rate_key():
    from chat.ratelimit import rate_key
    assert rate_key("198.51.100.7") == "198.51.100.7"
    assert rate_key("2001:db8:1:2:aaaa::1") == rate_key("2001:db8:1:2:ffff:ffff:ffff:ffff") == "2001:db8:1:2::/64"
    assert rate_key("2001:db8:1:3::1") != rate_key("2001:db8:1:2::1")
    assert rate_key("::ffff:203.0.113.9") == "203.0.113.9" and rate_key("unknown") == "unknown"


check("per-IP limits key IPv6 clients on their /64 (one home network = one bucket), IPv4 as is", ipv6_rate_key)

if failed:
    print(f"\n{failed} check(s) FAILED")
    sys.exit(1)
print("\nALL PASS")

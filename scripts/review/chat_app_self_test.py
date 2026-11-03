#!/usr/bin/env python3
"""
獨立的 chat 伺服器（api/chat_app.py create_app，開源計畫第 3 步），用 FastAPI TestClient 跑真的 app：

  1. 啟動：設定不對 → ChatConfigError（不建 app）；任何一個 chat 模組 import 失敗 → 拒絕啟動；/health；
     路由清單（沒有 AegisID／防詐／營運的路徑）；CORS 只放 CHAT_APP_ORIGINS
  2. import 圖：chat_app 與它 import 的每一個模組都不碰 AegisID、防詐、營運、付款、AegisTrans（另開一個 python 實際 import、
     再掃一遍原始碼裡的 import），api/ 底下被載入的只有 chat_app.py、chat/*、group_log_routes.py
  3. GET /api/chat/server-config：欄位、registration／push 旗標、沒有任何秘密
  4. Keys-only 註冊（POST /api/account/register）：invite 政策（沒碼 403、錯碼 403、對的碼 200、碼的次數／期限、
     猜錯太多 429）、open、closed；簽章（別人的金鑰、改過的欄位、非標準 base64 → 401；時鐘差 → 401 clock_skew；
     多送欄位 422）；request_id 只能用一次（409）；已經註冊的金鑰再註冊 → created false、不吃碼也不算額度；
     每 IP、全部的每小時上限（429，IP 只採信經過反向代理的 X-Forwarded-For）
  5. 第 2 步以前「沒有 AegisID 帳號就 403」的端點，用 keys-only 帳號全部可以用：MQTT token（沒帳號 403）、裝置 claim、
     短碼（簽章版）、群組 log append、Web Push 登記與推播（只收 message／incoming_call；沒開 FCM 就沒有 register-token）
  6. python -m chat.invites create／list／revoke、python -m chat.vapid
不連任何服務（Web Push 的送出換成記錄）。Run: python3 scripts/review/chat_app_self_test.py
（需要 fastapi、pydantic 2、PyJWT、cryptography、httpx；Web Push 那段需要 pywebpush）
"""
import ast
import base64
import hashlib
import importlib.util
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

API_DIR = Path(os.environ.get("AEGISTALK_API_DIR", str(Path(__file__).resolve().parents[2] / "api")))
sys.path.insert(0, str(API_DIR))
import chat_app  # noqa: E402
from chat import push as push_module  # noqa: E402
from chat.config import ChatConfigError  # noqa: E402

HAVE_WEBPUSH = importlib.util.find_spec("pywebpush") is not None
TMP = tempfile.mkdtemp(prefix="chat-app-")
MQTT = "chat-app-fixture-mqtt-secret-0123456789"
PROXY = "chat-app-fixture-proxy-token-0123456789"
PROXY_PEER = "172.30.0.1"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def vapid_pair():
    key = ec.generate_private_key(ec.SECP256R1())
    return b64url(key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)), \
        b64url(key.private_numbers().private_value.to_bytes(32, "big"))


VAPID_PUB, VAPID_PRIV = vapid_pair()


def env_for(name: str, **over) -> dict:
    folder = os.path.join(TMP, name)
    env = {
        "AEGIS_MQTT_JWT_SECRET": MQTT,
        "AEGIS_DB_PATH": os.path.join(folder, "chat.db"),
        "CHAT_PUBLIC_MQTT_URL": "wss://mqtt.example.test/mqtt",
        "CHAT_APP_ORIGINS": "https://chat.example.test,https://localhost,capacitor://localhost",
        "CHAT_TRUSTED_PROXIES": PROXY_PEER,
        "CHAT_PROXY_TOKEN": PROXY,
        "CHAT_STUN_URLS": "stun:stun.example.test:3478",
        "CHAT_SERVER_NAME": "Example chat",
        "CHAT_SUPPORT_URL": "https://example.test/help",
    }
    if HAVE_WEBPUSH:
        env.update(CHAT_VAPID_PUBLIC_KEY=VAPID_PUB, CHAT_VAPID_PRIVATE_KEY=VAPID_PRIV, CHAT_VAPID_SUBJECT="mailto:ops@example.test")
    env.update(over)
    return {k: v for k, v in env.items() if v is not None}


def with_peer(app):
    """X-Test-Peer：app 看到的 TCP 對方位址（172.30.0.1 ＝ 反向代理）"""
    async def wrapped(scope, receive, send):
        if scope["type"] == "http":
            peer = dict(scope["headers"]).get(b"x-test-peer")
            if peer:
                scope = {**scope, "client": (peer.decode(), 4321)}
        await app(scope, receive, send)
    return wrapped


def via(ip: str) -> dict:
    """經過反向代理、client 是 ip"""
    return {"X-Test-Peer": PROXY_PEER, "X-Aegis-Internal": PROXY, "X-Forwarded-For": ip}


def keypair():
    priv = Ed25519PrivateKey.generate()
    return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def sign(priv, payload: dict) -> str:
    return base64.b64encode(priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())).decode()


def rid() -> str:
    return secrets.token_hex(12)


def url(pk: str) -> str:
    return base64.urlsafe_b64encode(base64.b64decode(pk)).decode().rstrip("=")


def reg_body(priv, pk, invite=None, **over):
    f = {"action": "account_register", "pubkey": pk, "timestamp": int(time.time()), "request_id": rid()}
    if invite is not None:
        f["invite_code"] = invite
    f.update(over)
    signed = {k: v for k, v in f.items() if k != "signature"}
    return {**f, "signature": f.get("signature") or sign(priv, signed)}


failed = 0


def check(name, fn):
    global failed
    try:
        fn()
        print("PASS", name)
    except Exception as e:
        failed += 1
        import traceback
        print("FAIL", name, "\n    ", f"{type(e).__name__}: {str(e)[:800]}")
        traceback.print_exc(limit=3)


# Web Push 的送出換成記錄（WebPushSender 的建構照真的跑：VAPID 私鑰要讀得進去）
webpush_sent = []
push_module.WebPushSender.send = lambda self, endpoint, p256dh, auth, data: (webpush_sent.append((endpoint, data)), "sent")[1]


def invite(env, *args) -> str:
    r = subprocess.run([sys.executable, "-m", "chat.invites", *args], cwd=str(API_DIR), env={**os.environ, **env, "PYTHONDONTWRITEBYTECODE": "1"},
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 or args[0] == "revoke", r.stderr
    return r.stdout.strip()


# ───────────── 1. 啟動 ─────────────
def startup_and_routes():
    try:
        chat_app.create_app(env_for("bad", AEGIS_MQTT_JWT_SECRET=None, CHAT_PUBLIC_MQTT_URL="ws://mqtt.example.test/mqtt"))
        raise AssertionError("create_app must refuse a bad configuration")
    except ChatConfigError as e:
        assert "AEGIS_MQTT_JWT_SECRET is required" in str(e) and "CHAT_PUBLIC_MQTT_URL must be a wss://" in str(e), str(e)
    app = chat_app.create_app(env_for("routes"))
    served = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    expected = {("GET", "/health"), ("GET", "/api/chat/server-config"), ("POST", "/api/account/register"),
                ("POST", "/api/mqtt/token"), ("POST", "/api/mqtt/transfer-token"),
                ("POST", "/api/devices/claim"), ("POST", "/api/devices/heartbeat"), ("POST", "/api/devices/info"),
                ("POST", "/api/shortcode/register"), ("POST", "/api/shortcode/refresh"), ("GET", "/api/shortcode/lookup/{code}"),
                ("POST", "/api/group-log/{gid}"), ("GET", "/api/group-log/{gid}"), ("POST", "/api/push/notify")}
    if HAVE_WEBPUSH:
        expected |= {("POST", "/api/push/webpush/register"), ("POST", "/api/push/webpush/unregister")}
    assert served == expected, f"missing {sorted(expected - served)}, unexpected {sorted(served - expected)}"
    c = TestClient(with_peer(app))
    assert c.get("/health").json() == {"ok": True, "service": "aegistalk-chat"}
    ok = c.options("/api/account/register", headers={"Origin": "https://chat.example.test", "Access-Control-Request-Method": "POST",
                                                     "Access-Control-Request-Headers": "content-type"})
    assert ok.status_code == 200 and ok.headers.get("access-control-allow-origin") == "https://chat.example.test", dict(ok.headers)
    assert ok.headers.get("access-control-allow-credentials") is None, "no credentials: requests are signed, never cookies"
    bad = c.options("/api/account/register", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert bad.headers.get("access-control-allow-origin") is None
    # 一個 chat 模組 import 失敗 → 拒絕啟動（另開一個 python：把 chat.shortcode 換成「import 不到」）
    code = ("import sys; sys.modules['chat.shortcode'] = None; import chat_app\n"
            "try:\n    chat_app.create_app()\nexcept Exception as e:\n    print(type(e).__name__, e); sys.exit(3)\n")
    r = subprocess.run([sys.executable, "-c", code], cwd=str(API_DIR), env={**os.environ, **env_for("broken"), "PYTHONDONTWRITEBYTECODE": "1"},
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 3 and "ChatConfigError" in r.stdout and "chat.shortcode failed to import" in r.stdout, r.stdout + r.stderr


# ───────────── 2. import 圖 ─────────────
FORBIDDEN = ("aegisid", "aegispay", "aegistrans", "antifraud", "ops_routes", "main", "yaml", "crossmint", "moonpay")
ALLOWED_FILES = {"chat_app.py", "group_log_routes.py"}


def import_graph():
    code = ("import sys, json; import chat_app; chat_app.create_app()\n"
            "print(json.dumps({n: getattr(m, '__file__', None) for n, m in list(sys.modules.items()) if m is not None}))\n")
    r = subprocess.run([sys.executable, "-c", code], cwd=str(API_DIR), env={**os.environ, **env_for("graph"), "PYTHONDONTWRITEBYTECODE": "1"},
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    mods = json.loads(r.stdout.strip().splitlines()[-1])
    bad = sorted(n for n in mods if any(n == f or n.startswith(f + ".") or n.startswith(f + "_") for f in FORBIDDEN))
    assert not bad, f"forbidden modules imported by chat_app: {bad}"
    api_files = sorted(os.path.relpath(f, API_DIR) for f in mods.values() if f and os.path.abspath(f).startswith(str(API_DIR) + os.sep))
    stray = [f for f in api_files if f not in ALLOWED_FILES and not f.startswith("chat" + os.sep)]
    assert not stray, f"chat_app loads other api/ files: {stray}"
    assert "chat_app.py" in api_files and "group_log_routes.py" in api_files and any(f.startswith("chat" + os.sep) for f in api_files)
    # 原始碼裡（含只在函式裡才 import 的）也沒有
    sources = [API_DIR / "chat_app.py", API_DIR / "group_log_routes.py", *sorted((API_DIR / "chat").glob("*.py"))]
    for f in sources:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for n in ast.walk(tree):
            names = [a.name for a in n.names] if isinstance(n, ast.Import) else ([n.module or ""] if isinstance(n, ast.ImportFrom) and n.level == 0 else [])
            for name in names:
                top = name.split(".")[0].lower()
                assert not any(top == x or top.startswith(x + "_") or top.startswith(x) and x in ("aegisid", "aegispay", "aegistrans", "antifraud")
                               for x in FORBIDDEN), f"{f.name} imports {name}"
            if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "import_module" and n.args and isinstance(n.args[0], ast.Constant):
                assert not any(x in str(n.args[0].value).lower() for x in ("aegisid", "antifraud", "ops_routes", "aegispay", "aegistrans")), f.name
        text = f.read_text(encoding="utf-8")
        assert "sys.path.insert" not in text and "sys.path.append" not in text, f"{f.name} edits sys.path (would reach other repos)"
    print(f"    import graph: {len(mods)} modules, api/ files loaded: {api_files}")


# ───────────── 3. server-config ─────────────
def server_config():
    app = chat_app.create_app(env_for("config", CHAT_REGISTRATION="open"))
    c = TestClient(app)
    r = c.get("/api/chat/server-config")
    assert r.status_code == 200 and "max-age" in r.headers.get("cache-control", ""), r.headers
    cfg = r.json()
    assert cfg == {
        "service": "aegistalk-chat", "api_version": 1, "mqtt_url": "wss://mqtt.example.test/mqtt",
        "stun_urls": ["stun:stun.example.test:3478"], "vapid_public_key": VAPID_PUB if HAVE_WEBPUSH else None,
        "push": {"webpush": HAVE_WEBPUSH, "fcm": False, "types": ["message", "incoming_call"]},
        "backup": {"server": False}, "registration": "open", "name": "Example chat", "links": {"support": "https://example.test/help"},
    }, cfg
    blob = json.dumps(cfg)
    for s in (MQTT, PROXY, VAPID_PRIV):
        assert s not in blob, "server-config leaks a secret"
    plain = TestClient(chat_app.create_app(env_for("config2", CHAT_VAPID_PUBLIC_KEY=None, CHAT_VAPID_PRIVATE_KEY=None, CHAT_VAPID_SUBJECT=None)))
    cfg2 = plain.get("/api/chat/server-config").json()
    assert cfg2["registration"] == "invite" and cfg2["vapid_public_key"] is None and cfg2["push"]["webpush"] is False, cfg2
    assert plain.post("/api/push/notify", json={}).status_code == 404, "no push backend → no push routes"


# ───────────── 4. 註冊 ─────────────
def registration_invite():
    env = env_for("invite")
    app = chat_app.create_app(env)
    c = TestClient(with_peer(app))
    post = lambda body, ip="198.51.100.10": c.post("/api/account/register", json=body, headers=via(ip))  # noqa: E731
    a_priv, a = keypair()
    r = post(reg_body(a_priv, a))
    assert r.status_code == 403 and r.json()["detail"] == "invite_required", r.text
    r = post(reg_body(a_priv, a, invite="X" * 24))
    assert r.status_code == 403 and r.json()["detail"] == "invalid_invite", r.text
    code = invite(env, "create", "--uses", "2", "--days", "1", "--note", "test")
    assert len(code) == 24, code
    good = reg_body(a_priv, a, invite=code)
    r = post(good)
    assert r.status_code == 200 and r.json() == {"registered": True, "created": True, "registration": "invite"}, r.text
    assert post(good).status_code == 409, "replayed request"
    again = post(reg_body(a_priv, a, invite=code))
    assert again.status_code == 200 and again.json()["created"] is False, again.text
    listed = invite(env, "list")
    assert "uses_left=1" in listed and "active" in listed and code not in listed, listed   # 已有帳號的再註冊不吃次數；list 不印碼
    b_priv, b = keypair()
    assert post(reg_body(b_priv, b, invite=code)).json()["created"] is True
    c_priv, c_pk = keypair()
    r = post(reg_body(c_priv, c_pk, invite=code), ip="198.51.100.11")
    assert r.status_code == 403 and r.json()["detail"] == "invalid_invite", "used up"
    # 簽章與欄位
    d_priv, d = keypair()
    code2 = invite(env, "create")
    assert post(reg_body(c_priv, d, invite=code2), ip="198.51.100.12").status_code == 401, "signed by another key"
    tampered = reg_body(d_priv, d, invite=code2)
    assert post({**tampered, "invite_code": invite(env, "create")}, ip="198.51.100.12").status_code == 401, "invite code swapped after signing"
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    variant = d[:42] + alphabet[alphabet.index(d[42]) ^ 1] + "="
    assert post(reg_body(d_priv, variant, invite=code2), ip="198.51.100.12").status_code == 401, "non-canonical public key"
    skew = post(reg_body(d_priv, d, invite=code2, timestamp=int(time.time()) - 400), ip="198.51.100.12")
    detail = skew.json()["detail"]
    assert skew.status_code == 401 and isinstance(detail, dict) and detail.get("code") == "clock_skew", skew.text
    assert abs(detail["server_time"] - time.time()) < 5, detail
    assert post({**reg_body(d_priv, d, invite=code2), "account": "x"}, ip="198.51.100.12").status_code == 422, "unknown field"
    assert post(reg_body(d_priv, d, invite="short"), ip="198.51.100.12").status_code == 422, "malformed invite code"
    assert post(reg_body(d_priv, d, invite=code2), ip="198.51.100.12").json()["created"] is True
    # 期限、作廢
    e_priv, e_pk = keypair()
    expired = invite(env, "create", "--days", "0.00001")
    time.sleep(1.2)
    assert post(reg_body(e_priv, e_pk, invite=expired), ip="198.51.100.13").json()["detail"] == "invalid_invite", "expired"
    revoked = invite(env, "create")
    assert invite(env, "revoke", revoked) == "revoked 1"
    assert post(reg_body(e_priv, e_pk, invite=revoked), ip="198.51.100.13").json()["detail"] == "invalid_invite", "revoked"
    # 猜碼：同一個 IP 一小時錯 10 次之後 429（對的碼也一樣先擋）
    statuses = [post(reg_body(e_priv, e_pk, invite=secrets.token_urlsafe(18)), ip="198.51.100.14").status_code for _ in range(10)]
    assert statuses == [403] * 10, statuses
    r = post(reg_body(e_priv, e_pk, invite=invite(env, "create")), ip="198.51.100.14")
    assert r.status_code == 429 and r.json()["detail"] == "too_many_invite_attempts", r.text
    # 碼只存雜湊
    with sqlite3.connect(env["AEGIS_DB_PATH"]) as conn:
        hashes = [row[0] for row in conn.execute("SELECT code_hash FROM account_invites")]
        assert hashlib.sha256(code.encode()).hexdigest() in hashes and code not in hashes
        keys = [row[0] for row in conn.execute("SELECT account_key FROM pubkey_account_map")]
        assert len(keys) == 3 and all(k.startswith("chat_") and len(k) == 37 for k in keys), keys
        ips = " ".join(row[0] for row in conn.execute("SELECT scope FROM usage_events"))
        assert "198.51.100" not in ips, "IPs are stored as keyed hashes"


def registration_open_closed_limits():
    env = env_for("open", CHAT_REGISTRATION="open", CHAT_REGISTER_PER_IP_HOUR="2", CHAT_REGISTER_PER_HOUR="4")
    c = TestClient(with_peer(chat_app.create_app(env)))
    post = lambda body, headers: c.post("/api/account/register", json=body, headers=headers)  # noqa: E731
    keys = [keypair() for _ in range(8)]
    out = [post(reg_body(*keys[i]), via("203.0.113.1")).status_code for i in range(3)]
    assert out == [200, 200, 429], f"2 new accounts per IP per hour ({out})"
    assert post(reg_body(*keys[2]), via("203.0.113.1")).json()["detail"] == "registration_rate_limited"
    # 不經過代理送的 X-Forwarded-For 不算：從不受信任的位址換 XFF 也還是同一個 IP
    spoof = [post(reg_body(*keys[3 + i]), {"X-Test-Peer": "198.18.0.9", "X-Forwarded-For": f"10.1.1.{i}"}).status_code for i in range(3)]
    assert spoof == [200, 200, 429], f"spoofed X-Forwarded-For does not create new IPs ({spoof})"
    out = post(reg_body(*keys[6]), via("203.0.113.2"))
    assert out.status_code == 429 and out.json()["detail"] == "registration_rate_limited", "4 new accounts per hour in total"
    # 已經有帳號的金鑰：上限滿了照樣 200（created false）
    assert post(reg_body(*keys[0]), via("203.0.113.3")).json() == {"registered": True, "created": False, "registration": "open"}
    closed_env = {**env, "CHAT_REGISTRATION": "closed"}
    cc = TestClient(with_peer(chat_app.create_app(closed_env)))
    r = cc.post("/api/account/register", json=reg_body(*keys[7]), headers=via("203.0.113.4"))
    assert r.status_code == 403 and r.json()["detail"] == "registration_closed", r.text
    r = cc.post("/api/account/register", json=reg_body(*keys[1]), headers=via("203.0.113.4"))
    assert r.status_code == 200 and r.json()["created"] is False, "existing accounts keep working when registration is closed"


def ipv6_and_hashing():
    """IPv6 的 client 整個 /64 算一個 IP（審查 M）；用量表裡的 IP 雜湊金鑰混了伺服器的秘密，不是只靠資料庫裡的鹽（審查 M）"""
    env = env_for("ipv6", CHAT_REGISTRATION="open", CHAT_REGISTER_PER_IP_HOUR="2")
    c = TestClient(with_peer(chat_app.create_app(env)))
    out = [c.post("/api/account/register", json=reg_body(*keypair()), headers=via(f"2001:db8:aa:bb::{i + 1:x}")).status_code for i in range(3)]
    assert out == [200, 200, 429], f"three addresses in one /64 share the per-IP limit ({out})"
    assert c.post("/api/account/register", json=reg_body(*keypair()), headers=via("2001:db8:aa:bc::1")).status_code == 200, "another /64"
    import hmac as _hmac
    with sqlite3.connect(env["AEGIS_DB_PATH"]) as conn:
        db_salt = bytes.fromhex(conn.execute("SELECT v FROM chat_meta WHERE k = 'salt:events'").fetchone()[0])
        scopes = {r[0] for r in conn.execute("SELECT scope FROM usage_events")}
    db_only = "register-ip|" + _hmac.new(db_salt, b"2001:db8:aa:bb::/64", hashlib.sha256).hexdigest()[:32]
    assert db_only not in scopes and any(x.startswith("register-ip|") for x in scopes), "the hash key is not just the salt in the database"


# ───────────── 5. keys-only 帳號在每一個端點都能用 ─────────────
def keys_only_everywhere():
    env = env_for("everywhere", CHAT_REGISTRATION="open")
    c = TestClient(with_peer(chat_app.create_app(env)))
    a_priv, a = keypair()
    b_priv, b = keypair()
    g_priv, g = keypair()   # 沒註冊
    for priv, pk in ((a_priv, a), (b_priv, b)):
        assert c.post("/api/account/register", json=reg_body(priv, pk), headers=via("198.51.100.30")).json()["created"] is True
    INTERNAL = {"X-Test-Peer": PROXY_PEER, "X-Aegis-Internal": PROXY}
    device = "0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab"

    def token(priv, pk, headers=INTERNAL, **over):
        f = dict(action="mqtt_token", pubkey=pk, timestamp=int(time.time()), request_id=rid(), client_id=f"mist_{url(pk)[:16]}_{device[:8]}",
                 groups=["Tq3xZ0-_aB9cD8eF7gH6iJ"], presence=[], device_id=device)
        f.update(over)
        return c.post("/api/mqtt/token", json={**f, "signature": sign(priv, f)}, headers=headers)
    r = token(g_priv, g)
    assert r.status_code == 403 and r.json()["detail"] == "account_not_registered", r.text
    assert token(a_priv, a).status_code == 200, "keys-only account gets an MQTT token"
    r = token(a_priv, a, headers={"X-Test-Peer": "203.0.113.5", "X-Aegis-Internal": PROXY})
    assert r.status_code == 403 and r.json()["detail"] == "Unauthorized", "the token from an address that is not the proxy"

    def claim(priv, pk):
        ts = int(time.time())
        payload = {"device_id": device, "platform": "pwa", "display_label": "", "timestamp": ts, "action": "claim"}
        return c.post("/api/devices/claim", json={"device_id": device, "platform": "pwa", "timestamp": ts, "pubkey": pk, "signature": sign(priv, payload)})
    assert claim(g_priv, g).status_code == 403
    r = claim(a_priv, a)
    assert r.status_code == 200 and r.json()["success"] is True, r.text
    assert token(a_priv, a).status_code == 200, "token after claim (with kick topic)"

    def shortcode(priv, pk, action="register_shortcode", spk_priv=None):
        spk = base64.b64encode(os.urandom(32)).decode()
        sig = base64.b64encode((spk_priv or priv).sign(base64.b64decode(spk))).decode()
        f = {"action": action, "public_key": pk, "signed_pre_key": spk, "signature": sig, "display_name": "名字",
             "timestamp": int(time.time()), "request_id": rid()}
        path = "/api/shortcode/register" if action == "register_shortcode" else "/api/shortcode/refresh"
        return c.post(path, json={**f, "request_signature": sign(priv, f)}, headers=via("198.51.100.31"))
    assert shortcode(g_priv, g).status_code == 403
    r = shortcode(a_priv, a)
    assert r.status_code == 200 and r.json()["is_new"] is True, r.text
    look = c.get(f"/api/shortcode/lookup/ATK-{r.json()['short_code']}", headers=via("198.51.100.31")).json()
    assert look["pk"] == a and look["name"] == "名字", look

    def glog(priv, pk, blob="commit-1"):
        ts, r_id, gid = int(time.time()), rid(), "AbCdEfGhIjKlMnOpQrStUv"
        payload = {"action": "group_log_append", "pubkey": pk, "gid": gid, "blob_sha256": hashlib.sha256(blob.encode()).hexdigest(),
                   "timestamp": ts, "request_id": r_id}
        return c.post(f"/api/group-log/{gid}", json={"blob": blob, "pubkey": pk, "timestamp": ts, "request_id": r_id, "signature": sign(priv, payload)},
                      headers=via("198.51.100.32"))
    assert glog(g_priv, g).status_code == 403
    assert glog(a_priv, a).json() == {"seq": 1}
    assert os.path.exists(os.path.join(os.path.dirname(env["AEGIS_DB_PATH"]), "group_log.db")), "the log has its own file next to the DB"
    assert c.post("/api/push/register-token", json={}).status_code == 404, "FCM is off → no FCM registration route"
    if not HAVE_WEBPUSH:
        print("    (pywebpush not installed: Web Push part skipped)")
        return
    sub_key = ec.generate_private_key(ec.SECP256R1())
    p256dh = b64url(sub_key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
    endpoint = "https://fcm.googleapis.com/fcm/send/abc:def"

    def wp_register(priv, pk):
        f = {"action": "webpush_register", "pubkey": pk, "endpoint": endpoint, "p256dh": p256dh, "auth": b64url(os.urandom(16)),
             "timestamp": int(time.time()), "request_id": rid()}
        return c.post("/api/push/webpush/register", json={**f, "signature": sign(priv, f)}, headers=via("198.51.100.33"))
    assert wp_register(g_priv, g).status_code == 403
    assert wp_register(b_priv, b).json() == {"success": True}

    def notify(priv, pk, to, hint):
        f = {"action": "push_notify", "pubkey": pk, "recipient_pubkey": to, "notificationHint": hint, "timestamp": int(time.time()), "request_id": rid()}
        return c.post("/api/push/notify", json={**{k: v for k, v in f.items() if k != "action"}, "signature": sign(priv, f)})
    assert notify(g_priv, g, b, {"type": "message"}).status_code == 403
    webpush_sent.clear()
    r = notify(a_priv, a, b, {"type": "incoming_call", "isVideoCall": True})
    assert r.json() == {"success": True, "sent": 1}, r.text
    assert webpush_sent == [(endpoint, {"type": "incoming_call", "action": "wake_and_sync", "senderPubkey": a, "isVideoCall": "true"})], webpush_sent
    r = notify(a_priv, a, b, {"type": "guardian_alert"})
    assert r.status_code == 422 and r.json()["detail"] == "unsupported_push_type", r.text


# ───────────── 6. 指令 ─────────────
def vapid_cli():
    r = subprocess.run([sys.executable, "-m", "chat.vapid"], cwd=str(API_DIR), capture_output=True, text=True, timeout=60,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    lines = dict(line.split("=", 1) for line in r.stdout.strip().splitlines())
    assert set(lines) == {"CHAT_VAPID_PUBLIC_KEY", "CHAT_VAPID_PRIVATE_KEY"}, r.stdout
    from chat.config import ChatConfig
    if HAVE_WEBPUSH:
        cfg = ChatConfig.from_env({**env_for("vapid"), **lines, "CHAT_VAPID_SUBJECT": "https://example.test"})
        assert cfg.webpush_enabled and cfg.vapid_public_key == lines["CHAT_VAPID_PUBLIC_KEY"]


check("startup: bad settings / a chat module that fails to import → refused; exact route set; /health; CORS only CHAT_APP_ORIGINS", startup_and_routes)
check("import graph: no AegisID, anti-fraud, ops, payments or AegisTrans module reachable from chat_app (runtime + source)", import_graph)
check("GET /api/chat/server-config: public connection details and flags, no secrets; no push backend → no push routes", server_config)
check("registration (invite): codes required/checked/counted/expire/revocable, signature/replay/clock-skew/extra-field rules, "
      "guessing limited, codes and IPs hashed at rest", registration_invite)
check("registration (open/closed): per-IP and global hourly limits via the proxy-resolved IP, existing keys unaffected, closed", registration_open_closed_limits)
check("IPv6 clients are limited per /64; IP hashes are keyed with a server secret, not only the database salt", ipv6_and_hashing)
check("keys-only accounts work wherever an AegisID account was needed: token, device claim, short code, group log, Web Push register + notify",
      keys_only_everywhere)
check("python -m chat.vapid prints a pair ChatConfig accepts", vapid_cli)

if failed:
    print(f"\n{failed} check(s) FAILED")
    sys.exit(1)
print("\nALL PASS")

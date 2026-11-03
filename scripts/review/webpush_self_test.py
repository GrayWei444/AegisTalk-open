#!/usr/bin/env python3
"""
Web Push（開源計畫決定 4）：api/chat/push.py 的訂閱登記與送出。

  1. 登記（POST /api/push/webpush/register）：帳戶簽章（別人的金鑰／改過的欄位 401、時鐘差 401 clock_skew、沒帳號 403、
     重放 409、多送欄位 422）；網址只收推播服務（http、內網 IP、localhost、帳密、別的 port、不在名單的主機、控制字元 → 400，
     SSRF）；p256dh 要是真的 P-256 點、auth 16 bytes（400）；同一個網址只屬於最後簽章的金鑰；一把金鑰最多 5 個
  2. 取消（/unregister）：只拿得掉自己的
  3. 推播：送到收件人的每一個訂閱；推播服務說 404／410 的訂閱刪掉；送不出去的不算 sent
  4. 真的 pywebpush 送到本機一個假的推播服務：VAPID JWT（ES256，aud／sub／exp）用設定的公鑰驗得過、內容用訂閱的金鑰
     解得開（aes128gcm）且就是伺服器組的那份；TTL、Urgency；410 → gone、401／403（不是用這把 VAPID 金鑰訂的，開源第 4 步審查 M3）→ gone、
     500 → failed；重新導向一律不跟（導向的網址沒被打到）
不連任何外部服務。Run: python3 scripts/review/webpush_self_test.py   （需要 fastapi、pydantic 2、cryptography、httpx、pywebpush）
"""
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

API_DIR = Path(os.environ.get("AEGISTALK_API_DIR", str(Path(__file__).resolve().parents[2] / "api")))
sys.path.insert(0, str(API_DIR))
from chat import push, signing  # noqa: E402
from chat.config import ProxyGuard  # noqa: E402

try:
    import http_ece  # noqa: F401  （pywebpush 的相依套件）
    import pywebpush  # noqa: F401
except ImportError:
    print("SKIP webpush_self_test: pywebpush is not installed (pip install -r api/requirements-webpush.txt)")
    sys.exit(0)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def unb64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


vapid_key = ec.generate_private_key(ec.SECP256R1())
VAPID_PUB = b64url(vapid_key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
VAPID_PRIV = b64url(vapid_key.private_numbers().private_value.to_bytes(32, "big"))
SUBJECT = "mailto:ops@example.test"
failed = 0


def check(name, fn):
    global failed
    try:
        fn()
        print("PASS", name)
    except Exception as e:
        failed += 1
        print("FAIL", name, "\n    ", f"{type(e).__name__}: {str(e)[:700]}")


def keypair():
    priv = Ed25519PrivateKey.generate()
    return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def sign(priv, payload: dict) -> str:
    return base64.b64encode(priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())).decode()


def subscription_keys():
    key = ec.generate_private_key(ec.SECP256R1())
    return key, b64url(key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)), b64url(os.urandom(16))


TMP = tempfile.mkdtemp(prefix="webpush-")


@contextmanager
def get_db():
    c = sqlite3.connect(os.path.join(TMP, "db"))
    c.row_factory = sqlite3.Row
    try:
        yield c
    finally:
        c.close()


with get_db() as conn:
    signing.create_tables(conn.cursor())
    push.create_tables(conn.cursor())
    conn.commit()


def register_account(pk):
    with get_db() as conn:
        conn.execute("INSERT INTO pubkey_account_map (pubkey_hash, account_key, created_at) VALUES (?,?,0)",
                     (hashlib.sha256(pk.encode()).hexdigest(), "acct-" + pk[:8]))
        conn.commit()


sender = push.WebPushSender(VAPID_PRIV, SUBJECT)
results = {}      # endpoint → "sent"/"gone"/"failed"（送出換成這張表）
sends = []
sender.send = lambda endpoint, p256dh, auth, data: (sends.append((endpoint, data)), results.get(endpoint, "sent"))[1]
app = FastAPI()
app.include_router(push.create_push_router(get_db, signing.resolve_account_key,
                                           ProxyGuard(client_ip=lambda req: req.headers.get("X-Test-IP", "203.0.113.9"), internal_ok=lambda req: True),
                                           fcm=False, webpush=sender))
client = TestClient(app)
alice_priv, alice = keypair()
bob_priv, bob = keypair()
ghost_priv, ghost = keypair()
for pk in (alice, bob):
    register_account(pk)
counter = [0]


def reg(priv, pk, endpoint, p256dh=None, auth=None, ip=None, **over):
    _, p, a = subscription_keys()
    f = {"action": "webpush_register", "pubkey": pk, "endpoint": endpoint, "p256dh": p256dh or p, "auth": auth or a,
         "timestamp": int(time.time()), "request_id": secrets.token_hex(12)}
    f.update(over)
    signed = {k: v for k, v in f.items() if k != "signature"}
    counter[0] += 1
    return {**f, "signature": f.get("signature") or sign(priv, signed)}, (ip or f"198.51.100.{counter[0] % 250}")


def post(path, body_ip, status):
    body, ip = body_ip
    r = client.post(path, json=body, headers={"X-Test-IP": ip})
    assert r.status_code == status, (path, status, r.status_code, r.text, body.get("endpoint"))
    return r.json()


FCM = "https://fcm.googleapis.com/fcm/send/"


def subs_of(pk):
    with get_db() as conn:
        return [r[0] for r in conn.execute("SELECT endpoint FROM webpush_subscriptions WHERE pubkey_hash = ? ORDER BY id",
                                           (hashlib.sha256(pk.encode()).hexdigest(),))]


def registration():
    post("/api/push/webpush/register", reg(alice_priv, alice, FCM + "a1"), 200)
    assert subs_of(alice) == [FCM + "a1"]
    body, ip = reg(alice_priv, alice, FCM + "a2")
    post("/api/push/webpush/register", (body, ip), 200)
    post("/api/push/webpush/register", (body, ip), 409)                                    # 重放
    post("/api/push/webpush/register", ({**body, "request_id": secrets.token_hex(12)}, ip), 401)
    post("/api/push/webpush/register", reg(bob_priv, alice, FCM + "a3"), 401)              # 別人的金鑰簽的
    b, i = reg(alice_priv, alice, FCM + "a4")
    post("/api/push/webpush/register", ({**b, "endpoint": FCM + "evil"}, i), 401)          # 簽完換網址
    post("/api/push/webpush/register", reg(ghost_priv, ghost, FCM + "g1"), 403)            # 沒帳號
    r = post("/api/push/webpush/register", reg(alice_priv, alice, FCM + "a5", timestamp=int(time.time()) - 600), 401)
    assert r["detail"]["code"] == "clock_skew", r
    post("/api/push/webpush/register", reg(alice_priv, alice, FCM + "a6", extra="x"), 422)
    # 同一個網址只屬於最後簽章的金鑰（同一個瀏覽器換帳號）
    post("/api/push/webpush/register", reg(bob_priv, bob, FCM + "a1"), 200)
    assert FCM + "a1" not in subs_of(alice) and subs_of(bob) == [FCM + "a1"]
    # 一把金鑰最多 5 個，多的刪最舊的
    for n in range(3, 10):
        post("/api/push/webpush/register", reg(alice_priv, alice, FCM + f"cap{n}"), 200)
    assert len(subs_of(alice)) == 5 and subs_of(alice)[-1] == FCM + "cap9" and FCM + "a2" not in subs_of(alice), subs_of(alice)


def endpoint_rules():
    bad = ["http://fcm.googleapis.com/fcm/send/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://10.0.0.1/x",
           "https://169.254.169.254/latest/meta-data", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
           "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://evilfcm.googleapis.com.example/x",
           "https://fcm.googleapis.com/x\ny", "https://fcm.googleapis.com/x y", "https://xfcm.googleapis.com.attacker.test/x",
           "ftp://fcm.googleapis.com/x", "https://" + "a" * 1020,
           # 審查 HIGH：urlsplit 跟 urllib3 對 \ 的看法不同 —— 檢查看到 fcm.googleapis.com 的子網域，送出去連的是 169.254.169.254
           "https://169.254.169.254\\.fcm.googleapis.com/latest/meta-data", "https://evil.example\\@fcm.googleapis.com/x",
           "https://evil.example%2f.fcm.googleapis.com/x", "https://fcm.googleapis.com%2f@evil.example/x", "https://fcm.googleapis.com@evil.example/x",
           "https://evil.example#@fcm.googleapis.com/x", "https://fcm.googleapis.com/x\\y", "https://FCM.googleapis.com/x",
           "https://fcm.googleapis.com./x", "https://fcm.googleapis.com:443@evil.example/x", "https://xn--fcm.googleapis.com.evil.example/x",
           "https://fcm.googleapis.com/x#frag", "https://fcm.googleapis.com/ünicode"]
    for e in bad:
        r = client.post("/api/push/webpush/register", json=reg(alice_priv, alice, e)[0], headers={"X-Test-IP": "192.0.2.1" + str(len(e) % 9)})
        assert r.status_code in (400, 422), (e, r.status_code, r.text)
        if r.status_code == 400:
            assert r.json()["detail"] == "invalid_endpoint", (e, r.text)
    good = ["https://fcm.googleapis.com/wp/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/QG",
            "https://wns2-par02p.notify.windows.com/w/?token=x", "https://fcm.googleapis.com:443/wp/x"]
    for e in good:
        post("/api/push/webpush/register", reg(bob_priv, bob, e), 200)
    _, p, a = subscription_keys()
    not_on_curve = b64url(b"\x04" + b"\x01" * 64)
    for p256dh, auth in ((not_on_curve, a), (b64url(b"\x02" + os.urandom(32)) + "A" * 44, a), (p, b64url(os.urandom(15))),
                         (p, b64url(os.urandom(17))), (p[:-1] + "!", a)):
        r = client.post("/api/push/webpush/register", json=reg(bob_priv, bob, FCM + "k", p256dh=p256dh, auth=auth)[0], headers={"X-Test-IP": "192.0.2.50"})
        assert r.status_code in (400, 422), (p256dh, auth, r.text)


def unregister():
    def unreg(priv, pk, endpoint):
        f = {"action": "webpush_unregister", "pubkey": pk, "endpoint": endpoint, "timestamp": int(time.time()), "request_id": secrets.token_hex(12)}
        return client.post("/api/push/webpush/unregister", json={**f, "signature": sign(priv, f)}, headers={"X-Test-IP": "192.0.2.60"})
    post("/api/push/webpush/register", reg(bob_priv, bob, FCM + "u1"), 200)
    assert unreg(alice_priv, alice, FCM + "u1").json() == {"success": True, "removed": 0}, "someone else's subscription cannot be removed"
    assert FCM + "u1" in subs_of(bob)
    assert unreg(bob_priv, bob, FCM + "u1").json() == {"success": True, "removed": 1}
    assert FCM + "u1" not in subs_of(bob)


def notify():
    def note(priv, pk, to, hint):
        f = {"action": "push_notify", "pubkey": pk, "recipient_pubkey": to, "notificationHint": hint, "timestamp": int(time.time()),
             "request_id": secrets.token_hex(12)}
        return client.post("/api/push/notify", json={**{k: v for k, v in f.items() if k != "action"}, "signature": sign(priv, f)})
    bob_subs = subs_of(bob)
    results.update({bob_subs[0]: "gone", bob_subs[1]: "failed"})
    sends.clear()
    r = note(alice_priv, alice, bob, {"type": "message"})
    assert r.json() == {"success": True, "sent": len(bob_subs) - 2}, r.text
    assert sorted(e for e, _ in sends) == sorted(bob_subs) and all(d == {"type": "message", "action": "wake_and_sync"} for _, d in sends)
    assert bob_subs[0] not in subs_of(bob) and bob_subs[1] in subs_of(bob), "gone deleted, failed kept"
    assert client.post("/api/push/register-token", json={}).status_code == 404, "FCM off → no FCM registration route"


# ───────────── 真的 pywebpush，本機假的推播服務 ─────────────
received = []


class FakePushService(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        received.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if self.path.startswith("/redirect"):
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/internal-target")
            self.end_headers()
            return
        code = (410 if self.path.startswith("/gone") else 500 if self.path.startswith("/broken")
                else 401 if self.path.startswith("/unauth") else 403 if self.path.startswith("/forbidden") else 201)
        self.send_response(code)
        self.end_headers()

    def log_message(self, *a):
        pass


def real_pywebpush():
    server = HTTPServer(("127.0.0.1", 0), FakePushService)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    real = push.WebPushSender(VAPID_PRIV, SUBJECT, allowed_hosts=None)   # 本機的假推播服務不在名單上：這裡只測送出去的內容
    sub_key, p256dh, auth = subscription_keys()
    # 預設的 sender 送出前再檢查一次網址（資料庫裡就算有不合格的舊資料也不送）：不在名單 → failed，一個請求都沒發
    guarded = push.WebPushSender(VAPID_PRIV, SUBJECT)
    before = len(received)
    assert guarded.send(base + "/push/abc", p256dh, auth, {"type": "message"}) == "failed"
    assert guarded.send("https://169.254.169.254\\.fcm.googleapis.com/x", p256dh, auth, {"type": "message"}) == "failed"
    assert len(received) == before, "nothing was sent to a host that is not a push service"
    data = {"type": "incoming_call", "action": "wake_and_sync", "senderPubkey": alice, "isVideoCall": "false"}
    try:
        assert real.send(base + "/push/abc", p256dh, auth, data) == "sent"
        got = received[-1]
        h = {k.lower(): v for k, v in got["headers"].items()}
        assert h["content-encoding"] == "aes128gcm" and h["ttl"] == str(push.PUSH_TTL) and h["urgency"] == "high", h
        scheme, _, rest = h["authorization"].partition(" ")
        parts = dict(p.split("=", 1) for p in rest.split(","))
        assert scheme == "vapid" and parts["k"].rstrip("=") == VAPID_PUB, h["authorization"][:80]
        claims = jwt.decode(parts["t"], vapid_key.public_key(), algorithms=["ES256"], audience=base)
        assert claims["sub"] == SUBJECT and 0 < claims["exp"] - time.time() <= 24 * 3600, claims
        plain = http_ece.decrypt(got["body"], private_key=sub_key, auth_secret=unb64url(auth), version="aes128gcm")
        assert json.loads(plain) == data, plain
        assert real.send(base + "/gone/abc", p256dh, auth, data) == "gone"
        assert real.send(base + "/unauth/abc", p256dh, auth, data) == "gone", "401: subscribed with another VAPID key"
        assert real.send(base + "/forbidden/abc", p256dh, auth, data) == "gone", "403: subscribed with another VAPID key"
        assert real.send(base + "/broken/abc", p256dh, auth, data) == "failed"
        before = len(received)
        assert real.send(base + "/redirect/abc", p256dh, auth, data) == "failed"
        assert [r["path"] for r in received[before:]] == ["/redirect/abc"], "the redirect target must never be requested"
        auth_again = {k.lower(): v for k, v in received[-1]["headers"].items()}["authorization"]
        claims_again = jwt.decode(dict(p.split("=", 1) for p in auth_again.partition(" ")[2].split(","))["t"],
                                  vapid_key.public_key(), algorithms=["ES256"], audience=base)
        assert claims_again["aud"] == base, "every send gets its own claims (pywebpush mutates the dict it is given)"
    finally:
        server.shutdown()


check("registration: signed by the account key, replay 409, tampered/foreign/stale 401, unknown account 403, extra field 422, "
      "one key per endpoint, at most 5 per key", registration)
check("endpoint allow-list (SSRF): http, IPs, localhost, credentials, other ports, look-alike hosts, backslash/percent/@ tricks, "
      "control characters refused; keys must be a P-256 point and 16 bytes", endpoint_rules)
check("unregister removes only the signer's own subscription", unregister)
check("notify delivers to every subscription, deletes gone ones (404/410), does not count failures", notify)
check("real pywebpush to a local push service: VAPID ES256 JWT (aud/sub/exp) verifies, payload decrypts to the server-built data, "
      "TTL/Urgency, 410/401/403 gone, 500 failed, redirects not followed; the default sender re-checks the endpoint before sending", real_pywebpush)

if failed:
    print(f"\n{failed} check(s) FAILED")
    sys.exit(1)
print("\nALL PASS")

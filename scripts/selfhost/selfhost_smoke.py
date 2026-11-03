#!/usr/bin/env python3
"""
Smoke test for a running self-hosted chat server (api/chat_app.py + EMQX), from the outside — the way an app talks to it.

    python3 scripts/selfhost/selfhost_smoke.py --api https://chat-api.example.com --invite <code> --invite <code>

It reads GET /api/chat/server-config, connects to the broker URL found there, and checks:
  1. /health, server-config (no secrets in it)
  2. keys-only registration: no invite → 403; with an invite → 200; an unregistered key gets no MQTT token (403)
  3. MQTT (EMQX with emqx/base.hocon.example): connect with a token from the API; refused without a password, with a
     token bound to another client id; inbox delivery; retained publish refused on an inbox, accepted on the owner's
     presence topic and delivered to a later subscriber; foreign subscriptions refused; the connection survives refusals
  4. device claim, then a second device claims → the API's own "device replaced" notice reaches the first device
     through the broker (the API's tcp connection to EMQX and its token work)
  5. group log append and fetch; signed short code register + lookup; device-transfer token (receive-only)
Needs: Python 3.8+, cryptography, paho-mqtt >= 2 (pip install cryptography paho-mqtt). Uses two invite codes when the
server's registration policy is "invite" (python -m chat.invites create --uses 2 gives one code good for both).
Pass --proxy-token only when you call the API directly on the address your reverse proxy uses (simulating the proxy).
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import paho.mqtt.client as mqtt

parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument("--api", required=True, help="API base URL, e.g. https://chat-api.example.com")
parser.add_argument("--invite", action="append", default=[], help="invite code (repeat; one code with --uses 2 may be given twice)")
parser.add_argument("--proxy-token", default="", help="send X-Aegis-Internal yourself (only when calling the API behind the proxy's back)")
parser.add_argument("--insecure", action="store_true", help="do not verify TLS certificates (test setups with a private CA)")
args = parser.parse_args()
API = args.api.rstrip("/")
CTX = ssl._create_unverified_context() if args.insecure else None
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else f"  [{str(detail)[:300]}]"))
    return ok


def http(method, path, body=None):
    headers = {"Content-Type": "application/json"}
    if args.proxy_token:
        headers["X-Aegis-Internal"] = args.proxy_token
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
            return r.status, json.loads(r.read() or b"null"), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null"), dict(e.headers)
        except ValueError:
            return e.code, raw.decode(errors="replace"), dict(e.headers)


class Key:
    def __init__(self):
        self.priv = Ed25519PrivateKey.generate()
        self.pk = base64.b64encode(self.priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
        self.user = base64.urlsafe_b64encode(base64.b64decode(self.pk)).decode().rstrip("=")

    def sign(self, payload: dict) -> str:
        return base64.b64encode(self.priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())).decode()

    def signed(self, **fields) -> dict:
        body = {**fields, "timestamp": int(time.time()), "request_id": secrets.token_hex(16)}
        return {**body, "signature": self.sign(body)}


def rand22() -> str:
    return base64.urlsafe_b64encode(os.urandom(17)).decode()[:22]


# ── 1. health, server-config ──
status, body, _ = http("GET", "/health")
check("GET /health", status == 200 and body.get("ok") is True, body)
status, cfg, headers = http("GET", "/api/chat/server-config")
check("GET /api/chat/server-config", status == 200 and cfg.get("service") == "aegistalk-chat" and cfg.get("api_version") == 1, cfg)
print(f"     registration={cfg.get('registration')} mqtt_url={cfg.get('mqtt_url')} push={cfg.get('push')}")
check("server-config has no secret-looking field", not any(k in json.dumps(cfg).lower() for k in ("secret", "private", "token\":")), cfg)
broker = urlsplit(cfg["mqtt_url"])

# ── 2. registration ──
alice, bob, stranger = Key(), Key(), Key()
invites = list(args.invite)


def register(key: Key, use_invite=True):
    fields = {"action": "account_register", "pubkey": key.pk}
    if use_invite and cfg["registration"] == "invite":
        if not invites:
            sys.exit("the server wants invite codes: pass --invite (python -m chat.invites create --uses 2)")
        fields["invite_code"] = invites.pop(0) if len(invites) > 1 else invites[0]
    return http("POST", "/api/account/register", key.signed(**fields))


if cfg["registration"] == "invite":
    s, b, _ = register(stranger, use_invite=False)
    check("registration without an invite → 403 invite_required", s == 403 and b.get("detail") == "invite_required", b)
for who, key in (("alice", alice), ("bob", bob)):
    s, b, _ = register(key)
    if not check(f"keys-only registration ({who}) → 200 created", s == 200 and b.get("created") is True, b):
        sys.exit("cannot continue without two accounts (new-account limits: CHAT_REGISTER_PER_IP_HOUR, default 3 per hour)")
DEVICE1, DEVICE2 = "0b6f4c1e-8a2d-4c3b-9e7f-" + secrets.token_hex(6), "ffffffff-8a2d-4c3b-9e7f-" + secrets.token_hex(6)
TAG = rand22()


def token(key: Key, device=DEVICE1, presence=(), tag=None, groups=()):
    fields = {"action": "mqtt_token", "pubkey": key.pk, "client_id": f"mist_{key.user[:16]}_{(device or DEVICE1)[:8]}", "groups": list(groups),
              "presence": list(presence)}
    if tag:
        fields["presence_tag"] = tag
    if device:
        fields["device_id"] = device
    return http("POST", "/api/mqtt/token", key.signed(**fields))


s, b, _ = token(stranger)
check("MQTT token for a key without an account → 403 account_not_registered", s == 403 and b.get("detail") == "account_not_registered", b)


# ── 3. MQTT ──
class Conn:
    def __init__(self, username, client_id, password):
        transport = "websockets" if broker.scheme in ("ws", "wss") else "tcp"
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, protocol=mqtt.MQTTv5, transport=transport)
        if transport == "websockets":
            self.c.ws_set_options(path=broker.path or "/mqtt")
        if broker.scheme == "wss":
            self.c.tls_set_context(CTX or ssl.create_default_context())
        if username is not None:
            self.c.username_pw_set(username, password)
        self.rc = None
        self.acks, self.subacks, self.msgs = {}, {}, []
        self.up, self.down = threading.Event(), threading.Event()
        self.c.on_connect = lambda c, u, f, rc, p: (setattr(self, "rc", rc), self.up.set())
        self.c.on_publish = lambda c, u, mid, rc, p: self.acks.__setitem__(mid, rc.value)
        self.c.on_subscribe = lambda c, u, mid, rcs, p: self.subacks.__setitem__(mid, rcs[0].value)
        self.c.on_message = lambda c, u, m: self.msgs.append((m.topic, m.payload, m.retain))
        self.c.on_disconnect = lambda c, u, f, rc, p: self.down.set()

    def open(self):
        port = broker.port or (443 if broker.scheme == "wss" else 80 if broker.scheme == "ws" else 1883)
        try:
            self.c.connect(broker.hostname, port, keepalive=30)
        except Exception as e:  # noqa: BLE001
            self.rc = f"connect failed: {e}"
            return self
        self.c.loop_start()
        self.up.wait(10)
        time.sleep(0.3)
        return self

    @property
    def ok(self):
        return self.rc is not None and not isinstance(self.rc, str) and not self.rc.is_failure and not self.down.is_set()

    def _wait(self, table, mid):
        end = time.time() + 8
        while mid not in table and time.time() < end:
            time.sleep(0.02)
        return table.get(mid)

    def pub(self, topic, payload=b"{}", retain=False):
        return self._wait(self.acks, self.c.publish(topic, payload, qos=1, retain=retain).mid)

    def sub(self, topic):
        return self._wait(self.subacks, self.c.subscribe(topic, qos=1)[1])

    def close(self):
        try:
            self.c.disconnect()
            self.c.loop_stop()
        except Exception:  # noqa: BLE001
            pass


accepted = lambda rc: rc is not None and rc < 0x80  # noqa: E731  (0 accepted, 0x10 no subscribers)
s, ta, _ = token(alice, tag=TAG, device=None)
check("MQTT token for alice (keys-only account)", s == 200 and ta.get("username") == alice.user, ta)
my_presence = f"mist/user/{alice.user}/presence/{TAG}"
s, tb, _ = token(bob, presence=[my_presence], device=None)
check("MQTT token for bob with alice's presence topic in scope", s == 200 and my_presence in tb.get("subscribe", []), tb)
check("no password → refused", not Conn(None, f"mist_{alice.user[:16]}_nopass00", None).open().ok)
check("alice's token used with another client id → refused", not Conn(alice.user, f"mist_{alice.user[:16]}_other000", ta["token"]).open().ok)
a = Conn(alice.user, f"mist_{alice.user[:16]}_{DEVICE1[:8]}", ta["token"]).open()
bconn = Conn(bob.user, f"mist_{bob.user[:16]}_{DEVICE1[:8]}", tb["token"]).open()
check("alice and bob connect with their tokens", a.ok and bconn.ok, (a.rc, bconn.rc))
check("bob subscribes to his inbox", accepted(bconn.sub(f"mist/user/{bob.user}/inbox/+")))
check("alice → bob inbox (her slot) delivered", accepted(a.pub(f"mist/user/{bob.user}/inbox/{alice.user}", b'{"t":1}')))
check("retained on bob's inbox → 0x87", a.pub(f"mist/user/{bob.user}/inbox/{alice.user}", b'{"t":2}', retain=True) == 0x87)
check("publishing in bob's slot → 0x87", a.pub(f"mist/user/{bob.user}/inbox/{bob.user}") == 0x87)
check("subscribing to bob's inbox → 0x87", a.sub(f"mist/user/{bob.user}/inbox/+") == 0x87)
check("subscribing to # → 0x87", a.sub("#") == 0x87)
check("retained on her own presence topic → accepted", accepted(a.pub(my_presence, b'{"n":"AA","c":"BB"}', retain=True)))
time.sleep(0.8)
check("bob got exactly the one non-retained inbox message", [m[1] for m in bconn.msgs if "/inbox/" in m[0]] == [b'{"t":1}'], bconn.msgs)
check("bob subscribes to alice's presence and gets the retained state", accepted(bconn.sub(my_presence)) and
      (time.sleep(0.8) or any(t == my_presence and r for t, _, r in bconn.msgs)), bconn.msgs)
check("connections survive the refusals (deny_action = ignore)", a.ok and bconn.ok)
a.pub(my_presence, b"", retain=True)
a.close()
bconn.close()

# ── 4. device claim, kick through the broker ──


def claim(key, device):
    ts = int(time.time())
    payload = {"device_id": device, "platform": "pwa", "display_label": "", "timestamp": ts, "action": "claim"}
    return http("POST", "/api/devices/claim", {"device_id": device, "platform": "pwa", "timestamp": ts, "pubkey": key.pk, "signature": key.sign(payload)})


s, b, _ = claim(alice, DEVICE1)
check("device claim with a keys-only account", s == 200 and b.get("success") is True, b)
s, t1, _ = token(alice, device=DEVICE1)
kick_topic = f"aegis/device/{DEVICE1}/kicked"
check("token for the claimed device includes its kick topic", s == 200 and kick_topic in t1.get("subscribe", []), t1)
d1 = Conn(alice.user, f"mist_{alice.user[:16]}_{DEVICE1[:8]}", t1["token"]).open()
check("first device subscribes to its kick topic", d1.ok and accepted(d1.sub(kick_topic)))
s, b, _ = claim(alice, DEVICE2)
check("second device claims → kicked_previous", s == 200 and b.get("kicked_previous") is True, b)
end = time.time() + 10
while time.time() < end and not any(t == kick_topic for t, _, _ in d1.msgs):
    time.sleep(0.2)
check("the API's 'device replaced' notice arrives through the broker", any(t == kick_topic for t, _, _ in d1.msgs), d1.msgs)
d1.close()
s, b, _ = token(alice, device=DEVICE1)
check("the replaced device gets no new token (403 device_replaced)", s == 403 and b.get("detail") == "device_replaced", b)

# ── 5. group log, short code, transfer token ──
gid = rand22()
blob = "opaque-commit-" + secrets.token_hex(8)
payload = {"action": "group_log_append", "pubkey": alice.pk, "gid": gid, "blob_sha256": hashlib.sha256(blob.encode()).hexdigest(),
           "timestamp": int(time.time()), "request_id": secrets.token_hex(16)}
s, b, _ = http("POST", f"/api/group-log/{gid}", {"blob": blob, "pubkey": alice.pk, "timestamp": payload["timestamp"],
                                                  "request_id": payload["request_id"], "signature": alice.sign(payload)})
check("group log append with a keys-only account → seq 1", s == 200 and b == {"seq": 1}, b)
s, b, _ = http("GET", f"/api/group-log/{gid}?after=0")
check("group log fetch", s == 200 and b.get("entries") == [{"seq": 1, "blob": blob}], b)
spk = os.urandom(32)
fields = {"action": "register_shortcode", "public_key": alice.pk, "signed_pre_key": base64.b64encode(spk).decode(),
          "signature": base64.b64encode(alice.priv.sign(spk)).decode(), "display_name": "Alice", "timestamp": int(time.time()),
          "request_id": secrets.token_hex(16)}
s, b, _ = http("POST", "/api/shortcode/register", {**fields, "request_signature": alice.sign(fields)})
check("signed short code register", s == 200 and len(b.get("short_code", "")) == 6, b)
if s == 200:
    s2, look, _ = http("GET", f"/api/shortcode/lookup/{b['short_code']}")
    check("short code lookup returns alice's bundle", s2 == 200 and look.get("pk") == alice.pk, look)
s, tt, _ = http("POST", "/api/mqtt/transfer-token", {})
check("device-transfer token", s == 200 and tt["username"].startswith("transfer_"), tt)
if s == 200:
    t = Conn(tt["username"], tt["username"], tt["token"]).open()
    check("transfer token: own inbox only, nothing to publish",
          t.ok and accepted(t.sub(f"mist/user/{tt['username']}/inbox/+")) and t.pub(f"mist/user/{bob.user}/inbox/{tt['username']}") == 0x87)
    t.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
sys.exit(1 if failed else 0)

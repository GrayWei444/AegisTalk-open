#!/usr/bin/env python3
"""
來電者簽章的響鈴 token 經過推播伺服器（開源第 5d 步，api/chat/push.py ring_token_ok／push_notify；docs/DIRECT_SEALED.md §4）：
真的 create_push_router（chat 伺服器的預設型別：message／incoming_call），暫存 SQLite、假的 firebase_admin、FastAPI TestClient。

  1. 寄件者自己簽、寄給這個收件人、±300 秒的 token → 原樣放進 FCM data 的 ringToken（伺服器不加任何名字）
  2. 不是來電帶 token → 422 ring_token_not_allowed
  3. 偽造的簽章、別人簽的 token 轉寄、寄給別人的、太舊／太新、別的寫法（多空白、多欄位、多餘的位元）→ 422 invalid_ring_token；
     被擋下的不佔冷卻、不用掉 request_id（同一位寄件者馬上再送一則好的照樣送得出去）
  4. 簽章涵蓋 token：中途把 token 換掉 → 401（請求簽章不對）
  5. 沒有 token 的來電照舊送（舊版 App）；收件端（原生、service worker）不會因此全螢幕響鈴（ring_token_self_test、RingTokenTest）
Run: python3 scripts/review/push_ring_token_self_test.py   （需要 fastapi、pydantic 2、cryptography、httpx）
"""
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import types
from contextlib import contextmanager
from pathlib import Path
from typing import List

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

API_DIR = Path(os.environ.get("AEGISTALK_API_DIR") or Path(__file__).resolve().parents[2] / "api")


class Clock:
    now = 1_900_000_000.0

    def time(self) -> float:
        return self.now


clock = Clock()
sent: List[dict] = []


class _Any:
    def __init__(self, *a, **k):
        self.__dict__.update(k)


fake_fb = types.ModuleType("firebase_admin")
fake_fb._apps = {}
fake_messaging = types.ModuleType("firebase_admin.messaging")
for _name in ("APNSConfig", "APNSPayload", "Aps", "ApsAlert", "AndroidConfig"):
    setattr(fake_messaging, _name, _Any)
fake_messaging.Message = lambda **k: k
fake_messaging.send = lambda m: sent.append(m["data"])
fake_credentials = types.ModuleType("firebase_admin.credentials")
fake_fb.messaging, fake_fb.credentials = fake_messaging, fake_credentials
sys.modules.update({"firebase_admin": fake_fb, "firebase_admin.messaging": fake_messaging,
                    "firebase_admin.credentials": fake_credentials})

sys.path.insert(0, str(API_DIR))
from chat import push, signing  # noqa: E402
from chat.config import ProxyGuard  # noqa: E402

for m in (push, signing):
    m.time = clock

PREFIX = "aegistalk-ring-v1"


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def keypair():
    priv = Ed25519PrivateKey.generate()
    return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def call_id() -> str:
    return b64u(secrets.token_bytes(16))


def claims_text(frm: str, to: str, iat_ms: int, cid: str = None, prefix: str = PREFIX, video: bool = False) -> str:
    return (f'{{"v":1,"d":"{prefix}","callId":"{cid or call_id()}","from":"{frm}","to":"{to}",'
            f'"iat":{iat_ms},"nonce":"{b64u(secrets.token_bytes(16))}","video":{"true" if video else "false"}}}')


def ring_token(signer, text: str, prefix: str = PREFIX) -> str:
    raw = text.encode()
    return f"r1.{b64u(raw)}.{b64u(signer.sign((prefix + ':').encode() + raw))}"


with tempfile.TemporaryDirectory() as tmp:
    @contextmanager
    def get_db():
        c = sqlite3.connect(str(Path(tmp) / "db"))
        c.row_factory = sqlite3.Row
        try:
            yield c
        finally:
            c.close()

    with get_db() as c:
        signing.create_tables(c.cursor())
        push.create_tables(c.cursor())
        c.commit()

    guard = ProxyGuard(client_ip=lambda req: "203.0.113.9", internal_ok=lambda req: True)
    app = FastAPI()
    app.include_router(push.create_push_router(get_db, signing.resolve_account_key, guard))   # chat 伺服器的預設型別
    client = TestClient(app)

    def phash(pk: str) -> str:
        return hashlib.sha256(pk.encode()).hexdigest()

    def register_account(pk: str) -> None:
        with get_db() as conn:
            conn.execute("INSERT INTO pubkey_account_map (pubkey_hash, account_key, created_at) VALUES (?,?,0)",
                         (phash(pk), "acct-" + phash(pk)[:16]))
            conn.commit()

    def sign(priv, payload: dict) -> str:
        msg = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        return base64.b64encode(priv.sign(msg)).decode()

    def notify_req(priv, pk, recipient, hint, **over):
        fields = dict(action="push_notify", pubkey=pk, recipient_pubkey=recipient, notificationHint=hint,
                      timestamp=int(clock.now), request_id=secrets.token_hex(16))
        fields.update(over)
        signed = {k: v for k, v in fields.items() if k != "signature"}
        out = {k: v for k, v in fields.items() if k != "action"}
        return {**out, "signature": fields.get("signature") or sign(priv, signed)}

    def post(data, status=200):
        r = client.post("/api/push/notify", json=data)
        assert r.status_code == status, (status, r.status_code, r.text)
        return r.json()

    alice_priv, alice = keypair()     # 來電者
    bob_priv, bob = keypair()         # 收件人
    carol_priv, carol = keypair()     # 另一個有帳號的人
    mallory_priv, mallory = keypair()
    for pk in (alice, bob, carol, mallory):
        register_account(pk)
    with get_db() as conn:
        conn.execute("INSERT INTO fcm_tokens (pubkey_hash, fcm_token, platform, updated_at) VALUES (?,?,?,0)",
                     (phash(bob), "fcm-bob", "android"))
        conn.commit()
    now_ms = lambda: int(clock.now * 1000)  # noqa: E731

    # ── 1 ──
    tok = ring_token(alice_priv, claims_text(alice, bob, now_ms(), video=True))
    res = post(notify_req(alice_priv, alice, bob, {"type": "incoming_call", "isVideoCall": True, "ringToken": tok}))
    assert res == {"success": True, "sent": 1}, res
    assert sent[-1] == {"type": "incoming_call", "action": "wake_and_sync", "senderPubkey": alice, "isVideoCall": "true",
                        "ringToken": tok}, sent[-1]
    assert not any(k in json.dumps(sent[-1]) for k in ("senderName", "displayName", "callerName")), sent[-1]
    assert push.ring_token_ok(tok, alice, bob, clock.now)
    print("PASS a ring token signed by the sender for this recipient goes into the push unchanged (no names added)")

    # ── 2 ──
    clock.now += 31
    r = post(notify_req(alice_priv, alice, bob, {"type": "message", "ringToken": tok}), 422)
    assert r["detail"] == "ring_token_not_allowed", r
    print("PASS only incoming_call may carry a ring token (422 ring_token_not_allowed)")

    # ── 3 ──
    bad = {
        "forged signature (Mallory signs as Alice)": ring_token(mallory_priv, claims_text(alice, bob, now_ms())),
        "Carol's genuine token forwarded by Alice": ring_token(carol_priv, claims_text(carol, bob, now_ms())),
        "token for another recipient": ring_token(alice_priv, claims_text(alice, carol, now_ms())),
        "stale (301 s)": ring_token(alice_priv, claims_text(alice, bob, now_ms() - 301_000)),
        "future (301 s)": ring_token(alice_priv, claims_text(alice, bob, now_ms() + 301_000)),
        "extra space": ring_token(alice_priv, claims_text(alice, bob, now_ms()).replace('{"v":1,', '{"v":1, ')),
        "extra field": ring_token(alice_priv, claims_text(alice, bob, now_ms()).replace("}", ',"name":"Mom"}')),
        "signed for another domain": ring_token(alice_priv, claims_text(alice, bob, now_ms()), prefix="other-ring-v1"),
        "other tag": "r2." + ring_token(alice_priv, claims_text(alice, bob, now_ms()))[3:],
        "free text": "Mom is calling you, please answer " * 5,
    }
    good = ring_token(alice_priv, claims_text(alice, bob, now_ms()))
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    bad["spare bits in the signature"] = good[:-1] + alphabet[alphabet.index(good[-1]) + 1]
    for name, token in bad.items():
        before = len(sent)
        r = client.post("/api/push/notify", json=notify_req(alice_priv, alice, bob, {"type": "incoming_call", "ringToken": token}))
        assert r.status_code == 422, (name, r.status_code, r.text)
        assert len(sent) == before, name
        assert not push.ring_token_ok(token, alice, bob, clock.now), name
    # 被擋下的不佔冷卻：同一位寄件者馬上送一則好的
    res = post(notify_req(alice_priv, alice, bob, {"type": "incoming_call", "ringToken": good}))
    assert res == {"success": True, "sent": 1} and sent[-1]["ringToken"] == good, res
    # 被擋下的不用掉 request_id
    rid = secrets.token_hex(16)
    clock.now += 11
    post(notify_req(alice_priv, alice, bob, {"type": "incoming_call", "ringToken": bad["stale (301 s)"]}, request_id=rid), 422)
    fresh = ring_token(alice_priv, claims_text(alice, bob, now_ms()))
    assert post(notify_req(alice_priv, alice, bob, {"type": "incoming_call", "ringToken": fresh}, request_id=rid))["success"] is True
    print(f"PASS {len(bad)} bad tokens (forged, forwarded, misaddressed, stale/future, other encodings/domain) → 422; "
          "they take no cooldown and no request_id")

    # ── 4 ──
    clock.now += 11
    req = notify_req(alice_priv, alice, bob, {"type": "incoming_call", "ringToken": ring_token(alice_priv, claims_text(alice, bob, now_ms()))})
    req["notificationHint"]["ringToken"] = ring_token(alice_priv, claims_text(alice, bob, now_ms()))
    post(req, 401)
    print("PASS the account signature covers the token (swapping it on the way → 401)")

    # ── 5 ──
    clock.now += 11
    res = post(notify_req(alice_priv, alice, bob, {"type": "incoming_call", "isVideoCall": False}))
    assert res["success"] is True and "ringToken" not in sent[-1], sent[-1]
    print("PASS a call push without a token is still delivered (the phones do not ring full-screen for it)")

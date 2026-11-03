#!/usr/bin/env python3
"""
推播 API（移植群星 A5，稽核 H15）：真的 chat 伺服器 api/chat/push.py（create_push_router 的 register-token／notify，
簽章用 chat/signing.py），配暫存 SQLite、假的 firebase_admin、FastAPI TestClient 執行。不連任何正式服務。

以前：register／notify 都不驗身分 —— 任何人都能把自己的手機掛到別人名下（收別人的推播），也能對任何人送
「〈媽媽〉來電」「〈媽媽〉偵測到詐騙」：senderName／protectedName／alertType 原樣進 FCM；限速按 IP 與收件人算。
現在：
  - 兩支都要帳戶 Ed25519 簽章（±300 秒、request_id 只能用一次），寄件者要有 AegisID 帳號，收件人也要
  - notificationHint 只收 type（message／incoming_call／guardian_alert／check_in）與 isVideoCall，多送任何欄位 → 422
  - FCM data 只由伺服器組：沒有任何名字；來電／守護／報平安帶的是**已驗簽的**寄件者公鑰（收件端查本機聯絡人）
  - 限速：同一寄件帳戶 → 同一收件人 → 同一型別，來電 10 秒、其他 30 秒；同一寄件帳戶每分鐘 60 則來電／守護、
    300 則報平安（先看額度才佔那一格）；register 每 IP 每分鐘 30 次；一個 token 只屬於一個帳號
  - （開源第 3 步）時鐘差 → 401 {code: clock_skew, server_time}（跟 MQTT token 同一個形狀，client 校正後重簽）；
    chat 伺服器只收 message／incoming_call（守護／報平安 422 unsupported_push_type），官方站四種都收（hint_types）
  （Web Push 的登記與送出：webpush_self_test.py）
Run: python3 scripts/review/push_endpoints_self_test.py   （需要 fastapi、pydantic 2、cryptography、httpx）
"""
import ast
import base64
import hashlib
import json
import re
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

API_DIR = Path(__file__).resolve().parents[2] / "api"
PUSH_PY = API_DIR / "chat" / "push.py"
SRC = PUSH_PY.read_text(encoding="utf-8")
TREE = ast.parse(SRC)
TABLES = ("fcm_tokens", "push_rate_limit", "request_nonces", "pubkey_account_map")


class Clock:
    now = 1_800_000_000.0

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
from chat.config import ALL_PUSH_TYPES, ProxyGuard  # noqa: E402

for m in (push, signing):
    m.time = clock      # 伺服器的時鐘（簽章時間窗、冷卻、每分鐘額度）

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
        assert {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= set(TABLES)

    test_guard = ProxyGuard(client_ip=lambda req: req.headers.get("X-Test-IP", "203.0.113.9"), internal_ok=lambda req: True)
    app = FastAPI()
    # 官方站的設定：四種推播型別都收（chat 伺服器的預設只收兩種，見檔尾）
    app.include_router(push.create_push_router(get_db, signing.resolve_account_key, test_guard, hint_types=ALL_PUSH_TYPES))
    client = TestClient(app)

    def keypair():
        priv = Ed25519PrivateKey.generate()
        return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()

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

    def reg_req(priv, pk, token, **over):
        fields = dict(action="push_register", pubkey=pk, token=token, platform="android",
                      timestamp=int(clock.now), request_id=secrets.token_hex(16))
        fields.update(over)
        signed = {k: v for k, v in fields.items() if k != "signature"}
        out = {k: v for k, v in fields.items() if k != "action"}
        return {**out, "signature": fields.get("signature") or sign(priv, signed)}

    def notify_req(priv, pk, recipient, hint, **over):
        fields = dict(action="push_notify", pubkey=pk, recipient_pubkey=recipient, notificationHint=hint,
                      timestamp=int(clock.now), request_id=secrets.token_hex(16))
        fields.update(over)
        signed = {k: v for k, v in fields.items() if k != "signature"}
        out = {k: v for k, v in fields.items() if k != "action"}
        return {**out, "signature": fields.get("signature") or sign(priv, signed)}

    def post(path, data, status=200, ip="198.51.100.7"):
        r = client.post(path, json=data, headers={"X-Test-IP": ip})
        assert r.status_code == status, (path, status, r.status_code, r.text)
        return r.json()

    def notify(priv, pk, recipient, hint, status=200, **over):
        before = len(sent)
        res = post("/api/push/notify", notify_req(priv, pk, recipient, hint, **over), status)
        return res, sent[before:]

    alice_priv, alice = keypair()          # 寄件者（有帳號）
    bob_priv, bob = keypair()              # 收件人（有帳號、有手機）
    mallory_priv, mallory = keypair()      # 有帳號的攻擊者
    ghost_priv, ghost = keypair()          # 沒有 AegisID 帳號
    for pk in (alice, bob, mallory):
        register_account(pk)

    # ── register-token ──
    post("/api/push/register-token", {"pubkeyHash": phash(bob), "token": "fcm-token-x", "platform": "android"}, 422)
    post("/api/push/register-token", reg_req(mallory_priv, bob, "fcm-token-mallory"), 401)    # 拿自己的金鑰替 bob 註冊
    post("/api/push/register-token", reg_req(ghost_priv, ghost, "fcm-token-ghost"), 403)       # 沒有帳號
    stale = reg_req(bob_priv, bob, "fcm-token-bob", timestamp=int(clock.now) - 301)
    assert post("/api/push/register-token", stale, 401)["detail"] == {"code": "clock_skew", "server_time": int(clock.now)}
    ok = reg_req(bob_priv, bob, "fcm-token-bob")
    assert post("/api/push/register-token", ok) == {"success": True}
    post("/api/push/register-token", ok, 409)                                             # 重放
    with get_db() as conn:
        rows = [tuple(r) for r in conn.execute("SELECT pubkey_hash, fcm_token FROM fcm_tokens")]
    assert rows == [(phash(bob), "fcm-token-bob")], f"token stored under the server-computed hash of the signer only ({rows})"
    # 同一支手機換帳號：token 只屬於最後簽章的那個帳號
    post("/api/push/register-token", reg_req(mallory_priv, mallory, "fcm-token-shared"))
    post("/api/push/register-token", reg_req(alice_priv, alice, "fcm-token-shared"))
    with get_db() as conn:
        owners = [r[0] for r in conn.execute("SELECT pubkey_hash FROM fcm_tokens WHERE fcm_token='fcm-token-shared'")]
    assert owners == [phash(alice)], owners
    accepted = sum(1 for i in range(40) if client.post(
        "/api/push/register-token", json=reg_req(alice_priv, alice, f"fcm-token-spam-{i}"),
        headers={"X-Test-IP": "192.0.2.77"}).status_code == 200)
    assert accepted == 30, f"30 registrations per IP per minute (got {accepted})"
    print("PASS register-token: signed by the account key, stored under the server-computed hash, replay 409, "
          "one account per device token, 30/min per IP")

    # ── notify：簽章 ──
    call = {"type": "incoming_call", "isVideoCall": True}
    unsigned = {k: v for k, v in notify_req(alice_priv, alice, bob, call).items() if k != "signature"}
    post("/api/push/notify", unsigned, 422)
    post("/api/push/notify", {"recipientPubkeyHash": phash(bob), "notificationHint": {"type": "incoming_call",
                                                                                      "senderName": "媽媽"}}, 422)
    forged, out = notify(mallory_priv, alice, bob, call, status=401)                      # 冒用 alice 的公鑰
    assert out == [], out
    tampered = notify_req(alice_priv, alice, bob, call)
    _, mallory_device = keypair()
    post("/api/push/notify", {**tampered, "recipient_pubkey": mallory_device}, 401)       # 簽完改收件人
    post("/api/push/notify", {**tampered, "notificationHint": {"type": "incoming_call", "isVideoCall": False}}, 401)
    res, out = notify(alice_priv, alice, bob, call, status=401, timestamp=int(clock.now) + 301)
    assert res["detail"] == {"code": "clock_skew", "server_time": int(clock.now)} and out == [], res
    notify(ghost_priv, ghost, bob, call, status=403)                                      # 寄件者沒有帳號
    print("PASS notify: unsigned/legacy 422, forged/tampered/stale 401, sender without an AegisID account 403")

    # ── notify：不帶任何名字 ──
    for field, value in (("senderName", "媽媽"), ("protectedName", "媽媽"), ("alertType", "high_risk_conversation"),
                         ("checkInType", "request"), ("evil", "x")):
        notify(alice_priv, alice, bob, {"type": "incoming_call", field: value}, status=422)
    notify(alice_priv, alice, bob, {"type": "fake_bank_alert"}, status=422)
    res, out = notify(alice_priv, alice, bob, call)
    assert res == {"success": True, "sent": 1}, res
    assert out == [{"type": "incoming_call", "action": "wake_and_sync", "isVideoCall": "true", "senderPubkey": alice}], out
    names = re.compile(r"senderName|protectedName|alertType|checkInType|displayName")
    assert not names.search(json.dumps(out)), out
    clock.now += 1
    res, out = notify(alice_priv, alice, bob, {"type": "message"})
    assert out == [{"type": "message", "action": "wake_and_sync"}], f"message stays zero-content ({out})"
    for kind in ("guardian_alert", "check_in"):
        _, out = notify(alice_priv, alice, bob, {"type": kind})
        assert out == [{"type": kind, "action": "wake_and_sync", "senderPubkey": alice}], out
    replay = notify_req(alice_priv, alice, bob, {"type": "incoming_call"})
    clock.now += 11
    post("/api/push/notify", replay)
    post("/api/push/notify", replay, 409)                                                  # 同一個 request_id
    print("PASS notify: hint takes only type/isVideoCall (names → 422); FCM data built by the server, no names, "
          "verified senderPubkey for calls/guardian/check-in; request_id single-use")

    # ── notify：收件人 ──
    res, _ = notify(alice_priv, alice, ghost, {"type": "message"})
    assert res == {"success": False, "reason": "recipient_not_registered"}, res
    res, _ = notify(alice_priv, alice, mallory, {"type": "message"})
    assert res == {"success": False, "reason": "no_token"}, res
    notify(alice_priv, alice, "not-a-key" + "A" * 40, {"type": "message"}, status=400)

    # ── notify：限速 ──
    clock.now += 61
    res, out = notify(alice_priv, alice, bob, {"type": "incoming_call"})
    assert len(out) == 1, res
    res, out = notify(alice_priv, alice, bob, {"type": "incoming_call"})
    assert res == {"success": False, "reason": "rate_limited"} and out == [], "same caller → same callee within 10 s"
    res, out = notify(mallory_priv, mallory, bob, {"type": "incoming_call"})
    assert len(out) == 1, "another sender is not blocked by the first sender's cooldown (per sender→recipient)"
    clock.now += 11
    assert len(notify(alice_priv, alice, bob, {"type": "incoming_call"})[1]) == 1, "a new call after 10 s rings again"
    clock.now += 31
    assert len(notify(alice_priv, alice, bob, {"type": "message"})[1]) == 1
    clock.now += 5
    assert notify(alice_priv, alice, bob, {"type": "message"})[1] == [], "message wake-ups: 30 s per sender→recipient"
    assert len(notify(mallory_priv, mallory, bob, {"type": "message"})[1]) == 1, \
        "one sender cannot use up a recipient's message pushes for everyone (old per-recipient 30 s cache)"

    # 每個寄件帳戶每分鐘的額度：來電／守護 60、報平安 300（各自一份）；先看額度才佔那一格
    members = []
    for i in range(130):
        priv, pk = keypair()
        register_account(pk)
        post("/api/push/register-token", reg_req(priv, pk, f"fcm-token-m{i}"), ip=f"10.9.{i}.1")
        members.append(pk)
    clock.now += 61
    alerts = sum(len(notify(mallory_priv, mallory, m, {"type": "guardian_alert"})[1]) for m in members[:70])
    assert alerts == 60, f"one account: at most 60 calls/guardian alerts per minute (got {alerts})"
    callee = members[100]
    assert notify(mallory_priv, mallory, callee, {"type": "incoming_call"})[1] == [], "budget used up → refused"
    checkins = sum(len(notify(mallory_priv, mallory, m, {"type": "check_in"})[1]) for m in members[:98])
    assert checkins == 98, f"check-ins have their own allowance (two full groups) (got {checkins})"
    clock.now += 61
    assert len(notify(mallory_priv, mallory, callee, {"type": "incoming_call"})[1]) == 1, \
        "a call refused by the per-minute budget did not take the 10-second caller/callee slot"
    print("PASS notify limits: per sender→recipient→type cooldown (call 10 s, other 30 s), per-sender 60/min alerts "
          "and 300/min check-ins, budget checked before the slot is taken")

    model = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == "PushRegisterRequest")
    assert "android|ios" in (ast.get_source_segment(SRC, model) or ""), "platform limited to android/ios"
    every_api_source = "".join(f.read_text(encoding="utf-8") for f in [*API_DIR.glob("*.py"), *API_DIR.glob("chat/*.py")])
    for gone in ("_push_hint_payload", "_PUSH_HINT_FIELDS", "_push_rate_cache", "recipientPubkeyHash", "pubkeyHash:"):
        assert gone not in every_api_source, f"{gone} should be gone from the API (api/*.py, api/chat/*.py)"
    print("PASS old unsigned push code paths removed from the API")

    # ── chat 伺服器的預設：只收 message／incoming_call（決定 2）；FCM 沒開就沒有 register-token ──
    chat_app_ = FastAPI()
    chat_app_.include_router(push.create_push_router(get_db, signing.resolve_account_key, test_guard))
    chat_client = TestClient(chat_app_)
    clock.now += 61
    for kind in ("guardian_alert", "check_in"):
        r = chat_client.post("/api/push/notify", json=notify_req(alice_priv, alice, bob, {"type": kind}))
        assert r.status_code == 422 and r.json()["detail"] == "unsupported_push_type", (kind, r.text)
    before = len(sent)
    r = chat_client.post("/api/push/notify", json=notify_req(alice_priv, alice, bob, {"type": "incoming_call", "isVideoCall": False}))
    assert r.status_code == 200 and r.json()["success"] and len(sent) == before + 1, r.text
    for bad in (dict(hint_types=("message", "sms")), dict(hint_types=())):
        try:
            push.create_push_router(get_db, signing.resolve_account_key, test_guard, **bad)
            raise AssertionError(f"{bad} must be refused")
        except ValueError:
            pass
    try:
        push.create_push_router(get_db, signing.resolve_account_key, test_guard, fcm=False, webpush=None)
        raise AssertionError("a push router with neither FCM nor Web Push must be refused")
    except ValueError:
        pass
    print("PASS chat-server default: message/incoming_call only (guardian/check-in 422 unsupported_push_type); unknown types and "
          "a router with no push backend refused at startup")

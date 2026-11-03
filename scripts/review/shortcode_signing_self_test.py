#!/usr/bin/env python3
"""
好友短碼的 register／refresh 要簽章（開源計畫第 3 步，移植群星 _authorize_shortcode）：api/chat/shortcode.py 的真 router。

以前 register／refresh 只看欄位長度：知道別人公鑰的人能把別人短碼背後的預備金鑰、名字換成自己的（加那個碼的人會跟攻擊者
做 X3DH），也能用 refresh 作廢別人的短碼。現在：
  - request_signature：身分金鑰簽 {action: register_shortcode|refresh_shortcode, public_key, signed_pre_key, signature,
    display_name, timestamp, request_id}；別人的金鑰、改過任何一個欄位、換 action（register 的簽章拿去 refresh）→ 401
  - signature：身分金鑰對 signed_pre_key 的 X3DH 簽章；不對 → 401 invalid_prekey_signature
  - 公鑰要有帳號（403）、時鐘差 → 401 clock_skew、request_id 只能用一次（409）、多送欄位 422、每 IP 每分鐘 30 次
  - register 已有碼 → 同一個碼、更新背後的預備金鑰；refresh → 舊碼立即失效；過期一天的碼被清掉
  - 查詢（lookup）照舊不用簽章、每 IP 每分鐘 30 次
Run: python3 scripts/review/shortcode_signing_self_test.py   （需要 fastapi、pydantic 2、cryptography、httpx）
"""
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

API_DIR = Path(os.environ.get("AEGISTALK_API_DIR", str(Path(__file__).resolve().parents[2] / "api")))
sys.path.insert(0, str(API_DIR))
from chat import shortcode, signing  # noqa: E402
from chat.config import ProxyGuard  # noqa: E402


class Clock:
    now = 1_800_000_000.0

    def time(self) -> float:
        return self.now


clock = Clock()
for m in (shortcode, signing):
    m.time = clock

TMP = tempfile.mkdtemp(prefix="shortcode-")


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
    shortcode.create_tables(conn.cursor())
    conn.commit()

app = FastAPI()
app.include_router(shortcode.create_shortcode_router(get_db, ProxyGuard(client_ip=lambda req: req.headers.get("X-Test-IP", "203.0.113.9"),
                                                                         internal_ok=lambda req: True)))
client = TestClient(app)


def keypair():
    priv = Ed25519PrivateKey.generate()
    return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def sign(priv, payload: dict) -> str:
    return base64.b64encode(priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())).decode()


def register_account(pk):
    with get_db() as conn:
        conn.execute("INSERT INTO pubkey_account_map (pubkey_hash, account_key, created_at) VALUES (?,?,0)",
                     (hashlib.sha256(pk.encode()).hexdigest(), "acct-" + pk[:8]))
        conn.commit()


ip_counter = [0]


def body(priv, pk, action="register_shortcode", name="Alice", spk_signer=None, **over):
    spk = base64.b64encode(os.urandom(32)).decode()
    f = {"action": action, "public_key": pk, "signed_pre_key": spk,
         "signature": base64.b64encode((spk_signer or priv).sign(base64.b64decode(spk))).decode(),
         "display_name": name, "timestamp": int(clock.now), "request_id": secrets.token_hex(12)}
    f.update(over)
    signed = {k: v for k, v in f.items() if k != "request_signature"}
    return {**f, "request_signature": f.get("request_signature") or sign(priv, signed)}


def post(path, data, status, ip=None):
    ip_counter[0] += 1
    r = client.post(path, json=data, headers={"X-Test-IP": ip or f"198.51.100.{ip_counter[0] % 250}"})
    assert r.status_code == status, (path, status, r.status_code, r.text)
    return r.json()


def lookup(code, status=200):
    ip_counter[0] += 1
    r = client.get(f"/api/shortcode/lookup/{code}", headers={"X-Test-IP": f"192.0.2.{ip_counter[0] % 250}"})
    assert r.status_code == status, (code, r.status_code, r.text)
    return r.json()


alice_priv, alice = keypair()
mallory_priv, mallory = keypair()
ghost_priv, ghost = keypair()
for pk in (alice, mallory):
    register_account(pk)
REG, REF = "/api/shortcode/register", "/api/shortcode/refresh"

# ── 正常 ──
first = body(alice_priv, alice)
r1 = post(REG, first, 200)
assert r1["is_new"] and r1["remaining_seconds"] == 86400, r1
seen = lookup(f"ATK-{r1['short_code']}")
assert seen["pk"] == alice and seen["spk"] == first["signed_pre_key"] and seen["sig"] == first["signature"] and seen["name"] == "Alice", seen
again = body(alice_priv, alice, name="Alice 2")
r2 = post(REG, again, 200)
assert r2["short_code"] == r1["short_code"] and not r2["is_new"], "register keeps the live code"
assert lookup(r1["short_code"])["spk"] == again["signed_pre_key"], "…and updates the pre-key behind it"
print("PASS register: signed request → code; registering again keeps the code and updates the pre-key bundle")

# ── 攻擊：覆蓋別人的短碼、作廢別人的短碼 ──
hijack = body(mallory_priv, alice, name="Alice", spk_signer=mallory_priv)            # 用自己的金鑰替 alice 簽
assert post(REG, hijack, 401)["detail"] == "invalid_shortcode_signature"
assert post(REF, body(mallory_priv, alice, action="refresh_shortcode"), 401)["detail"] == "invalid_shortcode_signature"
# alice 自己簽的請求，偷換掉預備金鑰／簽章／名字／時間／request_id
legit = body(alice_priv, alice)
_, other_spk_pk = keypair()
for field, value in (("signed_pre_key", base64.b64encode(os.urandom(32)).decode()), ("display_name", "Mallory"),
                     ("signature", body(alice_priv, alice)["signature"]), ("request_id", secrets.token_hex(12)),
                     ("timestamp", int(clock.now) - 1)):
    post(REG, {**legit, field: value}, 401)
# register 的簽章拿去 refresh
assert post(REF, body(alice_priv, alice, action="register_shortcode"), 401)["detail"] == "invalid_shortcode_signature"
# 預備金鑰的 X3DH 簽章不是身分金鑰簽的（client 照樣簽了請求）
assert post(REG, body(alice_priv, alice, spk_signer=mallory_priv), 401)["detail"] == "invalid_prekey_signature"
assert lookup(r1["short_code"])["spk"] == again["signed_pre_key"], "nothing above changed the bundle"
print("PASS forged/tampered requests (another key, swapped pre-key/name/signature/id/time, register signature reused for refresh, "
      "pre-key not signed by the identity key) → 401; the code's bundle is unchanged")

# ── 帳號、時鐘、重放、欄位、限速 ──
assert post(REG, body(ghost_priv, ghost), 403)["detail"] == "account_not_registered"
skew = post(REG, body(alice_priv, alice, timestamp=int(clock.now) + 400), 401)
assert skew["detail"] == {"code": "clock_skew", "server_time": int(clock.now)}, skew
replay = body(alice_priv, alice)
post(REG, replay, 200)
assert post(REG, replay, 409)["detail"] == "request_replayed"
post(REG, {**body(alice_priv, alice), "extra": 1}, 422)
post(REG, {k: v for k, v in body(alice_priv, alice).items() if k != "request_signature"}, 422)
post(REG, body(alice_priv, alice, name="x" * 51), 422)
post(REG, {**body(alice_priv, alice), "signed_pre_key": "A" * 129}, 422)
alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
variant = alice[:42] + alphabet[alphabet.index(alice[42]) ^ 1] + "="
post(REG, body(alice_priv, variant), 401)
codes = [client.post(REG, json=body(alice_priv, alice), headers={"X-Test-IP": "192.0.2.200"}).status_code for _ in range(31)]
assert codes.count(200) == 30 and codes[-1] == 429, codes
print("PASS no account 403, clock skew 401 {code, server_time}, replay 409, extra/missing/oversized fields 422, non-canonical key 401, "
      "30 writes per IP per minute")

# ── refresh 作廢舊碼；過期清掉 ──
r3 = post(REF, body(alice_priv, alice, action="refresh_shortcode"), 200)
assert r3["is_new"] and r3["short_code"] != r1["short_code"]
lookup(r1["short_code"], 404)
assert lookup(r3["short_code"])["pk"] == alice
m1 = post(REG, body(mallory_priv, mallory, name="M"), 200)
clock.now += 86400 * 2 + 1
post(REG, body(alice_priv, alice), 200)
with get_db() as conn:
    left = [r[0] for r in conn.execute("SELECT short_code FROM friend_shortcodes")]
assert m1["short_code"] not in left and r3["short_code"] not in left and len(left) == 1, f"codes expired for a day are purged ({left})"
print("PASS refresh cancels the old code at once; codes expired for a day are purged")

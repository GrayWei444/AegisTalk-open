#!/usr/bin/env python3
"""
MQTT token 發放（對應群星 A8／B4／B18）：真的 chat 伺服器 api/chat/mqtt_auth.py（create_mqtt_router 的 /api/mqtt/token、
/api/mqtt/transfer-token、mqtt_acl、publish_mqtt_kick），配暫存 SQLite 與 FastAPI TestClient 執行（paho 換成假的）。不連任何正式服務。

以前：/api/mqtt/token 只收 {pubkeyHash}、不驗簽，JWT 只有 sub/exp/iat/iss、沒有 ACL —— 任何人都能替任何人拿 token、
訂閱任何人的收件箱；踢裝置的 token 也沒有 ACL；EMQX 的 HTTP webhook 對任何有效 JWT 回 allow。
現在：
  - 請求要帳戶 Ed25519 簽章（含 groups／presence／presence_tag／client_id／device_id），時間窗 ±300 秒，request_id 只能用一次
  - JWT 帶 acl：只發布到自己那一節（inbox/<我>、group/+/<我>）與自己那一個秘密 presence 主題（presence/<我的 tag>，沒有 tag 就沒有），
    只訂閱自己的收件箱、簽過名的群組主題 id、簽過名的確切好友 presence 主題、這台裝置的 kick 主題；username／sub＝URL-safe 公鑰；
    clientid 綁簽章者自己的前綴
  - （W3）群組主題 id 只收剛好 22 個 URL-safe 字元（每一代金鑰推出來的 tid，不是 gid）：+、#、/、21／23 字元、空字串、
    結尾換行、非字串 → 400；超過 50 個 → 422
  - （W4）沒有 peers（公鑰清單）了：送了就 422（簽了也一樣）。presence 只收確切的 mist/user/<標準寫法 URL-safe 公鑰>/presence/<22 字元 tag>：
    萬用字元、多一層、舊的 mist/user/<他>/presence、非標準寫法的公鑰、標準 base64、長度不對、結尾換行 → 400；非字串 → 422；
    150 個可以、151 個 → 422；presence_tag 也只收 22 個 URL-safe 字元
  - 換機 token：不用登入、只能訂閱自己隨機收件箱、什麼都不能發、clientId 由伺服器指定、每 IP 每小時 20 張
  - 踢裝置 token：只能發 kick 主題、綁 username／clientId
  - /api/mqtt/auth webhook 拿掉了
  - （審查 2a）kick 主題只給帳號目前的活躍裝置；被換掉的裝置拿不到 token（403 device_replaced）；沒帳號／還沒 claim 照發、沒有 kick
  - （審查 2a）每 IP 每分鐘 120 張；時鐘差太多回 401 {code: clock_skew, server_time}；回應帶 subscribe（＝acl.sub）與 serverTime
  - （開源第 3 步）acl claim 兩種格式：legacy {pub, sub, all}（上面的檢查）與 rules（EMQX ≥ 5.7：只有我自己的 presence 主題能 retain，
    其他發布規則 retain: false，最後 deny all）；require_account（獨立 chat 伺服器）沒帳號 403；每個帳號／金鑰 24 小時內的
    不同群組＋presence 主題數上限（429 mqtt_topic_quota，已經拿過的不重算，超過的那張整張不發、request_id 不算用掉）
Run: python3 scripts/review/mqtt_token_acl_self_test.py   （需要 fastapi、pydantic 2、pyjwt、cryptography、httpx）
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
import time
import types
from contextlib import contextmanager
from pathlib import Path

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

API_DIR = Path(__file__).resolve().parents[2] / "api"
SECRET = "fixture-secret-not-live-at-least-32-bytes"
INTERNAL = {"X-Aegis-Internal": "test-internal"}


class Clock:
    now = time.time()

    def time(self) -> float:
        return self.now


clock = Clock()
published: list = []
fake_paho = types.ModuleType("paho.mqtt.publish")
fake_paho.single = lambda topic, **kw: published.append({"topic": topic, **kw})
for name in ("paho", "paho.mqtt"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["paho.mqtt.publish"] = fake_paho
sys.modules["paho.mqtt"].publish = fake_paho

sys.path.insert(0, str(API_DIR))
from chat import devices, mqtt_auth, signing, usage  # noqa: E402
from chat.config import ChatConfig, ProxyGuard  # noqa: E402

for m in (mqtt_auth, signing):
    m.time = clock      # 伺服器的時鐘（簽章時間窗、token 的 iat/exp、限速）


def served_routes() -> set:
    """api/ 底下所有檔案（main.py、chat/*、其他路由模組）用 @app／@router 掛的路徑"""
    out = set()
    for f in [*API_DIR.glob("*.py"), *API_DIR.glob("chat/*.py")]:
        for n in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for d in n.decorator_list:
                    if isinstance(d, ast.Call) and d.args and isinstance(d.args[0], ast.Constant) and isinstance(d.args[0].value, str):
                        out.add(d.args[0].value)
    return out


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
        signing.create_tables(c.cursor())     # request_nonces、pubkey_account_map
        devices.create_tables(c.cursor())     # talk_active_device
        usage.create_tables(c.cursor())       # chat_meta、mqtt_topic_grants（每個帳號的主題數上限）
        c.commit()

    def register(pk: str, account: str, device: "str | None"):
        """pubkey → 帳號（AegisID）＋帳號目前的活躍裝置（/api/devices/claim）"""
        with get_db() as c:
            c.execute("INSERT OR REPLACE INTO pubkey_account_map (pubkey_hash, account_key) VALUES (?, ?)",
                      (hashlib.sha256(pk.encode()).hexdigest(), account))
            c.execute("DELETE FROM talk_active_device WHERE account_key=?", (account,))
            if device:
                c.execute("INSERT INTO talk_active_device (account_key, device_id, pubkey_hash, platform, last_seen, created_at)"
                          " VALUES (?,?,?,?,?,?)", (account, device, "h", "android", 0, 0))
            c.commit()

    cfg = ChatConfig(mqtt_jwt_secret=SECRET, mqtt_acl_format="legacy")   # 下面先驗 {pub, sub, all}；rules 格式在檔尾
    guard = ProxyGuard(client_ip=lambda req: req.headers.get("X-Test-IP", "203.0.113.9"),
                       internal_ok=lambda req: req.headers.get("X-Aegis-Internal") == "test-internal")
    app = FastAPI()
    app.include_router(mqtt_auth.create_mqtt_router(cfg, get_db, signing.resolve_account_key, guard))
    client = TestClient(app)

    def keypair():
        priv = Ed25519PrivateKey.generate()
        return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()

    def url(pk: str) -> str:
        return base64.urlsafe_b64encode(base64.b64decode(pk)).decode().rstrip("=")

    me_priv, me = keypair()
    _, friend = keypair()
    _, member = keypair()
    other_priv, other = keypair()
    DEVICE = "0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab"
    GROUP = "Tq3xZ0-_aB9cD8eF7gH6iJ"   # 群組主題 id（W3）：22 個 URL-safe 字元
    assert len(GROUP) == 22
    MYTAG = "Pq9_Rs8-Tu7Vw6Xy5Za4Bc"   # 我的 presence tag（W4）：22 個 URL-safe 字元
    TAG2 = "Hj3kLm4nOp5qRs6tUv7wXy"
    assert len(MYTAG) == len(TAG2) == 22

    def ptopic(pk: str, tag: str) -> str:
        return f"mist/user/{url(pk)}/presence/{tag}"

    def sign(priv, payload: dict) -> str:
        msg = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        return base64.b64encode(priv.sign(msg)).decode()

    def request(priv=me_priv, pk=me, **over):
        fields = dict(action="mqtt_token", pubkey=pk, timestamp=int(clock.now), request_id=secrets.token_hex(12),
                      client_id=f"mist_{url(pk)[:16]}_{DEVICE[:8]}", groups=[GROUP],
                      presence=[ptopic(friend, TAG2), ptopic(member, MYTAG)], presence_tag=MYTAG, device_id=DEVICE)
        fields.update(over)
        fields = {k: v for k, v in fields.items() if v is not None}
        return {**fields, "signature": sign(priv, fields)}

    def post(path, data, status, headers=INTERNAL):
        r = client.post(path, json=data, headers=headers)
        assert r.status_code == status, (path, status, r.status_code, r.text)
        return r.json()

    def claims(token: str) -> dict:
        return jwt.decode(token, SECRET, algorithms=["HS256"], options={"verify_exp": False, "verify_iat": False})

    # ── 簽章 ──
    req = request()
    post("/api/mqtt/token", req, 403, headers={})                            # 沒經過 Caddy
    unsigned = {k: v for k, v in req.items() if k != "signature"}
    post("/api/mqtt/token", unsigned, 422)                                   # 沒簽章（舊的 {pubkeyHash} 也是 422）
    post("/api/mqtt/token", {"pubkeyHash": hashlib.sha256(url(me).encode()).hexdigest()[:32]}, 422)
    post("/api/mqtt/token", {**req, "signature": request(priv=other_priv)["signature"]}, 401)   # 別人的金鑰簽的
    post("/api/mqtt/token", {**req, "groups": [GROUP, "Zz" * 11]}, 401)      # 簽完偷加群組主題
    post("/api/mqtt/token", {**req, "presence": req["presence"] + [ptopic(other, TAG2)]}, 401)  # 簽完偷加 presence 主題
    post("/api/mqtt/token", {**req, "presence_tag": TAG2}, 401)              # 簽完換掉我的 tag（發布權）
    post("/api/mqtt/token", {**req, "device_id": "ffffffff-8a2d-4c3b-9e7f-1234567890ab"}, 401)
    post("/api/mqtt/token", {**req, "client_id": f"mist_{url(other)[:16]}_{DEVICE[:8]}"}, 401)
    post("/api/mqtt/token", {**req, "pubkey": other}, 401)                   # 拿我的簽章替別人要
    # 時間窗外（手機時鐘差太多）→ 401 帶伺服器時間，client 用它重簽一次
    for skew in (-301, 301, -86400):
        detail = post("/api/mqtt/token", request(timestamp=int(clock.now) + skew), 401)["detail"]
        assert detail == {"code": "clock_skew", "server_time": int(clock.now)}, detail
    # 同一把金鑰的非標準 base64 寫法（最後一個字元沒用到的位元改掉）：解得出同一把金鑰，但字串不同 → 不收
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    variant = me[:42] + alphabet[alphabet.index(me[42]) ^ 1] + "="          # 第 43 字元最低兩位元沒用到
    assert base64.b64decode(variant) == base64.b64decode(me) and variant != me
    post("/api/mqtt/token", request(pk=variant, client_id=f"mist_{url(me)[:16]}_{DEVICE[:8]}"), 401)

    # ── 正常發放與 ACL 內容（帳號的活躍裝置就是這台 → 有 kick 主題） ──
    register(me, "acct-me", DEVICE)
    ok = post("/api/mqtt/token", req, 200)
    c = claims(ok["token"])
    u = url(me)
    assert ok["username"] == u and c["sub"] == u and c["username"] == u and c["iss"] == "aegisrd", c
    assert c["clientid"] == req["client_id"], c
    assert ok["expiresAt"] == c["exp"] == int(clock.now) + 3600, (ok, c)
    assert ok["serverTime"] == int(clock.now), ok
    assert ok["subscribe"] == c["acl"]["sub"], (ok["subscribe"], c["acl"])   # client 只訂這些
    assert c["acl"] == {
        "pub": [f"mist/user/+/inbox/{u}", f"mist/group/+/{u}", f"mist/user/{u}/presence/{MYTAG}"],
        "sub": [f"mist/user/{u}/inbox/+", f"mist/group/{GROUP}/+",
                ptopic(friend, TAG2), ptopic(member, MYTAG),
                f"aegis/device/{DEVICE}/kicked"],
        "all": [],
    }, c["acl"]
    # W4：沒有任何一條 presence 規則是只靠公鑰推得出來的 mist/user/<他>/presence；每一條都是確切的 <tag> 主題
    assert not any(t.endswith("/presence") for t in c["acl"]["sub"] + c["acl"]["pub"]), c["acl"]
    assert all(re.fullmatch(r"mist/user/[A-Za-z0-9_-]{43}/presence/[A-Za-z0-9_-]{22}", t)
               for t in c["acl"]["sub"] + c["acl"]["pub"] if "/presence" in t), c["acl"]
    # 我唯一的 presence 發布權是我自己那一個主題（也是唯一可以 retain 的，docs/MQTT_BROKER.md §3.1）
    assert [t for t in c["acl"]["pub"] if "/presence" in t] == [f"mist/user/{u}/presence/{MYTAG}"], c["acl"]
    # 不能訂閱萬用字元：沒有任何一條 sub 規則在「別人」或「群組 id」的位置用 + 或 #
    assert not any("#" in t for t in c["acl"]["sub"] + c["acl"]["pub"]), c["acl"]
    assert all(t.split("/")[2] != "+" for t in c["acl"]["sub"] if t.startswith(("mist/user/", "mist/group/"))), c["acl"]

    # ── 重放 ──
    post("/api/mqtt/token", req, 409)                                        # 同一個 request_id 第二次
    with get_db() as conn:                                                   # 過了簽章時間窗才清 nonce
        assert conn.execute("SELECT COUNT(*) FROM request_nonces").fetchone()[0] == 1

    # ── device_id 要是帳號目前的活躍裝置（審查 2a LOW：以前誰都能訂任何一台的 kick 主題） ──
    OTHER_DEVICE = "ffffffff-8a2d-4c3b-9e7f-1234567890ab"
    post("/api/mqtt/token", request(device_id=OTHER_DEVICE, client_id=f"mist_{u[:16]}_{OTHER_DEVICE[:8]}"), 403)
    post("/api/mqtt/token", request(device_id=None), 403)                    # 有活躍裝置卻不說是哪台
    register(me, "acct-me", OTHER_DEVICE)                                    # 換機了：這台被踢
    assert post("/api/mqtt/token", request(), 403)["detail"] == "device_replaced"
    register(me, "acct-me", None)                                            # 帳號還沒 claim → 照發、沒有 kick
    unclaimed = post("/api/mqtt/token", request(), 200)
    assert not any(t.startswith("aegis/device/") for t in claims(unclaimed["token"])["acl"]["sub"]), unclaimed
    assert unclaimed["subscribe"] == claims(unclaimed["token"])["acl"]["sub"]
    with get_db() as conn:
        conn.execute("DELETE FROM pubkey_account_map")
        conn.commit()
    stranger = post("/api/mqtt/token", request(), 200)                       # 沒有帳號（H1 之後再收緊）→ 也沒有 kick
    assert not any(t.startswith("aegis/device/") for t in claims(stranger["token"])["acl"]["sub"]), stranger
    register(me, "acct-me", DEVICE)

    # ── 範圍：沒群組、沒好友、沒 tag、沒 device_id → 只剩自己的收件箱，沒有任何 presence 發布權 ──
    register(me, "acct-me", None)
    bare = claims(post("/api/mqtt/token", request(groups=[], presence=[], presence_tag=None, device_id=None), 200)["token"])
    assert bare["acl"]["sub"] == [f"mist/user/{u}/inbox/+"], bare["acl"]
    assert bare["acl"]["pub"] == [f"mist/user/+/inbox/{u}", f"mist/group/+/{u}"], bare["acl"]
    # 重複的群組／presence 主題只算一次
    dup = claims(post("/api/mqtt/token", request(groups=[GROUP, GROUP], presence=[ptopic(friend, TAG2)] * 2, device_id=None), 200)["token"])
    assert dup["acl"]["sub"] == [f"mist/user/{u}/inbox/+", f"mist/group/{GROUP}/+", ptopic(friend, TAG2)], dup["acl"]
    # ── W4：peers（公鑰清單）拿掉了：送了就整張不發（簽在裡面也一樣） ──
    for peers in ([friend], []):
        assert post("/api/mqtt/token", request(peers=peers), 422)["detail"][0]["type"] == "extra_forbidden"
    # presence 主題只收確切的形狀
    furl = url(friend)
    alphabet_url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    variant_url = furl[:42] + alphabet_url[alphabet_url.index(furl[42]) ^ 1]   # 同一把金鑰的非標準寫法
    bad_presence = [
        f"mist/user/{furl}/presence",                       # 舊的：只要知道公鑰就能訂
        f"mist/user/{furl}/presence/+", f"mist/user/{furl}/presence/#", f"mist/user/+/presence/{TAG2}", f"mist/user/{furl}/+/{TAG2}",
        f"mist/user/{furl}/presence/{TAG2}/x", f"mist/user/{furl}/presence/{TAG2[:21]}", f"mist/user/{furl}/presence/{TAG2}A",
        f"mist/user/{furl}/presence/{TAG2}\n", f"mist/user/{friend}/presence/{TAG2}", f"mist/user/{variant_url}/presence/{TAG2}",
        f"mist/user/{furl}/inbox/{TAG2}", f"mist/group/{TAG2}/+", "#", "", f"mist/user/{furl[:42]}/presence/{TAG2}",
        f"mist/user/{furl}/presence/{TAG2[:21]}=",
    ]
    for t in bad_presence:
        assert post("/api/mqtt/token", request(presence=[ptopic(friend, TAG2), t]), 400)["detail"] == "invalid_acl_presence", t
    for tag in ("+", "#", "", TAG2[:21], TAG2[:21] + "/", TAG2[:21] + "=", TAG2[:21] + "+", TAG2[:21] + "\n"):
        assert post("/api/mqtt/token", request(presence_tag=tag), 400)["detail"] == "invalid_acl_presence_tag", tag
    for tag in (TAG2 + "A", TAG2 + "\n", 12345):                                 # 太長、不是字串：pydantic 先擋（422）
        post("/api/mqtt/token", request(presence_tag=tag), 422)
    post("/api/mqtt/token", request(presence=[ptopic(friend, TAG2), 12345]), 422)    # 不是字串（pydantic）
    many = [f"mist/user/{url(keypair()[1])}/presence/{TAG2}" for _ in range(151)]
    full_p = claims(post("/api/mqtt/token", request(presence=many[:150], device_id=None), 200)["token"])
    assert [t for t in full_p["acl"]["sub"] if "/presence/" in t] == many[:150], "150 exact presence topics accepted"
    post("/api/mqtt/token", request(presence=many), 422)                            # 151 個
    # 群組主題 id（W3）：剛好 22 個 URL-safe 字元；萬用字元、多一層、長度不對、舊的群組 id 格式都整張拒絕
    bad_topics = ["a/b", "+", "#", "", "A" * 21, "A" * 23, "A" * 21 + "+", "A" * 21 + "#", "A" * 10 + "/" + "A" * 11,
                  "A" * 22 + "\n", "A" * 21 + "=", "A" * 21 + ".", "group-1760000000000-abc1234", "+/#", "A" * 64]
    for t in bad_topics:
        post("/api/mqtt/token", request(groups=[GROUP, t]), 400)
    post("/api/mqtt/token", request(groups=[GROUP, 12345]), 422)              # 不是字串（pydantic）
    for bad in ({"device_id": "x/y/z/1234"}, {"device_id": "+"}, {"device_id": "short"}):
        post("/api/mqtt/token", request(**bad), 400)
    fifty = [f"{i:02d}" + "A" * 20 for i in range(50)]
    assert all(len(t) == 22 for t in fifty)
    full = claims(post("/api/mqtt/token", request(groups=fifty, presence=[], device_id=None), 200)["token"])
    assert [t for t in full["acl"]["sub"] if t.startswith("mist/group/")] == [f"mist/group/{t}/+" for t in fifty], full["acl"]
    post("/api/mqtt/token", request(groups=fifty + ["50" + "A" * 20]), 422)   # 51 個
    # 每一條群組訂閱規則都是確切的 22 字元主題 id（沒有萬用字元、沒有多的層）
    assert all(re.fullmatch(r"mist/group/[A-Za-z0-9_-]{22}/\+", t) for t in full["acl"]["sub"] if t.startswith("mist/group/")), full["acl"]
    for missing in ("groups", "presence", "client_id"):
        r = request()
        r.pop(missing)
        post("/api/mqtt/token", r, 422)

    # ── clientId 綁簽章者自己的公鑰 ──
    for bad in (f"mist_{url(other)[:16]}_{DEVICE[:8]}",         # 別人的 clientId → 會接手別人的持久 session
                f"guardian_{u[:16]}", f"transfer_{u[:16]}", f"debug_{DEVICE[:8]}",
                f"mist_{u[:16]}_toolongsuffix", f"mist_{u[:16]}_a/b", f"mist_{u[:15]}_{DEVICE[:8]}"):
        post("/api/mqtt/token", request(client_id=bad), 400)

    # ── 換機 token ──
    t = post("/api/mqtt/transfer-token", {}, 200)
    tc = claims(t["token"])
    assert t["username"].startswith("transfer_") and tc["username"] == tc["sub"] == tc["clientid"] == t["username"], tc
    assert t["subscribe"] == tc["acl"]["sub"] and t["serverTime"] == int(clock.now), t
    assert tc["acl"] == {"pub": [], "sub": [f"mist/user/{t['username']}/inbox/+"], "all": []}, tc["acl"]
    assert tc["exp"] - int(clock.now) == 300, tc
    assert claims(post("/api/mqtt/transfer-token", {}, 200)["token"])["username"] != t["username"]
    post("/api/mqtt/transfer-token", {}, 403, headers={})
    for _ in range(18):
        post("/api/mqtt/transfer-token", {}, 200)
    post("/api/mqtt/transfer-token", {}, 429)                                # 同一 IP 一小時第 21 張
    post("/api/mqtt/transfer-token", {}, 200, headers={**INTERNAL, "X-Test-IP": "198.51.100.7"})
    clock.now += 3601
    post("/api/mqtt/transfer-token", {}, 200)

    # ── 每 IP 每分鐘 120 張（審查 2a MEDIUM）：先擋再驗簽、寫 nonce ──
    flood = {**INTERNAL, "X-Test-IP": "192.0.2.50"}
    limit = mqtt_auth.MQTT_TOKEN_IP_LIMIT
    assert limit == 120, limit
    for _ in range(limit):
        post("/api/mqtt/token", request(groups=[], presence=[], device_id=None), 200, headers=flood)
    assert post("/api/mqtt/token", request(groups=[], presence=[], device_id=None), 429, headers=flood)["detail"] == "mqtt_token_rate_limited"
    post("/api/mqtt/token", request(groups=[], presence=[], device_id=None), 200, headers={**INTERNAL, "X-Test-IP": "192.0.2.51"})
    clock.now += 61
    post("/api/mqtt/token", request(groups=[], presence=[], device_id=None), 200, headers=flood)

    # ── 踢裝置的推播 token ──
    mqtt_auth.publish_mqtt_kick(cfg, DEVICE)
    assert len(published) == 1, published
    k = published[0]
    kc = claims(k["auth"]["password"])
    assert k["topic"] == f"aegis/device/{DEVICE}/kicked" and k["auth"]["username"] == kc["username"] == "aegis-system", k
    assert kc["clientid"] == k["client_id"] and kc["acl"] == {"pub": ["aegis/device/+/kicked"], "sub": [], "all": []}, kc

    # ── rules 格式（EMQX ≥ 5.7，預設）：同樣的 ACL，只有我自己的 presence 主題能 retain，最後 deny all ──
    rules_cfg = ChatConfig(mqtt_jwt_secret=SECRET)
    assert rules_cfg.mqtt_acl_format == "rules", "rules is the default format"
    rules_app = FastAPI()
    rules_app.include_router(mqtt_auth.create_mqtt_router(rules_cfg, get_db, signing.resolve_account_key, guard))
    rules_client = TestClient(rules_app)
    register(me, "acct-me", DEVICE)
    clock.now += 61
    r = rules_client.post("/api/mqtt/token", json=request(), headers={**INTERNAL, "X-Test-IP": "198.51.100.40"})
    assert r.status_code == 200, r.text
    rc = claims(r.json()["token"])["acl"]
    legacy = mqtt_auth.mqtt_acl(u, groups=[GROUP], presence=[ptopic(friend, TAG2), ptopic(member, MYTAG)], presence_tag=MYTAG, device_id=DEVICE)
    assert r.json()["subscribe"] == legacy["sub"], "subscribe is the same list in both formats"
    assert rc == [
        {"permission": "allow", "action": "publish", "topic": f"mist/user/+/inbox/{u}", "retain": False},
        {"permission": "allow", "action": "publish", "topic": f"mist/group/+/{u}", "retain": False},
        {"permission": "allow", "action": "publish", "topic": f"mist/user/{u}/presence/{MYTAG}"},
        *[{"permission": "allow", "action": "subscribe", "topic": t} for t in legacy["sub"]],
        {"permission": "deny", "action": "all", "topic": "#"},
    ], rc
    assert [x["topic"] for x in rc if x["action"] == "publish" and "retain" not in x] == [f"mist/user/{u}/presence/{MYTAG}"], \
        "the owner's own presence topic is the only publish rule without retain: false"
    no_tag = claims(rules_client.post("/api/mqtt/token", json=request(presence_tag=None), headers={**INTERNAL, "X-Test-IP": "198.51.100.40"}).json()["token"])["acl"]
    assert all(x.get("retain") is False for x in no_tag if x["action"] == "publish"), "no tag → nothing may be retained"
    tr = claims(rules_client.post("/api/mqtt/transfer-token", json={}, headers={**INTERNAL, "X-Test-IP": "198.51.100.41"}).json()["token"])
    assert tr["acl"] == [{"permission": "allow", "action": "subscribe", "topic": f"mist/user/{tr['username']}/inbox/+"},
                         {"permission": "deny", "action": "all", "topic": "#"}], tr["acl"]
    published.clear()
    mqtt_auth.publish_mqtt_kick(rules_cfg, DEVICE)
    assert claims(published[0]["auth"]["password"])["acl"] == [
        {"permission": "allow", "action": "publish", "topic": "aegis/device/+/kicked", "retain": False},
        {"permission": "deny", "action": "all", "topic": "#"}], published
    try:
        mqtt_auth.create_mqtt_router(ChatConfig(mqtt_jwt_secret=SECRET, mqtt_acl_format="v9"), get_db, signing.resolve_account_key, guard)
        raise AssertionError("an unknown ACL format must fail when the router is built")
    except ValueError:
        pass
    print("PASS rules ACL format: same subscriptions, retain only on my own presence topic, deny-all last (token, transfer, kick); unknown format fails at startup")

    # ── require_account（獨立的 chat 伺服器）：沒有帳號的金鑰拿不到 token ──
    strict_app = FastAPI()
    strict_app.include_router(mqtt_auth.create_mqtt_router(rules_cfg, get_db, signing.resolve_account_key, guard, require_account=True))
    strict = TestClient(strict_app)
    nobody_priv, nobody = keypair()
    ip3 = {**INTERNAL, "X-Test-IP": "198.51.100.42"}
    r = strict.post("/api/mqtt/token", json=request(priv=nobody_priv, pk=nobody, client_id=f"mist_{url(nobody)[:16]}_{DEVICE[:8]}",
                                                     device_id=None), headers=ip3)
    assert r.status_code == 403 and r.json()["detail"] == "account_not_registered", r.text
    register(nobody, "acct-nobody", None)
    retry = request(priv=nobody_priv, pk=nobody, client_id=f"mist_{url(nobody)[:16]}_{DEVICE[:8]}", device_id=None)
    assert strict.post("/api/mqtt/token", json=retry, headers=ip3).status_code == 200, "registered → token"
    print("PASS require_account: an unregistered key gets 403 account_not_registered, the same key after registering gets a token")

    # ── 每個帳號 24 小時內的不同主題數上限（限制猜主題）──
    quota_cfg = ChatConfig(mqtt_jwt_secret=SECRET, token_topics_per_day=200)
    quota_app = FastAPI()
    quota_app.include_router(mqtt_auth.create_mqtt_router(quota_cfg, get_db, signing.resolve_account_key, guard))
    quota = TestClient(quota_app)
    qpriv, qpk = keypair()
    register(qpk, "acct-quota", None)
    qip = {**INTERNAL, "X-Test-IP": "198.51.100.43"}

    def qreq(groups, presence):
        return request(priv=qpriv, pk=qpk, client_id=f"mist_{url(qpk)[:16]}_{DEVICE[:8]}", groups=groups, presence=presence, device_id=None)
    g50 = [f"{i:02d}" + "Q" * 20 for i in range(50)]
    p150 = [f"mist/user/{url(keypair()[1])}/presence/{TAG2}" for _ in range(150)]
    assert quota.post("/api/mqtt/token", json=qreq(g50, p150), headers=qip).status_code == 200, "a full token (200 topics) fits"
    assert quota.post("/api/mqtt/token", json=qreq(g50, p150), headers=qip).status_code == 200, "the same topics again do not count twice"
    over = qreq(g50[:49] + ["ZZ" + "Q" * 20], p150)
    r = quota.post("/api/mqtt/token", json=over, headers=qip)
    assert r.status_code == 429 and r.json()["detail"] == "mqtt_topic_quota", r.text
    with get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM request_nonces WHERE nonce = ?", (over["request_id"],)).fetchone()[0] == 0, \
            "a refused token does not use up its request_id"
        stored = conn.execute("SELECT COUNT(*) FROM mqtt_topic_grants WHERE owner = 'acct-quota'").fetchone()[0]
        assert stored == 200, stored
        assert not conn.execute("SELECT 1 FROM mqtt_topic_grants WHERE topic_hash LIKE '%QQQQ%' OR topic_hash LIKE '%presence%'").fetchone(), \
            "topics are stored as keyed hashes, not as text"
    other_priv, other_pk = keypair()
    register(other_pk, "acct-other", None)
    assert quota.post("/api/mqtt/token", json=request(priv=other_priv, pk=other_pk, client_id=f"mist_{url(other_pk)[:16]}_{DEVICE[:8]}",
                                                      groups=["ZZ" + "Q" * 20], presence=[], device_id=None), headers=qip).status_code == 200, \
        "another account has its own allowance"
    clock.now += 86401
    assert quota.post("/api/mqtt/token", json=qreq(g50[:49] + ["ZZ" + "Q" * 20], p150), headers=qip).status_code == 200, "after 24 h the window is new"
    # 沒有帳號的金鑰（只有官方站發得出 token）：不寫用量表 —— 每次換一把新金鑰就是新的「擁有者」，記了只會把資料庫灌大（審查 HIGH）
    with get_db() as conn:
        rows_before = conn.execute("SELECT COUNT(*) FROM mqtt_topic_grants").fetchone()[0]
    for _ in range(3):
        anon_priv, anon = keypair()
        r = quota.post("/api/mqtt/token", json=request(priv=anon_priv, pk=anon, client_id=f"mist_{url(anon)[:16]}_{DEVICE[:8]}",
                                                      groups=g50, presence=p150, device_id=None), headers=qip)
        assert r.status_code == 200, r.text
    with get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM mqtt_topic_grants").fetchone()[0] == rows_before, "keys without an account write no quota rows"
    # 自己的 presence tag（＝唯一能 retain 的主題）：每個帳號 24 小時最多 MQTT_TAGS_PER_DAY 個（這個帳號已經用了 MYTAG 一個）
    assert mqtt_auth.MQTT_TAGS_PER_DAY == 20 and mqtt_auth.MQTT_CLIENT_IDS_PER_DAY == 10
    tag_codes = [quota.post("/api/mqtt/token", json=request(priv=qpriv, pk=qpk, client_id=f"mist_{url(qpk)[:16]}_{DEVICE[:8]}", groups=[],
                                                           presence=[], presence_tag=f"{i:02d}" + "T" * 20, device_id=None), headers=qip)
                 for i in range(20)]
    assert [c.status_code for c in tag_codes] == [200] * 20, [c.status_code for c in tag_codes]
    granted = [any(x.get("action") == "publish" and "/presence/" in x["topic"] for x in claims(c.json()["token"])["acl"]) for c in tag_codes]
    # 超過上限的那一張照發（整張拒絕會讓人一整天連不上），只是沒有 presence 發布權
    assert granted == [True] * 19 + [False], granted
    assert quota.post("/api/mqtt/token", json=request(priv=qpriv, pk=qpk, client_id=f"mist_{url(qpk)[:16]}_{DEVICE[:8]}", groups=[], presence=[],
                                                      presence_tag="05" + "T" * 20, device_id=None), headers=qip).status_code == 200, "a tag used before is free"
    # clientId（＝broker 上的持久 session）：每個帳號 24 小時最多 MQTT_CLIENT_IDS_PER_DAY 個（已經用了 DEVICE 那一個）
    cid_codes = [quota.post("/api/mqtt/token", json=request(priv=qpriv, pk=qpk, client_id=f"mist_{url(qpk)[:16]}_c{i:02d}", groups=[], presence=[],
                                                           presence_tag=None, device_id=None), headers=qip).status_code for i in range(10)]
    assert cid_codes == [200] * 9 + [429], cid_codes
    print("PASS topic quota: 200 distinct group/presence topics per account per 24 h — repeats free, the 201st refused (429) without using the request_id, "
          "per account, hashed at rest, window slides; keys without an account write nothing; over 20 own presence tags a day the token "
          "comes without the presence-publish right; 10 client ids per account per day")

    # ── webhook 拿掉了（api/ 底下任何一個檔案都沒有掛它）──
    routes = served_routes()
    assert "/api/mqtt/auth" not in routes, "EMQX HTTP auth webhook is back"
    assert {"/api/mqtt/token", "/api/mqtt/transfer-token"} <= set(routes)
    # 守護背景服務的憑證拿掉了（W5，guardian_credentials_self_test.py）
    assert not {r for r in routes if r.startswith("/api/mqtt/guardian-")}, routes

print("PASS mqtt token: unsigned/foreign/tampered/stale/non-canonical rejected, request_id single-use, "
      "ACL = own inbox + signed group topic ids (exactly 22 chars, no wildcards) + exact friend presence topics (no peers, no key-only or wildcard forms, ≤150) "
      "+ my one presence topic to publish + kick topic only for the account's active device, replaced device refused, "
      "clock skew answered with server time, per-IP limit, subscribe/serverTime returned, clientid bound to signer, "
      "transfer token receive-only with server-assigned clientId and per-IP limit, kick token scoped, webhook removed")

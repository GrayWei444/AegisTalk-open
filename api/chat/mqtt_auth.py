"""
MQTT 連線憑證：/api/mqtt/token、/api/mqtt/transfer-token，token 自帶的 ACL 與範圍驗證，以及伺服器自己發的「踢裝置」推播。
broker 設定見 docs/MQTT_BROKER.md 與 emqx/base.hocon.example。

ACL 在伺服器裡一律先算成 {pub, sub, all}（mqtt_acl：App 只訂 sub 裡的主題），寫進 token 的 acl claim 時看 ChatConfig.mqtt_acl_format：
  rules（預設）：EMQX ≥ 5.7 的規則清單（mqtt_acl_claim）—— 發布規則除了我自己的秘密 presence 主題都帶 retain: false
                 （收件箱、群組頻道上發 retained → PUBACK 0x87），最後一條 deny all "#"（token 自己就拒絕其他一切，
                 不靠 broker 的其他授權來源）。固定版本 EMQX 5.8.9 實測過（docs/SELF_HOSTING.md）。
  legacy：{pub, sub, all}（EMQX 5.3 起），表達不了 retain；broker 版本還沒確認 ≥ 5.7 的站用它。
第 3 步另外加了：每個帳號 24 小時內拿得到的不同群組／presence 主題數、自己的 presence tag 數、clientId 數上限（chat/usage.py），
以及（獨立的 chat 伺服器）沒有註冊帳號的金鑰拿不到 token。

⚠️ 這個檔案的模組層只用標準函式庫：scripts/sim/lib/server_acl.py 用裸的 python3 直接載入這個檔案
（mqtt_scope／mqtt_acl／mqtt_acl_claim／mqtt_topic_user 與 MQTT_* 常數，含 token 請求的欄位表 MQTT_TOKEN_REQUEST_FIELDS），
讓四手機模擬跑的就是伺服器的 ACL 與請求規則，模擬那邊沒有任何一份抄的。
FastAPI／pydantic／PyJWT／paho 都在用到的函式裡才 import（create_mqtt_router、sign_mqtt_token、publish_mqtt_kick）。
"""
import base64 as _b64
import hashlib
import json as _json
import re
import secrets
import time
from typing import Callable, List, Optional, Sequence, Tuple

MQTT_TOKEN_EXPIRY_SECONDS = 3600  # 1 hour
#: 所有 token 的 iss
MQTT_ISSUER = "aegisrd"

#: 窄 ACL 的清單上限（對應群星 A8）。JWT 本身就是 MQTT 密碼，每個好友佔一條 presence 主題（約 80 bytes），
#: 150 個約 12KB —— 再大就逼近 broker 的 CONNECT 上限。超過的部分 client 端先截掉（mqtt.ts setAclScope）。
MQTT_ACL_MAX_GROUPS = 50
MQTT_ACL_MAX_PRESENCE = 150
#: 群組主題 id（W3，docs/GROUP_LOG_WIRING_W3.md）：tid = URL-safe base64(HKDF(這一代群組金鑰, "aegistalk-gtopic-v1|" + gid))[:22]，
#: 每換一次金鑰就換。只收剛好 22 個 URL-safe 字元：沒有 + 或 #（萬用字元）、沒有 /（多一層主題）。群組 id（gid）不會出現在
#: broker 上 —— 伺服器只看到 client 自己算出來的主題 id，也不知道它屬於哪個群
MQTT_GROUP_TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
#: presence（W4，docs/GROUP_LOG_WIRING_W4.md）：每個人一個秘密主題 mist/user/<我>/presence/<tag>，tag ＝ 22 個 URL-safe 字元，
#: 由只給好友的秘密推出來（伺服器不知道那個秘密）。token 請求只收確切的主題：主人那一節是 32 bytes 公鑰的 URL-safe 寫法
#: （43 字元，最後一字元沒用到的兩個位元是 0 —— 標準寫法），沒有 +／#、沒有多一層、沒有舊的 mist/user/<他>/presence
#: （只要知道公鑰就能訂）。伺服器不查誰是誰的好友（不必知道社交圖）：不知道 tag 的人訂到的是一個什麼都沒有的主題
MQTT_PRESENCE_TAG_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
MQTT_PRESENCE_TOPIC_RE = re.compile(r"^mist/user/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]/presence/[A-Za-z0-9_-]{22}$")
MQTT_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")    # localStorage aegis_device_id（UUID v4）
MQTT_CLIENT_ID_PREFIX = "mist_"
MQTT_CLIENT_ID_RE = re.compile(r"^mist_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{1,8}$")   # mqtt.ts：mist_<公鑰前 16>_<deviceId 前 8>
MQTT_TRANSFER_TOKEN_SECONDS = 300
#: /api/mqtt/token 收的欄位（MqttTokenRequest 是 extra="forbid"：多一個欄位 → 422，例如 W4 拿掉的 peers）。create_mqtt_router
#: 啟動時核對它跟模型的欄位一模一樣；四手機模擬（scripts/sim/lib/server_acl.py）用這一份判斷多的欄位，不自己抄
MQTT_TOKEN_REQUEST_FIELDS = ("pubkey", "timestamp", "request_id", "signature", "action", "client_id", "groups", "presence",
                             "presence_tag", "device_id")
#: presence_tag 的長度上限（模型的 max_length，超過 → 422；格式由 mqtt_scope 核對：剛好 22 個 URL-safe 字元，不對 → 400）
MQTT_PRESENCE_TAG_MAX = 22

#: /api/mqtt/token 每個 IP 每分鐘幾張（審查 MEDIUM：以前沒有限速，每次都驗簽＋寫一筆 nonce）。
#: 正常一台：開 App、換範圍（加好友／進群）、到期前換新 —— 一分鐘頂多幾張；同一個 NAT 後面的人共用額度，所以給寬。
MQTT_TOKEN_IP_LIMIT = 120
#: 每個帳號 24 小時內：自己的 presence tag（＝可以 retain 的主題）最多幾個、clientId（＝broker 上的持久 session）最多幾個
#: （第 3 步審查 M：以前每張 token 都能換一個新 tag／新 clientId —— 一直換就能塞滿 broker 的 retained 上限、開一堆 24 小時的 session）。
#: 正常的 App：tag 只在刪好友／封鎖／滿 30 天時換，clientId 跟著裝置（換機、重裝才變）
MQTT_TAGS_PER_DAY = 20
MQTT_CLIENT_IDS_PER_DAY = 10


class TokenRequestError(Exception):
    """token 請求不合格：status／detail 原樣變成 HTTP 回應（路由轉成 HTTPException）"""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def mqtt_topic_user(pubkey_b64: str) -> str:
    """MQTT 主題／username 用的公鑰寫法（URL-safe、去 padding），跟 client 的 toUrlSafeBase64 相同。"""
    return _b64.urlsafe_b64encode(_b64.b64decode(pubkey_b64)).decode().rstrip("=")


def mqtt_acl(username: str, *, receive_only: bool = False, groups: Sequence[str] = (),
             presence: Sequence[str] = (), presence_tag: Optional[str] = None, device_id: Optional[str] = None) -> dict:
    """Token 自帶的 ACL（EMQX JWT authenticator 的 `acl` claim；broker 沒命中規則一律拒絕，見 docs/MQTT_BROKER.md）。

    主題的最後一節是**發送者**：發布只能落在自己那一節（inbox/<我>、group/<主題 id>/<我>），收件端再把這一節跟訊息裡的 from 對上
    —— 冒用別人的 from 送不到任何人。presence 只能發在我自己那一個秘密主題 mist/user/<我>/presence/<tag>（W4；沒有 tag 就沒有任何
    presence 發布權），那也是唯一可以 retain 的主題（docs/MQTT_BROKER.md §3.1）。
    訂閱只有：自己的收件箱、簽過名的群組主題 id（mqtt_scope 已核對剛好 22 字元，沒有萬用字元）、簽過名的確切好友 presence 主題
    （mqtt_scope 已核對形狀，沒有萬用字元、沒有只靠公鑰推得出來的主題）、這台裝置的 kick 主題。
    receive_only（換機的臨時身分）：只能訂閱自己的收件箱，什麼都不能發。
    """
    inbox = f"mist/user/{username}/inbox/+"
    if receive_only:
        return {"pub": [], "sub": [inbox], "all": []}
    pub = [
        f"mist/user/+/inbox/{username}",
        f"mist/group/+/{username}",
    ]
    if presence_tag:
        pub.append(f"mist/user/{username}/presence/{presence_tag}")
    sub = [inbox]
    sub += [f"mist/group/{group}/+" for group in groups]
    sub += list(presence)
    if device_id:
        sub.append(f"aegis/device/{device_id}/kicked")
    return {"pub": pub, "sub": sub, "all": []}


def presence_retain_topics(username: str, presence_tag: Optional[str]) -> List[str]:
    """唯一可以 retain 的主題：我自己那一個秘密 presence 主題（沒有 tag 就沒有）"""
    return [f"mist/user/{username}/presence/{presence_tag}"] if presence_tag else []


def mqtt_acl_rules(acl: dict, retain_ok: Sequence[str] = ()) -> List[dict]:
    """
    {pub, sub, all} → EMQX ≥ 5.7 的 acl claim 規則清單（依序比對、第一條命中的決定）：
      - 發布：retain_ok 裡的主題不限 retain；其他一律 "retain": false（只收非 retained 的發布，retained → 沒命中 → 拒絕）
      - 訂閱：sub 裡的每一條
      - 最後 deny all "#"：token 自己拒絕其他一切（EMQX 先比 JWT 的 acl，命中 deny 就不再看其他授權來源）
    """
    keep = set(retain_ok)
    rules: List[dict] = []
    for topic in acl["pub"]:
        rule = {"permission": "allow", "action": "publish", "topic": topic}
        if topic not in keep:
            rule["retain"] = False
        rules.append(rule)
    rules += [{"permission": "allow", "action": "subscribe", "topic": topic} for topic in acl["sub"]]
    rules += [{"permission": "allow", "action": "all", "topic": topic} for topic in acl.get("all", [])]
    rules.append({"permission": "deny", "action": "all", "topic": "#"})
    return rules


def mqtt_acl_claim(acl: dict, retain_ok: Sequence[str] = (), fmt: str = "rules"):
    """token 的 acl claim：fmt "rules"（預設，EMQX ≥ 5.7）或 "legacy"（{pub, sub, all}，表達不了 retain）"""
    if fmt == "legacy":
        return acl
    if fmt != "rules":
        raise ValueError(f"unknown ACL format {fmt!r}")
    return mqtt_acl_rules(acl, retain_ok)


def mqtt_scope(body) -> Tuple[List[str], List[str], Optional[str], Optional[str]]:
    """驗證並正規化 ACL 範圍（body 要有 groups／presence／presence_tag／device_id）。格式不對一律 400（不要默默丟掉 ——
    那會變成收不到訊息卻沒人知道）。群組主題 id 只收剛好 22 個 URL-safe 字元（W3）：+、#、/、空字串、長度不對的都拒絕，整張不發。
    presence 主題只收確切的 mist/user/<標準寫法的 URL-safe 公鑰>/presence/<22 字元 tag>（W4）：萬用字元、多一層、
    舊的只有公鑰的形狀、非標準寫法的公鑰都拒絕；presence_tag 也只收 22 個 URL-safe 字元。"""
    groups = list(dict.fromkeys(body.groups))
    if any(not isinstance(g, str) or not MQTT_GROUP_TOPIC_RE.fullmatch(g) for g in groups):
        raise TokenRequestError(400, "invalid_acl_groups")
    presence = list(dict.fromkeys(body.presence))
    if any(not isinstance(t, str) or not MQTT_PRESENCE_TOPIC_RE.fullmatch(t) for t in presence):
        raise TokenRequestError(400, "invalid_acl_presence")
    tag = body.presence_tag
    if tag is not None and (not isinstance(tag, str) or not MQTT_PRESENCE_TAG_RE.fullmatch(tag)):
        raise TokenRequestError(400, "invalid_acl_presence_tag")
    if body.device_id is not None and not MQTT_DEVICE_ID_RE.fullmatch(body.device_id):
        raise TokenRequestError(400, "invalid_acl_device_id")
    return groups, presence, tag, body.device_id


def mqtt_kick_device(cursor, pubkey: str, device_id: Optional[str], account_source: Callable) -> Optional[str]:
    """
    這張 token 能不能訂 device_id 的 kick 主題（審查 LOW：以前 device_id 只是簽章裡的一個欄位，誰都能訂任何一台的）。
    - 帳號目前的活躍裝置（talk_active_device）就是這台 → 給 kick 主題
    - 帳號的活躍裝置是**別台**（這台已經被踢／換機）→ 403 device_replaced，不發 token
    - 沒有帳號、還沒 claim（新帳號剛註冊、claim 還沒完成）→ 照發 token，但沒有 kick 主題（claim 完 client 會換一張）
    """
    pubkey_hash = hashlib.sha256(pubkey.encode()).hexdigest()
    account = account_source(cursor, pubkey_hash)
    if not account:
        return None
    active = cursor.execute("SELECT device_id FROM talk_active_device WHERE account_key=?", (account,)).fetchone()
    if not active:
        return None
    if device_id is None or active["device_id"] != device_id:
        raise TokenRequestError(403, "device_replaced")
    return device_id


def sign_mqtt_token(secret: str, payload: dict) -> str:
    """HS256 JWT（EMQX 用同一個 secret 驗簽）"""
    import jwt as pyjwt
    return pyjwt.encode(payload, secret, algorithm="HS256")


def publish_mqtt_kick(cfg, device_id: str) -> None:
    """
    Phase 35b: 透過 MQTT 即時通知舊裝置已被踢下線。

    Topic: aegis/device/{device_id}/kicked
    QoS: 1 (至少一次送達)

    安全性：客戶端收到此訊息後**不直接登出**，而是呼叫
    `/api/devices/heartbeat` 確認，避免攻擊者偽造 kick 訊息。
    """
    try:
        import paho.mqtt.publish as mqtt_publish
        now = int(time.time())
        client_id = f"aegis-system-{secrets.token_hex(4)}"
        # 跟使用者 token 一樣自帶 ACL、綁 username／clientId：只能發 kick 主題，什麼都不能訂閱
        token = sign_mqtt_token(
            cfg.mqtt_jwt_secret,
            {
                "sub": "aegis-system",
                "username": "aegis-system",
                "clientid": client_id,
                "exp": now + 60,
                "iat": now,
                "iss": MQTT_ISSUER,
                "acl": mqtt_acl_claim({"pub": ["aegis/device/+/kicked"], "sub": [], "all": []},
                                      fmt=getattr(cfg, "mqtt_acl_format", "rules")),
            },
        )
        topic = f"aegis/device/{device_id}/kicked"
        payload = _json.dumps({"type": "kicked", "device_id": device_id, "timestamp": now})
        mqtt_publish.single(
            topic,
            payload=payload,
            qos=1,
            hostname=cfg.mqtt_host,
            port=cfg.mqtt_port,
            client_id=client_id,
            auth={"username": "aegis-system", "password": token},
            keepalive=15,
        )
    except Exception as e:
        # 推播失敗不阻斷 claim — 客戶端仍會在 heartbeat 時偵測到
        print(f"[Phase35b] MQTT kick publish failed: {e}")


def create_mqtt_router(cfg, db: Callable, account_source: Callable, proxy_guard, *, require_account: bool = False):
    """
    /api/mqtt/token 與 /api/mqtt/transfer-token（cfg: ChatConfig；proxy_guard: config.ProxyGuard）。
    require_account：沒有帳號（pubkey_account_map 查不到）的金鑰拿不到 token（403 account_not_registered）。
      獨立的 chat 伺服器開（帳號由註冊政策把關，broker 不給沒註冊的人用）；官方站不開（AegisID 註冊在進聊天之後才在背景跑完）。
    """
    import jwt  # noqa: F401  缺 PyJWT 就在建 router（啟動）時失敗，不要等到第一張 token 才 500（搬出 main.py 之前就是這樣）
    from fastapi import APIRouter, HTTPException, Request
    from pydantic import BaseModel, ConfigDict, Field

    from .ratelimit import mem_rate_hit, rate_key
    from .signing import DEVICE_TIMESTAMP_TOLERANCE, consume_request_nonce, verify_device_signature
    from .usage import admit_topics

    router = APIRouter()
    token_rate: dict = {}
    transfer_rate: dict = {}
    acl_format = getattr(cfg, "mqtt_acl_format", "rules")
    topics_per_day = getattr(cfg, "token_topics_per_day", 2000)
    mqtt_acl_claim({"pub": [], "sub": [], "all": []}, fmt=acl_format)   # 不認得的格式在啟動時就失敗

    class MqttTokenRequest(BaseModel):
        """MQTT token 請求：由帳戶身份金鑰（Ed25519）簽署；subject／username／ACL 一律由伺服器從已驗簽的公鑰推導。

        簽章內容＝signature 以外的所有欄位，action 固定 "mqtt_token"（排序 JSON，同 verify_device_signature）。
        - groups：要訂閱的群組主題 id（W3：每個群目前這一代的 tid，換金鑰後上一代的再留 10 分鐘；剛好 22 字元，見
          MQTT_GROUP_TOPIC_RE）。不是群組 id —— 伺服器與 broker 都看不到 gid。
        - presence（W4）：要訂閱的好友 presence 主題，確切的 mist/user/<他>/presence/<tag>（MQTT_PRESENCE_TOPIC_RE，最多 150 個）。
          以前送的是公鑰清單 peers，伺服器替每個列出來的人組 mist/user/<他>/presence —— 誰都能看任何人的上線狀態（審查 H1）；
          peers 拿掉了，送了就 422（extra="forbid"）。
        - presence_tag（選填）：我自己的 tag → 只有 mist/user/<我>/presence/<tag> 這一個 presence 主題的發布權（也是唯一能 retain 的主題）。
        token 只拿得到這些主題的訂閱權。
        - device_id（選填）：這台裝置的 kick 主題。
        - client_id：這張 token 只能用這個 clientId 連線（JWT `clientid` claim，broker 的 verify_claims 會擋）。
          前綴必須是**簽章者自己的**公鑰 —— 拿自己的 token 綁不到別人的 clientId，接手不了別人的持久 session。
        """
        pubkey: str = Field(..., min_length=40, max_length=128)
        timestamp: int
        request_id: str = Field(..., min_length=16, max_length=128)
        signature: str = Field(..., min_length=80, max_length=128)
        model_config = ConfigDict(extra="forbid")

        #: client 把簽章內容原樣送來（含 action）；驗章一律用固定的 "mqtt_token"，送別的值只會讓簽章對不上（401）
        action: Optional[str] = Field(None, max_length=32)
        client_id: str = Field(..., max_length=64)
        groups: List[str] = Field(..., max_length=MQTT_ACL_MAX_GROUPS)
        presence: List[str] = Field(..., max_length=MQTT_ACL_MAX_PRESENCE)
        presence_tag: Optional[str] = Field(None, max_length=MQTT_PRESENCE_TAG_MAX)
        device_id: Optional[str] = Field(None, max_length=64)

    if set(MqttTokenRequest.model_fields) != set(MQTT_TOKEN_REQUEST_FIELDS):
        raise RuntimeError("MQTT_TOKEN_REQUEST_FIELDS does not list exactly the fields of MqttTokenRequest")

    class MqttTokenResponse(BaseModel):
        """MQTT token 回應：username 要原樣當成 MQTT CONNECT 的 username（broker 核對 JWT 的 username claim）。
        subscribe＝這張 token 能訂閱的主題（＝JWT acl 的 sub），client 只訂這些；serverTime＝伺服器現在幾秒，
        client 拿來校正時鐘（簽章時間窗、token 到期前換新）。"""
        token: str
        expiresAt: int
        username: str
        subscribe: List[str]
        serverTime: int

    @router.post("/api/mqtt/token", response_model=MqttTokenResponse)
    def get_mqtt_token(req: Request, body: MqttTokenRequest):
        """
        生成 MQTT JWT token（作為 MQTT password；EMQX 用同一個 secret 驗簽）。

        授權：Caddy 內部 token ＋ 帳戶 Ed25519 簽章。Caddy header 只證明請求經過 Caddy，不代表使用者身份；
        以前只收 {pubkeyHash}、不驗簽、JWT 沒有 ACL —— 任何人都能替任何人拿 token、讀任何人的收件箱。
        每 IP 每分鐘 MQTT_TOKEN_IP_LIMIT 張；時鐘差太多回 401 {code: clock_skew, server_time}；kick 主題只給帳號的
        活躍裝置、被換掉的裝置 403（mqtt_kick_device）；回應帶 subscribe（client 只訂這些）與 serverTime。

        帳號風險鎖（trust score > 80 拒發 token）刻意不在這裡做：舊版那段從來沒生效過（`db` 未定義、
        _resolve_account_key 少一個參數，例外全被 `except Exception: pass` 吞掉）。
        官方站的信任分數檢舉現在要帳戶簽章、每個檢舉者對每個目標每天最多 10 分（移植群星），但群星那道
        「至少 3 個不同檢舉帳戶才鎖」的門檻在這裡還是擋不住一個人：同一張臉最多開 FACE_CLUSTER_MAX＝3 個帳號
        （AegisID），三個帳號一天 30 分、扣掉衰減 3 天就過 80；臉部向量又是 client 自己送的，換幾個向量就是「新的臉」，
        只剩每個網路來源的註冊上限擋著。而且檢舉不需要跟對方有任何往來（知道公鑰 hash 就行）。
        斷線的代價（收不到訊息、要等分數衰減）遠大於漏鎖，所以不開；分數照樣給好友看（加好友前的風險提示）。

        第 3 步：require_account（獨立 chat 伺服器）→ 沒註冊的金鑰 403 account_not_registered；同一個帳號 24 小時內拿到的不同
        群組／presence 主題超過 cfg.token_topics_per_day → 429 mqtt_topic_quota（限制猜主題，usage.admit_topics），自己的 presence tag
        超過 MQTT_TAGS_PER_DAY → 照發、但這張沒有 presence 發布權，clientId 超過 MQTT_CLIENT_IDS_PER_DAY → 429 mqtt_client_id_quota；
        acl claim 照 cfg.mqtt_acl_format（rules：只有我自己的 presence 主題能 retain）。
        """
        if not proxy_guard.internal_ok(req):
            raise HTTPException(status_code=403, detail="Unauthorized")
        now_f = time.time()
        if not mem_rate_hit(token_rate, rate_key(proxy_guard.client_ip(req)), 60, MQTT_TOKEN_IP_LIMIT, now_f):
            raise HTTPException(status_code=429, detail="mqtt_token_rate_limited")
        now = int(now_f)

        # 手機時鐘差太多：回伺服器時間，client 用它重簽一次（審查 MEDIUM：以前只有 401，client 60 秒後再錯一次、永遠連不上）。
        #   伺服器時間不是秘密；簽章錯的請求照樣在下面 401
        if abs(now - body.timestamp) > DEVICE_TIMESTAMP_TOLERANCE:
            raise HTTPException(status_code=401, detail={"code": "clock_skew", "server_time": now})
        signed = {"action": "mqtt_token", "pubkey": body.pubkey, "timestamp": body.timestamp,
                  "request_id": body.request_id, "client_id": body.client_id,
                  "groups": body.groups, "presence": body.presence}
        if "presence_tag" in body.model_fields_set:
            signed["presence_tag"] = body.presence_tag
        if "device_id" in body.model_fields_set:
            signed["device_id"] = body.device_id
        if not verify_device_signature(body.pubkey, body.signature, signed, body.timestamp):
            raise HTTPException(status_code=401, detail="invalid_signature_or_timestamp")
        try:
            groups, presence, presence_tag, device_id = mqtt_scope(body)
        except TokenRequestError as e:
            raise HTTPException(status_code=e.status, detail=e.detail)
        username = mqtt_topic_user(body.pubkey)
        if not (MQTT_CLIENT_ID_RE.fullmatch(body.client_id)
                and body.client_id[len(MQTT_CLIENT_ID_PREFIX):][:16] == username[:16]):
            raise HTTPException(status_code=400, detail="invalid_client_id")
        pubkey_hash = hashlib.sha256(body.pubkey.encode()).hexdigest()
        with db() as conn:
            cursor = conn.cursor()
            account = account_source(cursor, pubkey_hash)
            if require_account and not account:
                raise HTTPException(status_code=403, detail="account_not_registered")
            try:
                kick_device = mqtt_kick_device(cursor, body.pubkey, device_id, account_source)
            except TokenRequestError as e:
                raise HTTPException(status_code=e.status, detail=e.detail)
            consume_request_nonce(cursor, pubkey_hash, "mqtt_token", body.request_id)
            # 每個帳號 24 小時的上限（沒 commit 就離開 with ＝ 整筆不算，request_id 也沒用掉）。只算有帳號的：
            #   沒有帳號的金鑰（只有官方站發得出去）每次都能換一把新的，按金鑰記只會把資料庫灌大（第 3 步審查 HIGH）—— 它們只受每 IP 的 token 限速
            if account:
                if not admit_topics(cursor, account, [f"g|{g}" for g in groups] + [f"p|{t}" for t in presence], now, topics_per_day):
                    raise HTTPException(status_code=429, detail="mqtt_topic_quota")
                if presence_tag and not admit_topics(cursor, "tag:" + account, [presence_tag], now, MQTT_TAGS_PER_DAY):
                    # 超過 tag 上限：照發 token，只是這張沒有 presence 的發布權（好友暫時看不到我在線）——
                    #   整張拒絕的話，一天刪／封鎖超過 20 個好友的人會一整天連不上（第 3 步複審 LOW）
                    presence_tag = None
                if not admit_topics(cursor, "cid:" + account, [body.client_id], now, MQTT_CLIENT_IDS_PER_DAY):
                    raise HTTPException(status_code=429, detail="mqtt_client_id_quota")
            conn.commit()

        exp = now + MQTT_TOKEN_EXPIRY_SECONDS
        acl = mqtt_acl(username, groups=groups, presence=presence, presence_tag=presence_tag, device_id=kick_device)
        payload = {
            "sub": username,
            "username": username,
            "clientid": body.client_id,
            "exp": exp,
            "iat": now,
            "iss": MQTT_ISSUER,
            "acl": mqtt_acl_claim(acl, presence_retain_topics(username, presence_tag), acl_format),
        }
        token = sign_mqtt_token(cfg.mqtt_jwt_secret, payload)
        return MqttTokenResponse(token=token, expiresAt=exp, username=username, subscribe=acl["sub"], serverTime=now)

    @router.post("/api/mqtt/transfer-token", response_model=MqttTokenResponse)
    def get_mqtt_transfer_token(req: Request):
        """
        換機：新裝置（B 機）還沒有帳戶金鑰 → 發一張 5 分鐘、只能訂閱自己隨機收件箱的 token（不能發布、沒有 presence）。
        以前 B 機拿自己編的 tempId 當公鑰去連（換到的 token 也沒有 ACL）。
        clientId 由伺服器指定（＝這個隨機 username）：這支不用登入就拿得到，不能讓拿的人自己選，
        否則拿一張就能去接手任何人的持久 session。
        """
        if not proxy_guard.internal_ok(req):
            raise HTTPException(status_code=403, detail="Unauthorized")
        now_f = time.time()
        if not mem_rate_hit(transfer_rate, rate_key(proxy_guard.client_ip(req)), 3600, 20, now_f):
            raise HTTPException(status_code=429, detail="transfer_token_rate_limited")
        now = int(now_f)
        exp = now + MQTT_TRANSFER_TOKEN_SECONDS
        username = "transfer_" + secrets.token_urlsafe(24)
        acl = mqtt_acl(username, receive_only=True)
        payload = {
            "sub": username,
            "username": username,
            "clientid": username,
            "exp": exp,
            "iat": now,
            "iss": MQTT_ISSUER,
            "acl": mqtt_acl_claim(acl, fmt=acl_format),
        }
        token = sign_mqtt_token(cfg.mqtt_jwt_secret, payload)
        return MqttTokenResponse(token=token, expiresAt=exp, username=username, subscribe=acl["sub"], serverTime=now)

    # /api/mqtt/auth（EMQX HTTP 認證 webhook）已移除：它對任何有效 JWT 都回 allow、不帶 ACL、不核對 username／clientId，
    # broker 若改走它，每張 token 的範圍就放寬成「所有主題」。broker 只用 JWT authenticator（設定見 docs/MQTT_BROKER.md）。

    return router

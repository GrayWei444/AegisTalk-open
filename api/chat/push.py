"""
推播：FCM（選用）與 Web Push（VAPID，選用；開源計畫決定 4）。

- 註冊與推播都要帳戶 Ed25519 簽章（A5，移植群星），request_id 只能用一次；時鐘差 → 401 {code: clock_skew, server_time}
  （signing.check_clock，跟 /api/mqtt/token 同一個形狀：client 校正後重簽）。
    POST /api/push/register-token         FCM token（只有開 FCM 才掛）
    POST /api/push/webpush/register       瀏覽器的 Web Push 訂閱（只有設了 VAPID 才掛）：取代以前明文的 PUSH_SUBSCRIPTION_UPDATE
    POST /api/push/webpush/unregister       與沒有驗證的 mist relay —— 訂閱只掛在簽章者自己的公鑰下
    POST /api/push/notify                 兩種有任何一種就掛：送到收件人登記的每一個 FCM token 與 Web Push 訂閱
- 推播內容只由伺服器組（push_fcm_data），不帶任何寄件者自填的文字；顯示的名字由收件端用已驗簽的寄件者公鑰查本機聯絡人。
- 來電另外帶**來電者簽的響鈴 token**（ringToken；開源第 5d 步，packages/pwa/src/services/ringToken.ts、原生 RingToken.kt）：
  收件端只在 token 驗過時全螢幕響鈴、顯示名字 —— 伺服器（營運方）說的 senderPubkey 不夠。伺服器原樣帶過去，先驗一次
  （ring_token_ok：寄件者自己簽的、寄給這個收件人、±300 秒、只有一種寫法），別人不能藉推播塞任意內容；token 裡沒有名字。
  Web Push 的內容另外用訂閱的金鑰加密（aes128gcm），推播服務看不到。
- 型別：chat 伺服器只收 message、incoming_call（決定 2：守護／報平安不在 v1）；官方站另外收 guardian_alert、check_in。
- Web Push 只送到推播服務的網址（ChatConfig.webpush_hosts，https、後綴比對）：不能讓任何人登記一個指向內網的網址，伺服器就去
  POST 它（SSRF）；也不跟隨重新導向。推播服務回 404／410 的訂閱刪掉。
- 限速：同一寄件帳戶 → 同一收件人 → 同一型別一格冷卻（SQLite push_rate_limit），另有寄件帳戶每分鐘額度（記憶體）。
- firebase_admin、pywebpush 都只在開了那一種推播時才 import（沒開就不必裝）。
- 端點是一般函式（FastAPI 放進 threadpool）：SQLite、FCM／Web Push 的對外連線不卡 event loop。
"""
import base64
import hashlib
import json
import re
import time
from typing import Callable, Optional, Sequence

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .config import ALL_PUSH_TYPES, CHAT_PUSH_TYPES, DEFAULT_WEBPUSH_HOSTS
from .ratelimit import mem_rate_hit, mem_rate_peek, rate_key
from .signing import check_clock, consume_request_nonce, is_pubkey_b64, make_signed_account

#: 同一個寄件帳戶每分鐘最多推幾則「會跳出來的」推播（以前按 IP 算 —— 推播沒有身分驗證時只能這樣）。
#: 報平安一次對群組每位成員各推一則（群組上限 50 人 → 49 則），自己一個額度，不能把守護警報擠掉。
PUSH_ALERT_SENDER_LIMIT = 60
PUSH_CHECKIN_SENDER_LIMIT = 300
#: 同一寄件帳戶 → 同一收件人 → 同一型別的冷卻秒數（對應群星：來電 10 秒，其他 30 秒）
PUSH_CALL_COOLDOWN = 10
PUSH_COOLDOWN = 30
#: 推播在推播服務排隊最多幾秒（FCM 的 ttl、Web Push 的 TTL）
PUSH_TTL = 300
#: 一把帳戶金鑰最多幾個 Web Push 訂閱（多的刪最舊的）；註冊每 IP 每分鐘
WEBPUSH_MAX_PER_KEY = 5
REGISTER_IP_LIMIT = 30

#: 響鈴 token（開源第 5d 步）：外形、claims 的唯一寫法（跟 ringToken.ts 的 CLAIMS_RE、RingToken.kt 一樣）、時間窗（毫秒）
RING_TOKEN_RE = re.compile(r"r1\.([A-Za-z0-9_-]{40,800})\.([A-Za-z0-9_-]{86})")
RING_CLAIMS_RE = re.compile(
    r'\{"v":1,"d":"([a-z0-9][a-z0-9-]{2,39})","callId":"([A-Za-z0-9_-]{22})",'
    r'"from":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)","to":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)",'
    r'"iat":([1-9][0-9]{0,15}),"nonce":"([A-Za-z0-9_-]{22})","video":(true|false)\}')
RING_TOKEN_MAX_SKEW_MS = 300_000
_MAX_SAFE_INTEGER = 2 ** 53 - 1

#: iOS 通用文案（不洩露發送者/內容，符合 ADR-016 零內容）。
#: iOS data-only push 不會喚醒被殺死的 App → 必須帶 alert 才能在被殺死時跳通知 + 點擊開 App。
IOS_TITLES = {
    "message": "新訊息",
    "incoming_call": "來電",
    "guardian_alert": "守護警報",
    "check_in": "報平安提醒",
}


def create_tables(cursor) -> None:
    """FCM token、Web Push 訂閱、推播限速"""
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fcm_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pubkey_hash TEXT NOT NULL,
            fcm_token TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'android',
            updated_at INTEGER NOT NULL,
            UNIQUE(pubkey_hash, fcm_token)
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fcm_tokens_pubkey ON fcm_tokens(pubkey_hash)")
    # 推播限速（A5，移植群星）：已驗簽的寄件帳戶 → 收件人 → 型別，各自一個冷卻時間（來電 10 秒、其他 30 秒）。
    # 以前是記憶體裡「每個收件人 30 秒」：任何人先推一則就能讓真正的好友那 30 秒推不進來。
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS push_rate_limit (
            sender_account TEXT NOT NULL,
            recipient_hash TEXT NOT NULL,
            hint_type TEXT NOT NULL,
            last_sent_at INTEGER NOT NULL,
            PRIMARY KEY (sender_account, recipient_hash, hint_type)
        )
    """)
    # Web Push（決定 4）：一個訂閱網址只屬於一把帳戶金鑰（同一個瀏覽器換帳號 → 移到新的那把）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS webpush_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pubkey_hash TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_webpush_pubkey ON webpush_subscriptions(pubkey_hash)")


def init_firebase(credentials_path: str) -> None:
    """初始化 Firebase Admin SDK。檔案在設定檢查時已確認讀得到；這裡失敗（不是有效的 service account）就讓啟動失敗。"""
    import firebase_admin
    from firebase_admin import credentials as firebase_credentials
    if not firebase_admin._apps:
        firebase_admin.initialize_app(firebase_credentials.Certificate(credentials_path))


class PushRegisterRequest(BaseModel):
    """
    註冊 FCM token（A5，移植群星）：帳戶 Ed25519 簽章，簽章內容＝signature 以外的欄位，action 固定 "push_register"。
    pubkey_hash 由伺服器從已驗簽的公鑰算（以前收 client 自己給的 pubkeyHash —— 任何人都能把自己的手機掛到別人名下，
    收別人的來電／守護推播）。
    """
    pubkey: str = Field(..., min_length=40, max_length=128)
    token: str = Field(..., min_length=10, max_length=4096)
    # 只有原生 App 會註冊（capacitor.registerFcmToken 只在 android／ios 跑）
    platform: str = Field(default="android", pattern=r"^(android|ios)$")
    timestamp: int
    request_id: str = Field(..., min_length=16, max_length=128)
    signature: str = Field(..., min_length=80, max_length=128)


class WebPushRegisterRequest(BaseModel):
    """
    登記瀏覽器的 Web Push 訂閱（PushSubscription.toJSON() 的 endpoint 與 keys.p256dh／keys.auth，攤平）。
    簽章內容＝{"action": "webpush_register", pubkey, endpoint, p256dh, auth, timestamp, request_id}（排序 JSON）。
    """
    model_config = ConfigDict(extra="forbid")
    pubkey: str = Field(..., min_length=40, max_length=128)
    endpoint: str = Field(..., min_length=10, max_length=1024)
    p256dh: str = Field(..., min_length=80, max_length=100)
    auth: str = Field(..., min_length=16, max_length=32)
    timestamp: int
    request_id: str = Field(..., min_length=16, max_length=128)
    signature: str = Field(..., min_length=80, max_length=128)
    action: Optional[str] = Field(None, max_length=32)


class WebPushUnregisterRequest(BaseModel):
    """拿掉一個訂閱：簽章內容＝{"action": "webpush_unregister", pubkey, endpoint, timestamp, request_id}"""
    model_config = ConfigDict(extra="forbid")
    pubkey: str = Field(..., min_length=40, max_length=128)
    endpoint: str = Field(..., min_length=10, max_length=1024)
    timestamp: int
    request_id: str = Field(..., min_length=16, max_length=128)
    signature: str = Field(..., min_length=80, max_length=128)
    action: Optional[str] = Field(None, max_length=32)


class PushNotificationHint(BaseModel):
    """
    寄件者能決定的只有「哪一種推播」、「是不是視訊」與（來電的）響鈴 token。名字、警報類型這類文字**一律不收**
    （多送任何欄位 → 422）：以前 senderName／protectedName／alertType 原樣轉給 FCM → 任何人都能讓別人的手機鎖屏全螢幕跳
    「〈媽媽〉來電」、「〈媽媽〉偵測到詐騙」。顯示的名字由收件端查本機聯絡人；全螢幕來電只看來電者簽的 ringToken（第 5d 步）。
    guardian_alert／check_in 是官方站的守護功能（群星已下架、chat 伺服器不收），一樣不帶任何文字。
    """
    model_config = ConfigDict(extra="forbid")
    type: str = Field(..., pattern=r"^(message|incoming_call|guardian_alert|check_in)$")
    isVideoCall: Optional[bool] = None
    ringToken: Optional[str] = Field(None, min_length=100, max_length=1024)


class PushNotifyRequest(BaseModel):
    """推播請求（A5，移植群星）：寄件者帳戶簽章，簽章內容＝signature 以外的欄位，action 固定 "push_notify"。"""
    pubkey: str = Field(..., min_length=40, max_length=128)
    recipient_pubkey: str = Field(..., min_length=40, max_length=128)
    notificationHint: PushNotificationHint
    timestamp: int
    request_id: str = Field(..., min_length=16, max_length=128)
    signature: str = Field(..., min_length=80, max_length=128)


def _b64url_canonical(value: str) -> Optional[bytes]:
    """base64url（不補 =）→ bytes；不是正規寫法（多餘的位元、長度）→ None（跟 ringToken.ts 的 b64Decode 一樣）"""
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        return None
    return raw if base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") == value else None


def ring_token_ok(token: str, sender: str, recipient: str, now_s: float) -> bool:
    """
    來電者簽的響鈴 token（開源第 5d 步）：外形對、claims 只有一種寫法、from ＝ 推播請求的簽章者、to ＝ 收件人、
    iat 在伺服器時鐘 ±300 秒內、簽章是 from 的（簽章內容 ＝ "前綴:" ‖ claims 的原始位元組）。
    收件端還會再驗（好友、我是收件人、這一通沒響過）—— 伺服器這一關只是不讓人藉推播塞任意內容。
    """
    m = RING_TOKEN_RE.fullmatch(token) if isinstance(token, str) and len(token) <= 1024 else None
    if not m:
        return False
    claims, sig = _b64url_canonical(m.group(1)), _b64url_canonical(m.group(2))
    if claims is None or sig is None or len(sig) != 64:
        return False
    try:
        text = claims.decode("ascii")
    except UnicodeDecodeError:
        return False
    c = RING_CLAIMS_RE.fullmatch(text)
    if not c:
        return False
    prefix, _call_id, frm, to, iat, _nonce, _video = c.groups()
    if frm != sender or to != recipient or int(iat) > _MAX_SAFE_INTEGER:
        return False
    if abs(now_s * 1000 - int(iat)) > RING_TOKEN_MAX_SKEW_MS:
        return False
    try:
        # claims 的 from 的金鑰（上面已經要求它等於請求的簽章者）
        Ed25519PublicKey.from_public_bytes(base64.b64decode(frm, validate=True)).verify(sig, (prefix + ":").encode("ascii") + claims)
    except (InvalidSignature, ValueError):
        return False
    return True


def push_fcm_data(hint_type: str, is_video: Optional[bool], sender_pubkey: str, ring_token: Optional[str] = None) -> dict:
    """
    推播內容**只由伺服器組**（A5）：不轉發任何寄件者自填的文字（FCM 的 data、Web Push 加密前的 JSON 都是這個）。
      message                → 零內容（ADR-016）
      incoming_call          → 是不是視訊＋**已驗簽的**寄件者公鑰；來電者名字由收件端用公鑰查本機聯絡人，
                               不是好友／已封鎖就不響（AegisFCMService.lookupSender）
      guardian_alert／check_in → 已驗簽的寄件者公鑰；陌生人送的不顯示
    isVideoCall 用小寫 "true"/"false"：Android 端比的是 == "true"（以前 str(True) 送 "True" → 視訊永遠顯示成語音）
    """
    if hint_type == "message":
        return {"type": "message", "action": "wake_and_sync"}
    data = {"type": hint_type, "action": "wake_and_sync", "senderPubkey": sender_pubkey}
    if hint_type == "incoming_call":
        data["isVideoCall"] = "true" if is_video else "false"
        if ring_token:
            data["ringToken"] = ring_token
    return data


def _b64url_bytes(value: str) -> Optional[bytes]:
    if not isinstance(value, str) or not all(c.isalnum() or c in "-_=" for c in value):
        return None
    try:
        return base64.urlsafe_b64decode(value.rstrip("=") + "=" * (-len(value.rstrip("=")) % 4))
    except ValueError:
        return None


_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
_URL_SAFE = re.compile(r"^[A-Za-z0-9\-._~:/?\[\]@!$&'()*+,;=%]+$")


def webpush_endpoint_ok(endpoint: str, hosts: Sequence[str]) -> bool:
    """
    推播服務的網址才收（SSRF；第 3 步審查 HIGH：以前用 urlsplit 取主機，`https://169.254.169.254\\.fcm.googleapis.com/…` 會被當成
    fcm.googleapis.com 的子網域，真的送出去時 urllib3 卻把 \\ 當成主機的結尾、連到 169.254.169.254）。現在：
      - 只收 https://<主機>[:443]/…：主機自己切出來（到第一個 / ? # 為止），只能是小寫字母、數字、-、.（至少兩節），沒有 @ \\ % 帳密 port
      - 整個網址只能是 URL 合法字元（沒有 \\、空白、控制字元、非 ASCII），沒有 #
      - urllib3（真的送出去的那個）解析出來的主機要一模一樣，而且是 hosts 裡的某一個或它的子網域
    """
    if not isinstance(endpoint, str) or len(endpoint) > 1024 or not endpoint.startswith("https://"):
        return False
    if not _URL_SAFE.fullmatch(endpoint) or "#" in endpoint:
        return False
    rest = endpoint[len("https://"):]
    cut = min([i for i in (rest.find("/"), rest.find("?")) if i >= 0] or [len(rest)])
    authority, tail = rest[:cut], rest[cut:]
    host = authority[:-4] if authority.endswith(":443") else authority
    if not _HOST_RE.fullmatch(host) or (tail and not tail.startswith(("/", "?"))):
        return False
    try:
        from urllib3.util import parse_url
        parsed = parse_url(endpoint)
    except Exception:
        return False
    if parsed.scheme != "https" or parsed.host != host or parsed.auth or parsed.port not in (None, 443):
        return False
    return any(host == h or host.endswith("." + h) for h in hosts)


def webpush_keys_ok(p256dh: str, auth: str) -> bool:
    """p256dh：未壓縮的 P-256 點（65 bytes，真的在曲線上）；auth：16 bytes"""
    from cryptography.hazmat.primitives.asymmetric import ec
    point, secret = _b64url_bytes(p256dh), _b64url_bytes(auth)
    if point is None or secret is None or len(point) != 65 or point[0] != 4 or len(secret) != 16:
        return False
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
        return True
    except ValueError:
        return False


class WebPushSender:
    """
    用 VAPID 私鑰（base64url 32 bytes）送 Web Push。send(...) → "sent"／"gone"（推播服務說訂閱不在了：404／410；或不是用這把
    VAPID 金鑰訂的：401／403 —— 舊版用別的金鑰訂的訂閱永遠送不到，刪掉，App 下次開啟會重新訂閱並登記，開源第 4 步審查 M3）／"failed"。
    allowed_hosts：送出前再檢查一次網址（登記時檢查過，這裡是第二道：資料庫裡的舊資料、檢查規則改過）；None ＝ 不檢查（只給測試用）。
    transport：測試用，取代 pywebpush.webpush（同樣的參數）。
    """

    def __init__(self, private_key: str, subject: str, *, allowed_hosts: Optional[Sequence[str]] = DEFAULT_WEBPUSH_HOSTS,
                 transport: Optional[Callable] = None, timeout: float = 5.0):
        from py_vapid import Vapid02   # pywebpush 的相依套件
        from pywebpush import WebPushException, webpush
        self._vapid = Vapid02.from_raw(private_key.encode())
        self._subject = subject
        self._hosts = tuple(allowed_hosts) if allowed_hosts is not None else None
        self._webpush = transport or webpush
        self._error = WebPushException
        self._timeout = timeout

    def send(self, endpoint: str, p256dh: str, auth: str, data: dict) -> str:
        if self._hosts is not None and not webpush_endpoint_ok(endpoint, self._hosts):
            return "failed"
        import requests
        session = requests.Session()
        session.max_redirects = 0     # 推播服務不會重新導向；導向別處（內網）一律不跟
        try:
            self._webpush({"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                          data=json.dumps(data, separators=(",", ":")), vapid_private_key=self._vapid,
                          vapid_claims={"sub": self._subject}, ttl=PUSH_TTL, timeout=self._timeout,
                          headers={"Urgency": "high"}, requests_session=session)
            return "sent"
        except self._error as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            return "gone" if status in (401, 403, 404, 410) else "failed"
        except Exception:
            return "failed"
        finally:
            session.close()


def create_push_router(db: Callable, account_source: Callable, proxy_guard, *,
                       hint_types: Sequence[str] = CHAT_PUSH_TYPES, fcm: bool = True,
                       webpush: Optional[WebPushSender] = None,
                       webpush_hosts: Sequence[str] = DEFAULT_WEBPUSH_HOSTS) -> APIRouter:
    """
    推播端點（proxy_guard: config.ProxyGuard，註冊的每 IP 限速用）。
      hint_types   收哪些推播型別（chat 伺服器 message／incoming_call；官方站四種）
      fcm          掛 FCM（firebase_admin 在這裡 import：缺套件就在啟動時失敗）
      webpush      WebPushSender（None ＝ 不開 Web Push）；webpush_hosts：可以登記的推播服務
    """
    unknown = set(hint_types) - set(ALL_PUSH_TYPES)
    if unknown or not hint_types:
        raise ValueError(f"unknown push types {sorted(unknown)}")
    if not fcm and webpush is None:
        raise ValueError("create_push_router needs FCM or Web Push")
    firebase_messaging = None
    if fcm:
        from firebase_admin import messaging as firebase_messaging

    router = APIRouter()
    signed_account = make_signed_account(db, account_source)
    allowed_types = frozenset(hint_types)
    register_rate: dict = {}      # ip -> [epoch,...]（App 每次開啟註冊一次）
    webpush_rate: dict = {}       # ip -> [epoch,...]
    call_sender_rate: dict = {}   # 寄件帳戶 -> [epoch,...]（來電／守護警報）
    checkin_sender_rate: dict = {}  # 寄件帳戶 -> [epoch,...]（報平安，獨立額度）

    def push_sender_cap(hint_type: str):
        """每分鐘額度（記憶體滑動窗）。message 是零內容喚醒，只有上面的配對冷卻。"""
        if hint_type == "check_in":
            return checkin_sender_rate, PUSH_CHECKIN_SENDER_LIMIT
        if hint_type in ("incoming_call", "guardian_alert"):
            return call_sender_rate, PUSH_ALERT_SENDER_LIMIT
        return None

    if fcm:
        @router.post("/api/push/register-token")
        def register_push_token(request: PushRegisterRequest, req: Request):
            """
            註冊 FCM token（帳戶簽章）。每個帳戶公鑰可以有多個 token（多裝置）；一個 token 只屬於一個公鑰。
            每 IP 每分鐘 30 次；request_id 只能用一次；時鐘差 → 401 clock_skew。
            """
            if not mem_rate_hit(register_rate, rate_key(proxy_guard.client_ip(req)), 60, REGISTER_IP_LIMIT, time.time()):
                raise HTTPException(status_code=429, detail="rate_limited")
            check_clock(request.timestamp)
            signed = {"action": "push_register", "pubkey": request.pubkey, "token": request.token,
                      "platform": request.platform, "timestamp": request.timestamp, "request_id": request.request_id}
            _, pubkey_hash = signed_account(request.pubkey, request.signature, signed, request.timestamp)
            now = int(time.time())
            with db() as conn:
                cursor = conn.cursor()
                consume_request_nonce(cursor, pubkey_hash, "push_register", request.request_id)
                # 同一支手機換帳號：移除這個 token 綁在其他帳號上的紀錄，舊帳號的推播不再送到這台（對應 AegisPlay A5）
                cursor.execute("DELETE FROM fcm_tokens WHERE fcm_token = ? AND pubkey_hash <> ?",
                               (request.token, pubkey_hash))
                cursor.execute("""
                    INSERT INTO fcm_tokens (pubkey_hash, fcm_token, platform, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(pubkey_hash, fcm_token) DO UPDATE SET
                        platform = excluded.platform,
                        updated_at = excluded.updated_at
                """, (pubkey_hash, request.token, request.platform, now))
                conn.commit()

            return {"success": True}

    if webpush is not None:
        @router.post("/api/push/webpush/register")
        def register_webpush(request: WebPushRegisterRequest, req: Request):
            """
            登記 Web Push 訂閱（帳戶簽章、有帳號、request_id 一次性、時鐘差 → 401 clock_skew）。
            網址只收推播服務（400 invalid_endpoint）、金鑰要是真的 P-256 點與 16 bytes（400 invalid_keys）。
            同一個網址只屬於最後簽章的那把金鑰；一把金鑰最多 WEBPUSH_MAX_PER_KEY 個（多的刪最舊的）。
            """
            if not mem_rate_hit(webpush_rate, rate_key(proxy_guard.client_ip(req)), 60, REGISTER_IP_LIMIT, time.time()):
                raise HTTPException(status_code=429, detail="rate_limited")
            check_clock(request.timestamp)
            signed = {"action": "webpush_register", "pubkey": request.pubkey, "endpoint": request.endpoint,
                      "p256dh": request.p256dh, "auth": request.auth, "timestamp": request.timestamp,
                      "request_id": request.request_id}
            _, pubkey_hash = signed_account(request.pubkey, request.signature, signed, request.timestamp)
            if not webpush_endpoint_ok(request.endpoint, webpush_hosts):
                raise HTTPException(status_code=400, detail="invalid_endpoint")
            if not webpush_keys_ok(request.p256dh, request.auth):
                raise HTTPException(status_code=400, detail="invalid_keys")
            now = int(time.time())
            with db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                cursor = conn.cursor()
                consume_request_nonce(cursor, pubkey_hash, "webpush_register", request.request_id)
                cursor.execute("""
                    INSERT INTO webpush_subscriptions (pubkey_hash, endpoint, p256dh, auth, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(endpoint) DO UPDATE SET
                        pubkey_hash = excluded.pubkey_hash, p256dh = excluded.p256dh, auth = excluded.auth,
                        updated_at = excluded.updated_at
                """, (pubkey_hash, request.endpoint, request.p256dh, request.auth, now, now))
                cursor.execute("""
                    DELETE FROM webpush_subscriptions WHERE pubkey_hash = ? AND id NOT IN (
                        SELECT id FROM webpush_subscriptions WHERE pubkey_hash = ? ORDER BY updated_at DESC, id DESC LIMIT ?)
                """, (pubkey_hash, pubkey_hash, WEBPUSH_MAX_PER_KEY))
                conn.commit()
            return {"success": True}

        @router.post("/api/push/webpush/unregister")
        def unregister_webpush(request: WebPushUnregisterRequest, req: Request):
            """拿掉自己的一個訂閱（帳戶簽章；別人的訂閱拿不掉）"""
            if not mem_rate_hit(webpush_rate, rate_key(proxy_guard.client_ip(req)), 60, REGISTER_IP_LIMIT, time.time()):
                raise HTTPException(status_code=429, detail="rate_limited")
            check_clock(request.timestamp)
            signed = {"action": "webpush_unregister", "pubkey": request.pubkey, "endpoint": request.endpoint,
                      "timestamp": request.timestamp, "request_id": request.request_id}
            _, pubkey_hash = signed_account(request.pubkey, request.signature, signed, request.timestamp)
            with db() as conn:
                cursor = conn.cursor()
                consume_request_nonce(cursor, pubkey_hash, "webpush_unregister", request.request_id)
                cursor.execute("DELETE FROM webpush_subscriptions WHERE endpoint = ? AND pubkey_hash = ?",
                               (request.endpoint, pubkey_hash))
                removed = cursor.rowcount
                conn.commit()
            return {"success": True, "removed": removed}

    def send_fcm(rows, hint_type: str, hint_data: dict) -> int:
        sent_count = 0
        for row in rows:
            try:
                apns_cfg = None
                if row["platform"] == "ios":
                    apns_cfg = firebase_messaging.APNSConfig(
                        headers={"apns-priority": "10", "apns-push-type": "alert"},
                        payload=firebase_messaging.APNSPayload(
                            aps=firebase_messaging.Aps(
                                alert=firebase_messaging.ApsAlert(
                                    title="AegisTalk",
                                    body=IOS_TITLES.get(hint_type, "AegisTalk"),
                                ),
                                sound="default",
                                content_available=True,  # 背景時可喚醒做 P2P sync
                            )
                        ),
                    )
                message = firebase_messaging.Message(
                    token=row["fcm_token"],
                    data={k: str(v) for k, v in hint_data.items()},
                    android=firebase_messaging.AndroidConfig(
                        priority="high",
                        ttl=PUSH_TTL,  # 5 分鐘
                    ),
                    apns=apns_cfg,
                )
                firebase_messaging.send(message)
                sent_count += 1
            except Exception as e:
                # Token 無效時清除
                if "UNREGISTERED" in str(e) or "INVALID" in str(e):
                    try:
                        with db() as conn2:
                            cursor2 = conn2.cursor()
                            cursor2.execute("DELETE FROM fcm_tokens WHERE fcm_token = ?", (row["fcm_token"],))
                            conn2.commit()
                    except Exception:
                        pass
        return sent_count

    def send_webpush(rows, hint_data: dict) -> int:
        sent_count = 0
        for row in rows:
            result = webpush.send(row["endpoint"], row["p256dh"], row["auth"], hint_data)
            if result == "sent":
                sent_count += 1
            elif result == "gone":
                with db() as conn2:
                    conn2.execute("DELETE FROM webpush_subscriptions WHERE endpoint = ?", (row["endpoint"],))
                    conn2.commit()
        return sent_count

    @router.post("/api/push/notify")
    def push_notify(request: PushNotifyRequest, req: Request):
        """
        發送推播（FCM data message、Web Push）。

        授權（A5，移植群星）：寄件者帳戶簽章（request_id 只能用一次；時鐘差 → 401 clock_skew）、收件人要有帳號。
        型別不在 hint_types → 422 unsupported_push_type。
        限速：同一寄件帳戶 → 同一收件人 → 同一型別，來電 10 秒、其他 30 秒（push_rate_limit 表）；
        另外同一寄件帳戶每分鐘最多 60 則來電／守護警報、300 則報平安（先看額度，確定要送才記）。
        推播內容只由伺服器組（push_fcm_data），不帶任何寄件者自填的文字。
        """
        hint = request.notificationHint
        hint_type = hint.type
        if hint_type not in allowed_types:
            raise HTTPException(status_code=422, detail="unsupported_push_type")
        if hint.ringToken is not None and hint_type != "incoming_call":
            raise HTTPException(status_code=422, detail="ring_token_not_allowed")
        check_clock(request.timestamp)
        signed = {"action": "push_notify", "pubkey": request.pubkey, "recipient_pubkey": request.recipient_pubkey,
                  "notificationHint": hint.model_dump(exclude_none=True), "timestamp": request.timestamp,
                  "request_id": request.request_id}
        sender_account, sender_hash = signed_account(request.pubkey, request.signature, signed, request.timestamp)
        if not is_pubkey_b64(request.recipient_pubkey):
            raise HTTPException(status_code=400, detail="invalid_recipient")
        # 響鈴 token 要是這位寄件者簽給這位收件人的（開源第 5d 步）；在佔用冷卻與 request_id 之前擋
        if hint.ringToken is not None and not ring_token_ok(hint.ringToken, request.pubkey, request.recipient_pubkey, time.time()):
            raise HTTPException(status_code=422, detail="invalid_ring_token")
        recipient_hash = hashlib.sha256(request.recipient_pubkey.encode()).hexdigest()

        with db() as conn:
            cursor = conn.cursor()
            if not account_source(cursor, recipient_hash):
                return {"success": False, "reason": "recipient_not_registered"}
            tokens = cursor.execute("""
                SELECT fcm_token, platform FROM fcm_tokens
                WHERE pubkey_hash = ?
                ORDER BY updated_at DESC
            """, (recipient_hash,)).fetchall() if fcm else []
            subscriptions = cursor.execute(
                "SELECT endpoint, p256dh, auth FROM webpush_subscriptions WHERE pubkey_hash = ? ORDER BY updated_at DESC",
                (recipient_hash,)).fetchall() if webpush is not None else []

        if not tokens and not subscriptions:
            return {"success": False, "reason": "no_token"}

        now_f = time.time()
        now = int(now_f)
        cap = push_sender_cap(hint_type)
        # 先看每分鐘額度、再佔「寄件者 → 收件人」那一格（部署前審查 MEDIUM-3：反過來的話，被額度擋下的來電照樣
        #   佔掉那 10 秒，額度一回來還是打不通）
        if cap and not mem_rate_peek(cap[0], sender_account, 60, cap[1], now_f):
            return {"success": False, "reason": "rate_limited"}
        cooldown = PUSH_CALL_COOLDOWN if hint_type == "incoming_call" else PUSH_COOLDOWN
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.cursor()
            consume_request_nonce(cursor, sender_hash, "push_notify", request.request_id)
            row = cursor.execute(
                "SELECT last_sent_at FROM push_rate_limit"
                " WHERE sender_account=? AND recipient_hash=? AND hint_type=?",
                (sender_account, recipient_hash, hint_type),
            ).fetchone()
            if row and now - row["last_sent_at"] < cooldown:
                conn.commit()   # request_id 照樣用掉
                return {"success": False, "reason": "rate_limited"}
            cursor.execute(
                "INSERT INTO push_rate_limit VALUES (?,?,?,?)"
                " ON CONFLICT(sender_account,recipient_hash,hint_type)"
                " DO UPDATE SET last_sent_at=excluded.last_sent_at",
                (sender_account, recipient_hash, hint_type, now),
            )
            conn.commit()
        if cap:
            mem_rate_hit(cap[0], sender_account, 60, cap[1], now_f)

        hint_data = push_fcm_data(hint_type, hint.isVideoCall, request.pubkey, hint.ringToken)
        sent_count = send_fcm(tokens, hint_type, hint_data) + (send_webpush(subscriptions, hint_data) if subscriptions else 0)
        return {"success": sent_count > 0, "sent": sent_count}

    return router

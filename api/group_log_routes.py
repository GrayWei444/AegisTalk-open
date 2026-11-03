"""
群組 log（MLS delivery-service 式，決定 2026-10-22；同日審查修正 H2／M5／L2／L3）：伺服器只排序、不看內容。

  POST /api/group-log/{gid}  body {blob, pubkey, timestamp, request_id, signature}   → {"seq": n}
  GET  /api/group-log/{gid}?after=&limit=                                          → {"entries": [{"seq", "blob"}], "head", "more"}

- 每個群一條 append-only log，先到先排（同一個 gid 的 seq 從 1 起連號，不會重複、不會跳號）。
- blob 對伺服器不透明：客戶端用該群上一代金鑰加密的 commit（明文只有 kid，見 PWA services/groupLogEntry.ts）；伺服器不解析。
- append 要帳號簽章（同 /api/mqtt/token 的做法，審查 H2／M5）：簽 {"action": "group_log_append", "pubkey", "gid",
  "blob_sha256", "timestamp", "request_id"}（排序 JSON；blob_sha256 ＝ blob 的 UTF-8 bytes 的 SHA-256 hex，由伺服器自己算），
  ±300 秒內有效、request_id 只能用一次（成功的才算用掉；重送 → 409）、公鑰要對到已註冊的帳號（403）。
  **伺服器因此知道哪個帳號往哪個 gid 寫了哪一筆**：只為了算額度，用量表最多留 2 天；log 本身不記帳號。
- 額度照帳號算、不照 IP；被擋的請求不吃額度（審查 M5）：
    每個帳號        每分鐘 APPEND_PER_ACCOUNT_PER_MIN 筆、每天（UTC）BYTES_PER_ACCOUNT_PER_DAY bytes
    每個 (帳號, gid)  每分鐘 APPEND_PER_ACCOUNT_GID_PER_MIN 筆、每天 BYTES_PER_ACCOUNT_GID_PER_DAY bytes
  一個帳號吃不到別人的額度（以前每個群一桶、大家共用，一個 IP 就能把正常的 commit 擠掉）。計數存在 SQLite（不是記憶體表），
  灌很多 key 也擠不掉別人的計數。另有每 IP 每分鐘的粗略上限，只為了擋驗簽的 CPU，放得很寬。
- 大小一律用 bytes（UTF-8）算：blob ≤ MAX_BLOB_BYTES（審查 H2：以前算字元，65,536 個 emoji ＝ 256 KiB）。
- 存在自己的 SQLite 檔（不是主資料庫 aegis.db）。全域總量（blob bytes ＋每筆估計的額外空間）到 NEW_GID_MAX_BYTES 先拒收新的 gid
  （已經有的群照常寫），到 GLOBAL_MAX_BYTES 才全部拒收（507）。沒有每群筆數上限：不會有「某個群永遠寫不進去」。
  TODO：admin 簽的檢查點＋log 壓縮（保留期限），在那之前全域上限要人工處理。
- GET 不需要簽章（審查 L2，刻意）：知道 gid 的人（例如被踢的人）看得到每筆的 seq、大小、時間與明文 kid
  （所以知道何時換金鑰；封裝包的大小約略透露那時的人數），看不到內容。一頁最多 MAX_FETCH 筆、MAX_FETCH_BYTES bytes；
  after 要在 0..2^53−1（審查 L3：以前太大的數字讓 SQLite 丟 OverflowError → 500）。
- 純函式（建表、寫入、讀取、限流）不 import FastAPI，方便測試；路由由 create_group_log_router 掛到 main.py（官方站）與
  chat_app.py（獨立的 chat 伺服器）；兩邊的帳號都來自 pubkey_account_map（AegisID／keys-only 註冊）。
"""
import hashlib
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Callable, Dict, Iterator, List, Optional, Tuple

GID_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
#: 一筆 blob 的上限（UTF-8 bytes；＝ PWA groupLogEntry.MAX_ENTRY_BYTES）
MAX_BLOB_BYTES = 64 * 1024
#: GET 一頁最多幾筆、幾 bytes（至少回一筆，一筆最多 MAX_BLOB_BYTES）
MAX_FETCH = 200
MAX_FETCH_BYTES = 512 * 1024
#: after 的上限（＝ JS Number.MAX_SAFE_INTEGER）
MAX_SEQ = 2 ** 53 - 1
#: 每個帳號
APPEND_PER_ACCOUNT_PER_MIN = 60
BYTES_PER_ACCOUNT_PER_DAY = 16 * 1024 * 1024
#: 每個 (帳號, gid)
APPEND_PER_ACCOUNT_GID_PER_MIN = 30
BYTES_PER_ACCOUNT_GID_PER_DAY = 4 * 1024 * 1024
#: 全域總量：到 NEW_GID_MAX_BYTES 拒收新的 gid，到 GLOBAL_MAX_BYTES 全部拒收
GLOBAL_MAX_BYTES = 2 * 1024 ** 3
NEW_GID_MAX_BYTES = GLOBAL_MAX_BYTES * 3 // 4
#: 每筆除了 blob 之外估計佔的空間（seq、索引、時間）
ROW_OVERHEAD_BYTES = 64
#: 每 IP 每分鐘（只擋驗簽與查詢的 CPU；公平性靠上面的帳號額度）
REQUESTS_PER_IP_PER_MIN = 600
FETCH_PER_IP_PER_MIN = 120
_RATE_MAX_KEYS = 10_000
#: 路由是一般函式（threadpool）：同一張限流表的「看 → 記一筆」不讓兩個 thread 交錯
_RATE_LOCK = threading.Lock()
#: 簽章 ±300 秒有效，request_id 只要記得比那久
NONCE_TTL = 2 * 300 + 60
#: 用量表（帳號 → gid 的對應）最多留幾天
USAGE_KEEP_DAYS = 2


class GroupLogError(ValueError):
    """請求不合格或超過額度：code 給客戶端看、status 是 HTTP 狀態碼"""

    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def create_group_log_tables(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS group_log (
            gid TEXT NOT NULL, seq INTEGER NOT NULL, blob TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY (gid, seq))"""
    )
    # 每分鐘的筆數：最近 60 秒的事件（scope ＝ "a|帳號" 或 "g|帳號|gid"）
    conn.execute("CREATE TABLE IF NOT EXISTS group_log_recent (scope TEXT NOT NULL, created_at REAL NOT NULL)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_group_log_recent_scope ON group_log_recent(scope, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_group_log_recent_time ON group_log_recent(created_at)")
    # 每天的 bytes（UTC 日）
    conn.execute(
        """CREATE TABLE IF NOT EXISTS group_log_daily (
            scope TEXT NOT NULL, day INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (scope, day))"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS group_log_nonces (
            account TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account, nonce))"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_group_log_nonces_time ON group_log_nonces(created_at)")
    conn.execute("CREATE TABLE IF NOT EXISTS group_log_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
    conn.execute("INSERT OR IGNORE INTO group_log_meta (k, v) VALUES ('total_bytes', 0)")


def connect_group_log_db(path: str) -> sqlite3.Connection:
    """自己的 SQLite 檔；交易自己管（BEGIN IMMEDIATE）"""
    return sqlite3.connect(path, isolation_level=None, timeout=30)


def init_group_log_db(path: str) -> None:
    """啟動時建檔、建表（main.py startup 呼叫）"""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = connect_group_log_db(path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        create_group_log_tables(conn)
    finally:
        conn.close()


@contextmanager
def open_group_log_db(path: str) -> Iterator[sqlite3.Connection]:
    conn = connect_group_log_db(path)
    try:
        yield conn
    finally:
        conn.close()


def _check_gid(gid: object) -> str:
    if not isinstance(gid, str) or not GID_RE.match(gid):
        raise GroupLogError("bad_gid")
    return gid


def blob_bytes(blob: object) -> bytes:
    """blob 的 UTF-8 bytes；不是字串、空的、超過 MAX_BLOB_BYTES（照 bytes 算）→ bad_blob"""
    if not isinstance(blob, str):
        raise GroupLogError("bad_blob")
    try:
        raw = blob.encode("utf-8")
    except UnicodeEncodeError:
        raise GroupLogError("bad_blob")
    if not 1 <= len(raw) <= MAX_BLOB_BYTES:
        raise GroupLogError("bad_blob")
    return raw


def append_signed_payload(pubkey: str, gid: str, blob: str, timestamp: int, request_id: str) -> Dict[str, object]:
    """append 要簽的內容（不含 signature；main.py _verify_device_signature 照排序 JSON 驗）"""
    return {"action": "group_log_append", "pubkey": pubkey, "gid": gid,
            "blob_sha256": hashlib.sha256(blob_bytes(blob)).hexdigest(), "timestamp": timestamp, "request_id": request_id}


def _scopes(account: str, gid: str) -> Tuple[str, str]:
    return f"a|{account}", f"g|{account}|{gid}"


def _check_quota(conn: sqlite3.Connection, account: str, gid: str, size: int, now: float) -> None:
    """每個帳號、每個 (帳號, gid) 的每分鐘筆數與每天 bytes（超過 → 429，不記任何東西）"""
    acc, pair = _scopes(account, gid)
    day = int(now // 86400)
    for scope, per_min, per_day, code in ((acc, APPEND_PER_ACCOUNT_PER_MIN, BYTES_PER_ACCOUNT_PER_DAY, "account"),
                                          (pair, APPEND_PER_ACCOUNT_GID_PER_MIN, BYTES_PER_ACCOUNT_GID_PER_DAY, "account_gid")):
        recent = conn.execute("SELECT COUNT(*) FROM group_log_recent WHERE scope = ? AND created_at > ?", (scope, now - 60)).fetchone()[0]
        if recent >= per_min:
            raise GroupLogError(f"{code}_rate_limited", 429)
        used = conn.execute("SELECT bytes FROM group_log_daily WHERE scope = ? AND day = ?", (scope, day)).fetchone()
        if (used[0] if used else 0) + size > per_day:
            raise GroupLogError(f"{code}_daily_bytes", 429)


def _record_usage(conn: sqlite3.Connection, account: str, gid: str, size: int, now: float) -> None:
    day = int(now // 86400)
    for scope in _scopes(account, gid):
        conn.execute("INSERT INTO group_log_recent (scope, created_at) VALUES (?, ?)", (scope, now))
        conn.execute(
            "INSERT INTO group_log_daily (scope, day, bytes) VALUES (?, ?, ?)"
            " ON CONFLICT(scope, day) DO UPDATE SET bytes = bytes + excluded.bytes",
            (scope, day, size),
        )


def _prune(conn: sqlite3.Connection, now: float) -> None:
    conn.execute("DELETE FROM group_log_recent WHERE created_at <= ?", (now - 60,))
    conn.execute("DELETE FROM group_log_daily WHERE day < ?", (int(now // 86400) - USAGE_KEEP_DAYS + 1,))
    conn.execute("DELETE FROM group_log_nonces WHERE created_at < ?", (int(now) - NONCE_TTL,))


def append_entry(conn: sqlite3.Connection, gid: object, blob: object, *, account: str, request_id: str,
                 now: Optional[float] = None) -> int:
    """
    已驗過簽章的帳號寫一筆，回傳 seq。同一個 gid 的 seq 由交易保證連號（BEGIN IMMEDIATE）。
    檢查順序：格式 → request_id 沒用過 → 帳號與 (帳號, gid) 額度 → 全域總量（新的 gid 先擋）；任何一項不過，整筆不寫、不吃額度。
    """
    gid = _check_gid(gid)
    raw = blob_bytes(blob)
    if not isinstance(account, str) or not account or not isinstance(request_id, str) or not request_id:
        raise GroupLogError("bad_request")
    t = float(now if now is not None else time.time())
    size = len(raw) + ROW_OVERHEAD_BYTES
    conn.execute("BEGIN IMMEDIATE")
    try:
        _prune(conn, t)
        if conn.execute("SELECT 1 FROM group_log_nonces WHERE account = ? AND nonce = ?", (account, request_id)).fetchone():
            raise GroupLogError("request_replayed", 409)
        _check_quota(conn, account, gid, len(raw), t)
        head = int(conn.execute("SELECT COALESCE(MAX(seq), 0) FROM group_log WHERE gid = ?", (gid,)).fetchone()[0])
        total = int(conn.execute("SELECT v FROM group_log_meta WHERE k = 'total_bytes'").fetchone()[0])
        if total + size > GLOBAL_MAX_BYTES:
            raise GroupLogError("group_log_storage_full", 507)
        if head == 0 and total + size > NEW_GID_MAX_BYTES:
            raise GroupLogError("group_log_new_groups_paused", 507)
        seq = head + 1
        conn.execute("INSERT INTO group_log (gid, seq, blob, bytes, created_at) VALUES (?, ?, ?, ?, ?)", (gid, seq, blob, len(raw), int(t)))
        conn.execute("UPDATE group_log_meta SET v = v + ? WHERE k = 'total_bytes'", (size,))
        conn.execute("INSERT INTO group_log_nonces (account, nonce, created_at) VALUES (?, ?, ?)", (account, request_id, int(t)))
        _record_usage(conn, account, gid, len(raw), t)
        conn.execute("COMMIT")
        return seq
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def _check_int(value: object, low: int, high: int, code: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise GroupLogError(code)
    return value


def fetch_entries(conn: sqlite3.Connection, gid: object, after: object = 0, limit: object = MAX_FETCH) -> Tuple[List[Dict[str, object]], int, bool]:
    """after 之後的 entries（依 seq），最多 limit 筆、MAX_FETCH_BYTES bytes（至少一筆）；也回 head（最大 seq）與還有沒有沒回的"""
    gid = _check_gid(gid)
    after = _check_int(after, 0, MAX_SEQ, "bad_after")
    limit = _check_int(limit, 1, MAX_FETCH, "bad_limit")
    rows = conn.execute(
        "SELECT seq, blob, bytes FROM group_log WHERE gid = ? AND seq > ? ORDER BY seq LIMIT ?", (gid, after, limit)
    ).fetchall()
    entries: List[Dict[str, object]] = []
    used = 0
    for seq, blob, size in rows:
        if entries and used + size > MAX_FETCH_BYTES:
            break
        entries.append({"seq": int(seq), "blob": blob})
        used += size
    head = int(conn.execute("SELECT COALESCE(MAX(seq), 0) FROM group_log WHERE gid = ?", (gid,)).fetchone()[0])
    last = entries[-1]["seq"] if entries else after
    return entries, head, bool(last < head)


def rate_hit(store: Dict[str, list], key: str, window: float, limit: int, now: float) -> bool:
    """記憶體滑動窗（同 chat/ratelimit.py mem_rate_hit）：True ＝放行並記一筆。表太大先丟過期的，再丟最早的。只用在每 IP 的 CPU 上限。"""
    with _RATE_LOCK:
        hits = [t for t in store.get(key, ()) if now - t < window]
        if len(hits) >= limit:
            store[key] = hits
            return False
        hits.append(now)
        store[key] = hits
        if len(store) > _RATE_MAX_KEYS:
            for stale in [k for k, v in store.items() if not v or now - v[-1] >= window]:
                store.pop(stale, None)
            while len(store) > _RATE_MAX_KEYS:
                store.pop(next(iter(store)))
        return True


class GroupLogIpGuard:
    """每 IP 每分鐘的粗略上限（驗簽、查詢的 CPU）。公平性不靠這個：額度照帳號算、存在 SQLite（append_entry）"""

    def __init__(self) -> None:
        self.append_ip: Dict[str, list] = {}
        self.fetch_ip: Dict[str, list] = {}

    def allow_append(self, ip: str, now: float) -> bool:
        return rate_hit(self.append_ip, ip, 60, REQUESTS_PER_IP_PER_MIN, now)

    def allow_fetch(self, ip: str, now: float) -> bool:
        return rate_hit(self.fetch_ip, ip, 60, FETCH_PER_IP_PER_MIN, now)


def create_group_log_router(db_path: str, get_real_client_ip: Callable, signed_account: Callable):
    """
    FastAPI 路由（main.py 掛載）。signed_account(pubkey, signature, payload, timestamp) → 帳號 key：
    驗帳號簽章（±300 秒、標準 base64）並找已註冊的帳號，不過就丟 HTTPException（401／403）——＝ main.py 的 _signed_account。
    """
    from fastapi import APIRouter, HTTPException, Request
    from pydantic import BaseModel, Field

    router = APIRouter()
    guard = GroupLogIpGuard()

    class AppendBody(BaseModel):
        # 字元數 ≤ bytes 數：先用字元擋掉明顯太大的，再照 bytes 精算
        blob: str = Field(..., min_length=1, max_length=MAX_BLOB_BYTES)
        pubkey: str = Field(..., min_length=40, max_length=128)
        timestamp: int
        request_id: str = Field(..., min_length=16, max_length=128)
        signature: str = Field(..., min_length=80, max_length=128)

    def _http(e: GroupLogError) -> HTTPException:
        return HTTPException(status_code=e.status, detail=e.code)

    @router.post("/api/group-log/{gid}")
    def group_log_append(gid: str, body: AppendBody, req: Request):
        now = time.time()
        if not guard.allow_append(get_real_client_ip(req), now):
            raise HTTPException(status_code=429, detail="group_log_rate_limited")
        try:
            payload = append_signed_payload(body.pubkey, _check_gid(gid), body.blob, body.timestamp, body.request_id)
        except GroupLogError as e:
            raise _http(e)
        account = signed_account(body.pubkey, body.signature, payload, body.timestamp)
        with open_group_log_db(db_path) as conn:
            try:
                return {"seq": append_entry(conn, gid, body.blob, account=account, request_id=body.request_id, now=now)}
            except GroupLogError as e:
                raise _http(e)

    @router.get("/api/group-log/{gid}")
    def group_log_fetch(gid: str, req: Request, after: int = 0, limit: int = MAX_FETCH):
        if not guard.allow_fetch(get_real_client_ip(req), time.time()):
            raise HTTPException(status_code=429, detail="group_log_rate_limited")
        with open_group_log_db(db_path) as conn:
            try:
                entries, head, more = fetch_entries(conn, gid, after, limit)
            except GroupLogError as e:
                raise _http(e)
        return {"entries": entries, "head": head, "more": more}

    return router

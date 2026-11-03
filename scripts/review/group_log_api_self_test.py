"""
群組 log API（決定 2026-10-22，同日審查修正 H2／M5／L2／L3）：真的 api/group_log_routes.py（純函式＋FastAPI 路由），
簽章用 chat 伺服器真的 api/chat/signing.py（make_signed_account，chat_app.py 與官方站的 main.py 掛群組 log 時用的同一個）。
  1. append 先到先排：同一個 gid 的 seq 從 1 連號；不同 gid 各自編號；8 條連線同時寫也不重複、不跳號
  2. blob 不透明；大小照 UTF-8 bytes 算（審查 H2：65,536 個 emoji 以前算 64K「字元」、存進去 256 KiB）
  3. fetch：after／limit、head、more；一頁最多 200 筆、512 KiB；after 太大 → 400 而不是 500（審查 L3）
  4. 額度照帳號算、存在 SQLite（審查 M5）：每帳號、每 (帳號, gid) 的每分鐘筆數與每天 bytes；被擋的不吃額度；
     灌爆的帳號擠不掉別人（輪詢 10 分鐘，正常帳號每一筆都進得去）；建一萬多個計數也擠不掉別人的計數；request_id 只能用一次
  5. 全域總量：快滿先拒收新的 gid、已有的群照常寫；全滿才全部拒收；沒有每群筆數上限（不會有永遠寫不進去的群）
  6. 路由：要帳號簽章（簽 blob 的 SHA-256）、未註冊 403、改了 blob 401、重送 409、GET 不用簽章、壞參數 400
  7. 接線：(a) 獨立的 chat 伺服器 api/chat_app.py —— log 存自己的 SQLite 檔（不在 chat.db）、路由注入帳號簽章、建 app 之前建檔；
     路由裡 IP 限流 → 簽章 → 資料庫；(b) 官方站的 api/main.py 同樣的接線（公開的 repo 沒有 main.py：印 SKIP）
Run: python3 scripts/review/group_log_api_self_test.py   （需要 fastapi、pydantic 2、cryptography、httpx）
"""
import ast
import base64
import hashlib
import json
import os
import pathlib
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from contextlib import contextmanager

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = pathlib.Path(__file__).resolve().parents[2]
API_DIR = pathlib.Path(os.environ.get("AEGISTALK_API_DIR", str(ROOT / "api")))   # 變異測試可指向副本
sys.path.insert(0, str(API_DIR))
import group_log_routes as gl  # noqa: E402

GID = "AbCdEfGhIjKlMnOpQrStUv"
GID2 = "ZyXwVuTsRqPoNmLkJiHgFe"
TMP = tempfile.TemporaryDirectory()


def fresh_db():
    path = os.path.join(TMP.name, secrets.token_hex(6) + ".db")
    gl.init_group_log_db(path)
    return gl.connect_group_log_db(path), path


def expect_error(fn, code, status=400):
    try:
        fn()
    except gl.GroupLogError as e:
        assert e.code == code and e.status == status, (e.code, e.status)
        return
    raise AssertionError(f"expected {code}")


def rid():
    return secrets.token_hex(12)


def put(conn, gid, blob, account="acct-1", now=1000.0, request_id=None):
    return gl.append_entry(conn, gid, blob, account=account, request_id=request_id or rid(), now=now)


def attempt(conn, gid, blob, account, now, request_id=None):
    """'ok' 或錯誤代碼"""
    try:
        put(conn, gid, blob, account, now, request_id)
        return "ok"
    except gl.GroupLogError as e:
        return e.code


def row_count(conn):
    return conn.execute("SELECT COUNT(*) FROM group_log").fetchone()[0]


# ── 1 ──
conn, _ = fresh_db()
assert [put(conn, GID, f"blob-{i}", now=1000.0 + i) for i in range(5)] == [1, 2, 3, 4, 5]
assert put(conn, GID2, "other") == 1, "each group has its own sequence"
_, path = fresh_db()
seqs, errors = [], []


def writer(n):
    c = gl.connect_group_log_db(path)
    try:
        for i in range(25):
            seqs.append(gl.append_entry(c, GID, f"w{n}-{i}", account=f"writer-{n}", request_id=rid(), now=1000.0))
    except Exception as e:  # pragma: no cover
        errors.append(e)
    finally:
        c.close()


threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
for t in threads:
    t.start()
for t in threads:
    t.join()
assert not errors, errors
assert sorted(seqs) == list(range(1, 201)), "8 concurrent writers × 25 → seq 1..200, no duplicates, no gaps"
print("PASS append is first-come-first-serve: per-group gapless sequence, also under 8 concurrent writers")

# ── 2 ──
conn, _ = fresh_db()
weird = ['{"k":"kid","n":"x","c":"y"}', "not json at all", "繁體中文", "x" * gl.MAX_BLOB_BYTES, "\U0001F600" * (gl.MAX_BLOB_BYTES // 4)]
for i, b in enumerate(weird):
    put(conn, GID2, b, account=f"weird-{i}")
got, _, _ = gl.fetch_entries(conn, GID2, 0, 200)
assert [e["blob"] for e in got] == weird, "stored and returned verbatim"
for bad in ["", "x" * (gl.MAX_BLOB_BYTES + 1), b"bytes", None, "\U0001F600" * (gl.MAX_BLOB_BYTES // 4 + 1), "\ud800 lone surrogate"]:
    expect_error(lambda bad=bad: put(conn, GID, bad), "bad_blob")
expect_error(lambda: put(conn, GID, "\U0001F600" * 65536), "bad_blob")   # 審查 H2 的 PoC
stored = conn.execute("SELECT MAX(length(CAST(blob AS BLOB))) FROM group_log").fetchone()[0]
assert stored <= gl.MAX_BLOB_BYTES, f"nothing larger than {gl.MAX_BLOB_BYTES} bytes is stored (max {stored})"
for bad in ["short", "A" * 23, "../../etc/passwd....", GID[:-1] + "!", None, 5]:
    expect_error(lambda bad=bad: put(conn, bad, "x"), "bad_gid")
src = (API_DIR / "group_log_routes.py").read_text(encoding="utf-8")
assert "json.loads" not in src and "import json" not in src, "the server never parses blobs"
print("PASS blobs are opaque and limited in UTF-8 bytes (64 KiB; 65,536 emoji = 256 KiB refused; lone surrogates refused)")

# ── 3 ──
conn, _ = fresh_db()
for i in range(5):
    put(conn, GID, f"b{i}", now=1000.0 + i)
entries, head, more = gl.fetch_entries(conn, GID, 2, 2)
assert [e["seq"] for e in entries] == [3, 4] and head == 5 and more is True
assert gl.fetch_entries(conn, GID, 5, 200) == ([], 5, False)
assert gl.fetch_entries(conn, GID, 3, 200)[2] is False
assert gl.fetch_entries(conn, "Q" * 22, 0, 200) == ([], 0, False), "unknown group → empty"
for after, limit, code in [(-1, 10, "bad_after"), ("1", 10, "bad_after"), (True, 10, "bad_after"), (2 ** 53, 10, "bad_after"),
                           (10 ** 30, 10, "bad_after"), (0, 0, "bad_limit"), (0, 201, "bad_limit")]:
    expect_error(lambda: gl.fetch_entries(conn, GID, after, limit), code)
assert gl.fetch_entries(conn, GID, gl.MAX_SEQ, 1) == ([], 5, False), "the largest allowed after works"
big = "y" * (60 * 1024)
for i in range(20):
    put(conn, GID2, big, account=f"bulk-{i}")
page, head, more = gl.fetch_entries(conn, GID2, 0, 200)
assert len(page) == 8 and sum(len(e["blob"]) for e in page) <= gl.MAX_FETCH_BYTES and more and head == 20, \
    f"a page stops at {gl.MAX_FETCH_BYTES} bytes ({len(page)} entries) and says there is more"
assert gl.fetch_entries(conn, GID2, page[-1]["seq"], 200)[0][0]["seq"] == page[-1]["seq"] + 1, "the client continues from the last seq"
print("PASS fetch: after/limit paging with head and more; pages capped at 200 entries and 512 KiB; after outside 0..2^53-1 → bad_after (no 500)")

# ── 4. 額度照帳號 ──
conn, _ = fresh_db()
t0 = 10_000.0
codes = [attempt(conn, GID, "x", "busy", t0 + i * 0.1) for i in range(40)]
assert codes.count("ok") == gl.APPEND_PER_ACCOUNT_GID_PER_MIN == 30 and set(codes) == {"ok", "account_gid_rate_limited"}, "30/min per (account, gid)"
codes = [attempt(conn, f"g{i:021d}", "x", "busy", t0 + 5 + i * 0.1) for i in range(40)]
assert codes.count("ok") == gl.APPEND_PER_ACCOUNT_PER_MIN - 30 and set(codes) == {"ok", "account_rate_limited"}, "60/min per account across gids"
assert attempt(conn, GID, "x", "someone-else", t0 + 10) == "ok", "another account is not affected"
assert attempt(conn, GID, "x", "busy", t0 + 61) == "ok", "the window slides"
before = row_count(conn)
assert attempt(conn, GID, "x", "busy", t0 + 61.5) == "ok"
assert row_count(conn) == before + 1
# 每天 bytes：每 (帳號, gid) 4 MiB、每帳號 16 MiB；照 UTC 日重算
conn, _ = fresh_db()
day0 = 86400.0 * 20_000
chunk = "z" * gl.MAX_BLOB_BYTES
per_pair = gl.BYTES_PER_ACCOUNT_GID_PER_DAY // gl.MAX_BLOB_BYTES
codes = [attempt(conn, GID, chunk, "heavy", day0 + i * 2.1) for i in range(per_pair + 1)]
assert codes[:per_pair] == ["ok"] * per_pair and codes[-1] == "account_gid_daily_bytes", f"{per_pair} × 64 KiB per (account, gid) per day"
per_account = gl.BYTES_PER_ACCOUNT_PER_DAY // gl.MAX_BLOB_BYTES
codes = [attempt(conn, f"h{i:021d}", chunk, "heavy", day0 + 1000 + i * 1.1) for i in range(per_account - per_pair + 1)]
assert codes[:-1] == ["ok"] * (per_account - per_pair) and codes[-1] == "account_daily_bytes", f"{per_account} × 64 KiB per account per day"
assert attempt(conn, GID, chunk, "heavy", day0 + 86400) == "ok", "a new UTC day"
# 被擋的請求不吃額度：灌爆的帳號在同一個群輪詢 10 分鐘，正常帳號每 4 秒一筆、全部進得去（審查 M5 PoC (c)）
conn, _ = fresh_db()
attacker_ok = honest_ok = honest_try = 0
t = 50_000.0
for step in range(6000):                      # 攻擊者每 0.1 秒一次
    now = t + step * 0.1
    attacker_ok += attempt(conn, GID, "junk", "attacker", now) == "ok"
    if step % 40 == 0:                        # 正常帳號每 4 秒
        honest_try += 1
        honest_ok += attempt(conn, GID, "commit", "honest", now) == "ok"
assert honest_ok == honest_try == 150, f"the honest account got {honest_ok}/{honest_try}"
assert attacker_ok <= 10 * gl.APPEND_PER_ACCOUNT_GID_PER_MIN, f"the attacker stays within its own budget ({attacker_ok})"
# 計數在 SQLite、不會被擠掉：一個帳號到上限之後，就算有一萬多個別的 (帳號, gid) 計數，它還是被擋（審查 M5 PoC (d)）
conn, _ = fresh_db()
for i in range(30):
    put(conn, GID, "x", account="victim-of-eviction", now=90_000.0)
assert attempt(conn, GID, "x", "victim-of-eviction", 90_000.5) == "account_gid_rate_limited"
conn.execute("BEGIN")
conn.executemany("INSERT INTO group_log_recent (scope, created_at) VALUES (?, ?)", [(f"g|other-{i}|{GID}", 90_000.6) for i in range(10_001)])
conn.execute("COMMIT")
assert attempt(conn, GID, "x", "victim-of-eviction", 90_001.0) == "account_gid_rate_limited", "10,001 other counters evict nothing"
guard = gl.GroupLogIpGuard()
for i in range(gl._RATE_MAX_KEYS + 50):
    guard.allow_fetch(f"ip{i}", 100.0)
assert len(guard.fetch_ip) <= gl._RATE_MAX_KEYS, "the per-IP CPU guard's memory stays bounded"
# request_id 只能用一次；被擋的那次沒用掉
conn, _ = fresh_db()
once = rid()
assert put(conn, GID, "a", account="r", now=1.0, request_id=once) == 1
expect_error(lambda: put(conn, GID, "a", account="r", now=2.0, request_id=once), "request_replayed", 409)
assert put(conn, GID, "a", account="other-account", now=2.0, request_id=once) == 2, "request ids are per account"
for i in range(29):
    put(conn, GID, "f", account="r", now=3.0)
retry = rid()
assert attempt(conn, GID, "f", "r", 4.0, retry) == "account_gid_rate_limited"
assert attempt(conn, GID, "f", "r", 70.0, retry) == "ok", "a refused request can be retried with the same id"
print(f"PASS per-account limits in SQLite: 30/min per (account, gid), 60/min per account, 4 MiB/day per (account, gid), 16 MiB/day per account; "
      f"a polling attacker leaves the honest account 150/150; 10,001 other counters evict nothing; request ids single-use, refused ones retryable")

# ── 5. 全域總量、沒有每群上限 ──
conn, _ = fresh_db()
saved = gl.GLOBAL_MAX_BYTES, gl.NEW_GID_MAX_BYTES
try:
    gl.GLOBAL_MAX_BYTES, gl.NEW_GID_MAX_BYTES = 40_000, 20_000
    blob = "q" * 4000
    n = next((i for i in range(100) if attempt(conn, GID, blob, f"fill-{i}", 5.0) != "ok"), 100)
    assert n == 9, n   # 9 × (4000 + 64) < 40,000 ≤ 10 × …（最多試 100 次，上限壞了也不會無限迴圈）
    assert attempt(conn, GID2, "tiny", "new-group", 5.0) == "group_log_new_groups_paused"
    assert attempt(conn, GID, blob, "fill-more", 5.0) == "group_log_storage_full"
    rows = row_count(conn)
    assert attempt(conn, GID, "t", "fill-more", 5.0) == "ok", "an existing group still writes small commits until the hard cap"
    assert row_count(conn) == rows + 1
    total = conn.execute("SELECT v FROM group_log_meta WHERE k = 'total_bytes'").fetchone()[0]
    assert total == sum(len(r[0].encode()) + gl.ROW_OVERHEAD_BYTES for r in conn.execute("SELECT blob FROM group_log")), "size accounting"
    # 已有的群在「新群暫停」的區間照常寫
    conn2, _ = fresh_db()
    for i in range(5):
        put(conn2, GID, blob, account=f"a{i}")
    assert attempt(conn2, GID2, blob, "b", 5.0) == "group_log_new_groups_paused"
    assert attempt(conn2, GID, blob, "c", 5.0) == "ok"
finally:
    gl.GLOBAL_MAX_BYTES, gl.NEW_GID_MAX_BYTES = saved
conn, _ = fresh_db()
conn.execute("BEGIN")
conn.executemany("INSERT INTO group_log (gid, seq, blob, bytes, created_at) VALUES (?, ?, 'x', 1, 0)", [(GID, s) for s in range(1, 100_001)])
conn.execute("COMMIT")
assert put(conn, GID, "legit commit", account="admin") == 100_001, "no per-group entry cap: a long log never bricks the group"
assert not hasattr(gl, "MAX_ENTRIES_PER_GROUP")
print("PASS global cap: new groups paused first, existing groups keep writing, then everything refused (507); no per-group entry cap")

# ── 6. 路由（FastAPI）＋ chat 伺服器真的帳號簽章（api/chat/signing.py，chat_app.py／main.py 用同一個 make_signed_account）──
from chat import signing  # noqa: E402
main_db = os.path.join(TMP.name, "main.db")


@contextmanager
def get_db():
    c = sqlite3.connect(main_db)
    c.row_factory = sqlite3.Row
    try:
        yield c
    finally:
        c.close()


with get_db() as c:
    signing.create_tables(c.cursor())     # pubkey_account_map（＋request_nonces）
    c.commit()
signed_account = signing.make_signed_account(get_db, signing.resolve_account_key)
log_db = os.path.join(TMP.name, "route.db")
gl.init_group_log_db(log_db)
app = FastAPI()
app.include_router(gl.create_group_log_router(db_path=log_db, get_real_client_ip=lambda req: req.headers.get("X-Test-IP", "198.51.100.7"),
                                              signed_account=lambda pk, sig, payload, ts: signed_account(pk, sig, payload, ts)[0]))
client = TestClient(app)


def keypair():
    priv = Ed25519PrivateKey.generate()
    return priv, base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def register(pk, account):
    with get_db() as c:
        c.execute("INSERT INTO pubkey_account_map (pubkey_hash, account_key) VALUES (?, ?)", (hashlib.sha256(pk.encode()).hexdigest(), account))
        c.commit()


def request(priv, pk, gid, blob, signed_blob=None, ts=None, request_id=None):
    ts = int(time.time()) if ts is None else ts
    request_id = request_id or rid()
    payload = {"action": "group_log_append", "pubkey": pk, "gid": gid, "blob_sha256": hashlib.sha256((signed_blob or blob).encode()).hexdigest(),
               "timestamp": ts, "request_id": request_id}
    sig = base64.b64encode(priv.sign(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())).decode()
    return {"blob": blob, "pubkey": pk, "timestamp": ts, "request_id": request_id, "signature": sig}


alice_priv, alice = keypair()
stranger_priv, stranger = keypair()
register(alice, "account-alice")
assert gl.append_signed_payload(alice, GID, "b", 5, "r" * 16)["blob_sha256"] == hashlib.sha256(b"b").hexdigest()
r = client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID, "commit-1"))
assert r.status_code == 200 and r.json() == {"seq": 1}, r.text
good = request(alice_priv, alice, GID, "commit-2")
assert client.post(f"/api/group-log/{GID}", json=good).json() == {"seq": 2}
assert client.post(f"/api/group-log/{GID}", json=good).status_code == 409, "replayed request"
assert client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID, "swapped", signed_blob="signed")).status_code == 401, "blob not the signed one"
assert client.post(f"/api/group-log/{GID}", json={**request(alice_priv, alice, GID, "x"), "pubkey": stranger}).status_code in (401, 422)
assert client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID2, "x") | {"request_id": rid()}).status_code == 401, "request_id is signed"
assert client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID, "old", ts=int(time.time()) - 400)).status_code == 401, "stale signature"
assert client.post(f"/api/group-log/{GID}", json=request(stranger_priv, stranger, GID, "x")).status_code == 403, "not a registered account"
assert client.post(f"/api/group-log/{GID}", json={"blob": "x"}).status_code == 422, "unsigned"
assert client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID2, "x")).status_code == 401, "signed for another gid"
assert client.post(f"/api/group-log/{GID}", json=request(alice_priv, alice, GID, "\U0001F600" * 16385)).status_code == 400, "too many bytes"
assert client.post("/api/group-log/bad-gid", json=request(alice_priv, alice, "bad-gid", "x")).status_code == 400
codes = [client.post(f"/api/group-log/{GID2}", json=request(alice_priv, alice, GID2, f"c{i}")).status_code for i in range(32)]
assert codes.count(200) == 30 and codes[-1] == 429, codes
r = client.get(f"/api/group-log/{GID}?after=0&limit=10")
assert r.status_code == 200 and r.json() == {"entries": [{"seq": 1, "blob": "commit-1"}, {"seq": 2, "blob": "commit-2"}], "head": 2, "more": False}, r.text
assert client.get(f"/api/group-log/{GID}?after={2 ** 64}").status_code == 400, "huge after → 400, not 500"
assert client.get(f"/api/group-log/{GID}?after=-1").status_code == 400
assert client.get("/api/group-log/short").status_code == 400
print("PASS routes: append needs a registered account's signature over the blob hash (unsigned 422, tampered/stale/other gid 401, unregistered 403, replay 409, "
      "bytes 400, per (account, gid) 429); GET needs no signature, huge after → 400")

# ── 7a. 獨立的 chat 伺服器（api/chat_app.py）──
def log_calls(tree):
    return {n.func.id: n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") in ("create_group_log_router", "init_group_log_db")}


APP_SRC = (API_DIR / "chat_app.py").read_text(encoding="utf-8")
APP_TREE = ast.parse(APP_SRC)
create_app = next(n for n in APP_TREE.body if isinstance(n, ast.FunctionDef) and n.name == "create_app")
calls = log_calls(create_app)
assert set(calls) == {"create_group_log_router", "init_group_log_db"}, "chat_app.create_app mounts the router and creates the log database"
mount = calls["create_group_log_router"]
assert sorted(k.arg for k in mount.keywords) == ["db_path", "get_real_client_ip", "signed_account"]
assert ast.unparse(next(k.value for k in mount.keywords if k.arg == "db_path")) == "cfg.group_log_db_path", "the router writes the log's own file"
assert "signed_account(" in ast.unparse(next(k.value for k in mount.keywords if k.arg == "signed_account")), "appends are checked with the account signature helper"
assert "make_signed_account(get_db, resolve_account_key)" in ast.unparse(create_app), "the helper checks the chat server's own accounts"
assert ast.unparse(calls["init_group_log_db"]) == "init_group_log_db(cfg.group_log_db_path)"
app_line = min(n.lineno for n in ast.walk(create_app) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "FastAPI")
assert calls["init_group_log_db"].lineno < app_line, "the log file is created before the app exists (a broken file stops the start)"
chat_init = ast.parse((API_DIR / "chat" / "__init__.py").read_text(encoding="utf-8"))
tables = next(n for n in chat_init.body if isinstance(n, ast.FunctionDef) and n.name == "create_chat_tables")
assert "group_log" not in ast.unparse(tables), "the log is not in the chat database"
CONFIG_SRC = (API_DIR / "chat" / "config.py").read_text(encoding="utf-8")
assert "AEGIS_GROUP_LOG_DB_PATH" in CONFIG_SRC and '"group_log.db"' in CONFIG_SRC, "own file: AEGIS_GROUP_LOG_DB_PATH or group_log.db next to AEGIS_DB_PATH"
append_fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == "group_log_append")
order = [n.attr if isinstance(n, ast.Attribute) else n.id for n in ast.walk(append_fn)
         if (isinstance(n, ast.Attribute) and n.attr == "allow_append") or (isinstance(n, ast.Name) and n.id in ("signed_account", "open_group_log_db"))]
lines = {name: min(n.lineno for n in ast.walk(append_fn) if (getattr(n, "attr", None) == name or getattr(n, "id", None) == name)) for name in set(order)}
assert lines["allow_append"] < lines["signed_account"] < lines["open_group_log_db"], "IP guard, then signature, then the database"
print("PASS chat_app.py: the log lives in its own SQLite file (not chat.db), created before the app; the router gets the account-signature check; guard → signature → database")

# ── 7b. 官方站（api/main.py；公開的 repo 沒有）──
MAIN_PY = API_DIR / "main.py"
if not MAIN_PY.exists():
    print("SKIP 7b main.py (official server): api/main.py is not in this checkout")
else:
    MAIN = MAIN_PY.read_text(encoding="utf-8")
    TREE = ast.parse(MAIN)
    calls = log_calls(TREE)
    assert set(calls) == {"create_group_log_router", "init_group_log_db"}, "main.py mounts the router and creates the log database"
    assert sorted(k.arg for k in calls["create_group_log_router"].keywords) == ["db_path", "get_real_client_ip", "signed_account"]
    assert "_signed_account" in ast.unparse(calls["create_group_log_router"]), "appends are checked with the account signature helper"
    init_db = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "init_database")
    assert "group_log" not in ast.unparse(init_db), "the log is not in the main aegis.db"
    assert "GROUP_LOG_DB_PATH" in MAIN and "group_log.db" in MAIN and "AEGIS_GROUP_LOG_DB_PATH" in MAIN
    startup = next(n for n in TREE.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "startup")
    assert "init_group_log_db(GROUP_LOG_DB_PATH)" in ast.unparse(startup)
    print("PASS main.py: the log lives in its own SQLite file (not aegis.db), created at startup; the router gets the account-signature check")

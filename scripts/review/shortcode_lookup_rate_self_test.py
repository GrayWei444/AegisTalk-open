"""
好友短碼查詢要限速（稽核 M11，對應群星 P2-9／AegisPlay 408744a）：靜態檢查 chat 伺服器 api/chat/shortcode.py 的 lookup_shortcode，
再用真的 chat/ratelimit.py mem_rate_hit 跑一次。
  以前 GET /api/shortcode/lookup/{code} 不需登入也不限速：32^6 的碼空間、24h 有效，掃描就能收集公鑰與暱稱，
  掃到的人還能拿著碼直接加碼主人好友。
  shortcode.py 要 FastAPI，這裡只用 ast 讀它（標準庫就能跑）；ratelimit.py 只用標準庫，直接 import。
Run: python3 scripts/review/shortcode_lookup_rate_self_test.py
"""
import ast
import pathlib
import sys

api = pathlib.Path(__file__).resolve().parents[2] / "api"
src = (api / "chat" / "shortcode.py").read_text(encoding="utf-8")
tree = ast.parse(src)
funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

lookup = funcs["lookup_shortcode"]
calls = [n for n in ast.walk(lookup) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "mem_rate_hit"]
assert calls, "lookup_shortcode must call mem_rate_hit"
store = calls[0].args[0].id
assert store == "lookup_rate", f"uses its own rate table (got {store})"
assert any(isinstance(n, ast.Constant) and n.value == 429 for n in ast.walk(lookup)), "over the limit -> 429"
first_stmt = next(s for s in lookup.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)))
assert isinstance(first_stmt, ast.If) and calls[0] in ast.walk(first_stmt.test), "rate check runs before the DB lookup"
limit = calls[0].args[3]
assert isinstance(limit, ast.Constant) and limit.value == 30 and isinstance(calls[0].args[2], ast.Constant) and calls[0].args[2].value == 60, \
    "30 per 60 s"

sys.path.insert(0, str(api))
from chat.ratelimit import mem_rate_hit  # noqa: E402

table: dict = {}
allowed = sum(mem_rate_hit(table, "1.2.3.4", 60, 30, 1000.0 + i * 0.01) for i in range(100))
assert allowed == 30, f"30 lookups per minute per IP (got {allowed})"
assert mem_rate_hit(table, "1.2.3.4", 60, 30, 1061.0), "the window slides"
print("PASS short-code lookup is rate limited per IP (30/min) before touching the database")

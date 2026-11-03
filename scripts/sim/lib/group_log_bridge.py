#!/usr/bin/env python3
"""
模擬 API／測試用：群組 log 直接跑伺服器的程式（api/group_log_routes.py 的 append_signed_payload／append_entry／fetch_entries），
不是抄的一份。只用標準庫（routes 的純函式不 import FastAPI）。

  python3 -I group_log_bridge.py <api/group_log_routes.py> <sqlite 檔>
stdin 一行一個 JSON 請求，stdout 一行一個 JSON 回應（同一個 id）：
  {"id", "op": "payload", "pubkey", "gid", "blob", "timestamp", "request_id"} → {"id", "ok": true, "payload": {...要簽的內容}}
  {"id", "op": "append", "gid", "blob", "account", "request_id", "now"}       → {"id", "ok": true, "seq": n}
  {"id", "op": "fetch", "gid", "after", "limit"}                               → {"id", "ok": true, "entries": [...], "head": n, "more": b}
錯誤 → {"id", "ok": false, "status": 4xx/5xx, "code": "..."}（GroupLogError 的 code／status，跟 FastAPI 路由回的一樣）
簽章驗證在呼叫端（JS，同 api/chat/signing.py verify_device_signature：排序 JSON、±300 秒、標準 base64、request_id 不重放）。
"""
import importlib.util
import json
import sys


def load(path):
    spec = importlib.util.spec_from_file_location("group_log_routes", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    routes = load(sys.argv[1])
    db_path = sys.argv[2]
    routes.init_group_log_db(db_path)
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            op = req.get("op")
            if op == "payload":
                payload = routes.append_signed_payload(req["pubkey"], routes._check_gid(req["gid"]), req["blob"],
                                                       req["timestamp"], req["request_id"])
                out = {"id": rid, "ok": True, "payload": payload}
            elif op == "append":
                with routes.open_group_log_db(db_path) as conn:
                    seq = routes.append_entry(conn, req["gid"], req["blob"], account=req["account"],
                                              request_id=req["request_id"], now=req.get("now"))
                out = {"id": rid, "ok": True, "seq": seq}
            elif op == "fetch":
                with routes.open_group_log_db(db_path) as conn:
                    entries, head, more = routes.fetch_entries(conn, req["gid"], req.get("after", 0),
                                                               req.get("limit", routes.MAX_FETCH))
                out = {"id": rid, "ok": True, "entries": entries, "head": head, "more": more}
            else:
                out = {"id": rid, "ok": False, "status": 400, "code": "bad_op"}
        except routes.GroupLogError as e:
            out = {"id": rid, "ok": False, "status": e.status, "code": e.code}
        except (KeyError, TypeError, ValueError) as e:
            out = {"id": rid, "ok": False, "status": 422, "code": f"bad_request:{type(e).__name__}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

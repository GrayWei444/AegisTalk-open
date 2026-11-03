"""
邀請碼（CHAT_REGISTRATION=invite 時新帳號要一個）。從 api/ 資料夾執行，AEGIS_DB_PATH 指向伺服器的資料庫：

  python -m chat.invites create [--uses N] [--days D] [--note TEXT]   印出新的碼（只有這一次看得到；資料庫只存 SHA-256）
  python -m chat.invites list                                         id（hash 前 12 字元）、剩幾次、期限
  python -m chat.invites revoke <碼或 id>

docker：docker compose -f docker-compose.example.yml exec -u 10001 api python -m chat.invites create --uses 5
（-u 10001：跟 API 同一個使用者，不然資料庫旁邊的 -wal／-shm 檔可能變成 root 的、API 寫不進去）
"""
import argparse
import os
import sqlite3
import sys
import time

from . import accounts, signing, usage


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m chat.invites", description="Invite codes for keys-only registration")
    sub = parser.add_subparsers(dest="cmd", required=True)
    create = sub.add_parser("create", help="create an invite code")
    create.add_argument("--uses", type=int, default=1, help="how many accounts it can create (default 1)")
    create.add_argument("--days", type=float, default=7, help="valid for this many days (default 7)")
    create.add_argument("--note", default="", help="a note for yourself (stored with the code)")
    sub.add_parser("list", help="list invite codes")
    revoke = sub.add_parser("revoke", help="revoke an invite code")
    revoke.add_argument("code_or_id")
    args = parser.parse_args(argv)

    db_path = (os.environ.get("AEGIS_DB_PATH") or "").strip()
    if not db_path:
        print("AEGIS_DB_PATH is not set (point it at the chat server's database)", file=sys.stderr)
        return 2
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        cursor = conn.cursor()
        signing.create_tables(cursor)
        usage.create_tables(cursor)
        accounts.create_tables(cursor)
        if args.cmd == "create":
            code = accounts.create_invite(cursor, uses=args.uses, days=args.days, note=args.note)
            conn.commit()
            print(code)
        elif args.cmd == "list":
            now = int(time.time())
            for inv in accounts.list_invites(cursor, now):
                state = "active" if inv["active"] else "used up / expired"
                expires = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(inv["expires_at"]))
                print(f"{inv['id']}  uses_left={inv['uses_left']}  expires={expires}  {state}  {inv['note']}")
        else:
            removed = accounts.revoke_invite(cursor, args.code_or_id)
            conn.commit()
            print(f"revoked {removed}")
            return 0 if removed else 1
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

"""
記憶體滑動窗限流（chat 端點共用；搬自 api/main.py）。

每個 router 自己建一張表（dict），重啟即清。只用在「每 IP／每帳號每分鐘幾次」這種粗略上限；
需要跨重啟、不能被擠掉的計數（例如推播的寄件者 → 收件人冷卻、新帳號的上限）放在 SQLite。
端點是一般函式（FastAPI 在 threadpool 裡跑，第 3 步審查：async 端點裡做 SQLite／驗簽／對外連線會卡住整個 event loop），
所以這裡用一把鎖：同一張表的「看 → 記一筆」不會被兩個 thread 交錯。
"""
import ipaddress
import threading

MEM_RATE_MAX_KEYS = 10_000
_LOCK = threading.Lock()
#: IPv6 的限流單位（第 3 步審查 M：一般家用網路至少拿到一個 /64，按 /128 算的話每 IP 的上限形同虛設）
IPV6_RATE_PREFIX = 64


def rate_key(ip: str) -> str:
    """每 IP 限流用的 key：IPv4 照原樣，IPv6 用它所在的 /64（IPv4-mapped 的照 IPv4）；不是 IP 的字串原樣（例如 "unknown"）"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        return str(mapped)
    if addr.version == 6:
        return str(ipaddress.ip_network(f"{addr}/{IPV6_RATE_PREFIX}", strict=False))
    return str(addr)


def mem_rate_hit(store: dict, key: str, window: float, limit: int, now: float) -> bool:
    """
    記憶體滑動窗限流（重啟即清）。回 True＝放行並記一筆；False＝超過上限。
    表長到 MEM_RATE_MAX_KEYS 就先丟掉窗口已過的 key，還是太多再丟最早進來的，
    掃描器換 IP 也不會讓這個 process 的記憶體一直長（與 AegisPlay 同一份）。
    """
    with _LOCK:
        hits = [t for t in store.get(key, ()) if now - t < window]
        if len(hits) >= limit:
            store[key] = hits
            return False
        hits.append(now)
        store[key] = hits
        if len(store) > MEM_RATE_MAX_KEYS:
            for stale in [k for k, v in store.items() if not v or now - v[-1] >= window]:
                store.pop(stale, None)
            while len(store) > MEM_RATE_MAX_KEYS:
                store.pop(next(iter(store)))
        return True


def mem_rate_peek(store: dict, key: str, window: float, limit: int, now: float) -> bool:
    """只看還有沒有額度、不記一筆（先檢查、確定要送才用 mem_rate_hit 記）。"""
    with _LOCK:
        return sum(1 for t in store.get(key, ()) if now - t < window) < limit

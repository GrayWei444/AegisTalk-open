#!/usr/bin/env python3
"""
模擬 API 的 token ACL 直接用伺服器的程式算（審查 2a：以前模擬用 profiles.mjs 裡抄的一份，伺服器改了模擬不會知道）。

直接載入 api/chat/mqtt_auth.py（開源計畫第 2 步從 api/main.py 搬出來；以前要用 ast 從 main.py 挖函式，因為 main.py 硬 import
外部模組）：mqtt_scope（範圍驗證，W3：群組主題 id 剛好 22 字元、沒有萬用字元；W4：presence 只收確切的
mist/user/<他>/presence/<tag>、tag 22 字元）、mqtt_topic_user、mqtt_acl 與 MQTT_* 常數 —— 連請求的欄位表
（MQTT_TOKEN_REQUEST_FIELDS：多的欄位 422，開源第 6 步）與 tag 長度上限都是伺服器的，這裡沒有抄任何一份規則。
那個檔案的模組層只用標準庫，所以這裡也只需要標準庫（模擬用裸的 python3 就行）。
  python3 -I server_acl.py <api/chat/mqtt_auth.py>      stdin：一行一個 JSON 請求，stdout：一行一個 JSON 回應
請求：{"pubkey": 標準 base64 或 null, "username": 已是主題寫法（換機的 transfer_…）或 null,
       "groups": [...], "presence": [確切的好友 presence 主題...], "presence_tag": 我的 tag 或 null,
       "fields": 請求裡所有的欄位名（不在伺服器的欄位表裡的 → 422，例如舊的 peers）, "raw_device_id": 請求裡的 device_id 或 null（格式驗證）,
       "device_id": 已驗證、給 kick 主題的裝置或 null, "receive_only": bool, "acl_format": "rules"（預設）／"legacy"}
回應：{"username": ..., "acl": {"pub": [...], "sub": [...], "all": []}（＝回應的 subscribe 用 acl.sub）,
       "claim": token 的 acl claim（伺服器的 mqtt_acl_claim：rules ＝ EMQX ≥ 5.7 的規則清單，只有我自己的 presence 主題能 retain）}
      或 {"error": {"status": 400／422, "detail": ...}}（跟伺服器一樣整張拒絕：格式不對 400、超過上限 422）
"""
import importlib.util
import json
import sys
from types import SimpleNamespace

WANTED = ("mqtt_topic_user", "mqtt_acl", "mqtt_acl_claim", "presence_retain_topics", "mqtt_scope", "TokenRequestError",
          "MQTT_ACL_MAX_GROUPS", "MQTT_ACL_MAX_PRESENCE", "MQTT_GROUP_TOPIC_RE", "MQTT_PRESENCE_TOPIC_RE", "MQTT_PRESENCE_TAG_RE",
          "MQTT_TOKEN_REQUEST_FIELDS", "MQTT_PRESENCE_TAG_MAX")


def load(mqtt_auth_py: str):
    spec = importlib.util.spec_from_file_location("sim_server_mqtt_auth", mqtt_auth_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    missing = [n for n in WANTED if not hasattr(mod, n)]
    if missing:
        raise SystemExit(f"server_acl: {missing} not found in {mqtt_auth_py}")
    return mod


def answer(acl, req: dict) -> dict:
    username = req.get("username") or acl.mqtt_topic_user(req["pubkey"])
    fmt = req.get("acl_format") or "rules"
    if req.get("receive_only"):
        legacy = acl.mqtt_acl(username, receive_only=True)
        return {"username": username, "acl": legacy, "claim": acl.mqtt_acl_claim(legacy, fmt=fmt)}
    groups, presence, tag = req.get("groups", []), req.get("presence"), req.get("presence_tag")
    # MqttTokenRequest 的 pydantic 規則（extra="forbid"、List[str]、max_length）：伺服器回 422 —— 舊的 peers 欄位也是。
    #   欄位表與上限都從伺服器的模組來（MQTT_TOKEN_REQUEST_FIELDS、MQTT_ACL_MAX_*、MQTT_PRESENCE_TAG_MAX）
    extra = sorted(set(req.get("fields") or ()) - set(acl.MQTT_TOKEN_REQUEST_FIELDS))
    if extra:
        return {"error": {"status": 422, "detail": "extra_forbidden:" + ",".join(extra)}}
    if (not isinstance(groups, list) or not isinstance(presence, list) or len(groups) > acl.MQTT_ACL_MAX_GROUPS
            or len(presence) > acl.MQTT_ACL_MAX_PRESENCE or not all(isinstance(x, str) for x in groups + presence)
            or (tag is not None and (not isinstance(tag, str) or len(tag) > acl.MQTT_PRESENCE_TAG_MAX))):
        return {"error": {"status": 422, "detail": "invalid_scope_shape"}}
    try:
        groups, presence, tag, _ = acl.mqtt_scope(SimpleNamespace(groups=groups, presence=presence, presence_tag=tag,
                                                                  device_id=req.get("raw_device_id")))
    except acl.TokenRequestError as e:
        return {"error": {"status": e.status, "detail": e.detail}}
    legacy = acl.mqtt_acl(username, groups=groups, presence=presence, presence_tag=tag, device_id=req.get("device_id"))
    return {"username": username, "acl": legacy,
            "claim": acl.mqtt_acl_claim(legacy, acl.presence_retain_topics(username, tag), fmt)}


def main() -> None:
    acl = load(sys.argv[1])
    for line in sys.stdin:
        if not line.strip():
            continue
        sys.stdout.write(json.dumps(answer(acl, json.loads(line))) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

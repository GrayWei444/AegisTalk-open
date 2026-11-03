# MQTT broker 設定（EMQX 5，AegisTalk）

> 英文的精簡版在 [SELF_HOSTING.md](SELF_HOSTING.md#mqtt-broker)；這份逐條說明每一項設定為什麼這樣設（繁體中文）。
>
> 演進：群組主題是每一代群組金鑰推出來的主題 id（tid），gid 不上 broker（[W3](GROUP_LOG_WIRING_W3.md)）；presence 是好友之間的秘密主題
> `mist/user/<我>/presence/<tag>`，token 請求不帶公鑰清單（[W4](GROUP_LOG_WIRING_W4.md)）；收端判斷新不新鮮的時鐘只採信 API 時鐘差 ±5 分鐘，
> 模擬裡有惡意營運方與第五個角色 Mallory（[W5](GROUP_LOG_WIRING_W5.md)）。token 的 `acl` claim 預設是 EMQX ≥ 5.7 的規則格式
> （`CHAT_MQTT_ACL_FORMAT=rules`；只有自己的 presence 主題能 retain、最後一條 deny all），在 EMQX 5.8.9 實測過（§3.1）；整份 broker 設定是
> `emqx/base.hocon.example`；token 另外有每個帳號 24 小時的主題數上限（§5）。
> 這份是設定說明：repo 裡沒有任何程式會去改你的 broker，照做要由管理 broker 的人自己套用。

## 1. 原則

- 連線只認 **EMQX 內建 JWT authenticator**。每張 token 由 API 發（`api/chat/mqtt_auth.py`，由 chat 伺服器 `api/chat_app.py` 掛載），
  自帶 `acl` claim，而且綁死 `username` 與 `clientid`。
- 整份設定：`emqx/base.hocon.example`（EMQX 5.8.9 實測：`scripts/selfhost/selfhost_smoke.py` 34/34，2026-10-26）。
- 授權預設**拒絕**：token 的 `acl` 沒列到的發布／訂閱一律拒絕（`no_match = deny`），而且是**默默拒絕**
  （`deny_action = ignore`：發布回 PUBACK 0x87、訂閱回 SUBACK 0x87，連線不斷）。
- **不要**設定 HTTP 認證 webhook。API 的 `/api/mqtt/auth` 已經拿掉：它對任何有效 JWT 都回 allow、
  不帶 ACL、不核對 username／clientId，broker 只要改走它，每張 token 的範圍就放寬成「所有主題」。
- **只能有這一個 authenticator，而且沒有超級使用者**（見 §2.1）；每個 listener 都要用它（見 §2.2）。
- **retained 只准我自己那一個秘密 presence 主題**（`mist/user/<我>/presence/<我的 tag>`），見 §3.1。

## 2. JWT authenticator

```hocon
authentication = [
  {
    mechanism = jwt
    from = password
    use_jwks = false
    algorithm = "hmac-based"
    # 用 openssl rand -hex 32 產生；跟 API 的環境變數 AEGIS_MQTT_JWT_SECRET 同一個值。不要寫進 repo（用下面的環境變數給）。
    secret = "<YOUR_SECRET>"
    secret_base64_encoded = false
    # token 自帶的授權規則
    acl_claim_name = "acl"
    # JWT 的 username／clientid claim 必須跟 CONNECT 的 username／clientId 一字不差
    verify_claims {
      username = "${username}"
      clientid = "${clientid}"
    }
    # （EMQX 預設）token 到期就斷線：一般 token 1 小時、換機 token 5 分鐘；App 的 HealthMonitor 會拿新 token 重連
    disconnect_after_expire = true
  }
]
```

secret 不寫在檔案裡：用環境變數 `EMQX_AUTHENTICATION__1__SECRET` 給（EMQX 5.8.9 實測：陣列第 1 個 authenticator 的 secret 會被它蓋掉；
`emqx ctl conf show authentication` 看得到實際值 —— 這個指令的輸出也不要貼到任何地方）。
EMQX 的 JWT authenticator 會採信 token 裡的 `is_superuser` claim（5.8.9 實測：帶 `is_superuser: true` 的 token 什麼都能發）；API 發的 token
從來不帶，但拿到 secret 的人做得出來 —— secret 外流一律輪替（§2.4）。

Dashboard 的對應位置：Access Control → Authentication → JWT →
「JWT From = password」「Algorithm = hmac-based」「Secret = 新 secret」「ACL Claim Name = acl」
「Verify Claims：`username` = `${username}`、`clientid` = `${clientid}`」。

`disconnect_after_expire = true` 時，token 到期那一刻 broker 會把連線踢掉（而且發離線遺囑）。App 在到期前 5 分鐘
先拿新 token、送正常的 DISCONNECT（reason 0，**沒有**遺囑）再用新 token 連回來（`mqtt.ts _swapToken`／
`_scheduleTokenRefresh`），所以正常情況不會碰到這個踢線。

### 2.1 其他 authenticator 與超級使用者全部拿掉

- Access Control → Authentication 的**整條鏈**只留上面的 JWT authenticator。其他的（Password-Based 的 built-in
  database／MySQL／PostgreSQL／Redis／HTTP、SCRAM、另一個 JWT…）一律刪除，不要只是停用後忘了：鏈上任何一個認得
  某個帳密，那條連線就繞過了 token 的 ACL。
- 沒有任何 `is_superuser = true` 的使用者（超級使用者跳過所有授權檢查）：built-in database 刪掉之後就不會有；
  API 發的 token 也不帶 `is_superuser`。Dashboard 的登入帳號是另一套（`dashboard.default_username`），不影響 MQTT，
  但密碼要換掉預設值。
- `authorization.sources` 只留下面 §3 的檔案（不要 HTTP／built-in database 授權來源）。

### 2.2 每個 listener 都要認證

EMQX 5 的 listener 可以自己帶 authenticator（`listeners.<type>.<name>.authentication`，會**蓋掉**全域那條）或整個關掉
認證（`enable_authn = false`），預設設定檔有時候 ws／wss 跟 tcp 不一樣。逐一檢查 `emqx ctl listeners` 列出的每一個：

- `enable_authn = true`，而且**沒有** listener 自己的 `authentication` 區塊（只用全域的 JWT）。
- tcp `1883`：API 的踢裝置推播（`publish_mqtt_kick`）走這個，**只綁 `127.0.0.1`**（`bind = "127.0.0.1:1883"`），
  不對外開；它一樣要 JWT（API 自己簽）。
- ws `8083`：反向代理（例如 Caddy）轉過來的（`wss://<你的 MQTT 網域>/mqtt`），一樣只綁本機。
- 用不到的（ssl 8883、wss 8084、quic…）關掉。

### 2.3 Session 與佇列上限

收件箱一個寄件者一個主題（`mist/user/<我>/inbox/<寄件者>`），App 用持久 session（`clean_start = false`，
session 24 小時）。不設上限的話，一個離線的人可以被塞滿：

```hocon
mqtt {
  max_mqueue_len = 1000          # 每個離線 session 最多排 1000 則（App 自己的待送佇列上限是 200 則）
  mqueue_store_qos0 = false      # QoS0 不排隊（App 只用 QoS1）
  max_inflight = 32
  max_awaiting_rel = 100
  max_subscriptions = 256        # 一張 token 最多 1 收件箱 + 50 群組主題 + 150 好友 presence 主題 + 1 kick = 202
  max_packet_size = 1MB          # CONNECT 帶的 JWT：滿範圍約 16KB
  max_topic_levels = 8           # App 的主題最多 5 層
  session_expiry_interval = 24h  # MQTT 3 的預設；App（MQTT 5）自己要 86400 秒，不要調高上限
}
```

不同 EMQX 版本的鍵名略有差異（例如 session 上限放在 `durable_sessions` 或 zone 底下），套用前用 `emqx ctl conf show mqtt`
對一下實際的鍵。`emqx/base.hocon.example` 的 `mqtt { … }` 在 5.8.9 上 `conf show mqtt` 逐項確認過，另外加了
`max_clientid_len = 64`、`max_qos_allowed = 1`（App 只用 QoS 0／1）；ws listener 每個連線 `messages_rate = "50/s"`、`bytes_rate = "1MB/s"`
（超過時 EMQX 暫停讀那條連線，不斷線；5.8.9 `conf show listeners` 確認過）。`max_packet_size` 維持 1MB：封給身分金鑰的邀請／狀態最大約 700KB。

### 2.4 輪替 secret

1. `openssl rand -hex 32` 產生新值（只放在 broker 設定與 API 的環境變數，不進 repo、不進聊天紀錄）。
2. **同時**更新 EMQX JWT authenticator 的 secret 與 API 的 `AEGIS_MQTT_JWT_SECRET`，重啟 API。
3. 舊 token 立刻失效；App 連不上時會自己重新要 token，使用者不用做什麼（線上的人會斷線重連一次）。

## 3. Authorization

```hocon
authorization {
  no_match = deny
  deny_action = ignore
  # 快取的授權結果最多活這麼久；token 範圍改了之後，舊決定最晚 1 分鐘失效
  cache { enable = true, max_size = 32, ttl = 1m }
  sources = [
    { type = file, enable = true, path = "${EMQX_ETC_DIR}/acl.conf" }
  ]
}
```

`emqx/base.hocon.example` 更嚴：`sources = []`，一個授權來源都沒有（EMQX 預設的檔案來源最後一行是 `{allow, all}`），token 的規則以外全部落到
`no_match = deny`。如果你的 broker 要留檔案來源（例如讓 dashboard 帳號看 `$SYS`）：JWT 的 `acl` claim 在檔案授權之前先比對，檔案只留給
dashboard 看 `$SYS`，`acl.conf` 改成：

```erlang
{allow, {username, {re, "^dashboard$"}}, subscribe, ["$SYS/#"]}.
{deny, all, subscribe, ["$SYS/#", {eq, "#"}]}.
```

- **刪掉檔案最後的 `{allow, all}.`**：有它的話 `no_match = deny` 永遠不會發生，token 的 ACL 形同虛設。
- 也**刪掉** `{allow, {ipaddr, "127.0.0.1"}, all, ["$SYS/#", "#"]}.`：反向代理（Caddy）若是從 127.0.0.1 連進 EMQX，
  這一行等於讓每個 App 連線都全開。伺服器自己的推播（踢裝置）也帶自己的 JWT ACL，不需要它。

### 3.1 retained 只准我自己的秘密 presence 主題

App 只在自己的秘密 presence 主題（`mist/user/<我>/presence/<tag>`，W4）用 retain：上線／離線狀態、遺囑、每 4 分鐘的「在線」更新，
換秘密之前在舊主題上發一則**空的** retained 把 broker 存著的最後狀態清掉。payload 只有 `{n, c}`（AES-GCM，金鑰由只給好友的秘密推出來、
AAD ＝ 主題；沒有寄件人、沒有公鑰、沒有明文的上線與否）。收件箱與群組頻道上的
retained 沒有任何正當用途：任何人都能往別人每一個收件箱主題（一個寄件者一個）留一則，broker 永久保存、對方每次重新
訂閱就重播一次。App 收到時已經丟掉（`mqtt.ts handleMessage`：只有確切的 `mist/user/<他>/presence/<tag>` 可以是 retained，
舊的 `mist/user/<他>/presence` 也不行），broker 端還要擋：

**JWT 的 ACL 在檔案授權之前先比對**，`acl.conf` 裡的 deny 擋不住 token 已經 allow 的發布；所以規則要寫在 token 裡。
EMQX ≥ 5.7 的 `acl` claim 支援新格式（規則清單，依序比對、第一條命中的決定；`retain: false` 只命中非 retained 的發布，沒寫 ＝ 都命中）。
**token 預設就是這個格式**（`api/chat/mqtt_auth.py mqtt_acl_claim`，`CHAT_MQTT_ACL_FORMAT=rules`）：

```json
[
  {"permission": "allow", "action": "publish", "topic": "mist/user/+/inbox/<我>",   "retain": false},
  {"permission": "allow", "action": "publish", "topic": "mist/group/+/<我>",        "retain": false},
  {"permission": "allow", "action": "publish", "topic": "mist/user/<我>/presence/<我的 tag>"},
  {"permission": "allow", "action": "subscribe", "topic": "…（同 sub 清單，App 拿到的 subscribe 也是這份）"},
  {"permission": "deny",  "action": "all", "topic": "#"}
]
```

- 最後一條 deny all：JWT 的 acl 先比對，命中 deny 就不再看其他授權來源 —— 就算 broker 還留著 `{allow, all}` 的 acl.conf，token 自己就拒絕。
- **EMQX 5.8.9 實測**（2026-10-26，tarball＋`emqx/base.hocon.example`，探測 32/32 與 `selfhost_smoke.py`）：retained 發到收件箱、群組頻道
  → PUBACK 0x87；同一個主題不 retained → 收；自己的 presence 主題 retained → 收、之後訂閱的人收到那一則；只有 deny 的 token → 發、訂都 0x87；
  舊格式（`pub`／`sub`／`all`）照樣能用，但 retained 發到收件箱也收（表達不了 retain）。
- **broker 比 5.7 舊**：認不得規則格式 → 設 `CHAT_MQTT_ACL_FORMAT=legacy`；升到 ≥ 5.7 並照 §6 第 4 項驗過之後再改回 rules。
- retainer 的上限照樣留著（多一層保護）。`msg_expiry_interval` 是 7 天：open 註冊時一天 500 個帳號 × 每個每天 20 個 tag，30 天會超過
  20 萬的上限，7 天不會（App 連著時每 4 分鐘重發，離線一週的好友本來就顯示離線）。⚠️ 5.8 的鍵是 `retainer.backend.max_retained_messages`
  （頂層的 `retainer.max_retained_messages` 在 5.8.9 會 `unknown_fields`、整個 EMQX 起不來）：

```hocon
retainer {
  enable = true
  max_payload_size = 2KB             # presence（{n, c}）不到 200 bytes
  msg_expiry_interval = 7d           # 7 天沒更新的 presence 自動清掉（App 每次上線、連著時每 4 分鐘都會重發；換秘密的舊主題 App 自己清）
  backend {
    type = built_in_database
    storage_type = disc
    max_retained_messages = 200000   # 大約「使用者數 × 1」再留餘裕（正常只有 presence，一人一則）
  }
}
```

## 4. Token 內容（`api/chat/mqtt_auth.py`）

所有 token：`iss = "aegisrd"`、HS256、`sub = username`。主題裡的公鑰一律是 **URL-safe、去 padding** 的 base64
（`+`→`-`、`/`→`_`）。主題最後一節是**寄件者**：只能發布到自己那一節，收件端再核對它跟訊息裡的 `from` 一致。

| 誰 | 怎麼拿 | username／clientid | 可發布 | 可訂閱 | 效期 |
|---|---|---|---|---|---|
| App | `POST /api/mqtt/token`，帳戶 Ed25519 簽章（`action=mqtt_token`、`pubkey`、`timestamp`、`request_id`、`client_id`、`groups`（群組主題 id）、`presence`（確切的好友 presence 主題）、選填 `presence_tag`、選填 `device_id`；**沒有** `peers`，多送欄位 422），request_id 只能用一次；每 IP 每分鐘 120 張 | `<我>`／`mist_<我前16>_<deviceId前8>` | `mist/user/+/inbox/<我>`、`mist/group/+/<我>`、有 `presence_tag` 才有 `mist/user/<我>/presence/<presence_tag>`（唯一能 retain 的主題） | `mist/user/<我>/inbox/+`、每個簽過名的群組主題 `mist/group/<tid>/+`（≤50；tid 見下）、每個簽過名的好友 presence 主題 `mist/user/<他>/presence/<tag>`（≤150，確切的；見下）、`aegis/device/<deviceId>/kicked`（**只有**這台是帳號的活躍裝置時） | 1 小時 |
| 換機的新裝置 | `POST /api/mqtt/transfer-token`（不用登入，每 IP 每小時 20 張） | `transfer_<隨機>`／同 username（伺服器指定） | 無 | `mist/user/transfer_<隨機>/inbox/+` | 5 分鐘 |
| 伺服器踢裝置推播 | API 自己簽（`publish_mqtt_kick`） | `aegis-system`／`aegis-system-<隨機>` | `aegis/device/+/kicked` | 無 | 60 秒 |

`mist/broadcast` 已經拿掉（沒有功能在用、任何人都能往裡面發），任何 token 都沒有它的權限。

**群組主題 id（W3）**：`tid = URL-safe base64(HKDF-SHA256(這一代群組金鑰, "aegistalk-gtopic-v1|" + gid))[:22]`，每換一次金鑰就換；
App 的 `groups` 是每個群目前這一代的 tid，換金鑰後上一代的再留 10 分鐘（之後退訂）。伺服器（`mqtt_scope`）只收**剛好 22 個
URL-safe 字元**（`^[A-Za-z0-9_-]{22}$`）：`+`、`#`、`/`、長度不對、舊的 `group-<ms>-…` 群組 id 一律 `400 invalid_acl_groups`、整張不發；
超過 50 個 `422`。所以 token 裡每一條群組訂閱都是一個確切的主題，沒有萬用字元。gid 不在主題、token 請求、JWT、任何 payload 裡；
伺服器與 broker 不知道哪個 tid 是哪個群。群組主題上的信封只有 `{n, c}`、WebRTC offer 的證明只有 `{t, m}`，都**不帶金鑰 id**
（群組 log 的 API 看得到每一筆的 gid 與 kid，broker 上再看到 kid 就對得回去）；同時經營 log API 與 broker 的人只剩時間上的關聯
（某個群寫進換金鑰 → 一批人換 token、訂一個新的 tid），見 `docs/GROUP_LOG_WIRING_W3.md` 的限制。每次換金鑰，線上的成員都會換一次
token、重連一次。
**presence（W4，`docs/GROUP_LOG_WIRING_W4.md`）**：每個人一個秘密主題 `mist/user/<我>/presence/<tag>`，
`tag = URL-safe base64(HMAC-SHA256(S, "aegistalk-presence-v1|" + e)[:16])`；秘密 S 與世代 e 只封給好友（身分金鑰信封），刪好友、封鎖、
滿 30 天就換（換之前先清掉舊主題的 retained）。token 請求的 `presence` 只收確切的 `mist/user/<標準寫法的 URL-safe 公鑰（43 字元）>/presence/<22 字元 tag>`
（`MQTT_PRESENCE_TOPIC_RE`）：`+`、`#`、多一層、舊的 `mist/user/<他>/presence`（只要知道公鑰就能訂）、非標準寫法的公鑰、標準 base64 → `400 invalid_acl_presence`、
整張不發；超過 150 個 `422`；`presence_tag` 只收 22 個 URL-safe 字元（`400 invalid_acl_presence_tag`）。以前的 `peers`（公鑰清單）拿掉了：
伺服器替每個列出來的人組 `mist/user/<他>/presence`，誰都能看任何人的上線狀態（審查發現 H1）；現在送了就 `422`（`extra="forbid"`）。
伺服器不查誰是誰的好友：它不需要社交圖，但**看得到**（token 請求與訂閱裡的主題都帶著主人的公鑰，見 §5）。不知道 tag 的人就算拿到一個猜的主題，
訂到的也是什麼都沒有的主題；營運方沒有 S，寫不出解得開的「在線」。知道 tag（好友、看得到 token 的營運方）不必有 S 就看得到主人
發布的節奏（上線、每 4 分鐘更新、斷線），只是讀不到內容。

`/api/mqtt/token` 的其他規則：

- **kick 主題**（`mqtt_kick_device`）：帳號的活躍裝置（`talk_active_device`）就是這台才給；活躍裝置是別台 → `403 device_replaced`
  （被踢、換機的那台拿不到新 token）；沒有帳號或還沒 claim → 照發、沒有 kick。App claim 成功後
  （`mqttService.onDeviceClaimed`）若手上的 token 沒有 kick 主題就換一張。以前 `device_id` 只是簽章裡的一個欄位，誰都能訂任何一台的。
- **時鐘**：時間戳在 ±300 秒外回 `401 {"detail": {"code": "clock_skew", "server_time": <秒>}}`；App 用它重簽一次，
  之後訊息時戳、新鮮度、token 到期都用校正後的時間；重簽還是不行才顯示「手機時間不準」。
- **回應**：`token`、`expiresAt`、`username`、`subscribe`（＝token 准訂閱的主題，App 只訂這些）、`serverTime`。
- **帳號**：chat 伺服器（`api/chat_app.py`）上，沒有帳號（keys-only 註冊，見 `docs/SELF_HOSTING.md`）的金鑰拿不到 token
  （`403 account_not_registered`）。
- **經過反向代理**：這兩支只收「對方位址在 `CHAT_TRUSTED_PROXIES` 裡、帶正確 `X-Aegis-Internal`（`CHAT_PROXY_TOKEN`）」的請求，只看 header 不夠；
  沒有反向代理的自架（`CHAT_TRUSTED_PROXIES=none`）不檢查。

## 5. 已知限制

- 新的群組主題（剛加入、**每一次換金鑰**）要等換 token 重連後才訂得到（App 偵測到範圍多了這張 token 沒有的主題，250ms 後換
  token；我的 presence tag 換了（換秘密）也是 250ms；只多了好友的 presence 主題則 2 秒 debounce；只**少了**群組主題或 presence 主題不換 token、
  直接退訂）。換的時候先拿新 token、舊連線照常收，再送
  DISCONNECT（沒有遺囑）用新 token 連回來。訂到之前別人發在新主題上的控制訊息，這台收不到（群組主題不是 retained、broker 也不替
  還沒訂的主題排隊）：狀態不受影響（名冊、金鑰都在群組 log 上，重連後一定補抓），掉的是那幾秒內的刪除／通話控制。離線跨過換金鑰的人
  同理：舊主題上排隊的換金鑰通知會到，新主題上的不會（見 `docs/GROUP_LOG_WIRING_W3.md` 的限制）。
- 群組主題超過 50 個：每個群目前這一代的主題在前（最近有動靜的優先，`rankScopeGroups`／`rankScopeTopics`），換金鑰後還在
  重疊期的上一代排在最後、最先犧牲；最不活躍的那幾個群收不到群組主題上的控制訊息，App 會記 log 並提示；那個群組有新訊息時會排回前 50。
- EMQX 只在**訂閱當下**檢查授權。持久 session（`clean: false`、24 小時）裡早先訂好的主題，換成範圍比較小的 token
  重連之後還在。App 自己把範圍外的群組主題退訂（範圍變了、每次連上時），App 重開時 broker 還留著 session 的，靠 localStorage 記著的清單
  退訂；被踢的人就算故意留著舊主題，也只看得到上一代主題上的東西 —— 換金鑰之後誠實的成員不在那裡發任何東西（只有結束那一代的
  換金鑰通知，它本來就要讓被踢的人知道），新一代的主題它推不出來。
- 自己接 EMQX `message_dropped` 之類的 webhook、從主題取收件人的話：收件箱主題是 `mist/user/<收件人>/inbox/<寄件人>`，收件人在**第 3 節**，
  不能假設主題以 `/inbox` 結尾。
- token 不看任何「帳號風險分數」：伺服器不會因為別人檢舉就拒發 token（一個人就能湊出多個檢舉帳號；斷線的代價遠大於漏鎖，見
  `api/chat/mqtt_auth.py` get_mqtt_token 的說明）。
- `acl` claim 預設是 EMQX ≥ 5.7 的規則格式（§3.1，5.8.9 實測過）；`CHAT_MQTT_ACL_FORMAT=legacy` 是舊格式（`pub`／`sub`／`all`，在
  EMQX 5.3.2 實測過，表達不了 retain）。
- **審查發現 H1 —— 已處理（W3 群組、W4 presence）**：token 的範圍還是 client 自己選、伺服器不查帳號關係，但兩半邊都不再靠它：
  群組控制訊息用目前這一代的群組金鑰加密＋寄件人身分金鑰簽章（W2，`group_sealed`），群組主題是那一代金鑰推出來的 tid
  （W3）—— 被踢的成員記得 gid 也沒用（gid 不是主題），推不出新一代的 tid，就算訂到舊主題也讀不到新一代的東西；名冊與群組資訊只在
  群組 log 的簽章鏈上。presence（W4）：主題的 tag 由只給好友的秘密推出來，payload 用同一個秘密加密、AAD 綁主題；token 只收確切的主題、
  沒有公鑰清單 —— 知道公鑰也訂不到、讀不到、偽造不了。還剩（README「伺服器還看得到什麼」）：broker 看得到誰訂了誰的 presence 主題（主題裡有主人的公鑰：
  好友關係對營運方還是看得見）、連線與斷線的時間；營運方能擋掉或延後任何一則（擋掉遺囑時好友頂多誤以為我在線 10 分鐘，TTL）。
  API 的營運方能用 token 回應裡的 `serverTime` 撥偏一支手機的時鐘：W5 起窗短的收端判斷（presence 的新鮮度與 TTL、群組的
  here／sync／通話控制、通話信令、presence 服務自己的計時）只採信 ±5 分鐘的時鐘差（`mqtt.boundedNow`），錄下來超過約 10 分鐘的
  「在線」或通話開始再也不會看起來還新；commit／delete（24 小時窗）與封給身分金鑰的信封（7 天窗，內容另由狀態鏈與 kc 判斷）照舊用
  校正後的時鐘，手機時鐘不準的人才收得到邀請、金鑰與刪除；時鐘差超過 5 分鐘時 App 顯示「手機時間不準」（clock-drift）。
  好友主題被（任何人）清掉之後，重放同一個主題上更早的狀態也不採用（每個主題記著最後採用的那一則）。
- **伺服器給得出任何形狀正確的主題**：token 的群組 id 只看是不是 22 個 URL-safe 字元、presence 只看是不是確切的主題 —— 任何帳號（例如被踢的人、
  Mallory）都能訂任何 tid 或別人的 presence 主題，拿到的只是密文與時間（W5 模擬 S2X／S8／P1 量過：一則都拆不開）。每個帳號
  24 小時內拿得到的不同群組＋presence 主題最多 `CHAT_TOKEN_TOPICS_PER_DAY`（預設 2000；一支正常的手機頂多幾百個，
  同一個主題重拿不重算）→ 超過 429 `mqtt_topic_quota`，猜主題的速度有上限（主題只存鹽雜湊、留 24 小時）。同一個帳號另外每天最多
  20 個自己的 presence tag（＝能 retain 的主題；超過就照發 token、但這張沒有 presence 發布權 —— 整張拒絕會讓一天刪／封鎖很多好友的人連不上）、
  10 個 clientId（＝持久 session，429 `mqtt_client_id_quota`）。
  chat 伺服器只發 token 給有帳號的金鑰（見上面「帳號」），所以上限按帳號算（換一把新金鑰不會重新計數）；另外每 IP 每分鐘最多 120 張
  token（IPv6 整個 /64 算一個）。
- **TODO（之後）**：換機時舊手機一收到資料傳完就清掉自己，沒有等新手機確認收到、解得開。

## 6. 套用後怎麼驗

1. 沒帶密碼、帶過期 token、帶別人 clientId 的 token 連線 → 都被拒（CONNACK 0x86／0x87）。
2. 用 A 的 token 發 `mist/user/<B>/inbox/<B>`（冒用 B 那一節）→ PUBACK 0x87，B 收不到；
   訂閱 `mist/user/<B>/inbox/+`、`mist/user/+/presence/+`、`mist/user/<B>/presence/<B 的 tag>`（token 沒列的）、`mist/group/+/+`、
   token 沒列的 `mist/group/<別的 tid>/+` → SUBACK 0x87；token 請求的 `groups` 帶 `+`、`#`、不是 22 字元的 id、`presence` 帶
   `mist/user/<B>/presence` 或萬用字元、帶 `peers` → 400／422（整張不發）。用 A 的 token 發 `mist/user/<B>/presence/<任何 tag>`、
   `mist/user/<A>/presence/<不是 A 的 tag>` → PUBACK 0x87。
3. 換機 token 發任何主題 → 0x87。
4. 用 App 的 token 發 retained 到 `mist/user/<B>/inbox/<我>` → PUBACK 0x87（規則格式；`legacy` 格式的站至少確認 retainer 的上限生效：
   `emqx ctl retainer info`）。`scripts/selfhost/selfhost_smoke.py --api <API>` 從外面把 1～4 跟踢裝置推播一起跑一遍（見 `docs/SELF_HOSTING.md`
   「Check your server」）。
5. 換一個 listener（例如直接連 ws 8083、或 tcp 1883 從外網）用沒有密碼／錯的 token 連 → 一樣被拒；`emqx ctl listeners`
   每一個的 `enable_authn` 都是 true。
6. App 端：`scripts/review/mqtt_token_acl_self_test.py`（API）、`scripts/review/mqtt_acl_scope_self_test.mjs`、
   `mqtt_token_lifecycle_self_test.mjs`、`mqtt_suback_refused_self_test.mjs`（client），以及 `scripts/sim` 的
   四支模擬手機（模擬 broker 照這份設定執行、範圍驗證與 ACL 直接跑 `api/chat/mqtt_auth.py mqtt_scope／mqtt_acl`，報告的 BROKER-ACL 要
   deniedPub = 0、deniedSub = 0，GROUP-TOPICS 要 0 findings：broker 看得到的地方沒有 gid、S2 被踢的那支沒訂到也沒收到之後的群組主題；
   PRESENCE 要 0 findings：每一個 presence 主題都是確切的秘密主題、payload（發布的、連線時留的遺囑、broker 替斷線的人發的遺囑）只有 `{n, c}`
   而且沒有任何公鑰、只有好友訂到／收到彼此的 presence，每一對好友兩個方向都收到過、App 都認定對方在線過、沒有一則拆不開，
   一把不是任何人好友的新金鑰拿只有公鑰的主題、萬用字元、`peers` 要 token 都被擋）。

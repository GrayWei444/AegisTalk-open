/**
 * 模擬伺服器 API（記憶體內）。只做群組／加好友流程會碰到的端點，格式照 chat 伺服器（api/chat/*，官方站由 api/main.py 掛載）。
 *
 * 跟正式站不同、刻意放寬的地方（報告會列）：
 *  - /api/fingerprint/check、/api/same-source/check：一律放行（同一台 Mac 開好幾個帳號）。
 *  - /api/mqtt/token 不要求帳號（＝官方站：AegisID 註冊在進聊天之後才在背景跑完；獨立的 chat 伺服器要求，見 chat_app_self_test.py）。
 * 帳號（開源計畫第 3 步，profile.accountsRequired）：帳號只從 POST /api/account/register 來（keys-only：身分金鑰簽
 *  {action: account_register, pubkey, timestamp, request_id}，request_id 不可重放；模擬是 open 政策）。模擬沒有 AegisID，
 *  這個端點就是帳號的唯一來源 —— 每支手機設定完由模擬照 App 的格式在頁面裡簽、送（phone.mjs registerAccount；client 的註冊畫面是第 5 步）。
 *  正式站「沒有帳號就 403」的端點全部照查：推播（寄件者；收件人沒帳號回 recipient_not_registered）、信任分數、裝置 claim、
 *  短碼 register／refresh、群組 log append —— App 只要在哪裡用了沒有帳號的金鑰，API-AUTH 就會抓到（以前這一類模擬看不到）。
 * 照正式站驗的地方：
 *  - /api/mqtt/token（群星、AegisTalk 都是）：Ed25519 簽章（排序過的 JSON，同 api/chat/signing.py verify_device_signature）、
 *    時間窗 ±300 秒、request_id 不可重放、clientId 前綴要是簽章者自己的公鑰；token 的 ACL 由 profiles.mjs 決定
 *    （兩邊都是正式站的窄 ACL）。AegisTalk 另外要求 groups／presence／client_id 一定要送（profile.tokenRequiresScope；W4 起沒有 peers，
 *    送了 → 422，跟正式站的 extra="forbid" 一樣）。
 *  - /api/mqtt/transfer-token：只能訂閱自己隨機收件箱的臨時身分，clientId＝username。
 *  - /api/shortcode/register|refresh（群星、AegisTalk 第 3 步起都是）：身分金鑰簽整份請求（request_signature）＋預備金鑰的
 *    X3DH 簽章、request_id 不可重放、要有帳號（api/chat/shortcode.py）。
 *  - AegisTalk（profile.serverAcl）：token 的範圍驗證與 ACL 直接跑 api/chat/mqtt_auth.py 的 mqtt_scope／mqtt_acl／mqtt_acl_claim
 *    （lib/server_acl.py；token 的 acl claim 是 EMQX ≥ 5.7 的規則清單：只有自己的 presence 主題能 retain，模擬 broker 照規則放行），
 *    不再用抄的一份（W3：群組主題 id 剛好 22 字元、+／#／長度不對 → 400，超過 50 個 → 422，跟伺服器一樣整張拒絕）；
 *    kick 主題只給 /api/devices/claim 登記過的那台（＝伺服器的 talk_active_device），登記的是別台 → 403 device_replaced；
 *    時鐘差 → 401 {code: clock_skew, server_time}；回應帶 subscribe／serverTime。
 *  - 群組 log（POST／GET /api/group-log/{gid}）：儲存、排序、額度跑真的 api/group_log_routes.py（lib/groupLogServer.mjs），
 *    append 照正式站驗帳號簽章（不查 AegisID 帳號）；被拒的記在 rejected（API-AUTH）。
 *  - AegisTalk 的 /api/push/*（profile.signedPushTrust，2026-10-19 移植群星 A5）：
 *    帳戶 Ed25519 簽章、action 對、時間窗 ±300 秒、request_id 不可重放；推播提示只准 type／isVideoCall（多送欄位
 *    ＝正式站 422）。不合格的記在 rejected（run.mjs 的 API-AUTH 檢查：一筆都不該有）。
 *    正式站另外要求寄件者有 AegisID 帳號 —— 模擬關了刷臉、沒有帳號，這一條不查。
 *  - 只有官方版用的端點（profile.officialRoutes，私有的 profiles-official.mjs）：同一套 json／bump／signed 工具。
 *  - W5：handle 的 who ＝ 發請求的那一支（label）。isAdversary(who)（Mallory、Bob 的影子連線）的被拒請求另外記在 adversaryRejected，
 *    不算進 App 的 rejected（API-AUTH 只判 App）；群組 log 的 GET 把 who 交給 groupLogServer（營運方給不同的人看不同的 log）。
 *  - W5：serverTimeSkew（label → ms）＝ 營運方對這一支說謊的時鐘：token 回應的 serverTime、時鐘差的 server_time 都照它說，
 *    App 用 serverNow（＝它說的時間）簽的請求 —— token、群組 log —— 的時間窗也照它判（說謊的人自己前後一致）。
 *    開源第 4 步：推播、信任分數也用 serverNow 簽（mqtt.signedClock）→ 一樣照它判；差 300 秒以上回 401 clock_skew（附這一支聽到的
 *    伺服器時間，＝ chat.signing.check_clock），App 重簽一次。clock_skew 記在 clockSkewed（不是拒收：App 照規矩重簽就好）。
 *    社群版（profile.pushHintTypes）只收 message、incoming_call 兩種推播（＝ chat 伺服器 CHAT_PUSH_TYPES，多的 → 422）。
 *    開源第 5d 步：來電的提示可以多帶 ringToken（來電者簽的響鈴 token）—— 照 api/chat/push.py ring_token_ok 驗：外形、claims 的唯一
 *    寫法、from ＝ 簽章者、to ＝ 收件人、±300 秒（照這一支聽到的伺服器時間）、簽章；不合格 → 422（記在 rejected）。pushes 記下 token，
 *    情境拿真的 token 餵給收件那支手機的 JS 那一條路（ringDecision）。
 *    POST /api/push/webpush/register、GET /api/chat/server-config 照 chat 伺服器（模擬的瀏覽器擋了 service worker，正常不會打到）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { receiveOnlyAcl } from './profiles.mjs';

const SERVER_ACL_PY = fileURLToPath(new URL('./server_acl.py', import.meta.url));

/**
 * 伺服器的 ACL 計算（api/chat/mqtt_auth.py 的 mqtt_acl，經 server_acl.py）。req 見 server_acl.py。
 * 每次一個 python 行程（token 請求一輪模擬才幾十次）；SIM_PYTHON 可指定直譯器。
 */
export function serverAclFrom(mqttAuthPy) {
  if (!fs.existsSync(mqttAuthPy)) throw new Error(`server ACL source not found: ${mqttAuthPy} (remote-run.sh ships api/chat)`);
  return (req) => JSON.parse(execFileSync(process.env.SIM_PYTHON || 'python3', ['-I', SERVER_ACL_PY, mqttAuthPy],
    { input: JSON.stringify(req) + '\n', encoding: 'utf8', timeout: 20_000 }));
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
/** 響鈴 token（＝ api/chat/push.py 的 RING_TOKEN_RE／RING_CLAIMS_RE） */
const RING_TOKEN_RE = /^r1\.([A-Za-z0-9_-]{40,800})\.([A-Za-z0-9_-]{86})$/;
const RING_CLAIMS_RE = new RegExp('^\\{"v":1,"d":"([a-z0-9][a-z0-9-]{2,39})","callId":"([A-Za-z0-9_-]{22})",'
  + '"from":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)","to":"([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)",'
  + '"iat":([1-9][0-9]{0,15}),"nonce":"([A-Za-z0-9_-]{22})","video":(true|false)\\}$');

/** api/chat/push.py ring_token_ok：寄件者自己簽的、寄給這個收件人、±300 秒、只有一種寫法 */
export function ringTokenOk(token, sender, recipient, nowMs) {
  if (typeof token !== 'string' || token.length > 1024) return false;
  const m = RING_TOKEN_RE.exec(token);
  if (!m) return false;
  const claims = Buffer.from(m[1], 'base64url');
  const sig = Buffer.from(m[2], 'base64url');
  if (claims.toString('base64url') !== m[1] || sig.toString('base64url') !== m[2] || sig.length !== 64) return false;
  const c = RING_CLAIMS_RE.exec(claims.toString('latin1'));
  if (!c || c[3] !== sender || c[4] !== recipient || Math.abs(nowMs - Number(c[5])) > 300_000) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(sender, 'base64')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(c[1] + ':'), claims]), key, sig);
  } catch {
    return false;
  }
}
const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

export function topicUser(pubkeyB64) {
  return Buffer.from(pubkeyB64, 'base64').toString('base64url');
}

/** 模擬「時間過了很久」時（S6 把手機時鐘往後撥），伺服器的時鐘也一起平移 */
let clockOffsetMs = 0;
export function setClockOffset(ms) { clockOffsetMs = ms; }

function verifySig(pubkeyB64, sigB64, payload, skewMs = 0) {
  try {
    const pk = Buffer.from(pubkeyB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pk.length !== 32 || sig.length !== 64) return false;
    if (pk.toString('base64') !== pubkeyB64 || sig.toString('base64') !== sigB64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: 'der', type: 'spki' });
    const ts = payload.timestamp;
    if (typeof ts !== 'number' || Math.abs((Date.now() + clockOffsetMs + skewMs) / 1000 - ts) > 300) return false;
    return crypto.verify(null, Buffer.from(JSON.stringify(canonical(payload)), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

export function encodeToken(claims) {
  return 'sim.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
}
export function decodeToken(token) {
  if (typeof token !== 'string' || !token.startsWith('sim.')) return null;
  try { return JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8')); } catch { return null; }
}

export function createMockApi({ log, profile, serverAcl = null, groupLog = null, isAdversary = () => false }) {
  const pre = profile.clientIdPrefix;
  const clientIdRe = new RegExp(`^${pre}[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{1,8}$`);
  const shortcodes = new Map();   // code → { public_key, signed_pre_key, signature, display_name, expires_at }
  const nonces = new Set();
  const counts = new Map();       // "METHOD path" → n
  const unmocked = new Map();
  const tokenScopes = new Map();  // username → last { groups, presence }（群星：peers）
  const rejectedApp = new Map();  // "METHOD path reason" → n（App 送了正式站會拒絕的請求）
  const clockSkewed = new Map();  // "METHOD path" → n（401 clock_skew：App 該用伺服器時間重簽一次；開源第 4 步）
  const adversaryRejected = new Map();   // 同上，攻擊者送的（W5：刻意的，另外報）
  const pushes = [];              // 驗過的推播 { from, to, hint }
  const webpushSubs = new Map();  // endpoint → pubkey（POST /api/push/webpush/register）
  const deviceClaims = new Map(); // pubkey → 帳號的活躍裝置（/api/devices/claim；= 伺服器 talk_active_device）
  const accounts = new Map();     // pubkey → 帳號（POST /api/account/register；= 伺服器 pubkey_account_map）
  const accountLog = [];          // { who, pubkey, created, invite }
  /** 社群版（profile.registration === 'invite'，＝ api/chat/accounts.py 的 invite 政策）：邀請碼 → 剩幾次 */
  const invites = new Map();
  const invitePolicy = profile.registration === 'invite';
  const nowS = () => Math.floor((Date.now() + clockOffsetMs) / 1000);
  const serverTimeSkew = new Map();   // label → ms（W5 P2：營運方對某一支說謊的時鐘）
  const skewOf = (who) => (who ? serverTimeSkew.get(who) ?? 0 : 0);

  const json = (status, body) => ({ status, body: JSON.stringify(body), contentType: 'application/json' });
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // 只有官方版用的端點（私有的 profiles-official.mjs；社群版與公開的 repo 沒有）
  const officialRoute = profile.officialRoutes ? profile.officialRoutes({ json, bump, signed }) : null;

  function mqttToken(body, rejected, who) {
    const skew = skewOf(who);
    const nowW = () => nowS() + Math.round(skew / 1000);
    const { signature, ...signed } = body;
    if (profile.tokenRequiresScope && (!Array.isArray(body.groups) || !Array.isArray(body[profile.presenceField]) || typeof body.client_id !== 'string')) {
      return json(422, { detail: `groups, ${profile.presenceField} and client_id are required` });
    }
    if (profile.clockSkewDetail && typeof body.timestamp === 'number' && Math.abs(nowW() - body.timestamp) > 300) {
      return json(401, { detail: { code: 'clock_skew', server_time: nowW() } });
    }
    if (!verifySig(body.pubkey, signature, signed, skew)) return json(401, { detail: 'invalid_signature_or_timestamp' });
    if (signed.action !== 'mqtt_token') return json(401, { detail: 'invalid_signature_or_timestamp' });
    const nk = 'mqtt:' + body.pubkey + ':' + body.request_id;
    if (nonces.has(nk)) return json(409, { detail: 'request_replayed' });
    nonces.add(nk);
    const groups = [...new Set(body.groups || [])];
    const rawPeers = [...new Set(body.peers || [])];
    // 群星（沒有 serverAcl）：照它伺服器的格式自己驗；AegisTalk：下面整個交給 api/chat/mqtt_auth.py mqtt_scope
    if (!serverAcl) {
      if (groups.length > 50 || groups.some((g) => !GROUP_ID_RE.test(g))) return json(400, { detail: 'invalid_acl_groups' });
      if (rawPeers.length > 150) return json(400, { detail: 'invalid_acl_peers' });
      if (body.device_id != null && !DEVICE_ID_RE.test(body.device_id)) return json(400, { detail: 'invalid_acl_device_id' });
    }
    const username = topicUser(body.pubkey);
    if (body.client_id != null && !(clientIdRe.test(body.client_id) && body.client_id.slice(pre.length, pre.length + 16) === username.slice(0, 16))) {
      return json(400, { detail: 'invalid_client_id' });
    }
    // kick 主題：伺服器 mqtt_kick_device —— 帳號的活躍裝置就是這台才給；活躍裝置是別台 → 403；還沒 claim → 不給
    let kickDevice = body.device_id ?? null;
    if (profile.kickNeedsClaim) {
      const claimed = deviceClaims.get(body.pubkey);
      if (claimed !== undefined && claimed !== body.device_id) return json(403, { detail: 'device_replaced' });
      kickDevice = claimed !== undefined ? body.device_id : null;
    }
    const exp = nowS() + 3600;
    let acl;
    let claimAcl;
    if (serverAcl) {
      // 多的欄位（extra="forbid"）也由伺服器的欄位表判斷（api/chat/mqtt_auth.py MQTT_TOKEN_REQUEST_FIELDS）：這裡只交出欄位名
      const out = serverAcl({ pubkey: body.pubkey, groups: body.groups ?? [], presence: body.presence ?? null, presence_tag: body.presence_tag ?? null,
        fields: Object.keys(body), raw_device_id: body.device_id ?? null, device_id: kickDevice });
      if (out.error) {
        bump(rejected, `POST /api/mqtt/token ${out.error.detail}`);
        return json(out.error.status, { detail: out.error.detail });
      }
      acl = out.acl;
      claimAcl = out.claim ?? out.acl;   // token 的 acl claim（伺服器 mqtt_acl_claim 的格式）；回應的 subscribe 照舊是 acl.sub
    } else {
      acl = profile.acl(username, groups, rawPeers.map(topicUser), kickDevice);
      claimAcl = acl;
    }
    const claims = { sub: username, username, exp, iss: 'aegisrd-sim', acl: claimAcl };
    if (body.client_id != null) claims.clientid = body.client_id;
    const presenceCount = serverAcl ? (body.presence ?? []).length : rawPeers.length;
    tokenScopes.set(username, { groups, presence: presenceCount, tag: body.presence_tag ?? null });
    log('api', `mqtt token for ${username.slice(0, 10)} groups=[${groups.join(',')}] ${serverAcl ? 'presence' : 'peers'}=${presenceCount}${serverAcl ? ` tag=${body.presence_tag ? 'y' : 'n'}` : ''} device=${body.device_id ? 'y' : 'n'} kick=${kickDevice ? 'y' : 'n'}${serverAcl ? ' (server ACL)' : ''}`);
    return json(200, { token: encodeToken(claims), expiresAt: exp, username, subscribe: acl.sub, serverTime: nowW() });
  }

  /** 這把金鑰有沒有帳號（profile.accountsRequired 才查；沒有 ＝ 每把金鑰都算有） */
  const hasAccount = (pubkey) => !profile.accountsRequired || accounts.has(pubkey);

  /** = api/chat/signing.py make_signed_account：簽章（401）＋帳號（403，profile.accountsRequired）＋ request_id 不重放（409） */
  function signed(body, action, key, rejected, who = null) {
    const { signature, ...rest } = body;
    const reject = (status, reason) => { bump(rejected, `${key} ${reason}`); return json(status, { detail: reason }); };
    if (typeof body.request_id !== 'string' || body.request_id.length < 16) return reject(422, 'request_id');
    // 推播／信任分數（開源第 4 步）：App 用校正到伺服器的時鐘簽 → 照這一支聽到的伺服器時間判；差太多 → clock_skew（驗簽之前，見檔頭）
    const skew = profile.clockSkewDetail ? skewOf(who) : 0;   // 別的 App（群星）照舊用本機時鐘簽推播
    const nowW = nowS() + Math.round(skew / 1000);
    if (profile.clockSkewDetail && (typeof body.timestamp !== 'number' || Math.abs(nowW - body.timestamp) > 300)) {
      bump(clockSkewed, key);
      return json(401, { detail: { code: 'clock_skew', server_time: nowW } });
    }
    if (rest.action !== action || !verifySig(body.pubkey, signature, rest, skew)) return reject(401, 'invalid_signature_or_timestamp');
    if (!hasAccount(body.pubkey)) return reject(403, 'account_not_registered');
    const nk = `${action}:${body.pubkey}:${body.request_id}`;
    if (nonces.has(nk)) return reject(409, 'request_replayed');
    nonces.add(nk);
    return null;
  }

  /**
   * POST /api/account/register（= api/chat/accounts.py，open 政策）：身分金鑰簽 {action, pubkey, timestamp, request_id}；
   * 已經有帳號 → created false；request_id 不可重放
   */
  function registerAccount(body, rejected, who) {
    const key = 'POST /api/account/register';
    const extra = Object.keys(body).filter((k) => !['action', 'pubkey', 'timestamp', 'request_id', 'invite_code', 'signature'].includes(k));
    if (extra.length) { bump(rejected, `${key} extra:${extra.join(',')}`); return json(422, { detail: 'extra_forbidden' }); }
    const { signature, ...rest } = body;
    const payload = { action: 'account_register', pubkey: rest.pubkey, timestamp: rest.timestamp, request_id: rest.request_id,
      ...(rest.invite_code !== undefined ? { invite_code: rest.invite_code } : {}) };
    if (typeof body.request_id !== 'string' || body.request_id.length < 16) { bump(rejected, `${key} request_id`); return json(422, { detail: 'request_id' }); }
    if (!verifySig(body.pubkey, signature, payload, skewOf(who))) { bump(rejected, `${key} invalid_signature_or_timestamp`); return json(401, { detail: 'invalid_signature_or_timestamp' }); }
    const nk = `account_register:${body.pubkey}:${body.request_id}`;
    if (nonces.has(nk)) { bump(rejected, `${key} request_replayed`); return json(409, { detail: 'request_replayed' }); }
    nonces.add(nk);
    const created = !accounts.has(body.pubkey);
    // invite 政策（＝ accounts.register_account 的順序：已經有帳號 → 直接成功；新帳號要有效的邀請碼，扣一次）。
    //   App 照規矩不會送錯：被拒的記在 rejected（API-AUTH）
    if (created && invitePolicy) {
      if (!body.invite_code) { bump(rejected, `${key} invite_required`); return json(403, { detail: 'invite_required' }); }
      const left = invites.get(body.invite_code) ?? 0;
      if (left <= 0) { bump(rejected, `${key} invalid_invite`); return json(403, { detail: 'invalid_invite' }); }
      invites.set(body.invite_code, left - 1);
    }
    if (created) accounts.set(body.pubkey, 'chat_' + crypto.randomBytes(8).toString('hex'));
    accountLog.push({ who, pubkey: body.pubkey, created, invite: !!body.invite_code });
    log('api', `account register ${who ?? '?'} ${body.pubkey.slice(0, 8)} created=${created}${invitePolicy ? ` invite=${body.invite_code ? 'y' : 'n'}` : ''}`);
    return json(200, { registered: true, created, registration: invitePolicy ? 'invite' : 'open' });
  }

  function pushNotify(body, rejected, who) {
    const key = 'POST /api/push/notify';
    const hint = body.notificationHint;
    const extra = hint && typeof hint === 'object' ? Object.keys(hint).filter((k) => !['type', 'isVideoCall', 'ringToken'].includes(k)) : ['?'];
    if (extra.length || !(profile.pushHintTypes ?? ['message', 'incoming_call', 'guardian_alert', 'check_in']).includes(hint?.type)
        || (hint.isVideoCall !== undefined && typeof hint.isVideoCall !== 'boolean')) {
      bump(rejected, `${key} hint:${extra.join(',') || hint?.type}`);
      return json(422, { detail: 'invalid notificationHint' });
    }
    if (hint.ringToken !== undefined && hint.type !== 'incoming_call') {
      bump(rejected, `${key} ring_token_not_allowed`);
      return json(422, { detail: 'ring_token_not_allowed' });
    }
    const bad = signed(body, 'push_notify', key, rejected, who);
    if (bad) return bad;
    if (hint.ringToken !== undefined
        && !ringTokenOk(hint.ringToken, body.pubkey, body.recipient_pubkey, (nowS() + Math.round((profile.clockSkewDetail ? skewOf(who) : 0) / 1000)) * 1000)) {
      bump(rejected, `${key} invalid_ring_token`);
      return json(422, { detail: 'invalid_ring_token' });
    }
    if (!hasAccount(body.recipient_pubkey)) return json(200, { success: false, reason: 'recipient_not_registered' });
    pushes.push({ from: body.pubkey, to: body.recipient_pubkey, hint });
    log('api', `push ${hint.type} ${body.pubkey.slice(0, 8)} → ${String(body.recipient_pubkey).slice(0, 8)}`);
    return json(200, { success: false, reason: 'no_token' });   // 模擬裡沒有手機註冊 FCM
  }

  /** POST /api/push/webpush/register（= api/chat/push.py register_webpush）：欄位照伺服器（多的 → 422）、帳戶簽章 */
  function webpushRegister(body, rejected, who) {
    const key = 'POST /api/push/webpush/register';
    const extra = Object.keys(body).filter((k) => !['action', 'pubkey', 'endpoint', 'p256dh', 'auth', 'timestamp', 'request_id', 'signature'].includes(k));
    if (extra.length) { bump(rejected, `${key} extra:${extra.join(',')}`); return json(422, { detail: 'extra_forbidden' }); }
    const bad = signed(body, 'webpush_register', key, rejected, who);
    if (bad) return bad;
    webpushSubs.set(body.endpoint, body.pubkey);
    return json(200, { success: true });
  }

  function transferToken() {
    const now = nowS();
    const username = 'transfer_' + crypto.randomBytes(24).toString('base64url');
    const out = serverAcl ? serverAcl({ username, receive_only: true }) : null;
    const acl = out ? out.acl : receiveOnlyAcl(profile, username);
    const claims = { sub: username, username, clientid: username, exp: now + 300, iat: now, iss: 'aegisrd-sim', acl: out?.claim ?? acl };
    log('api', `transfer token ${username.slice(0, 16)}`);
    return json(200, { token: encodeToken(claims), expiresAt: now + 300, username, subscribe: acl.sub, serverTime: now });
  }

  function shortcode(body, refresh, rejected, who) {
    if (profile.shortcodeSigned) {
      const action = refresh ? 'refresh_shortcode' : 'register_shortcode';
      const key = `POST /api/shortcode/${refresh ? 'refresh' : 'register'}`;
      const reject = (status, reason) => { bump(rejected, `${key} ${reason}`); return json(status, { detail: reason }); };
      const { request_signature, ...rest } = body;
      const payload = { action, public_key: rest.public_key, signed_pre_key: rest.signed_pre_key, signature: rest.signature,
        display_name: rest.display_name, timestamp: rest.timestamp, request_id: rest.request_id };
      // App 用 serverNow 簽（FriendCode → signedShortCodeRequest）：說謊的營運方照自己說的時間判
      if (!verifySig(body.public_key, request_signature, payload, skewOf(who))) return reject(401, 'invalid_shortcode_signature');
      try {
        const k = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(body.public_key, 'base64')]), format: 'der', type: 'spki' });
        if (!crypto.verify(null, Buffer.from(body.signed_pre_key, 'base64'), k, Buffer.from(body.signature, 'base64'))) {
          return reject(401, 'invalid_prekey_signature');
        }
      } catch {
        return reject(401, 'invalid_prekey_signature');
      }
      if (!hasAccount(body.public_key)) return reject(403, 'account_not_registered');
      // 伺服器（pydantic）：request_id 必填、16～128 字元 → 422
      if (typeof rest.request_id !== 'string' || rest.request_id.length < 16 || rest.request_id.length > 128) return reject(422, 'request_id');
      const nk = `${action}:${body.public_key}:${rest.request_id}`;
      if (nonces.has(nk)) return reject(409, 'request_replayed');
      nonces.add(nk);
    } else {
      // AegisTalk 正式站（ShortCodeRegisterRequest）只看欄位長度，不驗任何簽章
      const okLen = (s, min, max = 10_000) => typeof s === 'string' && s.length >= min && s.length <= max;
      if (!okLen(body.public_key, 10) || !okLen(body.signed_pre_key, 10) || !okLen(body.signature, 10) || !okLen(body.display_name, 1, 50)) {
        return json(422, { detail: 'invalid shortcode request' });
      }
    }
    const now = Math.floor((Date.now() + clockOffsetMs) / 1000);
    let code = null;
    if (!refresh) {
      for (const [c, v] of shortcodes) if (v.public_key === body.public_key && v.expires_at > now) code = c;
    } else {
      for (const [c, v] of shortcodes) if (v.public_key === body.public_key) shortcodes.delete(c);
    }
    const isNew = !code;
    if (!code) {
      do { code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(''); } while (shortcodes.has(code));
    }
    const prev = shortcodes.get(code);
    const expires = prev?.expires_at ?? now + 86400;
    shortcodes.set(code, { public_key: body.public_key, signed_pre_key: body.signed_pre_key, signature: body.signature, display_name: body.display_name, expires_at: expires });
    log('api', `shortcode ${refresh ? 'refresh' : 'register'} ${body.display_name} → ${code}`);
    return json(200, { short_code: code, expires_at: expires, remaining_seconds: expires - now, is_new: isNew });
  }

  function lookup(code) {
    const cleaned = decodeURIComponent(code).trim().toUpperCase().replace(profile.codePrefix, '');
    const row = shortcodes.get(cleaned);
    if (!row || row.expires_at <= Date.now() / 1000) return json(404, { detail: 'Short code not found or expired' });
    return json(200, { v: 1, pk: row.public_key, spk: row.signed_pre_key, sig: row.signature, name: row.display_name, expires_at: row.expires_at });
  }

  /**
   * 群組 log（api/group_log_routes.py，經 groupLogServer → group_log_bridge.py 跑真的程式）：POST 驗帳號簽章、
   * 照 routes 的額度與大小上限；被拒的記進 rejected（API-AUTH 一筆都不該有）。
   */
  async function groupLogRoute(method, pathname, search, bodyText, rejected, who) {
    const key = `${method} /api/group-log/:gid`;
    bump(counts, key);
    const out = await groupLog.handle(method, pathname, search, bodyText, who, skewOf(who));
    if (out?.reason) bump(rejected, `${key} ${out.reason}`);
    if (method === 'POST') log('api', `group-log append ${pathname.split('/').pop().slice(0, 8)} → ${out.status}${out.reason ? ' ' + out.reason : ''}`);
    return out ? { status: out.status, body: out.body, contentType: out.contentType } : null;
  }

  /** 回傳 null ＝ 沒有這個端點的模擬（呼叫端回 404 並記下來）；群組 log 回 Promise。who ＝ 發請求的那一支（label，W5） */
  function handle(method, pathname, bodyText, search = '', who = null) {
    const rejected = who && isAdversary(who) ? adversaryRejected : rejectedApp;
    if (groupLog && pathname.startsWith('/api/group-log/')) return groupLogRoute(method, pathname, search, bodyText, rejected, who);
    let body = {};
    if (bodyText) { try { body = JSON.parse(bodyText); } catch { body = {}; } }
    const key = `${method} ${pathname.replace(/\/lookup\/.*/, '/lookup/:code')}`;
    bump(counts, key);
    if (method === 'POST' && pathname === '/api/mqtt/token') return mqttToken(body, rejected, who);
    if (method === 'POST' && pathname === '/api/mqtt/transfer-token') return transferToken();
    if (method === 'POST' && pathname === '/api/account/register' && profile.accountsRequired) return registerAccount(body, rejected, who);
    if (method === 'POST' && pathname === '/api/shortcode/register') return shortcode(body, false, rejected, who);
    if (method === 'POST' && pathname === '/api/shortcode/refresh') return shortcode(body, true, rejected, who);
    if (method === 'GET' && pathname.startsWith('/api/shortcode/lookup/')) return lookup(pathname.slice('/api/shortcode/lookup/'.length));
    if (method === 'POST' && pathname === '/api/push/notify') {
      return profile.signedPushTrust ? pushNotify(body, rejected, who) : json(200, { success: true, sim: 'no push in simulation' });
    }
    if (method === 'POST' && pathname === '/api/push/webpush/register' && profile.signedPushTrust) return webpushRegister(body, rejected, who);
    // ＝ api/chat/server_config.py（社群版：ChatAuthScreen 第一步就打這支，broker 網址從這裡拿；官方站回 external）
    if (method === 'GET' && pathname === '/api/chat/server-config') {
      return json(200, { service: 'aegistalk-chat', api_version: 1, mqtt_url: profile.brokerUrl, stun_urls: [], vapid_public_key: null,
        push: { webpush: false, fcm: false, types: profile.pushHintTypes ?? ['message', 'incoming_call'] }, backup: { server: false },
        registration: profile.registration ?? (profile.accountsRequired ? 'external' : 'open'), name: profile.chatServer?.name ?? null, links: {} });
    }
    if (method === 'POST' && pathname === '/api/push/register-token') {
      return profile.signedPushTrust ? (signed(body, 'push_register', 'POST /api/push/register-token', rejected, who) ?? json(200, { success: true }))
        : json(200, { success: true });
    }
    if (method === 'POST' && pathname === '/api/fingerprint/check') return json(200, { risk_level: 'low', risk_score: 0, reasons: [], allowed: true });
    if (method === 'POST' && pathname === '/api/same-source/check') return json(200, { risk_level: 'low', allowed: true, recent_registrations: 0, reasons: [] });
    if (method === 'POST' && pathname === '/api/devices/claim') {
      // 模擬不驗 claim 的簽章（正式站驗），只記下帳號目前的活躍裝置（AEGIS_E2E_TEST 模式下 App 根本不 claim）；沒帳號照正式站 403
      if (!hasAccount(body.pubkey)) { bump(rejected, 'POST /api/devices/claim account_not_registered'); return json(403, { detail: 'account_not_registered' }); }
      if (profile.kickNeedsClaim && typeof body.pubkey === 'string' && typeof body.device_id === 'string') deviceClaims.set(body.pubkey, body.device_id);
      return json(200, { success: true, kicked_previous: false });
    }
    if (method === 'POST' && pathname === '/api/devices/heartbeat') return json(200, { success: true, active: true });
    const official = officialRoute?.(method, pathname, body, rejected, who, profile);
    if (official) return official;
    counts.delete(key);
    bump(unmocked, key);
    return null;
  }

  /** 群組 log 的帳號（groupLogServer 的 accountOf）：有帳號 → 帳號 id；沒有 → null（不查帳號的 profile：公鑰本身） */
  const accountOf = (pubkey) => (profile.accountsRequired ? accounts.get(pubkey) ?? null : pubkey);
  /** 營運方發一個邀請碼（＝ python -m chat.invites create --uses n）；回傳碼本身 */
  const createInvite = (uses = 1) => { const code = crypto.randomBytes(18).toString('base64url'); invites.set(code, uses); return code; };
  return { handle, counts, unmocked, shortcodes, tokenScopes, rejected: rejectedApp, adversaryRejected, pushes, deviceClaims, serverTimeSkew,
    accounts, accountLog, accountOf, clockSkewed, webpushSubs, createInvite, invites };
}

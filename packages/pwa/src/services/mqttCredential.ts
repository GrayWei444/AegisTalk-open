/**
 * MQTT 連線憑證（對應群星 A8／B18；伺服器端見 api/chat/mqtt_auth.py get_mqtt_token／get_mqtt_transfer_token）。
 *
 * - token 由**已解鎖的帳戶金鑰**簽署請求才拿得到（以前只送 pubkeyHash，任何人都能替任何人拿）。
 * - token 自帶 ACL：只能發布到自己那一節、只能訂閱自己的收件箱、簽過名的群組主題與好友 presence、本機 kick 主題。
 *   群組主題 id（W3，docs/GROUP_LOG_WIRING_W3.md）＝每個群目前這一代金鑰推出來的 tid（groupControl.deriveTopicId），
 *   不是群組 id：gid 不上 broker、也不進 token 請求。
 *   presence（W4，docs/GROUP_LOG_WIRING_W4.md）：不再送公鑰清單（peers）—— 送確切的好友 presence 主題
 *   mist/user/<他>/presence/<tag>（tag 只有好友知道，presenceSecret.ts）與我自己的 tag（發布權）；沒有萬用字元、沒有只靠公鑰就推得出來的主題。
 *   伺服器把 sub 清單原樣回在 subscribe（credentialSubscribeTopics）：mqtt.ts 只訂閱這張 token 給得起的主題，不讓 broker 拒絕。
 * - clientId 綁在 token 上（JWT `clientid` claim）：mist_<公鑰前 16>_<deviceId 前 8>；換機的臨時身分由伺服器指定。
 * - 伺服器是執行期選的那一台（開源第 5c 步，services/apiBase.ts）：沒有寫死的 API 網址。
 */
import { apiBase } from './apiBase';
import { serverPickRequested } from './connectPolicy';

export interface MqttCredential {
  token: string;
  /** 秒（伺服器時間） */
  expiresAt: number;
  /** MQTT CONNECT 的 username（broker 核對 JWT 的 username claim）＝URL-safe 公鑰，或換機的 transfer_… */
  username: string;
  /** 這張 token 能訂閱的主題（＝JWT acl 的 sub）。kick 主題只有帳號的活躍裝置才有，client 猜不到，以伺服器為準 */
  subscribe?: string[];
  /** 伺服器現在幾秒：校正時鐘用 */
  serverTime?: number;
}

/** 已解鎖身分的簽署函式（不保存私鑰 bytes） */
export interface IdentitySigner {
  publicKey: string;
  sign: (data: Uint8Array) => Uint8Array;
}

/**
 * token 的訂閱範圍：群組主題 id（tid，22 字元）、好友的 presence 主題（確切的 mist/user/<他>/presence/<tag>）、
 * 我自己的 presence tag（發布權；null ＝ 還沒有，token 沒有任何 presence 發布權）
 */
export interface AclScope {
  groups: string[];
  presence: string[];
  presenceTag: string | null;
}

/** 伺服器上限（api/chat/mqtt_auth.py MQTT_ACL_MAX_GROUPS／MQTT_ACL_MAX_PRESENCE）：超過整張 token 被拒 */
export const MAX_ACL_GROUPS = 50;
export const MAX_ACL_PRESENCE = 150;
/** 群組主題 id（＝api/chat/mqtt_auth.py MQTT_GROUP_TOPIC_RE）：剛好 22 個 URL-safe 字元，沒有 + # /（萬用字元、多一層主題） */
const GROUP_TOPIC_RE = /^[A-Za-z0-9_-]{22}$/;
/** presence 的 tag（＝api/chat/mqtt_auth.py MQTT_PRESENCE_TAG_RE） */
const PRESENCE_TAG_RE = /^[A-Za-z0-9_-]{22}$/;
/**
 * 好友的 presence 主題（＝api/chat/mqtt_auth.py MQTT_PRESENCE_TOPIC_RE）：mist/user/<URL-safe 公鑰（43 字元，最後一字元沒用到的兩個位元是 0）>/presence/<tag>。
 * 只收這個確切的形狀：+、#、多一層、舊的 mist/user/<他>/presence（只要知道公鑰就能訂）一律不送 —— 伺服器會整張拒絕
 */
const PRESENCE_TOPIC_RE = /^mist\/user\/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]\/presence\/[A-Za-z0-9_-]{22}$/;
/**
 * 32 bytes 公鑰的**標準** base64（＝api/chat/signing.py is_pubkey_b64）：44 字元、標準字母表、一個 '='，而且最後一個資料字元
 * 沒用到的兩個位元是 0。同一把金鑰還有其他寫法（改那兩個位元），收件端只認這一種 —— 否則換個寫法就對不上封鎖名單、
 * 變成另一個「好友」（審查 MEDIUM）。
 */
const CANONICAL_PUBKEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isCanonicalPubkey(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_PUBKEY_RE.test(value);
}

export function isGroupTopicId(value: unknown): value is string {
  return typeof value === 'string' && GROUP_TOPIC_RE.test(value);
}

export function isPresenceTag(value: unknown): value is string {
  return typeof value === 'string' && PRESENCE_TAG_RE.test(value);
}

export function isPresenceTopic(value: unknown): value is string {
  return typeof value === 'string' && PRESENCE_TOPIC_RE.test(value);
}

/** Base64 → URL-safe、去 padding（MQTT 主題裡 + / 有特殊意義） */
export function toUrlSafeBase64(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 跟伺服器 `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 一字不差的 JSON：
 * key 依 code point 排序（不用 localeCompare —— 那是語系排序，跟 Python 不一定一樣）、遞迴。
 */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, nested]) => [k, sortKeys(nested)]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

export function validDeviceId(deviceId: string | null | undefined): deviceId is string {
  return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId);
}

/** 一般連線的 clientId（Phase 27：含 deviceId，同帳號不同裝置不互相接手 session） */
export function mqttClientId(publicKeyBase64: string, deviceId: string | null | undefined): string {
  return `mist_${toUrlSafeBase64(publicKeyBase64).slice(0, 16)}_${(deviceId ?? 'default').slice(0, 8)}`;
}

/**
 * 整理成伺服器收得下的範圍：格式不對的丟掉，超過上限的截掉**後面的**（呼叫端把重要的排前面：群組主題見 rankScopeTopics），
 * 再排序成固定的範圍鍵。
 * 審查 MEDIUM：以前群組先照 id 排序再截 —— id 是 group-<建立時間>，留下的是最舊的 50 個，新加入的群組全部收不到成員異動。
 */
export function normalizeAclScope(groups: string[], presence: string[], presenceTag: string | null): AclScope {
  const g = [...new Set(groups.filter(isGroupTopicId))].slice(0, MAX_ACL_GROUPS).sort();
  const p = [...new Set(presence.filter(isPresenceTopic))].slice(0, MAX_ACL_PRESENCE).sort();
  return { groups: g, presence: p, presenceTag: isPresenceTag(presenceTag) ? presenceTag : null };
}

/** 超過上限、這張 token 訂不到的群組主題／好友 presence 各有幾個（有效、不重複的才算） */
export function aclScopeOverflow(groups: string[], presence: string[]): { groups: number; presence: number } {
  return {
    groups: Math.max(0, new Set(groups.filter(isGroupTopicId)).size - MAX_ACL_GROUPS),
    presence: Math.max(0, new Set(presence.filter(isPresenceTopic)).size - MAX_ACL_PRESENCE),
  };
}

/** 排群組順序用的欄位（Group 的子集） */
export interface ScopeGroup {
  id: string;
  groupType?: string;
  createdAt?: number;
  updatedAt?: number;
  lastMessageTime?: number;
}

/** 活動時間取到小時：兩個群組輪流有新訊息時，不會每一則都把第 50 名換掉、整個換 token 重連 */
const ACTIVITY_BUCKET_MS = 3_600_000;

/**
 * token 範圍的群組順序（超過 MAX_ACL_GROUPS 時留前面的）：守護群組最前面（報平安、守護警報看的是名冊，名冊異動不能漏），
 * 其餘依最近活動（最後一則訊息、名冊／設定更新、建立時間取最新的那個）新到舊，同一小時內依 id。
 * 掉出去的群組有新訊息時（訊息走 P2P，照樣收得到）會排回前面、下一張 token 就訂得到。
 * 群星同一套 50 個上限（api/chat/mqtt_auth.py MQTT_ACL_MAX_GROUPS），也是先排序再截 —— 一樣的問題，要一起改。
 */
export function rankScopeGroups(groups: readonly ScopeGroup[]): string[] {
  const activity = (g: ScopeGroup) =>
    Math.floor(Math.max(g.lastMessageTime ?? 0, g.updatedAt ?? 0, g.createdAt ?? 0) / ACTIVITY_BUCKET_MS);
  return [...groups]
    .sort((a, b) => (Number(b.groupType === 'guardian') - Number(a.groupType === 'guardian'))
      || (activity(b) - activity(a))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((g) => g.id);
}

/** 群組引擎的主題表的一列（groupEngine.topics()）：哪個群、主題 id、是不是目前這一代（否則是換金鑰後還留著的上一代） */
export interface ScopeTopic {
  gid: string;
  tid: string;
  current: boolean;
}

/**
 * token 範圍裡的群組主題（W3）：每個群目前這一代的主題照群組的排名（rankScopeGroups）在前，換金鑰後還留著的上一代
 * （10 分鐘）排在後面、而且只填 MAX_ACL_GROUPS 剩下的位置 —— 先犧牲上一代的，也不會因為上一代的主題讓畫面說「群組被截掉」
 * （審查 W3 L6）。目前這一代超過上限照舊留前面的（截掉的才算被截掉）。排名裡沒有的群（畫面還沒載到）接在同一類的最後。
 */
export function rankScopeTopics(rankedGids: readonly string[], topics: readonly ScopeTopic[]): string[] {
  const rank = new Map(rankedGids.map((g, i) => [g, i]));
  const order = (t: ScopeTopic) => rank.get(t.gid) ?? rankedGids.length;
  const sorted = [...topics].sort((a, b) => (order(a) - order(b)) || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0));
  const current = [...new Set(sorted.filter((t) => t.current).map((t) => t.tid))];
  const previous = [...new Set(sorted.filter((t) => !t.current && !current.includes(t.tid)).map((t) => t.tid))];
  return [...current, ...previous.slice(0, Math.max(0, MAX_ACL_GROUPS - current.length))];
}

export function aclScopeKey(scope: AclScope | null): string {
  return scope ? `${scope.groups.join(',')}|${scope.presence.join(',')}|${scope.presenceTag ?? ''}` : '';
}

/**
 * 這張 token 能訂閱的主題：伺服器回的 subscribe（＝JWT acl 的 sub）。伺服器沒回（舊版 API）才自己推算
 * （＝api/chat/mqtt_auth.py mqtt_acl 的 sub；username 是 URL-safe 寫法）—— 推算的版本不知道 kick 主題給不給（要看這台是不是
 * 帳號的活躍裝置），所以不列，免得訂了被 broker 拒絕。
 */
export function credentialSubscribeTopics(credential: MqttCredential, scope: AclScope | null): Set<string> {
  if (Array.isArray(credential.subscribe) && credential.subscribe.every((t) => typeof t === 'string')) {
    return new Set(credential.subscribe);
  }
  const topics = new Set<string>([`mist/user/${credential.username}/inbox/+`]);
  for (const tid of scope?.groups ?? []) topics.add(`mist/group/${tid}/+`);
  for (const t of scope?.presence ?? []) topics.add(t);
  return topics;
}

export class MqttTokenError extends Error {
  /**
   * code：伺服器的 detail（例如 device_replaced、mqtt_token_rate_limited、clock_skew）；
   * serverTime：401 clock_skew 時伺服器的時間（秒），用它重簽一次。
   */
  constructor(readonly status: number, readonly code?: string, readonly serverTime?: number) {
    super(`mqtt_token:${status}${code ? ':' + code : ''}`);
  }
}

async function tokenError(response: Response): Promise<MqttTokenError> {
  try {
    const detail = ((await response.json()) as { detail?: unknown }).detail;
    if (typeof detail === 'string') return new MqttTokenError(response.status, detail);
    if (detail && typeof detail === 'object') {
      const d = detail as { code?: unknown; server_time?: unknown };
      return new MqttTokenError(response.status, typeof d.code === 'string' ? d.code : undefined,
        typeof d.server_time === 'number' && Number.isFinite(d.server_time) ? d.server_time : undefined);
    }
  } catch { /* 不是 JSON */ }
  return new MqttTokenError(response.status);
}

/**
 * 向伺服器要一張 token。簽章內容＝送出的所有欄位（signature 除外）；request_id 每次新的（伺服器只收一次）。
 * 沒有範圍（好友／群組還沒載入）就送空清單 —— 伺服器只給自己的收件箱，範圍到了 mqtt.ts 會換一張。
 * clockOffsetMs：伺服器時間 − 本機時間（手機時鐘不準時，用伺服器上次告訴我們的時間簽，見 mqtt.ts _requestGrant）。
 */
export async function requestMqttToken(
  signer: IdentitySigner,
  clientId: string,
  scope: AclScope | null,
  deviceId: string | null,
  clockOffsetMs = 0,
): Promise<MqttCredential> {
  // 選伺服器的那一頁（connect-src 沒有收窄）不連帳號（安全審查 L1）：不簽、不送
  if (serverPickRequested()) throw new MqttTokenError(0, 'server_pick');
  // W4：沒有 peers（公鑰清單）了 —— presence 是確切的好友主題，加上我自己的 tag（有才送，跟 device_id 一樣）
  const signed: Record<string, unknown> = {
    action: 'mqtt_token',
    pubkey: signer.publicKey,
    timestamp: Math.floor((Date.now() + clockOffsetMs) / 1000),
    request_id: randomHex(16),
    client_id: clientId,
    groups: scope?.groups ?? [],
    presence: scope?.presence ?? [],
  };
  if (scope?.presenceTag) signed.presence_tag = scope.presenceTag;
  if (deviceId) signed.device_id = deviceId;
  const signature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(signed))));
  const response = await fetch(`${apiBase()}/api/mqtt/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...signed, signature }),
  });
  if (!response.ok) throw await tokenError(response);
  return response.json() as Promise<MqttCredential>;
}

/** 換機的新裝置（還沒有帳戶金鑰）：伺服器發一張 5 分鐘、只能訂閱自己隨機收件箱的 token */
export async function requestTransferCredential(): Promise<MqttCredential> {
  const response = await fetch(`${apiBase()}/api/mqtt/transfer-token`, { method: 'POST' });
  if (!response.ok) throw await tokenError(response);
  return response.json() as Promise<MqttCredential>;
}

/**
 * 受測 App 的差異。哪一個 App、哪一個版本：AegisTalk 的建置在 dist 留下版本標記 aegis-edition.json（profileForBuild，開源第 6 步）；
 * 沒有標記的建置（群星、第 5d 步以前的 AegisTalk）才看 src/services/mqtt.ts 寫死的 broker 網址（detectProfile）。
 *
 * aegisplay：群星。token 要 Ed25519 簽章、帶群組／好友範圍，broker 是窄 ACL（正式站 AEGISPLAY_MQTT_NARROW_ACL=1）。
 * aegistalk：照 AegisTalk 的 chat 伺服器 api/chat/*（2026-10-19 移植群星的 MQTT 加固之後；2026-10-26 從 api/main.py 搬出來）：
 *   - /api/mqtt/token 要 Ed25519 簽章，groups／presence／client_id 必填、presence_tag／device_id 選填（W4：沒有 peers，送了 → 422），
 *     request_id 不可重放；
 *     JWT 的 acl 直接跑 api/chat/mqtt_auth.py 的 mqtt_acl（serverAcl → lib/server_acl.py，審查 2a：不再用抄的一份），
 *     kick 主題只給 claim 過的那台（kickNeedsClaim），時鐘差回 clock_skew（clockSkewDetail）。
 *     username＝URL-safe 公鑰，clientid 綁 mist_<16>_<8>。
 *     模擬 broker 照 docs/MQTT_BROKER.md 的正式設定執行：沒命中 acl 的發布／訂閱一律拒絕（deniedPub／deniedSub 計數）。
 *   - topic：mist/user/<收件人>/inbox/<寄件人>、mist/group/<tid>/<寄件人>（W3：每一代群組金鑰推出來的 22 字元主題 id，
 *     token 範圍也是 tid；gid 不上 broker）、mist/user/<我>/presence/<tag>（W4：只有好友知道 tag 的秘密主題，payload 只有 {n, c}）。
 *   - /api/shortcode/register|refresh 要身分金鑰簽整份請求＋帳號（shortcodeSigned，開源計畫第 3 步；以前不驗），短碼前綴 ATK-。
 *   - /api/push/notify、/api/push/register-token（與官方版的信任分數端點，profiles-official.mjs）要帳戶簽章（signedPushTrust）。
 *   - 帳號（accountsRequired，第 3 步）：只從 POST /api/account/register（keys-only）來；推播、信任分數、裝置 claim、短碼、
 *     群組 log append 沒有帳號一律 403（正式站要 AegisID 帳號的那一類，以前模擬不查）。token 不要求帳號（＝官方站）。
 *   - 畫面：沒有遊戲外殼。註冊＝「開始使用」→ PIN ×2 → 名字 → 完成，直接進聊天；手機寬度是底部導覽（好友／群組），
 *     加好友、建群在列表頁右上角的按鈕。
 */
import fs from 'node:fs';
import path from 'node:path';

// 官方 App 的主機（broker、正式站 API、防詐規則同步）與只有官方版用的模擬端點在私有的 profiles-official.mjs（開源匯出不帶它）。
// 沒有那個檔（公開的 repo）：官方版的 profile 沒有主機，只能跑社群版（chatEditionProfile 用模擬伺服器自己的假主機）。
const OFFICIAL_FILE = new URL('./profiles-official.mjs', import.meta.url);
const { OFFICIAL_PROFILES: OFFICIAL = {} } = fs.existsSync(OFFICIAL_FILE) ? await import(OFFICIAL_FILE.href) : {};
const NO_HOSTS = { brokerUrl: null, prodApiHosts: [], intercept404: [], officialRoutes: null };

function aegisplayAcl(username, groups, peers, deviceId) {
  const pub = [
    `aegisplay/user/+/inbox/${username}`,
    `aegisplay/user/${username}/presence`,
    `aegisplay/broadcast/${username}`,
    `aegisplay/group/+/${username}`,
  ];
  const sub = [`aegisplay/user/${username}/inbox/+`];
  for (const g of groups) sub.push(`aegisplay/group/${g}/+`);
  for (const p of peers) sub.push(`aegisplay/user/${p}/presence`, `aegisplay/broadcast/${p}`);
  if (deviceId) sub.push(`aegis/device/${deviceId}/kicked`);
  return { pub, sub, all: [] };
}

/** 換機臨時身分：只能訂閱自己的收件箱（守護背景服務 W5 已移除） */
export function receiveOnlyAcl(profile, username) {
  const prefix = profile.id === 'aegisplay' ? 'aegisplay' : 'mist';
  return { pub: [], sub: [`${prefix}/user/${username}/inbox/+`], all: [] };
}

export const PROFILES = {
  aegisplay: {
    id: 'aegisplay',
    uiReady: true,
    ...NO_HOSTS,
    ...OFFICIAL.aegisplay,
    clientIdPrefix: 'aegisplay_',
    codePrefix: 'AST-',
    codeRe: /AST-[A-Z2-9]{6}/,
    codePlaceholder: 'AST-XXXXXX',
    tokenStyle: 'signed',
    presenceField: 'peers',
    shortcodeSigned: true,
    tokenMatchesUser: (claims, username) => claims.username === username,
    // 正式站 AEGISPLAY_MQTT_NARROW_ACL=1：一律窄 ACL
    acl: aegisplayAcl,
  },
  aegistalk: {
    id: 'aegistalk',
    uiReady: true,
    ...NO_HOSTS,
    ...OFFICIAL.aegistalk,
    clientIdPrefix: 'mist_',
    codePrefix: 'ATK-',
    codeRe: /ATK-[A-Z2-9]{6}/,
    codePlaceholder: 'ATK-XXXXXX',
    tokenStyle: 'signed',
    // api/chat/mqtt_auth.py MqttTokenRequest：groups／presence／client_id 必填（沒送 → 422；W4 起 peers 送了也是 422）
    tokenRequiresScope: true,
    presenceField: 'presence',
    shortcodeSigned: true,
    // /api/push/*（與官方版的信任分數端點）要帳戶簽章（2026-10-19 移植群星 A5 與信任分數修法）：模擬 API 照驗
    signedPushTrust: true,
    // 帳號只從 keys-only 註冊來，沒有帳號的金鑰在推播／信任分數／claim／短碼／群組 log 一律 403（開源計畫第 3 步）
    accountsRequired: true,
    tokenMatchesUser: (claims, username) => claims.username === username,
    // token ACL 由伺服器的程式算（相對於 SIM_ROOT；remote-run.sh 會把 api/chat 一起送過去）
    serverAcl: 'api/chat/mqtt_auth.py',
    kickNeedsClaim: true,
    clockSkewDetail: true,
    // 社群版的 chat 伺服器只收這兩種推播（開源計畫決定 2；開源第 4 步起 App 也只送這兩種）
    pushHintTypes: ['message', 'incoming_call'],
  },
};

/**
 * 沒有版本標記的建置是哪個 App：mqtt.ts 寫死的 broker（群星）；AegisTalk 開源第 5c 步起 broker 是執行期選的伺服器的
 * （services/apiBase.ts），改看官方版的預設伺服器（src/ext-official/official-server.json）的 mqttUrl。
 */
export function detectProfile(pwaDir) {
  const src = fs.readFileSync(path.join(pwaDir, 'src/services/mqtt.ts'), 'utf8');
  let broker = src.match(/broker:\s*'([^']+)'/)?.[1];
  const official = path.join(pwaDir, 'src/ext-official/official-server.json');
  if (!broker && fs.existsSync(official)) broker = JSON.parse(fs.readFileSync(official, 'utf8')).mqttUrl;
  const hit = broker ? Object.values(PROFILES).find((p) => p.brokerUrl === broker) : undefined;
  if (!hit) throw new Error(`unknown app (broker ${broker}) — add a profile in scripts/sim/lib/profiles.mjs`);
  return hit;
}

/**
 * 社群版（開源第 5b／5c 步，remote-run.sh --edition chat）：沒有預設伺服器 —— 每支手機第一次開啟時在 ChatAuthScreen 輸入
 * 這台模擬伺服器的 API 網址（https://chat-api.sim.test），App 讀它的 server-config 拿到 broker（wss://chat-mqtt.sim.test/mqtt），
 * 用 invite 政策 keys-only 註冊（邀請碼在畫面上輸入）。兩個網址都是假的主機：只有模擬的攔截接得到（不會真的出去），
 * App 的 connect-src 也真的縮到這兩個來源（services/connectPolicy.ts）。官方站的主機在社群版一個都不該出現。
 */
export function chatEditionProfile(base) {
  return {
    ...base,
    edition: 'chat',
    chatServer: { apiUrl: 'https://chat-api.sim.test', name: 'Sim chat' },
    brokerUrl: 'wss://chat-mqtt.sim.test/mqtt',
    prodApiHosts: ['chat-api.sim.test'],
    // 社群版沒有防詐規則同步，也沒有官方版的端點：官方站的任何網址都不攔（出現就是 NETWORK-GUARD 違規）
    intercept404: [],
    officialRoutes: null,
    registration: 'invite',
  };
}

/**
 * 建置時 vite 寫進 dist 的版本標記（packages/pwa/vite.config.ts 的 editionMarker：{"edition": "chat" | "official"}）；
 * 沒有這個檔 → null（群星、第 5d 步以前的 AegisTalk）
 */
export function readEditionMarker(distDir) {
  const file = path.join(distDir, 'aegis-edition.json');
  if (!fs.existsSync(file)) return null;
  const { edition } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (edition !== 'chat' && edition !== 'official') throw new Error(`${file}: unknown edition ${JSON.stringify(edition)}`);
  return edition;
}

/**
 * 受測的 App 與版本（開源第 6 步）。有版本標記：那就是 AegisTalk，版本只看標記 —— 不從 broker 網址推（公開的 repo 根本沒有
 * 官方版的預設伺服器可看）。requested（remote-run／local-run 的 --edition，寫在 .sim-edition）跟標記不一樣 → 丟錯（建錯版本了）。
 * 官方版另外核對：它的預設伺服器（official-server.json）的 broker 就是 PROFILES.aegistalk.brokerUrl（模擬只攔這一個網址）。
 * 沒有標記：detectProfile（broker 網址），版本 ＝ requested，沒給就是 official（舊的建置只有官方版）。
 */
export function profileForBuild({ pwaDir, distDir, requested = null }) {
  const marker = readEditionMarker(distDir);
  if (marker && requested && marker !== requested) {
    throw new Error(`the build is the ${marker} edition (dist/aegis-edition.json) but --edition ${requested} was asked for — rebuild`);
  }
  const edition = marker ?? requested ?? 'official';
  let base;
  if (marker) {
    base = PROFILES.aegistalk;
    const official = path.join(pwaDir, 'src/ext-official/official-server.json');
    if (edition === 'official' && fs.existsSync(official)) {
      const { mqttUrl } = JSON.parse(fs.readFileSync(official, 'utf8'));
      if (mqttUrl !== base.brokerUrl) {
        throw new Error(`the official default server's broker ${mqttUrl} is not ${base.brokerUrl} (PROFILES.aegistalk in scripts/sim/lib/profiles.mjs)`);
      }
    }
  } else {
    base = detectProfile(pwaDir);
  }
  return { profile: edition === 'chat' ? chatEditionProfile(base) : base, edition, fromMarker: !!marker };
}

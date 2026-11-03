#!/usr/bin/env node
/**
 * 多人群組模擬：同一台機器開 4 個瀏覽器 context ＝ 4 支手機（Alice/Bob/Carol/Dave），
 * 跑真的 App 網頁版（群星或 AegisTalk，prepare.sh 建好的 dist；差異見 lib/profiles.mjs），
 * 本機 MQTT broker＋模擬 API，不連任何正式服務。一般用 local-run.sh（這台機器）或 remote-run.sh（送到建置機）來叫它。
 *
 *   node scripts/sim/run.mjs --src <SIM_ROOT> [--scenarios S1,S2] [--headful]
 *
 * SIM_ROOT：prepare.sh 用的那個資料夾（裡面有 packages/pwa 與 .sim-work/dist）。
 * 版本（社群版 chat／官方版 official）看 dist 裡建置留下的 aegis-edition.json（lib/profiles.mjs profileForBuild）；
 * SIM_ROOT/.sim-edition（--edition）是要求的版本，跟建置不一樣就不跑。
 * 瀏覽器：Playwright 從 SIM_PLAYWRIGHT_DIR（node_modules 資料夾）或 App 的 node_modules 找；Chrome 用 SIM_CHROME，
 * 沒設就用 Playwright 自己的 Chromium（npx playwright install chromium），macOS 上有 Google Chrome 就用它。
 * 報告：<SIM_ROOT>/.sim-work/report/{report.md,report.json,logs/*.log}
 * 結束碼：全部 PASS ＝ 0，否則 1。
 *
 * W5（docs/GROUP_LOG_WIRING_W5.md）：第五個角色 Mallory（純 Node 的 MQTT／HTTP 用戶端，自己的帳號金鑰、真的 token 與簽章）、
 * 惡意的營運方（broker inject／withhold／session 過期；伺服器給不同的人看不同的 log）、被踢的 Bob 的影子連線 —— 情境在 adversary.mjs。
 * 攻擊者（isAdversary）自己被拒的發布／訂閱／API 請求另外報；App 的 BROKER-ACL、API-AUTH、LEAK、GROUP-TOPICS、PRESENCE 照樣只判誠實的四支。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBroker, makeResolver } from './lib/broker.mjs';
import { createMockApi, decodeToken, serverAclFrom, setClockOffset, topicUser } from './lib/mockApi.mjs';
import { createGroupLogServer } from './lib/groupLogServer.mjs';
import { createLeakCheck } from './lib/leak.mjs';
import { createTopicAudit, deriveTopicId } from './lib/topics.mjs';
import { presenceAudit } from './lib/presenceAudit.mjs';
import { startStaticServer, guardContext } from './lib/net.mjs';
import { readAppStrings } from './lib/i18n.mjs';
import { Phone } from './lib/phone.mjs';
import { profileForBuild } from './lib/profiles.mjs';
import { setupWorld, ALL as BASE, lateSweep } from './scenarios.mjs';
import { S2X, S8, S9, S10, S11, S12, S13, S14, P1, P2, T1, prepareBobShadow, friendshipSnapshot } from './adversary.mjs';
import { C1, C2, C3 } from './calls.mjs';
import { G1, R1 } from './ring_group.mjs';
import { Actor, loadServices, newIdentity, isAdversary } from './lib/adversaryKit.mjs';

/**
 * 正常流程裡插進 W5 的對抗情境（順序有意義：S2X 要在 S3 之後、S4 之前 A 還是 admin；S12–S14 在 S4 之後 C 是 admin；P1 要四支都在）。
 * 開源第 4 步：D1（A↔B 的 1 對 1）之後跑 1 對 1 通話 C1、營運方／Mallory 塞信令 C2、指紋對不上 C3（calls.mjs）
 * 開源第 5d 步：S1（A、B、C 的群組）之後跑群組通話的指紋 G1、推播來電的響鈴 token R1（ring_group.mjs）
 */
const ALL = { D1: BASE.D1, C1, C2, C3, S1: BASE.S1, G1, R1, S2: BASE.S2, S3: BASE.S3, S2X, S8, S9, S10, S11, S4: BASE.S4, S12, S13, S14, S5: BASE.S5, S6: BASE.S6, S7: BASE.S7, P1, P2, T1 };


const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SRC = path.resolve((arg('--src') || '').replace(/^~/, os.homedir()));
const PWA = path.join(SRC, 'packages/pwa');
const DIST = path.join(SRC, '.sim-work/dist');
const OUT = path.join(SRC, '.sim-work/report');
const ONLY = (arg('--scenarios') || Object.keys(ALL).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const HEADFUL = args.includes('--headful');
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** undefined ＝ Playwright 自己的 Chromium */
const CHROME = process.env.SIM_CHROME || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined);

if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error(`no build at ${DIST} — run prepare.sh first`); process.exit(2); }
const PORT = Number(fs.readFileSync(path.join(DIST, '.sim-port'), 'utf8').trim());
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });

const resolveModule = makeResolver([process.env.SIM_PLAYWRIGHT_DIR, path.join(PWA, 'node_modules')]);
let chromium;
try {
  ({ chromium } = resolveModule('playwright'));
} catch (e) {
  console.error(`${e.message}\n\nThe simulator drives the browsers with Playwright, which is not one of the app's packages. Install it once:\n`
    + '  npm install --prefix ~/.cache/aegistalk-sim playwright@1 && ~/.cache/aegistalk-sim/node_modules/.bin/playwright install chromium\n'
    + 'then pass SIM_PLAYWRIGHT_DIR=~/.cache/aegistalk-sim/node_modules (local-run.sh: --playwright ~/.cache/aegistalk-sim/node_modules).');
  process.exit(2);
}

const brokerLog = fs.createWriteStream(path.join(OUT, 'logs', 'broker.log'));
const brokerLines = [];
function log(tag, line) {
  const now = Date.now();
  const s = `${new Date(now).toISOString().slice(11, 23)} [${tag}] ${line}`;
  brokerLog.write(s + '\n');
  brokerLines.push({ at: now, line: s });
  if (brokerLines.length > 30000) brokerLines.splice(0, 5000);
}

/**
 * AegisTalk 的版本（開源第 5a 步）：official／chat —— 看建置留下的 dist/aegis-edition.json（開源第 6 步：不再從 broker 網址推）；
 * .sim-edition（remote-run／local-run 的 --edition）是要求的版本，跟建置不一樣就停。
 * 社群版（第 5c 步）：沒有預設伺服器，手機在畫面上選這台模擬伺服器（假的 https 主機），invite 政策註冊
 */
const requested = fs.existsSync(path.join(SRC, '.sim-edition')) ? fs.readFileSync(path.join(SRC, '.sim-edition'), 'utf8').trim() : null;
let built;
try {
  built = profileForBuild({ pwaDir: PWA, distDir: DIST, requested });
} catch (e) {
  console.error(`edition: ${e.message}`);
  process.exit(2);
}
const { profile, edition } = built;
const editionFrom = built.fromMarker ? 'dist/aegis-edition.json' : `no edition marker in the build (${requested ? '--edition' : 'default'})`;
console.log(`app ${profile.id}, edition ${edition} — ${editionFrom}`);
if (!profile.uiReady) { console.error(`profile ${profile.id}: UI navigation not implemented yet (see lib/profiles.mjs)`); process.exit(2); }
// AegisTalk：token 的 ACL 直接跑伺服器的 mqtt_acl（api/chat/mqtt_auth.py）；開跑前先算一次，確定拿得到
const serverAcl = profile.serverAcl ? serverAclFrom(path.join(SRC, profile.serverAcl)) : null;
const aclProbe = serverAcl ? serverAcl({ pubkey: 'A'.repeat(43) + '=', groups: ['T'.repeat(22)], presence: [], presence_tag: 'P'.repeat(22), device_id: null }) : null;
if (aclProbe?.error) { console.error(`server ACL probe refused: ${JSON.stringify(aclProbe.error)}`); process.exit(2); }
if (serverAcl) console.log(`server ACL from ${profile.serverAcl}: sub=${JSON.stringify(aclProbe.acl.sub)}`);
let simClockOffset = 0;
// 群組 log：跑伺服器真的 api/group_log_routes.py（remote-run.sh 會一起送過去），每輪一個新的 SQLite 檔
const groupLogRoutes = path.join(SRC, 'api/group_log_routes.py');
// 群組 log 的帳號照模擬 API 的 keys-only 註冊（mockApi 在下一行才建：呼叫時才讀）
const groupLog = fs.existsSync(groupLogRoutes)
  ? createGroupLogServer({ routesPy: groupLogRoutes, dbPath: path.join(SRC, '.sim-work', `group_log-${Date.now()}.db`), now: () => Date.now() + simClockOffset,
    accountOf: (pk) => mockApi.accountOf(pk) })
  : null;
if (!groupLog) console.log('note: api/group_log_routes.py not shipped — group log endpoints not mocked');
const mockApi = createMockApi({ log, profile, serverAcl, groupLog, isAdversary });
/** W5：LEAK 也不能出現的字串（情境改的群名、守護設定的內容、攻擊者塞的字） */
const leakSecrets = new Set();
// LEAK（W2）：broker 在群組主題上看得到的每一則都要是 group_sealed，看得到的欄位沒有群名、暱稱、守護設定、別人的公鑰
const leak = createLeakCheck({
  secrets: () => [world.groupName, 'SimGroup', ...leakSecrets, ...Object.values(world.p).map((ph) => ph.name), 'notifyTime', 'customMessage', 'guardianSettings', 'checkIn'],
  members: () => Object.values(world.p).map((ph) => ph.pubkey),
  // 群組主題以外也不能出現的（群名、守護設定的內容）
  anywhere: () => [world.groupName, 'SimGroup', ...leakSecrets, 'notifyTime', 'customMessage', 'guardianSettings'],
  // 開源第 4 步：顯示名稱在 broker 上任何地方都看不到（個人資料、X3DH_INIT 的名字都封起來了）；明文的 1 對 1 信令型別一則都不准（checkDirect）
  names: () => Object.values(world.p).map((ph) => ph.name),
});
// GROUP-TOPICS（W3）：broker 看得到的每一樣東西都記下來，跑完判：gid 從沒上 broker；S2 被踢的那支從沒訂到／收到之後那幾代的主題
const topicAudit = createTopicAudit();
const broker = createBroker({ resolveModule, verifyToken: decodeToken, log, clock: () => Date.now() + simClockOffset, tokenMatchesUser: profile.tokenMatchesUser,
  isAdversary,
  // LEAK 只判 App 發的（攻擊者在群組主題上發明文的舊型別是 S14 的攻擊本身）
  onPublish: (label, topic, payload) => {
    if (isAdversary(label)) return;
    leak.check(label, topic, payload);
    leak.scanAny(label, topic, payload);
    leak.checkDirect(label, topic, payload);
  },
  onEvent: (ev) => {
    topicAudit.record(ev);
    // 遺囑不經 PUBLISH：連線時留的、broker 替斷線的人發的都看
    if ((ev.kind === 'connect' || ev.kind === 'will') && ev.payload !== undefined && !isAdversary(ev.label)) {
      leak.scanAny(ev.label, ev.topic, ev.payload);
      leak.checkDirect(ev.label, ev.topic, ev.payload);
    }
  } });
/** 稽核不算的事件：攻擊者自己的、營運方塞的／扣下的、送到誠實手機的攻擊者內容（那些另外在情境裡判） */
const skipAdversary = (ev) => isAdversary(ev.label) || isAdversary(ev.from) || ev.kind === 'inject' || ev.kind === 'withheld';
const guard = { intercepted: new Map(), violations: [] };
const server = await startStaticServer({ root: DIST, port: PORT, mockApi, log });
const baseUrl = `http://127.0.0.1:${PORT}`;
const sha = fs.existsSync(path.join(SRC, '.sim-sha')) ? fs.readFileSync(path.join(SRC, '.sim-sha'), 'utf8').trim() : 'unknown';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: [
    // 同一台機器上的 P2P：用真的本機位址當 host candidate（不要 mDNS 名稱）
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    // 本機以外的名稱一律解析失敗（再加一層保險；正常情況根本到不了 DNS，路由就先擋了）
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    // 開源第 4 步：1 對 1 通話（C1–C3）—— 假的麥克風／鏡頭，不跳權限詢問
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ],
});

const t = await readAppStrings(PWA);
const world = {
  p: {},
  groupName: 'SimGroup',
  /** 這一輪的群組 id（S1 記下）；s2 ＝ { gid, kid: 踢人換的那一代, removed: 被踢的那支 }（S2 記下） */
  gids: new Set(),
  kids: new Set(),
  s2: null,
  history: {},
  missing: [],
  /** S6：整個世界（伺服器＋所有在群組裡的手機）一起往後撥時間 */
  setClockOffset(ms) { simClockOffset = ms; setClockOffset(ms); },
  clockOffset: () => simClockOffset,
  nameOf(pk) { for (const ph of Object.values(this.p)) if (ph.pubkey === pk) return ph.name[0]; return pk?.slice(0, 6) ?? '?'; },
  brokerGrep(re, since, max = 30) { return brokerLines.filter((l) => l.at >= since && re.test(l.line)).map((l) => l.line.slice(0, 300)).slice(-max); },
};
const sim = {
  browser, baseUrl, t, profile, logDir: path.join(OUT, 'logs'),
  /** 社群版：營運方發給這支手機的邀請碼（一次性，＝ python -m chat.invites create）；手機在註冊畫面輸入 */
  issueInvite(name) { const code = mockApi.createInvite(1); log('sim', `invite issued for ${name}`); return code; },
  async attachNetwork(phone) {
    await guardContext(phone.context, {
      label: phone.name, mockApi, guard, log, profile,
      onMqttSocket(ws) {
        broker.attach({
          label: phone.name,
          send: (buf) => ws.send(buf),
          close: () => ws.close(),
          onData: (cb) => ws.onMessage((m) => cb(typeof m === 'string' ? Buffer.from(m) : m)),
          onClose: (cb) => ws.onClose(() => cb()),
          onConnectInfo: ({ username }) => phone.onMqttUsername(username),
        });
      },
    });
  },
};
for (const [k, name] of [['A', 'Alice'], ['B', 'Bob'], ['C', 'Carol'], ['D', 'Dave']]) {
  world.p[k] = new Phone(sim, name);
  await world.p[k].init();
}

// ───────── W5：攻擊者 ─────────
const mqttPacket = resolveModule('mqtt-packet');
const svc = await loadServices({ pwaSrc: path.join(PWA, 'src'), resolveModule, workDir: path.join(SRC, '.sim-work', 'adversary') });
const makeActor = ({ label, pk, sign, clientSuffix }) => new Actor({ label, pk, sign, mockApi, broker, mqttPacket, services: svc,
  clock: () => Date.now() + simClockOffset, clientSuffix });
const malloryId = newIdentity();
world.adv = {
  broker, mockApi, groupLog, svc, isAdversary, deriveTopicId, leakSecrets,
  events: () => topicAudit.events,
  actor: makeActor,
  mallory: makeActor({ label: 'Mallory', pk: malloryId.pk, sign: malloryId.sign, clientSuffix: 'evil0001' }),
  beforeKick: (w, sc) => prepareBobShadow(w, sc),
  /** PRESENCE：主人那一刻把秘密給誰（好友減封鎖）的時間軸 */
  friendsTimeline: [],
  /** PRESENCE：營運方故意塞進好友目前主題、一定拆不開的（label → { count, openSeq }：那支重開過就歸零） */
  expectOpenFailed: new Map(),
};
console.log(`W5 adversary: Mallory ${malloryId.pk.slice(0, 12)}…, app services bundled for the attackers`);
// Mallory 是一個註冊過的使用者（keys-only 帳號，開源計畫第 3 步）：他的 log append、推播都是「有帳號的外人」做的
if (profile.accountsRequired) {
  // 社群版的伺服器是 invite 政策：Mallory 也拿到一個邀請碼（他是一般使用者，不是外人）
  const reg = await world.adv.mallory.registerAccount(profile.registration === 'invite' ? mockApi.createInvite(1) : undefined);
  if (reg.status !== 200) { console.error(`Mallory could not register: ${JSON.stringify(reg)}`); process.exit(2); }
}

const results = [];
async function runOne(fn, id) {
  const t0 = Date.now();
  let sc;
  try {
    sc = await fn(world);
  } catch (e) {
    sc = { id, title: '(crashed)', checks: [], notes: [], error: e, get pass() { return false; } };
    log('sim', `${id} crashed: ${e.stack || e}`);
    for (const ph of Object.values(world.p)) {
      if (ph.page) await ph.page.screenshot({ path: path.join(OUT, `${id}-${ph.name}.png`) }).catch(() => {});
    }
  }
  sc.seconds = Math.round((Date.now() - t0) / 1000);
  results.push(sc);
  const line = `${sc.pass ? 'PASS' : 'FAIL'} ${sc.id} — ${sc.title} (${sc.seconds}s)`;
  console.log(line);
  for (const c of sc.checks) console.log(`   ${c.pass ? 'ok  ' : (c.required ? 'FAIL' : 'info')} ${c.name}${c.pass || !c.detail ? '' : '\n        ' + c.detail.split('\n').slice(0, 6).join('\n        ')}`);
  if (sc.error) console.log(`   ERROR ${sc.error.message}`);
  return sc;
}

let setupOk = false;
try {
  const s = await runOne(setupWorld, 'SETUP');
  setupOk = s.pass;
} catch (e) { console.error(e); }
// PRESENCE（W4）：誰跟誰是好友（SETUP 之後的名單）—— presence 只能在好友之間。W5 的 P1 會刪好友、封鎖：之後的變化記在 friendsTimeline
const friendsOf = new Map();
for (const ph of Object.values(world.p)) {
  const keys = new Set((await ph.friends().catch(() => [])).map((f) => f.pubkey));
  friendsOf.set(ph.name, new Set(Object.values(world.p).filter((o) => keys.has(o.pubkey)).map((o) => o.name)));
}
if (setupOk) world.adv.friendsTimeline.push({ at: 0, shares: await friendshipSnapshot(world) });
// 秘密 presence 是 AegisTalk W4 的；別的 App（aegisplay）還是舊的 presence → 不跑這一項
const presenceApplies = profile.id === 'aegistalk';
/**
 * PRESENCE（W4 審查 #5）：每一對好友、兩個方向，App 真的認定對方在線過（isFriendOnline：拆得開、AAD 對、夠新、TTL 內）——
 * 只看 broker 的話，金鑰或 AAD 對不上、一個方向壞掉都還是「有送到」。SETUP 之後最多等 timeoutMs
 */
const friendOnlineSeen = new Map();
async function watchFriendsOnline(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let missing = 0;
    for (const ph of Object.values(world.p)) {
      if (!ph.page || !ph.pubkey) continue;
      if (!friendOnlineSeen.has(ph.name)) friendOnlineSeen.set(ph.name, new Set());
      const seen = friendOnlineSeen.get(ph.name);
      for (const name of friendsOf.get(ph.name) ?? []) {
        if (seen.has(name)) continue;
        const other = Object.values(world.p).find((o) => o.name === name);
        if (other?.pubkey && (await ph.isFriendOnline(other.pubkey)) === true) seen.add(name);
        else missing++;
      }
    }
    if (missing === 0 || Date.now() >= deadline) return missing;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
if (setupOk && presenceApplies) {
  const t0 = Date.now();
  const missing = await watchFriendsOnline(60_000);
  log('sim', `presence: every friend seen online after SETUP in ${Math.round((Date.now() - t0) / 1000)}s, ${missing} direction(s) missing`);
}
if (setupOk) {
  for (const id of ONLY) {
    if (!ALL[id]) { console.log(`unknown scenario ${id}`); continue; }
    // 「晚到」掃描要在 S6 撥時鐘之前做（它量的是真實經過的時間）
    if (id === 'S6') await runOne((w) => lateSweep(w), 'LATE');
    await runOne(ALL[id], id);
  }
  if (!ONLY.includes('S6')) await runOne((w) => lateSweep(w), 'LATE');
} else {
  console.log('SETUP failed — scenarios not run');
}

for (const l of world.adv.mallory.links) { try { l.disconnect(); } catch { /* */ } }

// 網路保險絲：任何被擋下的對外請求 → 整輪失敗
const netPass = guard.violations.length === 0;
console.log(`${netPass ? 'PASS' : 'FAIL'} NETWORK-GUARD — no request left localhost (${guard.violations.length} blocked)`);
// broker ACL 照正式設定執行（token 的 acl claim、沒命中一律拒絕）：App 只該用 token 給得起的主題 → 一次拒絕都不該有
const aclPass = broker.stats.deniedPub === 0 && broker.stats.deniedSub === 0;
const advDenied = broker.stats.adversaryDenied;
const advDeniedBy = Object.fromEntries(Object.entries(broker.stats.deniedBy).filter(([l]) => isAdversary(l)));
console.log(`${aclPass ? 'PASS' : 'FAIL'} BROKER-ACL — app deniedPub=${broker.stats.deniedPub} deniedSub=${broker.stats.deniedSub} (see broker.log for "denied"); `
  + `attackers (reported separately): denied pub=${advDenied.pub} sub=${advDenied.sub} ${JSON.stringify(advDeniedBy)}; operator injected ${broker.stats.injected}, withheld ${broker.stats.withheld}`);
// 推播／信任分數 API 照正式站驗簽章與欄位（profile.signedPushTrust）：App 送出的每一筆都該過，一筆被拒就整輪失敗
const rejectedApi = Object.fromEntries(mockApi.rejected);
const apiAuthPass = mockApi.rejected.size === 0;
const pushNames = mockApi.pushes.filter((p) => /senderName|protectedName|callerName|alertType/.test(JSON.stringify(p.hint))).length;
const glog = groupLog ? groupLog.counts : { appends: 0, fetches: 0, rejected: 0 };
const rejectedAdv = Object.fromEntries(mockApi.adversaryRejected);
const accountsMade = mockApi.accountLog.filter((a) => a.created).map((a) => a.who);
const phonesWithAccount = Object.values(world.p).filter((ph) => ph.pubkey && mockApi.accounts.has(ph.pubkey)).length;
console.log(`${apiAuthPass && pushNames === 0 ? 'PASS' : 'FAIL'} API-AUTH — app rejected=${JSON.stringify(rejectedApi)} signedPushes=${mockApi.pushes.length} pushesWithNames=${pushNames} groupLogAppends=${glog.appends} groupLogFetches=${glog.fetches} groupLogRejected=${glog.rejected}; `
  + `clock_skew answered (re-signed by the app) ${JSON.stringify(Object.fromEntries(mockApi.clockSkewed))}; `
  + `keys-only accounts ${JSON.stringify(accountsMade)} (phones with an account ${phonesWithAccount}/${Object.keys(world.p).length}); `
  + `attackers' refused requests (reported separately) ${JSON.stringify(rejectedAdv)}`);
// 跑過群組情境卻一則群組主題都沒看到 → 檢查是空的，不算通過
const ranGroups = results.some((r) => /^S\d/.test(r.id));
// 開源第 4 步：收件箱上一則都沒看到 → 1 對 1 的檢查是空的，不算通過
const leakPass = leak.stats.findingCount === 0 && (!ranGroups || leak.stats.checked > 0) && leak.stats.direct.checked > 0;
console.log(`${leakPass ? 'PASS' : 'FAIL'} LEAK — group-topic publishes checked=${leak.stats.checked} types=${JSON.stringify(leak.stats.types)}; every app publish/will scanned for group names and guardian settings: ${leak.stats.scanned}; `
  + `inbox publishes checked=${leak.stats.direct.checked} types=${JSON.stringify(leak.stats.direct.types)} (non-group topics scanned for plaintext 1:1 types, push hints and display names: ${leak.stats.direct.scanned}); findings=${leak.stats.findingCount}`);
for (const f of leak.stats.findings.slice(0, 10)) console.log(`   ${f}`);
// GROUP-TOPICS（W3）：踢人之後那幾代的 tid 用還在群裡那支的金鑰算（＝App 的 deriveTopicId）
async function postRemovalTids() {
  if (!world.s2) return null;
  const ph = [world.p.C, world.p.D, world.p.A].find((p) => p.page);
  if (!ph) return null;
  const rows = await ph.q('SELECT key_id, key_base64, epoch_v FROM group_keys WHERE group_id = ?', [world.s2.gid]);
  const start = rows.find((r) => r.key_id === world.s2.kid)?.epoch_v;
  if (start === undefined) return null;
  return rows.filter((r) => Number(r.epoch_v) >= Number(start)).map((r) => deriveTopicId(r.key_base64, world.s2.gid));
}
for (const ph of Object.values(world.p)) {
  if (!ph.page) continue;
  for (const r of await ph.q('SELECT id FROM groups').catch(() => [])) world.gids.add(r.id);
  for (const r of await ph.q('SELECT key_id FROM group_keys').catch(() => [])) world.kids.add(r.key_id);
}
// 攻擊者用過的 gid（Mallory 的群、灌進來的假邀請）也不能從誠實的手機上出現在 broker 上
const gidCheck = topicAudit.gidHidden([...world.gids, ...(world.extraGids ?? [])], world.kids, { skip: skipAdversary });
const postTids = await postRemovalTids().catch((e) => { log('sim', `post-removal tids: ${e.message}`); return null; });
const removedCheck = world.s2 ? topicAudit.removedSilent({ removed: world.s2.removed, tids: postTids ?? [], skip: skipAdversary,
  others: Object.values(world.p).map((ph) => ph.name).filter((n) => n !== world.s2.removed) }) : null;
const topicsPass = (!ranGroups || (gidCheck.pass && gidCheck.kids > 0)) && (!world.s2 || !!removedCheck?.pass);
console.log(`${topicsPass ? 'PASS' : 'FAIL'} GROUP-TOPICS — gid/kid on the broker: ${gidCheck.findings.length} finding(s) (${gidCheck.checked} broker events, ${gidCheck.gids} gid(s), ${gidCheck.kids} kid(s), ${JSON.stringify(topicAudit.counts)}); `
  + (removedCheck ? `after S2 ${world.s2.removed} subscribed/received on ${removedCheck.tids} post-removal tid(s): ${removedCheck.findings.length} finding(s), delivered to it ${removedCheck.deliveredToRemoved}, to the others ${removedCheck.deliveredToOthers}`
    : 'S2 not run'));
for (const f of [...gidCheck.findings, ...(removedCheck?.findings ?? [])].slice(0, 10)) console.log(`   ${f}`);

// PRESENCE（W4）：broker 上的每一個 presence 主題都是確切的秘密主題（沒有只靠公鑰推得出來的、沒有萬用字元），payload 只有 {n, c}、
//   沒有任何公鑰；只有好友訂到、收到彼此的 presence（同群組的非好友一個都沒有）。再拿一把新的金鑰（不是任何人的好友）直接要 token：
//   只靠公鑰的主題、萬用字元、舊的公鑰清單（peers）都要被伺服器的範圍檢查擋掉（這幾筆刻意的拒絕不算進上面的 API-AUTH）
const canonicalJson = (v) => (Array.isArray(v) ? v.map(canonicalJson) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalJson(v[k])])) : v);
function presenceProbes() {
  if (!serverAcl || !world.p.A.pubkey) return [];
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64');
  const victim = topicUser(world.p.A.pubkey);
  const tag = 'A'.repeat(22);
  const cases = [
    ['key-only topic mist/user/<A>/presence', { presence: [`mist/user/${victim}/presence`] }, 400],
    ['wildcard tag mist/user/<A>/presence/+', { presence: [`mist/user/${victim}/presence/+`] }, 400],
    ['wildcard owner mist/user/+/presence/<tag>', { presence: [`mist/user/+/presence/${tag}`] }, 400],
    ['multi-level mist/user/<A>/#', { presence: [`mist/user/${victim}/#`] }, 400],
    ['public-key list (peers)', { peers: [world.p.A.pubkey] }, 422],
  ];
  return cases.map(([name, over, want]) => {
    const fields = { action: 'mqtt_token', pubkey: pk, client_id: `mist_${topicUser(pk).slice(0, 16)}_probe001`, groups: [], presence: [],
      ...over, timestamp: Math.floor((Date.now() + simClockOffset) / 1000), request_id: crypto.randomBytes(16).toString('hex') };
    const signature = crypto.sign(null, Buffer.from(JSON.stringify(canonicalJson(fields))), privateKey).toString('base64');
    const res = mockApi.handle('POST', '/api/mqtt/token', JSON.stringify({ ...fields, signature }), '', 'Mallory-probe');
    return { name, want, got: res?.status ?? 0, ok: res?.status === want };
  });
}
// 每一支手機收 presence 的計數（mqtt 的與 presence 服務的 svc.*）：open-failed 一律要是 0
const presenceStatsByPhone = new Map();
if (presenceApplies) for (const ph of Object.values(world.p)) if (ph.page) presenceStatsByPhone.set(ph.name, await ph.presenceStats());
/** 主人在 at 那一刻（往前 30 秒：換秘密要幾秒才清完舊主題）把秘密給 label 嗎（W5 P1 刪好友／封鎖之後就不給了） */
function sharesWith(owner, label, at) {
  const tl = world.adv.friendsTimeline;
  if (!tl.length) return friendsOf.get(owner)?.has(label) ?? false;
  let cur = tl[0];
  for (const e of tl) if (e.at <= (at ?? 0) - 30_000) cur = e;
  return cur.shares.get(owner)?.has(label) ?? false;
}
const expectOpenFailed = new Map([...world.adv.expectOpenFailed].map(([label, r]) => {
  const ph = Object.values(world.p).find((p) => p.name === label);
  return [label, ph && ph.openSeq === r.openSeq ? r.count : 0];
}));
const presenceCheck = presenceAudit(topicAudit.events, {
  phones: Object.values(world.p).filter((ph) => ph.pubkey).map((ph) => ({ label: ph.name, pubkey: ph.pubkey })), friendsOf,
  online: friendOnlineSeen, stats: presenceStatsByPhone, skip: skipAdversary, sharesWith, expectOpenFailed,
});
const probes = presenceApplies ? presenceProbes() : [];
const probesPass = !serverAcl || (probes.length > 0 && probes.every((p) => p.ok));
const presencePass = !setupOk || !presenceApplies || (presenceCheck.pass && probesPass);
const statsLine = [...presenceStatsByPhone].map(([n, st]) => `${n} ${JSON.stringify(st ?? {})}`).join('; ');
if (!presenceApplies) console.log(`PASS PRESENCE — skipped (${profile.id} has no W4 secret presence)`);
else console.log(`${presencePass ? 'PASS' : 'FAIL'} PRESENCE — ${presenceCheck.findings.length} finding(s) over ${presenceCheck.topics} presence topic(s)/rule(s): `
  + `${presenceCheck.publishes} publish(es), ${presenceCheck.subscribes} subscription(s), ${presenceCheck.wills} will(s) set / ${presenceCheck.willsFired} fired, ${presenceCheck.deliveredToFriends} delivered to friends; `
  + `friend directions delivered ${presenceCheck.pairsDelivered}/${presenceCheck.pairs}, seen online by the app ${presenceCheck.pairsOnline}/${presenceCheck.pairs}; `
  + `non-friend token probes ${probes.filter((p) => p.ok).length}/${probes.length} refused as expected`);
if (presenceApplies) console.log(`   presence stats: ${statsLine}`);
for (const f of presenceCheck.findings.slice(0, 10)) console.log(`   ${f}`);
for (const p of probes.filter((x) => !x.ok)) console.log(`   probe ${p.name}: wanted ${p.want}, got ${p.got}`);

// ───────── 報告 ─────────
const report = {
  sha, app: profile.id, edition, editionFrom, at: new Date().toISOString(), baseUrl,
  scenarios: results.map((r) => ({ id: r.id, title: r.title, pass: r.pass, seconds: r.seconds, checks: r.checks, notes: r.notes, error: r.error ? String(r.error.stack || r.error) : null })),
  network: { pass: netPass, violations: guard.violations, intercepted: Object.fromEntries(guard.intercepted) },
  brokerAcl: { pass: aclPass, deniedPub: broker.stats.deniedPub, deniedSub: broker.stats.deniedSub, aclSource: serverAcl ? profile.serverAcl : 'profiles.mjs',
    adversaryDenied: advDenied, adversaryDeniedBy: advDeniedBy, injected: broker.stats.injected, withheld: broker.stats.withheld },
  apiAuth: { pass: apiAuthPass && pushNames === 0, rejected: rejectedApi, adversaryRejected: rejectedAdv, signedPushes: mockApi.pushes.length, pushesWithNames: pushNames, groupLog: glog,
    accounts: mockApi.accountLog, phonesWithAccount },
  leak: { pass: leakPass, checked: leak.stats.checked, types: leak.stats.types, direct: leak.stats.direct, findings: leak.stats.findings, findingCount: leak.stats.findingCount },
  groupTopics: { pass: topicsPass, gidHidden: gidCheck, removedSilent: removedCheck, brokerEvents: topicAudit.counts },
  presence: { pass: presencePass, applies: presenceApplies, audit: presenceCheck, probes, friendsOf: Object.fromEntries([...friendsOf].map(([k, v]) => [k, [...v]])),
    seenOnline: Object.fromEntries([...friendOnlineSeen].map(([k, v]) => [k, [...v]])), stats: Object.fromEntries(presenceStatsByPhone) },
  api: { mocked: Object.fromEntries(mockApi.counts), unmocked: Object.fromEntries(mockApi.unmocked) },
  broker: broker.stats,
  phones: Object.fromEntries(Object.values(world.p).map((ph) => [ph.name, { pubkey: ph.pubkey, dialogs: ph.dialogs, scamAlerts: ph.alerts }])),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const md = [`# Group simulation — ${profile.id} @ ${sha}${edition === 'chat' ? ' (chat edition)' : ''}`, '', `- run: ${report.at}`, `- edition: ${edition} (${editionFrom})`, ''];
for (const r of report.scenarios) {
  md.push(`## ${r.pass ? 'PASS' : 'FAIL'} ${r.id} — ${r.title} (${r.seconds}s)`, '');
  for (const c of r.checks) {
    md.push(`- ${c.pass ? '✅' : (c.required ? '❌' : 'ℹ️')} ${c.name}`);
    if (!c.pass && c.detail) md.push('', '```', c.detail, '```', '');
  }
  for (const n of r.notes) md.push(`- note: ${n}`);
  if (r.error) md.push('', '```', r.error, '```');
  md.push('');
}
md.push(`## ${aclPass ? 'PASS' : 'FAIL'} BROKER-ACL`, '', `- app: deniedPub=${broker.stats.deniedPub} deniedSub=${broker.stats.deniedSub} (ACL from ${report.brokerAcl.aclSource})`,
  `- attackers (separate): denied pub=${advDenied.pub} sub=${advDenied.sub} ${JSON.stringify(advDeniedBy)}; operator injected ${broker.stats.injected}, withheld ${broker.stats.withheld}`, '');
md.push(`## ${report.apiAuth.pass ? 'PASS' : 'FAIL'} API-AUTH`, '', `- app: rejected=${JSON.stringify(rejectedApi)} signedPushes=${mockApi.pushes.length} pushesWithNames=${pushNames}`,
  `- keys-only accounts created: ${JSON.stringify(accountsMade)}; phones with an account ${phonesWithAccount}/${Object.keys(world.p).length}`,
  `- attackers' refused requests (separate): ${JSON.stringify(rejectedAdv)}`,
  `- group log (real api/group_log_routes.py): appends=${glog.appends} fetches=${glog.fetches} rejected=${glog.rejected}`, '');
md.push(`## ${leakPass ? 'PASS' : 'FAIL'} LEAK`, '', `- group-topic publishes checked=${leak.stats.checked} types=${JSON.stringify(leak.stats.types)} findings=${leak.stats.findingCount}`,
  `- inbox publishes checked=${leak.stats.direct.checked} types=${JSON.stringify(leak.stats.direct.types)}; non-group topics scanned ${leak.stats.direct.scanned}`,
  ...leak.stats.findings.map((f) => `- ${f}`), '');
md.push(`## ${topicsPass ? 'PASS' : 'FAIL'} GROUP-TOPICS`, '', `- gid or kid on the broker: ${gidCheck.findings.length} finding(s) over ${gidCheck.checked} broker events (${gidCheck.gids} gid(s), ${gidCheck.kids} kid(s))`,
  `- removed after S2: ${removedCheck ? `${removedCheck.tids} post-removal tid(s), delivered to the removed phone ${removedCheck.deliveredToRemoved}, to the others ${removedCheck.deliveredToOthers}, findings ${removedCheck.findings.length}` : 'S2 not run'}`,
  ...[...gidCheck.findings, ...(removedCheck?.findings ?? [])].map((f) => `- ${f}`), '');
md.push(`## ${presencePass ? 'PASS' : 'FAIL'} PRESENCE${presenceApplies ? '' : ' (skipped)'}`, '', `- presence topics/rules checked: ${presenceCheck.topics}; publishes ${presenceCheck.publishes}, subscriptions ${presenceCheck.subscribes}, wills ${presenceCheck.wills} set / ${presenceCheck.willsFired} fired, delivered to friends ${presenceCheck.deliveredToFriends}`,
  `- friend directions: delivered ${presenceCheck.pairsDelivered}/${presenceCheck.pairs}, seen online by the app ${presenceCheck.pairsOnline}/${presenceCheck.pairs}`,
  `- stats: ${statsLine}`,
  ...presenceCheck.findings.map((f) => `- ${f}`), ...probes.map((p) => `- probe ${p.name}: wanted ${p.want}, got ${p.got} ${p.ok ? '✅' : '❌'}`), '');
md.push(`## ${netPass ? 'PASS' : 'FAIL'} NETWORK-GUARD`, '', `- blocked: ${JSON.stringify(guard.violations)}`, `- intercepted (answered locally): ${JSON.stringify(report.network.intercepted)}`, `- API mocked: ${JSON.stringify(report.api.mocked)}`, `- API not mocked (404): ${JSON.stringify(report.api.unmocked)}`, `- broker: ${JSON.stringify(broker.stats)}`);
fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');

for (const ph of Object.values(world.p)) await ph.context.close().catch(() => {});
await browser.close().catch(() => {});
server.close();
groupLog?.close();
const allPass = netPass && aclPass && report.apiAuth.pass && leakPass && topicsPass && presencePass && results.filter((r) => r.id !== 'LATE').every((r) => r.pass);
process.exit(allPass ? 0 : 1);

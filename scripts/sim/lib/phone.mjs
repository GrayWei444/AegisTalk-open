/**
 * 一支模擬手機 ＝ 一個 Playwright BrowserContext（自己的 localStorage／IndexedDB／SQLite），
 * 頁面關掉再開 ＝ App 被關掉再打開（資料留著，要重新輸入 PIN）。
 *
 * 所有動作都走真的畫面（按鈕、輸入框），只有「讀結果」直接查 App 自己的 SQLite
 * （AEGIS_E2E_TEST 模式下 App 提供的 window.__aegisE2E.query）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INIT_SCRIPT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'initScript.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Phone {
  constructor(sim, name) {
    this.sim = sim;
    this.name = name;
    this.page = null;
    this.context = null;
    this.pubkey = null;        // 標準 base64（App 內部用的寫法）
    this.mqttUser = null;      // URL-safe（topic／broker username 的寫法）
    this.pin = '135790';
    this.lines = [];
    this.logFile = fs.createWriteStream(path.join(sim.logDir, `${name}.log`), { flags: 'a' });
    this.dialogs = [];
    this.alerts = [];   // App 自己跳出的防詐警告（ScamAlertModal）：記下來、按「我知道了」關掉
    this.lineWaiters = new Set();   // waitLog：等某一行 log 出現（傳檔途中關 App 用）
    this.openSeq = 0;               // 第幾次打開頁面（W5：App 的記憶體計數 —— presence 的 open-failed —— 重開就歸零）
  }

  log(line) {
    const now = Date.now();
    const ts = new Date(now).toISOString().slice(11, 23);
    this.logFile.write(`${ts} ${line}\n`);
    this.lines.push({ at: now, line });
    if (this.lines.length > 30000) this.lines.splice(0, 5000);
    for (const w of this.lineWaiters) if (w.re.test(line)) { this.lineWaiters.delete(w); w.resolve(true); }
  }

  /** 等下一行符合 re 的 log（console 事件一到就 resolve，不靠輪詢）；逾時回 false */
  waitLog(re, timeout = 30_000) {
    return new Promise((resolve) => {
      const w = { re, resolve };
      this.lineWaiters.add(w);
      setTimeout(() => { if (this.lineWaiters.delete(w)) resolve(false); }, timeout);
    });
  }

  /** since 之後、符合 re 的 log 行（診斷用） */
  grep(re, since = 0, max = 40) {
    const out = [];
    for (const l of this.lines) if (l.at >= since && re.test(l.line)) out.push(`${new Date(l.at).toISOString().slice(11, 23)} ${l.line.slice(0, 400)}`);
    return out.slice(-max);
  }

  get t() { return this.sim.t; }

  /** AegisTalk：沒有遊戲外殼（入場頁、main-tabs），導覽走手機版的底部 nav 與列表頁右上角按鈕 */
  get talk() { return this.sim.profile.id === 'aegistalk'; }

  async init() {
    const { browser, baseUrl } = this.sim;
    this.context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      locale: 'en-US',
      serviceWorkers: 'block',
      baseURL: baseUrl,
      // 開源第 4 步：1 對 1 通話（假的麥克風／鏡頭，見 run.mjs 的 Chrome 參數）
      permissions: ['microphone', 'camera'],
    });
    await this.context.addInitScript({ content: INIT_SCRIPT });
    await this.sim.attachNetwork(this);
  }

  async openPage() {
    const page = await this.context.newPage();
    this.page = page;
    this.openSeq++;
    page.on('console', (msg) => this.log(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => this.log(`[pageerror] ${err.message}`));
    page.on('dialog', async (d) => {
      this.dialogs.push(d.message());
      this.log(`[dialog] ${d.type()}: ${d.message()}`);
      await d.dismiss().catch(() => {});
    });
    page.on('close', () => this.log('[sim] page closed'));
    this.log('[sim] page opened');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    return page;
  }

  /** 由 broker 回呼：這支手機的 MQTT CONNECT username → 公鑰 */
  onMqttUsername(username) {
    if (!username) return;
    this.mqttUser = username;
    const b64 = username.replace(/-/g, '+').replace(/_/g, '/');
    this.pubkey = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  }

  // ───────────── 畫面操作 ─────────────

  btn(text, opts = {}) {
    return this.page.getByRole('button', { name: text, exact: opts.exact ?? true });
  }

  async typePin() {
    // 群星：.pin-keys；AegisTalk：SocialRecovery/PinKeypad 的 3 欄格子（數字鍵 aria-label＝數字）
    const keys = this.talk ? 'div.grid.grid-cols-3' : '.pin-keys';
    for (const d of this.pin) {
      await this.page.locator(`${keys} button[aria-label="${d}"]`).click();
      await sleep(120);
    }
  }

  /**
   * 社群版的註冊（開源第 5b／5c 步，ext/chat/ChatAuthScreen）：全部走畫面 —— 輸入伺服器的 API 網址 →「檢查」（App 讀 server-config）
   * →「使用這台伺服器」（存起來、重新載入）→「建立帳號」→ PIN ×2 → 名字 ＋ 邀請碼 →「完成設定」：App 自己用身分金鑰簽
   * POST /api/account/register（invite 政策），伺服器收下才寫 PIN、進聊天。按鈕文字是 src/i18n/communityStrings.ts 的英文。
   */
  async registerChat() {
    const { chatServer } = this.sim.profile;
    await this.openPage();
    const url = this.page.locator('#aegistalk-server-url');
    await url.waitFor({ timeout: 60_000 });
    await url.fill(chatServer.apiUrl);
    await this.btn('Check').click();
    await this.btn('Use this server').click({ timeout: 30_000 });
    // 存好伺服器後頁面重新載入，下一個畫面是歡迎頁
    await this.btn('Create account').click({ timeout: 60_000 });
    await this.page.getByText(this.t('auth.setupPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    await this.page.getByText(this.t('auth.confirmPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    const nameInput = this.page.getByPlaceholder(this.t('auth.namePlaceholder'));
    await nameInput.waitFor({ timeout: 30_000 });
    await nameInput.fill(this.name);
    this.invite = this.invite ?? this.sim.issueInvite(this.name);
    await this.page.locator('#chat-invite-code').fill(this.invite);
    await this.btn(this.t('auth.completeSetup')).click();
    await this.enterFromEntryPage();
  }

  /** 新帳號：開始使用 → PIN ×2 → 名字 → 完成 → （群星）入場頁「進入」／（AegisTalk）直接進聊天 */
  async register() {
    if (this.sim.profile.edition === 'chat') return this.registerChat();
    await this.openPage();
    // AegisTalk 的「開始使用」寫死在 AuthScreen（new-or-recover），不走 i18n
    await this.btn(this.talk ? '開始使用' : this.t('astra.entry2.start')).click({ timeout: 60_000 });
    await this.page.getByText(this.t('auth.setupPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    await this.page.getByText(this.t('auth.confirmPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    const nameInput = this.page.getByPlaceholder(this.t('auth.namePlaceholder'));
    await nameInput.waitFor({ timeout: 30_000 });
    await nameInput.fill(this.name);
    await this.btn(this.t('auth.completeSetup')).click();
    if (this.sim.profile.accountsRequired) await this.registerAccount();
    await this.enterFromEntryPage();
  }

  /**
   * keys-only 帳號（開源計畫第 3 步，伺服器 api/chat/accounts.py）：身分一解鎖就在頁面裡用 App 自己的身分金鑰
   * （window.__simAdversary.sign，模擬專用）簽 {action: account_register, pubkey, timestamp, request_id}，經 App 的網路送
   * POST <profile 的 API 主機>/api/account/register（模擬攔下 → mockApi）。client 的註冊畫面是第 5 步；在那之前由這裡代替。
   */
  async registerAccount(timeout = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const me = await this.page.evaluate(() => window.__simAdversary?.me?.() ?? null).catch(() => null);
      if (me) break;
      await sleep(250);
    }
    const apiOrigin = `https://${this.sim.profile.prodApiHosts[0]}`;
    const res = await this.page.evaluate(async (apiOrigin) => {
      const adv = window.__simAdversary;
      const me = adv?.me?.();
      if (!me) return { status: 0, body: 'identity still locked' };
      const rid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const body = { action: 'account_register', pubkey: me, request_id: rid, timestamp: Math.floor(Date.now() / 1000) };
      const canonical = JSON.stringify(Object.fromEntries(Object.keys(body).sort().map((k) => [k, body[k]])));
      const bytes = new TextEncoder().encode(canonical);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const signature = adv.sign(btoa(bin));
      const r = await fetch(`${apiOrigin}/api/account/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, signature }) });
      return { status: r.status, body: await r.text() };
    }, apiOrigin);
    this.log(`[sim] account register → ${res.status} ${String(res.body).slice(0, 120)}`);
    if (res.status !== 200) throw new Error(`${this.name}: account registration failed (${res.status} ${res.body})`);
  }

  /** App 重開：輸入 PIN → 入場頁「進入」 */
  async login() {
    await this.openPage();
    await this.page.getByText(this.t('auth.enterPin'), { exact: true }).waitFor({ timeout: 60_000 });
    await this.typePin();
    if (this.talk) { await this.enterFromEntryPage(); return; }
    const skipPrf = this.btn(this.t('auth.prfSkip'));
    const enter = this.btn(this.t('astra.entry.enter'));
    await Promise.race([skipPrf.waitFor({ timeout: 60_000 }), enter.waitFor({ timeout: 60_000 })]);
    if (await skipPrf.isVisible().catch(() => false)) await skipPrf.click();
    await this.enterFromEntryPage();
  }

  /** AegisTalk 手機版底部導覽的某一顆（好友／群組） */
  talkNav(label) {
    return this.page.locator('nav button', { hasText: label }).first();
  }

  async enterFromEntryPage() {
    if (this.talk) {
      // 沒有入場頁：註冊完／PIN 對了就是聊天畫面（底部 nav）
      await this.talkNav(this.t('nav.friends')).waitFor({ timeout: 90_000 });
      await this.waitMqtt();
      return;
    }
    const enter = this.btn(this.t('astra.entry.enter'));
    await enter.waitFor({ timeout: 90_000 });
    await enter.click();
    await this.page.locator('nav.main-tabs').waitFor({ timeout: 30_000 });
    await this.waitMqtt();
  }

  async waitMqtt(timeout = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const ok = await this.page.evaluate(() => !!(window.__aegisE2E && window.__aegisE2E.mqttConnected())).catch(() => false);
      if (ok && this.pubkey) return;
      await sleep(500);
    }
    throw new Error(`${this.name}: MQTT not connected after ${timeout} ms`);
  }

  /** 關掉蓋在畫面上的 App 彈窗（目前只有防詐警告），像使用者一樣按「我知道了」 */
  async dismissOverlays() {
    const p = this.page;
    if (!p) return;
    const iKnow = p.getByRole('button', { name: this.t('risk.iKnow'), exact: true });
    if (await iKnow.isVisible().catch(() => false)) {
      const txt = (await p.locator('.fixed.inset-0.z-50').first().textContent().catch(() => '')).slice(0, 200);
      this.alerts.push(txt);
      this.log(`[sim] dismissed scam alert: ${txt}`);
      await iKnow.click().catch(() => {});
      await sleep(400);
    }
    // 連線提示橫幅（ConnectionNotice：時鐘、指紋對不上…）蓋在頁首：情境自己判過內容了，這裡照使用者的做法按「知道了」
    const banners = p.locator('div[role="alert"] button', { hasText: this.t('connectionNotice.dismiss') });
    for (let i = 0; i < 4 && await banners.first().isVisible().catch(() => false); i++) {
      this.log('[sim] dismissed a connection notice banner');
      await banners.first().click().catch(() => {});
      await sleep(300);
    }
    // 群組來電的全螢幕畫面（W5 S2X 會發一通群組通話）：按拒接（發起的人掛斷了，來電畫面不會自己收）
    const ringing = p.locator('.fixed.inset-0.z-50').filter({ hasText: this.t('group.groupCallInvite') });
    if (await ringing.first().isVisible().catch(() => false)) {
      this.log('[sim] declined an incoming group call screen');
      await ringing.first().locator('button.bg-red-600').first().click().catch(() => {});
      await sleep(400);
    }
  }

  async gotoFriendsTab(sub = 'friends') {
    const p = this.page;
    await this.dismissOverlays();
    if (this.talk) {
      // 全螢幕畫面（群組視窗、聊天室）蓋住列表時沒有底部 nav：先按左上角返回
      const nav = this.talkNav(this.t('nav.friends'));
      if (!(await nav.isVisible().catch(() => false))) {
        await p.keyboard.press('Escape').catch(() => {});
        const back = p.locator('button:has(path[d="M15 19l-7-7 7-7"])').first();
        if (await back.isVisible().catch(() => false)) await back.click();
        // 1 對 1 聊天室的返回鍵是「←」字（ChatRoom header，手機寬度才有）
        const chatBack = p.locator('button', { hasText: '←' }).first();
        if (!(await nav.isVisible().catch(() => false)) && await chatBack.isVisible().catch(() => false)) await chatBack.click();
      }
      await this.talkNav(sub === 'groups' ? this.t('nav.groups') : this.t('nav.friends')).click({ timeout: 20_000 });
      return;
    }
    // 關掉蓋在上面的東西（群組視窗、彈窗）
    const nav = p.locator(`nav.main-tabs button[aria-label="${this.t('nav.friends')}"]`);
    if (!(await nav.isVisible().catch(() => false))) {
      await p.keyboard.press('Escape').catch(() => {});
      const back = p.locator('button:has(path[d="M15 19l-7-7 7-7"])').first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await nav.click({ timeout: 20_000 });
    const label = sub === 'groups' ? this.t('nav.groups') : this.t('nav.friends');
    await p.locator(`.friends-tabs button[aria-label="${label}"]`).click();
  }

  /** 我的好友碼（加好友 → 好友碼分頁，App 會去註冊短碼） */
  /** 列表頁右上角的「加好友」（好友分頁）／「建立群組」（群組分頁）按鈕 */
  headerButton(title) {
    return this.talk
      ? this.page.locator(`button[title="${title}"]`).first()
      : this.page.locator(`.friends-header button[title="${title}"]`);
  }

  async myFriendCode() {
    await this.gotoFriendsTab('friends');
    const p = this.page;
    await this.headerButton(this.t('friendList.addFriend')).click();
    await this.btn(this.t('friendCode.friendCodeTab'), { exact: true }).click();
    const re = this.sim.profile.codeRe;
    const codeEl = p.locator('p.font-mono', { hasText: re });
    await codeEl.waitFor({ timeout: 30_000 });
    const code = (await codeEl.textContent()).match(re)[0];
    await p.keyboard.press('Escape').catch(() => {});
    await this.closeModal();
    return code;
  }

  async closeModal() {
    const p = this.page;
    // 加好友彈窗的關閉鈕（右上 X）
    const x = p.locator('.fixed.inset-0 button:has(path[d="M6 18L18 6M6 6l12 12"])').first();
    if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
    await sleep(300);
  }

  async addFriendByCode(code) {
    await this.gotoFriendsTab('friends');
    const p = this.page;
    await this.headerButton(this.t('friendList.addFriend')).click();
    await this.btn(this.t('friendCode.friendCodeTab'), { exact: true }).click();
    await p.getByPlaceholder(this.sim.profile.codePlaceholder).fill(code);
    // AegisTalk 的送出鈕文字「加入好友」寫死在 AddFriendModal（不走 i18n）
    const submit = this.talk ? '加入好友' : this.t('astra.friendAdd.addFriend');
    await p.locator('.fixed.inset-0.z-50').getByRole('button', { name: submit, exact: true }).click();
    // 成功後彈窗 2 秒自己關；失敗會顯示紅字
    await sleep(2500);
    const err = await p.locator('.fixed.inset-0 p.text-red-400').first().textContent({ timeout: 500 }).catch(() => null);
    if (err) throw new Error(`${this.name}: add friend failed: ${err}`);
    await this.closeModal();
  }

  async createGroup(groupName, memberNames) {
    await this.gotoFriendsTab('groups');
    const p = this.page;
    await this.headerButton(this.t('group.createGroup')).click();
    const menu = this.talk ? p.locator('div.absolute button', { hasText: this.t('friendList.normalGroupHint') })
      : p.locator('.friends-header div.absolute button', { hasText: this.t('friendList.normalGroupHint') });
    await menu.first().click();
    const nameInput = p.getByPlaceholder(this.t('groups.groupNamePlaceholder'));
    await nameInput.fill(groupName);
    const dialog = this.talk ? p.locator('.fixed.inset-0.z-50').filter({ has: nameInput }) : p.locator('.create-group-dialog');
    for (const m of memberNames) {
      await dialog.locator('button', { hasText: m }).first().click();
    }
    await dialog.getByRole('button', { name: this.t('group.createGroup'), exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
  }

  async openGroup(groupName) {
    const p = this.page;
    await this.dismissOverlays();
    const input = p.getByPlaceholder(this.t('group.typeMessage'));
    const header = p.locator('div.relative.z-10 h2', { hasText: groupName });
    if (await input.isVisible().catch(() => false) && await header.first().isVisible().catch(() => false)) return;
    await this.gotoFriendsTab('groups');
    const row = this.talk ? p.locator('div.space-y-1 > button', { hasText: groupName })
      : p.locator('.friends-content button', { hasText: groupName });
    await row.first().click({ timeout: 20_000 });
    await input.waitFor({ timeout: 20_000 });
  }

  async sendGroupText(groupName, text) {
    await this.openGroup(groupName);
    const input = this.page.getByPlaceholder(this.t('group.typeMessage'));
    await input.fill(text);
    await input.press('Enter');
    this.log(`[sim] SENT group text "${text}"`);
  }

  /** 1 對 1：好友列表點對方 → 聊天室（AegisTalk 的 FriendItem／ChatRoom） */
  async openChat(friendName) {
    const p = this.page;
    await this.dismissOverlays();
    const input = p.getByPlaceholder(this.t('group.typeMessage'));
    const header = p.locator('h2.font-medium', { hasText: friendName });
    if (await input.isVisible().catch(() => false) && await header.first().isVisible().catch(() => false)) return;
    await this.gotoFriendsTab('friends');
    await p.locator('div.cursor-pointer', { has: p.locator('span.font-medium', { hasText: friendName }) }).first().click({ timeout: 20_000 });
    await input.waitFor({ timeout: 20_000 });
  }

  async sendDirectText(friendName, text) {
    await this.openChat(friendName);
    const input = this.page.getByPlaceholder(this.t('group.typeMessage'));
    await input.fill(text);
    await input.press('Enter');
    this.log(`[sim] SENT direct text to ${friendName} "${text}"`);
  }

  /** 1 對 1：在聊天室選一個檔案送出（ChatInput 隱藏的檔案欄位；非圖片／文件類型選了就直接送，不跳預覽） */
  async sendDirectFile(friendName, filePath) {
    await this.openChat(friendName);
    await this.page.locator('input[type="file"][accept="*/*"]').first().setInputFiles(filePath);
    this.log(`[sim] SENT direct file to ${friendName} ${filePath}`);
  }

  /** 收到的檔案（messages 表 msg_type='file'，metadata.fileData；檔名每輪唯一，呼叫端用檔名對） */
  async receivedFiles() {
    const rows = await this.q("SELECT id, metadata FROM messages WHERE msg_type = 'file' AND is_outgoing = 0");
    return rows.map((r) => { try { return { id: r.id, ...JSON.parse(r.metadata || '{}').fileData }; } catch { return { id: r.id }; } });
  }

  /** 送檔待送清單（localStorage aegis_file_pending：還沒收到對方 ack 的檔） */
  async parkedFiles() {
    if (!this.page) return null;
    return this.page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('aegis_file_pending') || '[]')
          .map((p) => ({ peer: p.peer, fileId: p.manifest?.fileId, name: p.manifest?.name, chunks: p.manifest?.chunkCount, tries: p.tries ?? 0 }));
      } catch { return []; }
    });
  }

  // ───────────── 1 對 1 通話（開源第 4 步，C1–C3）─────────────

  /** 聊天室右上角的語音通話按鈕 */
  async startVoiceCall(friendName) {
    await this.openChat(friendName);
    await this.page.locator(`button[title="${this.t('group.voiceCall')}"]`).first().click({ timeout: 20_000 });
    this.log(`[sim] CALL started to ${friendName}`);
  }

  /** 來電畫面的「接聽」（IncomingCallModal 會跳動的那一顆）；回傳有沒有看到來電 */
  async acceptIncomingCall(timeout = 30_000) {
    const btn = this.page.locator('button.animate-bounce').first();
    const shown = await btn.waitFor({ timeout }).then(() => true).catch(() => false);
    // 按鈕一直在跳（animate-bounce）：Playwright 等不到它「停穩」→ force（照樣是畫面上那顆按鈕的 click）
    if (shown) { await btn.click({ force: true }); this.log('[sim] CALL accepted'); }
    return shown;
  }

  /** 通話畫面的「掛斷」（紅色、話筒圖示） */
  async hangUp() {
    const btn = this.page.locator('button.bg-red-500:has(path[d^="M3 5a2"])').first();
    await btn.click({ timeout: 10_000 });
    this.log('[sim] CALL hung up');
  }

  /** 1 對 1 通話的狀態（simAdversary.callDebug：callState、callId、verified、計數） */
  async callState() {
    return this.adv('callDebug');
  }

  /** 1 對 1 聊天室畫面上看得到這段文字 */
  async uiChatShows(friendName, text) {
    await this.openChat(friendName);
    await sleep(800);
    return this.page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
  }

  async groupMenu(item) {
    const p = this.page;
    await this.dismissOverlays();
    await p.locator('div.relative.z-10 button:has(path[d^="M12 5v.01"])').last().click();
    await p.getByRole('button', { name: item, exact: false }).first().click();
  }

  async addMember(groupName, friendName) {
    await this.openGroup(groupName);
    await this.groupMenu(this.t('group.inviteMembers'));
    const p = this.page;
    const modal = p.locator('.fixed.inset-0').filter({ hasText: this.t('invite.title') });
    await modal.locator('button', { hasText: friendName }).first().click();
    await modal.getByRole('button', { name: this.t('invite.inviteCount', { count: 1 }) }).click();
    await modal.waitFor({ state: 'detached', timeout: 20_000 });
  }

  async kick(groupName, memberPubkey) {
    await this.openGroup(groupName);
    await this.groupMenu(this.t('group.settings'));
    const p = this.page;
    const row = p.locator('div.flex.items-center.gap-3.rounded-lg', { hasText: memberPubkey.slice(0, 16) });
    await row.locator('button:has(path[d^="M12 5v.01"])').click();
    await p.getByRole('button', { name: this.t('group.removeMember') }).click();
    await sleep(1500);
    await this.closeSettings();
  }

  async closeSettings() {
    const p = this.page;
    const modal = p.locator('.fixed.inset-0').filter({ hasText: this.t('group.settings') });
    const x = modal.locator('button:has(path[d="M6 18L18 6M6 6l12 12"])').first();
    if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
  }

  async leave(groupName) {
    await this.openGroup(groupName);
    await this.groupMenu(this.t('group.settings'));
    const p = this.page;
    await p.getByRole('button', { name: this.t('group.leave'), exact: true }).click();
    await p.getByRole('button', { name: this.t('group.confirmLeave'), exact: true }).click();
    await sleep(1500);
  }

  /** 群組畫面上看得到的訊息文字（打開該群組） */
  async uiGroupTexts(groupName) {
    await this.openGroup(groupName);
    await sleep(800);
    // AegisTalk 的訊息泡泡沒有包 data-content-item：取訊息列表那一塊（GroupChatWindow「訊息列表」）的文字
    if (this.talk) return this.page.locator('div.flex-1.overflow-y-auto.p-4').first().allTextContents();
    return this.page.locator('[data-content-item]').allTextContents();
  }

  /** App 被關掉（優雅關閉：pagehide → 送離線 presence、MQTT 斷線；P2P 跟著斷） */
  async closeApp() {
    if (!this.page) return;
    await this.page.close({ runBeforeUnload: true }).catch(() => {});
    this.page = null;
    await sleep(1500);
  }

  async reopenApp() {
    await this.login();
  }

  /**
   * 把這支手機的「牆上時鐘」往後撥 ms：App 關掉 → 之後開的頁面 Date／Date.now() 都加上 ms → 重開。
   * 只動 Date（計時器、performance.now 照真實時間走）—— 等於使用者的手機過了 ms 之後才打開 App。
   * （Playwright 的 clock.install 會連計時器一起接管，實測頁面計時器停擺、MQTT keepalive 逾時，不適合。）
   */
  async timeTravel(ms) {
    await this.closeApp();
    await this.context.addInitScript({ content: `(() => {
      const off = ${Number(ms)};
      const RealDate = Date;
      function SimDate(...a) {
        if (!new.target) return new RealDate(RealDate.now() + off).toString();
        return a.length === 0 ? new RealDate(RealDate.now() + off) : new RealDate(...a);
      }
      SimDate.prototype = RealDate.prototype;
      SimDate.now = () => RealDate.now() + off;
      SimDate.parse = RealDate.parse;
      SimDate.UTC = RealDate.UTC;
      window.Date = SimDate;
    })();` });
    this.log(`[sim] wall clock moved forward ${Math.round(ms / 3600000)}h`);
    await this.login();
  }

  // ───────────── 讀 App 自己的資料庫 ─────────────

  async q(sql, params = []) {
    if (!this.page) throw new Error(`${this.name}: app is closed`);
    return this.page.evaluate(async ([s, p]) => {
      const e2e = window.__aegisE2E;
      if (!e2e) throw new Error('__aegisE2E missing');
      return e2e.query(s, p);
    }, [sql, params]);
  }

  async groupIdByName(groupName) {
    const rows = await this.q('SELECT id FROM groups WHERE name = ?', [groupName]);
    return rows[0]?.id ?? null;
  }

  async groupMessages(groupId) {
    return this.q(
      `SELECT id, sender_pubkey AS sender, content, is_outgoing AS outgoing, created_at AS at FROM messages
       WHERE group_ids LIKE ? ORDER BY created_at`, [`%"${groupId}"%`]);
  }

  async groupRoster(groupId) {
    return this.q('SELECT pubkey, role, nickname, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at', [groupId]);
  }

  async groupKeys(groupId) {
    return this.q('SELECT key_id, is_active, created_at, created_by FROM group_keys WHERE group_id = ? ORDER BY created_at', [groupId]);
  }

  async friends() {
    return this.q('SELECT pubkey, nickname, trust_level FROM contacts');
  }

  async pending() {
    return this.q('SELECT recipient_pubkey AS to_pk, message_type AS type, retry_count, created_at FROM pending_messages');
  }

  async peerState(pubkey) {
    if (!this.page) return 'app-closed';
    return this.page.evaluate((pk) => window.__aegisE2E?.getPeerState(pk), pubkey).catch((e) => 'err:' + e.message);
  }

  /** W4：這支手機看得到 pubkey 在線嗎（驗過、解得開的秘密 presence；不是好友的永遠 false） */
  async isFriendOnline(pubkey) {
    if (!this.page) return null;
    return this.page.evaluate((pk) => window.__aegisE2E?.isFriendOnline(pk) ?? null, pubkey).catch(() => null);
  }

  /**
   * W5：模擬專用的 window.__simAdversary（scripts/sim/lib/simAdversary.ts，只有模擬的 dist 有）：這支手機的主人做壞事、
   * 或看 App 收到了什麼。method 的參數要能序列化
   */
  async adv(method, ...args) {
    if (!this.page) throw new Error(`${this.name}: app is closed`);
    return this.page.evaluate(async ([m, a]) => {
      const x = window.__simAdversary;
      if (!x) throw new Error('__simAdversary missing (not a sim build?)');
      return x[m](...a);
    }, [method, args]);
  }

  /** W4：mqtt 這一層收 presence 的計數（accepted／notOpened／refused…） */
  async presenceStats() {
    if (!this.page) return null;
    return this.page.evaluate(() => window.__aegisE2E?.presenceStats?.() ?? null).catch(() => null);
  }
}

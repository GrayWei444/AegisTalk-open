#!/usr/bin/env node
/**
 * Self-host end to end with two real browsers (open-source steps 5b / 5c): the community web build against a running chat
 * server (api/chat_app.py + EMQX, set up as in docs/SELF_HOSTING.md). Nothing is mocked: the browsers talk to the real API
 * and the real broker.
 *
 *   node scripts/selfhost/two_browsers_e2e.mjs --dist <chat dist> --api <API URL> --invite <code good for 2 uses>
 *        [--port 48280] [--chrome <path>] [--playwright <dir>] [--out <dir>]
 *
 * --dist: a community build (AEGIS_EDITION=chat; its dist/aegis-edition.json must say "chat"). --playwright: a node_modules
 * folder that holds playwright, or the playwright package folder itself (default: $SIM_PLAYWRIGHT_DIR, then the app's
 * packages/pwa/node_modules). --chrome: default $SIM_CHROME, else Playwright's own Chromium (a macOS Google Chrome if there).
 * scripts/selfhost/conformance.sh runs this against the docker compose stack.
 *
 * It serves the dist on http://127.0.0.1:<port> (list that origin in CHAT_APP_ORIGINS) and, in two browser contexts
 * (Alice, Bob — separate storage, like two phones):
 *   1. first run: the app has no server → type the API URL, "Check" (GET /api/chat/server-config), "Use this server";
 *      after the reload the page's connect-src is narrowed to exactly that API and its broker
 *   2. "Create account" → PIN × 2 → name + invite code → the app registers itself (POST /api/account/register, signed by its
 *      identity key) → chat screen, MQTT connected with a token from the API
 *   3. Alice shows her short friend code, Bob adds her with it; both see each other as friends
 *   4. Bob → Alice and Alice → Bob text messages arrive (WebRTC data channel, signalling through the broker)
 *   5. no request ever leaves for a host other than the page, the API and the broker
 * Exit 0 only when every check passes; screenshots and browser logs go to --out.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readAppStrings } from '../sim/lib/i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIST = path.resolve(arg('--dist', ''));
const API = arg('--api', '').replace(/\/+$/, '');
const INVITE = arg('--invite', '');
const PORT = Number(arg('--port', '48280'));
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** undefined = Playwright's own Chromium */
const CHROME = arg('--chrome', process.env.SIM_CHROME || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : '')) || undefined;
const OUT = path.resolve(arg('--out', path.join(process.cwd(), 'selfhost-e2e-out')));
if (!fs.existsSync(path.join(DIST, 'index.html')) || !API || !INVITE) {
  console.error('usage: two_browsers_e2e.mjs --dist <chat dist> --api <API URL> --invite <code> [--port n]');
  process.exit(2);
}
// the community build (AEGIS_EDITION=chat) — its edition marker, written by packages/pwa/vite.config.ts
const markerFile = path.join(DIST, 'aegis-edition.json');
const edition = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')).edition : null;
if (edition !== 'chat') {
  console.error(`${DIST} is not a community build (aegis-edition.json: ${edition ?? 'missing'}): build it with AEGIS_EDITION=chat`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

/** Playwright is not one of the app's packages: --playwright, $SIM_PLAYWRIGHT_DIR or the app's node_modules */
function loadPlaywright() {
  const dirs = [arg('--playwright', ''), process.env.SIM_PLAYWRIGHT_DIR, path.join(HERE, '../../packages/pwa/node_modules')]
    .filter(Boolean).map((d) => d.replace(/^~(?=\/)/, process.env.HOME || ''));
  for (const dir of dirs) {
    for (const load of [() => createRequire(path.join(dir, 'noop.js'))('playwright'), () => createRequire(import.meta.url)(dir)]) {
      try { return load(); } catch { /* next */ }
    }
  }
  console.error(`Playwright not found (looked in ${dirs.join(', ')}). Install it once:\n`
    + '  npm install --prefix ~/.cache/aegistalk-sim playwright@1 && ~/.cache/aegistalk-sim/node_modules/.bin/playwright install chromium\n'
    + 'then pass --playwright ~/.cache/aegistalk-sim/node_modules');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const t = await readAppStrings(path.join(HERE, '../../packages/pwa'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PIN = '246810';
const WEB = `http://127.0.0.1:${PORT}`;

// ── static server for the dist ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, WEB);
  let file = path.join(DIST, decodeURIComponent(u.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (u.pathname === '/' || !path.extname(u.pathname)) file = path.join(DIST, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `  [${String(detail).slice(0, 300)}]`}`);
  return ok;
};

const apiOrigin = new URL(API).origin;
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

class User {
  constructor(name) { this.name = name; this.log = fs.createWriteStream(path.join(OUT, `${name}.log`)); this.foreign = []; this.mqttOrigin = null; }
  async open() {
    this.context = await browser.newContext({ viewport: { width: 412, height: 915 }, locale: 'en-US', serviceWorkers: 'block' });
    // the app's own E2E switch (reads its SQLite for the checks) and English UI — nothing else is changed
    await this.context.addInitScript({ content: "try { localStorage.setItem('AEGIS_E2E_TEST','true'); localStorage.setItem('aegistalk_language','en'); } catch (e) {}" });
    this.page = await this.context.newPage();
    this.page.on('console', (m) => this.log.write(`[${m.type()}] ${m.text()}\n`));
    this.page.on('pageerror', (e) => this.log.write(`[pageerror] ${e.message}\n`));
    this.page.on('dialog', (d) => d.accept().catch(() => {}));
    this.page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return;
      if (u.origin !== WEB && u.origin !== apiOrigin && u.origin !== this.mqttOrigin) this.foreign.push(`${r.method()} ${r.url()}`);
    });
    this.page.on('websocket', (ws) => { const u = new URL(ws.url()); if (u.origin !== this.mqttOrigin) this.foreign.push(`WS ${ws.url()}`); });
    await this.page.goto(WEB, { waitUntil: 'domcontentloaded' });
  }
  btn(name) { return this.page.getByRole('button', { name, exact: true }); }
  async typePin() {
    for (const d of PIN) { await this.page.locator(`div.grid.grid-cols-3 button[aria-label="${d}"]`).click(); await sleep(120); }
  }
  async chooseServer() {
    const url = this.page.locator('#aegistalk-server-url');
    await url.waitFor({ timeout: 60_000 });
    await url.fill(API);
    await this.btn('Check').click();
    await this.btn('Use this server').click({ timeout: 30_000 });
    await this.btn('Create account').waitFor({ timeout: 60_000 });   // reloaded on the chosen server
    const cfg = await (await fetch(`${API}/api/chat/server-config`)).json();
    this.mqttOrigin = new URL(cfg.mqtt_url).origin;
    const policies = await this.page.evaluate(() => [...document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map((m) => m.content.replace(/\s+/g, ' ').trim()));
    return { policies, cfg };
  }
  async register() {
    await this.btn('Create account').click();
    await this.page.getByText(t('auth.setupPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    await this.page.getByText(t('auth.confirmPin'), { exact: true }).waitFor({ timeout: 20_000 });
    await this.typePin();
    const name = this.page.getByPlaceholder(t('auth.namePlaceholder'));
    await name.waitFor({ timeout: 30_000 });
    await name.fill(this.name);
    await this.page.locator('#chat-invite-code').fill(INVITE);
    await this.btn(t('auth.completeSetup')).click();
    await this.page.locator('nav button', { hasText: t('nav.friends') }).first().waitFor({ timeout: 90_000 });
    for (let i = 0; i < 120; i++) {
      if (await this.page.evaluate(() => !!window.__aegisE2E?.mqttConnected?.()).catch(() => false)) return true;
      await sleep(500);
    }
    return false;
  }
  async q(sql, params = []) { return this.page.evaluate(([s, p]) => window.__aegisE2E.query(s, p), [sql, params]); }
  async friendCode() {
    await this.page.locator('button[title="' + t('friendList.addFriend') + '"]').first().click();
    await this.btn(t('friendCode.friendCodeTab')).click();
    const el = this.page.locator('p.font-mono', { hasText: /ATK-[A-Z2-9]{6}/ });
    await el.waitFor({ timeout: 30_000 });
    const code = (await el.textContent()).match(/ATK-[A-Z2-9]{6}/)[0];
    await this.page.locator('.fixed.inset-0 button:has(path[d="M6 18L18 6M6 6l12 12"])').first().click().catch(() => {});
    return code;
  }
  async addFriend(code) {
    await this.page.locator('button[title="' + t('friendList.addFriend') + '"]').first().click();
    await this.btn(t('friendCode.friendCodeTab')).click();
    await this.page.getByPlaceholder('ATK-XXXXXX').fill(code);
    await this.page.locator('.fixed.inset-0.z-50').getByRole('button', { name: '加入好友', exact: true }).click();
    await sleep(3000);
    await this.page.locator('.fixed.inset-0 button:has(path[d="M6 18L18 6M6 6l12 12"])').first().click().catch(() => {});
  }
  async send(friend, text) {
    await this.page.locator('div.cursor-pointer', { has: this.page.locator('span.font-medium', { hasText: friend }) }).first().click({ timeout: 20_000 });
    const input = this.page.getByPlaceholder(t('group.typeMessage'));
    await input.waitFor({ timeout: 20_000 });
    await input.fill(text);
    await input.press('Enter');
  }
  async waitMessage(text, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.q('SELECT content FROM messages WHERE is_outgoing = 0').catch(() => []);
      if (rows.some((r) => String(r.content).includes(text))) return true;
      await sleep(1000);
    }
    return false;
  }
}

const alice = new User('Alice');
const bob = new User('Bob');
let exit = 1;
try {
  for (const u of [alice, bob]) await u.open();
  for (const u of [alice, bob]) {
    const { policies, cfg } = await u.chooseServer();
    const narrowed = policies.find((p) => p.startsWith('connect-src'));
    check(`${u.name}: first run chose the server via its server-config (registration ${cfg.registration})`, cfg.service === 'aegistalk-chat' && cfg.registration === 'invite', JSON.stringify(cfg));
    check(`${u.name}: connect-src narrowed to the API and the broker`, narrowed === `connect-src 'self' blob: ${apiOrigin} ${u.mqttOrigin}`, JSON.stringify(policies));
    check(`${u.name}: registered with the invite (keys-only) and connected to the broker`, await u.register());
  }
  const code = await alice.friendCode();
  check('Alice: short friend code from the server', /^ATK-/.test(code), code);
  await bob.addFriend(code);
  let friendsOk = false;
  for (let i = 0; i < 60 && !friendsOk; i++) {
    const [fa, fb] = [await alice.q('SELECT nickname FROM contacts'), await bob.q('SELECT nickname FROM contacts')];
    friendsOk = fa.some((r) => r.nickname === 'Bob') && fb.some((r) => r.nickname === 'Alice');
    if (!friendsOk) await sleep(1000);
  }
  check('Alice and Bob are friends (code → X3DH through the broker)', friendsOk);
  await bob.send('Alice', 'hello Alice from Bob');
  check('Bob → Alice message delivered', await alice.waitMessage('hello Alice from Bob'));
  await alice.send('Bob', 'hi Bob, got it');
  check('Alice → Bob message delivered', await bob.waitMessage('hi Bob, got it'));
  for (const u of [alice, bob]) check(`${u.name}: no request to any other host`, u.foreign.length === 0, u.foreign.slice(0, 5).join(' | '));
  exit = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log('ERROR', e.stack || e);
  exit = 1;
} finally {
  for (const u of [alice, bob]) {
    if (u.page) await u.page.screenshot({ path: path.join(OUT, `${u.name}.png`) }).catch(() => {});
  }
  await browser.close().catch(() => {});
  server.close();
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(exit);

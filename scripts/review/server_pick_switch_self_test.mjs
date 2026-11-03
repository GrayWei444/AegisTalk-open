/**
 * Server pick page and server switch (security review L1, L2).
 * L1 before: the "pick a server" flag in sessionStorage was read at boot but never consumed — after tapping "Change" and
 *   reloading, the tab stayed un-narrowed (connect-src) for the rest of the signed-in session, and a script could set the flag
 *   and reload. Now the boot consumes it (one page only); that page offers only the server choice: the community login
 *   screen does not unlock the account there, and no MQTT token is requested on it (either edition).
 * L2 before: switchServer saved the new server first (saveCustomServer also invalidated the in-page cache), then waited up to
 *   1.5 s for the MQTT shutdown — in that window apiBase()/brokerUrl() already named the new server, so a token refresh
 *   (its body lists groups and friends' presence topics), the device-claim heartbeat or a push went to the new server signed
 *   by the old identity. Now: shut down first, store the choice for the next load without touching the page's choice, reload.
 * Real connectPolicyBoot.ts, connectPolicy.ts, serverChoice.ts, apiBase.ts, serverSwitch.ts, mqttCredential.ts; MQTT,
 * database and key store replaced by recorders.
 *
 *   node scripts/review/server_pick_switch_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'srvpick-'));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^\.\/database$|^\.\/mqtt$|^\.\/keyEncryption$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: {
    '@ext/server': 'export const defaultServer = null; export const connectSources = []; export const brandLegal = undefined;',
    './database': 'export async function flushToStore(o) { globalThis.__log.push("flush"); }',
    './mqtt': `export const mqttService = {
      gracefulShutdown: async () => { globalThis.__log.push('graceful'); globalThis.__duringShutdown?.(); },
      disconnect: () => globalThis.__log.push('disconnect') };`,
    './keyEncryption': 'export function clearEncryptionKey() { globalThis.__log.push("lock"); }',
  }[a.path] }));
} };
await require('esbuild').build({
  stdin: { contents: `import './connectPolicyBoot';
export * from './connectPolicy'; export * from './serverChoice'; export * from './apiBase'; export * from './serverSwitch';
export { requestMqttToken, MqttTokenError } from './mqttCredential';`, resolveDir: SRC + '/services', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [stubs], define: { 'import.meta.env': '{}' },
});

const OLD = { v: 1, apiUrl: 'https://old-api.example.com', mqttUrl: 'wss://old-mqtt.example.com/mqtt', registration: 'invite', apiVersion: 1, links: {} };
const NEW = { ...OLD, apiUrl: 'https://new-api.example.com', mqttUrl: 'wss://new-mqtt.example.com/mqtt' };
const mapStore = (m = new Map()) => ({ m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
// one browser tab: localStorage and sessionStorage live across reloads
const tab = { local: mapStore(), session: mapStore() };
let head = [];
let n = 0;
/** a page load of the tab (a fresh module instance; the boot runs on import) */
async function load() {
  globalThis.localStorage = tab.local;
  globalThis.sessionStorage = tab.session;
  globalThis.__log = [];
  head = [];
  globalThis.document = { head: { appendChild: (el) => head.push(el) }, createElement: () => ({}) };
  globalThis.window = { location: { reload: () => globalThis.__log.push('reload') } };
  return import(pathToFileURL(join(dir, 'p.mjs')).href + `?load${n++}`);
}
const FLAG = 'aegis_server_pick';
const fetches = [];
globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: true, json: async () => ({ token: 't', expiresAt: 0, username: 'u' }) }; };
const signer = { publicKey: 'A'.repeat(43) + '=', sign: () => { throw new Error('a pick page must not sign a token request'); } };

// ── L1 ──
await check('L1: the boot consumes the pick flag — this page is the pick page (not narrowed), the next load is narrowed again', async () => {
  tab.local.setItem('aegistalk_server', JSON.stringify(OLD));
  let P = await load();
  assert.equal(head.length, 1, 'a normal page is narrowed');
  P.beginServerPick();
  assert.equal(tab.session.getItem(FLAG), '1');
  assert.deepEqual(__log, ['reload']);
  P = await load();
  assert.equal(tab.session.getItem(FLAG), null, 'the flag is gone once the page booted');
  assert.equal(P.serverPickRequested(), true, 'this page is the pick page');
  assert.equal(head.length, 0, 'the pick page is not narrowed');
  assert.equal(P.narrowedConnectPolicy(), null);
  P = await load();   // the user reloads instead of choosing
  assert.equal(P.serverPickRequested(), false);
  assert.equal(head.length, 1, 'the next load is narrowed again — no un-narrowed signed-in session');
});

await check('L1: a script that sets the flag and reloads gets one pick page, no more', async () => {
  tab.session.setItem(FLAG, '1');
  await load();
  assert.equal(head.length, 0);
  await load();
  assert.equal(head.length, 1);
});

await check('L1: no MQTT token is requested on the pick page (nothing signed, nothing sent); on a normal page it is', async () => {
  tab.session.setItem(FLAG, '1');
  let P = await load();
  fetches.length = 0;
  await assert.rejects(P.requestMqttToken(signer, 'c', null, null), (e) => e instanceof P.MqttTokenError && e.code === 'server_pick');
  assert.deepEqual(fetches, []);
  P = await load();
  await P.requestMqttToken({ ...signer, sign: () => new Uint8Array(64) }, 'c', null, null);
  assert.deepEqual(fetches, ['https://old-api.example.com/api/mqtt/token']);
});

await check('L1: the community login shows only the server choice on the pick page (before any PIN check)', async () => {
  const auth = readFileSync(SRC + '/ext/chat/ChatAuthScreen.tsx', 'utf8');
  const a = auth.indexOf('const checkAuth = async () => {');
  const body = auth.slice(a, auth.indexOf('void checkAuth();', a));
  const iPick = body.indexOf('if (serverPickRequested()) {'), iPin = body.indexOf('pinAuth().hasPin()');
  assert.ok(iPick > 0 && iPin > 0 && iPick < iPin, 'the pick check comes before the PIN');
  assert.match(body.slice(iPick, iPin), /setMode\('pick'\);\s*return;/, 'and ends there');
  const screen = auth.slice(auth.indexOf("if (mode === 'pick') {"), auth.indexOf("if (mode === 'server') {"));
  assert.match(screen, /<ServerSettings /);
  assert.doesNotMatch(screen, /onSuccess|PinKeypad|unlockAndReloadKeys/, 'nothing that unlocks the account');
  const policy = readFileSync(SRC + '/services/connectPolicy.ts', 'utf8');
  assert.doesNotMatch(policy, /can reach nothing but the chosen server/, 'the comment no longer overclaims');
});

// ── L2 ──
await check('L2: while the old account shuts down, every request still goes to the old server; the new one is used after the reload', async () => {
  tab.session.removeItem(FLAG);
  tab.local.setItem('aegistalk_server', JSON.stringify(OLD));
  const P = await load();
  const seen = [];
  globalThis.__duringShutdown = () => seen.push([P.apiBase(), P.brokerUrl()]);
  await P.switchServer(NEW);
  globalThis.__duringShutdown = undefined;
  assert.deepEqual(seen, [[OLD.apiUrl, OLD.mqttUrl]], 'token refresh / heartbeat during the shutdown reach the old server only');
  assert.deepEqual(__log, ['graceful', 'disconnect', 'lock', 'flush', 'reload'], 'shut down, lock, flush, then reload');
  assert.equal(P.getActiveServer().apiUrl, OLD.apiUrl, 'the page keeps its server until the reload');
  assert.equal(P.readCustomServer().apiUrl, NEW.apiUrl, 'stored for the next load');
  const Q = await load();
  assert.equal(Q.apiBase(), NEW.apiUrl, 'after the reload: the new server');
});

await check('L2: storage that cannot be written → nothing shut down, nothing locked, no reload (the switch is refused)', async () => {
  const P = await load();
  const saved = tab.local.setItem;
  tab.local.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    await assert.rejects(P.switchServer(OLD));
    assert.deepEqual(__log, []);
  } finally { tab.local.setItem = saved; }
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS server_pick_switch: one-shot pick page that never unlocks or connects; switching never mixes the old account and the new server');

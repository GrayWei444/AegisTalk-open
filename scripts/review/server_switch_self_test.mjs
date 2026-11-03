/**
 * Server choice and switch (open-source step 5c; port of AegisTrans serverChoice / serverSwitch / apiBase).
 * Real serverChoice.ts, apiBase.ts, connectPolicy.ts, serverAccount.ts, serverSwitch.ts; the app database, MQTT and the
 * account-wipe helpers are recorders; '@ext/server' is either edition's leaf (community: no default; official: the official
 * service). The server-config the client parses is produced by the real api/chat/server_config.py.
 *
 *   node scripts/review/server_switch_self_test.mjs     (AEGISTALK_PYTHON with fastapi for the server-config cross-check)
 *
 *   1. URLs: api https only (http for localhost), broker wss only (ws for localhost), no credentials / query / fragment
 *   2. community edition: no default server → apiBase()/brokerUrl() throw NoServerError (nothing silently falls back to a
 *      host); the official edition defaults to the official service
 *   3. discovery: GET {api}/api/chat/server-config (no credentials, no redirects), service and api_version checked, the
 *      broker URL validated, TURN dropped; the real server's answer is accepted; a stored choice that was tampered with
 *      (ws:// to a public host) is ignored
 *   4. connect-src: narrowed to the active server's API and broker origins (+ 'self', blob:; the official list only on the
 *      official server); not narrowed before a choice or during a pick; pick mode reloads once
 *   5. accounts are per server: the account belongs to the server it was created on; on another server ownerMismatch()
 *      names the owner (with its settings to switch back); back on its server no mismatch; an install from before step 5c
 *      belongs to the default server (official) / is adopted (community); switching deletes nothing and locks; a failed
 *      save changes nothing; wipeLocalAccount removes keys, PIN, contacts, groups and the owner record
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const API_DIR = process.env.AEGISTALK_API_DIR ?? root + 'api';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'srvswitch-'));

const OFFICIAL = { name: 'AegisTalk', apiUrl: 'https://api.official.test', mqttUrl: 'wss://mqtt.official.test/mqtt', stunUrls: ['stun:stun.official.test:3478'], registration: 'external', links: {} };
const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^\.\/database$|^\.\/mqtt$|^\.\/keyEncryption$|^\.\/deviceClaim$|^\.\/storage$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: {
    '@ext/server': `export const defaultServer = globalThis.__edition === 'official' ? ${JSON.stringify(OFFICIAL)} : null;
      export const connectSources = ['https://*.moonpay.com', 'https://cdn.official.test']; export const brandLegal = undefined;`,
    './database': `const s = () => globalThis.__db;
      export async function getSetting(k) { return s().settings.has(k) ? s().settings.get(k) : null; }
      export async function setSetting(k, v) { s().settings.set(k, v); }
      export async function deleteSetting(k) { s().settings.delete(k); }
      export async function run(sql) { s().sql.push(sql); return 1; }
      export async function flushToStore(o) { s().flushes.push(o ?? {}); }`,
    './mqtt': `export const mqttService = { gracefulShutdown: async () => { globalThis.__log.push('graceful'); }, disconnect: () => globalThis.__log.push('disconnect') };`,
    './keyEncryption': `export function clearEncryptionKey() { globalThis.__log.push('lock'); }`,
    './deviceClaim': `export async function wipeLocalKeys() { globalThis.__log.push('wipeLocalKeys'); }`,
    './storage': `export async function clearAllData() { globalThis.__log.push('clearAllData'); }`,
  }[a.path] }));
} };
await require('esbuild').build({
  stdin: { contents: `export * from './serverChoice'; export * from './apiBase'; export * from './connectPolicy'; export * from './serverAccount'; export * from './serverSwitch';`,
    resolveDir: SRC + '/services', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), logLevel: 'silent', plugins: [stubs], define: { 'import.meta.env': '{}' },
});

function freshEnv(edition) {
  globalThis.__edition = edition;
  const mapStore = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  globalThis.localStorage = mapStore();
  globalThis.sessionStorage = mapStore();
  globalThis.__db = { settings: new Map(), sql: [], flushes: [] };
  globalThis.__log = [];
  const head = [];
  globalThis.document = { head: { appendChild: (el) => head.push(el) }, createElement: () => ({}) };
  globalThis.window = { location: { reload: () => globalThis.__log.push('reload') } };
  return { head };
}
let n = 0;
/** each edition gets its own module instance (the server choice is cached per page) */
const load = async (edition) => { freshEnv(edition); return import(pathToFileURL(join(dir, 's.mjs')).href + `?${edition}${n++}`); };

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); }
}

const CUSTOM = { v: 1, apiUrl: 'https://chat-api.example.com', mqttUrl: 'wss://chat-mqtt.example.com/mqtt', registration: 'invite', apiVersion: 1, links: {} };
const OTHER = { ...CUSTOM, apiUrl: 'https://other-api.example.net', mqttUrl: 'wss://other-mqtt.example.net/mqtt' };

// ── 1 ──
await check('URLs: https / wss only (http / ws on localhost), no credentials, query or fragment, trailing slash removed', async () => {
  const S = await load('chat');
  const ok = (u, k) => S.normalizeServerUrl(u, k);
  assert.deepEqual(ok('https://chat.example.com/api/', 'api'), { ok: true, url: 'https://chat.example.com/api' });
  assert.deepEqual(ok('http://chat.example.com', 'api'), { ok: false, reason: 'insecure' });
  assert.equal(ok('http://127.0.0.1:8000', 'api').ok, true);
  assert.equal(ok('http://localhost:8000', 'api').ok, true);
  assert.deepEqual(ok('ws://mqtt.example.com/mqtt', 'mqtt'), { ok: false, reason: 'insecure' });
  assert.equal(ok('ws://127.0.0.1:8083/mqtt', 'mqtt').ok, true);
  assert.deepEqual(ok('https://u:p@chat.example.com', 'api'), { ok: false, reason: 'credentials' });
  assert.deepEqual(ok('https://chat.example.com/?x=1', 'api'), { ok: false, reason: 'query' });
  assert.deepEqual(ok('https://chat.example.com/#a', 'api'), { ok: false, reason: 'query' });
  for (const bad of ['javascript:alert(1)', 'ftp://x', 'not a url', 'wss://mqtt.example.com']) assert.equal(ok(bad, 'api').ok, false, bad);
});

// ── 2 ──
await check('community edition: no default server → apiBase()/brokerUrl() throw NoServerError; official: the official service', async () => {
  const S = await load('chat');
  assert.equal(S.getActiveServer(), null);
  assert.equal(S.hasDefaultServer(), false);
  assert.throws(() => S.apiBase(), (e) => e instanceof S.NoServerError);
  assert.throws(() => S.brokerUrl(), (e) => e instanceof S.NoServerError);
  assert.equal(S.serverStunUrls(), null);
  const O = await load('official');
  const a = O.getActiveServer();
  assert.deepEqual([a.isDefault, a.isOfficial, a.key, a.apiUrl, a.mqttUrl], [true, true, 'default', OFFICIAL.apiUrl, OFFICIAL.mqttUrl]);
  assert.equal(O.apiBase(), OFFICIAL.apiUrl);
  assert.deepEqual(O.serverStunUrls(), OFFICIAL.stunUrls);
  assert.equal(O.defaultServerIsOfficial(), true);
});

// ── 3 ──
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); if (answer instanceof Error) throw answer; return answer; };
  f.calls = calls;
  return f;
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const goodConfig = { service: 'aegistalk-chat', api_version: 1, mqtt_url: 'wss://chat-mqtt.example.com/mqtt',
  stun_urls: ['stun:stun.example.com:3478', 'turn:turn.example.com:3478'], vapid_public_key: null,
  push: { webpush: false, fcm: false, types: ['message', 'incoming_call'] }, backup: { server: false }, registration: 'invite', name: 'Example', links: {} };

await check('discovery: server-config fetched without credentials or redirects; service, version and broker URL checked; TURN dropped', async () => {
  const S = await load('chat');
  const f = fakeFetch(resp(200, goodConfig));
  const r = await S.discoverServer(' https://chat-api.example.com/ ', f);
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, 'https://chat-api.example.com/api/chat/server-config');
  assert.equal(f.calls[0].init.credentials, 'omit'); assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.method, 'GET');
  assert.deepEqual(r.server, { v: 1, apiUrl: 'https://chat-api.example.com', mqttUrl: 'wss://chat-mqtt.example.com/mqtt',
    stunUrls: ['stun:stun.example.com:3478'], registration: 'invite', apiVersion: 1, name: 'Example', links: {} });
  const cases = [
    [resp(200, { ...goodConfig, service: 'aegistrans' }), 'not_aegistalk'],
    [resp(200, { ...goodConfig, api_version: 2 }), 'unsupported_version'],
    [resp(200, { ...goodConfig, mqtt_url: 'ws://chat-mqtt.example.com/mqtt' }), 'bad_config'],
    [resp(200, { ...goodConfig, registration: 'whatever' }), 'bad_config'],
    [resp(404, {}), 'not_aegistalk'],
    [resp(500, {}), 'bad_config'],
    [new TypeError('network'), 'unreachable'],
  ];
  for (const [answer, reason] of cases) assert.deepEqual(await S.discoverServer('https://chat-api.example.com', fakeFetch(answer)), { ok: false, reason });
  assert.deepEqual(await S.discoverServer('http://chat-api.example.com', fakeFetch(resp(200, goodConfig))), { ok: false, reason: 'insecure_url' });
});

await check('discovery accepts the real server\'s answer (api/chat/server_config.py)', async () => {
  const py = process.env.AEGISTALK_PYTHON || 'python3';
  const out = execFileSync(py, ['-c', `
import json, sys, types
sys.path.insert(0, ${JSON.stringify(API_DIR)})
from chat.server_config import server_config
cfg = types.SimpleNamespace(public_mqtt_url='wss://chat-mqtt.example.com/mqtt', stun_urls=('stun:stun.example.com:3478',),
    vapid_public_key='B'*87, webpush_enabled=True, fcm_enabled=False, push_types=('message', 'incoming_call'),
    registration='invite', server_name='Example chat', links={'support': 'https://chat.example.com/help'})
print(json.dumps(server_config(cfg, cfg.registration)))`], { encoding: 'utf8' });
  const S = await load('chat');
  const r = await S.discoverServer('https://chat-api.example.com', fakeFetch(resp(200, JSON.parse(out))));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.webPush, true);
  assert.equal(r.server.registration, 'invite');
  assert.equal(r.server.links.support, 'https://chat.example.com/help');
});

await check('a stored choice: used and keyed per server; tampered (ws:// to a public host) → ignored', async () => {
  const S = await load('chat');
  S.saveCustomServer(CUSTOM);
  const a = S.getActiveServer();
  assert.deepEqual([a.isDefault, a.isOfficial, a.key], [false, false, 'custom:https://chat-api.example.com']);
  assert.equal(S.apiBase(), CUSTOM.apiUrl); assert.equal(S.brokerUrl(), CUSTOM.mqttUrl);
  localStorage.setItem(S.SERVER_STORAGE_KEY, JSON.stringify({ ...CUSTOM, mqttUrl: 'ws://evil.example/mqtt' }));
  S.resetActiveServerCache();
  assert.equal(S.getActiveServer(), null, 'tampered choice ignored (community: back to no server)');
  const O = await load('official');
  O.saveCustomServer(CUSTOM);
  assert.equal(O.getActiveServer().isOfficial, false, 'official build on a chosen server is not "official"');
});

// ── 4 ──
await check('connect-src narrowed to the chosen server (official list only on the official server); not before a choice / during a pick', async () => {
  let S = await load('chat');
  assert.equal(S.narrowConnectSrc(globalThis.document), false, 'no server → not narrowed');
  S = await load('chat');
  const env = { head: [] };
  globalThis.document = { head: { appendChild: (el) => env.head.push(el) }, createElement: () => ({}) };
  S.saveCustomServer(CUSTOM);
  assert.equal(S.narrowConnectSrc(globalThis.document), true);
  assert.equal(S.narrowConnectSrc(globalThis.document), true);
  assert.equal(env.head.length, 1, 'one policy');
  assert.equal(env.head[0].httpEquiv, 'Content-Security-Policy');
  assert.equal(env.head[0].content, "connect-src 'self' blob: https://chat-api.example.com wss://chat-mqtt.example.com");
  const O = await load('official');
  const off = O.connectSourcesFor(O.getActiveServer());
  assert.deepEqual(off, ["'self'", 'blob:', 'https://api.official.test', 'wss://mqtt.official.test', 'https://*.moonpay.com', 'https://cdn.official.test']);
  O.saveCustomServer(CUSTOM);
  assert.ok(!O.connectSourcesFor(O.getActiveServer()).some((s) => s.includes('moonpay') || s.includes('official')), 'official extras not on another server');
  const P = await load('chat');
  P.saveCustomServer(CUSTOM);
  P.beginServerPick();
  assert.deepEqual(__log, ['reload']);
  assert.equal(P.serverPickRequested(), true);
  assert.equal(P.narrowConnectSrc({ head: { appendChild() { throw new Error('must not narrow'); } }, createElement: () => ({}) }), false, 'pick mode: not narrowed');
  P.endServerPick();
  assert.equal(P.serverPickRequested(), false);
});

// ── 5 ──
await check('accounts are per server: owner recorded; mismatch on another server (with settings to switch back); none back home', async () => {
  const S = await load('chat');
  S.saveCustomServer(CUSTOM);
  assert.equal(await S.ownerMismatch(), null, 'no account yet');
  localStorage.setItem('mist_keys', '{"v":1,"iv":"x","ct":"y"}');
  localStorage.setItem('mist_pin_hash', 'h');
  assert.equal(await S.ownerMismatch(), null, 'community install without a record: adopted by the active server');
  await S.rememberAccountOwner();
  assert.deepEqual(JSON.parse(__db.settings.get(S.OWNER_KEY)), { key: 'custom:https://chat-api.example.com', server: S.readCustomServer() }, 'owner in the database too');
  S.saveCustomServer(OTHER);
  const m = await S.ownerMismatch();
  assert.equal(m?.key, 'custom:https://chat-api.example.com', 'on another server the account is not used');
  assert.equal(m.server.apiUrl, CUSTOM.apiUrl, 'its server settings come along (switch back)');
  S.saveCustomServer(CUSTOM);
  assert.equal(await S.ownerMismatch(), null, 'back on its server');
  // localStorage wiped (iOS): the database copy still decides
  localStorage.removeItem(S.OWNER_KEY);
  S.saveCustomServer(OTHER);
  assert.equal((await S.ownerMismatch())?.key, 'custom:https://chat-api.example.com');
});

await check('official edition: an install from before step 5c belongs to the official server; on a chosen server it is a mismatch', async () => {
  const O = await load('official');
  localStorage.setItem('mist_keys', 'k');
  assert.equal(await O.ownerMismatch(), null, 'on the official server: its own');
  O.saveCustomServer(CUSTOM);
  assert.deepEqual(await O.ownerMismatch(), { key: 'default', server: null }, 'on another server: belongs to the default (official) server');
});

await check('switching deletes nothing, locks and reloads; a failed save changes nothing', async () => {
  const S = await load('chat');
  S.saveCustomServer(CUSTOM);
  localStorage.setItem('mist_keys', 'k');
  sessionStorage.setItem(S.SERVER_PICK_FLAG, '1');
  await S.switchServer(OTHER);
  assert.equal(S.readCustomServer().apiUrl, OTHER.apiUrl);
  assert.equal(localStorage.getItem('mist_keys'), 'k', 'account data kept');
  assert.deepEqual(__log, ['graceful', 'disconnect', 'lock', 'reload']);
  assert.deepEqual(__db.flushes.at(-1), { seal: true });
  assert.equal(S.serverPickRequested(), false, 'pick ended');
  const T = await load('chat');
  T.saveCustomServer(CUSTOM);
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(T.switchServer(OTHER));
  assert.deepEqual(__log, [], 'nothing shut down, no reload');
});

await check('wipeLocalAccount: keys, PIN, salt, flags, owner gone; contacts / messages / groups tables cleared; sealed', async () => {
  const S = await load('chat');
  for (const k of ['mist_keys', 'mist_pin_hash', 'mist_pin_salt', 'aegis_key_salt', 'aegis_account_unconfirmed', S.OWNER_KEY, 'mist_user_profile']) {
    localStorage.setItem(k, 'x'); __db.settings.set(k, 'x');
  }
  localStorage.setItem('aegistalk_theme', 'dark');
  await S.wipeLocalAccount();
  for (const k of ['mist_keys', 'mist_pin_hash', 'mist_pin_salt', 'aegis_key_salt', 'aegis_account_unconfirmed', S.OWNER_KEY, 'mist_user_profile']) {
    assert.equal(localStorage.getItem(k), null, k); assert.equal(__db.settings.has(k), false, `${k} (database)`);
  }
  assert.equal(localStorage.getItem('aegistalk_theme'), 'dark', 'app settings kept');
  assert.ok(__log.includes('wipeLocalKeys') && __log.includes('clearAllData') && __log.includes('lock'));
  for (const t of ['groups', 'group_members', 'group_keys', 'group_commits', 'group_log_state', 'local_user_blacklist']) {
    assert.ok(__db.sql.includes(`DELETE FROM ${t}`), t);
  }
  assert.deepEqual(__db.flushes.at(-1), { seal: true });
  const T = await load('chat');
  await T.wipeLocalAccount({ seal: false });
  assert.deepEqual(__db.flushes.at(-1), { seal: false }, 'restore path keeps writing');
});

await check('App shows the mismatch screen instead of the login when the account belongs to another server', async () => {
  const app = (await import('node:fs')).readFileSync(join(SRC, 'App.tsx'), 'utf8');
  assert.match(app, /ownerMismatch\(\)\.then\(\(m\) => \{ if \(alive\) setMismatch\(m\); \}\)/);
  assert.match(app, /if \(mismatch\) return <ServerMismatchScreen owner=\{mismatch\} \/>;/);
  assert.match(app, /if \(mismatch === undefined\) \{/, 'nothing shown until the check is done');
  const main = (await import('node:fs')).readFileSync(join(SRC, 'main.tsx'), 'utf8');
  assert.match(main.split('\n').find((l) => l.startsWith('import ')), /^import '\.\/services\/connectPolicyBoot';$/, 'the connect-src narrowing is the first import of main.tsx');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS server_switch: per-edition default, discovery against the real server-config, narrowed connect-src, accounts per server');

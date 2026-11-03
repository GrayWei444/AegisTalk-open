/**
 * Push leftovers of step 4, finished in step 5b: Web Push subscribes only after the user granted notification permission,
 * and friends' push subscriptions stored by older versions are cleared.
 * Real services/pushNotification.ts, the real ChatApp effect (vm), real storage.addContact / database migration SQL
 * (sql.js with the app's contacts schema).
 *
 *   node scripts/review/push_permission_self_test.mjs
 *
 *   1. pushNotification.subscribe() never asks for permission and never creates a subscription (only webPush.registerWebPush
 *      does, after permission, with the chosen server's VAPID key); without permission it returns null
 *   2. ChatApp: the permission prompt's answer decides — granted → registerWebPush; denied / dismissed / failed → nothing
 *   3. contacts: addContact stores push_subscription = NULL even when handed one, a read never returns one; migration 13
 *      clears every subscription stored before (and SCHEMA_VERSION was raised so it runs)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'pushperm-'));
const src = (p) => readFileSync(join(SRC, p), 'utf8');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); }
}

await esbuild.build({ entryPoints: [SRC + '/services/pushNotification.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'p.mjs'), logLevel: 'silent',
  plugins: [{ name: 's', setup(b) {
    b.onResolve({ filter: /utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ loader: 'js', contents: 'export const devLog = () => {}; export const devWarn = () => {};' }));
  } }] });
const P = await import(pathToFileURL(join(dir, 'p.mjs')));

function browser(permission, existing = null) {
  const calls = { prompt: 0, subscribe: 0 };
  globalThis.Notification = { permission, requestPermission: async () => { calls.prompt++; return 'granted'; } };
  globalThis.window = { PushManager: function () {}, Notification: globalThis.Notification, btoa: (s) => Buffer.from(s, 'binary').toString('base64') };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { ready: Promise.resolve({ pushManager: {
    getSubscription: async () => existing,
    subscribe: async () => { calls.subscribe++; return existing; },
  } }) } } });
  return calls;
}

await check('pushNotification.subscribe(): never prompts, never creates a subscription; null without permission', async () => {
  for (const perm of ['default', 'denied']) {
    const calls = browser(perm);
    assert.equal(await P.pushNotificationService.subscribe(), null, perm);
    assert.deepEqual(calls, { prompt: 0, subscribe: 0 }, perm);
  }
  const sub = { endpoint: 'https://push.example/1', expirationTime: null, getKey: () => new Uint8Array([1, 2, 3]).buffer };
  const calls = browser('granted', sub);
  const got = await P.pushNotificationService.subscribe();
  assert.equal(got.endpoint, 'https://push.example/1', 'granted: the existing subscription');
  assert.deepEqual(calls, { prompt: 0, subscribe: 0 });
  browser('granted', null);
  assert.equal(await P.pushNotificationService.subscribe(), null, 'granted but none yet: not created here');
});

await check('ChatApp: registerWebPush only after the prompt answered granted', async () => {
  const chat = src('pages/ChatApp.tsx');
  const a = chat.indexOf('requestNotificationPermission().then(');
  assert.ok(a > 0, 'ChatApp asks, then decides on the answer');
  const snippet = chat.slice(a, chat.indexOf('}).catch(() => {});', a) + '}).catch(() => {});'.length);
  for (const [answer, expect] of [[true, 1], [false, 0], ['reject', 0]]) {
    const registered = [];
    runInNewContext(esbuild.transformSync(snippet, { loader: 'ts' }).code, {
      requestNotificationPermission: () => (answer === 'reject' ? Promise.reject(new Error('x')) : Promise.resolve(answer)),
      registerWebPush: async (pk) => { registered.push(pk); }, isNativeApp: () => false, publicKey: 'PK',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(registered.length, expect, `answer ${answer}`);
  }
  const webPush = src('services/webPush.ts');
  assert.match(webPush, /if \(Notification\.permission !== 'granted'\) return false;/, 'registerWebPush itself refuses without permission');
});

// ── 3: contacts ──
const initSqlJs = require('sql.js/dist/sql-asm.js');
const SQL = await initSqlJs();
const dbSrc = src('services/database.ts');
const contactsDdl = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS contacts ('), dbSrc.indexOf(');', dbSrc.indexOf('CREATE TABLE IF NOT EXISTS contacts (')) + 2);
const conversationsDdl = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS conversations ('), dbSrc.indexOf(');', dbSrc.indexOf('CREATE TABLE IF NOT EXISTS conversations (')) + 2);

await check('contacts: addContact stores no push subscription; reads return none', async () => {
  const sdb = new SQL.Database();
  sdb.run(contactsDdl); sdb.run(conversationsDdl);
  globalThis.__sdb = sdb;
  await esbuild.build({ stdin: { contents: "export { addContact, getAllContacts } from './storage';", resolveDir: SRC + '/services', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), logLevel: 'silent',
    plugins: [{ name: 's', setup(b) {
      b.onResolve({ filter: /^\.\/database$|^\.\/topicMemory$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
      b.onResolve({ filter: /^\.\// }, (a) => (a.importer.endsWith('storage.ts') && !/database|topicMemory/.test(a.path) ? { path: a.path, namespace: 'empty' } : null));
      b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ loader: 'js', contents: 'export default {};' }));
      b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path === './database'
        ? `export async function initDatabase() {} export function isInitialized() { return true; }
           export async function run(q, p = []) { globalThis.__sdb.run(q, p); return 1; }
           export async function query(q, p = []) { const st = globalThis.__sdb.prepare(q); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; }
           export async function queryOne(q, p = []) { return (await query(q, p))[0] ?? null; }
           export async function runBatch() {} export async function getSetting() { return null; } export async function setSetting() {}`
        : a.path === './topicMemory' ? 'export function wipeRememberedTopics() {}' : 'export const devLog = () => {}; export const devWarn = () => {};' }));
    } }] }).catch((e) => { throw new Error('bundling storage.ts: ' + e.message); });
  const S = await import(pathToFileURL(join(dir, 's.mjs')));
  await S.addContact({ pubkey: 'PK1', nickname: 'A', avatar: '', addedAt: 1, trustLevel: 'verified',
    pushSubscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } } });
  assert.equal(sdb.exec("SELECT push_subscription FROM contacts WHERE pubkey = 'PK1'")[0].values[0][0], null);
  const all = await S.getAllContacts();
  assert.equal(all[0].pushSubscription, undefined);
});

await check('migration 13 clears the subscriptions stored before; SCHEMA_VERSION raised to run it', async () => {
  const m = dbSrc.match(/version: 13,[\s\S]*?individualStatements: \[\s*`([^`]+)`/);
  assert.ok(m, 'migration 13 exists');
  assert.match(dbSrc, /const SCHEMA_VERSION = 13;/);
  const sdb = new SQL.Database();
  sdb.run(contactsDdl);
  sdb.run("INSERT INTO contacts (pubkey, nickname, avatar, added_at, trust_level, push_subscription) VALUES ('a','A','',1,'verified','{\"endpoint\":\"https://push.example/a\"}'), ('b','B','',2,'verified',NULL)");
  sdb.run(m[1]);
  assert.deepEqual(sdb.exec('SELECT pubkey, push_subscription FROM contacts ORDER BY pubkey')[0].values, [['a', null], ['b', null]]);
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS push_permission: Web Push only after permission; friends\' stored push subscriptions gone');

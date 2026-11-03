/**
 * Community identity pieces (open-source step 5b): change PIN without the AegisID account key, the device-transfer
 * payload without face / behaviour data, and the chat edition's identity wiring.
 * Real ext/chat/changePin.ts, services/keyEncryption.ts and services/pinAuth.ts (Argon2id); the app database is an
 * in-memory map that can be made to fail.
 *
 *   node scripts/review/chat_identity_self_test.mjs
 *
 *   1. change PIN: wrong old PIN / bad format / same PIN refused; a change re-encrypts mist_keys and mist_sessions under the
 *      new PIN-derived key, the new PIN verifies, the old one does not, the journal is gone
 *   2. crash safety: interrupted before the PIN hash is durable → unlocking with the new PIN finishes it; interrupted before
 *      anything was replaced → unlocking with the old PIN finishes it (and returns the new PIN to derive from); a journal of
 *      another account is ignored
 *   3. device transfer: the chat edition's transferExtras() is empty; the sender reads face / behaviour data only through
 *      ext.identity.transferExtras (the official one adds both)
 *   4. wiring: the chat AuthScreen is ChatAuthScreen (PinAuthScreen is gone), keys-only register and changePin are wired,
 *      the backup leaf feeds the public blob serializer, the recovery kit sits in the account block of Settings
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'chatid-'));
const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /services\/database$|^\.\/database$|^@capacitor\/core$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path.includes('capacitor')
    ? 'export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web" };'
    : a.path.includes('devLog') ? 'export const devLog = () => {}; export const devWarn = () => {};'
    : `const d = () => globalThis.__db;
       export async function getSetting(k) { return d().map.has(k) ? d().map.get(k) : null; }
       export async function setSetting(k, v) { if (d().failOn?.(k)) throw new Error('disk full'); d().map.set(k, v); }
       export async function deleteSetting(k) { d().map.delete(k); }
       export async function flushToStore() {}` }));
} };
await require('esbuild').build({
  stdin: { contents: `export * from './ext/chat/changePin'; export * from './services/keyEncryption'; export { pinAuth } from './services/pinAuth';`,
    resolveDir: SRC, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'c.mjs'), logLevel: 'silent', plugins: [stubs],
});

function freshDevice() {
  const mapStore = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  globalThis.localStorage = mapStore();
  globalThis.sessionStorage = mapStore();
  globalThis.__db = { map: new Map(), failOn: null };
}
let nMod = 0;
const load = () => import(pathToFileURL(join(dir, 'c.mjs')).href + `?${nMod++}`);
const PK = 'A'.repeat(43) + '=';
const KEYS = JSON.stringify({ identity: { publicKey: PK, privateKey: 'B'.repeat(43) + '=' }, signedPreKey: null, oneTimePreKeys: [] });
const SESSIONS = JSON.stringify({ peer: 'ratchet' });

/** a device with an account protected by `pin` (keys + sessions encrypted with the PIN-derived key) */
async function device(pin) {
  freshDevice();
  const M = await load();
  await M.pinAuth().setPin(pin);
  for (const k of ['mist_pin_hash', 'mist_pin_salt', 'aegis_backup_auth_hash']) __db.map.set(k, localStorage.getItem(k));
  const key = await M.deriveEncryptionKey(pin, { isInitialSetup: true });
  await M.setEncryptionKey(key);
  const enc = await M.encryptData(KEYS, key), encS = await M.encryptData(SESSIONS, key);
  for (const [k, v] of [['mist_keys', enc], ['mist_sessions', encS], ['mist_pubkey_raw', PK]]) { localStorage.setItem(k, v); __db.map.set(k, v); }
  return M;
}
const opens = async (M, pin) => {
  const key = await M.deriveEncryptionKey(pin);
  try { return (await M.decryptData(localStorage.getItem('mist_keys'), key)) === KEYS && (await M.decryptData(localStorage.getItem('mist_sessions'), key)) === SESSIONS; }
  catch { return false; }
};

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); }
}

// ── 1 ──
await check('change PIN: refusals; re-encrypts keys and sessions; new PIN verifies, old does not; journal gone', async () => {
  const M = await device('111111');
  assert.deepEqual(await M.changeChatPin('000000', '222222'), { ok: false, code: 'old_wrong' });
  assert.deepEqual(await M.changeChatPin('111111', '12'), { ok: false, code: 'bad_format' });
  assert.deepEqual(await M.changeChatPin('111111', '111111'), { ok: false, code: 'same_as_old' });
  assert.deepEqual(await M.changeChatPin('111111', '222222'), { ok: true });
  assert.equal(await opens(M, '222222'), true, 'keys and sessions open with the new PIN');
  assert.equal(await opens(M, '111111'), false, 'not with the old one');
  assert.equal(await M.pinAuth().verifyPin('222222'), true);
  assert.equal(await M.pinAuth().verifyPin('111111'), false);
  assert.equal(localStorage.getItem(M.CHAT_PIN_JOURNAL), null); assert.equal(__db.map.has(M.CHAT_PIN_JOURNAL), false);
  assert.equal(__db.map.get('mist_pin_hash'), localStorage.getItem('mist_pin_hash'), 'durable PIN hash copy');
});

// ── 2 ──
await check('crash after the keys moved, before the PIN hash was durable → unlocking with the new PIN finishes it', async () => {
  let M = await device('111111');
  __db.failOn = (k) => k === 'mist_pin_hash';
  assert.deepEqual(await M.changeChatPin('111111', '333333'), { ok: false, code: 'pending' });
  assert.ok(localStorage.getItem(M.CHAT_PIN_JOURNAL), 'journal kept');
  __db.failOn = null;
  M = await load();   // the app restarts
  assert.equal(await M.pinAuth().verifyPin('333333'), true);
  assert.equal(await M.resumeChatPinChange('333333'), '333333');
  assert.equal(localStorage.getItem(M.CHAT_PIN_JOURNAL), null);
  assert.equal(await opens(M, '333333'), true);
});

await check('crash before anything was replaced → unlocking with the old PIN finishes it and returns the new PIN', async () => {
  let M = await device('111111');
  let first = true;
  __db.failOn = (k) => { if (k === 'mist_keys' && first) { first = false; return true; } return false; };
  assert.deepEqual(await M.changeChatPin('111111', '444444'), { ok: false, code: 'pending' });
  __db.failOn = null;
  M = await load();
  assert.equal(await M.pinAuth().verifyPin('111111'), true, 'the old PIN still verifies');
  assert.equal(await M.resumeChatPinChange('111111'), '444444', 'the key must now come from the new PIN');
  assert.equal(await opens(M, '444444'), true);
  assert.equal(await M.pinAuth().verifyPin('444444'), true);
  assert.equal(localStorage.getItem(M.CHAT_PIN_JOURNAL), null);
});

await check('a journal left by another account is ignored', async () => {
  let M = await device('111111');
  __db.failOn = (k) => k === 'mist_keys';
  await M.changeChatPin('111111', '555555');
  __db.failOn = null;
  localStorage.setItem('mist_pubkey_raw', 'C'.repeat(43) + '=');   // another account on this phone now
  M = await load();
  assert.equal(await M.resumeChatPinChange('111111'), '111111', 'not applied');
});

// ── 3 / 4 ──
const src = (p) => readFileSync(join(SRC, p), 'utf8');
await check('device transfer: chat transferExtras() is empty; the sender reads face / behaviour only through the edition', async () => {
  const chat = src('ext/chat/index.tsx');
  assert.match(chat, /transferExtras: async \(\) => \(\{\}\),/);
  const hook = src('hooks/useDeviceTransfer.ts');
  assert.match(hook, /const \{ faceEmbedding, behaviorBaseline \} = await ext\.identity\.transferExtras\(\);/);
  assert.ok(!hook.includes("localStorage.getItem('aegis_behavior_baseline')"), 'no direct behaviour read in the shared sender');
  if (existsSync(join(SRC, 'ext-official/identity.ts'))) {
    assert.match(src('ext-official/identity.ts'), /behaviorBaseline: localStorage\.getItem\('aegis_behavior_baseline'\) \?\? undefined,/, 'official unchanged: still sends it');
  } else {
    console.log('SKIP device transfer, official edition: src/ext-official is not in this checkout (the official transferExtras is not checked)');
  }
});

await check('wiring: ChatAuthScreen, keys-only register, changePin, blob providers, recovery kit in Settings', async () => {
  const chat = src('ext/chat/index.tsx');
  assert.match(chat, /AuthScreen: ChatAuthScreen,/);
  assert.match(chat, /register: \(signer, inviteCode\) => registerAccount\(signer, inviteCode, \{ clock: mqttService\.signedClock\(\) \}\),/);
  assert.match(chat, /changePin: chatPinChange,/);
  assert.match(chat, /accountItems: <RecoveryKitSettingsItem \/>/);
  assert.equal(existsSync(join(SRC, 'ext/chat/PinAuthScreen.tsx')), false, 'the 5a PIN-only screen is gone');
  assert.match(src('ext/chat/backup.ts'), /setProviders: \(providers\) => setBlobDataProviders\(providers\),/);
  const screen = src('ext/chat/ChatAuthScreen.tsx');
  // the PIN is written only after the server accepted the account
  const create = screen.slice(screen.indexOf('const handleCreate = useCallback'), screen.indexOf('/** after a kit restore'));
  const iReg = create.indexOf('registerAccount('), iPin = create.indexOf('pinAuth().setPin(pin)'), iRefused = create.indexOf('if (!outcome.ok)');
  assert.ok(iReg > 0 && iRefused > iReg && iPin > iRefused, 'register → refused? stop → only then write the PIN');
  const refused = create.slice(iRefused, create.indexOf('\n      }\n', iRefused) + 9);
  assert.match(refused, /\n        return;\n      }\n$/, 'a refused registration stops there (no PIN written)');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS chat_identity: crash-safe change PIN without an account key, transfer without face / behaviour, keys-only wiring');

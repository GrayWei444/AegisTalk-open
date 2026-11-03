/**
 * Taking the account off the phone needs the PIN (security review M2).
 * Before: Settings → "Create recovery kit" built the kit as soon as the app was unlocked (readUnlockedIdentity + createKit with a
 * passphrase chosen by whoever held the phone), and device transfer sent the account to any scanned phone after choosing a mode.
 * The chat export already asked for the PIN. Now both check it first, with the PIN's lockout (5 wrong → 5 minutes):
 *   - ext/chat/RecoveryKitExport.tsx makeKitText: locked → refused; verifyPin false → refused (nothing read, nothing encrypted);
 *     only then the identity is read and the kit built. The modal asks for the PIN as its last step and builds only through it.
 *   - components/DeviceTransfer/DeviceTransferModal.tsx confirmTransferWithPin: the transfer starts only after
 *     ext.identity.verifyPin; the mode buttons only choose the mode.
 * Real modules bundled with esbuild (their React / UI imports stubbed), the real services/pinAuth.ts (Argon2id, lockout) for the
 * lockout cases.
 *
 *   node scripts/review/account_export_pin_self_test.mjs
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
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'exportpin-'));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

/** bundle `entry` with every import except the entry itself and the listed real ones replaced by `stubs[path]` */
async function bundle(entry, out, stubs) {
  const plugin = { name: 'stubs', setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => (a.kind === 'entry-point' || !(a.path in stubs) ? undefined : { path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: stubs[a.path] }));
  } };
  await esbuild.build({ entryPoints: [SRC + entry], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, out),
    logLevel: 'silent', jsx: 'automatic', plugins: [plugin], define: { 'import.meta.env': '{}' } });
  return import(pathToFileURL(join(dir, out)).href);
}
const reactStub = 'export const useState = (v) => [typeof v === "function" ? v() : v, () => {}]; export const useMemo = (f) => f(); '
  + 'export const useCallback = (f) => f; export const useEffect = () => {}; export const useRef = (v) => ({ current: v });';
const jsxStub = 'export const jsx = () => null; export const jsxs = () => null; export const Fragment = () => null;';

// ── the real pinAuth (Argon2id + lockout), its database replaced by memory ──
const noDb = { name: 'no-db', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'db', namespace: 'no-db' }));
  b.onLoad({ filter: /.*/, namespace: 'no-db' }, () => ({ loader: 'js', contents: 'export {}' }));
} };
await esbuild.build({ entryPoints: [SRC + '/services/pinAuth.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'pin.mjs'), logLevel: 'silent', plugins: [noDb] });
const { createPinAuth } = await import(pathToFileURL(join(dir, 'pin.mjs')).href);
const realPin = async (pin) => {
  const cache = new Map(); const db = new Map();
  const auth = createPinAuth({ getSetting: async (k) => db.get(k) ?? null, setSetting: async (k, v) => { db.set(k, v); }, deleteSetting: async (k) => { db.delete(k); } },
    { getItem: (k) => cache.get(k) ?? null, setItem: (k, v) => cache.set(k, String(v)), removeItem: (k) => cache.delete(k) });
  await auth.setPin(pin);
  return auth;
};

// ── RecoveryKitExport.tsx ──
const K = await bundle('/ext/chat/RecoveryKitExport.tsx', 'kit.mjs', {
  react: reactStub, 'react/jsx-runtime': jsxStub,
  '../../i18n/communityStrings': 'export const useCommunityStrings = () => (k) => k;',
  '../../i18n': 'export const useLanguage = () => ({ t: (k) => k });',
  '../../services/recoveryKit': 'export const createKit = async (c, p) => { globalThis.__kit.created.push([c, p]); return "KIT"; }; '
    + 'export const generatePassphrase = () => "gen"; export const normalizePassphrase = (x) => x; export const passphraseStrength = () => ({ ok: true }); '
    + 'export class KitError extends Error {}',
  '../../services/identityBlob': 'export const buildBlob = (id) => ({ blobOf: id.publicKey });',
  '../../services/serverChoice': 'export const activeServerForKit = () => null;',
  '../../services/fileOpener': 'export const saveFile = async () => ({ success: true });',
  '../../services/pinAuth': 'export const pinAuth = () => globalThis.__kit.pin;',
  './identityKeys': 'export const readUnlockedIdentity = async () => { globalThis.__kit.reads++; return { publicKey: "ME", privateKey: "SECRET" }; };',
});
const PASS = { value: 'correct horse battery staple', generated: false };
const kitWorld = (pin) => { globalThis.__kit = { pin, created: [], reads: 0 }; return globalThis.__kit; };

await check('kit: a wrong PIN builds nothing (identity not read, nothing encrypted)', async () => {
  assert.equal(typeof K.makeKitText, 'function', 'RecoveryKitExport exports makeKitText');
  const w = kitWorld(await realPin('246810'));
  const r = await K.makeKitText('111111', PASS);
  assert.deepEqual(r, { ok: false, reason: 'wrong_pin' });
  assert.equal(w.reads, 0, 'identity not read');
  assert.equal(w.created.length, 0, 'no kit');
});

await check('kit: the right PIN builds the kit from the unlocked identity with the chosen passphrase', async () => {
  const w = kitWorld(await realPin('246810'));
  const r = await K.makeKitText('246810', PASS);
  assert.deepEqual(r, { ok: true, text: 'KIT' });
  assert.deepEqual(w.created, [[{ blob: { blobOf: 'ME' }, server: null }, PASS]]);
});

await check('kit: 5 wrong PINs lock it — then even the right PIN builds nothing for 5 minutes (the login lock)', async () => {
  const w = kitWorld(await realPin('246810'));
  const reasons = [];
  for (let i = 0; i < 5; i++) reasons.push((await K.makeKitText('000000', PASS)).reason);
  assert.deepEqual(reasons, ['wrong_pin', 'wrong_pin', 'wrong_pin', 'wrong_pin', 'locked'], 'the fifth wrong PIN locks');
  assert.deepEqual(await K.makeKitText('246810', PASS), { ok: false, reason: 'locked' });
  assert.equal(w.created.length, 0);
});

await check('kit: a lock is honoured even by a verifier that would say yes (checked first)', async () => {
  const w = kitWorld({ isLockedOut: () => true, verifyPin: async () => true });
  assert.deepEqual(await K.makeKitText('246810', PASS), { ok: false, reason: 'locked' });
  assert.equal(w.created.length + w.reads, 0);
});

await check('kit: the modal builds only through makeKitText (no direct createKit / identity read)', async () => {
  const src = readFileSync(SRC + '/ext/chat/RecoveryKitExport.tsx', 'utf8');
  assert.equal((src.match(/(?<!deps\.)createKit\(/g) ?? []).length, 0, 'createKit is only called as deps.createKit');
  assert.equal((src.match(/(?<!: )readUnlockedIdentity\(/g) ?? []).length, 0, 'the identity is only read through the deps');
  assert.match(src, /const made = await makeKitText\(pin, \{ value: passphrase, generated: !own \}\);/, 'with the real deps (the real PIN check)');
});

// ── DeviceTransferModal.tsx ──
const D = await bundle('/components/DeviceTransfer/DeviceTransferModal.tsx', 'transfer.mjs', {
  react: reactStub, 'react/jsx-runtime': jsxStub,
  '@ext': 'export const ext = { identity: { verifyPin: async () => false } };',
  '../../hooks/useDeviceTransfer': 'export const useOldDeviceScanner = () => ({});',
  '../../i18n': 'export const useLanguage = () => ({ t: (k) => k });',
  '../../services/crypto': 'export class Identity {} export class SignedPreKey {}',
});

await check('transfer: a wrong PIN starts nothing; the right one starts the chosen mode (real pinAuth)', async () => {
  assert.equal(typeof D.confirmTransferWithPin, 'function', 'DeviceTransferModal exports confirmTransferWithPin');
  const auth = await realPin('975310');
  const started = [];
  const deps = { verifyPin: (p) => auth.verifyPin(p), confirmTransfer: async (m) => { started.push(m); } };
  assert.equal(await D.confirmTransferWithPin('123456', 'transfer', deps), false);
  assert.deepEqual(started, []);
  assert.equal(await D.confirmTransferWithPin('975310', 'multi-device', deps), true);
  assert.deepEqual(started, ['multi-device']);
  for (let i = 0; i < 5; i++) await D.confirmTransferWithPin('000000', 'transfer', deps);
  assert.equal(await D.confirmTransferWithPin('975310', 'transfer', deps), false, 'locked after 5 wrong PINs');
  assert.deepEqual(started, ['multi-device']);
});

await check('transfer: the mode buttons only choose; the transfer goes through ext.identity.verifyPin', async () => {
  const src = readFileSync(SRC + '/components/DeviceTransfer/DeviceTransferModal.tsx', 'utf8');
  assert.equal((src.match(/scanner\.confirmTransfer\(/g) ?? []).length, 0, 'scanner.confirmTransfer is never called directly');
  assert.match(src, /onClick=\{\(\) => setPendingMode\('transfer'\)\}/);
  assert.match(src, /onClick=\{\(\) => setPendingMode\('multi-device'\)\}/);
  assert.match(src, /confirmTransferWithPin\(pin, pendingMode, \{\s*verifyPin: \(p\) => ext\.identity\.verifyPin\(p\),\s*confirmTransfer: scanner\.confirmTransfer,/);
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS account_export_pin: the recovery kit and device transfer need the PIN (with its lockout)');

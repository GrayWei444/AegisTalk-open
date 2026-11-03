/**
 * Community edition PIN (services/pinAuth.ts, open-source step 5a): re-implemented, not vendored, so it must stay
 * compatible with the official AegisID PIN store — same Argon2id parameters, storage keys, encoding and lockout.
 *
 *   node scripts/review/pin_auth_self_test.mjs        (AEGISTALK_PYTHON with argon2-cffi enables the cross-check)
 *
 *   1. setPin writes mist_pin_hash / mist_pin_salt / aegis_backup_auth_hash to the cache and the database; the hash is
 *      Argon2id(m=64 MiB, t=3, p=4, 32 B) — checked against an independent implementation (Python argon2-cffi)
 *   2. verifyPin: right PIN ok, wrong PIN counted; 5 wrong → locked 5 min (right PIN refused while locked); expiry
 *      unlocks; a right PIN resets the counter
 *   3. hasPin reads the database when localStorage was wiped (iOS); restoreFromTransfer accepts a hash made elsewhere
 *   4. setPin refuses anything but 6 digits; clearPin removes hash, salt and backup hash
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'pinauth-'));
// the app database (lazy import in pinAuth()) is replaced by the fixtures below
const noDb = { name: 'no-db', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'db', namespace: 'no-db' }));
  b.onLoad({ filter: /.*/, namespace: 'no-db' }, () => ({ loader: 'js', contents: 'export {}' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/pinAuth.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'p.mjs'), logLevel: 'silent', plugins: [noDb] });
const { createPinAuth, PIN_KEYS } = await import(pathToFileURL(join(dir, 'p.mjs')));

function fixture() {
  const cache = new Map(); const db = new Map();
  const store = { getSetting: async (k) => db.get(k) ?? null, setSetting: async (k, v) => { db.set(k, v); }, deleteSetting: async (k) => { db.delete(k); } };
  const ls = { getItem: (k) => cache.get(k) ?? null, setItem: (k, v) => cache.set(k, String(v)), removeItem: (k) => cache.delete(k) };
  return { cache, db, auth: createPinAuth(store, ls) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const realNow = Date.now;

// 1
{
  const { cache, db, auth } = fixture();
  assert.equal(await auth.hasPin(), false);
  await auth.setPin('135790');
  await settle();
  for (const k of [PIN_KEYS.hash, PIN_KEYS.salt, PIN_KEYS.backupAuthHash]) {
    assert.ok(cache.get(k), `${k} cached`);
    assert.equal(db.get(k), cache.get(k), `${k} also in the database`);
  }
  assert.deepEqual([PIN_KEYS.hash, PIN_KEYS.salt, PIN_KEYS.backupAuthHash, PIN_KEYS.failedAttempts, PIN_KEYS.lockoutUntil],
    ['mist_pin_hash', 'mist_pin_salt', 'aegis_backup_auth_hash', 'mist_failed_attempts', 'mist_lockout_until'], 'official storage keys');
  assert.equal(Buffer.from(cache.get(PIN_KEYS.salt), 'base64').length, 32, '32-byte random salt');
  assert.equal(Buffer.from(cache.get(PIN_KEYS.hash), 'base64').length, 32, '32-byte hash');
  const python = process.env.AEGISTALK_PYTHON || 'python3';
  let cross = null;
  try {
    cross = execFileSync(python, ['-c', `
import base64, sys
from argon2.low_level import Type, hash_secret_raw
pin, salt = sys.argv[1].encode(), base64.b64decode(sys.argv[2])
h = hash_secret_raw(pin, salt, time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, type=Type.ID)
b = hash_secret_raw(pin, b'AegisTalk-BackupAuth-v1', time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, type=Type.ID)
print(base64.b64encode(h).decode(), base64.b64encode(b).decode())`, '135790', cache.get(PIN_KEYS.salt)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ');
  } catch { /* no argon2-cffi here */ }
  if (cross) {
    assert.equal(cache.get(PIN_KEYS.hash), cross[0], 'hash = Argon2id(PIN, salt, m=65536 KiB, t=3, p=4, 32 B) (independent implementation)');
    assert.equal(cache.get(PIN_KEYS.backupAuthHash), cross[1], 'backup auth hash uses the fixed official salt');
    console.log('PASS setPin: official keys, cache + database, Argon2id parameters cross-checked with argon2-cffi');
  } else {
    console.log('PASS setPin: official keys, cache + database (argon2-cffi not available: parameter cross-check skipped)');
  }
}

// 1b — fixed known answer (no external tool needed): salt[i] = i*7+1, PIN 135790; values from argon2-cffi
//      (Argon2id, m=65536 KiB, t=3, p=4, 32 B) — the same as the official AegisID pinHash.deriveKey
{
  const { cache, auth } = fixture();
  const realRandom = crypto.getRandomValues;
  crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 7 + 1) & 0xff; return a; };
  try { await auth.setPin('135790'); } finally { crypto.getRandomValues = realRandom; }
  assert.equal(cache.get(PIN_KEYS.salt), 'AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09o=', 'salt is the 32 random bytes, base64');
  assert.equal(cache.get(PIN_KEYS.hash), '/vGiqgw6DzuvT3Qxm0F4yqEFINBefWhNsp0/OFvkPSk=', 'known-answer PIN hash');
  assert.equal(cache.get(PIN_KEYS.backupAuthHash), 'iucUVsBSBtWGKjmx0+vg5kXbGIiE1HVC0vtESkXkzkE=', 'known-answer backup auth hash');
  assert.equal(await auth.verifyPin('135790'), true);
  console.log('PASS setPin matches the fixed known answer (Argon2id parameters and encoding)');
}

// 1c — lockout remaining time (the community lock screen counts it down and unlocks itself)
{
  const { auth } = fixture();
  await auth.setPin('112233');
  assert.equal(auth.getLockoutRemaining(), 0, 'not locked');
  for (let i = 0; i < 5; i++) await auth.verifyPin('000000');
  const left = auth.getLockoutRemaining();
  assert.ok(left > 4 * 60 * 1000 && left <= 5 * 60 * 1000, 'about 5 minutes left');
  console.log('PASS getLockoutRemaining reports the time left on the lock');
}

// 2
{
  const { cache, auth } = fixture();
  await auth.setPin('246813');
  assert.equal(await auth.verifyPin('246813'), true);
  assert.equal(await auth.verifyPin('000000'), false);
  assert.equal(auth.getFailedAttempts(), 1);
  assert.equal(await auth.verifyPin('246813'), true, 'right PIN');
  assert.equal(auth.getFailedAttempts(), 0, 'a right PIN resets the counter');
  for (let i = 0; i < 5; i++) assert.equal(await auth.verifyPin('111111'), false);
  assert.equal(auth.isLockedOut(), true, '5 wrong PINs lock');
  const until = Number(cache.get(PIN_KEYS.lockoutUntil));
  assert.ok(Math.abs(until - realNow() - 5 * 60 * 1000) < 5000, 'for 5 minutes');
  assert.equal(await auth.verifyPin('246813'), false, 'even the right PIN is refused while locked');
  Date.now = () => until + 1;
  try {
    assert.equal(auth.isLockedOut(), false, 'the lock expires');
    assert.equal(auth.getFailedAttempts(), 0, 'and the counter starts again');
    assert.equal(await auth.verifyPin('246813'), true);
  } finally { Date.now = realNow; }
  console.log('PASS verifyPin: counts wrong PINs, 5 → locked 5 minutes (right PIN refused), expiry and success reset');
}

// 3
{
  const a = fixture();
  await a.auth.setPin('975310');
  await settle();
  a.cache.clear();   // iOS wiped localStorage; the database copy is still there
  assert.equal(await a.auth.hasPin(), true, 'hasPin reads the database');
  assert.equal(await a.auth.verifyPin('975310'), true, 'verifyPin too');
  const b = fixture();
  await b.auth.restoreFromTransfer({ pinHash: a.db.get(PIN_KEYS.hash), pinSalt: a.db.get(PIN_KEYS.salt), backupAuthHash: a.db.get(PIN_KEYS.backupAuthHash) });
  assert.equal(await b.auth.verifyPin('975310'), true, 'a transferred hash works on the new device');
  assert.equal(await b.auth.verifyPin('975311'), false);
  console.log('PASS hasPin / verifyPin fall back to the database; a transferred PIN hash works');
}

// 4
{
  const { cache, db, auth } = fixture();
  for (const bad of ['12345', '1234567', '12a456', '']) await assert.rejects(auth.setPin(bad), /6 digits/, `refuses ${JSON.stringify(bad)}`);
  await auth.setPin('112233');
  await auth.clearPin();
  await settle();
  for (const k of [PIN_KEYS.hash, PIN_KEYS.salt, PIN_KEYS.backupAuthHash]) assert.ok(!cache.has(k) && !db.has(k), `${k} removed`);
  assert.equal(await auth.hasPin(), false);
  console.log('PASS setPin takes exactly 6 digits; clearPin removes hash, salt and backup hash');
}

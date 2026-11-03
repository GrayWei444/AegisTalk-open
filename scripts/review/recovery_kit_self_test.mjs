/**
 * Offline recovery kit (open-source step 5b, services/recoveryKit.ts + ext/chat/kitRestore.ts + services/identityBlob.ts).
 * Real modules, real group chains (groupEngineKit: real engine, store and api/group_log_routes.py), real Ed25519.
 *
 *   node scripts/review/recovery_kit_self_test.mjs     (AEGISTALK_PYTHON with fastapi for the group-log server)
 *
 *   1. passphrase: generated = 25 letters of a 32-letter alphabet in 5 groups (125 bits), typed back in any case / without
 *      dashes; a chosen one needs 16+ characters and ~72 bits (short, repeated, sequential refused); createKit refuses a
 *      weak one
 *   2. format = the documented spec, checked by an independent implementation: header fields, Argon2id m=64 MiB t=3 p=4 over
 *      a 16-byte salt, AES-256-GCM 12-byte IV, AAD = canonical JSON of the header; nothing readable in the file (no name,
 *      key, contact, server)
 *   3. round trip: identity, friends with their pre-key bundles, groups (whole signed chains, re-verified into a fresh
 *      phone: roster and current epoch key restored), display name, own signed pre-key and the server choice; flags set
 *      for session repair and account confirmation
 *   4. wrong passphrase, tampered ciphertext / created / salt / iv / pass kind, other KDF parameters, extra field, newer
 *      version, another format, truncated file, not JSON → a clear KitError code and NOTHING written by the restore
 *   5. a kit that decrypts but does not hold a usable account (missing blob, private key of another identity, a server with
 *      ws:// to a public host) → invalid_contents, nothing written
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World, E } from './groupEngineKit.mjs';
import { verify, seedOf } from './groupStateKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const { argon2id } = require('hash-wasm');
const dir = mkdtempSync(join(tmpdir(), 'kit-'));
await require('esbuild').build({
  stdin: { contents: `export * from './services/recoveryKit'; export * from './services/identityBlob'; export * from './ext/chat/kitRestore';`,
    resolveDir: SRC, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'k.mjs'), logLevel: 'silent', define: { 'import.meta.env': '{}' },
});
const K = await import(pathToFileURL(join(dir, 'k.mjs')));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); }
}
const kitError = async (p, code, what) => {
  await assert.rejects(p, (e) => e instanceof K.KitError && e.code === code, `${what}: expected KitError ${code}`);
};
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const pubOf = (privB64) => crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(privB64, 'base64')]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

// ── 1 ──
await check('generated passphrase: 25 letters, 5 groups, 32-letter alphabet; typed back in any case / without dashes', async () => {
  const p = K.generatePassphrase();
  assert.match(p, /^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
  assert.equal(K.GENERATED_ALPHABET.length, 32);
  for (const c of 'lo01') assert.ok(!K.GENERATED_ALPHABET.includes(c), `no ambiguous ${c}`);
  assert.ok(K.isGeneratedShape(p.toUpperCase().replace(/-/g, ' ')));
  assert.equal(K.normalizePassphrase(p.toUpperCase().replace(/-/g, ''), true), p.replace(/-/g, ''));
  const seen = new Set(Array.from({ length: 200 }, () => K.generatePassphrase()));
  assert.equal(seen.size, 200, 'random');
});

await check('chosen passphrase strength: 16+ characters and ~72 bits; short / repeated / sequential refused', async () => {
  assert.deepEqual([K.passphraseStrength('Tr0ub4dor&3').ok, K.passphraseStrength('Tr0ub4dor&3').reason], [false, 'too_short']);
  for (const weak of ['aaaaaaaaaaaaaaaaaaaaaaaa', 'abcdefghijklmnopqrstuvwx', '1234567890123456', 'abababababababababab']) {
    const s = K.passphraseStrength(weak);
    assert.equal(s.ok, false, `${weak} (${s.bits} bits)`);
  }
  for (const strong of ['correct horse battery staple 42', 'Mango!Fiddle7-Quartz.Lantern', '我家那隻叫豆腐的貓每天要睡十四個小時']) {
    const s = K.passphraseStrength(strong);
    assert.equal(s.ok, true, `${strong} (${s.bits} bits)`);
  }
  await kitError(K.createKit({ blob: null, server: null }, { value: 'short one', generated: false }), 'weak_passphrase', 'weak chosen');
  await kitError(K.createKit({ blob: null, server: null }, { value: 'not-a-generated-shape', generated: true }), 'weak_passphrase', 'bad generated');
});

// ── real account: Alice with two friends and a group (real chain) ──
const world = new World();
globalThis.__verify = verify;
const SERVER = { v: 1, apiUrl: 'https://chat-api.example.com', mqttUrl: 'wss://chat-mqtt.example.com/mqtt', registration: 'invite',
  apiVersion: 1, name: 'Example chat', links: { support: 'https://chat.example.com/help' } };
let A, B, C, gid, kitText, blob, pass;
try {
  [A, B, C] = await Promise.all(['alice', 'bob', 'carol'].map((l) => world.phone(l)));
  world.befriend(A, B); world.befriend(A, C); world.befriend(B, C);
  for (const p of [A, B, C]) await p.boot();
  gid = await A.engine.createGroup({ name: 'Kit group', members: [B.pk, C.pk] });
  await world.settle();
  const privA = Buffer.from(seedOf(A.id.label)).toString('base64');
  assert.equal(pubOf(privA), A.pk, 'test identity: the seed is Alice\'s key');
  const spk = { id: 7, publicKey: Buffer.alloc(32, 7).toString('base64'), privateKey: Buffer.alloc(32, 8).toString('base64'),
    signature: Buffer.alloc(64, 9).toString('base64'), timestamp: 1_800_000_000 };
  K.setBlobDataProviders({
    getDisplayName: () => 'Alice',
    getContacts: () => [B, C].map((p, i) => ({ publicKey: p.pk, nickname: ['Bob', 'Carol'][i], avatar: '', trustLevel: 'verified',
      addedAt: 1000 + i, signedPreKey: Buffer.alloc(32, 20 + i).toString('base64'), signature: Buffer.alloc(64, 30 + i).toString('base64') })),
    getGroups: () => [{ id: gid, name: 'Kit group', members: [], createdAt: 1, createdBy: A.pk, log: A.engine.backupOf(gid) }],
  });
  K.setOwnSignedPreKey(spk);
  blob = K.buildBlob({ publicKey: A.pk, privateKey: privA });
  assert.ok(blob?.groups[0]?.log?.chain?.length >= 1, 'the group backup carries its chain');
  pass = K.generatePassphrase();
  kitText = await K.createKit({ blob, server: SERVER }, { value: pass, generated: true });
} catch (e) {
  failed++;
  console.log('FAIL setup', e.stack);
}

// ── 2 ──
const b64 = (u8) => Buffer.from(u8).toString('base64');
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** an independent implementation of the documented format (key from the passphrase as the spec says) */
async function specOpen(text, passValue) {
  const f = JSON.parse(text);
  const { ct, ...header } = f;
  const pw = header.pass === 'generated' ? passValue.toLowerCase().replace(/[\s-]+/g, '') : passValue.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const raw = await argon2id({ password: pw, salt: Buffer.from(header.kdf.salt, 'base64'), memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32, outputType: 'binary' });
  const key = await crypto.webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(header.cipher.iv, 'base64'), additionalData: Buffer.from(canonical(header)) }, key, Buffer.from(ct, 'base64'));
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}
async function specCraft(header, plaintextObj, passValue) {
  const raw = await argon2id({ password: passValue, salt: Buffer.from(header.kdf.salt, 'base64'), memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32, outputType: 'binary' });
  const key = await crypto.webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: Buffer.from(header.cipher.iv, 'base64'), additionalData: Buffer.from(canonical(header)) }, key, Buffer.from(JSON.stringify(plaintextObj)));
  return JSON.stringify({ ...header, ct: b64(new Uint8Array(ct)) });
}

await check('format: the documented header, Argon2id 64 MiB / 3 / 4 over a 16-byte salt, AES-256-GCM, AAD = canonical header; nothing readable', async () => {
  const f = JSON.parse(kitText);
  assert.deepEqual(Object.keys(f).sort(), ['cipher', 'created', 'ct', 'format', 'kdf', 'pass', 'v']);
  assert.equal(f.format, 'aegistalk-recovery-kit'); assert.equal(f.v, 1); assert.equal(f.pass, 'generated');
  assert.deepEqual({ ...f.kdf, salt: undefined }, { alg: 'argon2id', m: 65536, t: 3, p: 4, salt: undefined });
  assert.equal(Buffer.from(f.kdf.salt, 'base64').length, 16); assert.equal(f.cipher.alg, 'A256GCM'); assert.equal(Buffer.from(f.cipher.iv, 'base64').length, 12);
  const inner = await specOpen(kitText, pass);
  assert.equal(inner.kit, 'aegistalk-recovery-kit'); assert.equal(inner.created, f.created);
  assert.equal(inner.blob.publicKey, A.pk); assert.deepEqual(inner.server.apiUrl, SERVER.apiUrl);
  for (const secret of ['Alice', 'Bob', 'Carol', A.pk, B.pk, blob.privateKey, 'chat-api.example.com', 'Kit group', gid]) {
    assert.ok(!kitText.includes(secret), `the file does not contain ${secret.slice(0, 12)}`);
  }
});

// ── 3 ──
function recorder() {
  const w = { server: [], keys: [], contacts: [], groups: [], name: [], flags: [] };
  return {
    w,
    written: () => Object.values(w).reduce((n, a) => n + a.length, 0),
    deps: (restoreGroups = async (g) => { w.groups.push(...g); return g.length; }) => ({
      publicKeyOf: pubOf,
      storedKeysJson: (b) => JSON.stringify({ identity: { publicKey: b.publicKey, privateKey: b.privateKey }, signedPreKey: b.signedPreKey ?? null, oneTimePreKeys: [] }),
      encrypt: async (t) => `enc(${t})`,
      saveKeys: async (e) => { w.keys.push(e); },
      addContact: async (c) => { w.contacts.push(c); },
      restoreGroups,
      setDisplayName: (n) => { w.name.push(n); },
      saveServer: (s) => { w.server.push(s); },
      setFlag: (k) => { w.flags.push(k); },
    }),
  };
}
async function restore(text, passValue, rec = recorder()) {
  const contents = await K.openKit(text, passValue);
  return { rec, result: await K.applyKit(contents, rec.deps()) };
}

await check('round trip: identity, friends + bundles, groups (signed chain → fresh phone), name, own pre-key, server, flags', async () => {
  const contents = await K.openKit(kitText, pass.toUpperCase().replace(/-/g, ''));
  const rec = recorder();
  const A2 = await world.phone('alice-restored', A);
  await A2.boot();
  const result = await K.applyKit(contents, rec.deps((groups, me) => E.restoreGroupBackups(groups, me, (...x) => globalThis.__verify(...x), A2.store)));
  assert.deepEqual(result, { publicKey: A.pk, contacts: 2, groups: 1 });
  const keys = JSON.parse(rec.w.keys[0].slice(4, -1));
  assert.equal(keys.identity.privateKey, blob.privateKey); assert.equal(keys.identity.publicKey, A.pk);
  assert.deepEqual(keys.signedPreKey, blob.signedPreKey, 'own signed pre-key restored (friends\' bundles stay valid)');
  assert.deepEqual(rec.w.contacts.map((c) => [c.publicKey, c.nickname, c.signedPreKey, c.signature]),
    blob.contacts.map((c) => [c.publicKey, c.nickname, c.signedPreKey, c.signature]));
  assert.deepEqual(rec.w.name, ['Alice']);
  assert.deepEqual(rec.w.server, [SERVER], 'server choice restored');
  assert.deepEqual(rec.w.flags.sort(), ['aegis_account_unconfirmed', 'aegis_session_repair_needed']);
  await A2.engine.adoptStored();
  await world.settle();
  assert.deepEqual(A2.roster(gid), [A.pk, B.pk, C.pk].sort(), 'group roster from the re-verified chain');
  assert.deepEqual(A2.activeKid(gid), A.activeKid(gid), 'current epoch key restored');
  A2.shutdown();
  world.phones.set(A.pk, A);
});

// ── 4 ──
await check('wrong passphrase / tampered / other parameters / truncated / not a kit → clear error, nothing written', async () => {
  const f = JSON.parse(kitText);
  const flipCt = Buffer.from(f.ct, 'base64'); flipCt[10] ^= 1;
  const otherSalt = b64(crypto.randomBytes(16)), otherIv = b64(crypto.randomBytes(12));
  const cases = [
    ['wrong passphrase', kitText, K.generatePassphrase(), 'wrong_passphrase'],
    ['one ciphertext bit', JSON.stringify({ ...f, ct: b64(flipCt) }), pass, 'wrong_passphrase'],
    ['created changed', JSON.stringify({ ...f, created: f.created + 1 }), pass, 'wrong_passphrase'],
    ['salt changed', JSON.stringify({ ...f, kdf: { ...f.kdf, salt: otherSalt } }), pass, 'wrong_passphrase'],
    ['iv changed', JSON.stringify({ ...f, cipher: { ...f.cipher, iv: otherIv } }), pass, 'wrong_passphrase'],
    ['pass kind changed', JSON.stringify({ ...f, pass: 'chosen' }), pass, 'wrong_passphrase'],
    ['weaker KDF asked', JSON.stringify({ ...f, kdf: { ...f.kdf, m: 1024 } }), pass, 'corrupt'],
    ['absurd KDF asked', JSON.stringify({ ...f, kdf: { ...f.kdf, t: 100000 } }), pass, 'corrupt'],
    ['extra field', JSON.stringify({ ...f, note: 'x' }), pass, 'corrupt'],
    ['newer version', JSON.stringify({ ...f, v: 2 }), pass, 'unsupported_version'],
    ['another format', JSON.stringify({ ...f, format: 'something-else' }), pass, 'not_a_kit'],
    ['truncated file', kitText.slice(0, Math.floor(kitText.length / 2)), pass, 'corrupt'],
    ['ciphertext cut short', JSON.stringify({ ...f, ct: f.ct.slice(0, 40) }), pass, 'wrong_passphrase'],
    ['ciphertext not base64', JSON.stringify({ ...f, ct: '%%%' }), pass, 'corrupt'],
    ['not JSON', 'hello', pass, 'not_a_kit'],
  ];
  for (const [what, text, p, code] of cases) {
    const rec = recorder();
    await kitError(restore(text, p, rec), code, what);
    assert.equal(rec.written(), 0, `${what}: nothing written`);
  }
});

// ── 5 ──
await check('decrypts but no usable account (no blob, another identity\'s key, ws:// server) → invalid_contents, nothing written', async () => {
  const f = JSON.parse(kitText);
  const { ct, ...header } = f;
  void ct;
  const pw = pass.replace(/-/g, '');
  const body = { kit: 'aegistalk-recovery-kit', v: 1, created: header.created, blob, server: SERVER };
  const privB = Buffer.from(seedOf(B.id.label)).toString('base64');
  const variants = [
    ['no blob', { ...body, blob: undefined }],
    ['private key of another identity', { ...body, blob: { ...blob, privateKey: privB } }],
    ['ws:// server on a public host', { ...body, server: { ...SERVER, mqttUrl: 'ws://chat-mqtt.example.com/mqtt' } }],
    ['created not matching the header', { ...body, created: header.created + 5 }],
  ];
  for (const [what, inner] of variants) {
    const crafted = await specCraft(header, inner, pw);
    const rec = recorder();
    await kitError(restore(crafted, pass, rec), 'invalid_contents', what);
    assert.equal(rec.written(), 0, `${what}: nothing written`);
  }
  // control: the same crafting with the real contents opens (the variants fail for their contents, not the crafting)
  assert.equal((await K.openKit(await specCraft(header, body, pw), pass)).blob.publicKey, A.pk);
});

world.close?.();
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS recovery_kit: documented authenticated format, strong passphrases, full round trip (chains re-verified), nothing written on any error');
process.exit(0);

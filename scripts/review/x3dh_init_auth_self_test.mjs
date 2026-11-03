/**
 * X3DH_INIT from an existing friend must be signed by that friend (open-source step 5b, services/x3dhInitAuth.ts).
 * Before: the INIT is plaintext on the broker and its `from` is whatever the publisher wrote, and an INIT from an existing
 * friend resets the session with him (clear session + outbox + WebRTC peer, new ratchet) — so the operator or any account
 * could force resets with all of a user's friends. Real x3dhInitAuth.ts, real Ed25519 (Node crypto), the real AppProvider
 * X3DH_INIT handler (run in a vm, its collaborators recorded).
 *
 *   node scripts/review/x3dh_init_auth_self_test.mjs
 *
 *   1. sign/verify: the signature covers from, to, ephemeral, signed pre-key + its signature, sessionReset, repair,
 *      recipientSpk and iat — changing any one of them, the recipient, or the signer fails; domain-separated; 10 minutes
 *      old / 2 minutes ahead at most; malformed and missing auth are refused
 *   2. reset budget: 5 resets per friend per 10 minutes, per friend, refilled after the window
 *   3. the handler: an existing friend's INIT without auth, signed by someone else, signed for another recipient, stale,
 *      or with a changed sessionReset flag is dropped before anything happens (no rename, no bundle update, no session
 *      cleared, no accept, nothing sent back); a correctly signed one is processed as before; a flood of distinct valid
 *      INITs resets the session at most 5 times; a stranger's INIT still goes through the via check (unchanged)
 *   4. senders: session repair, the PREKEY_REQUEST answer and the add-friend INIT go through withInitAuth (source)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { identity, verify } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'x3dhauth-'));
await esbuild.build({ entryPoints: [SRC + '/services/x3dhInitAuth.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'a.mjs'), logLevel: 'silent' });
const A = await import(pathToFileURL(join(dir, 'a.mjs')));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

const key32 = (n) => Buffer.alloc(32, n).toString('base64');
const alice = identity(), bob = identity(), mallory = identity();
const signer = (id) => ({ me: id.pk, sign: id.sign });
const NOW = 1_800_000_000_000;
const base = { ephemeralPublicKey: key32(1), signedPreKey: key32(2), signature: Buffer.alloc(64, 3).toString('base64'), sessionReset: true, repair: true, recipientSpk: key32(4) };
const signed = (p = base, from = alice, to = bob.pk, now = NOW) => ({ ...p, auth: A.signInitAuth(signer(from), to, p, now) });
const verdict = (payload, { from = alice.pk, to = bob.pk, now = NOW } = {}) => A.verifyInitAuth({ from, to, payload, now, verify });

// ── 1 ──
await check('a signed INIT verifies for its recipient; any covered field changed, another recipient or another signer fails', async () => {
  assert.equal(verdict(signed()), 'ok');
  const p = signed();
  for (const [k, v] of [['ephemeralPublicKey', key32(9)], ['signedPreKey', key32(9)], ['signature', Buffer.alloc(64, 9).toString('base64')],
    ['sessionReset', false], ['repair', false], ['recipientSpk', key32(9)]]) {
    assert.equal(verdict({ ...p, [k]: v }), 'bad-signature', `${k} is covered`);
  }
  assert.equal(verdict({ ...p, auth: { ...p.auth, iat: p.auth.iat + 1 } }), 'bad-signature', 'iat is covered');
  assert.equal(verdict(p, { to: mallory.pk }), 'bad-signature', 'bound to the recipient');
  assert.equal(verdict(p, { from: mallory.pk }), 'bad-signature', 'bound to the sender');
  assert.equal(verdict(signed(base, mallory)), 'bad-signature', 'signed by someone else for the claimed sender');
  // domain separation: the same body signed without the domain prefix does not verify
  const raw = A.initAuthMessage(alice.pk, bob.pk, base, NOW);
  const body = raw.subarray(Buffer.byteLength(A.X3DH_INIT_AUTH_DOMAIN) + 1);
  assert.equal(new TextDecoder().decode(raw).startsWith(A.X3DH_INIT_AUTH_DOMAIN + '\n'), true);
  const noDomain = { ...base, auth: { iat: NOW, sig: Buffer.from(alice.sign(body)).toString('base64') } };
  assert.equal(verdict(noDomain), 'bad-signature', 'domain-separated');
});

await check('freshness: 10 minutes old at most, 2 minutes ahead at most; missing / malformed auth refused', async () => {
  const p = signed();
  assert.equal(verdict(p, { now: NOW + 10 * 60_000 }), 'ok');
  assert.equal(verdict(p, { now: NOW + 10 * 60_000 + 1 }), 'stale');
  assert.equal(verdict(p, { now: NOW - 2 * 60_000 }), 'ok');
  assert.equal(verdict(p, { now: NOW - 2 * 60_000 - 1 }), 'stale');
  assert.equal(verdict(base), 'missing');
  for (const auth of [{}, { iat: 'x', sig: p.auth.sig }, { iat: NOW, sig: 'short' }, { iat: 1.5, sig: p.auth.sig }, 'x', 7]) {
    assert.equal(verdict({ ...base, auth }), 'malformed', JSON.stringify(auth));
  }
  assert.equal(verdict(p, { from: 'not-a-key' }), 'malformed');
});

// ── 2 ──
await check('reset budget: 5 per friend per 10 minutes, separate per friend, refilled after the window', async () => {
  const b = A.createResetBudget();
  for (let i = 0; i < 5; i++) assert.equal(b.take('F', NOW + i), true);
  assert.equal(b.take('F', NOW + 10), false, '6th within 10 minutes refused');
  assert.equal(b.take('G', NOW + 10), true, 'another friend has its own budget');
  assert.equal(b.take('F', NOW + 10 * 60_000 + 5), true, 'refilled after the window');
  assert.equal(A.RESET_BUDGET_MAX, 5);
  assert.equal(A.RESET_BUDGET_WINDOW_MS, 10 * 60_000);
});

// ── 3: the real handler ──
const provider = readFileSync(SRC + '/providers/AppProvider.tsx', 'utf8');
const cut = (text, from, to) => { const a = text.indexOf(from); const b = text.indexOf(to, a + 1); assert.ok(a >= 0 && b > a, `${from}…${to}`); return text.slice(a, b); };
const handlerSrc = esbuild.transformSync(cut(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息')
  .replace(/\bimport\(/g, '__import('), { loader: 'tsx' }).code;
const budgetLine = provider.match(/const initResetBudget = createResetBudget\((.*)\);/);
assert.ok(budgetLine, 'AppProvider keeps a module-level reset budget');

function phone({ friend, budget = A.createResetBudget(), now = NOW }) {
  let handler;
  const r = { added: [], accepted: [], cleared: [], sent: [], renamed: [], errors: [] };
  runInNewContext(handlerSrc, {
    useEffect: (fn) => fn(), Date: { now: () => now }, JSON, Promise,
    console: { error: (...a) => r.errors.push(a.join(' ')), log() {}, warn() {} },
    mqtt: { isConnected: true, subscribe: (_t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: { X3DH_INIT: 'x3dh_init' }, getFriendByPublicKey: () => undefined,
    findFriendSettled: async (pk) => (pk === friend?.publicKey ? friend : undefined),
    updateFriendProfile: (...a) => r.renamed.push(a), addFriend: (...a) => r.added.push(a),
    fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, devLog() {}, publicKey: bob.pk, friendViaSealer: null,
    hasSessionWith: () => true, wasInitAccepted: () => false, isInitOlderThanAccepted: () => false, recentlyInitiatedTo: () => false, rememberAcceptedInit() {},
    signedPreKey: { publicKeyBase64: base.recipientSpk, signatureBase64: 'S' },
    mqttService: { sendToUser: (to, type) => r.sent.push([to, type]), serverNow: () => now, boundedNow: () => now },
    verifyInitAuth: A.verifyInitAuth, identityVerify: verify, initResetBudget: budget,
    sendProfileUpdate: async (to) => { r.sent.push([to, 'profile']); return true; }, sendPrekeyRequest: async (to) => { r.sent.push([to, 'prekey']); return true; },
    viaName: async () => 'Alice2', acceptedVia: async () => null, cleanPeerName: (n, d) => n || d, isBlacklisted: async () => false,
    clearPeerSession: async (pk) => r.cleared.push(pk), deletePendingMessagesForRecipient: async () => {},
    webrtcService: { disconnect() {} }, acceptSession: (...a) => r.accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }), getServiceTranslation: () => (k) => k,
    localStorage: { getItem: () => null }, useChatStore: { getState: () => ({ userProfile: { displayName: 'Bob' }, updateFriendTrust() {} }) },
    usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  });
  return { r, deliver: (from, payload) => handler({ from, payload }) };
}
const friendA = { id: 'friend-a', publicKey: alice.pk, name: 'Alice', trustLevel: 'verified', avatar: '', signedPreKey: key32(2), signature: 'G' };
const untouched = (r) => r.added.length === 0 && r.accepted.length === 0 && r.cleared.length === 0 && r.sent.length === 0 && r.renamed.length === 0;
const eph = (n) => key32(40 + n);
const initFor = (n, extra = {}) => ({ ephemeralPublicKey: eph(n), signedPreKey: key32(2), signature: 'G', sessionReset: true, recipientSpk: base.recipientSpk, via: 'v', ...extra });

await check('handler: an existing friend\'s INIT without a valid signature changes nothing (no rename, bundle, session, accept, reply)', async () => {
  const cases = {
    'no auth': initFor(1),
    'signed by Mallory': { ...initFor(2), auth: A.signInitAuth(signer(mallory), bob.pk, initFor(2), NOW) },
    'signed for another recipient': { ...initFor(3), auth: A.signInitAuth(signer(alice), mallory.pk, initFor(3), NOW) },
    'stale (11 minutes)': { ...initFor(4), auth: A.signInitAuth(signer(alice), bob.pk, initFor(4), NOW - 11 * 60_000) },
    'reset flag added after signing': { ...initFor(5, { sessionReset: false }), auth: A.signInitAuth(signer(alice), bob.pk, initFor(5, { sessionReset: false }), NOW), sessionReset: true },
  };
  for (const [name, payload] of Object.entries(cases)) {
    const p = phone({ friend: friendA });
    await p.deliver(alice.pk, payload);
    assert.ok(untouched(p.r), `${name}: ${JSON.stringify({ added: p.r.added.length, accepted: p.r.accepted.length, cleared: p.r.cleared.length, sent: p.r.sent })}`);
    assert.ok(p.r.errors.some((e) => e.includes('[DIAG:X3DH:RX]')), `${name}: logged`);
  }
});

await check('handler: a correctly signed INIT from the friend is processed as before (session reset + accept + profile back)', async () => {
  const p = phone({ friend: friendA });
  const payload = initFor(6);
  await p.deliver(alice.pk, { ...payload, auth: A.signInitAuth(signer(alice), bob.pk, payload, NOW) });
  assert.deepEqual(p.r.cleared, [alice.pk], 'session cleared (sessionReset)');
  assert.equal(p.r.accepted.length, 1, 'accepted');
  assert.ok(p.r.sent.some(([to, t]) => to === alice.pk && t === 'profile'), 'profile sent back');
});

await check('handler: a flood of distinct validly signed INITs resets the session at most 5 times in 10 minutes', async () => {
  const budget = A.createResetBudget();
  let resets = 0;
  for (let i = 0; i < 20; i++) {
    const p = phone({ friend: friendA, budget });
    const payload = initFor(100 + i);
    await p.deliver(alice.pk, { ...payload, auth: A.signInitAuth(signer(alice), bob.pk, payload, NOW) });
    resets += p.r.accepted.length;
    if (i >= 5) assert.equal(p.r.cleared.length, 0, `INIT ${i + 1}: no session cleared over budget`);
  }
  assert.equal(resets, 5);
});

await check('handler: a stranger\'s INIT still goes through the via check (no auth needed, refused without a matching via)', async () => {
  const p = phone({ friend: undefined });
  await p.deliver(mallory.pk, initFor(7));   // acceptedVia → null in this phone
  assert.ok(untouched(p.r));
  assert.ok(p.r.errors.some((e) => e.includes('拒收')));
});

// ── 4: senders ──
await check('senders: repair INIT, PREKEY_REQUEST answer and add-friend INIT carry the identity signature (withInitAuth)', async () => {
  const sends = provider.match(/mqttService\.sendToUser\([^,]+, MessageType\.X3DH_INIT, [^\n]*/g) ?? [];
  assert.equal(sends.length, 2, 'two INIT senders in AppProvider');
  for (const s of sends) assert.match(s, /withInitAuth\(/, s);
  const modal = readFileSync(SRC + '/components/Verification/AddFriendModal.tsx', 'utf8');
  assert.match(modal, /mqttService\.sendToUser\(peerData\.pk, MessageType\.X3DH_INIT, withInitAuth\(peerData\.pk, initPayload\)\)/);
  const send = readFileSync(SRC + '/services/x3dhInitSend.ts', 'utf8');
  assert.match(send, /signInitAuth\(signer, to, payload, mqttService\.serverNow\(\)\)/, 'iat on the server-corrected clock');
  // the auth check runs first in the existing-friend branch (before rename / bundle update)
  const branch = cut(provider, '        if (existingFriend) {\n', '        } else {\n          // 封鎖過的人');
  const iAuth = branch.indexOf('verifyInitAuth('), iRename = branch.indexOf('updateFriendProfile('), iBundle = branch.indexOf('addFriend(');
  assert.ok(iAuth > 0 && iAuth < iRename && iAuth < iBundle, 'signature checked before anything else');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS x3dh_init_auth: existing friends\' INITs are signed, bound, fresh, budgeted; forged ones change nothing');

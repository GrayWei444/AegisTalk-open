/**
 * A recorded X3DH_INIT cannot be replayed later by moving the receiver's clock (security review M1).
 * Before: an existing friend's INIT was judged fresh on mqttService.serverNow() — the device clock plus whatever offset the
 * server's token response set, with no limit — and accepted ephemerals were kept for 48 hours only. An operator who recorded a
 * friend's signed INIT could, more than 48 hours later, answer one token request with a server time near that INIT's iat and
 * publish the INIT again: the session with the friend was reset, his stale pre-key bundle stored and his old name applied.
 * Now: (1) freshness is judged on mqttService.boundedNow() (the W5 rule: at most 5 minutes of server offset are believed);
 * (2) every accepted INIT leaves a persisted, non-expiring "newest iat from this friend" mark (services/x3dhReplay.ts), and an
 * INIT older than the mark is refused before anything happens — also inside the freshness window (an INIT the operator held
 * back and delivers after a newer one).
 * Real x3dhReplay.ts, real x3dhInitAuth.ts, real presenceClock (the bounded clock), real Ed25519, the real AppProvider
 * X3DH_INIT handler in a vm with its collaborators recorded.
 *
 *   node scripts/review/x3dh_init_mark_self_test.mjs
 */
import assert from 'node:assert/strict';
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
const dir = mkdtempSync(join(tmpdir(), 'x3dhmark-'));
const bundle = async (entry, out) => {
  await esbuild.build({ entryPoints: [SRC + entry], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, out), logLevel: 'silent' });
  return pathToFileURL(join(dir, out)).href;
};
const authUrl = await bundle('/services/x3dhInitAuth.ts', 'auth.mjs');
const replayUrl = await bundle('/services/x3dhReplay.ts', 'replay.mjs');
const clockUrl = await bundle('/services/presenceSecret.ts', 'clock.mjs');
const A = await import(authUrl);
const { presenceClock } = await import(clockUrl);

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

// one localStorage for the whole phone (persisted across "reloads" = fresh module instances), a device clock we move
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const T0 = 1_800_000_000_000, MIN = 60_000, HOUR = 60 * MIN;
let device = T0;
Date.now = () => device;
let reloads = 0;
const freshReplay = () => import(`${replayUrl}?reload${reloads++}`);

// ── 1: the marks (real x3dhReplay.ts) ──
await check('marks: newest accepted iat per account and friend; older refused, equal / newer not; no iat → no mark', async () => {
  mem.clear();
  const R = await freshReplay();
  assert.equal(typeof R.isInitOlderThanAccepted, 'function', 'x3dhReplay exports isInitOlderThanAccepted');
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0), false, 'nothing accepted yet');
  R.rememberAcceptedInit('me', 'alice', 'E1', T0 + MIN);
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0), true, 'older than the accepted one');
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0 + MIN), false, 'the same iat goes on to the duplicate check');
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0 + 2 * MIN), false, 'newer');
  assert.equal(R.isInitOlderThanAccepted('me', 'bob', T0), false, 'per friend');
  assert.equal(R.isInitOlderThanAccepted('other-account', 'alice', T0), false, 'per account');
  R.rememberAcceptedInit('me', 'alice', 'E0', T0);
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0 + MIN / 2), true, 'an older accept never lowers the mark');
  R.rememberAcceptedInit('me', 'carol', 'E2');
  assert.equal(R.isInitOlderThanAccepted('me', 'carol', 0), false, 'accepted without iat (stranger branch): no mark');
  for (const bad of ['1', 1.5, NaN, null, undefined, {}]) assert.equal(R.isInitOlderThanAccepted('me', 'alice', bad), false, `malformed iat ${String(bad)}`);
});

await check('marks are persisted and never expire: after a reload and 49 hours the old INIT is still older', async () => {
  device = T0 + 49 * HOUR;
  const R = await freshReplay();
  assert.equal(R.isInitOlderThanAccepted('me', 'alice', T0), true, 'still refused after the 48 h ephemeral list expired');
  assert.equal(R.wasInitAccepted('me', 'alice', 'E1'), false, '(the 48 h ephemeral list itself has expired)');
  device = T0;
});

await check('without storage the marks still hold for the page', async () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  try {
    const R = await freshReplay();
    R.rememberAcceptedInit('me', 'dave', 'E9', T0 + 5 * MIN);
    assert.equal(R.isInitOlderThanAccepted('me', 'dave', T0), true);
  } finally { globalThis.localStorage = saved; }
});

// ── 2: the real handler ──
const provider = readFileSync(SRC + '/providers/AppProvider.tsx', 'utf8');
const cut = (text, from, to) => { const a = text.indexOf(from); const b = text.indexOf(to, a + 1); assert.ok(a >= 0 && b > a, `${from}…${to}`); return text.slice(a, b); };
const handlerSrc = esbuild.transformSync(cut(provider, '// 監聽 X3DH_INIT 訊息 - 接收端建立 session', '// 監聽 PREKEY_REQUEST 訊息')
  .replace(/\bimport\(/g, '__import('), { loader: 'tsx' }).code;

const key32 = (n) => Buffer.alloc(32, n).toString('base64');
const alice = identity(), bob = identity();
const signer = { me: alice.pk, sign: alice.sign };
const SPK = key32(4);
const friendA = { id: 'friend-a', publicKey: alice.pk, name: 'Alice', trustLevel: 'verified', avatar: '', signedPreKey: key32(2), signature: 'G' };
/** Alice's genuine INIT number n, signed at `iat` on her server-corrected clock */
const initAt = (n, iat) => {
  const p = { ephemeralPublicKey: key32(40 + n), signedPreKey: key32(60 + n), signature: 'G', sessionReset: true, recipientSpk: SPK, via: 'v' };
  return { ...p, auth: A.signInitAuth(signer, bob.pk, p, iat) };
};

/**
 * Bob's phone. offsetMs = the server offset the last token response set (the operator chooses it): serverNow is the device
 * clock plus that offset, boundedNow is the same with the offset capped (the real presenceClock).
 */
async function phone({ offsetMs = 0, R }) {
  let handler;
  const r = { added: [], accepted: [], cleared: [], sent: [], renamed: [], errors: [] };
  runInNewContext(handlerSrc, {
    useEffect: (fn) => fn(), Date: { now: () => device }, JSON, Promise,
    console: { error: (...a) => r.errors.push(a.join(' ')), log() {}, warn() {} },
    mqtt: { isConnected: true, subscribe: (_t, cb) => { handler = cb; return () => {}; } },
    cryptoReady: true, MessageType: { X3DH_INIT: 'x3dh_init' }, getFriendByPublicKey: () => undefined,
    findFriendSettled: async (pk) => (pk === friendA.publicKey ? friendA : undefined),
    updateFriendProfile: (...a) => r.renamed.push(a), addFriend: (...a) => r.added.push(a),
    fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, devLog() {}, publicKey: bob.pk, friendViaSealer: null,
    hasSessionWith: () => true, recentlyInitiatedTo: () => false,
    wasInitAccepted: R.wasInitAccepted, rememberAcceptedInit: R.rememberAcceptedInit, isInitOlderThanAccepted: R.isInitOlderThanAccepted,
    signedPreKey: { publicKeyBase64: SPK, signatureBase64: 'S' },
    mqttService: { sendToUser: (to, type) => r.sent.push([to, type]), serverNow: () => device + offsetMs, boundedNow: () => presenceClock(device, offsetMs) },
    verifyInitAuth: A.verifyInitAuth, identityVerify: verify, initResetBudget: A.createResetBudget(),
    sendProfileUpdate: async (to) => { r.sent.push([to, 'profile']); return true; }, sendPrekeyRequest: async (to) => { r.sent.push([to, 'prekey']); return true; },
    viaName: async () => 'Alice (old name)', acceptedVia: async () => null, cleanPeerName: (n, d) => n || d, isBlacklisted: async () => false,
    clearPeerSession: async (pk) => r.cleared.push(pk), deletePendingMessagesForRecipient: async () => {},
    webrtcService: { disconnect() {} }, acceptSession: (...a) => r.accepted.push(a), flushSessionWrites: async () => {},
    __import: async () => ({ flushQueueForPeer: async () => {} }), getServiceTranslation: () => (k) => k,
    localStorage: globalThis.localStorage, useChatStore: { getState: () => ({ userProfile: { displayName: 'Bob' }, updateFriendTrust() {} }) },
    usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  });
  return { r, deliver: (payload) => handler({ from: alice.pk, payload }) };
}
const untouched = (r) => r.added.length === 0 && r.accepted.length === 0 && r.cleared.length === 0 && r.sent.length === 0 && r.renamed.length === 0;
const summary = (r) => JSON.stringify({ added: r.added.length, accepted: r.accepted.length, cleared: r.cleared.length, renamed: r.renamed.length, sent: r.sent.length });

await check('handler: the operator replays Alice\'s INIT 49 h later and sets my server time to its iat → refused, nothing changes', async () => {
  mem.clear(); device = T0;
  const init1 = initAt(1, T0);
  let p = await phone({ R: await freshReplay() });
  await p.deliver(init1);
  assert.equal(p.r.accepted.length, 1, 'the genuine INIT is accepted when it arrives');
  // 49 hours later, after a reload: the 48 h ephemeral list has expired; the operator's token response says "it is T0 + 1 min"
  device = T0 + 49 * HOUR;
  p = await phone({ offsetMs: (T0 + MIN) - device, R: await freshReplay() });
  await p.deliver(init1);
  assert.ok(untouched(p.r), `no reset, no stale bundle, no old name: ${summary(p.r)}`);
  assert.ok(p.r.errors.some((e) => e.includes('[DIAG:X3DH:RX]')), 'logged');
});

await check('handler: an INIT the operator held back and delivers after a newer one (inside the 10-minute window) → refused', async () => {
  mem.clear(); device = T0;
  const older = initAt(2, T0), newer = initAt(3, T0 + MIN);
  device = T0 + 90_000;
  let p = await phone({ R: await freshReplay() });
  await p.deliver(newer);
  assert.equal(p.r.accepted.length, 1, 'the newer INIT is accepted');
  p = await phone({ R: await freshReplay() });   // and after a reload
  await p.deliver(older);
  assert.ok(untouched(p.r), `the older INIT changes nothing (no bundle from it, no rename, no reset): ${summary(p.r)}`);
});

await check('handler: Alice\'s genuine later INIT is still processed (reset + accept), and the mark moves forward', async () => {
  device = T0 + 3 * MIN;
  const p = await phone({ R: await freshReplay() });
  await p.deliver(initAt(4, T0 + 2 * MIN));
  assert.equal(p.r.cleared.length, 1, 'session reset');
  assert.equal(p.r.accepted.length, 1, 'accepted');
  const R = await freshReplay();
  assert.equal(R.isInitOlderThanAccepted(bob.pk, alice.pk, T0 + MIN), true, 'the mark is the newest accepted iat');
});

await check('handler: a phone whose server offset is within the 5-minute cap still accepts a fresh INIT', async () => {
  mem.clear(); device = T0;
  const p = await phone({ offsetMs: 4 * MIN, R: await freshReplay() });
  await p.deliver(initAt(5, T0 + 4 * MIN));
  assert.equal(p.r.accepted.length, 1);
});

await check('source: the existing-friend branch checks the bounded clock and the mark before rename / bundle update', async () => {
  const branch = cut(provider, '        if (existingFriend) {\n', '        } else {\n          // 封鎖過的人');
  assert.match(branch, /verifyInitAuth\(\{[^}]*now: mqttService\.boundedNow\(\)/, 'freshness on boundedNow');
  const iMark = branch.indexOf('isInitOlderThanAccepted('), iRename = branch.indexOf('updateFriendProfile('), iBundle = branch.indexOf('addFriend(');
  assert.ok(iMark > 0 && iMark < iRename && iMark < iBundle, 'mark checked before anything else changes');
  assert.match(provider, /rememberAcceptedInit\(publicKey, senderPublicKeyBase64, payload\.ephemeralPublicKey, verifiedIat\)/, 'the accepted iat is remembered');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS x3dh_init_mark: INIT freshness on the bounded clock; older INITs than the newest accepted one are refused, persistently');

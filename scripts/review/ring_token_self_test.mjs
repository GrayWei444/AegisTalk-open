/**
 * 來電者簽章的響鈴 token（開源第 5d 步，services/ringToken.ts、services/ringDirectory.ts；docs/DIRECT_SEALED.md §4「Push ring」）：
 * 真的 ringToken.ts／ringDirectory.ts／pushRequest.ts（esbuild），Node crypto 與 WebCrypto 的 Ed25519。
 *   以前：推播的全螢幕來電只看推播伺服器給的 senderPubkey —— 營運方能讓手機用好友的名字全螢幕響鈴。
 *   1. 好友簽、寄給我、新鮮、這一通沒響過 → 響（名字是本機存的、視訊與否是 token 簽的）
 *   2. 偽造的簽章、竄改過的內容、寄給別人、推播說的寄件人跟 token 不同、陌生人／封鎖的（不在好友名單）、重放（同一張、同一個 callId
 *      重簽）、太舊、太新、別的網域、沒有 token、我還沒同步 → 不響；偽造的 token 不能先佔掉真的 callId
 *   3. 只有一種寫法（claims 的樣式、base64url 的正規寫法）：多一個欄位、多一個空白、多餘的位元都不收
 *   4. 推播 → 響不響、叫什麼名字（decideRingWith）：推播裡的名字一律不用；時鐘差照名單上的；不是來電不響
 *   5. 跨實作的測試向量（android/app/src/test/resources/ring_token_vectors.json）：這裡產生、比對、用 JS 驗；原生 RingToken.kt 的
 *      JVM 單元測試驗同一份（node scripts/review/ring_token_self_test.mjs --write 重新產生）
 *   6. 接線：發起方的推播帶這一通的 callId 簽的 token（每次重簽都用同一個時間）；serverPushHint 只讓來電帶、長得像的 token 過；
 *      service worker 用 decideRing；原生 AegisFCMService 驗過才全螢幕
 * Run: node scripts/review/ring_token_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, verify } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const ANDROID = process.env.AEGISTALK_ANDROID_APP ?? root + 'packages/pwa/android/app';
const VECTORS = ANDROID + '/src/test/resources/ring_token_vectors.json';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'ringtoken-'));
await require('esbuild').build({
  stdin: { contents: "export * from './ringToken'; export * from './ringDirectory'; export { serverPushHint } from './pushRequest';",
    resolveDir: SRC + '/services', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent',
});
const R = await import(pathToFileURL(join(dir, 'r.mjs')).href);
const P = R.AEGISTALK_RING_PREFIX;
const MIN = 60_000;
const NOW = 1_900_000_000_000;

const seed = (label) => crypto.createHash('sha256').update(`aegistalk ring vector: ${label}`).digest();
const friend = identity(seed('friend'));
const me = identity(seed('me'));
const mallory = identity(seed('mallory'));
const other = identity(seed('other recipient'));
const id22 = (label) => crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22);

const sign = (o = {}) => R.signRingToken({
  prefix: P, callId: o.callId ?? id22('call-' + Math.random()), from: (o.from ?? friend).pk, to: (o.to ?? me).pk,
  video: o.video ?? false, now: o.now ?? NOW, sign: (o.signer ?? o.from ?? friend).sign, nonce: o.nonce,
});
const friendsOf = (list) => (pk) => (list.some((x) => x.pk === pk) ? pk : null);
const check = (token, o = {}) => R.verifyRingToken({
  token, prefix: o.prefix ?? P, me: o.me === undefined ? me.pk : o.me, sender: o.sender === undefined ? friend.pk : o.sender,
  friendKey: o.friendKey ?? friendsOf([friend]), verify: o.verify ?? verify, now: o.now ?? NOW, replay: o.replay ?? R.createMemoryRingReplay(),
});
const reason = async (token, o) => { const v = await check(token, o); return v.ok ? 'ok' : v.reason; };
/** 改 claims（保留原來的簽章）／用別的前綴簽／改寫 claims 的 JSON 字串 */
const parts = (t) => t.split('.');
const b64u = (s) => Buffer.from(s).toString('base64url');
const claimsOf = (t) => Buffer.from(parts(t)[1], 'base64url').toString('utf8');
const withClaims = (t, text) => `r1.${b64u(text)}.${parts(t)[2]}`;
/** 簽章最後一個字元只改「多餘的位元」（64 bytes → 86 字元，最後一個字元的低 4 位元沒用到）：同一組 bytes 的第二種寫法 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const spareBits = (t) => t.slice(0, -1) + B64URL[B64URL.indexOf(t.at(-1)) + 1];
const signRaw = (text, signer = friend, prefix = P) =>
  `r1.${b64u(text)}.${Buffer.from(signer.sign(Buffer.concat([Buffer.from(prefix + ':'), Buffer.from(text)]))).toString('base64url')}`;

// ── 1 ──
{
  const t = sign({ callId: id22('one'), video: true });
  assert.match(t, /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  assert.ok(t.length < R.RING_TOKEN_MAX_LEN, `fits the server limit (${t.length})`);
  const claims = JSON.parse(claimsOf(t));
  assert.deepEqual(Object.keys(claims), ['v', 'd', 'callId', 'from', 'to', 'iat', 'nonce', 'video']);
  assert.ok(!/name|nick|avatar/i.test(claimsOf(t)), 'the token carries no name');
  const v = await check(t);
  assert.deepEqual(v, { ok: true, from: friend.pk, callId: id22('one'), video: true, iat: NOW }, 'a friend\'s fresh token for me rings');
  const w = await check(sign({ callId: id22('one-webcrypto') }), { verify: R.webCryptoEd25519Verify });
  assert.equal(w.ok, true, 'the service worker\'s WebCrypto Ed25519 verifies it too');
  assert.equal(await R.webCryptoEd25519Verify(new Uint8Array(32), new Uint8Array(1), new Uint8Array(64)), false, 'WebCrypto: a bad key never verifies');
  assert.throws(() => R.signRingToken({ prefix: 'Bad Prefix', callId: id22('x'), from: friend.pk, to: me.pk, video: false, now: NOW, sign: friend.sign }), /prefix/);
  assert.throws(() => R.signRingToken({ prefix: P, callId: 'short', from: friend.pk, to: me.pk, video: false, now: NOW, sign: friend.sign }), /callId/);
  console.log('PASS a friend\'s fresh ring token for me verifies (Node and WebCrypto Ed25519); no name in the token');
}

// ── 2 ──
{
  const replay = R.createMemoryRingReplay();
  const t = sign({ callId: id22('two') });
  assert.equal(await reason(sign({ callId: id22('forged'), signer: mallory })), 'bad-signature', 'forged signature (Mallory signs as the friend)');
  assert.equal(await reason(withClaims(t, claimsOf(t).replace(id22('two'), id22('swapped')))), 'bad-signature', 'tampered claims');
  assert.equal(await reason(sign({ callId: id22('to-other'), to: other })), 'wrong-recipient', 'a token for someone else');
  assert.equal(await reason(t, { sender: mallory.pk }), 'sender-mismatch', 'the push names another sender than the token');
  assert.equal(await reason(sign({ callId: id22('stranger'), from: mallory }), { sender: mallory.pk }), 'unknown-caller', 'a stranger\'s own valid token');
  assert.equal(await reason(t, { friendKey: () => null }), 'unknown-caller', 'blocked / removed friend (not in the friend list)');
  assert.equal(await reason(t, { friendKey: () => { throw new Error('db'); } }), 'unknown-caller', 'friend list unreadable → no ring');
  assert.equal(await reason(t, { me: null }), 'no-context', 'not signed in / not synced');
  for (const missing of [undefined, null, '']) assert.equal(await reason(missing), 'missing');
  assert.equal(await reason(sign({ callId: id22('stale'), now: NOW - 5 * MIN - 1 })), 'stale');
  assert.equal(await reason(sign({ callId: id22('future'), now: NOW + 5 * MIN + 1 })), 'future');
  assert.equal(await reason(sign({ callId: id22('edge-old'), now: NOW - 5 * MIN })), 'ok', '5 minutes old still rings');
  assert.equal(await reason(sign({ callId: id22('edge-new'), now: NOW + 5 * MIN })), 'ok', '5 minutes ahead still rings');
  assert.equal(await reason(t, { now: NaN }), 'stale');
  assert.equal(await reason(t, { replay }), 'ok');
  assert.equal(await reason(t, { replay }), 'replay', 'the same token again');
  assert.equal(await reason(sign({ callId: id22('two') }), { replay }), 'replay', 'the same call id re-signed (new nonce)');
  // 偽造的 token 不能先佔掉真的 callId（只記驗過的）
  const r2 = R.createMemoryRingReplay();
  assert.equal(await reason(sign({ callId: id22('real'), signer: mallory }), { replay: r2 }), 'bad-signature');
  assert.equal(await reason(sign({ callId: id22('real'), from: mallory }), { replay: r2, sender: mallory.pk }), 'unknown-caller');
  assert.equal(await reason(sign({ callId: id22('real') }), { replay: r2 }), 'ok', 'forged / stranger tokens did not burn the genuine call id');
  // 網域
  const otherDomain = R.signRingToken({ prefix: 'other-ring-v1', callId: id22('dom'), from: friend.pk, to: me.pk, video: false, now: NOW, sign: friend.sign });
  assert.equal(await reason(otherDomain), 'wrong-domain');
  assert.equal(await reason(signRaw(claimsOf(sign({ callId: id22('xdom') })), friend, 'other-ring-v1')), 'bad-signature',
    'claims saying this domain but signed for another one');
  assert.equal(await reason(otherDomain, { prefix: 'other-ring-v1' }), 'ok', 'the prefix is a parameter (port to another app)');
  await assert.rejects(check(t, { prefix: 'X' }), /prefix/);
  console.log('PASS forged, tampered, misaddressed, stranger/blocked, stale/future, replayed and foreign-domain tokens do not ring; forged ones burn no call id');
}

// ── 3 ──
{
  const t = sign({ callId: id22('three') });
  const text = claimsOf(t);
  const malformed = [
    signRaw(text.replace('{"v":1,', '{"v":1, ')),                                    // 多一個空白
    signRaw(text.replace('}', ',"name":"Mom"}')),                                    // 多一個欄位
    signRaw(text.replace(',"video":false', '')),                                      // 少一個欄位
    signRaw(text.replace('"v":1,"d"', '"d"').replace('"callId"', '"v":1,"callId"')),  // 欄位順序不同
    signRaw(text.replace(/"iat":\d+/, '"iat":9007199254740993')),                     // 超過安全整數
    signRaw(text.replace(/"iat":\d+/, '"iat":1.9e12')),
    signRaw(text.replace('"video":false', '"video":0')),
    t.replace(/^r1\./, 'r2.'),
    t + 'x',
    spareBits(t),                                                                     // 簽章的最後一個字元多餘的位元
    `r1.${parts(t)[1]}=.${parts(t)[2]}`,
    'r1.' + 'A'.repeat(900) + '.' + parts(t)[2],
    42, {}, ['r1'],
  ];
  for (const m of malformed) assert.equal(await reason(m), m === t ? 'ok' : 'malformed', `malformed: ${String(m).slice(0, 60)}`);
  assert.equal(R.parseRingToken(t)?.claims.callId, id22('three'));
  console.log('PASS only one encoding is accepted (claims pattern, canonical base64url, no extra / missing / reordered fields)');
}

// ── 4 ──
{
  const dirOf = (o = {}) => async () => ({ me: me.pk, friends: { [friend.pk]: 'Mom' }, offsetMs: o.offsetMs ?? 0, at: 0 });
  const decide = (data, o = {}) => R.decideRingWith(data, o.deviceNow ?? NOW, {
    directory: o.directory ?? dirOf(o), replay: o.replay ?? R.createMemoryRingReplay(), verify,
  });
  const t = sign({ callId: id22('four'), video: true });
  const push = { type: 'incoming_call', action: 'wake_and_sync', senderPubkey: friend.pk, isVideoCall: 'false', ringToken: t,
    callerName: 'Bank', title: '銀行', body: '轉帳' };
  assert.deepEqual(await decide(push), { name: 'Mom', video: true, callId: id22('four') },
    'the name comes from my friend list, video from the signed token — never from the push');
  assert.equal(await decide({ ...push, type: 'message' }), null, 'only incoming_call can ring');
  assert.equal(await decide({ ...push, ringToken: undefined }), null, 'no token → no ring (server-named sender is not enough)');
  assert.equal(await decide({ ...push, senderPubkey: mallory.pk }), null);
  assert.equal(await decide(push, { directory: async () => null }), null, 'nothing synced yet → no ring');
  assert.equal(await decide(push, { directory: async () => { throw new Error('idb'); } }), null);
  assert.equal(await decide(push, { directory: async () => ({ me: me.pk, friends: {}, offsetMs: 0, at: 0 }) }), null, 'not a friend (or blocked) → no ring');
  // 時鐘差：本機時鐘慢 6 分鐘，名單上的時鐘差（5 分鐘）補回來；但最多採信 ±5 分鐘（安全審查 H2：營運方謊報伺服器時間，錄下來的舊 token
  //   不能看起來是新的）—— 本機慢 20 分鐘、說差 20 分鐘，只補 5 分鐘 → token 是 15 分鐘後的 → 不響
  assert.deepEqual((await decide(push, { deviceNow: NOW - 6 * MIN, offsetMs: 5 * MIN }))?.name, 'Mom', 'judged on the bounded server clock');
  assert.equal(await decide(push, { deviceNow: NOW - 6 * MIN }), null, 'control: on the raw device clock the token is from the future');
  assert.equal(await decide({ ...push, ringToken: sign({ callId: id22('four-capped'), video: true }) }, { deviceNow: NOW - 20 * MIN, offsetMs: 20 * MIN }), null,
    'an operator-claimed offset beyond ±5 min is not believed');
  assert.equal(await decide({ ...push, ringToken: sign({ callId: id22('four-old'), now: NOW - 30 * MIN }) }, { offsetMs: -30 * MIN }), null,
    'a 30-minute-old genuine token stays stale when the operator sets the clock back 30 minutes');
  for (const d of [null, undefined, 'x', [], { type: 'incoming_call' }]) assert.equal(await decide(d), null);
  assert.deepEqual(R.cleanRingDirectory({ me: me.pk, friends: { [friend.pk]: '  Mom  ', [me.pk]: 'me', x: 3 }, offsetMs: 5 }),
    { me: me.pk, friends: { [friend.pk]: 'Mom' }, offsetMs: 5, at: 0 }, 'directory cleaned (no self, strings only, trimmed)');
  assert.equal(R.cleanRingDirectory({ me: '', friends: {}, offsetMs: 0 }), null);
  assert.equal(R.cleanRingDirectory({ me: me.pk, friends: {}, offsetMs: 365 * 24 * 60 * MIN })?.offsetMs, R.RING_CLOCK_CAP_MS, 'stored offset capped at +5 min');
  assert.equal(R.cleanRingDirectory({ me: me.pk, friends: {}, offsetMs: -20 * MIN })?.offsetMs, -R.RING_CLOCK_CAP_MS, '…and at -5 min');
  // 響過的記錄照「本機」時鐘留到 iat ＋ 20 分鐘（新鮮度 ＋ 兩倍的時鐘差上限）：營運方撥時鐘差（最多 5 分鐘）清不掉還有效的記錄
  assert.equal(R.RING_SEEN_RETENTION_MS, 20 * MIN);
  let device = NOW;
  const seen = R.createMemoryRingReplay(256, () => device);
  const t0 = sign({ callId: id22('retained') });
  assert.equal(await reason(t0, { replay: seen }), 'ok');
  device = NOW + 9 * MIN;
  assert.equal(await reason(sign({ callId: id22('later') }), { replay: seen, now: NOW + 4 * MIN }), 'ok', 'another call triggers pruning');
  assert.equal(await reason(t0, { replay: seen, now: device - R.RING_CLOCK_CAP_MS }), 'replay', 'still remembered 9 min later, whatever offset the operator sets');
  device = NOW + 20 * MIN + 1;
  await reason(sign({ callId: id22('much-later'), now: device }), { replay: seen, now: device });
  assert.equal(seen.size, 1, 'pruned by the device clock only after iat + 20 min');
  assert.deepEqual(R.ringSeenToPrune([['b', 9], ['a', 5]], 0, 2), ['a'], 'full → the earliest expiry goes');
  assert.deepEqual(R.ringSeenToPrune([['b', 9], ['a', 1]], 2, 10), ['a'], 'expired (device clock) → goes');
  assert.deepEqual(R.ringSeenToPrune([['a', 5]], 0, 10), []);
  console.log('PASS decideRing: the name comes from my friend list, video from the token, the clock from my synced offset; push fields are ignored');
}

// ── 5 ──
{
  const at = (n, o = {}) => ({ callId: id22(`vector-${n}`), nonce: id22(`nonce-${n}`), ...o });
  const valid = sign(at(1));
  const cases = [];
  const add = (name, token, expect, o = {}) => cases.push({ name, token, sender: o.sender === undefined ? friend.pk : o.sender,
    me: o.me === undefined ? me.pk : o.me, expect, ...(o.video !== undefined ? { video: o.video } : {}) });
  add('valid voice call', valid, 'ok', { video: false });
  add('valid video call', sign(at(2, { video: true })), 'ok', { video: true });
  add('same token again (replay)', valid, 'replay');
  add('same call id re-signed (replay)', sign(at(1, { nonce: id22('nonce-1b') })), 'replay');
  add('forged signature (Mallory signs as the friend)', sign(at(3, { signer: mallory })), 'bad-signature');
  add('tampered claims (call id swapped)', withClaims(valid, claimsOf(valid).replace(id22('vector-1'), id22('vector-1x'))), 'bad-signature');
  add('wrong recipient', sign(at(4, { to: other })), 'wrong-recipient');
  add('push names another sender', sign(at(5)), 'sender-mismatch', { sender: mallory.pk });
  add('unknown caller (stranger signs his own)', sign(at(6, { from: mallory })), 'unknown-caller', { sender: mallory.pk });
  add('stale (5 min + 1 ms)', sign(at(7, { now: NOW - 5 * MIN - 1 })), 'stale');
  add('future (5 min + 1 ms)', sign(at(8, { now: NOW + 5 * MIN + 1 })), 'future');
  add('edge: exactly 5 min old', sign(at(9, { now: NOW - 5 * MIN })), 'ok', { video: false });
  add('edge: exactly 5 min ahead', sign(at(10, { now: NOW + 5 * MIN })), 'ok', { video: false });
  add('other domain', R.signRingToken({ prefix: 'other-ring-v1', ...at(11), from: friend.pk, to: me.pk, video: false, now: NOW, sign: friend.sign }), 'wrong-domain');
  add('signed for another domain', signRaw(claimsOf(sign(at(12))), friend, 'other-ring-v1'), 'bad-signature');
  add('extra space in claims', signRaw(claimsOf(sign(at(13))).replace('{"v":1,', '{"v":1, ')), 'malformed');
  add('extra field in claims', signRaw(claimsOf(sign(at(14))).replace('}', ',"name":"Mom"}')), 'malformed');
  add('iat above the safe integer range', signRaw(claimsOf(sign(at(15))).replace(/"iat":\d+/, '"iat":9007199254740993')), 'malformed');
  add('non-canonical base64url (spare bits)', spareBits(valid), 'malformed');
  add('other tag', valid.replace(/^r1\./, 'r2.'), 'malformed');
  add('no token', null, 'missing');
  add('not signed in', sign(at(16)), 'no-context', { me: null });
  const vectors = { comment: 'Generated by scripts/review/ring_token_self_test.mjs --write (do not edit). Cases run in order with one replay store.',
    prefix: P, now: NOW, friends: [friend.pk], me: me.pk, cases };
  const text = JSON.stringify(vectors, null, 2) + '\n';
  if (process.argv.includes('--write')) {
    if (!existsSync(dirname(VECTORS))) mkdirSync(dirname(VECTORS), { recursive: true });
    writeFileSync(VECTORS, text);
    console.log(`wrote ${VECTORS}`);
  }
  assert.ok(existsSync(VECTORS), `${VECTORS} exists (run with --write)`);
  const committed = JSON.parse(readFileSync(VECTORS, 'utf8'));
  assert.deepEqual(committed, vectors, 'the committed test vectors are what this implementation produces (deterministic)');
  const replay = R.createMemoryRingReplay();
  for (const c of committed.cases) {
    const v = await R.verifyRingToken({ token: c.token, prefix: committed.prefix, me: c.me, sender: c.sender,
      friendKey: (pk) => (committed.friends.includes(pk) ? pk : null), verify, now: committed.now, replay });
    assert.equal(v.ok ? 'ok' : v.reason, c.expect, `vector: ${c.name}`);
    if (v.ok) assert.equal(v.video, c.video, `vector video: ${c.name}`);
  }
  assert.ok(!/"seed"|PRIVATE/i.test(text), 'the vectors hold public keys and signatures only');
  // 模擬的 API（scripts/sim/lib/mockApi.mjs，＝ 伺服器的 ring_token_ok）：寄件者自己簽、給這個收件人、±300 秒
  const { ringTokenOk } = await import(pathToFileURL(root + 'scripts/sim/lib/mockApi.mjs').href);
  const byName = Object.fromEntries(committed.cases.map((c) => [c.name, c]));
  assert.equal(ringTokenOk(byName['valid voice call'].token, friend.pk, me.pk, NOW), true, 'sim API: the genuine token passes');
  assert.equal(ringTokenOk(byName['valid voice call'].token, mallory.pk, me.pk, NOW), false, 'sim API: forwarded by someone else');
  assert.equal(ringTokenOk(byName['valid voice call'].token, friend.pk, other.pk, NOW), false, 'sim API: for another recipient');
  assert.equal(ringTokenOk(byName['valid voice call'].token, friend.pk, me.pk, NOW + 301_000), false, 'sim API: stale');
  for (const n of ['forged signature (Mallory signs as the friend)', 'extra space in claims', 'non-canonical base64url (spare bits)', 'signed for another domain']) {
    assert.equal(ringTokenOk(byName[n].token, friend.pk, me.pk, NOW), false, `sim API: ${n}`);
  }
  console.log(`PASS ${committed.cases.length} cross-implementation vectors (also run by the Android JVM test RingTokenTest); the sim API checks tokens like the server`);
}

// ── 6 ──
{
  const hint = (h) => R.serverPushHint(h, 'community');
  const t = sign({ callId: id22('six') });
  assert.deepEqual(hint({ type: 'incoming_call', isVideoCall: true, ringToken: t }), { type: 'incoming_call', isVideoCall: true, ringToken: t });
  assert.deepEqual(hint({ type: 'message', ringToken: t }), { type: 'message' }, 'only calls carry a ring token');
  assert.deepEqual(hint({ type: 'incoming_call', ringToken: 'Mom is calling' }), { type: 'incoming_call' }, 'free text never passes as a token');
  assert.deepEqual(hint({ type: 'incoming_call', ringToken: 42 }), { type: 'incoming_call' });
  const src = (p) => readFileSync(p, 'utf8');
  const voice = src(SRC + '/services/voiceCall.ts');
  assert.match(voice, /const callId = newCallId\(\);\s*this\.guard\.begin\('caller', peerId, callId\);/);
  assert.match(voice, /mqttService\.triggerFcmNotify\(peerId, \{ type: 'incoming_call', isVideoCall: withVideo, callId \}\);/,
    'the caller\'s push names this call (the token is signed for its callId)');
  const mqtt = src(SRC + '/services/mqtt.ts');
  const trig = mqtt.slice(mqtt.indexOf('  triggerFcmNotify('), mqtt.indexOf('  signedClock(): SignedClock'));
  assert.match(trig, /signRingToken\(\{ prefix: AEGISTALK_RING_PREFIX, callId, from: signer\.publicKey, to: recipientPublicKeyBase64,\s*video: hint\.isVideoCall === true, now: this\.boundedNow\(\),/,
    'the token\'s iat is on the bounded clock (review H1: an operator-supplied server_time cannot make me sign a token dated next week)');
  assert.match(trig, /postSigned\(url, build\(true\), this\.signedClock\(\)\)/);
  assert.match(trig, /if \(detail === 'invalid_ring_token'\) await postSigned\(url, build\(false\), this\.signedClock\(\)\);/,
    'a token the server finds stale (my clock far off) → the push goes again without a token (the callee gets a plain notification)');
  const sw = src(SRC + '/sw-custom.ts');
  assert.match(sw, /event\.waitUntil\(decideRing\(data, Date\.now\(\)\)\.then\(\(ring\) => showPushNotification\(pushDisplayFor\(data, Date\.now\(\), ring\)\)\)\);/,
    'the service worker decides ring / name with decideRing');
  const fcm = src(ANDROID + '/src/main/kotlin/com/aegisrd/talk/AegisFCMService.kt');
  const call = fcm.slice(fcm.indexOf('private fun showIncomingCallNotification('), fcm.indexOf('private fun showUnverifiedCallNotification('));
  assert.match(call, /RingToken\.verify\(\s*token = data\["ringToken"\], prefix = RingToken\.PREFIX, me = ctx\.me, sender = data\["senderPubkey"\],/);
  assert.match(call, /is LocalSenders\.Sender\.Friend -> \{ friendName = c\.name; pk \}\s*else -> null/, 'native: only a (not blocked) local contact is a friend');
  assert.match(call, /nowMs = System\.currentTimeMillis\(\) \+ RingToken\.clampOffset\(ctx\.offsetMs\), seen = RingSeenStore\(this\)/, 'native: offset capped at ±5 min');
  assert.match(call, /LocalSenders\.lookup\(this, pk, blockListFailsClosed = true\)/, 'native: an unreadable block list counts as blocked for rings (review L2)');
  const stores = src(ANDROID + '/src/main/kotlin/com/aegisrd/talk/RingStores.kt');
  assert.match(stores, /RingToken\.seenToPrune\(all, clock\(\), MAX_SEEN\)/, 'native: seen calls pruned by the device clock');
  assert.match(stores, /\.putLong\(KEY_OFFSET, RingToken\.clampOffset\(offsetMs\)\)/, 'native: stored offset capped');
  assert.ok(call.indexOf('if (verdict !is RingToken.Verdict.Ok)') < call.indexOf('setFullScreenIntent'), 'native: no full-screen intent before the token verified');
  assert.match(call, /if \(verdict !is RingToken\.Verdict\.Ok\) \{[\s\S]*?showUnverifiedCallNotification\(\)\s*return\s*\}/);
  assert.match(call, /val isVideo = verdict\.video/, 'native: video flag from the signed token');
  assert.ok(!/data\["callerName"\]|data\["senderName"\]/.test(fcm), 'native: no name from the push');
  const unverified = fcm.slice(fcm.indexOf('private fun showUnverifiedCallNotification('), fcm.indexOf('private fun appLabel('));
  assert.ok(!/setFullScreenIntent|CALL_CHANNEL_ID|callerName|setOngoing\(true\)/.test(unverified), 'native: the unverified notification is not a call screen and names nobody');
  // 帳號離開這台：三條路都清掉驗響鈴用的資料（好友名單副本、我是誰、看過的來電）；聊天畫面掛著時同步
  const app = src(SRC + '/App.tsx');
  const exitChat = app.slice(app.indexOf('const exitChat = useCallback'), app.indexOf('window.location.reload();', app.indexOf('const exitChat = useCallback')));
  assert.match(exitChat, /const \{ clearRingData \} = await import\('\.\/services\/ringSync'\);\s*await clearRingData\(\);/, 'logout clears the ring data');
  const settings = src(SRC + '/pages/SettingsPage.tsx');
  const transfer = settings.slice(settings.indexOf("if (mode === 'transfer') {"), settings.indexOf('window.location.reload();', settings.indexOf("if (mode === 'transfer') {")));
  assert.match(transfer, /await import\('\.\.\/services\/ringSync'\)\.then\(\(m\) => m\.clearRingData\(\)\)/, 'device transfer (old phone) clears it');
  const claim = src(SRC + '/services/deviceClaim.ts');
  assert.match(claim.slice(claim.indexOf('export async function wipeLocalKeys')), /const \{ clearRingData \} = await import\('\.\/ringSync'\);\s*await clearRingData\(\);/, 'kicked device clears it');
  assert.match(src(SRC + '/pages/ChatApp.tsx'), /useRingDirectory\(publicKey, chatFriends\);/, 'the chat screen keeps it in sync');
  const sync = src(SRC + '/services/ringSync.ts');
  assert.match(sync, /if \(await isBlacklisted\(f\.publicKey\)\.catch\(\(\) => true\)\) continue;/, 'blocked friends (or an unreadable block list) are left out of the directory');
  console.log('PASS wiring: the caller signs a token for this call id in every (re)signed push; only calls carry it; the service worker and AegisFCMService ring only on a verified token; logout / kick / transfer clear the ring data');
}

// ── 7：同步給 JS 那一條路（ringSync.ts，stub 掉 mqtt／封鎖名單／IndexedDB）──
{
  const out = join(dir, 'sync.mjs');
  globalThis.__ring = { saves: [], clears: 0, slow: null, blocked: new Set() };
  const stub = { name: 'stub', setup(b) {
    b.onResolve({ filter: /^\.\/mqtt$|^\.\/localBlacklist$|^\.\/capacitor$|^\.\/ringDirectory$|plugins\/ringContext$/ }, (a) => ({ path: a.path, namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
      a.path === './mqtt' ? 'export const mqttService = { serverNow: () => Date.now() + 365 * 86400000, boundedNow: () => Date.now() + 180000 };'
      : a.path === './localBlacklist' ? 'export async function isBlacklisted(pk) { if (globalThis.__ring.slow) await globalThis.__ring.slow; if (pk === "broken") throw new Error("db"); return globalThis.__ring.blocked.has(pk); }'
      : a.path === './capacitor' ? 'export const isNativeApp = () => false;'
      : a.path === './ringDirectory' ? 'export async function saveRingDirectory(d) { globalThis.__ring.saves.push(d); } export async function clearRingDirectory() { globalThis.__ring.clears++; }'
      : 'export const RingContext = { async set() { throw new Error("web build: no native context"); }, async clear() {} };' }));
  } };
  await require('esbuild').build({ entryPoints: [SRC + '/services/ringSync.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out,
    logLevel: 'silent', plugins: [stub] });
  const { syncRing, clearRingData, reopenRingSync } = await import(pathToFileURL(out).href);
  const g = globalThis.__ring;
  g.blocked.add(mallory.pk);
  await syncRing(me.pk, [{ publicKey: friend.pk, name: ' Mom ' }, { publicKey: mallory.pk, name: 'Blocked' }, { publicKey: 'broken', name: 'X' }, { publicKey: me.pk, name: 'me' }]);
  assert.equal(g.saves.length, 1);
  assert.deepEqual(g.saves[0].friends, { [friend.pk]: 'Mom' }, 'blocked friends, an unreadable block-list entry and myself are left out');
  assert.ok(Math.abs(g.saves[0].offsetMs - 180_000) < 2_000, `the offset comes from the bounded clock (review H2), not serverNow (${g.saves[0].offsetMs})`);
  await syncRing(me.pk, [{ publicKey: friend.pk, name: ' Mom ' }]);
  assert.equal(g.saves.length, 1, 'nothing changed → not rewritten');
  // 登出時還在跑的同步（卡在查封鎖名單）不能在清掉之後把名單寫回去（審查 L1）
  let release;
  g.slow = new Promise((r) => { release = r; });
  const pending = syncRing(me.pk, [{ publicKey: friend.pk, name: 'Mom (renamed)' }]);
  await new Promise((r) => setTimeout(r, 20));   // 同步已經在跑（卡在查封鎖名單）
  const cleared = clearRingData();
  release();
  await Promise.all([pending, cleared]);
  g.slow = null;
  assert.equal(g.clears, 1, 'cleared');
  assert.equal(g.saves.length, 1, 'the sync that was running at logout wrote nothing after the clear');
  await syncRing(me.pk, [{ publicKey: friend.pk, name: 'Mom again' }]);
  assert.equal(g.saves.length, 1, 'no sync after the clear (until the chat screen reopens it for a login)');
  reopenRingSync();
  await syncRing(me.pk, [{ publicKey: friend.pk, name: 'Mom again' }]);
  assert.equal(g.saves.length, 2, 'a new login (reopenRingSync from useRingDirectory) syncs again (follow-up review L4)');
  assert.match(readFileSync(SRC + '/hooks/useRingDirectory.ts', 'utf8'), /if \(syncedFor\.current !== publicKey\) \{\s*syncedFor\.current = publicKey;\s*reopenRingSync\(\);/,
    'the chat screen reopens it only when the account changes (not while it stays mounted after logout)');
  console.log('PASS ringSync: blocked / unreadable / self left out, bounded offset, no rewrite when unchanged; nothing is written back after logout');
}

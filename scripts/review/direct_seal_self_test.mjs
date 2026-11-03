/**
 * DIRECT_SEALED 的信封（開源第 4 步，services/directSeal.ts；docs/DIRECT_SEALED.md）：真的 directSeal.ts＋identitySeal.ts，
 * Node crypto 的 Ed25519／X25519。
 *   1. 封給 Bob 的只有 Bob 拆得開；broker 上看不到種類、SDP、名字；from／to／iat／nonce 由封裝蓋上（body 寫的不算）
 *   2. 寄件人：用「我這台存的身分金鑰」驗簽章 —— 營運方／Mallory 用自己的金鑰簽、寫成 from＝Alice → 拆不開；存的金鑰跟 from 不同 → 拒
 *   3. 網域：DIRECT 的信封跟群組金鑰信封、好友 via、別的 App（不同前綴）互相拆不開
 *   4. 新鮮度照種類，一律看校正到伺服器的時鐘（審查 M1：以前通話／DataChannel 看有上限的時鐘，手機時鐘差 7 分鐘以上就全斷）：
 *      通話／DataChannel 2 分鐘、個人資料 7 天、預備金鑰請求與刪除 24 小時；未來 5 分鐘以上都拒
 *   5. 大小照種類；不認得的種類拒（封也封不出來）
 *   6. 重放：同一個 (寄件人, nonce) 只收一次；個人資料／預備金鑰請求／來電（call 的 request）要 iat 比上一則新（存起來，重開也記得）；
 *      記下的「上一則」最多到有上限的時鐘之後 5 分鐘、比它晚一天以上的拒（審查 L1：營運方撥快兩邊時鐘塞一則，之後真的照樣收）；表有上限
 *   7. 網域前綴是參數（群星移植）：格式不對的前綴丟例外
 *   8. 密文補到固定的幾級（審查 L6）：ICE／指紋／來電控制 1 KB、任何 SDP 16 KB —— broker 從大小分不出語音、視訊或 DataChannel；
 *      拆開後沒有補的欄位
 * Run: node scripts/review/direct_seal_self_test.mjs
 */
import assert from 'node:assert/strict';
import { identity, verify, x25519, loadDirectSeal, x25519PrivOf } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const D = await loadDirectSeal(root);
const A = identity(), B = identity(), C = identity(), M = identity();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T = 1_900_000_000_000;
const seal = (from, to, body, now = T, scheme = D.AEGISTALK_DIRECT) =>
  D.sealDirect({ from: from.pk, to: to.pk, body, sign: from.sign, now, scheme }, x25519);
const open = async (env, { from = A.pk, to = B, storedKey = from, server = T, scheme = D.AEGISTALK_DIRECT } = {}) =>
  D.openDirect({ envelope: env, from, to: to.pk, storedKey, myX25519Private: await x25519PrivOf(D, to), verify,
    now: server, scheme }, x25519);
const rejects = async (p, re, msg) => { await assert.rejects(p, re, msg); };

// 1
const offer = { kind: 'call', sig: 'offer', callId: 'C'.repeat(22), seq: 2, data: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\nc=IN IP4 10.0.0.7' } };
const env = await seal(A, B, offer);
assert.deepEqual(Object.keys(env).sort(), ['ct', 'ek', 'n', 'v'], 'the broker sees only { v, ek, n, ct }');
const wire = JSON.stringify(env);
// short words are searched as JSON strings ("call"): the base64 fields are random text and contain a bare 'sdp' in about
// one run of 400 ('call' 1 in 30,000), while a quote can only come from a plaintext field
for (const leak of ['"call"', '"offer"', '"sdp"', 'fingerprint', '10.0.0.7', A.pk, B.pk]) assert.ok(!wire.includes(leak), `nothing readable on the wire: ${leak}`);
const body = await open(env);
assert.equal(body.kind, 'call');
assert.equal(body.from, A.pk);
assert.equal(body.to, B.pk);
assert.equal(body.iat, T);
assert.ok(typeof body.nonce === 'string' && body.nonce.length >= 16, 'a random nonce');
assert.deepEqual(body.data, offer.data);
await rejects(open(env, { to: C }), /./, 'only the recipient can open it');
const spoof = await seal(A, B, { kind: 'profile', displayName: 'x', from: M.pk, to: C.pk, iat: 1, nonce: 'n' });
const sb = await open(spoof);
assert.deepEqual([sb.from, sb.to, sb.iat], [A.pk, B.pk, T], 'from/to/iat set by the seal, not by the body');
console.log('PASS sealed to the recipient\'s identity key; the broker sees no kind, SDP, IP or name; from/to/iat/nonce bound by the seal');

// 2
const forged = await seal(M, B, offer);                              // Mallory 自己的金鑰簽
await rejects(open(forged, { from: A.pk }), /signature|mismatch|decrypt|operation/i, 'Mallory\'s envelope claiming from=Alice is rejected');
await rejects(open(env, { from: A.pk, storedKey: C.pk }), /stored identity/, 'the stored identity key must be the sender\'s');
await rejects(open(env, { from: M.pk, storedKey: M.pk }), /./, 'a genuine envelope relabelled as from=Mallory does not open (AAD and signature bind from)');
const tampered = { ...env, ct: Buffer.from(Buffer.from(env.ct, 'base64').map((b, i) => (i === 20 ? b ^ 1 : b))).toString('base64') };
await rejects(open(tampered), /./, 'a flipped ciphertext bit is rejected');
console.log('PASS the sender is proven by the stored identity key; Mallory / the operator cannot sign as Alice');

// 3
const asGroup = await D.sealToIdentity({ from: A.pk, to: B.pk, body: { kind: 'call', x: 1 }, sign: A.sign, now: T, scheme: D.GROUP_KEY_SEAL,
  kindLimits: { call: 65536 } }, x25519);
await rejects(open(asGroup), /./, 'a group-key envelope does not open as DIRECT_SEALED');
await rejects(D.openDirect({ envelope: env, from: A.pk, to: B.pk, storedKey: A.pk, myX25519Private: await x25519PrivOf(D, B), verify,
  now: T, scheme: D.FRIEND_VIA_SEAL }, x25519), /./, 'nor as a friend via');
const play = D.directScheme('aegisplay-sig-v1');
const envPlay = await seal(A, B, offer, T, play);
await rejects(open(envPlay), /./, 'another app\'s prefix does not open as AegisTalk');
assert.equal((await open(envPlay, { scheme: play })).kind, 'call', 'but opens with its own scheme');
for (const bad of ['', 'Ab', 'with space', 'x'.repeat(41), 'a:b']) assert.throws(() => D.directScheme(bad), /prefix/, `bad prefix ${JSON.stringify(bad)}`);
console.log('PASS domain separation: direct vs group-key vs friend-via vs another app\'s prefix');

// 4（寄件端用校正到伺服器的時鐘蓋 iat，收端也用它判 —— 兩邊的手機時鐘差多少都無所謂）
const at = async (kind, iat, nowS) => open(await seal(A, B, { kind }, iat), { server: nowS });
assert.equal((await at('call', T, T + 2 * MIN - 1)).kind, 'call', 'a call signal just under 2 min old is fresh');
await rejects(at('call', T, T + 2 * MIN + 1), /stale/, 'a call signal older than 2 minutes is rejected');
await rejects(at('dc', T, T + 2 * MIN + 1), /stale/, 'a data-channel signal too');
assert.equal((await at('profile', T, T + 7 * DAY - 1)).kind, 'profile', 'a profile: 7 days');
await rejects(at('profile', T, T + 7 * DAY + 1), /stale/);
assert.equal((await at('prekey', T, T + DAY - 1)).kind, 'prekey', 'a prekey request: 24 h');
await rejects(at('prekey', T, T + DAY + 1), /stale/);
await rejects(at('delete', T, T + DAY + 1), /stale/, 'a delete: 24 h');
await rejects(at('call', T + 6 * MIN, T), /stale|future/, 'more than 5 minutes in the future is rejected');
assert.equal((await at('call', T + 4 * MIN, T)).kind, 'call', 'a few minutes of clock skew is fine');
console.log('PASS freshness per kind on the server-corrected clock: signalling 2 min, profile 7 d, prekey/delete 24 h; no far future');

// 5
await rejects(seal(A, B, { kind: 'call', blob: 'x'.repeat(70_000) }), /too large/, 'a call signal over 64 KB cannot be sealed');
assert.equal((await open(await seal(A, B, { kind: 'profile', displayName: 'Ann', avatar: 'data:image/jpeg;base64,' + 'A'.repeat(300_000) }))).kind, 'profile',
  'a profile with a ~300 KB avatar fits');
await rejects(seal(A, B, { kind: 'prekey', pad: 'x'.repeat(9_000) }), /too large/, 'a prekey request over 8 KB cannot be sealed');
await rejects(seal(A, B, { kind: 'not-a-kind' }), /unknown kind/, 'unknown kinds cannot be sealed');
const unknown = await D.sealToIdentity({ from: A.pk, to: B.pk, body: { kind: 'invite' }, sign: A.sign, now: T, scheme: D.AEGISTALK_DIRECT,
  kindLimits: { invite: 65536 } }, x25519);
await rejects(open(unknown), /unknown kind/, 'an envelope of an unknown kind is rejected after opening');
console.log('PASS size limits per kind; unknown kinds rejected both ways');

// 6
const store = new Map();
const marks = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
const guard = new D.DirectReplayGuard(marks);
const now = (server = T, bounded = server) => ({ server, bounded });
const b1 = await open(await seal(A, B, { kind: 'call', sig: 'ice' }));
assert.equal(guard.check(b1, now()), 'ok');
assert.equal(guard.check(b1, now()), 'replay', 'the same envelope twice → replay');
const p1 = await open(await seal(A, B, { kind: 'profile', displayName: 'new' }, T + 10));
const p0 = await open(await seal(A, B, { kind: 'profile', displayName: 'old' }, T + 5));
assert.equal(guard.check(p1, now()), 'ok');
assert.equal(guard.check(p0, now()), 'out-of-order', 'an older profile (recorded earlier, replayed later) cannot roll the name back');
const restarted = new D.DirectReplayGuard(marks);                  // App 重開：nonce 表是新的，iat 記錄還在
assert.equal(restarted.check(p1, now()), 'out-of-order', 'after a restart the same profile is still refused (persisted mark)');
const q1 = await open(await seal(A, B, { kind: 'prekey' }, T + 20));
assert.equal(restarted.check(q1, now()), 'ok');
assert.equal(restarted.check(await open(await seal(A, B, { kind: 'prekey' }, T + 20)), now()), 'out-of-order', 'a prekey request with the same iat is refused');
const c1 = await open(await seal(C, B, { kind: 'profile', displayName: 'carol' }, T + 1), { from: C.pk });
assert.equal(restarted.check(c1, now()), 'ok', 'marks are per sender');
const d1 = await open(await seal(A, B, { kind: 'delete', messageId: 'm' }, T - 100));
assert.equal(restarted.check(d1, now()), 'ok', 'deletes are not ordered (idempotent), only de-duplicated');
// 來電：request 要遞增（重開之後重放一通舊的來電不能讓手機再響）；同一通的其他信令不看（綁 callId／seq）
const r2 = await open(await seal(A, B, { kind: 'call', sig: 'request', callId: 'X'.repeat(22), seq: 1 }, T + 30));
const r1 = await open(await seal(A, B, { kind: 'call', sig: 'request', callId: 'Y'.repeat(22), seq: 1 }, T + 25));
assert.equal(restarted.check(r2, now()), 'ok');
assert.equal(new D.DirectReplayGuard(marks).check(r1, now()), 'out-of-order', 'an older call request is refused, also after a restart');
const ice0 = await open(await seal(A, B, { kind: 'call', sig: 'ice', callId: 'X'.repeat(22), seq: 2 }, T + 1));
assert.equal(restarted.check(ice0, now()), 'ok', 'other call signals are not ordered by iat');
// 營運方把兩邊的時鐘撥到幾個小時後：那一則（真的、簽過名）收下，但記下的「上一則」只到有上限的時鐘 ＋5 分鐘 —— 時鐘回來之後真的照樣收
const pf = await open(await seal(A, B, { kind: 'profile', displayName: 'future' }, T + 10 * HOUR), { server: T + 10 * HOUR });
assert.equal(restarted.check(pf, now(T + 10 * HOUR, T)), 'ok');
assert.equal(store.get(`${A.pk}|profile`), T + 5 * MIN, 'the stored mark is capped at bounded + 5 min');
const pAfter = await open(await seal(A, B, { kind: 'profile', displayName: 'real' }, T + 6 * MIN), { server: T + 6 * MIN });
assert.equal(restarted.check(pAfter, now(T + 6 * MIN)), 'ok', 'a genuine profile once the clock is back is still accepted');
const pFar = await open(await seal(A, B, { kind: 'profile', displayName: 'far' }, T + 2 * DAY), { server: T + 2 * DAY });
assert.equal(restarted.check(pFar, now(T + 2 * DAY, T)), 'out-of-order', 'more than a day ahead of the bounded clock → refused');
const small = new D.DirectReplayGuard(null, 3);
for (let i = 0; i < 5; i++) assert.equal(small.check(await open(await seal(A, B, { kind: 'call', sig: 'ice', i })), now()), 'ok');
assert.ok(small.size <= 3, 'the seen table is bounded');
console.log('PASS replay: one use per (sender, nonce); profile/prekey/call-request strictly newer per sender (also after a restart, mark capped); bounded table');

// 8 大小補到固定的幾級
const ctLen = (e) => Buffer.from(e.ct, 'base64').length;
const sdpOf = (n) => 'v=0\r\n' + 'a=candidate:x\r\n'.repeat(Math.ceil(n / 15));
const sizes = {};
for (const [name, body] of [
  ['ice', { kind: 'call', sig: 'ice', callId: 'C'.repeat(22), seq: 9, data: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host', sdpMid: '0' } }],
  ['fp', { kind: 'call', sig: 'fp', callId: 'C'.repeat(22), seq: 10, data: { local: ['sha-256 ' + 'AB:'.repeat(31) + 'AB'], remote: ['sha-256 ' + 'CD:'.repeat(31) + 'CD'], got: true } }],
  ['request', { kind: 'call', sig: 'request', callId: 'C'.repeat(22), seq: 1, video: true }],
  ['audio-offer', { kind: 'call', sig: 'offer', callId: 'C'.repeat(22), seq: 2, data: { type: 'offer', sdp: sdpOf(3000) } }],
  ['video-offer', { kind: 'call', sig: 'offer', callId: 'C'.repeat(22), seq: 2, data: { type: 'offer', sdp: sdpOf(9000) } }],
  ['dc-offer', { kind: 'dc', sig: 'offer', pc: 'p'.repeat(22), data: { type: 'offer', sdp: sdpOf(1200) } }],
  ['dc-ice', { kind: 'dc', sig: 'ice', pc: 'p'.repeat(22), data: { candidate: 'candidate:2 1 udp 1 10.0.0.1 1 typ host' } }],
  ['profile', { kind: 'profile', displayName: 'Ann', avatar: '' }],
]) sizes[name] = ctLen(await seal(A, B, body));
assert.deepEqual(sizes, { ice: 1024, fp: 1024, request: 1024, 'audio-offer': 16384, 'video-offer': 16384, 'dc-offer': 16384, 'dc-ice': 1024, profile: 1024 },
  'ciphertexts come in fixed sizes: the broker cannot tell an ICE from a call request, or a voice call from a video call');
const opened = await open(await seal(A, B, { kind: 'call', sig: 'ice', _pad: 'x'.repeat(60_000) }));
assert.ok(!('_pad' in opened), 'the padding field is removed after opening');
assert.equal(ctLen(await seal(A, B, { kind: 'call', sig: 'ice', _pad: 'x'.repeat(60_000) })), 1024, 'a caller-supplied _pad is replaced, not trusted');
console.log('PASS ciphertexts are padded to fixed buckets (1 KB control/ICE, 16 KB any SDP); the padding is stripped on opening');

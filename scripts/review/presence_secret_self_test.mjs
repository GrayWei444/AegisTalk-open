/**
 * 只有好友看得到的 presence（W4，設計 §C）：真的 services/presenceSecret.ts；另外用 Node crypto 照規格獨立實作一份來核對與偽造。
 *   1. tag 推導：tag = b64url(HMAC-SHA256(S, "aegistalk-presence-v1|" + e)[:16])（22 字元）；不同 S、不同 e → 不同 tag
 *   2. 主題：mist/user/<URL-safe 公鑰>/presence/<tag>；舊的 mist/user/<公鑰>/presence、+／#、多一層、非標準寫法的公鑰 → 不是 presence 主題
 *   3. 封／拆：K = HKDF(S, "aegistalk-presence-key-v1|" + e)，AES-GCM、AAD = 主題；payload 只有 {n, c}（沒有寄件人、公鑰、明文的 on）
 *   4. AAD 綁定（營運方寫不出「在線」）：搬到別的主題、別人的 S、舊一代的 S、改密文、營運方自己編的明文或空的金鑰 → 全部拆不開
 *   5. 順序（acceptState）：舊的「在線」、比目前採用的舊的連線、同一條連線離線之後才到的上線 → 不收；離線不看多舊
 *   6. share／request 的信封內容：欄位一個不多一個不少；share 的世代只能往上（compareShare）
 *   7. 換秘密的時機（rotationReason）：沒有 → initial；拿過的人刪好友／被封鎖 → revoked；30 天 → timer
 * Run: node scripts/review/presence_secret_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { load, identity } from './groupStateKit.mjs';

const P = await load('presenceSecret');
const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── 照規格的獨立實作 ──
const specTag = (s, e) => crypto.createHmac('sha256', Buffer.from(s)).update(`aegistalk-presence-v1|${e}`).digest().subarray(0, 16).toString('base64url');
const specKey = (s, e) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(s), Buffer.alloc(0), Buffer.from(`aegistalk-presence-key-v1|${e}`), 32));
function specOpen(s, e, topic, env) {
  const raw = Buffer.from(env.c, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', specKey(s, e), Buffer.from(env.n, 'base64'));
  d.setAAD(Buffer.from(topic));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
  } catch (err) {
    return assert.fail(`the spec decryption (key = HKDF(S, e), AAD = the topic) does not open it: ${err.message}`);
  }
}
function craft(key, aad, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(plain))), c.final(), c.getAuthTag()]);
  return { n: iv.toString('base64'), c: ct.toString('base64') };
}
const rejects = async (p, re, why) => assert.rejects(p, re, why);

const alice = identity('presence-alice');
const bob = identity('presence-bob');
const S = new Uint8Array(crypto.randomBytes(32));
const sec = { s: S, e: 1_800_000_000 };

// ── 1. tag ──
const tag = await P.presenceTag(sec);
assert.equal(tag, specTag(S, sec.e), 'tag = b64url(HMAC-SHA256(S, "aegistalk-presence-v1|e")[:16])');
assert.match(tag, /^[A-Za-z0-9_-]{22}$/);
assert.notEqual(await P.presenceTag({ s: S, e: sec.e + 1 }), tag, 'another epoch → another tag');
assert.notEqual(await P.presenceTag({ s: new Uint8Array(crypto.randomBytes(32)), e: sec.e }), tag, 'another secret → another tag');
await rejects(P.presenceTag({ s: S.slice(0, 31), e: 1 }), /bad secret/, '31-byte secret refused');
await rejects(P.presenceTag({ s: S, e: 0 }), /bad secret/, 'epoch must be ≥ 1');
console.log('PASS tag derivation matches the spec (HMAC-SHA256(S, "aegistalk-presence-v1|e")[:16], 22 chars) and changes with S and e');

// ── 2. 主題 ──
const topic = P.presenceTopic(alice.pk, tag);
assert.equal(topic, `mist/user/${url(alice.pk)}/presence/${tag}`);
assert.deepEqual(P.parsePresenceTopic(topic), { owner: alice.pk, tag });
for (const bad of [
  `mist/user/${url(alice.pk)}/presence`,               // 舊的：只要知道公鑰就能訂
  `mist/user/${url(alice.pk)}/presence/+`, `mist/user/+/presence/${tag}`, `mist/user/${url(alice.pk)}/presence/#`,
  `mist/user/${url(alice.pk)}/presence/${tag}/x`, `mist/user/${url(alice.pk)}/presence/${tag.slice(1)}`, `mist/user/${url(alice.pk)}/presence/${tag}A`,
  `mist/user/${alice.pk}/presence/${tag}`,               // 標準 base64（含 + / =）
  `mist/user/${url(alice.pk)}/inbox/${tag}`, `mist/group/${tag}/presence`,
]) {
  assert.equal(P.parsePresenceTopic(bad), null, `not a presence topic: ${bad}`);
  assert.equal(P.isPresenceTopic(bad), false);
}
// 同一把金鑰的另一種寫法（最後一個資料字元沒用到的位元改成 1）不是標準寫法
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const seg = url(alice.pk);
const variant = seg.slice(0, 42) + alphabet[alphabet.indexOf(seg[42]) ^ 1];
assert.equal(P.parsePresenceTopic(`mist/user/${variant}/presence/${tag}`), null, 'non-canonical owner segment refused');
assert.throws(() => P.presenceTopic(alice.pk, 'short'), /bad presence topic/);
assert.throws(() => P.presenceTopic(url(alice.pk), tag), /bad presence topic/, 'owner must be the standard base64 key');
console.log('PASS presence topics: exact mist/user/<owner>/presence/<22-char tag>; key-only, wildcard, extra-level and non-canonical forms refused');

// ── 3. 封／拆 ──
const now = Date.now();
const on = { on: 1, ts: now, cs: now - 1000 };
const env = await P.sealPresence({ secret: sec, topic, state: on });
assert.deepEqual(Object.keys(env).sort(), ['c', 'n'], 'payload is exactly {n, c}');
const wire = JSON.stringify(env);
for (const leak of [alice.pk, url(alice.pk), '"on"', 'online', '"from"'])   // "from" quoted: a bare 'from' turns up in random base64 assert.ok(!wire.includes(leak), `payload does not carry ${leak}`);
assert.deepEqual(specOpen(S, sec.e, topic, env), on, 'the spec implementation opens it (AAD = topic)');
assert.deepEqual(await P.openPresence({ secret: sec, topic, payload: wire }), on, 'opens from the JSON string');
const env2 = await P.sealPresence({ secret: sec, topic, state: on });
assert.notEqual(env2.n, env.n, 'fresh nonce each time');
await rejects(P.sealPresence({ secret: sec, topic: P.presenceTopic(alice.pk, specTag(S, sec.e + 1)), state: on }), /does not belong/, 'cannot seal on a topic of another epoch');
await rejects(P.sealPresence({ secret: sec, topic, state: { on: 1, ts: 5, cs: 6 } }), /bad presence state/, 'cs after ts refused');
console.log('PASS seal/open: AES-GCM under HKDF(S, e), AAD = topic, payload only {n, c} (no sender, no key, no plaintext state)');

// ── 4. AAD 綁定：營運方（沒有 S）寫不出解得開的「在線」 ──
const bobTopic = P.presenceTopic(bob.pk, tag);
await rejects(P.openPresence({ secret: sec, topic: bobTopic, payload: env }), /cannot decrypt/, 'moved to another owner topic (same tag) → AAD mismatch');
const otherSec = { s: new Uint8Array(crypto.randomBytes(32)), e: sec.e };
await rejects(P.openPresence({ secret: otherSec, topic, payload: env }), /does not belong/, 'another secret: the topic is not even theirs');
const oldSec = { s: S, e: sec.e - 1 };
await rejects(P.openPresence({ secret: oldSec, topic, payload: env }), /does not belong/, 'an older epoch of the same secret');
// 營運方：知道主題、不知道 S —— 用全零／亂數金鑰、或拿主題字串推的金鑰自己封一則「在線」
for (const key of [Buffer.alloc(32), crypto.randomBytes(32), crypto.createHash('sha256').update(topic).digest()]) {
  await rejects(P.openPresence({ secret: sec, topic, payload: craft(key, topic, { on: 1, ts: now, cs: now }) }), /cannot decrypt/, 'forged online (operator without S) refused');
}
// 有 S 的人（好友）在別的主題上封的、AAD 不對的
await rejects(P.openPresence({ secret: sec, topic, payload: craft(specKey(S, sec.e), bobTopic, on) }), /cannot decrypt/, 'right key, wrong AAD');
// 改密文、多欄位、型別不對、明文不是 {on, ts, cs}
const raw = Buffer.from(env.c, 'base64'); raw[0] ^= 1;
await rejects(P.openPresence({ secret: sec, topic, payload: { n: env.n, c: raw.toString('base64') } }), /cannot decrypt/, 'tampered ciphertext');
await rejects(P.openPresence({ secret: sec, topic, payload: { ...env, from: alice.pk } }), /malformed payload/, 'extra field');
await rejects(P.openPresence({ secret: sec, topic, payload: { n: env.n } }), /malformed payload/, 'missing c');
await rejects(P.openPresence({ secret: sec, topic, payload: 'not json' }), /not JSON/);
await rejects(P.openPresence({ secret: sec, topic, payload: craft(specKey(S, sec.e), topic, { on: 1, ts: now, cs: now, from: bob.pk }) }), /malformed plaintext/, 'extra plaintext field');
await rejects(P.openPresence({ secret: sec, topic, payload: craft(specKey(S, sec.e), topic, { on: true, ts: now, cs: now }) }), /bad presence state/, 'on must be 0/1');
await rejects(P.openPresence({ secret: sec, topic, payload: craft(specKey(S, sec.e), topic, { online: true }) }), /malformed plaintext/, 'the old {online} shape');
console.log('PASS AAD binding: forged online without S, moved/tampered envelopes, other or older secrets and the old shape are all refused');

// ── 5. 順序 ──
const A = (o, ts, cs) => ({ on: o, ts, cs });
assert.equal(P.acceptState(null, A(1, now, now), now), true, 'fresh online');
assert.equal(P.acceptState(null, A(1, now - P.ONLINE_FRESH_MS - 1, now - P.ONLINE_FRESH_MS - 1), now), false, 'stale online refused (replayed old online)');
assert.equal(P.acceptState(null, A(0, now - 40 * 60_000, now - 40 * 60_000), now), true, 'an old offline (will written at connect time) is accepted');
assert.equal(P.acceptState(null, A(1, now + P.FUTURE_SKEW_MS + 1000, now), now), false, 'future online refused');
assert.equal(P.acceptState(null, A(0, now + P.FUTURE_SKEW_MS + 1000, now + P.FUTURE_SKEW_MS + 1000), now), false, 'future offline refused');
const cur = A(1, now - 1000, now - 60_000);
assert.equal(P.acceptState(cur, A(0, now - 120_000, now - 120_000), now), false, 'the will of an older connection arriving late refused');
assert.equal(P.acceptState(cur, A(0, now - 60_000, now - 60_000), now), true, 'the will of the same connection accepted');
assert.equal(P.acceptState(A(0, now - 500, now - 60_000), A(1, now - 1000, now - 60_000), now), false, 'online of a connection after its own offline refused');
assert.equal(P.acceptState(A(0, now - 500, now - 60_000), A(1, now, now - 10), now), true, 'a newer connection comes back online');
assert.equal(P.acceptState(cur, A(1, now - 2000, now - 60_000), now), false, 'an older refresh of the same connection refused');
assert.equal(P.stillOnline(A(1, now - P.ONLINE_TTL_MS + 1000, 0), now), true);
assert.equal(P.stillOnline(A(1, now - P.ONLINE_TTL_MS, 0), now), false, 'online expires without a refresh (a dropped will cannot keep pushes suppressed)');
assert.ok(P.PRESENCE_REFRESH_MS < P.ONLINE_FRESH_MS && P.ONLINE_FRESH_MS < P.ONLINE_TTL_MS, 'refresh < freshness < TTL');
console.log('PASS ordering: stale or replayed online, late wills of older connections, online after offline refused; online expires after the TTL');

// ── 6. share／request ──
const sealFields = { v: 1, from: bob.pk, to: alice.pk, iat: now, nonce: 'n'.repeat(22) };
const share = P.shareBody(sec);
assert.deepEqual(share, { kind: 'presence', s: Buffer.from(S).toString('base64'), e: sec.e });
const parsed = P.parsePresenceBody({ ...share, ...sealFields });
assert.equal(parsed.t, 'share');
assert.deepEqual([Buffer.from(parsed.secret.s).toString('hex'), parsed.secret.e, parsed.iat], [Buffer.from(S).toString('hex'), sec.e, now], 'with the signed sealing time');
assert.deepEqual(P.parsePresenceBody({ ...P.requestBody(7), ...sealFields }), { t: 'request', have: 7 });
assert.deepEqual(P.requestBody(undefined), { kind: 'presence', have: 0 });
for (const bad of [
  { ...share, ...sealFields, extra: 1 }, { ...share, ...sealFields, have: 1 }, { kind: 'presence', s: share.s, ...sealFields },
  { ...share, ...sealFields, e: 0 }, { ...share, ...sealFields, e: 1.5 }, { ...share, ...sealFields, s: share.s.slice(0, -4) + 'AAA=' + 'A' },
  { ...share, ...sealFields, s: 'x'.repeat(44) }, { ...share, ...sealFields, kind: 'dist' }, { kind: 'presence', have: -1, ...sealFields },
  { ...share, v: 1, from: bob.pk, to: alice.pk, iat: now },
  { ...share, ...sealFields, iat: -1 }, { ...share, ...sealFields, iat: 'x' },
]) assert.equal(P.parsePresenceBody(bad), null, `refused: ${JSON.stringify(Object.keys(bad))}`);
assert.equal(P.compareShare(null, sec), 'new');
assert.equal(P.compareShare(sec, { s: S, e: sec.e }), 'same');
assert.equal(P.compareShare(sec, { s: S, e: sec.e - 1 }), 'stale', 'a replayed older share does not replace the current one');
assert.equal(P.compareShare(sec, { s: new Uint8Array(32), e: sec.e }), 'conflict');
assert.equal(P.compareShare({ ...sec, iat: 5 }, { s: new Uint8Array(32), e: sec.e, iat: 6 }), 'new', 'same epoch, another secret sealed later → the later one wins (two creations in one second)');
assert.equal(P.compareShare({ ...sec, iat: 5 }, { s: new Uint8Array(32), e: sec.e, iat: 4 }), 'conflict', 'an older envelope of the same epoch never wins');
assert.equal(P.compareShare(sec, { s: new Uint8Array(32), e: sec.e + 1 }), 'new');
assert.equal(P.nextEpoch(null, 1_800_000_000_500), 1_800_000_000);
assert.equal(P.nextEpoch(1_900_000_000, 1_800_000_000_500), 1_900_000_001, 'always grows');
assert.equal(P.nextEpoch(5, 1_800_000_000_500), 1_800_000_000, 'never below the current second (a restored device beats its old shares)');
console.log('PASS share/request bodies are exact; shares only move forward; new epochs grow and are ≥ the current second');

// ── 7. 換秘密的時機 ──
const peers = new Set([bob.pk, alice.pk]);
assert.equal(P.rotationReason(null, peers, now), 'initial');
assert.equal(P.rotationReason({ since: now, sharedWith: [bob.pk] }, peers, now), null);
assert.equal(P.rotationReason({ since: now, sharedWith: [bob.pk, 'gone'] }, peers, now), 'revoked', 'someone holding the secret is no longer a recipient');
assert.equal(P.rotationReason({ since: now - P.PRESENCE_ROTATE_MS, sharedWith: [bob.pk] }, peers, now), 'timer', '30 days');
assert.equal(P.PRESENCE_ROTATE_MS, 30 * 24 * 3_600_000);
console.log('PASS rotation: initial, revoked (unfriend/block), 30-day timer');

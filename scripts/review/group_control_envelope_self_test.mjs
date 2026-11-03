/**
 * 群組控制信封 group_sealed（設計 B2）：真的 services/groupControl.ts；另外用 Node crypto 照規格獨立實作一份來核對與偽造。
 *   1. 規格：tid = b64url(HKDF(K_e, "aegistalk-gtopic-v1|gid"))[:22]；K_ctl = HKDF(K_e, "aegistalk-gctl-v1|gid")；
 *      AES-GCM、AAD = tid|kid|寄件人；明文 {c, s}，s = Ed25519("aegistalk-gctl-v1:" + c)；五種內層都拆得開
 *   2. AAD 綁定：主題、金鑰 id、寄件人、群組任一個不對 → 拆不開
 *   3. 舊一代的金鑰拆不開新一代的訊息（主題也不同）
 *   4. 密文、nonce 被改、內層簽章不是寄件人的（含拿狀態鏈網域簽的）、內層不是這個群、不是正規 JSON → 拒收
 *      內層簽章裡有 kid（決定 2026-10-22 規則 4）：舊一代簽好的內層換新一代的金鑰重送 → 拒收
 *   5. nonce 每次都不同；信封只有 {n, c}（W3 審查 M3：沒有明文的 kid —— 主題決定是哪一代），沒有舊金鑰的副本
 *   6. W2 的 body（log 模型）：commit／here／sync 只帶 log 位置 {seq, id}，call 只有 {action, video}；
 *      W1 草案的形狀（commit 帶整批 commits、head 用 {v, id}、call 帶任意欄位）一律拒收
 * Run: node scripts/review/group_control_envelope_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { load, identity, verify, groupKey, b64 } from './groupStateKit.mjs';

const C = await load('groupControl');
const enc = (s) => new TextEncoder().encode(s);
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// ── 照規格的獨立實作 ──
const hkdf = (key, info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(key), Buffer.alloc(0), Buffer.from(info), 32));
const specTid = (key, gid) => hkdf(key, `aegistalk-gtopic-v1|${gid}`).toString('base64url').slice(0, 22);
const specCtl = (key, gid) => hkdf(key, `aegistalk-gctl-v1|${gid}`);
function specOpen(key, gid, tid, sender, env, kid = 'kid-1') {
  const raw = Buffer.from(env.c, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', specCtl(key, gid), Buffer.from(env.n, 'base64'));
  d.setAAD(Buffer.from(`${tid}|${kid}|${sender}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
}
function craft(key, gid, tid, kid, sender, plain, aadTid = tid) {
  const iv = crypto.randomBytes(12);
  const e = crypto.createCipheriv('aes-256-gcm', specCtl(key, gid), iv);
  e.setAAD(Buffer.from(`${aadTid}|${kid}|${sender}`));
  const ct = Buffer.concat([e.update(Buffer.from(JSON.stringify(plain))), e.final(), e.getAuthTag()]);
  return { n: iv.toString('base64'), c: ct.toString('base64') };
}
const signedPlain = (signer, inner, domain = C.GCTL_DOMAIN) => {
  const c = canon(inner);
  return { c, s: b64(signer.sign(enc(domain + c))) };
};

const ALICE = identity('ctl-alice'), BOB = identity('ctl-bob'), MALLORY = identity('ctl-mallory');
const GID = 'AbCdEfGhIjKlMnOpQrStUv', GID2 = 'ZyXwVuTsRqPoNmLkJiHgFe';
const K1 = groupKey('ctl-epoch-1'), K2 = groupKey('ctl-epoch-2');
const KID1 = 'kid-1', KID2 = 'kid-2';
const HEAD = { seq: 7, id: 'c'.repeat(64) };
const bodies = {
  commit: { head: HEAD },
  call: { action: 'start', video: false },
  here: { head: HEAD },
  sync: { have: HEAD },
  delete: { messageId: 'msg-123' },
};
const seal = (over = {}) => C.sealControl({ gid: GID, kid: KID1, key: K1, sender: ALICE.pk, sign: ALICE.sign, t: 'here', body: bodies.here, ...over });
const open = (env, over = {}) => C.openControl({ envelope: env, gid: GID, tid: specTid(K1, GID), sender: ALICE.pk, kid: KID1, key: K1, verify, ...over });
const rejects = (p, re, why) => assert.rejects(p, re, why);

// ── 1 ──
{
  const tid1 = await C.deriveTopicId(K1, GID);
  assert.equal(tid1, specTid(K1, GID), 'tid follows the spec');
  assert.equal(tid1.length, 22);
  assert.notEqual(tid1, await C.deriveTopicId(K2, GID), 'a new key epoch → a new topic');
  assert.notEqual(tid1, await C.deriveTopicId(K1, GID2), 'topics differ per group');
  for (const [t, body] of Object.entries(bodies)) {
    const { tid, envelope } = await seal({ t, body, ts: 1234 });
    assert.equal(tid, tid1);
    assert.deepEqual(Object.keys(envelope).sort(), ['c', 'n'], 'only {n, c} on the wire — no kid (W3 M3), no legacy copy');
    assert.ok(!JSON.stringify(envelope).includes(KID1), 'the kid is not on the wire');
    const plain = specOpen(K1, GID, tid, ALICE.pk, envelope);
    assert.ok(verify(ALICE.pub, enc('aegistalk-gctl-v1:' + plain.c), Buffer.from(plain.s, 'base64')), 'inner signature per spec');
    assert.equal(plain.c, canon(JSON.parse(plain.c)), 'inner is canonical JSON');
    assert.equal(JSON.parse(plain.c).kid, KID1, 'the signed inner names the key epoch');
    const opened = await open(envelope);
    assert.equal(opened.t, t);
    assert.equal(opened.sender, ALICE.pk);
    assert.equal(opened.gid, GID);
    assert.equal(opened.ts, 1234);
    assert.equal(opened.kid, KID1);
    assert.deepEqual(opened.body, body);
    assert.ok(!envelope.c.includes('msg-123') && !JSON.stringify(envelope).includes(GID), 'nothing readable outside');
  }
  assert.equal(C.peekKeyId, undefined, 'nothing to peek at: the receiver knows the epoch from the topic');
  console.log('PASS spec: tid and K_ctl via HKDF, AES-GCM with AAD tid|kid|sender, signed canonical inner; all five kinds round-trip');
}

// ── 2. AAD 綁定 ──
{
  const { envelope } = await seal();
  const tid1 = specTid(K1, GID);
  await rejects(open(envelope, { tid: specTid(K1, GID2) }), /topic/, 'arrived on another topic');
  await rejects(open(craft(K1, GID, tid1, KID1, ALICE.pk, signedPlain(ALICE, { t: 'here', gid: GID, kid: KID1, ts: 1, nonce: 'n'.repeat(22), body: bodies.here }), 'X'.repeat(22))),
    /cannot decrypt/, 'sealed for another tid (AAD) → cannot be opened on this topic');
  await rejects(open({ ...envelope, k: KID1 }), /malformed envelope/, 'a kid on the wire is refused (W3 M3)');
  await rejects(open(envelope, { kid: KID2 }), /cannot decrypt/, 'opened as another epoch (the kid is bound in the AAD)');
  await rejects(open(envelope, { sender: BOB.pk }), /cannot decrypt/, 'relabelled as another sender');
  await rejects(open(envelope, { gid: GID2, tid: specTid(K1, GID2) }), /cannot decrypt/, 'another group (K_ctl differs)');
  // 成員 Bob 有 K_ctl：把 Alice 簽的內層重新封成「Bob 寄的」→ 內層簽章對不上 Bob
  const plain = specOpen(K1, GID, tid1, ALICE.pk, envelope);
  await rejects(open(craft(K1, GID, tid1, KID1, BOB.pk, plain), { sender: BOB.pk }), /bad inner signature/, 'a member re-wrapping someone else\'s inner');
  console.log('PASS AAD binds tid, kid and sender; another group/topic/kid/sender cannot open it');
}

// ── 3. 舊金鑰 ──
{
  const { tid: tid2, envelope } = await seal({ kid: KID2, key: K2 });
  assert.notEqual(tid2, specTid(K1, GID), 'the removed member does not even know the new topic');
  await rejects(open(envelope, { tid: tid2, kid: KID2, key: K1 }), /topic/, 'old key on the new topic');
  await rejects(open(envelope, { tid: specTid(K1, GID), kid: KID2, key: K1 }), /cannot decrypt/, 'old key, pretending the old topic');
  assert.throws(() => specOpen(K1, GID, tid2, ALICE.pk, envelope), undefined, 'independent check: K1-derived K_ctl cannot decrypt');
  assert.ok(await open(envelope, { tid: tid2, kid: KID2, key: K2 }), 'the new key opens it');
  // 規則 4：拿 Alice 第一代簽好的內層（kid1），用第二代的金鑰重新加密、送到第二代的主題 → 內層的 kid 對不上
  const old = await seal({ t: 'call', body: { action: 'start', video: true } });
  const oldPlain = specOpen(K1, GID, specTid(K1, GID), ALICE.pk, old.envelope);
  const rewrapped = craft(K2, GID, tid2, KID2, ALICE.pk, oldPlain);
  await rejects(open(rewrapped, { tid: tid2, kid: KID2, key: K2 }), /inner key id mismatch/, 'an old-epoch inner re-sent under the new epoch');
  console.log('PASS an old epoch key cannot read new-epoch control messages; an old signed inner cannot be re-sent under a new epoch');
}

// ── 4. 竄改 ──
{
  const tid1 = specTid(K1, GID);
  const { envelope } = await seal();
  const flip = (s, i) => { const u = Buffer.from(s, 'base64'); u[i] ^= 1; return u.toString('base64'); };
  await rejects(open({ ...envelope, c: flip(envelope.c, 3) }), /cannot decrypt/, 'ciphertext bit flip');
  await rejects(open({ ...envelope, c: flip(envelope.c, Buffer.from(envelope.c, 'base64').length - 1) }), /cannot decrypt/, 'tag bit flip');
  await rejects(open({ ...envelope, n: flip(envelope.n, 0) }), /cannot decrypt/, 'nonce changed');
  await rejects(open({ ...envelope, c: Buffer.from(envelope.c, 'base64').subarray(0, 20).toString('base64') }), /cannot decrypt/, 'truncated');
  await rejects(open({ ...envelope, extra: 1 }), /malformed/, 'extra envelope field');
  const inner = { t: 'here', gid: GID, kid: KID1, ts: 5, nonce: 'A'.repeat(22), body: bodies.here };
  const good = signedPlain(ALICE, inner);
  assert.ok(await open(craft(K1, GID, tid1, KID1, ALICE.pk, good)), 'the independent implementation produces openable envelopes');
  const forged = [
    ['signed by another member', signedPlain(MALLORY, inner), /bad inner signature/],
    ['signature bit flipped', { c: good.c, s: flip(good.s, 5) }, /bad inner signature/],
    ['signed in the gstate domain', signedPlain(ALICE, inner, 'aegistalk-gstate-v1:'), /bad inner signature/],
    ['signed in the gks domain', signedPlain(ALICE, inner, 'aegistalk-gks-v1:'), /bad inner signature/],
    ['signed without a domain', signedPlain(ALICE, inner, ''), /bad inner signature/],
    ['inner for another group', signedPlain(ALICE, { ...inner, gid: GID2 }), /wrong group/],
    ['unknown kind', signedPlain(ALICE, { ...inner, t: 'admin' }), /unknown kind/],
    ['malformed body', signedPlain(ALICE, { ...inner, body: { head: { v: 0, id: 'x' } } }), /malformed/],
    ['extra inner field', signedPlain(ALICE, { ...inner, from: BOB.pk }), /malformed inner/],
  ];
  const nonCanonical = JSON.stringify({ body: inner.body, gid: GID, kid: KID1, nonce: inner.nonce, t: 'here', ts: 5 }).replace('"gid"', ' "gid"');
  forged.push(['non-canonical inner', { c: nonCanonical, s: b64(ALICE.sign(enc(C.GCTL_DOMAIN + nonCanonical))) }, /not canonical/]);
  for (const [why, plain, re] of forged) await rejects(open(craft(K1, GID, tid1, KID1, ALICE.pk, plain)), re, why);
  await rejects(open(craft(K1, GID, tid1, KID1, ALICE.pk, { c: good.c })), /malformed plaintext/, 'no signature');
  console.log(`PASS tampered ciphertext/nonce/tag and ${forged.length + 1} forged inner variants (wrong signer, other domains, other group, bad shape) rejected`);
}

// ── 5. nonce、大小 ──
{
  const ivs = new Set(), nonces = new Set();
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const { envelope } = await seal();
    assert.equal(Buffer.from(envelope.n, 'base64').length, 12);
    ivs.add(envelope.n);
    nonces.add((await open(envelope)).nonce);
  }
  assert.equal(ivs.size, N, 'AES-GCM nonces never repeat');
  assert.equal(nonces.size, N, 'inner nonces never repeat');
  const tooBig = { n: (await seal()).envelope.n, c: Buffer.alloc(C.MAX_CONTROL_PLAINTEXT + 64).toString('base64') };
  await rejects(open(tooBig), /envelope too large/, 'an envelope larger than any control plaintext is refused before decrypting');
  await rejects(seal({ t: 'call', body: { action: 'hijack', video: false } }), /malformed/, 'unknown call action');
  const identityPoint = Buffer.from('01'.padEnd(64, '0'), 'hex').toString('base64');
  await rejects(seal({ sender: identityPoint }), /bad seal parameters/, 'small-order sender key');
  await rejects(open((await seal()).envelope, { sender: identityPoint }), /bad open parameters/, 'small-order sender key on open');
  console.log(`PASS ${N} seals: unique 96-bit GCM nonces and inner nonces; size and body checks at seal time`);
}

// ── 6. W2 的 body ──
{
  const w1Shapes = [
    ['commit carrying a batch of commits (W1 draft)', 'commit', { commits: [{ c: { op: 'info' }, s: 'x' }] }],
    ['empty commit batch', 'commit', { commits: [] }],
    ['commit with extra fields', 'commit', { head: HEAD, commits: [] }],
    ['here with a {v, id} head (W1 draft)', 'here', { head: { v: 7, id: 'c'.repeat(64) } }],
    ['here with a negative seq', 'here', { head: { seq: -1, id: 'c'.repeat(64) } }],
    ['here with a fractional seq', 'here', { head: { seq: 1.5, id: 'c'.repeat(64) } }],
    ['here with a bad id', 'here', { head: { seq: 3, id: 'C'.repeat(64) } }],
    ['sync with a head instead of have', 'sync', { head: HEAD }],
    ['call without video', 'call', { action: 'start' }],
    ['call with a non-boolean video', 'call', { action: 'join', video: 'yes' }],
    ['call carrying a group name', 'call', { action: 'start', video: false, groupName: 'Family' }],
    ['call carrying a claimed initiator', 'call', { action: 'start', video: false, initiatorId: BOB.pk }],
    ['delete with an empty id', 'delete', { messageId: '' }],
    ['delete with extra fields', 'delete', { messageId: 'm', groupId: GID }],
  ];
  for (const [why, t, body] of w1Shapes) {
    await rejects(seal({ t, body }), /malformed/, `${why} refused at seal time`);
    assert.throws(() => C.checkControlBody(t, body), /malformed/, `${why} refused by checkControlBody`);
    const inner = { t, gid: GID, kid: KID1, ts: 5, nonce: 'B'.repeat(22), body };
    await rejects(open(craft(K1, GID, specTid(K1, GID), KID1, ALICE.pk, signedPlain(ALICE, inner))), /malformed/, `${why} refused on open`);
  }
  assert.deepEqual(C.checkControlBody('call', { video: true, action: 'end' }), { action: 'end', video: true });
  assert.deepEqual(C.checkControlBody('here', { head: { id: 'c'.repeat(64), seq: 0 } }), { head: { seq: 0, id: 'c'.repeat(64) } });
  assert.throws(() => C.checkControlBody('admin', {}), /unknown kind/);
  // 補長度（審查 W2 #9）：每一種的密文一樣長；補的字元只能是 '.'
  const lengths = new Set();
  for (const [t, body] of Object.entries(bodies)) lengths.add((await seal({ t, body })).envelope.c.length);
  lengths.add((await seal({ t: 'call', body: { action: 'end', video: false } })).envelope.c.length);
  lengths.add((await seal({ t: 'delete', body: { messageId: 'm'.repeat(128) } })).envelope.c.length);
  assert.equal(lengths.size, 1, `every kind has the same ciphertext length (${[...lengths]})`);
  assert.equal(Buffer.from((await seal()).envelope.c, 'base64').length, C.PAD_BUCKET + 16, 'padded to one bucket (+ GCM tag)');
  const inner = { t: 'here', gid: GID, kid: KID1, ts: 5, nonce: 'C'.repeat(22), body: bodies.here };
  const padded = { ...signedPlain(ALICE, inner), p: '....' };
  assert.ok(await open(craft(K1, GID, specTid(K1, GID), KID1, ALICE.pk, padded)), 'padding is accepted');
  await rejects(open(craft(K1, GID, specTid(K1, GID), KID1, ALICE.pk, { ...padded, p: 'hidden data' })), /malformed plaintext/, 'padding carries nothing else');
  console.log(`PASS W2 bodies: log positions {seq, id}, call {action, video}; ${w1Shapes.length} W1-draft or extra-field shapes refused on both sides`);
}


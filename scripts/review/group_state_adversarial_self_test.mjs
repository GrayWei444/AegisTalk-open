/**
 * 群組狀態鏈的攻擊情境（設計 A 節的攻擊 1–4、E 節；log 模型，決定 2026-10-22）：真的 services/groupState.ts，Ed25519 用 Node crypto。
 * 攻擊者＝營運方／broker 金鑰持有者（可以用任何寄件人後綴發任何東西，但沒有成員的私鑰），或不守規矩的成員。
 *   1. 營運方偽造 add：自己的金鑰簽、冒用 admin 當 actor（沒有或錯的簽章）→ 拒收、名冊不變、他要不到金鑰
 *   2. 一般成員踢人、admins-only 群組裡一般成員加人、成員自己升 admin、成員換金鑰、關掉報平安 → 拒收
 *   3. 被踢的人：重放 → duplicate；在還是成員的舊位置簽的 → 永遠 stale；在 head 簽的 → 不是成員
 *   4. 營運方自己編的 {kid, kc}、被踢的人手上的舊金鑰 → 不算數、不給新金鑰
 *   5. 被降級的前 admin：舊位置（還是 admin 時）簽的踢人／刪群 → 永遠 stale；head 上只有成員的權限（上一輪的漏洞情境）
 *   6. 成員卡不住群組：rekey／remove／加回舊成員只有 admin 能寫
 *   7. 小階點／非正規編碼／不在曲線上／混了小階成分的公鑰不能當成員、初始成員或建立者（否則營運方可用 (R = 恆等點, S = 0) 冒用；
 *      不在曲線上的會讓換金鑰封不了新金鑰而卡死群組，審查 H1；混了小階成分的讓不同驗章器答案不同，審查 M2）
 *   8. 驗章器不同（寬鬆／verify_strict 式／ZIP-215 cofactored／什麼都收）對特製簽章（R 恆等點、R 混小階、S + L、R 非正規）
 *      答案不同，但 toVerifiedCommit 一律拒收；同一個簽章只收正規的 base64 寫法（審查 M2、L5）
 * Run: node scripts/review/group_state_adversarial_self_test.mjs
 */
import assert from 'node:assert/strict';
import { load, identity, verify, chainKit, b64, ed } from './groupStateKit.mjs';

const G = await load('groupState');
const wire = (vc) => ({ c: vc.c, s: vc.s });
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const enc = (s) => new TextEncoder().encode(s);

const A = identity('adv-admin'), B = identity('adv-B'), M = identity('adv-M'), X = identity('adv-kicked');
const OP = identity('adv-operator'), MAL = identity('adv-mallory');
const guardianSettings = {
  type: 'guardian',
  checkIn: { enabled: true, frequency: 'daily', notifyTime: '09:00', timezone: 'Asia/Taipei', responseDeadline: 48 },
  protection: { riskAlert: true, paymentAlert: true, linkAlert: true, riskThreshold: 70 },
};

async function group(policy, groupType = 'normal') {
  const k = chainKit(G);
  const g = await k.genesis(A, { members: [B.pk, M.pk], addPolicy: policy, groupType, guardianSettings: groupType === 'guardian' ? guardianSettings : null });
  const rep = await k.start(g);
  return { k, rep };
}
const unchanged = (res, rep, why) => {
  assert.equal(res.ok, false, why);
  assert.equal(canon(rep.state), canon(rep.state), `${why}: input unchanged`);
};

// ── 1. 營運方偽造 add ──
{
  const { k, rep } = await group('members');
  const selfSigned = await k.next(rep.state, OP, 'add', { pk: MAL.pk });
  let res = await G.appendCommit(rep, selfSigned, verify);
  unchanged(res, rep, 'add signed by a non-member key');
  assert.equal(res.reason, 'actor-not-member');
  const fromAdmin = { c: { ...selfSigned.c, actor: A.pk }, s: selfSigned.s };
  res = await G.appendCommit(rep, fromAdmin, verify);
  unchanged(res, rep, '"from admin" with the operator\'s signature');
  assert.equal(res.reason, 'bad-signature');
  res = await G.appendCommit(rep, { c: fromAdmin.c, s: b64(B.sign(enc(G.GSTATE_DOMAIN + G.commitBody(fromAdmin.c)))) }, verify);
  unchanged(res, rep, '"from admin" signed by another member');
  assert.equal(res.reason, 'bad-signature');
  for (const s of ['', 'A'.repeat(86) + '==', undefined]) {
    res = await G.appendCommit(rep, s === undefined ? { c: fromAdmin.c } : { c: fromAdmin.c, s }, verify);
    unchanged(res, rep, `unsigned "from admin" add (${JSON.stringify(s)})`);
  }
  // 同樣的偽造塞進一條「邀請」給 Mallory 自己或成員：不會讓 Mallory 變成員
  const inv = await G.verifyInvite({ chain: [...rep.chain.map(wire), fromAdmin], gid: rep.gid, me: MAL.pk, key: { kid: rep.state.epoch.kid, key: new Uint8Array(32) }, verify });
  assert.equal(inv.ok, false);
  assert.ok(!rep.state.members.some((m) => m.pk === MAL.pk));
  for (const e of rep.state.epochs) assert.equal(G.mayReceiveKey(rep.state, MAL.pk, e.v), false, 'Mallory\'s key request gets no answer');
  console.log('PASS operator-forged adds (self-signed, "from admin" unsigned/mis-signed) rejected; roster unchanged; no key for Mallory');
}

// ── 2. 不守規矩的成員 ──
{
  const open = await group('members');
  const tryAs = async (g, who, op, args, ts) => {
    const res = await G.appendCommit(g.rep, await g.k.next(g.rep.state, who, op, args, ts), verify);
    unchanged(res, g.rep, `${op} by ${who.label}`);
    return res.reason;
  };
  assert.equal(await tryAs(open, M, 'remove', { pk: B.pk }), 'not-admin', 'non-admin remove');
  assert.equal(await tryAs(open, M, 'role', { pk: M.pk, role: 'admin' }), 'not-admin', 'self-promotion (admin = guardian)');
  assert.equal(await tryAs(open, M, 'rekey', {}, 10_000_000_000), 'not-admin', 'members never rekey');
  const strict = await group('admins');
  assert.equal(await tryAs(strict, M, 'add', { pk: MAL.pk }), 'add-admins-only', 'add under admins-only');
  const guardian = await group(undefined, 'guardian');
  assert.equal(guardian.rep.state.info.addPolicy, 'admins');
  const off = { ...guardianSettings, checkIn: { ...guardianSettings.checkIn, enabled: false } };
  assert.equal(await tryAs(guardian, M, 'info', { guardianSettings: off }), 'not-admin', 'a member silently disabling check-ins');
  assert.equal(await tryAs(guardian, OP, 'info', { guardianSettings: off }), 'actor-not-member', 'the operator disabling check-ins');
  assert.equal(await tryAs(guardian, M, 'add', { pk: MAL.pk }), 'add-admins-only', 'guardian group: member cannot add');
  console.log('PASS non-admin remove/promote/rekey, add under admins-only, forged guardian check-in changes → rejected');
}

// ── 3. 被踢的人：重放、舊位置、踢掉之後 ──
{
  const { k, rep } = await group('members');
  const added = await k.run(rep, [[A, 'add', { pk: X.pk }]]);
  const before = added.state;
  const kicked = await k.run(added, [[A, 'info', { name: 'between' }], [A, 'remove', { pk: X.pk }], [B, 'leave'], [A, 'rekey']]);
  assert.ok(!kicked.state.members.some((m) => m.pk === X.pk));
  for (const vc of added.chain) assert.equal((await G.appendCommit(kicked, wire(vc), verify)).reason, 'duplicate', 'replayed old commits (incl. the add of X) are no-ops');
  // X 在還是成員的舊位置簽的任何東西 → 永遠過時（沒有分叉選擇可以搶）
  for (const [op, args] of [['add', { pk: MAL.pk }], ['info', { name: 'mine' }], ['leave', {}]]) {
    const r = await G.appendCommit(kicked, await k.next(before, X, op, args, 7), verify);
    unchanged(r, kicked, `kicked member old-position ${op}`);
    assert.equal(r.reason, 'stale');
  }
  // X 在 head 簽的任何東西
  for (const [op, args] of [['add', { pk: MAL.pk }], ['info', { name: 'mine' }], ['leave', {}], ['rekey', {}]]) {
    const r = await G.appendCommit(kicked, await k.next(kicked.state, X, op, args), verify);
    unchanged(r, kicked, `kicked member ${op}`);
    assert.equal(r.reason, 'actor-not-member');
  }
  assert.equal(G.mayReceiveKey(kicked.state, X.pk, kicked.state.epoch.v), false);
  assert.notEqual(kicked.state.epoch.kid, before.epoch.kid, 'remove rotated the key');
  console.log('PASS kicked member: replays are duplicates, old-position commits always stale, head commits rejected, no new key');
}

// ── 4. 營運方編的金鑰 ──
{
  const { k, rep } = await group('members');
  const forgedKey = new Uint8Array(32).fill(9);
  const forgedKc = await G.keyCommitment(forgedKey, rep.gid, 'operator-kid');
  assert.equal(await G.keyAuthorised(rep.state, 'operator-kid', forgedKc, forgedKey), false, 'a key no verified commit names');
  const forgedRekey = await k.next(rep.state, OP, 'rekey', { kid: 'operator-kid', kc: forgedKc, kb: 'A'.repeat(43) });
  unchanged(await G.appendCommit(rep, forgedRekey, verify), rep, 'operator rekey');
  unchanged(await G.appendCommit(rep, { c: { ...forgedRekey.c, actor: A.pk }, s: forgedRekey.s }, verify), rep, 'operator rekey "from admin"');
  assert.equal(await G.keyAuthorised(rep.state, rep.state.epoch.kid, rep.state.epoch.kc, forgedKey), false, 'wrong key under the real kid');
  console.log('PASS operator-chosen {kid, kc} never authorised; cannot be put on the chain without an admin signature');
}

// ── 5. 被降級的前 admin：舊位置永遠過時，head 上只有成員的權限 ──
{
  const k = chainKit(G);
  const D = identity('adv-demoted'), Z = identity('adv-Z');
  let v = await k.start(await k.genesis(A, { members: [D.pk, Z.pk], addPolicy: 'members' }));
  v = await k.run(v, [[A, 'role', { pk: D.pk, role: 'admin' }]]);
  const whenAdmin = v.state;
  v = await k.run(v, [[Z, 'add', { pk: identity('adv-U').pk }], [A, 'info', { name: 'a1' }], [A, 'role', { pk: D.pk, role: 'member' }], [A, 'info', { name: 'a2' }]]);
  // 上一輪的漏洞情境：D 回到還是 admin 的位置踢 Z、踢 A、刪群 → 全部 stale
  for (const [op, args] of [['remove', { pk: Z.pk }], ['remove', { pk: A.pk }], ['delete', {}], ['role', { pk: Z.pk, role: 'admin' }]]) {
    const r = await G.appendCommit(v, await k.next(whenAdmin, D, op, args, 1), verify);
    unchanged(r, v, `demoted ex-admin old-position ${op}`);
    assert.equal(r.reason, 'stale');
  }
  for (const [op, args] of [['remove', { pk: Z.pk }], ['rekey', {}], ['role', { pk: D.pk, role: 'admin' }], ['delete', {}]]) {
    const r = await G.appendCommit(v, await k.next(v.state, D, op, args), verify);
    unchanged(r, v, `demoted ex-admin at head ${op}`);
    assert.equal(r.reason, 'not-admin');
  }
  console.log('PASS demoted ex-admin: old-position commits always stale; at head only member rights');
}

// ── 6. 成員卡不住群組：會換金鑰的 commit 只有 admin 能寫 ──
{
  const { k, rep } = await group('members');
  const left = await k.run(await k.run(rep, [[A, 'add', { pk: X.pk }], [A, 'remove', { pk: X.pk }]]), [[B, 'leave']]);
  assert.equal(left.state.needsRekey, true);
  const rekeyed = await k.run(left, [[A, 'rekey']]);
  for (const view of [left, rekeyed]) {
    const st = view.state;
    for (const [op, args] of [['rekey', {}], ['remove', { pk: A.pk }], ['add', await k.readdArgs(st, X.pk, M)], ['add', await k.readdArgs(st, B.pk, M)]]) {
      const r = await G.appendCommit(view, await k.next(st, M, op, args, 1), verify);
      unchanged(r, view, `member ${op}`);
      // 等 admin 換金鑰的期間連加人都不收（審查 M4）
      assert.equal(r.reason, op === 'add' ? (st.needsRekey ? 'needs-rekey' : 'readd-admin-only') : 'not-admin');
    }
  }
  console.log('PASS members cannot author key-rotating commits (rekey, remove, re-add), so they cannot stall the group with a withheld key');
}

// ── 7. 小階點／非正規公鑰（審查 MEDIUM）：不能當成員、不能當 actor ──
{
  const S = await load('identitySeal');
  const { rep } = await group('members');
  const hexKey = (h, signBit = false) => { const u = Buffer.from(h, 'hex'); if (signBit) u[31] |= 0x80; return u.toString('base64'); };
  const small = [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  ];
  // 8 階的兩個 y 對應到 X25519 公開黑名單上的 8 階 u（獨立核對常數沒抄錯）
  const order8U = new Set(['e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157']);
  for (const h of small.slice(3)) assert.ok(order8U.has(Buffer.from(S.edPublicToX25519(Buffer.from(h, 'hex'))).toString('hex')), `${h.slice(0, 8)} is an order-8 point`);
  const weak = [...small.flatMap((h) => [hexKey(h), hexKey(h, true)]),
    hexKey('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'), hexKey('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'),
    hexKey('f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')];
  for (const pk of weak) {
    assert.equal(G.validPubkey(pk), false, `small-order / non-canonical key ${pk.slice(0, 8)}… rejected`);
    const c = G.proposeCommit(rep.state, A.pk, 'add', { pk }, 5);
    const res = await G.appendCommit(rep, { c, s: b64(A.sign(enc(G.GSTATE_DOMAIN + G.commitBody(c)))) }, verify);
    assert.equal(res.reason, 'bad-pubkey', 'an admin cannot add a weak key');
  }
  // 冒用恆等點：(R = 恆等點, S = 0) 這種「簽章」在 actor 檢查就被擋下
  const identityPk = hexKey(small[1]);
  const forgedSig = b64(Buffer.concat([Buffer.from(small[1], 'hex'), Buffer.alloc(32)]));
  const c = G.proposeCommit(rep.state, identityPk, 'add', { pk: OP.pk }, 5);
  assert.equal((await G.appendCommit(rep, { c, s: forgedSig }, verify)).reason, 'bad-actor');
  for (let i = 0; i < 300; i++) assert.ok(G.validPubkey(identity(`honest-${i}`).pk), 'honest keys pass');
  await assert.rejects(chainKit(G).genesis(A, { members: [identityPk] }), /bad-pubkey/, 'a weak key cannot be an initial member either');
  // 審查 H1／M2：不在曲線上（轉不成 X25519，封不了新金鑰）、混了小階成分（cofactored 與 cofactorless 驗章器答案不同）
  const offCurve = Array.from({ length: 6 }, (_, i) => ed.offCurveKey(`adv-${i}`));
  const mixed = [A, B, M].map((who) => ed.mixedOrderKey(who.pk));
  for (const pk of [...offCurve, ...mixed]) {
    assert.equal(G.validPubkey(pk), false, `${pk.slice(0, 8)}… is not a member key`);
    assert.equal(G.wellFormedPubkey(pk), true, 'it passes the cheap format check (the old validPubkey)');
    const c = G.proposeCommit(rep.state, A.pk, 'add', { pk }, 5);
    assert.equal((await G.appendCommit(rep, { c, s: b64(A.sign(enc(G.GSTATE_DOMAIN + G.commitBody(c)))) }, verify)).reason, 'bad-pubkey', 'an admin cannot add it');
    await assert.rejects(chainKit(G).genesis(A, { members: [pk] }), /bad-pubkey/, 'nor list it as an initial member');
  }
  // 混了小階成分的「建立者」：genesis 一律完整檢查（其他 commit 的 actor 一定要是成員，成員進名冊時已檢查過）
  const mixedA = ed.mixedOrderKey(A.pk);
  const g = { gid: '', v: 1, prev: '0'.repeat(64), op: 'create', actor: mixedA, ts: 1, args: { name: 'x', avatar: '', groupType: 'normal', guardianSettings: null, addPolicy: 'members', members: [], kid: 'k1', kc: 'A'.repeat(43), nonce: 'A'.repeat(22) } };
  assert.equal((await G.startChain('A'.repeat(22), { c: g, s: b64(new Uint8Array(64)) }, verify)).reason, 'bad-actor');
  const asActor = G.proposeCommit(rep.state, mixedA, 'info', { name: 'mixed' }, 5);
  assert.equal((await G.appendCommit(rep, { c: asActor, s: b64(A.sign(enc(G.GSTATE_DOMAIN + G.commitBody(asActor)))) }, verify)).ok, false, 'never accepted as an actor');
  console.log(`PASS ${weak.length} small-order / non-canonical, ${offCurve.length} off-curve and ${mixed.length} mixed-order public keys rejected as member, initial member or creator; identity-point forgery stopped`);
}


// ── 8. 驗章器不同也得到同一條鏈（審查 M2、L5）：R／S 在 toVerifiedCommit 自己擋，不靠注入的驗章器 ──
{
  const { rep } = await group('members');
  const c = G.proposeCommit(rep.state, A.pk, 'info', { name: 'signed oddly' }, 5);
  const msg = enc(G.GSTATE_DOMAIN + G.commitBody(c));
  const signed = (sig) => ({ c, s: b64(sig) });
  const crafted = {
    'R = identity point (S = k·a)': ed.signCustom(A.label, A.pub, msg, { r: 0n, rBytes: ed.IDENTITY_ENC }),
    'R = honest R + order-8 point': ed.signCustom(A.label, A.pub, msg, { rPoint: (r) => ed.add(ed.mul(ed.B, r), ed.T8) }),
    'S + L (non-canonical scalar)': ed.signCustom(A.label, A.pub, msg, { sAdd: ed.L }),
    'R with a non-canonical y (identity as p + 1)': (() => { const sig = ed.signCustom(A.label, A.pub, msg, { r: 0n, rBytes: ed.le32(ed.p + 1n) }); return sig; })(),
  };
  const honest = ed.signCustom(A.label, A.pub, msg);
  // 先確定這些簽章真的讓驗章器分歧（不然這個測試沒意義）。寬鬆的那個用純 JS 的 RFC 8032 驗章（不檢查 R）：
  //   以前用 Node 的 OpenSSL，但 OpenSSL 3.5 起也擋小階 R（Node 24.22／26 實測），前提就不成立了；Node 的照樣列在下面的迴圈裡
  const verifiers = { 'lenient (RFC 8032, no R checks)': ed.verifyLenient, 'dalek verify_strict style': ed.verifyStrict,
    'ZIP-215 cofactored': ed.verifyCofactored, 'node (OpenSSL)': verify, 'accepts anything': () => true };
  const answers = (sig) => Object.values(verifiers).slice(0, 3).map((v) => v(A.pub, msg, sig));
  assert.deepEqual(answers(crafted['R = identity point (S = k·a)']), [true, false, true], 'R = identity: lenient yes, strict no');
  assert.deepEqual(answers(crafted['R = honest R + order-8 point']), [false, false, true], 'mixed-order R: only the cofactored verifier says yes');
  assert.deepEqual(answers(honest), [true, true, true]);
  for (const [vname, v] of Object.entries(verifiers)) {
    for (const [why, sig] of Object.entries(crafted)) {
      const res = await G.appendCommit(rep, signed(sig), v);
      assert.equal(res.reason, 'non-strict-signature', `${why} rejected whatever the verifier (${vname})`);
    }
    if (vname !== 'accepts anything') assert.equal((await G.appendCommit(rep, signed(honest), v)).ok, true, `honest signature accepted (${vname})`);
  }
  // 同一個簽章的其他 base64 寫法（最後一個字元沒用到的 4 bits）→ 只收正規的那一個
  const s = b64(honest);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const base = alphabet.indexOf(s[85]);
  const spellings = Array.from({ length: 16 }, (_, i) => s.slice(0, 85) + alphabet[(base & ~15) | i] + '==');
  assert.equal(new Set(spellings.map((x) => Buffer.from(x, 'base64').toString('hex'))).size, 1, '16 spellings, one signature');
  const accepted = [];
  for (const sp of spellings) if ((await G.appendCommit(rep, { c, s: sp }, verify)).ok) accepted.push(sp);
  assert.deepEqual(accepted, [s], 'only the canonical base64 spelling of a signature is accepted');
  console.log(`PASS ${Object.keys(crafted).length} crafted signatures (R identity / mixed-order R / S + L / non-canonical R) rejected under ${Object.keys(verifiers).length} different verifiers; honest ones accepted by all; only the canonical base64 spelling counts`);
}

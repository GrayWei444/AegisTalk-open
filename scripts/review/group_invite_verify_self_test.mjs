/**
 * 新成員驗邀請（設計 B4）與金鑰只認鏈上指定的（B5）：真的 services/groupState.ts，Ed25519 用 Node crypto。
 *   1. 誠實的邀請（genesis → … → add 我；附目前那一代金鑰）→ 收；createdBy 是建群的人、addedBy 是加我的人
 *   2. 拒收：偽造的 genesis、鏈斷掉／順序錯、沒簽或自己簽的「admin」commit、最後一筆不是加我、kc 對不上（錯的金鑰、舊的那一代）
 *   3. keyAuthorised：鏈上 create／remove／rekey 指定的 {kid, kc}、kc 由金鑰算得出來才算數；kc 照規格獨立計算核對
 *   4. mayReceiveKey：目前的成員、金鑰世代不早於他加入時正在用的那一代；被踢的、外人、不認得的世代都不給；
 *      被踢的人加回來（同一筆換金鑰，決定 2026-10-22 規則 5）只拿得到新的那一代起，邀請也要附新的金鑰
 * Run: node scripts/review/group_invite_verify_self_test.mjs
 */
import assert from 'node:assert/strict';
import { load, identity, verify, chainKit, kcSpec } from './groupStateKit.mjs';

const G = await load('groupState');
const wire = (vc) => ({ c: vc.c, s: vc.s });
const A = identity('inv-A'), B = identity('inv-B'), C = identity('inv-C'), ME = identity('inv-me');
const OP = identity('inv-operator'), Z = identity('inv-Z');

const k = chainKit(G);
const g = await k.genesis(A, { members: [B.pk, C.pk] });
const start = await k.start(g);
// A 換一次金鑰、改名，B（一般成員，規則 members）把我加進來
const before = await k.run(start, [[A, 'rekey'], [A, 'info', { name: 'Family' }]]);
const withMe = await k.run(before, [[B, 'add', { pk: ME.pk }]]);
const chain = withMe.chain.map(wire);
const current = { kid: withMe.state.epoch.kid, key: k.keys.get(withMe.state.epoch.kid) };
const invite = (over = {}) => G.verifyInvite({ chain, gid: g.gid, me: ME.pk, key: current, verify, ...over });

// ── 1 ──
{
  const res = await invite();
  assert.ok(res.ok, res.reason);
  assert.equal(res.addedBy, B.pk, 'the member who added me');
  assert.equal(res.view.state.createdBy, A.pk, 'creator from the genesis, not the inviter (design bug 5)');
  assert.equal(res.view.state.members.find((m) => m.pk === ME.pk).role, 'member', 'joined as a plain member');
  assert.equal(res.view.state.info.name, 'Family');
  // 只有 genesis、genesis 列了我
  const g2 = await k.genesis(A, { members: [ME.pk] });
  const res2 = await G.verifyInvite({ chain: [wire(g2.commit)], gid: g2.gid, me: ME.pk, key: { kid: g2.kid, key: g2.key }, verify });
  assert.ok(res2.ok, res2.reason);
  console.log('PASS honest invite accepted (via a member under the members policy, and as an initial genesis member)');
}

// ── 2 ──
{
  const expectReject = async (over, reason, why) => {
    const res = await invite(over);
    assert.equal(res.ok, false, why);
    assert.equal(res.reason, reason, why);
  };
  // 偽造 genesis：營運方自己簽一份「A 建的群」
  const fakeGenesis = { c: g.commit.c, s: Buffer.from(OP.sign(new TextEncoder().encode(G.GSTATE_DOMAIN + G.commitBody(g.commit.c)))).toString('base64') };
  await expectReject({ chain: [fakeGenesis, ...chain.slice(1)] }, 'bad-signature', 'genesis not signed by its actor');
  // 營運方自己建一個群（合法簽章）再拿原本的 gid 來用
  const opGenesis = await k.genesis(OP, { members: [ME.pk] });
  await expectReject({ chain: [wire(opGenesis.commit)] }, 'gid-mismatch', 'a genesis that does not hash to the gid');
  // 鏈斷掉、順序錯
  await expectReject({ chain: [chain[0], chain[2], chain[3]] }, 'not-next', 'missing commit');
  await expectReject({ chain: [chain[0], chain[2], chain[1], chain[3]] }, 'not-next', 'reordered commits');
  await expectReject({ chain: chain.slice(1) }, 'not-genesis', 'no genesis');
  await expectReject({ chain: [] }, 'bad-chain-length', 'empty chain');
  await expectReject({ chain: 'nope' }, 'bad-chain-length', 'not an array');
  // 沒簽、自己簽的「admin」commit
  const addMeByOp = await k.next(before.state, OP, 'add', { pk: ME.pk });
  await expectReject({ chain: [...before.chain.map(wire), addMeByOp] }, 'actor-not-member', 'self-signed add by a non-member');
  const claimsAdmin = { c: { ...addMeByOp.c, actor: A.pk }, s: addMeByOp.s };
  await expectReject({ chain: [...before.chain.map(wire), claimsAdmin] }, 'bad-signature', '"from admin" without the admin\'s signature');
  await expectReject({ chain: [...before.chain.map(wire), { c: claimsAdmin.c, s: '' }] }, 'bad-signature-format', 'unsigned');
  await expectReject({ chain: [...before.chain.map(wire), { c: claimsAdmin.c }] }, 'signed-commit-missing-s', 'no signature field');
  // 營運方先自封 admin 再加我
  const promoteOp = await k.next(before.state, OP, 'role', { pk: OP.pk, role: 'admin' });
  await expectReject({ chain: [...before.chain.map(wire), promoteOp] }, 'actor-not-member', 'self-promotion by a non-member');
  // admins-only 群組裡一般成員加我
  const strict = await k.genesis(A, { members: [B.pk], addPolicy: 'admins' });
  const strictRep = await k.start(strict);
  const memberAdds = await k.next(strictRep.state, B, 'add', { pk: ME.pk });
  const strictRes = await G.verifyInvite({ chain: [wire(strict.commit), memberAdds], gid: strict.gid, me: ME.pk, key: { kid: strict.kid, key: strict.key }, verify });
  assert.equal(strictRes.reason, 'add-admins-only', 'an add the chain does not allow');
  // 最後一筆不是加我
  const afterMe = await k.run(withMe, [[A, 'info', { name: 'Later' }]]);
  await expectReject({ chain: afterMe.chain.map(wire) }, 'last-commit-does-not-add-me', 'something after my add');
  const addsZ = await k.run(before, [[B, 'add', { pk: Z.pk }]]);
  await expectReject({ chain: addsZ.chain.map(wire) }, 'last-commit-does-not-add-me', 'adds someone else');
  await expectReject({ chain: before.chain.map(wire) }, 'last-commit-does-not-add-me', 'does not add me at all');
  // kc 對不上
  await expectReject({ key: { kid: current.kid, key: new Uint8Array(32).fill(7) } }, 'key-mismatch', 'wrong key bytes for the current kid');
  await expectReject({ key: { kid: g.kid, key: g.key } }, 'key-mismatch', 'the genesis key (superseded by a rekey)');
  await expectReject({ key: { kid: 'unknown', key: current.key } }, 'key-mismatch', 'unknown kid');
  // 刪掉的群
  const deleted = await k.run(withMe, [[A, 'delete']]);
  const delRes = await G.verifyInvite({ chain: deleted.chain.map(wire), gid: g.gid, me: ME.pk, key: current, verify });
  assert.equal(delRes.ok, false);
  console.log('PASS forged genesis, broken/reordered chains, unsigned or self-signed "admin" commits, disallowed adds, invites not ending with my add, kc mismatch → all rejected');
}

// ── 3. keyAuthorised ──
{
  const st = withMe.state;
  assert.equal(st.epochs.length, 2);
  for (const e of st.epochs) {
    const key = k.keys.get(e.kid);
    assert.equal(e.kc, kcSpec(key, e.v === 1 ? '' : g.gid, e.kid), `kc = HMAC(K, "aegistalk-gkc-v1|gid|kid") (genesis epoch: empty gid), v${e.v}`);
    assert.equal(await G.keyAuthorised(st, e.kid, e.kc, key), true, 'a key named by a verified commit');
    assert.equal(await G.keyAuthorised(st, e.kid, e.kc, new Uint8Array(32).fill(1)), false, 'other key bytes under that kid');
    assert.equal(await G.keyAuthorised(st, e.kid, 'A'.repeat(43), key), false, 'a kc not on the chain');
  }
  assert.equal(await G.keyAuthorised(st, 'nope', st.epoch.kc, current.key), false, 'kid not on the chain');
  // 同一把金鑰、同一個 kid 用在另一個群：kc 綁 gid，不能拿來用
  const other = await k.genesis(A, {});
  const otherKc = await G.keyCommitment(current.key, other.gid, st.epoch.kid);
  assert.notEqual(otherKc, st.epoch.kc, 'the same key and kid in another group has another kc');
  assert.equal(await G.keyAuthorised(st, st.epoch.kid, otherKc, current.key), false);
  console.log('PASS keys are accepted only when a verified create/remove/rekey names {kid, kc} and the key reproduces kc (independent HMAC check)');
}

// ── 4. mayReceiveKey ──
{
  // v1 genesis（epoch 1）、v2 rekey（epoch 2）、v3 info、v4 add ME；再 v5 rekey（epoch 5）、v6 add Z、v7 remove C（epoch 7）
  const later = await k.run(withMe, [[A, 'rekey'], [A, 'add', { pk: Z.pk }], [A, 'remove', { pk: C.pk }]]);
  const st = later.state;
  assert.deepEqual(st.epochs.map((e) => e.v), [1, 2, 5, 7]);
  assert.equal(G.mayReceiveKey(st, ME.pk, 2), true, 'the epoch in force when I joined (no rekey on add)');
  assert.equal(G.mayReceiveKey(st, ME.pk, 1), false, 'an epoch that ended before I joined');
  assert.equal(G.mayReceiveKey(st, ME.pk, 5), true);
  assert.equal(G.mayReceiveKey(st, ME.pk, 7), true);
  assert.equal(G.mayReceiveKey(st, Z.pk, 2), false, 'Z joined during epoch 5');
  assert.equal(G.mayReceiveKey(st, Z.pk, 5), true);
  assert.equal(G.mayReceiveKey(st, B.pk, 1), true, 'genesis members get every epoch');
  assert.equal(G.mayReceiveKey(st, C.pk, 5), false, 'removed member gets nothing');
  assert.equal(G.mayReceiveKey(st, OP.pk, 7), false, 'outsider gets nothing');
  assert.equal(G.mayReceiveKey(st, ME.pk, 6), false, 'not an epoch on the chain');
  // 規則 5：被踢的 C 加回來 → 同一筆換金鑰（v8）；他只拿得到 v8 之後的，不會拿到踢他之後那一代（v7）
  const fresh = await k.freshKey(later.state, A);
  const back = await k.run(later, [[A, 'add', { pk: C.pk, kid: fresh.kid, kc: fresh.kc, kb: fresh.kb }]]);
  assert.deepEqual(back.state.epochs.map((e) => e.v), [1, 2, 5, 7, 8]);
  assert.equal(G.mayReceiveKey(back.state, C.pk, 7), false, 'the epoch created to exclude C is not given to the re-added C');
  assert.equal(G.mayReceiveKey(back.state, C.pk, 5), false);
  assert.equal(G.mayReceiveKey(back.state, C.pk, 8), true);
  const reInvite = await G.verifyInvite({ chain: back.chain.map(wire), gid: g.gid, me: C.pk, key: { kid: fresh.kid, key: fresh.key }, verify });
  assert.ok(reInvite.ok, reInvite.reason);
  const staleKey = await G.verifyInvite({ chain: back.chain.map(wire), gid: g.gid, me: C.pk, key: { kid: st.epoch.kid, key: k.keys.get(st.epoch.kid) }, verify });
  assert.equal(staleKey.reason, 'key-mismatch', 'a re-add invite must carry the new key');
  console.log('PASS mayReceiveKey: current members only, epochs from the one in force at their join; ex-members, outsiders, unknown epochs refused');
}

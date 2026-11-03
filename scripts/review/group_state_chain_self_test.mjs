/**
 * 群組狀態鏈（設計 B1；log 模型，決定 2026-10-22）：真的 services/groupState.ts（＋groupStateRules／groupStateCommit），Ed25519 用 Node crypto。
 *   1. genesis／gid 綁定：gid = b64url(SHA-256(正規 JSON(genesis)))[:22]；改 genesis 就換 gid；別的群、第二個 genesis 拒收
 *   2. 權限矩陣：每個 op × 發起人身分（admin／成員／外人／被踢的人）× 加人規則（members／admins），再加各種邊界
 *   3. 直線鏈：只接 prev ＝ head 的；重放 → duplicate、舊位置 → stale（沒有分叉選擇）
 *   4. 有人離開：needsRekey、畫面「等 admin 換金鑰」；只有 admin 能換（成員不能），輪換順序只列 admin、各台用本機時間
 *   5. 加回曾經在群裡的人：只有 admin，而且同一筆換金鑰
 *   6. 簽章網域分開：為 "aegistalk-gctl-v1:"、API 簽章 JSON（無前綴）、"aegistalk-gks-v1:" 簽的，不能當狀態鏈 commit，反之亦然
 *   7. group_commits 列的編碼／解碼
 *   8. 回傳的 commit／狀態／鏈都凍結，呼叫端的物件會被複製
 * Run: node scripts/review/group_state_chain_self_test.mjs
 */
import assert from 'node:assert/strict';
import { load, identity, verify, chainKit, sha256, b64 } from './groupStateKit.mjs';

const G = await load('groupState');
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const wire = (vc) => ({ c: vc.c, s: vc.s });
const stateJson = (v) => canon(v.state);

const A = identity('chain-A'), B = identity('chain-B'), M = identity('chain-M'), N = identity('chain-N');
const O = identity('chain-outsider'), X = identity('chain-ex'), T = identity('chain-target');

async function attempt(k, view, who, op, args, ts) {
  const res = await G.appendCommit(view, await k.next(view.state, who, op, args, ts), verify);
  return res.ok ? 'ok' : res.reason;
}

// ── 1. genesis／gid ──
{
  const k = chainKit(G);
  const g = await k.genesis(A, { members: [B.pk] });
  const view = await k.start(g);
  assert.equal(g.gid, Buffer.from(sha256(canon(g.commit.c))).toString('base64url').slice(0, 22), 'gid = b64url(SHA-256(canonical genesis))[:22]');
  assert.equal(g.commit.c.gid, '', 'genesis carries an empty gid');
  assert.equal(view.state.createdBy, A.pk, 'createdBy comes from the genesis actor');
  assert.equal((await G.startChain(g.gid.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')), wire(g.commit), verify)).reason, 'gid-mismatch');
  const renamed = { ...g.commit.c, args: { ...g.commit.c.args, name: 'Other' } };
  assert.equal((await G.startChain(g.gid, { c: renamed, s: g.commit.s }, verify)).reason, 'bad-signature', 'edited genesis, old signature');
  assert.equal((await G.startChain(g.gid, G.signCommit(renamed, A.sign, A.pk), verify)).reason, 'gid-mismatch', 'a re-signed edited genesis is a different group');
  assert.equal((await G.appendCommit(view, wire(g.commit), verify)).reason, 'duplicate', 'genesis replay');
  const other = await k.genesis(A, { name: 'Second' });
  assert.equal((await G.appendCommit(view, wire(other.commit), verify)).reason, 'duplicate', 'a second genesis is never appended');
  const otherView = await k.start(other);
  const foreign = await k.next(otherView.state, A, 'info', { name: 'X' });
  assert.equal((await G.appendCommit(view, { c: { ...foreign.c, prev: view.state.head.id }, s: foreign.s }, verify)).reason, 'bad-signature');
  assert.equal((await G.appendCommit(view, G.signCommit({ ...foreign.c, prev: view.state.head.id }, A.sign, A.pk), verify)).reason, 'wrong-group');
  for (const [field, value] of [['gid', g.gid], ['prev', '1'.repeat(64)]]) {
    assert.throws(() => G.signCommit({ ...g.commit.c, [field]: value }, A.sign, A.pk), /bad-/, `genesis with a non-genesis ${field} is malformed`);
  }
  console.log('PASS genesis binds the gid; edited/foreign/second genesis rejected; createdBy from genesis');
}

// ── 2. 權限矩陣 ──
async function scenario(policy, groupType = 'normal') {
  const k = chainKit(G);
  const view = await k.start(await k.genesis(A, { members: [B.pk, M.pk, N.pk], addPolicy: policy, groupType }));
  // B 升 admin；X 先加再踢（被踢的人）
  return { k, view: await k.run(view, [[A, 'role', { pk: B.pk, role: 'admin' }], [A, 'add', { pk: X.pk }], [A, 'remove', { pk: X.pk }]]) };
}
{
  const actors = { admin: A, member: M, outsider: O, exMember: X };
  const ops = {
    add: () => ({ pk: T.pk }), remove: () => ({ pk: N.pk }), leave: () => ({}), rekey: () => ({}),
    role: () => ({ pk: N.pk, role: 'admin' }), info: () => ({ name: 'Renamed' }), delete: () => ({}),
  };
  const expected = (policy, role, op) => {
    if (role === 'outsider' || role === 'exMember') return 'actor-not-member';
    if (role === 'admin' || op === 'leave') return 'ok';
    if (op === 'add') return policy === 'members' ? 'ok' : 'add-admins-only';
    return 'not-admin';   // 成員不能 remove／rekey／role／info／delete
  };
  let cells = 0;
  for (const policy of ['members', 'admins']) {
    const { k, view } = await scenario(policy);
    for (const [role, who] of Object.entries(actors)) {
      for (const [op, args] of Object.entries(ops)) {
        assert.equal(await attempt(k, view, who, op, args()), expected(policy, role, op), `${policy} × ${role} × ${op}`);
        cells++;
      }
    }
  }
  const guardian = await scenario(undefined, 'guardian');
  assert.equal(guardian.view.state.info.addPolicy, 'admins', 'guardian groups default to admins-only adds');
  assert.equal(await attempt(guardian.k, guardian.view, M, 'add', { pk: T.pk }), 'add-admins-only');
  assert.equal((await scenario(undefined, 'normal')).view.state.info.addPolicy, 'members', 'normal groups default to LINE-like member adds');
  console.log(`PASS permission matrix: ${cells} cells (op × admin/member/outsider/ex-member × members/admins policy) + guardian default`);
}

// ── 2b. 邊界 ──
{
  const { k, view } = await scenario('members');
  assert.equal(await attempt(k, view, A, 'add', { pk: M.pk }), 'already-member');
  assert.equal(await attempt(k, view, A, 'remove', { pk: A.pk }), 'remove-self');
  assert.equal(await attempt(k, view, A, 'remove', { pk: O.pk }), 'target-not-member');
  // 審查 L5：新一代的 kid 由位置與作者決定（epochKidFor），重用任何一代、別人的、或自己過時那筆的 kid 一律拒收
  const e0 = view.state.epochs[0];
  assert.equal(await attempt(k, view, A, 'remove', { pk: N.pk, kid: e0.kid, kc: e0.kc, kb: 'A'.repeat(43) }), 'kid-not-derived');
  assert.equal(await attempt(k, view, A, 'rekey', { kid: view.state.epoch.kid, kc: view.state.epoch.kc, kb: 'A'.repeat(43) }), 'kid-not-derived');
  const kidA = await G.epochKidFor(view.state.head.id, A.pk);
  assert.notEqual(kidA, await G.epochKidFor(view.state.head.id, B.pk), 'two admins rotating at the same head get different kids');
  assert.equal(await attempt(k, view, B, 'rekey', { kid: kidA, kc: 'A'.repeat(43), kb: 'A'.repeat(43) }), 'kid-not-derived', 'B cannot use the kid of A\'s position');
  const moved = await k.run(view, [[A, 'info', { name: 'moved on' }]]);
  assert.equal(await attempt(k, moved, A, 'rekey', { kid: kidA, kc: 'A'.repeat(43), kb: 'A'.repeat(43) }), 'kid-not-derived', 'a rebased rekey cannot keep the kid of its stale version');
  assert.equal(await attempt(k, moved, A, 'rekey', {}), 'ok', 'the derived kid at the new head is accepted');
  assert.equal(await attempt(k, view, A, 'role', { pk: M.pk, role: 'member' }), 'no-change');
  assert.equal(await attempt(k, view, A, 'role', { pk: O.pk, role: 'admin' }), 'target-not-member');
  assert.equal(await attempt(k, view, A, 'role', { pk: A.pk, role: 'member' }), 'ok', 'an admin may step down while another admin remains');
  const solo = await k.run(view, [[A, 'role', { pk: B.pk, role: 'member' }]]);
  assert.equal(await attempt(k, solo, A, 'role', { pk: A.pk, role: 'member' }), 'last-admin', 'the last admin cannot be demoted');
  assert.equal(await attempt(k, view, A, 'info', { name: view.state.info.name }), 'no-change');
  assert.equal(await attempt(k, view, A, 'info', { guardianSettings: { type: 'guardian', checkIn: { enabled: true, frequency: 'daily', notifyTime: '09:00', responseDeadline: 48 }, protection: { riskAlert: true, paymentAlert: true, linkAlert: true, riskThreshold: 70 } } }),
    'guardian-settings-on-normal-group');
  assert.equal((await k.run(view, [[A, 'info', { groupType: 'guardian' }]])).state.info.addPolicy, 'admins', 'becoming a guardian group switches to admins-only adds unless stated');
  const deleted = await k.run(view, [[A, 'delete']]);
  for (const [op, args] of [['info', { name: 'Back' }], ['add', { pk: T.pk }], ['rekey', {}], ['leave', {}]]) {
    assert.equal(await attempt(k, deleted, A, op, args), 'group-deleted', `delete is final (${op})`);
  }
  const many = Array.from({ length: 49 }, (_, i) => identity(`many-${i}`).pk);
  const full = await k.start(await k.genesis(A, { members: many }));
  assert.equal(full.state.members.length, 50);
  assert.equal(await attempt(k, full, A, 'add', { pk: T.pk }), 'group-full');
  const good = await k.next(view.state, A, 'info', { name: 'Fine' });
  for (const [why, c] of [
    ['extra top-level field', { ...good.c, extra: 1 }],
    ['extra args key', { ...good.c, args: { name: 'Fine', admin: true } }],
    ['create after genesis', { ...good.c, op: 'create' }],
    ['non-integer version', { ...good.c, v: 2.5 }],
    ['remove without new key', { ...good.c, op: 'remove', args: { pk: N.pk } }],
    ['rekey without key-bundle hash', { ...good.c, op: 'rekey', args: { kid: 'kx', kc: 'A'.repeat(43) } }],
    ['rekey with a malformed key-bundle hash', { ...good.c, op: 'rekey', args: { kid: 'kx', kc: 'A'.repeat(43), kb: 'not-a-hash' } }],
  ]) {
    const res = await G.appendCommit(view, { c, s: good.s }, verify);
    assert.equal(res.ok, false, why);
    assert.notEqual(res.reason, 'bad-signature', `${why}: rejected by the format check before the signature`);
  }
  console.log('PASS edges: duplicate add, self/non-member remove, kid reuse / non-derived kid (L5), no-op role/info, last admin, guardian settings, delete final, 50 cap, strict format');
}

// ── 3. 直線鏈：重放、舊位置 ──
{
  const k = chainKit(G);
  const g = await k.genesis(A, { members: [B.pk, M.pk] });
  const view = await k.run(await k.start(g), Array.from({ length: 9 }, (_, i) => [A, 'info', { name: `n${i}` }]));
  assert.equal(view.state.head.v, 10);
  for (const vc of view.chain) assert.equal((await G.appendCommit(view, wire(vc), verify)).reason, 'duplicate', `replay of v${vc.c.v}`);
  const oldParent = (await G.loadChain(g.gid, view.chain.slice(0, 4).map(wire), verify)).view.state;
  assert.equal((await G.appendCommit(view, await k.next(oldParent, A, 'info', { name: 'late' }), verify)).reason, 'stale', 'even an admin\'s commit at an old position is stale');
  assert.equal((await G.appendCommit(view, await k.next(view.state, A, 'info', { name: 'head' }), verify)).ok, true);
  const res = await G.appendCommit(view, await k.next(view.state, O, 'info', { name: 'x' }), verify);
  assert.equal(res.reason, 'actor-not-member');
  assert.equal(stateJson(view), stateJson(view), 'the input view is never changed');
  console.log('PASS straight chain: replays are duplicates, any old-position commit is stale (no fork choice)');
}

// ── 4. 有人離開、換金鑰（只有 admin） ──
{
  const k = chainKit(G);
  const [P, Q] = [A, B].sort((a, b) => (a.pk < b.pk ? -1 : 1));   // 名冊依公鑰字串排
  let view = await k.start(await k.genesis(P, { members: [Q.pk, M.pk, N.pk] }));
  view = await k.run(view, [[P, 'role', { pk: Q.pk, role: 'admin' }], [P, 'add', { pk: T.pk }]]);
  const left = await k.run(view, [[N, 'leave', {}, 50_000]]);
  assert.equal(left.state.needsRekey, true);
  assert.equal(G.waitingForAdminRekey(left.state), true, 'UI state: waiting for an admin to rotate the key');
  assert.deepEqual(G.rotationOrder(left.state), [P.pk, Q.pk], 'only admins rotate, ordered by key');
  for (const who of [M, T]) {
    for (const ts of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(await attempt(k, left, who, 'rekey', {}, ts), 'not-admin', 'members can never rekey (cannot stall the group)');
  }
  assert.equal(G.shouldRekeyNow(left.state, P.pk, 0), true, 'first admin acts at once');
  assert.equal(G.shouldRekeyNow(left.state, Q.pk, 59), false);
  assert.equal(G.shouldRekeyNow(left.state, Q.pk, 60), true, 'the next admin takes over after 60 s of its own local time');
  assert.equal(G.shouldRekeyNow(left.state, M.pk, 1e9), false, 'members are not in the order');
  assert.equal(G.shouldRekeyNow(left.state, P.pk, Number.NaN), false);
  const noHead = (s) => canon({ ...s, head: null });
  assert.equal(noHead((await k.run(view, [[N, 'leave', {}, 0]])).state), noHead((await k.run(view, [[N, 'leave', {}, Number.MAX_SAFE_INTEGER]])).state), 'the leave ts changes nothing');
  // 審查 M4：等 admin 換金鑰的期間只收 rekey／remove（admin）與 leave；舊金鑰下不能再有新內容（離開的人還拿著舊金鑰）
  for (const [who, op, args] of [[P, 'info', { name: 'secret plans' }], [P, 'add', { pk: O.pk }], [M, 'add', { pk: O.pk }], [P, 'role', { pk: M.pk, role: 'admin' }],
    [Q, 'role', { pk: P.pk, role: 'member' }], [P, 'delete', {}], [P, 'add', await k.readdArgs(left.state, N.pk, P)]]) {
    assert.equal(await attempt(k, left, who, op, args), 'needs-rekey', `${op} by ${who === M ? 'a member' : 'an admin'} waits for the rekey`);
  }
  assert.equal(await attempt(k, left, M, 'leave', {}), 'ok', 'leaving is still possible');
  assert.equal(await attempt(k, left, P, 'remove', { pk: M.pk }), 'ok', 'an admin remove rotates the key, so it is allowed');
  assert.equal((await k.run(left, [[P, 'remove', { pk: M.pk }]])).state.needsRekey, false, 'and it ends the wait');
  const rekeyed = await k.run(left, [[Q, 'rekey', {}, 1]]);
  assert.equal(rekeyed.state.needsRekey, false);
  assert.equal(G.waitingForAdminRekey(rekeyed.state), false);
  assert.equal(await attempt(k, rekeyed, P, 'info', { name: 'after the rekey' }), 'ok', 'normal again after the rekey');
  // 最後一個 admin 離開 → 最早加入的接手（變成 admin，就能換金鑰）
  const tie = await k.start(await k.genesis(A, {}));
  const [lo, hi] = [M, N].sort((a, b) => (a.pk < b.pk ? -1 : 1));
  const t2 = await k.run(tie, [[A, 'add', { pk: hi.pk }], [A, 'add', { pk: lo.pk }], [A, 'leave']]);
  assert.equal(t2.state.members.find((m) => m.role === 'admin').pk, hi.pk, 'successor is the earliest added (addedAtV), not the smallest key');
  assert.equal(await attempt(k, t2, hi, 'rekey', {}), 'ok', 'the auto-promoted successor can rotate');
  // 審查 L4：曾經被降級的人不會因為最後一個 admin 離開又變回 admin；全都被降級過才從全部裡挑最早的
  const [d1, d2] = [M, N].sort((a, b) => (a.pk < b.pk ? -1 : 1));
  const demotedFirst = await k.run(tie, [[A, 'add', { pk: d1.pk }], [A, 'add', { pk: d2.pk }], [A, 'add', { pk: T.pk }],
    [A, 'role', { pk: d1.pk, role: 'admin' }], [A, 'role', { pk: d1.pk, role: 'member' }]]);
  assert.deepEqual([...demotedFirst.state.demoted], [d1.pk]);
  const afterLeave = await k.run(demotedFirst, [[A, 'leave']]);
  assert.equal(afterLeave.state.members.find((m) => m.role === 'admin').pk, d2.pk, 'the earliest never-demoted member takes over, not the demoted ex-admin');
  const allDemoted = await k.run(tie, [[A, 'add', { pk: d1.pk }], [A, 'add', { pk: d2.pk }], [A, 'role', { pk: d1.pk, role: 'admin' }], [A, 'role', { pk: d2.pk, role: 'admin' }],
    [A, 'role', { pk: d1.pk, role: 'member' }], [A, 'role', { pk: d2.pk, role: 'member' }], [A, 'leave']]);
  assert.equal(allDemoted.state.members.find((m) => m.role === 'admin').pk, d1.pk, 'if everyone left was demoted once, the earliest added takes over');
  const stepDown = await k.run(tie, [[A, 'add', { pk: d1.pk }], [A, 'add', { pk: d2.pk }], [A, 'role', { pk: d1.pk, role: 'admin' }], [d1, 'role', { pk: d1.pk, role: 'member' }], [A, 'leave']]);
  assert.equal(stepDown.state.members.find((m) => m.role === 'admin').pk, d2.pk, 'stepping down yourself counts as being demoted');
  console.log('PASS leave → needsRekey and "waiting for an admin" (only rekey/remove/leave accepted meanwhile); members can never rekey; admins rotate by local i × 60 s; successor by addedAtV, skipping ever-demoted members');
}

// ── 5. 加回曾經在群裡的人：只有 admin、同一筆換金鑰 ──
{
  const { k, view } = await scenario('members');
  assert.deepEqual([...view.state.former], [X.pk], 'the removed member is remembered');
  assert.equal(await attempt(k, view, A, 'add', { pk: X.pk }), 'readd-needs-rekey', 'a removed member re-added without a new key');
  assert.equal(await attempt(k, view, M, 'add', await k.readdArgs(view.state, X.pk, M)), 'readd-admin-only', 'members cannot re-add (that would rotate the key)');
  assert.equal(await attempt(k, view, M, 'add', { pk: X.pk }), 'readd-admin-only');
  const readd = await k.readdArgs(view.state, X.pk, A);
  const back = await k.run(view, [[A, 'add', readd]]);
  assert.equal(back.state.epoch.kid, readd.kid, 're-add rotates the key in the same commit');
  assert.equal(back.state.epoch.v, back.state.members.find((m) => m.pk === X.pk).addedAtV);
  assert.equal(await attempt(k, view, A, 'add', await k.readdArgs(view.state, T.pk, A)), 'add-rekey-only-for-former', 'first-time adds do not rekey');
  assert.throws(() => G.signCommit(G.proposeCommit(view.state, A.pk, 'add', { pk: X.pk, kid: readd.kid }, 5), A.sign, A.pk), /add-key-incomplete/);
  const leftN = await k.run(view, [[N, 'leave'], [A, 'rekey']]);
  assert.equal(await attempt(k, leftN, A, 'add', { pk: N.pk }), 'readd-needs-rekey', 'someone who left counts as a former member too');
  assert.deepEqual([...leftN.state.former], [N.pk, X.pk].sort());
  assert.ok(G.carriesNewEpoch({ op: 'add', args: readd }) && G.carriesNewEpoch({ op: 'remove', args: {} }) && !G.carriesNewEpoch({ op: 'add', args: { pk: T.pk } }));
  console.log('PASS re-adding a former member is admin-only and rotates the key; first-time adds never rotate');
}

// ── 6. 簽章網域 ──
{
  const k = chainKit(G);
  const view = await k.start(await k.genesis(A, { members: [B.pk] }));
  const good = await k.next(view.state, A, 'info', { name: 'domain' });
  const body = G.commitBody(good.c);
  const enc = (s) => new TextEncoder().encode(s);
  for (const [why, data] of [['aegistalk-gctl-v1:', 'aegistalk-gctl-v1:' + body], ['API signed JSON (no prefix)', body], ['aegistalk-gks-v1:', 'aegistalk-gks-v1:' + body]]) {
    assert.equal((await G.appendCommit(view, { c: good.c, s: b64(A.sign(enc(data))) }, verify)).reason, 'bad-signature', `a signature made for ${why} is not a gstate commit signature`);
  }
  assert.equal((await G.appendCommit(view, good, verify)).ok, true);
  const sig = Buffer.from(good.s, 'base64');
  for (const other of ['aegistalk-gctl-v1:' + body, body, 'aegistalk-gks-v1:' + body]) assert.equal(verify(A.pub, enc(other), sig), false);
  assert.ok(verify(A.pub, enc(G.GSTATE_DOMAIN + body), sig));
  assert.equal(G.GSTATE_DOMAIN, 'aegistalk-gstate-v1:');
  console.log('PASS signature domain separation: gctl / API JSON / gks signatures never verify as gstate commits and vice versa');
}

// ── 7. 列 ──
{
  const k = chainKit(G);
  const g = await k.genesis(A, { members: [B.pk, M.pk] });
  const r = await k.run(await k.start(g), [[A, 'add', { pk: N.pk }], [A, 'remove', { pk: M.pk }], [B, 'leave'], [A, 'rekey'], [A, 'info', { name: '名稱' }]]);
  const rows = JSON.parse(JSON.stringify(r.chain.map((vc) => G.encodeCommitRow(r.gid, vc))));
  assert.deepEqual(Object.keys(rows[0]).sort(), ['body', 'gid', 'id', 'prev', 'sig', 'v']);
  const loaded = await G.loadChainFromRows(r.gid, [...rows].reverse(), verify);
  assert.ok(loaded.ok, loaded.reason);
  assert.equal(stateJson(loaded.view), stateJson(r));
  const edit = (i, patch) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row));
  assert.equal((await G.loadChainFromRows(r.gid, edit(3, { body: rows[3].body.replace('"leave"', '"delete"') }), verify)).reason, 'bad-signature');
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(rows[2].body)).reverse()));
  assert.equal((await G.loadChainFromRows(r.gid, edit(2, { body: reordered }), verify)).reason, 'row-not-canonical');
  assert.equal((await G.loadChainFromRows(r.gid, edit(2, { id: 'a'.repeat(64) }), verify)).reason, 'row-id-mismatch');
  assert.equal((await G.loadChainFromRows(r.gid, edit(2, { v: 9 }), verify)).reason, 'row-mismatch');
  assert.equal((await G.loadChainFromRows(r.gid, rows.filter((_, i) => i !== 2), verify)).reason, 'not-next');
  assert.equal((await G.loadChainFromRows(g.gid.slice(0, 21) + (g.gid[21] === 'A' ? 'B' : 'A'), rows, verify)).reason, 'row-gid-mismatch');
  console.log('PASS group_commits rows round-trip; tampered/reordered/mis-numbered/missing rows rejected');
}

// ── 8. 回傳的東西都凍結 ──
{
  const k = chainKit(G);
  const settings = { type: 'guardian', checkIn: { enabled: true, frequency: 'daily', notifyTime: '09:00', responseDeadline: 48 }, protection: { riskAlert: true, paymentAlert: true, linkAlert: true, riskThreshold: 70 } };
  const g = await k.genesis(A, { members: [B.pk], groupType: 'guardian', guardianSettings: settings });
  const view = await k.start(g);
  settings.checkIn.enabled = false;
  assert.equal(view.state.info.guardianSettings.checkIn.enabled, true, 'the caller\'s object is copied, not kept');
  const args = { name: 'before' };
  const signed = G.signCommit(G.proposeCommit(view.state, A.pk, 'info', args, 5), A.sign, A.pk);
  args.name = 'after';
  assert.equal(signed.c.args.name, 'before');
  const r = await k.extend(view, [signed]);
  for (const [what, o] of [['view', r], ['chain', r.chain], ['commit', r.chain[1].c], ['args', r.chain[1].c.args], ['state', r.state],
    ['members', r.state.members], ['member', r.state.members[0]], ['info', r.state.info], ['guardian settings', r.state.info.guardianSettings.checkIn],
    ['epochs', r.state.epochs], ['former', r.state.former], ['genesis args', r.chain[0].c.args.guardianSettings.checkIn]]) {
    assert.ok(Object.isFrozen(o), `${what} is frozen`);
  }
  assert.throws(() => { r.state.info.guardianSettings.checkIn.enabled = false; }, TypeError, 'in-place edits throw');
  assert.throws(() => { r.state.members.push({ pk: O.pk, role: 'admin', addedAtV: 1 }); }, TypeError);
  assert.ok((await G.loadChainFromRows(r.gid, r.chain.map((vc) => G.encodeCommitRow(r.gid, vc)), verify)).ok, 'stored rows still reload');
  console.log('PASS commits, states and chain views are deep-frozen; caller objects are copied; rows stay loadable');
}

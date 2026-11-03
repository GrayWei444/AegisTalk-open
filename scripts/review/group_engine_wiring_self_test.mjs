/**
 * 群組 log 接線（W1，docs/GROUP_LOG_WIRING_W1.md）：真的引擎＋存檔＋log client＋伺服器 api/group_log_routes.py（見 groupEngineKit）。
 *   1. log 來回：建群 → genesis 上 log → 邀請 → 初始成員對照 log 加入；每台的鏈、名冊、目前金鑰一樣；鏈與位置存進資料庫
 *   2. 自己的 commit 與新金鑰在 append 之前就存好（flush）；append 帶帳號簽章，簽錯的伺服器拒收
 *   3. 同時寫 → 伺服器先到的上，另一筆過時 → 作者在新 head 上重寫（換金鑰的換新的 kid 與金鑰），大家收斂到同一條鏈
 *   4. 離線很久的人重開：從 processedSeq 補完（中間換過金鑰，新金鑰從封裝包拿到）；被踢的人刪掉這個群
 *   5. 邀請：verifyInvite＋對照伺服器 log；不是好友的、不是寫 add 的人送的、seq 對不上的 → 拒收；加回舊成員帶上一代的只讀 log 金鑰
 *   6. 金鑰只收鏈上授權過的（kc 對、寄件人是成員）；只回答 mayReceiveKey 允許的；等金鑰時向 admin 要、拿到後繼續
 *   7. 有人離開 → 名冊馬上少了他、其他變更先 held、畫面「等 admin 換金鑰」；admin 換了之後 held 的才送出
 *   8. 備份／換機：帶整條鏈、位置、目前金鑰；還原時整條重驗，竄改的不還原；還原後補進度跟大家一樣
 *   9. head 交叉比對：落後 → 去抓；conflict → 先問伺服器那一號：跟我當時處理的一樣（成員亂說）→ 不重建；伺服器改了 →
 *      從基準點重建，但會丟掉已套上的 commit 的重建不採用（不倒退、不刪群）
 * Run: node scripts/review/group_engine_wiring_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, E } from './groupEngineKit.mjs';
import { verify } from './groupStateKit.mjs';

const world = new World();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.__verify = verify;
const serverHead = async (gid) => JSON.parse((await world.server.handle('GET', `/api/group-log/${gid}`, '?after=0&limit=1', '')).body).head;
try {
  const [A, B, C, D] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((l) => world.phone(l)));
  for (const x of [B, C, D]) world.befriend(A, x);
  for (const p of [A, B, C, D]) await p.boot();

  // ── 1. log 來回 ──
  const gid = await A.engine.createGroup({ name: 'Sim', members: [B.pk, C.pk] });
  await world.settle();
  assert.equal(gid.length, 22);
  for (const p of [A, B, C]) {
    assert.deepEqual(p.roster(gid), [A.pk, B.pk, C.pk].sort(), `${p.label} sees the full roster`);
    assert.deepEqual(p.admins(gid), [A.pk], `${p.label}: the creator is the only admin`);
    assert.equal(p.groups.get(gid).createdBy, A.pk);
    assert.equal(p.groups.get(gid).keyState, 'ok');
  }
  const genesisKid = A.activeKid(gid)[0];
  assert.deepEqual(B.activeKid(gid), [genesisKid]);
  assert.deepEqual(C.activeKid(gid), [genesisKid]);
  for (const p of [A, B, C]) {
    const st = p.sql('SELECT head_v, processed_seq, status FROM group_log_state WHERE gid = ?', [gid])[0];
    assert.deepEqual({ ...st }, { head_v: 1, processed_seq: 1, status: 'member' }, `${p.label} persisted the log position`);
    assert.equal(p.sql('SELECT COUNT(*) AS n FROM group_commits WHERE gid = ?', [gid])[0].n, 1);
    assert.equal(p.sql("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?", [gid])[0].n, 3, 'projection rows');
  }
  assert.equal(D.groups.size, 0, 'D was not invited');
  console.log('PASS round trip: genesis on the log, sealed invites, initial members confirm against the log; chain, roster, key and position persisted');

  // ── 2. 先存再送；帳號簽章 ──
  let seenAtAppend = null;
  A.appendHook = async () => {
    seenAtAppend = A.sql("SELECT op, state FROM group_pending_commits WHERE gid = ?", [gid]).map((r) => `${r.op}:${r.state}`);
  };
  const flushesBefore = globalThis.__engineFlushes[A.dbLabel] ?? 0;
  assert.equal(await A.engine.updateInfo(gid, { name: 'Sim 2' }), 'applied');
  A.appendHook = null;
  assert.deepEqual(seenAtAppend, ['info:append'], 'the own commit is in the store before the POST');
  assert.ok((globalThis.__engineFlushes[A.dbLabel] ?? 0) > flushesBefore, 'and flushed');
  assert.equal(A.sql('SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ?', [gid])[0].n, 0, 'dropped once applied');
  await world.settle();
  for (const p of [A, B, C]) assert.equal(p.groups.get(gid).name, 'Sim 2');
  const forged = await world.server.handle('POST', `/api/group-log/${gid}`, '', JSON.stringify({
    blob: '{"k":"x","n":"AAAAAAAAAAAAAAAA","c":"AAAAAAAAAAAAAAAAAAAAAA=="}', pubkey: B.pk, timestamp: Math.floor(world.now() / 1000),
    request_id: 'f'.repeat(32), signature: Buffer.from(A.id.sign(new Uint8Array([1]))).toString('base64'),
  }));
  assert.equal(forged.status, 401, 'an append not signed by the account is refused by the real routes');
  console.log('PASS own commits (and new keys) are persisted and flushed before the append; appends are account-signed');

  // ── 3. 同時寫 → 過時的重寫 ──
  assert.equal(await A.engine.setRole(gid, B.pk, 'admin'), 'applied');
  await world.settle();
  assert.deepEqual(C.admins(gid), [A.pk, B.pk].sort());
  // B 跟 A 在同一個 head 上同時寫（B 還沒看到 A 那筆）：A 改名、B 加 D（D 不是 B 的好友，邀請由 B 送 → D 不收，見 5）
  world.befriend(B, D);
  const r1 = A.engine.updateInfo(gid, { name: 'Sim 3' });
  const r2 = B.engine.removeMember(gid, C.pk);   // 換金鑰的 commit：過時的要換新的 kid 與金鑰
  await Promise.all([r1, r2]);
  await world.settle();
  for (const p of [A, B]) {
    assert.equal(p.groups.get(gid).name, 'Sim 3', `${p.label}: rename applied`);
    assert.deepEqual(p.roster(gid), [A.pk, B.pk].sort(), `${p.label}: C removed`);
  }
  assert.equal(C.groups.has(gid), false, 'C dropped the group');
  assert.equal(C.sql('SELECT COUNT(*) AS n FROM group_commits WHERE gid = ?', [gid])[0].n, 0, 'C deleted the chain');
  const kA = A.activeKid(gid);
  assert.deepEqual(B.activeKid(gid), kA);
  assert.notEqual(kA[0], genesisKid, 'the remove rotated the key');
  const headA = A.engine.gossip(gid);
  assert.deepEqual(B.engine.gossip(gid), headA, 'A and B converge on the same head');
  assert.ok(A.notices.concat(B.notices).every((n) => n.kind !== 'rejected'), JSON.stringify(A.notices.concat(B.notices)));
  const chainLen = A.sql('SELECT MAX(v) AS v FROM group_commits WHERE gid = ?', [gid])[0].v;
  assert.equal(await serverHead(gid), chainLen + 1, 'exactly one entry on the log was stale (skipped) and rebuilt');
  const removes = A.sql("SELECT body FROM group_commits WHERE gid = ? AND body LIKE '%\"op\":\"remove\"%'", [gid]);
  assert.equal(removes.length, 1);
  console.log('PASS concurrent commits: the server order decides, the stale one is rebuilt on the new head, all replicas converge');

  // ── 4. 離線很久的人跨過換金鑰補完；被踢的人刪掉 ──
  const g2 = await A.engine.createGroup({ name: 'Two', members: [B.pk, C.pk, D.pk] });
  await world.settle();
  for (const p of [B, C, D]) assert.deepEqual(p.roster(g2), [A.pk, B.pk, C.pk, D.pk].sort());
  C.shutdown();
  assert.equal(await A.engine.removeMember(g2, B.pk), 'applied');
  assert.equal(await A.engine.updateInfo(g2, { name: 'Two renamed' }), 'applied');
  await world.settle();
  assert.equal(B.groups.has(g2), false, 'B (removed) dropped the group');
  assert.deepEqual(D.activeKid(g2), A.activeKid(g2), 'D got the new key from the bundle in the remove entry');
  await C.boot();
  await world.settle();
  assert.equal(C.groups.get(g2).name, 'Two renamed', 'C caught up after reopening');
  assert.deepEqual(C.roster(g2), [A.pk, C.pk, D.pk].sort());
  assert.deepEqual(C.activeKid(g2), A.activeKid(g2), 'C took the rotated key from the log (it was offline for the rekey)');
  assert.ok(B.engine.decryptKey(g2, A.activeKid(g2)[0]) === null, 'B never sees the new epoch key');
  console.log('PASS catch-up after being offline across a rekey; the removed member deletes the group and never gets the new key');

  // ── 5. 邀請 ──
  const E2 = await world.phone('erin');
  await E2.boot();
  const before = world.sealedLog.length;
  assert.equal(await A.engine.addMember(g2, E2.pk), 'applied');
  await world.settle();
  const invite = world.sealedLog.slice(before).find((m) => m.kind === 'invite' && m.to === E2.pk);
  assert.ok(invite, 'the invite went out after the add was applied');
  assert.equal(E2.groups.has(g2), false, 'E (not a friend of A) ignores the invite');
  assert.equal(E2.sql("SELECT COUNT(*) AS n FROM group_pending_commits")[0].n, 0, 'nothing stored for an ignored invite');
  world.befriend(A, E2);
  world.befriend(D, E2);
  await world.deliverSealed(D, E2.pk, invite.body);        // 好友 D 轉送 A 的邀請：不是寫那筆 add 的人
  await world.settle();
  assert.equal(E2.groups.has(g2), false);
  assert.ok(E2.notices.some((n) => n.kind === 'invite-rejected' && n.reason === 'sender-is-not-the-adder'), JSON.stringify(E2.notices));
  await world.deliverSealed(A, E2.pk, { ...invite.body, headSeq: invite.body.headSeq + 1 });   // seq 對不上
  await world.settle();
  assert.equal(E2.groups.has(g2), false, 'an invite whose headSeq does not match the log is rejected');
  assert.ok(E2.notices.some((n) => n.kind === 'invite-rejected' && /head-seq|add-not-in-log/.test(n.reason)), JSON.stringify(E2.notices));
  // 好友但被我封鎖：他的邀請一律不收（稽核 H13）
  E2.shutdown();
  await E2.boot({ isBlocked: async (pk) => pk === A.pk });
  await world.deliverSealed(A, E2.pk, invite.body);
  await world.settle();
  assert.equal(E2.groups.has(g2), false, 'an invite from a friend I blocked is ignored');
  assert.equal(E2.sql("SELECT COUNT(*) AS n FROM group_pending_commits")[0].n, 0, 'and nothing is stored for it');
  E2.shutdown();
  await E2.boot();
  await world.deliverSealed(A, E2.pk, invite.body);        // 正確的
  await world.settle();
  assert.deepEqual(E2.roster(g2), [A.pk, C.pk, D.pk, E2.pk].sort(), 'the honest invite confirms against the log and joins');
  assert.deepEqual(E2.activeKid(g2), A.activeKid(g2));
  // 加回舊成員：admin 換金鑰、邀請附上一代的只讀 log 金鑰
  world.befriend(A, B);
  const kidBefore = A.activeKid(g2)[0];
  assert.equal(await A.engine.addMember(g2, B.pk), 'applied');
  await world.settle();
  const readd = world.sealedLog.filter((m) => m.kind === 'invite' && m.to === B.pk && m.gid === g2).pop();
  assert.ok(readd?.body.parentLogKey, 're-add invite carries the parent epoch read-only log key');
  assert.deepEqual(B.roster(g2), [A.pk, B.pk, C.pk, D.pk, E2.pk].sort(), 'B is back');
  assert.notEqual(A.activeKid(g2)[0], kidBefore, 're-adding a former member rotated the key');
  for (const p of [B, C, D, E2]) assert.deepEqual(p.activeKid(g2), A.activeKid(g2), `${p.label} holds the re-add epoch key`);
  assert.equal(B.engine.decryptKey(g2, kidBefore), null, 'B does not get the epoch it missed (the parent log key never enters the key store)');
  console.log('PASS invites: verified chain + log confirmation; non-friend, blocked, forwarded and wrong-seq invites rejected; re-add with the parent log key');

  // ── 6. 金鑰只照鏈收、照 mayReceiveKey 給 ──
  const cur = A.activeKid(g2)[0];
  const curKey = A.engine.decryptKey(g2, cur);
  const sentTo = (to, kind, since) => world.sealedLog.slice(since).filter((m) => m.to === to && m.kind === kind);
  let mark = world.sealedLog.length;
  const outsider = await world.phone('olga');
  await outsider.boot();
  await world.deliverSealed(outsider, A.pk, { kind: 'req', gid: g2, kid: cur });          // 外人
  await world.deliverSealed(C, A.pk, { kind: 'req', gid: g2, kid: genesisKid });           // 別的群的 kid
  await world.deliverSealed(E2, A.pk, { kind: 'req', gid: g2, kid: D.sql('SELECT key_id FROM group_keys WHERE group_id = ? AND epoch_v = 1', [g2])[0].key_id });   // 他加入之前的那一代
  await world.settle();
  assert.equal(sentTo(outsider.pk, 'dist', mark).length, 0, 'no key for a non-member');
  assert.equal(sentTo(C.pk, 'dist', mark).length, 0, 'unknown kid → no answer');
  assert.equal(sentTo(E2.pk, 'dist', mark).length, 0, 'an epoch that ended before the requester joined is not given');
  mark = world.sealedLog.length;
  await world.deliverSealed(C, A.pk, { kind: 'req', gid: g2, kid: cur });
  await world.settle();
  assert.equal(sentTo(C.pk, 'dist', mark).length, 1, 'a member asking for the current epoch gets it');
  // D 手上這一代的金鑰不見了（模擬還原時沒帶到）→ 重開後自己向 admin 要；假的、別人的、不在鏈上的都不收
  D.shutdown();
  D.db.run('DELETE FROM group_keys WHERE group_id = ? AND key_id = ?', [g2, cur]);
  const asked = world.sealedLog.length;
  const replies = [];
  await D.boot({ sendSealed: async (to, body) => { replies.push({ to, body }); if (to !== A.pk) await world.deliverSealed(D, to, body); } });
  await world.settle();
  assert.ok(replies.some((r) => r.to === A.pk && r.body.kind === 'req' && r.body.kid === cur), 'D asks the admin for the epoch it lacks');
  assert.equal(D.groups.get(g2).keyState, 'waiting-key');
  assert.equal(await D.engine.sendingKey(g2), null, 'no sending key while waiting (no fallback to an older epoch)');
  const fake = new Uint8Array(32).fill(7);
  await world.deliverSealed(A, D.pk, { kind: 'dist', gid: g2, kid: cur, key: Buffer.from(fake).toString('base64') });   // kc 對不上
  await world.deliverSealed(outsider, D.pk, { kind: 'dist', gid: g2, kid: cur, key: Buffer.from(curKey).toString('base64') });   // 外人
  await world.deliverSealed(A, D.pk, { kind: 'dist', gid: g2, kid: 'not-a-chain-kid', key: Buffer.from(curKey).toString('base64') });
  await world.settle();
  assert.equal(D.engine.decryptKey(g2, cur), null, 'wrong key, a non-member sender, unknown kid → nothing accepted');
  await world.deliverSealed(A, D.pk, { kind: 'dist', gid: g2, kid: cur, key: Buffer.from(curKey).toString('base64') });
  await world.settle();
  assert.equal(D.groups.get(g2).keyState, 'ok');
  assert.deepEqual(D.activeKid(g2), [cur], 'the chain-authorised key is accepted and becomes the sending key');
  assert.ok(world.sealedLog.slice(asked).length > 0);
  // 別的群挑一樣的 kid：金鑰以 (群組, kid) 為主鍵，存進來也換不掉這個群那一代
  const otherGid = 'Other_gid_0123456789ab';
  await A.store.persistGroupLog({ gid: otherGid, keys: [{ kid: cur, key: fake, v: 1, actor: A.pk, origin: 'chain' }] });
  assert.deepEqual(A.sql('SELECT key_base64 FROM group_keys WHERE group_id = ? AND key_id = ?', [g2, cur]).map((r) => r.key_base64),
    [Buffer.from(curKey).toString('base64')], 'another group reusing the kid does not replace this group\'s key');
  assert.equal(A.sql('SELECT COUNT(*) AS n FROM group_keys WHERE key_id = ?', [cur])[0].n, 2, 'both rows exist side by side');
  assert.deepEqual(Buffer.from(A.engine.decryptKey(g2, cur)), Buffer.from(curKey));
  A.db.run('DELETE FROM group_keys WHERE group_id = ?', [otherGid]);
  console.log('PASS keys: only chain-authorised keys from members are accepted; requests answered only per mayReceiveKey; a missing epoch key is requested; (group, kid) keyed');

  // ── 7. 離開 → 先 held，等 admin 換金鑰 ──
  world.befriend(A, C);
  const g3 = await A.engine.createGroup({ name: 'Three', members: [B.pk, C.pk, D.pk] });
  await world.settle();
  assert.equal(await A.engine.setRole(g3, C.pk, 'admin'), 'applied');
  await world.settle();
  const [first, second] = [A, C].sort((x, y) => (x.pk < y.pk ? -1 : 1));
  first.shutdown();                                  // 輪換順序第一位的 admin 不在
  const k3 = second.activeKid(g3)[0];
  assert.equal(await B.engine.leave(g3), 'applied');
  await world.settle();
  assert.equal(B.groups.has(g3), false, 'the leaver dropped the group once its leave was applied');
  assert.deepEqual(D.roster(g3), [A.pk, C.pk, D.pk].sort(), 'the leaver is out of the roster (fan-out) at once');
  assert.equal(D.groups.get(g3).keyState, 'waiting-admin-rekey');
  assert.equal(await D.engine.addMember(g3, E2.pk), 'held', 'control changes are held until an admin rotates the key');
  assert.ok(D.notices.some((n) => n.kind === 'held'));
  assert.deepEqual(second.activeKid(g3), [k3], 'the second admin waits its 60 s turn');
  world.offset += 61_000;
  second.engine.syncAll();
  await world.settle();
  const k3b = second.activeKid(g3)[0];
  assert.notEqual(k3b, k3, 'after 60 s of its own clock the second admin rotates');
  await world.settle();
  for (const p of [second, D]) assert.ok(p.roster(g3).includes(E2.pk), `${p.label}: the held add went out after the rekey`);
  assert.deepEqual(D.activeKid(g3)[0] !== undefined, true);
  await first.boot();
  await world.settle();
  assert.equal(first.groups.get(g3).keyState, 'ok');
  assert.ok(first.roster(g3).includes(E2.pk));
  const rekeys = first.sql("SELECT COUNT(*) AS n FROM group_commits WHERE gid = ? AND body LIKE '%\"op\":\"rekey\"%'", [g3])[0].n;
  assert.equal(rekeys, 1, 'the admin that was away does not rotate again');
  console.log('PASS leave: the leaver drops out at once, control changes are held (UI: waiting for an admin), the next admin rotates after its turn');

  // ── 8. 備份／換機帶整條鏈 ──
  const backup = A.engine.backupOf(g2);
  assert.ok(backup && backup.chain.length >= 4 && backup.epochKey, 'the backup carries the chain, the position and the epoch key');
  A.shutdown();
  const A2 = await world.phone('alice-restored', A);
  await A2.boot();          // 帳號恢復：身分先解鎖、引擎先跑起來，群組之後才從備份還原
  assert.equal(A2.groups.size, 0);
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.chain[0].c.args.name = 'Evil';
  assert.equal(await E.restoreGroupBackups([{ id: g2, log: tampered }], A.pk, (...x) => globalThis.__verify(...x), A2.store), 0, 'a tampered chain is not restored');
  const strangerCopy = await world.phone('stranger');
  assert.equal(await E.restoreGroupBackups([{ id: g2, log: backup }], strangerCopy.pk, (...x) => globalThis.__verify(...x), strangerCopy.store), 0,
    'a backup is not restored for someone who is not on the roster');
  assert.equal(await E.restoreGroupBackups([{ id: g2, log: backup }], A.pk, (...x) => globalThis.__verify(...x), A2.store), 1);
  assert.equal(await D.engine.updateInfo(g2, { name: 'Moved on' }).catch((e) => e.reason), 'not-admin', 'D is not an admin (rules)');
  assert.equal(await C.engine.addMember(g2, outsider.pk), 'applied', 'the group moved on while A was being restored');
  await world.settle();
  assert.equal(await A2.engine.adoptStored(), 1, 'the running engine adopts the group restored under it (re-verified from the store)');
  assert.equal(await A2.engine.adoptStored(), 0, 'once');
  await world.settle();
  assert.deepEqual(A2.roster(g2), C.roster(g2), 'the restored replica caught up to the same roster');
  assert.deepEqual(A2.activeKid(g2), C.activeKid(g2));
  assert.deepEqual(A2.engine.gossip(g2), C.engine.gossip(g2), 'and the same head');
  const restoreSrc = readFileSync(new URL('../../packages/pwa/src/services/groupRestore.ts', import.meta.url), 'utf8');
  assert.ok(/restoreGroupBackups\([^)]*\);\s*if \(n > 0\) await getGroupEngine\(\)\?\.adoptStored\(\);/.test(restoreSrc), 'the app restore path hands restored groups to a running engine');
  console.log('PASS backup/transfer carry the chain + position + epoch key; restore re-verifies (tampered/foreign rejected), a running engine adopts it, catches up');

  // ── 9. head 交叉比對 ──
  const h = C.engine.gossip(g2);
  const fetchesBefore = C.fetchCount.get(`${g2}|${h.seq}`) ?? 0;
  C.engine.onGossip(g2, { seq: h.seq + 5, id: 'ab'.repeat(32) }, D.pk);   // W2：寄件人（已驗過的成員）一起傳
  await world.settle();
  assert.ok((C.fetchCount.get(`${g2}|${h.seq}`) ?? 0) > fetchesBefore, 'a member ahead of me → I fetch');
  const st = C.sql('SELECT first_seq FROM group_log_state WHERE gid = ?', [g2])[0];
  const fromBase = () => C.fetchCount.get(`${g2}|${st.first_seq}`) ?? 0;
  // 成員自己簽的群訊可以宣稱任何 head（審查 W1 HIGH-3）：伺服器給我的那一號跟我當時處理的一樣 → 不重建、不動鏈
  let rebuildsBefore = fromBase();
  C.engine.onGossip(g2, { seq: h.seq, id: 'cd'.repeat(32) }, D.pk);
  await world.settle();
  assert.equal(fromBase(), rebuildsBefore, 'a forged head from a member does not trigger a rebuild when the server agrees with me');
  assert.ok((C.fetchCount.get(`${g2}|${h.seq - 1}`) ?? 0) > 0, 'only that one seq was checked against the server');
  assert.deepEqual(C.engine.gossip(g2), h);
  assert.ok(C.notices.some((n) => n.kind === 'conflict' && n.reason === 'peer-disagrees'), JSON.stringify(C.notices.slice(-3)));
  // 伺服器真的改了給我的歷史（我那一號現在打不開）→ 重抓、重建；重建會丟掉我已經套上的 commit → 不採用、鏈不倒退、群不刪
  const flip = (blob) => { const o = JSON.parse(blob); o.n = Buffer.from(Buffer.from(o.n, 'base64').map((x) => x ^ 0xff)).toString('base64'); return JSON.stringify(o); };
  world.fetchFilter = (phone, g, entries) => (phone === C && g === g2 ? entries.map((e) => (e.seq === h.seq ? { ...e, blob: flip(e.blob) } : e)) : entries);
  world.offset += 61_000;   // 重建一分鐘最多一次
  rebuildsBefore = fromBase();
  C.engine.onGossip(g2, { seq: h.seq, id: 'ef'.repeat(32) }, D.pk);
  await world.settle();
  world.fetchFilter = null;
  assert.ok(fromBase() > rebuildsBefore, 'the server changed what it serves me at that seq → re-fetch from the base');
  assert.deepEqual(C.engine.gossip(g2), h, 'a rebuild that would drop commits I already applied is not adopted');
  assert.ok(C.groups.has(g2), 'and the group is not dropped');
  assert.ok(C.notices.some((n) => n.kind === 'conflict' && /rebuild-not-adopted:would-regress/.test(n.reason ?? '')), JSON.stringify(C.notices.slice(-3)));
  // 伺服器少給一筆 → gap → 重抓
  let hidden = false;
  world.fetchFilter = (phone, g, entries) => {
    if (phone !== D || g !== g2 || hidden || entries.length < 2) return entries;
    hidden = true;
    return entries.filter((_, i) => i !== 0);
  };
  assert.equal(await C.engine.addMember(g2, B.pk).catch((e) => e.reason), 'already-member');
  await A2.engine.updateInfo(g2, { name: 'After gap 1' });
  await A2.engine.updateInfo(g2, { name: 'After gap 2' });
  await world.settle();
  world.fetchFilter = null;
  D.engine.requestSync(g2);
  await world.settle();
  assert.equal(D.groups.get(g2).name, 'After gap 2', 'a hole in the served log stops processing, the refetch fills it');
  assert.deepEqual(D.engine.gossip(g2), A2.engine.gossip(g2));
  console.log('PASS head gossip: behind → fetch; a forged conflict is checked against the server (no rebuild); a server rewrite is detected but never makes the chain regress; a missing seq is refetched, never skipped as stale');
} finally {
  world.close();
}
await wait(10);

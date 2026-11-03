/**
 * W1 接線的獨立審查（HIGH-1／HIGH-2／HIGH-3、M-1／M-2、LOW）之後的修正：真的引擎＋存檔＋log client＋api/group_log_routes.py。
 *   1. HIGH-1 我寫的 commit 晚於別人的換金鑰落到 log（外層是上一代 → other-epoch 跳過，不在 staleOwn）：在新的 head 上重寫、
 *      套上，不會永遠卡在待送、也不會每次重開都把舊的 blob 再 POST 一次
 *   2. HIGH-2 同一個作者在同一個 head 上寫兩筆換金鑰（kid 一樣）：第二筆先 held，第一筆套上後才放；鏈上這一代的金鑰
 *      絕不會因為過時那筆被丟掉而刪掉；唯一 admin 自己那份不見了，改問其他成員
 *   3. 加回舊成員之後重建的基準點在加入那筆（上一代的只讀 log 金鑰早就丟了）；備份還原的基準點挪到目前這一代開始的地方
 *   4. M-2 離線時被踢又被加回：邀請比「被踢」先到 → 先存著，舊的群刪掉之後重新加入
 *   5. M-1 引擎停了之後，還在跑的工作不再寫資料庫或畫面
 *   6. LOW 名冊外的人發的 log 通知不理（W2：W1 的 group_log_ping 換成 group_sealed 的 commit 通知，名冊外的寄件人不解密就丟，
 *      就算他拿得到目前這一代的金鑰）；伺服器明確拒收的 append 丟掉並回報（不再每次同步重送）；規則拒收的動作 propose 會丟錯
 *   7. 複審 M1：邀請額度用完的先存著；一個寄件人最多存 3 份確認中的邀請，擠不掉別人的
 *   8. 複審 M2：宣稱 head 在一筆規則會拒收的 commit 上（我當時跳過的那一號），不算伺服器改歷史、不重建
 * Run: node scripts/review/group_engine_review_fixes_self_test.mjs
 */
import assert from 'node:assert/strict';
import { World, E } from './groupEngineKit.mjs';
import { verify, x25519 } from './groupStateKit.mjs';

const world = new World();
globalThis.__verify = verify;
const pendingOf = (p, gid) => p.sql('SELECT op, state FROM group_pending_commits WHERE gid = ?', [gid]).map((r) => `${r.op}:${r.state}`);
try {
  const [A, B, C, D] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((l) => world.phone(l)));
  for (const x of [B, C, D]) world.befriend(A, x);
  world.befriend(C, D);
  for (const p of [A, B, C, D]) await p.boot();

  // ── 1. HIGH-1 ──
  const g = await A.engine.createGroup({ name: 'One', members: [B.pk, C.pk, D.pk] });
  await world.settle();
  assert.equal(await A.engine.setRole(g, C.pk, 'admin'), 'applied');
  await world.settle();
  // A 改名：在 A 的 POST 送出之前，C（另一位 admin）的踢人（換金鑰）先落到 log
  let posts = 0;
  A.appendHook = async () => {
    posts++;
    if (posts === 1) await C.engine.removeMember(g, B.pk);
  };
  const r = await A.engine.updateInfo(g, { name: 'Renamed after the rekey' });
  await world.settle();
  A.appendHook = null;
  assert.ok(['applied', 'pending'].includes(r), r);
  for (const p of [A, C, D]) {
    assert.equal(p.groups.get(g).name, 'Renamed after the rekey', `${p.label}: the rename was rewritten on the new head and applied`);
    assert.ok(!p.roster(g).includes(B.pk), `${p.label}: B removed`);
  }
  assert.deepEqual(pendingOf(A, g), [], 'nothing left pending on A');
  assert.equal(posts, 2, 'the stale entry was posted once, the rewritten one once');
  assert.ok(!A.notices.some((n) => n.kind === 'rejected'), JSON.stringify(A.notices));
  // 重開：不會再把舊的 blob POST 一次
  A.shutdown();
  posts = 0;
  A.appendHook = async () => { posts++; };
  await A.boot();
  await world.settle();
  A.appendHook = null;
  assert.equal(posts, 0, 'after a restart nothing is re-posted');
  console.log('PASS HIGH-1: my commit overtaken by another admin\'s rekey is rewritten on the new head (not stuck, not re-posted forever)');

  // ── 2. HIGH-2 ──
  const g2 = await A.engine.createGroup({ name: 'Two', members: [B.pk, C.pk, D.pk] });
  await world.settle();
  let offline = true;
  A.appendHook = async () => { if (offline) throw new Error('network down'); };
  assert.equal(await A.engine.removeMember(g2, B.pk), 'pending', 'the first remove could not be posted');
  assert.equal(await A.engine.removeMember(g2, C.pk), 'held', 'a second key-rotating commit on the same head is held (its kid would collide)');
  assert.deepEqual(pendingOf(A, g2).sort(), ['remove:append', 'remove:held']);
  offline = false;
  A.appendHook = null;
  A.engine.requestSync(g2);
  await world.settle();
  assert.deepEqual(A.roster(g2), [A.pk, D.pk].sort(), 'both removes applied, one after the other');
  assert.deepEqual(D.roster(g2), A.roster(g2));
  assert.equal(A.groups.get(g2).keyState, 'ok', 'the sole admin still holds the current epoch key');
  assert.ok(await A.engine.sendingKey(g2), 'and can send');
  assert.deepEqual(D.activeKid(g2), A.activeKid(g2));
  assert.deepEqual(pendingOf(A, g2), []);
  // 同一個 head 上我的兩筆換金鑰（例如另一台同帳號的裝置、或舊版留下的）：另一筆先落地成為鏈上這一代（kid 跟我待送那筆一樣）
  //   → 我那筆過時、被重寫時不能把鏈上這一代的金鑰刪掉（以前 rebase 無條件 dropKids → 唯一 admin 從此沒有金鑰）
  const g3 = await A.engine.createGroup({ name: 'Three', members: [C.pk, D.pk] });
  await world.settle();
  A.appendHook = async () => { throw new Error('network down'); };
  assert.equal(await A.engine.removeMember(g3, C.pk), 'pending');
  A.appendHook = null;
  const mine = JSON.parse(A.sql("SELECT signed FROM group_pending_commits WHERE gid = ? AND state = 'append'", [g3])[0].signed);
  const rows = A.sql('SELECT gid, v, id, prev, body, sig FROM group_commits WHERE gid = ? ORDER BY v', [g3]).map((r) => ({ ...r, v: Number(r.v) }));
  const loaded = await E.GS.loadChainFromRows(g3, rows, verify);
  assert.ok(loaded.ok);
  const other = await E.GL.buildCommitEntry({
    view: loaded.view, actor: A.pk, sign: A.id.sign, op: 'rekey', args: {}, ts: world.now(),
    epochKey: A.engine.decryptKey(g3, loaded.view.state.epoch.kid), newEpoch: { key: crypto.getRandomValues(new Uint8Array(32)) },
  }, x25519);
  assert.equal(other.newEpoch.kid, mine.c.args.kid, 'same head, same author → same kid');
  const client = E.createGroupLogClient({
    base: 'https://api.test', signer: () => ({ publicKey: A.pk, sign: A.id.sign }), serverNow: () => world.now(), sleep: async () => {},
    fetchFn: async (url, init = {}) => {
      const u = new URL(url);
      const out = await world.server.handle(init.method ?? 'GET', u.pathname, u.search, init.body ?? '');
      return new Response(out.body, { status: out.status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await client.append(g3, other.blob);
  A.engine.requestSync(g3);
  await world.settle();
  // W3：那一筆是直接寫進 log 的（沒有人在 D 的主題上發換金鑰通知），之後的通知都在新一代的主題上 —— D 在下一次輪詢補上
  D.engine.requestSync(g3);
  await world.settle();
  assert.deepEqual(A.roster(g3), [A.pk, D.pk].sort(), 'my overtaken remove was rewritten on the new head and applied');
  assert.equal(A.groups.get(g3).keyState, 'ok', 'the sole admin still holds the current epoch key');
  assert.ok(await A.engine.sendingKey(g3));
  assert.deepEqual(D.activeKid(g3), A.activeKid(g3));
  // 唯一的 admin 自己那一份金鑰不見了（還原時沒帶到）：沒有 admin 可問 → 改問其他成員（mayReceiveKey 允許他們回答）
  const lostKid = A.activeKid(g3)[0];
  A.shutdown();
  A.db.run('DELETE FROM group_keys WHERE group_id = ? AND key_id = ?', [g3, lostKid]);
  await A.boot();
  await world.settle();
  assert.equal(A.groups.get(g3).keyState, 'ok', 'the sole admin got its key back from a member');
  assert.deepEqual(A.activeKid(g3), [lostKid]);
  console.log('PASS HIGH-2: a second key-rotating commit waits for the first; the current epoch key is never dropped');

  // ── 3. 重建的基準點 ──
  world.befriend(A, B);
  assert.equal(await A.engine.addMember(g2, B.pk), 'applied', 'B (removed in 2) is re-added');
  await world.settle();
  const bState = B.sql('SELECT first_seq, base_v, join_v FROM group_log_state WHERE gid = ?', [g2])[0];
  assert.ok(bState, 'B rejoined');
  assert.equal(bState.base_v, bState.join_v, 'a re-added member rebuilds from its own add (the parent log key is gone)');
  const h = B.engine.gossip(g2);
  assert.equal(bState.first_seq, h.seq, 'its base is the seq of that add');
  const backup = D.engine.backupOf(g2);
  const D2 = await world.phone('dave-restored', D);
  await D2.boot();
  assert.equal(await E.restoreGroupBackups([{ id: g2, log: backup }], D.pk, (...x) => globalThis.__verify(...x), D2.store), 1);
  await D2.engine.adoptStored();
  await world.settle();
  const dState = D2.sql('SELECT first_seq, base_v FROM group_log_state WHERE gid = ?', [g2])[0];
  const chain = D2.sql('SELECT v, body FROM group_commits WHERE gid = ? ORDER BY v', [g2]);
  const epochStart = Math.max(...chain.filter((c) => /"kid"/.test(c.body)).map((c) => c.v));
  assert.equal(dState.base_v, epochStart, 'a restored device rebuilds from the start of the epoch it holds the key for');
  D2.shutdown();
  world.phones.set(D.pk, D);   // 同一個身分的兩台：信封送回原本那台
  console.log('PASS rebuild bases: a re-added member from its own add, a restored device from the current epoch');

  // ── 4. M-2 ──
  const g4 = await A.engine.createGroup({ name: 'Four', members: [B.pk, D.pk] });
  await world.settle();
  B.shutdown();
  assert.equal(await A.engine.removeMember(g4, B.pk), 'applied');
  await world.settle();
  assert.equal(await A.engine.addMember(g4, B.pk), 'applied', 're-added while B is offline');
  await world.settle();
  assert.ok(world.mailbox.get(B.pk)?.length, 'the re-add invite is queued for B');
  await B.boot();          // 引擎先載入舊的群，排隊的邀請比「被踢」的同步先到
  await world.settle();
  assert.ok(B.groups.has(g4), 'B is back in the group');
  assert.deepEqual(B.roster(g4), [A.pk, B.pk, D.pk].sort());
  assert.deepEqual(B.activeKid(g4), A.activeKid(g4), 'with the re-add epoch key');
  assert.equal(B.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE state = 'join'")[0].n, 0, 'the invite row is gone once joined');
  console.log('PASS M-2: a re-add invite that arrives before the removal is synced is kept and used once the old group is dropped');

  // ── 5. M-1 ──
  assert.ok(D.groups.has(g4));
  let projected = 0;
  D.shutdown();
  await D.boot({ project: (gid, grp) => { projected++; if (grp) D.groups.set(gid, grp); else D.groups.delete(gid); world.bump(); } });
  await world.settle();
  const before = { ...D.sql('SELECT processed_seq, head_v FROM group_log_state WHERE gid = ?', [g4])[0] };
  projected = 0;
  // D 的引擎正在抓 log（A 的 ping 觸發）的時候被停掉（換帳號）：抓回來的東西不寫資料庫、不動畫面
  const stoppedEngine = D.engine;
  let stoppedMidFetch = false;
  world.fetchFilter = (phone, gid, entries) => {
    if (phone === D && gid === g4 && !stoppedMidFetch) { stoppedMidFetch = true; stoppedEngine.stop(); }
    return entries;
  };
  assert.equal(await A.engine.updateInfo(g4, { name: 'Four b' }), 'applied');
  await world.settle();
  world.fetchFilter = null;
  assert.ok(stoppedMidFetch, 'D was fetching when it stopped');
  assert.deepEqual({ ...D.sql('SELECT processed_seq, head_v FROM group_log_state WHERE gid = ?', [g4])[0] }, before, 'no DB writes after stop');
  assert.equal(projected, 0, 'no projection after stop');
  D.engine = null;
  D.online = false;
  console.log('PASS M-1: a stopped engine does not write the store or the screen');

  // ── 6. LOW ──
  const outsider = await world.phone('olga');
  await outsider.boot();
  const fetchesOf = (p) => [...p.fetchCount.values()].reduce((a, b) => a + b, 0);
  const gkid = C.activeKid(g)[0];
  const gkey = C.engine.decryptKey(g, gkid);
  const ph = C.engine.gossip(g);
  const notification = (who) => E.CTL.sealControl({ gid: g, kid: gkid, key: gkey, sender: who.pk, sign: who.id.sign, t: 'commit',
    body: { head: { seq: ph.seq + 50, id: 'ab'.repeat(32) } }, ts: world.now() });
  const fetchesBefore = fetchesOf(C);
  // 名冊外的人（這裡連目前這一代的金鑰都拿到了）發的 commit 通知：不解密就丟、不抓 log
  assert.equal(await C.engine.onControl(C.tidOf(g), outsider.pk, (await notification(outsider)).envelope), 'non-member');
  await world.settle();
  assert.equal(fetchesOf(C), fetchesBefore, 'a log notification from someone not on my roster is ignored');
  assert.equal(await C.engine.onControl(C.tidOf(g), A.pk, (await notification(A)).envelope), 'ok');
  await world.settle();
  assert.ok(fetchesOf(C) > fetchesBefore, 'a member\'s log notification still triggers a fetch');
  // 伺服器明確拒收（413）：丟掉、回報，不再每次同步重送
  let tries = 0;
  A.appendHook = async () => { tries++; throw new E.GroupLogHttpError(413, 'entry_too_large'); };
  await assert.rejects(A.engine.updateInfo(g4, { name: 'Too big' }), (e) => e.reason === 'server:entry_too_large');
  A.engine.requestSync(g4);
  await world.settle();
  A.appendHook = null;
  assert.equal(tries, 1, 'a permanently refused append is not retried');
  assert.deepEqual(pendingOf(A, g4), []);
  console.log('PASS LOW: non-member log notifications ignored; permanently refused appends dropped and reported once');

  // ── 7. 複審 MEDIUM-1：一個惡意好友不能把確認中的邀請塞滿、擠掉別人的 ──
  const M = await world.phone('mallory');
  const V = await world.phone('victor');
  world.befriend(M, V);
  world.befriend(A, V);
  await M.boot();
  await V.boot({ inviteBudget: { perSender: 2, total: 20 } });   // 照正式的額度
  const b64 = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64');
  const fakeGid = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url').slice(0, 22);
  for (let i = 0; i < 8; i++) {
    await world.deliverSealed(M, V.pk, { kind: 'invite', gid: fakeGid(), chain: [{}], kid: 'k1', key: b64(32), headSeq: 5, baseSeq: 1 });
  }
  await world.settle();
  const joinRows = () => V.sql("SELECT gid, signed, created_at FROM group_pending_commits WHERE state = 'join'");
  assert.ok(joinRows().filter((r) => r.signed === M.pk).length <= 3, `one sender keeps at most 3 waiting invites (${joinRows().length})`);
  const gV = await A.engine.createGroup({ name: 'Victor', members: [V.pk, C.pk] });
  await world.settle();
  assert.ok(V.groups.has(gV), 'an honest friend\'s invite still gets through');
  console.log('PASS re-review M1: invites over budget are deferred, one sender keeps at most 3 waiting, others are not crowded out');

  // ── 8. 複審 MEDIUM-2：宣稱 head 在一筆會被規則拒收的 commit 上，不會逼出整份重建 ──
  const gR = await A.engine.createGroup({ name: 'Rebuild', members: [C.pk, D.pk] });
  await world.settle();
  assert.equal(await A.engine.updateInfo(gR, { name: 'Rebuild 2' }), 'applied');   // 讓那一號的前一號不是基準點
  await world.settle();
  const rowsR = A.sql('SELECT gid, v, id, prev, body, sig FROM group_commits WHERE gid = ? ORDER BY v', [gR]).map((r) => ({ ...r, v: Number(r.v) }));
  const viewR = (await E.GS.loadChainFromRows(gR, rowsR, verify)).view;
  const kidR = viewR.state.epoch.kid;
  // C（這個群的一般成員）簽一筆把自己升成 admin 的 commit、直接 append：每台都會照規則跳過它（not-admin）
  const bogus = E.GS.signCommit(E.GS.proposeCommit(viewR.state, C.pk, 'role', { pk: C.pk, role: 'admin' }, world.now()), C.id.sign, C.pk);
  const blobR = await E.GL.sealLogEntry({ gid: gR, kid: kidR, key: C.engine.decryptKey(gR, kidR), commit: bogus });
  const clientC = E.createGroupLogClient({
    base: 'https://api.test', signer: () => ({ publicKey: C.pk, sign: C.id.sign }), serverNow: () => world.now(), sleep: async () => {},
    fetchFn: async (url, init = {}) => {
      const u = new URL(url);
      const out = await world.server.handle(init.method ?? 'GET', u.pathname, u.search, init.body ?? '');
      return new Response(out.body, { status: out.status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const bogusSeq = await clientC.append(gR, blobR);
  A.engine.requestSync(gR);
  await world.settle();
  assert.ok(!A.admins(gR).includes(C.pk), 'the bogus role commit was skipped');
  const firstR = A.sql('SELECT first_seq FROM group_log_state WHERE gid = ?', [gR])[0].first_seq;
  const fullBefore = A.fetchCount.get(`${gR}|${firstR}`) ?? 0;
  world.offset += 61_000;
  A.engine.onGossip(gR, { seq: bogusSeq, id: await E.GS.commitIdOf(bogus.c) }, C.pk);   // W2：寄件人一起傳（C 是這個群的成員）
  await world.settle();
  assert.equal(A.fetchCount.get(`${gR}|${firstR}`) ?? 0, fullBefore, 'a seq I skipped by the rules is not "the server changed history" → no rebuild');
  const conflicts = A.notices.filter((n) => n.gid === gR && n.kind === 'conflict').map((n) => n.reason);
  assert.deepEqual(conflicts, ['peer-disagrees'], JSON.stringify(conflicts));
  console.log('PASS re-review M2: pointing a gossip at a commit the rules refuse does not force a full rebuild');
} finally {
  world.close();
}
await new Promise((r) => setTimeout(r, 10));
process.exit(0);

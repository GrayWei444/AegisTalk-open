/**
 * W3（docs/GROUP_LOG_WIRING_W3.md）：每一代金鑰一個群組主題 id。真的引擎＋存檔＋log client＋api/group_log_routes.py
 * （groupEngineKit：手機照引擎的主題表訂／退訂、broker 只送給訂了那個 tid 的手機）。
 *   1. tid 推法：每個成員的目前主題＝deriveTopicId(這一代的金鑰, gid)、22 字元、≠ gid、大家一樣、每個群／每一代都不同；
 *      線上（主題、payload）從來沒有 gid
 *   2. tid → 群組只靠引擎自己的主題表：gid 本身、亂數 tid、別的群的信封、內層自稱別的群 → 一律不收、不交給 App
 *   3. 換金鑰：新的主題、上一代再留重疊期（訂閱也是），到期退訂；App 重開時還在重疊期內 → 上一代補回表上
 *   4. 不在上一代的主題上發：每一則用某一代送出的，送出那一刻寄件人都還沒套上結束那一代的 commit（換金鑰通知在切換之前發）；
 *      封的那段時間裡剛好換了一代 → 不送、改用新的一代重封；mqtt 不收（connected() 卻說連著）→ 留著、不空轉，連上再送
 *   5. 被踢的人：從沒訂到新一代的主題、新主題上的東西一則都沒收到；群沒了，舊主題也退訂
 *   6. 離線跨過兩次換金鑰的人：回來用 log 補上，直接訂到目前這一代的主題（中間那一代從沒訂過），不靠舊主題上排隊的通知
 *   7. App 接線：主題表 → token 範圍；mqtt 收到的主題 id 交給引擎對回群組
 * 審查 W3 之後：信封上沒有 kid（M3）；換主題之後的 grace：needsRekey 期間留著的訊息等大家訂到新主題才放（M1）；拆的時候主題過期
 * → 不收；上一代主題上的 here／sync 不回；absorb 半路出錯，主題表在下一次同步補上（L5）；漏了通知的人靠輪詢自己跟上；
 * 重開時存著的上一代金鑰過不了 kc → 不補主題；這一代的金鑰不見了 → 沒有主題，金鑰回來（不是同步）馬上訂上
 * Run: node scripts/review/group_topics_w3_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, E } from './groupEngineKit.mjs';
import { SRC, verify } from './groupStateKit.mjs';

const OVERLAP = 6_000;   // 測試把 10 分鐘的重疊期縮短（deps.topicOverlapMs）
const world = new World();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = (p, k) => p.engine.controlStats()[k] ?? 0;
const quiet = console.error;
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT)\]/.test(String(a[0]))) quiet(...a); };
const boot = (p) => p.boot({ topicOverlapMs: OVERLAP });
const tidFor = async (p, gid) => E.CTL.deriveTopicId(p.engine.decryptKey(gid, p.activeKid(gid)[0]), gid);

/** 不變式（第 4 點）：某一代的每一則，送出那一刻寄件人套到的 seq 都在「結束那一代的 commit」之前 */
function assertNothingOnOldTopics(endSeqOf, what) {
  for (const e of world.controlLog) {
    const end = endSeqOf.get(e.kid);
    if (end === undefined) continue;
    assert.ok(e.headSeq !== null && e.headSeq < end,
      `${what}: a message under an ended epoch was published after its sender applied the commit that ended it (kid …${e.kid.slice(-6)}, sender at seq ${e.headSeq}, epoch ended at ${end})`);
  }
}

try {
  const [A, B, C, D, X] = await Promise.all(['alice', 'bob', 'carol', 'dave', 'xena'].map((l) => world.phone(l)));
  for (const p of [B, C, D, X]) world.befriend(A, p);
  for (const p of [A, B, C, D, X]) await boot(p);
  const g = await A.engine.createGroup({ name: 'Topic Family', members: [B.pk, C.pk, D.pk] });
  const g2 = await A.engine.createGroup({ name: 'Other Group', members: [B.pk, X.pk] });
  await world.settle();
  for (const p of [B, C, D]) assert.ok(p.groups.has(g), `${p.label} joined`);

  // ── 1. tid 推法 ──
  {
    const tid1 = await tidFor(A, g);
    for (const p of [A, B, C, D]) {
      assert.equal(p.tidOf(g), tid1, `${p.label}'s current topic is deriveTopicId(current key, gid)`);
      assert.ok(p.subs.has(tid1), `${p.label} subscribed it`);
    }
    assert.ok(/^[A-Za-z0-9_-]{22}$/.test(tid1) && tid1 !== g, '22 URL-safe chars, not the gid');
    assert.equal(B.tidOf(g2), await tidFor(B, g2));
    assert.notEqual(B.tidOf(g2), tid1, 'each group has its own topic');
    assert.deepEqual(B.engine.topics().map((t) => t.gid).sort(), [g, g2].sort(), 'one current topic per joined group');
    const gids = [g, g2];
    assert.ok(world.controlLog.length > 0);
    const kids = [g, g2].flatMap((x) => A.sql('SELECT key_id FROM group_keys WHERE group_id = ?', [x]).map((r) => r.key_id));
    assert.ok(kids.length >= 2);
    for (const e of world.controlLog) {
      assert.ok(!gids.includes(e.tid), 'no group id is ever a topic');
      assert.ok(!gids.some((x) => JSON.stringify(e.envelope).includes(x)), 'and none is in a payload');
      assert.deepEqual(Object.keys(e.envelope).sort(), ['c', 'n'], 'the envelope is {n, c} only');
      assert.ok(!kids.some((k) => JSON.stringify(e.envelope).includes(k)), 'no kid on the wire (W3 M3: the log carries kids next to the gid)');
    }
    console.log('PASS tid = deriveTopicId(current key, gid): 22 chars, same for every member, per group and per epoch; no gid on the wire');
  }

  // ── 2. tid → 群組只靠引擎的主題表 ──
  {
    const tid1 = B.tidOf(g);
    const kid = A.activeKid(g)[0];
    const key = A.engine.decryptKey(g, kid);
    const seal = (over) => E.CTL.sealControl({ gid: g, kid, key, sender: A.pk, sign: A.id.sign, t: 'delete', body: { messageId: 'route-x' }, ts: world.now(), ...over });
    const decrypts = stat(B, 'decrypt');
    const good = await seal({});
    assert.equal(await B.engine.onControl(g, A.pk, good.envelope), 'unknown-topic', 'the gid is not a topic');
    assert.equal(await B.engine.onControl('Q'.repeat(22), A.pk, good.envelope), 'unknown-topic', 'a random topic id');
    assert.equal(stat(B, 'decrypt'), decrypts, 'neither was decrypted');
    // 別的群（B 也在）的信封丟到這個群的主題：那一代對不上 → 不解密
    const kid2 = B.activeKid(g2)[0];
    const other = await E.CTL.sealControl({ gid: g2, kid: kid2, key: B.engine.decryptKey(g2, kid2), sender: A.pk, sign: A.id.sign,
      t: 'delete', body: { messageId: 'route-y' }, ts: world.now() });
    assert.equal(await B.engine.onControl(tid1, A.pk, other.envelope), 'bad-envelope', 'an envelope of another group on this topic');
    // 用這個群的金鑰、但內層自稱別的群：主題 id 推出來就不一樣（AAD 綁 tid）→ 在這個主題上解不開；在它自己推出來的主題上沒人認得
    const claimed = await seal({ gid: g2 });
    assert.notEqual(claimed.tid, tid1);
    assert.equal(await B.engine.onControl(tid1, A.pk, claimed.envelope), 'bad-envelope', 'an inner that claims another group does not open on this topic');
    assert.equal(await B.engine.onControl(claimed.tid, A.pk, claimed.envelope), 'unknown-topic');
    assert.deepEqual(B.controls.filter((c) => /^route-/.test(c.body.messageId ?? '')), [], 'nothing reached the app');
    assert.equal(await B.engine.onControl(tid1, A.pk, good.envelope), 'ok', 'the genuine one on the right topic');
    assert.deepEqual(B.controls.filter((c) => c.body.messageId === 'route-x').map((c) => c.gid), [g], 'handed to the app under the group the table says');
    B.controls.length = 0;
    console.log('PASS tid → group only through the engine\'s own table: gid, random id, other group\'s envelope, claimed group all refused');
  }

  // ── 3＋4＋5. 換金鑰（踢掉 D）──
  {
    const tid1 = A.tidOf(g);
    const kid1 = A.activeKid(g)[0];
    const mark = world.controlLog.length;
    assert.equal(await A.engine.removeMember(g, D.pk), 'applied');
    await world.settle();
    const kid2 = A.activeKid(g)[0];
    const tid2 = A.tidOf(g);
    assert.notEqual(kid2, kid1);
    assert.notEqual(tid2, tid1, 'a rekey gives a new topic');
    assert.equal(tid2, await tidFor(A, g));
    // 換金鑰通知：上一代、上一代的主題、A 切換之前；被踢的人靠它馬上知道
    const notes = [];
    for (const e of world.controlLog.slice(mark)) if (e.from === A.pk) notes.push({ e, m: await A.peekControl(e) });
    const removeNote = notes.find((x) => x.m?.t === 'commit');
    assert.ok(removeNote, 'the remove was announced');
    const rekeySeq = removeNote.m.body.head.seq;
    assert.deepEqual([removeNote.e.kid, removeNote.e.tid], [kid1, tid1], 'on the previous epoch\'s topic, under its key');
    assert.ok(removeNote.e.headSeq < rekeySeq, `before the author switched (author at seq ${removeNote.e.headSeq}, rekey at ${rekeySeq})`);
    assert.ok(!D.groups.has(g), 'the removed member learned of its removal at once');
    for (const p of [A, B, C]) {
      assert.deepEqual(p.topicsOf(g).map((t) => [t.tid, t.current]), [[tid2, true], [tid1, false]], `${p.label}: new topic + the previous one during the overlap`);
      assert.ok(p.subs.has(tid2) && p.subs.has(tid1), `${p.label} subscribed both`);
    }
    // 換金鑰之後大家都在發東西（here、刪除、通話）：只會在新的主題上
    const markAfter = world.controlLog.length;
    for (const p of [A, B, C]) p.engine.announce();
    for (const p of [B, C]) assert.equal(await p.engine.sendControl(g, 'delete', { messageId: `after-${p.label}` }), 'sent');
    assert.equal(await A.engine.sendControl(g, 'call', { action: 'start', video: false }), 'sent');
    await world.settle();
    const after = world.controlLog.slice(markAfter).filter((e) => e.gid === g);
    assert.ok(after.length >= 5, `traffic after the rekey (${after.length})`);
    assert.ok(after.every((e) => e.tid === tid2 && e.kid === kid2), 'everything after the switch is on the new topic, under the new key');
    // 不變式：上一代的每一則，送出時寄件人都還沒套上結束它的那筆
    assertNothingOnOldTopics(new Map([[kid1, rekeySeq]]), 'rekey');
    // 被踢的人
    assert.ok(!D.everSubscribed.has(tid2), 'the removed member never subscribed to the new topic');
    assert.ok(!D.received.some((r) => r.tid === tid2), 'and received nothing on it');
    assert.ok(!D.subs.has(tid1), 'its group is gone, so it dropped the old topic too');
    assert.deepEqual(D.engine.topics().filter((t) => t.gid === g), []);
    console.log(`PASS rekey: new topic, previous kept for the overlap; the rekey notice goes out on the old topic before the switch; ${after.length} messages after it all on the new topic; the removed member never saw the new topic`);

    // App 重開（主題表在記憶體）：還在重疊期內 → 上一代補回表上
    B.shutdown();
    await boot(B);
    await world.settle();
    assert.deepEqual(B.topicsOf(g).map((t) => [t.tid, t.current]), [[tid2, true], [tid1, false]], 'a restart during the overlap restores the previous topic');
    // 存著的上一代金鑰對不上鏈上的 kc（壞掉、被換掉）：重開時不拿它補主題（不訂一個亂推出來的 tid；審查 W3 INFO）
    const [{ key_base64: goodOld }] = C.sql('SELECT key_base64 FROM group_keys WHERE group_id = ? AND key_id = ?', [g, kid1]);
    C.shutdown();
    C.sql('UPDATE group_keys SET key_base64 = ? WHERE group_id = ? AND key_id = ?', [Buffer.alloc(32, 7).toString('base64'), g, kid1]);
    await boot(C);
    await world.settle();
    assert.deepEqual(C.topicsOf(g).map((t) => [t.tid, t.current]), [[tid2, true]], 'a stored previous key that fails its kc is not used to restore a topic');
    C.shutdown();
    C.sql('UPDATE group_keys SET key_base64 = ? WHERE group_id = ? AND key_id = ?', [goodOld, g, kid1]);
    await boot(C);
    await world.settle();
    assert.deepEqual(C.topicsOf(g).map((t) => [t.tid, t.current]), [[tid2, true], [tid1, false]], '(with the right key it is)');
    // 重疊期內：還沒換過來的人在上一代主題上的晚到訊息照收；到期之後就不在表上、也退訂了
    const late = await E.CTL.sealControl({ gid: g, kid: kid1, key: C.engine.decryptKey(g, kid1), sender: C.pk, sign: C.id.sign, t: 'delete',
      body: { messageId: 'late-on-old-topic' }, ts: world.now() });
    assert.equal(await B.engine.onControl(tid1, C.pk, late.envelope), 'ok', 'a late message on the previous topic during the overlap');
    assert.equal(await B.engine.onControl(tid1, D.pk, (await E.CTL.sealControl({ gid: g, kid: kid1, key: C.engine.decryptKey(g, kid1), sender: D.pk,
      sign: D.id.sign, t: 'delete', body: { messageId: 'removed' }, ts: world.now() })).envelope), 'non-member', 'the removed member on the old topic');
    // here／sync 從上一代的主題來（對方還沒換過來）：只拿來比對，不回 —— 回在新的主題上對方聽不到（審查 m2／m5）
    const oldKey = C.engine.decryptKey(g, kid1);
    const sealOld = (t, body) => E.CTL.sealControl({ gid: g, kid: kid1, key: oldKey, sender: C.pk, sign: C.id.sign, t, body, ts: world.now() });
    const heresBefore = stat(B, 'sent:here') + stat(B, 'held:here');
    assert.equal(await B.engine.onControl(tid1, C.pk, (await sealOld('sync', { have: { seq: 1, id: B.engine.gossip(g).id } })).envelope), 'ok');
    assert.equal(await B.engine.onControl(tid1, C.pk, (await sealOld('here', { head: { seq: 1, id: B.engine.gossip(g).id } })).envelope), 'ok');
    await world.settle();
    assert.equal(stat(B, 'sent:here') + stat(B, 'held:here'), heresBefore, 'no here reply to a sync or a behind here heard on the previous topic');
    // 拆到一半（AES-GCM 那一步）主題過期了：拆完不收（審查 m1）
    const subtle = globalThis.crypto.subtle;
    const realDecrypt = subtle.decrypt.bind(subtle);
    let openGate;
    const gate = new Promise((r) => { openGate = r; });
    let armedDecrypt = true;
    subtle.decrypt = async (...a) => { if (armedDecrypt) { armedDecrypt = false; await gate; } return realDecrypt(...a); };
    const lateRacing = B.engine.onControl(tid1, C.pk, (await sealOld('delete', { messageId: 'expired-while-opening' })).envelope);
    await sleep(OVERLAP + 400);
    await world.settle();
    openGate();
    assert.equal(await lateRacing, 'old-epoch', 'the topic expired while the message was being opened → dropped');
    subtle.decrypt = realDecrypt;
    for (const p of [A, B, C]) {
      assert.deepEqual(p.topicsOf(g).map((t) => t.tid), [tid2], `${p.label}: the previous topic expired`);
      assert.ok(!p.subs.has(tid1), `${p.label} unsubscribed it`);
      assert.deepEqual(p.topicList.filter((t) => t.gid === g).map((t) => t.tid), [tid2], `${p.label}: the app was told (token scope)`);
    }
    const late2 = await E.CTL.sealControl({ gid: g, kid: kid1, key: C.engine.decryptKey(g, kid1), sender: C.pk, sign: C.id.sign, t: 'delete',
      body: { messageId: 'too-late' }, ts: world.now() });
    assert.equal(await B.engine.onControl(tid1, C.pk, late2.envelope), 'unknown-topic', 'after the overlap the old topic means nothing');
    assert.deepEqual(B.controls.map((c) => c.body.messageId).filter((x) => /late|removed|expired/.test(x)), ['late-on-old-topic']);
    B.controls.length = 0;
    console.log('PASS overlap: restored after a restart, late messages accepted on the previous topic (here/sync not answered), expiry while opening drops it, then it expires, is unsubscribed and unmapped');
  }

  // ── 4b. 封的那段時間裡剛好換了一代：不送，改用新的一代重封 ──
  {
    const [E1, F1] = await Promise.all(['erin', 'fred'].map((l) => world.phone(l)));
    for (const p of [E1, F1]) { world.befriend(A, p); await boot(p); }
    const g3 = await A.engine.createGroup({ name: 'Race', members: [B.pk, E1.pk, F1.pk] });
    await world.settle();
    const kidOld = B.activeKid(g3)[0];
    const tidOld = B.tidOf(g3);
    // B 的同步卡住：A 踢掉 F，B 收到通知但還套不上
    let releaseFetch;
    const gate = new Promise((r) => { releaseFetch = r; });
    B.fetchHook = async (gid) => { if (gid === g3) await gate; };
    assert.equal(await A.engine.removeMember(g3, F1.pk), 'applied');
    await world.settle();
    assert.deepEqual(B.activeKid(g3), [kidOld], 'B has not applied the rekey yet');
    // B 封一則刪除：封到一半（AES-GCM 那一步）卡住；這時 B 套上換金鑰、切換到新的一代
    const subtle = globalThis.crypto.subtle;
    const realEncrypt = subtle.encrypt.bind(subtle);
    let releaseSeal;
    const sealGate = new Promise((r) => { releaseSeal = r; });
    let armed = true;
    subtle.encrypt = async (...a) => { if (armed) { armed = false; await sealGate; } return realEncrypt(...a); };
    const markRace = world.controlLog.length;
    const sending = B.engine.sendControl(g3, 'delete', { messageId: 'sealed-across-the-switch' });
    await sleep(30);
    B.fetchHook = null;
    releaseFetch();
    B.engine.requestSync(g3);
    await world.settle();
    const kidNew = B.activeKid(g3)[0];
    assert.notEqual(kidNew, kidOld, 'B switched while the seal was in flight');
    releaseSeal();
    assert.equal(await sending, 'held', 'the message sealed under the old epoch is not published');
    subtle.encrypt = realEncrypt;
    await world.settle();
    const out = world.controlLog.slice(markRace).filter((e) => e.from === B.pk && e.gid === g3);
    assert.ok(out.length >= 1 && out.every((e) => e.kid === kidNew && e.tid === B.tidOf(g3)), `re-sealed under the new epoch only (${out.map((e) => (e.kid === kidOld ? 'OLD' : 'new'))})`);
    assert.ok(!out.some((e) => e.tid === tidOld), 'nothing went to the old topic');
    assert.ok(A.controls.some((c) => c.gid === g3 && c.body.messageId === 'sealed-across-the-switch' && c.from === B.pk), 'the admin got it under the new epoch');
    assert.ok(!F1.received.some((r) => r.tid !== tidOld && r.from === B.pk), 'the removed member got nothing from B on a new topic');
    console.log('PASS a message sealed while the epoch switched is not published under the old epoch; it is re-sealed and sent on the new topic');
  }

  // ── 4c. mqtt 不收（不排隊，回 false）但 connected() 還說連著：留著、不馬上重試（不空轉），下一次連上再送 ──
  {
    const [M1] = await Promise.all(['mia'].map((l) => world.phone(l)));
    world.befriend(A, M1);
    let refuse = true;
    let attempts = 0;
    await M1.boot({ topicOverlapMs: OVERLAP, publish: (tid, envelope, opts) => {
      if (refuse) { attempts++; return false; }
      return world.publishControl(M1, tid, envelope, opts);
    } });
    const g5 = await A.engine.createGroup({ name: 'Refused', members: [M1.pk] });
    await world.settle();
    refuse = true;
    attempts = 0;
    assert.equal(await M1.engine.sendControl(g5, 'delete', { messageId: 'refused-once' }), 'held', 'not counted as sent');
    await sleep(300);
    await world.settle();
    assert.ok(attempts <= 2, `no busy retry loop while mqtt refuses (${attempts} attempts)`);
    refuse = false;
    M1.engine.flushControl();   // App：連上（onConnected）
    await world.settle();
    assert.ok(A.controls.some((c) => c.gid === g5 && c.body.messageId === 'refused-once'), 'sent on the next connect');
    console.log(`PASS mqtt refusing a publish: the message is held (not lost, not counted as sent), no retry loop (${attempts} attempt), sent on the next connect`);
  }

  // ── 4d. needsRekey 期間留著的刪除：admin 換金鑰之後，等大家訂到新主題（grace）才放 —— 不是只有寫換金鑰的人收得到（審查 M1）──
  {
    const GRACE = 1_500;
    const [H, I, J, K] = await Promise.all(['hana', 'ivan', 'jade', 'kai'].map((l) => world.phone(l)));
    for (const p of [I, J, K]) world.befriend(H, p);
    for (const p of [H, I, J, K]) { p.subscribeDelayMs = 300; await p.boot({ topicOverlapMs: OVERLAP, switchGraceMs: GRACE }); }
    const g6 = await H.engine.createGroup({ name: 'Grace', members: [I.pk, J.pk, K.pk] });
    await world.settle();
    H.shutdown();                                       // 唯一的 admin 不在：K 離開後沒人換金鑰
    assert.equal(await K.engine.leave(g6), 'applied');
    await world.settle();
    assert.equal(await I.engine.sendControl(g6, 'delete', { messageId: 'held-across-the-rekey' }), 'held', 'held while the leaver still holds the key');
    await H.boot({ topicOverlapMs: OVERLAP, switchGraceMs: GRACE });   // admin 回來 → 換金鑰
    await world.settle();
    await sleep(GRACE + 400);
    await world.settle();
    assert.notEqual(I.tidOf(g6), null);
    assert.equal(I.tidOf(g6), J.tidOf(g6), 'I and J are on the new topic');
    for (const p of [H, J]) {
      assert.ok(p.controls.some((c) => c.gid === g6 && c.body.messageId === 'held-across-the-rekey' && c.from === I.pk),
        `${p.label} received the delete held during needsRekey`);
    }
    console.log(`PASS a delete held during needsRekey is released after the switch grace (${GRACE} ms) and reaches every remaining member, not just the admin who rekeyed`);
  }

  // ── 4e. absorb 半路出錯（換金鑰套上了、存檔失敗、沒走到 project）：下一次同步把主題表補上（審查 L5）──
  {
    const [S1, S2] = await Promise.all(['sam', 'sue'].map((l) => world.phone(l)));
    for (const p of [S1, S2]) { world.befriend(A, p); await boot(p); }
    const g7 = await A.engine.createGroup({ name: 'Persist fails', members: [S1.pk, S2.pk] });
    await world.settle();
    const realPersist = S1.store.persistGroupLog;
    let failOnce = true;
    S1.store.persistGroupLog = async (...a) => { if (failOnce && a[0]?.meta) { failOnce = false; throw new Error('disk full'); } return realPersist.apply(S1.store, a); };
    assert.equal(await A.engine.removeMember(g7, S2.pk), 'applied');
    await world.settle();
    S1.store.persistGroupLog = realPersist;
    assert.equal(failOnce, false, 'the persist after the rekey failed once');
    S1.engine.requestSync(g7);                          // 下一次同步（輪詢、重連）
    await world.settle();
    assert.equal(S1.tidOf(g7), A.tidOf(g7), 'the topic table caught up with the chain');
    assert.ok(S1.subs.has(A.tidOf(g7)));
    console.log('PASS a rekey applied by an absorb that failed to persist still gets its topic at the next sync');
  }

  // ── 4f. 漏了換金鑰通知（那一筆沒人在我的主題上通知）：輪詢自己跟上、訂到新主題（不靠手動同步）──
  {
    const [T1, T2] = await Promise.all(['tom', 'tia'].map((l) => world.phone(l)));
    for (const p of [T1, T2]) world.befriend(A, p);
    await boot(T2);
    await T1.boot({ topicOverlapMs: OVERLAP, pollMs: 1_000 });
    const g8 = await A.engine.createGroup({ name: 'Poll', members: [T1.pk, T2.pk] });
    await world.settle();
    T1.subs.clear();                                    // 這段時間 T1 的群組主題沒收到東西（通知漏了）
    T1.topicList = [];
    assert.equal(await A.engine.removeMember(g8, T2.pk), 'applied');
    await world.settle();
    await sleep(2_500);
    await world.settle();
    assert.equal(T1.tidOf(g8), A.tidOf(g8), 'caught up through its own poll');
    assert.ok(T1.subs.has(A.tidOf(g8)), 'and subscribed the new topic');
    console.log('PASS a member that missed the rekey notice catches up at its own poll and subscribes the new topic');
  }

  // ── 4g. 這一代的金鑰不見了（還原時沒帶到）：沒有主題；金鑰一到（別人回的 dist，不是同步）馬上有主題、訂上 ──
  {
    const [K1, K2] = await Promise.all(['kim', 'ken'].map((l) => world.phone(l)));
    for (const p of [K1, K2]) { world.befriend(A, p); await boot(p); }
    const g9 = await A.engine.createGroup({ name: 'Key back', members: [K1.pk, K2.pk] });
    await world.settle();
    const tid9 = A.tidOf(g9);
    const cur = K1.activeKid(g9)[0];
    K1.shutdown();
    K1.db.run('DELETE FROM group_keys WHERE group_id = ? AND key_id = ?', [g9, cur]);
    K1.subs.clear();
    const held = [];
    await K1.boot({ topicOverlapMs: OVERLAP, sendSealed: async (to, body) => { held.push({ to, body }); } });   // 要金鑰的請求先攔著
    await world.settle();
    assert.ok(!K1.tidOf(g9) && !K1.subs.has(tid9), 'no current key → no topic');
    const req = held.find((r) => r.body.kind === 'req' && r.body.kid === cur);
    assert.ok(req, 'it asks for the key');
    for (const r of held) await world.deliverSealed(K1, r.to, r.body);
    await world.settle();
    assert.equal(K1.tidOf(g9), tid9, 'the key arrived → the topic is there at once (no sync needed)');
    assert.ok(K1.subs.has(tid9), 'and subscribed');
    console.log('PASS a member that lost its current key has no topic until the key comes back, then subscribes it at once');
  }

  // ── 6. 離線跨過兩次換金鑰 ──
  {
    const [P, Q, R] = await Promise.all(['pia', 'quinn', 'rob'].map((l) => world.phone(l)));
    for (const p of [P, Q, R]) { world.befriend(A, p); await boot(p); }
    const g4 = await A.engine.createGroup({ name: 'Offline', members: [C.pk, P.pk, Q.pk, R.pk] });
    await world.settle();
    const tidA = C.tidOf(g4);
    C.shutdown();                                       // C 離線（持久 session：舊主題的訂閱留著）
    assert.equal(await A.engine.removeMember(g4, P.pk), 'applied');
    await world.settle();
    const tidB = A.tidOf(g4);
    assert.equal(await A.engine.removeMember(g4, Q.pk), 'applied');
    await world.settle();
    const tidC = A.tidOf(g4);
    assert.equal(new Set([tidA, tidB, tidC]).size, 3, 'two rekeys, three topics');
    // broker 沒保留 C 的 session（不靠舊主題上排隊的通知）
    world.controlMailbox.delete(C.pk);
    C.subs.clear();
    await boot(C);
    await world.settle();
    assert.deepEqual(C.roster(g4), A.roster(g4), 'caught up through the log');
    assert.equal(C.tidOf(g4), tidC, 'derived the chain of epochs and subscribed the current topic');
    assert.ok(C.subs.has(tidC));
    assert.ok(!C.everSubscribed.has(tidB), 'the epoch it slept through was never subscribed');
    const mark = world.controlLog.length;
    assert.equal(await A.engine.sendControl(g4, 'delete', { messageId: 'after-coming-back' }), 'sent');
    await world.settle();
    assert.ok(C.controls.some((c) => c.gid === g4 && c.body.messageId === 'after-coming-back'), 'and receives on it');
    assert.ok(world.controlLog.slice(mark).every((e) => e.gid !== g4 || e.tid === tidC));
    console.log('PASS offline across two rekeys: back through the log, straight onto the current topic (the middle one never subscribed), no reliance on old topics');
  }

  // ── 7. App 接線 ──
  {
    const provider = readFileSync(`${SRC}/providers/AppProvider.tsx`, 'utf8');
    assert.match(provider, /publish: \(tid, envelope, \{ qos \}\) => mqttService\.sendToGroup\(tid, MessageType\.GROUP_SEALED, envelope, \{ qos \}\)/, 'the engine publishes on the topic id it sealed for');
    assert.match(provider, /topicReady: \(tid\) => mqttService\.isGroupSubscribed\(tid\)/);
    assert.match(provider, /onTopics: \(topics\) => setGroupTopics\(topics\)/, 'the engine\'s topic table drives the token scope');
    assert.match(provider, /onControl\(src\.tid, src\.from, src\.envelope\)/, 'received topic ids go to the engine (it maps them)');
    assert.match(provider, /mqttService\.onGroupSubscribed\(\(tid\) => \{ getGroupEngine\(\)\?\.onTopicReady\(tid\); \}\)/);
    const route = readFileSync(`${SRC}/services/groupControlRoute.ts`, 'utf8');
    const source = route.slice(route.indexOf('export function groupControlSource'), route.indexOf('export interface ControlHandlers'));
    assert.ok(source.length > 100 && !/validGid|gid[:,]/.test(source), 'the route never produces a gid');
    // 純函式：重疊期 10 分鐘、上一代最多兩個、金鑰不見了就沒有目前的主題
    assert.equal(E.GT.TOPIC_OVERLAP_MS, 10 * 60_000);
    const t = (tid, kid, until) => ({ tid, kid, until });
    let tab = E.GT.nextTopics([], 'k1', { tid: 'T1', kid: 'k1' }, 0);
    tab = E.GT.nextTopics(tab, 'k2', { tid: 'T2', kid: 'k2' }, 100);
    assert.deepEqual(tab, [t('T2', 'k2', null), t('T1', 'k1', 100 + E.GT.TOPIC_OVERLAP_MS)]);
    tab = E.GT.nextTopics(tab, 'k3', { tid: 'T3', kid: 'k3' }, 200);
    tab = E.GT.nextTopics(tab, 'k4', { tid: 'T4', kid: 'k4' }, 300);
    assert.deepEqual(tab.map((x) => x.tid), ['T4', 'T3', 'T2'], `at most ${E.GT.MAX_PREVIOUS_TOPICS} previous topics, newest first`);
    assert.deepEqual(E.GT.nextTopics(tab, 'k4', null, 400).map((x) => x.tid), ['T3', 'T2'], 'current key gone → no current topic');
    assert.deepEqual(E.GT.nextTopics(tab, 'k4', { tid: 'T4', kid: 'k4' }, 10 * 60_000 + 301).map((x) => x.tid), ['T4'], 'expired previous topics dropped');
    assert.equal(E.GT.previousUntil(1_000, 2_000, 5_000), 6_000);
    assert.equal(E.GT.previousUntil(9_999_999, 2_000, 5_000), 7_000, 'a commit ts in the future cannot stretch the overlap');
    assert.equal(E.GT.previousUntil(1_000, 7_000, 5_000), null, 'past the overlap');
    console.log('PASS app wiring: engine topic table → token scope; topic ids mapped by the engine; pure table rules (overlap, cap, expiry)');
  }
} finally {
  console.error = quiet;
  world.close();
}
await new Promise((r) => setTimeout(r, 10));
process.exit(0);

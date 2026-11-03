/**
 * 群組 log 模型對抗式審查（2026-10-22）的每個 PoC → 回歸測試：在 8aab9d9 上失敗、修好之後通過。真的 services/*.ts，Ed25519 用 Node crypto。
 *   poc1 H1  一般成員（addPolicy members）加兩個「不在曲線上」的公鑰 → 之後踢人、換金鑰全部丟例外，群組永遠卡住
 *            修正：進名冊的公鑰要在曲線上、在質數階子群（鏈規則）；封裝新金鑰時封不了的收件人只跳過並回報
 *   poc2 M1  被踢的 X 在自己最後的 head 簽 add(N)、用舊金鑰 append、邀請 N → verifyInvite 收、N 以為自己是成員，
 *            名冊有 X、金鑰是 X 手上那把，真的 log 對 N 全是「別一代」，N 永遠不會發現
 *            修正：confirmInvite 從那一代開始的地方套 log，我那筆一定要在正典套用裡、剛好在 headSeq
 *   poc3 M3  (a) 目前 kid 下存了錯的金鑰 → 整代的 entry 被當成解不開跳過，修好金鑰、整個重抓也回不來；
 *            (b) 伺服器少給某一號 → 下一筆被當成過時跳過，重抓也回不來
 *            修正：呼叫端給的金鑰一律核對 kc（錯的 → 停下來等）；seq 一定要連號（缺號 → 停下來回報 gap）；rebuildLog 從基準點重來
 *   poc4 M4  有人離開後（needsRekey）info／add 照樣上鏈（舊金鑰下，離開的人讀得到）；成員「加分身→分身離開」不停循環把鏈撐爆
 *            修正：needsRekey 期間只收 admin 的 rekey／remove 與 leave
 *   poc5 M2  成員用 R = 恆等點（或 R 混了 8 階點）簽 commit：寬鬆／嚴格／cofactored 驗章器答案不同 → 成員得到不同的鏈
 *            修正：toVerifiedCommit 自己檢查 S < L、R 正規且在質數階子群，不靠注入的驗章器
 *   poc7 L1  營運方＋被踢的人把 admin 簽的 remove 換上別的封裝包、排在前面 → 大家套用但拿不到新金鑰（keyMissing）；
 *            不能退回用舊金鑰（被踢的人有）。修正：currentEpochKey 只給目前這一代、kc 對得上的金鑰
 *   poc6 H2／M5／L3（伺服器）在 group_log_api_self_test.py：bytes 上限、帳號簽章與額度、輪詢擠不掉、計數擠不掉、沒有每群上限、after 上限
 * 只跑一個：node scripts/review/group_log_review_regressions_self_test.mjs poc1
 * 拿舊版跑（應該失敗）：AEGISTALK_PWA_SRC=<8aab9d9 的 packages/pwa/src> node ...
 */
import assert from 'node:assert/strict';
import { load, identity, verify, x25519, ed, logKit, seedOf } from './groupStateKit.mjs';

const G = await load('groupState');
const L = await load('groupLog');
const S = await load('identitySeal');
const K = logKit(G, L, S);

const cases = {
  // ── H1：不在曲線上的成員公鑰 ──
  async poc1() {
    const A = identity('rg1-admin'), M = identity('rg1-mallory'), B = identity('rg1-bob');
    const { log, owner: a } = await K.newGroup(A);              // 一般群組 → addPolicy 'members'
    const m = await K.invite(a, log, M), b = await K.invite(a, log, B);
    for (const cl of [a, m, b]) await K.pull(cl, log);
    const bogus = [ed.offCurveKey('rg1-1'), ed.offCurveKey('rg1-2')];
    const mixed = ed.mixedOrderKey(identity('rg1-honest').pk);
    for (const pk of [...bogus, mixed]) assert.equal(G.validPubkey(pk), false, `${pk.slice(0, 8)}… is not a usable member key`);
    // Mallory 繞過作者端檢查，自己簽、自己 append
    const before = a.rep.view.state.head.id;
    for (const pk of [...bogus, mixed]) {
      await K.appendRaw(log, m.rep.view.state, m.keys.get(m.rep.view.state.epoch.kid), K.forge(m.rep.view.state, M, 'add', { pk }));
    }
    for (const cl of [a, m, b]) {
      const res = await K.pull(cl, log);
      assert.deepEqual(res.skipped.map((x) => x.reason), ['bad-pubkey', 'bad-pubkey', 'bad-pubkey'], `${cl.id.label}: off-curve / mixed-order adds skipped`);
      assert.equal(cl.rep.view.state.head.id, before);
    }
    assert.equal(a.rep.view.state.members.length, 3);
    // 群組還動得了：踢掉 Mallory、換金鑰
    await K.submit(a, log, 'remove', { pk: M.pk });
    await K.submit(b, log, 'leave', {});
    for (const cl of [a, b]) await K.pull(cl, log);
    await K.submit(a, log, 'rekey', {});
    await K.pull(a, log);
    assert.equal(a.rep.view.state.needsRekey, false, 'removal and rotation still work');
    // 封裝包：封不了的那一位只跳過並回報，其他人照樣拿到
    const key = new Uint8Array(32).fill(3);
    const sealed = await L.sealKeyBundle({ gid: a.rep.view.gid, kid: 'rg1-kid', key, recipients: [A.pk, bogus[0], B.pk] }, x25519);
    assert.deepEqual(sealed.skipped, [bogus[0]], 'the bad recipient is reported');
    assert.deepEqual(Object.keys(sealed.bundle.to).sort(), [A.pk, B.pk].sort());
    for (const who of [A, B]) {
      const opened = await L.openKeyBundle({ bundle: sealed.bundle, gid: a.rep.view.gid, kid: 'rg1-kid', me: who.pk, myX25519Private: await S.edSeedToX25519Scalar(seedOf(who.label)) }, x25519);
      assert.deepEqual([...opened], [...key], `${who.label} still gets the key`);
    }
    await assert.rejects(L.sealKeyBundle({ gid: a.rep.view.gid, kid: 'rg1-kid', key, recipients: [bogus[0], bogus[1]] }, x25519), /no-recipient/);
    return 'off-curve and mixed-order member keys are rejected by the chain; a bad recipient is skipped and reported, not fatal to the bundle';
  },

  // ── M1：假邀請（被踢的人在舊 head 上做的） ──
  async poc2() {
    const A = identity('rg2-admin'), B = identity('rg2-bob'), X = identity('rg2-removed'), N = identity('rg2-newbie');
    const { log, owner: a } = await K.newGroup(A);
    const b = await K.invite(a, log, B), x = await K.invite(a, log, X);
    for (const cl of [a, b, x]) await K.pull(cl, log);
    const stale = x.rep;                                             // X 還是成員時最後看到的樣子
    const kH = { kid: stale.view.state.epoch.kid, key: x.keys.get(stale.view.state.epoch.kid) };
    await K.submit(a, log, 'remove', { pk: X.pk });
    await K.pull(a, log);
    await K.submit(a, log, 'info', { name: 'after X was removed' });
    for (const cl of [a, b, x]) await K.pull(cl, log);
    assert.equal(x.rep.status, 'removed');
    // X 在舊 head 上加 N、用舊金鑰 append、做邀請
    const addN = G.signCommit(G.proposeCommit(stale.view.state, X.pk, 'add', { pk: N.pk }, 99), X.sign, X.pk);
    const seq = log.append(await L.sealLogEntry({ gid: stale.view.gid, kid: kH.kid, key: kH.key, commit: addN }));
    const chain = [...stale.view.chain.map(K.wire), addN];
    const baseSeq = stale.firstSeq;                                 // 那一代（genesis）開始的地方
    assert.ok((await G.verifyInvite({ chain, gid: stale.view.gid, me: N.pk, key: kH, verify })).ok, 'the chain and key alone look fine');
    const res = await K.accept(N, { chain, gid: stale.view.gid, key: kH, headSeq: seq, baseSeq }, log);
    assert.equal(res.ok, false, 'N must not join through a removed member\'s stale branch');
    assert.equal(res.reason, 'add-not-in-log');
    // 兩步：X 先在舊 head 加同夥 Y、再加 N → 正典套用在 N 那筆的版本之前就換了金鑰（踢 X）→ 直接拒收，不會卡在等金鑰
    const Y = identity('rg2-accomplice');
    const addY = G.signCommit(G.proposeCommit(stale.view.state, X.pk, 'add', { pk: Y.pk }, 98), X.sign, X.pk);
    const withY = (await G.appendCommit(stale.view, addY, verify)).view;
    const addN2 = G.signCommit(G.proposeCommit(withY.state, X.pk, 'add', { pk: N.pk }, 99), X.sign, X.pk);
    log.append(await L.sealLogEntry({ gid: stale.view.gid, kid: kH.kid, key: kH.key, commit: addY }));
    const seq2 = log.append(await L.sealLogEntry({ gid: stale.view.gid, kid: kH.kid, key: kH.key, commit: addN2 }));
    const res2 = await K.accept(N, { chain: [...withY.chain.map(K.wire), addN2], gid: stale.view.gid, key: kH, headSeq: seq2, baseSeq }, log);
    assert.deepEqual([res2.ok, res2.reason, res2.retry], [false, 'add-not-in-log', false], 'two-step stale branch: rejected, not left waiting for a key');
    // 誠實的邀請照樣收
    const n = await K.invite(a, log, N);
    await K.pull(n, log);
    assert.equal(n.rep.view.state.head.id, a.rep.view.state.head.id);
    assert.ok(!G.memberOf(n.rep.view.state, X.pk), 'the real roster');
    return 'an invite on a removed member\'s stale branch is rejected against the server log (add-not-in-log); honest invites still work';
  },

  // ── M3：存錯的金鑰、缺號 ──
  async poc3() {
    const A = identity('rg3-admin'), B = identity('rg3-bob'), C = identity('rg3-carol');
    const canon = (st) => JSON.stringify(st);
    {
      const { log, owner: a } = await K.newGroup(A);
      const b = await K.invite(a, log, B);
      for (const cl of [a, b]) await K.pull(cl, log);
      const kid = a.rep.view.state.epoch.kid;
      const right = b.keys.get(kid);
      b.keys.set(kid, new Uint8Array(32).fill(0x5a));                 // 目前 kid 下存了錯的金鑰
      const beforeSeq = b.rep.processedSeq;
      await K.submit(a, log, 'info', { name: 'renamed' });
      await K.submit(a, log, 'add', { pk: C.pk });
      await K.pull(a, log);
      const r1 = await K.pull(b, log);
      assert.deepEqual(r1.skipped, [], '(a) nothing is skipped as undecryptable');
      assert.deepEqual(r1.waiting, { kid, seq: beforeSeq + 1, reason: 'key-mismatch' }, '(a) B waits and says its key does not match kc');
      assert.equal(b.rep.processedSeq, beforeSeq, '(a) and does not move past the entry');
      assert.equal((await L.currentEpochKey(b.rep, (k) => b.keys.get(k))).reason, 'key-mismatch', '(a) B does not send with the wrong key either');
      b.keys.set(kid, right);                                          // 金鑰修好
      await K.pull(b, log);
      assert.equal(canon(b.rep.view.state), canon(a.rep.view.state), '(a) after the fix B continues from there and equals A');
    }
    {
      const { log, owner: a } = await K.newGroup(A);
      const b = await K.invite(a, log, B);
      for (const cl of [a, b]) await K.pull(cl, log);
      const s1 = (await K.submit(a, log, 'info', { name: 'one' })).seq;
      await K.pull(a, log);
      await K.submit(a, log, 'info', { name: 'two' });
      await K.pull(a, log);
      const r = await K.pull(b, log, log.after(b.rep.processedSeq).filter((e) => e.seq !== s1));   // 伺服器少給一號
      assert.deepEqual(r.gap, { from: s1, to: s1 }, '(b) the missing seq is reported');
      assert.deepEqual(r.skipped, [], '(b) the next commit is not marked stale');
      assert.equal(b.rep.processedSeq, s1 - 1);
      await K.pull(b, log);                                            // 重抓
      assert.equal(canon(b.rep.view.state), canon(a.rep.view.state), '(b) after re-fetching B equals A');
      // 已經照錯的 log 套過了：rebuildLog 從基準點重來
      const c = await K.invite(a, log, C);
      const forked = log.entries.map((e) => ({ ...e }));
      const s3 = (await K.submit(a, log, 'info', { name: 'three' })).seq;
      await K.submit(a, log, 'info', { name: 'four' });
      await K.pull(a, log);
      const lied = [...forked, { seq: s3, blob: log.entries[s3].blob }];   // 給 C 看的：s3 換成 "four"（之後就是 stale）
      await K.pull(c, log, lied.filter((e) => e.seq > c.rep.processedSeq));
      assert.notEqual(c.rep.view.state.info.name, a.rep.view.state.info.name, 'C was shown another log');
      assert.equal(L.compareGossip(c.rep, L.headGossip(a.rep)), 'conflict', 'head gossip detects it');
      const res = await L.rebuildLog(c.rep, log.after(c.rep.firstSeq), K.deps(c));
      c.rep = res.replica;
      assert.equal(canon(c.rep.view.state), canon(a.rep.view.state), 'rebuild from the base with the honest log → C equals A');
      assert.equal(L.compareGossip(c.rep, L.headGossip(a.rep)), 'same');
    }
    return 'a wrong key under the current kid makes the member wait (key-mismatch) instead of skipping; a missing seq stops processing (gap); rebuild recovers';
  },

  // ── M4：needsRekey 期間的內容、分身循環 ──
  async poc4() {
    const A = identity('rg4-admin'), B = identity('rg4-bob'), LV = identity('rg4-leaver'), N = identity('rg4-new'), M = identity('rg4-mallory');
    {
      const { log, owner: a } = await K.newGroup(A);
      const b = await K.invite(a, log, B), lv = await K.invite(a, log, LV);
      for (const cl of [a, b, lv]) await K.pull(cl, log);
      await K.submit(lv, log, 'leave', {});
      for (const cl of [a, b]) await K.pull(cl, log);
      assert.equal(a.rep.view.state.needsRekey, true);
      const headAtLeave = a.rep.view.state.head.id;
      // 誠實的客戶端寫不出來（作者端檢查）；硬塞進 log 的，每台都跳過
      await assert.rejects(K.build(a, 'info', { name: 'secret plans' }), /needs-rekey/, 'an honest admin cannot write content under the old key');
      await assert.rejects(K.build(b, 'add', { pk: N.pk }), /needs-rekey/);
      const st = a.rep.view.state, key = a.keys.get(st.epoch.kid);
      await K.appendRaw(log, st, key, K.forge(st, A, 'info', { name: 'secret plans' }));
      await K.appendRaw(log, st, key, K.forge(st, B, 'add', { pk: N.pk }));
      for (const cl of [a, b]) {
        const res = await K.pull(cl, log);
        assert.deepEqual(res.skipped.map((x) => x.reason), ['needs-rekey', 'needs-rekey'], `${cl.id.label}: nothing new under the old key`);
        assert.equal(cl.rep.view.state.head.id, headAtLeave);
      }
      await K.submit(a, log, 'rekey', {});
      await K.pull(a, log);
      await K.submit(a, log, 'info', { name: 'after the rekey' });
      await K.pull(a, log);
      assert.equal(a.rep.view.state.info.name, 'after the rekey', 'normal again once an admin rotated');
    }
    {
      const { log, owner: a } = await K.newGroup(A);
      const m = await K.invite(a, log, M);
      for (const cl of [a, m]) await K.pull(cl, log);
      const before = a.rep.view.chain.length;
      let cycles = 0;
      for (let i = 0; i < 50; i++) {
        const sock = identity(`rg4-sock-${i}`);
        const st = m.rep.view.state, key = m.keys.get(st.epoch.kid);
        await K.appendRaw(log, st, key, K.forge(st, M, 'add', { pk: sock.pk }));
        await K.pull(m, log);
        if (!G.memberOf(m.rep.view.state, sock.pk)) continue;
        cycles++;
        const st2 = m.rep.view.state;
        await K.appendRaw(log, st2, key, K.forge(st2, sock, 'leave', {}));
        await K.pull(m, log);
      }
      await K.pull(a, log);
      assert.equal(cycles, 1, 'one sockpuppet cycle, then adds wait for an admin rekey');
      assert.equal(a.rep.view.chain.length, before + 2, 'the chain cannot grow without admin rekeys');
      assert.equal(a.rep.view.state.needsRekey, true);
    }
    return 'while a rekey is pending only admin rekey/remove and leave are applied; the sockpuppet churn stops after one cycle';
  },

  // ── M2：驗章器分歧 ──
  async poc5() {
    const A = identity('rg5-admin'), B = identity('rg5-bob'), C = identity('rg5-carol'), D = identity('rg5-dave'), N = identity('rg5-new');
    const SMALL = new Set(['0000000000000000000000000000000000000000000000000000000000000000', '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a']);
    /** dalek verify_strict 會多擋的：R 是小階點 */
    const strict = (pub, data, sig) => { const r = Buffer.from(sig.subarray(0, 32)); r[31] &= 0x7f; return !SMALL.has(r.toString('hex')) && verify(pub, data, sig); };
    // 寬鬆的驗章器用純 JS 的 RFC 8032（不檢查 R）：OpenSSL 3.5 起 Node 的 verify 也擋小階 R（Node 24.22／26 實測）
    const lenient = ed.verifyLenient;
    const { log, owner: a } = await K.newGroup(A);
    const b = await K.invite(a, log, B), c = await K.invite(a, log, C), d = await K.invite(a, log, D);
    for (const cl of [a, b, c, d]) await K.pull(cl, log);
    b.verify = lenient;                // B 跑寬鬆的版本（舊 OpenSSL／libsodium 不檢查 R 的那種）
    c.verify = strict;                 // C 跑 verify_strict 的版本
    d.verify = ed.verifyCofactored;    // D 跑 ZIP-215 cofactored 的版本
    const st = b.rep.view.state;
    const forged = (args, opts) => {
      const commit = G.proposeCommit(st, B.pk, 'add', args, 7);
      const sig = ed.signCustom(B.label, B.pub, new TextEncoder().encode(G.GSTATE_DOMAIN + G.commitBody(commit)), opts);
      return { c: commit, s: Buffer.from(sig).toString('base64') };
    };
    const rIdentity = forged({ pk: N.pk }, { r: 0n, rBytes: ed.IDENTITY_ENC });
    const rMixed = forged({ pk: identity('rg5-other').pk }, { rPoint: (r) => ed.add(ed.mul(ed.B, r), ed.T8) });
    const msgOf = (x) => new TextEncoder().encode(G.GSTATE_DOMAIN + G.commitBody(x.c));
    assert.deepEqual([lenient, strict].map((v) => v(B.pub, msgOf(rIdentity), Buffer.from(rIdentity.s, 'base64'))), [true, false], 'the verifiers really disagree on R = identity');
    for (const x of [rIdentity, rMixed]) await K.appendRaw(log, st, b.keys.get(st.epoch.kid), x);
    await K.submit(a, log, 'info', { name: 'next' });
    const results = [];
    for (const cl of [a, b, c, d]) results.push(await K.pull(cl, log));
    for (const [i, cl] of [a, b, c, d].entries()) {
      assert.ok(!G.memberOf(cl.rep.view.state, N.pk), `${cl.id.label}: the oddly signed add is not applied`);
      assert.deepEqual(results[i].skipped.map((x) => x.reason), ['non-strict-signature', 'non-strict-signature'], `${cl.id.label}: same skip reasons whatever its verifier`);
      assert.equal(cl.rep.view.state.head.id, a.rep.view.state.head.id, `${cl.id.label}: same head as A`);
      assert.equal(L.compareGossip(cl.rep, L.headGossip(a.rep)), 'same');
    }
    return 'R = identity / mixed-order R signatures are skipped identically by lenient, verify_strict-style and cofactored verifiers; one chain';
  },

  // ── L1：封裝包被換掉 → 等金鑰，不退回舊金鑰 ──
  async poc7() {
    const A = identity('rg7-admin'), B = identity('rg7-bob'), C = identity('rg7-carol'), X = identity('rg7-removed');
    const { log, owner: a } = await K.newGroup(A);
    const b = await K.invite(a, log, B), c = await K.invite(a, log, C), x = await K.invite(a, log, X);
    for (const cl of [a, b, c, x]) await K.pull(cl, log);
    const k1 = { kid: x.rep.view.state.epoch.kid, key: x.keys.get(x.rep.view.state.epoch.kid) };
    const honest = await K.build(a, 'remove', { pk: X.pk });
    a.keys.set(honest.newEpoch.kid, honest.newEpoch.key);
    // 營運方先把 entry 給 X；X 用 K1 打開、換上自己的封裝包，營運方把這份排在前面
    const opened = await L.openLogEntry({ blob: honest.blob, gid: x.rep.view.gid, key: k1.key });
    const junk = await L.sealKeyBundle({ gid: x.rep.view.gid, kid: honest.newEpoch.kid, key: new Uint8Array(32).fill(1), recipients: [X.pk] }, x25519);
    log.append(await L.sealLogEntry({ gid: x.rep.view.gid, kid: k1.kid, key: k1.key, commit: opened.commit, bundle: junk.bundle ?? junk }));
    log.append(honest.blob);
    const ra = await K.pull(a, log);
    assert.deepEqual(ra.keyMissing.map((k) => k.kid), [honest.newEpoch.kid], 'even the author does not use a bundle it did not sign');
    await K.submit(a, log, 'info', { name: 'after the removal' });
    for (const cl of [b, c]) {
      const r = await K.pull(cl, log);
      assert.ok(!G.memberOf(cl.rep.view.state, X.pk), `${cl.id.label}: the remove is applied`);
      assert.deepEqual(r.keyMissing.map((k) => k.kid), [honest.newEpoch.kid], `${cl.id.label}: key missing for the new epoch`);
      assert.equal(r.waiting?.kid, honest.newEpoch.kid, `${cl.id.label}: waits at the next entry of the new epoch`);
      const send = await L.currentEpochKey(cl.rep, (kid) => cl.keys.get(kid));
      assert.deepEqual([send.ok, send.kid, send.reason], [false, honest.newEpoch.kid, 'no-key'], `${cl.id.label}: no key to send with`);
      assert.ok(cl.keys.has(k1.kid), 'even though the old epoch key is still at hand');
      cl.keys.set(honest.newEpoch.kid, new Uint8Array(32).fill(2));
      assert.equal((await L.currentEpochKey(cl.rep, (kid) => cl.keys.get(kid))).reason, 'key-mismatch', 'a wrong key for the new epoch is refused too');
      cl.keys.set(honest.newEpoch.kid, honest.newEpoch.key);           // sealed req 向 admin 要到
      const ok = await L.currentEpochKey(cl.rep, (kid) => cl.keys.get(kid));
      assert.deepEqual([ok.ok, ok.kid], [true, honest.newEpoch.kid]);
      await K.pull(cl, log);
      assert.equal(cl.rep.view.state.info.name, 'after the removal', 'and processing resumes');
    }
    return 'after a stripped key bundle every member waits for the new key; currentEpochKey never falls back to the old epoch key';
  },
};

const only = process.argv.slice(2);
let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  try {
    console.log(`PASS ${name}: ${await run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}
if (failed) process.exit(1);

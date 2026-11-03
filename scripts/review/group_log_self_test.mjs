/**
 * 群組 log 模型（決定 2026-10-22）：真的 services/groupLog.ts ＋ groupState.ts，伺服器 log 用一個陣列模擬；另用 Node crypto 照規格獨立核對。
 *   1. 規格：blob ＝ {k, n, c}，K_log ＝ HKDF(K, "aegistalk-glog-v1|gid")、AAD ＝ "aegistalk-glog-v1|gid|kid"；
 *      換金鑰的 commit 帶封裝包：每位留下的成員各一份，kb ＝ SHA-256(正規 JSON(包))，金鑰對得上 kc；被踢的人沒有那一份
 *   2. 一般流程：建群、加人、邀請（verifyInvite ＋ startLog）、同時送出 → 先到的上、另一筆 stale 回報給作者、rebase 後重送
 *   3. 跳過：格式壞的、別一代的 kid（不解密）、解不開的、簽章不對、外人簽的、重複、過時 → 每台一樣
 *   4. 踢人：留下的成員從同一筆拿到新金鑰；被踢的人停下、拿不到新金鑰、讀不到之後的 entry、他再送的都被跳過
 *   5. 離線很久的人一次補完好幾次換金鑰（金鑰都在 log 裡，沒有 7 天期限）
 *   6. 少給一份／金鑰對不上 kc／包被換掉 → 照樣套用、回報 keyMissing、停在下一筆等金鑰；拿到金鑰後從那裡繼續，跟大家一樣
 *   7. head 交叉比對：同一條 log → same／they-are-behind／i-am-behind；伺服器給兩個人不同的 log → conflict
 *   8. 被踢的人、被降級的前 admin 在舊位置簽的 → 永遠過時；成員送換金鑰的 commit → 被跳過，群組照常（卡不住）
 *  10. 連號（缺號 → 停下回報 gap）、呼叫端給的金鑰核對 kc（錯的 → 等）、conflict 後用誠實的 log 從基準點重建（審查 M3）
 *  11. 邀請對照 log（審查 M1）：舊位置的邀請、seq 不對／太大／沒抓完／缺號、baseSeq 不對 → 拒收並回報；初始成員；重建再對照
 *  12. 加回舊成員：附上一代的只讀 log 金鑰對照 log；附錯／沒附／舊分支 → 拒收；那把金鑰解不開控制訊息、聊天、新一代，也不能拿來送
 *   9. 性質測試：隨機的人、隨機時間同步、同時送出、垃圾、踢人／加人／換金鑰、離線、伺服器分岔（給某人看另一個順序的 log 一段時間）
 *      → 分岔真的發生、在同一個位置交換 (seq, head) 一定發現；真的 log 回來後重建；每個還在群裡的人得到同一個狀態，
 *      而且等於照規格獨立實作的套用結果；交叉比對全是 same
 * Run: node scripts/review/group_log_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { load, identity, verify, chainKit, x25519, seedOf, rng, shuffle } from './groupStateKit.mjs';

const G = await load('groupState');
const L = await load('groupLog');
const S = await load('identitySeal');
const wire = (vc) => ({ c: vc.c, s: vc.s });
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** 新一代的金鑰（kid 由位置與作者決定，buildCommitEntry 回傳在 built.newEpoch.kid） */
const fresh = () => ({ key: new Uint8Array(crypto.randomBytes(32)) });

// ── 照規格的獨立實作（Node crypto） ──
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), 32));
function specOpenEntry(blob, gid, key) {
  const o = JSON.parse(blob);
  const raw = Buffer.from(o.c, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', hkdf(key, Buffer.alloc(0), `aegistalk-glog-v1|${gid}`), Buffer.from(o.n, 'base64'));
  d.setAAD(Buffer.from(`aegistalk-glog-v1|${gid}|${o.k}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString());
}
async function specOpenCopy(bundle, gid, kid, who) {
  const scalar = await S.edSeedToX25519Scalar(seedOf(who.label));
  const ek = Buffer.from(bundle.ek, 'base64');
  const myX = Buffer.from(S.edPublicToX25519(who.pub));
  const shared = x25519.x25519(scalar, ek);
  const raw = Buffer.from(bundle.to[who.pk], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', hkdf(shared, Buffer.concat([ek, myX]), 'AegisTalk-GroupKeyBundle-v1'), raw.subarray(0, 12));
  d.setAAD(Buffer.from(`aegistalk-gkb-v1|${gid}|${kid}|${who.pk}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
}

/** 照規格自己封一個包：同一把臨時金鑰，每個人可以給不同的金鑰（做「解得開但金鑰不對」的那份） */
async function specSealBundle(gid, kid, keyFor) {
  const eph = x25519.generateX25519();
  const to = {};
  for (const [who, key] of keyFor) {
    const x = Buffer.from(S.edPublicToX25519(who.pub));
    const shared = x25519.x25519(eph.privateKey, x);
    const n = crypto.randomBytes(12);
    const e = crypto.createCipheriv('aes-256-gcm', hkdf(shared, Buffer.concat([Buffer.from(eph.publicKey), x]), 'AegisTalk-GroupKeyBundle-v1'), n);
    e.setAAD(Buffer.from(`aegistalk-gkb-v1|${gid}|${kid}|${who.pk}`));
    to[who.pk] = Buffer.concat([n, e.update(Buffer.from(key)), e.final(), e.getAuthTag()]).toString('base64');
  }
  return { ek: Buffer.from(eph.publicKey).toString('base64'), to };
}

// ── 模擬伺服器與客戶端 ──
function newLog() {
  const entries = [];
  return { entries, append: (blob) => { entries.push({ seq: entries.length + 1, blob }); return entries.length; }, after: (seq) => entries.filter((e) => e.seq > seq) };
}
async function clientOf(id, rep, keys) {
  return { id, rep, keys: new Map(keys), xpriv: await S.edSeedToX25519Scalar(seedOf(id.label)), calls: [] };
}
const client = (id, view, headSeq, keys) => clientOf(id, L.startLog({ view, me: id.pk, headSeq }), keys);
const deps = (cl) => ({ verify, keyFor: (kid) => { cl.calls.push(kid); return cl.keys.get(kid) ?? null; }, myX25519Private: cl.xpriv, x25519 });
const skipCount = new Map();
async function pull(cl, log, upTo = Infinity) {
  const res = await L.applyLog(cl.rep, log.after(cl.rep.processedSeq).filter((e) => e.seq <= upTo), deps(cl));
  for (const x of res.skipped) skipCount.set(x.reason, (skipCount.get(x.reason) ?? 0) + 1);
  for (const nk of res.newKeys) cl.keys.set(nk.kid, nk.key);
  cl.rep = res.replica;
  return res;
}
async function submit(cl, log, op, args, opts = {}) {
  const built = await L.buildCommitEntry({ view: cl.rep.view, actor: cl.id.pk, sign: cl.id.sign, op, args, ts: opts.ts ?? 5, epochKey: cl.keys.get(cl.rep.view.state.epoch.kid), newEpoch: opts.newEpoch }, x25519);
  if (built.newEpoch) cl.keys.set(built.newEpoch.kid, built.newEpoch.key);   // 送出前先存好
  return { seq: log.append(built.blob), built };
}
async function newGroup(creator, opts = {}) {
  const k = chainKit(G);
  const g = await k.genesis(creator, opts);
  const log = newLog();
  const seq = log.append(await L.sealGenesisEntry({ gid: g.gid, genesis: wire(g.commit), kid: g.kid, key: g.key }));
  return { k, g, log, owner: await client(creator, await k.start(g), seq, [[g.kid, g.key]]) };
}
/**
 * 新成員收邀請（鏈＋headSeq＋baseSeq＋加入那時的金鑰）：verifyInvite，再對照 log 確認（confirmInvite，審查 M1；只給到 headSeq 為止）。
 * 回傳 { ok, client } 或 { ok: false, reason }
 */
async function join(who, params, gid, key, log) {
  const res = await G.verifyInvite({ chain: params.chain, gid, me: who.pk, key, verify });
  if (!res.ok) return res;
  const cl = await clientOf(who, null, [[key.kid, key.key]]);
  const conf = await L.confirmInvite({ view: res.view, me: who.pk, key, headSeq: params.headSeq, baseSeq: params.baseSeq,
    entries: log.entries.filter((e) => e.seq >= params.baseSeq && e.seq <= params.headSeq), logHead: log.entries.length,
    ...(params.parentLogKey ? { parentLogKey: params.parentLogKey } : {}) }, deps(cl));
  if (!conf.ok) return conf;
  cl.rep = conf.result.replica;
  return { ok: true, client: cl };
}
/** 加入那時正在用的那一代金鑰 */
const keyAtAdd = (inviter, params) => {
  const { kid } = inviter.rep.view.state.epochs.filter((e) => e.v <= params.chain.length).at(-1);
  return { kid, key: inviter.keys.get(kid) };
};
/** 邀請要附的東西：inviteParams ＋ 加回舊成員時上一代的只讀 log 金鑰 */
const inviteFrom = async (inviter, addId) => {
  const params = L.inviteParams(inviter.rep, addId);
  if (!params?.parentKid) return params;
  return { ...params, parentLogKey: await L.logKeyBytes(inviter.keys.get(params.parentKid), inviter.rep.view.gid) };
};
/** inviter 把 who 加進來、看到自己的 add 上鏈後送邀請 */
async function invite(inviter, log, who) {
  const { seq, built } = await submit(inviter, log, 'add', { pk: who.pk });
  await pull(inviter, log, seq);
  assert.equal(inviter.rep.headSeq, seq, 'the add was applied');
  const params = await inviteFrom(inviter, built.id);
  assert.equal(params.headSeq, seq);
  const res = await join(who, params, inviter.rep.view.gid, keyAtAdd(inviter, params), log);
  assert.ok(res.ok, res.reason);
  assert.equal(res.client.rep.headSeq, seq);
  return res.client;
}
const A = identity('log-A'), B = identity('log-B'), C = identity('log-C'), D = identity('log-D'), M = identity('log-M'), OUT = identity('log-outsider');

// ── 1. 規格 ──
{
  const { g, log, owner } = await newGroup(A);
  const b = await invite(owner, log, B);
  const c = await invite(owner, log, C);
  await pull(b, log); await pull(c, log);
  const headBefore = owner.rep.view.state.head.id;
  const { built } = await submit(owner, log, 'remove', { pk: C.pk }, { newEpoch: fresh() });
  const ep = built.newEpoch;
  assert.equal(ep.kid, crypto.createHash('sha256').update(`aegistalk-gkid-v1|${headBefore}|${A.pk}`).digest('base64url').slice(0, 22),
    'kid = b64url(SHA-256("aegistalk-gkid-v1|" + prev + "|" + actor))[:22] (decided by position and author)');
  const blob = JSON.parse(built.blob);
  assert.deepEqual(Object.keys(blob).sort(), ['c', 'k', 'n'], 'only {k, n, c} on the wire');
  assert.equal(blob.k, g.kid, 'encrypted under the parent epoch, kid in clear');
  const plain = specOpenEntry(built.blob, g.gid, owner.keys.get(g.kid));
  assert.equal(plain.commit.c.op, 'remove');
  assert.equal(plain.commit.c.args.kb, crypto.createHash('sha256').update(canon(plain.bundle)).digest('base64url'), 'kb = SHA-256(canonical bundle)');
  assert.deepEqual(Object.keys(plain.bundle.to).sort(), [A.pk, B.pk].sort(), 'one copy per remaining member, none for the removed one');
  for (const who of [A, B]) {
    const key = await specOpenCopy(plain.bundle, g.gid, ep.kid, who);
    assert.ok(key.equals(Buffer.from(ep.key)), `${who.label} opens its copy (independent implementation)`);
  }
  assert.equal(plain.commit.c.args.kc, crypto.createHmac('sha256', Buffer.from(ep.key)).update(`aegistalk-gkc-v1|${g.gid}|${ep.kid}`).digest('base64url'));
  assert.ok(!built.blob.includes(C.pk) && !built.blob.includes('remove'), 'nothing readable by the server');
  console.log('PASS spec: log entry {k, n, c} under the parent epoch; key bundle with one copy per remaining member, kb and kc bind it to the signed commit; kid derived from (prev, actor)');
}

// ── 2. 一般流程、同時送出、rebase ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B);
  await pull(a, log); await pull(b, log);
  assert.equal(a.rep.view.state.head.id, b.rep.view.state.head.id);
  // A 和 B 在同一個 head 同時送
  const s1 = await submit(a, log, 'info', { name: 'from A' });
  const s2 = await submit(b, log, 'add', { pk: C.pk });
  const ra = await pull(a, log), rb = await pull(b, log);
  assert.equal(a.rep.view.state.head.id, b.rep.view.state.head.id, 'same log → same head');
  assert.equal(a.rep.view.state.info.name, 'from A', 'first come, first applied');
  assert.deepEqual(rb.staleOwn.map((x) => x.id), [s2.built.id], 'the author of the later one is told it went stale');
  assert.deepEqual(ra.staleOwn, [], 'others are not asked to re-send');
  assert.equal(rb.skipped.find((x) => x.seq === s2.seq).reason, 'stale');
  const draft = L.rebaseDraft(rb.staleOwn[0]);
  assert.deepEqual(draft, { op: 'add', args: { pk: C.pk }, needsNewEpoch: false });
  await submit(b, log, draft.op, draft.args);
  await pull(a, log); await pull(b, log);
  assert.ok(a.rep.view.state.members.some((m) => m.pk === C.pk), 'the rebased add went through');
  assert.equal(a.rep.headSeq, b.rep.headSeq);
  // 換金鑰的 commit 過時 → 重送一定要新金鑰
  const ep = fresh();
  const stale = await submit(a, log, 'remove', { pk: C.pk }, { newEpoch: ep });
  await submit(b, log, 'add', { pk: D.pk });
  const order = log.entries.slice(-2);
  [log.entries[log.entries.length - 2], log.entries[log.entries.length - 1]] = [{ ...order[1], seq: order[0].seq }, { ...order[0], seq: order[1].seq }];   // 伺服器讓 B 先
  const ra2 = await pull(a, log);
  assert.deepEqual(ra2.staleOwn.map((x) => x.id), [stale.built.id]);
  const d2 = L.rebaseDraft(ra2.staleOwn[0]);
  assert.deepEqual(d2, { op: 'remove', args: { pk: C.pk }, needsNewEpoch: true }, 'kid/kc/kb dropped: the old bundle already went to the old roster');
  await assert.rejects(L.buildCommitEntry({ view: a.rep.view, actor: A.pk, sign: A.sign, op: 'remove', args: d2.args, ts: 9, epochKey: a.keys.get(a.rep.view.state.epoch.kid) }, x25519), /needs-new-epoch/);
  console.log('PASS normal flow: invite + startLog, first-come ordering, stale report to the author only, rebase; key-rotating rebase needs a new key');
}

// ── 3. 跳過：每台一樣，別一代的不解密 ──
{
  const { g, log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B);
  const before = log.entries.length;
  const cur = { kid: a.rep.view.state.epoch.kid, key: a.keys.get(a.rep.view.state.epoch.kid) };
  const signedBy = async (who, args) => G.signCommit(G.proposeCommit(a.rep.view.state, who.pk, 'info', args, 3), who.sign, who.pk);
  const goodish = await signedBy(A, { name: 'tampered' });
  const junk = [
    ['malformed-entry', 'not json'],
    ['malformed-entry', JSON.stringify({ k: cur.kid, n: 'AAAA', c: 'AAAA' })],
    ['other-epoch', JSON.stringify({ k: 'old-kid', n: Buffer.alloc(12).toString('base64'), c: Buffer.alloc(40).toString('base64') })],
    ['undecryptable', JSON.stringify({ k: cur.kid, n: Buffer.alloc(12).toString('base64'), c: Buffer.alloc(40).toString('base64') })],
    ['bad-signature', await L.sealLogEntry({ gid: g.gid, kid: cur.kid, key: cur.key, commit: { c: goodish.c, s: (await signedBy(B, { name: 'x' })).s } })],
    ['actor-not-member', await L.sealLogEntry({ gid: g.gid, kid: cur.kid, key: cur.key, commit: await signedBy(OUT, { name: 'outsider' }) })],
    ['malformed-entry', await L.sealLogEntry({ gid: g.gid, kid: cur.kid, key: cur.key, commit: goodish }).then((bl) => { const o = JSON.parse(bl); return JSON.stringify({ ...o, extra: 1 }); })],
  ];
  for (const [, blob] of junk) log.append(blob);
  const realSeq = (await submit(a, log, 'info', { name: 'real' })).seq;
  log.append(log.entries[realSeq - 1].blob);   // 伺服器重複送同一筆
  for (const cl of [a, b]) {
    cl.calls.length = 0;
    const res = await pull(cl, log);
    const reasons = res.skipped.filter((x) => x.seq > before).map((x) => x.reason);
    assert.deepEqual(reasons, [...junk.map(([r]) => r), 'duplicate'], `${cl.id.label}: every bad entry skipped with its reason`);
    assert.ok(!cl.calls.includes('old-kid'), 'another epoch is skipped without even looking up its key');
    assert.equal(cl.rep.view.state.info.name, 'real');
  }
  assert.equal(a.rep.view.state.head.id, b.rep.view.state.head.id);
  console.log(`PASS ${junk.length + 1} kinds of bad entries skipped identically by every member; other-epoch entries never decrypted`);
}

// ── 4. 踢人：新金鑰在同一筆裡 ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B), c = await invite(a, log, C);
  for (const cl of [a, b, c]) await pull(cl, log);
  const oldKid = a.rep.view.state.epoch.kid;
  const { built: removal } = await submit(a, log, 'remove', { pk: C.pk }, { newEpoch: fresh() });
  const ep = removal.newEpoch;
  const rb = await pull(b, log), rc = await pull(c, log);
  await pull(a, log);
  assert.deepEqual(rb.newKeys.map((x) => x.kid), [ep.kid], 'B receives the new key from the remove itself');
  assert.ok(Buffer.from(b.keys.get(ep.kid)).equals(Buffer.from(ep.key)));
  assert.equal(c.rep.status, 'removed');
  assert.deepEqual(rc.newKeys, [], 'C gets nothing');
  await submit(a, log, 'info', { name: 'after' });
  // C 還拿舊金鑰送東西：其他人不解密就跳過
  const cOld = await L.sealLogEntry({ gid: a.rep.view.gid, kid: oldKid, key: c.keys.get(oldKid), commit: G.signCommit(G.proposeCommit(c.rep.view.state, C.pk, 'add', { pk: M.pk }, 1), C.sign, C.pk) });
  log.append(cOld);
  const rb2 = await pull(b, log);
  assert.equal(b.rep.view.state.info.name, 'after');
  assert.equal(rb2.skipped[rb2.skipped.length - 1].reason, 'other-epoch');
  assert.throws(() => specOpenEntry(log.entries[log.entries.length - 2].blob, a.rep.view.gid, c.keys.get(oldKid)), undefined, 'C cannot read entries after the remove');
  const rc2 = await pull(c, log);
  assert.equal(rc2.applied.length, 0, 'a removed member stops');
  console.log('PASS remove: remaining members get the new key from the same commit; the removed member stops, cannot read on, and its old-key entries are skipped');
}

// ── 5. 離線很久的人一次補完 ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B), d = await invite(a, log, D), c = await invite(a, log, C);
  for (const cl of [a, b, d, c]) await pull(cl, log);
  // D 離線：期間踢 C、B 離開、A 換金鑰、加回 C、改名
  await submit(a, log, 'remove', { pk: C.pk }, { newEpoch: fresh() }); await pull(a, log);
  await pull(b, log); await submit(b, log, 'leave', {}); await pull(a, log);
  assert.ok(G.waitingForAdminRekey(a.rep.view.state));
  await submit(a, log, 'rekey', {}, { newEpoch: fresh() }); await pull(a, log);
  await submit(a, log, 'add', { pk: C.pk }, { newEpoch: fresh() }); await pull(a, log);
  await submit(a, log, 'info', { name: 'much later' }, { ts: Date.now() + 30 * 86_400_000 }); await pull(a, log);
  const rd = await pull(d, log);
  assert.equal(rd.newKeys.length, 3, 'three rotations, three keys, all from the log itself');
  assert.equal(rd.waiting, null);
  assert.equal(canon(d.rep.view.state), canon(a.rep.view.state), 'the offline member catches up to the same state');
  assert.equal(d.rep.headSeq, a.rep.headSeq);
  console.log('PASS a long-offline member catches up across 3 key rotations in one fetch (keys travel in the log, no expiry)');
}

// ── 6. 少給一份、對不上 kc、包被換掉 → keyMissing，等，拿到後繼續 ──
async function malformedRotation(a, log, mutate) {
  const st = a.rep.view.state;
  const ep = { ...fresh(), kid: await G.epochKidFor(st.head.id, A.pk) };
  const recipients = G.rosterAfter(st, 'rekey');
  let bundle = (await L.sealKeyBundle({ gid: st.gid, kid: ep.kid, key: ep.key, recipients }, x25519)).bundle;
  const kb = await L.bundleHash(bundle);
  const kc = await G.keyCommitment(ep.key, st.gid, ep.kid);
  bundle = await mutate(bundle, st, ep);
  const commit = G.signCommit(G.proposeCommit(st, A.pk, 'rekey', { kid: ep.kid, kc, kb: mutate.recomputeKb ? await L.bundleHash(bundle) : kb }, 7), A.sign, A.pk);
  log.append(await L.sealLogEntry({ gid: st.gid, kid: st.epoch.kid, key: a.keys.get(st.epoch.kid), commit, bundle }));
  a.keys.set(ep.kid, ep.key);   // 作者自己先存好
  const ra = await pull(a, log);
  return { ep, ra };
}
{
  const leaveOutB = Object.assign(async (bundle, st, ep) => (await L.sealKeyBundle({ gid: st.gid, kid: ep.kid, key: ep.key, recipients: [A.pk, C.pk] }, x25519)).bundle, { recomputeKb: true });
  const wrongKeyForB = Object.assign(async (bundle, st, ep) => {
    const wrong = (await L.sealKeyBundle({ gid: st.gid, kid: ep.kid, key: new Uint8Array(32).fill(5), recipients: [B.pk] }, x25519)).bundle;
    const good = (await L.sealKeyBundle({ gid: st.gid, kid: ep.kid, key: ep.key, recipients: [A.pk, C.pk] }, x25519)).bundle;
    return { ek: good.ek, to: { ...good.to, [B.pk]: wrong.to[B.pk] } };   // B 那份用別的臨時金鑰封 → 打不開或對不上
  }, { recomputeKb: true });
  const swapped = Object.assign(async (bundle) => ({ ek: Buffer.alloc(32, 9).toString('base64'), to: bundle.to }), { recomputeKb: false });
  // B 那份解得開、但裡面是別的金鑰 → kc 對不上
  const wrongButOpens = Object.assign(async (bundle, st, ep) => specSealBundle(st.gid, ep.kid, [[A, ep.key], [B, new Uint8Array(32).fill(7)], [C, ep.key]]), { recomputeKb: true });
  // 有人（知道金鑰的成員）把包換成另一個正確的包：金鑰沒錯，但不是作者簽的那個包 → 一律不用（kb 綁住）
  const resealed = Object.assign(async (bundle, st, ep) => specSealBundle(st.gid, ep.kid, [[A, ep.key], [B, ep.key], [C, ep.key]]), { recomputeKb: false });
  const cases = [['B left out of the bundle', leaveOutB], ['B given a wrong copy', wrongKeyForB], ['B copy opens to a key that does not match kc', wrongButOpens],
    ['bundle swapped after signing (kb mismatch)', swapped], ['bundle replaced by a re-sealed correct one (not the signed bundle)', resealed]];
  for (const [why, mutate] of cases) {
    const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
    const b = await invite(a, log, B), c = await invite(a, log, C);
    for (const cl of [a, b, c]) await pull(cl, log);
    const { ep, ra } = await malformedRotation(a, log, mutate);
    await submit(a, log, 'info', { name: 'continues' });
    await pull(a, log);
    const rb = await pull(b, log);
    assert.deepEqual(rb.keyMissing.map((x) => x.kid), [ep.kid], `${why}: B applies the rotation but reports the key missing`);
    assert.equal(rb.replica.view.state.epoch.kid, ep.kid, 'the commit is applied (validity does not depend on the bundle)');
    assert.deepEqual(rb.waiting, { kid: ep.kid, seq: log.entries.length, reason: 'no-key' }, 'B stops at the next entry of that epoch');
    assert.equal(b.rep.processedSeq, log.entries.length - 1, 'and will resume from there');
    if (why.startsWith('bundle')) assert.deepEqual(ra.keyMissing.map((x) => x.kid), [ep.kid], 'nobody uses a bundle the author did not sign');
    // B 用 sealed req 向 admin 要到金鑰（這裡直接放進去）→ 從停下的地方繼續
    b.keys.set(ep.kid, ep.key);
    const rb2 = await pull(b, log);
    assert.equal(rb2.waiting, null);
    assert.equal(canon(b.rep.view.state), canon(a.rep.view.state), `${why}: after receiving the key B is identical`);
  }
  console.log('PASS missing/mismatched/swapped key copies → commit applied, keyMissing reported, member waits at the next entry and resumes identically once the key arrives');
}

// ── 7. head 交叉比對 ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B);
  await pull(a, log); await pull(b, log);
  assert.equal(L.compareGossip(a.rep, L.headGossip(b.rep)), 'same');
  await submit(a, log, 'info', { name: 'n1' });
  await pull(a, log);
  assert.equal(L.compareGossip(b.rep, L.headGossip(a.rep)), 'i-am-behind');
  assert.equal(L.compareGossip(a.rep, L.headGossip(b.rep)), 'they-are-behind');
  assert.equal(L.compareGossip(b.rep, { seq: 0, id: a.rep.view.chain[0].id }), 'unknown', 'before B joined');
  assert.equal(L.compareGossip(a.rep, { seq: 1, id: 'f'.repeat(64) }), 'conflict');
  assert.equal(L.compareGossip(a.rep, { seq: 'x', id: 1 }), 'unknown');
  // 伺服器分岔：給 A 看的 log 跟給 B 看的在下一個 seq 不一樣
  await pull(b, log);
  const a0 = a.rep, b0 = b.rep;
  const copy = () => { const l = newLog(); for (const e of log.entries) l.append(e.blob); return l; };
  const forkA = copy(), forkB = copy();
  await submit(a, forkA, 'info', { name: 'only A sees this' });
  await submit(b, forkB, 'add', { pk: C.pk });
  await pull(a, forkA); await pull(b, forkB);
  assert.equal(L.compareGossip(a.rep, L.headGossip(b.rep)), 'conflict', 'same seq, different head → server equivocation detected');
  assert.equal(L.compareGossip(b.rep, L.headGossip(a.rep)), 'conflict');
  // 伺服器在同一個 seq 給 A 真的、給 B 垃圾：A 套上的 seq，B 跳過了 → 也是 conflict
  a.rep = a0; b.rep = b0;
  const real = copy(), junk = copy();
  await submit(a, real, 'info', { name: 'real one' });
  junk.append('garbage');
  await pull(a, real); await pull(b, junk);
  assert.equal(b.rep.processedSeq, a.rep.headSeq);
  assert.equal(L.compareGossip(b.rep, L.headGossip(a.rep)), 'conflict', 'an entry applied by A but skipped by B is a conflict');
  console.log('PASS head gossip: same / behind / unknown on one log; a forked log (server equivocation) is reported as conflict');
}

// ── 8. 舊位置永遠過時；成員送換金鑰的 commit 卡不住群組 ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const d = await invite(a, log, D), c = await invite(a, log, C), m = await invite(a, log, M);
  for (const cl of [a, d, c, m]) await pull(cl, log);
  await submit(a, log, 'role', { pk: D.pk, role: 'admin' });
  for (const cl of [a, d, c, m]) await pull(cl, log);
  const whenAdmin = d.rep.view;   // D 還是 admin、C 還是成員的那一版
  await submit(a, log, 'remove', { pk: C.pk }, { newEpoch: fresh() });
  await pull(a, log);
  await submit(a, log, 'role', { pk: D.pk, role: 'member' });
  for (const cl of [a, d, m]) await pull(cl, log);
  const headBefore = a.rep.view.state.head.id;
  // D 回到還是 admin 的位置踢 M；被踢的 C 回到還是成員的位置加人 —— 用那時的金鑰（現在的 kid 不同）或現在的金鑰都一樣
  const oldKid = whenAdmin.state.epoch.kid;
  const dOld = G.signCommit(G.proposeCommit(whenAdmin.state, D.pk, 'remove', { pk: M.pk, kid: await G.epochKidFor(whenAdmin.state.head.id, D.pk), kc: 'A'.repeat(43), kb: 'A'.repeat(43) }, 1), D.sign, D.pk);
  log.append(await L.sealLogEntry({ gid: whenAdmin.gid, kid: a.rep.view.state.epoch.kid, key: d.keys.get(a.rep.view.state.epoch.kid), commit: dOld }));
  log.append(await L.sealLogEntry({ gid: whenAdmin.gid, kid: oldKid, key: c.keys.get(oldKid), commit: G.signCommit(G.proposeCommit(whenAdmin.state, C.pk, 'add', { pk: OUT.pk }, 1), C.sign, C.pk) }));
  // 成員 M 試著換金鑰（自己拿著不給人）、試著加回 C
  const mRekey = G.signCommit(G.proposeCommit(m.rep.view.state, M.pk, 'rekey', { kid: await G.epochKidFor(m.rep.view.state.head.id, M.pk), kc: 'B'.repeat(43), kb: 'C'.repeat(43) }, 1), M.sign, M.pk);
  log.append(await L.sealLogEntry({ gid: whenAdmin.gid, kid: m.rep.view.state.epoch.kid, key: m.keys.get(m.rep.view.state.epoch.kid), commit: mRekey }));
  await submit(a, log, 'info', { name: 'still moving' });
  for (const cl of [a, d, m]) {
    const res = await pull(cl, log);
    assert.deepEqual(res.skipped.slice(-3).map((x) => x.reason), ['stale', 'other-epoch', 'not-admin'], `${cl.id.label}: old-position commits stale / old epoch, member rekey rejected`);
    assert.equal(res.waiting, null, 'nobody waits for a key a member made up');
    assert.equal(cl.rep.view.state.info.name, 'still moving');
  }
  assert.notEqual(a.rep.view.state.head.id, headBefore);
  console.log('PASS removed member and demoted ex-admin old-position commits are always stale/skipped; a member\'s rekey is skipped, the group keeps moving');
}

// ── 10. 連號、金鑰核對、從基準點重建（審查 M3） ──
{
  const { log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B);
  for (const cl of [a, b]) await pull(cl, log);
  for (const name of ['n1', 'n2', 'n3']) { await submit(a, log, 'info', { name }); await pull(a, log); }
  const from = b.rep.processedSeq;
  const deps10 = { verify, keyFor: (kid) => b.keys.get(kid) ?? null, myX25519Private: b.xpriv, x25519 };
  const page = log.after(from);
  let r = await L.applyLog(b.rep, page.slice(1), deps10);
  assert.deepEqual([r.applied.length, r.gap], [0, { from: from + 1, to: from + 1 }], 'a page that starts after a hole applies nothing');
  r = await L.applyLog(b.rep, [page[0], page[2]], deps10);
  assert.deepEqual([r.applied.length, r.gap, r.replica.processedSeq], [1, { from: from + 2, to: from + 2 }, from + 1], 'a hole in the middle: stop right before it');
  r = await L.applyLog(b.rep, [page[0], { ...page[1] }, page[1], page[2]], deps10);
  assert.deepEqual([r.applied.length, r.gap], [3, null], 'duplicated seq in one page: first copy counts, still contiguous');
  // 金鑰：給錯的 → 等（key-mismatch）、不往前；不給 → 等（no-key）
  const kid = b.rep.view.state.epoch.kid;
  r = await L.applyLog(b.rep, page, { ...deps10, keyFor: () => new Uint8Array(32).fill(9) });
  assert.deepEqual([r.waiting, r.replica.processedSeq], [{ kid, seq: from + 1, reason: 'key-mismatch' }, from]);
  r = await L.applyLog(b.rep, page, { ...deps10, keyFor: () => null });
  assert.deepEqual(r.waiting, { kid, seq: from + 1, reason: 'no-key' });
  // 伺服器在同一個 seq 給 B 垃圾（A 套上的那筆 B 跳過）→ conflict → 用誠實的 log 重建
  const fake = page.map((e, i) => (i === 0 ? { seq: e.seq, blob: 'garbage' } : e));
  const s0 = await submit(b, log, 'add', { pk: C.pk });      // B 在舊 head 上寫的：誠實 log 上會過時
  const fakeWithMine = [...fake, log.entries[s0.seq - 1]];
  await pull(b, { after: () => fakeWithMine.filter((e) => e.seq > b.rep.processedSeq) });
  await pull(a, log);
  assert.equal(L.compareGossip(b.rep, L.headGossip(a.rep)), 'conflict', 'a member shown garbage where others applied a commit sees a conflict');
  const rebuilt = await L.rebuildLog(b.rep, log.after(b.rep.firstSeq), deps10);
  assert.equal(canon(rebuilt.replica.view.state), canon(a.rep.view.state), 'rebuilt from the base with the honest log: same state as A');
  assert.equal(rebuilt.replica.firstSeq, b.rep.firstSeq);
  assert.deepEqual(rebuilt.staleOwn.map((x) => x.id), [s0.built.id], 'own stale commits are reported again (the caller de-duplicates by id)');
  assert.equal(L.compareGossip(rebuilt.replica, L.headGossip(a.rep)), 'same');
  console.log('PASS seq contiguity (hole → stop and report the gap), stored keys checked against kc (wrong → wait), rebuild from the base after a conflict');
}

// ── 11. 邀請對照 log（審查 M1） ──
{
  const P = identity('log-P'), Q = identity('log-Q'), N = identity('log-N'), Z = identity('log-Z');
  const { g, log, owner: a } = await newGroup(A, { addPolicy: 'members' });
  const b = await invite(a, log, B), d = await invite(a, log, D);
  await submit(a, log, 'role', { pk: D.pk, role: 'admin' });
  for (const cl of [a, b, d]) await pull(cl, log);
  const dWhenAdmin = d.rep;
  await submit(a, log, 'remove', { pk: B.pk }, { newEpoch: fresh() });   // 換一代（踢 B）
  await pull(a, log);
  await submit(a, log, 'role', { pk: D.pk, role: 'member' });
  await pull(a, log);
  const confirm = async (who, params, key, entries, logHead = log.entries.length) => {
    const res = await G.verifyInvite({ chain: params.chain, gid: g.gid, me: who.pk, key, verify });
    assert.ok(res.ok, res.reason);
    const cl = await clientOf(who, null, [[key.kid, key.key]]);
    return L.confirmInvite({ view: res.view, me: who.pk, key, headSeq: params.headSeq, baseSeq: params.baseSeq, entries, logHead }, deps(cl));
  };
  // 被降級的前 admin 在還是 admin 的舊位置邀人 → 正典套用在他那筆之前就換了金鑰（踢 B）→ 他那筆永遠接不上，直接拒收（不會卡住）
  const kOld = { kid: dWhenAdmin.view.state.epoch.kid, key: d.keys.get(dWhenAdmin.view.state.epoch.kid) };
  const addP = G.signCommit(G.proposeCommit(dWhenAdmin.view.state, D.pk, 'add', { pk: P.pk }, 9), D.sign, D.pk);
  const sP = log.append(await L.sealLogEntry({ gid: g.gid, kid: kOld.kid, key: kOld.key, commit: addP }));
  const staleBranch = { chain: [...dWhenAdmin.view.chain.map(wire), addP], headSeq: sP, baseSeq: dWhenAdmin.firstSeq };
  assert.deepEqual(await confirm(P, staleBranch, kOld, log.after(staleBranch.baseSeq - 1)), { ok: false, reason: 'add-not-in-log', retry: false }, 'demoted ex-admin, old position');
  // 誠實的 add：在新一代裡（baseSeq ＝ 踢人那筆的 seq）
  const { seq: sQ, built } = await submit(a, log, 'add', { pk: Q.pk });
  await submit(a, log, 'info', { name: 'later' });   // 跟 add 同一個 head → 過時
  await pull(a, log);
  const params = L.inviteParams(a.rep, built.id);
  const keyQ = keyAtAdd(a, params);
  assert.equal(params.headSeq, sQ);
  assert.ok(params.baseSeq > dWhenAdmin.firstSeq && params.baseSeq < sQ, 'baseSeq is where the current epoch started');
  const all = log.after(params.baseSeq - 1);
  const ok = await confirm(Q, params, keyQ, all);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.result.replica.status, 'member');
  assert.equal(ok.result.replica.view.state.head.id, a.rep.view.state.head.id, 'entries after headSeq are applied too');
  // seq 對不上、太大、還沒抓完、缺號、baseSeq 不對
  const cases = [
    ['headSeq too small', { ...params, headSeq: sQ - 1 }, all, 'head-seq-mismatch', false],
    ['headSeq points at a later entry', { ...params, headSeq: sQ + 1 }, all, 'head-seq-mismatch', false],
    ['headSeq beyond the server head', { ...params, headSeq: log.entries.length + 5 }, all, 'head-seq-beyond-log', false],
    ['entries stop before headSeq', params, all.filter((e) => e.seq < sQ), 'log-incomplete', true],
    ['a hole before headSeq', params, all.filter((e) => e.seq !== sQ - 1), 'log-incomplete', true],
    ['baseSeq after the epoch start (skips a commit)', { ...params, baseSeq: params.baseSeq + 1 }, log.after(params.baseSeq), 'add-not-in-log', false],
    ['baseSeq after headSeq', { ...params, baseSeq: sQ + 1 }, all, 'bad-invite-seq', false],
    ['negative seq', { ...params, headSeq: -1 }, all, 'bad-invite-seq', false],
  ];
  for (const [why, pp, entries, reason, retry] of cases) {
    assert.deepEqual(await confirm(Q, pp, keyQ, entries), { ok: false, reason, retry }, why);
  }
  // 初始成員（genesis 列了我）：genesis 那筆用第一代金鑰，直接核對
  const g2 = await newGroup(A, { members: [Z.pk] });
  const genesisParams = { chain: [wire(g2.owner.rep.view.chain[0])], headSeq: 1, baseSeq: 1 };
  const gz = await (async () => {
    const res = await G.verifyInvite({ chain: genesisParams.chain, gid: g2.g.gid, me: Z.pk, key: { kid: g2.g.kid, key: g2.g.key }, verify });
    const cl = await clientOf(Z, null, [[g2.g.kid, g2.g.key]]);
    return L.confirmInvite({ view: res.view, me: Z.pk, key: { kid: g2.g.kid, key: g2.g.key }, headSeq: 1, baseSeq: 1, entries: g2.log.entries, logHead: 1 }, deps(cl));
  })();
  assert.equal(gz.ok, true, gz.reason);
  // 加回舊成員沒附上一代的只讀 log 金鑰 → 拒收（完整的情況在第 12 節）
  await submit(a, log, 'add', { pk: B.pk }, { newEpoch: fresh() });
  await pull(a, log);
  const readd = L.inviteParams(a.rep, a.rep.view.state.head.id);
  assert.ok(readd.parentKid && readd.baseSeq < readd.headSeq, 'a re-add is confirmed from where the parent epoch started');
  const rr = await confirm(B, readd, { kid: a.rep.view.state.epoch.kid, key: a.keys.get(a.rep.view.state.epoch.kid) }, log.after(readd.baseSeq - 1));
  assert.deepEqual(rr, { ok: false, reason: 'missing-parent-log-key', retry: false });
  // 加入之後重建：基準點是那一代開始的地方，再對照一次；誠實 log → 還是成員，拿掉我那筆的 log → not-joined
  const q = await clientOf(Q, ok.result.replica, [[keyQ.kid, keyQ.key]]);
  await pull(q, log);
  const again = await L.rebuildLog(q.rep, log.after(q.rep.firstSeq), deps(q));
  assert.equal(again.replica.status, 'member');
  assert.equal(canon(again.replica.view.state), canon(a.rep.view.state));
  const withoutMine = log.after(q.rep.firstSeq).map((e) => (e.seq === sQ ? { seq: e.seq, blob: 'garbage' } : e));
  assert.equal((await L.rebuildLog(q.rep, withoutMine, deps(q))).replica.status, 'not-joined', 'a log without my add: not joined (reported, not silent)');
  console.log(`PASS invite confirmation against the log: stale-branch invite rejected, honest invite accepted from the epoch start, ${cases.length} wrong/oversized/incomplete seq cases reported (never a silent freeze), genesis member accepted, re-add without the parent log key refused, rebuild re-checks the join`);
}

// ── 12. 加回舊成員的邀請：附上一代的只讀 log 金鑰對照 log（決定 2026-10-22 M1 補充） ──
{
  const Ctl = await load('groupControl');
  const F = identity('log-former'), X = identity('log-ex-admin');
  const confirmWith = async (gid, log, params, key, parentLogKey, entries = log.after(params.baseSeq - 1)) => {
    const res = await G.verifyInvite({ chain: params.chain, gid, me: F.pk, key, verify });
    assert.ok(res.ok, res.reason);
    const cl = await clientOf(F, null, [[key.kid, key.key]]);
    const conf = await L.confirmInvite({ view: res.view, me: F.pk, key, headSeq: params.headSeq, baseSeq: params.baseSeq, entries,
      logHead: log.entries.length, ...(parentLogKey !== undefined ? { parentLogKey } : {}) }, deps(cl));
    return { conf, cl };
  };
  // 誠實的加回
  {
    const { g, log, owner: a } = await newGroup(A, { addPolicy: 'members' });
    const b = await invite(a, log, B), f = await invite(a, log, F);
    for (const cl of [a, b, f]) await pull(cl, log);
    await submit(a, log, 'remove', { pk: F.pk }, { newEpoch: fresh() }); await pull(a, log);
    await submit(a, log, 'info', { name: 'without F' }); await pull(a, log);
    const parent = { kid: a.rep.view.state.epoch.kid, key: a.keys.get(a.rep.view.state.epoch.kid) };
    const { built } = await submit(a, log, 'add', { pk: F.pk }, { newEpoch: fresh() }); await pull(a, log);
    await submit(a, log, 'info', { name: 'F is back' }); await pull(a, log);
    const params = await inviteFrom(a, built.id);
    assert.equal(params.parentKid, parent.kid, 'the invite names the parent epoch');
    assert.deepEqual([...params.parentLogKey], [...hkdf(parent.key, Buffer.alloc(0), `aegistalk-glog-v1|${g.gid}`)], 'K_log = HKDF(K_parent, "aegistalk-glog-v1|gid") (independent check)');
    const keyNew = keyAtAdd(a, params);
    assert.equal(keyNew.kid, built.newEpoch.kid);
    const { conf, cl } = await confirmWith(g.gid, log, params, keyNew, params.parentLogKey);
    assert.equal(conf.ok, true, conf.reason);
    assert.equal(conf.result.replica.status, 'member');
    assert.equal(canon(conf.result.replica.view.state), canon(a.rep.view.state), 'the re-added member continues to the same state');
    assert.deepEqual(conf.result.newKeys.map((k) => k.kid), [keyNew.kid], 'only the new epoch key comes out (from its own copy in the bundle)');
    assert.ok(conf.result.newKeys.every((k) => !Buffer.from(k.key).equals(Buffer.from(params.parentLogKey))), 'the parent log key never comes out as a key');
    // 附錯的只讀金鑰：亂數、上一代的金鑰本身（K_e 不是 K_log）、別一代的 K_log；沒附
    const wrongs = [['random', new Uint8Array(32).fill(4)], ['the parent epoch key itself', parent.key],
      ['the log key of another epoch', await L.logKeyBytes(keyNew.key, g.gid)], ['16 bytes', new Uint8Array(16)]];
    for (const [why, k] of wrongs) {
      assert.deepEqual((await confirmWith(g.gid, log, params, keyNew, k)).conf, { ok: false, reason: 'bad-parent-log-key', retry: false }, why);
    }
    assert.deepEqual((await confirmWith(g.gid, log, params, keyNew, undefined)).conf, { ok: false, reason: 'missing-parent-log-key', retry: false });
    // 只讀 log 金鑰的範圍：解得開上一代的 log entry；解不開新一代的、群組控制訊息、聊天（groupKey.ts：AES-GCM 直接用 K_e）；也不是任何一代的金鑰
    const parentEntry = log.entries[params.headSeq - 1];
    assert.equal((await L.openLogEntryWithLogKey({ blob: parentEntry.blob, gid: g.gid, logKey: params.parentLogKey })).kid, parent.kid);
    const newEntry = log.entries[params.headSeq];
    assert.equal(JSON.parse(newEntry.blob).k, keyNew.kid);
    await assert.rejects(L.openLogEntryWithLogKey({ blob: newEntry.blob, gid: g.gid, logKey: params.parentLogKey }), /undecryptable/, 'not the next epoch\'s entries');
    const ctl = await Ctl.sealControl({ gid: g.gid, kid: parent.kid, key: parent.key, sender: A.pk, sign: A.sign, t: 'here', body: { head: L.headGossip(a.rep) } });
    await assert.rejects(Ctl.openControl({ envelope: ctl.envelope, gid: g.gid, tid: ctl.tid, sender: A.pk, kid: parent.kid, key: params.parentLogKey, verify }), /groupControl/, 'not group control traffic');
    const kCtl = hkdf(parent.key, Buffer.alloc(0), `aegistalk-gctl-v1|${g.gid}`);
    assert.ok(!kCtl.equals(Buffer.from(params.parentLogKey)) && !Buffer.from(parent.key).equals(Buffer.from(params.parentLogKey)));
    const iv = crypto.randomBytes(12);
    const enc = crypto.createCipheriv('aes-256-gcm', Buffer.from(parent.key), iv);
    const chat = Buffer.concat([enc.update('hello group'), enc.final(), enc.getAuthTag()]);
    assert.throws(() => { const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(params.parentLogKey), iv); d.setAuthTag(chat.subarray(-16)); d.update(chat.subarray(0, -16)); d.final(); }, undefined, 'not chat traffic');
    for (const e of a.rep.view.state.epochs) assert.equal(await G.keyAuthorised(a.rep.view.state, e.kid, e.kc, params.parentLogKey), false, 'not an epoch key');
    const send = await L.currentEpochKey(conf.result.replica, () => params.parentLogKey);
    assert.equal(send.ok, false, 'cannot be used to send even if it ended up in the key store');
    void cl;
  }
  // 不在 log 裡的加回：X 還是 admin 時的舊位置（F 已被踢）簽加回 F、附那時的只讀 log 金鑰；之後 X 被踢
  {
    const { g, log, owner: a } = await newGroup(A, { addPolicy: 'members' });
    const b = await invite(a, log, B), f = await invite(a, log, F), x = await invite(a, log, X);
    await submit(a, log, 'role', { pk: X.pk, role: 'admin' }); await pull(a, log);
    await submit(a, log, 'remove', { pk: F.pk }, { newEpoch: fresh() }); await pull(a, log);
    for (const cl of [b, f, x]) await pull(cl, log);
    const stale = x.rep;                                            // X 還是 admin、F 已被踢
    const staleKey = { kid: stale.view.state.epoch.kid, key: x.keys.get(stale.view.state.epoch.kid) };
    await submit(a, log, 'remove', { pk: X.pk }, { newEpoch: fresh() }); await pull(a, log);
    const phantom = await L.buildCommitEntry({ view: stale.view, actor: X.pk, sign: X.sign, op: 'add', args: { pk: F.pk }, ts: 9,
      epochKey: staleKey.key, newEpoch: fresh() }, x25519);
    const sPh = log.append(phantom.blob);
    const epochStart = stale.view.chain[stale.view.state.epoch.v - 1].id;
    const baseSeq = Number(Object.entries(stale.appliedAt).find(([, id]) => id === epochStart)[0]);
    const params = { chain: [...stale.view.chain.map(wire), phantom.signed], headSeq: sPh, baseSeq, parentKid: staleKey.kid };
    const logKey = await L.logKeyBytes(staleKey.key, g.gid);
    const { conf } = await confirmWith(g.gid, log, params, phantom.newEpoch, logKey);
    assert.deepEqual(conf, { ok: false, reason: 'add-not-in-log', retry: false }, 'a removed ex-admin\'s re-add on its old branch is refused');
    void b;
  }
  console.log('PASS re-add invites: confirmed against the log with the parent epoch\'s read-only log key (K_log only); wrong / missing / K_e-instead-of-K_log keys refused; '
    + 'an old-branch re-add refused; that key opens only parent-epoch log entries — not the next epoch, not group control, not chat, not an epoch key, never a sending key');
}

// ── 9. 性質測試 ──
const POOL = [A, B, C, D, M, identity('log-P1'), identity('log-P2')];
/**
 * 規格參考：只用 Node crypto 解 entry、G.appendCommit 驗與接，金鑰由「全知」的表提供。
 * 表是 kid → 候選金鑰（同一位作者在同一個 head 寫兩筆換金鑰的 commit 時 kid 相同 —— kid 由位置與作者決定 —— 只有一筆會上鏈；
 * 用 kc 挑出鏈上指定的那一把，跟客戶端一樣）
 */
async function reference(gid, genesisView, entries, allKeys) {
  let view = genesisView;
  for (const e of entries.slice(1)) {
    let o;
    try { o = JSON.parse(e.blob); } catch { continue; }
    if (!o || o.k !== view.state.epoch.kid) continue;
    let key = null;
    for (const cand of allKeys.get(o.k) ?? []) if (await G.keyAuthorised(view.state, o.k, view.state.epoch.kc, cand)) key = cand;
    if (!key) continue;
    let plain;
    try { plain = specOpenEntry(e.blob, gid, key); } catch { continue; }
    const res = await G.appendCommit(view, plain.commit, verify);
    if (res.ok) view = res.view;
  }
  return view;
}
/**
 * 伺服器分岔：給 victim 看的 log 從 from 起每兩筆對調一次（其他人看到的是真的順序）。同一個 seq 對 victim 永遠給同一筆（一致的假 log），
 * 所以只給到最後一組湊滿的那一筆為止。
 */
function forkedView(log, from) {
  return {
    after(seq) {
      const n = log.entries.length;
      const limit = n >= from ? from - 1 + 2 * Math.floor((n - from + 1) / 2) : n;
      const out = [];
      for (let q = seq + 1; q <= limit; q++) {
        const src = q < from ? q : ((q - from) % 2 === 0 ? q + 1 : q - 1);
        out.push({ seq: q, blob: log.entries[src - 1].blob });
      }
      return out;
    },
  };
}
{
  const SEEDS = 40;
  skipCount.clear();
  let entriesTotal = 0, rotations = 0, splits = 0, diverged = 0, detected = 0, forkInvitesRefused = 0, readdsJoined = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const { log, owner } = await newGroup(POOL[0], { addPolicy: r.next() < 0.5 ? 'members' : 'admins' });
    const allKeys = new Map([...owner.keys].map(([kid, key]) => [kid, [key]]));
    const remember = (ne) => allKeys.set(ne.kid, [...(allKeys.get(ne.kid) ?? []), ne.key]);
    const clients = new Map([[POOL[0].pk, owner]]);
    for (const who of POOL.slice(1, 4)) clients.set(who.pk, await invite(owner, log, who));
    const genesisView = (await G.startChain(owner.rep.view.gid, wire(owner.rep.view.chain[0]), verify)).view;
    // 審查 M3：真的分岔 —— 伺服器給某一位成員看另一個順序的 log，一段時間後才給回真的；要發現（head 交叉比對）而且重建後一樣
    let split = null;
    const src = (cl) => (split && split.victim === cl ? split.view : log);
    const endSplit = async () => {
      const victim = split.victim;
      await pull(victim, split.view);
      const p = victim.rep.processedSeq;
      const vdeps = deps(victim);
      const honestAt = (await L.rebuildLog(victim.rep, log.entries.filter((e) => e.seq > victim.rep.firstSeq && e.seq <= p), vdeps)).replica;
      if (canon(honestAt.view.state) !== canon(victim.rep.view.state) || honestAt.status !== victim.rep.status) {
        diverged++;
        if (honestAt.processedSeq === p) {   // 兩邊在同一個位置交換 (seq, head)
          const seen = L.compareGossip(victim.rep, L.headGossip(honestAt)) === 'conflict' || L.compareGossip(honestAt, L.headGossip(victim.rep)) === 'conflict';
          assert.ok(seen, `seed ${seed}: a genuine split is detected by head gossip`);
          detected++;
        }
      }
      const res = await L.rebuildLog(victim.rep, log.after(victim.rep.firstSeq), vdeps);   // 真的 log 回來了 → 從基準點重建
      for (const nk of res.newKeys) victim.keys.set(nk.kid, nk.key);
      victim.rep = res.replica;
      split = null;
    };
    for (let step = 0; step < 40; step++) {
      const actives = [...clients.values()].filter((cl) => cl.rep.status === 'member');
      if (!split && r.next() < 0.15) {
        const victim = r.pick(actives);
        split = { victim, view: forkedView(log, Math.max(victim.rep.processedSeq + 1, log.entries.length - 1)) };
        splits++;
      } else if (split && r.next() < 0.1) await endSplit();
      const cl = r.pick(actives);
      if (r.next() < 0.45) { await pull(cl, src(cl), log.entries.length - r.int(3)); continue; }   // 有時只同步到一半
      if (r.next() < 0.08) { log.append(r.next() < 0.5 ? 'garbage' : JSON.stringify({ k: cl.rep.view.state.epoch.kid, n: Buffer.alloc(12).toString('base64'), c: Buffer.alloc(20).toString('base64') })); continue; }
      const st = cl.rep.view.state;
      const me = st.members.find((x) => x.pk === cl.id.pk);
      if (!me || !cl.keys.get(st.epoch.kid)) continue;
      const admin = me.role === 'admin';
      const others = st.members.filter((x) => x.pk !== cl.id.pk);
      const outsiders = POOL.filter((p) => !st.members.some((x) => x.pk === p.pk));
      const choice = r.pick(admin ? ['info', 'add', 'remove', 'rekey', 'role', 'leave'] : ['add', 'leave', 'rekey-attempt', 'info-attempt']);
      try {
        if (choice === 'info') await submit(cl, log, 'info', { name: `n${seed}-${step}` });
        else if (choice === 'add' && outsiders.length) {
          const who = r.pick(outsiders);
          const former = st.former.includes(who.pk);
          if (former && !admin) continue;
          const { seq, built } = await submit(cl, log, 'add', { pk: who.pk }, former ? { newEpoch: fresh() } : {});
          if (built.newEpoch) remember(built.newEpoch);
          // 新成員：作者看到自己的 add 上鏈才送邀請；新成員對照的是真的 log
          await pull(cl, src(cl));
          if (cl.rep.view.chain.some((x) => x.id === built.id) && cl.rep.view.state.members.some((x) => x.pk === who.pk)) {
            const params = await inviteFrom(cl, built.id);
            assert.equal(!!params.parentKid, former, 're-adds carry the parent epoch\'s kid');
            const res = await join(who, params, st.gid, keyAtAdd(cl, params), log);   // 加回舊成員：附上一代的只讀 log 金鑰對照
            if (res.ok) { clients.set(who.pk, res.client); if (former) readdsJoined++; }
            else {
              // 只有被伺服器看了假 log 的人做得出對照不過的邀請
              assert.ok(split && split.victim === cl, `seed ${seed}: honest invite refused (${res.reason})`);
              forkInvitesRefused++;
            }
          }
        } else if (choice === 'remove' && others.length) {
          const { built } = await submit(cl, log, 'remove', { pk: r.pick(others).pk }, { newEpoch: fresh() });
          remember(built.newEpoch); rotations++;
        } else if (choice === 'rekey') {
          const { built } = await submit(cl, log, 'rekey', {}, { newEpoch: fresh() });
          remember(built.newEpoch); rotations++;
        } else if (choice === 'role' && others.length) {
          const t = r.pick(others);
          await submit(cl, log, 'role', { pk: t.pk, role: t.role === 'admin' ? 'member' : 'admin' });
        } else if (choice === 'leave' && st.members.length > 2) await submit(cl, log, 'leave', {});
        else if (choice === 'rekey-attempt') {   // 成員想換金鑰：自己簽、自己封，其他人要跳過
          const c = G.signCommit(G.proposeCommit(st, cl.id.pk, 'rekey', { kid: await G.epochKidFor(st.head.id, cl.id.pk), kc: 'A'.repeat(43), kb: 'A'.repeat(43) }, 1), cl.id.sign, cl.id.pk);
          log.append(await L.sealLogEntry({ gid: st.gid, kid: st.epoch.kid, key: cl.keys.get(st.epoch.kid), commit: c }));
        } else if (choice === 'info-attempt') {
          const c = G.signCommit(G.proposeCommit(st, cl.id.pk, 'info', { name: 'member says' }, 1), cl.id.sign, cl.id.pk);
          log.append(await L.sealLogEntry({ gid: st.gid, kid: st.epoch.kid, key: cl.keys.get(st.epoch.kid), commit: c }));
        }
      } catch (e) {
        if (!/groupState: /.test(e.message)) throw e;   // 本機檢查不過（例如過時的狀態）→ 不送
      }
    }
    // 最後：分岔結束（真的 log 回來），每個人都抓完
    if (split) await endSplit();
    for (const cl of clients.values()) await pull(cl, log);
    entriesTotal += log.entries.length;
    const expected = await reference(owner.rep.view.gid, genesisView, log.entries, allKeys);
    const members = [...clients.values()].filter((cl) => cl.rep.status === 'member');
    assert.ok(members.length >= 1);
    for (const cl of members) {
      assert.equal(cl.rep.waiting, null, `seed ${seed}: ${cl.id.label} is not stuck`);
      assert.equal(canon(cl.rep.view.state), canon(expected.state), `seed ${seed}: ${cl.id.label} = independent log application`);
      for (const other of members) assert.equal(L.compareGossip(cl.rep, L.headGossip(other.rep)), 'same');
    }
    // 不是成員的（被踢、離開）：狀態停在讓他出去的那一筆，而且那一筆在正典鏈上
    for (const cl of [...clients.values()].filter((x) => x.rep.status !== 'member')) {
      assert.ok(expected.chain.some((x) => x.id === cl.rep.view.state.head.id), `seed ${seed}: ${cl.id.label} stopped on the canonical chain`);
    }
    // 成員自己編的 rekey 永遠沒上
    assert.ok(!expected.chain.some((x) => x.c.op === 'rekey' && x.c.args.kc === 'A'.repeat(43)));
  }
  const sk = Object.fromEntries(skipCount);
  assert.ok(sk.stale > 20 && sk['not-admin'] > 5, `stale and rejected entries really occurred: ${JSON.stringify(sk)}`);
  assert.ok(diverged >= 5 && detected >= 5, `genuine splits really happened (${splits} forked views, ${diverged} diverged, ${detected} compared at the same position)`);
  assert.ok(readdsJoined >= 1, `re-added members really joined through log confirmation (${readdsJoined})`);
  console.log(`PASS property: ${SEEDS} random runs (${entriesTotal} log entries, ${rotations} rotations, partial syncs, concurrent submits, garbage, member rekey attempts; skips seen by members: ${JSON.stringify(sk)}; ${splits} server splits, ${diverged} genuinely diverged, all ${detected} compared at the same position detected by head gossip, ${forkInvitesRefused} invites made on a forked view refused, ${readdsJoined} re-added members confirmed with the parent log key) → after the honest log is served and the victim rebuilds, every member equals the independent log application, gossip all "same"`);
}

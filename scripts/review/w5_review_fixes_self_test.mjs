/**
 * W5 獨立審查之後的修正（docs/GROUP_LOG_WIRING_W5.md「審查」）：
 *   1. M1 收端的新鮮度用有上限的時鐘（EngineDeps.receiveNow）：API 回假的 serverTime 撥慢一小時，錄下來的通話開始（一小時前）
 *      在 now（撥慢的）看起來才 30 秒、在 receiveNow（真的）看起來一小時 → 丟掉（stale），不會響
 *   2. S12 只扣不換的伺服器：一個成員報的 head 比我新，抓完 log 伺服器還是說沒有更新的 → logConflict（server-behind-peer）；
 *      伺服器放行、追上之後警告消失；2b（純模組）他說之前就開始的、沒抓完的一輪不算，同一個成員只通知一次，活躍的群也判斷得出來，
 *      追上了但那一號的 id 不一樣 → 分叉（head-differs），不蓋掉更嚴重的警告
 *   1b. 複審：commit／delete（24 小時的窗）照舊看 now —— 手機慢了 25 分鐘的人照樣收得到「為所有人刪除」，通話開始照樣丟
 *   1d. 複審：去重表的過期清理看兩個時鐘裡比較早的（只在一個時鐘下過期的不清，重放照樣擋）
 *   1c. 複審：我封鎖的成員的 sync、帶舊 head 的 here → 我不回 here（不讓他問出我在不在線）；沒封鎖他的人照樣回
 *   3. L1 presence：好友的 share 世代 e 遠在未來（撥偏時鐘的手機產生的）→ 不收；sharesWith 只對拿到我目前秘密的人成立；
 *      複審：我自己的世代是時鐘快很多時產生的 → 下一次換秘密從現在重新算
 *   4. App 接線（原始碼）：receiveNow、通話信令、presence 服務用 mqtt.boundedNow，身分信封的 7 天窗照舊 serverNow；
 *      時鐘差超過上限 → clock-drift 提示；刪好友刪完再比對一次 presence；定時 here 只給看不到我 presence 的人、
 *      群裡有我封鎖的人就不發、封鎖名單還沒載到就不發；回 here 不回封鎖的人
 *      （守護設定只送原生畫面的文字、升級上來的舊格式由原生外掛清掉：官方版才有，在 w5_review_fixes_official_self_test.mjs）
 *   5. 複審：引擎載入本機的群組途中被停掉（換帳號）→ 不再刪資料庫裡的群、不再投影到畫面
 * Run: node scripts/review/w5_review_fixes_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { World, E } from './groupEngineKit.mjs';
import { load, identity, SRC } from './groupStateKit.mjs';

const quiet = console.error;
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT|presence)\]/.test(String(a[0]))) quiet(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

// ── 1. 收端的新鮮度看 receiveNow ──
{
  const world = new World();
  try {
    const [A, B] = await Promise.all(['alice', 'bob'].map((l) => world.phone(l)));
    world.befriend(A, B);
    await A.boot();
    // Bob 的 API 時鐘被撥慢一小時（now），收端的新鮮度用真的（receiveNow）
    await B.boot({ now: () => world.now() - HOUR, receiveNow: () => world.now() });
    const gid = await A.engine.createGroup({ name: 'Clock Group', members: [B.pk] });
    await world.settle();
    const tid = A.tidOf(gid);
    const kid = A.activeKid(gid)[0];
    const key = A.engine.decryptKey(gid, kid);
    assert.ok(tid && key && B.tidOf(gid) === tid, 'both on the same epoch topic');
    const before = B.engine.controlStats()['dropped:stale'] ?? 0;
    // 一小時前錄下來的通話開始（撥慢一小時的時鐘看起來才 30 秒）
    const recorded = await E.CTL.sealControl({ gid, kid, key, sender: A.pk, sign: A.id.sign, t: 'call', body: { action: 'start', video: false }, ts: world.now() - HOUR + 30_000 });
    world.publishControl(A, tid, recorded.envelope, { qos: 1 });
    await world.settle();
    assert.equal((B.engine.controlStats()['dropped:stale'] ?? 0) - before, 1, 'the hour-old call start is stale on the bounded receive clock');
    assert.ok(!B.controls.some((c) => c.t === 'call'), 'and it never reaches the app (nothing rings)');
    // 正常的（現在封的）照收
    const fresh = await E.CTL.sealControl({ gid, kid, key, sender: A.pk, sign: A.id.sign, t: 'call', body: { action: 'start', video: false }, ts: world.now() });
    world.publishControl(A, tid, fresh.envelope, { qos: 1 });
    await world.settle();
    assert.ok(B.controls.some((c) => c.t === 'call'), 'a current call start is still accepted');
    console.log('PASS receive freshness runs on receiveNow: an API clock lie cannot make a recorded call start fresh');
  } finally {
    world.close();
  }
}

// ── 1b. commit／delete 看 now、here／sync／call 看 receiveNow ──
{
  const world = new World();
  try {
    const [A, B] = await Promise.all(['alice', 'bob'].map((l) => world.phone(l)));
    world.befriend(A, B);
    await A.boot();
    // Bob 的手機慢了 25 分鐘：API 校正過的 now 是對的；有上限的 receiveNow 只撥回 5 分鐘 → 比真的慢 20 分鐘
    await B.boot({ receiveNow: () => world.now() - 20 * 60_000 });
    const gid = await A.engine.createGroup({ name: 'Drift Group', members: [B.pk] });
    await world.settle();
    const tid = A.tidOf(gid);
    const kid = A.activeKid(gid)[0];
    const key = A.engine.decryptKey(gid, kid);
    assert.ok(tid && key && B.tidOf(gid) === tid, 'both on the same epoch topic');
    const stale0 = B.engine.controlStats()['dropped:stale'] ?? 0;
    const del = await E.CTL.sealControl({ gid, kid, key, sender: A.pk, sign: A.id.sign, t: 'delete', body: { messageId: 'm-drift-1' }, ts: world.now() });
    world.publishControl(A, tid, del.envelope, { qos: 1 });
    const call = await E.CTL.sealControl({ gid, kid, key, sender: A.pk, sign: A.id.sign, t: 'call', body: { action: 'start', video: false }, ts: world.now() });
    world.publishControl(A, tid, call.envelope, { qos: 1 });
    await world.settle();
    assert.ok(B.controls.some((c) => c.t === 'delete' && c.body.messageId === 'm-drift-1'), 'the delete for everyone reaches the phone whose clock is 25 min slow');
    assert.ok(!B.controls.some((c) => c.t === 'call'), 'the call start is judged on the bounded clock (20 min in its future → dropped)');
    assert.equal((B.engine.controlStats()['dropped:stale'] ?? 0) - stale0, 1, 'exactly the call start was stale');
    console.log('PASS commit/delete are judged on the API-corrected clock (a 25-min-slow phone still applies deletes); here/sync/call on the bounded one');
  } finally {
    world.close();
  }
}

// ── 1d. 去重表的過期清理看兩個時鐘裡比較早的：只在一個時鐘下過期的那一筆不能被清掉（不然重放進來會被當成新的） ──
{
  const world = new World();
  try {
    const [A, B] = await Promise.all(['alice', 'bob'].map((l) => world.phone(l)));
    world.befriend(A, B);
    await A.boot();
    // Bob 的手機慢了 25 分鐘（receiveNow ＝ 真的 − 20 分鐘，now ＝ 真的）
    await B.boot({ receiveNow: () => world.now() - 20 * 60_000 });
    const gid = await A.engine.createGroup({ name: 'Prune Group', members: [B.pk] });
    await world.settle();
    const tid = A.tidOf(gid);
    const kid = A.activeKid(gid)[0];
    const key = A.engine.decryptKey(gid, kid);
    const head = A.engine.gossip(gid);
    const base = world.now() - 22 * 60_000;   // 在 Bob 的 receiveNow 上是 2 分鐘前：新鮮；在 now 上 22 分鐘前
    const seal = (i) => E.CTL.sealControl({ gid, kid, key, sender: A.pk, sign: A.id.sign, t: 'here', body: { head: { seq: head.seq, id: head.id } }, ts: base + i });
    const first = await seal(0);
    world.publishControl(A, tid, first.envelope, { qos: 0 });
    await world.settle();
    for (let i = 1; i <= 128; i++) world.publishControl(A, tid, (await seal(i)).envelope, { qos: 0 });   // 灌滿 Bob 那一份去重表
    await world.settle();
    const r0 = B.engine.controlStats()['dropped:replay'] ?? 0;
    world.publishControl(A, tid, first.envelope, { qos: 0 });   // 重放第一則
    await world.settle();
    assert.equal((B.engine.controlStats()['dropped:replay'] ?? 0) - r0, 1, 'the replayed here is still a replay after the table filled up');
    console.log('PASS the replay table is pruned on the earlier of the two clocks: a here that is only expired on the API clock is not forgotten');
  } finally {
    world.close();
  }
}

// ── 1c. 我封鎖的成員：他的 sync／帶舊 head 的 here 不回 ──
{
  const world = new World();
  try {
    const [A, B, C] = await Promise.all(['alice', 'bob', 'carol'].map((l) => world.phone(l)));
    world.befriend(A, B);
    world.befriend(A, C);
    await A.boot();
    await B.boot();
    await C.boot({ mayReply: (_gid, from) => from !== B.pk });   // Carol 封鎖了 Bob
    const gid = await A.engine.createGroup({ name: 'Blocked Probe', members: [B.pk, C.pk] });
    await world.settle();
    const tid = A.tidOf(gid);
    const kid = A.activeKid(gid)[0];
    const key = A.engine.decryptKey(gid, kid);
    const old = B.engine.gossip(gid);
    assert.equal(await A.engine.updateInfo(gid, { name: 'Blocked Probe 2' }), 'applied');
    await world.settle();
    world.offset += 11_000;   // 過了每個請求者 10 秒一次的回覆限速
    const sent = (p) => p.engine.controlStats()['sent:here'] ?? 0;
    const [a0, c0, r0] = [sent(A), sent(C), C.engine.controlStats()['not-replied:refused'] ?? 0];
    const head = B.engine.gossip(gid);
    const sync = await E.CTL.sealControl({ gid, kid, key, sender: B.pk, sign: B.id.sign, t: 'sync', body: { have: { seq: head.seq, id: head.id } }, ts: world.now() });
    world.publishControl(B, tid, sync.envelope, { qos: 0 });
    await world.settle();
    await sleep(30);
    await world.settle();
    assert.ok(sent(A) > a0, 'Alice answers Bob\'s sync');
    assert.equal(sent(C) - c0, 0, 'Carol does not answer the sync of the member she blocked');
    assert.ok((C.engine.controlStats()['not-replied:refused'] ?? 0) > r0, 'counted as refused');
    world.offset += 11_000;
    const [a1, c1] = [sent(A), sent(C)];
    const here = await E.CTL.sealControl({ gid, kid, key, sender: B.pk, sign: B.id.sign, t: 'here', body: { head: { seq: old.seq, id: old.id } }, ts: world.now() });
    world.publishControl(B, tid, here.envelope, { qos: 0 });
    await world.settle();
    await sleep(30);
    await world.settle();
    assert.ok(sent(A) > a1, 'Alice answers a here with an older head (they-are-behind)');
    assert.equal(sent(C) - c1, 0, 'Carol does not, for the member she blocked');
    console.log('PASS a blocked co-member gets no here back for his sync or his older-head here; others still answer');
  } finally {
    world.close();
  }
}

// ── 2. 伺服器只扣不換 → server-behind-peer ──
{
  const world = new World();
  try {
    const [A, C] = await Promise.all(['alice', 'carol'].map((l) => world.phone(l)));
    world.befriend(A, C);
    await A.boot();
    await C.boot();
    const gid = await A.engine.createGroup({ name: 'Withhold Group', members: [C.pk] });
    await world.settle();
    const cutoff = C.engine.gossip(gid).seq;
    let withholding = true;
    world.fetchFilter = (phone, g, entries) => (withholding && phone === C && g === gid ? entries.filter((e) => e.seq <= cutoff) : entries);
    assert.equal(await A.engine.updateInfo(gid, { name: 'Renamed' }), 'applied');
    await world.settle();
    await sleep(2_500);   // 同一個群兩次同步至少隔 minSyncIntervalMs（kit 給 0）、debounce 300 ms
    await world.settle();
    assert.equal(C.groups.get(gid)?.name, 'Withhold Group', 'Carol never got the rename (the server withholds it)');
    assert.ok(C.conflictSeen.has(gid), 'Carol shows the log warning: Alice reports a later head, the server says there is nothing newer');
    assert.ok(C.notices.some((n) => n.kind === 'conflict' && n.reason === 'server-behind-peer'), JSON.stringify(C.notices.slice(-5)));
    withholding = false;
    A.engine.announce();   // Alice 的 here（head）→ Carol 去抓
    await world.settle();
    await sleep(2_500);
    await world.settle();
    assert.equal(C.groups.get(gid)?.name, 'Renamed', 'once the server serves it Carol catches up');
    assert.ok(!C.groups.get(gid)?.logConflict, 'and the warning clears');
    console.log('PASS a server that withholds log entries from one member is flagged (server-behind-peer) and the flag clears after catching up');
  } finally {
    world.close();
  }
}

// ── 2b. server-behind-peer 的條件（純模組 groupEngineGossip）：他說了之後才開始、抓完的一輪才算；同一個成員只通知一次；
//        活躍的群一直有新的 head 也照樣判斷得出來；追上了那一號但 id 不一樣 → 分叉（head-differs）不是清掉；不蓋掉更嚴重的警告 ──
{
  const G = await load('groupEngineGossip');
  const notices = [];
  const host = {
    deps: { now: () => 1_000 }, runtimes: new Map(), queue: async () => undefined, logDeps: async () => ({}), absorb: async () => [],
    perform: async () => false, trailingActions: () => [], settle: async () => undefined, notice: (n) => notices.push(n),
    project: () => undefined, requestSync: () => undefined, isStopped: () => false,
  };
  const gossip = G.createGossip(host);
  const [P, Q, R] = ['w5-peer-p', 'w5-peer-q', 'w5-peer-r'].map((l) => identity(l).pk);
  const id = (c) => c.repeat(64);
  const rt = {
    gid: 'G'.repeat(22), gone: false, conflicts: new Map(), behindPeers: new Map(), syncRound: 3,
    rep: { status: 'member', processedSeq: 5, headSeq: 5, firstSeq: 1, appliedAt: { 5: id('a') },
      view: { state: { members: [{ pk: P }, { pk: Q }, { pk: R }], head: { id: id('a') } } } },
  };
  const sbp = () => notices.filter((n) => n.reason === 'server-behind-peer').length;
  assert.equal(gossip.verdict(rt, { seq: 7, id: id('b') }, P), 'i-am-behind', 'P reports a later head while round 3 is running');
  gossip.checkBehind(rt, true, 3);
  assert.equal(rt.conflicts.size, 0, 'round 3 started before P spoke: not evidence');
  rt.syncRound = 4;
  assert.equal(gossip.verdict(rt, { seq: 8, id: id('c') }, P), 'i-am-behind', 'an active group: P reports an even later head during round 4');
  gossip.checkBehind(rt, false, 4);
  assert.equal(rt.conflicts.size, 0, 'an incomplete round (more pages / waiting for a key) is not evidence');
  gossip.checkBehind(rt, true, 4);
  assert.equal(rt.conflicts.get(P)?.reason, 'server-behind-peer', 'round 4 started after P first spoke and is still behind seq 7 → flagged (a newer head does not reset the wait)');
  gossip.checkBehind(rt, true, 5);
  assert.equal(sbp(), 1, 'one notice per member, not one per round');
  // 追上 7 號、跟 P 說的一樣 → 清掉
  Object.assign(rt.rep, { processedSeq: 7, headSeq: 7, appliedAt: { 5: id('a'), 7: id('b') } });
  rt.rep.view.state.head = { id: id('b') };
  gossip.checkBehind(rt, true, 6);
  assert.ok(!rt.conflicts.has(P) && !rt.behindPeers.has(P), 'caught up with what P said → flag and record gone');
  // Q：說 9 號是 X；伺服器之後給我的 9 號是 Y → 分叉，不是「追上了」
  assert.equal(gossip.verdict(rt, { seq: 9, id: id('d') }, Q), 'i-am-behind');
  Object.assign(rt.rep, { processedSeq: 9, headSeq: 9, appliedAt: { 5: id('a'), 7: id('b'), 9: id('e') } });
  rt.rep.view.state.head = { id: id('e') };
  gossip.checkBehind(rt, true, 7);
  assert.equal(rt.conflicts.get(Q)?.reason, 'head-differs', 'my seq 9 is not the one Q reported → a fork stays flagged');
  // R：已經有更嚴重的警告；他又說他比我新、這一輪也還是比他舊 → 不蓋掉、不另外通知
  rt.conflicts.set(R, { reason: 'peer-disagrees', head: { seq: 9, id: id('f') } });
  const before = sbp();
  rt.syncRound = 8;
  assert.equal(gossip.verdict(rt, { seq: 12, id: id('f') }, R), 'i-am-behind');
  gossip.checkBehind(rt, true, 9);
  assert.equal(rt.conflicts.get(R)?.reason, 'peer-disagrees', 'a stronger warning is not overwritten by server-behind-peer');
  assert.equal(sbp(), before, 'and no extra notice');
  console.log('PASS server-behind-peer: needs a complete round started after the first report, one notice, survives an active group; a fork on catch-up stays flagged; never overwrites a stronger warning');
}

// ── 3. presence：遠在未來的世代不收；sharesWith ──
{
  const S = await load('presenceService');
  const P = await load('presenceSecret');
  const me = identity('w5-me');
  const F = identity('w5-friend');
  let saved = null;
  const sent = [];
  const nowMs = 1_800_000_000_000;
  const svc = S.createPresenceService({
    me: me.pk, now: () => nowMs,
    store: { load: async () => saved, save: async (_m, d) => { saved = JSON.parse(JSON.stringify(d)); } },
    sendSealed: async (to, body) => { sent.push({ to, body }); return true; },
    friends: () => [F.pk], isFriend: async (pk) => pk === F.pk, blocked: async () => new Set(),
    onScope: () => {}, clearRetained: async () => true, connected: () => true, log: () => {},
  });
  await svc.start();
  assert.equal(svc.sharesWith(F.pk), true, 'sharesWith: the friend holds my current secret');
  assert.equal(svc.sharesWith(identity('w5-x').pk), false, 'sharesWith: nobody else');
  const seal = () => ({ v: 1, from: F.pk, to: me.pk, iat: nowMs, nonce: crypto.randomBytes(16).toString('base64') });
  const far = { s: new Uint8Array(crypto.randomBytes(32)), e: Math.floor(nowMs / 1000) + 2 * 86_400 };
  assert.equal(await svc.onSealed(F.pk, { ...P.shareBody(far), ...seal() }), 'ignored', 'a share from two days in the future is refused');
  assert.equal(svc.stats()['share-future-epoch'], 1);
  const ok = { s: new Uint8Array(crypto.randomBytes(32)), e: Math.floor(nowMs / 1000) };
  assert.equal(await svc.onSealed(F.pk, { ...P.shareBody(ok), ...seal() }), 'share', 'a share of the current epoch is taken');
  svc.stop();
  assert.equal(svc.sharesWith(F.pk), false, 'a stopped service shares with nobody');
  // 我自己的秘密是在時鐘快了 10 天的時候產生的（e 遠在未來，好友都拒收）；時鐘修好之後換秘密 → 從現在重新算，不是舊的 + 1
  let saved2 = null;
  let clock = nowMs + 10 * 86_400_000;
  let friends = [F.pk];
  const mk = () => S.createPresenceService({
    me: me.pk, now: () => clock,
    store: { load: async () => saved2, save: async (_m, d) => { saved2 = JSON.parse(JSON.stringify(d)); } },
    sendSealed: async () => true, friends: () => friends, isFriend: async (pk) => friends.includes(pk), blocked: async () => new Set(),
    onScope: () => {}, clearRetained: async () => true, connected: () => true, log: () => {},
  });
  const skewed = mk();
  await skewed.start();
  const farE = saved2?.self?.e;
  assert.ok(farE > Math.floor(nowMs / 1000) + 9 * 86_400, `the first secret got a far-future epoch (${farE})`);
  skewed.stop();
  clock = nowMs;
  friends = [];
  const fixed = mk();
  await fixed.start();
  await fixed.reconcile();
  const newE = Math.max(saved2?.self?.e ?? 0, saved2?.next?.e ?? 0);
  assert.ok(saved2?.self?.e !== farE || saved2?.next, 'the unfriend rotated the secret');
  assert.ok(newE <= Math.floor(nowMs / 1000) + 60, `the new epoch restarts from now (${newE}), not from the far-future one + 1`);
  fixed.stop();
  console.log('PASS presence: a share epoch far in the future is refused; sharesWith follows my current secret; a far-future own epoch restarts from now');
}

// ── 4. App 接線（原始碼） ──
const app = readFileSync(SRC + '/providers/AppProvider.tsx', 'utf8');
const engineDeps = app.slice(app.indexOf('const engine = createGroupEngine({'), app.indexOf('setGroupEngine(engine);'));
assert.match(engineDeps, /receiveNow: \(\) => mqttService\.boundedNow\(\),/, 'the engine judges incoming here/sync/call freshness on the bounded clock');
assert.match(engineDeps, /now: \(\) => mqttService\.serverNow\(\),/, 'and still stamps outgoing messages with the corrected server clock');
assert.match(app, /groupCallService\.handleSignal\(opened\.from, opened\.body, mqttService\.boundedNow\(\)\);/, 'call signals: bounded clock');
assert.match(engineDeps, /needsHere: \(_gid, members\) => \{\s*const blocked = blockedNow;\s*return blocked !== null && !members\.some\(\(pk\) => blocked\.has\(pk\)\)\s*&& members\.some\(\(pk\) => pk !== me && !\(presenceRef\.current\?\.sharesWith\(pk\) \?\? false\)\);\s*\},/,
  'periodic here: only for members who cannot see my presence (an open channel does not count); never in a group with someone I blocked or before the list is loaded');
assert.match(engineDeps, /answerHere: \(_gid, from\) => from !== me && notBlocked\(from\) && !useChatStore\.getState\(\)\.getFriendByPublicKey\(from\)/, 'no here answer to a blocked member');
assert.match(engineDeps, /mayReply: \(_gid, from\) => notBlocked\(from\),/, 'no sync / older-head reply to a blocked member');
assert.match(app, /const notBlocked = \(pk: string\): boolean => blockedNow !== null && !blockedNow\.has\(pk\);/, 'an unknown blocked list (not loaded / failed) blocks everyone');
assert.match(app, /if \(!engineGone && n === blockedLoad\) blockedNow = new Set\(/, 'overlapping reloads: only the latest one counts');
const presenceEffect = app.slice(app.indexOf('const service = createPresenceService({'), app.indexOf('presenceRef.current = service;'));
assert.match(presenceEffect, /now: \(\) => mqttService\.boundedNow\(\),/, 'the presence service runs on the bounded clock');
assert.match(app, /const offRemoved = onFriendRemoved\(reconcile\);/, 'presence re-checks after a friend is fully removed');
assert.match(app, /offRemoved\(\);/, 'and unsubscribes on cleanup');
const store = readFileSync(SRC + '/stores/chatStore.ts', 'utf8');
const removeFriend = store.slice(store.indexOf('removeFriend: async (friendId) => {'), store.indexOf('getFriendByPublicKey: (publicKey) =>'));
assert.ok(removeFriend.indexOf('await storage.removeContact(friend.publicKey);') < removeFriend.indexOf('for (const cb of friendRemovedListeners)'),
  'the friend-removed listeners run after the contact row is deleted');
const seal = readFileSync(SRC + '/services/groupKeyDelivery.ts', 'utf8');
assert.match(seal, /kindLimits: KIND_LIMITS, now: mqttService\.serverNow\(\) \},\n      x25519,/, 'the 7-day envelope window stays on the API-corrected clock (invites/keys reach a phone with a wrong clock)');
const mq = readFileSync(SRC + '/services/mqtt.ts', 'utf8');
assert.match(mq, /boundedNow\(\): number \{\n    return presenceClock\(Date\.now\(\), this\._clockOffsetMs\);/, 'boundedNow = device clock + the capped API offset');
assert.match(mq, /MqttService\.notice\(\{ kind: 'clock-ok' \}\);\n      \}\n      this\._noteClockDrift\(\);/, 'every token checks the clock drift');
assert.match(mq, /const drift = Math\.abs\(this\._clockOffsetMs\) > PRESENCE_MAX_CLOCK_SKEW_MS;/, 'drift = offset beyond the bounded clock\'s cap');
const banner = readFileSync(SRC + '/components/common/ConnectionNotice.tsx', 'utf8');
assert.match(banner, /case 'clock-drift':/, 'the banner shows the drift');
console.log('PASS App wiring: bounded clocks on the short-window checks, clock-drift notice, friend-removed re-check, periodic here and reply rules');

// ── 5. 載入本機的群組途中被停掉 → 不刪、不投影 ──
{
  const world = new World();
  try {
    const P = await world.phone('paul');
    const run = async (stopEarly) => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const deleted = [];
      const projected = [];
      const bad = { meta: { gid: 'B'.repeat(22), headId: 'a'.repeat(64), headV: 0 }, rows: [], keys: [], pending: [] };
      const store = {
        cleanupOrphans: async () => undefined, loadGroupLogs: () => gate.then(() => [bad]),
        deleteGroupLog: async (gid) => { deleted.push(gid); }, persistGroupLog: async () => undefined,
      };
      const engine = E.createGroupEngine(P.deps({ store, project: (gid, g) => projected.push([gid, g]), onTopics: () => undefined }));
      const started = engine.start();
      if (stopEarly) engine.stop();
      release();
      await started.catch(() => undefined);
      await sleep(20);
      if (!stopEarly) engine.stop();
      return { deleted, projected };
    };
    const control = await run(false);
    assert.deepEqual([control.deleted, control.projected.map(([g, v]) => [g, v])], [['B'.repeat(22)], [['B'.repeat(22), null]]],
      'control: a stored chain that does not verify is dropped and removed from the screen');
    const stopped = await run(true);
    assert.deepEqual([stopped.deleted, stopped.projected], [[], []], 'stopped while loading (account switch): nothing deleted, nothing projected');
    // 真的鏈、位置記的 head 對不上（→ 會被刪）；第一次驗簽章的時候就被停掉 → 驗完也不刪、不投影
    const Q = await world.phone('quinn');
    world.befriend(P, Q);
    await P.boot();
    await Q.boot();
    const gid = await P.engine.createGroup({ name: 'Stored Group', members: [Q.pk] });
    await world.settle();
    P.shutdown();
    const stored = (await P.store.loadGroupLogs(P.pk)).filter((x) => x.meta.gid === gid).map((x) => ({ ...x, meta: { ...x.meta, headId: 'f'.repeat(64) } }));
    assert.equal(stored.length, 1, 'the group is stored');
    const midVerify = async (stopInVerify) => {
      const deleted = [];
      const projected = [];
      let engine = null;
      let stoppedOnce = false;
      const verify = P.deps().verify;
      const store = {
        cleanupOrphans: async () => undefined, loadGroupLogs: async () => stored,
        deleteGroupLog: async (g) => { deleted.push(g); }, persistGroupLog: async () => undefined,
      };
      engine = E.createGroupEngine(P.deps({
        store, project: (g, v) => projected.push([g, v]), onTopics: () => undefined,
        verify: (...a) => { if (stopInVerify && !stoppedOnce) { stoppedOnce = true; engine.stop(); } return verify(...a); },
      }));
      await engine.start().catch(() => undefined);
      await sleep(20);
      engine.stop();
      return { deleted, projected, stoppedOnce };
    };
    const ctl = await midVerify(false);
    assert.deepEqual(ctl.deleted, [gid], 'control: the stored chain whose head does not match is dropped');
    const mid = await midVerify(true);
    assert.ok(mid.stoppedOnce, 'the engine was stopped inside the chain verification');
    assert.deepEqual([mid.deleted, mid.projected], [[], []], 'stopped during verification: the stored group is neither deleted nor projected');
    console.log('PASS an engine stopped while loading stored groups (before or during chain verification) deletes and projects nothing');
  } finally {
    world.close();
  }
}
process.exit(0);

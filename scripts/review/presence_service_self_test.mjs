/**
 * 好友之間的秘密 presence 服務（W4）：真的 services/presenceService.ts＋presenceSecret.ts，假的存檔／信封／好友名單／mqtt。
 *   1. 第一次：產生秘密、封給每個好友（不封給同群組但不是好友的人）、跟每個好友要他的；範圍只有我的 tag（還沒有好友的主題）
 *   2. 好友寄來的 share 才收（陌生人、同群組的非好友、封鎖的不收）；重放的舊 share 不換；收下後範圍多一個確切的好友主題
 *   3. 新好友 → 只封給他（已經拿過的不重封）
 *   4. 刪好友 → 換秘密：先不在舊主題發東西（seal → null）、連上且清掉舊主題的 retained（PUBACK）之後才換上新的 tag、
 *      只封給剩下的好友；他的秘密也丟掉（範圍不再有他的主題）。前好友拿舊的 S 推不出新主題、解不開新的狀態，跟我要也不給
 *   5. 清不掉（沒有 PUBACK）→ 不換、也不封，下次連上再試
 *   6. 封鎖 → 一樣換；30 天 → 一樣換（timer）
 *   7. request：只回現在的好友、每人限速；換秘密的中途不回
 *   8. 重開：存檔還原（同一個 tag、不重封、換到一半的繼續換）；好友名單一時是空的不會誤換
 *   9. 好友的主題被清掉（空 retained）→ 跟他要（限速）；他寄 share 而我還沒封給他 → 回封
 *  10. 160 個好友：範圍最多 150 個主題；換秘密時每個剩下的好友剛好一封
 * Run: node scripts/review/presence_service_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { load, identity } from './groupStateKit.mjs';

const S = await load('presenceService');
const P = await load('presenceSecret');

const me = identity('svc-me');
const B = identity('svc-bob');
const C = identity('svc-carol');
const D = identity('svc-dave');
const X = identity('svc-stranger');      // 同群組、不是好友
const DAY = 24 * 3_600_000;
const sealFields = (from) => ({ v: 1, from, to: me.pk, iat: Date.now(), nonce: crypto.randomBytes(16).toString('base64') });

function world({ friends = [B.pk, C.pk], connected = true } = {}) {
  const w = {
    now: 1_800_000_000_000,
    friends: [...friends],
    dbFriends: null,          // isFriend 查「資料庫」用；null ＝ 跟 friends 一樣
    blocked: new Set(),
    connected,
    clearOk: true,
    saved: null,
    sent: [],
    scopes: [],
    cleared: [],
  };
  w.deps = {
    me: me.pk,
    now: () => w.now,
    store: { load: async () => (w.saved ? JSON.parse(JSON.stringify(w.saved)) : null), save: async (_me, d) => { w.saved = JSON.parse(JSON.stringify(d)); } },
    sendSealed: async (to, body) => { w.sent.push({ to, body }); return true; },
    friends: () => w.friends,
    isFriend: async (pk) => (w.dbFriends ?? w.friends).includes(pk),
    blocked: async () => w.blocked,
    onScope: (s) => w.scopes.push(s),
    clearRetained: async (topic) => { w.cleared.push(topic); return w.clearOk; },
    connected: () => w.connected,
    log: () => {},
  };
  w.svc = S.createPresenceService(w.deps);
  w.scope = () => w.svc.scope();
  w.sharesTo = () => w.sent.filter((m) => 's' in m.body).map((m) => m.to);
  w.requestsTo = () => w.sent.filter((m) => 'have' in m.body).map((m) => m.to);
  return w;
}
const secretOf = (body) => ({ s: new Uint8Array(Buffer.from(body.s, 'base64')), e: body.e });
const shareFrom = (who, secret) => ({ ...P.shareBody(secret), ...sealFields(who.pk) });
const reqFrom = (who, have = 0) => ({ ...P.requestBody(have), ...sealFields(who.pk) });
const fresh = (e = 1_800_000_000) => ({ s: new Uint8Array(crypto.randomBytes(32)), e });

// ── 1. 第一次 ──
const w = world();
await w.svc.start();
assert.ok(w.svc.isReady());
assert.deepEqual(w.sharesTo().sort(), [B.pk, C.pk].sort(), 'my secret goes to each friend once');
assert.deepEqual(w.requestsTo().sort(), [B.pk, C.pk].sort(), 'and I ask each friend for theirs');
const first = secretOf(w.sent.find((m) => 's' in m.body).body);
assert.ok(w.sent.filter((m) => 's' in m.body).every((m) => m.body.s === w.sent.find((x) => 's' in x.body).body.s), 'the same secret to everyone');
assert.equal(w.scope().tag, await P.presenceTag(first), 'scope carries my tag');
assert.deepEqual(w.scope().topics, [], 'no friend topics yet');
assert.ok(!w.sent.some((m) => m.to === X.pk), 'nothing for a non-friend co-member');
console.log('PASS first start: secret created, sealed to each friend only, requests sent, scope = my tag');

// ── 2. 收好友的 share ──
const bSec = fresh(1_800_000_100);
assert.equal(await w.svc.onSealed(B.pk, shareFrom(B, bSec)), 'share');
const bTopic = P.presenceTopic(B.pk, await P.presenceTag(bSec));
assert.deepEqual(w.scope().topics, [bTopic], 'B\'s exact topic is now in scope');
assert.equal(await w.svc.onSealed(B.pk, shareFrom(B, { s: bSec.s, e: bSec.e - 1 })), 'ignored', 'replayed older share refused');
assert.equal(await w.svc.onSealed(X.pk, shareFrom(X, fresh())), 'ignored', 'a non-friend co-member\'s share is not taken');
w.blocked.add(C.pk);
assert.equal(await w.svc.onSealed(C.pk, shareFrom(C, fresh())), 'ignored', 'a blocked friend\'s share is not taken');
w.blocked.delete(C.pk);
assert.equal(await w.svc.onSealed(B.pk, { ...shareFrom(B, fresh(1_900_000_000)), extra: 1 }), 'ignored', 'malformed share');
assert.deepEqual(w.scope().topics, [bTopic]);
// codec.open：B 封的才解得開，主題要是 B 目前那一個
const onState = { on: 1, ts: w.now, cs: w.now };
const bEnv = JSON.stringify(await P.sealPresence({ secret: bSec, topic: bTopic, state: onState }));
assert.deepEqual(await w.svc.codec.open(bTopic, bEnv), { owner: B.pk, state: onState });
const oldTag = P.presenceTopic(B.pk, await P.presenceTag({ s: bSec.s, e: bSec.e - 1 }));
assert.equal(await w.svc.codec.open(oldTag, bEnv), null, 'another topic of B → not opened');
const xSec = fresh();
const xTopic = P.presenceTopic(X.pk, await P.presenceTag(xSec));
assert.equal(await w.svc.codec.open(xTopic, JSON.stringify(await P.sealPresence({ secret: xSec, topic: xTopic, state: onState }))), null, 'a non-friend\'s presence is never opened');
console.log('PASS only friends\' shares are taken (not strangers, co-members, blocked); replays refused; scope gets the exact friend topic');

// ── 3. 新好友 ──
w.sent.length = 0;
w.friends.push(D.pk);
await w.svc.reconcile();
assert.deepEqual(w.sharesTo(), [D.pk], 'only the new friend gets my secret');
assert.deepEqual(w.requestsTo(), [D.pk], 'and only the new friend is asked (C was asked moments ago)');
console.log('PASS a new friend gets the current secret; nobody is re-sealed');

// ── 4. 刪好友 → 換秘密 ──
const cSec = fresh(1_800_000_200);
await w.svc.onSealed(C.pk, shareFrom(C, cSec));
const cTopic = P.presenceTopic(C.pk, await P.presenceTag(cSec));
assert.ok(w.scope().topics.includes(cTopic), 'C is a friend: his topic is in scope');
const myTopicBefore = P.presenceTopic(me.pk, w.scope().tag);
w.connected = false;
w.sent.length = 0;
w.friends = w.friends.filter((pk) => pk !== C.pk);
await w.svc.reconcile();
assert.equal(w.scope().tag, await P.presenceTag(first), 'offline: the tag does not change yet');
assert.ok(!w.scope().topics.includes(cTopic), 'the ex-friend\'s secret is dropped at once (his topic leaves the scope)');
assert.equal(await w.svc.codec.seal(myTopicBefore, { on: 1, ts: w.now, cs: w.now }), null, 'pending rotation: nothing more on the old topic (no online, no will)');
assert.deepEqual(w.cleared, [], 'cannot clear while offline');
assert.deepEqual(w.sharesTo(), [], 'nothing re-sealed before the old topic is cleared');
w.connected = true;
await w.svc.onConnected();
assert.deepEqual(w.cleared, [myTopicBefore], 'connected: the old topic is cleared first (empty retained)');
const newTag = w.scope().tag;
assert.notEqual(newTag, await P.presenceTag(first), 'then the new tag is used');
assert.deepEqual(w.sharesTo().sort(), [B.pk, D.pk].sort(), 'the new secret goes to the remaining friends only (one each)');
assert.ok(!w.sent.some((m) => m.to === C.pk), 'nothing for the ex-friend');
const second = secretOf(w.sent.find((m) => 's' in m.body).body);
assert.ok(second.e > first.e, 'epoch grows');
assert.equal(newTag, await P.presenceTag(second));
const myTopicAfter = P.presenceTopic(me.pk, newTag);
const sealedNew = await w.svc.codec.seal(myTopicAfter, { on: 1, ts: w.now, cs: w.now });
assert.ok(sealedNew, 'online is published on the new topic');
assert.equal(await w.svc.codec.seal(myTopicBefore, { on: 1, ts: w.now, cs: w.now }), null, 'never again on the old one');
// 前好友 C 手上只有舊的 S：推不出新主題，也解不開
assert.notEqual(P.presenceTopic(me.pk, await P.presenceTag({ s: first.s, e: first.e + 1 })), myTopicAfter, 'the old S cannot derive the new topic (new S, not just e+1)');
await assert.rejects(P.openPresence({ secret: first, topic: myTopicAfter, payload: sealedNew }), /does not belong|cannot decrypt/, 'the ex-friend cannot open the new state');
assert.equal(await w.svc.onSealed(C.pk, reqFrom(C, first.e)), 'ignored', 'the ex-friend asking for the new secret gets nothing');
assert.ok(!w.sent.some((m) => m.to === C.pk));
console.log('PASS unfriend: old topic cleared before the switch, nothing on it meanwhile, new secret only to remaining friends; the ex-friend can neither derive, open nor request it');

// ── 5. 清不掉 → 不換 ──
w.sent.length = 0; w.cleared.length = 0;
w.clearOk = false;
w.friends = w.friends.filter((pk) => pk !== D.pk);
await w.svc.reconcile();
assert.equal(w.cleared.length, 1, 'tried to clear');
assert.equal(w.scope().tag, newTag, 'no PUBACK → the tag stays');
assert.deepEqual(w.sharesTo(), [], 'and nothing is sealed');
w.clearOk = true;
await w.svc.onConnected();
assert.notEqual(w.scope().tag, newTag, 'next connect: cleared and switched');
assert.deepEqual(w.sharesTo(), [B.pk]);
console.log('PASS a clear that is not confirmed keeps the rotation pending (retried on the next connect)');

// ── 6. 封鎖、30 天 ──
const w6 = world({ friends: [B.pk, C.pk, D.pk] });
await w6.svc.start();
const tag6 = w6.scope().tag;
w6.sent.length = 0;
w6.blocked.add(B.pk);
await w6.svc.reconcile();
assert.notEqual(w6.scope().tag, tag6, 'blocking a friend rotates');
assert.deepEqual(w6.sharesTo().sort(), [C.pk, D.pk].sort(), 'the blocked friend gets nothing');
const tag6b = w6.scope().tag;
w6.sent.length = 0;
w6.now += 29 * DAY;
await w6.svc.reconcile();
assert.equal(w6.scope().tag, tag6b, '29 days: no rotation');
w6.now += 1 * DAY;
await w6.svc.reconcile();
assert.notEqual(w6.scope().tag, tag6b, '30 days: rotated');
assert.equal(w6.cleared.length, 2, 'the old topic was cleared each time');
assert.deepEqual(w6.sharesTo().sort(), [C.pk, D.pk].sort(), 'timer rotation re-seals to everyone current');
console.log('PASS block and the 30-day timer rotate the same way (old topic cleared, current friends re-sealed)');

// ── 7. request ──
w6.sent.length = 0;
assert.equal(await w6.svc.onSealed(C.pk, reqFrom(C)), 'request');
assert.deepEqual(w6.sharesTo(), [C.pk], 'a friend asking gets the current secret');
assert.equal(await w6.svc.onSealed(C.pk, reqFrom(C)), 'ignored', 'rate-limited');
w6.now += 61_000;
assert.equal(await w6.svc.onSealed(C.pk, reqFrom(C)), 'request', 'answered again after a minute');
assert.equal(await w6.svc.onSealed(X.pk, reqFrom(X)), 'ignored', 'a non-friend asking gets nothing');
assert.equal(await w6.svc.onSealed(B.pk, reqFrom(B)), 'ignored', 'a blocked friend asking gets nothing');
console.log('PASS requests are answered for current friends only, rate-limited');

// ── 8. 重開 ──
const w8 = world({ friends: [B.pk, C.pk] });
await w8.svc.start();
await w8.svc.onSealed(B.pk, shareFrom(B, bSec));
const tag8 = w8.scope().tag;
const topics8 = w8.scope().topics;
const saved = w8.saved;
const w8b = world({ friends: [B.pk, C.pk] });
w8b.saved = saved;
await w8b.svc.start();
assert.equal(w8b.scope().tag, tag8, 'same tag after a restart');
assert.deepEqual(w8b.scope().topics, topics8, 'friend secrets restored');
assert.deepEqual(w8b.sharesTo(), [], 'nothing re-sealed after a restart');
// 好友名單一時載到 0 筆（chatStore readiness race）：資料庫還有他們 → 不換
w8b.friends = [];
w8b.dbFriends = [B.pk, C.pk];
await w8b.svc.reconcile();
assert.equal(w8b.scope().tag, tag8, 'an empty friends list that the database contradicts does not rotate');
// 換到一半重開：next 還在，連上就清舊的、換上
w8b.friends = [B.pk]; w8b.dbFriends = null; w8b.connected = false;
await w8b.svc.reconcile();
const w8c = world({ friends: [B.pk], connected: true });
w8c.saved = w8b.saved;
await w8c.svc.start();
assert.equal(w8c.cleared.length, 1, 'a pending rotation survives a restart and completes on connect');
assert.notEqual(w8c.scope().tag, tag8);
assert.deepEqual(w8c.sharesTo(), [B.pk]);
console.log('PASS restart: state restored (same tag, no re-seal), an empty list does not rotate, a pending rotation completes');

// ── 9. 好友的主題被清掉 → 跟他要；他寄 share、我還沒封給他 → 回封 ──
const w9 = world({ friends: [B.pk] });
await w9.svc.start();
await w9.svc.onSealed(B.pk, shareFrom(B, bSec));
w9.sent.length = 0;
assert.equal(w9.svc.codec.cleared(P.presenceTopic(B.pk, 'Z'.repeat(22))), false, 'an empty message on an old topic of his is not "his topic was cleared" (review W4 #8)');
assert.equal(w9.svc.codec.cleared(bTopic), true, 'his current topic is');
await w9.svc.reconcile();
assert.deepEqual(w9.requestsTo(), [B.pk], 'cleared topic of a friend → ask him');
w9.sent.length = 0;
w9.svc.codec.cleared(bTopic);
await w9.svc.reconcile();
assert.deepEqual(w9.requestsTo(), [], 'rate-limited');
w9.svc.codec.cleared(xTopic);
await w9.svc.reconcile();
assert.ok(!w9.sent.some((m) => m.to === X.pk), 'a non-friend topic is ignored');
const w9b = world({ friends: [] });
await w9b.svc.start();
w9b.friends = [B.pk];       // B 剛加我：我還沒 reconcile 前他的 share 先到
assert.equal(await w9b.svc.onSealed(B.pk, shareFrom(B, bSec)), 'share');
assert.deepEqual(w9b.sharesTo(), [B.pk], 'his share arrived first → mine goes back at once');
console.log('PASS a cleared friend topic triggers a (rate-limited) request; a share from a friend I have not sealed to is answered');

// ── 10. 160 個好友 ──
const many = Array.from({ length: 160 }, (_, i) => identity(`svc-many-${i}`));
const w10 = world({ friends: many.map((f) => f.pk) });
await w10.svc.start();
for (const f of many) await w10.svc.onSealed(f.pk, shareFrom(f, fresh()));
assert.equal(w10.scope().topics.length, 150, 'at most 150 friend topics in the token scope');
assert.ok(w10.scope().topics.every((t) => P.isPresenceTopic(t)), 'all exact topics');
w10.sent.length = 0;
w10.friends = w10.friends.slice(1);
await w10.svc.reconcile();
const shares = w10.sharesTo();
assert.equal(shares.length, 159, 'one sealed share per remaining friend');
assert.equal(new Set(shares).size, 159, 'no duplicates');
assert.ok(!shares.includes(many[0].pk), 'not to the removed one');
console.log('PASS 160 friends: scope capped at 150 exact topics; a rotation seals exactly one share per remaining friend');

// ── 12. 好友一直換秘密（逼我一直換 token）：10 分鐘最多換一次，除非是我要的、或他的主題剛清掉；同一代兩份 → 晚封的勝出 ──
{
  const w12 = world({ friends: [B.pk] });
  await w12.svc.start();
  const shareAt = (secret, iat) => ({ ...P.shareBody(secret), ...sealFields(B.pk), iat });
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(fresh(1_800_000_100), 1000)), 'share');
  const t1 = w12.scope().topics[0];
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(fresh(1_800_000_101), 1001)), 'ignored', 'a second change within 10 minutes is refused');
  assert.deepEqual(w12.scope().topics, [t1], 'scope unchanged (no token swap)');
  w12.now += 10 * 60_000;
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(fresh(1_800_000_102), 1002)), 'share', 'after 10 minutes it is taken');
  const t2 = w12.scope().topics[0];
  w12.svc.codec.cleared(t2);                                   // 他目前的主題被清掉（他剛換秘密）
  await w12.svc.reconcile();
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(fresh(1_800_000_103), 1003)), 'share', 'right after his topic was cleared it is taken at once');
  // 同一代、不同秘密：晚封的勝出、早封的不換
  const sameE = fresh(1_800_000_104);
  w12.now += 10 * 60_000;
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(sameE, 2000)), 'share');
  w12.now += 10 * 60_000;
  assert.equal(await w12.svc.onSealed(B.pk, shareAt({ s: new Uint8Array(crypto.randomBytes(32)), e: sameE.e }, 1999)), 'ignored', 'an earlier-sealed secret of the same epoch does not win');
  const winner = { s: new Uint8Array(crypto.randomBytes(32)), e: sameE.e };
  assert.equal(await w12.svc.onSealed(B.pk, shareAt(winner, 2001)), 'share', 'a later-sealed one does');
  assert.deepEqual(w12.scope().topics, [P.presenceTopic(B.pk, await P.presenceTag(winner))]);
  console.log('PASS share changes are rate-limited per friend (unless asked for or after a clear); the later-sealed secret of an epoch wins');
}

// ── 13. 訂了好友目前的主題 10 分鐘什麼都沒收到（他換秘密時那一封弄丟了）→ 跟他要 ──
{
  const w13 = world({ friends: [B.pk, C.pk] });
  await w13.svc.start();
  const bS = fresh(1_800_000_300);
  const cS = fresh(1_800_000_300);
  await w13.svc.onSealed(B.pk, shareFrom(B, bS));
  await w13.svc.onSealed(C.pk, shareFrom(C, cS));
  const bT = P.presenceTopic(B.pk, await P.presenceTag(bS));
  // C 的主題上有東西（broker 存著他最後的狀態）；B 的上面什麼都沒有
  const cT = P.presenceTopic(C.pk, await P.presenceTag(cS));
  assert.ok(await w13.svc.codec.open(cT, JSON.stringify(await P.sealPresence({ secret: cS, topic: cT, state: { on: 0, ts: w13.now, cs: w13.now } }))));
  w13.sent.length = 0;
  await w13.svc.reconcile();
  assert.deepEqual(w13.requestsTo(), [], 'not before 10 minutes');
  w13.now += 10 * 60_000;
  await w13.svc.reconcile();
  assert.deepEqual(w13.requestsTo(), [B.pk], 'B\'s topic stayed empty → ask him; C\'s had a state → not');
  assert.ok(w13.scope().topics.includes(bT));
  console.log('PASS a friend topic that stays empty for 10 minutes (lost rotation share) triggers a request');
}

// ── 14. stop() 之後還在跑的工作：不再送、不再存、不再改範圍（換帳號時舊帳號的秘密不會用新帳號送出去） ──
{
  const w14 = world({ friends: Array.from({ length: 5 }, (_, i) => identity(`svc-stop-${i}`).pk) });
  let release;
  const gate = new Promise((r) => { release = r; });
  let sends = 0;
  w14.deps.sendSealed = async (to, body) => { sends++; if (sends === 2) await gate; w14.sent.push({ to, body }); return true; };
  const svc14 = S.createPresenceService(w14.deps);
  const starting = svc14.start();
  for (let i = 0; i < 50 && sends < 2; i++) await new Promise((r) => setTimeout(r, 5));
  const savedBefore = JSON.stringify(w14.saved);
  const scopesBefore = w14.scopes.length;
  svc14.stop();
  release();
  await starting.catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sends, 2, 'no further share goes out after stop (the loop was mid-way)');
  assert.equal(JSON.stringify(w14.saved), savedBefore, 'nothing is saved after stop');
  assert.equal(w14.scopes.length, scopesBefore, 'and the scope is not changed after stop');
  assert.equal(await svc14.codec.seal('mist/user/x/presence/y', { on: 1, ts: 1, cs: 1 }), null, 'the codec seals nothing after stop');
  // stop() 正好在處理好友的 share 途中（查好友名單的那段 await 裡）：之後的存檔不寫
  const w14b = world({ friends: [B.pk] });
  await w14b.svc.start();
  const saved14b = JSON.stringify(w14b.saved);
  w14b.deps.isFriend = async () => { w14b.svc.stop(); return true; };
  await w14b.svc.onSealed(B.pk, shareFrom(B, bSec));
  assert.equal(JSON.stringify(w14b.saved), saved14b, 'a share handled while the service stops is not saved');
  console.log('PASS after stop(): no more shares, saves or scope changes from work that was still running');
}

// ── 11. 存檔載完之前的事件等著（不然先存了一份空的、把原本的蓋掉）；載不起來就停 ──
{
  const w11 = world({ friends: [B.pk] });
  await w11.svc.start();
  const tag11 = w11.scope().tag;
  const saved11 = w11.saved;
  let release;
  const w11b = world({ friends: [B.pk] });
  w11b.deps.store.load = () => new Promise((r) => { release = () => r(JSON.parse(JSON.stringify(saved11))); });
  const svc11 = S.createPresenceService(w11b.deps);
  const early = svc11.onSealed(B.pk, shareFrom(B, bSec));   // 冷啟動：信封比存檔早到
  const starting = svc11.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w11b.saved, null, 'nothing is saved before the stored state is loaded');
  release();
  await starting;
  assert.equal(await early, 'share', 'the early share is handled after loading');
  assert.equal(svc11.scope().tag, tag11, 'the stored secret survived (not overwritten by a fresh one)');
  assert.deepEqual(w11b.sharesTo(), [], 'and nobody was re-sealed');
  const w11c = world({ friends: [B.pk] });
  w11c.deps.store.load = async () => { throw new Error('db not open'); };
  const svc11c = S.createPresenceService(w11c.deps);
  await assert.rejects(svc11c.start(), /could not load/);
  assert.equal(await svc11c.reconcile(), undefined);
  assert.equal(w11c.saved, null, 'a failed load never writes (the stored secret is kept for the next start)');
  assert.deepEqual(w11c.sent, [], 'and sends nothing');
  console.log('PASS events wait for the stored state; a failed load stops the service without overwriting anything');
}

// ── 16. 封給誰之前先記進 sharedWith、存好（審查 W4 #9：送到一半當掉、之後刪了他 → 照樣換秘密）；沒送出去的拿掉 ──
{
  const w16 = world({ friends: [B.pk, C.pk] });
  const atSend = [];
  w16.deps.sendSealed = async (to, body) => {
    atSend.push({ to, share: 's' in body, saved: w16.saved?.self?.sharedWith ?? [] });
    w16.sent.push({ to, body });
    return to !== C.pk;   // C 的那一封沒送出去
  };
  const svc16 = S.createPresenceService(w16.deps);
  await svc16.start();
  const shares = atSend.filter((x) => x.share);
  assert.ok(shares.length >= 2 && shares.every((x) => x.saved.includes(x.to)), 'each friend is in the saved sharedWith before his share goes out');
  assert.deepEqual(w16.saved.self.sharedWith, [B.pk], 'a share that did not go out is taken back out');
  console.log('PASS sharedWith is saved before each share goes out; failed sends are removed');
}

// ── 15. 存檔還沒載完就收到好友的 presence（App 重開，persistent session 上的更新先到）：等載完再拆，不當成「不是他的主題」丟掉 ──
{
  const w15 = world({ friends: [B.pk] });
  await w15.svc.start();
  await w15.svc.onSealed(B.pk, shareFrom(B, bSec));
  const saved15 = w15.saved;
  let release;
  const w15b = world({ friends: [B.pk] });
  w15b.deps.store.load = () => new Promise((r) => { release = () => r(JSON.parse(JSON.stringify(saved15))); });
  const svc15 = S.createPresenceService(w15b.deps);
  const bT = P.presenceTopic(B.pk, await P.presenceTag(bSec));
  const payload = JSON.stringify(await P.sealPresence({ secret: bSec, topic: bT, state: { on: 1, ts: w15b.now, cs: w15b.now } }));
  const opening = svc15.codec.open(bT, payload);
  const starting = svc15.start();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await starting;
  assert.equal((await opening)?.owner, B.pk, 'a friend state that arrives before the stored secrets are loaded is opened once they are');
  assert.equal(svc15.codec.stats().opened, 1, 'codec.stats counts it (the sim reads these through mqtt presenceStats)');
  const w15c = world({ friends: [B.pk] });
  w15c.deps.store.load = () => new Promise(() => {});
  const svc15c = S.createPresenceService(w15c.deps);
  void svc15c.start().catch(() => {});
  const waiting = svc15c.codec.open(bT, payload);
  svc15c.stop();
  assert.equal(await waiting, null, 'a service stopped while the state waits opens nothing');
  assert.equal(svc15c.codec.stats()['open-before-load'], 1);
  console.log('PASS a friend state that arrives before loading waits for it; stopped meanwhile → not opened');
}

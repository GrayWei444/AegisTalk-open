/**
 * W4 接線：同群組但不是好友的人拿不到 presence，改看 here 與 P2P；App 這一層的每個 presence 用法都跟著換。
 *   1. 群組引擎（真的 groupEngine＋groupEngineControl，World 見 groupEngineKit）：驗過的 here／sync → deps.onMemberSeen(gid, 寄件人)；
 *      名冊外的人、偽造的信封、commit／delete 不算「他剛連上」
 *   1b. 回 here（審查 W4 #2）：他剛連上、他看不到我（不是好友）、我這邊也沒看到他 → 回一則 here；我 10 秒內發過 here、
 *      他是好友、最近看過他 → 不回；不會連鎖（一次上線最多每個沒看過他的成員回一則）
 *   2. 非好友的同群成員：A 的 presence 範圍只有好友 B 的主題、秘密只封給 B；C（同群、不是好友）寄 share／request 都不理 ——
 *      但 C 的 here 讓 A 知道他在線（memberPresence）
 *   3. memberPresence：here → 在線；P2P 通道關了 → 離線；10 分鐘沒有新的 here → 不算；peerOnline（好友 presence ∪ here ∪ 通道）
 *   4. App 接線（原始碼）：presenceService 建在 AppProvider、codec 交給 mqtt、GROUP_KEY_SEALED 的 presence 種類交給它（在引擎之前）、
 *      token 範圍用它的 tag 與確切主題（沒有 peers）、它晚到 3 秒也不卡群組主題、刪好友／封鎖／連上都會重新比對；
 *      健康檢查、P2P 啟動（here → reachPeerRef）、推播判斷（useChat isFriendOnline）、小綠點（GroupSettingsModal → usePeerOnline）
 * Run: node scripts/review/presence_w4_wiring_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { World, E } from './groupEngineKit.mjs';
import { load, SRC } from './groupStateKit.mjs';

const MP = await load('memberPresence');
const PS = await load('presenceService');
const P = await load('presenceSecret');
const quiet = console.error;
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT|presence)\]/.test(String(a[0]))) quiet(...a); };

// ── 1. 引擎：here／sync → onMemberSeen ──
const world = new World();
let gid;
const seen = new Map();   // label → [{ gid, from }]
try {
  const [A, B, C, O] = await Promise.all(['alice', 'bob', 'carol', 'olga'].map((l) => world.phone(l)));
  world.befriend(A, B);
  world.befriend(A, C);   // 邀請要從好友來（A 邀 C）；B 與 C 不是好友
  for (const p of [A, B, C, O]) {
    seen.set(p.label, []);
    await p.boot({ onMemberSeen: (g, from) => seen.get(p.label).push({ g, from }) });
  }
  gid = await A.engine.createGroup({ name: 'Presence Group', members: [B.pk, C.pk] });
  await world.settle();
  for (const p of [A, B, C]) seen.get(p.label).length = 0;
  C.engine.announce();
  await world.settle();
  assert.ok(seen.get('bob').some((s) => s.g === gid && s.from === C.pk), 'B (not C\'s friend) learns C is online from C\'s verified here');
  assert.ok(seen.get('alice').some((s) => s.from === C.pk), 'A too');
  assert.ok(!seen.get('carol').length, 'nobody reports themselves');
  // O 不在名冊上：他在群組主題上發的（用他自己沒有的金鑰亂封）不算
  for (const p of [A, B]) seen.get(p.label).length = 0;
  const tid = A.tidOf(gid);
  const forged = await E.CTL.sealControl({ gid, kid: A.activeKid(gid)[0], key: crypto.randomBytes(32), sender: O.pk, sign: O.id.sign, t: 'here',
    body: { head: { seq: 1, id: 'a'.repeat(64) } }, ts: world.now() });
  world.publishControl(O, tid, forged.envelope, { qos: 0 });
  // 名冊上的 C 寄一則封錯金鑰的 here（偽造的信封）
  const bad = await E.CTL.sealControl({ gid, kid: A.activeKid(gid)[0], key: crypto.randomBytes(32), sender: C.pk, sign: C.id.sign, t: 'here',
    body: { head: { seq: 1, id: 'a'.repeat(64) } }, ts: world.now() });
  world.publishControl(C, tid, bad.envelope, { qos: 0 });
  await world.settle();
  assert.deepEqual(seen.get('alice'), [], 'a non-member or an envelope that does not open is not "seen"');
  // commit／delete 不算（broker 替離線的人排隊的 QoS1，不能證明他現在在線）
  assert.equal(await C.engine.sendControl(gid, 'delete', { messageId: 'm-1' }), 'sent');
  await world.settle();
  assert.deepEqual(seen.get('alice'), [], 'a delete (QoS1, may be queued for hours) does not count as online');
  console.log('PASS engine: a verified here from a member reports him seen; non-members, bad envelopes and queued kinds do not');
} finally {
  world.close();
}

// ── 1b. 回 here：讓剛連上、看不到我 presence 的非好友知道我在（審查 W4 #2） ──
{
  const w = new World();
  try {
    const [A, B, C] = await Promise.all(['alice', 'bob', 'carol'].map((l) => w.phone(l)));
    w.befriend(A, B);
    w.befriend(A, C);   // B 與 C 不是好友
    const mps = new Map();
    for (const p of [A, B, C]) {
      const mp = MP.createMemberPresence({ now: () => w.now() });
      mps.set(p.label, mp);
      await p.boot({
        onMemberSeen: (_g, from) => mp.seen(from),
        answerHere: (_g, from) => !w.isFriend(p, from) && !mp.recentlySeen(from),
      });
    }
    const g = await A.engine.createGroup({ name: 'Answer Group', members: [B.pk, C.pk] });
    await w.settle();
    for (const mp of mps.values()) mp.reset();
    const heresFrom = (mark) => {
      const out = {};
      for (const e of w.controlLog.slice(mark)) {
        const who = [A, B, C].find((p) => p.pk === e.from).label;
        out[who] = (out[who] ?? 0) + 1;
      }
      return out;
    };
    // C 剛連上：B 不是他的好友、最近沒看到他 → B 回一則；A 是他的好友（他看得到 A 的 presence）→ 不回；C 收到 B 的回覆不再回
    //   （announce 同一個群 15 秒最多一次 → 每次往前撥 16 秒）
    w.offset += 16_000;
    let mark = w.controlLog.length;
    C.engine.announce();
    await w.settle();
    assert.deepEqual(heresFrom(mark), { carol: 1, bob: 1 }, 'exactly one answer, from the non-friend co-member; no cascade');
    assert.ok(mps.get('carol').recentlySeen(B.pk), 'C now knows B is online although they are not friends');
    assert.ok(!mps.get('carol').recentlySeen(A.pk), 'A did not answer (C sees A through the friends-only presence)');
    // 10 秒內 C 又發一則：B 剛發過 here → 不回（B 也還沒忘了 C：先讓 B 忘掉，只剩「10 秒內發過」這一道）
    mps.get('bob').closed(C.pk);
    mark = w.controlLog.length;
    assert.equal(await C.engine.sendControl(g, 'here'), 'sent');
    await w.settle();
    assert.deepEqual(heresFrom(mark), { carol: 1 }, 'no answer while my own here is under 10 s old');
    // 過了 10 秒、B 最近看過 C → 不回
    w.offset += 16_000;
    mark = w.controlLog.length;
    C.engine.announce();
    await w.settle();
    assert.deepEqual(heresFrom(mark), { carol: 1 }, 'no answer to someone I saw recently');
    // B 跟 C 的通道關了（memberPresence.closed）→ C 再連上 → 再回
    mps.get('bob').closed(C.pk);
    w.offset += 16_000;
    mark = w.controlLog.length;
    C.engine.announce();
    await w.settle();
    assert.deepEqual(heresFrom(mark), { carol: 1, bob: 1 }, 'answered again once the channel closed');
    console.log('PASS answer here: a non-friend co-member who cannot see my presence learns I am online; rate-limited, no cascade');
  } finally {
    w.close();
  }
}

// ── 2. 非好友的同群成員拿不到 presence ──
{
  const id = () => Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64');
  const [me, bob, carol] = [id(), id(), id()];
  const sent = [];
  let scope = null;
  const svc = PS.createPresenceService({
    me, now: () => 1_800_000_000_000, store: { load: async () => null, save: async () => {} },
    sendSealed: async (to, body) => { sent.push({ to, body }); return true; },
    friends: () => [bob], isFriend: async (pk) => pk === bob, blocked: async () => new Set(),
    onScope: (s) => { scope = s; }, clearRetained: async () => true, connected: () => true, log: () => {},
  });
  await svc.start();
  const sf = (from) => ({ v: 1, from, to: me, iat: Date.now(), nonce: 'n'.repeat(22) });
  const bobSec = { s: new Uint8Array(crypto.randomBytes(32)), e: 1_800_000_000 };
  const carolSec = { s: new Uint8Array(crypto.randomBytes(32)), e: 1_800_000_000 };
  await svc.onSealed(bob, { ...P.shareBody(bobSec), ...sf(bob) });
  assert.equal(await svc.onSealed(carol, { ...P.shareBody(carolSec), ...sf(carol) }), 'ignored', 'a co-member\'s share is not taken');
  assert.equal(await svc.onSealed(carol, { ...P.requestBody(0), ...sf(carol) }), 'ignored', 'a co-member asking for my secret gets nothing');
  assert.deepEqual(scope.topics, [P.presenceTopic(bob, await P.presenceTag(bobSec))], 'my token scope has only my friend\'s exact topic');
  assert.ok(!sent.some((m) => m.to === carol), 'nothing was ever sealed to the co-member');
  const carolTopic = P.presenceTopic(carol, await P.presenceTag(carolSec));
  const carolOnline = JSON.stringify(await P.sealPresence({ secret: carolSec, topic: carolTopic, state: { on: 1, ts: Date.now(), cs: Date.now() } }));
  assert.equal(await svc.codec.open(carolTopic, carolOnline), null, 'the co-member\'s presence is never opened');
  // 但 here 讓我知道他在線
  const mp = MP.createMemberPresence();
  assert.equal(mp.recentlySeen(carol), false);
  mp.seen(carol);
  assert.equal(mp.recentlySeen(carol), true, 'his here marks him online for the UI and the health check');
  console.log('PASS a non-friend co-member gets no presence secret and none of mine, but his here marks him online');
}

// ── 3. memberPresence ──
{
  let t = 1_000;
  const mp = MP.createMemberPresence({ now: () => t, ttlMs: 10_000 });
  const events = [];
  const off = mp.onChange((pk) => events.push(pk));
  mp.seen('X');
  assert.equal(mp.recentlySeen('X'), true);
  mp.seen('X');
  assert.equal(events.length, 1, 'a second here while already online is not a change (no re-render storm, review W4 #14)');
  t += 9_999;
  assert.equal(mp.recentlySeen('X'), true);
  t += 1;
  assert.equal(mp.recentlySeen('X'), false, 'no new here within the TTL → not online any more');
  mp.seen('X');
  mp.closed('X');
  assert.equal(mp.recentlySeen('X'), false, 'a closed P2P channel → offline at once');
  mp.closed('Y');
  assert.deepEqual(events, ['X', 'X', 'X'], 'changes notified (closing someone never seen is not a change)');
  off();
  mp.seen('Z');
  assert.equal(events.length, 3, 'unsubscribed');
  mp.reset();
  assert.equal(mp.recentlySeen('Z'), false, 'reset on account switch');
  const d = (f, r, c) => ({ friendOnline: () => f, recentlySeen: () => r, channelOpen: () => c });
  assert.equal(MP.peerOnline('p', d(false, false, false)), false);
  assert.equal(MP.peerOnline('p', d(true, false, false)), true, 'a friend\'s verified presence');
  assert.equal(MP.peerOnline('p', d(false, true, false)), true, 'a member\'s recent here');
  assert.equal(MP.peerOnline('p', d(false, false, true)), true, 'an open P2P channel');
  console.log('PASS memberPresence: here → online, closed channel → offline, TTL; peerOnline = presence ∪ here ∪ channel');
}

// ── 4. App 接線（原始碼） ──
{
  const read = (p) => readFileSync(`${SRC}/${p}`, 'utf8');
  const provider = read('providers/AppProvider.tsx');
  const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `markers ${a} … ${b}`); return src.slice(i, j); };
  const svcBlock = between(provider, 'const service = createPresenceService({', '}, [cryptoReady, identity, publicKey, storageReady]);');
  assert.match(svcBlock, /sendSealed: async \(to, body\) => \(stopped \|\| currentSealer\(\)\?\.me !== me \? false : sendGroupSealed\(to, body\)\)/,
    'shares and requests go out as identity-sealed envelopes — never after the effect stopped or under another account (review W4 #3)');
  assert.match(svcBlock, /onScope: \(scope\) => \{ if \(!stopped\) setPresenceScope\(scope\); \}/, 'a stopped service no longer sets the token scope');
  assert.ok(svcBlock.indexOf('let stopped = false;') < svcBlock.indexOf('sendSealed:') || provider.indexOf('let stopped = false;', provider.indexOf('好友之間的秘密 presence（W4，services/presenceService')) < provider.indexOf('const service = createPresenceService({'));
  assert.match(svcBlock, /friends: \(\) => useChatStore\.getState\(\)\.friends\.map/, 'recipients = friends');
  assert.match(svcBlock, /blocked: async \(\) => new Set\(\(await getLocalBlacklist\(\)\)/, 'minus the blocked');
  assert.match(svcBlock, /clearRetained: \(topic\) => \(stopped \? Promise\.resolve\(false\) : mqttService\.clearPresence\(topic\)\)/, 'the old topic is cleared through mqtt');
  assert.match(svcBlock, /mqttService\.setPresenceCodec\(service\.codec\)/, 'mqtt seals/opens presence with its codec');
  assert.match(svcBlock, /onBlacklistChanged\(reconcile\)/, 'blocking someone re-checks (rotates)');
  assert.match(svcBlock, /const keys = friendKeys\(state\.friends\);\s*if \(keys === lastFriendKeys\) return;\s*lastFriendKeys = keys;\s*reconcile\(\);/,
    'unfriending re-checks (rotates) — only when the set of friend keys changed, not on every message (review W4 #10)');
  assert.match(svcBlock, /list\.map\(\(f\) => f\.publicKey\)\.sort\(\)\.join\(','\)/);
  assert.match(svcBlock, /mqttService\.onConnected\(\(\) => \{ void service\.onConnected\(\); \}\)/, 'a pending rotation completes on connect');
  assert.match(svcBlock, /setInterval\(reconcile, 5 \* 60_000\)/, 'the 30-day timer and request retries are checked periodically');
  assert.match(svcBlock, /mqttService\.setPresenceCodec\(null\)/, 'and the codec is dropped on logout / account switch');
  const sealed = between(provider, 'mqtt.subscribe(MessageType.GROUP_KEY_SEALED', '}, [mqtt, publicKey]);');
  const presenceAt = sealed.indexOf("opened.kind === 'presence'");
  assert.ok(presenceAt > 0 && presenceAt < sealed.indexOf('engine.onSealed('), 'presence envelopes go to the presence service, never to the group engine');
  assert.match(sealed.slice(presenceAt, presenceAt + 300), /const presence = await waitForPresenceService\(presenceRef, publicKey\);\s*if \(presence\) await presence\.onSealed\(opened\.from, opened\.body\)/,
    'a share that arrives before the service exists waits for it (review W4 #1)');
  const waitFn = between(provider, 'async function waitForPresenceService(', 'async function waitForGroupEngine(');
  assert.match(waitFn, /if \(service\) return service\.me === me \? service : null;/, 'and only goes to the same account\'s service');
  const engineBlock = between(provider, 'onMemberSeen: (_gid, from) => {', 'notice: (n) =>');
  assert.match(engineBlock, /answerHere: \(_gid, from\) => from !== me && notBlocked\(from\) && !useChatStore\.getState\(\)\.getFriendByPublicKey\(from\)\s*&& !memberPresence\.recentlySeen\(from\) && !webrtcService\.isDataChannelOpen\(from\)/,
    'answer a co-member\'s here only if he is not a friend, not blocked (W5), not seen recently and has no open channel');
  const scope = between(provider, 'mqttService.setAclScope(', '}, [isLoaded');
  assert.match(scope, /\{ tag: presenceTag, topics: presenceTopicList \? presenceTopicList\.split\(','\) : \[\] \}/, 'the token scope = my tag + exact friend topics');
  assert.ok(!/presenceKeyList|subscribeToFriendsPresence|knownPeerKeys\([^)]*\)\.join/.test(provider), 'no public-key presence list any more');
  assert.match(provider, /setTimeout\(\(\) => setPresenceLate\(true\), 3_000\)/, 'a late presence service does not hold back the group topics');
  assert.match(provider, /isGroupsLoaded && groupTopicsReady && presenceScopeReady/, 'the first token waits for the presence scope too (no token without my tag)');
  const mqttSrc = read('services/mqtt.ts');
  assert.ok(!/subscribeToFriendPresence|getMyPresenceTopic|PRESENCE = 'presence'/.test(mqttSrc), 'no public-key presence API left in mqtt.ts');
  assert.match(read('services/groupKeyDelivery.ts'), /const KINDS = \[[^\]]*'presence'/, 'presence is an identity-sealed kind');
  const bl = read('services/localBlacklist.ts');
  assert.ok((bl.match(/notifyChanged\(\);/g) ?? []).length >= 4, 'every blacklist change is announced');
  assert.match(read('hooks/useChat.ts'), /if \(!mqttService\.isFriendOnline\(currentFriend\.publicKey\)\)/, 'push suppression reads the authenticated, TTL-bounded presence');
  const modal = read('components/GroupChat/GroupSettingsModal.tsx');
  assert.match(modal, /const onlinePeers = usePeerOnline\(members\.map\(\(m\) => m\.publicKey\), isOpen\)/, 'the online dot uses presence ∪ here ∪ channel (only while the modal is open)');
  assert.match(modal, /online=\{!!member\.isOnline \|\| onlinePeers\.has\(member\.publicKey\)\}/);
  const hook = read('hooks/usePeerOnline.ts');
  assert.match(hook, /if \(!enabled\) return undefined;/, 'no listeners or timer while closed');
  assert.match(hook, /if \(!enabled\) return NONE;/);
  assert.match(hook, /friendOnline: \(pk: string\) => mqttService\.isFriendOnline\(pk\)/);
  assert.match(hook, /recentlySeen: \(pk: string\) => memberPresence\.recentlySeen\(pk\)/);
  assert.match(hook, /channelOpen: \(pk: string\) => webrtcService\.isDataChannelOpen\(pk\)/);
  console.log('PASS App wiring: presence service, sealed kind routing, token scope without peers, late fallback, rotation triggers, health/P2P/push/online-dot consumers');
}

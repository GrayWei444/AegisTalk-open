/**
 * W2 的獨立審查之後的修正（docs/GROUP_LOG_WIRING_W2.md「審查」）：真的引擎＋存檔＋log client＋api/group_log_routes.py（groupEngineKit：
 * 群組主題只送給訂好的手機、MQTT 有沒有連上）。每一條對應一個審查發現，在修正前的版本上會失敗。
 *   #1 時鐘：引擎、封給身分金鑰的信封、通話信令都用校正到伺服器的時間（App 的接線）
 *   #2 加入後的 sync 等群組主題訂好才送：大家回的 here 這台收得到
 *   #3 去重表每個 (群, 寄件人) 一份：一個成員灌爆不了別人的；擠掉的那一筆再進來還是重放（下限）
 *   #4 收著的（拆不了的）：W3 起不再收著 —— 主題決定是哪一代，別的 kid 封的拆不開就丟（塞假 kid 什麼都佔不到）；
 *      誠實的一口氣 24 則（同一代）照樣全收
 *   #5 封完再看一次：封的時候斷線／不能送了 → 不送、留著，連上再用那時的這一代封；沒連上時不交給 mqtt 排隊；
 *      放回去的時候其實已經可以送 → 馬上再放一次（複審 5a）；離線時的 delete 存進資料庫，重開 App 也會送（複審 5b）
 *   #6 重送的邀請綁在那一次加入：踢掉又加回來的人不會再收到舊的那份（舊鏈、舊金鑰）
 *   #7 引擎在已經連著的時候才建 → 自己發 here
 *   #8 重複邀請的回條只給寫那筆 add、還在群裡的人（不給被踢的前成員當探測）
 *   #11 群組畫面顯示引擎的通知；重送用完還沒送到的邀請留在群組設定（Group.unackedInvites），可以再送一輪（複審）
 * Run: node scripts/review/group_control_w2_review_fixes_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, E } from './groupEngineKit.mjs';
import { SRC } from './groupStateKit.mjs';

const world = new World();
const since = (mark, from, gid) => world.controlLog.slice(mark).filter((e) => e.from === from.pk && (!gid || e.gid === gid));
const stat = (p, k) => p.engine.controlStats()[k] ?? 0;
const quiet = console.error;
let armed5 = false;
let cFloodEnd = 0;   // the newest timestamp of C's #3 flood (#4 waits until the clock has passed it)
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT)\]/.test(String(a[0]))) quiet(...a); };
try {
  const [A, B, C, X] = await Promise.all(['alice', 'bob', 'carol', 'xavier'].map((l) => world.phone(l)));
  for (const p of [B, C, X]) world.befriend(A, p);
  for (const p of [A, B, C, X]) await p.boot();
  const g = await A.engine.createGroup({ name: 'Review', members: [B.pk, C.pk] });
  await world.settle();
  const kid = () => A.activeKid(g)[0];
  const key = () => A.engine.decryptKey(g, kid());
  const seal = (who, t, body, over = {}) => E.CTL.sealControl({ gid: g, kid: kid(), key: key(), sender: who.pk, sign: who.id.sign, t, body, ts: world.now(), ...over });

  // ── #1 ──
  {
    const provider = readFileSync(`${SRC}/providers/AppProvider.tsx`, 'utf8');
    const delivery = readFileSync(`${SRC}/services/groupKeyDelivery.ts`, 'utf8');
    // 只看 createGroupEngine({ … }) 這一段（W4 的 presence 服務在後面也有一行 now: () => …；W5 起收端的新鮮度另走 receiveNow／boundedNow）
    const engineDeps = provider.slice(provider.indexOf('createGroupEngine({'), provider.indexOf('setGroupEngine(engine)'));
    assert.ok(engineDeps.length > 0 && /now: \(\) => mqttService\.serverNow\(\),/.test(engineDeps), 'the engine runs on the server-corrected clock');
    assert.ok(/sealToIdentity\(\{[^}]*now: mqttService\.serverNow\(\) \}/.test(delivery), 'sealed group envelopes are dated with the server clock');
    assert.ok(/openFromIdentity\([^]*?now: mqttService\.serverNow\(\) \}/.test(delivery), 'and judged with it (W5 複審：7 天的窗留在 serverNow，窗短的種類另外用 boundedNow)');
    assert.ok(/groupCallService\.handleSignal\(opened\.from, opened\.body, mqttService\.boundedNow\(\)\)/.test(provider), 'call signals are judged with the bounded clock too');
    console.log('PASS #1 clocks: engine ts/freshness, sealed envelopes and call signals all use the server-corrected time');
  }

  // ── #2 ──
  {
    const N = await world.phone('nina');
    world.befriend(A, N);
    await N.boot();
    N.subscribeDelayMs = 2_500;                     // 加入之後主題要一陣子才訂好（換 token、重連、SUBACK）
    // a member's sync just before the join: replies to syncs are rate-limited per sender (10 s), so answering Carol must
    // not use up the members' reply to the joiner (a per-group limit would; mutant "R2 sync replies limited per group").
    // Without this the joiner was simply the first sync in 10 s and a per-group limit went unnoticed on slow machines.
    const carolSync = await seal(C, 'sync', { have: C.engine.gossip(g) });
    for (const p of [A, B]) assert.equal(await p.engine.onControl(p.tidOf(g), C.pk, carolSync.envelope), 'ok', 'a member\'s sync is taken');
    const mark = world.controlLog.length;
    const resultsMark = world.controlResults.length;
    assert.equal(await A.engine.addMember(g, N.pk), 'applied');
    await world.settle(2_000);
    const syncs = since(mark, N, g);
    assert.equal(syncs.length, 1, `exactly one sync (${syncs.length})`);
    assert.ok(syncs[0].fromSubscribed, 'the joiner\'s sync went out only once its group topic was subscribed');
    const repliesToN = world.controlResults.slice(resultsMark).filter((r) => r.to === N.pk && r.gid === g && r.result === 'ok' && r.from !== N.pk);
    assert.ok(repliesToN.length >= 1, `members' here replies reached the joiner (${repliesToN.length})`);
    N.subscribeDelayMs = 0;
    console.log('PASS #2 the post-join sync waits for the topic subscription, so the members\' here replies arrive');
  }

  // ── #3 ──
  {
    const callEnd = await seal(A, 'call', { action: 'end', video: false });
    assert.equal(await B.engine.onControl(B.tidOf(g), A.pk, callEnd.envelope), 'ok');
    const lateFromA = await seal(A, 'delete', { messageId: 'a-late' });   // A 先封好、晚一點才到（broker 排隊）
    const firstOfC = await seal(C, 'delete', { messageId: 'c-0' });
    assert.equal(await B.engine.onControl(B.tidOf(g), C.pk, firstOfC.envelope), 'ok');
    let floodTs = 0;
    for (let i = 1; i <= 300; i++) {
      floodTs = world.now() + i;   // distinct, rising timestamps: up to 300 ms ahead of the clock
      assert.equal(await B.engine.onControl(B.tidOf(g), C.pk, (await seal(C, 'delete', { messageId: `c-${i}` }, { ts: floodTs })).envelope), 'ok');
    }
    cFloodEnd = floodTs;
    assert.equal(await B.engine.onControl(B.tidOf(g), A.pk, callEnd.envelope), 'replay', 'one member\'s flood does not evict another member\'s entries');
    assert.equal(await B.engine.onControl(B.tidOf(g), C.pk, firstOfC.envelope), 'replay', 'an evicted entry of the flooder is still a replay (floor)');
    assert.equal(await B.engine.onControl(B.tidOf(g), A.pk, lateFromA.envelope), 'ok', 'another member\'s late (older ts) message is still accepted: the flooder only raised its own floor');
    B.controls.length = 0;
    console.log('PASS #3 replay cache per (group, sender) with a floor: a 300-message flood evicts nothing of others and opens no replay');
  }

  // ── #4（W3）──
  {
    const env = (who, k, i) => E.CTL.sealControl({ gid: g, kid: k, key: key(), sender: who.pk, sign: who.id.sign, t: 'delete',
      body: { messageId: `f-${k}-${i}` }, ts: world.now() });
    const fakeKids = [];
    for (let i = 0; i < 10; i++) fakeKids.push(await B.engine.onControl(B.tidOf(g), C.pk, (await env(C, `fake-kid-${i}`, 0)).envelope));
    assert.ok(fakeKids.every((r) => r === 'bad-envelope'), `envelopes sealed for other kids do not open on my topic (${[...new Set(fakeKids)]})`);
    assert.equal(stat(B, 'held:in'), 0, 'nothing kept');
    // an honest sender's clock does not run backwards: C's burst comes after its #3 flood, whose timestamps ran up to
    // 300 ms ahead of the clock and raised C's replay floor that far. Without this wait a fast machine sends the burst
    // "before" the flood and every message is (rightly) a replay below the floor (seen on the Mac: 0/24).
    while (world.now() <= cFloodEnd) await new Promise((r) => setTimeout(r, 10));
    const burst = [];
    for (let i = 1; i <= 24; i++) burst.push(await B.engine.onControl(B.tidOf(g), C.pk, (await env(C, kid(), i)).envelope));
    assert.ok(burst.every((r) => r === 'ok'), `an honest burst under the current epoch is all accepted (${burst.filter((r) => r === 'ok').length}/24)`);
    assert.equal(await B.engine.onControl(B.tidOf(g), A.pk, (await env(A, kid(), 0)).envelope), 'ok', 'another member is not crowded out');
    B.controls.length = 0;
    console.log('PASS #4 (W3) nothing is held any more: envelopes sealed for another epoch do not open on the topic; honest bursts all accepted');
  }

  // ── #5 ──
  {
    // 沒連上：留在引擎裡（不交給 mqtt 排隊），連上才封、送
    C.mqttUp = false;
    let mark = world.controlLog.length;
    assert.equal(await C.engine.sendControl(g, 'delete', { messageId: 'offline-1' }), 'held');
    assert.deepEqual(since(mark, C, g), [], 'nothing handed to mqtt while offline');
    C.mqttUp = true;
    C.engine.flushControl();
    await world.settle();
    assert.equal(since(mark, C, g).length, 1, 'sealed and sent once connected');
    // 封的那段時間裡斷線（同樣代表「剛套上 leave、換了一代」）：封好的不送，留著
    let armed = false;
    C.shutdown();
    await C.boot({ sign: (data) => {
      if (armed && Buffer.from(data).toString('utf8', 0, 18) === 'aegistalk-gctl-v1:') { armed = false; C.mqttUp = false; }
      return C.id.sign(data);
    } });
    await world.settle();
    C.mqttUp = true;
    mark = world.controlLog.length;
    armed = true;
    assert.equal(await C.engine.sendControl(g, 'delete', { messageId: 'race-1' }), 'held', 'blocked during sealing → not sent');
    assert.deepEqual(since(mark, C, g), []);
    assert.ok(stat(C, 'resealed-later') >= 1);
    C.mqttUp = true;
    C.engine.flushControl();
    await world.settle();
    const out = since(mark, C, g);
    assert.equal(out.length, 1, 'released (sealed again) once it may be sent');
    assert.equal((await A.peekControl(out[0]))?.body.messageId, 'race-1');
    console.log('PASS #5 nothing is handed out sealed while sending is blocked: offline or blocked during sealing → held, sealed again later');
  }

  // ── #5 複審 ──
  {
    // 5a：封的時候（只有那一刻）不能送 → 放回去時其實已經可以了 → 馬上再放一次，不用等下一次變化
    let falseOnce = 0;
    C.shutdown();
    await C.boot({
      connected: () => { if (falseOnce > 0) { falseOnce--; return false; } return C.online && C.mqttUp; },
      sign: (data) => {
        if (armed5 && Buffer.from(data).toString('utf8', 0, 18) === 'aegistalk-gctl-v1:') { armed5 = false; falseOnce = 1; }
        return C.id.sign(data);
      },
    });
    await world.settle();
    let mark = world.controlLog.length;
    armed5 = true;
    assert.equal(await C.engine.sendControl(g, 'delete', { messageId: 'blip-1' }), 'held');
    await world.settle();
    assert.deepEqual((await Promise.all(since(mark, C, g).map((e) => A.peekControl(e)))).map((m) => m?.body.messageId), ['blip-1'],
      'released again right away, without waiting for another change');
    // 5b：離線時按的「為所有人刪除」存在資料庫：App 關掉再開（還是離線）也還在，連上才送
    C.mqttUp = false;
    mark = world.controlLog.length;
    assert.equal(await C.engine.sendControl(g, 'delete', { messageId: 'offline-restart' }), 'held');
    await world.settle();
    assert.equal(C.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ? AND state = 'ctl'", [g])[0].n, 1, 'stored');
    C.shutdown();
    C.mqttUp = false;
    await C.boot();
    await world.settle();
    assert.deepEqual(since(mark, C, g), [], 'still offline after the restart: nothing sent');
    C.mqttUp = true;
    C.engine.flushControl();
    await world.settle();
    assert.deepEqual((await Promise.all(since(mark, C, g).map((e) => A.peekControl(e)))).map((m) => m?.t === 'delete' ? m.body.messageId : m?.t).filter((x) => x !== 'here'),
      ['offline-restart'], 'the delete survived the restart and went out once connected');
    assert.equal(C.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ? AND state = 'ctl'", [g])[0].n, 0, 'and its row is gone');
    console.log('PASS #5 review: re-held control is released again at once when possible; an offline delete survives a restart');
  }

  // ── #6 ──
  {
    const Ev = await world.phone('eve');
    world.befriend(A, Ev);
    await Ev.boot();
    world.sealedFilter = ({ to, body }) => !(to === Ev.pk && body.kind === 'invite');   // 加、踢、加回來的邀請都先丟了
    assert.equal(await A.engine.addMember(g, Ev.pk), 'applied');
    await world.settle();
    const firstKid = kid();
    assert.equal(await A.engine.removeMember(g, Ev.pk), 'applied');
    await world.settle();
    assert.equal(await A.engine.addMember(g, Ev.pk), 'applied');   // 加回來（換金鑰）
    await world.settle();
    const readdKid = kid();
    assert.notEqual(readdKid, firstKid);
    assert.equal(A.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ? AND state = 'sent'", [g])[0].n, 2, 'two unacked invites: the first add and the re-add');
    world.sealedFilter = null;
    const mark = world.sealedLog.length;
    world.offset += 31_000;
    A.engine.requestSync(g);
    await world.settle();
    const resent = world.sealedLog.slice(mark).filter((m) => m.kind === 'invite' && m.to === Ev.pk);
    assert.deepEqual(resent.map((m) => m.kid), [readdKid], `only the re-add invite is resent, never the stale one with the pre-removal key (${resent.map((m) => (m.kid === firstKid ? 'OLD' : 'new'))})`);
    assert.ok(Ev.groups.has(g), 'the re-added member joins');
    assert.deepEqual(Ev.activeKid(g), [readdKid]);
    assert.equal(A.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ? AND state = 'sent'", [g])[0].n, 0, 'the stale row is gone, the new one acked');
    console.log('PASS #6 a resend is bound to that add: after remove + re-add the old invite (old chain, old key) is never resent');
  }

  // ── #7 ──
  {
    const mark = world.controlLog.length;
    B.shutdown();
    B.online = true;
    B.engine = E.createGroupEngine(B.deps());     // 已經連著才建引擎（換帳號、身分重新解鎖），沒人呼叫 announce()
    await B.engine.start();
    await world.settle();
    const heres = [];
    for (const e of since(mark, B, g)) heres.push((await A.peekControl(e))?.t);
    assert.ok(heres.includes('here'), `the engine announces itself when it starts while connected (${heres})`);
    console.log('PASS #7 an engine started while MQTT is already connected sends its here');
  }

  // ── #8 ──
  {
    const invite = world.sealedLog.filter((m) => m.kind === 'invite' && m.to === C.pk && m.gid === g).pop();
    assert.ok(invite, 'C\'s genesis invite');
    world.befriend(X, C);
    const acksBefore = world.sealedLog.filter((m) => m.kind === 'ack' && m.from === C.pk).length;
    await world.deliverSealed(X, C.pk, invite.body);          // 不是寫那筆 add、也不是成員的好友拿著舊邀請來問
    await world.settle();
    assert.equal(world.sealedLog.filter((m) => m.kind === 'ack' && m.from === C.pk).length, acksBefore, 'no ack to someone who did not add me');
    await world.deliverSealed(A, C.pk, invite.body);          // 真的邀請者
    await world.settle();
    assert.equal(world.sealedLog.filter((m) => m.kind === 'ack' && m.from === C.pk && m.to === A.pk).length > 0, true, 'the real inviter still gets the ack');
    console.log('PASS #8 duplicate-invite acks only to the member who wrote that add (no membership oracle)');
  }

  // ── #11 複審 ──
  {
    const F = await world.phone('fiona');
    world.befriend(A, F);
    await F.boot();
    world.sealedFilter = ({ to, body }) => !(to === F.pk && body.kind === 'invite');
    assert.equal(await A.engine.addMember(g, F.pk), 'applied');
    await world.settle();
    for (const d of E.INVITE_RESEND_MS) {
      world.offset += d + 1_000;
      A.engine.requestSync(g);
      await world.settle();
    }
    assert.deepEqual(A.groups.get(g).unackedInvites, [F.pk], 'the undelivered invite is kept in the group state (settings shows it)');
    world.sealedFilter = null;
    assert.equal(await A.engine.resendInvite(g, F.pk), true, 'the user resends it');
    await world.settle();
    assert.ok(F.groups.has(g), 'and it arrives this time');
    assert.ok(!A.groups.get(g).unackedInvites, 'the undelivered mark clears with the ack');
    assert.equal(await A.engine.resendInvite(g, F.pk), false, 'nothing left to resend');
    console.log('PASS #11 review: an invite that ran out of resends stays visible and can be resent');
  }

  // ── #11 ──
  {
    const win = readFileSync(`${SRC}/components/GroupChat/GroupChatWindow.tsx`, 'utf8');
    assert.ok(/addEventListener\('aegis:group-notice'/.test(win) && /invite-unacked/.test(win) && /noticeHeld/.test(win), 'the group screen shows engine notices');
    console.log('PASS #11 engine notices (invite never acked, change held, rejected) reach the group screen');
  }
} finally {
  console.error = quiet;
  world.close();
}
await new Promise((r) => setTimeout(r, 10));
process.exit(0);

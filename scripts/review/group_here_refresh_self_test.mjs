/**
 * W5 定時 here（docs/GROUP_LOG_WIRING_W5.md）：同群組的非好友看不到彼此的 presence，只靠群組主題上的 here 知道對方還在
 * （memberPresence 10 分鐘沒有新的 here 就當作離線）。W4 之前一個連著、但一直沒說話的成員 10 分鐘後就從健康檢查與小綠點消失。
 *   1. 名冊上有非好友（deps.needsHere 說要）→ 每個間隔一則 here（QoS0、目前這一代的主題）；不要的群一則都不發
 *   2. 收到的人每一次都記成「剛看到他」（deps.onMemberSeen），所以一直連著的成員不會在 TTL 之後消失
 *   3. 沒連上不發（QoS0 不排隊，連上時另外有 announce）；剛發過（半個間隔內）不重複；引擎停了不再發
 *   4. App 接線（原始碼）：needsHere ＝ 名冊上有不是我好友的人
 * Run: node scripts/review/group_here_refresh_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from './groupEngineKit.mjs';
import { SRC } from './groupStateKit.mjs';

const quiet = console.error;
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT|presence)\]/.test(String(a[0]))) quiet(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVERY = 1200;

const world = new World();
try {
  const [A, B, C] = await Promise.all(['alice', 'bob', 'carol'].map((l) => world.phone(l)));
  world.befriend(A, B);
  world.befriend(A, C);   // B 與 C 不是好友；A 跟每個人都是好友
  const seen = new Map([[A.pk, []], [B.pk, []], [C.pk, []]]);
  // ＝App 的 needsHere：名冊上有不是我好友的人
  const nonFriendIn = (p) => (_gid, members) => members.some((pk) => pk !== p.pk && !world.isFriend(p, pk));
  let needsCalls = 0;
  let connectedCalls = 0;   // 定時 here 每一輪都先問連著沒：停掉之後還有人問 ＝ 計時器還在跑
  for (const p of [A, B, C]) {
    const ask = nonFriendIn(p);
    await p.boot({
      hereRefreshMs: EVERY, needsHere: (...x) => { needsCalls++; return ask(...x); }, onMemberSeen: (_g, from) => seen.get(p.pk).push({ from, at: Date.now() }),
      connected: () => { connectedCalls++; return p.online && p.mqttUp; },
    });
  }
  const gid = await A.engine.createGroup({ name: 'Here Group', members: [B.pk, C.pk] });
  await world.settle();
  // controlLog 沒有時間：記下現在有幾則，之後只看新的（用另一支手機的金鑰拆開看種類）
  const mark = () => world.controlLog.length;
  const newHeres = async (p, from) => {
    const out = [];
    for (const e of world.controlLog.slice(from).filter((x) => x.from === p.pk && x.gid === gid)) {
      const viewer = p === A ? B : A;
      const opened = await viewer.peekControl(e).catch(() => null);
      if (opened?.t === 'here') out.push(e);
    }
    return out;
  };

  // ── 1. 名冊上有非好友的人定時發；每個成員都是好友的（A）不發 ──
  let m0 = mark();
  for (const p of [A, B, C]) seen.get(p.pk).length = 0;
  await sleep(EVERY * 4.6);
  const a1 = await newHeres(A, m0);
  const b1 = await newHeres(B, m0);
  const c1 = await newHeres(C, m0);
  assert.ok(b1.length >= 3 && b1.length <= 5, `B (C is not his friend) sends a here about every interval (${b1.length} in ~4.6 intervals)`);
  assert.ok(c1.length >= 3 && c1.length <= 5, `C too (${c1.length})`);
  assert.equal(a1.length, 0, 'A (every co-member is a friend: they see his presence) sends no periodic here');
  assert.ok([...b1, ...c1].every((e) => e.qos === 0), 'periodic here is QoS0 (never queued for offline members)');
  assert.ok([...b1, ...c1].every((e) => e.tid === A.tidOf(gid)), 'on the current epoch topic');
  console.log(`PASS periodic here: ${b1.length}/${c1.length} from B/C in ~4.6 intervals, none from A (all co-members are friends), QoS0 on the current topic`);

  // ── 2. 收到的人每次都記成「剛看到他」 ──
  const bSawC = seen.get(B.pk).filter((s) => s.from === C.pk);
  const cSawB = seen.get(C.pk).filter((s) => s.from === B.pk);
  assert.ok(bSawC.length >= 3 && cSawB.length >= 3, `B and C keep seeing each other (${bSawC.length}, ${cSawB.length}) — a connected but silent co-member never drops out after the TTL`);
  assert.ok(!seen.get(B.pk).some((s) => s.from === A.pk) && !seen.get(C.pk).some((s) => s.from === A.pk), 'nobody is "seen" by a here he never sent');
  console.log('PASS every periodic here refreshes the receivers\' member presence (onMemberSeen)');

  // ── 3. 沒連上不發；半個間隔內發過就不再發；停了不發 ──
  B.mqttUp = false;
  m0 = mark();
  const heldBefore = B.engine.controlStats()['held:here'] ?? 0;
  await sleep(EVERY * 3.2);
  assert.equal((await newHeres(B, m0)).length, 0, 'no periodic here while MQTT is down (QoS0 would be lost; the reconnect announces)');
  assert.equal((B.engine.controlStats()['held:here'] ?? 0) - heldBefore, 0, '…and none is even queued in the engine for later (the reconnect sends its own)');
  B.mqttUp = true;
  // 時鐘停住：C 每一輪都覺得「剛發過」→ 最多再發一則（不看上次發的時間的話每一輪都會發）
  const realNow = world.now.bind(world);
  const frozen = realNow();
  world.now = () => frozen;
  m0 = mark();
  await sleep(EVERY * 3.4);
  const c3 = (await newHeres(C, m0)).length;
  world.now = realNow;
  assert.ok(c3 <= 1, `a here sent less than half an interval ago is not repeated (${c3} in ~3.4 intervals with the clock stopped)`);
  for (const p of [A, B, C]) p.engine.stop();
  m0 = mark();
  const callsAtStop = needsCalls;
  const connectedAtStop = connectedCalls;
  await sleep(EVERY * 3);
  assert.equal(world.controlLog.length, m0, 'a stopped engine sends no periodic here');
  assert.equal(needsCalls, callsAtStop, '…and its timer is gone (nothing even asks whether a here is needed)');
  assert.equal(connectedCalls, connectedAtStop, '…not even whether MQTT is connected (no timer left running after stop)');
  console.log('PASS no periodic here while disconnected, none within half an interval of the last one, none after stop');
} finally {
  world.close();
}

// ── 4. App 接線（原始碼） ──
const app = readFileSync(SRC + '/providers/AppProvider.tsx', 'utf8');
const deps = app.slice(app.indexOf('const engine = createGroupEngine({'), app.indexOf('setGroupEngine(engine);'));
assert.match(deps, /needsHere: \(_gid, members\) => \{\s*const blocked = blockedNow;\s*return blocked !== null && !members\.some\(\(pk\) => blocked\.has\(pk\)\)\s*&& members\.some\(\(pk\) => pk !== me && !\(presenceRef\.current\?\.sharesWith\(pk\) \?\? false\)\);/,
  'the App asks for a periodic here when a co-member cannot see my presence (W5 review: not in a group with someone I blocked, not before the blocked list is known)');
const engine = readFileSync(SRC + '/services/groupEngine.ts', 'utf8');
assert.match(engine, /export const HERE_REFRESH_MS = 4 \* 60_000;/, 'every 4 minutes (two chances inside the 10-minute member presence TTL)');
const mp = readFileSync(SRC + '/services/memberPresence.ts', 'utf8');
assert.match(mp, /export const HERE_TTL_MS = 10 \* 60_000;/);
console.log('PASS App wiring: needsHere = a co-member who cannot see my presence; 4-minute interval inside the 10-minute TTL');
process.exit(0);   // 定時器留著的 mutant 也要結束（失敗的斷言照樣以非 0 結束）

/**
 * 群組成員之間要連得上（對應群星 64f3d211，多人模擬 S3：C 離線時 A 把 D 加進群；C 回來後 D 給 C 的群訊一直卡著）。
 *   1. 「我要連得到的人」＝好友＋同群成員（不含自己），好友在前
 *   2. 接線：P2P 健康檢查涵蓋群組成員；名冊多了人就連上他、送待送的；名冊／好友變動再判斷收著的 offer
 *      W4：presence 只在好友之間（token 範圍是 presenceService 的確切好友主題，不再是「好友＋同群成員的公鑰」）；
 *      同群的非好友靠群組主題上驗過的 here（群組引擎 onMemberSeen → memberPresence → reachPeerRef）與 P2P 的狀態
 *   4. here 從同群成員來 → 跟「名冊多了人」同一套規則連他；同一個人 10 秒內不重複；封鎖的不連
 *   3. 名冊多了人時誰發起：pubkey 較大的一方；較小的一方只有手上有東西要送才自己連；通道已開就直接 flush；
 *      剛從本機載入的名冊不算「新加入」
 *   （AegisTalk 的 MQTT token 沒有訂閱範圍 —— EMQX 只驗 JWT —— 所以沒有群星那段 token 範圍的修正。）
 * Run: node scripts/review/group_peer_reach_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build, transformSync } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'peerreach-'));
await build({ entryPoints: [root + 'packages/pwa/src/services/rosterPeers.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const rp = await import(pathToFileURL(join(dir, 'r.mjs')));

// ── 1 ──
const groups = [{ members: [{ publicKey: 'ME' }, { publicKey: 'A' }, { publicKey: 'D' }] }, { members: [{ publicKey: 'D' }, { publicKey: 'E' }] }];
assert.deepEqual(rp.groupMemberKeys(groups, 'ME'), ['A', 'D', 'E'], 'members of every group, without me, deduplicated');
assert.deepEqual(rp.knownPeerKeys(['F', 'A'], groups, 'ME'), ['F', 'A', 'D', 'E'], 'friends first, then the other members');
assert.deepEqual(rp.newlyAdded(new Set(['A']), ['A', 'D']), ['D']);
console.log('PASS known peers = friends + fellow group members (friends first)');

// ── 2 接線 ──
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const health = provider.slice(provider.indexOf('peerHealthMonitor.start({'), provider.indexOf('isPeerHealthy:'));
assert.ok(/knownPeerKeys\(/.test(health) && /useGroupStore\.getState\(\)\.groups/.test(health), 'P2P health covers fellow group members');
// W4：presence 不再給同群成員（以前 token 範圍列了誰的公鑰就訂得到誰的 presence）
assert.ok(!/subscribeToFriendsPresence|presenceKeyList/.test(provider), 'no presence subscription by public key (friends + members) any more');
const scopeCall = provider.slice(provider.indexOf('mqttService.setAclScope('), provider.indexOf('mqttService.setAclScope(') + 200);
assert.ok(/tag: presenceTag, topics: presenceTopicList/.test(scopeCall), 'the token scope takes the presence service\'s exact friend topics and my tag');
assert.ok(/memberPresence\.recentlySeen\(pk\)/.test(health), 'P2P health counts a fellow member seen via here as online');
const seenAt = provider.indexOf('onMemberSeen: (_gid, from) => {');
assert.ok(seenAt > 0 && /memberPresence\.seen\(from\);\s*reachPeerRef\.current\(from\);/.test(provider.slice(seenAt, seenAt + 200)), 'a verified here marks the member seen and reaches him');
assert.ok(/memberPresence\.closed\(peerPublicKey\)/.test(provider), 'a closed P2P channel marks the member offline');
const reach = provider.slice(provider.indexOf('const reachNewMember'));
assert.ok(/useGroupStore\.subscribe\(/.test(reach) && /newlyAdded\(/.test(reach), 'new roster members are detected');
assert.ok(/webrtcService\.connect\(pk\)/.test(reach) && /flushQueueForPeer\(pk\)/.test(reach), 'and connected to / flushed');
assert.ok((reach.match(/recheckHeldOffers\(\)/g) ?? []).length >= 2, 'roster and friend changes re-check held offers');
const presence = provider.slice(provider.indexOf('mqttService.onPresenceChange('));
const knownAt = presence.indexOf('knownPeerKeys(');
assert.ok(knownAt > 0 && knownAt < presence.indexOf('webrtcService.connect(friendPublicKey)'),
  'a presence "online" only triggers a connect to someone still a friend or fellow member (not a kicked ex-member)');
const blockedAt = presence.indexOf('isBlacklisted(friendPublicKey)');
assert.ok(blockedAt > 0 && blockedAt < presence.indexOf('webrtcService.connect(friendPublicKey)'), 'and never to someone I blocked');
console.log('PASS wiring: presence and health include group members; new members are reached; held offers re-checked');

// ── 3 名冊多了人：誰發起（抽出 AppProvider 的 effect 執行） ──
const start = provider.indexOf('const reachNewMember');
const effectStart = provider.lastIndexOf('useEffect(() => {', start);
const effectEnd = provider.indexOf('}, [publicKey]);', start);
const effectCode = transformSync('globalThis.__effect = ' + provider.slice(effectStart + 'useEffect('.length, effectEnd) + '};', { loader: 'ts' }).code;
async function run(me, { open = [], queued = {} } = {}) {
  const connects = []; const flushes = []; let rechecks = 0;
  let groupListener = null; let friendListener = null;
  const groupState = { groups: [{ members: [{ publicKey: me }, { publicKey: 'MM' }] }], isLoaded: false };
  const ctx = {
    globalThis: {}, publicKey: me, diagLog() {}, devLog() {}, reachPeerRef: { current: null }, Date, Map,
    groupMemberKeys: rp.groupMemberKeys, newlyAdded: rp.newlyAdded, isBlacklisted: async (pk) => pk === 'BLK',
    flushQueueForPeer: async (pk) => { flushes.push(pk); return 0; },
    getQueueSize: async (pk) => queued[pk] ?? 0,
    webrtcService: {
      isDataChannelOpen: (pk) => open.includes(pk),
      connect: async (pk) => { connects.push(pk); },
      recheckHeldOffers: () => { rechecks++; },
    },
    useGroupStore: { getState: () => groupState, subscribe: (fn) => { groupListener = fn; return () => {}; } },
    useChatStore: { subscribe: (fn) => { friendListener = fn; return () => {}; } },
  };
  runInNewContext(effectCode, ctx);
  ctx.globalThis.__effect();
  const emit = async (groups, isLoaded = true) => { Object.assign(groupState, { groups, isLoaded }); groupListener(groupState); await new Promise((r) => setTimeout(r, 5)); };
  const here = async (pk) => { ctx.reachPeerRef.current(pk); await new Promise((r) => setTimeout(r, 5)); };
  return { connects, flushes, emit, here, rechecks: () => rechecks, friendChange: (a, b) => friendListener({ friends: a }, { friends: b }) };
}
const roster = (me, ...pks) => [{ members: [me, 'MM', ...pks].map((publicKey) => ({ publicKey })) }];
{
  const r = await run('M5');
  await r.emit(roster('M5'), true);                       // 從本機載入（isLoaded false → true）：不算新加入
  assert.deepEqual(r.connects, [], 'members loaded from the database are not "new"');
  await r.emit(roster('M5', 'D1', 'Z9', 'BLK'));           // M5 > D1：我發起；M5 < Z9：沒東西要送就等他；BLK 我封鎖了
  assert.deepEqual(r.connects, ['D1'], 'the larger pubkey initiates to a new member; the smaller one waits; a blocked member is never dialled');
  assert.ok(r.rechecks() >= 2, 'every roster change re-checks held offers');
  const before = r.rechecks();
  r.friendChange([1], [0]);
  assert.equal(r.rechecks(), before + 1, 'a friend-list change re-checks held offers too');
}
{
  const r = await run('M5', { queued: { Z9: 2 }, open: ['OPEN'] });
  await r.emit(roster('M5'), true);
  await r.emit(roster('M5', 'Z9', 'OPEN'));
  assert.deepEqual(r.connects, ['Z9'], 'the smaller pubkey connects anyway when it has messages queued for him');
  assert.deepEqual(r.flushes, ['OPEN'], 'a channel that is already open is just flushed');
}
console.log('PASS new members: larger pubkey initiates; smaller only with queued messages; open channels flushed; loads are not "new"');

// ── 4 here（W4：非好友的同群成員看不到彼此的 presence） ──
{
  const r = await run('M5', { queued: { Z9: 1 }, open: ['OPEN'] });
  await r.emit(roster('M5', 'D1', 'Z9', 'Z8', 'OPEN', 'BLK'), true);
  await r.here('D1');
  await r.here('D1');
  assert.deepEqual(r.connects, ['D1'], 'a here from a member: the larger pubkey connects (once per 10 s)');
  await r.here('Z8');
  assert.deepEqual(r.connects, ['D1'], 'the smaller one with nothing queued waits for his offer');
  await r.here('Z9');
  assert.deepEqual(r.connects, ['D1', 'Z9'], 'but connects when it has messages queued for him (S3: D had messages for C)');
  await r.here('OPEN');
  assert.deepEqual(r.flushes, ['OPEN'], 'an open channel is just flushed');
  await r.here('BLK');
  assert.ok(!r.connects.includes('BLK'), 'a blocked member is never dialled');
}
console.log('PASS here from a fellow member reaches him like a new member (initiator / queued / open channel), throttled, never a blocked one');

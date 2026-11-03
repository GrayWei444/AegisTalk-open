/**
 * 群組超過 token 上限（50）時留哪些（審查 MEDIUM）：真的 mqttCredential.ts／mqtt.ts（esbuild，stub 掉 mqtt.js、IDB）。
 *   以前：normalizeAclScope 先依 id 排序再截前 50 —— id 是 group-<建立時間>-…，留下的是最舊的 50 個，
 *         新加入的群組默默收不到群組頻道上的成員異動，沒有任何 log 或提示。
 *   現在：
 *   1. AppProvider 用 rankScopeGroups 排：守護群組優先，其次最近有動靜（最後訊息／名冊更新／建立）的在前；
 *      W3：token 範圍是群組主題 id（rankScopeTopics）—— 每個群目前這一代的主題照群組排名在前、換金鑰後還留著的上一代全部在後，
 *      normalizeAclScope 截後面的（超過上限先犧牲上一代的主題）；上一代的只填剩下的位置，不會觸發「群組被截掉」提示（審查 W3 L6）；
 *      引擎 3 秒還沒給主題表就先用空的群組主題設範圍（審查 W3 L7）
 *   2. 活動時間取到小時：兩個群組輪流有訊息不會每一則都換掉第 50 名
 *   3. 被截掉時 console.error ＋ aegis:mqtt-notice {kind: scope-overflow}，數字沒變不重複；回到上限內 → scope-ok
 * Run: node scripts/review/mqtt_scope_groups_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'scopegroups-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect(){ throw new Error("no") } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : 'export const makeOutgoingId=()=>"o"; export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }' }));
} };
await require('esbuild').build({
  stdin: { contents: `export * from '${SRC}/services/mqtt.ts'; export * from '${SRC}/services/mqttCredential.ts';`, resolveDir: root + 'packages/pwa', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
const errors = [];
console.warn = () => {}; console.error = (...x) => errors.push(x.join(' '));
const notices = [];
globalThis.window = { dispatchEvent: (e) => { notices.push(e.detail); return true; } };
const m = await import(pathToFileURL(join(dir, 'm.mjs')));
const { mqttService: svc, rankScopeGroups, rankScopeTopics, normalizeAclScope, MAX_ACL_GROUPS } = m;

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const id22 = (prefix, i) => `${prefix}${String(i).padStart(4, '0')}`.padEnd(22, 'x');
// 60 個群組（gid 是 22 字元），第 i 個在 T0 + i 小時建立；每個群目前這一代的主題 tid(i)
const groups = Array.from({ length: 60 }, (_, i) => ({ id: id22('G', i), createdAt: T0 + i * H, updatedAt: T0 + i * H }));
const tidOf = (gid) => `T${gid.slice(1)}`;
const topics = groups.map((g) => ({ gid: g.id, tid: tidOf(g.id), current: true }));
const scopeOf = (gs, ts = topics) => normalizeAclScope(rankScopeTopics(rankScopeGroups(gs), ts), []).groups;
const oldest = tidOf(groups[0].id);
const newest = tidOf(groups.at(-1).id);

// ── 1. 最新的留下、最舊的截掉 ──
assert.equal(MAX_ACL_GROUPS, 50);
const kept = scopeOf(groups);
assert.equal(kept.length, 50);
assert.ok(kept.includes(newest), 'the newest group is in the token scope');
assert.ok(!kept.includes(oldest), 'the oldest (least active) group is the one dropped');
assert.deepEqual(new Set(kept), new Set(groups.slice(10).map((g) => tidOf(g.id))), 'exactly the 50 most recently active');
assert.ok(kept.every((t) => !groups.some((g) => g.id === t)), 'the scope carries topic ids, never a gid');
// 舊群組有新訊息 → 排回來
const revived = groups.map((g) => (g.id === groups[0].id ? { ...g, lastMessageTime: T0 + 100 * H } : g));
assert.ok(scopeOf(revived).includes(oldest), 'a group with a new message moves back in');
// 守護群組最優先
const guardian = groups.map((g) => (g.id === groups[1].id ? { ...g, groupType: 'guardian' } : g));
assert.ok(scopeOf(guardian).includes(tidOf(groups[1].id)), 'an old guardian group is always kept');
// 換金鑰後還留著的上一代主題（W3）：排在所有目前這一代的後面 —— 超過上限先犧牲它們
const few = groups.slice(0, 48);
const withPrev = [...topics.slice(0, 48), { gid: groups[47].id, tid: id22('P', 47), current: false },
  { gid: groups[40].id, tid: id22('P', 40), current: false }, { gid: groups[30].id, tid: id22('P', 30), current: false }];
const ranked = rankScopeTopics(rankScopeGroups(few), withPrev);
assert.deepEqual(ranked.slice(-2), [id22('P', 47), id22('P', 40)], 'previous-epoch topics come after every current one, most active group first');
assert.equal(ranked.length, 50, 'previous-epoch topics only fill the free slots (the third one is left out, not ranked past the cap)');
const capped = scopeOf(few, withPrev);
assert.equal(capped.length, 50);
assert.ok(few.every((g) => capped.includes(tidOf(g.id))), 'every current topic is kept');
assert.ok(capped.includes(id22('P', 47)) && capped.includes(id22('P', 40)) && !capped.includes(id22('P', 30)), 'the previous topic of the least active group is the one dropped');
console.log('PASS over 50 group topics: the most recently active groups are kept (guardian groups first), previous-epoch topics go first');

// ── 2. 同一小時內不互換 ──
const a = { id: 'group-a', createdAt: T0 + 59 * H + 1 };
const z = { id: 'group-z', createdAt: T0 + 59 * H + 2 };
const ranked1 = rankScopeGroups([z, a]);
const ranked2 = rankScopeGroups([{ ...z, lastMessageTime: T0 + 59 * H + 1000 }, { ...a, lastMessageTime: T0 + 59 * H + 2000 }]);
assert.deepEqual(ranked1, ranked2, 'activity in the same hour does not reshuffle the order');
console.log('PASS ranking is stable within the hour (no reconnect per message at the boundary)');

// ── 3. 記 log、提示，數字沒變不重複 ──
svc.setAclScope(rankScopeTopics(rankScopeGroups(groups), topics), { tag: null, topics: [] }, 'owner');
assert.deepEqual(notices, [{ kind: 'scope-overflow', groups: 10, max: 50 }], `UI is told how many groups were dropped (${JSON.stringify(notices)})`);
assert.ok(errors.some((e) => e.includes('10 group(s) beyond 50')), 'and it is logged in production builds (console.error)');
svc.setAclScope(rankScopeTopics(rankScopeGroups(revived), topics), { tag: null, topics: [] }, 'owner');
assert.equal(notices.length, 1, 'same overflow count → no repeated notice');
svc.setAclScope(rankScopeTopics(rankScopeGroups(groups.slice(0, 50)), topics.slice(0, 50)), { tag: null, topics: [] }, 'owner');
assert.deepEqual(notices.at(-1), { kind: 'scope-ok' }, 'back under the limit → notice withdrawn');
// 上一代的主題只填剩下的位置：49 個目前的＋幾個上一代的不會讓畫面說「群組被截掉」（審查 W3 L6）
const n0 = notices.length;
const many = groups.slice(0, 49);
const withOld = [...topics.slice(0, 49), ...[1, 2, 3].map((i) => ({ gid: groups[i].id, tid: id22('Q', i), current: false }))];
const scope49 = rankScopeTopics(rankScopeGroups(many), withOld);
assert.equal(scope49.length, 50, '49 current + 1 previous fill the 50 slots');
svc.setAclScope(scope49, { tag: null, topics: [] }, 'owner');
assert.equal(notices.length, n0, 'previous-epoch topics never raise the overflow banner');
assert.equal(rankScopeTopics(rankScopeGroups(groups.slice(0, 50)), [...topics.slice(0, 50), { gid: groups[0].id, tid: id22('Q', 0), current: false }]).length, 50,
  'with 50 current topics the previous ones are left out');
console.log('PASS dropped groups are logged and surfaced once per change; previous-epoch topics only fill free slots');

// ── AppProvider 用 rankScopeGroups ──
const provider = readFileSync((process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/providers/AppProvider.tsx', 'utf8');
assert.match(provider, /const groupRankList = useGroupStore\(\(state\) => rankScopeGroups\(state\.groups\)\.join\(','\)\);/,
  'AppProvider ranks the groups by priority (no alphabetical sort)');
assert.match(provider, /rankScopeTopics\(groupRankList \? groupRankList\.split\(','\) : \[\], scopeTopics\)/,
  'and orders the engine\'s topic table by that ranking for the token scope');
// 引擎遲遲沒給主題表：3 秒後先用空的群組主題設範圍，好友 presence 不跟著等（審查 W3 L7）
assert.match(provider, /const scopeTopics = groupTopics \?\? \(groupTopicsLate \? \[\] : null\);/, 'a missing topic table falls back to no group topics');
assert.match(provider, /if \(groupTopics !== null \|\| !isLoaded \|\| !isGroupsLoaded\) return;\s*const timer = setTimeout\(\(\) => setGroupTopicsLate\(true\), 3_000\);/,
  'only after the lists are loaded and the table is still missing for 3 s');
assert.match(readFileSync((process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/components/common/ConnectionNotice.tsx', 'utf8'), /case 'scope-overflow':/);
console.log('PASS AppProvider and the notice banner are wired');

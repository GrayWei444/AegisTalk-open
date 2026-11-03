/**
 * broker 沒保留 session 時要把群組主題與好友 presence 重訂一次（部署前審查 BLOCKER 第 a 點，對應 AegisPlay B41）：
 *   真的 mqtt.ts，stub 掉 mqtt.js／IDB。clean:false 只在 broker 還留著 session 時保住訂閱；broker 重啟、
 *   session 過了 24 小時、換了 client，訂閱就沒了。以前群組頻道只在建群／收到邀請那一刻訂一次，
 *   之後再也不訂 → 收不到群組主題上的控制訊息，各台名冊岔開。presence 那份還記著「訂過了」，
 *   subscribeToFriendPresence 直接 return → 看不到好友上線。W4：好友的 presence 主題（確切的秘密主題）也照範圍訂，規則跟群組主題一樣。
 *   現在（W3）：群組主題（tid）的訂閱只照訂閱範圍（setAclScope）——
 *   1. 連上時（CONNACK）把範圍裡的訂齊；broker 說沒有 session（sessionPresent=false）就全部重訂，presence 也重訂
 *   2. 範圍少了的（換金鑰後上一代的過了重疊期、被踢、退群）馬上退訂；之後重連也不再訂
 *   3. App 重開時 broker 還留著 session：上次訂的、現在不要的（記在 localStorage）退訂 —— 不然一直留在 session 裡
 *   4. 登出／換帳號：清單不帶到下一個帳號（記憶體清掉；localStorage 那份留給同一個帳號下次退訂）
 *   5. SUBSCRIBE 送出、還沒等到 SUBACK 就換了 client（換 token、重連）：新的連線上重送，SUBACK 到了才算訂好（審查 W3 M2）
 * Run: node scripts/review/mqtt_group_resubscribe_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttresub-'));
globalThis.__clients = [];
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? `export default { connect() {
        const handlers = {}; const subs = []; const unsubs = [];
        const c = { connected: true, disconnected: false, subs, unsubs, handlers,
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          pending: [],
          subscribe(topic, opts, cb) { subs.push(topic); const done = () => cb?.(null, [].concat(topic).map((t) => ({ topic: t, qos: 1 })));
            if (globalThis.__holdSuback) c.pending.push(done); else done(); },
          unsubscribe(t, cb) { unsubs.push(...[].concat(t)); cb?.(null); },
          publish(t, p, o, cb) { cb?.(null); }, removeAllListeners() { for (const k in handlers) delete handlers[k]; }, end() {} };
        globalThis.__clients.push(c); return c; } };`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : `export const makeOutgoingId=()=>"o"; export async function persistOutgoing(){} export async function removeOutgoing(){}
       export async function loadAllOutgoing(){ return [] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
console.warn = () => {}; console.error = () => {}; console.log = (...x) => process.stdout.write(x.join(' ') + '\n');
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

const ME = 'A'.repeat(43) + '=';
const FP = `mist/user/${'B'.repeat(42)}A/presence/${'P'.repeat(22)}`;   // 好友的秘密 presence 主題（W4）
const FP2 = `mist/user/${'C'.repeat(42)}A/presence/${'Q'.repeat(22)}`;
const NOP = { tag: null, topics: [] };
const T1 = 'T1aaaaaaaaaaaaaaaaaaaa';
const T2 = 'T2bbbbbbbbbbbbbbbbbbbb';
const T3 = 'T3cccccccccccccccccccc';
const groupTopic = (t) => `mist/group/${t}/+`;   // 訂閱整個群組主題（最後一節是寄件者）
const flatSubs = (c) => c.subs.flat();
const groupSubs = (c) => flatSubs(c).filter((t) => t.startsWith('mist/group/'));
async function connect(sessionPresent) {
  const p = svc.connect(ME, true);   // dev broker：沒有 token，什麼都給訂
  const c = globalThis.__clients.at(-1);
  c.emit('connect', { cmd: 'connack', sessionPresent });
  await p;
  return c;
}

// ── 1. 照範圍訂；broker 沒留 session → 全部重訂 ──
svc.setAclScope([T1], { tag: null, topics: [FP] }, ME);
let c = await connect(true);
assert.deepEqual(groupSubs(c), [groupTopic(T1)], 'the group topic in the scope is subscribed at CONNACK');
assert.ok(flatSubs(c).includes(FP), 'and the friend presence topic');
svc._teardown();
c = await connect(false);
assert.ok(flatSubs(c).includes(groupTopic(T1)), 'group topic re-subscribed when the broker kept no session');
assert.ok(flatSubs(c).includes(FP), 'friend presence re-subscribed too');
svc._teardown();
c = await connect(true);
assert.deepEqual(groupSubs(c), [], 'nothing extra when the broker kept the session');
assert.ok(!flatSubs(c).includes(FP), 'presence neither');
assert.equal(typeof svc.syncGroupSubscriptions, 'undefined', 'no per-group subscribe API left (the scope drives it)');
assert.equal(typeof svc.subscribeToGroup, 'undefined');
console.log('PASS group topics come from the scope; a lost broker session re-subscribes every group and presence topic');

// ── 2. 範圍少了的馬上退訂、之後不再訂 ──
svc.setAclScope([T1, T2], NOP, ME);
assert.deepEqual(groupSubs(c), [groupTopic(T2)], 'a new topic in the scope is subscribed on the live connection');
svc.setAclScope([T2], NOP, ME);
assert.deepEqual(c.unsubs, [FP, groupTopic(T1)], 'a topic dropped from the scope is unsubscribed at once (the presence topic left with the scope before, then the group topic)');
svc._teardown();
c = await connect(false);
assert.deepEqual(groupSubs(c), [groupTopic(T2)], 'a dropped topic is not re-subscribed');
console.log('PASS a topic dropped from the scope (old epoch after the overlap, removed, left) is unsubscribed and stays so');

// ── 3. App 重開、broker 還留著 session：上次訂的、現在不要的退訂 ──
svc.setAclScope([T2, T3], { tag: null, topics: [FP2] }, ME);
assert.ok(JSON.parse(store.get(`aegis_mqtt_group_topics:${'A'.repeat(43)}`)).includes(groupTopic(T3)), 'subscribed topics are remembered locally');
assert.deepEqual(JSON.parse(store.get(`aegis_mqtt_presence_topics:${'A'.repeat(43)}`)), [FP2], 'presence topics too');
svc.disconnect();   // App 關掉（記憶體清掉，localStorage 留著）
svc.setAclScope([T3], NOP, ME);
c = await connect(true);
assert.deepEqual(c.unsubs, [groupTopic(T2), FP2], 'after a restart, topics the session may still hold but the scope dropped are unsubscribed (group, then presence: an ex-friend\'s or a rotated topic)');
assert.ok(groupSubs(c).includes(groupTopic(T3)));
assert.deepEqual(JSON.parse(store.get(`aegis_mqtt_group_topics:${'A'.repeat(43)}`)), [groupTopic(T3)], 'and forgotten once unsubscribed');
console.log('PASS after a restart, leftover group subscriptions of the broker session are unsubscribed');

// ── 4. 登出／換帳號：清單不帶到下一個帳號 ──
svc.disconnect();
c = await connect(false);
assert.ok(!flatSubs(c).some((t) => t.startsWith('mist/group/') || t.includes('/presence/')), 'user-initiated disconnect forgets the tracked topics and the scope');
console.log('PASS other accounts do not inherit the group topics');

// ── 5. SUBACK 還沒到就換了 client ──
svc.disconnect();
svc.setAclScope([T1], NOP, ME);
const granted5 = [];
const unsub5 = svc.onGroupSubscribed((tid) => granted5.push(tid));
globalThis.__holdSuback = true;
c = await connect(true);
assert.deepEqual(groupSubs(c), [groupTopic(T1)], 'SUBSCRIBE sent');
assert.equal(svc.isGroupSubscribed(T1), false, 'not yet granted');
svc._teardown();                                         // 換 token／HealthMonitor：舊 client 丟掉，它的 SUBACK 永遠不會被處理
globalThis.__holdSuback = false;
const c2 = await connect(true);                          // broker 還留著 session
assert.deepEqual(groupSubs(c2), [groupTopic(T1)], 'the unconfirmed subscription is sent again on the new client');
assert.ok(svc.isGroupSubscribed(T1) && granted5.includes(T1), 'and its SUBACK marks the topic ready (the post-join sync can go out)');
for (const late of c.pending) late();                    // 舊 client 晚到的 SUBACK：不算（client 已經換了）
unsub5();
svc.disconnect();
console.log('PASS a group SUBSCRIBE still waiting for its SUBACK when the client is replaced is sent again and confirmed');

const provider = readFileSync((process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/providers/AppProvider.tsx', 'utf8');
assert.ok(/mqttService\.setAclScope\(groupTopicList \? groupTopicList\.split/.test(provider), 'AppProvider sets the group topics of the engine\'s table as the scope');
assert.ok(!/syncGroupSubscriptions|subscribeToGroup|unsubscribeFromGroup/.test(provider), 'and subscribes nothing per group by hand');
console.log('PASS AppProvider drives group subscriptions through the scope only');

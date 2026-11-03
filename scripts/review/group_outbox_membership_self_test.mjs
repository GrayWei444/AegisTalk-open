/**
 * 群組的待送只給「現在還同群」的人（對應群星 6d381b43，審查 M2）。3c8a607 讓群訊等回條、刪好友與 session 重置都不再
 * 清群組的待送，但被踢、離開、自己退群、群被刪之後，給那個人的群組密文還留在 outbox：loadOutbox 每次開 App 都撥給他
 * 30 天，通道一開就照送。
 *   1. p2pSend：名單還沒載入（不知道）→ 照舊；知道了以後，loadOutbox 只撥給有東西可送的好友／同群成員，
 *      已經不同群的人不送群組的待送（1 對 1 的照舊送給好友）
 *   2. dropGroupOutboxFor：只清給那個人的群組待送（密文、等回條、回條），1 對 1 的留著；清掉的不再等回條
 *   3. storage：真的 SQLite（sql.js）上只刪那個人的群組型別
 *   4. 接線：loadOutbox／flush 用好友＋同群的名單；名單（一時）是空的當成「還不知道」
 *   5. 名冊少了人（踢人、離開、自己退群、刪群）、刪好友時對方也不同群 → 3 秒後名冊仍沒有他、資料庫 group_members
 *      也沒有他才清（程式碼審查 MEDIUM：整份重載的舊快照不能讓人永遠收不到群訊）
 * Run: node scripts/review/group_outbox_membership_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../../', import.meta.url).pathname;
const PWA = root + 'packages/pwa/';
const require = createRequire(PWA + 'package.json');
const { transformSync } = require('esbuild');
const read = (p) => readFileSync(PWA + 'src/' + p, 'utf8');

// ---------- 1, 2：p2pSend（記憶體 outbox）----------
let rows = [];
const storage = {
  getPendingMessageCount: async (p) => rows.filter((m) => m.recipientPubkey === p).length,
  addPendingMessage: async (m) => { rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m }); },
  getPendingMessagesForRecipient: async (p) => rows.filter((m) => m.recipientPubkey === p).map((r) => ({ ...r })),
  getAllPendingMessages: async () => rows.map((r) => ({ ...r })),
  removePendingMessage: async (id) => { rows = rows.filter((m) => m.id !== id); },
  removePendingMessageForRecipient: async (id, p) => { rows = rows.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
  updatePendingMessageRetry: async () => {},
  deleteGroupPendingMessagesForRecipient: async (p) => {
    rows = rows.filter((m) => !(m.recipientPubkey === p && ['group_key_message', 'group_inflight', 'group_msg_ack'].includes(m.messageType)));
  },
};
const module = { exports: {} };
runInNewContext(transformSync(read('services/p2pSend.ts'), { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, crypto: webcrypto, Date, Map, Set, Promise, JSON, setTimeout: () => 0, clearTimeout: () => {}, console: { error() {} },
  require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
});
const api = module.exports;
const dialed = [];
const wire = [];
let relations = null;                                   // null＝名單還沒載入
api.registerP2PFunctions({
  isConnectedTo: () => false,
  sendToPeer: (p, d) => { wire.push(`${p}:${JSON.parse(d).type}`); return true; },
  connectPeer: async (p) => { dialed.push(p); },
  peerRelation: (p) => relations && (relations[p] ?? { friend: false, fellowMember: false }),
});
const add = (id, p, type) => rows.push({ id, recipientPubkey: p, messageType: type, createdAt: rows.length,
  encryptedPayload: JSON.stringify({ type }), retryCount: 0, lastRetryAt: null });
add('k1', 'KICKED', 'group_key_message');
add('k2', 'KICKED', 'group_inflight');
add('f1', 'FRIEND_EX_MEMBER', 'group_key_message');
add('f2', 'FRIEND_EX_MEMBER', 'encrypted_message');
add('o1', 'FRIEND_ONLY_GROUP_ROWS', 'group_msg_ack');
add('m1', 'MEMBER', 'group_key_message');

await api.loadOutbox();
assert.deepEqual(dialed.sort(), ['FRIEND_EX_MEMBER', 'FRIEND_ONLY_GROUP_ROWS', 'KICKED', 'MEMBER'], 'roster not loaded yet → dial as before');
dialed.length = 0;
relations = {
  KICKED: { friend: false, fellowMember: false },
  FRIEND_EX_MEMBER: { friend: true, fellowMember: false },
  FRIEND_ONLY_GROUP_ROWS: { friend: true, fellowMember: false },
  MEMBER: { friend: false, fellowMember: true },
};
await api.loadOutbox();
assert.deepEqual(dialed.sort(), ['FRIEND_EX_MEMBER', 'MEMBER'], 'only peers we still have something deliverable for are dialed');
for (const p of ['KICKED', 'FRIEND_EX_MEMBER', 'MEMBER']) await api.flushQueueForPeer(p);
assert.deepEqual(wire, ['FRIEND_EX_MEMBER:encrypted_message', 'MEMBER:group_key_message'],
  'group ciphertext is not sent to someone who no longer shares a group; 1-1 messages to a friend still go out');
assert.equal(rows.filter((r) => r.recipientPubkey === 'KICKED').length, 2, 'flush only skips (a roster that failed to load must not delete anything)');
console.log('PASS loadOutbox dials and flush sends group messages only to current fellow members (1-1 only to friends)');

// 2
rows = [];
add('a', 'X', 'group_key_message'); add('b', 'X', 'group_inflight'); add('c', 'X', 'group_msg_ack');
add('d', 'X', 'encrypted_message'); add('e', 'X', 'plaintext_pending'); add('g', 'Y', 'group_key_message');
await api.dropGroupOutboxFor('X');
assert.deepEqual(rows.map((r) => r.id).sort(), ['d', 'e', 'g'], "only X's group entries are dropped");
console.log('PASS dropGroupOutboxFor clears only that peer\'s group entries');

// ---------- 3：storage.ts on sql.js ----------
const SQL = await require('sql.js/dist/sql-asm.js')();
const sqlite = new SQL.Database();
const schema = read('services/database.ts').split('const SCHEMA_SQL')[1];   // 只看 SCHEMA_SQL（遷移裡也有同名的 CREATE TABLE）
for (const t of ['contacts', 'conversations', 'messages', 'pending_messages', 'group_outbox_payloads']) {
  const a = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;
const dir = mkdtempSync(join(tmpdir(), 'goutmember-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    export async function run(sql, params = []) { globalThis.__sqlite.run(sql, params); return { changes: 0 }; }
    export async function query(sql, params = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; } export async function runBatch() {}
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await require('esbuild').build({ stdin: { contents: "export { deleteGroupPendingMessagesForRecipient } from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const st = await import(pathToFileURL(join(dir, 's.mjs')));
const ins = (id, p, type) => sqlite.run('INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, created_at) VALUES (?,?,?,?,?)', [id, p, '{}', type, 1]);
ins('a', 'X', 'group_key_message'); ins('b', 'X', 'group_inflight'); ins('c', 'X', 'group_msg_ack');
ins('d', 'X', 'encrypted_message'); ins('e', 'X', 'plaintext_pending'); ins('g', 'Y', 'group_inflight');
await st.deleteGroupPendingMessagesForRecipient('X');
assert.deepEqual(sqlite.exec('SELECT id FROM pending_messages ORDER BY id')[0].values.flat(), ['d', 'e', 'g']);
console.log('PASS storage deletes only the group entries for that recipient (real SQLite)');

// ---------- 4：接線 ----------
const p2p = read('services/p2pSend.ts');
const storageSrc = read('services/storage.ts');
const typesIn = (src, re) => [...(src.match(re)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
assert.deepEqual(typesIn(p2p, /const GROUP_OUTBOX_TYPES = new Set\(\[([^\]]*)\]/),
  typesIn(storageSrc, /const GROUP_OUTBOX_TYPES_SQL = `([^`]*)`/), 'p2pSend and storage agree on which outbox types are group entries');
const provider = read('providers/AppProvider.tsx');
assert.ok(/peerRelation: \(pk: string\) =>/.test(provider), 'AppProvider tells p2pSend who is a friend / fellow member');
// 抽出真的 peerRelation 執行（對應群星 5f497318）：好友清單是空的 → 1 對 1 當成還不知道；群組清單是空的不算「不知道」
{
  const start = provider.indexOf('peerRelation: (pk: string) =>');
  const open = provider.indexOf('{', start);
  let depth = 0, end = open;
  for (; end < provider.length; end++) { if (provider[end] === '{') depth++; else if (provider[end] === '}' && --depth === 0) break; }
  const fnSrc = provider.slice(provider.indexOf('(pk: string) =>', start), end + 1);
  const { transformSync } = require('esbuild');
  const { runInNewContext } = await import('node:vm');
  const relationWith = ({ friends, groups }) => {
    const ctx = { globalThis: {},
      useChatStore: { getState: () => ({ isLoaded: true, friends, getFriendByPublicKey: (pk) => friends.find((f) => f.publicKey === pk) }) },
      useGroupStore: { getState: () => ({ isLoaded: true, groups }) } };
    runInNewContext(transformSync('globalThis.__rel = ' + fnSrc, { loader: 'ts' }).code, ctx);
    return ctx.globalThis.__rel;
  };
  const exMember = relationWith({ friends: [{ publicKey: 'F' }], groups: [] })('B');
  assert.deepEqual({ ...exMember }, { friend: false, fellowMember: false },
    'no groups left (just left the last one) still blocks group entries for an ex-member — an empty group list is not "unknown"');
  const reloading = relationWith({ friends: [], groups: [{ members: [{ publicKey: 'M' }] }] });
  assert.equal(reloading('F').friend, true, 'an empty friend list (momentary reload) keeps 1-1 entries dialable');
  assert.equal(reloading('M').fellowMember, true, 'fellow members are still computed from the real group list');
}
console.log('PASS wiring: loadOutbox/flush use friends + fellow members; only an empty friend list counts as "unknown"');

// ---------- 5：名冊少了人 → 確認過才清（抽出 AppProvider 的 effect 執行；程式碼審查 MEDIUM） ----------
//   groupStore 先改記憶體再寫資料庫；整份重載可能用寫入前的快照暫時蓋掉成員 —— 那時清就把給他的群訊永遠刪了
{
  const rp = await import(pathToFileURL(join(dir, 'rp.mjs')).href).catch(async () => {
    await require('esbuild').build({ entryPoints: [PWA + 'src/services/rosterPeers.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'rp.mjs'), logLevel: 'silent' });
    return import(pathToFileURL(join(dir, 'rp.mjs')).href);
  });
  const start = provider.indexOf('const reachNewMember');
  const effectStart = provider.lastIndexOf('useEffect(() => {', start);
  const effectEnd = provider.indexOf('}, [publicKey]);', start);
  const effectCode = transformSync('globalThis.__effect = ' + provider.slice(effectStart + 'useEffect('.length, effectEnd) + '};', { loader: 'ts' }).code;
  const dropped = []; const timers = []; const dbMembers = new Set();
  let groupListener = null; let friendListener = null;
  const groupState = { groups: [], isLoaded: false };
  const ctx = {
    globalThis: {}, publicKey: 'ME', diagLog() {}, devLog() {}, reachPeerRef: { current: null },   // W4：here → 連上同群成員
    groupMemberKeys: rp.groupMemberKeys, newlyAdded: rp.newlyAdded, isBlacklisted: async () => false,
    flushQueueForPeer: async () => 0, getQueueSize: async () => 0,
    webrtcService: { isDataChannelOpen: () => true, connect: async () => {}, recheckHeldOffers() {} },
    useGroupStore: { getState: () => groupState, subscribe: (fn) => { groupListener = fn; return () => {}; } },
    useChatStore: { subscribe: (fn) => { friendListener = fn; return () => {}; } },
    dropGroupOutboxFor: async (pk) => { dropped.push(pk); },
    isGroupMemberAnywhere: async (pk) => dbMembers.has(pk),
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  runInNewContext(effectCode, ctx);
  ctx.globalThis.__effect();
  const emit = (pks, isLoaded = true) => { Object.assign(groupState, { groups: [{ members: ['ME', ...pks].map((publicKey) => ({ publicKey })) }], isLoaded }); groupListener(groupState); };
  const fireTimers = async () => { while (timers.length) timers.shift()(); await new Promise((r) => setTimeout(r, 5)); };
  emit(['A', 'B', 'C'], true);                             // 從本機載入
  for (const pk of ['A', 'B', 'C']) dbMembers.add(pk);
  emit(['A', 'C']);                                       // 重載用了舊快照：B 暫時不見
  emit(['A', 'B', 'C']);                                  // 下一次更新又有 B
  await fireTimers();
  assert.deepEqual(dropped, [], 'a member who is back in the roster a moment later keeps his queued group messages');
  emit(['A', 'C']);                                       // 記憶體少了 B，但資料庫還有他（寫入還沒到）
  await fireTimers();
  assert.deepEqual(dropped, [], 'a member still listed in the database keeps his queued group messages');
  emit(['A', 'B', 'C']);                                  // 之後名冊又載對了
  await fireTimers();
  dbMembers.delete('B');                                  // 真的踢掉：記憶體與資料庫都沒有他
  emit(['A', 'C']);
  await fireTimers();
  assert.deepEqual(dropped, ['B'], 'after a real kick/leave his group outbox is dropped');
  dropped.length = 0;
  friendListener({ isLoaded: true, friends: [] }, { isLoaded: true, friends: [{ publicKey: 'F' }, { publicKey: 'A' }] });
  await fireTimers();
  assert.deepEqual(dropped, ['F'], 'an unfriended peer who shares no group is dropped too (a fellow member is not)');
}
console.log('PASS roster shrink and unfriend drop group entries only after confirming (roster and database)');

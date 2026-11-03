/**
 * 群組「為所有人刪除」（對應群星 P3-1，AegisPlay e10df23）：真的 storage.deleteGroupMessageFrom（sql.js＋真 schema）
 * ＋ 真的 groupControlRoute（App 把引擎驗過的 delete 交給 storage）＋ 抽出真的 useGroupChat.deleteGroupMessage 與
 * AppProvider DELETE_MESSAGE effect 執行。
 *   以前只通知 message.recipientPubkey（群組訊息還原出來的第一個 1 對 1 對象），收端也只在 1 對 1 訊息裡找、
 *   還要求寄件人是好友 → 群組刪除從來沒有生效。
 *   W2（docs/GROUP_LOG_WIRING_W2.md）：刪除通知改成群組主題上一則 group_sealed delete（目前這一代金鑰加密、作者簽章）。
 *   寄件人是不是套上的名冊上的成員、是不是目前這一代、新不新鮮、有沒有重放，由群組引擎在解密之前／之後判斷
 *   （group_control_w2_self_test 測名冊外的人、偽造、重放、舊一代的 delete 都到不了這裡）；這裡測引擎之後那一段：
 *   只刪「這個群、這個作者」的那一則（別人不能刪我的）；收件箱那條帶 groupId 的明文刪除一律不處理。
 * Run: node scripts/review/group_delete_self_test.mjs
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
const initSqlJs = require('sql.js/dist/sql-asm.js');
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
const schema = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8');
for (const t of ['conversations', 'messages']) {
  const a = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;
const dir = mkdtempSync(join(tmpdir(), 'gdel-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    export async function run(sql, params = []) { globalThis.__sqlite.run(sql, params); return { changes: globalThis.__sqlite.getRowsModified() }; }
    export async function query(sql, params = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; } export async function runBatch() {}
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await build({ stdin: { contents: "export * from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const storage = await import(pathToFileURL(join(dir, 's.mjs')));
const has = (id) => (sqlite.exec(`SELECT COUNT(*) FROM messages WHERE id='${id}'`)[0].values[0][0]) === 1;
const save = (id, sender, groupIds) => storage.saveMessage({ id, conversationId: 'conv-' + sender, senderPubkey: sender, content: 'x', type: 'text',
  createdAt: 1, ttl: 0, expiresAt: null, readAt: null, isOutgoing: false, status: 'delivered', groupIds });

// ── 收端：引擎驗過的 delete → groupControlRoute → storage ──
const dirR = mkdtempSync(join(tmpdir(), 'gdelr-'));
await build({ entryPoints: [join(root, 'packages/pwa/src/services/groupControlRoute.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dirR, 'r.mjs'), logLevel: 'silent' });
const route = await import(pathToFileURL(join(dirR, 'r.mjs')));
const provider = readFileSync(join(root, 'packages/pwa/src/providers/AppProvider.tsx'), 'utf8');
assert.ok(/onDelete: \(g, f, messageId\) => \{[^]*?deleteGroupMessageFrom\(messageId, g, f\)/.test(provider), 'the app hands verified deletes to deleteGroupMessageFrom(id, group, author)');
const refreshed = [];
const handlers = {
  onCall() { throw new Error('not a call'); },
  onDelete: (g, f, id) => { void storage.deleteGroupMessageFrom(id, g, f).then((d) => { if (d) refreshed.push(g); }); },
};
const recv = async (from, body, gid = 'g1') => { route.routeGroupControl(gid, from, 'delete', body, handlers); await new Promise((r) => setTimeout(r, 20)); };
await save('m-alice', 'ALICE', ['g1']);
await save('m-bob', 'BOB', ['g1']);
await recv('BOB', { messageId: 'm-alice' });
assert.ok(has('m-alice'), 'someone else cannot delete my message');
await recv('ALICE', { messageId: 'm-alice' }, 'g2');
assert.ok(has('m-alice'), 'the message must belong to the group the delete came from');
await recv('ALICE', { messageId: 'm-alice' });
assert.ok(!has('m-alice') && has('m-bob'), 'the author (a member, not necessarily a friend) deletes it for everyone');
assert.deepEqual(refreshed, ['g1'], 'the group view is refreshed');
await recv('ALICE', { messageId: 42 });
console.log('PASS receiver deletes only the author\'s own message in that group');

// ── 收件箱那條的群組刪除（帶 groupId）：W2 起一律不處理，作者本人送的也一樣（開源第 4 步起 1 對 1 的刪除是封好的
//   DIRECT_SEALED kind delete —— directSignal 驗過寄件人的簽章才交給這個 handler） ──
const ps = provider.indexOf('// 全域監聽 DELETE_MESSAGE');
const pe = provider.indexOf('// 全域監聽 PROFILE_UPDATE', ps);
assert.ok(ps > 0 && pe > ps, 'DELETE_MESSAGE effect found');
const recvCode = transformSync(provider.slice(ps, pe), { loader: 'ts' }).code;
let inboxHandler;
const burned = [];
runInNewContext(recvCode, {
  useEffect: (fn) => fn(), console: { error() {}, warn() {}, log() {} }, diagLog() {}, devLog() {}, cryptoReady: true,
  onDirect: (kind, cb) => { assert.equal(kind, 'delete'); inboxHandler = cb; return () => {}; },
  getFriendByPublicKey: (pk) => (pk === 'BOB' ? { id: 'friend-BOB' } : undefined),
  useChatStore: { getState: () => ({ messages: { c: [{ id: 'm-bob', senderId: 'friend-BOB' }] }, burnMessage: (id) => burned.push(id) }) },
  deleteGroupMessageFrom: async () => { throw new Error('group deletes must not come through the inbox'); },
  window: { dispatchEvent() {} }, CustomEvent: class {},
});
inboxHandler('BOB', { kind: 'delete', messageId: 'm-bob', groupId: 'g1' });
await new Promise((r) => setTimeout(r, 20));
assert.ok(has('m-bob') && burned.length === 0, 'a plaintext group delete over the inbox is ignored, even from the author');
inboxHandler('BOB', { kind: 'delete', messageId: 'm-bob' });
assert.deepEqual(burned, ['m-bob'], 'control: 1-1 deletes from a friend still work');
console.log('PASS group deletes no longer accepted over the inbox (group_sealed only)');

// ── storage 單元 ──
await save('m-carol', 'CAROL', ['g1']);
assert.equal(await storage.deleteGroupMessageFrom('m-carol', 'g2', 'CAROL'), false, 'the message must belong to the named group');
assert.equal(await storage.deleteGroupMessageFrom('m-carol', 'g1', 'BOB'), false, 'only the author');
assert.equal(await storage.deleteGroupMessageFrom('m-carol', 'g1', 'CAROL'), true);
console.log('PASS deleteGroupMessageFrom checks group and author');

// ── 發送端：useGroupChat.deleteGroupMessage ──
const hook = readFileSync(join(root, 'packages/pwa/src/hooks/useGroupChat.ts'), 'utf8');
const hs = hook.indexOf('const deleteGroupMessage = useCallback(');
const he = hook.indexOf('\n  );\n', hs);
const sendCode = transformSync('globalThis.__d = ' + hook.slice(hook.indexOf('useCallback(', hs), he) + '\n);', { loader: 'ts' }).code;
const purged = [];
async function del(messageId, msgs) {
  const sent = []; const mqttSent = []; const ctx = { globalThis: {}, useCallback: (fn) => fn, devLog() {}, console,
    currentGroupId: 'g1', publicKeyBase64: 'ME', messages: msgs,
    storage: { deleteMessage: async () => {}, removePendingGroupMessage: async (id) => { purged.push(id); } }, loadGroupMessages() {},
    getOtherMemberPublicKeys: () => ['ALICE', 'BOB', 'CAROL'],
    getGroupEngine: () => ({ sendControl: async (gid, t, body) => { sent.push({ gid, t, body }); return 'sent'; } }),
    mqttService: { sendToUser: (...a) => mqttSent.push(a) }, MessageType: { DELETE_MESSAGE: 'delete_message' } };
  runInNewContext(sendCode, ctx);
  await ctx.globalThis.__d(messageId);
  assert.deepEqual(mqttSent, [], 'no plaintext DELETE_MESSAGE to anyone');
  return JSON.parse(JSON.stringify(sent));   // vm 裡做的物件換回這個 realm 再比
}
let sent = await del('mine', [{ id: 'mine', senderId: 'me', recipientPubkey: 'ALICE' }]);
assert.deepEqual(sent, [{ gid: 'g1', t: 'delete', body: { messageId: 'mine' } }], 'my message: one group control message tells every member (W2)');
sent = await del('theirs', [{ id: 'theirs', senderId: 'BOB', recipientPubkey: 'BOB' }]);
assert.deepEqual(sent, [], 'someone else\'s message is only deleted locally');
assert.deepEqual(purged, ['mine'], 'queued / awaiting-receipt copies are dropped only for my own message (group_outbox_storage_self_test)');
console.log('PASS sender notifies every member with one sealed group control message, only for its own messages');

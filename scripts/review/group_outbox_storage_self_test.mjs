/**
 * 群組的待送訊息跟 1-1 session、好友關係無關（對應群星 8708fa6f；LINE 式群組：群訊不分是不是好友）。
 * 真的 storage.ts，底下是真的 SQLite（sql.js）＋ database.ts 裡真的 schema。
 *   1. session 重置（對方重加好友／恢復帳號）只作廢 1-1 舊密文：群組金鑰密文、群組等回條、群組回條留著
 *   2. 刪好友：給他的 1-1 待送全清（對應群星 P3-5 照舊），群組的留著（他可能還跟我同群）
 *   3. 收到群訊重送時去重：同一個寄件者的同一個 id 才算「已經有了」
 *   4. 回條只清「送給回條者」的那一筆（同一個 id 送給別人的那筆不動）
 *   5. 我的群訊「為所有人刪除」：排隊中與等回條的每一份都刪掉（不然重送會把它送回去），別則不動
 * Run: node scripts/review/group_outbox_storage_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
// 只看 SCHEMA_SQL（遷移裡也有同名的 CREATE TABLE）；群組密文表見 group_outbox_payload_self_test
const schema = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8').split('const SCHEMA_SQL')[1];
for (const t of ['contacts', 'conversations', 'messages', 'pending_messages', 'group_outbox_payloads']) {
  const a = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  assert.ok(a >= 0, `schema for ${t}`);
  sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;

const dir = mkdtempSync(join(tmpdir(), 'groupoutbox-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    export async function run(sql, params = []) { globalThis.__sqlite.run(sql, params); return { changes: 0 }; }
    export async function query(sql, params = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; } export async function runBatch() {}
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await require('esbuild').build({ stdin: { contents: "export { removeContact, deletePendingMessagesForRecipient, hasMessageFrom, saveMessage, removePendingMessageForRecipient, removePendingGroupMessage } from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const storage = await import(pathToFileURL(join(dir, 's.mjs')));

const add = (id, peer, type) => sqlite.run(
  'INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, created_at) VALUES (?,?,?,?,?)',
  [id, peer, '{}', type, 1]);
const ids = (peer) => sqlite.exec(`SELECT id FROM pending_messages WHERE recipient_pubkey = '${peer}' ORDER BY id`)[0]?.values.flat() ?? [];

// 1
add('r1', 'PEER', 'encrypted_message');
add('r2', 'PEER', 'plaintext_pending');
add('r4', 'PEER', 'group_key_message');
add('r5', 'PEER', 'group_inflight');
add('r6', 'PEER', 'group_msg_ack');
await storage.deletePendingMessagesForRecipient('PEER');
assert.deepEqual(ids('PEER'), ['r2', 'r4', 'r5', 'r6'], 'a session reset drops only the old 1-1 ciphertext');
console.log('PASS a 1-1 session reset keeps queued group ciphertext, group receipts and awaiting-receipt entries');

// 2
add('x1', 'EX', 'encrypted_message');
add('x2', 'EX', 'plaintext_pending');
add('x3', 'EX', 'group_key_message');
add('x4', 'EX', 'group_inflight');
await storage.removeContact('EX');
assert.deepEqual(ids('EX'), ['x3', 'x4'], '1-1 entries for the ex-friend are gone, group entries stay');
console.log('PASS removing a friend keeps the group messages queued for them (they may still share a group)');

// 3
await storage.saveMessage({ id: 'gm-1', conversationId: 'conv-SENDER', senderPubkey: 'SENDER', content: 'hi', type: 'text',
  createdAt: 1, ttl: 0, expiresAt: null, readAt: null, isOutgoing: false, status: 'delivered', groupIds: ['g1'] });
assert.equal(await storage.hasMessageFrom('gm-1', 'SENDER'), true);
assert.equal(await storage.hasMessageFrom('gm-1', 'OTHER'), false, 'the same id from someone else is not a duplicate');
assert.equal(await storage.hasMessageFrom('gm-2', 'SENDER'), false);
console.log('PASS duplicate check matches both the message id and its sender');

// 4
add('same-id', 'B1', 'group_inflight');
sqlite.run('UPDATE pending_messages SET id = ? WHERE id = ?', ['ginflight-m-B1', 'same-id']);
add('ginflight-m-C1', 'C1', 'group_inflight');
await storage.removePendingMessageForRecipient('ginflight-m-C1', 'B1');
assert.deepEqual([...ids('B1'), ...ids('C1')], ['ginflight-m-B1', 'ginflight-m-C1'], 'an id addressed to someone else is not removed');
await storage.removePendingMessageForRecipient('ginflight-m-B1', 'B1');
assert.deepEqual(ids('B1'), [], 'the recipient clears only its own entry');
console.log('PASS a receipt clears only the entry addressed to the peer that sent it');

// 5
const addFull = (id, peer, type, original) => sqlite.run(
  'INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at) VALUES (?,?,?,?,?,?)',
  [id, peer, '{}', type, original, 1]);
addFull('ginflight-gmsg-1-P1', 'P1', 'group_inflight', null);
addFull('ginflight-gmsg-1-P2', 'P2', 'group_inflight', null);
addFull('q1', 'P3', 'group_key_message', JSON.stringify({ messageId: 'gmsg-1', group: true }));
addFull('ginflight-gmsg-10-P1', 'P1', 'group_inflight', null);
addFull('q2', 'P3', 'group_key_message', JSON.stringify({ messageId: 'gmsg-2', group: true }));
await storage.removePendingGroupMessage('gmsg-1');
const left = sqlite.exec(`SELECT id FROM pending_messages WHERE id IN ('ginflight-gmsg-1-P1','ginflight-gmsg-1-P2','q1','ginflight-gmsg-10-P1','q2') ORDER BY id`)[0]?.values.flat() ?? [];
assert.deepEqual(left, ['ginflight-gmsg-10-P1', 'q2'], 'every queued or awaiting-receipt copy of the deleted message is gone; other messages (even gmsg-10) stay');
console.log('PASS deleting my group message drops its queued and awaiting-receipt copies only');
const hookSrc = readFileSync(join(root, 'packages/pwa/src/hooks/useGroupChat.ts'), 'utf8');
// W2：刪除通知改成群組主題上的 group_sealed delete（engine.sendControl），斷言不變：先清掉排隊的副本，再告訴別人
const del = hookSrc.slice(hookSrc.indexOf('const deleteGroupMessage = useCallback('), hookSrc.indexOf(".sendControl(currentGroupId, 'delete'", hookSrc.indexOf('const deleteGroupMessage = useCallback(')));
assert.ok(del.length > 0 && hookSrc.includes(".sendControl(currentGroupId, 'delete'"), 'the delete notification goes out as a group control message');
assert.ok(/storage\.removePendingGroupMessage\(messageId\)/.test(del), 'useGroupChat.deleteGroupMessage drops the queued copies before telling the others');
console.log('PASS wiring: deleting my group message for everyone drops its queued copies first');

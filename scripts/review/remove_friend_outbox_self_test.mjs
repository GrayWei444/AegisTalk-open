/**
 * 刪好友也要清掉給他的待送訊息（對應群星 P3-5，AegisPlay 42207fc）：真的 storage.removeContact，
 * 底下是真的 SQLite（sql.js）＋ database.ts 裡真的 schema。
 *   以前只刪聯絡人、對話、訊息，outbox（pending_messages，含明文的 plaintext_pending）留著：
 *   loadOutbox 之後 30 天一直對前好友撥 WebRTC，對方若還接受連線，刪好友前排隊的訊息照樣送過去。
 * Run: node scripts/review/remove_friend_outbox_self_test.mjs
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
const schema = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8');
for (const t of ['contacts', 'conversations', 'messages', 'pending_messages']) {
  const a = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  assert.ok(a >= 0, `schema for ${t}`);
  sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;

const dir = mkdtempSync(join(tmpdir(), 'rmfriend-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    export async function run(sql, params = []) { globalThis.__sqlite.run(sql, params); return { changes: 0 }; }
    export async function query(sql, params = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; } export async function runBatch() {}
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await require('esbuild').build({ stdin: { contents: "export { removeContact } from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const { removeContact } = await import(pathToFileURL(join(dir, 's.mjs')));

const add = (id, peer, type) => sqlite.run(
  'INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, created_at) VALUES (?,?,?,?,?)',
  [id, peer, '{}', type, 1]);
add('a1', 'EX', 'encrypted_message');
add('a2', 'EX', 'plaintext_pending');
add('b1', 'FRIEND', 'encrypted_message');
await removeContact('EX');
const left = sqlite.exec('SELECT id FROM pending_messages ORDER BY id')[0]?.values.flat() ?? [];
assert.deepEqual(left, ['b1'], 'every queued entry for the removed friend is gone (incl. plaintext); others kept');
console.log('PASS removing a friend clears their outbox, including plaintext entries');

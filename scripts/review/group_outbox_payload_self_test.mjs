/**
 * 群組訊息的密文在 outbox 只存一份（對應群星 0a544b74，審查 M3）。3c8a607 起每個成員各留一筆「等回條」、離線時各排
 * 一筆待送，每筆都帶整份群組密文：一則 100 KB 的群訊發給 20 人就是 2 MB，web 版每次寫入還要把整個資料庫匯出到 IndexedDB。
 * 真的 p2pSend.ts ＋ 真的 storage.ts，底下是真的 SQLite（sql.js）＋ database.ts 裡真的 schema。
 *   1. 離線扇出、連線扇出：密文只存一份（group_outbox_payloads），每個收件人一筆輕量參照
 *   2. 送出時原封不動送出那份密文；排隊的轉成等回條，密文不會被刪了又寫
 *   3. 參照全部清掉（回條、成員被踢）→ 那份密文跟著刪；還有人參照就留著
 *   4. 30 天 TTL 清掉的也一起清密文；我自己的群訊「為所有人刪除」也清掉那份密文
 *   5. v11 遷移：舊資料庫加上 payload_ref 欄與密文表
 * Run: node scripts/review/group_outbox_payload_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const SQL = await require('sql.js/dist/sql-asm.js')();
const schema = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8');
const schemaSql = schema.slice(schema.indexOf('const SCHEMA_SQL'));
const ddl = (t) => {
  const a = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  assert.ok(a >= 0, `schema for ${t}`);
  return schemaSql.slice(a, schemaSql.indexOf(');', a) + 2);
};
let sqlite = new SQL.Database();
const hasPayloadTable = schemaSql.includes('CREATE TABLE IF NOT EXISTS group_outbox_payloads (');
for (const t of ['contacts', 'conversations', 'messages', 'pending_messages', ...(hasPayloadTable ? ['group_outbox_payloads'] : [])]) sqlite.run(ddl(t));
globalThis.__sqlite = () => sqlite;

const dir = mkdtempSync(join(tmpdir(), 'goutpayload-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$/ }, (a) => ({ path: a.path.includes('devLog') ? 'devlog' : 'diaglog', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    const S = () => globalThis.__sqlite();
    export async function run(sql, params = []) { S().run(sql, params); return S().getRowsModified(); }
    export async function query(sql, params = []) { const st = S().prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function runBatch(sets) { S().run('BEGIN'); try { for (const s of sets) S().run(s.statement, s.values); S().run('COMMIT'); } catch (e) { S().run('ROLLBACK'); throw e; } return 0; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; }
    export async function getSetting() { return null; } export async function setSetting() {}` }));
  b.onLoad({ filter: /^devlog$/, namespace: 'fx' }, () => ({ loader: 'js', contents: 'export const devLog=()=>{};export const devWarn=()=>{};' }));
  b.onLoad({ filter: /^diaglog$/, namespace: 'fx' }, () => ({ loader: 'js', contents: 'export const diagLog=()=>{};' }));
} };
await require('esbuild').build({
  stdin: { contents: "export * as p2p from './packages/pwa/src/services/p2pSend.ts'; export * as storage from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'b.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture],
});
const { p2p, storage } = await import(pathToFileURL(join(dir, 'b.mjs')));
globalThis.console.error = () => {};

const MEMBERS = Array.from({ length: 20 }, (_, i) => `M${String(i).padStart(2, '0')}`);
const connected = new Set();
const wire = [];
p2p.registerP2PFunctions({
  isConnectedTo: (p) => connected.has(p),
  sendToPeer: (p, d) => { if (!connected.has(p)) return false; wire.push([p, d]); return true; },
  connectPeer: async () => {},
});
const settle = () => new Promise((r) => setTimeout(r, 30));
const groupWire = (id, size) => JSON.stringify({ type: 'group_key_message', payload: { messageId: id, groupId: 'g1', encrypted: { keyId: 'k1', ciphertext: 'C'.repeat(size) } } });
const one = (sql) => sqlite.exec(sql)[0]?.values[0][0] ?? 0;
const storedBytes = () => one('SELECT COALESCE(SUM(LENGTH(encrypted_payload)), 0) FROM pending_messages')
  + (hasPayloadTable ? one('SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM group_outbox_payloads') : 0);
const payloads = () => (hasPayloadTable ? one('SELECT COUNT(*) FROM group_outbox_payloads') : -1);

try {
  // 1 離線扇出
  const big = groupWire('gm1', 100_000);
  for (const m of MEMBERS) p2p.sendViaP2P(m, big, { messageId: 'gm1', group: true });
  await settle();
  console.log(`  offline fan-out of a ${big.length}-char group message to ${MEMBERS.length} members → ${storedBytes()} chars stored, ${payloads()} payload row(s)`);
  assert.equal(one("SELECT COUNT(*) FROM pending_messages WHERE message_type = 'group_key_message'"), 20, 'one queued entry per member');
  assert.ok(storedBytes() < big.length * 1.5, 'the ciphertext is stored once, not once per member');
  assert.equal(payloads(), 1);
  // 連線扇出（等回條）
  for (const m of MEMBERS) connected.add(m);
  const big2 = groupWire('gm2', 100_000);
  for (const m of MEMBERS) p2p.sendViaP2P(m, big2, { messageId: 'gm2', group: true });
  await settle();
  assert.equal(one("SELECT COUNT(*) FROM pending_messages WHERE message_type = 'group_inflight'"), 20);
  assert.ok(storedBytes() < (big.length + big2.length) * 1.5, 'awaiting-receipt entries also share one copy');
  assert.equal(payloads(), 2);
  console.log('PASS each group message ciphertext is stored once; per-recipient entries are light references');

  // 2 flush：送出原封不動的密文，排隊的轉成等回條
  await p2p.flushQueueForPeer('M00');
  assert.deepEqual(wire.filter(([p]) => p === 'M00').map(([, d]) => d.length), [big2.length, big.length], 'the full ciphertext goes out');
  assert.equal(wire.find(([p, d]) => p === 'M00' && d.includes('"gm1"'))[1], big, 'byte-for-byte the queued ciphertext');
  assert.equal(one("SELECT COUNT(*) FROM pending_messages WHERE recipient_pubkey = 'M00' AND message_type = 'group_inflight'"), 2);
  assert.equal(payloads(), 2, 'the shared copy survives the queued → awaiting-receipt switch');
  console.log('PASS flush sends the stored ciphertext as-is and keeps the shared copy');

  // 3 回條／踢人：參照清光才刪密文
  for (const m of MEMBERS) p2p.confirmDelivered(m, ['gm2']);
  await settle();
  assert.equal(one("SELECT COUNT(*) FROM pending_messages WHERE payload_ref = 'gm2'"), 0);
  assert.equal(one("SELECT COUNT(*) FROM group_outbox_payloads WHERE message_id = 'gm2'"), 0, 'last receipt → the ciphertext is deleted');
  p2p.confirmDelivered('M00', ['gm1']);
  await settle();
  assert.equal(one("SELECT COUNT(*) FROM group_outbox_payloads WHERE message_id = 'gm1'"), 1, 'still referenced by 19 members → kept');
  for (const m of MEMBERS.slice(1)) await p2p.dropGroupOutboxFor(m);
  assert.equal(payloads(), 0, 'dropping the remaining members (kick/leave) deletes it');
  console.log('PASS the shared copy is deleted when its last reference goes (receipts, kicks)');

  // 4 TTL、為所有人刪除
  connected.clear();
  p2p.sendViaP2P('M01', groupWire('gm3', 10), { messageId: 'gm3', group: true });
  await settle();
  sqlite.run('UPDATE pending_messages SET created_at = 1');
  await storage.cleanupOldPendingMessages();
  assert.equal(one('SELECT COUNT(*) FROM pending_messages'), 0);
  assert.equal(payloads(), 0, 'the 30-day TTL also removes the now-unreferenced ciphertext');
  for (const m of ['M01', 'M02']) p2p.sendViaP2P(m, groupWire('gm5', 10), { messageId: 'gm5', group: true });
  await settle();
  await storage.removePendingGroupMessage('gm5');
  assert.equal(one('SELECT COUNT(*) FROM pending_messages'), 0);
  assert.equal(payloads(), 0, 'deleting my group message for everyone also deletes its shared copy');
  console.log('PASS TTL cleanup and delete-for-everyone cover the shared copies');

  // 5 v11 遷移
  const v11 = schema.slice(schema.indexOf('version: 11,'), schema.indexOf('],', schema.indexOf('version: 11,')));
  assert.ok(schema.includes('version: 11,') && Number(schema.match(/const SCHEMA_VERSION = (\d+);/)?.[1]) >= 11 && /critical: true/.test(v11), 'v11 migration, critical');
  const stmts = [...v11.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  sqlite = new SQL.Database();
  sqlite.run(`CREATE TABLE pending_messages (id TEXT PRIMARY KEY, recipient_pubkey TEXT NOT NULL, encrypted_payload TEXT NOT NULL,
    message_type TEXT NOT NULL, original_content TEXT, created_at INTEGER NOT NULL, retry_count INTEGER DEFAULT 0, last_retry_at INTEGER)`);
  sqlite.run("INSERT INTO pending_messages (id, recipient_pubkey, encrypted_payload, message_type, created_at) VALUES ('old', 'M05', '{\"type\":\"encrypted_message\"}', 'encrypted_message', 5)");
  for (const s of stmts) sqlite.run(s);
  assert.equal((await storage.getPendingMessagesForRecipient('M05'))[0]?.encryptedPayload, '{"type":"encrypted_message"}', 'existing rows still read back');
  p2p.sendViaP2P('M05', groupWire('gm4', 10), { messageId: 'gm4', group: true });
  await settle();
  assert.equal(payloads(), 1);
  console.log('PASS the v11 migration upgrades an existing database');
} finally {
  p2p.unregisterP2PFunctions();   // 35 秒的重送檢查計時器是 unref 的（不擋測試結束），註冊照樣收掉
}

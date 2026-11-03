/**
 * 對方不能用自己挑的 id 蓋掉別人的訊息或檔案（稽核 M6，對應 AegisPlay B35 message_overwrite_self_test）：
 *   真的 storage.saveMessage（sql.js＋database.ts 裡真的 messages／conversations schema），
 *   以及真的 fileTransfer 收檔流程（真的 AES-GCM 分塊、真的 sha256），blob store 換成記憶體。
 *   以前 messages 是 INSERT OR REPLACE（id 是寄件者給的），blob 用寄件者給的 fileId 直接 put：
 *   群組成員拿別人訊息的 id 發一則就把那一列換掉；拿別人檔案的 fileId（群組裡大家都看得到）
 *   重新送一個 sha256 自洽的檔，就把其他人手機上的檔案內容換掉。
 * Run: node scripts/review/message_overwrite_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'msgov-'));

// ── messages 列 ──
const initSqlJs = require('sql.js/dist/sql-asm.js');
const SQL = await initSqlJs();
const sqlite = new SQL.Database();
const schema = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8');
for (const t of ['conversations', 'messages']) {
  const a = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  sqlite.run(schema.slice(a, schema.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;
const dbFixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    export async function run(sql, params = []) { globalThis.__sqlite.run(sql, params); return { changes: globalThis.__sqlite.getRowsModified() }; }
    export async function query(sql, params = []) { const st = globalThis.__sqlite.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; } export async function runBatch() {}
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await build({ stdin: { contents: "export { saveMessage } from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [dbFixture] });
const { saveMessage } = await import(pathToFileURL(join(dir, 's.mjs')));
const row = (id) => { const st = sqlite.prepare('SELECT sender_pubkey, content, status, conversation_id FROM messages WHERE id=?'); st.bind([id]); const r = st.step() ? st.getAsObject() : null; st.free(); return r; };
const msg = (over) => ({ id: 'm1', conversationId: 'conv-BOB', senderPubkey: 'BOB', content: 'hi', type: 'text', createdAt: 1, ttl: 0, expiresAt: null, readAt: null, isOutgoing: false, status: 'sent', ...over });

await saveMessage(msg({}));
await saveMessage(msg({ senderPubkey: 'MALLORY', conversationId: 'conv-MALLORY', content: '改掉你的訊息' }));   // 別人拿同一個 id
assert.deepEqual({ ...row('m1') }, { sender_pubkey: 'BOB', content: 'hi', status: 'sent', conversation_id: 'conv-BOB' }, 'another sender cannot overwrite');
await saveMessage(msg({ conversationId: 'conv-MALLORY', content: '搬到別的對話' }));                            // 同 id 換對話
assert.equal(row('m1').content, 'hi', 'cannot be moved into another conversation');
await saveMessage(msg({ status: 'read' }));                                                                   // 同寄件者同對話改狀態
assert.equal(row('m1').status, 'read', 'same sender + conversation can still update');
console.log('PASS a message row can only be updated by its own sender in its own conversation');

// ── 收到的檔案 blob ──
globalThis.__blobs = new Map();
const ftFixture = { name: 'ft', setup(b) {
  b.onResolve({ filter: /^\.\/fileBlobStore$|utils\/devLog$|utils\/diagLog$/ }, (a) => ({ path: a.path, namespace: 'ft' }));
  b.onLoad({ filter: /.*/, namespace: 'ft' }, (a) => ({ loader: 'js', contents:
    a.path.includes('fileBlobStore') ? `
      export async function putBlob(id, blob) { globalThis.__blobs.set(id, blob); }
      export async function getBlob(id) { return globalThis.__blobs.get(id) ?? null; }
      export async function readBlob(id) { return globalThis.__blobs.get(id) ?? null; }
      export async function hasBlob(id) { return globalThis.__blobs.has(id); }
      export async function deleteBlob(id) { globalThis.__blobs.delete(id); }`
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};' : 'export const diagLog=()=>{};' }));
} };
await build({ entryPoints: [root + 'packages/pwa/src/services/fileTransfer.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'ft.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [ftFixture] });
const b64 = (u8) => Buffer.from(u8).toString('base64');
async function deliver(ft, from, fileId, text) {
  const plain = new TextEncoder().encode(text);
  const raw = webcrypto.getRandomValues(new Uint8Array(32));
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  await ft.handleManifestPayload({ v: 1, messageId: 'msg-' + text, fileId, name: 'a.txt', mimeType: 'text/plain', size: plain.length,
    sha256: createHash('sha256').update(plain).digest('hex'), chunkSize: 65536, chunkCount: 1, fileKey: b64(raw), timestamp: 1 }, from);
  const header = new TextEncoder().encode(JSON.stringify({ fileId, chunkIndex: 0, iv: b64(iv) }));
  const frame = new ArrayBuffer(4 + header.length + ct.length);
  new DataView(frame).setUint32(0, header.length, true);
  new Uint8Array(frame, 4, header.length).set(header);
  new Uint8Array(frame, 4 + header.length).set(ct);
  await ft.handleChunkFrame(frame, from);
}
const received = [];
// 收檔要先 init（沒 init 的 fileTransfer 不收任何東西）；fileId 要是合法格式（8–80 字的 [A-Za-z0-9_-]）
const init = (ft) => ft.initFileTransfer({ owner: 'ME', sendChunk: () => true, sendManifest: async () => {}, getBufferedAmount: () => 0,
  isConnectedTo: () => false, connectPeer: async () => {}, sendControl: async () => {} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const F1 = 'file_F1_aaaaaaaa', F2 = 'file_F2_bbbbbbbb';
const ft1 = await import(pathToFileURL(join(dir, 'ft.mjs')) + '?run=1');
init(ft1);
ft1.onFileReceived((rf) => received.push(rf.messageId));
await deliver(ft1, 'ALICE', F1, 'ORIGINAL');
assert.equal(await globalThis.__blobs.get(F1)?.text(), 'ORIGINAL');
assert.deepEqual(received, ['msg-ORIGINAL']);
// App 重開（「已收完」清單只在記憶體）後，群組成員拿同一個 fileId 送一個 sha256 自洽的新檔
const ft2 = await import(pathToFileURL(join(dir, 'ft.mjs')) + '?run=2');
init(ft2);
ft2.onFileReceived((rf) => received.push(rf.messageId));
await deliver(ft2, 'MALLORY', F1, 'EVIL');
assert.equal(await globalThis.__blobs.get(F1)?.text(), 'ORIGINAL', 'an existing fileId keeps its stored file');
assert.deepEqual(received, ['msg-ORIGINAL'], 'and the duplicate is not announced as a new file');
await deliver(ft2, 'ALICE', F2, 'NEW FILE');
assert.equal(await globalThis.__blobs.get(F2)?.text(), 'NEW FILE', 'new files are still stored');
console.log('PASS a received file never replaces an already stored fileId');
process.exit(0);

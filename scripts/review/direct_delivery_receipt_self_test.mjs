/**
 * 1 對 1 的聊天訊息要等到對方回條才算送到（移植群星 B33）。以前 DataChannel `send()` 成功就算送到：連線其實已經死了
 * （偵測要 ~35 秒）或還在送出緩衝裡時 closePeer，那幾則就不見了，畫面卻顯示已送。
 *   真的 p2pSend.ts（假時鐘、記憶體 outbox）：
 *   1. 直接送出 → 留一筆「等回條」（存明文，不是密文）
 *   2. 30 秒內不重送；過了 30 秒沒回條 → 用當下的 session **重新加密**再送（不是同一份密文）、仍留著
 *   3. 別人送來的回條不算；對方的回條 → 刪掉
 *   4. 對方離線時排進佇列的密文，連上送出後也轉成「等回條」
 *   5. 沒有 session 時排的「待加密」，session 好了加密送出後也轉成「等回條」
 *   6. 送出之後 DataChannel 換過 → 不等 30 秒、馬上重送
 *   7. 回條比「等回條」那筆寫進資料庫還早到 → 寫完就刪掉
 *   8. 重送 5 次都沒回條 → 放棄
 *   真的 storage.ts（sql.js）：
 *   9. 對方 sessionReset（清掉舊密文）時：帶明文的排隊密文改回「待加密」、「等回條」留著；沒帶明文的照舊刪掉
 *   AppProvider：
 *  10. 收到 msg_ack 交給 confirmDelivered、不當成訊息；存好訊息後回 DR 加密的 msg_ack；useChat／轉發都帶上明文
 * Run: node scripts/review/direct_delivery_receipt_self_test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const require = createRequire(ROOT + 'package.json');
const { transformSync, build } = require('esbuild');
const src = readFileSync(ROOT + 'src/services/p2pSend.ts', 'utf8');
let now = 1_800_000_000_000;
const FakeDate = class extends Date { static now() { return now; } };
let rows = [];
let slowWrites = false;
const storage = {
  getPendingMessageCount: async (p) => rows.filter((m) => m.recipientPubkey === p).length,
  addPendingMessage: async (m) => {
    if (slowWrites) await new Promise((r) => setTimeout(r, 20));
    rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m });
  },
  addGroupPendingMessage: async () => { throw new Error('no group messages in this test'); },
  getPendingMessagesForRecipient: async (p) => rows.filter((m) => m.recipientPubkey === p).sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r })),
  getAllPendingMessages: async () => rows,
  removePendingMessage: async (id) => { rows = rows.filter((m) => m.id !== id); },
  removePendingMessageForRecipient: async (id, p) => { rows = rows.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
  updatePendingMessageRetry: async (id) => { rows = rows.map((m) => m.id === id ? { ...m, retryCount: m.retryCount + 1, lastRetryAt: now } : m); },
  deleteGroupPendingMessagesForRecipient: async () => {},
};
const module = { exports: {} };
runInNewContext(transformSync(src, { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, crypto: webcrypto, Date: FakeDate, Map, Set, Promise, JSON, setTimeout: () => 0, console: { error() {} },
  require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
});
const api = module.exports;
const wire = [];
let connected = true, encCount = 0, openedAt = 0, hasSession = true;
api.registerP2PFunctions({
  isConnectedTo: () => connected,
  sendToPeer: (_p, d) => { if (!connected) return false; wire.push(JSON.parse(d).payload); return true; },
  connectPeer: async () => {},
  channelOpenedAt: () => openedAt,
}, 'A');
api.registerOutboxEncrypt(async (_peer, plaintext) => hasSession ? `CT(${JSON.parse(plaintext).id})#${++encCount}` : null, 'A');
const flush = () => api.flushQueueForPeer('B');
const inflight = () => rows.filter((r) => r.messageType === 'plaintext_inflight');
const settle = () => new Promise((r) => setTimeout(r, 5));
const msg = (id, text = 'hi') => ({ envelope: JSON.stringify({ type: 'encrypted_message', payload: `CT(${id})#orig` }),
  track: { messageId: id, plaintext: JSON.stringify({ id, content: text, type: 'text' }) } });

// 1
const m1 = msg('m1');
api.sendViaP2P('B', m1.envelope, m1.track);
await settle();
assert.deepEqual(wire, ['CT(m1)#orig']);
assert.equal(inflight().length, 1, 'direct send leaves an awaiting-receipt entry');
assert.equal(JSON.parse(inflight()[0].encryptedPayload).payload, m1.track.plaintext, 'the entry keeps the plaintext (re-encrypted on resend)');
console.log('PASS a direct 1:1 send keeps the plaintext until the recipient acknowledges it');
// 2
now += 10_000; await flush();
assert.equal(wire.length, 1, 'no resend within 30 s');
now += 25_000; await flush();
assert.equal(wire.length, 2);
assert.match(wire[1], /^CT\(m1\)#\d+$/, 'resend is a fresh encryption, not the old ciphertext');
assert.notEqual(wire[1], wire[0]);
assert.equal(inflight().length, 1, 'still waiting for the receipt');
console.log('PASS no receipt after 30 s → re-encrypted with the current session and resent');
// 3
api.confirmDelivered('C', ['m1']); await settle();
assert.equal(inflight().length, 1, "someone else's receipt does not count");
api.confirmDelivered('B', ['m1']); await settle();
assert.equal(inflight().length, 0, 'receipt from the recipient clears it');
assert.equal(api.confirmDelivered('B', ['m1']), 0, 'a second receipt for the same id does nothing');
console.log('PASS only the recipient can confirm');

// 4
connected = false;
const m2 = msg('m2', 'later');
api.sendViaP2P('B', m2.envelope, m2.track);
await settle();
assert.equal(rows.length, 1, 'queued while B is offline');
connected = true; await flush(); await settle();
assert.equal(wire.at(-1), 'CT(m2)#orig');
assert.equal(inflight().length, 1, 'queued ciphertext becomes awaiting-receipt once sent');
assert.equal(rows.filter((r) => r.messageType === 'encrypted_message').length, 0, 'the queued entry is gone');
api.confirmDelivered('B', ['m2']); await settle();
console.log('PASS queued messages also wait for a receipt after they go out');

// 5
hasSession = false;
api.enqueuePlaintextForSession('B', JSON.stringify({ id: 'm3', content: 'no session yet', type: 'text' }));
await settle(); await flush();
assert.equal(rows.filter((r) => r.messageType === 'plaintext_pending').length, 1, 'held until there is a session');
hasSession = true; await flush(); await settle();
assert.match(wire.at(-1), /^CT\(m3\)#\d+$/);
assert.equal(inflight().length, 1, 'a plaintext-pending message waits for a receipt once encrypted and sent');
assert.equal(inflight()[0].id, 'inflight-m3');
api.confirmDelivered('B', ['m3']); await settle();
assert.equal(inflight().length, 0);
console.log('PASS messages queued without a session also wait for a receipt');

// 6
const m4 = msg('m4');
api.sendViaP2P('B', m4.envelope, m4.track);
await settle();
now += 2_000; openedAt = now;                   // 舊通道其實已死，新的 DataChannel 剛開
const before = wire.length;
await flush();
assert.equal(wire.length, before + 1, 'sent on the previous channel → resent at once on the new one');
now += 1_000; await flush();
assert.equal(wire.length, before + 1, 'resent on the current channel → waits for the receipt again');
api.confirmDelivered('B', ['m4']); await settle();
console.log('PASS a new DataChannel resends what went out on the old one right away');

// 7
slowWrites = true;
const m5 = msg('m5');
api.sendViaP2P('B', m5.envelope, m5.track);
api.confirmDelivered('B', ['m5']);              // 回條先到（那筆還在寫）
await new Promise((r) => setTimeout(r, 40));
slowWrites = false;
assert.equal(inflight().length, 0, 'an early receipt still clears the entry once it is written');
console.log('PASS a receipt that beats the database write still clears the entry');

// 8
const m6 = msg('m6');
api.sendViaP2P('B', m6.envelope, m6.track);
await settle();
for (let i = 0; i < 6; i++) { now += 31_000; await flush(); }
assert.equal(inflight().length, 0, 'gives up after 5 unanswered resends');
console.log('PASS gives up after 5 resends without a receipt');

// 9 真的 storage.ts：sessionReset 時的清除
const SQL = await require('sql.js/dist/sql-asm.js')();
const sqlite = new SQL.Database();
const schemaSql = readFileSync(join(ROOT, 'src/services/database.ts'), 'utf8').split('const SCHEMA_SQL')[1];
for (const t of ['pending_messages', 'group_outbox_payloads']) {
  const a = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  sqlite.run(schemaSql.slice(a, schemaSql.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;
const dir = mkdtempSync(join(tmpdir(), 'dreceipt-'));
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    const S = () => globalThis.__sqlite;
    export async function run(sql, params = []) { S().run(sql, params); return S().getRowsModified(); }
    export async function query(sql, params = []) { const st = S().prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function runBatch(sets) { for (const s of sets) S().run(s.statement, s.values); return 0; }
    export async function initDatabase() {} export async function getSetting() { return null; } export async function setSetting() {} export async function deleteSetting() {}` }));
} };
await build({ stdin: { contents: "export * from './src/services/storage.ts';", resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const st = await import(pathToFileURL(join(dir, 's.mjs')));
await st.addPendingMessage({ id: 'q1', recipientPubkey: 'B', encryptedPayload: '{"type":"encrypted_message","payload":"OLD"}', messageType: 'encrypted_message',
  originalContent: JSON.stringify({ messageId: 'x1', plaintext: '{"id":"x1","content":"queued"}' }), createdAt: 1 });
await st.addPendingMessage({ id: 'q2', recipientPubkey: 'B', encryptedPayload: '{"type":"encrypted_message","payload":"OLD-CTL"}', messageType: 'encrypted_message', createdAt: 2 });
await st.addPendingMessage({ id: 'inflight-x2', recipientPubkey: 'B', encryptedPayload: '{"type":"plaintext_inflight","payload":"{\\"id\\":\\"x2\\"}"}', messageType: 'plaintext_inflight', createdAt: 3 });
await st.deletePendingMessagesForRecipient('B');
const left = Object.fromEntries((await st.getPendingMessagesForRecipient('B')).map((r) => [r.id, r]));
assert.equal(left.q1?.messageType, 'plaintext_pending', 'a queued chat message is turned back into plaintext-pending (sent with the new session)');
assert.equal(JSON.parse(left.q1.encryptedPayload).payload, '{"id":"x1","content":"queued"}');
assert.equal(left.q2, undefined, 'ciphertext without a plaintext copy (old session) is dropped');
assert.equal(left['inflight-x2']?.messageType, 'plaintext_inflight', 'awaiting-receipt entries survive a session reset');
console.log('PASS a session reset keeps queued chat messages (as plaintext-pending) and awaiting-receipt entries');

// 10 AppProvider／useChat／ForwardModal
const app = readFileSync(ROOT + 'src/providers/AppProvider.tsx', 'utf8');
const body = app.slice(app.indexOf('const processEncryptedMessage = async'), app.indexOf('processEncryptedMessageRef.current = processEncryptedMessage'));
const ackAt = body.indexOf("type === 'msg_ack'");
assert.ok(ackAt > 0, 'AppProvider handles msg_ack');
assert.match(body.slice(ackAt, ackAt + 400), /confirmDelivered\(senderPublicKeyBase64[\s\S]*?return;/, 'msg_ack goes to confirmDelivered and is not shown');
assert.ok(ackAt < body.indexOf('DIRECT_VISIBLE_TYPES'), 'msg_ack is handled before the visible-type check');
const stored = body.indexOf('await receiveMessage(friend.id, newMessage)');
assert.match(body.slice(stored, stored + 400), /sendDirectReceipt\(senderPublicKeyBase64, messageData\.id\)/, 'a receipt is sent after the message is stored');
const receipt = app.slice(app.indexOf('const sendDirectReceipt'), app.indexOf('const processEncryptedMessage = async'));
assert.match(receipt, /type: 'msg_ack'[\s\S]*ackIds: \[messageId\]/, 'the receipt is a msg_ack with the message id');
assert.match(receipt, /await encrypt\(peer/, 'the receipt is DR-encrypted');
assert.match(receipt, /ack\.free\(\)/, 'the WASM ciphertext object is freed');
const chat = readFileSync(ROOT + 'src/hooks/useChat.ts', 'utf8');
assert.match(chat, /sendViaP2P\(currentFriend\.publicKey, p2pPayload, \{ messageId, plaintext: JSON\.stringify\(messageData\) \}\)/, 'chat messages are tracked');
const fwd = readFileSync(ROOT + 'src/components/FileShare/ForwardModal.tsx', 'utf8');
assert.match(fwd, /sendViaP2P\(targetPubkey, p2pPayload, \{ messageId, plaintext: JSON\.stringify\(messageData\) \}\)/, 'forwarded messages are tracked');
console.log('PASS AppProvider confirms msg_ack, acknowledges stored messages; chat and forward sends are tracked');

/**
 * 帳號從這台裝置清掉時，MQTT 待送佇列（IndexedDB）也要清（對應群星 P3-4，AegisPlay 2c132d6）。
 *   待送佇列存在全域的 IndexedDB（aegistalk-mqtt-outbox），不分帳號。AegisTalk 有兩條「帳號離開這台」的路：
 *   被新裝置踢下線（deviceClaim.wipeLocalKeys）與換機模式登出（SettingsPage）。兩條都沒清佇列：
 *   下一個帳號一連上就把上一個帳號排隊的 X3DH_INIT／群組事件用舊身分送出去 ——
 *   對方會因此重設跟新裝置剛建好的 session。現在：先停 MQTT（不再收新的），再清佇列。
 *
 * SQLite 的待送（pending_messages，連同 v11 起群組共用的密文表 group_outbox_payloads）也是這個帳號的：
 *   以前清除帳號（storage.clearAllData）只刪訊息、對話、聯絡人、ratchet，被踢時（wipeLocalKeys）更是一筆都不刪。
 *   下一個帳號一開 App，loadOutbox 就照收件人把上一個帳號的 1 對 1 密文、排隊的明文、群組密文（帶著上一個帳號的簽章）
 *   撥出去。現在兩條路都清；而且換機登出等清完、存檔落地才 reload（以前 resetAll 沒等就 reload，web 版的刪除根本沒存檔）。
 *   真的 storage.ts，底下是真的 SQLite（sql.js）＋ database.ts 裡真的 schema。
 * Run: node scripts/review/account_wipe_outbox_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { extStubPlugin } from './extStub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build, transformSync } = require('esbuild');
const events = globalThis.__events = [];
const dir = mkdtempSync(join(tmpdir(), 'wipeoutbox-'));

// ── 清除帳號：storage.clearAllData／clearAllPendingMessages（真的 SQLite） ──
const SQL = await require('sql.js/dist/sql-asm.js')();
const sqlite = new SQL.Database();
const schemaSql = readFileSync(join(root, 'packages/pwa/src/services/database.ts'), 'utf8').split('const SCHEMA_SQL')[1];
const TABLES = ['contacts', 'conversations', 'messages', 'ratchet_states', 'pending_messages', 'group_outbox_payloads', 'settings'];
for (const t of TABLES) {
  const a = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  assert.ok(a >= 0, `schema for ${t}`);
  sqlite.run(schemaSql.slice(a, schemaSql.indexOf(');', a) + 2));
}
globalThis.__sqlite = sqlite;
const fixture = { name: 'fx', setup(b) {
  b.onResolve({ filter: /^\.\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
  b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js', contents: `
    const S = () => globalThis.__sqlite;
    export async function run(sql, params = []) { S().run(sql, params); return S().getRowsModified(); }
    export async function query(sql, params = []) { const st = S().prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    export async function queryOne(sql, params = []) { return (await query(sql, params))[0] ?? null; }
    export async function runBatch(sets) { S().run('BEGIN'); try { for (const s of sets) S().run(s.statement, s.values); S().run('COMMIT'); } catch (e) { S().run('ROLLBACK'); throw e; } return 0; }
    export async function initDatabase() {} export function isDatabaseReady() { return true; }
    export async function getSetting() { return null; } export async function setSetting() {}` }));
} };
await build({ stdin: { contents: "export * from './packages/pwa/src/services/storage.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 's.mjs'), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
const storage = await import(pathToFileURL(join(dir, 's.mjs')));
const count = (t) => sqlite.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0];
async function seedAccount() {
  sqlite.run(`INSERT INTO contacts (pubkey, nickname, avatar, added_at, trust_level) VALUES ('PEER', 'p', '', 1, 'verified')`);
  sqlite.run(`INSERT INTO ratchet_states (peer_pubkey, state_blob, updated_at) VALUES ('PEER', 'blob', 1)`);
  // W4：好友之間的 presence 秘密（presenceStore：settings 的 presence_secret:<我>）也是這個帳號的
  sqlite.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('presence_secret:ME', '{"v":1}', 1)`);
  sqlite.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mist_language', 'zh-TW', 1)`);
  await storage.addPendingMessage({ id: 'd1', recipientPubkey: 'PEER', encryptedPayload: 'ratchet-ct', messageType: 'encrypted_message', createdAt: 1 });
  await storage.addPendingMessage({ id: 'd2', recipientPubkey: 'PEER', encryptedPayload: '{"type":"plaintext_pending"}', messageType: 'plaintext_pending', originalContent: 'my words', createdAt: 2 });
  for (const pk of ['M1', 'M2', 'M3']) {
    await storage.addGroupPendingMessage({ id: `ginflight-gm1-${pk}`, recipientPubkey: pk, messageType: 'group_inflight', createdAt: 3 }, 'gm1', 'group-ct-signed-by-me');
  }
  assert.equal(count('pending_messages'), 5, 'seed: 1-1 and group entries queued');
  assert.equal(count('group_outbox_payloads'), 1, 'seed: one shared group ciphertext');
}
/** localStorage 的替身：mqtt 記著的群組／presence 主題（W4 審查 #11）跟其他的 key */
function fakeLocalStorage(keys) {
  const m = new Map(keys.map((k) => [k, 'x']));
  return { m, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); events.push('rm:' + k); },
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}
const REMEMBERED = ['aegis_mqtt_presence_topics:ME', 'aegis_mqtt_group_topics:ME', 'aegis_mqtt_presence_topics:OTHER'];
globalThis.localStorage = fakeLocalStorage([...REMEMBERED, 'mist_language_ui']);
await seedAccount();
await storage.clearAllData();
assert.deepEqual([...globalThis.localStorage.m.keys()], ['mist_language_ui'],
  'clearing the account drops the remembered group / presence topics (friends\' keys and current tags) of every account, nothing else');
assert.equal(count('contacts') + count('ratchet_states'), 0, 'clearing the account still drops contacts and ratchets');
assert.equal(count('pending_messages'), 0, 'clearing the account drops its queued 1-1 / group outbox entries');
assert.equal(count('group_outbox_payloads'), 0, 'and the shared group ciphertexts (schema v11 table)');
assert.equal(sqlite.exec(`SELECT COUNT(*) FROM settings WHERE key LIKE 'presence_secret:%'`)[0].values[0][0], 0, 'and the presence secrets (W4: mine and my friends\' S)');
assert.equal(sqlite.exec(`SELECT COUNT(*) FROM settings WHERE key = 'mist_language'`)[0].values[0][0], 1, 'other settings stay');
assert.deepEqual(await storage.getAllPendingMessages(), [], 'the next account\'s loadOutbox finds nothing to send');
assert.equal(typeof storage.clearAllPendingMessages, 'function', 'storage exposes clearAllPendingMessages for the kick wipe');
await seedAccount();
await storage.clearAllPendingMessages();
assert.equal(count('pending_messages') + count('group_outbox_payloads'), 0, 'clearAllPendingMessages drops both outbox tables');
assert.equal(count('contacts'), 1, 'and nothing else');
// 一起刪、一起成功：中途失敗的話不會留下「參照刪了、密文還在」或反過來
sqlite.run(`CREATE TRIGGER wipe_fail BEFORE DELETE ON group_outbox_payloads BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
await storage.addGroupPendingMessage({ id: 'ginflight-gm2-M1', recipientPubkey: 'M1', messageType: 'group_inflight', createdAt: 4 }, 'gm2', 'ct');
await assert.rejects(storage.clearAllPendingMessages(), /fixture failure/, 'a failed wipe is reported, not swallowed');
assert.equal(count('pending_messages'), 1, 'a failed wipe rolls back: references are not dropped without their ciphertext');
sqlite.run('DROP TRIGGER wipe_fail');
await storage.clearAllPendingMessages();
console.log('PASS clearing the account drops the SQLite outbox (pending_messages + group_outbox_payloads) in one transaction');

// ── 被踢：deviceClaim.wipeLocalKeys ──
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@capacitor\/core$|^\.\/crypto$|^\.\/deviceId$|utils\/devLog$|^\.\/database$|^\.\/mqtt$|^\.\/outgoingQueueStore$|^\.\/storage$|^\.\/guardianBackground$|^\.\/fileTransfer$|^\.\/p2pSend$|^\.\/presenceStore$|^\.\/ringSync$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@capacitor/core' ? 'export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web" };'
    : a.path === './ringSync' ? 'export async function clearRingData(){ globalThis.__events.push("clear-ring") }'
    : a.path === './crypto' ? 'export class Identity {}'
    : a.path === './deviceId' ? 'export async function getDeviceId(){ return "d" }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path === './database' ? `export async function deleteSetting(k){ globalThis.__events.push("del:" + k) }
        export async function flushToStore(o){ globalThis.__events.push(o?.seal ? "flush-store-sealed" : "flush-store") }`
    : a.path === './storage' ? `export async function clearAllPendingMessages(){
        if (globalThis.__failSqliteWipe) throw new Error("db busy"); globalThis.__events.push("clear-sqlite-outbox") }`
    : a.path === './mqtt' ? 'export const mqttService = { disconnect(){ globalThis.__events.push("stop-mqtt") } };'
    : a.path === './guardianBackground' ? 'export async function clearGuardianNativeData(){ globalThis.__events.push("clear-guardian") }'
    : a.path === './fileTransfer' ? 'export async function shutdownFileTransfer(){ globalThis.__events.push("stop-file-transfer") }'
    : a.path === './p2pSend' ? 'export async function shutdownP2PAccount(){ globalThis.__events.push("stop-p2p") }'
    : a.path === './presenceStore' ? 'export async function wipePresenceSecrets(){ globalThis.__events.push("wipe-presence") }'
    : `export async function clearAllOutgoing(){
        if (globalThis.__failIdbWipe) throw new Error("idb blocked"); globalThis.__events.push("clear-mqtt-outbox") }` }));
} };
// 帳號備份（官方版的 v2 blob sync）停在 ext.identity.backup.clear()（開源第 5a 步起經 @ext）
globalThis.__extHooks = { backupClear: () => { globalThis.__events.push('stop-blob'); } };
await build({ entryPoints: [root + 'packages/pwa/src/services/deviceClaim.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'd.mjs'), logLevel: 'silent', plugins: [stub, extStubPlugin()], define: { 'import.meta.env': '{}' } });
globalThis.localStorage = fakeLocalStorage([...REMEMBERED, 'mist_keys']);
console.error = () => {};
const { wipeLocalKeys } = await import(pathToFileURL(join(dir, 'd.mjs')));
events.length = 0;
await wipeLocalKeys();
assert.ok(events.includes('rm:mist_keys'), 'keys are still wiped');
assert.ok(events.includes('clear-mqtt-outbox'), 'kick wipe clears the MQTT outbox');
assert.ok(events.includes('clear-guardian'), 'kick wipe clears the native guardian data (check-in config, legacy credentials, pending "I am OK")');
assert.ok(events.includes('clear-ring'), 'kick wipe clears the ring-token data (friend copy, who I am, seen calls; open-source step 5d)');
assert.ok(events.indexOf('stop-mqtt') >= 0 && events.indexOf('stop-mqtt') < events.indexOf('clear-mqtt-outbox'), 'MQTT stops before the outbox is cleared');
console.log('PASS kicked device: MQTT stopped, then its outbox cleared');
assert.ok(events.includes('clear-sqlite-outbox'), 'kick wipe also clears the SQLite outbox (1-1, group references, group ciphertexts)');
assert.ok(events.indexOf('stop-mqtt') < events.indexOf('clear-sqlite-outbox'), 'after MQTT stops');
const flushAt = events.indexOf('flush-store');
assert.ok(flushAt > events.indexOf('clear-sqlite-outbox'), 'then saved right away (web), so the reload a moment later keeps the wipe');
assert.ok(!events.includes('flush-store-sealed'), 'without sealing the store (the kicked page keeps running until the reload)');
// 被踢的頁面還要倒數幾秒才 reload：還在跑的傳檔與送訊先停（對應群星 shutdownP2PAccount），清完 outbox 之後不會又寫回一筆
assert.ok(events.indexOf('stop-file-transfer') >= 0 && events.indexOf('stop-file-transfer') < events.indexOf('clear-sqlite-outbox'), 'file transfer stops before the SQLite outbox is cleared');
assert.ok(events.indexOf('stop-p2p') >= 0 && events.indexOf('stop-p2p') < events.indexOf('clear-sqlite-outbox'), 'P2P sending stops (and drains its writes) before the SQLite outbox is cleared');
assert.ok(events.includes('rm:aegis_file_pending'), 'the pending-file list (with file keys) is cleared too');
assert.ok(events.includes('wipe-presence'), 'the presence secrets (W4: mine and my friends\' S) are wiped too');
assert.ok(REMEMBERED.every((k) => events.includes('rm:' + k)), 'and the remembered group / presence topics (W4 review #11)');
assert.ok(events.indexOf('stop-mqtt') < events.indexOf('rm:' + REMEMBERED[0]), 'after MQTT stopped (it cannot write them back)');
events.length = 0;
globalThis.__failIdbWipe = true;
await wipeLocalKeys();
assert.ok(events.includes('clear-sqlite-outbox'), 'an IndexedDB that will not open does not stop the SQLite outbox wipe');
globalThis.__failIdbWipe = false;
events.length = 0;
globalThis.__failSqliteWipe = true;
await wipeLocalKeys();
assert.ok(events.includes('rm:mist_keys') && events.includes('clear-mqtt-outbox'), 'a failed SQLite wipe does not undo the rest of the kick wipe');
globalThis.__failSqliteWipe = false;
console.log('PASS kicked device: the SQLite outbox is cleared and saved too');

// ── 換機模式登出：SettingsPage.handleDeviceTransferSuccess ──
const page = readFileSync(root + 'packages/pwa/src/pages/SettingsPage.tsx', 'utf8');
const s = page.indexOf('const handleDeviceTransferSuccess = ');
const e = page.indexOf('\n  };\n', s);
assert.ok(s > 0 && e > s, 'handleDeviceTransferSuccess found');
const code = transformSync('globalThis.__h = ' + page.slice(s + 'const handleDeviceTransferSuccess = '.length, e + 4), { loader: 'ts' }).code;
// resetAll（chatStore → storage.clearAllData，上面驗過會清 SQLite 待送）是非同步的：要等它做完、存檔落地才 reload
async function runTransfer(mode, { resetFails = false } = {}) {
  const ev = [];
  const ctx = { globalThis: {}, console: { error() {}, warn() {}, log() {} },
    resetAll: async () => { await new Promise((r) => setTimeout(r, 20)); if (resetFails) throw new Error('db busy'); ev.push('reset'); },
    flushToStore: async (o) => { await new Promise((r) => setTimeout(r, 5)); ev.push(o?.seal ? 'flush-store-sealed' : 'flush-store'); },
    localStorage: { removeItem: (k) => ev.push('rm:' + k) },
    window: { location: { reload: () => ev.push('reload') } }, setShowDeviceTransfer: () => ev.push('close'),
    mqttService: { disconnect: () => ev.push('stop-mqtt') }, clearAllOutgoing: async () => { ev.push('clear-mqtt-outbox'); },
    clearGuardianNativeData: async () => { ev.push('clear-guardian'); },
    shutdownFileTransfer: async () => { ev.push('stop-file-transfer'); }, shutdownP2PAccount: async () => { ev.push('stop-p2p'); } };
  runInNewContext(code, ctx);
  await ctx.globalThis.__h(mode);
  await new Promise((r) => setTimeout(r, 50));   // 沒等的話 reset 會在 reload 之後才出現
  return ev;
}
let ev = await runTransfer('transfer');
assert.ok(ev.includes('clear-mqtt-outbox'), 'transfer-mode logout clears the MQTT outbox');
assert.ok(ev.indexOf('stop-mqtt') < ev.indexOf('clear-mqtt-outbox'), 'MQTT stops before the outbox is cleared');
assert.ok(ev.indexOf('clear-mqtt-outbox') < ev.indexOf('reload'), 'cleared before the page reloads');
assert.ok(ev.includes('reset') && ev.indexOf('reset') < ev.indexOf('reload'),
  'the account wipe (SQLite outbox included) finishes before the page reloads');
assert.ok(ev.indexOf('reset') < ev.indexOf('flush-store-sealed') && ev.indexOf('flush-store-sealed') < ev.indexOf('reload'),
  'and is saved (sealed, like exitChat) before the reload');
assert.ok(ev.indexOf('stop-mqtt') < ev.indexOf('reset'), 'MQTT stops before the wipe');
assert.ok(ev.includes('clear-guardian') && ev.indexOf('clear-guardian') < ev.indexOf('reload'), 'the native guardian data is cleared before the reload');
assert.ok(ev.includes('stop-file-transfer') && ev.indexOf('stop-file-transfer') < ev.indexOf('reset'), 'file transfer stops before the account wipe');
assert.ok(ev.includes('stop-p2p') && ev.indexOf('stop-p2p') < ev.indexOf('reset'), 'P2P sending stops before the account wipe (no write after the outbox is cleared)');
assert.ok(ev.includes('rm:aegis_file_pending'), 'the pending-file list is cleared');
ev = await runTransfer('transfer', { resetFails: true });
assert.ok(ev.includes('reload') && ev.includes('rm:mist_keys'), 'a failed wipe still logs this device out (the account has moved)');
ev = await runTransfer('multi-device');
assert.deepEqual(ev, ['close'], 'multi-device mode keeps the account (and its outbox)');
console.log('PASS transfer-mode logout: MQTT stopped, both outboxes cleared and saved before reload; multi-device untouched');

// chatStore.resetAll 等 clearAllData 做完才回（上面「reload 之前清完」靠它）
const chatStoreSrc = readFileSync(root + 'packages/pwa/src/stores/chatStore.ts', 'utf8');
const resetBody = chatStoreSrc.slice(chatStoreSrc.indexOf('resetAll: async () => {'), chatStoreSrc.indexOf('\n  },', chatStoreSrc.indexOf('resetAll: async () => {')));
assert.match(resetBody, /await storage\.clearAllData\(\)/, 'chatStore.resetAll awaits storage.clearAllData');
console.log('PASS chatStore.resetAll waits for the SQLite wipe');

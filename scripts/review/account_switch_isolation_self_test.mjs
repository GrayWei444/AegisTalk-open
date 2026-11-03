/**
 * 換帳號／帳號離開這台時，上一個帳號還在跑的送訊與傳檔不能漏到下一個帳號（移植群星 p2pSend owner／generation、
 * shutdownP2PAccount、AppProvider 的 fileTransfer session 檢查）。
 *   真的 p2pSend.ts：
 *   1. 讀 outbox 讀到一半換帳號 → 讀出來的上一個帳號的密文不會用新帳號的通道送出、也不會刪
 *   2. 加密到一半換帳號 → 加密結果不送；新帳號自己的照常送
 *   3. 查數量查到一半帳號離開 → 不寫進 outbox；寫到一半帳號離開 → shutdownP2PAccount 等它寫完才回（呼叫端才清 outbox）
 *   4. 同一個帳號重跑 effect（重新註冊）不影響排隊中的寫入；帳號離開後舊 effect 晚到的註冊不能重新打開
 *   5. 新帳號不能用上一個帳號註冊的加密器
 *   AppProvider／wipe 路徑：
 *   6. P2P 註冊的 import 晚於 effect 清掉時不註冊；帶 owner；fileTransfer 的 callback 換 session 後不送、不存
 *   7. 被踢（wipeLocalKeys）與換機登出：清 SQLite outbox 之前先 shutdownFileTransfer＋shutdownP2PAccount，也清 aegis_file_pending
 * Run: node scripts/review/account_switch_isolation_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const require = createRequire(new URL('../../packages/pwa/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const read = (p) => readFileSync(new URL('../../packages/pwa/src/' + p, import.meta.url), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

let readPending, encryptPending, countPending, writePending;
let rows = [], sent = [], removed = [], writes = 0;
const module = { exports: {} };
runInNewContext(transformSync(read('services/p2pSend.ts'), { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, console: quiet, crypto: webcrypto, Date, setTimeout: () => 0, clearTimeout() {},
  require: (n) => ({
    '../utils/devLog': { devLog() {}, devWarn() {} }, '../utils/diagLog': { diagLog() {} },
    './storage': {
      getPendingMessagesForRecipient: async () => (readPending ? new Promise((r) => { readPending = r; }) : rows),
      getAllPendingMessages: async () => [],
      getPendingMessageCount: async () => (countPending ? new Promise((r) => { countPending = r; }) : 0),
      addPendingMessage: async () => { writes++; if (writePending) await new Promise((r) => { writePending = r; }); },
      removePendingMessage: async (id) => removed.push(id),
      updatePendingMessageRetry: async () => {},
    },
  })[n],
});
const p2p = module.exports;
const register = (owner) => p2p.registerP2PFunctions({ isConnectedTo: () => false, sendToPeer: (_p, data) => { sent.push({ owner, data }); return true; }, connectPeer: async () => {} }, owner);

// 1
register('A'); readPending = true;
const first = p2p.flushQueueForPeer('peer'); await tick();
await p2p.shutdownP2PAccount(); register('B');
readPending([{ id: 'old', messageType: 'encrypted_message', encryptedPayload: 'old', retryCount: 0, createdAt: 1 }]); await first; readPending = null;
assert.equal(sent.length, 0, "the previous account's ciphertext is not sent on the new account's channel");
assert.equal(removed.length, 0, 'nor removed');
console.log('PASS an outbox read that finishes after an account switch sends nothing');

// 2
rows = [{ id: 'plain', messageType: 'plaintext_pending', encryptedPayload: JSON.stringify({ payload: 'private' }), retryCount: 0, createdAt: 2 }];
p2p.registerOutboxEncrypt(async () => new Promise((r) => { encryptPending = r; }), 'B');
const encrypting = p2p.flushQueueForPeer('peer'); await tick();
await p2p.shutdownP2PAccount(); register('C');
encryptPending('old-cipher'); await encrypting;
assert.equal(sent.length, 0, 'an encryption that finishes after the switch is not sent');
p2p.registerOutboxEncrypt(async () => 'current-cipher', 'C');
assert.equal(await p2p.flushQueueForPeer('peer'), 1);
assert.equal(sent[0].owner, 'C', "the new account's own message goes out");
console.log('PASS an encryption that finishes after an account switch is dropped; the new account still sends');

// 3
countPending = true; p2p.sendViaP2P('peer', 'pending'); await tick();
const stopping = p2p.shutdownP2PAccount(); countPending(0); await stopping; countPending = null;
assert.equal(writes, 0, 'nothing is written to the outbox after the account left');
register('D'); writePending = true; p2p.sendViaP2P('peer', 'pending'); await tick();
let drained = false;
const stop = p2p.shutdownP2PAccount().then(() => { drained = true; }); await tick();
assert.equal(drained, false, 'shutdown waits for the write that is in progress');
writePending(); await stop;
assert.equal(drained, true);
console.log('PASS writes that lost the race are not stored; shutdown waits for a write in progress before the outbox is cleared');

// 4
register('E'); writePending = null; countPending = true; p2p.sendViaP2P('peer', 'same-account'); await tick();
register('E'); countPending(0); countPending = null; await tick();
assert.equal(writes, 2, 'a re-render of the same account keeps the queued write');
await p2p.shutdownP2PAccount(); register('E'); p2p.sendViaP2P('peer', 'retired'); await tick();
assert.equal(writes, 2, "a late registration from the retired account's effect cannot reopen it");
console.log('PASS same-account re-registration keeps work; a retired account cannot be reopened by a late effect');

// 5
register('F'); p2p.registerOutboxEncrypt(async () => 'wrong-account', 'E');
assert.equal(await p2p.flushQueueForPeer('peer'), 0, "a new account cannot use the previous account's encryptor");
p2p.registerOutboxEncrypt(async () => 'right-account', 'F');
assert.equal(await p2p.flushQueueForPeer('peer'), 1);
console.log("PASS a new account cannot use the previous account's encryptor");

// 6
const provider = read('providers/AppProvider.tsx');
{
  const start = provider.indexOf('  useEffect(() => {\n    let cancelled = false;', provider.indexOf('const outboxLoadedRef'));
  const end = provider.indexOf('  }, [webrtc, publicKey]);', start) + '  }, [webrtc, publicKey]);'.length;
  assert.ok(start >= 0 && end > start, 'found the P2P registration effect');
  const code = transformSync(provider.slice(start, end).replace("import('../services/p2pSend')", 'loadRegistration()'), { loader: 'ts' }).code;
  let resolveModule, cleanup, registered = [];
  const ctx = { useEffect: (fn) => { cleanup = fn(); }, loadRegistration: () => new Promise((r) => { resolveModule = r; }), webrtc: {}, publicKey: 'A', outboxLoadedRef: { current: null } };
  runInNewContext(code, ctx);
  cleanup();
  resolveModule({ registerP2PFunctions: (...a) => registered.push(a), unregisterP2PFunctions() {}, loadOutbox() {} }); await tick();
  assert.equal(registered.length, 0, 'an import that resolves after the effect was cleaned up does not register stale callbacks');
  runInNewContext(code, ctx);
  resolveModule({ registerP2PFunctions: (...a) => registered.push(a), unregisterP2PFunctions() {}, loadOutbox() {} }); await tick();
  assert.equal(registered.length, 1);
  assert.equal(registered[0][1], 'A', 'registration carries the account (owner)');
}
{
  const ft = provider.slice(provider.indexOf('// 大檔分塊傳輸 (LEARNINGS §1)'), provider.indexOf('}, [publicKey, cryptoReady, encrypt]);'));
  assert.match(ft, /const session = fileTransfer\.fileTransferSession\(\);\s*const active = \(\) => !cancelled && session === fileTransfer\.fileTransferSession\(\);/, 'the file-transfer effect remembers its session');
  const manifest = ft.slice(ft.indexOf('sendManifest: async'), ft.indexOf('getBufferedAmount:'));
  assert.match(manifest, /if \(!active\(\)\) return;[\s\S]*await encrypt\([\s\S]*if \(!active\(\)\) return;[\s\S]*sendViaP2P/, 'a manifest encrypted for an old session is not sent');
  const control = ft.slice(ft.indexOf('sendControl: async'), ft.indexOf('const unsubReceived'));
  assert.match(control, /if \(!active\(\)\) return;[\s\S]*await encrypt\([\s\S]*if \(!active\(\)\) return;[\s\S]*sendViaP2P/, 'a file ack for an old session is not sent');
  const received = ft.slice(ft.indexOf('fileTransfer.onFileReceived(async (rf) => {'));
  assert.match(received, /^fileTransfer\.onFileReceived\(async \(rf\) => \{\s*if \(!active\(\)\) return;/, 'a file received for an old session is not stored');
  assert.ok((received.match(/if \(!active\(\)\) return;/g) ?? []).length >= 3, 'checked again after the scan and after storing');
  assert.match(ft, /return \(\) => \{\s*cancelled = true;/, 'cleanup marks the effect cancelled');
}
console.log('PASS AppProvider: late imports do not register, registration carries the account, file callbacks check their session');

// 7
const wipe = read('services/deviceClaim.ts');
const w = wipe.slice(wipe.indexOf('export async function wipeLocalKeys'));
const order = (src, names) => names.map((n) => { const i = src.indexOf(n); assert.ok(i >= 0, `calls ${n}`); return i; });
const [ft1, p2p1, clear1] = order(w, ['await shutdownFileTransfer()', 'await shutdownP2PAccount()', 'await clearAllPendingMessages()']);
assert.ok(ft1 < clear1 && p2p1 < clear1, 'kick wipe: stop file transfer and P2P before clearing the outbox');
assert.match(w, /localStorage\.removeItem\('aegis_file_pending'\)/, 'kick wipe clears the pending-file list');
const settings = read('pages/SettingsPage.tsx');
const s = settings.slice(settings.indexOf('const handleDeviceTransferSuccess'));
const [ft2, p2p2, reset2] = order(s, ['await shutdownFileTransfer()', 'await shutdownP2PAccount()', 'await resetAll()']);
assert.ok(ft2 < reset2 && p2p2 < reset2, 'device-transfer logout: stop file transfer and P2P before the account wipe');
assert.match(s.slice(0, s.indexOf('window.location.reload()')), /'aegis_file_pending'/, 'device-transfer logout clears the pending-file list');
console.log('PASS kick wipe and device-transfer logout stop P2P and file transfer before clearing the outbox');

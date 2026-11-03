/**
 * 回條只處理「我真的送給他、還在等回條」的那幾則（對應群星 b4fdce19，審查 HIGH：灌 group_msg_ack）。
 * 以前任何連得上的人送 group_msg_ack，每個 id 都記進 recentAcks、各下一條 SQLite DELETE，recentAcks 超過 500 筆後
 * 每個回條還整份掃一遍：40,000 個假 id ＝ 40,000 條 DELETE、主線程卡住。真的 p2pSend.ts、假時鐘、記憶體 outbox。
 *   1. 沒在等的 id（亂造的、別人的、已確認過的）不碰資料庫，40,000 個在 2 秒內處理完
 *   2. 真的在等的照常確認，只有收件人自己的回條算數
 *   3. 每個對象有額度：灌爆的那個人自己的回條暫時不算（之後照常重送），別人的不受影響；額度會回補
 *   4. App 重開後，從 outbox 讀到的「等回條」照樣認得回條
 *   5. 回條比「等回條」那筆寫進資料庫還早到 → 寫完就刪（舊行為保留）
 *   6. AppProvider 重跑註冊（unregister → register）不會忘掉在等的回條
 * Run: node scripts/review/group_ack_flood_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const { transformSync } = createRequire(ROOT + 'package.json')('esbuild');
const code = transformSync(readFileSync(ROOT + 'src/services/p2pSend.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
let now = 1_800_000_000_000;
const FakeDate = class extends Date { static now() { return now; } };
let rows = [];
let deletes = 0;
let slowWrites = false;
const storage = {
  getPendingMessageCount: async (p) => rows.filter((m) => m.recipientPubkey === p).length,
  addPendingMessage: async (m) => {
    if (slowWrites) await new Promise((r) => setTimeout(r, 20));
    rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m });
  },
  // 群組：真的 storage 把密文只存一份、讀出時補上；這裡直接存在那一筆
  addGroupPendingMessage: async (m, messageId, payload) => {
    if (slowWrites) await new Promise((r) => setTimeout(r, 20));
    rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m, encryptedPayload: payload, payloadRef: messageId });
  },
  getPendingMessagesForRecipient: async (p) => rows.filter((m) => m.recipientPubkey === p).map((r) => ({ ...r })),
  getAllPendingMessages: async () => rows.map((r) => ({ ...r })),
  removePendingMessage: async (id) => { deletes++; rows = rows.filter((m) => m.id !== id); },
  removePendingMessageForRecipient: async (id, p) => { deletes++; rows = rows.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
  updatePendingMessageRetry: async (id) => { rows = rows.map((m) => m.id === id ? { ...m, retryCount: m.retryCount + 1, lastRetryAt: now } : m); },
};
function load() {
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, crypto: webcrypto, Date: FakeDate, Map, Set, Promise, JSON, setTimeout: () => 0, clearTimeout: () => {}, console: { error() {} },
    require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
  });
  const api = module.exports;
  api.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: () => true, connectPeer: async () => {}, channelOpenedAt: () => 0 });
  return api;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const groupWire = (id) => JSON.stringify({ type: 'group_key_message', payload: { messageId: id, groupId: 'g1', encrypted: { keyId: 'k1', ciphertext: 'X' + id } } });
const awaiting = (p) => rows.filter((r) => r.messageType === 'group_inflight' && r.recipientPubkey === p).length;
let api = load();

// 1
api.sendViaP2P('B', groupWire('gm1'), { messageId: 'gm1', group: true });
await settle();
deletes = 0;
const t0 = performance.now();
for (let f = 0; f < 800; f++) {
  api.confirmDelivered('PEER', Array.from({ length: 50 }, (_, i) => `gmsg-${f}-${i}-` + 'x'.repeat(100)));
  if (f % 100 === 0) now += 1000;
}
api.confirmDelivered('C', ['gm1']);                     // 別人替 B 確認
await settle();
const ms = performance.now() - t0;
console.log(`  flood: 40000 unknown ids from a connected peer → ${deletes} database deletes, ${ms.toFixed(0)} ms`);
assert.equal(deletes, 0, 'ids we are not waiting for never touch the database');
assert.ok(ms < 2000, `a 40,000-id flood is handled quickly (took ${ms.toFixed(0)} ms)`);
assert.equal(awaiting('B'), 1, "someone else's receipt does not confirm B's copy");
console.log('PASS receipts for messages we are not waiting for are ignored without database work');

// 2
api.confirmDelivered('B', ['gm1']);
await settle();
assert.equal(awaiting('B'), 0, 'the real recipient still confirms its copy');
assert.equal(deletes, 1, 'one targeted delete');
api.confirmDelivered('B', ['gm1']);
await settle();
assert.equal(deletes, 1, 'a repeated receipt for an already-confirmed message does nothing');
assert.equal(typeof api.confirmDelivered('B', ['nope']), 'number', 'confirmDelivered reports how many it confirmed (for the log)');
console.log('PASS awaited messages are still confirmed by their own recipient only');

// 3 額度：X 灌爆自己的額度 → X 自己的回條暫時不算；Y 不受影響；過一陣子回補
api.sendViaP2P('X', groupWire('gx'), { messageId: 'gx', group: true });
api.sendViaP2P('Y', groupWire('gy'), { messageId: 'gy', group: true });
await settle();
for (let f = 0; f < 100; f++) api.confirmDelivered('X', Array.from({ length: 50 }, (_, i) => `junk-${f}-${i}`));
api.confirmDelivered('X', ['gx']);
api.confirmDelivered('Y', ['gy']);
await settle();
assert.equal(awaiting('X'), 1, "the flooder's own receipts are ignored while its budget is spent (the message is simply resent later)");
assert.equal(awaiting('Y'), 0, "another peer's receipts are unaffected");
now += 60_000;
api.confirmDelivered('X', ['gx']);
await settle();
assert.equal(awaiting('X'), 0, 'the budget refills over time');
console.log('PASS each peer has its own receipt budget; a flood only slows down the flooder');

// 4 重開 App：outbox 裡的「等回條」照樣認得回條
api.sendViaP2P('B', groupWire('gm9'), { messageId: 'gm9', group: true });
await settle();
api = load();                                          // 新的模組實例＝重開 App（記憶體清空、SQLite 還在）
await api.loadOutbox();
api.confirmDelivered('B', ['gm9']);
await settle();
assert.equal(rows.filter((r) => r.recipientPubkey === 'B').length, 0, 'after a restart the persisted awaiting-receipt entries are confirmed by their receipts');
console.log('PASS after a restart, receipts still clear the awaiting entries read back from the outbox');

// 5
slowWrites = true;
api.sendViaP2P('B', groupWire('gm4'), { messageId: 'gm4', group: true });
api.confirmDelivered('B', ['gm4']);
await new Promise((r) => setTimeout(r, 40));
slowWrites = false;
assert.equal(awaiting('B'), 0, 'an early receipt still clears the entry once it is written');
console.log('PASS a receipt that beats the database write still clears the awaiting-receipt entry');

// 6 AppProvider 每次 render 都會重跑註冊的 effect（unregister → register）：等回條的名單不能跟著忘掉，
//   否則對方的回條被當成「沒在等」、那則 30 秒後白白重送（AegisTalk 登出／換帳號會整頁 reload，記憶體本來就清空）
api.sendViaP2P('B', groupWire('gm6'), { messageId: 'gm6', group: true });
await settle();
api.unregisterP2PFunctions();
api.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: () => true, connectPeer: async () => {}, channelOpenedAt: () => 0 });
assert.equal(api.confirmDelivered('B', ['gm6']), 1, 're-registering the P2P functions keeps the awaited receipts');
await settle();
assert.equal(awaiting('B'), 0);
console.log('PASS re-registering the P2P functions (AppProvider effect re-run) keeps the awaited receipts');

// 7 重跑註冊也不能忘掉「比寫入早到的回條」（recentAcks，程式碼審查 LOW）：以前每次 render 都清掉 → 那則 30 秒後白白重送
slowWrites = true;
api.sendViaP2P('B', groupWire('gm7'), { messageId: 'gm7', group: true });
api.confirmDelivered('B', ['gm7']);                     // 回條比「等回條」那筆寫進資料庫還早到
api.unregisterP2PFunctions();                            // 寫入完成之前 AppProvider 又 render 了一次
api.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: () => true, connectPeer: async () => {}, channelOpenedAt: () => 0 });
await new Promise((r) => setTimeout(r, 40));
slowWrites = false;
assert.equal(awaiting('B'), 0, 'an early receipt is still honoured after the P2P functions were re-registered');
console.log('PASS an early receipt survives re-registering the P2P functions');

// 8 時鐘往回調（程式碼審查 LOW）：額度不能因此變成負的、一小時都不收回條
api.sendViaP2P('Z', groupWire('gz'), { messageId: 'gz', group: true });
await settle();
api.confirmDelivered('Z', ['nope']);                     // 先建立 Z 的額度紀錄
now -= 3_600_000;
assert.equal(api.confirmDelivered('Z', ['gz']), 1, 'a clock that moved back does not drain the receipt budget');
now += 3_600_000;
console.log('PASS the receipt budget survives the clock moving backwards');

/**
 * 同一個 peer 同時兩次 flush 不能把同一批密文送兩次（稽核 M3，對應 AegisPlay B31 outbox_flush_race_self_test）。
 *   真的 p2pSend.ts，storage 換成記憶體（非同步，跟 jeep/capacitor 一樣）。
 *   以前：DataChannel open（自己的 channel＋ondatachannel 各一次）或 open＋X3DH_INIT 後的 flush 同時跑，
 *   兩邊都讀到同一批 → 同一則密文送兩次 → 對方第二次 AEAD 失敗 → 要求重建 session → 重建時把我的 outbox 刪掉。
 * Run: node scripts/review/outbox_flush_race_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const { transformSync } = createRequire(ROOT + 'package.json')('esbuild');
const src = readFileSync(ROOT + 'src/services/p2pSend.ts', 'utf8');
const module = { exports: {} };
let pending = [
  { id: 'p1', recipientPubkey: 'B', encryptedPayload: '{"type":"encrypted_message","payload":"CT1"}', messageType: 'encrypted_message', createdAt: 1 },
  { id: 'p2', recipientPubkey: 'B', encryptedPayload: '{"type":"encrypted_message","payload":"CT2"}', messageType: 'encrypted_message', createdAt: 2 },
];
const tick = () => new Promise((r) => setTimeout(r, 1));
const storage = {
  getPendingMessageCount: async (p) => { await tick(); return pending.filter((m) => m.recipientPubkey === p).length; },
  addPendingMessage: async (m) => { await tick(); pending.push(m); },
  getPendingMessagesForRecipient: async (p) => { await tick(); return pending.filter((m) => m.recipientPubkey === p); },
  getAllPendingMessages: async () => pending,
  removePendingMessage: async (id) => { await tick(); pending = pending.filter((m) => m.id !== id); },
  updatePendingMessageRetry: async () => {},
};
runInNewContext(transformSync(src, { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, crypto: webcrypto, Date, Map, Promise, setTimeout, JSON, console: { error() {} },
  require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
});
const api = module.exports;
const wire = [];
api.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: (_p, d) => { wire.push(JSON.parse(d).payload); return true; }, connectPeer: async () => {} });
await Promise.all([api.flushQueueForPeer('B'), api.flushQueueForPeer('B')]);
assert.deepEqual(wire, ['CT1', 'CT2'], `each ciphertext exactly once, in order (got ${wire.join(',')})`);
assert.equal(pending.length, 0);

// 排隊不能卡死：前一次 flush 丟例外，下一次照跑；不同 peer 不互等
pending.push({ id: 'p3', recipientPubkey: 'B', encryptedPayload: '{"type":"encrypted_message","payload":"CT3"}', messageType: 'encrypted_message', createdAt: 3 });
const orig = storage.getPendingMessagesForRecipient;
let failOnce = true;
storage.getPendingMessagesForRecipient = async (p) => { if (failOnce) { failOnce = false; throw new Error('db busy'); } return orig(p); };
const [failed, next] = await Promise.all([api.flushQueueForPeer('B'), api.flushQueueForPeer('B')]);
assert.equal(failed, 0, 'the first flush hit the DB error');
assert.equal(next, 1, 'the queued flush still runs after a failed one');
assert.deepEqual(wire, ['CT1', 'CT2', 'CT3']);
console.log('PASS concurrent flushes for one peer send each queued ciphertext once, in order; a failed flush does not block the next');

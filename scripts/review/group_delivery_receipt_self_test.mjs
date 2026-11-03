/**
 * 群組訊息也要等對方回條（對應群星 8708fa6f，多人模擬 S3／S5：對方剛關 App 或剛重開時，這邊的 DataChannel
 * 好幾秒內還說 open，群組扇出送進去就算送到，那幾則永遠不見）。真的 p2pSend.ts、假時鐘、記憶體 outbox。
 *   1. 群組訊息送給兩個成員 → 每人各一筆「等回條」（同一個 messageId 不會互相蓋掉）
 *   2. 30 秒內不重送；過了 30 秒沒回條 → **原封不動**重送同一份密文（群組金鑰密文跟 1-1 session 無關，不重新加密）
 *   3. 只有收件人自己的回條算數，也只清他那一筆
 *   4. 通道重建（新的 DataChannel 開了）→ 在舊通道送出、還沒回條的立刻重送，不必等 30 秒；新通道上送的照等
 *   5. 對方離線時排進佇列的群訊，連上送出後也轉成「等回條」
 *   6. 重送 5 次都沒回條 → 放棄
 *   7. 回條比「等回條」那筆寫進資料庫還早到 → 寫完就刪掉，不會 30 秒後白白重送
 *   8. 等回條的那筆不擋後面的待送；一般控制訊息（不帶 track）照舊送了就刪
 * Run: node scripts/review/group_delivery_receipt_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { extVm } from './extStub.mjs';
import { webcrypto } from 'node:crypto';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const { transformSync } = createRequire(ROOT + 'package.json')('esbuild');
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
  // 群組：真的 storage 把密文只存一份、讀出時補上；這裡直接存在那一筆
  addGroupPendingMessage: async (m, messageId, payload) => {
    if (slowWrites) await new Promise((r) => setTimeout(r, 20));
    rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m, encryptedPayload: payload, payloadRef: messageId });
  },
  getPendingMessagesForRecipient: async (p) => rows.filter((m) => m.recipientPubkey === p).sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r })),
  getAllPendingMessages: async () => rows,
  removePendingMessage: async (id) => { rows = rows.filter((m) => m.id !== id); },
  removePendingMessageForRecipient: async (id, p) => { rows = rows.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
  updatePendingMessageRetry: async (id) => { rows = rows.map((m) => m.id === id ? { ...m, retryCount: m.retryCount + 1, lastRetryAt: now } : m); },
};
const module = { exports: {} };
runInNewContext(transformSync(src, { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, crypto: webcrypto, Date: FakeDate, Map, Set, Promise, JSON, setTimeout: () => 0, console: { error() {} },
  require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
});
const api = module.exports;
const wire = { B: [], C: [] };
const connected = { B: true, C: true };
const openedAt = { B: 0, C: 0 };
let encCount = 0;
api.registerP2PFunctions({
  isConnectedTo: (p) => connected[p],
  sendToPeer: (p, d) => { if (!connected[p]) return false; wire[p].push(d); return true; },
  connectPeer: async () => {},
  channelOpenedAt: (p) => openedAt[p],
});
api.registerOutboxEncrypt(async (_peer, plaintext) => `CT(${JSON.parse(plaintext).id})#${++encCount}`);
const settle = () => new Promise((r) => setTimeout(r, 5));
const groupWire = (id) => JSON.stringify({ type: 'group_key_message', payload: { messageId: id, groupId: 'g1', encrypted: { keyId: 'k1', ciphertext: 'X' + id } } });
const ginflight = (p) => rows.filter((r) => r.messageType === 'group_inflight' && (!p || r.recipientPubkey === p));

// 1
const g1 = groupWire('gm1');
for (const p of ['B', 'C']) api.sendViaP2P(p, g1, { messageId: 'gm1', group: true });
await settle();
assert.deepEqual(wire.B, [g1]); assert.deepEqual(wire.C, [g1]);
assert.equal(ginflight('B').length, 1, 'B has an awaiting-receipt entry');
assert.equal(ginflight('C').length, 1, 'C has its own entry (same messageId, not overwritten)');
console.log('PASS a group message sent to several members leaves one awaiting-receipt entry per member');

// 2
now += 10_000; await api.flushQueueForPeer('B');
assert.equal(wire.B.length, 1, 'no resend within 30 s');
now += 25_000; await api.flushQueueForPeer('B');
assert.deepEqual(wire.B, [g1, g1], 'after 30 s the very same group ciphertext is resent');
assert.equal(encCount, 0, 'group messages are never re-encrypted with a 1-1 session');
console.log('PASS no receipt after 30 s → the same group ciphertext is resent (no 1-1 re-encryption)');

// 3
api.confirmDelivered('C', ['gm1']); await settle();
assert.equal(ginflight('B').length, 1, "C's receipt does not clear B's entry");
assert.equal(ginflight('C').length, 0, "C's receipt clears C's entry");
api.confirmDelivered('B', ['gm1']); await settle();
assert.equal(ginflight().length, 0, "B's receipt clears B's entry");
api.confirmDelivered('B', 'gm1'); api.confirmDelivered('B', [42, '', 'x'.repeat(200)]);   // 格式不對的回條不出錯
console.log('PASS only each recipient can confirm its own copy');

// 4 通道重建：舊通道上送的立刻重送；新通道上送的照等 30 秒
const g2 = groupWire('gm2');
api.sendViaP2P('B', g2, { messageId: 'gm2', group: true });
await settle();
now += 3_000;
openedAt.B = now;                                     // 舊通道其實已死，新的 DataChannel 剛開
await api.flushQueueForPeer('B');
assert.deepEqual(wire.B.slice(-2), [g2, g2], 'sent on the previous channel → resent at once when a new channel opens');
const before = wire.B.length;
now += 1_000; await api.flushQueueForPeer('B');
assert.equal(wire.B.length, before, 'resent on the current channel → waits for the receipt again');
api.confirmDelivered('B', ['gm2']); await settle();
console.log('PASS a new DataChannel resends what went out on the old one right away');

// 5
connected.C = false;
const g3 = groupWire('gm3');
api.sendViaP2P('C', g3, { messageId: 'gm3', group: true });
await settle();
assert.equal(rows.filter((r) => r.recipientPubkey === 'C' && r.messageType === 'group_key_message').length, 1, 'queued while C is offline');
now += 1_000; connected.C = true; openedAt.C = now;
await api.flushQueueForPeer('C'); await settle();
assert.equal(wire.C.at(-1), g3);
assert.equal(ginflight('C').length, 1, 'once sent it waits for C\'s receipt');
assert.equal(rows.filter((r) => r.recipientPubkey === 'C' && r.messageType === 'group_key_message').length, 0);
console.log('PASS queued group messages also wait for a receipt after they go out');

// 6
for (let i = 0; i < 6; i++) { now += 31_000; await api.flushQueueForPeer('C'); }
assert.equal(ginflight('C').length, 0, 'gives up after 5 unanswered resends');
console.log('PASS gives up after 5 resends without a receipt');

// 7
slowWrites = true;
const g4 = groupWire('gm4');
api.sendViaP2P('B', g4, { messageId: 'gm4', group: true });
api.confirmDelivered('B', ['gm4']);                 // 回條先到（那筆還在寫）
await new Promise((r) => setTimeout(r, 40));
slowWrites = false;
assert.equal(ginflight('B').length, 0, 'an early receipt still clears the entry once it is written');
console.log('PASS a receipt that beats the database write still clears the awaiting-receipt entry');

// 8
const g5 = groupWire('gm5');
api.sendViaP2P('B', g5, { messageId: 'gm5', group: true });
await settle();
connected.B = false;
const ack = JSON.stringify({ type: 'group_msg_ack', ids: ['zz'] });
api.sendViaP2P('B', ack);                            // 控制訊息：不帶 track
await settle();
connected.B = true;
now += 1_000;
const sentBefore = wire.B.length;
await api.flushQueueForPeer('B');
assert.equal(wire.B.length, sentBefore + 1, 'the queued control frame goes out although an older message is still awaiting its receipt');
assert.equal(wire.B.at(-1), ack);
assert.equal(rows.filter((r) => r.messageType === 'group_msg_ack').length, 0, 'a control frame is removed once sent (no receipt for it)');
assert.equal(ginflight('B').length, 1, 'the awaiting-receipt entry is still there');
console.log('PASS an awaiting-receipt entry does not block later queued frames; control frames are sent once');

// 9 接線：收端存好才回條、重送的只回條；寄件端群組扇出帶 track；通道 open 時間給 p2pSend
const read = (p) => readFileSync(ROOT + 'src/' + p, 'utf8');
const provider = read('providers/AppProvider.tsx');
const gk = provider.slice(provider.indexOf('const handleGroupKeyMessage'), provider.indexOf('const retryPendingGroupMessages'));
const dedupeAt = gk.indexOf('hasMessageFrom(messageId, senderPubkey)');
const saveAt = gk.indexOf('await storageSaveMessage(');
const ackAt = gk.lastIndexOf('ackGroupMessage(senderPubkey, messageId)');
assert.ok(dedupeAt > 0 && dedupeAt < gk.search(/decryptGroupMessage\(|decryptWithGroupKey\(/), 'a resent message already saved is only acknowledged (before decrypting again)');
assert.ok(saveAt > 0 && ackAt > saveAt, 'the receipt goes out only after the message is saved');
// 開源第 4 步：回條要是這條通道的對方簽的、回給我的（groupAck；簽章的測試在 group_ack_signed_self_test），才清他那幾筆
assert.ok(/parsed\.type === 'group_msg_ack'[\s\S]{0,900}openGroupAck\(\{ frame: parsed, from: peerPublicKey, to: me, verify: identityVerify \}\)[\s\S]{0,300}if \(!ids\) \{[\s\S]{0,200}return;\s*\}\s*const confirmed = confirmDelivered\(peerPublicKey, ids\)/.test(provider),
  'receipts from a peer clear only that peer\'s entries, and only when signed by that peer');
assert.ok(/channelOpenedAt: \(pk: string\) => webrtcService\.channelOpenedAt\(pk\)/.test(provider), 'p2pSend knows when the current DataChannel opened');
assert.ok(/sendViaP2P\(memberPk, p2pPayload, \{ messageId, group: true \}\)/.test(read('hooks/useGroupChat.ts')), 'the group fan-out waits for each member\'s receipt');
assert.ok(/peer\.dcOpenedAt = Date\.now\(\)/.test(read('services/webrtc.ts')), 'webrtc records when the send channel opened');
console.log('PASS wiring: ack after save, duplicates only acknowledged, fan-out tracked, channel-open time exposed');

// 10 收端：同一則的兩份幾乎同時到（通道換過時寄件者立刻重送）→ 只存一次、只算一次未讀；存過的再來只回條
{
  const { runInNewContext: run } = await import('node:vm');
  const hs = provider.indexOf('const handleGroupKeyMessage = useCallback(');
  const he = provider.indexOf('}, [holdGroupMessage]);', hs);
  assert.ok(hs > 0 && he > hs, 'handleGroupKeyMessage found');
  const code = transformSync('globalThis.__h = ' + provider.slice(provider.indexOf('useCallback(', hs), he)
    + '}, []);', { loader: 'ts' }).code;
  const saved = []; const acks = []; let unread = 0;
  const vmCtx = {
    globalThis: {}, console: { error() {}, log() {} }, diagLog() {}, devLog() {}, devWarn() {}, JSON, useCallback: (fn) => fn,
    groupMessagesInProgress: new Set(),
    hasMessageFrom: async (id, s) => saved.some((m) => m.id === id && m.senderPubkey === s),
    ackGroupMessage: (pk, id) => acks.push([pk, id]),
    isBlacklisted: async () => false,
    groupKeyService: ({
      decryptWithGroupKey: async () => JSON.stringify({ id: 'm1', content: 'hi', groupIds: ['G'] }), verifySignature: () => true,
      bytesToBase64: () => 'K' }),
    // 群組引擎：G 已加入、S 在套上的名冊上、k 是 G 鏈上的一代
    getGroupEngine: () => ({ knows: (g) => g === 'G', isMember: (g, pk) => g === 'G' && pk === 'S',
      decryptKey: (g, k) => (g === 'G' && k === 'k' ? new Uint8Array(32) : null), requestSync() {}, onGossip() {} }),
    holdGroupMessage: () => { throw new Error('not expected to hold'); },
    publicKeyRef: { current: 'ME' },
    offlineQueue: { cacheGroupMessage() {} }, isAegisReady: () => false, ext: extVm, viewGroupIdsToSave: (s, g) => [g],
    getConversationIdForPeer: (p) => 'conv-' + p,
    storageSaveMessage: async (m) => { await new Promise((r) => setTimeout(r, 15)); saved.push(m); },
    window: { dispatchEvent() {} }, CustomEvent: class {},
    useGroupStore: { getState: () => ({ getGroupById: () => ({ members: [{ publicKey: 'S' }, { publicKey: 'ME' }] }), incrementUnread() { unread++; }, updateMemberNickname() {} }) },
  };
  run(code, vmCtx);
  const gm = { messageId: 'm1', groupId: 'G', senderId: 'S', timestamp: 1, type: 'text', encrypted: { keyId: 'k', ciphertext: 'c', iv: 'i' }, signature: '' };
  await Promise.all([vmCtx.globalThis.__h('S', gm), vmCtx.globalThis.__h('S', gm)]);
  assert.equal(saved.length, 1, 'two copies arriving together are saved once');
  assert.equal(unread, 1, 'and counted as unread once');
  assert.deepEqual(acks, [['S', 'm1']], 'the copy that was saved is acknowledged');
  await vmCtx.globalThis.__h('S', gm);
  assert.deepEqual([saved.length, unread, acks.length], [1, 1, 2], 'a later resend of a saved message is only acknowledged');
  console.log('PASS receiver: concurrent copies of one group message are saved and counted once; later resends only acknowledged');
}

// 11 重送檢查的計時器：每個對象一個；檢查完還有在等回條的就再排一次（不必等別的事件觸發 flush）
{
  const timers = [];
  const cleared = [];
  let rows2 = [];
  const st = {
    ...storage,
    getPendingMessageCount: async (p) => rows2.filter((m) => m.recipientPubkey === p).length,
    addPendingMessage: async (m) => { rows2 = rows2.filter((r) => r.id !== m.id); rows2.push({ retryCount: 0, lastRetryAt: null, ...m }); },
    addGroupPendingMessage: async (m, messageId, payload) => {
      rows2 = rows2.filter((r) => r.id !== m.id); rows2.push({ retryCount: 0, lastRetryAt: null, ...m, encryptedPayload: payload, payloadRef: messageId });
    },
    getPendingMessagesForRecipient: async (p) => rows2.filter((m) => m.recipientPubkey === p).map((r) => ({ ...r })),
    removePendingMessage: async (id) => { rows2 = rows2.filter((m) => m.id !== id); },
    removePendingMessageForRecipient: async (id, p) => { rows2 = rows2.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
    updatePendingMessageRetry: async (id) => { rows2 = rows2.map((m) => m.id === id ? { ...m, retryCount: m.retryCount + 1, lastRetryAt: now } : m); },
  };
  const mod = { exports: {} };
  runInNewContext(transformSync(src, { loader: 'ts', format: 'cjs' }).code, {
    module: mod, exports: mod.exports, crypto: webcrypto, Date: FakeDate, Map, Set, Promise, JSON, console: { error() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (t) => { cleared.push(t); },
    require: (n) => n === './storage' ? st : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
  });
  const p2 = mod.exports;
  const out = [];
  p2.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: (p, d) => { out.push([p, d]); return true; }, connectPeer: async () => {}, channelOpenedAt: () => 0 });
  p2.sendViaP2P('B', groupWire('t1'), { messageId: 't1', group: true });
  p2.sendViaP2P('B', groupWire('t2'), { messageId: 't2', group: true });
  await settle();
  assert.equal(timers.length, 1, 'one re-check timer per recipient, not one per message');
  // AppProvider 每次 render 都重跑註冊（unregister → register）：計時器不能跟著被清掉（程式碼審查 LOW）
  p2.unregisterP2PFunctions();
  p2.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: (p, d) => { out.push([p, d]); return true; }, connectPeer: async () => {}, channelOpenedAt: () => 0 });
  assert.equal(cleared.length, 0, 're-registering the P2P functions does not cancel the re-check timer');
  now += 31_000;
  const fire = timers.shift(); fire(); await settle(); await settle();
  assert.equal(out.length, 4, 'the timer resends both unacknowledged messages');
  assert.equal(timers.length, 1, 'and is armed again because they still await a receipt');
  p2.confirmDelivered('B', ['t1', 't2']); await settle();
  now += 31_000; timers.shift()(); await settle(); await settle();
  assert.equal(timers.length, 0, 'nothing left to wait for → no new timer');
  console.log('PASS resend checks: one timer per recipient, re-armed while receipts are still missing');
}

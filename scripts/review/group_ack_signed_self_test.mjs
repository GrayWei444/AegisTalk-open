/**
 * 群組訊息的送達回條要由回條者的身分金鑰簽章（開源第 4 步，services/groupAck.ts；群星 aegisplay-call-check.md「plaintext group_msg_ack」）：
 * 真的 groupAck.ts＋p2pSend.ts，Node crypto 的 Ed25519。
 *   1. 簽好的回條：通道的對方（from）回給我（to）→ 拿到 ids
 *   2. 偽造：沒簽章的舊格式、Mallory 用自己的金鑰簽、竄改 ids／ts、回給別人的（to 不是我）、別的網域、格式不對 → null
 *   3. 端到端：中間人在通道上替收件人回條（偽造的）→ 寄件人「等回條」那筆還在、30 秒後照樣重送；收件人自己簽的才清
 *   4. 接線：AppProvider 收到 group_msg_ack 先 openGroupAck（用這條通道的對方、我的身分），不對就 return；回條用 currentSealer 簽
 * Run: node scripts/review/group_ack_signed_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { identity, verify } from './directKit.mjs';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? ROOT + 'src';
const { transformSync } = createRequire(ROOT + 'package.json')('esbuild');
const load = (file, ctx) => {
  const module = { exports: {} };
  runInNewContext(transformSync(readFileSync(`${SRC}/${file}`, 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, TextEncoder, atob, btoa, Uint8Array, JSON, Array, Number, ...ctx });
  return module.exports;
};
const G = load('services/groupAck.ts', {});
const A = identity(), B = identity(), C = identity(), M = identity();
const T = 1_900_000_000_000;

// 1
const good = G.signGroupAck({ from: B.pk, to: A.pk, ids: ['gmsg-1-abc', 'gmsg-2-def'], ts: T, sign: B.sign });
assert.deepEqual(Object.keys(good).sort(), ['ids', 'sig', 'ts', 'type']);
assert.deepEqual([...G.openGroupAck({ frame: JSON.parse(JSON.stringify(good)), from: B.pk, to: A.pk, verify })], ['gmsg-1-abc', 'gmsg-2-def'],   // vm 的陣列換成這邊的
  'a receipt signed by the channel peer, addressed to me, opens');
console.log('PASS a receipt signed by the peer\'s identity key, addressed to me, is accepted');

// 2
const open = (frame, { from = B.pk, to = A.pk, domain } = {}) => G.openGroupAck({ frame, from, to, verify, domain });
assert.equal(open({ type: 'group_msg_ack', ids: ['gmsg-1-abc'] }), null, 'the old unsigned frame is ignored');
const byMallory = G.signGroupAck({ from: B.pk, to: A.pk, ids: ['gmsg-1-abc'], ts: T, sign: M.sign });
assert.equal(open(byMallory), null, 'Mallory signing as Bob is ignored');
assert.equal(open({ ...good, ids: ['gmsg-9-zzz'] }), null, 'changed ids break the signature');
assert.equal(open({ ...good, ts: T + 1 }), null, 'changed ts breaks the signature');
const toCarol = G.signGroupAck({ from: B.pk, to: C.pk, ids: ['gmsg-1-abc'], ts: T, sign: B.sign });
assert.equal(open(toCarol), null, 'Bob\'s receipt to Carol cannot clear my entries');
assert.equal(open(good, { from: C.pk }), null, 'a receipt relayed over another peer\'s channel is ignored');
assert.equal(open(G.signGroupAck({ from: B.pk, to: A.pk, ids: ['x'], ts: T, sign: B.sign, domain: 'aegisplay-gack-v1:' })), null,
  'another app\'s domain does not verify here');
for (const bad of [null, 'x', { ...good, type: 'group_msg' }, { ...good, ids: [] }, { ...good, ids: 'gmsg-1' }, { ...good, ids: ['a b'] },
  { ...good, ids: Array(51).fill('x') }, { ...good, ts: 'now' }, { ...good, sig: 'AAAA' }, { ...good, sig: 42 }]) {
  assert.equal(open(bad), null, `malformed ${JSON.stringify(bad)?.slice(0, 40)}`);
}
assert.equal(G.openGroupAck({ frame: good, from: B.pk, to: A.pk, verify: () => { throw new Error('boom'); } }), null, 'a throwing verifier is a rejection');
console.log('PASS unsigned, forged, altered, misaddressed, relayed, foreign-domain and malformed receipts are all ignored');

// 3 端到端：真的 p2pSend
let now = T;
const FakeDate = class extends Date { static now() { return now; } };
let rows = [];
const storage = {
  getPendingMessageCount: async (p) => rows.filter((m) => m.recipientPubkey === p).length,
  addPendingMessage: async (m) => { rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m }); },
  addGroupPendingMessage: async (m, messageId, payload) => { rows = rows.filter((r) => r.id !== m.id); rows.push({ retryCount: 0, lastRetryAt: null, ...m, encryptedPayload: payload, payloadRef: messageId }); },
  getPendingMessagesForRecipient: async (p) => rows.filter((m) => m.recipientPubkey === p).sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r })),
  getAllPendingMessages: async () => rows,
  removePendingMessage: async (id) => { rows = rows.filter((m) => m.id !== id); },
  removePendingMessageForRecipient: async (id, p) => { rows = rows.filter((m) => !(m.id === id && m.recipientPubkey === p)); },
  updatePendingMessageRetry: async (id) => { rows = rows.map((m) => m.id === id ? { ...m, retryCount: m.retryCount + 1, lastRetryAt: now } : m); },
};
const P = load('services/p2pSend.ts', {
  crypto: webcrypto, Date: FakeDate, Map, Set, Promise, setTimeout: () => 0, console: { error() {} },
  require: (n) => n === './storage' ? storage : n === '../utils/devLog' ? { devLog() {}, devWarn() {} } : { diagLog() {} },
});
const wire = [];
P.registerP2PFunctions({ isConnectedTo: () => true, sendToPeer: (_p, d) => { wire.push(d); return true; }, connectPeer: async () => {}, channelOpenedAt: () => 0 });
P.registerOutboxEncrypt(async () => 'unused');
const settle = () => new Promise((r) => setTimeout(r, 5));
/** AppProvider 的 group_msg_ack 分支（同一個組合，見 4 的接線檢查） */
const onAckFrame = (peer, raw) => {
  const ids = G.openGroupAck({ frame: JSON.parse(raw), from: peer, to: A.pk, verify });
  return ids ? P.confirmDelivered(peer, ids) : 0;
};
const frame = JSON.stringify({ type: 'group_key_message', payload: { messageId: 'gmsg-7-abc', groupId: 'g1', encrypted: { keyId: 'k', ciphertext: 'X' } } });
P.sendViaP2P(B.pk, frame, { messageId: 'gmsg-7-abc', group: true });
await settle();
const inflight = () => rows.filter((r) => r.messageType === 'group_inflight' && r.recipientPubkey === B.pk);
assert.equal(inflight().length, 1, 'waiting for Bob\'s receipt');
onAckFrame(B.pk, JSON.stringify({ type: 'group_msg_ack', ids: ['gmsg-7-abc'] }));                       // 中間人：舊格式
onAckFrame(B.pk, JSON.stringify(G.signGroupAck({ from: B.pk, to: A.pk, ids: ['gmsg-7-abc'], ts: now, sign: M.sign })));   // 中間人：自己簽
onAckFrame(B.pk, JSON.stringify(G.signGroupAck({ from: B.pk, to: C.pk, ids: ['gmsg-7-abc'], ts: now, sign: B.sign })));   // Bob 回給 Carol 的
await settle();
assert.equal(inflight().length, 1, 'forged receipts do not clear the awaiting-receipt entry');
now += 31_000;
await P.flushQueueForPeer(B.pk);
assert.deepEqual(wire, [frame, frame], 'so the message is resent after 30 s');
onAckFrame(B.pk, JSON.stringify(G.signGroupAck({ from: B.pk, to: A.pk, ids: ['gmsg-7-abc'], ts: now, sign: B.sign })));
await settle();
assert.equal(inflight().length, 0, 'Bob\'s own signed receipt clears it');
now += 31_000;
await P.flushQueueForPeer(B.pk);
assert.equal(wire.length, 2, 'and the resends stop');
console.log('PASS a forged receipt injected on the channel does not stop the resends; the real one does');

// 4 接線
const provider = readFileSync(`${SRC}/providers/AppProvider.tsx`, 'utf8');
const branch = provider.slice(provider.indexOf("parsed.type === 'group_msg_ack'"), provider.indexOf("parsed.type === 'seed_sync'"));
assert.ok(branch.length > 0 && branch.length < 2000, 'the group_msg_ack branch is found');
assert.ok(/openGroupAck\(\{ frame: parsed, from: peerPublicKey, to: me, verify: identityVerify \}\)/.test(branch), 'verified with the channel peer as signer and me as addressee');
assert.ok(/if \(!ids\) \{[\s\S]{0,200}return;/.test(branch) && /confirmDelivered\(peerPublicKey, ids\)/.test(branch), 'nothing is cleared without a valid signature');
assert.ok(!/confirmDelivered\(peerPublicKey, parsed\.ids\)/.test(provider), 'the unverified ids are never used');
const ackFn = provider.slice(provider.indexOf('function ackGroupMessage('), provider.indexOf('function ackGroupMessage(') + 600);
assert.ok(/signGroupAck\(\{ from: s\.me, to: peer, ids: \[messageId\]/.test(ackFn) && /sendViaP2P\(peer, JSON\.stringify\(frame\)\)/.test(ackFn),
  'my receipts are signed with my identity and addressed to the sender');
assert.ok(!/type: 'group_msg_ack', ids: \[/.test(provider), 'no unsigned receipt is built anywhere');
console.log('PASS wiring: receipts are signed when sent and verified (peer, me) before anything is cleared');

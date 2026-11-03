/**
 * WebRTC offer 附的群組金鑰證明（程式碼審查 H1）：真的 services/offerProof.ts ＋ 真的 webrtc.ts（stub 掉 mqtt）。
 *   名冊上沒有的人的 offer 收著 15 秒就丟；我這台的鏈可能還沒追到對方加入的那一筆（log 還沒抓到），對方又不一定是好友
 *   → 群組通話／送檔連不上。持有共同群組金鑰的證明讓這種人先連得上（群訊照樣只收鏈上成員的）。
 *   1. 持有共同群組金鑰的人算得出證明（挑鏈上最新的兩代）；收件人本機有這個群、也有那一代（照那一代的群組主題 id 在群組引擎的主題表
 *      找本機的群組與金鑰，再用金鑰本身重算 tid 核對）→ 驗得過。證明裡沒有群組 id、也沒有金鑰 id —— 只有 { tid, mac }
 *      （W3：offer 是收件箱上的明文信令，gid 不能上 broker；kid 也不行，群組 log 上每一筆都帶 kid、看得到 gid，審查 W3 M3）
 *   2. 驗不過：不同的群（同一把金鑰記在別的群底下也不行）、沒有那把金鑰、金鑰 id 不同、寄件人／收件人換人、時間差超過 10 分鐘、
 *      被這台記成踢掉／離開、格式不對（含舊版帶群組 id 或金鑰 id 的）
 *   3. webrtc：名冊上沒有、但證明對得上 → 馬上回 answer；證明不對 → 照舊收著；封鎖的人有證明也不收
 *   4. 送 offer 時附上證明；useWebRTC 接線
 * Run: node scripts/review/offer_proof_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webrtcStub, dcBody, deliverDc } from './webrtcKit.mjs';
import { ENFORCED, enforcementPlugin } from './groupEnforcementFlags.mjs';
import { deriveTopicId } from '../sim/lib/topics.mjs';   // 獨立的 node 版（不是受測的那份）

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'offerproof-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
await build({ entryPoints: [SRC + '/services/offerProof.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'p.mjs'), logLevel: 'silent' });
const P = await import(pathToFileURL(join(dir, 'p.mjs')));

const G = 'Ggggggggggggggggggggg1'; const H = 'Hhhhhhhhhhhhhhhhhhhhh2'; const X = 'Xxxxxxxxxxxxxxxxxxxxx3';   // gid 是 22 字元
const key = (keyId, groupId, createdAt = 1, epochV) => ({ keyId, groupId, createdAt, ...(epochV ? { epochV } : {}), keyBase64: createHash('sha256').update(`key|${keyId}`).digest('base64') });
const kG1 = key('gk-1', G); const kG2 = key('gk-22', G, 2);
const tidOf = (k, gid = k.groupId) => deriveTopicId(k.keyBase64, gid);
const senderGroups = [{ id: G, members: [{ publicKey: 'N' }, { publicKey: 'E' }] }, { id: X, members: [{ publicKey: 'N' }] }];
const senderKeys = { [G]: [kG1, kG2], [X]: [key('xk', X)] };
const now = 1_800_000_000_000;

// ── 1 ──
const proof = await P.createOfferProof('N', 'E', senderGroups, async (g) => senderKeys[g] ?? [], now);
assert.equal(proof.items.length, 2, 'only groups the remote is in (G, not X); the newest two keys');
assert.ok(!JSON.stringify(proof).includes(kG1.keyBase64), 'no key material in the proof');
assert.ok(proof.items.every((i) => Object.keys(i).sort().join() === 'm,t'), 'each item is { tid, mac } only');
assert.deepEqual(proof.items.map((i) => i.t), [tidOf(kG2), tidOf(kG1)], 'the tid is the epoch\'s group topic id (newest first)');
const wire = JSON.stringify(proof);
assert.ok(!wire.includes(G) && !wire.includes(X) && !wire.includes('gk-1') && !wire.includes('gk-22'),
  'no group id and no key id in the proof (W3: the gid must not reach the broker; a kid links back to it through the log)');
const eGroups = { [G]: { id: G, members: [{ publicKey: 'E' }, { publicKey: 'A' }], departed: ['KICKED'] } };   // E 的名冊少了 N
const eTable = { [tidOf(kG1)]: [kG1] };                                     // E 的主題表只有舊的那一代（還沒套上 kG2 那一筆）
const keyLookups = [];
const verify = (remote, me, pr, t = now, groups = eGroups, table = eTable) =>
  P.verifyOfferProof(remote, me, pr, (id) => groups[id], async (tid) => { keyLookups.push(tid); return table[tid] ?? []; }, t);
assert.equal(await verify('N', 'E', proof), true, 'E has group G and one of the epochs N proved → accepted');
assert.ok(keyLookups.length > 0 && keyLookups.every((k) => /^[A-Za-z0-9_-]{22}$/.test(k)), 'keys are looked up by tid (the engine\'s topic table); group and kid come from the local entry');
// 挑「最新的兩代」照鏈上位置（epochV），不照這台存進來的時間：晚到的舊一代不能把目前那一代擠掉
const three = [key('cur', G, 1, 9), key('old', G, 50, 2), key('mid', G, 2, 5)];
const late = await P.createOfferProof('N', 'E', senderGroups, async () => three, now);
assert.deepEqual(late.items.map((i) => i.t), [tidOf(three[0]), tidOf(three[2])], 'the newest two epochs by chain position');
assert.equal(new Set(three.map((k) => tidOf(k))).size, 3, '(each epoch has its own tid)');
console.log('PASS a peer holding a shared group key can prove it; one shared key is enough');

// ── 2 ──
assert.equal(await verify('N', 'E', proof, now, eGroups, { [tidOf(kG1)]: [{ ...kG1, keyBase64: Buffer.alloc(32, 99).toString('base64') }] }), false, 'a different key under that tid does not verify (the tid is re-derived from the local key)');
assert.equal(await verify('N', 'E', proof, now, eGroups, {}), false, 'I do not hold any of the proved epochs');
assert.equal(await verify('N', 'E', proof, now, {}, eTable), false, 'a group I am not in');
// 主題表那一項跟金鑰對不上（表錯了、或證明換了 tid）：用金鑰本身重算 tid 核對 → 不算
const swapped = { ...proof, items: [{ t: tidOf(kG2), m: proof.items[1].m }] };
assert.equal(await verify('N', 'E', swapped, now, eGroups, { [tidOf(kG2)]: [kG1] }), false, 'a key that does not derive the item\'s tid is not used');
assert.equal(await verify('N', 'E', proof, now, eGroups, { [tidOf(kG1)]: [{ ...kG1, keyId: 'gk-other' }] }), false, 'the same key bytes under another kid do not verify (the mac binds the kid)');
// 同一把金鑰（同 kid、同 bytes）記在別的群底下：tid 與 HMAC 都綁群組 id → 不算
const hGroups = { ...eGroups, [H]: { id: H, members: [{ publicKey: 'E' }] } };
assert.equal(await verify('N', 'E', proof, now, hGroups, { [tidOf(kG1)]: [{ ...kG1, groupId: H }] }), false, 'the same key filed under another group does not verify (tid and mac bind the group)');
assert.equal(await verify('N', 'E', proof, now, hGroups, { [tidOf(kG1)]: [{ ...kG1, groupId: H }, kG1] }), true, 'the right group among several candidates');
assert.equal(await verify('MALLORY', 'E', proof), false, 'cannot be replayed as someone else');
assert.equal(await verify('N', 'OTHER', proof), false, 'cannot be replayed to someone else');
assert.equal(await verify('N', 'E', proof, now + 11 * 60_000), false, 'stale (> 10 min)');
const kicked = await P.createOfferProof('KICKED', 'E', [{ id: G, members: [{ publicKey: 'E' }] }], async () => [kG1], now);
assert.equal(await verify('KICKED', 'E', kicked), false, 'someone this device recorded as kicked/left is not accepted, even with an old key');
const it1 = proof.items[1];   // 對得上 E 那一代的那一項
for (const bad of [null, 'x', { v: 2, t: now, items: proof.items }, { v: 1, t: now, items: 'x' }, { v: 1, t: now, items: new Array(7).fill(it1) },
  { v: 1, t: now, items: [{ t: it1.t.slice(1), m: it1.m }] }, { v: 1, t: now, items: [{ t: `${it1.t}x`, m: it1.m }] }, { v: 1, t: now, items: [{ t: it1.t, m: '!!' }] },
  { v: 1, t: now, items: [{ k: 'gk-1', m: it1.m }] },                       // W3 前一版：{ kid, mac }
  { v: 1, t: now, items: [{ g: G, k: 'gk-1', m: it1.m }] },                // 更早一版：帶群組 id
  { v: 1, t: now, items: [{ ...it1, k: 'gk-1' }] }]) {                      // 多一個欄位
  assert.equal(await verify('N', 'E', bad), false, `malformed proof rejected: ${JSON.stringify(bad)?.slice(0, 40)}`);
}
assert.equal(await P.createOfferProof('N', 'Z', senderGroups, async (g) => senderKeys[g] ?? [], now), undefined, 'no shared group → no proof');
console.log('PASS proofs fail for other groups/keys/peers, stale ones, kicked members and malformed input');

// ── 3 webrtc（開源第 4 步：offer 是封好的 DIRECT_SEALED kind 'dc'，證明在信封裡 —— broker 連 tid 都看不到了） ──
await build({ entryPoints: [SRC + '/services/webrtc.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'w.mjs'), logLevel: 'silent', plugins: [webrtcStub(), enforcementPlugin(ENFORCED)] });
globalThis.localStorage = { getItem: () => null };
const quiet = console.error; console.error = () => {};
const { webrtcService: svc, parseDcSignal } = await import(pathToFileURL(join(dir, 'w.mjs')));
const offer = (from, groupProof) => deliverDc(svc, parseDcSignal, from, dcBody('offer', { type: 'offer', sdp: 'x' }, { groupProof }));
const built = [];
svc.createResponderConnection = async (pk) => { built.push(pk); };
svc.startDcHeartbeat = () => {};
svc.initialize('E');
svc.setInboundPolicy({ isBlocked: (pk) => pk === 'BLOCKED', isKnown: async () => false });
svc.setOfferProofs({ create: async () => undefined, verify: (remote, pr) => verify(remote, 'E', pr, Date.now()) });
const fresh = await P.createOfferProof('N', 'E', senderGroups, async (g) => senderKeys[g] ?? []);
await offer('N', fresh);
assert.deepEqual(built, ['N'], 'missing from my roster but proves a shared group key → answered at once');
await offer('M', { ...fresh, items: fresh.items.map((i) => ({ ...i, m: Buffer.alloc(32).toString('base64') })) });
await offer('Q');
assert.deepEqual(built, ['N'], 'a wrong proof or none: not answered (held as before)');
const blockedProof = await P.createOfferProof('BLOCKED', 'E', senderGroups.map((g) => ({ ...g, members: [...g.members, { publicKey: 'E' }] })), async (g) => senderKeys[g] ?? []);
await offer('BLOCKED', blockedProof);
assert.deepEqual(built, ['N'], 'a blocked contact is refused even with a valid proof');
console.log('PASS webrtc: a valid group-key proof admits a member missing from my roster; wrong/no proof is held; blocked always refused');

// ── 4 送 offer 附證明；接線 ──
svc.setOfferProofs({ create: async (remote) => ({ v: 1, t: 1, items: [{ t: 'k', m: remote }] }), verify: async () => false });
const proofOf = await svc.offerProofFor('Z');
assert.deepEqual(proofOf, { v: 1, t: 1, items: [{ t: 'k', m: 'Z' }] }, 'offers carry the proof from the hook');
svc.setOfferProofs({ create: async () => { throw new Error('db'); }, verify: async () => false });
assert.equal(await svc.offerProofFor('Z'), undefined, 'a failing proof hook never blocks an offer');
console.error = quiet;
const w = readFileSync(SRC + '/services/webrtc.ts', 'utf8');
assert.equal((w.match(/const groupProof = await this\.offerProofFor\(remotePublicKeyBase64\)/g) ?? []).length, 2, 'both offer paths (new connection, in-place reopen) attach the proof');
assert.equal((w.match(/sendDcSignal\(remotePublicKeyBase64, 'offer',[\s\S]{0,200}?groupProof \}\)/g) ?? []).length, 2, 'both send it inside the sealed offer');
const hook = readFileSync(SRC + '/hooks/useWebRTC.ts', 'utf8');
assert.ok(/webrtcService\.setOfferProofs\(/.test(hook) && /createOfferProof\(me, remote/.test(hook) && /verifyOfferProof\(remote, me, proof/.test(hook), 'useWebRTC installs the proof hooks');
assert.ok(/getGroupEngine\(\)\?\.topics\(\)\.find\(\(x\) => x\.tid === tid\)/.test(hook) && /getGroupKey\(hit\.gid, hit\.kid\)/.test(hook)
  && /verifyOfferProof\(remote, me, proof,[\s\S]{0,120}keysForTopic\)/.test(hook), 'and verifies by mapping the tid through the engine\'s topic table (no group or key id in the proof)');
assert.ok(!/getGroupKeysByKeyId/.test(hook), 'no lookup by a kid taken from the wire');
console.log('PASS offers carry a group-key proof; useWebRTC wires create/verify');
svc.shutdown();
process.exit(0);

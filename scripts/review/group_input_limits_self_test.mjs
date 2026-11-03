/**
 * 群組相關輸入的把關與額度（對應群星 e1b119c7，審查 LOW）。真的 peerBudget.ts／groupStateCommit.ts ＋ AppProvider 接線。
 *   1. 公鑰必須是正規的 32 bytes base64：以前任何字串都進名冊，接著被拿去撥 WebRTC、當 MQTT topic 的一段。
 *      W1 起名冊只來自套上的狀態鏈（genesis／add 的新成員過 validPubkey：正規編碼、在曲線上、質數階），
 *      而且整個 App 只有 groupLogStore 寫 groups／group_members／group_keys —— 沒有別的路把名字塞進名冊。
 *   2. peerBudget：每人一個 token bucket，記錄的人數有上限
 *   3. 群組信封（GROUP_KEY_SEALED）：先看額度、再看寄件者是不是好友或同群成員，才拆（拆封要 X25519＋HKDF＋AES＋簽章驗證）；
 *      AegisTalk：冷啟動等清單載完才判斷（waitForLocalLists），好友清單一時載到 0 筆時查 contacts 表（findFriendSettled）
 *   4. 回覆索取每人有額度，而且只回鏈上那一代、給 mayReceiveKey 允許的人；向別人索取只問鏈上的世代、同一把 30 秒一次，
 *      群訊標了我沒有的 kid 不會回頭封信封給寄件者（只收著、去抓 log）——成員一直送不存在的 kid，不能讓我一直封信封
 * Run: node scripts/review/group_input_limits_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'ginput-'));
const entry = join(dir, 'entry.ts');
writeFileSync(entry, `export { createPeerBudget } from '${root}packages/pwa/src/services/peerBudget';
export { validPubkey } from '${root}packages/pwa/src/services/groupStateCommit';`);
await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'e.mjs'), logLevel: 'silent' });
const { createPeerBudget, validPubkey } = await import(pathToFileURL(join(dir, 'e.mjs')));
const { generateKeyPairSync } = await import('node:crypto');
const edPub = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

// 1 鏈的規則（名冊唯一的來源；以前 rosterPeers.validIdentityKey 只在 GROUP_MEMBER_ADDED／邀請名冊用，那兩條路已經拿掉）
const real = edPub();
assert.equal(validPubkey(real), true);
for (let i = 0; i < 50; i++) assert.equal(validPubkey(edPub()), true, 'real Ed25519 identity keys enter the chain roster');
const nonCanonical = real.slice(0, 42) + (real[42] === 'B' ? 'C' : 'B') + '=';   // 最後一個字元的低 2 bits 不是 0
assert.notEqual(Buffer.from(nonCanonical, 'base64').toString('base64'), nonCanonical);
assert.equal(validPubkey(nonCanonical), false, 'only the canonical encoding');
for (const bad of [real.slice(0, 43), real + '=', real.replace(/.$/, ''), 'a/b/#', 'x'.repeat(44), Buffer.alloc(31).toString('base64'),
  Buffer.alloc(33).toString('base64'), real.replace(/^./, '#'), real.replace(/^./, '-'), ` ${real.slice(1)}`, 42, null, undefined,
  Buffer.alloc(32).toString('base64')]) {
  assert.equal(validPubkey(bad), false, `rejects ${JSON.stringify(bad)}`);
}
console.log('PASS roster keys must be canonical base64 of 32 bytes (and the chain also requires a prime-order curve point)');

// 2
const b = createPeerBudget({ capacity: 3, refillPerSec: 1, maxPeers: 2 });
assert.deepEqual([b.take('p', 1, 0), b.take('p', 1, 0), b.take('p', 1, 0), b.take('p', 1, 0)], [true, true, true, false], 'capacity');
assert.equal(b.take('p', 1, 1000), true, 'refills over time');
assert.equal(b.take('q', 3, 0), true, 'per peer');
b.take('r', 1, 0);                                       // 第三個人 → 最久沒動的 p 被丟掉，重新從滿的開始
assert.equal(b.take('p', 3, 1000), true, 'bounded number of tracked peers (oldest forgotten)');
console.log('PASS peerBudget is a per-peer token bucket with a bounded peer table');

// 3, 4 接線
const src = root + 'packages/pwa/src/';
const { readdirSync, statSync } = await import('node:fs');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(f);
  }
})(src);
const writersOf = (re) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(src.length));
assert.deepEqual(writersOf(/INSERT\s+(OR\s+\w+\s+)?INTO\s+(group_members|groups|group_keys)\b|UPDATE\s+group_members\s+SET\s+(?!nickname\b)|UPDATE\s+group_keys\b/i),
  ['services/groupLogStore.ts'], 'only the chain projection writes the roster, roles and group keys');
assert.deepEqual(writersOf(/DELETE\s+FROM\s+(group_members|group_keys)\b/i), ['services/database.ts', 'services/groupLogStore.ts'],
  'and only it (plus the v12 migration that drops the pre-chain roster) removes them');
const store = readFileSync(src + 'stores/groupStore.ts', 'utf8');
assert.ok(!/\baddMember\s*:|\bremoveMember\s*:|\bupdateMemberRole\s*:|\bmergeRosterFromAdmin\b/.test(store), 'the group store has no roster writers of its own');
const provider = readFileSync(src + 'providers/AppProvider.tsx', 'utf8');
assert.equal((provider.match(/_applyChainGroup\(/g) ?? []).length, 1, 'the projection is applied only from the engine');
const projectAt = provider.indexOf('project: (gid, group) => {');
assert.ok(projectAt > 0 && provider.indexOf('_applyChainGroup(') > projectAt && provider.indexOf('_applyChainGroup(') < projectAt + 300, 'inside the engine project callback');

const sealed = provider.slice(provider.indexOf('mqtt.subscribe(MessageType.GROUP_KEY_SEALED'));
const openAt = sealed.indexOf('openGroupSealed(');
assert.ok(openAt > 0, 'sealed handler found');
assert.ok(sealed.indexOf('isFriendOrFellowMember(message.from)') > 0 && sealed.indexOf('isFriendOrFellowMember(message.from)') < openAt,
  'a sealed envelope from someone who is neither a friend nor a fellow member is dropped before decrypting');
assert.ok(sealed.indexOf('waitForLocalLists()') > 0 && sealed.indexOf('waitForLocalLists()') < sealed.indexOf('isFriendOrFellowMember(message.from)'),
  'cold start: the sender is judged only after the friend and group lists are loaded');
const gate = provider.slice(provider.indexOf('async function isFriendOrFellowMember('), provider.indexOf('async function isFriendOrFellowMember(') + 600);
assert.ok(/findFriendSettled\(pk\)/.test(gate), 'a friend list that loaded empty for a moment falls back to the contacts table');
assert.ok(sealed.indexOf('sealedOpenBudget.take(message.from)') > 0 && sealed.indexOf('sealedOpenBudget.take(message.from)') < openAt, 'and each sender has a budget');
assert.ok(sealed.indexOf('isBlacklisted(message.from)') > 0 && sealed.indexOf('isBlacklisted(message.from)') < openAt, 'blocked senders are dropped before decrypting');
const toEngine = sealed.indexOf('engine.onSealed(');
assert.ok(sealed.indexOf("opened.kind === 'req' && !keyAnswerBudget.take(opened.from)") > openAt && sealed.indexOf("opened.kind === 'req' && !keyAnswerBudget.take(opened.from)") < toEngine,
  'answering key requests is rate-limited per requester (before the engine looks anything up)');

const eng = readFileSync(src + 'services/groupEngineSealed.ts', 'utf8');
const onReq = eng.slice(eng.indexOf('async function onKeyRequest('), eng.indexOf('async function onKeyDist('));
assert.ok(onReq.indexOf('mayReceiveKey(state, from, epoch.v)') > 0 && onReq.indexOf('keyAuthorised(') > 0
  && onReq.indexOf('mayReceiveKey(state, from, epoch.v)') < onReq.indexOf('sendSealed(') && onReq.indexOf('keyAuthorised(') < onReq.indexOf('sendSealed('),
  'a key is only sent to someone the chain allows, and only a key that matches the chain');
const ask = eng.slice(eng.indexOf('export async function askForKey('), eng.indexOf('async function onKeyRequest('));
assert.ok(/KEY_ASK_INTERVAL_MS/.test(ask) && ask.indexOf('askedAt.get(kid)') < ask.indexOf('sendSealed('), 'asking for a key is rate-limited per kid');
assert.ok(/epochOfKey\(state, kid\)/.test(ask), 'and targets the chain epoch');
const recv = provider.slice(provider.indexOf('const handleGroupKeyMessage = useCallback('), provider.indexOf('}, [holdGroupMessage]);'));
assert.ok(recv.length > 0 && !/sendSealed|sendGroupSealed|requestGroupKey/.test(recv),
  'a group message with a kid I do not have never makes me send an envelope back to its sender (held, then the log is fetched)');
console.log('PASS wiring: roster only from the chain, sealed-envelope sender gate, key request/answer budgets');

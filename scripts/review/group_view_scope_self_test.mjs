/**
 * 收到的群組訊息只能出現在寄件人所屬的群組（稽核 H8，對應群星 P1-8、P2-11、B30）：
 *   真的 AppProvider handleGroupKeyMessage（抽出來配 stub 跑）＋ groupViewScope.ts ＋ 另兩條存檔路徑的接線。
 *   以前：群組金鑰只用 keyId 查、不管它屬於哪個群；寄件人不必是成員；明文的 groupIds 照單全收 ——
 *   X 群的成員（或拿到 X 金鑰的前成員）把訊息標成 Y 群、或在 groupIds 寫上 Y，訊息就以非成員身分出現在 Y 群。
 *   群組檔案的 manifest、一對一加密的群組訊息也直接照 groupIds 存。
 *   現在（W1 狀態鏈）：只用「這個群鏈上那一代」的金鑰解（groupEngine.decryptKey(群, kid)；沒有過渡期舊金鑰）；
 *   寄件人必須在套上的名冊上；groupIds 只留本機知道且寄件人是成員的群。群還沒加入（邀請確認中）、寄件人還不在名冊、
 *   那一代還沒拿到 → 先收著、補抓 log（不存、不回條），加入或補到之後重試。成員檢查一直開著（MODES 只剩一種）。
 * Run: node scripts/review/group_view_scope_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { extVm } from './extStub.mjs';
import { MODES, enforcementPlugin, flagContext, reasons } from './groupEnforcementFlags.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync, build } = require('esbuild');
const src = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');

// ── handleGroupKeyMessage 實際行為 ──
const start = src.indexOf('const handleGroupKeyMessage = useCallback(');
const end = src.indexOf('}, [holdGroupMessage]);', start);
assert.ok(start > 0 && end > start, 'handleGroupKeyMessage found');
const snippet = 'globalThis.__h = ' + src.slice(src.indexOf('useCallback(', start), end) + '}, []);';
const code = transformSync(snippet, { loader: 'ts' }).code;

const scopePath = root + 'packages/pwa/src/services/groupViewScope.ts';
assert.ok(existsSync(scopePath), 'services/groupViewScope.ts exists');
const dir = mkdtempSync(join(tmpdir(), 'groupscope-'));
// 真的 groupViewScope
const scope = {};
for (const [, flags] of MODES) {
  const out = join(dir, `g-${flags.ENFORCE_GROUP_MEMBERSHIP}.mjs`);
  await build({ entryPoints: [scopePath], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', plugins: [enforcementPlugin(flags)] });
  scope[flags.ENFORCE_GROUP_MEMBERSHIP] = await import(pathToFileURL(out));
}
const { permittedGroupIds } = scope.true;
const realError = console.error;
const captured = async (fn) => {
  const lines = []; console.error = (...a) => { const l = a.join(' '); if (l.startsWith('[GROUP-CHECK]')) lines.push(l); };
  try { return { value: await fn(), lines }; } finally { console.error = realError; }
};

const groups = {
  X: { id: 'X', members: [{ publicKey: 'alice', role: 'admin' }, { publicKey: 'both' }, { publicKey: 'me', role: 'member' }] },
  Y: { id: 'Y', members: [{ publicKey: 'bob', role: 'admin' }, { publicKey: 'both' }, { publicKey: 'me', role: 'member' }] },
};
/** 每個群鏈上的世代：kid → 金鑰（這裡用標籤代表金鑰） */
const chainKeys = { X: { kX: 'KX' }, Y: { kY: 'KY' } };
/** 群組引擎：只認已加入的群、套上的名冊、這個群鏈上的那一代 */
const engine = {
  knows: (gid) => !!groups[gid],
  isMember: (gid, pk) => !!groups[gid]?.members.some((m) => m.publicKey === pk),
  decryptKey: (gid, kid) => (chainKeys[gid]?.[kid] ? { label: chainKeys[gid][kid] } : null),
  requestSync() {}, onGossip() {},
};
function run(senderPubkey, msg, plain, flags) {
  const saved = []; const logs = []; const held = [];
  const ctx = {
    ...flagContext(flags, logs), viewGroupIdsToSave: scope[flags.ENFORCE_GROUP_MEMBERSHIP].viewGroupIdsToSave,
    globalThis: {}, console: { error() {}, warn() {}, log() {} },
    useCallback: (fn) => fn, diagLog() {}, devLog() {}, devWarn() {},
    groupKeyService: ({
      decryptWithGroupKey: async (ct, iv, k) => { if (ct !== 'CT:' + k) throw new Error('bad tag'); return JSON.stringify(plain); },
      verifySignature: () => true, bytesToBase64: (k) => k.label,
    }),
    getGroupEngine: () => engine, holdGroupMessage: (gid) => held.push(gid),
    publicKeyRef: { current: 'ME' }, hasMessageFrom: async () => false, ackGroupMessage() {}, groupMessagesInProgress: new Set(),
    offlineQueue: { cacheGroupMessage() {} },
    isAegisReady: () => false, ext: extVm, isBlacklisted: async () => false,
    getConversationIdForPeer: (p) => 'conv-' + p,
    storageSaveMessage: async (m) => { saved.push({ ...m, groupIds: Array.from(m.groupIds ?? []) }); },   // vm 裡建的陣列換成本 realm 的
    window: { dispatchEvent() {} }, CustomEvent: class {},
    useGroupStore: { getState: () => ({ getGroupById: (id) => groups[id], incrementUnread() {}, updateMemberNickname() {} }) },
  };
  runInNewContext(code, ctx);
  return captured(() => ctx.globalThis.__h(senderPubkey, msg))
    .then(({ lines }) => Object.assign(saved, { held, logged: [...reasons(logs), ...lines.map((l) => l.split(' ')[3])] }));
}
const gm = (groupId, encrypted, sender = 'alice') => ({ messageId: 'm1', groupId, senderId: sender, timestamp: Date.now(), type: 'text', encrypted, signature: '' });

for (const [mode, flags] of MODES) {
  let saved = await run('both', gm('Y', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }, 'both'), { id: 'm1', content: 'hi', groupIds: ['Y'] }, flags);
  assert.equal(saved.length, 0, `${mode}: a message encrypted with group X's key cannot be filed under group Y, even by a member of both`);

  saved = await run('alice', gm('X', { keyId: 'nope', ciphertext: 'x', iv: 'i', legacyKeyId: 'kX', legacyCiphertext: 'CT:KX', legacyIv: 'i' }),
    { id: 'm1', content: 'hi' }, flags);
  assert.equal(saved.length, 0, `${mode}: a legacy copy is never used: only the epoch the message names, from this group's chain`);

  saved = await run('carol', gm('X', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }, 'carol'), { id: 'm1', content: 'hi' }, flags);
  assert.deepEqual([saved.length, saved.held], [0, ['X']], `${mode}: a non-member holding X's key (e.g. removed member) cannot post into X (held while I re-check the log)`);

  saved = await run('alice', gm('X', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }), { id: 'm1', content: 'hi', groupIds: ['X', 'Y'] }, flags);
  assert.equal(saved.length, 1, `${mode}: a member's message to its own group is saved`);
  assert.deepEqual([saved[0].groupIds, saved.logged], [['X'], []], `${mode}: claimed view groups the sender is not in are dropped`);

  saved = await run('dave', gm('Z', { keyId: 'kZ', ciphertext: 'CT:KZ', iv: 'i' }, 'dave'), { id: 'm1', content: 'hi', groupIds: ['Z', 'Y'] }, flags);
  assert.deepEqual([saved.length, saved.held], [0, ['Z']],
    `${mode}: a group not joined yet (invite still being confirmed against the log) → held and retried after joining, never saved unchecked`);

  saved = await run('mallory', gm('X', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }, 'alice'), { id: 'm1', content: 'hi' }, flags);
  assert.equal(saved.length, 0, `${mode}: the message's senderId must be the peer that delivered it`);
}
console.log('PASS group-key messages: only this group\'s chain epoch key, sender must be on the applied roster, view groups limited, unknown groups held');

// 開源第 5a 步：L2 掃描是 ext.antiFraud.inspectInbound（'group-key' 掃描點）；它回的結果照舊存進訊息的 metadata，
//   沒有結果（社群版、引擎沒準備好、safe/low）就不帶 metadata
{
  const RISK = { riskLevel: 'high', riskScore: 80, warnings: ['w'], action: 'warn', triggeredRules: [] };
  const seen = [];
  globalThis.__extHooks = { inspectInbound: async (ev) => { seen.push(ev); return RISK; } };
  try {
    const saved = await run('alice', gm('X', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }), { id: 'm9', content: 'pay now', groupIds: ['X'] }, MODES[0][1]);
    assert.equal(saved.length, 1);
    assert.deepEqual(JSON.parse(saved[0].metadata).riskResult, RISK, 'the scan result is stored with the group message');
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ site: 'group-key', sender: 'alice', messageId: 'm9', type: 'text', content: 'pay now' }],
      'scanned once at the group-key site, with the sender, message id, type and decrypted text');
  } finally { globalThis.__extHooks = undefined; }
  const plain = await run('alice', gm('X', { keyId: 'kX', ciphertext: 'CT:KX', iv: 'i' }), { id: 'm10', content: 'hi', groupIds: ['X'] }, MODES[0][1]);
  assert.equal(plain[0].metadata, undefined, 'no scan result → no metadata');
}
console.log('PASS group-key messages: the anti-fraud result (ext.antiFraud.inspectInbound) is stored in the metadata, none → no metadata');

// ── groupViewScope 單元 ──
const get = (id) => groups[id];
assert.deepEqual(permittedGroupIds('alice', 'X', ['X', 'Y'], get), ['X'], 'a member of X cannot tag a message into Y');
assert.deepEqual(permittedGroupIds('alice', 'Y', ['Y'], get), [], 'nor send it "for" Y when not a member of Y');
assert.deepEqual(permittedGroupIds('alice', 'Z', ['Z', 'Y'], get), ['Z'], 'unknown target group kept (invite may arrive later); other claims dropped');
assert.deepEqual(permittedGroupIds('alice', undefined, ['X', 'Y', 'Z'], get), ['X'], 'file manifests: only known groups the sender is in');
assert.deepEqual(permittedGroupIds('bob', 'Y', undefined, get), ['Y'], 'no claimed list → just the target group');
assert.deepEqual(permittedGroupIds('alice', 'X', ['X', 'X', 42, null], get), ['X'], 'deduped, non-strings ignored');
for (const [mode, flags] of MODES) {
  const { viewGroupIdsToSave } = scope[flags.ENFORCE_GROUP_MEMBERSHIP];
  let r = await captured(() => viewGroupIdsToSave('alice', 'X', ['X', 'Y'], get, ['X', 'Y']));
  assert.deepEqual(r.value, flags.ENFORCE_GROUP_MEMBERSHIP ? ['X'] : ['X', 'Y'], `${mode}: saved view groups`);
  assert.deepEqual(r.lines, flags.ENFORCE_GROUP_MEMBERSHIP ? [] : ['[GROUP-CHECK] would block: view-group-not-member sender=alice group=X groups=1'], `${mode}: log`);
  r = await captured(() => viewGroupIdsToSave('carol', 'X', undefined, get, ['X']));
  assert.deepEqual([r.value, r.lines], [[], []], `${mode}: a non-member gets no view group at all`);
  r = await captured(() => viewGroupIdsToSave('alice', undefined, ['X', 'Y'], get, ['X', 'Y']));
  assert.deepEqual(r.value, flags.ENFORCE_GROUP_MEMBERSHIP ? ['X'] : ['X', 'Y'], `${mode}: file manifests`);
}
console.log('PASS view groups limited to groups the sender belongs to');

// ── 另兩條存群組訊息的路徑（群組檔案、一對一加密的群組訊息）也要經過它 ──
assert.equal((src.match(/viewGroupIdsToSave\(/g) ?? []).length, 3, 'all three group-message save paths use viewGroupIdsToSave');
assert.ok(!/groupIds:\s*rf\.groupIds,/.test(src), 'file-manifest path saves what the check returns, not rf.groupIds directly');
assert.ok(/groupIds: viewGroupIds,[\s\S]*groupIds: savedGroupIds,|groupIds: savedGroupIds,[\s\S]*groupIds: viewGroupIds,/.test(src), 'saved groupIds come from the check');
assert.equal((src.match(/storageSaveMessage\(\{[^]*?groupIds: (viewGroupIds|savedGroupIds),/g) ?? []).length, 3, 'all three saves use the checked list');
console.log('PASS AppProvider routes every group save through the check');

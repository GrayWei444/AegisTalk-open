/**
 * 收訊息的路徑不能改名冊（W1：名冊、角色、金鑰只由套上的狀態鏈決定，docs/GROUP_LOG_WIRING_W1.md）。
 * 取代已拿掉的 group_roster_heal／group_key_guard 裡「名冊自癒」那幾段：以前一則群訊（或一對一＋groupId 的訊息）
 * 從名冊上沒有的人來，只要他握有金鑰、或是好友，就被補進名冊；被踢但還是好友的人送一則就回來了（稽核 H6）。
 *   1. 一對一＋groupId 的路（守護群組的報平安／警示在用）：真的 AppProvider 片段配 stub 跑 ——
 *      被踢但還是好友的人、陌生人都丟掉、不加回名冊；成員照收；本機還沒有的群一律不收（以前先存，之後加入就以他的名義出現）
 *   2. 群組金鑰的路（handleGroupKeyMessage）：寄件人不在套上的名冊 → 收著、補抓 log，不存也不改名冊
 *      （實際行為在 group_view_scope_self_test；這裡確認片段裡沒有任何名冊寫入）
 *   3. 整個 AppProvider／useGroupChat 沒有任何「從訊息改名冊」的呼叫（addMember／markDeparted／mergeRosterFromAdmin／自癒）
 * Run: node scripts/review/group_chain_receive_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { visibleTypes } from './providerScope.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const hook = readFileSync(root + 'packages/pwa/src/hooks/useGroupChat.ts', 'utf8');
const between = (src, from, to) => {
  const s = src.indexOf(from); const e = src.indexOf(to, s);
  assert.ok(s > 0 && e > s, `found ${from}`);
  return src.slice(s, e);
};

// ── 1 一對一＋groupId ──
const routeCode = transformSync('globalThis.__run = async (senderPublicKeyBase64, messageData) => {'
  + between(provider, '// ====== 群組訊息路由（加密群組訊息） ======', '// 明文的 groupIds 只留寄件者所屬的群') + ' __reached(); } };', { loader: 'ts' }).code;
const groups = {
  X: { id: 'X', members: [{ publicKey: 'ADMIN', role: 'admin' }, { publicKey: 'MEMBER', role: 'member' }, { publicKey: 'ME', role: 'member' }],
    departed: ['KICKED'] },
};
async function route(sender, data, friends = ['KICKED', 'MEMBER', 'FRIEND']) {
  const rosterWrites = []; const nick = []; let reached = false;
  const trap = (name) => (...x) => { rosterWrites.push([name, ...x]); };
  const ctx = {
    globalThis: {}, console: { error() {}, log() {} }, devLog() {}, devWarn() {}, diagLog() {}, publicKey: 'ME',
    useGroupStore: { getState: () => ({
      getGroupById: (id) => groups[id],
      updateMemberNickname: (...x) => nick.push(x),
      addMember: trap('addMember'), removeMember: trap('removeMember'), _applyChainGroup: trap('_applyChainGroup'),
    }) },
    useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => (friends.includes(pk) ? { publicKey: pk } : undefined) }) },
    __reached: () => { reached = true; }, ...visibleTypes,
  };
  runInNewContext(routeCode, ctx);
  await ctx.globalThis.__run(sender, data);
  return { rosterWrites, reached, nick };
}
let r = await route('KICKED', { id: 'm1', groupId: 'X', content: 'I am back', senderName: 'k' });
assert.deepEqual([r.rosterWrites, r.reached, r.nick], [[], false, []], 'a kicked member who is still a friend is not added back; the message is dropped');
r = await route('STRANGER', { id: 'm2', groupId: 'X', content: 'hi' });
assert.deepEqual([r.rosterWrites, r.reached], [[], false], 'a non-friend outside the roster is dropped');
r = await route('FRIEND', { id: 'm3', groupId: 'NOT_HERE', content: 'planted', senderName: 'f' });
assert.deepEqual([r.rosterWrites, r.reached], [[], false], 'a friend cannot file a message under a group not on this device (it would show up as his once I join)');
r = await route('MEMBER', { id: 'm4', groupId: 'X', content: 'hi', senderName: 'Mem' });
assert.deepEqual([r.rosterWrites, r.reached, r.nick], [[], true, [['X', 'MEMBER', 'Mem']]], 'a member still gets through (only the display name is refreshed)');
console.log('PASS 1-1 group-tagged messages: no roster self-heal, unknown groups dropped, members kept');

// ── 2 群組金鑰的路 ──
const recv = between(provider, 'const handleGroupKeyMessage = useCallback(', '}, [holdGroupMessage]);');
assert.ok(/engine\.isMember\(|isMember\(/.test(recv), 'handleGroupKeyMessage checks the applied roster');
assert.ok(/holdGroupMessage\(/.test(recv) && /requestSync\(/.test(recv), 'a sender I do not know yet is held while the log is fetched');
assert.ok(!/addMember|removeMember|markDeparted|_applyChainGroup|mergeRoster|selfHeal|healName/.test(recv), 'it never writes the roster');
console.log('PASS group-key messages never write the roster (held until the chain says otherwise)');

// ── 3 沒有任何從訊息改名冊的路 ──
for (const [name, src] of [['AppProvider', provider], ['useGroupChat', hook]]) {
  assert.ok(!/useGroupStore\.getState\(\)\.(addMember|removeMember|updateMemberRole|markDeparted)\(|store\(\)\.(addMember|removeMember|markDeparted)\(/.test(src),
    `${name}: no roster writes outside the chain projection`);
  const code = src.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, '');   // 註解裡提到舊型別（說明拿掉了什麼）不算
  assert.ok(!/mergeRosterFromAdmin|Self-healed roster|MessageType\.(GROUP_MEMBER_ADDED|GROUP_MEMBER_REMOVED|GROUP_MEMBER_LEFT|GROUP_ROLE_UPDATED|GROUP_INFO_UPDATED|GROUP_INVITE)\b|'group_(invite|member_added|member_removed|member_left|role_updated|info_updated)'/.test(code),
    `${name}: none of the pre-chain roster messages are sent or handled`);
}
assert.equal((provider.match(/_applyChainGroup\(/g) ?? []).length, 1, 'the store is written only from the engine projection callback');
console.log('PASS no receive path can change the roster: the chain projection is the only writer');

/**
 * 解密後只顯示認得的型別（對應群星 2026-10-01 審查）：控制訊息各自 return；剩下的不在名單上 → 有內容的當文字
 * （照樣做 L2 掃描），沒內容的（不認得的控制訊息，例如別版多出來的回條）不顯示。轉帳卡片（payment）只在 1 對 1。
 *   1. 名單本身：1 對 1 有 payment、群組沒有；不是字串的型別一律不在名單上
 *   2. AppProvider 的順序：1 對 1 的名單檢查在所有控制訊息（含轉帳狀態）之後、L2 掃描與存檔之前；
 *      群組的在 L2 掃描之前；不認得又沒內容的直接 return（不存、不顯示）
 * Run: node scripts/review/visible_types_self_test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { visibleTypes } from './providerScope.mjs';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const { DIRECT_VISIBLE_TYPES, GROUP_VISIBLE_TYPES, visibleTypeOf } = visibleTypes;

// 1
for (const t of ['text', 'image', 'file', 'voice', 'payment']) assert.equal(visibleTypeOf(t, DIRECT_VISIBLE_TYPES), t, `1:1 shows ${t}`);
assert.equal(visibleTypeOf('payment', GROUP_VISIBLE_TYPES), null, 'payment cards are 1:1 only');
for (const t of ['msg_ack', 'file_ctl', 'agent_status', 'payment_executed', 'weird', undefined, 42, { toString: () => 'text' }]) {
  assert.equal(visibleTypeOf(t, DIRECT_VISIBLE_TYPES), null, `not visible: ${String(t)}`);
}
console.log('PASS the visible-type lists: payment only in 1:1; control and unknown types are not visible');

// 2
const app = readFileSync(ROOT + 'src/providers/AppProvider.tsx', 'utf8');
const body = app.slice(app.indexOf('const processEncryptedMessage = async'), app.indexOf('processEncryptedMessageRef.current = processEncryptedMessage'));
assert.ok(body.length > 1000, 'found processEncryptedMessage');
const at = (needle, from = 0) => { const i = body.indexOf(needle, from); assert.ok(i >= 0, `missing: ${needle}`); return i; };
const directCheck = at('visibleTypeOf(messageData.type, DIRECT_VISIBLE_TYPES)');
// 開源第 5a 步：轉帳狀態（payment_*）交給 ext.payments（官方版 src/ext-official/payments.ts 的對照表），L2 掃描是
//   ext.antiFraud.inspectInbound 的掃描點；順序不變
for (const control of ["'agent_status'", "'group_key_distribution'", "'group_key_request'", "'file_manifest'", "'recovery_shard'", 'ext.payments?.onDirectControl({']) {
  assert.ok(at(control) < directCheck, `${control} is handled before the 1:1 visible-type check`);
}
if (existsSync(ROOT + 'src/ext-official/payments.ts')) {
  const payments = readFileSync(ROOT + 'src/ext-official/payments.ts', 'utf8');
  for (const t of ['payment_executed:', 'payment_failed:', 'payment_cancelled:', 'payment_scheduled:']) {
    assert.ok(payments.includes(t), `the official payments extension handles ${t}`);
  }
  assert.match(payments, /if \(!\(t in map\)\) return false;[\s\S]*return true;/, 'payment_* are handled (never shown), anything else is not');
} else {
  // the chat edition has no ext.payments: payment_* fall through to the visible-type check, which never shows them (part 1)
  console.log('SKIP official payments extension: src/ext-official is not in this checkout (its payment_* table is not checked)');
}
assert.ok(directCheck < at("site: 'direct'", directCheck), '1:1 check runs before the L2 scan');
assert.ok(directCheck < at('await receiveMessage(friend.id', directCheck), '1:1 check runs before the message is stored');
const directBlock = body.slice(directCheck, at('devLog(\'[AppProvider] Decrypted message from:', directCheck));
assert.match(directBlock, /content\.length === 0\)\s*\{[\s\S]*?return;/, 'an unknown type without content is not shown');
assert.match(directBlock, /messageData\.type = 'text'/, 'an unknown type with content becomes text');
const groupBranch = at('if (messageData.groupId) {');
const groupCheck = at('visibleTypeOf(messageData.type, GROUP_VISIBLE_TYPES)', groupBranch);
assert.ok(groupCheck < at("site: 'group-1to1'", groupBranch), 'group check runs before the group L2 scan');
console.log('PASS AppProvider applies the lists after every control type and before L2 / storage');

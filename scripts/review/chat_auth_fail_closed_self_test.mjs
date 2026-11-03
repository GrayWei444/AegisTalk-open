/**
 * The community login never treats a slow PIN check as "no account" and never deletes an account without asking
 * (security review L4).
 * Before: ext/chat/ChatAuthScreen.tsx raced pinAuth().hasPin() against a 5-second timer that answered `false` → the welcome
 * screen of a fresh install; restoring a recovery kit from there wiped the local account without a question.
 * Now: on a slow answer an account visible in localStorage goes to the PIN screen, otherwise the screen keeps waiting for the
 * real answer; the kit restore asks (mismatch.startOverConfirm) before deleting an account that is still on the phone.
 * Source checks of the real component (its behaviour needs React and the app database).
 *
 *   node scripts/review/chat_auth_fail_closed_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const auth = readFileSync(SRC + '/ext/chat/ChatAuthScreen.tsx', 'utf8');
const between = (from, to) => { const a = auth.indexOf(from); assert.ok(a >= 0, `ChatAuthScreen has ${from}`); return auth.slice(a, auth.indexOf(to, a)); };

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

check('a slow PIN check is not "no PIN": a visible account goes to the PIN screen, otherwise the real answer is awaited', () => {
  const body = between('const checkAuth = async () => {', 'void checkAuth();');
  assert.doesNotMatch(body, /resolve\(false\)/, 'no timer that answers "no PIN"');
  assert.match(body, /const hasPin = quick === 'slow' \? \(localAccountVisible\(\) \|\| await pinCheck\) : quick;/);
  const visible = between('function localAccountVisible(): boolean {', '\n}\n');
  assert.match(visible, /localStorage\.getItem\('mist_keys'\) \|\| localStorage\.getItem\('mist_pin_hash'\)/);
});

check('restoring a kit asks before deleting an account that is still on the phone; declining changes nothing', () => {
  const kit = between('const restoreKit = useCallback(', 'const handleConfirm = useCallback(');
  const iAsk = kit.indexOf("window.confirm(s('mismatch.startOverConfirm'))"), iWipe = kit.indexOf('await wipeLocalAccount(');
  assert.ok(iAsk > 0 && iWipe > iAsk, 'the question comes before the wipe');
  assert.match(kit.slice(iAsk, iWipe), /setMode\('kit'\);\s*return;/, 'declining returns to the kit screen without writing anything');
  assert.ok(kit.indexOf('await setEncryptionKey(') > iWipe, 'nothing is written before the answer');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS chat_auth_fail_closed: slow PIN check never shows a fresh install; no silent wipe on kit restore');

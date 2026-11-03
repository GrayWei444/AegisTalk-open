/**
 * Web Push 的通知內容（開源第 4 步審查 M4、第 5d 步，services/pushDisplay.ts ＋ sw-custom.ts）：推播沒有寄件人簽章，推得動的人
 * （持有 VAPID 私鑰的營運方、舊版留下的 relay）能塞任何欄位。
 *   1. 只看伺服器組的 type；名字、標題、內文、圖示網址、tag 一律不採用（固定文字）
 *   2. 來電（第 5d 步）：響鈴 token 沒驗過 → 不是來電的樣子（ring false）、不帶名字、不管伺服器說是不是視訊（以前「媽媽」的名字雖然
 *      不顯示，任何推播照樣變成一直響的來電通知）；驗過（decideRing 給的 ring）→ 來電的樣子，名字是本機存的、視訊看 token
 *   3. 解析不了、不認得的型別 → 一則固定的「新訊息」（userVisibleOnly 一定要顯示一則）
 *   4. service worker 用它：原始碼裡沒有從推播資料拿 callerName／callerAvatar／title／body／icon／tag／alertType／protectedName；
 *      來電的樣子只給 display.ring；沒驗過的來電通知點了只開 App、滑掉不送「拒接」
 * Run: node scripts/review/push_display_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'pushdisp-'));
await require('esbuild').build({ entryPoints: [SRC + '/services/pushDisplay.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'p.mjs'), logLevel: 'silent' });
const { pushDisplayFor } = await import(pathToFileURL(join(dir, 'p.mjs')));
const NOW = 1_900_000_000_000;

// 1 ＋ 2
// 自己的 tag：一則偽造的推播不會蓋掉（取代）一則驗過的來電通知（第 5d 步審查 L3）
const GENERIC_CALL = { kind: 'incoming_call', ring: false, isVideoCall: false, tag: 'call-hint', title: 'AegisTalk', body: '可能有人打給你，打開 AegisTalk 看看' };
const voice = pushDisplayFor({ type: 'incoming_call', action: 'wake_and_sync', senderPubkey: 'A'.repeat(44), isVideoCall: 'false' }, NOW);
assert.deepEqual(voice, GENERIC_CALL, 'an incoming-call push without a verified ring token is a plain notification: no call style, no name');
for (const v of ['true', true, 'False', 'yes', 1, null]) {
  assert.deepEqual(pushDisplayFor({ type: 'incoming_call', isVideoCall: v, ringToken: 'r1.x.y' }, NOW), GENERIC_CALL, `unverified (isVideoCall ${v}): still plain`);
}
const verified = pushDisplayFor({ type: 'incoming_call', isVideoCall: 'false' }, NOW, { name: '  媽媽  ', video: true });
assert.deepEqual(verified, { kind: 'incoming_call', ring: true, isVideoCall: true, tag: 'incoming-call', title: '📹 視訊來電', body: '媽媽 正在發起視訊通話' },
  'a verified ring: call style, the local name, video from the signed token (not the server\'s isVideoCall)');
assert.deepEqual(pushDisplayFor({ type: 'incoming_call' }, NOW, { name: '', video: false }),
  { kind: 'incoming_call', ring: true, isVideoCall: false, tag: 'incoming-call', title: '📞 來電', body: '打開 AegisTalk 接聽' }, 'verified, no local name: no name shown');
assert.equal(pushDisplayFor({ type: 'incoming_call' }, NOW, { name: 'x'.repeat(200), video: false }).body.length, 64 + ' 正在呼叫你'.length, 'name capped');
assert.equal(pushDisplayFor({ type: 'message' }, NOW, { name: '媽媽', video: false }).ring, false, 'only calls can ring');
assert.equal(pushDisplayFor({ type: 'incoming_call', isVideoCall: 'true' }, NOW, { name: '媽媽', video: false }).isVideoCall, false,
  'video comes from the signed token only (the server\'s "true" does not turn a voice call into a video call)');
const forged = pushDisplayFor({ type: 'incoming_call', callerName: '媽媽', callerAvatar: 'https://evil.example/t.png', title: '銀行通知',
  body: '請立即轉帳', tag: 'x', icon: 'https://evil.example/i.png' }, NOW);
const shown = JSON.stringify(forged);
for (const leak of ['媽媽', 'evil.example', '銀行', '轉帳']) assert.ok(!shown.includes(leak), `injected text is never shown: ${leak}`);
const msg = pushDisplayFor({ type: 'message', title: '你中獎了', body: '點這裡', icon: 'https://evil.example/i.png', tag: 'pin' }, NOW);
assert.deepEqual(msg, { kind: 'message', ring: false, isVideoCall: false, tag: `msg-${NOW}`, title: 'AegisTalk', body: '你有新訊息' });
const guardian = pushDisplayFor({ type: 'guardian_alert', alertType: 'payment_intent', protectedName: '爸爸' }, NOW);
assert.ok(!JSON.stringify(guardian).includes('爸爸'), 'no protected name from the push');
assert.equal(guardian.kind, 'guardian_alert');
assert.equal(pushDisplayFor({ type: 'check_in' }, NOW).kind, 'check_in');
console.log('PASS only the server-built type is used; an unverified call push is plain and nameless; a verified ring shows the local name; push texts are ignored');

// 3
for (const d of [null, undefined, 'text', [], 42, { type: 'fake_bank_alert', body: '...' }, { type: ['incoming_call'] }]) {
  assert.deepEqual(pushDisplayFor(d, NOW), { kind: 'message', ring: false, isVideoCall: false, tag: `msg-${NOW}`, title: 'AegisTalk', body: '你有新訊息' },
    `unparsable / unknown → a fixed "new message" (${JSON.stringify(d)})`);
}
console.log('PASS unparsable or unknown pushes show one fixed "new message" notification');

// 4
const sw = readFileSync(SRC + '/sw-custom.ts', 'utf8');
const pushHandler = sw.slice(sw.indexOf("self.addEventListener('push'"), sw.indexOf("self.addEventListener('notificationclick'"));
assert.match(pushHandler, /event\.waitUntil\(decideRing\(data, Date\.now\(\)\)\.then\(\(ring\) => showPushNotification\(pushDisplayFor\(data, Date\.now\(\), ring\)\)\)\)/,
  'the push handler shows pushDisplayFor(...) only, with the ring decided from the signed token (decideRing)');
const showFn = sw.slice(sw.indexOf('async function showPushNotification('), sw.indexOf('async function showLocalCallNotification('));
assert.ok(showFn.length > 200, 'showPushNotification found');
// 推播那條路（push 事件、組通知、點通知）不看推播裡的名字、文字、圖示、id；名字只來自 App 視窗自己（postMessage）
const fromPush = pushHandler + showFn + sw.slice(sw.indexOf("self.addEventListener('notificationclick'"));
assert.doesNotMatch(fromPush, /callerName|callerAvatar|protectedName|alertType|data\.title|data\.body|data\.icon|data\.tag|data\.callId/,
  'the push path never reads names, texts, icons or ids from a push');
assert.match(sw, /if \(event\.data\?\.type === 'SHOW_CALL_NOTIFICATION'\) \{\s*void showLocalCallNotification\(event\.data\.payload\);/,
  'a caller name is shown only when the app window itself asks (same-origin postMessage) or the ring token verified');
assert.match(showFn, /if \(display\.kind === 'incoming_call' && display\.ring\) \{/, 'call style (accept/reject, long vibration) only for display.ring');
assert.match(showFn, /type: display\.kind === 'incoming_call' \? 'message' : display\.kind,/,
  'an unverified call notification is a plain one: a click only opens the app, a swipe sends no REJECT_CALL');
console.log('PASS the service worker builds notifications only from pushDisplayFor');

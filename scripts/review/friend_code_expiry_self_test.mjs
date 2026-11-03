/**
 * 短碼「重新產生」就作廢舊碼；本機只認到「伺服器到期＋24 小時」（程式碼審查 M3）。
 *   以前：FriendCode 每拿到一個碼就記 7 天，按「重新產生」舊碼在伺服器上作廢了，本機卻照樣認 7 天 ——
 *         碼外流後想作廢，其實作廢不了。
 *   現在：按重新產生（/api/shortcode/refresh）成功 → 這個帳號以前記的短碼全部拿掉，只留新碼；
 *         伺服器給的到期時間最多採信到「拿到碼的時候＋24 小時」（伺服器短碼本來就 24 小時），不照單全收；
 *         每個碼本機認到「伺服器說的到期時間＋24 小時」（broker 離線佇列最多留 24 小時：到期前送出的 INIT
 *         晚一天才到也認），不再一律 7 天。重新打開分頁（/api/shortcode/register）不是作廢，舊碼照樣認到它自己到期。
 *   真的 FriendCode.fetchShortCode（假的伺服器）＋真的 friendInvites（記憶體 localStorage、可控時間），
 *   用 makeVia／acceptedVia 模擬「拿到碼的人送 INIT、碼主人收」。
 * Run: node scripts/review/friend_code_expiry_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { friendViaKit } from './friendViaKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const src = (p) => readFileSync(root + 'packages/pwa/src/' + p, 'utf8');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.message).split('\n')[0]); }
}

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR, T0 = 1_800_000_000_000;
const store = new Map();
let now = T0;
const at = (ms) => { now = T0 + ms; };
const FakeDate = class extends Date { static now() { return now; } };
const names = ['rememberInvite', 'rememberShortCode', 'acceptedVia', 'makeVia', 'issueQrInvite'];
const fi = new Function('localStorage', 'Date', 'crypto', transformSync(src('services/friendInvites.ts').replace(/^export /gm, ''), { loader: 'ts' }).code
  + `;return {${names.map((k) => `${k}: typeof ${k} === 'undefined' ? undefined : ${k}`).join(',')}};`)(
  { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, FakeDate, globalThis.crypto);

// 每個角色一支真的手機（真的身分金鑰；via 封給碼主人的身分金鑰，見 friendViaKit）
const kit = await friendViaKit(root);
const P = {};
for (const n of ['BOB', 'ALICE', 'CAROL']) P[n] = await kit.party(n);
/** owner 收到 who 用 code 加他的 INIT：認不認 */
const accepts = async (code, { owner = 'BOB', who = 'ALICE', kind = 'code' } = {}) => {
  const via = await fi.makeVia({ kind, token: code }, P[who].pk, 'EPH', P[owner].pk, P[who].sealer);
  return !!(await fi.acceptedVia(P[owner].pk, P[who].pk, 'EPH', via, P[owner].sealer));
};

// ── 真的 FriendCode.fetchShortCode，伺服器照 api/chat/shortcode.py 的 register／refresh 行為回 ──
const fc = src('components/Verification/FriendCode.tsx');
const a = fc.indexOf('const fetchShortCode = useCallback('); const b = fc.indexOf('// 自動取得短碼', a);
assert.ok(a >= 0 && b > a, 'FriendCode has fetchShortCode');
const fetchCode = transformSync(fc.slice(a, b), { loader: 'tsx' }).code + ';({ fetchShortCode })';

/** 碼主人的「好友碼」分頁。server：{ code, expiresAtSec } 現在伺服器上的碼；refresh 時換成 next */
function friendCodeTab(owner, server) {
  const calls = [];
  const { fetchShortCode } = runInNewContext(fetchCode, {
    useCallback: (fn) => fn, publicKey: P[owner].pk, signedPreKey: { publicKeyBase64: 'SPK', signatureBase64: 'SIG' },
    displayName: owner, t: (k) => k, onError() {}, onCodeGenerated() {}, apiBase: () => 'https://api', JSON, Error, Date: FakeDate,
    // 請求的簽章（第 3 步）另外在 shortcode_request_self_test.mjs 驗；這裡只看短碼的期限
    mqttService: { identitySignerFor: (pk) => ({ publicKey: pk, sign: () => new Uint8Array(64) }), serverNow: () => now },
    signedShortCodeRequest: (signer, bundle, action) => ({ action, public_key: signer.publicKey }),
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/refresh')) Object.assign(server, server.next(), {});
      return { ok: true, json: async () => ({ short_code: server.code, expires_at: server.expiresAtSec,
        remaining_seconds: server.expiresAtSec - Math.floor(now / 1000), is_new: url.endsWith('/refresh') }) };
    },
    rememberInvite: fi.rememberInvite, rememberShortCode: fi.rememberShortCode,
    setIsLoading() {}, setError() {}, setShortCode() {}, setExpiresAt() {},
  });
  return { open: () => fetchShortCode(), regenerate: () => fetchShortCode(true), calls };
}
const sec = (ms) => Math.floor(ms / 1000);

await check('regenerating the short code cancels the previous one at once; the new one works', async () => {
  store.clear(); at(0);
  const server = { code: 'OLD234', expiresAtSec: sec(T0 + DAY), next: () => ({ code: 'NEW567', expiresAtSec: sec(now + DAY) }) };
  const tab = friendCodeTab('BOB', server);
  await tab.open();
  assert.ok(await accepts('ATK-OLD234'), 'control: the code on screen works');
  at(HOUR);
  await tab.regenerate();
  assert.ok(tab.calls.at(-1).endsWith('/api/shortcode/refresh'), 'regenerate asks the server for a new code');
  assert.equal(await accepts('ATK-OLD234'), false, 'the old code is refused right after regenerating (it used to work for 7 more days)');
  assert.ok(await accepts('ATK-NEW567'), 'the new code works');
});

await check('a code is accepted until the server expiry + 24 h (broker queue), then refused — not a flat 7 days', async () => {
  store.clear(); at(0);
  const server = { code: 'K7M2QP', expiresAtSec: sec(T0 + DAY), next: () => ({}) };
  await friendCodeTab('BOB', server).open();
  at(DAY + 23 * HOUR + 59 * MIN);
  assert.ok(await accepts('ATK-K7M2QP'), 'an INIT sent before expiry that waited a day in the broker is still accepted');
  at(2 * DAY + SEC);
  assert.equal(await accepts('ATK-K7M2QP'), false, 'refused once server expiry + 24 h has passed');
  at(6 * DAY);
  assert.equal(await accepts('ATK-K7M2QP'), false, 'still refused on day 6 (used to be accepted for 7 days)');
});

await check('register returning an existing code with 2 h left: accepted until those 2 h + 24 h, not a fresh day', async () => {
  store.clear(); at(0);
  const server = { code: 'ABC234', expiresAtSec: sec(T0 + 2 * HOUR), next: () => ({}) };
  await friendCodeTab('BOB', server).open();
  at(2 * HOUR + 23 * HOUR + 59 * MIN);
  assert.ok(await accepts('ABC234'), 'accepted just before server expiry + 24 h');
  at(2 * HOUR + DAY + SEC);
  assert.equal(await accepts('ABC234'), false, 'refused after server expiry + 24 h');
});

await check('reopening the code tab (register, not regenerate) keeps an older code until its own expiry', async () => {
  store.clear(); at(0);
  const server = { code: 'FIRST2', expiresAtSec: sec(T0 + DAY), next: () => ({}) };
  const tab = friendCodeTab('BOB', server);
  await tab.open();
  at(DAY + HOUR);                                           // 伺服器上那個碼過期了，打開分頁拿到新的一個
  Object.assign(server, { code: 'SECND3', expiresAtSec: sec(now + DAY) });
  await tab.open();
  assert.ok(tab.calls.at(-1).endsWith('/api/shortcode/register'), 'opening the tab registers, it does not regenerate');
  assert.ok(await accepts('FIRST2'), 'an INIT made with the previous code while it was live still gets in during its 24 h tail');
  assert.ok(await accepts('SECND3'), 'the new code works');
});

await check('regenerating drops only this account\'s codes: another account on the same phone and my QR nonces are untouched', async () => {
  store.clear(); at(0);
  await friendCodeTab('CAROL', { code: 'CAROL2', expiresAtSec: sec(T0 + DAY), next: () => ({}) }).open();
  const { nonce } = fi.issueQrInvite(P.BOB.pk);
  const tab = friendCodeTab('BOB', { code: 'BOBOLD', expiresAtSec: sec(T0 + DAY), next: () => ({ code: 'BOBNEW', expiresAtSec: sec(now + DAY) }) });
  await tab.open();
  await tab.regenerate();
  assert.equal(await accepts('BOBOLD'), false, 'my old code is gone');
  assert.ok(await accepts('CAROL2', { owner: 'CAROL' }), 'Carol\'s code (other account) still works');
  assert.ok(await accepts(nonce, { kind: 'qr' }), 'my QR on screen still works');
});

await check('a server expiry beyond its 24 h TTL is clamped: the code is accepted at most until it was shown + 24 h + 24 h', async () => {
  store.clear(); at(0);
  await friendCodeTab('BOB', { code: 'FAR234', expiresAtSec: sec(T0 + 365 * DAY), next: () => ({}) }).open();
  at(2 * DAY - MIN);
  assert.ok(await accepts('FAR234'), 'accepted within shown + 48 h');
  at(2 * DAY + SEC);
  assert.equal(await accepts('FAR234'), false, 'refused after shown + 48 h, whatever the server said');
});

await check('the same code returned again is stored once (no duplicate entries)', async () => {
  store.clear(); at(0);
  const tab = friendCodeTab('BOB', { code: 'SAME23', expiresAtSec: sec(T0 + DAY), next: () => ({}) });
  for (let i = 0; i < 5; i++) await tab.open();
  const saved = JSON.parse(store.get('aegis_friend_invites_v1') ?? '[]');
  assert.equal(saved.filter((e) => e.kind === 'code').length, 1, `one entry: ${JSON.stringify(saved)}`);
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nALL PASS');

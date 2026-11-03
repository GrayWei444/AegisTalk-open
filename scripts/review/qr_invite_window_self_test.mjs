/**
 * 加好友 QR「五分鐘一張」（產品決定 2026-10-15：qrcode 是五分鐘一次；對應 AegisPlay 5a1edc11）：
 *   真的 friendInvites.ts ＋ 抽出 QRCodeVerification 的產生／換新程式碼、AddFriendModal 的掃描／確認程式碼，配 stub 執行。
 *   - 畫出來起 5 分鐘內，幾個人掃同一張都認（不是用一次就作廢）。
 *   - 畫面打開就是新的一張，每 5 分鐘自動換新（App 從背景回來那一刻也馬上換），不會顯示一張已失效的碼。
 *   - 掃描端：掃到時 QR 已過 5 分鐘（＋30 秒寬限，容兩支手機的時鐘差一點）就不送；看風險警告看到過期，也不送。
 *   - 碼主人（收 INIT 的一端）：畫出來起 30 分鐘內收到的都認（程式碼審查 M1）—— 掃完對方就鎖屏、INIT 在離線佇列，
 *     碼主人可能過好幾分鐘才處理到；以前 5 分鐘＋30 秒一過就整封拒收，掃描端還以為加成功了。
 * Run: node scripts/review/qr_invite_window_self_test.mjs
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

const SEC = 1000, MIN = 60 * SEC, T0 = 1_800_000_000_000;
const store = new Map();
let now = T0;
const FakeDate = class extends Date { static now() { return now; } };
const names = ['acceptedVia', 'makeVia', 'issueQrInvite', 'qrScreenTick', 'qrScanExpired', 'QR_INVITE_TTL_MS', 'QR_INVITE_GRACE_MS', 'QR_INVITE_ACCEPT_MS'];
const fi = new Function('localStorage', 'Date', 'crypto', transformSync(src('services/friendInvites.ts').replace(/^export /gm, ''), { loader: 'ts' }).code
  + `;return {${names.map((k) => `${k}: typeof ${k} === 'undefined' ? undefined : ${k}`).join(',')}};`)(
  { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, FakeDate, globalThis.crypto);
const GRACE = fi.QR_INVITE_GRACE_MS ?? 30 * SEC;
/** 掃到這張 QR 的人（who）加我：他送的 via 是綁他自己金鑰的證明（friend_strict_accept_self_test），收端（owner）認不認 */
// 每個角色一支真的手機（真的身分金鑰；via 封給碼主人的身分金鑰，見 friendViaKit）
const kit = await friendViaKit(root);
const P = {};
for (const n of ['ME', 'OTHER', 'SCANNER', 'ANN', 'BEN', 'CAT', 'DAN', 'EVE']) P[n] = await kit.party(n);
const ME = P.ME.pk;
const ok = async (token, who = 'SCANNER', owner = 'ME') => {
  assert.equal(typeof fi.makeVia, 'function', 'makeVia exported');
  const via = await fi.makeVia({ kind: 'qr', token }, P[who].pk, 'EPH', P[owner].pk, P[who].sealer);
  return !!(await fi.acceptedVia(P[owner].pk, P[who].pk, 'EPH', via, P[owner].sealer));
};
const at = (ms) => { now = T0 + ms; };
const plain = (o) => JSON.parse(JSON.stringify(o));   // vm 裡建的物件原型不同，比內容就好

await check('QR credential: a new code every 5 minutes, scanner grace at most a minute, receiver accepts for 30 minutes', () => {
  assert.equal(fi.QR_INVITE_TTL_MS, 5 * MIN, 'QR_INVITE_TTL_MS = 5 min');
  assert.ok(Number.isFinite(fi.QR_INVITE_GRACE_MS) && fi.QR_INVITE_GRACE_MS >= 0 && fi.QR_INVITE_GRACE_MS <= MIN, 'QR_INVITE_GRACE_MS in [0, 60 s]');
  assert.equal(fi.QR_INVITE_ACCEPT_MS, 30 * MIN, 'QR_INVITE_ACCEPT_MS = 30 min');
});

await check('a QR nonce is accepted until 30 minutes after it was shown (INIT processed late: phone locked, offline queue), refused after', async () => {
  store.clear(); at(0);
  const n1 = fi.issueQrInvite(ME).nonce;
  at(4 * MIN + 59 * SEC); assert.ok(await ok(n1), 'accepted at 4:59');
  at(5 * MIN + SEC + GRACE); assert.ok(await ok(n1), 'scanned at 4:59, processed at 5:31 → accepted (was refused)');
  at(29 * MIN + 59 * SEC); assert.ok(await ok(n1), 'scanned at 4:59, the owner\'s phone was locked, processed at 29:59 → accepted');
  at(30 * MIN + SEC); assert.equal(await ok(n1), false, 'refused at 30:01');
  at(60 * MIN); assert.equal(await ok(n1), false, 'refused an hour later');
});

await check('several people scanning the same QR within 5 minutes are all accepted (not single-use)', async () => {
  store.clear(); at(0);
  const shared = fi.issueQrInvite(ME).nonce;
  for (const [who, t] of [['ANN', 10 * SEC], ['BEN', 2 * MIN], ['CAT', 4 * MIN + 59 * SEC], ['DAN', 4 * MIN + 59 * SEC]]) {
    at(t); assert.ok(await ok(shared, who), `${who} at ${t / SEC}s`);
  }
  at(30 * MIN + SEC); assert.equal(await ok(shared, 'EVE'), false, 'an INIT processed after 30:01 is refused');
  assert.equal(await ok(shared, 'ANN', 'OTHER'), false, 'still bound to my account');
});

await check('issueQrInvite: remembers the nonce; the QR ts/exp are the same instant (exp = ts + 5 min)', async () => {
  assert.equal(typeof fi.issueQrInvite, 'function', 'issueQrInvite exported');
  store.clear(); at(0);
  const a = fi.issueQrInvite(ME);
  assert.equal(a.issuedAt, T0); assert.equal(a.expiresAt, T0 + 5 * MIN);
  assert.match(a.nonce, /^[A-Za-z0-9_-]{16,}$/);
  const b = fi.issueQrInvite(ME);
  assert.notEqual(a.nonce, b.nonce, 'every QR gets its own nonce');
  at(4 * MIN + 59 * SEC); assert.ok(await ok(a.nonce) && await ok(b.nonce));
  at(30 * MIN + SEC); assert.equal(await ok(a.nonce), false);
});

await check('qrScreenTick counts down by the wall clock and renews at 5:00 (also after a long time in the background)', () => {
  assert.equal(typeof fi.qrScreenTick, 'function', 'qrScreenTick exported');
  const exp = T0 + 5 * MIN;
  assert.deepEqual(fi.qrScreenTick(exp, T0), { secondsLeft: 300, renew: false });
  assert.deepEqual(fi.qrScreenTick(exp, T0 + 4 * MIN + 59 * SEC), { secondsLeft: 1, renew: false });
  assert.deepEqual(fi.qrScreenTick(exp, T0 + 4 * MIN + 59.5 * SEC), { secondsLeft: 1, renew: false });
  assert.deepEqual(fi.qrScreenTick(exp, exp), { secondsLeft: 0, renew: true });
  assert.deepEqual(fi.qrScreenTick(exp, T0 + 20 * MIN), { secondsLeft: 0, renew: true });
});

// ── 真的 QRCodeVerification：產生、每秒 tick、切回前景、到期換新 ──
const comp = src('components/Verification/QRCodeVerification.tsx');
const cut = (text, from, to, file) => {
  const a = text.indexOf(from); const b = text.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${file} has "${from}" … "${to}"`);
  return transformSync(text.slice(a, b), { loader: 'tsx' }).code;
};

function openScreen() {
  const genCode = cut(comp, 'const generateQR = useCallback(', '// 打開畫面', 'QRCodeVerification');
  const tickCode = cut(comp, '// 每秒更新倒數', 'const handleRefresh', 'QRCodeVerification');
  const viewCode = cut(comp, 'const view = ', '// 載入中', 'QRCodeVerification');
  const state = { qr: null, now: 0, error: null };
  const encoded = [];
  let pending = Promise.resolve(); let calls = 0;
  const { generateQR } = runInNewContext(genCode + ';({ generateQR })', {
    useCallback: (fn) => fn, publicKey: ME, signedPreKey: { publicKeyBase64: 'SPK', signatureBase64: 'SIG' },
    displayName: 'Me', t: (k) => k, onError() {}, issueQrInvite: fi.issueQrInvite, generatingRef: { current: false },
    QRCode: { toDataURL: async (text) => { encoded.push(JSON.parse(text)); return 'data:' + encoded.length; } },
    setQr: (v) => { state.qr = v; }, setNow: (v) => { state.now = v; }, setError: (v) => { state.error = v; },
    setIsGeneratingQR() {}, Date: FakeDate, JSON,
  });
  const gen = () => { calls++; pending = generateQR(); return pending; };
  let interval = null; let cleanup = null; const listeners = {};
  const tickCtx = {
    useEffect: (fn) => { cleanup = fn() ?? null; }, qr: null, error: null, generateQR: gen, qrScreenTick: fi.qrScreenTick, Date: FakeDate,
    setNow: (v) => { state.now = v; },
    setInterval: (fn, ms) => { assert.ok(ms <= SEC, 'ticks at least every second'); interval = fn; return 1; },
    clearInterval: () => { interval = null; },
    document: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; },
    },
  };
  let mounted = null;
  const rerender = () => {             // React：qr 換了 → effect 重跑
    if (mounted === state.qr) return;
    cleanup?.(); cleanup = null; mounted = state.qr; tickCtx.qr = state.qr;
    runInNewContext(tickCode, tickCtx);
  };
  const showQr = () => runInNewContext(viewCode + ';showQr', { qr: state.qr, now: state.now, qrScreenTick: fi.qrScreenTick });
  const settle = async () => { await pending; rerender(); };
  const shown = () => encoded.at(-1);
  const invariant = () => {
    if (showQr()) assert.ok(now < state.qr.expiresAt, 'an expired code is never on screen');
  };
  return { state, encoded, gen, settle, showQr, shown, invariant, tick: () => interval?.(), listeners, calls: () => calls };
}

await check('QR screen (real code): fresh code on open, renews every 5 minutes, an old one is accepted for 30 minutes after it was shown', async () => {
  store.clear(); at(0);
  const s = openScreen();
  await s.gen(); await s.settle();                       // 打開畫面
  const first = s.shown();
  assert.equal(first.ts, T0); assert.equal(first.exp, T0 + 5 * MIN); assert.equal(s.state.qr.expiresAt, first.exp);
  assert.ok(s.showQr() && await ok(first.n), 'the code on screen is live and remembered');
  for (let t = SEC; t < 5 * MIN; t += SEC) {
    at(t); s.tick(); await s.settle(); s.invariant();
  }
  assert.equal(s.encoded.length, 1, 'no new code before 5:00');
  assert.equal(s.state.now, T0 + 4 * MIN + 59 * SEC, 'countdown follows the clock');
  at(5 * MIN); s.tick(); s.tick();                      // 到期那一秒可能連 tick 兩次
  assert.equal(s.showQr(), false, 'at 5:00 the old code is hidden while the new one is drawn');
  await s.settle(); s.invariant();
  assert.equal(s.encoded.length, 2, 'exactly one new code at 5:00');
  const second = s.shown();
  assert.notEqual(second.n, first.n); assert.equal(second.exp, T0 + 10 * MIN);
  assert.ok(s.showQr(), 'the new code is on screen');
  assert.ok(await ok(first.n), 'someone who scanned the old one at 4:59 still gets in');
  at(5 * MIN + SEC + GRACE); s.tick(); await s.settle();
  assert.ok(await ok(first.n), 'and still does when I only process the INIT at 5:31');
  assert.ok(await ok(second.n), 'the code on screen works');
  at(30 * MIN + SEC);
  assert.equal(await ok(first.n), false, 'the old code is refused 30 minutes after it was shown');
});

await check('QR screen (real code): coming back from the background renews at once', async () => {
  store.clear(); at(0);
  const s = openScreen();
  await s.gen(); await s.settle();
  const before = s.shown();
  at(32 * MIN);                                          // 背景 32 分鐘，計時器沒跑
  assert.ok(s.listeners.visibilitychange, 'listens for the app coming back to the foreground');
  s.listeners.visibilitychange(); await s.settle(); s.invariant();
  const after = s.shown();
  assert.notEqual(after.n, before.n); assert.equal(after.exp, T0 + 37 * MIN);
  assert.equal(await ok(before.n), false); assert.ok(await ok(after.n));
  const reopened = openScreen(); await reopened.gen(); await reopened.settle();
  assert.notEqual(reopened.shown().n, after.n, 'reopening the screen shows a new code too');
});

await check('QR screen wiring: no "expired" overlay, live-only image, refresh text in all 5 languages', () => {
  assert.match(comp, /useState<\{ image: string; expiresAt: number \} \| null>\(null\)/, 'starts empty → every open draws a new code');
  assert.match(comp, /!qr && !isGeneratingQR && !error\) \{\s*void generateQR\(\);/, 'opening the screen generates a code');
  assert.doesNotMatch(comp, /isExpired|已過期/, 'no expired overlay — the screen swaps in a new code instead');
  assert.match(comp, /showQr && qr \? \(\s*<img src=\{qr\.image\}/, 'the image is only drawn while the code is live');
  assert.match(comp, /t\('friendCode\.qrRefreshesIn', \{ time: formatTime\(view\.secondsLeft\) \}\)/, 'countdown to the next code');
  assert.match(comp, /t\('friendCode\.qrRefreshHint'\)/, 'says it changes every 5 minutes');
  const types = src('i18n/types.ts');
  assert.match(types, /qrRefreshesIn: string;/); assert.match(types, /qrRefreshHint: string;/);
  for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
    const loc = src(`i18n/locales/${lang}.ts`);
    assert.match(loc, /\bqrRefreshesIn: (['"])[^'"\n]*\{time\}[^'"\n]*\1,/, `${lang} qrRefreshesIn has {time}`);
    assert.match(loc, /\bqrRefreshHint: (['"])[^'"\n]*5[^'"\n]*\1,/, `${lang} qrRefreshHint mentions 5 minutes`);
  }
});

// ── 掃描端（真的 AddFriendModal）──
const modal = src('components/Verification/AddFriendModal.tsx');
await check('scanner: exp checked with the same grace (clock skew)', async () => {
  assert.equal(typeof fi.qrScanExpired, 'function', 'qrScanExpired exported');
  const exp = T0 + 5 * MIN;
  assert.equal(fi.qrScanExpired(exp, T0 + 4 * MIN), false);
  assert.equal(fi.qrScanExpired(exp, exp + GRACE - SEC), false, 'scanner clock a little ahead → still fine');
  assert.equal(fi.qrScanExpired(exp, exp + GRACE + SEC), true);
  const code = cut(modal, 'const handleQrScanned = useCallback(', '// Phase 12: 確認加好友', 'AddFriendModal');
  const run = async (qr) => {
    const r = { sent: [], error: '' };
    const { handleQrScanned } = runInNewContext(code + ';({ handleQrScanned })', {
      useCallback: (fn) => fn, publicKey: 'ME', Date: FakeDate, JSON, Math, devLog() {}, devWarn() {},
      setScanError: (m) => { r.error = m; }, setScanStatus() {}, setStatusMessage() {}, setRiskWarning() {},
      // 信任分數查詢（開源第 5a 步起經 ext.antiFraud.contactRisk）：跟以前一樣查到空的紀錄
      ext: { antiFraud: { contactRisk: async () => ({}) } }, shouldShowWarning: () => false,
      proceedAddFriend: async (...a) => { r.sent.push(a); }, qrScanExpired: (e) => fi.qrScanExpired(e), addAttemptRef: { current: 0 }, setAwaiting() {},
      qrInvite: (q) => (q.n ? { kind: 'qr', token: q.n } : undefined),
    });
    await handleQrScanned(JSON.stringify(qr));
    return r;
  };
  at(5 * MIN + 10 * SEC);
  let r = await run({ v: 2, pk: 'P', spk: 'S', sig: 'G', name: 'X', ts: T0, exp: T0 + 5 * MIN, n: 'N' });
  assert.equal(r.sent.length, 1, '10 s past exp on my clock (skew) → still adds');
  assert.deepEqual(plain(r.sent[0][2]), { kind: 'qr', token: 'N' });
  at(5 * MIN + SEC + GRACE);
  r = await run({ v: 2, pk: 'P', spk: 'S', sig: 'G', name: 'X', ts: T0, exp: T0 + 5 * MIN, n: 'N' });
  assert.equal(r.sent.length, 0, 'past exp + grace → not sent'); assert.match(r.error, /expired/i);
});

await check('scanner: after a long risk warning an expired QR is not sent', async () => {
  const code = cut(modal, 'const handleConfirmAddFriend = useCallback(', '// Phase 12: 取消加好友', 'AddFriendModal');
  const run = async (qr) => {
    const r = { sent: [], error: '', status: '' };
    const { handleConfirmAddFriend } = runInNewContext(code + ';({ handleConfirmAddFriend })', {
      useCallback: (fn) => fn, riskWarning: { show: true, riskInfo: {}, pendingQrData: qr },
      setRiskWarning() {}, setScanStatus: (s) => { r.status = s; }, setScanError: (m) => { r.error = m; }, setStatusMessage() {},
      proceedAddFriend: async (...a) => { r.sent.push(a); }, qrScanExpired: (e) => fi.qrScanExpired(e), Date: FakeDate, addAttemptRef: { current: 0 }, setAwaiting() {},
      qrInvite: (q) => (q.n ? { kind: 'qr', token: q.n } : undefined),
    });
    await handleConfirmAddFriend();
    return r;
  };
  const qr = { v: 2, pk: 'P', spk: 'S', sig: 'G', name: 'X', ts: T0, exp: T0 + 5 * MIN, n: 'N' };
  at(4 * MIN);
  let r = await run(qr);
  assert.equal(r.sent.length, 1, 'confirmed in time → adds'); assert.deepEqual(plain(r.sent[0][2]), { kind: 'qr', token: 'N' });
  at(7 * MIN);
  r = await run(qr);
  assert.equal(r.sent.length, 0, 'confirmed 2 minutes after expiry → not sent'); assert.equal(r.status, 'error'); assert.match(r.error, /expired/i);
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nALL PASS');

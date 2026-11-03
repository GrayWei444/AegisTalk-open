/**
 * DTLS 指紋核對（開源第 4 步，services/dtlsFingerprint.ts）：真的模組，假的 getStats／計時器。
 *   1. 指紋從 getStats 的 transport → 兩張憑證拿（DTLS 實際用的）；拿不到才看 SDP 的 a=fingerprint；寫法正規化
 *   2. 比對：我看到的對方 ＝ 他說的他自己、他看到的對方 ＝ 我 —— 中間人（兩邊各接到他的一張憑證）兩邊都對不上；空的不算
 *   3. 對方送來的格式要對（不認得的演算法、怪字元、太多項、少 got → 不理）
 *   4. 流程：ICE 連上才 start；對上 → onVerified 一次，對方說還沒拿到我的就回一次；對不上 → onFail('mismatch')；
 *      timeout 內沒驗過 → onFail('timeout')；自己的讀不到 → onFail('unreadable')；對方先到的先收著；重送到對方說拿到為止；stop 之後什麼都不做
 * Run: node scripts/review/dtls_fingerprint_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'dtlsfp-'));
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/dtlsFingerprint.ts'],
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'f.mjs'), logLevel: 'silent' });
const F = await import(pathToFileURL(join(dir, 'f.mjs')));

const hex = (b) => Array.from({ length: 32 }, () => b).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
const FA = `sha-256 ${hex(0xa1)}`, FB = `sha-256 ${hex(0xb2)}`, FM1 = `sha-256 ${hex(0xc3)}`, FM2 = `sha-256 ${hex(0xd4)}`;
const stats = (local, remote, dtlsState = 'connected') => ({
  forEach(cb) {
    cb({ id: 'T', type: 'transport', dtlsState, localCertificateId: 'L', remoteCertificateId: 'R' });
    if (local) cb({ id: 'L', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: local.split(' ')[1].toLowerCase() });
    if (remote) cb({ id: 'R', type: 'certificate', fingerprintAlgorithm: 'SHA-256', fingerprint: remote.split(' ')[1] });
  },
});
const sdp = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:${fp}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:${fp}\r\n`;

// 1
assert.equal(F.normalizeFingerprint('SHA-256', hex(0xa1).toLowerCase()), FA, 'algorithm lower case, hex upper case');
assert.equal(F.normalizeFingerprint('md5', hex(0xa1)), null, 'unknown algorithm');
assert.equal(F.normalizeFingerprint('sha-256', 'AB:CD'), null, 'too short');
assert.equal(F.normalizeFingerprint('sha-256', hex(0xa1) + ' x'), null);
assert.deepEqual(F.fingerprintsFromSdp(sdp(FA)), [FA], 'SDP fingerprint lines (session + media, de-duplicated)');
assert.deepEqual(await F.readFingerprints({ getStats: async () => stats(FA, FB) }), { local: [FA], remote: [FB] }, 'from getStats (the certificates DTLS used)');
assert.deepEqual(await F.readFingerprints({ getStats: async () => stats(null, null), localDescription: { sdp: sdp(FA) }, remoteDescription: { sdp: sdp(FB) } }),
  { local: [FA], remote: [FB] }, 'falls back to the SDP');
assert.deepEqual(await F.readFingerprints({ getStats: async () => { throw new Error('no stats'); }, localDescription: { sdp: sdp(FA) }, remoteDescription: { sdp: sdp(FB) } }),
  { local: [FA], remote: [FB] }, 'also when getStats throws');
assert.equal(await F.readFingerprints({ getStats: async () => stats(FA, null, 'connecting'), localDescription: null, remoteDescription: null }), null,
  'nothing usable yet (DTLS not connected, no SDP) → null');
console.log('PASS fingerprints come from the DTLS certificates (getStats), SDP as fallback; normalised');

// 2
const A = { local: [FA], remote: [FB] }, B = { local: [FB], remote: [FA] };
assert.ok(F.fingerprintsMatch(A, B) && F.fingerprintsMatch(B, A), 'a direct connection matches on both sides');
const aViaM = { local: [FA], remote: [FM1] }, bViaM = { local: [FB], remote: [FM2] };   // 中間人：A↔M1、M2↔B
assert.ok(!F.fingerprintsMatch(aViaM, bViaM) && !F.fingerprintsMatch(bViaM, aViaM), 'a man in the middle (two DTLS legs) fails on both sides');
assert.ok(!F.fingerprintsMatch({ local: [FA], remote: [FM1] }, { local: [FB], remote: [FA] }), 'mine says M, his says B → mismatch');
assert.ok(!F.fingerprintsMatch(A, { local: [FB], remote: [FM1] }), 'his view of me is not my certificate (only his leg is intercepted) → mismatch');
assert.ok(!F.fingerprintsMatch({ local: [], remote: [] }, { local: [], remote: [] }), 'empty lists never match');
assert.ok(!F.fingerprintsMatch(A, { local: [FB, FM1], remote: [FA] }), 'an extra fingerprint is a mismatch');
console.log('PASS mismatch detection: a MITM fails on both sides; empty or extra fingerprints never match');

// 3
assert.deepEqual(F.parseFingerprintMessage({ local: [FA], remote: [FB], got: false }), { local: [FA], remote: [FB], got: false });
for (const bad of [null, [], { local: [FA], remote: [FB] }, { local: FA, remote: [FB], got: true }, { local: [], remote: [FB], got: true },
  { local: [FA.toLowerCase()], remote: [FB], got: true }, { local: ['md5 ' + hex(1)], remote: [FB], got: true }, { local: [FA, FA, FA, FA, FA], remote: [FB], got: true },
  { local: [FA + '\n'], remote: [FB], got: true }]) {
  assert.equal(F.parseFingerprintMessage(bad), null, `malformed ${JSON.stringify(bad)?.slice(0, 50)}`);
}
console.log('PASS malformed fingerprint messages are ignored');

// 4
function harness({ mine = A, readFails = 0 } = {}) {
  const timers = [];
  let t = 0;
  const h = { sent: [], verified: 0, failed: [], reads: 0 };
  const clock = {
    setTimeout: (fn, ms) => { const x = { at: t + ms, fn, live: true }; timers.push(x); return x; },
    clearTimeout: (x) => { if (x) x.live = false; },
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  h.advance = async (ms) => {
    const end = t + ms;
    await settle();
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false; t = next.at; next.fn();
      await settle();                                   // 計時器裡的 async（重讀指紋）跑完、排好下一個
    }
    t = end;
    await settle();
  };
  h.check = F.createFingerprintCheck({
    read: async () => { h.reads++; return h.reads <= readFails ? null : mine; },
    send: (fp, got) => h.sent.push({ ...fp, got }),
    onVerified: () => { h.verified++; },
    onFail: (r) => { h.failed.push(r); },
    timeoutMs: 30_000, resendMs: 5_000, readTries: 3, readIntervalMs: 300, timers: clock,
  });
  return h;
}
let h = harness();
h.check.receive({ ...B, got: false });                   // 對方先驗完、先送
assert.equal(h.sent.length, 0, 'nothing sent before ICE connected');
h.check.start();
await h.advance(0);
assert.equal(h.verified, 1, 'his early message is checked as soon as mine is read');
assert.deepEqual(h.sent.map((x) => x.got), [false, true], 'I send mine, then answer his (got:true) because he had not seen mine yet');
assert.equal(h.check.state, 'verified');
h.check.receive({ ...B, got: true });
await h.advance(60_000);
assert.equal(h.verified, 1, 'verified once');
assert.equal(h.sent.length, 2, 'no more resends once he says he got mine');
assert.deepEqual(h.failed, [], 'and no timeout after verification');
console.log('PASS matching fingerprints verify once; early arrivals wait; answers until the peer has mine');

h = harness();
h.check.start();
await h.advance(0);
await h.advance(12_000);
assert.ok(h.sent.length >= 3, `resent every 5 s until the peer answers (${h.sent.length})`);
h.check.receive({ local: [FM2], remote: [FA], got: true });   // 對方那條腿接的是中間人
await h.advance(0);
assert.deepEqual(h.failed, ['mismatch'], 'a mismatch fails the check');
assert.equal(h.verified, 0);
const sentAt = h.sent.length;
await h.advance(60_000);
assert.equal(h.sent.length, sentAt, 'nothing more is sent after a failure');
h.check.receive({ ...B, got: true });
assert.equal(h.verified, 0, 'and a later (genuine-looking) message cannot revive it');
console.log('PASS a mismatch fails the check for good');

h = harness();
h.check.start();
await h.advance(29_999);
assert.deepEqual(h.failed, [], 'not before the timeout');
await h.advance(2);
assert.deepEqual(h.failed, ['timeout'], 'no fingerprint from the peer within 30 s → timeout');
h = harness({ readFails: 5 });
h.check.start();
await h.advance(2_000);
assert.deepEqual(h.failed, ['unreadable'], 'my own fingerprints unreadable after the retries → fail');
h = harness({ readFails: 2 });
h.check.start();
await h.advance(1_000);
h.check.receive({ ...B, got: true });
await h.advance(0);
assert.equal(h.verified, 1, 'a couple of empty reads (stats not ready yet) are retried');
h = harness();
h.check.start();
await h.advance(0);
h.check.stop();
h.check.receive({ ...B, got: false });
await h.advance(60_000);
assert.equal(h.verified + h.failed.length, 0, 'after stop() nothing happens');
assert.equal(h.sent.length, 1, 'and nothing is resent');
console.log('PASS timeout, unreadable fingerprints, retries and stop()');

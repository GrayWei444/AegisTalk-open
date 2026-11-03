/**
 * 不認得的人的 offer 先收著，名冊／好友一更新就處理（對應群星 64f3d211，多人模擬 S3）：真的 webrtc.ts，stub 掉 mqtt。
 *   App 重開時 broker 一口氣補送離線期間的訊息：「D 加入群組」（群組頻道）與 D 的 offer（收件匣）幾乎同時到，
 *   名冊事件的 listener 要等畫面掛上才註冊、事後才重播 → offer 先到就被當成陌生人丟掉，D 的待送永遠等不到連線。
 *   成員檢查一直開著（W1 拿掉了 groupEnforcement 開關）：
 *   - 不認得 → 不建連線、不回 answer，但 offer 與之後（以及等閘門期間先到）的 ICE 收著
 *   - 期限內變成認得的（名冊更新）→ 照常處理，收著的 ICE 接著補上；不用等呼叫，0.5 秒內自己會再判斷
 *   - 同一個人又送新的 offer → 用新的
 *   - 15 秒內還是不認得 → 丟掉；之後才認得也不會再處理那一則
 *   - 封鎖的人一律不收著、不處理；最多同時收 16 個人
 *   - 重送不延長收著的時間；過期丟掉的人 60 秒內再送也不收著（對應群星 81b7bb45：人頭不能一直佔位）
 *   以前「第一階段（開關關著）陌生人直接回 answer」那段不再測：那個模式已經不存在。
 * Run: node scripts/review/webrtc_held_offer_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENFORCED, enforcementPlugin } from './groupEnforcementFlags.mjs';
import { webrtcStub, dcBody, deliverDc } from './webrtcKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'rtchold-'));
// 開源第 4 步：信令是封好的 DIRECT_SEALED kind 'dc'（directSignal 驗過才交給 webrtc；webrtcKit 直接餵驗過的內容）
const stub = webrtcStub();
let parse = null;
globalThis.localStorage = { getItem: () => null };
globalThis.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = console.error;

async function load(flags) {
  const out = join(dir, `w-${flags.ENFORCE_GROUP_MEMBERSHIP}.mjs`);
  await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/webrtc.ts'], bundle: true, platform: 'node',
    format: 'esm', outfile: out, logLevel: 'silent', plugins: [stub, enforcementPlugin(flags)] });
  const { webrtcService: svc, parseDcSignal } = await import(pathToFileURL(out));
  parse = parseDcSignal;
  const built = [];
  const added = [];
  svc.createResponderConnection = async (pk, offer, pcId, _iat, early = []) => {
    built.push(`${pk}:${offer.sdp}`);
    const peer = { connection: { remoteDescription: { sdp: offer.sdp }, close() {}, addIceCandidate: async (c) => { added.push(`${pk}:${c.candidate}`); } },
      incomingCandidates: [], remotePcId: pcId, fp: { stop() {} } };
    svc.peers.set(pk, peer);
    for (const c of early) added.push(`${pk}:${c.candidate.candidate}`);
  };
  svc.startDcHeartbeat = () => {};
  svc.initialize('ME');
  return { svc, built, added };
}
const offer = (from, sdp = 'v1') => deliverDc(svc0(), parse, from, dcBody('offer', { type: 'offer', sdp }));
const ice = (from, c) => deliverDc(svc0(), parse, from, dcBody('ice', { candidate: c }));
let current = null;
const svc0 = () => current;

// ── 成員檢查打開 ──
console.error = () => {};
{
  const { svc, built, added } = await load(ENFORCED);
  current = svc;
  const known = new Set(['FRIEND']);
  // 好友清單從資料庫載入要一點時間（findFriendSettled）：isKnown 是非同步的
  svc.setInboundPolicy({ isBlocked: (pk) => pk === 'BLOCKED', isKnown: async (pk) => { await sleep(1); return known.has(pk); } });

  await offer('FRIEND');
  assert.deepEqual(built, ['FRIEND:v1'], 'known peers are answered at once');

  // D 的 offer 比「D 加入群組」早到；它的第一個 ICE 在等閘門時就到了
  const first = offer('DAVE', 'v1');
  await ice('DAVE', 'c0');
  await first;
  await ice('DAVE', 'c1');
  await offer('DAVE', 'v2');                 // 同一個人又送新的 offer（舊的連同它的 ICE 作廢）
  await ice('DAVE', 'c2');
  assert.equal(built.length, 1, 'an unknown peer is not answered');
  known.add('DAVE');                         // 名冊事件重播 → D 成了成員
  svc.recheckHeldOffers();
  await sleep(20);
  assert.deepEqual(built, ['FRIEND:v1', 'DAVE:v2'], 'once the roster knows him, his latest held offer is answered');
  assert.deepEqual(added, ['DAVE:c2'], 'and the ICE candidates held with it are added');
  console.log('PASS (enforced) an offer that arrives before the roster event is held, then answered once the peer is known');

  // 不用呼叫 recheck：0.5 秒內自己再判斷
  await offer('ERIN');
  known.add('ERIN');
  await sleep(800);
  assert.ok(built.includes('ERIN:v1'), 'held offers are re-checked on their own');
  console.log('PASS (enforced) held offers are re-checked periodically without an explicit nudge');

  // 15 秒內還是陌生人 → 丟掉
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  await offer('STRANGER');
  skew += 16_000;
  svc.recheckHeldOffers();
  known.add('STRANGER');
  svc.recheckHeldOffers();
  await sleep(20);
  assert.ok(!built.some((b) => b.startsWith('STRANGER')), 'a stranger\'s offer is dropped after 15 s and never answered');
  await ice('STRANGER', 'late');
  assert.ok(!added.some((a) => a.startsWith('STRANGER')), 'and his later ICE is ignored');
  Date.now = realNow;
  console.log('PASS (enforced) strangers are still never answered: their offer is dropped after 15 s');

  // 封鎖的人：不收著
  await offer('BLOCKED');
  known.add('BLOCKED');
  svc.recheckHeldOffers();
  await sleep(20);
  assert.ok(!built.some((b) => b.startsWith('BLOCKED')), 'a blocked contact is never held nor answered');

  // 收著期間本機自己先建了連線（名冊多了人就主動連）：放行時走既有連線，收著的 ICE 也要補進去
  globalThis.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
  await offer('PAT', 'p1');
  await ice('PAT', 'pc1');
  await ice('PAT', 'pc2');
  const conn = { connectionState: 'connected', iceConnectionState: 'connected', signalingState: 'stable', remoteDescription: null,
    setRemoteDescription: async (d) => { conn.remoteDescription = d; }, createAnswer: async () => ({ type: 'answer', sdp: 'a' }),
    setLocalDescription: async () => {}, addIceCandidate: async (c) => { added.push(`PAT:${c.candidate}`); }, close() {} };
  svc.peers.set('PAT', { connection: conn, dataChannel: null, connectionState: 'connected', incomingCandidates: [], localPcId: 'pc-local-pat', fp: { stop() {} } });
  known.add('PAT');
  svc.recheckHeldOffers();
  await sleep(30);
  assert.equal(conn.remoteDescription?.sdp, 'p1', 'the held offer is answered on the connection that already exists');
  assert.deepEqual(added.filter((a) => a.startsWith('PAT')), ['PAT:pc1', 'PAT:pc2'], 'and the ICE held with it is added to that connection');
  console.log('PASS (enforced) a held offer released onto an existing local connection keeps its ICE candidates');

  // 最多收 16 個
  for (let i = 0; i < 20; i++) await offer(`X${i}`);
  for (let i = 0; i < 20; i++) known.add(`X${i}`);
  svc.recheckHeldOffers();
  await sleep(30);
  assert.equal(built.filter((b) => b.startsWith('X')).length, 16, 'at most 16 unknown peers are held');
  console.log('PASS (enforced) blocked contacts are not held; the hold list is bounded (16 peers)');
  svc.shutdown();

  // 人頭佔位（對應群星 81b7bb45，審查 LOW）：16 個陌生人每 10 秒重送 offer。以前每次重送都把 15 秒重新算，
  //   16 個位子永遠被佔著，新成員 NEWBIE 的 offer（名冊事件晚 1 秒到）連收都收不進來。
  //   現在：重送不延長（從第一次收著算 15 秒）；過期丟掉後同一個人 60 秒內再送也不收著
  svc.initialize('ME2');
  svc.setInboundPolicy({ isBlocked: () => false, isKnown: async (pk) => known.has(pk) });
  const realNow2 = Date.now;
  let skew2 = 0;
  Date.now = () => realNow2() + skew2;
  for (let t = 0; t <= 40_000; t += 10_000) {
    skew2 = t;
    for (let i = 0; i < 16; i++) await offer(`SYBIL${i}`, 'v' + t);
    svc.recheckHeldOffers();
    if (t === 30_000) await offer('NEWBIE', 'legit');
  }
  known.add('NEWBIE');
  skew2 += 1000;
  svc.recheckHeldOffers();
  await sleep(20);
  const sybilsHeld = [...svc.heldOffers.keys()].filter((k) => k.startsWith('SYBIL')).length;
  console.log(`  after 40 s of re-offers: ${sybilsHeld} sybils held, NEWBIE answered: ${built.some((b) => b === 'NEWBIE:legit')}`);
  assert.ok(built.includes('NEWBIE:legit'), 'a real new member still gets a slot and is answered once the roster knows him');
  assert.ok(sybilsHeld < 16, 're-offering does not keep a slot forever');
  assert.ok(!built.some((b) => b.startsWith('SYBIL')), 'strangers are still never answered');
  skew2 += 61_000;
  await offer('SYBIL0', 'late');
  assert.equal(svc.heldOffers.has('SYBIL0'), true, 'after the cooldown a stranger can be held again (it might be a member whose roster event is slow)');
  Date.now = realNow2;
  console.log('PASS (enforced) re-offers do not extend a held slot and a dropped stranger is not held again for 60 s');
  svc.shutdown();
}

console.error = quiet;
process.exit(0);

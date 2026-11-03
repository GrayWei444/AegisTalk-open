/**
 * 陌生人不能對我發 WebRTC offer、也不能讓我響鈴（稽核 M5／M17，對應 AegisPlay B39 webrtc_inbound_gate_self_test）：
 *   真的 webrtc.ts（stub 掉 mqtt／iceServers），加上抽出 voiceCall 的來電處理執行。
 *   以前任何拿到公鑰的人送一則 WEBRTC_OFFER 就能跟我建直連 —— 看得到我的 LAN／公網 IP、能往 DataChannel 灌資料
 *   （檔案 early-chunk buffer 30 秒不設上限）；CALL_REQUEST 也不看是不是好友，照樣跳來電畫面。
 *   現在：我自己連過去的 peer、或 inboundPolicy（AppProvider／useWebRTC 注入：好友或同群成員）才回 answer，
 *   其餘靜默丟掉；來電只接好友的。
 *   第一階段（groupEnforcement 開關關著）：封鎖的人照擋；陌生人跟正式版一樣回 answer／照響，只記
 *   `[GROUP-CHECK] would block`。兩種開關都測。
 * Run: node scripts/review/webrtc_inbound_gate_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { MODES, enforcementPlugin, flagContext, reasons } from './groupEnforcementFlags.mjs';
import { webrtcStub, dcBody, deliverDc } from './webrtcKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build, transformSync } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'rtcgate-'));
// 開源第 4 步：offer 是封好的 DIRECT_SEALED kind 'dc'（directSignal 驗過寄件人才交給 webrtc；webrtcKit 直接餵驗過的內容）
const stub = webrtcStub();
globalThis.localStorage = { getItem: () => null };
const tick = () => new Promise((r) => setTimeout(r, 0));
const realError = console.error;
for (const [mode, flags] of MODES) {
  const out = join(dir, `w-${flags.ENFORCE_GROUP_MEMBERSHIP}.mjs`);
  await build({ entryPoints: [root + 'packages/pwa/src/services/webrtc.ts'], bundle: true, platform: 'node',
    format: 'esm', outfile: out, logLevel: 'silent', plugins: [stub, enforcementPlugin(flags)] });
  const { webrtcService: svc, parseDcSignal } = await import(pathToFileURL(out));
  const built = []; const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  svc.createResponderConnection = async (pk) => { built.push(pk); };
  svc.startDcHeartbeat = () => {};
  svc.initialize('ME');
  const offer = async (from) => { await deliverDc(svc, parseDcSignal, from, dcBody('offer', { type: 'offer', sdp: 'x' })); await tick(); };

  await offer('STRANGER');
  assert.deepEqual(built, [], `${mode}: offers ignored until the app installs a policy (useWebRTC does it right after initialize)`);
  assert.equal(typeof svc.setInboundPolicy, 'function', 'webrtcService.setInboundPolicy exists');
  svc.setInboundPolicy({ isBlocked: (pk) => pk === 'BLOCKED', isKnown: async (pk) => pk === 'FRIEND' || pk === 'GROUPMATE' });
  for (const pk of ['FRIEND', 'GROUPMATE', 'STRANGER', 'BLOCKED']) await offer(pk);
  const gateLog = lines.filter((l) => l.startsWith('[GROUP-CHECK]'));
  if (flags.ENFORCE_GROUP_MEMBERSHIP) {
    assert.deepEqual(built, ['FRIEND', 'GROUPMATE'], `${mode}: friends and group members accepted, stranger and blocked ignored`);
    assert.deepEqual(gateLog, [], `${mode}: nothing logged as "would block"`);
  } else {
    assert.deepEqual(built, ['FRIEND', 'GROUPMATE', 'STRANGER'], `${mode}: like production, a stranger (e.g. a group member missing from my roster) is answered; blocked still ignored`);
    assert.deepEqual(gateLog, ['[GROUP-CHECK] would block: webrtc-offer-from-stranger peer=STRANGER'], `${mode}: and logged once`);
  }
  built.length = 0;
  svc.setInboundPolicy({ isBlocked: () => { throw new Error('store not ready'); }, isKnown: () => true });
  await offer('FRIEND');
  assert.deepEqual(built, [], `${mode}: a throwing block check denies`);
  svc.setInboundPolicy({ isBlocked: () => false, isKnown: () => { throw new Error('store not ready'); } });
  await offer('FRIEND');
  assert.deepEqual(built, flags.ENFORCE_GROUP_MEMBERSHIP ? [] : ['FRIEND'],
    `${mode}: a throwing membership lookup ${flags.ENFORCE_GROUP_MEMBERSHIP ? 'denies' : 'only affects the log'}`);
  console.error = realError;
}
console.log('PASS strangers cannot open WebRTC to me (enforced) / are only logged (stage 1); blocked contacts always refused');

// useWebRTC 真的有注入「好友或同群成員」的 policy
const hook = readFileSync(root + 'packages/pwa/src/hooks/useWebRTC.ts', 'utf8');
assert.match(hook, /webrtcService\.setInboundPolicy\(/, 'useWebRTC installs the inbound policy');
assert.match(hook, /getFriendByPublicKey\(pk\)/, 'policy admits friends');
assert.match(hook, /groups\.some\(\(g\) => g\.members\.some\(\(m\) => m\.publicKey === pk\)\)/, 'policy admits group members (group fan-out is per-member P2P)');
console.log('PASS useWebRTC admits friends and group members');

// ── 來電只接好友的 ──
const vc = readFileSync(root + 'packages/pwa/src/services/voiceCall.ts', 'utf8');
const s = vc.indexOf('handleCallRequest(callerId: string, s: CallSignal, iat: number)'); const e = vc.indexOf('/**\n   * 處理通話接受', s);
const callCode = transformSync(`globalThis.__call = ${/private async handleCallRequest/.test(vc) ? 'async ' : ''}function ` + vc.slice(s, e).trimEnd(), { loader: 'ts' }).code;
async function ring(from, flags) {
  const rang = []; const logs = [];
  let current = null;
  const self = { callState: 'idle', currentCall: null, notifyStateChange() {}, incomingCallListeners: [(pk) => rang.push(pk)], rejectCall() {},
    guard: { current: () => current, begin: (role, peer, callId) => { current = { role, peer, callId }; } }, count() {}, sendSignal() {} };
  const ctx = {
    globalThis: {}, console: { error() {}, log() {} }, devLog() {}, devWarn() {}, Promise,
    CallState: { IDLE: 'idle', INCOMING: 'incoming' }, setTimeout: () => 0,
    mqttService: { serverNow: () => Date.now() }, CALL_REQUEST_MAX_AGE_MS: 35_000,
    isBlacklisted: async () => false,
    useChatStore: { getState: () => ({ getFriendByPublicKey: (pk) => (pk === 'FRIEND' ? { publicKey: pk } : undefined) }) },
    findFriendSettled: async (pk) => (pk === 'FRIEND' ? { publicKey: pk } : undefined),
    ...flagContext(flags, logs),
  };
  runInNewContext(callCode, ctx);
  await ctx.globalThis.__call.call(self, from, { sig: 'request', callId: 'C'.repeat(22), seq: 1 }, Date.now());
  await tick();
  return { rang, logged: reasons(logs) };
}
for (const [mode, flags] of MODES) {
  assert.deepEqual(await ring('FRIEND', flags), { rang: ['FRIEND'], logged: [] }, `${mode}: a friend can call`);
  assert.deepEqual(await ring('STRANGER', flags), flags.ENFORCE_GROUP_MEMBERSHIP
    ? { rang: [], logged: [] } : { rang: ['STRANGER'], logged: ['call-from-non-friend'] },
  `${mode}: a stranger ${flags.ENFORCE_GROUP_MEMBERSHIP ? 'cannot make my phone ring' : 'rings like production and is logged'}`);
}
console.log('PASS calls ring only for friends (enforced) / non-friends only logged (stage 1)');
process.exit(0);

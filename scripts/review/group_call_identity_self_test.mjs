/**
 * 群組通話只採信驗過的寄件人、且必須是群組成員（稽核 M17 相關，對應群星 P2-10）：真的 groupCallService.ts。
 *   以前 handler 用 payload 裡的 initiatorId／fromId／participantId，不檢查成員：
 *   任何人在知道 groupId 的群組主題發 GROUP_CALL_START 就能偽造「X 發起群組通話」；
 *   知道通話正在進行的人用自己的 key 發 GROUP_CALL_OFFER 就能加入媒體。
 * W2（docs/GROUP_LOG_WIRING_W2.md）：七種明文的 group_call_* 型別拿掉了。
 *   - start／join／leave／end 走群組主題上的 group_sealed（engine.sendControl('call', { action, video })；收端由引擎驗過
 *     寄件人、交給 handleControl(gid, from, body)）—— 群名、自稱的 id 都不送
 *   - offer／answer／ICE 走封給對方身分金鑰的信封（sendGroupSealed kind call，transient；收端 handleSignal(from, body)）
 *   這裡驗：發話者一律是驗過的寄件人、而且是本機名冊上的成員；封鎖的成員不響；別人不能把別人踢出通話；舊的、別的群的信令不理；
 *   送出去的只有密封的這兩種（沒有任何 mqtt 明文送出）。完整的引擎那一段（只用目前這一代、名冊外不解密）見 group_control_w2_self_test。
 * Run: node scripts/review/group_call_identity_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'gcallid-'));
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
globalThis.__group = { id: 'g1', name: '本機群名', members: [{ publicKey: 'zME' }, { publicKey: 'alice' }, { publicKey: 'bob' }] };
globalThis.__controls = [];
globalThis.__signals = [];
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/iceServers$|utils\/devLog$|^\.\.\/types$|stores\/groupStore$|^\.\/localBlacklist$|^\.\/groupEngineHost$|^\.\/groupKeyDelivery$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === './mqtt' ? 'throw new Error("groupCallService must not use plaintext MQTT any more");'
    : a.path.includes('iceServers') ? 'export function getIceServers(){ return [] }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('groupStore') ? 'export const useGroupStore = { getState: () => ({ getGroupById: (id) => id === globalThis.__group.id ? globalThis.__group : undefined }) };'
    : a.path.includes('localBlacklist') ? 'export async function isBlacklisted(pk) { if (pk === "broken") throw new Error("db"); return (globalThis.__blocked ?? []).includes(pk); }'
    : a.path.includes('groupEngineHost') ? 'export const getGroupEngine = () => ({ sendControl: async (gid, t, body) => { globalThis.__controls.push({ gid, t, body }); return "sent"; } });'
    : a.path.includes('groupKeyDelivery') ? 'export async function sendGroupSealed(to, body, opts) { globalThis.__signals.push({ to, body, opts }); return true; }'
    : 'export const GROUP_CONSTANTS = { MAX_CALL_MEMBERS: 8 };' }));
} };
globalThis.RTCSessionDescription = class { constructor(x) { Object.assign(this, x); } };
globalThis.RTCIceCandidate = class { constructor(x) { Object.assign(this, x); } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }) } } });
const out = join(dir, 'c.mjs');
await require('esbuild').build({ entryPoints: [SRC + '/services/groupCallService.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', plugins: [stub] });
const { groupCallService: svc } = await import(pathToFileURL(out));
const src = readFileSync(SRC + '/services/groupCallService.ts', 'utf8');
assert.ok(!/from '\.\/mqtt'/.test(src) && !/GROUP_CALL_/.test(src.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, '')), 'no plaintext group call types left in the service');
svc.initialize('zME');
let nonceSeq = 0;
const sig = (signal, data, over = {}) => ({ kind: 'call', gid: 'g1', signal, data, iat: Date.now(), nonce: `nonce-${++nonceSeq}-xxxxxxxxxxxx`, ...over });
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── 來電：發話者是驗過的寄件人、要是成員；群名用本機的 ──
const incoming = [];
svc.onIncomingCall((groupId, name, initiator, video) => incoming.push({ groupId, name, initiator, video }));
svc.handleControl('g1', 'mallory', { action: 'start', video: false });
await tick();
assert.equal(incoming.length, 0, 'a non-member cannot ring the group');
svc.handleControl('g1', 'alice', { action: 'start', video: true, groupName: '假群名', initiatorId: 'bob' });
await tick();
assert.deepEqual(incoming, [{ groupId: 'g1', name: '本機群名', initiator: 'alice', video: true }], 'the initiator is the verified sender; the group name comes from my roster');
svc.handleControl('g2', 'alice', { action: 'start', video: false });
await tick();
assert.equal(incoming.length, 1, 'a group that is not on this device does not ring');
console.log('PASS incoming group calls: verified sender; non-members ignored');

// 我封鎖的成員發起群組通話不響（部署前審查 LOW；一對一來電早就擋了）
globalThis.__blocked = ['bob'];
incoming.length = 0;
svc.handleControl('g1', 'bob', { action: 'start', video: false });
await tick();
assert.equal(incoming.length, 0, 'a group call started by a member I blocked does not ring');
globalThis.__blocked = [];
svc.handleControl('g1', 'bob', { action: 'start', video: false });
await tick();
assert.equal(incoming.length, 1, 'control: unblocked members still ring');
console.log('PASS a blocked member\'s group call does not ring');

// ── 送出去的：call 控制訊息與密封的信令，沒有明文 ──
await svc.startGroupCall('g1', '本機群名', ['alice', 'bob'], false);
assert.deepEqual(globalThis.__controls, [{ gid: 'g1', t: 'call', body: { action: 'start', video: false } }], 'start goes out as a sealed group control message (no group name, no ids)');
svc.createPeerConnection = () => ({ addTrack() {}, async setRemoteDescription() {}, async addIceCandidate() {},
  async createOffer() { return { type: 'offer', sdp: 'o' }; }, async createAnswer() { return { type: 'answer', sdp: 'a' }; },
  async setLocalDescription() {}, close() {} });
svc.handleControl('g1', 'alice', { action: 'join', video: false });
await tick();
assert.deepEqual(globalThis.__signals.map((x) => [x.to, x.body.kind, x.body.signal, x.body.gid, x.opts?.transient]), [['alice', 'call', 'offer', 'g1', true]],
  'a member joining gets an offer sealed to their identity, transient (the member already in the call offers; step 5d)');
assert.deepEqual(globalThis.__signals[0].body.data, { type: 'offer', sdp: 'o' });
svc.handleControl('g1', 'mallory', { action: 'join', video: false });
await tick();
assert.ok(!svc.participants.has('mallory'), 'a non-member joining is ignored');
console.log('PASS outgoing: start/join/leave/end as group_sealed call controls, offer/answer/ICE sealed to the peer; nothing in plaintext');

// ── 通話中：只有成員的信令有效，用的是驗過的寄件人 ──
svc.participants.clear(); svc.currentCall.participants.clear(); globalThis.__signals.length = 0;
svc.localStream = { getTracks: () => [] };
svc.handleSignal('mallory', sig('offer', { type: 'offer', sdp: 'o' }));
svc.handleSignal('mallory', sig('offer', { type: 'offer', sdp: 'o' }, { fromId: 'bob' }));
await tick();
assert.deepEqual([...svc.participants.keys()], [], 'a non-member cannot join the media, even claiming a member id');
svc.handleSignal('bob', sig('offer', { type: 'offer', sdp: 'o' }, { iat: Date.now() - 3 * 60_000 }));
svc.handleSignal('bob', sig('offer', { type: 'offer', sdp: 'o' }, { gid: 'g2' }));
svc.handleSignal('bob', sig('hijack', { type: 'offer', sdp: 'o' }));
svc.handleSignal('bob', sig('offer', { type: 'offer', sdp: 'x'.repeat(40_000) }));
await tick();
assert.deepEqual([...svc.participants.keys()], [], 'stale, other-group, unknown and oversized signals are ignored');
// 審查 W2 #1：寄件人的時鐘慢了 150 秒（伺服器時間＝他的 iat）—— 用伺服器時間（App 傳進來的 now）判斷照樣收；用本機時間就會當成過期
const serverNow = () => Date.now() - 150_000;
const skewed = sig('offer', { type: 'offer', sdp: 'o' }, { iat: serverNow() });
svc.handleSignal('bob', { ...skewed, nonce: 'skew-local-xxxxxxxxxx' });
await tick();
assert.ok(!svc.participants.has('bob'), 'control: judged on a clock 150 s off, the signal looks stale');
svc.handleSignal('bob', skewed, serverNow());
await tick();
assert.ok(svc.participants.has('bob'), 'a member still joins (judged on the server-corrected clock the app passes in)');
assert.deepEqual(globalThis.__signals.map((x) => [x.to, x.body.signal]), [['bob', 'answer']], 'the answer is sealed back to that member');
// 審查 W2 #3：同一封信令重放 → 不再處理（不會再回一次 answer）
svc.handleSignal('bob', skewed, serverNow());
await tick();
assert.equal(globalThis.__signals.length, 1, 'a replayed signal is ignored');
svc.handleSignal('bob', { ...sig('offer', { type: 'offer', sdp: 'o' }), nonce: undefined });
await tick();
assert.equal(globalThis.__signals.length, 1, 'a signal without a nonce is ignored');
svc.handleSignal('mallory', sig('ice', { candidate: 'c' }, { fromId: 'bob' }));
await tick();
assert.equal(svc.pendingIceCandidates.size, 0, 'ICE from a non-member is never filed under the member it names');
svc.removeParticipant = (id) => { svc.participants.delete(id); };
svc.handleControl('g1', 'alice', { action: 'leave', video: false, participantId: 'bob' });
await tick();
assert.ok(svc.participants.has('bob'), 'a member cannot remove someone else from the call');
svc.handleControl('g1', 'bob', { action: 'leave', video: false });
await tick();
assert.ok(!svc.participants.has('bob'), 'a member can leave themselves');
console.log('PASS in-call offers/ICE/leave use the verified sender and require membership; stale or foreign signals ignored');
// App 接線：拆開的 call 信封交給 handleSignal（不進引擎）；引擎驗過的 call 控制訊息交給 handleControl
const provider = readFileSync(SRC + '/providers/AppProvider.tsx', 'utf8');
const sealedHandler = provider.slice(provider.indexOf('mqtt.subscribe(MessageType.GROUP_KEY_SEALED'));
assert.ok(/if \(opened\.kind === 'call'\) \{\s*groupCallService\.handleSignal\(opened\.from, opened\.body, mqttService\.boundedNow\(\)\);\s*return;\s*\}/.test(sealedHandler)
  && sealedHandler.indexOf('groupCallService.handleSignal(') < sealedHandler.indexOf('engine.onSealed('), 'sealed call signals go to the call service, after the blocked/stranger checks');
assert.ok(sealedHandler.indexOf('isBlacklisted(message.from)') < sealedHandler.indexOf('groupCallService.handleSignal('), 'blocked senders are dropped before');
assert.ok(/onCall: \(g, f, b\) => groupCallService\.handleControl\(g, f, b\)/.test(provider), 'verified call controls go to handleControl');
console.log('PASS wiring: sealed call signals → handleSignal; verified call controls → handleControl');
svc.endCall();
assert.deepEqual(globalThis.__controls.at(-1), { gid: 'g1', t: 'call', body: { action: 'end', video: false } }, 'end goes out as a call control too');
process.exit(0);   // 通話計時器、結束畫面的 2 秒延遲不必等

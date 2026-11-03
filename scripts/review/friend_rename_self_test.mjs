/**
 * 已經是好友的人改了名字，我這邊要跟著改（移植群星 2026-09-08）：真的 AppProvider X3DH_INIT handler＋真的 x3dhReplay.ts
 * ＋真的 cleanPeerName。
 *   以前只有舊名字「看起來像預設值」（Friend／User／好友／用戶 開頭）才更新 —— 好友改了暱稱，我這邊永遠是舊名字。
 *   短碼重加時他只送一封 INIT（我收不到他的 PROFILE_UPDATE），INIT 是唯一的來源。
 *   開源第 4 步：名字不再是 INIT 明文的 senderName（broker 看得到、誰都能填），在封給我身分金鑰、他簽名的 via 裡 ——
 *   handler 用 viaName 拆（真的拆封在 friend_add_confirm／friend_invites 測；這裡 stub 成「via 裡寫什麼就是什麼」）。
 *   明文的 senderName 一律不採用。
 *   1. 一般名字的好友送新名字來 → 改
 *   2. 名字照新加好友的規則清理（控制字元、<>、40 字）；空的、跟現在一樣的 → 不動
 *   3. 同一封 INIT 重到（已接受過）→ 不改：那是當時的名字，可能已被之後的 PROFILE_UPDATE 改過
 * Run: node scripts/review/friend_rename_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { cleanPeerName } from './providerScope.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'rename-'));

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/services/x3dhReplay.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const replay = await import(pathToFileURL(join(dir, 'r.mjs')));

const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const head = 'mqtt.subscribe(MessageType.X3DH_INIT, ';
const start = provider.indexOf(head) + head.length;
const end = provider.indexOf('\n    });\n\n    return () => {', start);
assert.ok(start > head.length && end > start, 'found the X3DH_INIT handler');
const code = esbuild.transformSync(`module.exports = (${provider.slice(start, end + 6)});`,
  { loader: 'tsx', format: 'cjs', supported: { 'dynamic-import': false } }).code;
const ME = 'Z'.repeat(44), F = 'F'.repeat(44);
const friend = { name: 'Alice', trustLevel: 'unverified' };
const renames = [];
const mod = { exports: {} };
runInNewContext(code, {
  module: mod, exports: mod.exports, console: { log() {}, error() {} }, Date, JSON, localStorage: globalThis.localStorage,
  require: (n) => { if (n === '../services/p2pSend') return { flushQueueForPeer() {} }; throw Error(n); },
  publicKey: ME, signedPreKey: { publicKeyBase64: 'spk', signatureBase64: 'sig' },
  getFriendByPublicKey: (pk) => (pk === F ? friend : undefined),
  findFriendSettled: async (pk) => (pk === F ? { ...friend } : undefined),
  updateFriendProfile: (pk, p) => { renames.push(p.displayName); if (pk === F && p.displayName) friend.name = p.displayName; },
  addFriend() {}, cleanPeerName, fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, recentlyInitiatedTo: () => false,
  // 開源第 5b 步：既有好友的 INIT 要有他身分金鑰的簽章（services/x3dhInitAuth，x3dh_init_auth_self_test 用真的簽章測那一關）；
  //   這裡的好友不是真的金鑰 —— 他的 INIT 當作簽章正確，測的是後面的行為
  verifyInitAuth: () => 'ok', identityVerify: () => true, initResetBudget: { take: () => true },
  mqttService: { sendToUser() {}, serverNow: () => Date.now(), boundedNow: () => Date.now() }, MessageType: { PREKEY_REQUEST: 'p', PROFILE_UPDATE: 'u' },
  sendProfileUpdate: async () => true, sendPrekeyRequest: async () => true,
  viaName: async (_me, from, via) => (from === F && via && typeof via.name === 'string' && via.name ? via.name : null),
  acceptedVia: async () => null,   // 不是對得上的邀請（重加的信任升級在 friend_strict_accept 測）
  clearPeerSession: async () => {}, deletePendingMessagesForRecipient: async () => {},
  webrtcService: { disconnect() {} },
  acceptSession() {}, flushSessionWrites: async () => {}, hasSessionWith: () => true,
  wasInitAccepted: replay.wasInitAccepted, rememberAcceptedInit: replay.rememberAcceptedInit, isInitOlderThanAccepted: replay.isInitOlderThanAccepted,
  getServiceTranslation: () => (k) => k, useChatStore: { getState: () => ({ userProfile: {} }) },
  usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  friendViaSealer: { seal: async () => { throw new Error('no identity in this test'); }, open: async () => { throw new Error('no identity in this test'); } },
});
const handle = mod.exports;
let n = 0;
const eph = () => Buffer.alloc(32, ++n).toString('base64');
const init = (e, name) => handle({ from: F, payload: { ephemeralPublicKey: e, sessionReset: true, ...(name !== undefined ? { via: { name } } : {}) } });

// 0（開源第 4 步）：明文的 senderName 不算數
await handle({ from: F, payload: { ephemeralPublicKey: eph(), sessionReset: true, senderName: 'Mallory' } });
assert.equal(friend.name, 'Alice', 'a plaintext senderName (no sealed via) does not rename');
console.log('PASS a plaintext name on the INIT is ignored (the name lives in the sealed via)');

// 1
await init(eph(), 'Alice Chen');
assert.equal(friend.name, 'Alice Chen', 'an existing friend with a normal name follows their rename');
console.log('PASS an existing friend who renamed shows the new name');

// 2
renames.length = 0;
await init(eph(), '  <Bob>\u0007' + 'x'.repeat(60));
assert.equal(friend.name, 'Bob' + 'x'.repeat(37), 'the new name is cleaned like a new friend name (no control chars or <>, 40 chars)');
const before = friend.name;
await init(eph(), '   ');
await init(eph(), undefined);
await init(eph(), before);
assert.equal(friend.name, before);
assert.equal(renames.length, 1, 'empty / missing / unchanged names do not touch the contact');
console.log('PASS the name is cleaned; empty or unchanged names leave the contact alone');

// 3
const E = eph();
await init(E, 'Carol');
assert.equal(friend.name, 'Carol');
friend.name = 'Carol (new)';                        // 之後的 PROFILE_UPDATE 改了名字
await init(E, 'Carol');                             // 同一封 INIT 重到
assert.equal(friend.name, 'Carol (new)', 'a redelivered INIT does not roll the name back');
console.log('PASS a redelivered INIT does not roll back a later rename');

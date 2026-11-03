/**
 * 重複的 X3DH_INIT 不再拆掉正常的 session（傳輸統一 X6）：真的 x3dhReplay.ts＋AppProvider 的 X3DH_INIT handler。
 *   加好友與自動修復送的 INIT 都帶 sessionReset：收端先清 session、outbox 密文、WebRTC 再 accept。
 *   同一封 INIT 再到一次（發送端 MQTT 離線佇列重送、broker QoS1 重投、App 被殺後重播）就會把剛建好的
 *   session 拆掉重建 → 對方下一則 aead → 又一輪修復。以前只靠 useCrypto 記憶體裡的 ephemeral 去重，
 *   而且 clearPeerSession 會先把那份紀錄清掉，判斷又在清除之後才跑。
 *   現在：清除之前先查這把 ephemeral 是否已接受過（存 localStorage，跨重啟有效）；
 *   但本機已經沒有 session 時照常處理（重新接受才救得回來）。
 * Run: node scripts/review/x3dh_replay_self_test.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'x3dhreplay-'));

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/services/x3dhReplay.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const replay = await import(pathToFileURL(join(dir, 'r.mjs')));

// ── 模組本身：帳號隔離、過期 ──
replay.rememberAcceptedInit('me', 'peer', 'E0');
assert.equal(replay.wasInitAccepted('me', 'peer', 'E0'), true);
assert.equal(replay.wasInitAccepted('other-account', 'peer', 'E0'), false, 'records are per account');
const raw = JSON.parse(store.get([...store.keys()][0]));
raw[0].at = Date.now() - 49 * 3600_000;
store.set([...store.keys()][0], JSON.stringify(raw));
assert.equal(replay.wasInitAccepted('me', 'peer', 'E0'), false, 'records expire after 48h (INIT freshness is 24h)');
console.log('PASS replay records are per account and expire');

// ── AppProvider 的 X3DH_INIT handler ──
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const head = 'mqtt.subscribe(MessageType.X3DH_INIT, ';
const start = provider.indexOf(head) + head.length;
const end = provider.indexOf('\n    });\n\n    return () => {', start);
assert.ok(start > head.length && end > start, 'found the X3DH_INIT handler');
const code = esbuild.transformSync(`module.exports = (${provider.slice(start, end + 6)});`,
  { loader: 'tsx', format: 'cjs', supported: { 'dynamic-import': false } }).code;   // import() → require()，vm 裡才跑得動
const ME = 'Z'.repeat(44), F = 'F'.repeat(44);
const calls = { clear: 0, accept: 0, disconnect: 0 };
let sessionExists = true;
const mod = { exports: {} };
runInNewContext(code, {
  module: mod, exports: mod.exports, console: { log() {}, error() {} }, Date, JSON, localStorage: globalThis.localStorage,
  require: (n) => { if (n === '../services/p2pSend') return { flushQueueForPeer() {} }; throw Error(n); },
  publicKey: ME, signedPreKey: { publicKeyBase64: 'spk', signatureBase64: 'sig' },
  getFriendByPublicKey: (pk) => (pk === F ? { name: 'F', trustLevel: 'unverified' } : undefined),
  findFriendSettled: async (pk) => (pk === F ? { name: 'F', trustLevel: 'unverified' } : undefined),
  updateFriendProfile() {}, addFriend() {}, cleanPeerName, fromBase64: (s) => Buffer.from(s, 'base64'), diagLog() {}, recentlyInitiatedTo: () => false,
  // 開源第 5b 步：既有好友的 INIT 要有他身分金鑰的簽章（services/x3dhInitAuth，x3dh_init_auth_self_test 用真的簽章測那一關）；
  //   這裡的好友不是真的金鑰 —— 他的 INIT 當作簽章正確，測的是後面的行為
  verifyInitAuth: () => 'ok', identityVerify: () => true, initResetBudget: { take: () => true },
  mqttService: { sendToUser() {}, serverNow: () => Date.now(), boundedNow: () => Date.now() }, MessageType: { PREKEY_REQUEST: 'p', PROFILE_UPDATE: 'u' },
  clearPeerSession: async () => { calls.clear++; }, deletePendingMessagesForRecipient: async () => {},
  webrtcService: { disconnect: () => { calls.disconnect++; } },
  acceptSession: () => { calls.accept++; sessionExists = true; }, flushSessionWrites: async () => {},
  hasSessionWith: () => sessionExists,
  wasInitAccepted: replay.wasInitAccepted, rememberAcceptedInit: replay.rememberAcceptedInit, isInitOlderThanAccepted: replay.isInitOlderThanAccepted,
  getServiceTranslation: () => (k) => k, useChatStore: { getState: () => ({ userProfile: {} }) },
  usePendingFriendStore: { getState: () => ({ markPending() {}, confirm: () => false, cancel() {} }) },
  friendViaSealer: { seal: async () => { throw new Error('no identity in this test'); }, open: async () => { throw new Error('no identity in this test'); } },
});
const handle = mod.exports;
/** 兩把不同的 32-byte ephemeral 公鑰（收端先檢查長度，審查 L2） */
const E1 = Buffer.alloc(32, 1).toString('base64'), E2 = Buffer.alloc(32, 2).toString('base64');
const init = (eph) => handle({ from: F, payload: { ephemeralPublicKey: eph, senderName: 'F', sessionReset: true } });

await init(E1);
assert.deepEqual(calls, { clear: 1, accept: 1, disconnect: 1 }, 'first INIT resets and accepts');
await init(E1);                                    // 重啟後同一封又到（紀錄在 localStorage）
assert.deepEqual(calls, { clear: 1, accept: 1, disconnect: 1 }, 'a redelivered INIT leaves the working session alone');
await init(E2);
assert.deepEqual(calls, { clear: 2, accept: 2, disconnect: 2 }, 'a new INIT (new ephemeral) still resets');
await init(E1);
assert.equal(calls.clear, 2, 'an older redelivery after a newer reset is also ignored');
sessionExists = false;
await init(E2);
assert.equal(calls.accept, 3, 'with no session left, a known INIT is processed again so the session can be rebuilt');
console.log('PASS duplicate X3DH_INIT ignored before the reset; new INIT and lost-session recovery still work');

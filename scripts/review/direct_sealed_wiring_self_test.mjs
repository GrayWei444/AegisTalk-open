/**
 * 開源第 4 步的接線（原始碼檢查；行為在 direct_seal／direct_signal／call_state_machine／webrtc_fingerprint_gate 測）：
 *   1. MQTT 的型別只剩 x3dh_init、direct_sealed、換機兩種、群組兩種 —— 明文的 1 對 1 信令型別一個都不在（收到的 validateMessage 直接丟）
 *   2. 每一個送到 broker 的地方只用這幾種；1 對 1 信令只經 directSignal（sendDirect）封好送
 *   3. X3DH_INIT 不帶名字（名字在封好的 via／個人資料裡）；收端不讀 INIT 的 senderName
 *   4. MQTT 訊息不帶推播提示（notificationHint／pushData）
 *   5. 收：AppProvider 開 startDirectSignal（存著的身分 ＝ 好友或同群成員，封鎖名單）；通話、DataChannel、個人資料、預備金鑰請求、
 *      刪除各自 onDirect；個人資料的名字經過 cleanPeerName、頭像有上限
 * Run: node scripts/review/direct_sealed_wiring_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const read = (p) => readFileSync(join(SRC, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|__tests__/.test(f)).map((f) => ({ f: relative(SRC, f), code: strip(readFileSync(f, 'utf8')) }));

// 1
const mqtt = strip(read('services/mqtt.ts'));
const enumBody = mqtt.slice(mqtt.indexOf('export enum MessageType {'), mqtt.indexOf('}', mqtt.indexOf('export enum MessageType {')));
const values = [...enumBody.matchAll(/=\s*'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
assert.deepEqual(values, ['device_transfer_data', 'device_transfer_request', 'direct_sealed', 'group_key_sealed', 'group_sealed', 'x3dh_init'],
  'only these message types are known (anything else is dropped on receipt)');
assert.match(mqtt, /const knownTypes = Object\.values\(MessageType\) as string\[\];\s*if \(!knownTypes\.includes\(msg\.type\)\) return false;/,
  'unknown types are dropped before any listener');
console.log('PASS the MQTT type table has no plaintext 1:1 signalling type left');

// 2
const LEGACY = /MessageType\.(WEBRTC_\w+|CALL_\w+|PROFILE_\w+|PREKEY_\w+|PRE_KEY_\w+|PUSH_SUBSCRIPTION\w*|DELETE_MESSAGE|TYPING|ENCRYPTED_MESSAGE)\b/;
const LEGACY_LITERAL = /type:\s*'(webrtc_offer|webrtc_answer|webrtc_ice_candidate|call_request|call_accept|call_reject|call_end|call_webrtc_\w+|profile_update|profile_request|prekey_request|prekey_bundle|push_subscription_update|delete_message)'/;
const allowedSend = new Set(['X3DH_INIT', 'DIRECT_SEALED', 'GROUP_KEY_SEALED', 'DEVICE_TRANSFER_REQUEST', 'DEVICE_TRANSFER_DATA']);
let sends = 0;
for (const { f, code } of files) {
  assert.ok(!LEGACY.test(code), `${f}: references a removed plaintext type`);
  assert.ok(!LEGACY_LITERAL.test(code), `${f}: builds a removed plaintext type by hand`);
  for (const m of code.matchAll(/\.(sendToUser|sendTransientToUser)\(\s*[^,]+,\s*([^,]+),/g)) {
    const t = m[2].trim();
    if (t === 'type') continue;                                    // 通用的包裝（型別限定 MessageType）
    const name = t.replace(/^MessageType\./, '');
    assert.ok(t.startsWith('MessageType.') && allowedSend.has(name), `${f}: sends ${t}`);
    sends++;
    if (name === 'DIRECT_SEALED') assert.equal(f, 'services/directSignal.ts', `${f}: sealed 1:1 signals go out only through directSignal.sendDirect`);
  }
}
assert.ok(sends >= 8, `found the send sites (${sends})`);
for (const [f, re] of [
  ['services/voiceCall.ts', /sendDirect\(peer, \{ kind: 'call', sig, callId, seq,/],
  ['services/webrtc.ts', /sendDirect\(remote, \{\s*kind: 'dc', sig, pc: fields\.pc,/],
]) assert.match(read(f), re, `${f}: signals are sealed (sendDirect)`);
console.log(`PASS every broker send uses an allowed type (${sends} sites); 1:1 signals only via sendDirect`);

// 3
const modal = strip(read('components/Verification/AddFriendModal.tsx'));
const initIface = modal.slice(modal.indexOf('interface X3DHInitPayload {'), modal.indexOf('}', modal.indexOf('interface X3DHInitPayload {')));
assert.ok(initIface.length > 0 && !/senderName|name/.test(initIface), 'X3DHInitPayload has no name field');
const litAt = modal.indexOf('const initPayload: X3DHInitPayload = {');
const initLit = modal.slice(litAt, modal.indexOf('};', litAt));
assert.ok(litAt > 0 && !/senderName|displayName|nickname/.test(initLit), 'the add-friend X3DH_INIT payload carries no name');
assert.match(modal, /makeVia\(invite, publicKey, ephemeralB64, peerData\.pk, friendViaSealer,\s*userProfile\.displayName/, 'the name goes into the sealed via');
const provider = strip(read('providers/AppProvider.tsx'));
let inits = 0;
for (const { f, code } of files) {
  // 開源第 5b 步：INIT 包在 withInitAuth(收件人, …) 裡（加寄件人身分金鑰的簽章，services/x3dhInitSend.ts）—— 看裡面那份 payload
  for (const m of code.matchAll(/sendToUser\([^,]+,\s*MessageType\.X3DH_INIT,\s*(?:withInitAuth\([^,]+,\s*)?(\{[\s\S]*?\}|\w+)\)?\);/g)) {
    inits++;
    assert.ok(!/senderName|displayName|nickname/.test(m[1]), `${f}: an X3DH_INIT carries a name: ${m[1].slice(0, 120)}`);
  }
}
assert.ok(inits >= 3, `found the X3DH_INIT sends (${inits})`);
const x3dhAt = provider.indexOf('mqtt.subscribe(MessageType.X3DH_INIT, async');
assert.ok(x3dhAt > 0, 'X3DH_INIT handler found');
const x3dhEnd = provider.indexOf("onDirect('prekey', ", x3dhAt);
assert.ok(x3dhEnd > x3dhAt, 'end of the X3DH_INIT handler found');
const x3dhHandler = provider.slice(x3dhAt, x3dhEnd);
assert.ok(!/senderName/.test(x3dhHandler), 'the X3DH_INIT handler does not read a plaintext senderName');
assert.match(x3dhHandler, /viaName\(/, 'a known friend\'s new name comes from the sealed via');
console.log(`PASS X3DH_INIT carries no name (${inits} send sites) and the receiver does not read one`);

// 4
const outMsg = mqtt.slice(mqtt.indexOf('\n  sendToUser('), mqtt.indexOf('\n  sendTransientToUser('));
assert.ok(outMsg.length > 200, 'sendToUser found');
assert.ok(!/notificationHint|pushData/.test(mqtt), 'mqtt.ts has no push hint at all');
assert.match(outMsg, /const message: MqttMessage = \{\s*type,\s*from: [^,]+,\s*to: [^,]+,\s*payload,\s*timestamp: [^,}]+,?\s*\}/,
  'the inbox message is exactly { type, from, to, payload, timestamp }');
console.log('PASS MQTT messages carry no push hint');

// 5
const start = provider.slice(provider.indexOf('startDirectSignal({'), provider.indexOf('startDirectSignal({') + 800);
assert.match(start, /storedIdentity: async \(pk\) => \{[\s\S]*getFriendByPublicKey\(pk\)[\s\S]*groups\.some\(\(g\) => g\.members\.some\(\(m\) => m\.publicKey === pk\)\)/,
  'stored identity = a friend or a member of one of my groups');
assert.match(start, /isBlocked: \(pk\) => isBlacklisted\(pk\)\.catch\(\(\) => true\)/, 'an unreadable block list counts as blocked (review L5)');
assert.match(start, /marks: localStorageMarks\(me\)/);
assert.match(read('services/voiceCall.ts'), /onDirect\('call', \(from, body\) => this\.handleSignal\(from, body\)\)/);
assert.match(read('services/webrtc.ts'), /onDirect\('dc', \(from, body\) => this\.handleDirect\(from, body\)\)/);
for (const k of ['prekey', 'delete', 'profile']) assert.match(provider, new RegExp(`onDirect\\('${k}', `), `AppProvider handles '${k}'`);
const prof = provider.slice(provider.indexOf("onDirect('profile', "), provider.indexOf("onDirect('profile', ") + 4000);
assert.match(prof, /cleanPeerName\(/, 'profile names are cleaned');
assert.match(prof, /400[_]?000/, 'avatar size is capped');
console.log('PASS receive side: startDirectSignal with stored identities and the block list; one handler per kind');

/**
 * 同一則 1 對 1 訊息收兩次不能變兩則（移植群星 B31）：對方沒等到回條會重送（每次重新加密，解得開），
 * outbox 也可能重送 —— 以前每一份都多一個氣泡、多算一次未讀、多做一次 L2 掃描（風險分數加兩次）、
 * 重存一次把已讀改回未讀。
 *   1. 真的 chatStore（stub 掉 zustand／storage）：同一個 id 收兩次 → 只有一則、未讀只加一次、只存一次
 *   2. AppProvider：解密後、L2 掃描之前先查「記憶體或資料庫裡已經有這個寄件者的這一則」→ 只回條、不掃描、不存
 * Run: node scripts/review/duplicate_receive_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extStubPlugin } from './extStub.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const esbuild = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'duprecv-'));
globalThis.__saved = [];
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^zustand$|services\/storage$|services\/database$|services\/directSignal$|secureId$|utils\/devLog$|cryptoSessionControl$|services\/webrtc$|pendingFriendStore$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'zustand' ? `export function create(fn) { let state; const subs = new Set();
      const set = (p) => { const prev = state; state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; for (const s of [...subs]) s(state, prev); };
      const get = () => state; state = fn(set, get); const hook = (sel) => (sel ? sel(state) : state);
      hook.getState = get; hook.setState = set; hook.subscribe = (l) => { subs.add(l); return () => subs.delete(l); }; return hook; }`
    : a.path.endsWith('storage') ? `export const isInitialized = () => true;
      export const getConversationIdForPeer = (pk) => 'conv-' + pk;
      export async function saveMessage(m) { globalThis.__saved.push(m.id); }`
    : a.path.endsWith('database') ? 'export async function run(){}'
    : a.path.endsWith('directSignal') ? 'export function broadcastProfileUpdate() {}'
    : a.path.includes('secureId') ? 'export const generateId = (p) => p + "-1";'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('cryptoSessionControl') ? 'export async function clearPeerSession(){}'
    : a.path.includes('pendingFriendStore') ? 'export const usePendingFriendStore = { getState: () => ({ forgetPeer() {} }) };'
    : 'export const webrtcService = { disconnect() {} };' }));
} };
await esbuild.build({ entryPoints: [root + 'packages/pwa/src/stores/chatStore.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'cs.mjs'), logLevel: 'silent', plugins: [stub, extStubPlugin()] });
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { useChatStore } = await import(pathToFileURL(join(dir, 'cs.mjs')));

// 1
const F = 'F'.repeat(43) + '=';
useChatStore.setState({ friends: [{ id: 'friend-F', publicKey: F, name: 'Fay', avatar: '', lastMessage: '', lastMessageTime: 0, unreadCount: 0, online: true, trustLevel: 'verified', addedAt: 1 }],
  messages: {}, currentFriendId: null, isLoaded: true });
const m = { id: 'msg-1', senderId: 'friend-F', content: 'hello', timestamp: 5, type: 'text', isRead: false, isBurned: false, encrypted: true };
await useChatStore.getState().receiveMessage('friend-F', m);
await useChatStore.getState().receiveMessage('friend-F', { ...m, content: 'hello (resent)' });
const s = useChatStore.getState();
assert.equal(s.messages['friend-F'].length, 1, 'the same message id shows once');
assert.equal(s.messages['friend-F'][0].content, 'hello', 'the first copy is kept');
assert.equal(s.friends[0].unreadCount, 1, 'unread is counted once');
assert.deepEqual(globalThis.__saved, ['msg-1'], 'stored once');
await useChatStore.getState().receiveMessage('friend-F', { ...m, id: 'msg-2' });
assert.equal(useChatStore.getState().messages['friend-F'].length, 2, 'a different id is a new message');
console.log('PASS chatStore keeps one copy of a message received twice');

// 2
const app = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const body = app.slice(app.indexOf('const processEncryptedMessage = async'), app.indexOf('processEncryptedMessageRef.current = processEncryptedMessage'));
const dup = body.indexOf('duplicate 1:1 message');
assert.ok(dup > 0, 'AppProvider checks for a duplicate 1:1 message');
const check = body.slice(body.lastIndexOf('if (', dup), dup);
assert.match(check, /messages\[friend\.id\][\s\S]*\.some\(\(m\) => m\.id === messageData\.id\)/, 'checks the in-memory conversation');
assert.match(check, /hasMessageFrom\(messageData\.id, senderPublicKeyBase64\)/, 'checks the database for this sender\'s copy (after an app restart)');
assert.match(body.slice(dup, dup + 300), /sendDirectReceipt\(senderPublicKeyBase64, messageData\.id\);\s*return;/, 'a duplicate is acknowledged again and dropped');
// L2 掃描（開源第 5a 步起是 ext.antiFraud.inspectInbound 的 'direct' 掃描點；官方版照舊掃、社群版不掃）
const afterVisible = body.indexOf('DIRECT_VISIBLE_TYPES');
const scanAt = body.slice(afterVisible).search(/ext\.antiFraud\.inspectInbound\(\{\s*site: 'direct'/);
assert.ok(afterVisible > 0 && scanAt > 0 && dup < afterVisible + scanAt, 'before the 1:1 L2 scan');
assert.ok(dup < body.indexOf('await receiveMessage(friend.id'), 'before storing');
console.log('PASS AppProvider drops a duplicate before L2 / storage and only re-acknowledges it');

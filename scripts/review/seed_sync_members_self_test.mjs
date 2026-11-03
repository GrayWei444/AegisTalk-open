/**
 * 群訊快取（seed_sync）只跟這個群「現在的成員」交換，結果只回給 DataChannel 的對方（成員變動輪換打開之後的審查）：
 *   抽出真的 AppProvider handleSeedSync 配 stub 執行。
 *   以前任何開得了 DataChannel 的人（例如某位成員的好友、被踢但還是好友的人）送 sync_accept 就拿得到群訊快取，
 *   requesterId 還能填別人 →「被踢的人拿不到新東西」不成立。
 *   W1：加人不換金鑰，所以新成員只拿得到他加入（鏈上那筆 add 的時間）之後的快取；引擎沒有他的加入紀錄 → 什麼都不給。
 *   另外跑真的 seedSync.transferMessages，確認 notBefore 之前的訊息真的不送。
 * Run: node scripts/review/seed_sync_members_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const s = provider.indexOf('const handleSeedSync = useCallback(');
const e = provider.indexOf('}, [publicKey]);', s);
assert.ok(s > 0 && e > s, 'handleSeedSync found');
const code = transformSync(provider.slice(s, e) + '}, [publicKey]);\nglobalThis.__seed = handleSeedSync;', { loader: 'ts' }).code;

const groups = { G: { id: 'G', members: [{ publicKey: 'ME' }, { publicKey: 'MEM' }, { publicKey: 'NOREC' }], departed: ['KICKED'] } };
const JOINED = { MEM: 5000 };
function run(peer, msg, engine = { joinedAt: (g, pk) => (g === 'G' ? JOINED[pk] ?? null : null) }) {
  const calls = [];
  const ctx = {
    globalThis: {}, console: { error() {} }, devLog() {}, diagLog() {}, useCallback: (fn) => fn, publicKey: 'ME',
    Number,
    useGroupStore: { getState: () => ({ getGroupById: (id) => groups[id] }) },
    getGroupEngine: () => engine,
    seedSync: {
      handleSyncRequest: (m) => calls.push(['request', m.requesterId]),
      handleSyncOffer: () => calls.push(['offer']),
      transferMessages: (g, after, to, notBefore) => calls.push(['transfer', g, to, notBefore]),
      handleSyncTransfer: () => calls.push(['transfer-in']),
    },
  };
  runInNewContext(code, ctx);
  ctx.globalThis.__seed(peer, msg);
  return calls;
}
assert.deepEqual(run('MEM', { type: 'sync_accept', groupId: 'G', lastMessageId: null, requesterId: 'MEM' }), [['transfer', 'G', 'MEM', 5000]], 'a member gets the cached group messages since they joined');
assert.deepEqual(run('MEM', { type: 'sync_accept', groupId: 'G', lastMessageId: null, requesterId: 'OTHER' }), [['transfer', 'G', 'MEM', 5000]], 'always to the peer on this channel, never to a requesterId it names');
assert.deepEqual(run('NOREC', { type: 'sync_accept', groupId: 'G', lastMessageId: null }), [['transfer', 'G', 'NOREC', Number.MAX_SAFE_INTEGER]], 'no join record in the chain → nothing is old enough to send');
assert.deepEqual(run('MEM', { type: 'sync_accept', groupId: 'G', lastMessageId: null }, null), [['transfer', 'G', 'MEM', Number.MAX_SAFE_INTEGER]], 'engine not ready → nothing is sent');
assert.deepEqual(run('MEM', { type: 'sync_request', groupId: 'G', requesterId: 'OTHER' }), [['request', 'MEM']], 'offers also go back to the channel peer only');
assert.deepEqual(run('KICKED', { type: 'sync_accept', groupId: 'G', lastMessageId: null, requesterId: 'KICKED' }), [], 'a kicked member gets nothing');
assert.deepEqual(run('STRANGER', { type: 'sync_accept', groupId: 'G', lastMessageId: null, requesterId: 'STRANGER' }), [], 'a non-member gets nothing');
assert.deepEqual(run('MEM', { type: 'sync_accept', groupId: 'NOPE', lastMessageId: null }), [], 'a group I am not in: nothing');
assert.deepEqual(run('STRANGER', { type: 'sync_transfer', groupId: 'G', messages: [] }), [], 'and a non-member cannot push messages into the cache');
console.log('PASS seed sync: only current members of that group, answers only to the channel peer, only messages since they joined');

// 真的 seedSync.transferMessages：notBefore 之前的不送
const { build } = require('esbuild');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const dir = mkdtempSync(join(tmpdir(), 'seedsync-'));
const sent = [];
globalThis.__seedSent = sent;
await build({ entryPoints: [root + 'packages/pwa/src/services/seedSync.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 's.mjs'), logLevel: 'silent', plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /^\.\/(offlineQueue|groupKey|p2pSend)$|utils\/devLog$/ }, (a) => ({ path: a.path, namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
      a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
      : a.path.includes('offlineQueue') ? `export const getMessagesAfter = () => [
          { messageId: 'before', payload: 'p', timestamp: 4999 }, { messageId: 'at', payload: 'p', timestamp: 5000 },
          { messageId: 'after', payload: 'p', timestamp: 7000 }];
          export const getLastMessageId = () => null; export const hasMessage = () => false; export const cacheGroupMessage = () => {};`
      : a.path.includes('groupKey') ? 'export {};'
      : 'export const sendViaP2P = (to, m) => { globalThis.__seedSent.push([to, JSON.parse(m)]); return true; };' }));
  } }] });
const S = await import(pathToFileURL(join(dir, 's.mjs')));
S.transferMessages('G', null, 'MEM', 5000);
assert.deepEqual(sent.map(([to, m]) => [to, m.payload.messages.map((x) => x.messageId)]), [['MEM', ['at', 'after']]],
  'messages from before the join time are not transferred');
sent.length = 0;
S.transferMessages('G', null, 'NOREC', Number.MAX_SAFE_INTEGER);
assert.equal(sent.length, 0, 'no join record → nothing transferred');
console.log('PASS seed sync transfer skips messages from before the peer joined');

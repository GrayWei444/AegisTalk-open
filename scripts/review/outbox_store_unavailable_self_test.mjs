/**
 * MQTT 待送佇列（IndexedDB）打不開時（對應 AegisPlay a41ddf4a，審查 LOW）：真的 outgoingQueueStore.ts，stub 掉 idb。
 *   以前 clearAllOutgoing 在 IndexedDB 打不開時丟例外（AegisTalk 的呼叫端 deviceClaim.wipeLocalKeys／設定頁登出會接住、
 *   只記一筆錯誤，但照樣當成清除失敗）。
 *   打不開代表這台本來就存不進待送訊息，沒有東西要清；真的清除失敗（資料可能還在）仍要丟。
 *   另外 openDB 失敗一次後 _dbPromise 留著被拒絕的 promise，之後每次存取都失敗，直到重新載入。
 * Run: node scripts/review/outbox_store_unavailable_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'outboxstore-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^idb$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ loader: 'js', contents:
    'export async function openDB(){ return globalThis.__idb.open() }' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/outgoingQueueStore.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'o.mjs'), logLevel: 'silent', plugins: [stub] });

const rows = new Map();
let clearFails = false;
const db = {
  put: async (_s, e) => { rows.set(e.id, e); },
  getAll: async () => [...rows.values()],
  delete: async (_s, id) => { rows.delete(id); },
  clear: async () => { if (clearFails) throw new Error('clear failed'); rows.clear(); },
};
let available = false;
globalThis.__idb = { open: async () => { if (!available) throw new Error('IndexedDB unavailable'); return db; } };
const store = await import(pathToFileURL(join(dir, 'o.mjs')));

await store.clearAllOutgoing();   // 打不開：不丟
console.log('PASS clearing the outbox succeeds when IndexedDB cannot be opened (nothing can be stored there)');

available = true;
await store.persistOutgoing({ id: 'a', topic: 't', payload: '{}', qos: 1, timestamp: 1 });
assert.equal(rows.size, 1, 'a failed open does not poison later access once IndexedDB works again');
console.log('PASS a failed open is retried on the next access');

clearFails = true;
await assert.rejects(store.clearAllOutgoing(), /clear failed/, 'a real clear failure (data may remain) is still reported');
console.log('PASS a real clear failure is still reported');

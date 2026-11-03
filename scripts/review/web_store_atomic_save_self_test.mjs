/**
 * Web 版資料庫存檔不能「先刪再寫」（2026-10-15 多人模擬：Dave 的 App 關掉再開，十次有一次資料庫整顆是空的）。
 *
 * jeep-sqlite 2.8 存檔（saveToStore → UtilsStore.saveDBToStore）是 localForage 的 removeItem(key) 再 setItem(key, 整顆 DB)：
 * 兩個各自提交的 IndexedDB transaction。AppProvider 在 pagehide 時正好存一次（flushDbOnHide）：removeItem 很小、立刻
 * 提交；setItem 要寫整顆 DB，還沒提交頁面就沒了 → 這顆 DB 的 key 從 IndexedDB 消失 → 下次開 App jeep 建一顆空的。
 *
 * 這支用一個照 IndexedDB 語意做的假資料庫（每個 transaction 全有或全無；頁面一關，還沒提交的全部作廢），上面跑的是
 * 照 localForage 1.10 原樣寫的 removeItem／setItem／getItem 與 jeep 2.8 原樣的 saveDBToStore，再「在 removeItem 提交後、
 * setItem 提交前關掉頁面」：
 *   1. 舊做法（直接呼叫）：重開後 key 不見 → 空資料庫（證明這個窗口存在）
 *   2. 新做法（webStoreAtomicSave.saveAtomically）：jeep 那一次 delete 變成唯讀的 count，setItem 的 put 一次換掉 →
 *      頁面在同一個時間點關掉，重開後還是上一份完整快照；沒被打斷時就是新的那份
 *   3. 只吞「我們自己存檔時、jeepSqliteStore/databases 裡這顆 DB 的那一次」delete：存檔以外的刪除（登出刪資料庫）、
 *      別的 key（規則 DB）、別的 IndexedDB 照常；存檔失敗也會解除
 *   4. 接線：database.ts 每次存檔都走 saveAtomically；檢查「DB 在不在 store」只認 aegistalkSQLite.db 這個 key；
 *      登出前的 flushToStore 存檔丟例外就再試一次（key 一定在，不能拿它當成存好了）
 *      （以前 includes('aegistalk') 也比對到規則 DB 的 aegistalkrulesSQLite.db，key 不見了還說在）
 * Run: node scripts/review/web_store_atomic_save_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const KEY = 'aegistalkSQLite.db';

// ───────── 照 IndexedDB 語意的假資料庫 ─────────
// 每個 transaction 的寫入先記著，下一輪事件迴圈才一次提交（全有或全無）；page.crash() 之後還沒提交的全部作廢、
// 之後的 transaction 也不再提交（頁面沒了）。disk 是存活過「關 App」的那份（瀏覽器的 IndexedDB 檔）。
class FakeRequest { constructor(tx) { this.transaction = tx; this.result = undefined; this.error = null; } }
class FakeObjectStore {
  constructor(tx, name) { this.transaction = tx; this.name = name; }
  _data() { return this.transaction.db._disk.get(this.name); }
  put(value, key) { const r = new FakeRequest(this.transaction); this.transaction._ops.push(() => this._data().set(key, value)); return r; }
  delete(key) { const r = new FakeRequest(this.transaction); this.transaction._ops.push(() => this._data().delete(key)); return r; }
  get(key) { const r = new FakeRequest(this.transaction); r.result = this._data().get(key); return r; }
  count(key) { const r = new FakeRequest(this.transaction); r.result = this._data().has(key) ? 1 : 0; return r; }
  getAllKeys() { const r = new FakeRequest(this.transaction); r.result = [...this._data().keys()]; return r; }
}
class FakeTransaction {
  constructor(db, page) {
    this.db = db; this._ops = []; this.oncomplete = null; this.onerror = null; this.onabort = null; this.error = null;
    setTimeout(() => {
      if (page.dead || (page.crashBeforeCommit && page.crashBeforeCommit(this))) { page.dead = true; return; }   // 頁面沒了：作廢
      for (const op of this._ops) op();
      this.oncomplete?.();
    }, 0);
  }
  objectStore(name) { return new FakeObjectStore(this, name); }
}
function fakeIdb(disk, page) {
  return { name: 'jeepSqliteStore', _disk: disk, transaction: () => new FakeTransaction({ name: 'jeepSqliteStore', _disk: disk }, page) };
}
// localForage 1.10 的 IndexedDB driver（jeep 打包在 jeep-sqlite.entry.js 裡的那份）：removeItem／setItem／getItem 各自一個 transaction，
//   在 transaction.oncomplete 才 resolve
function localForageLike(idb) {
  const tx = () => idb.transaction();
  return {
    removeItem: (key) => new Promise((resolve, reject) => {
      const t = tx(); const store = t.objectStore('databases');
      const req = store['delete'](key);
      t.oncomplete = () => resolve(); t.onerror = () => reject(req.error);
    }),
    setItem: (key, value) => new Promise((resolve, reject) => {
      const t = tx(); const store = t.objectStore('databases');
      store.put(value, key);
      t.oncomplete = () => resolve(value); t.onerror = () => reject(t.error);
    }),
    getItem: (key) => new Promise((resolve) => {
      const t = tx(); const req = t.objectStore('databases').get(key);
      t.oncomplete = () => resolve(req.result ?? null);
    }),
  };
}
// jeep-sqlite 2.8.0 dist/collection/utils/utils-store.js 原樣
async function saveDBToStore(dbName, data, store) {
  await store.removeItem(dbName);
  await store.setItem(dbName, data);
}
// jeep 2.8 Database.open()：store 裡沒有這顆 → 建一顆空的（並寫 null 回去）
async function jeepOpen(store) {
  const retDB = await store.getItem(KEY);
  if (retDB != null) return retDB;
  await store.setItem(KEY, null);
  return 'EMPTY-DB';
}

const snapshot = (n) => new Uint8Array(2_000).fill(n);
const run = async ({ guard, crash }) => {
  const disk = new Map([['databases', new Map([[KEY, snapshot(1)], ['aegistalkrulesSQLite.db', null]])]]);
  const page = { dead: false, crashBeforeCommit: null };
  const store = localForageLike(fakeIdb(disk, page));
  // 關 App 的時間點：removeItem 已提交、setItem（整顆 DB）還沒提交
  if (crash) page.crashBeforeCommit = (t) => t._ops.length > 0 && t._isPut;
  const origPut = FakeObjectStore.prototype.put;
  FakeObjectStore.prototype.put = function (v, k) { this.transaction._isPut = true; return origPut.call(this, v, k); };
  const save = () => saveDBToStore(KEY, snapshot(2), store);
  const p = guard ? guard(KEY, save) : save();
  if (crash) await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 30))]);   // 頁面沒了，存檔永遠不會回來
  else await p;
  FakeObjectStore.prototype.put = origPut;
  // 重開 App：新的頁面，同一份 disk
  const reopened = localForageLike(fakeIdb(disk, { dead: false }));
  return jeepOpen(reopened);
};

// 1 舊做法
const lost = await run({ guard: null, crash: true });
console.log(`  delete-then-write, page closed between the two: reopened database = ${typeof lost === 'string' ? lost : `snapshot #${lost[0]}`}`);
assert.equal(lost, 'EMPTY-DB', 'the old save path loses the database when the page closes between removeItem and setItem');
assert.deepEqual((await run({ guard: null, crash: false }))[0], 2, 'control: an uninterrupted old save works');
console.log('PASS the delete-then-write window exists: closing the page between the two steps empties the database');

// 2 新做法
const modPath = root + 'packages/pwa/src/services/webStoreAtomicSave.ts';
assert.ok(existsSync(modPath), 'services/webStoreAtomicSave.ts exists');
const dir = mkdtempSync(join(tmpdir(), 'atomicsave-'));
await require('esbuild').build({ entryPoints: [modPath], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'a.mjs'), logLevel: 'silent' });
const modUrl = pathToFileURL(join(dir, 'a.mjs')).href;
const pristineDelete = FakeObjectStore.prototype.delete;
let pages = 0;
// 每個「頁面」一份新的模組（關 App 的頁面裡那次存檔永遠不會回來；真的瀏覽器裡模組跟著頁面一起沒了）
async function freshPage() {
  FakeObjectStore.prototype.delete = pristineDelete;
  const mod = await import(`${modUrl}?page=${++pages}`);
  assert.equal(mod.installAtomicSaveGuard(FakeObjectStore.prototype), true, 'the guard installs on the object store prototype');
  assert.equal(mod.installAtomicSaveGuard(FakeObjectStore.prototype), true, 'installing twice is harmless');
  return mod;
}
const kept = await run({ guard: (await freshPage()).saveAtomically, crash: true });
console.log(`  atomic save, page closed at the same moment: reopened database = ${typeof kept === 'string' ? kept : `snapshot #${kept[0]}`}`);
assert.notEqual(kept, 'EMPTY-DB', 'the database survives a page close in the middle of a save');
assert.equal(kept[0], 1, 'the previous complete snapshot is still there');
assert.equal((await run({ guard: (await freshPage()).saveAtomically, crash: false }))[0], 2, 'an uninterrupted save stores the new snapshot');
// 連續關 App 再開 10 次，每次都在存檔中途關：一次都不會變空
for (let i = 0; i < 10; i++) {
  assert.equal((await run({ guard: (await freshPage()).saveAtomically, crash: true }))[0], 1, `restart ${i + 1}: still the last snapshot`);
}
const A = await freshPage();
console.log('PASS an interrupted save keeps the last complete snapshot; an uninterrupted one replaces it in one transaction');

// 3 範圍
{
  const disk = new Map([['databases', new Map([[KEY, 'x'], ['aegistalkrulesSQLite.db', 'r']])], ['other', new Map([[KEY, 'o']])]]);
  const page = { dead: false };
  const idb = fakeIdb(disk, page);
  const lf = localForageLike(idb);
  await lf.removeItem('aegistalkrulesSQLite.db');
  assert.equal(disk.get('databases').has('aegistalkrulesSQLite.db'), false, 'deletes outside a save go through');
  await A.saveAtomically(KEY, async () => {
    await lf.removeItem('aegistalkrulesSQLite.db');                 // 別的 key
    const t = idb.transaction(); t.objectStore('other').delete(KEY);   // 別的 object store
    await new Promise((r) => { t.oncomplete = r; });
    await lf.removeItem(KEY);                                        // 這一次被吞
    await lf.removeItem(KEY);                                        // 第二次照常（一次存檔只吞一次）
  });
  assert.equal(disk.get('other').has(KEY), false, 'another object store is untouched by the guard');
  assert.equal(disk.get('databases').has(KEY), false, 'only one delete per save is swallowed');
  disk.get('databases').set(KEY, 'y');
  await assert.rejects(A.saveAtomically(KEY, async () => { throw new Error('quota'); }), /quota/, 'a failing save still reports its error');
  await lf.removeItem(KEY);
  assert.equal(disk.get('databases').has(KEY), false, 'after a failed save the guard is disarmed (logout can delete the database)');
  // 另一個 IndexedDB（例如檔案 blob store）同名的 key 不受影響
  const other = { name: 'aegis-file-blobs', _disk: new Map([['databases', new Map([[KEY, 'b']])]]) };
  await A.saveAtomically(KEY, async () => {
    const t = new FakeTransaction(other, { dead: false }); t.objectStore('databases').delete(KEY);
    await new Promise((r) => { t.oncomplete = r; });
  });
  assert.equal(other._disk.get('databases').has(KEY), false, 'a different IndexedDB database is untouched by the guard');
}
console.log('PASS the guard only swallows the one delete jeep makes for this database during our own save');

// 4 接線
const db = readFileSync(root + 'packages/pwa/src/services/database.ts', 'utf8');
const save = db.slice(db.indexOf('function _doSaveToStore('), db.indexOf('function _persistToStore('));
assert.match(save, /saveAtomically\(JEEP_DB_KEY, \(\) => CapacitorSQLite\.saveToStore\(\{ database: DB_NAME \}\)\)/, 'every web save goes through saveAtomically');
assert.match(db, /const JEEP_DB_KEY = `\$\{DB_NAME\}SQLite\.db`/, 'the jeep store key of the durable database');
for (const fn of ['_pollDbInStore', '_rawIdbHasBlob', '_rawIdbHasKey']) {
  const body = db.slice(db.indexOf(`async function ${fn}(`), db.indexOf('\n}\n', db.indexOf(`async function ${fn}(`)));
  assert.ok(!/includes\(DB_NAME\)/.test(body), `${fn} no longer matches aegistalkrulesSQLite.db as if it were the durable database`);
  assert.ok(/JEEP_DB_KEY/.test(body), `${fn} looks for exactly ${KEY}`);
}
assert.ok(db.indexOf('installAtomicSaveGuard()') > 0 && db.indexOf('installAtomicSaveGuard()') < db.indexOf('await CapacitorSQLite.initWebStore()'),
  'the guard is installed before the web store opens');
// 登出前的 flushToStore：store 裡的 key 一定在（存檔一次換掉、舊快照留著），存檔丟例外（例如空間不夠）時不能拿
//   「key 在」當成存好了 —— 要再試一次（程式碼審查 LOW）
const flush = db.slice(db.indexOf('export async function flushToStore('), db.indexOf('export async function runNoSave('));
const failAt = flush.indexOf('if (!saved) continue;');
assert.ok(failAt > 0 && failAt < flush.indexOf('_rawIdbHasKey()'), 'a save that threw is retried instead of being confirmed by the (old) key');
console.log('PASS wiring: database.ts saves through saveAtomically, checks the exact store key, and retries a failed flush');

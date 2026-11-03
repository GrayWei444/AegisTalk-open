/**
 * Web 版資料庫存檔改成「一次換掉」（2026-10-15 多人模擬：Dave 的 App 關掉再開，十次有一次資料庫整顆是空的）。
 *
 * jeep-sqlite 2.8 的 saveToStore → UtilsStore.saveDBToStore 是 localForage 的 `removeItem(key)` 再 `setItem(key, 整顆 DB)`：
 * 兩個各自提交的 IndexedDB transaction。AppProvider 在 pagehide 時正好存一次（flushDbOnHide）：removeItem 很小、立刻提交，
 * setItem 要寫整顆 DB，還沒提交頁面就沒了 → 這顆 DB 的 key 從 IndexedDB 消失 → 下次開 App jeep 建一顆空的。
 *
 * jeep 打包了自己的 localForage，碰不到它；但它最後一定呼叫 `IDBObjectStore.prototype.delete`。我們自己發起的存檔期間
 * （saveAtomically），jeep 對 `jeepSqliteStore` 資料庫 `databases` object store 裡**這顆 DB 的 key** 做的那一次 delete
 * 改成一個唯讀的 `count`：localForage 的 removeItem 照樣在 transaction 完成時 resolve，接下來的 setItem 是單一個 put ——
 * IndexedDB 的 transaction 全有或全無，put 提交前舊快照一直在，提交後就是新的那份。中間任何時候關 App 都不會沒有資料。
 *
 * 只吞那一次：存檔以外的刪除（登出刪資料庫）、別的 key（規則 DB）、別的 object store／IndexedDB 一律照常。
 * 存檔一次只跑一個（自己排隊；database.ts 的 _saveTail 本來也排隊），失敗也會解除。
 */

export const JEEP_IDB_NAME = 'jeepSqliteStore';
export const JEEP_OBJECT_STORE = 'databases';

type DeleteFn = (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) => IDBRequest;
type StoreProto = { delete: DeleteFn; count: IDBObjectStore['count'] };

let installedOn: StoreProto | null = null;
/** 正在存的那顆 DB 的 key；jeep 的那一次 delete 用掉就清掉 */
let armedKey: string | null = null;
let tail: Promise<unknown> = Promise.resolve();

/**
 * 在 object store 的 prototype 上裝攔截（瀏覽器：IDBObjectStore.prototype；測試可傳假的）。可以重複呼叫。
 * 環境沒有 IndexedDB 回 false（原生 App 不走 jeep）。
 */
export function installAtomicSaveGuard(
  proto: StoreProto | undefined = (globalThis as { IDBObjectStore?: { prototype: StoreProto } }).IDBObjectStore?.prototype,
): boolean {
  if (!proto) return false;
  if (installedOn === proto) return true;
  const original = proto.delete;
  proto.delete = function guardedDelete(this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest {
    if (armedKey !== null && query === armedKey && this.name === JEEP_OBJECT_STORE
        && this.transaction?.db?.name === JEEP_IDB_NAME) {
      armedKey = null;                 // 一次存檔只吞一次
      return this.count(query);        // 唯讀：transaction 照常完成，舊快照留著，等接下來的 put 一次換掉
    }
    return original.call(this, query);
  };
  installedOn = proto;
  return true;
}

/** 跑一次 jeep 的存檔（`save`），期間它對 `key` 的那一次 delete 不真的刪 */
export function saveAtomically<T>(key: string, save: () => Promise<T>): Promise<T> {
  if (!installedOn) installAtomicSaveGuard();
  const run = async (): Promise<T> => {
    armedKey = key;
    try {
      return await save();
    } finally {
      armedKey = null;
    }
  };
  const next = tail.then(run, run);
  tail = next.catch(() => {});
  return next;
}

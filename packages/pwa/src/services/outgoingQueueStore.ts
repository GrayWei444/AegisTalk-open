/**
 * Outgoing MQTT Queue Persistence — IndexedDB-backed
 *
 * 對應 mqtt.ts 內的 outgoingQueue（in-memory）：MQTT 斷線時暫存待發訊息，
 * 重連後 flush。原本只活在 RAM，瀏覽器 tab 被背景殺/重整就消失，
 * 對應使用者「離線發了訊息回來什麼都沒了」的故障。
 *
 * 此 store 把每筆 enqueue 鏡寫一份到 IndexedDB，
 * - 啟動 / 重連時 loadAllOutgoing() 撈回記憶體
 * - 成功 publish 後 removeOutgoing(id) 清掉
 * - 視覺上達到「mqtt 訊息暫存，回上線會補送」
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'aegistalk-mqtt-outbox';
const STORE = 'outgoing';
const VERSION = 1;

export interface PersistedOutgoing {
  id: string;
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  timestamp: number;
  /** 排隊最多多久（毫秒；mqtt.ts OutgoingMessage.ttlMs，只在本機） */
  ttlMs?: number;
}

let _db: IDBPDatabase | null = null;
let _dbPromise: Promise<IDBPDatabase> | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;
  _dbPromise = openDB(DB_NAME, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    },
  });
  try {
    _db = await _dbPromise;
  } catch (err) {
    _dbPromise = null;   // 不留被拒絕的 promise：否則之後每次存取都失敗，直到重新載入（對應 AegisPlay a41ddf4a）
    throw err;
  }
  return _db;
}

/**
 * id＝毫秒-流水號-亂數：同一毫秒排入的照排入順序排（IndexedDB 照 id 排，載回時同一時間的也照 id 排）。
 * 以前是「毫秒-亂數」，重開 App 後同一毫秒的兩則一半機率顛倒 —— 唯一 admin 離開時連發的 GROUP_ROLE_UPDATED
 * 會跑到 GROUP_MEMBER_LEFT 後面，收端就不認那個接手者。流水號每次載入模組從頭算（那時毫秒早就不同了）。
 */
let _idSeq = 0;
export function makeOutgoingId(): string {
  _idSeq = (_idSeq + 1) % 1_000_000_000;
  return `${Date.now()}-${String(_idSeq).padStart(9, '0')}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function persistOutgoing(entry: PersistedOutgoing): Promise<void> {
  const db = await getDB();
  await db.put(STORE, entry);
}

export async function loadAllOutgoing(): Promise<PersistedOutgoing[]> {
  const db = await getDB();
  const all = await db.getAll(STORE);
  // 同一時間的照 id（排入順序，見 makeOutgoingId），不靠 getAll 的回傳順序
  return all.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function removeOutgoing(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, id);
}

/** 清掉這台裝置上帳號的待送訊息（被踢下線、換帳號登出）：否則下一個帳號會載入、重送上一個帳號的 */
export async function clearAllOutgoing(): Promise<void> {
  let db: IDBPDatabase;
  try {
    db = await getDB();
  } catch {
    // IndexedDB 打不開（無痕模式、被封鎖）→ 這台本來就存不進待送訊息，沒有東西要清（對應 AegisPlay a41ddf4a）
    return;
  }
  await db.clear(STORE);   // 真的清除失敗（資料可能還在）照樣丟
}

/**
 * File Blob Store — IndexedDB binary storage for large file payloads
 *
 * 給 fileTransfer.ts 使用：分塊接收完成後 Blob 寫進這裡，MessageBubble 渲染時
 * lookup 出來建 ObjectURL。SQLite 的 messages.content 欄不存 base64 大字串，
 * 只存 fileId 引用 — 避免 100MB 檔把 SQLite 撐爆。
 *
 * 對應 LEARNINGS_FROM_AEGISTRANS.md §1
 */

import { devLog, devWarn } from '../utils/devLog';

const DB_NAME = 'aegistalk-files';
const STORE_NAME = 'blobs';
const DB_VERSION = 1;

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fileId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

interface BlobRecord {
  fileId: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: number;
}

export async function putBlob(fileId: string, blob: Blob, mimeType: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: BlobRecord = {
      fileId,
      blob,
      mimeType,
      size: blob.size,
      createdAt: Date.now(),
    };
    store.put(record);
    tx.oncomplete = () => {
      devLog(`[fileBlobStore] Stored blob ${fileId.slice(0, 8)} (${blob.size} bytes)`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * null＝確定沒有這個檔；讀取錯誤會丟出（對應群星 Codex #16）。呼叫端要分得出「不見了」與「暫時讀不到」時用這個 ——
 * 例如待送清單：iOS 從背景回來 IndexedDB 常常斷線，那時不能當成檔案不見了就把待送的那筆丟掉
 */
export async function readBlob(fileId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(fileId);
    req.onsuccess = () => {
      const record = req.result as BlobRecord | undefined;
      resolve(record?.blob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getBlob(fileId: string): Promise<Blob | null> {
  try {
    return await readBlob(fileId);
  } catch (err) {
    devWarn('[fileBlobStore] getBlob failed:', err);
    return null;
  }
}

export async function deleteBlob(fileId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function hasBlob(fileId: string): Promise<boolean> {
  const blob = await getBlob(fileId);
  return blob !== null;
}

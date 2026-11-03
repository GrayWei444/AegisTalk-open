/**
 * 解不開的金鑰不能被刪、換機收到的金鑰重啟後還解得開（移植群星 B21）。
 * 真的 keyEncryption.ts（真的 Argon2／AES），storage 與 IndexedDB 用記憶體版。
 *   A. 沒有 IndexedDB：換機收到的資料用臨時金鑰加密、第一次設 PIN 前重啟 → 解不開 → 搬去隔離區，不是刪掉
 *   B. 有 IndexedDB：同樣情境，臨時金鑰在 IndexedDB 還在 → 解得開、重新用 PIN 金鑰加密
 *   C. useCrypto／社群版的 ChatAuthScreen：隔離區有東西時解鎖保持鎖住（不讓 AppProvider 產新身分），PIN 對了也回歡迎畫面
 *      （開新帳號或匯入恢復包）；新帳號確定、或從恢復包還原之後才清隔離區；開新帳號產身分時解鎖
 *   D. 網頁版不跨瀏覽器 session 沿用金鑰（移植群星 A7）：關掉瀏覽器（session marker 沒了）之後，刷臉也不能從
 *      IndexedDB 拿回金鑰，要輸 PIN；原生 App 刷臉照舊
 * 官方版 AuthScreen（AegisID）的同一套規則在 key_quarantine_official_self_test.mjs（開源第 6 步拆開：公開的 repo 沒有它）。
 * Run: node scripts/review/key_quarantine_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
class Storage { data = new Map(); getItem(k) { return this.data.get(k) ?? null; } setItem(k, v) { this.data.set(k, String(v)); } removeItem(k) { this.data.delete(k); } }

/** 夠 keyEncryption 用的 IndexedDB：open／upgrade／transaction／put／get／delete */
function memoryIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => { stores.set(s, new Map()); },
          close() {},
          transaction(s) {
            const tx = {};
            const store = stores.get(s);
            tx.objectStore = () => ({
              put: (v, k) => { store.set(k, v); },
              delete: (k) => { store.delete(k); },
              get: (k) => { const r = {}; later(() => { r.result = store.get(k); r.onsuccess?.(); }); return r; },
            });
            later(() => later(() => tx.oncomplete?.()));
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

async function loadKeyEncryption(label) {
  const dir = mkdtempSync(join(tmpdir(), 'keyq-'));
  const fixture = { name: 'fx', setup(b) {
    b.onResolve({ filter: /^\.\.?\/database$/ }, () => ({ path: 'database', namespace: 'fx' }));
    b.onResolve({ filter: /utils\/devLog$/ }, () => ({ path: 'devlog', namespace: 'fx' }));
    b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'cap', namespace: 'fx' }));
    b.onLoad({ filter: /^cap$/, namespace: 'fx' }, () => ({ loader: 'js', contents: 'export const Capacitor={isNativePlatform:()=>globalThis.__native===true};' }));
    b.onLoad({ filter: /^database$/, namespace: 'fx' }, () => ({ loader: 'js',
      contents: 'export async function getSetting(k){return globalThis.__db.get(k)??null;} export async function setSetting(k,v){globalThis.__db.set(k,v);} export async function query(){return [];} export async function run(){}' }));
    b.onLoad({ filter: /^devlog$/, namespace: 'fx' }, () => ({ loader: 'js', contents: 'export const devLog=()=>{};export const devWarn=()=>{};' }));
  } };
  await require('esbuild').build({ stdin: { contents: "export * from './packages/pwa/src/services/keyEncryption.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(dir, `${label}.mjs`), define: { 'import.meta.env': '{}' }, logLevel: 'silent', plugins: [fixture] });
  return import(pathToFileURL(join(dir, `${label}.mjs`)));
}

async function transferThenRestart(withIDB, label) {
  globalThis.localStorage = new Storage(); globalThis.sessionStorage = new Storage(); globalThis.__db = new Map();
  globalThis.indexedDB = withIDB ? memoryIndexedDB() : undefined;
  const m = await loadKeyEncryption(label);
  localStorage.setItem('aegis_key_salt', Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const secret = JSON.stringify({ identity: { privateKey: 'REAL_IDENTITY' } });
  const enc = await m.encryptWithEphemeralKey(secret);             // 換機收到、還沒設 PIN
  localStorage.setItem('mist_keys', enc); __db.set('mist_keys', enc);
  sessionStorage.removeItem('aegis_eph_key');                      // App 重啟
  const k = await m.deriveEncryptionKey('123456');
  await m.setEncryptionKey(k);                                     // 第一次輸入正確 PIN → 觸發遷移
  return { m, k, secret, enc };
}

console.error = () => {};
{
  // A
  {
    const { m, enc } = await transferThenRestart(false, 'a');
    assert.equal(localStorage.getItem('mist_keys'), null);
    assert.equal(localStorage.getItem('mist_keys.unreadable'), enc, 'unreadable identity kept in quarantine (localStorage), byte for byte');
    assert.equal(__db.get('mist_keys.unreadable'), enc, 'and in SQLite');
    assert.equal(m.hasUnreadableKeys(), true, 'unlock flow can see keys exist but are unreadable');
    m.clearUnreadableKeys();
    assert.equal(m.hasUnreadableKeys(), false);
    console.log('PASS undecryptable identity is quarantined, not deleted; flagged so no new identity is generated');
  }
  // B
  {
    const { m, k, secret } = await transferThenRestart(true, 'b');
    const stored = localStorage.getItem('mist_keys');
    assert.ok(stored, 'transferred keys still there');
    assert.equal(await m.decryptData(stored, k), secret, 're-encrypted under the PIN key');
    assert.equal(m.hasUnreadableKeys(), false);
    console.log('PASS temp key survives an app restart (IndexedDB), transferred identity migrates to the PIN key');
  }
  // C
  {
    const crypto = readFileSync(root + 'packages/pwa/src/hooks/useCrypto.ts', 'utf8');
    const unlock = crypto.slice(crypto.indexOf('const unlockAndReloadKeys = useCallback('), crypto.indexOf('const identity = Identity.fromPrivateKey', crypto.indexOf('const unlockAndReloadKeys = useCallback(')));
    assert.ok(unlock.indexOf('if (hasUnreadableKeys())') > 0 && unlock.indexOf('if (hasUnreadableKeys())') < unlock.indexOf('keysLocked: false'),
      'unlockAndReloadKeys stays locked (no new identity) while quarantined keys exist');
    assert.match(unlock.slice(unlock.indexOf('if (hasUnreadableKeys())'), unlock.indexOf('keysLocked: false')), /return false;/);
    const gen = crypto.slice(crypto.indexOf('const generateIdentity = useCallback('), crypto.indexOf('const getPreKeyBundle = useCallback('));
    assert.match(gen, /keysLocked: false/, 'a newly generated identity is unlocked (new account after quarantine)');
    // 社群版的登入畫面（ext/chat/ChatAuthScreen.tsx）
    const chat = readFileSync(root + 'packages/pwa/src/ext/chat/ChatAuthScreen.tsx', 'utf8');
    const between = (from, to) => { const a = chat.indexOf(from); assert.ok(a >= 0, `ChatAuthScreen has ${from}`); return chat.slice(a, chat.indexOf(to, a)); };
    const verify = between('const handleVerifyComplete = useCallback(', 'const handleUnconfirmed = useCallback(');
    assert.match(verify, /const unlocked = await unlockAndReloadKeys\(\);\s*if \(!unlocked && hasUnreadableKeys\(\)\) \{[\s\S]*?setMode\('welcome'\);\s*return;/,
      'a correct PIN over unreadable keys goes back to the welcome screen (new account or recovery kit), never to a new identity');
    const create = between('const handleCreate = useCallback(', 'const confirmAccount = useCallback(');
    assert.ok(create.indexOf('clearUnreadableKeys()') > create.indexOf('pinAuth().setPin(pin)') && create.indexOf('pinAuth().setPin(pin)') > 0,
      'new account confirmed by the server (PIN written) → quarantine cleared');
    const kit = between('const restoreKit = useCallback(', 'const handleConfirm = useCallback(');
    assert.ok(kit.indexOf('clearUnreadableKeys()') > kit.indexOf('pinAuth().setPin(newPin)') && kit.indexOf('pinAuth().setPin(newPin)') > 0,
      'identity restored from the recovery kit → quarantine cleared');
    console.log('PASS unlock stays locked over quarantined keys; ChatAuthScreen goes back to the welcome screen and clears the quarantine only after a new or restored identity');
  }
  // D
  {
    globalThis.localStorage = new Storage(); globalThis.sessionStorage = new Storage(); globalThis.__db = new Map();
    globalThis.indexedDB = memoryIndexedDB(); globalThis.__native = false;
    const m = await loadKeyEncryption('a7');
    localStorage.setItem('aegis_key_salt', Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
    await m.setEncryptionKey(await m.deriveEncryptionKey('123456'));
    assert.equal(await m.canRestoreEncryptionKey(), true, 'same browser session: key can be restored');
    assert.equal(await m.restoreEncryptionKeyFromSession(true), true);
    sessionStorage.removeItem('aegis_ek_active');                    // 關掉瀏覽器再開
    assert.equal(await m.canRestoreEncryptionKey(), false, 'web, new browser session: no stored key to reuse');
    assert.equal(await m.restoreEncryptionKeyFromSession(true), false, 'web: face login cannot bring the stored key back across sessions');
    await m.setEncryptionKey(await m.deriveEncryptionKey('123456'));   // 輸 PIN 之後照常
    sessionStorage.removeItem('aegis_ek_active');
    globalThis.__native = true;
    assert.equal(await m.canRestoreEncryptionKey(), true, 'native app: stored key still usable');
    assert.equal(await m.restoreEncryptionKeyFromSession(true), true, 'native app: face login still restores the key');
    console.log('PASS web does not reuse the stored key across browser sessions (PIN needed); native face login unchanged');
  }
}

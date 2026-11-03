/**
 * 加密前（與解密失敗重試前）從資料庫重載 session 時，要先等排隊中的存檔寫完（移植群星 B29）。
 *   acceptSession／createSession 換了新 session 之後只是「排隊存檔」；那筆還沒落 DB 時 encrypt 從 DB 重載，
 *   讀到的是舊 session —— 用舊的加密、再存回去蓋掉新的，之後每則都 aead。
 *   真的 useCrypto.ts 的 encrypt／decrypt（抽出 useCallback 本體），真的 saveSession 佇列＋flushSessionWrites，
 *   假的 DB（寫入要等一下才完成）。
 *   1. encrypt：新 session 還在排隊存 → 等它寫完才讀，用新的加密
 *   2. decrypt：記憶體那份 aead → 重試時同樣先等存檔，拿到新的那份才解得開
 * Run: node scripts/review/session_flush_before_reload_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../packages/pwa/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const src = readFileSync(new URL('../../packages/pwa/src/hooks/useCrypto.ts', import.meta.url), 'utf8');
const cut = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, `found ${from}`); return src.slice(a, b); };
// 模組層：saveSession 佇列、flushSessionWrites、loadAllSessionsFromDb（真的）
const moduleCode = cut('// Promise queue serializes async session saves', 'function deleteStoredSession(')
  + cut('// Sync version (reads localStorage cache) - returns empty if encrypted', 'async function restoreSessions(');
// hook 裡的 encrypt／decrypt（useCallback 換成直接回傳函式）
const encryptCode = cut('const encrypt = useCallback(', '\n  /**\n   * 解密訊息');
const decryptCode = cut('const decrypt = useCallback(', '\n  /**\n   * 解鎖並重新載入');

function setup() {
  const db = { value: null, writes: 0, delay: 30 };
  const ctx = {
    console: { error() {}, log() {}, warn() {} }, devLog() {}, devWarn() {}, diagLog() {}, JSON, Promise, setTimeout,
    useCallback: (fn) => fn, withSessionLock: async (_k, fn) => fn(), SESSIONS_STORAGE_KEY: 'mist_sessions',
    getEncryptionKey: () => 'K', isEncryptedData: () => false,
    encryptData: async (json) => json, decryptData: async (data) => data,
    toBase64: (s) => s, fromBase64: (s) => s,
    localStorage: { setItem() {}, getItem: () => null },
    db: {
      getSetting: async () => db.value,
      setSetting: async (_k, v) => { await new Promise((r) => setTimeout(r, db.delay)); db.value = v; db.writes++; },
    },
    Session: { deserialize: (b64) => ({ id: b64, encrypt: (t) => `${b64}:${t}`, decryptToString: (m) => {
      if (m !== `for-${b64}`) throw new Error('aead::Error'); return 'ok'; }, serialize: () => b64 }) },
    sessionsRef: { current: new Map() },
  };
  runInNewContext(transformSync(moduleCode.replace(/^export /gm, '') + encryptCode + ';\n' + decryptCode
    + ';\nglobalThis.api = { saveSession, flushSessionWrites, encrypt, decrypt };', { loader: 'ts' }).code, { ...ctx, globalThis: ctx });
  return { api: ctx.api, db, ctx };
}

// 1
{
  const { api, db, ctx } = setup();
  const old = { serialize: () => 'OLD' };
  await api.saveSession('peer', old);                   // DB 裡是舊的
  assert.equal(JSON.parse(db.value).peer, 'OLD');
  const fresh = { serialize: () => 'NEW' };
  ctx.sessionsRef.current.set('peer', fresh);
  void api.saveSession('peer', fresh);                  // 換了新 session，存檔還在排隊（DB 寫入要 30ms）
  const out = await api.encrypt('peer', 'hi');
  assert.equal(out, 'NEW:hi', 'encrypt waits for the queued save and uses the new session');
  assert.equal(JSON.parse(db.value).peer, 'NEW', 'and does not write the old session back over the new one');
}
console.log('PASS encrypt reloads the session only after queued session writes landed');

// 2
{
  const { api, db, ctx } = setup();
  await api.saveSession('peer', { serialize: () => 'OLD' });
  ctx.sessionsRef.current.set('peer', ctx.Session.deserialize('STALE'));   // 記憶體這份對不上 → aead
  void api.saveSession('peer', { serialize: () => 'NEW' });                // 新的那份還在排隊
  const plain = await api.decrypt('peer', 'for-NEW');
  assert.equal(plain, 'ok', 'the aead retry waits for the queued save and decrypts with the new session');
  assert.ok(db.writes >= 2);
}
console.log('PASS the decrypt retry reloads only after queued session writes landed');

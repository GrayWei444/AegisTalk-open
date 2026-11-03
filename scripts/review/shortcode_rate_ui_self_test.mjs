/**
 * 短碼查詢被伺服器限速（429）時要說「太多次，稍後再試」，不是「找不到」（部署前審查 LOW）：
 *   抽出真的 FriendCode.lookupShortCode 配假的 fetch 執行，再檢查 AddFriendModal 與五種語言。
 *   46cfe6e 讓 /api/shortcode/lookup 每 IP 每分鐘 30 次；以前 lookupShortCode 把任何非 2xx 都回 null，
 *   畫面顯示「Short code not found or expired」→ 使用者以為碼錯了一直重打，越打越久。
 * Run: node scripts/review/shortcode_rate_ui_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { transformSync } = require('esbuild');
const src = (p) => readFileSync(root + 'packages/pwa/src/' + p, 'utf8');
const fc = src('components/Verification/FriendCode.tsx');
const start = fc.indexOf('export class ShortCodeRateLimitedError');
assert.ok(start > 0, 'FriendCode exports ShortCodeRateLimitedError');
const end = fc.indexOf('export default FriendCode', start);   // 舊長碼那一段（原本的切點「// 向後相容」）已拿掉
const code = transformSync(fc.slice(start, end).replace(/^export /gm, '').replace(/\/\/ =+\s*$/, '')
  + '\nglobalThis.__api = { lookupShortCode, ShortCodeRateLimitedError };', { loader: 'ts' }).code;
let reply = null;
const ctx = { globalThis: {}, apiBase: () => 'https://api', console: { error() {} },
  fetch: async () => reply, Error };
runInNewContext(code, ctx);
const { lookupShortCode, ShortCodeRateLimitedError } = ctx.globalThis.__api;

reply = { ok: false, status: 429, json: async () => ({}) };
await assert.rejects(lookupShortCode('ATK-ABC234'), (e) => e instanceof ShortCodeRateLimitedError, 'a 429 is reported as rate limited, not "not found"');
reply = { ok: false, status: 404, json: async () => ({}) };
assert.equal(await lookupShortCode('ATK-ABC234'), null, 'a 404 is still "not found"');
reply = { ok: true, status: 200, json: async () => ({ pk: 'P', name: 'n' }) };
assert.equal((await lookupShortCode('ATK-ABC234')).pk, 'P', 'a hit still returns the bundle');
ctx.fetch = async () => { throw new Error('offline'); };
assert.equal(await lookupShortCode('ATK-ABC234'), null, 'network errors keep the old behaviour');
console.log('PASS lookupShortCode tells a rate limit apart from "not found"');

const modal = src('components/Verification/AddFriendModal.tsx');
assert.match(modal, /err instanceof ShortCodeRateLimitedError[\s\S]{0,80}t\('friendCode\.lookupRateLimited'\)/, 'AddFriendModal shows the rate-limit message');
assert.match(src('i18n/types.ts'), /lookupRateLimited: string;/, 'translation key declared');
for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
  assert.match(src(`i18n/locales/${lang}.ts`), /\blookupRateLimited: (['"]).+\1,/, `${lang} has friendCode.lookupRateLimited`);
}
console.log('PASS the add-friend screen says "too many attempts, try later" (5 languages)');

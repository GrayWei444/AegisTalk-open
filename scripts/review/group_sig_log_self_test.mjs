/**
 * 群組訊息簽章的診斷 log 不再印出明文（稽核 H14，對應群星 P2-12）：真的 groupKey.ts，stub 掉 database。
 *   signPlaintext／verifySignature 以前用 console.error 印出明文前 120 字；prod build 保留 console.error，
 *   手機上會進 logcat／瀏覽器 log，開遠端除錯（debug build、?debug=1、E2E）時還會串到 broker 的
 *   aegis/debug/#。現在只印長度、簽章開頭與結果。
 * Run: node scripts/review/group_sig_log_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'gsiglog-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /\.\/database$|^\.\.\/types$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path.includes('types')
    ? 'export const GROUP_CONSTANTS = { KEY_RETENTION_DAYS: 30, KEY_TRANSITION_HOURS: 72 };'   // ../types 會拉進 zustand／capacitor
    : 'export {}' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/groupKey.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'k.mjs'), logLevel: 'silent', plugins: [stub] });
const logged = [];
console.error = (...a) => logged.push(a.map(String).join(' '));
console.log = console.warn = console.error;
const gk = await import(pathToFileURL(join(dir, 'k.mjs')));

gk.registerSignFunctions({ sign: () => new Uint8Array(64), verify: () => true });
const secret = '今晚八點在老地方見 secret-meeting-token';
const sig = gk.signPlaintext(JSON.stringify({ content: secret }));
gk.verifySignature(Buffer.alloc(32).toString('base64'), JSON.stringify({ content: secret }), sig);
assert.ok(logged.length > 0, 'diagnostics are still logged');
assert.ok(logged.every((l) => !l.includes('secret-meeting-token') && !l.includes('老地方')), 'no plaintext in any log line');
console.info('PASS group signature diagnostics keep lengths/results but never the message text');

// 解密後的 DIAG log（開 AEGIS_DIAG 時）也不印明文（對應 AegisPlay 95c3c2d0：AppProvider 還有兩行印前 30 字）
const { readFileSync } = await import('node:fs');
const provider = readFileSync(root + 'packages/pwa/src/providers/AppProvider.tsx', 'utf8');
const leaks = provider.split('\n').filter((l) => /diagLog\(/.test(l) && /content\??\.slice\(/.test(l));
assert.deepEqual(leaks, [], 'no diagLog line in AppProvider prints message content');
console.info('PASS decrypted-message diagnostics in AppProvider print lengths only');

// 檔名、agent 狀態文字也不印（對應 AegisPlay b403ecec，第二輪審查 L6）。
//   AegisTalk 另有一行正式版也會留的 console.error('[DIAG:FILESCAN] …') 印收到的檔名
const nameLeaks = ['providers/AppProvider.tsx', 'services/fileTransfer.ts', 'hooks/useChat.ts'].flatMap((p) =>
  readFileSync(root + 'packages/pwa/src/' + p, 'utf8').split('\n')
    .filter((l) => /diagLog\(|console\.error\(['`]\[DIAG/.test(l) && /(manifest|fileManifest|payload|file|rf)\.name\b|agentStatus\.slice\(/.test(l))
    .map((l) => p + ': ' + l.trim()));
assert.deepEqual(nameLeaks, [], 'no diagnostic line prints file names or agent status text');
console.info('PASS file diagnostics print ids and sizes, not names');

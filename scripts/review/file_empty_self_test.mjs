/**
 * 0 位元組檔案在送出端就拒絕（對應群星 P3-2，AegisPlay 4d879c6）：真的 fileTransfer.ts（stub 掉 blob store）。
 *   送出端允許 0 bytes：manifest 的 chunkCount 是 0，收端永遠等不到「收齊」那一塊 →
 *   60 秒後標成失敗，送出端畫面卻顯示已送出（LEARNINGS §16.3）。現在送出端直接丟錯（跟「檔案太大」同一條路）。
 * Run: node scripts/review/file_empty_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'fileempty-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|\.\/fileBlobStore$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : 'export async function putBlob(){} export async function getBlob(){ return null } export async function readBlob(){ return null } export async function hasBlob(){ return false }' }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/fileTransfer.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'f.mjs'), logLevel: 'silent', plugins: [stub] });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.error = () => {};
const ft = await import(pathToFileURL(join(dir, 'f.mjs')));
const manifests = [];
ft.initFileTransfer({ sendChunk: () => true, sendManifest: async (p, m) => { manifests.push(m); },
  getBufferedAmount: () => 0, isConnectedTo: () => false, connectPeer: async () => {} });

const empty = new File([], 'empty.txt', { type: 'text/plain' });
await assert.rejects(ft.sendFile('peer', empty), /empty/i, 'a 0-byte file is refused up front');
await assert.rejects(ft.sendFileToGroup(['a', 'b'], empty, ['g']), /empty/i, 'also for groups');
assert.equal(manifests.length, 0, 'nothing is sent that the receiver would reject');
console.log('PASS 0-byte files are refused at send time instead of stalling on the receiver while the sender shows sent');

// 群組畫面：0 位元組要說「檔案是空的」，不是「讀取檔案失敗」（對應 AegisPlay ee7b0729，審查 LOW）
const { readFileSync } = await import('node:fs');
const win = readFileSync(root + 'packages/pwa/src/components/GroupChat/GroupChatWindow.tsx', 'utf8');
assert.ok(/file\.size === 0[\s\S]{0,80}t\('group\.fileEmpty'\)/.test(win), 'the group chat window checks for an empty file and shows group.fileEmpty');
for (const lang of ['en', 'ja', 'ko', 'zh-CN', 'zh-TW']) {
  const src = readFileSync(root + `packages/pwa/src/i18n/locales/${lang}.ts`, 'utf8');
  assert.ok(/\bfileEmpty: (['"]).+\1,/.test(src), `${lang} has group.fileEmpty`);
}
console.log('PASS the group chat tells the user the file is empty');

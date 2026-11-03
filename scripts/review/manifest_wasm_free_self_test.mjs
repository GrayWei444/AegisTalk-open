/**
 * 傳檔 manifest／file_ctl 加密出來的 RatchetMessage（WASM 物件）用完要 free（移植群星）。
 *   以前 sendManifest 只 toJson、不 free：每送一個檔就漏一個 WASM 物件，換帳號提早 return 時也一樣。
 *   真的 AppProvider 裡的 sendManifest／sendControl（抽出本體），stub encrypt／sendViaP2P／active。
 *   1. 正常送出：送一次、free 一次
 *   2. 加密完發現換帳號了（active() 變 false）：不送，但照樣 free
 * Run: node scripts/review/manifest_wasm_free_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../../packages/pwa/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const src = readFileSync(new URL('../../packages/pwa/src/providers/AppProvider.tsx', import.meta.url), 'utf8');
const ft = src.slice(src.indexOf('// 大檔分塊傳輸 (LEARNINGS §1)'), src.indexOf('}, [publicKey, cryptoReady, encrypt]);'));
const grab = (name, until) => {
  const a = ft.indexOf(`${name}: async (peer, payload) => {`);
  const b = ft.indexOf(until, a);
  assert.ok(a >= 0 && b > a, `found ${name}`);
  return `const ${name} = ` + ft.slice(a + name.length + 2, b).trim().replace(/,$/, '') + ';\n';
};
const code = transformSync(grab('sendManifest', 'getBufferedAmount:') + grab('sendControl', '});\n\n    const unsubReceived')
  + 'globalThis.api = { sendManifest, sendControl };', { loader: 'ts' }).code;

function setup() {
  const st = { live: true, sent: [], freed: 0, made: 0, dropAfterEncrypt: false };
  const ctx = {
    JSON, Date,
    active: () => st.live,
    encrypt: async (_peer, text) => {
      st.made++;
      if (st.dropAfterEncrypt) st.live = false;
      return { toJson: () => `ct(${text.length})`, free: () => { st.freed++; } };
    },
    sendViaP2P: (peer, payload) => { st.sent.push([peer, payload]); },
  };
  runInNewContext(code, { ...ctx, globalThis: ctx });
  return { api: ctx.api, st };
}

const manifest = { messageId: 'm1', fileId: 'f1', caption: 'hi', timestamp: 1 };
// 1
{
  const { api, st } = setup();
  await api.sendManifest('B', manifest);
  await api.sendControl('B', { kind: 'ack', fileId: 'f1' });
  assert.equal(st.sent.length, 2);
  assert.equal(st.made, 2);
  assert.equal(st.freed, 2, 'each RatchetMessage from a manifest / file_ctl is freed after sending');
}
console.log('PASS manifest and file_ctl free their RatchetMessage after sending');
// 2
{
  const { api, st } = setup();
  st.dropAfterEncrypt = true;
  await api.sendManifest('B', manifest);
  assert.equal(st.sent.length, 0, 'not sent when the account changed during encryption');
  assert.equal(st.freed, 1, 'but the RatchetMessage is still freed');
  st.live = true; st.dropAfterEncrypt = true;
  await api.sendControl('B', { kind: 'busy', fileId: 'f1' });
  assert.equal(st.sent.length, 0);
  assert.equal(st.freed, 2);
}
console.log('PASS a manifest dropped after an account switch still frees its RatchetMessage');

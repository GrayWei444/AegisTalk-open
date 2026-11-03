/**
 * 抽出 AppProvider 片段來跑的測試共用：片段會用到的模組層 helper（真的 services/visibleTypes.ts），
 * 放進 runInNewContext 的 context 裡。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const ROOT = new URL('../../packages/pwa/', import.meta.url).pathname;
const { transformSync } = createRequire(ROOT + 'package.json')('esbuild');
const module = { exports: {} };
runInNewContext(transformSync(readFileSync(ROOT + 'src/services/visibleTypes.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module, exports: module.exports, Set });

/** 真的 visibleTypeOf／DIRECT_VISIBLE_TYPES／GROUP_VISIBLE_TYPES */
export const visibleTypes = { ...module.exports };

/** 真的 cleanPeerName（從 services/friendInvites.ts 抽出這一個函式；整個模組依賴太多） */
const invites = readFileSync(ROOT + 'src/services/friendInvites.ts', 'utf8');
const cpnAt = invites.indexOf('export function cleanPeerName(');
const cpnScope = {};
runInNewContext(transformSync(invites.slice(cpnAt, invites.indexOf('\n}\n', cpnAt) + 3).replace(/^export /, '')
  + '\nglobalThis.cleanPeerName = cleanPeerName;', { loader: 'ts' }).code, Object.assign(cpnScope, { globalThis: cpnScope }));
export const cleanPeerName = cpnScope.cleanPeerName;

/**
 * processEncryptedMessage 用到、但不是這些測試要驗的：送達回條與重複訊息（direct_delivery_receipt／duplicate_receive
 * 測的是真的那一份）。預設「沒收過、回條照送」
 */
export const receiveScope = {
  hasMessageFrom: async () => false,
  sendDirectReceipt() {},
  confirmDelivered: () => 0,
};

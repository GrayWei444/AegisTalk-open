/**
 * 介面字串直接從受測原始碼的英文語系檔讀（模擬把語言設成 en），
 * 文案改了、或換成 AegisTalk 那份程式碼，選擇器跟著走，不用改模擬。
 * Node 22.18+/23.6+ 可以直接 import .ts（型別會被拿掉；en.ts 只有 `import type`）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function readAppStrings(pwaDir) {
  const file = path.join(pwaDir, 'src/i18n/locales/en.ts');
  const mod = await import(pathToFileURL(file).href);
  const dict = mod.default;
  return function t(key, params) {
    let v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict);
    if (typeof v !== 'string') throw new Error(`i18n key not found in ${file}: ${key}`);
    if (params) for (const [k, val] of Object.entries(params)) v = v.replaceAll(`{${k}}`, String(val));
    return v;
  };
}

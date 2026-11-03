/**
 * 模擬建置用的 Vite 設定：包住 App 自己的 vite.config.ts，只改「測試必須改」的幾件事。
 *
 * 改了什麼（都寫在報告裡，修 App 的人要知道模擬跟正式版差在哪）：
 *  1. 註冊時的刷臉關掉（features.default.ts 的 faceRecognition → false）。瀏覽器沒有臉，
 *     刷臉那一步一定過不了；關掉之後走 App 自己「沒開刷臉」的那條路：PIN → 名字 → 進 App。
 *     其餘程式一行都沒改。
 *  2. 不產 PWA service worker（模擬的瀏覽器本來就封鎖 service worker）。
 *  3. 只建主頁 index.html（遊戲頁用不到）。
 *  4. cacheDir／outDir 放在模擬資料夾（SIM_WORK_DIR），不寫進共用的 node_modules。
 *  5. W5：main.tsx 後面接上 scripts/sim/lib/simAdversary.ts（window.__simAdversary，只在 AEGIS_E2E_TEST 模式下掛）——
 *     讓模擬裡的手機做壞事（被踢的人再要金鑰、成員偽造踢人、admin 換金鑰漏掉某人、灌邀請），也讓模擬看得到 App 收到了什麼。
 *     正式版的 build 不經過這個設定檔，沒有它。
 *
 * API 位址由環境變數 VITE_API_URL 決定（App 的 define 會讀），一律指向本機。
 */
import path from 'node:path';
import fs from 'node:fs';
import appConfigFn from '../../packages/pwa/vite.config.ts';

const WORK = process.env.SIM_WORK_DIR;
if (!WORK) throw new Error('SIM_WORK_DIR is required (where dist/ and the vite cache go)');
if (!process.env.VITE_API_URL || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(process.env.VITE_API_URL)) {
  throw new Error('VITE_API_URL must point at the local sim server (http://127.0.0.1:<port>)');
}

const FEATURES_FILE = /[\\/]src[\\/]config[\\/]features\.default\.ts$/;
const MAIN_FILE = /[\\/]packages[\\/]pwa[\\/]src[\\/]main\.tsx$/;
const ADVERSARY = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'lib/simAdversary.ts');

/** W5：模擬的 dist 多載一個 simAdversary.ts（見檔頭 5.）；找不到 main.tsx 就讓建置失敗（不要默默少了它） */
function simAdversaryHook() {
  let hooked = false;
  return {
    name: 'sim-adversary-hook',
    enforce: 'pre',
    transform(code, id) {
      if (!MAIN_FILE.test(id.split('?')[0])) return null;
      hooked = true;
      return { code: `${code}\nimport ${JSON.stringify(ADVERSARY)};\n`, map: null };
    },
    buildEnd(err) {
      if (!err && !hooked) throw new Error('sim-adversary-hook: main.tsx was never transformed');
    },
  };
}

function simFeaturesOverride() {
  return {
    name: 'sim-features-override',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0];
      if (!FEATURES_FILE.test(file)) return null;
      const src = fs.readFileSync(file, 'utf8');
      const out = src.replace(/faceRecognition:\s*true/g, 'faceRecognition: false');
      if (out === src) throw new Error(`sim-features-override: faceRecognition flag not found in ${file}`);
      return out;
    },
  };
}

export default async (env) => {
  const base = typeof appConfigFn === 'function' ? await appConfigFn(env) : appConfigFn;
  const plugins = (base.plugins || []).flat(Infinity).filter((p) => {
    const name = p && p.name;
    // vite-plugin-pwa 會展開成好幾個 vite-plugin-pwa* 外掛
    return !(typeof name === 'string' && name.startsWith('vite-plugin-pwa'));
  });
  const pwaRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../packages/pwa');
  return {
    ...base,
    cacheDir: path.join(WORK, 'vite-cache'),
    plugins: [simFeaturesOverride(), simAdversaryHook(), ...plugins],
    build: {
      ...base.build,
      outDir: path.join(WORK, 'dist'),
      emptyOutDir: true,
      reportCompressedSize: false,
      rollupOptions: {
        ...(base.build?.rollupOptions || {}),
        input: { main: path.join(pwaRoot, 'index.html') },
      },
    },
  };
};

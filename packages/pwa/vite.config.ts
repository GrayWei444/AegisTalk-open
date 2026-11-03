import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import fs from 'fs';

// 版本（開源第 5a 步）：AEGIS_EDITION=chat → 社群版（src/ext/chat）；official（這個 repo 的預設）→ 官方版（src/ext-official）。
//   App 只透過 '@ext' 取用版本的功能（防詐、AegisID、守護、AegisPay、網路防護）；匯出的開源版預設 chat。
const EDITION_ENV = process.env.AEGIS_EDITION ?? 'chat';
if (EDITION_ENV !== 'chat' && EDITION_ENV !== 'official') {
  throw new Error(`AEGIS_EDITION must be "chat" or "official" (got "${EDITION_ENV}")`);
}
const EDITION: 'chat' | 'official' = EDITION_ENV;
const EXT_DIR = EDITION === 'chat' ? './src/ext/chat' : './src/ext-official';
const EXT_ENTRY = EDITION === 'chat' ? './src/ext/chat/index.tsx' : './src/ext-official/index.ts';

// 推播型別的版本（開源第 4 步：services/pushRequest.appEdition 只看 VITE_AEGIS_EDITION）：社群版不可以宣稱是官方版。
//   .env 檔裡的 VITE_* 要等 mode 確定才讀得到 → 用 config hook 跟 loadEnv 一起看
const editionGuard = {
  name: 'aegis-edition-guard',
  config(_: unknown, { mode }: { mode: string }) {
    if (EDITION === 'chat' && { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }.VITE_AEGIS_EDITION === 'official') {
      throw new Error('VITE_AEGIS_EDITION=official cannot be combined with AEGIS_EDITION=chat');
    }
  },
};

// 社群版的 public/：只有官方版用的靜態檔（裝置上語音辨識的 sherpa-onnx 模型與 WASM、通話語音分析的 worklet、防詐語音的
//   測試音檔與測試頁、prep 產生的臉部模型／ONNX runtime／MediaPipe）不進社群版的 dist。官方版照舊整個 public/ 複製。
const OFFICIAL_ONLY_PUBLIC = /^(sherpa-onnx|sherpa-onnx-old-streaming|test-audio|models|mediapipe)\/|^wasm\/ort-|^(voice-test\.html|worklets\/ring-buffer-processor\.js)$/;
const chatPublicAssets = {
  name: 'aegis-chat-public-assets',
  apply: 'build' as const,
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: Uint8Array }): string }) {
    const root = path.resolve(__dirname, 'public');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    if (!fs.existsSync(root)) return;
    for (const file of walk(root)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!OFFICIAL_ONLY_PUBLIC.test(rel)) this.emitFile({ type: 'asset', fileName: rel, source: fs.readFileSync(file) });
    }
  },
};

// Content-Security-Policy per edition (開源第 5c 步)：index.html 是社群版的政策（不寫任何官方主機、沒有 MoonPay）；
//   官方版在這裡補上 src/ext-official/csp.json 的來源（MediaPipe CDN、MoonPay 的 frame／API、官方網頁）。對不上就讓建置失敗，
//   不會默默少了 MoonPay 的 frame-src。社群版的 connect-src 為什麼是 https: wss:（伺服器是執行期選的）見 index.html 與 services/connectPolicy.ts
const OFFICIAL_CSP: { scriptSrc: string[]; connectSrc: string[]; frameSrc: string[] } | null = EDITION === 'official'
  ? JSON.parse(fs.readFileSync(path.resolve(__dirname, 'src/ext-official/csp.json'), 'utf8'))
  : null;
function withOfficialSources(policy: string): string {
  if (!OFFICIAL_CSP) return policy;
  const add = (directive: string, sources: string[], replaceNone = false) => {
    const re = new RegExp(`(^|;)(\\s*${directive})\\s+([^;]*)`);
    const m = policy.match(re);
    if (!m) throw new Error(`aegis-edition-csp: ${directive} missing from index.html`);
    const current = m[3].trim().split(/\s+/).filter((s) => !(replaceNone && s === "'none'"));
    policy = policy.replace(re, `$1$2 ${[...current, ...sources.filter((s) => !current.includes(s))].join(' ')}`);
  };
  add('script-src', OFFICIAL_CSP.scriptSrc);
  add('connect-src', OFFICIAL_CSP.connectSrc);
  add('frame-src', OFFICIAL_CSP.frameSrc, true);
  return policy;
}
const editionCsp = {
  name: 'aegis-edition-csp',
  transformIndexHtml(html: string) {
    if (!OFFICIAL_CSP) return html;
    const re = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;
    if (!re.test(html)) throw new Error('aegis-edition-csp: no Content-Security-Policy meta in index.html');
    return html.replace(re, (_m, a: string, policy: string, b: string) => a + withOfficialSources(policy) + b);
  },
};

// 這份 dist 是哪個版本建的（開源第 5d 步）：Android 的 Gradle 檢查（app/build.gradle checkChatWebAssets／checkOfficialWebAssets）
//   讀 assets/public/aegis-edition.json —— 在官方版的樹裡建社群版的 APK、忘了重建網頁，就不會把官方版的網頁包進去
const editionMarker = {
  name: 'aegis-edition-marker',
  apply: 'build' as const,
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }) {
    this.emitFile({ type: 'asset', fileName: 'aegis-edition.json', source: JSON.stringify({ edition: EDITION }) + '\n' });
  },
};

// mode: 'production' (default for vite build) strips console.log/warn
// mode: 'debug' (vite build --mode debug) keeps all console output for ADB debugging
export default defineConfig(({ mode }) => ({
  base: '/',
  // 版本可見性：build hash 注入，啟動時打到 log（[DIAG:BUILD]）→ 可驗證雙方是否跑同一版,
  //   避免「測試其實跑在舊 bundle / stale cache」造成修法看似無效（GPT 抓到的測試盲點）。
  //   web build(容器) 與 iOS build(Mac) 都在 build 指令前帶 BUILD_HASH env。
  define: {
    __BUILD_HASH__: JSON.stringify((process.env.BUILD_HASH || 'dev') + '/' + mode + (EDITION === 'chat' ? '/chat' : '')),
    __AEGIS_EDITION__: JSON.stringify(EDITION),
  },
  resolve: {
    alias: {
      // 葉節點入口（stores／useCrypto／deviceClaim／voiceCall 用，不經整個擴充，避免多出循環 import）要排在 '@ext' 前面
      '@ext/backup': path.resolve(__dirname, EXT_DIR, 'backup.ts'),
      '@ext/callAnalysis': path.resolve(__dirname, EXT_DIR, 'callAnalysis.ts'),
      '@ext/server': path.resolve(__dirname, EXT_DIR, 'server.ts'),
      '@ext': path.resolve(__dirname, EXT_ENTRY),
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@config': path.resolve(__dirname, './src/config'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@services': path.resolve(__dirname, './src/services'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@types': path.resolve(__dirname, './src/types'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@plugins': path.resolve(__dirname, './src/plugins'),
    },
  },
  plugins: [
    editionGuard,
    editionCsp,
    editionMarker,
    ...(EDITION === 'chat' ? [chatPublicAssets] : []),
    wasm(),
    topLevelAwait(),
    react(),
    VitePWA({
      // 使用 injectManifest 以支援自定義 SW 邏輯 (Share Target POST)
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw-custom.ts',
      registerType: 'autoUpdate',
      // 強制 Service Worker 立即更新
      selfDestroying: false,
      includeAssets: ['favicon.svg', 'logo.webp', 'logo-transparent.png', 'logo-192.png', 'logo-512.png', 'logo-512-masked.png', 'splash-iphone.png', 'splash-iphone-s.png', 'splash-ipad.png', 'splash-android-xhdpi.png'],
      injectManifest: {
        // Exclude .data and .onnx (ASR models 230MB+) — load on demand, not precache
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,txt}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10MB
      },
      manifest: {
        name: 'AegisTalk Chat (community)',
        short_name: 'AegisTalk Chat',
        description: 'AegisTalk Chat (community): end-to-end encrypted chat on your own server',
        theme_color: '#1a3a5c',
        background_color: '#0d1b2a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'zh-TW',
        categories: ['social', 'utilities'],
        icons: [
          {
            src: '/logo-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/logo-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/logo-512-masked.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        // Phase 14: Share Target - 接收其他 App 分享的檔案
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: [
                  'image/*',
                  'video/*',
                  'audio/*',
                  'application/pdf',
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  'text/*',
                  'application/zip',
                  'application/x-rar-compressed',
                  'application/x-7z-compressed'
                ]
              }
            ]
          }
        }
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['sql.js'],
  },
  server: {
    port: 5173,
    host: true,
    // 允許 dev server 服務 sibling file: 依賴(@aegisrd/aegisai 等)的資產(WASM/模型)
    fs: { allow: [path.resolve(__dirname, '../../..')] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    // 社群版的 public/ 由 chatPublicAssets 挑過再放（官方版：整個複製，跟以前一樣）
    copyPublicDir: EDITION !== 'chat',
    sourcemap: false,
    // Strip console.log/warn in production — prevents sensitive data leakage in Release APK
    // Keeps console.error for real runtime errors
    minify: 'esbuild',
  },
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : [],
    pure: mode === 'production' ? ['console.log', 'console.warn', 'console.debug', 'console.info'] : [],
  },
  worker: {
    format: 'es',
  },
}));

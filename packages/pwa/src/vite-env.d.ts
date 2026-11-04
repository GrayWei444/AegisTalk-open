/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_MQTT_URL: string
  readonly VITE_TURN_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// vite define 注入的 build hash（版本可見性）
declare const __BUILD_HASH__: string;
/** 建置的版本（vite.config.ts 的 AEGIS_EDITION）；service worker 用它拿掉只有官方版需要的快取規則 */
declare const __AEGIS_EDITION__: 'chat' | 'official';
/** 設定頁顯示的版本號：vite.config.ts 從這個版本的 package.json 讀 */
declare const __APP_VERSION__: string;

// pdfjs-dist 無 exports map、legacy 子路徑沒同位 .d.ts（LEARNINGS §10）
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}

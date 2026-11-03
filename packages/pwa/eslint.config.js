import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        EventSource: 'readonly',
        WebSocket: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCIceCandidate: 'readonly',
        MediaStream: 'readonly',
        MediaRecorder: 'readonly',
        AudioContext: 'readonly',
        Notification: 'readonly',
        ServiceWorkerRegistration: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLAudioElement: 'readonly',
        Image: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        location: 'readonly',
        performance: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        BroadcastChannel: 'readonly',
        IDBDatabase: 'readonly',
        IDBOpenDBRequest: 'readonly',
        // ServiceWorker / Web Worker
        self: 'readonly',
        importScripts: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        // Capacitor
        Capacitor: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      // TypeScript overrides
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-undef': 'off', // TypeScript handles this
      'no-redeclare': 'off', // TypeScript handles this

      // React hooks
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Disable noisy rules for existing codebase
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': 'warn',
      'no-async-promise-executor': 'warn',
    },
  },
  // 版本邊界（開源第 5a 步）：src/ext-official 以外的程式（公開的社群版會用到的全部）不准 import 官方版的實作、
  // 私有套件或只有防詐／金流用的套件 —— 一律經 '@ext'（src/ext/types.ts）。動態 import() 這條規則看不到，
  // 由 scripts/review/chat_edition_boundary_self_test.mjs 打包社群版整個入口檢查。
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/ext-official/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/ext-official', '**/ext-official/**', '@/ext-official/**'], message: 'Official-only code: use the @ext extensions (src/ext/types.ts).' },
          { group: ['@aegisrd/*', '@aegisrd/**'], message: 'Private package: only src/ext-official may import it.' },
          { group: ['onnxruntime-web', 'onnxruntime-web/**', '@mediapipe/*', 'mammoth', 'jszip', 'opencc-js', '@moonpay/*', '@transak/*', '@crossmint/*', 'viem', 'viem/*'], message: 'Anti-fraud / payments-only package: only src/ext-official may import it.' },
        ],
      }],
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'android/**',
      'ios/**',
      'src/wasm/**',
      '*.config.js',
      '*.config.ts',
      'public/**',
    ],
  },
];

#!/usr/bin/env node
/**
 * The web build's SQLite: in a browser @capacitor-community/sqlite runs on jeep-sqlite, which loads sql.js's
 * `sql-wasm.wasm` from the site root. Copy it from the installed sql.js into public/ (a build product, not in git), so
 * `vite build` puts it into dist/. Without it the web app cannot open its database ("both async and sync fetching of the
 * wasm failed") and never gets past account setup. The community manifest's `prep:chat` runs this
 * (scripts/sim/prepare.sh does too when the script exists). Android and iOS use the native SQLite and do not need it.
 *
 *   node scripts/copy-sqlite-wasm.mjs        (from packages/pwa)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pwa = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(pwa, 'package.json'));
let src;
try {
  src = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');   // sql.js main is dist/sql-wasm.js
} catch {
  console.error('[copy-sqlite-wasm] sql.js is not installed: npm ci in packages/pwa');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`[copy-sqlite-wasm] ${src} not found (sql.js layout changed?)`);
  process.exit(1);
}
const dest = path.join(pwa, 'public', 'sql-wasm.wasm');
const data = fs.readFileSync(src);
if (fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), data) === 0) {
  console.log(`[copy-sqlite-wasm] public/sql-wasm.wasm is current (${data.length} bytes)`);
} else {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  console.log(`[copy-sqlite-wasm] public/sql-wasm.wasm ← ${path.relative(pwa, src)} (${data.length} bytes)`);
}

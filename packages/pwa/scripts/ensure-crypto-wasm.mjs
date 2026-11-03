/**
 * 確保 E2EE 核心 WASM 是「從這份 packages/crypto-core 原始碼」建出來的，不是就用 build.sh 重建。
 *
 * `src/wasm/` 是產物、被 .gitignore 排除，`services/crypto.ts` 直接 `import … from '../wasm/pkg/safetalk_core'`
 * （X3DH + Double Ratchet）。建置一律走 `packages/crypto-core/build.sh --install`：rustc 由 rust-toolchain.toml 釘住、
 * 依賴由 Cargo.lock 釘住（--locked）、路徑重新對應，產物可以拿 REPRODUCIBLE*.sha256 核對（build.sh --verify）。
 *
 * 只看檔案在不在不夠（2026-10-26）：舊版 crate 會把共享密鑰、DH 輸出、鏈金鑰的前 8 bytes 印到 console，
 * 開發機上留著的舊 pkg（或從別台機器複製過來的檔案）會被一直沿用。所以每次建完寫一個戳記：
 * 原始碼的 SHA-256 ＋ 五個產物各自的 SHA-256；原始碼變了、任何一個產物不見或內容不同，就重建。
 * 缺 Rust 工具鏈時印出安裝方式並中止，不讓 vite 之後才報看不懂的 module not found。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '../src/wasm/pkg');
const stampFile = resolve(pkgDir, '.crypto-core-source.json');
const crateDir = resolve(here, '../../crypto-core');
const buildScript = resolve(crateDir, 'build.sh');
const STAMPED = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.sh'];
/** build.sh --install 放進 src/wasm/pkg 的檔案 */
const OUTPUTS = ['safetalk_core_bg.wasm', 'safetalk_core.js', 'safetalk_core.d.ts', 'safetalk_core_bg.wasm.d.ts', 'package.json'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function listRs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listRs(p);
    return e.name.endsWith('.rs') ? [p] : [];
  });
}

/** 原始碼的 SHA-256：固定順序的「相對路徑 NUL 內容 NUL」 */
function sourceHash() {
  const files = [...STAMPED.map((f) => join(crateDir, f)), ...listRs(join(crateDir, 'src')).sort()];
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(crateDir, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

/** 產物各自的 SHA-256；少一個就回 null */
function outputHashes() {
  const out = {};
  for (const name of OUTPUTS) {
    const p = join(pkgDir, name);
    if (!existsSync(p)) return null;
    out[name] = sha256(readFileSync(p));
  }
  return out;
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return null;
  }
}

if (!existsSync(buildScript)) {
  console.error(`[crypto-wasm] 找不到 ${buildScript}，無法建置 E2EE 核心。`);
  process.exit(1);
}

const source = sourceHash();
const stamp = readStamp();
const have = outputHashes();
const fresh = stamp && have && stamp.source === source
  && OUTPUTS.every((name) => stamp.files?.[name] === have[name]);
if (fresh) process.exit(0);

console.log(have
  ? '[crypto-wasm] src/wasm/pkg 不是這份原始碼建的（戳記不同、沒有戳記或檔案被換過），從 packages/crypto-core 重建…'
  : '[crypto-wasm] src/wasm/pkg 不存在或不完整，從 packages/crypto-core 建置…');
try {
  execFileSync('bash', [buildScript, '--install'], { stdio: 'inherit' });
} catch {
  console.error('[crypto-wasm] 建置失敗。需要 rustup、wasm-pack 0.13.1 與 C linker，見 packages/crypto-core/README.md。');
  process.exit(1);
}
const built = outputHashes();
if (!built) {
  console.error('[crypto-wasm] build.sh --install 之後 src/wasm/pkg 還是缺檔案。');
  process.exit(1);
}
writeFileSync(stampFile, `${JSON.stringify({ source, files: built }, null, 2)}\n`);
console.log('[crypto-wasm] 完成 → src/wasm/pkg/');

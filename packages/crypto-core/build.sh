#!/usr/bin/env bash
# 從 packages/crypto-core 的原始碼建出 E2EE 核心 WASM（X3DH + Double Ratchet）。
#
# 用法：
#   packages/crypto-core/build.sh                 # 建到 packages/crypto-core/target/pkg，印出 SHA-256
#   packages/crypto-core/build.sh --verify        # 建完後比對 REPRODUCIBLE*.sha256，不一致就失敗
#   packages/crypto-core/build.sh --install       # 建完後放進 packages/pwa/src/wasm/pkg（覆蓋現有檔案）
#   packages/crypto-core/build.sh --out-dir DIR   # 改輸出位置
#
# 可重現性：
#   - rustc 由 rust-toolchain.toml 釘在 1.90.0（rustup 會自動安裝）。
#   - 依賴版本由 Cargo.lock 釘住（--locked）。
#   - wasm-pack 需為 0.13.1（它決定 wasm-bindgen CLI 下載方式與 wasm-opt＝binaryen version_117）。
#   - 依賴原始碼路徑會被編進 panic 訊息；用 --remap-path-prefix 把 CARGO_HOME 與本目錄
#     換成固定字串，不同電腦、不同使用者名稱才會建出同一個檔案，也不會把建置者的家目錄寫進產物。
#   - host 端（build script、proc-macro）需要一個 C linker（Linux：build-essential；macOS：Xcode CLT）。
set -euo pipefail
# ⚠️ 變數後面緊接全形字元時一律寫 ${var}：macOS 內建的 bash 3.2 會把緊接的全形字元（「）」「，」「。」）當成變數名的一部分，
#    set -u 之下直接 "unbound variable"（2026-10-26 在 Mac 上實測）。

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
out_dir="$here/target/pkg"
verify=0
install=0
expected_wasm_pack="0.13.1"

while [ $# -gt 0 ]; do
  case "$1" in
    --verify) verify=1 ;;
    --install) install=1 ;;
    --out-dir) shift; out_dir="$1" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

for tool in rustup cargo wasm-pack; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[crypto-core] 缺少 ${tool}。安裝方式：" >&2
    echo "  curl https://sh.rustup.rs -sSf | sh" >&2
    echo "  cargo install wasm-pack --version $expected_wasm_pack --locked" >&2
    exit 1
  fi
done

wp_version="$(wasm-pack --version | awk '{print $2}')"
if [ "$wp_version" != "$expected_wasm_pack" ]; then
  echo "[crypto-core] 警告：wasm-pack ${wp_version} ≠ ${expected_wasm_pack}，產物的 SHA-256 可能不同。" >&2
  if [ "$verify" = 1 ]; then
    echo "[crypto-core] --verify 需要 wasm-pack ${expected_wasm_pack}。" >&2
    exit 1
  fi
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
remap="--remap-path-prefix=${cargo_home}=/cargo --remap-path-prefix=${here}=/crypto-core"

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

echo "[crypto-core] 建置中（rustc $(cd "$here" && rustc --version | awk '{print $2}')，wasm-pack ${wp_version}）…"
(
  cd "$here"
  RUSTFLAGS="${RUSTFLAGS:-} $remap" wasm-pack build --release --target web --out-dir "$out_dir" -- --locked
)

# wasm-pack 會把本目錄 README 與 .gitignore 複製進輸出；正式使用的 pkg 不含這兩個檔。
rm -f "$out_dir/README.md" "$out_dir/.gitignore"

echo "[crypto-core] 產物 SHA-256："
(cd "$out_dir" && sha256 safetalk_core_bg.wasm safetalk_core.js safetalk_core.d.ts safetalk_core_bg.wasm.d.ts package.json)

if [ "$verify" = 1 ]; then
  (cd "$out_dir" && sha256 -c "$here/REPRODUCIBLE.sha256")
  wasm_hash="$(sha256 "$out_dir/safetalk_core_bg.wasm" | awk '{print $1}')"
  if ! grep -v '^#' "$here/REPRODUCIBLE-wasm.sha256" | grep -qx "$wasm_hash"; then
    echo "[crypto-core] safetalk_core_bg.wasm $wasm_hash 不在 REPRODUCIBLE-wasm.sha256 裡。" >&2
    exit 1
  fi
  echo "[crypto-core] 與 REPRODUCIBLE.sha256／REPRODUCIBLE-wasm.sha256 一致。"
fi

if [ "$install" = 1 ]; then
  dest="$repo_root/packages/pwa/src/wasm/pkg"
  mkdir -p "$dest"
  cp "$out_dir"/safetalk_core_bg.wasm "$out_dir"/safetalk_core.js "$out_dir"/safetalk_core.d.ts \
     "$out_dir"/safetalk_core_bg.wasm.d.ts "$out_dir"/package.json "$dest/"
  echo "[crypto-core] 已放到 packages/pwa/src/wasm/pkg/"
fi

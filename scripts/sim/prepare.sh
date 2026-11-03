#!/usr/bin/env bash
# 把一份 App 原始碼（local-run.sh／remote-run.sh 放好的資料夾）建成模擬用的 dist。Linux 與 macOS 都可以
# （bash 3.2 也行：開源第 6 步從 zsh 改寫，local-run.sh 在這台機器上用、mac-job.sh 在 Mac 上用同一支）。
#
#   bash scripts/sim/prepare.sh <SIM_ROOT>
#
# SIM_ROOT 底下要有 packages/pwa、packages/crypto-core、scripts/sim（git archive 的結構）。
# 產物全部放在 $SIM_ROOT/.sim-work（dist、vite cache、cargo target），不寫進共用目錄：
#  - node_modules 是「連結農場」：每個套件各自 symlink 到共用的 node_modules（不 npm install），
#    vite 的 .vite 快取等寫入只會落在這個資料夾。
#  - 共用 node_modules 用 SIM_SHARED_NODE_MODULES 指定（local-run.sh：這份 repo 的 packages/pwa/node_modules）；
#    沒給就是 Mac 上的 ~/dev/AegisTalk/packages/pwa/node_modules（群星與 AegisTalk 共用大部分套件）。
# 環境變數：SIM_PORT（預設 41730，模擬伺服器的埠，會編進 VITE_API_URL）。
# 版本：$SIM_ROOT/.sim-edition（remote-run.sh --edition）＝ official（預設）或 chat。chat：AEGIS_EDITION=chat 建置，
#   連結農場不連 @aegisrd 與防詐／金流專用套件（社群版不可以需要它們：缺了就建置失敗），套件清單對 editions/chat/package.json。
set -euo pipefail
SIM_ROOT=${1:?usage: prepare.sh <SIM_ROOT>}
SIM_ROOT=$(cd "$SIM_ROOT" && pwd)
PWA=$SIM_ROOT/packages/pwa
WORK=$SIM_ROOT/.sim-work
SHARED=${SIM_SHARED_NODE_MODULES:-$HOME/dev/AegisTalk/packages/pwa/node_modules}
PORT=${SIM_PORT:-41730}
EDITION=$(cat "$SIM_ROOT/.sim-edition" 2>/dev/null || echo official)
[[ $EDITION == official || $EDITION == chat ]] || { echo "[prepare] bad edition $EDITION"; exit 1; }
mkdir -p "$WORK"

[[ -d $PWA/src ]] || { echo "[prepare] no $PWA/src"; exit 1; }
[[ -d $SHARED ]] || { echo "[prepare] shared node_modules not found: $SHARED (npm ci in packages/pwa, or set SIM_SHARED_NODE_MODULES)"; exit 1; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# 1) node_modules 連結農場
if [[ ! -d $PWA/node_modules ]]; then
  mkdir -p "$PWA/node_modules"
  for e in "$SHARED"/* "$SHARED"/.bin; do
    [[ -e $e ]] || continue
    name=$(basename "$e")
    # 社群版：私有套件與只有官方版用的套件不連（jszip 不在這裡：jeep-sqlite 要用）
    if [[ $EDITION == chat ]]; then
      case $name in
        @aegisrd|onnxruntime-web|onnxruntime-common|@mediapipe|mammoth|opencc-js|@moonpay|@transak|@crossmint|viem) continue ;;
      esac
    fi
    ln -s "$e" "$PWA/node_modules/$name"
  done
  echo "[prepare] linked $(ls "$PWA/node_modules" | wc -l | tr -d ' ') packages from $SHARED (edition $EDITION)"
fi
# 缺的套件列出來（缺了 vite build 會直接失敗，這裡先講清楚是哪個）。公開的 repo 只有一份清單（社群版的，就是 package.json）
MANIFEST=./package.json
[[ $EDITION == chat && -f $PWA/editions/chat/package.json ]] && MANIFEST=./editions/chat/package.json
missing=$(cd "$PWA" && MANIFEST=$MANIFEST node -e '
  const p=require(process.env.MANIFEST); const fs=require("fs");
  const all={...p.dependencies,...p.devDependencies};
  console.log(Object.keys(all).filter(d=>!fs.existsSync("node_modules/"+d+"/package.json")).join(" "));')
[[ -z $missing ]] || echo "[prepare] WARNING missing packages: $missing"

# 2) E2EE 核心 WASM（src/wasm 是產物、不在 git）：用這份原始碼的 crypto-core 現編，跟 App 的 build 同一條路
#    （packages/pwa/scripts/ensure-crypto-wasm.mjs → build.sh --install：rustc 1.90.0、Cargo.lock --locked、路徑重新對應）。
#    編譯中間檔在 crypto-core/target（build.sh 只重新對應 crate 目錄與 CARGO_HOME，target 放在別處的話產物會帶別的路徑），裝好就刪。
#    Xcode 授權沒同意時 Xcode 的 cc 會拒絕連結（build script 要用）→ 有 Command Line Tools 就改用它。
#    local-run.sh 會先把這份 repo 已經建好的 src/wasm/pkg（含戳記）放進來：原始碼沒變，ensure-crypto-wasm.mjs 就不重建。
if [[ ! -f $PWA/src/wasm/pkg/safetalk_core_bg.wasm || ! -f $PWA/src/wasm/pkg/.crypto-core-source.json ]]; then
  echo "[prepare] building crypto-core wasm (ensure-crypto-wasm.mjs → build.sh --install)…"
  DEVDIR=""
  [[ -x /Library/Developer/CommandLineTools/usr/bin/cc ]] && DEVDIR=/Library/Developer/CommandLineTools
  ( cd "$PWA" && DEVELOPER_DIR=${DEVDIR:-${DEVELOPER_DIR:-}} \
      node scripts/ensure-crypto-wasm.mjs >"$WORK/wasm-pack.log" 2>&1 ) \
    || { tail -30 "$WORK/wasm-pack.log"; exit 1; }
  rm -rf "$SIM_ROOT/packages/crypto-core/target"   # 幾百 MB 的編譯中間檔，產物已經在 src/wasm/pkg
  # 跟 REPRODUCIBLE*.sha256 對一下（只記錄、不擋：雜湊是在 Linux x86_64 上量的）
  wasm_sha=$(sha256 "$PWA/src/wasm/pkg/safetalk_core_bg.wasm" | cut -d' ' -f1)
  if grep -qx "$wasm_sha" "$SIM_ROOT/packages/crypto-core/REPRODUCIBLE-wasm.sha256" \
      && ( cd "$PWA/src/wasm/pkg" && sha256 -c "$SIM_ROOT/packages/crypto-core/REPRODUCIBLE.sha256" >/dev/null 2>&1 ); then
    echo "[prepare] crypto-core wasm matches REPRODUCIBLE*.sha256 ($wasm_sha)"
  else
    echo "[prepare] WARNING crypto-core wasm does not match REPRODUCIBLE*.sha256 ($wasm_sha)"
  fi
else
  # 戳記還在：確認它對得上這份原始碼（對不上 ensure-crypto-wasm.mjs 會重建；缺 Rust 工具鏈就印出怎麼裝並停下）
  ( cd "$PWA" && node scripts/ensure-crypto-wasm.mjs >"$WORK/wasm-pack.log" 2>&1 ) || { tail -30 "$WORK/wasm-pack.log"; exit 1; }
  rm -rf "$SIM_ROOT/packages/crypto-core/target"
fi

# 3) 建置前要放進 public/ 的 runtime（App 自己的 prep 腳本，只寫這個資料夾的 public/；public/ 本身沒送過來）
#    AegisTalk 沒有 copy-sqlite-wasm.mjs（正式站的 sql-wasm.wasm 是另外放的）→ 直接從 sql.js 複製同一份
mkdir -p "$PWA/public"
# 社群版：ONNX runtime 與 MediaPipe 只有官方版用（套件也沒連進來；editions/chat 的 prep:chat 也不複製；sql-wasm.wasm 它照樣複製）
COPY_SCRIPTS="copy-sqlite-wasm copy-ort-wasm copy-mediapipe"
[[ $EDITION == chat ]] && COPY_SCRIPTS="copy-sqlite-wasm"
( cd "$PWA" && for s in $COPY_SCRIPTS; do
    if [[ -f scripts/$s.mjs ]]; then node "scripts/$s.mjs" || exit 1; fi
  done
  [[ -f public/sql-wasm.wasm ]] || cp node_modules/sql.js/dist/sql-wasm.wasm public/sql-wasm.wasm ) \
  >"$WORK/copy-runtime.log" 2>&1 || { tail -20 "$WORK/copy-runtime.log"; exit 1; }

# 4) vite build（正式模式：跟上線版一樣去掉 console.log/warn、沒有 StrictMode 雙跑）
SHA=$(cat "$SIM_ROOT/.sim-sha" 2>/dev/null || echo unknown)
echo "[prepare] vite build (sha=$SHA, edition=$EDITION, api=http://127.0.0.1:$PORT)…"
( cd "$PWA" && AEGIS_EDITION=$EDITION SIM_WORK_DIR=$WORK VITE_API_URL=http://127.0.0.1:$PORT BUILD_HASH=sim-$SHA \
    node node_modules/vite/bin/vite.js build --config ../../scripts/sim/vite.sim.config.mjs --logLevel warn ) \
  >"$WORK/vite-build.log" 2>&1 || { tail -40 "$WORK/vite-build.log"; exit 1; }
echo "$PORT" > "$WORK/dist/.sim-port"
# 版本標記（vite.config.ts editionMarker）：run.mjs 只看它決定版本；沒有或不是要求的版本 → 停（開源第 6 步）
marker=$(cat "$WORK/dist/aegis-edition.json" 2>/dev/null || true)
[[ -n $marker ]] || { echo "[prepare] the build wrote no aegis-edition.json (packages/pwa/vite.config.ts editionMarker)"; exit 1; }
[[ $marker == *"\"$EDITION\""* ]] || { echo "[prepare] the build is not the $EDITION edition: aegis-edition.json = $marker"; exit 1; }
if [[ $EDITION == chat ]]; then
  # 社群版的 dist 不可以有官方版的實作或私有 SDK（建置成功但被打包進來也算失敗）。只找壓縮後還在、只有官方程式才有的字串
  #   （log 文字、常數；不能用 FamilyGuard／@aegisrd 這種 i18n、客服信箱裡也有的字）。grep 沒找到會回 1：|| true（set -e）
  leaked=$(grep -rlF -e 'aegisid-pin-verifier-v1' -e 'AEGIS_FACEENGINE_HARNESS' -e '[DIAG:GRISK] GK L2 eval' -e '@aegisrd/' "$WORK/dist" 2>/dev/null | head -3 || true)
  [[ -z $leaked ]] || { echo "[prepare] chat dist contains official code: $leaked"; exit 1; }
  # 開源第 5c 步：社群版沒有預設伺服器，dist 裡一個官方站的主機都不該有（API、broker、CSP、STUN、客服信箱）
  hosts=$(grep -rlE -e 'aegisrd\.com' -e '31\.97\.71\.140' "$WORK/dist" 2>/dev/null | head -3 || true)
  [[ -z $hosts ]] || { echo "[prepare] chat dist names an official host: $hosts"; exit 1; }
fi
echo "[prepare] dist ready: $WORK/dist ($(du -sh "$WORK/dist" | cut -f1))"

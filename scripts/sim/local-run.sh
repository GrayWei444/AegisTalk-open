#!/usr/bin/env bash
# Run the 4-phone + Mallory group simulation on this machine (open-source step 6): the same run remote-run.sh does on a
# build machine over SSH, without one. Linux or macOS, bash 3.2 or newer.
#
#   scripts/sim/local-run.sh [--edition chat|official] [--scenarios S1,S2,...] [--port N] [--chrome PATH]
#                            [--playwright DIR] [--work DIR] [--out DIR] [--keep] [--headful]
#   (or from packages/pwa: npm run sim -- --edition chat)
#
#  --edition     chat: the community edition (the default when src/ext-official is not in this checkout);
#                official: the author's tree with src/ext-official and the private packages in node_modules
#  --scenarios   only these scenarios (default: all of them; SETUP always runs). A full run takes 50-60 minutes.
#  --port        port of the simulated server (default 41730 official / 41731 chat, so both editions can run at once)
#  --chrome      Chrome or Chromium to drive (default: $SIM_CHROME, else Playwright's own Chromium)
#  --playwright  a node_modules folder that contains playwright (default: $SIM_PLAYWRIGHT_DIR, else the app's node_modules)
#  --work        where the copy is built (default: .cache/sim/<commit>-<edition> in this repository; git ignores .cache/)
#  --out         where the report goes (default: test-results/sim-<edition>)
#  --keep        keep the work folder afterwards (default: deleted once the report is copied out)
#  --headful     show the browser windows
#
# What it does: copies the app sources of the working tree (tracked and new files, uncommitted changes included; not
# public/, android/, ios/) and scripts/sim to the work folder, writes the edition to .sim-edition, then
# scripts/sim/prepare.sh links the app's node_modules into the copy, package by package (chat: without the private and
# anti-fraud-only packages), reuses packages/pwa/src/wasm/pkg when it was built from the same crypto-core sources (otherwise builds it:
# Rust + wasm-pack, see packages/crypto-core/README.md), builds the app for the edition (the build writes
# dist/aegis-edition.json, which run.mjs reads) and scripts/sim/run.mjs runs the scenarios and audits.
#
# Needs: Node.js 20+, `npm ci` in packages/pwa, python3 (standard library only), git, and Playwright with a Chromium —
# Playwright is not one of the app's packages; install it once outside the repository:
#   npm install --prefix ~/.cache/aegistalk-sim playwright@1
#   ~/.cache/aegistalk-sim/node_modules/.bin/playwright install chromium
#   scripts/sim/local-run.sh --playwright ~/.cache/aegistalk-sim/node_modules
# Exit code: 0 when every scenario and audit passed, 1 when one failed, 2 when the run could not start (see the message).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PWA=$REPO/packages/pwa
# what the simulation needs from the app (scripts/review/sim_server_acl_self_test.mjs checks api/chat and the group log routes)
APP_PATHS=(packages/pwa packages/crypto-core api/chat api/group_log_routes.py)

EDITION=""
SCENARIOS=""
PORT=""
CHROME=${SIM_CHROME:-}
PW=${SIM_PLAYWRIGHT_DIR:-}
WORK=""
OUT=""
KEEP=0
HEADFUL=0
die() { echo "[local-run] $*" >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n ${2:-} ]] || die "$1 needs a value"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --edition) need_value "$@"; EDITION=$2; shift 2 ;;
    --scenarios) need_value "$@"; SCENARIOS=$2; shift 2 ;;
    --port) need_value "$@"; PORT=$2; shift 2 ;;
    --chrome) need_value "$@"; CHROME=$2; shift 2 ;;
    --playwright) need_value "$@"; PW=$2; shift 2 ;;
    --work) need_value "$@"; WORK=$2; shift 2 ;;
    --out) need_value "$@"; OUT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --headful) HEADFUL=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ── edition ──
HAS_OFFICIAL=0
[[ -d $PWA/src/ext-official ]] && HAS_OFFICIAL=1
if [[ -z $EDITION ]]; then
  if [[ $HAS_OFFICIAL == 1 ]]; then EDITION=official; else EDITION=chat; fi
  echo "[local-run] edition $EDITION (default for this checkout; --edition chat|official to choose)"
fi
[[ $EDITION == official || $EDITION == chat ]] || die "--edition must be chat or official"
[[ $EDITION == chat || $HAS_OFFICIAL == 1 ]] || die "--edition official needs packages/pwa/src/ext-official, which this checkout does not have (the public repository has the chat edition only)"
if [[ -z $PORT ]]; then
  if [[ $EDITION == chat ]]; then PORT=41731; else PORT=41730; fi
fi
[[ $PORT =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "--port must be a port number"

# ── tools ──
command -v git >/dev/null || die "git is needed (the sources are copied with git ls-files)"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
command -v node >/dev/null || die "Node.js 20 or newer is needed"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js $(node -v) is too old: 20 or newer"
SIM_PYTHON=${SIM_PYTHON:-python3}
command -v "$SIM_PYTHON" >/dev/null || die "python3 is needed (standard library only; SIM_PYTHON picks another interpreter)"
# the node_modules folder the app resolves its packages from (packages/pwa/node_modules after npm ci, or a hoisted one above)
MODULES=$(node -e 'const p = require("module").createRequire(process.argv[1]).resolve("vite");
  process.stdout.write(p.slice(0, p.lastIndexOf("/node_modules/") + "/node_modules".length));' "$PWA/package.json" 2>/dev/null) \
  || die "the app's packages are not installed: cd packages/pwa && npm ci"
PW_DIR=${PW:-$MODULES}
PW_DIR=${PW_DIR/#\~/$HOME}
node -e 'require("module").createRequire(process.argv[1] + "/noop.js").resolve("playwright")' "$PW_DIR" 2>/dev/null || die "Playwright not found in $PW_DIR.
  Install it once:  npm install --prefix ~/.cache/aegistalk-sim playwright@1 && ~/.cache/aegistalk-sim/node_modules/.bin/playwright install chromium
  then run:         scripts/sim/local-run.sh --playwright ~/.cache/aegistalk-sim/node_modules"
if [[ -n $CHROME ]]; then
  [[ -x $CHROME ]] || die "--chrome $CHROME is not an executable"
elif [[ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  node -e 'const { chromium } = require("module").createRequire(process.argv[1] + "/noop.js")("playwright");
    process.exit(require("fs").existsSync(chromium.executablePath()) ? 0 : 1)' "$PW_DIR" \
    || die "Playwright's Chromium is not installed: $PW_DIR/.bin/playwright install chromium (or pass --chrome <path>)"
fi
node -e 'const s = require("net").createServer(); s.once("error", () => process.exit(1)); s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close())' "$PORT" \
  || die "port $PORT on 127.0.0.1 is in use (another simulation?): pass --port"

# ── copy the sources ──
SHA=$(git -C "$REPO" rev-parse --short=8 HEAD 2>/dev/null || echo nocommit)
[[ -z $(git -C "$REPO" status --porcelain -- "${APP_PATHS[@]}" scripts/sim) ]] || SHA="$SHA-dirty"
WORK=${WORK:-$REPO/.cache/sim/$SHA-$EDITION}
OUT=${OUT:-$REPO/test-results/sim-$EDITION}
case $WORK in /|"$HOME"|"$REPO") die "--work must be a folder of its own (it is deleted and rebuilt)" ;; esac
rm -rf "$WORK"
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
# tracked files that exist and new files git does not ignore (uncommitted changes included)
( cd "$REPO" && git ls-files -co --exclude-standard -z -- "${APP_PATHS[@]}" scripts/sim \
  | while IFS= read -r -d '' f; do
      case $f in packages/pwa/public/*|packages/pwa/android/*|packages/pwa/ios/*) continue ;; esac
      if [[ -f $f ]]; then printf '%s\0' "$f"; fi
    done | tar --null -T - -cf - ) | tar -x -C "$WORK"
# the crypto WASM is a build product (not in git): reuse this tree's build; prepare.sh checks its stamp against the sources
rm -rf "$WORK/packages/pwa/src/wasm/pkg"
if [[ -f $PWA/src/wasm/pkg/safetalk_core_bg.wasm ]]; then
  mkdir -p "$WORK/packages/pwa/src/wasm"
  cp -R "$PWA/src/wasm/pkg" "$WORK/packages/pwa/src/wasm/pkg"
fi
# small files under public/ the build reads (scripts/sim/public-files.txt)
while read -r f; do
  [[ -z $f || $f == \#* ]] && continue
  if [[ -f $PWA/public/$f ]]; then
    mkdir -p "$WORK/packages/pwa/public/$(dirname "$f")"
    cp "$PWA/public/$f" "$WORK/packages/pwa/public/$f"
  fi
done < "$HERE/public-files.txt"
echo "$SHA" > "$WORK/.sim-sha"
echo "$EDITION" > "$WORK/.sim-edition"
echo "[local-run] $EDITION edition @ $SHA → $WORK ($(du -sh "$WORK" | cut -f1)), simulated server on 127.0.0.1:$PORT"

# ── build, run, report ──
collect() {
  mkdir -p "$OUT"
  rm -rf "$OUT/report"
  if [[ -d $WORK/.sim-work/report ]]; then cp -R "$WORK/.sim-work/report" "$OUT/report"; fi
  for log in "$WORK"/.sim-work/*.log; do
    if [[ -f $log ]]; then cp "$log" "$OUT/"; fi
  done
}
if ! SIM_PORT=$PORT SIM_SHARED_NODE_MODULES=$MODULES bash "$WORK/scripts/sim/prepare.sh" "$WORK"; then
  collect
  echo "[local-run] the build failed (logs in $OUT; the work folder stays: $WORK)" >&2
  exit 2
fi
export SIM_PYTHON
export SIM_PLAYWRIGHT_DIR=$PW_DIR
if [[ -n $CHROME ]]; then export SIM_CHROME=$CHROME; fi
ARGS=(--src "$WORK")
if [[ -n $SCENARIOS ]]; then ARGS+=(--scenarios "$SCENARIOS"); fi
if [[ $HEADFUL == 1 ]]; then ARGS+=(--headful); fi
set +e
# at most 110 minutes (a full run is 50-60; two scenarios wait 10 minutes each)
if command -v perl >/dev/null; then
  perl -e 'alarm shift; exec @ARGV' 6600 node "$WORK/scripts/sim/run.mjs" "${ARGS[@]}"
else
  node "$WORK/scripts/sim/run.mjs" "${ARGS[@]}"
fi
STATUS=$?
set -e
collect
if [[ -f $OUT/report/report.md ]]; then
  if [[ $KEEP == 0 ]]; then rm -rf "$WORK"; fi
  echo "[local-run] report: $OUT/report/report.md (exit $STATUS)"
else
  echo "[local-run] no report was written (exit $STATUS); the work folder stays: $WORK" >&2
  if [[ $STATUS == 0 ]]; then STATUS=1; fi
fi
exit $STATUS

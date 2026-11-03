#!/usr/bin/env bash
# Conformance run of the self-hosting stack (open-source step 6): bring up docker-compose.example.yml (the chat API +
# EMQX 5.8.9 with emqx/base.hocon.example) in a throw-away copy, run the outside-in checks against it, tear it down.
# Linux or macOS with Docker, bash 3.2 or newer.
#
#   scripts/selfhost/conformance.sh [--dist DIR] [--no-browsers] [--python PATH] [--playwright DIR] [--chrome PATH]
#                                   [--project NAME] [--out DIR] [--keep]
#
# Phase A, clients reach the API directly (CHAT_TRUSTED_PROXIES=none):
#   1. scripts/selfhost/selfhost_smoke.py — health, server-config, keys-only registration with an invite, tokens, broker
#      connect and refusals, retain rules, device claim with the "device replaced" notice through the broker, group log,
#      signed short code, device-transfer token
#   2. scripts/selfhost/two_browsers_e2e.mjs — two browsers with the community web build: choose the server, register,
#      add each other, messages both ways, no request to any other host (skip with --no-browsers)
# Phase B, the reverse-proxy settings of api/.env.example (CHAT_TRUSTED_PROXIES = the compose gateway 172.30.0.1 and a
#   CHAT_PROXY_TOKEN): the API is recreated with them; a token request without the proxy header is refused (403), with it
#   it gets as far as the signature check (401); selfhost_smoke.py passes with --proxy-token. This assumes the API sees
#   connections to the published port as coming from the gateway (docker's default userland proxy).
#
#  --dist        the community web build for phase A2 (default packages/pwa/dist; its aegis-edition.json must say "chat":
#                cd packages/pwa && npm run build   in the public repository, or AEGIS_EDITION=chat npx vite build)
#  --no-browsers skip phase A2 (then Node.js and Playwright are not needed)
#  --python      Python 3.8+ with cryptography and paho-mqtt >= 2 (default $AEGISTALK_PYTHON, else python3;
#                pip install -r scripts/review/requirements-test.txt has both)
#  --playwright, --chrome   as for two_browsers_e2e.mjs (default $SIM_PLAYWRIGHT_DIR / $SIM_CHROME, else packages/pwa/node_modules
#                and Playwright's own Chromium)
#  --project     docker compose project name (default aegistalk-conformance)
#  --out         logs and screenshots (default test-results/conformance)
#  --keep        leave the stack running afterwards (the folder and the `docker compose ... down -v` command are printed)
#
# It needs the ports 8000, 8083, 18083 (and 48280 for the browsers) free on 127.0.0.1 and the subnet 172.30.0.0/24 unused,
# so it cannot run next to another copy of the stack on the same machine. Nothing in this repository is changed: the
# compose file, emqx/base.hocon.example and the chat server's files (api/chat_app.py, api/chat/, api/group_log_routes.py,
# the requirements) are copied to a temporary folder with freshly generated secrets.
# Exit code: 0 when every check passed, 1 when one failed, 2 when the run could not start.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

DIST=$REPO/packages/pwa/dist
BROWSERS=1
PY=${AEGISTALK_PYTHON:-python3}
PW=${SIM_PLAYWRIGHT_DIR:-}
CHROME=${SIM_CHROME:-}
PROJECT=aegistalk-conformance
OUT=$REPO/test-results/conformance
KEEP=0
API=http://127.0.0.1:8000
WEB_PORT=48280
die() { echo "[conformance] $*" >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n ${2:-} ]] || die "$1 needs a value"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) need_value "$@"; DIST=$2; shift 2 ;;
    --no-browsers) BROWSERS=0; shift ;;
    --python) need_value "$@"; PY=$2; shift 2 ;;
    --playwright) need_value "$@"; PW=$2; shift 2 ;;
    --chrome) need_value "$@"; CHROME=$2; shift 2 ;;
    --project) need_value "$@"; PROJECT=$2; shift 2 ;;
    --out) need_value "$@"; OUT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ── what is needed ──
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die "Docker with the compose plugin (docker compose) is needed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (is it running, may this user use it?)"
command -v "$PY" >/dev/null || die "Python not found: $PY (--python)"
"$PY" -c 'import cryptography, paho.mqtt.client as c; c.CallbackAPIVersion' 2>/dev/null \
  || die "$PY lacks cryptography or paho-mqtt >= 2: pip install -r scripts/review/requirements-test.txt (or: pip install cryptography 'paho-mqtt>=2')"
port_free() { "$PY" -c 'import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)' "$1"; }
PORTS="8000 8083 18083"
if [[ $BROWSERS == 1 ]]; then
  command -v node >/dev/null || die "Node.js 20+ is needed for the browser phase (or --no-browsers)"
  [[ -f $DIST/index.html ]] || die "no web build at $DIST: cd packages/pwa && npm run build (community manifest) or AEGIS_EDITION=chat npx vite build; or --no-browsers"
  grep -q '"chat"' "$DIST/aegis-edition.json" 2>/dev/null || die "$DIST is not a community build (aegis-edition.json must say \"chat\"): rebuild with AEGIS_EDITION=chat"
  PORTS="$PORTS $WEB_PORT"
fi
for p in $PORTS; do port_free "$p" || die "port $p on 127.0.0.1 is in use (another copy of the stack, or --keep from an earlier run?)"; done

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/aegistalk-conformance.XXXXXX")
dc() { (cd "$WORKDIR" && docker compose -p "$PROJECT" -f docker-compose.example.yml "$@"); }
finish() {
  local rc=$?
  set +e
  if [[ -d $WORKDIR ]]; then
    dc logs --no-color --timestamps > "$OUT/compose.log" 2>&1
    if [[ $KEEP == 1 ]]; then
      echo "[conformance] the stack keeps running (--keep): cd $WORKDIR && docker compose -p $PROJECT -f docker-compose.example.yml down -v"
    else
      dc down -v --remove-orphans >/dev/null 2>&1
      rm -rf "$WORKDIR"
    fi
  fi
  exit $rc
}
trap finish EXIT
trap 'exit 130' INT TERM

# ── a throw-away copy with new secrets ──
mkdir -p "$WORKDIR/api" "$WORKDIR/emqx"
cp "$REPO/docker-compose.example.yml" "$WORKDIR/"
cp "$REPO/emqx/base.hocon.example" "$WORKDIR/emqx/"
for f in chat_app.py group_log_routes.py requirements-chat.txt requirements-webpush.txt requirements-fcm.txt; do
  cp "$REPO/api/$f" "$WORKDIR/api/"
done
(cd "$REPO/api" && tar --exclude=__pycache__ -cf - chat) | tar -x -C "$WORKDIR/api"
secret() { "$PY" -c 'import secrets; print(secrets.token_hex(32))'; }
cat > "$WORKDIR/.env" <<EOF
AEGIS_MQTT_JWT_SECRET=$(secret)
EMQX_NODE_COOKIE=$(secret)
EMQX_DASHBOARD_PASSWORD=$(secret)
EOF
PROXY_TOKEN=$(secret)
# api/.env for one phase: direct (CHAT_TRUSTED_PROXIES=none) or proxy (the compose gateway + a proxy token, as api/.env.example)
write_api_env() {
  local proxies=none token=""
  if [[ $1 == proxy ]]; then proxies=172.30.0.1; token=$PROXY_TOKEN; fi
  cat > "$WORKDIR/api/.env" <<EOF
AEGIS_DB_PATH=/data/chat.db
CHAT_PUBLIC_MQTT_URL=ws://127.0.0.1:8083/mqtt
CHAT_APP_ORIGINS=http://127.0.0.1:$WEB_PORT
CHAT_TRUSTED_PROXIES=$proxies
CHAT_PROXY_TOKEN=$token
CHAT_REGISTRATION=invite
CHAT_REGISTER_PER_IP_HOUR=50
CHAT_REGISTER_PER_IP_DAY=200
CHAT_MQTT_ACL_FORMAT=rules
CHAT_SERVER_NAME=conformance
EOF
}

wait_up() {   # the API's /health (pip installs the requirements at every start) and the broker's ws port
  "$PY" - "$API/health" <<'PYEOF'
import json, socket, sys, time, urllib.request
end = time.time() + 420
def health():
    try:
        with urllib.request.urlopen(sys.argv[1], timeout=5) as r:
            return r.status == 200 and json.loads(r.read()).get("ok") is True
    except Exception:
        return False
def broker():
    try:
        socket.create_connection(("127.0.0.1", 8083), timeout=3).close()
        return True
    except OSError:
        return False
while time.time() < end:
    if health() and broker():
        time.sleep(3)   # EMQX accepts TCP a moment before its listeners are configured
        sys.exit(0)
    time.sleep(2)
sys.exit(1)
PYEOF
}
invite() { dc exec -T -u 10001 api python -m chat.invites create --uses 2 --days 1 --note "conformance $1" | tail -n 1 | tr -d '\r'; }

RESULTS=()
FAILED=0
step() {   # step <name> <command...>: run, log, remember the verdict
  local name=$1 log
  shift
  log="$OUT/$(echo "$name" | tr ' /' '__').log"
  echo "[conformance] ── $name"
  if "$@" 2>&1 | tee "$log"; then RESULTS+=("PASS  $name"); else RESULTS+=("FAIL  $name (log: $log)"); FAILED=1; fi
}

# ── phase A: direct ──
write_api_env direct
echo "[conformance] docker compose up (project $PROJECT, copy in $WORKDIR) — the first run pulls the images"
dc up -d >"$OUT/compose-up.log" 2>&1 || { tail -20 "$OUT/compose-up.log" >&2; die "docker compose up failed (log: $OUT/compose-up.log)"; }
wait_up || die "the API or the broker did not come up within 7 minutes (docker compose logs: $OUT/compose.log)"
NO_INVITE="could not create an invite code (python -m chat.invites in the api container; docker compose logs: $OUT/compose.log)"
CODE=$(invite smoke-direct) && [[ -n $CODE ]] || die "$NO_INVITE"
step "A1 selfhost_smoke (direct)" "$PY" "$HERE/selfhost_smoke.py" --api "$API" --invite "$CODE"
if [[ $BROWSERS == 1 ]]; then
  CODE=$(invite browsers) && [[ -n $CODE ]] || die "$NO_INVITE"
  BROWSER_ARGS=(--dist "$DIST" --api "$API" --invite "$CODE" --port "$WEB_PORT" --out "$OUT/browsers")
  if [[ -n $PW ]]; then BROWSER_ARGS+=(--playwright "$PW"); fi
  if [[ -n $CHROME ]]; then BROWSER_ARGS+=(--chrome "$CHROME"); fi
  step "A2 two_browsers_e2e" node "$HERE/two_browsers_e2e.mjs" "${BROWSER_ARGS[@]}"
else
  RESULTS+=("SKIP  A2 two_browsers_e2e (--no-browsers)")
fi

# ── phase B: behind the reverse proxy (settings of api/.env.example) ──
write_api_env proxy
dc up -d --force-recreate api >>"$OUT/compose-up.log" 2>&1 || die "recreating the api container failed (log: $OUT/compose-up.log)"
wait_up || die "the API did not come back with the proxy settings (docker compose logs: $OUT/compose.log)"
proxy_guard() {
  "$PY" - "$API" "$PROXY_TOKEN" <<'PYEOF'
import json, sys, time, urllib.error, urllib.request
api, token = sys.argv[1], sys.argv[2]
body = {"action": "mqtt_token", "pubkey": "A" * 43 + "=", "timestamp": int(time.time()), "request_id": "r" * 16,
        "signature": "S" * 88, "client_id": "mist_" + "A" * 16 + "_x", "groups": [], "presence": []}
def post(headers):
    req = urllib.request.Request(api + "/api/mqtt/token", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
ok = True
for name, headers, want in (("without the proxy header", {}, 403), ("with a wrong proxy token", {"X-Aegis-Internal": "x" * 64}, 403),
                            ("with the proxy token (stops at the signature check)", {"X-Aegis-Internal": token}, 401)):
    got = post(headers)
    print(("PASS " if got == want else "FAIL ") + f"token request {name}: {got} (want {want})")
    ok = ok and got == want
sys.exit(0 if ok else 1)
PYEOF
}
step "B1 token requests need the proxy" proxy_guard
CODE=$(invite smoke-proxy) && [[ -n $CODE ]] || die "$NO_INVITE"
step "B2 selfhost_smoke (behind the proxy)" "$PY" "$HERE/selfhost_smoke.py" --api "$API" --invite "$CODE" --proxy-token "$PROXY_TOKEN"

echo
echo "──────── conformance (docker-compose.example.yml, EMQX $(grep -o 'emqx/emqx:[0-9.]*' "$WORKDIR/docker-compose.example.yml" | cut -d: -f2)) ────────"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo "logs: $OUT"
exit $FAILED

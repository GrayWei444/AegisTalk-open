#!/usr/bin/env python3
"""
scripts/selfhost/conformance.sh without Docker (open-source step 6): what the runner gives the stack must be what the chat
server accepts, so a conformance run fails only on the stack, not on its own settings.
  1. the api/.env the runner writes for both phases (direct: CHAT_TRUSTED_PROXIES=none; proxy: the compose gateway + a token)
     passes the server's own start-up checks (api/chat/config.py ChatConfig.from_env), with the browser origin it serves
     the web build on and the broker URL the apps get; both phases use the invite policy
  2. the proxy phase trusts exactly the gateway of the compose network in docker-compose.example.yml
  3. the files it copies for the api container are the chat server's (no official module) and exist; their imports stay
     inside them (chat_app.py, chat/*, group_log_routes.py)
  4. the ports it checks are the ones the compose file publishes, and the checks it runs exist
Run: python3 scripts/review/selfhost_conformance_self_test.py   (needs cryptography; no Docker)
"""
import ast
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API_DIR = Path(os.environ.get("AEGISTALK_API_DIR", str(ROOT / "api")))
sys.path.insert(0, str(API_DIR))
from chat.config import ChatConfig  # noqa: E402

RUNNER = (ROOT / "scripts/selfhost/conformance.sh").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.example.yml").read_text(encoding="utf-8")
TMP = tempfile.mkdtemp(prefix="conformance-")
WEB_PORT = re.search(r"^WEB_PORT=(\d+)$", RUNNER, re.M).group(1)


def api_env(phase: str) -> dict:
    """the heredoc of write_api_env with the shell variables of that phase filled in"""
    body = re.search(r'cat > "\$WORKDIR/api/\.env" <<EOF\n(.*?)\nEOF\n', RUNNER, re.S)
    assert body, "write_api_env's heredoc is where this test expects it"
    values = {"WEB_PORT": WEB_PORT, "proxies": "none", "token": ""}
    if phase == "proxy":
        values.update(proxies="172.30.0.1", token="t" * 64)
    env = {}
    for line in body.group(1).split("\n"):
        key, _, value = line.partition("=")
        env[key] = re.sub(r"\$(\w+)", lambda m: values[m.group(1)], value)
    return env


# ── 1. both phases pass the server's start-up checks ──
for phase in ("direct", "proxy"):
    env = api_env(phase)
    assert env["AEGIS_DB_PATH"] == "/data/chat.db", "the database is on the compose volume"
    env = {**env, "AEGIS_DB_PATH": os.path.join(TMP, phase, "chat.db"), "AEGIS_MQTT_JWT_SECRET": "s" * 64}
    os.makedirs(os.path.dirname(env["AEGIS_DB_PATH"]))
    cfg = ChatConfig.from_env(env)
    assert cfg.registration == "invite", "the runner tests the default (invite) policy"
    assert cfg.public_mqtt_url == "ws://127.0.0.1:8083/mqtt"
    assert cfg.app_origins == (f"http://127.0.0.1:{WEB_PORT}",), cfg.app_origins
    assert bool(cfg.trusted_proxies) == (phase == "proxy"), phase
    assert cfg.register_limits.ip_per_hour >= 6, "smoke (2) + browsers (2) + smoke behind the proxy (2) register from one address"
print("PASS the api/.env of both phases passes ChatConfig.from_env (invite policy, local broker URL, the web build's origin)")

# ── 2. the proxy phase trusts the compose gateway ──
gateway = re.search(r"gateway:\s*([0-9.]+)", COMPOSE).group(1)
assert 'proxies=172.30.0.1' in RUNNER and gateway == "172.30.0.1", (gateway, "the proxy phase trusts the compose network's gateway")
assert "--proxy-token" in RUNNER and 'X-Aegis-Internal' in RUNNER
print("PASS the proxy phase trusts exactly the compose gateway and sends the proxy token")

# ── 3. what goes into the api container: the chat server, nothing official ──
copied = re.search(r"for f in ([^;]+); do\n  cp \"\$REPO/api/\$f\"", RUNNER).group(1).split()
assert "tar --exclude=__pycache__ -cf - chat" in RUNNER, "and the chat package"
assert set(copied) == {"chat_app.py", "group_log_routes.py", "requirements-chat.txt", "requirements-webpush.txt", "requirements-fcm.txt"}, copied
for f in copied:
    assert (API_DIR / f).is_file(), f
local = {"chat_app", "group_log_routes", "chat"}
for f in [API_DIR / "chat_app.py", API_DIR / "group_log_routes.py", *sorted((API_DIR / "chat").glob("*.py"))]:
    for n in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
        names = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module or ""] if isinstance(n, ast.ImportFrom) and n.level == 0 else []
        for name in names:
            top = name.split(".")[0]
            assert top in local or not (API_DIR / f"{top}.py").exists(), f"{f.name} imports api/{top}.py, which the conformance copy leaves out"
print(f"PASS the api container gets the chat server only ({', '.join(copied)}, chat/) and it imports nothing else from api/")

# ── 4. ports and checks ──
published = set(re.findall(r'"127\.0\.0\.1:(\d+):\d+"', COMPOSE))
checked = set(re.search(r'^PORTS="([^"]+)"', RUNNER, re.M).group(1).split())
assert {"8000", "8083", "18083"} <= published, published
assert checked == published - {"8080"}, (checked, published)   # 8080: the optional web profile, not started
for script in ("selfhost_smoke.py", "two_browsers_e2e.mjs"):
    assert f'"$HERE/{script}"' in RUNNER and (ROOT / "scripts/selfhost" / script).is_file(), script
assert "down -v" in RUNNER and "trap finish EXIT" in RUNNER, "the stack is torn down with its volumes, also on failure"
print("PASS the runner checks the published ports, runs selfhost_smoke.py and two_browsers_e2e.mjs, and always tears the stack down")

# ── 5. the api start command is one shell line ──
# A folded block (">-") joins lines with spaces only while they share one indentation; a deeper-indented line keeps its
# line break. The first Docker run (step 9) showed exactly that: sh got "exec setpriv ... --clear-groups" and then
# "uvicorn ..." as two commands ("setpriv: No program specified") and the api container restarted forever.
block = re.search(r"^(\s*)command: >-\n((?:\1\s+.*\n)+)", COMPOSE, re.M)
assert block, "the api service starts with a folded command block"
lines = block.group(2).splitlines()
indents = {len(l) - len(l.lstrip(" ")) for l in lines}
assert len(indents) == 1, f"the command block mixes indentations {sorted(indents)}: YAML keeps a line break there"
command = " ".join(l.strip() for l in lines)
assert re.search(r"exec setpriv [^\n]*--clear-groups uvicorn chat_app:create_app", command), command
print("PASS the api start command folds into one shell line (setpriv gets uvicorn as its program)")

# ── 6. the community web build carries the browser SQLite's wasm ──
# jeep-sqlite (the web fallback of @capacitor-community/sqlite) loads sql-wasm.wasm from the site root. The first browser
# run of the compose stack (step 9) failed account setup on "both async and sync fetching of the wasm failed": the
# community `npm run build` never put the file into dist (only the simulator's prepare.sh copied it).
import json  # noqa: E402
chat_manifest = ROOT / "packages/pwa/editions/chat/package.json"
if not chat_manifest.is_file():
    chat_manifest = ROOT / "packages/pwa/package.json"   # the public tree: the chat manifest is the only one
scripts = json.loads(chat_manifest.read_text(encoding="utf-8"))["scripts"]
assert "node scripts/copy-sqlite-wasm.mjs" in scripts["prep:chat"], scripts["prep:chat"]
assert all("npm run prep:chat" in scripts[s] for s in ("build", "dev")), "build and dev run prep:chat"
copier = (ROOT / "packages/pwa/scripts/copy-sqlite-wasm.mjs").read_text(encoding="utf-8")
assert "require.resolve('sql.js')" in copier and "'public', 'sql-wasm.wasm'" in copier, "copies sql.js's wasm to public/"
print("PASS the community build's prep copies sql.js's sql-wasm.wasm into public/ (the browser SQLite needs it)")

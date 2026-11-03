#!/usr/bin/env python3
"""
Open-source step 3 mutation check (standalone chat server, docs/SELF_HOSTING.md): each mutant removes one step-3 protection in a COPY
of the repository (the real tree is never touched); the named review tests must fail against the copy on an assertion (a crash, a
syntax error or a missing tool is ERROR, not a kill). Baseline first: every named test passes on an unmutated copy.
  python3 scripts/review/step3_mutants.py            # all mutants
  python3 scripts/review/step3_mutants.py "<name>"   # selected ones
Python tests run with $AEGISTALK_PYTHON (default: this interpreter; needs fastapi, pydantic 2, PyJWT, cryptography, httpx, pywebpush).
The copy goes to $STEP3_MUTANT_DIR (default: a .step3-mutants folder next to the repo; packages/pwa/node_modules is linked into it).
Mutants of official-only code come from mutants_official.py; without it (the public repository) they are not run (mutant_kit.py).
Exit code 0 only if every mutant is killed (and every pattern still matches the source).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('STEP3_MUTANT_DIR', str(Path(REPO).parent / '.step3-mutants'))
PY = os.environ.get('AEGISTALK_PYTHON', sys.executable)
C = 'api/chat/'
CFG, APP, WEB, SC, TOK, PUSH, MAIN, ADMIN, SIMACL, SCREQ = ('py:chat_config', 'py:chat_app', 'py:webpush', 'py:shortcode_signing',
    'py:mqtt_token_acl', 'py:push_endpoints', 'py:main_wiring', 'py:server_admin_endpoints', 'sim_server_acl', 'shortcode_request')
MUTANTS = [
  # ── 反向代理與 client IP（config.py） ──
  ('X-Forwarded-For believed from a trusted address without the token', C+'config.py', [
     ("        if not internal_ok(req):\n            return peer", "        if not trusted_peer(req):\n            return peer")], [CFG]),
  ('left-most X-Forwarded-For hop believed', C+'config.py', [("        for hop in reversed(hops):", "        for hop in hops:")], [CFG]),
  ('proxy token accepted from any address', C+'config.py', [
     ("        return bool(got) and trusted_peer(req) and hmac.compare_digest(got.encode(), secret)", "        return bool(got) and hmac.compare_digest(got.encode(), secret)")], [CFG, MAIN]),
  # ── 拒絕啟動（config.py） ──
  ('missing MQTT secret auto-generated', C+'config.py', [
     ('        mqtt_secret = p.secret("AEGIS_MQTT_JWT_SECRET", env.get("AEGIS_MQTT_JWT_SECRET") or "")',
      '        mqtt_secret = env.get("AEGIS_MQTT_JWT_SECRET") or __import__("secrets").token_hex(32)')], [CFG, MAIN]),
  ('short secrets accepted', C+'config.py', [("        elif len(value) < MIN_SECRET_LENGTH or value != value.strip():", "        elif False:")], [CFG, MAIN]),
  ('equal secrets accepted', C+'config.py', [('        p.distinct({"AEGIS_MQTT_JWT_SECRET": mqtt_secret,', '        (lambda *_: None)({"AEGIS_MQTT_JWT_SECRET": mqtt_secret,')], [CFG, MAIN]),
  ('ws:// broker URL accepted for any host', C+'config.py', [
     ('    return parts.scheme == "wss" or (parts.scheme == "ws" and parts.hostname in LOCAL_HOSTS)', '    return parts.scheme in ("ws", "wss")')], [CFG]),
  ('half-set VAPID pair accepted', C+'config.py', [("    if not (public and private):\n        p.items.append(", "    if False:\n        p.items.append(")], [CFG]),
  ('mismatched VAPID pair accepted', C+'config.py', [
     ('        p.check(hmac.compare_digest(derived, raw_public), "CHAT_VAPID_PUBLIC_KEY does not belong to CHAT_VAPID_PRIVATE_KEY")', '        pass')], [CFG]),
  ('unreadable FCM file accepted', C+'config.py', [
     ("        except (OSError, ValueError) as e:\n            self.items.append(f\"CHAT_FCM_CREDENTIALS: cannot read", "        except (OSError, ValueError) as e:\n            return\n            self.items.append(f\"CHAT_FCM_CREDENTIALS: cannot read")], [CFG, MAIN]),
  ('unwritable database folder accepted', C+'config.py', [
     ('            with tempfile.NamedTemporaryFile(dir=folder, prefix=".chat-write-check-"):\n                pass\n', '')], [CFG]),
  ('proxy list without a token accepted', C+'config.py', [('    p.secret("CHAT_PROXY_TOKEN", token)\n    return tuple(nets), token', '    return tuple(nets), token')], [CFG, MAIN]),
  ('a chat module that fails to import is ignored', 'api/chat_app.py', [("    if failed:\n        raise ChatConfigError(failed)", "    if False:\n        raise ChatConfigError(failed)")], [APP]),
  # ── keys-only 註冊（accounts.py） ──
  ('invite policy not enforced', C+'accounts.py', [
     ('        if policy == "invite" and not invite_code:', '        if False:'),
     ('        if policy == "invite":\n            row = cursor', '        if policy == "invite" and invite_code:\n            row = cursor')], [APP]),
  ('invite code uses never counted', C+'accounts.py', [
     ('            cursor.execute("UPDATE account_invites SET uses_left = uses_left - 1 WHERE code_hash = ?", (invite_hash(invite_code),))\n', '')], [APP]),
  ('no per-IP registration limit', C+'accounts.py', [("    for scope, per_hour, per_day in ((ip_scope, limits.ip_per_hour, limits.ip_per_day),",
                                                       "    for scope, per_hour, per_day in ((ip_scope, 10 ** 9, 10 ** 9),")], [APP]),
  ('registration request_id reusable', C+'accounts.py', [("        consume_request_nonce(cursor, key_hash, ACTION, request_id)\n", "")], [APP]),
  ('registration signature not checked', C+'accounts.py', [("        if not verify_device_signature(body.pubkey, body.signature, payload, body.timestamp):", "        if False:")], [APP]),
  ('registration clock skew not answered', C+'accounts.py', [("        check_clock(body.timestamp)\n        if not is_pubkey_b64(body.pubkey):", "        if not is_pubkey_b64(body.pubkey):")], [APP]),
  ('closed policy still registers', C+'accounts.py', [('        if policy == "closed":\n            raise AccountError(403, "registration_closed")\n', '')], [APP]),
  ('invite guessing not limited', C+'accounts.py', [("        if not mem_rate_peek(invite_failures, ip, 3600, INVITE_FAILURES_PER_IP_HOUR, now_f):", "        if False:")], [APP]),
  # ── MQTT token（mqtt_auth.py） ──
  ('token without an account on the chat server', C+'mqtt_auth.py', [("            if require_account and not account:", "            if False:")], [TOK, APP]),
  ('topic quota not enforced', C+'mqtt_auth.py', [('                if not admit_topics(cursor, account, [f"g|{g}"', '                if False and not admit_topics(cursor, account, [f"g|{g}"')], [TOK]),
  ('retain allowed on every publish rule', C+'mqtt_auth.py', [('        if topic not in keep:\n            rule["retain"] = False', '        if False:\n            rule["retain"] = False')], [TOK, SIMACL]),
  ('no deny-all at the end of the rules', C+'mqtt_auth.py', [('    rules.append({"permission": "deny", "action": "all", "topic": "#"})\n', '')], [TOK, SIMACL]),
  ('chat server does not require accounts for tokens', C+'__init__.py', [("require_account=keys_only_accounts)", "require_account=False)")], [APP]),
  # ── 短碼（shortcode.py） ──
  ('short code request signature not checked', C+'shortcode.py', [
     ("        if not verify_device_signature(body.public_key, body.request_signature, shortcode_signed_payload(body, action), body.timestamp):", "        if False:")], [SC, APP]),
  ('short code pre-key signature not checked', C+'shortcode.py', [("        if not prekey_signature_ok(body.public_key, body.signed_pre_key, body.signature):", "        if False:")], [SC]),
  ('short code without an account', C+'shortcode.py', [("            if not account_of(conn.cursor(), scope):", "            if False:")], [SC, APP]),
  ('short code request_id reusable', C+'shortcode.py', [('            consume_request_nonce(cursor, scope, "register_shortcode", request.request_id)\n', '')], [SC]),
  ('register signature works for refresh', C+'shortcode.py', [('        scope = authorize(req, request, "refresh_shortcode")', '        scope = authorize(req, request, "register_shortcode")')], [SC]),
  ('client signs the short code request non-canonically', 'packages/pwa/src/services/shortcodeRequest.ts', [
     ("signer.sign(new TextEncoder().encode(canonicalJson(body)))", "signer.sign(new TextEncoder().encode(JSON.stringify(body)))")], [SCREQ]),
  # ── 推播（push.py） ──
  ('web push endpoint not checked (SSRF)', C+'push.py', [("            if not webpush_endpoint_ok(request.endpoint, webpush_hosts):", "            if False:")], [WEB]),
  ('web push keys not checked', C+'push.py', [("            if not webpush_keys_ok(request.p256dh, request.auth):", "            if False:")], [WEB]),
  ('web push follows redirects', C+'push.py', [("        session.max_redirects = 0     # 推播服務不會重新導向；導向別處（內網）一律不跟\n", "")], [WEB]),
  ('web push registration unsigned', C+'push.py', [
     ("            _, pubkey_hash = signed_account(request.pubkey, request.signature, signed, request.timestamp)\n            if not webpush_endpoint_ok",
      "            pubkey_hash = __import__('hashlib').sha256(request.pubkey.encode()).hexdigest()\n            if not webpush_endpoint_ok")], [WEB, APP]),
  ('gone subscriptions kept', C+'push.py', [('            elif result == "gone":\n', '            elif False:\n')], [WEB]),
  ('push notify clock skew not answered', C+'push.py', [
     ("        check_clock(request.timestamp)\n        signed = {\"action\": \"push_notify\"", "        signed = {\"action\": \"push_notify\""),
     ("            check_clock(request.timestamp)\n            signed = {\"action\": \"push_register\"", "            signed = {\"action\": \"push_register\"")], [PUSH]),
  ('chat server accepts guardian/check-in pushes', C+'push.py', [("        if hint_type not in allowed_types:", "        if False:")], [PUSH, APP]),
  # ── 審查修正（第 3 步獨立審查） ──
  ('web push endpoint checked like before (urlsplit host, any characters)', C+'push.py', [
     ('    if not _URL_SAFE.fullmatch(endpoint) or "#" in endpoint:\n        return False\n', ''),
     ('    if not _HOST_RE.fullmatch(host) or (tail and not tail.startswith(("/", "?"))):', '    if not host:'),
     ('    if parsed.scheme != "https" or parsed.host != host or parsed.auth or parsed.port not in (None, 443):', '    if parsed.scheme != "https":')], [WEB]),
  ('web push endpoint not re-checked before sending', C+'push.py', [("        if self._hosts is not None and not webpush_endpoint_ok(endpoint, self._hosts):", "        if False:")], [WEB]),
  ('IPv6 limited per address, not per /64', C+'ratelimit.py', [("    if addr.version == 6:", "    if False:")], [CFG, APP]),
  ('quota rows written for keys without an account', C+'mqtt_auth.py', [
     ("            if account:\n                if not admit_topics(cursor, account,", "            if True:\n                account = account or \"pk:\" + pubkey_hash\n                if not admit_topics(cursor, account,")], [TOK]),
  ('own presence tags not counted', C+'mqtt_auth.py', [('                if presence_tag and not admit_topics(cursor, "tag:" + account', '                if False and not admit_topics(cursor, "tag:" + account')], [TOK]),
  ('over the tag limit the token keeps the presence-publish right', C+'mqtt_auth.py', [("                    presence_tag = None\n", "                    pass\n")], [TOK]),
  ('client ids not counted', C+'mqtt_auth.py', [('                if not admit_topics(cursor, "cid:" + account', '                if False and not admit_topics(cursor, "cid:" + account')], [TOK]),
  ('IP hashes keyed only with the database salt', C+'usage.py', [('    return hmac.new(_pepper["key"], db_salt, hashlib.sha256).digest() if _pepper["key"] else db_salt', '    return db_salt')], [APP]),
  ('broad proxy ranges accepted', C+'config.py', [("        if net.prefixlen < (8 if net.version == 4 else 16):", "        if net.prefixlen == 0:")], [CFG]),
  ('single-label push host accepted', C+'config.py', [("    return len(labels) >= 2 and len(host) <= 253 and all(", "    return len(labels) >= 1 and len(host) <= 253 and all(")], [CFG]),
  ('client does not re-sign after clock_skew', 'packages/pwa/src/components/Verification/FriendCode.tsx', [("        if (res.status === 401 && clockFixMs === 0) {", "        if (false) {")], [SCREQ]),
  ('client does not retry while the account is being created', 'packages/pwa/src/components/Verification/FriendCode.tsx', [("        if (res.status !== 403) break;", "        break;")], [SCREQ]),
  ('sim mock takes short codes without a request_id', 'scripts/sim/lib/mockApi.mjs', [
     ("      if (typeof rest.request_id !== 'string' || rest.request_id.length < 16 || rest.request_id.length > 128) return reject(422, 'request_id');\n", "")], [SIMACL]),
  # ── 模擬（帳號、retain） ──
  ('sim mock API does not require accounts', 'scripts/sim/lib/mockApi.mjs', [
     ("  const hasAccount = (pubkey) => !profile.accountsRequired || accounts.has(pubkey);", "  const hasAccount = () => true;")], [SIMACL]),
  ('sim broker ignores the retain condition', 'scripts/sim/lib/aclView.mjs', [
     ("    if (action === 'publish' && typeof r.retain === 'boolean' && r.retain !== !!retain) continue;\n", "")], [SIMACL]),
]
MUTANTS += kit.official_mutants('step3')

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json', 'packages/pwa/public/voice-test.html']


def make_copy(dst):
    # paths this checkout lacks are left out; the app's node_modules is linked in (mutant_kit.make_copy)
    kit.make_copy(dst, COPY_DIRS, COPY_FILES, ignore=('__pycache__', 'node_modules'))


ASSERTION = ('AssertionError', 'ERR_ASSERTION')


def failed_on_assertion(r):
    return r.returncode != 0 and any(a in (r.stdout + r.stderr) for a in ASSERTION)


def run_test(t, copy):
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'AEGISTALK_PYTHON': PY}
    try:
        if t.startswith('py:'):
            return subprocess.run([PY, f'{copy}/scripts/review/{t[3:]}_self_test.py'], cwd=copy, env=env, capture_output=True, text=True, timeout=900)
        return subprocess.run(['node', f'{copy}/scripts/review/{t}_self_test.mjs'], cwd=copy, env=env, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        return subprocess.CompletedProcess(e.cmd, 124, out, 'TIMEOUT')


only = set(sys.argv[1:])
selected = kit.runnable([m for m in MUTANTS if not only or m[0] in only])
os.makedirs(WORK, exist_ok=True)
copy = WORK + '/repo'
make_copy(copy)
baseline_bad = []
for t in sorted({t for m in selected for t in m[3]}):
    t0 = time.time()
    r = run_test(t, copy)
    print(f"baseline {t}: {'passes' if r.returncode == 0 else 'FAILS'} ({round(time.time() - t0)}s)", flush=True)
    if r.returncode != 0:
        baseline_bad.append(t)
        print('\n'.join((r.stdout + r.stderr).splitlines()[-8:]), flush=True)
if baseline_bad:
    shutil.rmtree(WORK, ignore_errors=True)
    print(json.dumps({'baseline_failed': baseline_bad}))
    sys.exit(2)
results = []
for name, f, reps, tests in selected:
    make_copy(copy)
    ok = True
    for old, new in reps:
        p = f'{copy}/{f}'
        s = open(p, encoding='utf-8').read()
        if s.count(old) != 1:
            ok = False
            print(f'!! {name}: pattern count {s.count(old)} in {f}: {old[:70]!r}', flush=True)
            break
        open(p, 'w', encoding='utf-8').write(s.replace(old, new))
    if not ok:
        results.append((name, 'BAD-PATTERN', []))
        continue
    outcome = []
    for t in tests:
        t0 = time.time()
        r = run_test(t, copy)
        lines = (r.stdout + r.stderr).splitlines()
        why = next((l.strip() for l in lines if any(a in l for a in ASSERTION)), '') or next((l.strip() for l in lines if 'Error' in l), '')
        state = 'passes' if r.returncode == 0 else ('FAILS' if failed_on_assertion(r) else 'ERROR')
        outcome.append((t, state, round(time.time() - t0), why[:160]))
    killed = any(o[1] == 'FAILS' for o in outcome)
    verdict = 'KILLED' if killed else ('ERROR' if any(o[1] == 'ERROR' for o in outcome) else 'SURVIVED')
    results.append((name, verdict, outcome))
    print(f"{verdict:8} {name}: " + '; '.join(f'{t} {st} ({sec}s) {why}' for t, st, sec, why in outcome), flush=True)
shutil.rmtree(WORK, ignore_errors=True)
killed = sum(r[1] == 'KILLED' for r in results)
print(json.dumps({'killed': killed, 'total': len(results), 'skipped': len(kit.SKIPPED)}))
sys.exit(0 if results and killed == len(results) else 1)

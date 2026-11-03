#!/usr/bin/env python3
"""
開源第 5b／5c 步的 mutation check（社群版登入、恢復包、X3DH_INIT 簽章、推播權限、伺服器切換；docs/EDITIONS.md §6–§7）：
每個 mutant 在 repo 的副本裡拿掉一項保護（真的樹不動），指定的 review 測試對著副本要失敗 —— 而且是斷言失敗（當掉、語法錯、
少工具算 ERROR，不算殺掉）。先跑基準：每支會用到的測試在沒改過的副本上都要過，不然 exit 2、一個 mutant 都不跑。
  python3 scripts/review/step5_mutants.py            # 全部
  python3 scripts/review/step5_mutants.py "<name>"   # 指定的
伺服器那一半（keys-only 註冊的簽章、invite 政策、次數、request_id、時鐘差）的 mutant 在 step3_mutants.py。
Python 測試與 account_register／recovery_kit／server_switch 的 Python 部分用 $AEGISTALK_PYTHON（fastapi／pydantic／cryptography／httpx），沒設就用 uv。
副本放在 $STEP5_MUTANT_DIR（預設 repo 旁邊的 .step5-mutants，node_modules 從上一層解析得到），跑完刪掉。
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('STEP5_MUTANT_DIR', str(Path(REPO).parent / '.step5-mutants'))
PY = kit.python_cmd(
    ['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography',
     '--with', 'httpx', '--with', 'pywebpush', '--with', 'uvicorn', 'python'])
W = 'packages/pwa/src/'
S = W + 'services/'
C = W + 'ext/chat/'
P = W + 'providers/AppProvider.tsx'
REG, KIT, X3, PUSH, SRV, IDN, BND, WEBPUSH = ('account_register', 'recovery_kit', 'x3dh_init_auth', 'push_permission', 'server_switch',
    'chat_identity', 'chat_edition_boundary', 'webpush_register')
MARK = 'x3dh_init_mark'
EXPIN = 'account_export_pin'
PICK = 'server_pick_switch'
FAILCLOSED = 'chat_auth_fail_closed'
DTM = W + 'components/DeviceTransfer/DeviceTransferModal.tsx'


def official_domain():
    """The official domain as chat_edition_boundary_self_test.mjs defines it (its OFFICIAL_HOST): the two mutants that put an
    official host back into the community build use the test's own definition instead of repeating the host here."""
    import re
    text = open(f'{REPO}/scripts/review/chat_edition_boundary_self_test.mjs', encoding='utf-8').read()
    m = re.search(r'^const OFFICIAL_HOST = /([^/|]+)', text, re.M)
    if not m:
        sys.exit('step5_mutants: chat_edition_boundary_self_test.mjs has no OFFICIAL_HOST regex')
    return m.group(1).replace('\\.', '.')


OD = official_domain()
MUTANTS = [
  # ── keys-only 註冊（client：ext/chat/registration.ts、ChatAuthScreen.tsx） ──
  ('registration signature does not cover the invite code', C+'registration.ts', [
     ("  if (inviteCode !== undefined) fields.invite_code = inviteCode;\n  const signature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(fields))));\n",
      "  const signature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(fields))));\n  if (inviteCode !== undefined) fields.invite_code = inviteCode;\n")], [REG]),
  ('registration signed over non-canonical JSON', C+'registration.ts', [
     ("signer.sign(new TextEncoder().encode(canonicalJson(fields)))", "signer.sign(new TextEncoder().encode(JSON.stringify(fields)))")], [REG]),
  ('registration ignores clock_skew', C+'registration.ts', [
     ("      deps.clock, deps.fetchImpl ?? fetch);", "      { now: () => Date.now(), adopt: () => {} }, deps.fetchImpl ?? fetch);")], [REG]),
  ('malformed invite code sent anyway', C+'registration.ts', [
     ("  if (code !== undefined && !INVITE_CODE_RE.test(code)) return { ok: false, code: 'invalid_invite' };\n", "")], [REG]),
  # security review L4: a slow PIN check is not "no account"; no silent wipe on kit restore
  ('slow PIN check shows a fresh install', C+'ChatAuthScreen.tsx', [
     ("        const hasPin = quick === 'slow' ? (localAccountVisible() || await pinCheck) : quick;", "        const hasPin = quick === 'slow' ? false : quick;")], [FAILCLOSED]),
  ('kit restore wipes an account without asking', C+'ChatAuthScreen.tsx', [
     ("        if (!window.confirm(s('mismatch.startOverConfirm'))) {", "        if (false) {")], [FAILCLOSED]),
  ('PIN written although the server refused the account', C+'ChatAuthScreen.tsx', [
     ("        setError(outcome.code === 'failed' ? s('reg.err.failed', { status: outcome.status ?? '?' }) : s(regMessageKey(outcome)));\n        return;\n      }\n      // PIN 寫入",
      "        setError(outcome.code === 'failed' ? s('reg.err.failed', { status: outcome.status ?? '?' }) : s(regMessageKey(outcome)));\n      }\n      // PIN 寫入")], [IDN]),
  # ── 恢復包（services/recoveryKit.ts、ext/chat/kitRestore.ts） ──
  ('kit header not authenticated (AAD dropped)', S+'recoveryKit.ts', [
     ("const aadOf = (h: KitHeader): ArrayBuffer => toBuffer(new TextEncoder().encode(canonical(h)));",
      "const aadOf = (h: KitHeader): ArrayBuffer => { void h; return toBuffer(new TextEncoder().encode('')); };")], [KIT]),
  ('kit KDF parameters not enforced', S+'recoveryKit.ts', [
     ("      || kdf.alg !== KIT_KDF.alg || kdf.m !== KIT_KDF.m || kdf.t !== KIT_KDF.t || kdf.p !== KIT_KDF.p) {", ") {")], [KIT]),
  ('kit extra header fields accepted', S+'recoveryKit.ts', [
     ("  if (keys !== 'cipher,created,ct,format,kdf,pass,v') throw new KitError('corrupt');\n", "")], [KIT]),
  ('weak chosen passphrase accepted', S+'recoveryKit.ts', [
     ("  if (passphrase.generated ? !isGeneratedShape(passphrase.value) : !passphraseStrength(passphrase.value).ok) {", "  if (false) {")], [KIT]),
  ('passphrase strength ignores repeats and runs', S+'recoveryKit.ts', [
     ("    effective += c === prev || Math.abs(c - prev) === 1 ? 0.25 : 1;", "    effective += 1; void prev;")], [KIT]),
  # security review M2: the kit and device transfer need the PIN (with its lockout)
  ('kit built without the PIN', C+'RecoveryKitExport.tsx', [
     ("  if (!(await deps.verifyPin(pin))) return { ok: false, reason: deps.isLockedOut() ? 'locked' : 'wrong_pin' };\n", "")], [EXPIN]),
  ('kit ignores the PIN lock', C+'RecoveryKitExport.tsx', [("  if (deps.isLockedOut()) return { ok: false, reason: 'locked' };\n", "")], [EXPIN]),
  ('kit modal builds without makeKitText', C+'RecoveryKitExport.tsx', [
     ("      const made = await makeKitText(pin, { value: passphrase, generated: !own });",
      "      const made = await makeKitText(pin, { value: passphrase, generated: !own }, { ...kitDeps, verifyPin: async () => true });")], [EXPIN]),
  ('device transfer without the PIN', DTM, [("  if (!(await deps.verifyPin(pin))) return false;\n", "")], [EXPIN]),
  ('transfer mode button starts the transfer directly', DTM, [
     ("            onClick={() => setPendingMode('transfer')}", "            onClick={() => scanner.confirmTransfer('transfer')}")], [EXPIN]),
  ('restore writes a kit whose key is another identity', C+'kitRestore.ts', [
     ("  if (derived !== blob.publicKey) throw new KitError('invalid_contents');\n", "")], [KIT]),
  ('kit server not validated', S+'recoveryKit.ts', [
     ("    server = parseCustomServer(c.server);\n    if (!server) throw new KitError('invalid_contents');", "    server = c.server as CustomServer;")], [KIT]),
  ('kit created not bound to the header', S+'recoveryKit.ts', [
     (" || body.created !== header.created) throw new KitError('invalid_contents');", ") throw new KitError('invalid_contents');")], [KIT]),
  # ── X3DH_INIT（services/x3dhInitAuth.ts、AppProvider.tsx） ──
  ('existing friend INIT not verified', P, [("          if (authVerdict !== 'ok') {", "          if (false) {")], [X3]),
  ('INIT signature does not cover sessionReset', S+'x3dhInitAuth.ts', [("    reset: p.sessionReset === true,\n", "")], [X3]),
  ('INIT signature not bound to the recipient', S+'x3dhInitAuth.ts', [("    from, to, iat,", "    from, iat,")], [X3]),
  ('INIT signature not domain-separated', S+'x3dhInitAuth.ts', [
     ("  return new TextEncoder().encode(`${X3DH_INIT_AUTH_DOMAIN}\\n${canonical(body)}`);", "  return new TextEncoder().encode(canonical(body));")], [X3]),
  ('stale INIT accepted', S+'x3dhInitAuth.ts', [
     ("  if (!(a.now - auth.iat <= INIT_AUTH_MAX_AGE_MS) || !(auth.iat - a.now <= INIT_AUTH_MAX_FUTURE_MS)) return 'stale';\n", "")], [X3]),
  ('no per-friend reset budget', P, [("        if (existingFriend && !initResetBudget.take(senderPublicKeyBase64, Date.now())) {", "        if (false) {")], [X3]),
  ('reset budget shared by all friends', S+'x3dhInitAuth.ts', [
     ("      const recent = (hits.get(peer) ?? []).filter((t) => now - t < windowMs);", "      peer = '*';\n      const recent = (hits.get(peer) ?? []).filter((t) => now - t < windowMs);")], [X3]),
  # security review M1: INIT freshness on the bounded clock, persisted newest-INIT mark per friend (x3dhReplay.ts)
  ('INIT freshness on the unbounded server clock', P, [
     ("now: mqttService.boundedNow(), verify: identityVerify })", "now: mqttService.serverNow(), verify: identityVerify })")], [MARK]),
  ('INIT older than the newest accepted one processed', P, [
     ("          if (publicKey && isInitOlderThanAccepted(publicKey, senderPublicKeyBase64, verifiedIat)) {", "          if (false) {")], [MARK]),
  ('accepted INIT leaves no newest-iat mark', P, [("payload.ephemeralPublicKey, verifiedIat);", "payload.ephemeralPublicKey);")], [MARK]),
  ('INIT marks kept in memory only', S+'x3dhReplay.ts', [
     ("  try { localStorage.setItem(INIT_IAT_KEY, JSON.stringify(kept)); }", "  try { void kept; }")], [MARK]),
  ('INIT mark lowered by an older accept', S+'x3dhReplay.ts', [("  if (marks[k] !== undefined && marks[k] >= iat) return;\n", "")], [MARK]),
  ('repair INIT sent unsigned', P, [
     ("            mqttService.sendToUser(f.publicKey, MessageType.X3DH_INIT, withInitAuth(f.publicKey, {", "            mqttService.sendToUser(f.publicKey, MessageType.X3DH_INIT, ((_to: string, p: object) => p)(f.publicKey, {")], [X3]),
  # ── 推播（ChatApp.tsx、webPush.ts、pushNotification.ts、storage.ts） ──
  ('web push registered without permission', W+'pages/ChatApp.tsx', [
     ("        if (granted && publicKey && !isNativeApp()) registerWebPush(publicKey).catch(() => {});", "        void granted; if (publicKey && !isNativeApp()) registerWebPush(publicKey).catch(() => {});")], [PUSH]),
  ('registerWebPush ignores the permission', S+'webPush.ts', [("    if (Notification.permission !== 'granted') return false;\n", "")], [PUSH, WEBPUSH]),
  ('pushNotification.subscribe prompts', S+'pushNotification.ts', [
     ("    if (!this.isSupported() || Notification.permission !== 'granted') return null;", "    if (!this.isSupported() || (await this.requestPermission()) !== 'granted') return null;")], [PUSH]),
  ('friend push subscription stored again', S+'storage.ts', [
     ("  const pushSubscriptionJson = null;", "  const pushSubscriptionJson = contact.pushSubscription ? JSON.stringify(contact.pushSubscription) : null;")], [PUSH]),
  ('old friend push subscriptions never cleared', S+'database.ts', [("const SCHEMA_VERSION = 13;", "const SCHEMA_VERSION = 12;")], [PUSH]),
  # ── 伺服器切換（serverChoice.ts、connectPolicy.ts、serverAccount.ts、App.tsx、ext/chat/server.ts、index.html） ──
  ('connect-src never narrowed', S+'connectPolicy.ts', [("  if (!server || serverPickRequested()) return false;", "  void server; return false;")], [SRV]),
  ('official connect list on a self-hosted server', S+'connectPolicy.ts', [
     ("  if (server.isOfficial) for (const s of editionExtras)", "  for (const s of editionExtras)")], [SRV]),
  ('broker URL accepts ws:// to a public host', S+'serverChoice.ts', [
     ("  if (u.protocol !== secure && !(u.protocol === plain && isLocalHost(u.hostname))) {", "  if (u.protocol !== secure && u.protocol !== plain) {")], [SRV]),
  ('discovery ignores the service id', S+'serverChoice.ts', [
     ("  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).service !== SERVICE_ID) {", "  if (!body || typeof body !== 'object') {")], [SRV]),
  ('discovery follows redirects', S+'serverChoice.ts', [("      redirect: 'error',\n", "")], [SRV]),
  ('account used on another server', S+'serverAccount.ts', [("  return owner && owner.key !== active.key ? owner : null;", "  void owner; return null;")], [SRV]),
  ('old installs adopted by any server', S+'serverAccount.ts', [
     ("  return hasDefaultServer() ? { key: DEFAULT_SERVER_KEY, server: null } : null;", "  return null;")], [SRV]),
  ('switching sends the old account to the new server unlocked', S+'serverSwitch.ts', [("  clearEncryptionKey();\n  try {", "  try {")], [SRV]),
  # security review L1: the pick flag lasts one page; that page never unlocks or connects
  ('pick flag not consumed at boot', S+'connectPolicy.ts', [
     ("    requested = sessionStorage.getItem(SERVER_PICK_FLAG) === '1';\n    sessionStorage.removeItem(SERVER_PICK_FLAG);\n",
      "    requested = sessionStorage.getItem(SERVER_PICK_FLAG) === '1';\n")], [PICK]),
  ('boot does not consume the pick flag', S+'connectPolicyBoot.ts', [("consumeServerPick();\nnarrowConnectSrc();", "void consumeServerPick;\nnarrowConnectSrc();")], [PICK]),
  ('MQTT token requested on the pick page', S+'mqttCredential.ts', [("  if (serverPickRequested()) throw new MqttTokenError(0, 'server_pick');\n", "")], [PICK]),
  ('community login unlocks on the pick page', C+'ChatAuthScreen.tsx', [
     ("        if (serverPickRequested()) {\n          setPickHasAccount", "        if (false) {\n          setPickHasAccount")], [PICK]),
  # security review L2: shut down first, store for the next load, the page keeps its server
  ('switch changes the page server before the shutdown', S+'serverSwitch.ts', [
     ("import { storeServerForNextLoad, type CustomServer } from './serverChoice';",
      "import { storeServerForNextLoad, saveCustomServer, clearCustomServer, type CustomServer } from './serverChoice';"),
     ("  localStorage.setItem(PROBE_KEY, JSON.stringify(next));\n  localStorage.removeItem(PROBE_KEY);\n",
      "  if (next) saveCustomServer(next); else clearCustomServer();\n")], [PICK]),
  ('stored next server replaces the page server', S+'serverChoice.ts', [
     ("  else localStorage.removeItem(SERVER_STORAGE_KEY);\n}", "  else localStorage.removeItem(SERVER_STORAGE_KEY);\n  cached = null;\n}")], [PICK]),
  ('switch signs out without checking the choice can be stored', S+'serverSwitch.ts', [
     ("  localStorage.setItem(PROBE_KEY, JSON.stringify(next));\n  localStorage.removeItem(PROBE_KEY);\n", "")], [PICK]),
  ('wipe keeps the PIN', S+'serverAccount.ts', [("  'mist_keys', 'mist_sessions', 'mist_pubkey_raw', 'mist_user_profile', 'mist_pin_hash', 'mist_pin_salt',",
     "  'mist_keys', 'mist_sessions', 'mist_pubkey_raw', 'mist_user_profile',")], [SRV]),
  ('App logs in although the account belongs to another server', W+'App.tsx', [
     ("      if (mismatch) return <ServerMismatchScreen owner={mismatch} />;\n", "")], [SRV]),
  ('community edition gets the official server as default', C+'server.ts', [
     ("export const defaultServer: EditionServerConfig | null = null;",
      f"export const defaultServer: EditionServerConfig | null = {{ apiUrl: 'https://api.{OD}', mqttUrl: 'wss://mqtt.{OD}/mqtt' }};")], [BND]),
  ('official broker back in the community CSP', 'packages/pwa/index.html', [
     ("      connect-src 'self' https: wss: blob:", f"      connect-src 'self' wss://mqtt.{OD} https: wss: blob:")], [BND]),
  # ── 換機、變更 PIN（ext/chat） ──
  ('chat transfer sends the behaviour baseline', C+'index.tsx', [
     ("    transferExtras: async () => ({}),", "    transferExtras: async () => ({ behaviorBaseline: localStorage.getItem('aegis_behavior_baseline') ?? undefined }),")], [IDN]),
  ('chat PIN change without a journal', C+'changePin.ts', [
     ("    localStorage.setItem(CHAT_PIN_JOURNAL, journal);\n    await setSetting(CHAT_PIN_JOURNAL, journal);\n", "    void journal;\n")], [IDN]),
  ('chat PIN change applies another account\'s journal', C+'changePin.ts', [
     ("      if (owner && data.owner !== owner) return null;   // another account's leftover: not ours to apply\n", "")], [IDN]),
]

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json', 'packages/pwa/tsconfig.chat.json', 'packages/pwa/vite.config.ts',
              'packages/pwa/index.html', 'packages/pwa/editions/chat/package.json']


def make_copy(dst):
    # paths this checkout lacks are left out; the app's node_modules is linked in (mutant_kit.make_copy)
    kit.make_copy(dst, COPY_DIRS, COPY_FILES, ignore=('__pycache__', 'node_modules', 'res'))


ASSERTION = ('AssertionError', 'ERR_ASSERTION', 'FAIL ')


def failed_on_assertion(r):
    return r.returncode != 0 and any(a in (r.stdout + r.stderr) for a in ASSERTION)


def run_test(t, copy):
    env = {**os.environ, 'AEGISTALK_PWA_SRC': f'{copy}/packages/pwa/src', 'AEGISTALK_API_DIR': f'{copy}/api', 'PYTHONDONTWRITEBYTECODE': '1'}
    try:
        if t.startswith('py:'):
            return subprocess.run(PY + [f'{copy}/scripts/review/{t[3:]}_self_test.py'], cwd=copy, env=env, capture_output=True, text=True, timeout=600)
        return subprocess.run(['node', f'{copy}/scripts/review/{t}_self_test.mjs'], cwd=copy, env=env, capture_output=True, text=True, timeout=600)
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
    copy = WORK + '/repo'
    make_copy(copy)
    ok = True
    for old, new in reps:
        p = f'{copy}/{f}'
        s = open(p).read()
        if s.count(old) != 1:
            ok = False; print(f'!! {name}: pattern count {s.count(old)} in {f}: {old[:70]!r}', flush=True); break
        open(p, 'w').write(s.replace(old, new))
    if not ok:
        results.append((name, 'BAD-PATTERN', [])); continue
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

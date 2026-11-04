#!/usr/bin/env python3
"""
開源第 5d 步的 mutation check（docs/DIRECT_SEALED.md §4「Push ring」「Group calls」、docs/EDITIONS.md §2）：每個 mutant 在 repo 的
副本裡拿掉一項 5d 的保護（真的樹不動），指定的測試對著副本要失敗 —— 而且是斷言失敗（當掉、語法錯、少工具算 ERROR，不算殺掉）。
先跑基準：每支會用到的測試在沒改過的副本上都要過，不然 exit 2、一個 mutant 都不跑。
  python3 scripts/review/step5d_mutants.py            # 全部
  python3 scripts/review/step5d_mutants.py "<name>"   # 指定的
  python3 scripts/review/step5d_mutants.py --no-jvm   # 不跑原生（Kotlin）的那幾個
Python 測試用 $AEGISTALK_PYTHON（有 fastapi／pydantic／cryptography／httpx 的直譯器），沒設就用 uv。
原生的 RingToken.kt 用 JVM 單元測試（jvm:RingTokenTest）：要一個建好過的社群版 Android 專案（Gradle 的相依已經在快取裡，--offline）——
  AEGISTALK_JVM_PROJECT  那個專案的 packages/pwa/android（本機路徑；或配 AEGISTALK_JVM_SSH 的遠端路徑）
  AEGISTALK_JVM_SSH      （選用）在別台機器跑：ssh 指令前綴，例如 "ssh -i ~/.ssh/key user@mac"；遠端用 zsh -lc 執行、JAVA_HOME 要設好
副本的 app/src 整份送過去蓋掉那個專案的 app/src，跑完送原本的回去。副本放在 $STEP5D_MUTANT_DIR（預設 repo 旁邊的 .step5d-mutants）。
每個 mutant 都被殺掉（而且每個樣式都還對得上原始碼）才 exit 0。
"""
import io, json, os, shlex, shutil, subprocess, sys, tarfile, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('STEP5D_MUTANT_DIR', str(Path(REPO).parent / '.step5d-mutants'))
PY = kit.python_cmd(
    ['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography',
     '--with', 'httpx', 'python'])
JVM_PROJECT = os.environ.get('AEGISTALK_JVM_PROJECT')
JVM_SSH = os.environ.get('AEGISTALK_JVM_SSH')
S = 'packages/pwa/src/services/'
K = 'packages/pwa/android/app/src/main/kotlin/com/aegisrd/talk/'
RT = 'ring_token'
DISPLAY = 'push_display'
CALL = 'call_state_machine'
WIPE = 'account_wipe_outbox'
GFP = 'group_call_fingerprint'
PUSHSIG = 'push_signing'
GLOG = 'guardian_logout'
SRV = 'py:push_ring_token'
JVM = 'jvm:RingTokenTest'
CAPNAV = 'capacitor_navigation'
MUTANTS = [
  # ── 響鈴 token（ringToken.ts） ──
  ('ring: signature not checked', S+'ringToken.ts', [("  if (!good) return { ok: false, reason: 'bad-signature' };\n", "")], [RT]),
  ('ring: recipient not checked', S+'ringToken.ts', [("  if (claims.to !== p.me) return { ok: false, reason: 'wrong-recipient' };\n", "")], [RT]),
  ('ring: push sender not compared', S+'ringToken.ts', [("  if (typeof p.sender === 'string' && p.sender !== claims.from) return { ok: false, reason: 'sender-mismatch' };\n", "")], [RT]),
  ('ring: any signer rings (no friend lookup)', S+'ringToken.ts', [("    stored = await p.friendKey(claims.from);", "    stored = claims.from;")], [RT]),
  ('ring: stale tokens ring', S+'ringToken.ts', [("  if (p.now - claims.iat > RING_MAX_AGE_MS) return { ok: false, reason: 'stale' };\n", "")], [RT]),
  ('ring: future tokens ring', S+'ringToken.ts', [("  if (claims.iat - p.now > RING_MAX_FUTURE_MS) return { ok: false, reason: 'future' };\n", "")], [RT]),
  ('ring: freshness window 50 minutes', S+'ringToken.ts', [("export const RING_MAX_AGE_MS = 5 * 60_000;", "export const RING_MAX_AGE_MS = 50 * 60_000;")], [RT]),
  ('ring: replay not checked', S+'ringToken.ts', [("  if (await p.replay.seen(claims.callId)) return { ok: false, reason: 'replay' };\n", "")], [RT]),
  ('ring: forged tokens burn the call id', S+'ringToken.ts', [("  if (!good) return { ok: false, reason: 'bad-signature' };",
     "  if (!good) { await p.replay.remember(claims.callId, claims.iat + RING_SEEN_RETENTION_MS); return { ok: false, reason: 'bad-signature' }; }")], [RT]),
  ('ring: seen calls kept only through the freshness window', S+'ringToken.ts', [
     ("export const RING_SEEN_RETENTION_MS = RING_MAX_AGE_MS + RING_MAX_FUTURE_MS + 2 * RING_CLOCK_CAP_MS;", "export const RING_SEEN_RETENTION_MS = RING_MAX_AGE_MS;")], [RT]),
  ('ring: stored offset not capped', S+'ringDirectory.ts', [("offsetMs: clampRingOffset(d.offsetMs), at:", "offsetMs: d.offsetMs, at:")], [RT]),
  ('ring sync: written back after logout', S+'ringSync.ts', [("    if (key === lastKey || cleared) return;", "    if (key === lastKey) return;")], [RT]),
  ('ring sync never reopens after a clear', S+'ringSync.ts', [("export function reopenRingSync(): void {\n  cleared = false;\n}", "export function reopenRingSync(): void {\n  void cleared;\n}")], [RT]),
  ('ring sync: offset from the unbounded server clock', S+'ringSync.ts', [("mqttService.boundedNow() - Date.now()", "mqttService.serverNow() - Date.now()")], [RT]),
  ('ring: domain not checked', S+'ringToken.ts', [("  if (claims.d !== p.prefix) return { ok: false, reason: 'wrong-domain' };\n", "")], [RT]),
  ('ring: signature not bound to the domain prefix', S+'ringToken.ts', [("  return concat(utf8(`${prefix}:`), claimsJson);", "  return claimsJson;")], [RT]),
  ('ring: non-canonical base64 accepted', S+'ringToken.ts', [("  return again === s ? out : null;", "  void again; return out;")], [RT]),
  ('ring: extra claims accepted', S+'ringToken.ts', [("'\"iat\":([1-9][0-9]{0,15}),\"nonce\":\"([A-Za-z0-9_-]{22})\",\"video\":(true|false)\\\\}$'",
     "'\"iat\":([1-9][0-9]{0,15}),\"nonce\":\"([A-Za-z0-9_-]{22})\",\"video\":(true|false)(,.*)?\\\\}$'")], [RT]),
  # ── JS 那一條路（ringDirectory.ts／pushDisplay.ts／sw-custom.ts） ──
  ('decideRing: name taken from the push', S+'ringDirectory.ts', [("  return { name: dir.friends[verdict.from] ?? '', video: verdict.video, callId: verdict.callId };",
     "  return { name: typeof d.callerName === 'string' ? d.callerName : dir.friends[verdict.from] ?? '', video: verdict.video, callId: verdict.callId };")], [RT]),
  ('decideRing: device clock instead of the synced offset', S+'ringDirectory.ts', [("    now: deviceNow + clampRingOffset(dir.offsetMs),", "    now: deviceNow,")], [RT]),
  ('decideRing: operator offset not capped', S+'ringDirectory.ts', [("    now: deviceNow + clampRingOffset(dir.offsetMs),", "    now: deviceNow + dir.offsetMs,")], [RT]),
  ('decideRing: any push type rings', S+'ringDirectory.ts', [("  if (d.type !== 'incoming_call' || typeof d.ringToken !== 'string') return null;", "  if (typeof d.ringToken !== 'string') return null;")], [RT]),
  ('display: unverified call push shown as a call', S+'pushDisplay.ts', [
     ("    return { kind, ring: false, isVideoCall: false, tag: 'call-hint', title: 'AegisTalk', body: s.callHint };",
      "    return { kind, ring: true, isVideoCall: false, tag: 'incoming-call', title: `📞 ${s.callTitle}`, body: s.openToAnswer };")], [DISPLAY]),
  ('service worker: call style for any call push', 'packages/pwa/src/sw-custom.ts', [("  if (display.kind === 'incoming_call' && display.ring) {", "  if (display.kind === 'incoming_call') {")], [DISPLAY]),
  ('service worker: ring not decided from the token', 'packages/pwa/src/sw-custom.ts', [
     ("  event.waitUntil(Promise.all([decideRing(data, Date.now()), loadPushStrings()]).then(([ring, s]) => showPushNotification(pushDisplayFor(data, Date.now(), ring, s), s)));",
      "  event.waitUntil(loadPushStrings().then((s) => showPushNotification(pushDisplayFor(data, Date.now(), { name: '', video: false }, s), s)));")], [DISPLAY, RT]),
  ('display: unverified call push shares the verified call\'s tag', S+'pushDisplay.ts', [("tag: 'call-hint', title: 'AegisTalk'", "tag: 'incoming-call', title: 'AegisTalk'")], [DISPLAY]),
  ('service worker: a swipe on an unverified call rejects the real call', 'packages/pwa/src/sw-custom.ts', [
     ("      type: display.kind === 'incoming_call' ? 'message' : display.kind,", "      type: display.kind,")], [DISPLAY]),
  ('ring directory keeps blocked friends', S+'ringSync.ts', [("      if (await isBlacklisted(f.publicKey).catch(() => true)) continue;\n", "")], [RT]),
  # ── 發起方（voiceCall.ts／mqtt.ts／pushRequest.ts） ──
  ('caller: push without a ring token', S+'voiceCall.ts', [("{ type: 'incoming_call', isVideoCall: withVideo, callId });", "{ type: 'incoming_call', isVideoCall: withVideo });")], [CALL, RT]),
  ('caller: token dated on the unbounded server clock', S+'mqtt.ts', [("            video: hint.isVideoCall === true, now: this.boundedNow(), sign: (d) => signer.sign(d) });",
     "            video: hint.isVideoCall === true, now: nowMs, sign: (d) => signer.sign(d) });")], [PUSHSIG, RT]),
  ('caller: push lost when the server finds the token stale', S+'mqtt.ts', [("        if (detail === 'invalid_ring_token') await postSigned(url, build(false), this.signedClock());\n", "")], [PUSHSIG, RT]),
  ('caller: push without the call id', S+'mqtt.ts', [("    const callId = hint.type === 'incoming_call' && typeof hint.callId === 'string' ? hint.callId : null;", "    const callId = null as string | null; void hint.callId;")], [PUSHSIG]),
  ('push hint: free text passes as a ring token', S+'pushRequest.ts', [("typeof hint.ringToken === 'string' && RING_TOKEN_SHAPE.test(hint.ringToken)", "typeof hint.ringToken === 'string'")], [RT]),
  ('push hint: ring token on non-call pushes', S+'pushRequest.ts', [("    ...(hint.type === 'incoming_call' && typeof hint.ringToken === 'string'", "    ...(typeof hint.ringToken === 'string'")], [RT]),
  # ── 帳號離開這台：清掉驗響鈴的資料 ──
  ('logout keeps the ring data', 'packages/pwa/src/App.tsx', [("      await clearRingData();\n    } catch (err) {\n      console.error('[exitChat] clearing the ring data failed:', err);",
     "      void clearRingData;\n    } catch (err) {\n      console.error('[exitChat] clearing the ring data failed:', err);")], [RT]),
  ('kicked device keeps the ring data', S+'deviceClaim.ts', [("      const { clearRingData } = await import('./ringSync');\n      await clearRingData();",
     "      const { clearRingData } = await import('./ringSync');\n      void clearRingData;")], [WIPE, RT]),
  ('device transfer keeps the ring data', 'packages/pwa/src/pages/SettingsPage.tsx', [("      await import('../services/ringSync').then((m) => m.clearRingData())",
     "      await import('../services/ringSync').then((m) => void m)")], [RT]),
  # ── 推播伺服器（api/chat/push.py） ──
  ('server: ring token signature not checked', 'api/chat/push.py', [
     ('        Ed25519PublicKey.from_public_bytes(base64.b64decode(frm, validate=True)).verify(sig, (prefix + ":").encode("ascii") + claims)',
      '        pass')], [SRV]),
  ('server: another sender\'s token accepted', 'api/chat/push.py', [("    if frm != sender or to != recipient or int(iat) > _MAX_SAFE_INTEGER:", "    if to != recipient or int(iat) > _MAX_SAFE_INTEGER:")], [SRV]),
  ('server: token for another recipient accepted', 'api/chat/push.py', [("    if frm != sender or to != recipient or int(iat) > _MAX_SAFE_INTEGER:", "    if frm != sender or int(iat) > _MAX_SAFE_INTEGER:")], [SRV]),
  ('server: stale token accepted', 'api/chat/push.py', [("    if abs(now_s * 1000 - int(iat)) > RING_TOKEN_MAX_SKEW_MS:\n        return False\n", "")], [SRV]),
  ('server: ring token on a message push', 'api/chat/push.py', [('        if hint.ringToken is not None and hint_type != "incoming_call":\n            raise HTTPException(status_code=422, detail="ring_token_not_allowed")\n', '')], [SRV]),
  ('server: ring token not checked at all', 'api/chat/push.py', [
     ("        if hint.ringToken is not None and not ring_token_ok(hint.ringToken, request.pubkey, request.recipient_pubkey, time.time()):",
      "        if False:")], [SRV]),
  ('server: other encodings accepted', 'api/chat/push.py', [('    return raw if base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") == value else None', '    return raw')], [SRV]),
  # ── 原生（RingToken.kt；AegisFCMService 的接線由 ring_token 的原始碼檢查看） ──
  ('native: signature not checked', K+'RingToken.kt', [('        if (!good) return Verdict.Rejected("bad-signature")\n', '')], [JVM]),
  ('native: recipient not checked', K+'RingToken.kt', [('        if (p.to != me) return Verdict.Rejected("wrong-recipient")\n', '')], [JVM]),
  ('native: any signer rings (no friend lookup)', K+'RingToken.kt', [('        val stored = try { friendKey(p.from) } catch (e: Exception) { null }', '        val stored: String? = p.from')], [JVM]),
  ('native: stale tokens ring', K+'RingToken.kt', [('        if (nowMs - p.iat > MAX_AGE_MS) return Verdict.Rejected("stale")\n', '')], [JVM]),
  ('native: replay not checked', K+'RingToken.kt', [('        if (seen.seen(p.callId)) return Verdict.Rejected("replay")\n', '')], [JVM]),
  ('native: forged tokens burn the call id', K+'RingToken.kt', [('        if (!good) return Verdict.Rejected("bad-signature")',
     '        if (!good) { seen.remember(p.callId, p.iat + SEEN_RETENTION_MS); return Verdict.Rejected("bad-signature") }')], [JVM]),
  ('native: operator offset not capped', K+'RingToken.kt', [('    fun clampOffset(offsetMs: Long): Long = offsetMs.coerceIn(-CLOCK_CAP_MS, CLOCK_CAP_MS)', '    fun clampOffset(offsetMs: Long): Long = offsetMs')], [JVM]),
  ('native: seen calls kept only through the freshness window', K+'RingToken.kt', [('    const val SEEN_RETENTION_MS = MAX_AGE_MS + MAX_FUTURE_MS + 2 * CLOCK_CAP_MS', '    const val SEEN_RETENTION_MS = MAX_AGE_MS')], [JVM]),
  ('native: block list fails open for rings', K+'AegisFCMService.kt', [('LocalSenders.lookup(this, pk, blockListFailsClosed = true)', 'LocalSenders.lookup(this, pk)')], [RT]),
  ('native: offset used uncapped', K+'AegisFCMService.kt', [('System.currentTimeMillis() + RingToken.clampOffset(ctx.offsetMs)', 'System.currentTimeMillis() + ctx.offsetMs')], [RT]),
  ('native: non-canonical base64 accepted', K+'RingToken.kt', [('        return if (encode(bytes, url) == s) bytes else null', '        return bytes')], [JVM]),
  ('native: full-screen ring without a verified token', K+'AegisFCMService.kt', [('        if (verdict !is RingToken.Verdict.Ok) {', '        if (false) {')], [RT]),
  ('native: name of the server-named sender', K+'AegisFCMService.kt', [
     ('                    is LocalSenders.Sender.Friend -> { friendName = c.name; pk }\n                    else -> null',
      '                    is LocalSenders.Sender.Friend -> { friendName = c.name; pk }\n                    else -> pk')], [RT]),
  # ── 群組通話的 DTLS 指紋（groupCallService.ts） ──
  ('group: connected on ICE alone', S+'groupCallService.ts', [("        gate.check.start();\n", "        gate.check.start();\n        this.onPeerVerified(peerId);\n")], [GFP]),
  ('group: mismatch keeps the peer', S+'groupCallService.ts', [("    this.removeParticipant(peerId);\n  }\n\n  /** 停掉這位參與者", "  }\n\n  /** 停掉這位參與者")], [GFP]),
  ('group: media sent before verification', S+'groupCallService.ts', [("    for (const t of gate.clones) t.enabled = gate.verified && (", "    for (const t of gate.clones) t.enabled = (")], [GFP]),
  ('group: remote stream shown before verification', S+'groupCallService.ts', [
     ("    if (participant && gate.verified && gate.heldStream && participant.remoteStream !== gate.heldStream) {", "    if (participant && gate.heldStream && participant.remoteStream !== gate.heldStream) {")], [GFP]),
  ('group: shared local tracks sent (no per-PC clone)', S+'groupCallService.ts', [("      const clone = track.clone();", "      const clone = track;")], [GFP]),
  ('group: fingerprint signals ignored', S+'groupCallService.ts', [("      if (gate) gate.check.receive(data);", "      void gate;")], [GFP]),
  ('group: user not told', S+'groupCallService.ts', [("      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'group-call-unverified', reason } }));\n", "")], [GFP]),
  ('group: only the larger key offers to a joiner (pair left waiting)', S+'groupCallService.ts', [
     ("    devLog(`[GroupCall] Creating offer for ${peerId.slice(0, 8)}`);\n    const offer = await connection.createOffer();",
      "    if (!(this.localPublicKey > peerId)) return;\n    const offer = await connection.createOffer();")], [GFP]),
  ('group: glare not resolved', S+'groupCallService.ts', [("      await participant.connection.setLocalDescription({ type: 'rollback' });\n", "")], [GFP]),
  ('group: renegotiation keeps a changed certificate', S+'groupCallService.ts', [("    if (gate?.verified && gate.connection === participant.connection) {", "    if (false) {")], [GFP]),
  ('group: participant connected before verification', S+'groupCallService.ts', [("        if (participant && gate.verified && !participant.isConnected) {", "        if (participant && !participant.isConnected) {")], [GFP]),
  # ── 版本：帳號離開時跑版本註冊的原生端清除（社群版沒有守護外掛；官方版那一半在 mutants_official.py 的 'step5d'） ──
  ('registered native cleanup not run when the account leaves', S+'guardianBackground.ts', [("    await run();\n", "    void run;\n")], [GLOG]),
  # ── security review L3: the community app allows no in-app navigation (Capacitor gives those origins the native bridge) ──
  ('community build allows in-app navigation', 'packages/pwa/capacitor.config.ts', [
     ("const allowNavigation: string[] = CHAT ? [] : officialNavigation();",
      "const allowNavigation: string[] = CHAT ? ['https://chat.example.org'] : officialNavigation();")], [CAPNAV]),
]
MUTANTS += kit.official_mutants('step5d')

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src', 'packages/pwa/android/app/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json', 'packages/pwa/vite.config.ts', 'packages/pwa/capacitor.config.ts']


def make_copy(dst):
    # paths this checkout lacks are left out; the app's node_modules is linked in (mutant_kit.make_copy)
    kit.make_copy(dst, COPY_DIRS, COPY_FILES, ignore=('__pycache__', 'node_modules', 'build'))


ASSERTION = ('AssertionError', 'ERR_ASSERTION', 'FAIL ', 'ComparisonFailure', 'AssertionFailedError')


def failed_on_assertion(r):
    return r.returncode != 0 and any(a in (r.stdout + r.stderr) for a in ASSERTION)


def _remote(cmd, stdin=None):
    """JVM 專案上執行（本機或 ssh）"""
    if JVM_SSH:
        full = shlex.split(JVM_SSH) + [f"zsh -lc {shlex.quote(cmd)}"]
    else:
        full = ['bash', '-lc', cmd]
    return subprocess.run(full, input=stdin, capture_output=True, timeout=1200)


def _push_src(src_root):
    """src_root/packages/pwa/android/app/src 整份送去蓋掉 JVM 專案的 app/src"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        tf.add(f'{src_root}/packages/pwa/android/app/src', arcname='src')
    r = _remote(f'cd {shlex.quote(JVM_PROJECT)}/app && rm -rf src && tar -xf -', stdin=buf.getvalue())
    if r.returncode != 0:
        raise RuntimeError('could not push the sources to the JVM project: ' + r.stderr.decode('utf-8', 'replace')[-400:])


def run_jvm(test_class, copy):
    if not JVM_PROJECT:
        return subprocess.CompletedProcess('jvm', 2, '', 'jvm tests need AEGISTALK_JVM_PROJECT (see the header)')
    _push_src(copy)
    r = _remote(f'cd {shlex.quote(JVM_PROJECT)} && ./gradlew --offline --no-daemon --console=plain :app:testChatDebugUnitTest --tests com.aegisrd.talk.{test_class}')
    out, err = r.stdout.decode('utf-8', 'replace'), r.stderr.decode('utf-8', 'replace')
    # 斷言失敗：JUnit 的失敗訊息在報告裡，Gradle 只印「FAILED」→ 把那一份 XML 也拿回來看
    if r.returncode != 0:
        x = _remote(f'cat {shlex.quote(JVM_PROJECT)}/app/build/test-results/testChatDebugUnitTest/TEST-com.aegisrd.talk.{test_class}.xml 2>/dev/null')
        out += x.stdout.decode('utf-8', 'replace')
    return subprocess.CompletedProcess('jvm', r.returncode, out, err)


def run_test(t, copy):
    env = {**os.environ, 'AEGISTALK_PWA_SRC': f'{copy}/packages/pwa/src', 'AEGISTALK_API_DIR': f'{copy}/api', 'PYTHONDONTWRITEBYTECODE': '1'}
    try:
        if t.startswith('jvm:'):
            return run_jvm(t[4:], copy)
        if t.startswith('py:'):
            return subprocess.run(PY + [f'{copy}/scripts/review/{t[3:]}_self_test.py'], cwd=copy, env=env, capture_output=True, text=True, timeout=600)
        return subprocess.run(['node', f'{copy}/scripts/review/{t}_self_test.mjs'], cwd=copy, env=env, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        return subprocess.CompletedProcess(e.cmd, 124, out, 'TIMEOUT')


args = sys.argv[1:]
no_jvm = '--no-jvm' in args
only = set(a for a in args if a != '--no-jvm')
selected = kit.runnable([m for m in MUTANTS if (not only or m[0] in only) and not (no_jvm and any(t.startswith('jvm:') for t in m[3]))])
os.makedirs(WORK, exist_ok=True)
copy = WORK + '/repo'
make_copy(copy)
baseline_bad = []
try:
    for t in sorted({t for m in selected for t in m[3]}):
        t0 = time.time()
        r = run_test(t, copy)
        print(f"baseline {t}: {'passes' if r.returncode == 0 else 'FAILS'} ({round(time.time() - t0)}s)", flush=True)
        if r.returncode != 0:
            baseline_bad.append(t)
            print('\n'.join((r.stdout + r.stderr).splitlines()[-8:]), flush=True)
    if baseline_bad:
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
                ok = False; print(f'!! {name}: pattern count {s.count(old)} in {f}: {old[:70]!r}', flush=True); break
            open(p, 'w', encoding='utf-8').write(s.replace(old, new))
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
finally:
    if JVM_PROJECT and any(t.startswith('jvm:') for m in selected for t in m[3]):
        try:
            _push_src(REPO)
        except Exception as e:   # noqa: BLE001
            print('!! could not restore the JVM project sources:', e, flush=True)
    shutil.rmtree(WORK, ignore_errors=True)
killed = sum(r[1] == 'KILLED' for r in results)
print(json.dumps({'killed': killed, 'total': len(results), 'skipped': len(kit.SKIPPED)}))
sys.exit(0 if results and killed == len(results) else 1)

#!/usr/bin/env python3
"""
開源第 4 步的 mutation check（docs/DIRECT_SEALED.md）：每個 mutant 在 repo 的副本裡拿掉一項第 4 步的保護（真的樹不動），
指定的 review 測試對著副本要失敗 —— 而且是斷言失敗（當掉、語法錯、少工具算 ERROR，不算殺掉）。先跑基準：每支會用到的測試
在沒改過的副本上都要過，不然 exit 2、一個 mutant 都不跑。
  python3 scripts/review/step4_mutants.py            # 全部
  python3 scripts/review/step4_mutants.py "<name>"   # 指定的
Python 測試用 $AEGISTALK_PYTHON（有 fastapi／pydantic／cryptography／httpx／pywebpush 的直譯器），沒設就用 uv。
副本放在 $STEP4_MUTANT_DIR（預設 repo 旁邊的 .step4-mutants，node_modules 從上一層解析得到），跑完刪掉。
每個 mutant 都被殺掉（而且每個樣式都還對得上原始碼）才 exit 0。
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('STEP4_MUTANT_DIR', str(Path(REPO).parent / '.step4-mutants'))
PY = kit.python_cmd(
    ['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography',
     '--with', 'httpx', '--with', 'pywebpush', 'python'])
S = 'packages/pwa/src/services/'
P = 'packages/pwa/src/providers/AppProvider.tsx'
SEAL = 'direct_seal'
SIG = 'direct_signal'
CALL = 'call_state_machine'
GATE = 'webrtc_fingerprint_gate'
DTLS = 'dtls_fingerprint'
ACK = 'group_ack_signed'
WIRE = 'direct_sealed_wiring'
WEBPUSH = 'webpush_register'
DISPLAY = 'push_display'
UNSENT = 'group_unsent_status'
BUF = 'mqtt_buffers'
MUTANTS = [
  # ── 信封（directSeal.ts） ──
  ('sender not checked against the stored identity', S+'directSeal.ts', [
     ("  if (typeof p.storedKey !== 'string' || p.storedKey !== p.from) throw new Error('directSeal: sender is not the stored identity');\n", "")], [SEAL]),
  ('no freshness window', S+'directSeal.ts', [
     ("  if (p.now - iat > rule.maxAgeMs || iat - p.now > DIRECT_MAX_FUTURE_MS) throw new Error('directSeal: stale or future envelope');", "  void iat; void rule;")], [SEAL]),
  # （「未來 5 分鐘以上」由 identitySeal 自己的窗也擋：拿掉 directSeal 的那一半等於沒變，不列為 mutant）
  ('signalling valid for 20 minutes', S+'directSeal.ts', [
     ("  call: { maxCt: 64 * KB, maxAgeMs: 2 * MINUTE,", "  call: { maxCt: 64 * KB, maxAgeMs: 20 * MINUTE,"),
     ("  dc: { maxCt: 64 * KB, maxAgeMs: 2 * MINUTE,", "  dc: { maxCt: 64 * KB, maxAgeMs: 20 * MINUTE,")], [SEAL]),
  ('nonce replay not checked', S+'directSeal.ts', [("    if (this.seen.has(key)) return 'replay';\n", "")], [SEAL, SIG]),
  ('ordered kinds not ordered', S+'directSeal.ts', [("      if (last !== undefined && !(body.iat > last)) return 'out-of-order';\n", "")], [SEAL, SIG]),
  ('call requests not ordered', S+'directSeal.ts', [("ordered: true, orderedSig: 'request',", "ordered: false, orderedSig: 'request',")], [SEAL, SIG]),
  ('ordering mark not capped (operator clock poisoning)', S+'directSeal.ts', [
     ("      this.marks.set(markKey, Math.min(body.iat, now.bounded + DIRECT_MAX_FUTURE_MS));", "      this.marks.set(markKey, body.iat);")], [SEAL]),
  ('far-ahead ordered envelopes accepted', S+'directSeal.ts', [("      if (body.iat > now.bounded + DIRECT_ORDERED_MAX_AHEAD_MS) return 'out-of-order';\n", "")], [SEAL]),
  ('no size padding', S+'directSeal.ts', [
     ("  return bucket === undefined ? body : { ...body, [PAD_FIELD]: 'x'.repeat(bucket - size) };", "  void bucket; return body;")], [SEAL]),
  ('padding not stripped after opening', S+'directSeal.ts', [("  return withoutPad(opened) as DirectBody;", "  return opened as DirectBody;")], [SEAL]),
  ('domain prefix ignored', S+'directSeal.ts', [
     ("  return { domain: `${prefix}:`, aadPrefix: `${prefix}|`, info: `${prefix}/hkdf` };", "  return { domain: 'd:', aadPrefix: 'd|', info: 'd/hkdf' };")], [SEAL]),
  # ── 收（directSignal.ts） ──
  ('strangers may send any kind', S+'directSignal.ts', [("    if (!stored && body.kind !== 'dc') { stat(`stranger:${body.kind}`); return; }\n", "")], [SIG]),
  ('blocked senders opened', S+'directSignal.ts', [("    if (await deps.isBlocked(from).catch(() => true)) { stat('blocked'); return; }\n", "")], [SIG]),
  ('block list fails open (receive)', S+'directSignal.ts', [("    if (await deps.isBlocked(from).catch(() => true))", "    if (await deps.isBlocked(from).catch(() => false))")], [SIG]),
  ('replay verdict ignored', S+'directSignal.ts', [("    if (verdict !== 'ok') { stat(`${verdict}:${body.kind}`); return; }\n", "")], [SIG]),
  ('no stranger budget', S+'directSignal.ts', [("    } else if (!strangerBudget.take(from) || !strangerTotal.take('*')) {", "    } else if (false) {")], [SIG]),
  ('sends not serialized per recipient', S+'directSignal.ts', [("  const prev = sendChains.get(to) ?? Promise.resolve();", "  const prev = Promise.resolve();")], [SIG]),
  # ── 通話狀態機（callSignalGuard.ts／voiceCall.ts） ──
  ('signals of another call id accepted', S+'callSignalGuard.ts', [
     ("      if (!state || from !== state.peer || s.callId !== state.callId) return false;", "      if (!state || from !== state.peer) return false;")], [CALL]),
  ('signals from someone else accepted', S+'callSignalGuard.ts', [
     ("      if (!state || from !== state.peer || s.callId !== state.callId) return false;", "      if (!state || s.callId !== state.callId) return false;")], [CALL]),
  ('state signals not ordered by seq', S+'callSignalGuard.ts', [("      if (!(s.seq > state.lastSeq)) return false;\n", "")], [CALL]),
  ('ICE ordered by seq again', S+'callSignalGuard.ts', [("      if (s.sig === 'ice' || s.sig === 'fp') return true;\n", "")], [CALL]),
  ('caller takes offers', S+'callSignalGuard.ts', [
     ("    mayTakeOffer() { return !!state && state.role === 'callee' && !state.offerTaken; },", "    mayTakeOffer() { return !!state && !state.offerTaken; },")], [CALL]),
  ('more than one offer per call', S+'callSignalGuard.ts', [
     ("    mayTakeOffer() { return !!state && state.role === 'callee' && !state.offerTaken; },", "    mayTakeOffer() { return !!state && state.role === 'callee'; },")], [CALL]),
  ('answers taken in any signalling state', S+'callSignalGuard.ts', [
     ("state.role === 'caller' && signalingState === 'have-local-offer'; },", "state.role === 'caller' && !!signalingState; },")], [CALL]),
  ('call connected before the fingerprint check', S+'voiceCall.ts', [("        check.start();\n", "        check.start();\n        this.onCallConnected();\n")], [CALL]),
  ('microphone sent before verification', S+'voiceCall.ts', [
     ("t.enabled = this.verified && !(call?.isMuted ?? false); });", "t.enabled = !(call?.isMuted ?? false); });")], [CALL]),
  ('fingerprint mismatch does not hang up', S+'voiceCall.ts', [("    this.endCallWithReason(CallEndReason.UNVERIFIED);\n", "")], [CALL]),
  ('non-friends can ring', S+'voiceCall.ts', [("    if (!(await findFriendSettled(callerId))) { this.count('request-not-friend'); return; }\n", "")], [CALL]),
  ('stale call requests ring', S+'voiceCall.ts', [("    if (!(mqttService.serverNow() - iat <= CALL_REQUEST_MAX_AGE_MS)) { this.count('request-stale'); return; }\n", "    void iat;\n")], [CALL]),
  ('block list fails open (calls)', S+'voiceCall.ts', [("    if (await isBlacklisted(callerId).catch(() => true))", "    if (await isBlacklisted(callerId).catch(() => false))")], [CALL, 'block_all_paths']),
  ('no connect timeout', S+'voiceCall.ts', [("const CONNECT_TIMEOUT_MS = 45_000;", "const CONNECT_TIMEOUT_MS = 450_000;")], [CALL]),
  ('call signals not handled in order', S+'voiceCall.ts', [
     ("    this.signalChain = this.signalChain.then(run).catch(", "    this.signalChain = Promise.resolve().then(run).catch(")], [CALL]),
  ('call media signals not queued', S+'voiceCall.ts', [
     ("sendDirect(peer, { kind: 'call', sig, callId, seq, ...extra }, { ttlMs: CALL_CONTROL_TTL_MS })",
      "sendDirect(peer, { kind: 'call', sig, callId, seq, ...extra }, sig === 'request' || sig === 'accept' || sig === 'reject' || sig === 'end' ? { ttlMs: CALL_CONTROL_TTL_MS } : { transient: true })")], [CALL]),
  # ── DTLS 指紋（dtlsFingerprint.ts） ──
  ('fingerprints compared one way only', S+'dtlsFingerprint.ts', [
     ("  return sameSet(mine.local, theirs.remote) && sameSet(mine.remote, theirs.local);", "  return sameSet(mine.remote, theirs.local);")], [DTLS]),
  # 失敗是終點：三道（receive、live()、state === 'started'）都拿掉才會在失敗之後又驗過
  ('a failed check can be revived', S+'dtlsFingerprint.ts', [("  const live = () => state === 'started' || state === 'verified';", "  const live = () => state !== 'stopped';"),
     ("    if (first && state === 'started') {", "    if (first && state !== 'stopped') {"),
     ("      if (state === 'failed' || state === 'stopped') return;\n      const theirs", "      if (state === 'stopped') return;\n      const theirs")], [DTLS]),
  # ── DataChannel（webrtc.ts） ──
  ('DataChannel usable before verification', S+'webrtc.ts', [("    if (!peer.verified) return false;\n    // ⚠️ 真因", "    // ⚠️ 真因")], [GATE]),
  ('send allowed before verification', S+'webrtc.ts', [
     ("    if (!peer.verified) {\n      devWarn(`[WebRTC] Cannot send to ${remotePublicKeyBase64.slice(0, 8)}...: DTLS fingerprints not verified yet`);\n      return false;\n    }\n", "")], [GATE]),
  ('unverified inbound delivered', S+'webrtc.ts', [("      if (peer && !peer.verified) {\n        const size", "      if (false) {\n        const size")], [GATE]),
  ('fingerprint mismatch keeps the DataChannel', S+'webrtc.ts', [
     ("      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'link-unverified', reason } }));\n    }\n    this.closePeer(remote);",
      "      window.dispatchEvent(new CustomEvent('aegis:mqtt-notice', { detail: { kind: 'link-unverified', reason } }));\n    }")], [GATE]),
  ('fingerprint for another PC pair accepted', S+'webrtc.ts', [
     ("    if (!peer || msg.pc !== peer.remotePcId || msg.rpc !== peer.localPcId) { this.count('fp-stale'); return; }", "    if (!peer) { this.count('fp-stale'); return; }")], [GATE]),
  ('unauthenticated offers handled', S+'webrtc.ts', [("    const remotePublicKeyBase64 = msg.from;\n    if (msg.authenticated !== true) return;\n", "    const remotePublicKeyBase64 = msg.from;\n")], [GATE]),
  ('pcId hijack: older offer tears down the live PC', S+'webrtc.ts', [
     ("        if (msg.authenticated !== true || (existingPeer.remotePcIat !== undefined && !(msg.iat > existingPeer.remotePcIat))) {", "        if (msg.authenticated !== true) {")], [GATE]),
  ('answer for another PC generation taken', S+'webrtc.ts', [("    if (msg.rpc !== peer.localPcId) {\n      this.count('answer-other-generation');", "    if (false) {\n      this.count('answer-other-generation');")], [GATE]),
  ('answer from a new PC generation kept on a live PC', S+'webrtc.ts', [("    if (peer.remotePcId && msg.pc !== peer.remotePcId) {\n      this.count('answer-new-generation');", "    if (false) {\n      this.count('answer-new-generation');")], [GATE]),
  ('ICE for another PC generation used', S+'webrtc.ts', [("    if (peer.remotePcId && tagged.pc !== peer.remotePcId) {\n      this.count('ice-other-generation');", "    if (false) {\n      this.count('ice-other-generation');")], [GATE]),
  # ── 群組回條（groupAck.ts／AppProvider.tsx） ──
  ('group ack signature not verified', S+'groupAck.ts', [
     ("    return p.verify(pk, signedBytes(p.domain ?? GROUP_ACK_DOMAIN, p.from, p.to, f.ids, f.ts), sig) ? [...f.ids] : null;", "    return [...f.ids];")], [ACK]),
  ('group ack not bound to the recipient', S+'groupAck.ts', [
     ("  return new TextEncoder().encode(domain + JSON.stringify({ from, to, ids, ts }));", "  void to; return new TextEncoder().encode(domain + JSON.stringify({ from, ids, ts }));")], [ACK]),
  ('App clears entries on an unverified ack', P, [("        const confirmed = confirmDelivered(peerPublicKey, ids);", "        const confirmed = confirmDelivered(peerPublicKey, parsed.ids);")], [ACK, 'group_delivery_receipt']),
  # ── 推播／信任（signedPost.ts、pushRequest.ts、webPush.ts、pushDisplay.ts、api） ──
  ('no clock_skew retry', S+'signedPost.ts', [("  if (serverTime === null) return first;\n", "  if (serverTime === null || true) return first;\n")], ['push_signing', 'risk_score_signing', WEBPUSH]),
  ('clock_skew retry without adopting the server time', S+'signedPost.ts', [("  clock.adopt(serverTime);\n", "")], ['push_signing', 'risk_score_signing', WEBPUSH]),
  ('community edition sends guardian pushes', S+'pushRequest.ts', [("    : ['message', 'incoming_call']);", "    : ['message', 'incoming_call', 'guardian_alert', 'check_in']);")], ['push_signing']),
  ('legacy web-push subscription reused', S+'webPush.ts', [
     ("    if (subscription && (!readFlag(registeredFlag(publicKeyBase64)) || !subscribedWithKey(subscription, vapidBytes))) {", "    if (subscription && false) {")], [WEBPUSH]),
  ('web-push registration never remembered', S+'webPush.ts', [("    writeFlag(registeredFlag(publicKeyBase64));\n", "")], [WEBPUSH]),
  # （第 5d 步起推播的「是不是視訊」只看驗過的響鈴 token；沒驗過的來電推播根本不是來電的樣子 —— 兩個 mutant 改對著新的寫法）
  ('push isVideoCall taken from the push', S+'pushDisplay.ts', [("      const isVideoCall = ring.video === true;", "      const isVideoCall = ring.video === true || !!d.isVideoCall;")], [DISPLAY]),
  ('push caller name shown', S+'pushDisplay.ts', [("    return { kind, ring: false, isVideoCall: false, tag: 'call-hint', title: 'AegisTalk', body: '可能有人打給你，打開 AegisTalk 看看' };",
     "    return { kind, ring: false, isVideoCall: false, tag: 'call-hint', title: 'AegisTalk', body: typeof d.callerName === 'string' ? `${d.callerName} 正在呼叫你` : '可能有人打給你，打開 AegisTalk 看看' };")], [DISPLAY]),
  ('server keeps subscriptions under another VAPID key', 'api/chat/push.py', [('            return "gone" if status in (401, 403, 404, 410) else "failed"', '            return "gone" if status in (404, 410) else "failed"')], ['py:webpush']),
  # ── MQTT（mqtt.ts） ──
  ('transient signals never expire at the broker', S+'mqtt.ts', [
     ("      MqttService.publishOptions(MqttService.TRANSIENT_EXPIRY_S * 1000));", "      { qos: 1 });")], [BUF]),
  ('a full direct_sealed buffer drops the newest', S+'mqtt.ts', [
     ("      const dropOldest = typeKey === MessageType.DIRECT_SEALED && critical && size <= MqttService.PENDING_CRITICAL_MAX_BYTES;", "      const dropOldest = false;")], [BUF]),
  # ── 名字不上 broker（AddFriendModal／AppProvider） ──
  ('name back in the add-friend X3DH_INIT', 'packages/pwa/src/components/Verification/AddFriendModal.tsx', [
     ("        via,   // 對方的信任等級只看這個", "        via, senderName: userProfile.displayName,   // 對方的信任等級只看這個")], [WIRE]),
  ('App block lookup fails open', P, [("      isBlocked: (pk) => isBlacklisted(pk).catch(() => true),", "      isBlocked: (pk) => isBlacklisted(pk).catch(() => false),")], [WIRE]),
  # ── 群組泡泡（useGroupChat.ts） ──
  ('retry also sends to members who joined later', 'packages/pwa/src/hooks/useGroupChat.ts', [
     ("getOtherMemberPublicKeys(currentGroupId, publicKeyBase64).filter((pk) => joinedBefore.has(pk));", "getOtherMemberPublicKeys(currentGroupId, publicKeyBase64);")], [UNSENT]),
  ('unsent mark not shown on screen', 'packages/pwa/src/hooks/useGroupChat.ts', [
     ("    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, sendStatus: 'failed' as const } : m)));\n  }, []);", "  }, []);")], [UNSENT]),
]
MUTANTS += kit.official_mutants('step4')

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json', 'packages/pwa/vite.config.ts']


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

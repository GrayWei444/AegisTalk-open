#!/usr/bin/env python3
"""
W2 mutation check (docs/GROUP_LOG_WIRING_W2.md): each mutant removes one protection in a COPY of packages/pwa/src
(the real tree is never touched); the named review tests must fail against the copy (AEGISTALK_PWA_SRC).
W3 (docs/GROUP_LOG_WIRING_W3.md) changed some of the code these patterns point at: patterns updated where the protection
still exists; the held-incoming mutants (never expires, waiting kids per sender, per-kid cap) are gone with that code
(a message of another epoch can no longer arrive on a topic I listen to); the envelope carries no kid any more (W3 review M3),
so "kid of another epoch than the topic" became "epoch taken from my chain instead of the topic". W3's own protections:
group_w3_mutants.py.

  python3 scripts/review/group_w2_mutants.py            # all mutants
  python3 scripts/review/group_w2_mutants.py "<name>"   # selected ones

The copy goes to $W2_MUTANT_DIR (default: a .w2-mutants folder next to the repo) and is deleted afterwards. It holds
packages/pwa/src with packages/pwa/tsconfig.json (esbuild resolves the '@ext/...' imports through its "paths") and the
app's node_modules linked in (mutant_kit.make_copy). Every test first runs on the unchanged copy (baseline): a test that
fails there would "kill" every mutant, so the runner stops with exit code 2 instead.
Exit code 0 only if every mutant is killed (and every pattern still matches the source).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('W2_MUTANT_DIR', str(Path(REPO).parent / '.w2-mutants'))
COPY_DIRS = ['packages/pwa/src']
COPY_FILES = ['packages/pwa/tsconfig.json']
S = 'services/'
W2 = 'group_control_w2'
MUTANTS = [
  ('non-member pre-filter', S+'groupEngineControl.ts', [("    if (!memberOf(state, from)) return drop('non-member');\n", "")], [W2, 'group_engine_review_fixes']),
  ('epoch taken from my chain instead of the topic', S+'groupEngineControl.ts', [("    const kid = at.kid;\n", "    const kid = rt.rep.view.state.epoch.kid;\n")], [W2]),
  ('replay accepted', S+'groupEngineControl.ts', [("    if (seenBefore(gid, from, opened.ts, opened.nonce, opened.ts + WINDOW_MS[opened.t] + FUTURE_SKEW_MS)) return drop('replay');\n", "")], [W2]),
  ('freshness ignored', S+'groupEngineControl.ts', [("    if (opened.ts > now + FUTURE_SKEW_MS || now - opened.ts > WINDOW_MS[opened.t]) return drop('stale');\n", "")], [W2]),
  ('not held during needsRekey', S+'groupEngineControl.ts', [("rt.rep.view.state.needsRekey || rt.rep.waiting", "rt.rep.waiting")], [W2]),
  ('held never released', S+'groupEngineControl.ts', [("        outcome = await publish(rt, cur.kid, cur.key, h.t, bodyOf(rt, h.t, h.body), true);\n        if (outcome === 'sent') {", "        outcome = 'sent';\n        if (true) { continue;")], [W2]),
  ('stale held call released', S+'groupEngineControl.ts', [("      if (h.t === 'call' && now - h.at > CALL_STALE_MS) { count('expired:call'); continue; }\n", "")], [W2]),
  ('commit notice under the new epoch', S+'groupEngine.ts', [("    const entryOf = (a: LogApplyResult['applied'][number]) => epochAt(after, a.commit.c.v - 1);", "    const entryOf = (_a: LogApplyResult['applied'][number]) => after.epoch;")], [W2]),
  ('no conflict warning', S+'groupEngineGossip.ts', [("    rt.conflicts.set(from, { reason, head });\n    if (!was) host.project(rt);", "    void reason; void head; void was;")], [W2]),
  ('conflict never cleared', S+'groupEngineGossip.ts', [("    if (rt.gone || !rt.conflicts.delete(from)) return;", "    if (rt.gone || !rt.conflicts.has(from)) return;")], [W2]),
  ('gossip from non-members counted', S+'groupEngineGossip.ts', [("    if (rt.gone || rt.rep.status !== 'member' || !memberOf(rt.rep.view.state, from)) return 'unknown';", "    if (rt.gone || rt.rep.status !== 'member') return 'unknown';")], [W2]),
  ('invite not resent (W1)', S+'groupEngineSealed.ts', [("  const sent = async (to: string[]) => {\n", "  const sent = async (to: string[]) => {\n    if (to) { await done(); return; }\n")], [W2]),
  ('unbounded resends', S+'groupEngineSealed.ts', [("    if (sends > INVITE_RESEND_MS.length) {", "    if (sends > 1000) {"),
     ("nextAt: now + INVITE_RESEND_MS[sends - 1] }", "nextAt: now + (INVITE_RESEND_MS[sends - 1] ?? 60_000) }")], [W2]),
  ('no implicit ack', S+'groupEngineSealed.ts', [("  if (!waitsForAck(rt, from)) return;\n  await ctx.queue(rt.gid, () => markAcked(ctx, rt, from));", "  void waitsForAck; void markAcked; void rt; void from;")], [W2]),
  ('no ack after join', S+'groupEngineSealed.ts', [("  await deps.sendSealed(from, { kind: 'ack', gid, id: verified.view.state.head.id }).catch((e) => log('invite ack failed:', (e as Error)?.message ?? e));\n", "")], [W2]),
  ('forget keeps local data', S+'groupEngine.ts', [("      if (rt) await dropGroup(rt, 'forgotten');", "      if (rt) { rt.gone = true; runtimes.delete(gid); deps.project(gid, null); notice({ gid, kind: 'forgotten' }); }")], [W2]),
  ('announce lost before engine ready', S+'groupEngine.ts', [("    if (!ready) { announcePending = true; return; }", "    if (!ready) return;")], [W2]),
  ('group topic accepts any type', S+'mqtt.ts', [("    if (group !== (type === MessageType.GROUP_SEALED)) return false;\n", "")], [W2, 'mqtt_freshness']),
  ('token swap not flagged', S+'mqtt.ts', [("      this._swapReconnect = true;\n", "")], ['mqtt_acl_scope']),
  ('route ignores topic sender', S+'groupControlRoute.ts', [("  if (!isGroupTopicId(parts[2]) || parts[3] !== toUrlSafeBase64(message.from)) return null;", "  if (!isGroupTopicId(parts[2])) return null;")], [W2]),
  ('stale call signal accepted', S+'groupCallService.ts', [("    if (typeof iat !== 'number' || now - iat > SIGNAL_MAX_AGE_MS || iat - now > SIGNAL_MAX_FUTURE_MS) {", "    if (typeof iat !== 'number') {")], ['group_call_identity']),
  ('call signal from non-member', S+'groupCallService.ts', [("    if (!this.localPublicKey || from === this.localPublicKey || !this.isMember(gid, from)) return;\n    // 先記下", "    if (!this.localPublicKey || from === this.localPublicKey) return;\n    // 先記下")], ['group_call_identity']),
  ('call control from non-member', S+'groupCallService.ts', [("    if (!this.localPublicKey || from === this.localPublicKey || !this.isMember(groupId, from)) return;", "    if (!this.localPublicKey || from === this.localPublicKey) return;")], ['group_call_identity']),
  ('worker reply trusted blindly', S+'groupInviteVerify.ts', [("      if (error !== undefined || !result || typeof result.ok !== 'boolean') w.reject(", "      if (error !== undefined || !result) w.reject(")], ['group_invite_worker']),
  ('worker failure skips verification', S+'groupInviteVerify.ts', [("    const r = await onMainThread(params);\n    diagLog('[DIAG:GLOG] invite chain verified on the main thread:'", "    const r: InviteResult = { ok: true, view: undefined as never, addedBy: '' }; void onMainThread;\n    diagLog('[DIAG:GLOG] invite chain verified on the main thread:'")], ['group_invite_worker']),
  ('call body accepts extra fields', S+'groupControl.ts', [("      exactKeys(b, ['action', 'video'], 'call body');\n", "")], [W2, 'group_control_envelope']),
  ('R1 engine on the device clock', 'providers/AppProvider.tsx', [("手機之間的時鐘差不算進去\n      now: () => mqttService.serverNow(),", "手機之間的時鐘差不算進去\n      now: () => Date.now(),")], ['group_control_w2_review_fixes']),
  ('R1 sealed envelopes on the device clock', S+'groupKeyDelivery.ts', [("kindLimits: KIND_LIMITS, now: mqttService.serverNow() }, x25519);\n  if (sealer !== s) throw new Error('groupKeyDelivery: account changed while sealing');\n  if (opts.transient)", "kindLimits: KIND_LIMITS }, x25519);\n  if (sealer !== s) throw new Error('groupKeyDelivery: account changed while sealing');\n  if (opts.transient)")], ['group_control_w2_review_fixes']),
  ('R1 call signals on the device clock', S+'groupCallService.ts', [("  handleSignal(from: string, body: Record<string, unknown>, now: number = Date.now()): void {\n", "  handleSignal(from: string, body: Record<string, unknown>, _now: number = Date.now()): void {\n    const now = Date.now();\n")], ['group_call_identity']),
  ('R2 join sync before the topic is subscribed', S+'groupEngine.ts', [("      if (tid && (deps.topicReady?.(tid) ?? true)) control.send", "      if (true) control.send")], ['group_control_w2_review_fixes']),
  ('R2 sync replies limited per group', S+'groupEngineControl.ts', [("        if (!previous && mayReplyTo(rt, m.sender)) reply(rt, m.sender);", "        if (!previous && mayReplyTo(rt, m.sender)) reply(rt);")], ['group_control_w2_review_fixes']),
  ('R3 one shared replay cache', S+'groupEngineControl.ts', [("    const key = `${gid}|${from}`;\n    let s = seen.get(key);", "    const key = 'all';\n    let s = seen.get(key);")], ['group_control_w2_review_fixes']),
  ('R3 no floor after eviction', S+'groupEngineControl.ts', [("      s.floor = Math.max(s.floor, oldest[1].ts);\n", "")], ['group_control_w2_review_fixes']),
  ('R3 call signal replays accepted', S+'groupCallService.ts', [("    if (typeof nonce !== 'string' || !this.firstSeen(`${from}|${nonce}`, iat + SIGNAL_MAX_AGE_MS + SIGNAL_MAX_FUTURE_MS, now)) {", "    if (typeof nonce !== 'string') {")], ['group_call_identity']),
  ('R5 no re-check after sealing', S+'groupEngineControl.ts', [("    if (guarded && blocked(rt)) { count('resealed-later'); return 'retry'; }\n", "")], ['group_control_w2_review_fixes']),
  ('R5 offline control handed to mqtt', S+'groupEngineControl.ts', [(" || !connected() || switching(rt);", " || switching(rt);")], ['group_control_w2_review_fixes']),
  ('R6 resend not bound to the add', S+'groupEngineSealed.ts', [("to.filter((pk) => memberOf(state, pk)?.addedAtV === addV && ", "to.filter((pk) => !!memberOf(state, pk) && addV > 0 && ")], ['group_control_w2_review_fixes']),
  ('R7 no announce when started while connected', S+'groupEngine.ts', [("      if (announcePending || deps.connected?.()) {", "      if (announcePending) {")], ['group_control_w2_review_fixes']),
  ('R8 ack to anyone with the invite', S+'groupEngineSealed.ts', [("  if (!memberOf(rt.rep.view.state, from)) return false;\n", ""), ("  const addsMe = !!c && c.actor === from\n", "  const addsMe = !!c\n")], ['group_control_w2_review_fixes']),
  ('R9 no padding', S+'groupControl.ts', [("  const padded = unpadded.slice(0, -2) + '.'.repeat(Math.ceil(used / PAD_BUCKET) * PAD_BUCKET - used) + '\"}';", "  const padded = unpadded;")], ['group_control_envelope']),
  ('R10 one timeout disables the worker', S+'groupInviteVerify.ts', [("        if (worker === w) retire(why, why !== 'timeout');", "        if (worker === w) retire(why, true);")], ['group_invite_worker']),
  ('RR5a re-held not released again', S+'groupEngineControl.ts', [("    hold(rt, t, stored);\n    if (outcome === 'retry') releaseSoon(rt);\n    return 'held';", "    hold(rt, t, stored);\n    return 'held';")], ['group_control_w2_review_fixes']),
  ('RR5b held delete not persisted', S+'groupEngineControl.ts', [("    if (t === 'delete' && !rowId && !host.isStopped() && !rt.gone) {", "    if (false) {")], ['group_control_w2_review_fixes']),
  ('RR5b held deletes not restored', S+'groupEngine.ts', [("    control.restore(rt);   // 上次沒送出去的「為所有人刪除」\n", "")], ['group_control_w2_review_fixes']),
  ('RR10 timeouts fall back to the main thread', S+'groupInviteVerify.ts', [("    if (timeouts === 2) throw new Error('invite-verify-timeout');", "    void timeouts;")], ['group_invite_worker']),
  ('RR11 unacked invites forgotten', S+'groupEngineSealed.ts', [("      const row: PendingRow = { ...p, state: 'unacked', blob: null, args: JSON.stringify({ to, acked, sends, nextAt: -1 }) };\n      await ctx.deps.store.persistGroupLog({ gid, pendingUpsert: [row] });\n      rt.pending.set(id, row);", "      await done();")], ['group_control_w2_review_fixes']),
]


def fresh_copy():
    kit.make_copy(WORK + '/copy', COPY_DIRS, COPY_FILES)
    return WORK + '/copy/packages/pwa/src'


def run_test(t, dst):
    return subprocess.run(['node', f'scripts/review/{t}_self_test.mjs'], cwd=REPO, env={**os.environ, 'AEGISTALK_PWA_SRC': dst},
                          capture_output=True, text=True, timeout=1200)


only = set(sys.argv[1:])
os.makedirs(WORK, exist_ok=True)
baseline_bad = []
for t in sorted({t for m in MUTANTS if not only or m[0] in only for t in m[3]}):
    r = run_test(t, fresh_copy())
    print(f"baseline {t}: {'passes' if r.returncode == 0 else 'FAILS'}", flush=True)
    if r.returncode != 0:
        baseline_bad.append(t)
        print('\n'.join((r.stdout + r.stderr).splitlines()[-8:]), flush=True)
if baseline_bad:
    shutil.rmtree(WORK, ignore_errors=True)
    print(json.dumps({'baseline_failed': baseline_bad}))
    sys.exit(2)
results = []
for name, f, reps, tests in MUTANTS:
    if only and name not in only: continue
    dst = fresh_copy()
    p = dst + '/' + f
    s = open(p).read()
    ok = True
    for old, new in reps:
        if s.count(old) != 1:
            ok = False; print(f'!! {name}: pattern count {s.count(old)} in {f}: {old[:70]!r}', flush=True); break
        s = s.replace(old, new)
    if not ok:
        results.append((name, 'BAD-PATTERN', [])); continue
    open(p, 'w').write(s)
    outcome = []
    for t in tests:
        t0 = time.time()
        r = run_test(t, dst)
        tail = [l for l in (r.stdout + r.stderr).splitlines() if 'Error' in l or 'ERR_ASSERTION' in l or l.startswith('  ')]
        why = next((l.strip() for l in (r.stdout + r.stderr).splitlines() if 'AssertionError' in l or 'Error:' in l), '')
        outcome.append((t, 'FAILS' if r.returncode != 0 else 'passes', round(time.time() - t0), why[:160]))
    killed = any(o[1] == 'FAILS' for o in outcome)
    results.append((name, 'KILLED' if killed else 'SURVIVED', outcome))
    print(f"{'KILLED  ' if killed else 'SURVIVED'} {name}: " + '; '.join(f'{t} {st} ({sec}s) {why}' for t, st, sec, why in outcome), flush=True)
shutil.rmtree(WORK, ignore_errors=True)
killed = sum(r[1] == 'KILLED' for r in results)
print(json.dumps({'killed': killed, 'total': len(results)}))
sys.exit(0 if results and killed == len(results) else 1)

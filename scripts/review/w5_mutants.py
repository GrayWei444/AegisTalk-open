#!/usr/bin/env python3
"""
W5 mutation check (docs/GROUP_LOG_WIRING_W5.md): each mutant removes one W5 protection in a COPY of the repository (the real tree is
never touched); the named review tests must fail against the copy — on an assertion (a crash, a syntax error or a missing tool is
ERROR, not a kill). Baseline first: every named test passes on an unmutated copy, otherwise exit 2 and no mutant runs.
  python3 scripts/review/w5_mutants.py            # all mutants
  python3 scripts/review/w5_mutants.py "<name>"   # selected ones
The copy goes to $W5_MUTANT_DIR (default: a .w5-mutants folder next to the repo; packages/pwa/node_modules is linked into it) and is
deleted afterwards. The guardian mutants (official edition only) come from mutants_official.py (mutant_kit.py).
Exit code 0 only if every mutant is killed (and every pattern still matches the source).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('W5_MUTANT_DIR', str(Path(REPO).parent / '.w5-mutants'))
UV = kit.python_cmd(['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography', '--with', 'httpx', 'python'])
S = 'packages/pwa/src/services/'
HERE = 'group_here_refresh'
PRES = 'mqtt_presence_w5'
HARN = 'sim_adversary_harness'
REV = 'w5_review_fixes'
SIM = 'scripts/sim/lib/'
MUTANTS = [
  # ── 定時 here（groupEngine.ts／AppProvider.tsx） ──
  ('periodic here never scheduled', S+'groupEngine.ts', [("      scheduleHere();\n      syncAll();", "      syncAll();")], [HERE]),
  ('periodic here ignores needsHere', S+'groupEngine.ts', [("      if (needed) control.send(rt, 'here')", "      if (true) control.send(rt, 'here')")], [HERE]),
  ('periodic here while disconnected', S+'groupEngine.ts', [("    if (stopped || !ready || !deps.needsHere || !(deps.connected?.() ?? true)) return;", "    if (stopped || !ready || !deps.needsHere) return;")], [HERE]),
  ('periodic here right after another here', S+'groupEngine.ts', [("      if (since >= 0 && since < every / 2) continue;\n", "")], [HERE]),
  ('a stopped engine keeps the periodic here', S+'groupEngine.ts', [
     ("    if (hereTimer) clearTimeout(hereTimer);\n", ""),
     ("    if (stopped || !ready || !deps.needsHere || !(deps.connected?.() ?? true)) return;", "    if (!deps.needsHere || !(deps.connected?.() ?? true)) return;"),
     ("    if (stopped || !deps.needsHere) return;\n    const every", "    if (!deps.needsHere) return;\n    const every"),
     ("      if (rt.gone || rt.rep.status !== 'member') continue;\n      const last = control.lastHere", "      if (rt.rep.status !== 'member') continue;\n      const last = control.lastHere")], [HERE]),
  ('App asks for a periodic here even when everyone sees my presence', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("          && members.some((pk) => pk !== me && !(presenceRef.current?.sharesWith(pk) ?? false));", "          && members.length > 1;")], [HERE, REV]),
  ('periodic here in a group with someone I blocked', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("        return blocked !== null && !members.some((pk) => blocked.has(pk))\n", "        return blocked !== null\n")], [HERE, REV]),
  ('periodic here before the blocked list is loaded', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("        return blocked !== null && !members.some((pk) => blocked.has(pk))\n", "        return !members.some((pk) => !!blocked?.has(pk))\n")], [REV]),
  ('periodic here skipped while a P2P channel is open', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("          && members.some((pk) => pk !== me && !(presenceRef.current?.sharesWith(pk) ?? false));", "          && members.some((pk) => pk !== me && !(presenceRef.current?.sharesWith(pk) ?? false) && !webrtcService.isDataChannelOpen(pk));")], [REV]),
  ('here answered to a blocked member', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("      answerHere: (_gid, from) => from !== me && notBlocked(from) && !useChatStore", "      answerHere: (_gid, from) => from !== me && !useChatStore")], [REV]),
  ('App lets blocked members trigger replies', 'packages/pwa/src/providers/AppProvider.tsx', [("      mayReply: (_gid, from) => notBlocked(from),", "      mayReply: () => true,")], [REV]),
  ('blocked list fails open before it loads', 'packages/pwa/src/providers/AppProvider.tsx', [
     ("    const notBlocked = (pk: string): boolean => blockedNow !== null && !blockedNow.has(pk);", "    const notBlocked = (pk: string): boolean => !blockedNow?.has(pk);")], [REV]),
  ('a stale blacklist reload wins', 'packages/pwa/src/providers/AppProvider.tsx', [("        if (!engineGone && n === blockedLoad) blockedNow = new Set(", "        if (!engineGone) blockedNow = new Set(")], [REV]),
  ('engine ignores mayReply on a sync', S+'groupEngineControl.ts', [("        if (!previous && mayReplyTo(rt, m.sender)) reply(rt, m.sender);", "        if (!previous) reply(rt, m.sender);")], [REV]),
  ('engine ignores mayReply on an older-head here', S+'groupEngineControl.ts', [("        const replied = may && (verdict === 'they-are-behind'", "        const replied = !previous && (verdict === 'they-are-behind'")], [REV]),
  ('commit/delete judged on the capped clock', S+'groupEngineControl.ts', [("  const freshnessNow = (t: ControlKind): number => (t === 'commit' || t === 'delete' ? deps.now() : receiveNow());", "  const freshnessNow = (_t: ControlKind): number => receiveNow();")], [REV]),
  ('here/sync/call judged on the raw API clock', S+'groupEngineControl.ts', [("  const freshnessNow = (t: ControlKind): number => (t === 'commit' || t === 'delete' ? deps.now() : receiveNow());", "  const freshnessNow = (_t: ControlKind): number => deps.now();")], [REV]),
  ('replay table pruned on the later clock', S+'groupEngineControl.ts', [("  const pruneNow = (): number => Math.min(deps.now(), receiveNow());", "  const pruneNow = (): number => Math.max(deps.now(), receiveNow());")], [REV]),
  ('stopped engine keeps loading stored groups', S+'groupEngine.ts', [
     ("        if (stopped) return;\n        await loadStored(s);", "        await loadStored(s);"),
     ("  async function loadStored(s: StoredGroup): Promise<boolean> {\n    if (stopped) return false;\n    let loaded = await loadChainFromRows(s.meta.gid, s.rows, deps.verify);\n    if (stopped) return false;\n",
      "  async function loadStored(s: StoredGroup): Promise<boolean> {\n    let loaded = await loadChainFromRows(s.meta.gid, s.rows, deps.verify);\n"),
     ("deps.verify);\n      if (stopped) return false;\n      if (upTo.ok", "deps.verify);\n      if (upTo.ok"),
     ("    if (stopped) return false;\n    if (!loaded.ok || loaded.view.state.head.id !== s.meta.headId) {", "    if (!loaded.ok || loaded.view.state.head.id !== s.meta.headId) {"),
     ("    await seedPreviousTopic(rt);\n    if (stopped) return false;\n    project(rt);", "    await seedPreviousTopic(rt);\n    project(rt);")], [REV]),
  ('stop during chain verification ignored (only the checks after the awaits)', S+'groupEngine.ts', [
     ("    let loaded = await loadChainFromRows(s.meta.gid, s.rows, deps.verify);\n    if (stopped) return false;\n", "    let loaded = await loadChainFromRows(s.meta.gid, s.rows, deps.verify);\n"),
     ("deps.verify);\n      if (stopped) return false;\n      if (upTo.ok", "deps.verify);\n      if (upTo.ok"),
     ("    if (stopped) return false;\n    if (!loaded.ok || loaded.view.state.head.id !== s.meta.headId) {", "    if (!loaded.ok || loaded.view.state.head.id !== s.meta.headId) {"),
     ("    await seedPreviousTopic(rt);\n    if (stopped) return false;\n    project(rt);", "    await seedPreviousTopic(rt);\n    project(rt);")], [REV]),
  ('periodic here slower than the member TTL', S+'groupEngine.ts', [("export const HERE_REFRESH_MS = 4 * 60_000;", "export const HERE_REFRESH_MS = 12 * 60_000;")], [HERE]),
  # ── presence 的時鐘與順序（presenceSecret.ts／mqtt.ts） ──
  ('presence clock not bounded', S+'presenceSecret.ts', [("  return deviceNow + Math.max(-PRESENCE_MAX_CLOCK_SKEW_MS, Math.min(PRESENCE_MAX_CLOCK_SKEW_MS, off));", "  return deviceNow + off;")], [PRES]),
  ('freshness on the raw API clock', S+'mqtt.ts', [("      if (!acceptState(prev, opened.state, this._presenceNow())) {", "      if (!acceptState(prev, opened.state, this._serverNow())) {")], [PRES]),
  ('online TTL on the raw API clock', S+'mqtt.ts', [("    return stillOnline(this.friendPresence.get(friendPublicKey), this._presenceNow());", "    return stillOnline(this.friendPresence.get(friendPublicKey), this._serverNow());")], [PRES]),
  ('ordering reset by a forged clear (floor not consulted)', S+'mqtt.ts', [("      const prev = this.friendPresence.get(opened.owner) ?? this._presenceFloor.get(topic) ?? null;", "      const prev = this.friendPresence.get(opened.owner) ?? null;")], [PRES]),
  ('last state per topic never recorded', S+'mqtt.ts', [("      this._presenceFloor.set(topic, opened.state);\n", "")], [PRES]),
  ('last state per topic not pruned with the scope', S+'mqtt.ts', [("    for (const t of [...this._presenceFloor.keys()]) if (!keep.has(t)) this._presenceFloor.delete(t);\n", "")], [PRES]),
  ('last state per topic survives logout', S+'mqtt.ts', [("    this._presenceFloor.clear();\n", "")], [PRES]),
  # ── 送不出去的群訊（S13 找到的）──
  ('unsent text marked before its row is saved', 'packages/pwa/src/hooks/useGroupChat.ts', [("currentGroupId, messageId, 'text');\n      } finally {\n        if (!sent) {\n          await saved;\n", "currentGroupId, messageId, 'text');\n      } finally {\n        if (!sent) {\n")], ['group_unsent_status']),
  ('unsent text left as sent when the send throws', 'packages/pwa/src/hooks/useGroupChat.ts', [("currentGroupId, messageId, 'text');\n      } finally {\n", "currentGroupId, messageId, 'text');\n      } catch { return; } finally {\n")], ['group_unsent_status']),
  ('unsent voice marked before its row is saved', 'packages/pwa/src/hooks/useGroupChat.ts', [("currentGroupId, messageId, 'voice');\n      } finally {\n        if (!sent) {\n          await saved;\n", "currentGroupId, messageId, 'voice');\n      } finally {\n        if (!sent) {\n")], ['group_unsent_status']),
  ('unsent voice left as sent when the send throws', 'packages/pwa/src/hooks/useGroupChat.ts', [("currentGroupId, messageId, 'voice');\n      } finally {\n", "currentGroupId, messageId, 'voice');\n      } catch { return; } finally {\n")], ['group_unsent_status']),
  # ── 審查修正（w5_review_fixes） ──
  ('engine receive freshness on the raw clock', S+'groupEngineControl.ts', [("  const receiveNow = (): number => (deps.receiveNow ?? deps.now)();", "  const receiveNow = (): number => deps.now();")], [REV]),
  ('App feeds the raw API clock to the engine receive checks', 'packages/pwa/src/providers/AppProvider.tsx', [("      receiveNow: () => mqttService.boundedNow(),", "      receiveNow: () => mqttService.serverNow(),")], [REV]),
  ('call signals judged on the raw API clock', 'packages/pwa/src/providers/AppProvider.tsx', [("groupCallService.handleSignal(opened.from, opened.body, mqttService.boundedNow());", "groupCallService.handleSignal(opened.from, opened.body, mqttService.serverNow());")], [REV]),
  ('sealed envelope window on the capped clock (a phone with a wrong clock loses invites/keys)', S+'groupKeyDelivery.ts', [("kindLimits: KIND_LIMITS, now: mqttService.serverNow() },\n      x25519,", "kindLimits: KIND_LIMITS, now: mqttService.boundedNow() },\n      x25519,")], [REV, 'group_control_w2_review_fixes']),
  ('clock drift never noticed', S+'mqtt.ts', [("      this._noteClockDrift();\n", "")], [REV, 'mqtt_token_lifecycle']),
  ('presence service on the raw API clock', 'packages/pwa/src/providers/AppProvider.tsx', [("      now: () => mqttService.boundedNow(),\n      store: presenceStore,", "      now: () => mqttService.serverNow(),\n      store: presenceStore,")], [REV]),
  ('no presence re-check after a friend is fully removed', 'packages/pwa/src/providers/AppProvider.tsx', [("    const offRemoved = onFriendRemoved(reconcile);", "    const offRemoved = () => {};")], [REV]),
  ('friend-removed listeners fire before the contact row is gone', 'packages/pwa/src/stores/chatStore.ts', [
     ("  removeFriend: async (friendId) => {\n    const { messages, friends } = get();\n    const friend = friends.find((f) => f.id === friendId);",
      "  removeFriend: async (friendId) => {\n    const { messages, friends } = get();\n    const friend = friends.find((f) => f.id === friendId);\n    if (friend) for (const cb of friendRemovedListeners) cb(friend.publicKey);")], [REV]),
  ('withheld log never flagged', S+'groupEngineGossip.ts', [("      markConflict(rt, pk, 'server-behind-peer', head);\n", "")], [REV]),
  ('withheld-log flag never cleared after catching up', S+'groupEngineGossip.ts', [("        } else if (reason === 'server-behind-peer') clearConflict(rt, pk);\n", "        }\n")], [REV]),
  ('withheld-log flag from a round that started before the gossip', S+'groupEngineGossip.ts', [("      if (!complete || round <= saidAt) continue;\n", "      if (!complete) continue;\n")], [REV]),
  ('withheld-log flag from an incomplete round', S+'groupEngineGossip.ts', [("      if (!complete || round <= saidAt) continue;\n", "      if (round <= saidAt) continue;\n")], [REV]),
  ('withheld-log notice on every round', S+'groupEngineGossip.ts', [("      if (!reason) host.notice(", "      if (true) host.notice(")], [REV]),
  ('withheld-log record replaced by every later head', S+'groupEngineGossip.ts', [("      if (!rt.behindPeers.has(from) && rt.behindPeers.size < MAX_CONFLICT_PEERS)", "      if (rt.behindPeers.has(from) || rt.behindPeers.size < MAX_CONFLICT_PEERS)")], [REV]),
  ('catch-up clears a forked head', S+'groupEngineGossip.ts', [("        if (v === 'conflict') {\n          if (!reason", "        if (false) {\n          if (!reason")], [REV, 'group_control_w2']),
  ('server-behind-peer overwrites a stronger warning', S+'groupEngineGossip.ts', [("      if (reason && reason !== 'server-behind-peer') continue;", "      if (false) continue;")], [REV]),
  ('far-future share epoch accepted', S+'presenceService.ts', [("      if (parsed.secret.e > Math.floor(deps.now() / 1000) + MAX_FUTURE_EPOCH_S) { count('share-future-epoch'); return 'ignored'; }\n", "")], [REV]),
  ('far-future own epoch keeps growing', S+'presenceService.ts', [("e: nextEpoch(tooFar ? null : prev, deps.now())", "e: nextEpoch(prev, deps.now())")], [REV]),
  ('sharesWith ignores who holds my secret', S+'presenceService.ts', [("    sharesWith: (pk) => !stopped && !!self && !next && self.sharedWith.has(pk),", "    sharesWith: (pk) => !stopped && !!self && !next,")], [REV]),
  # ── 原生守護背景服務拿掉了（不能回來） ──
  ('native service back in the manifest', 'packages/pwa/android/app/src/main/AndroidManifest.xml', [('        <!-- FCM Service (offline push notifications) -->', '        <service android:name=".GuardianMqttService" android:exported="false" />\n        <!-- FCM Service (offline push notifications) -->')], ['guardian_logout']),
  ('logout no longer clears the native guardian data', 'packages/pwa/src/App.tsx', [("      await clearGuardianNativeData();", "      void clearGuardianNativeData;")], ['guardian_logout']),
  # ── 模擬的攻擊者工具（判得準才有意義） ──
  ('broker counts the attacker\'s denials as the app\'s', SIM+'broker.mjs', [("    if (isAdversary(label)) stats.adversaryDenied[what]++;\n    else if", "    if (false) stats.adversaryDenied[what]++;\n    else if")], [HARN]),
  ('broker withhold does nothing', SIM+'broker.mjs', [("      if (withholds.size && withheldFor(sess, topic, payload, from)) continue;\n", "")], [HARN]),
  ('malicious log server shows everyone the same log', SIM+'groupLogServer.mjs', [("      const seen = rules.size ? mislead(who, gid, r.entries, r.head) : { entries: r.entries, head: r.head };", "      const seen = { entries: r.entries, head: r.head };")], [HARN]),
  ('mock API counts attacker refusals as the app\'s', SIM+'mockApi.mjs', [("    const rejected = who && isAdversary(who) ? adversaryRejected : rejectedApp;", "    const rejected = rejectedApp;")], [HARN]),
]
MUTANTS += kit.official_mutants('w5')

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src', 'packages/pwa/android/app/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json', 'packages/pwa/vite.config.ts']


def make_copy(dst):
    # paths this checkout lacks are left out; the app's node_modules is linked in (mutant_kit.make_copy)
    kit.make_copy(dst, COPY_DIRS, COPY_FILES, ignore=('__pycache__', 'node_modules', 'res'))


ASSERTION = ('AssertionError', 'ERR_ASSERTION')


def failed_on_assertion(r):
    return r.returncode != 0 and any(a in (r.stdout + r.stderr) for a in ASSERTION)


def run_test(t, copy):
    try:
        if t.startswith('py:'):
            return subprocess.run(UV + [f'{copy}/scripts/review/{t[3:]}_self_test.py'], cwd=copy, capture_output=True, text=True, timeout=600)
        return subprocess.run(['node', f'{copy}/scripts/review/{t}_self_test.mjs'], cwd=copy,
                              env={**os.environ, 'AEGISTALK_PWA_SRC': f'{copy}/packages/pwa/src'}, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired as e:
        # 一個 mutant 讓測試掛住（例如留下的定時器）：算 ERROR，不算殺掉，也不讓整輪停掉
        out = e.stdout.decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
        return subprocess.CompletedProcess(e.cmd, 124, out, 'TIMEOUT')


only = set(sys.argv[1:])
selected = kit.runnable([m for m in MUTANTS if not only or m[0] in only])
os.makedirs(WORK, exist_ok=True)
# 基準：每個會用到的測試在沒改過的副本上都要過（不然「失敗」可能只是環境壞了）
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

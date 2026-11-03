#!/usr/bin/env python3
"""
W3 mutation check (docs/GROUP_LOG_WIRING_W3.md): each mutant removes one W3 protection in a COPY of the sources (the real
tree is never touched); the named review tests must fail against the copy.
  - packages/pwa/src mutants: the .mjs tests run against the copy (AEGISTALK_PWA_SRC)
  - api/ mutants: api/ and the Python test are copied next to each other (the test reads ../../api/chat/*), run with
    $AEGISTALK_PYTHON (else uv, else this interpreter)

  python3 scripts/review/group_w3_mutants.py            # all mutants
  python3 scripts/review/group_w3_mutants.py "<name>"   # selected ones

The copy goes to $W3_MUTANT_DIR (default: a .w3-mutants folder next to the repo) and is deleted afterwards. The src copy
comes with packages/pwa/tsconfig.json (esbuild resolves the '@ext/...' imports through its "paths") and the app's
node_modules linked in (mutant_kit.make_copy).
Exit code 0 only if every mutant is killed (and every pattern still matches the source).
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
SRC = REPO + '/packages/pwa/src'
WORK = os.environ.get('W3_MUTANT_DIR', str(Path(REPO).parent / '.w3-mutants'))
UV = kit.python_cmd(['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography', '--with', 'httpx', 'python'])
S = 'services/'
W3 = 'group_topics_w3'
W2 = 'group_control_w2'
MUTANTS = [
  # ── tid → group only through the engine's table ──
  ('gid accepted as a topic', S+'groupEngine.ts', [("      const hit = findTopic(tid);\n      return hit ?", "      const gidRt = runtimes.get(tid);\n      const hit = findTopic(tid) ?? (gidRt ? { rt: gidRt, kid: gidRt.rep.view.state.epoch.kid, current: true } : null);\n      return hit ?")], [W3, W2]),
  ('route hands out a gid-shaped id from any topic', S+'groupControlRoute.ts', [("  if (!isGroupTopicId(parts[2]) || parts[3] !== toUrlSafeBase64(message.from)) return null;", "  if (parts[3] !== toUrlSafeBase64(message.from)) return null;")], [W2]),
  ('kid back on the wire (links the tid to the gid through the log)', S+'groupControl.ts', [("  return { tid, envelope: { n: toB64(iv), c: toB64(new Uint8Array(ct)) } };", "  return { tid, envelope: { k: kid, n: toB64(iv), c: toB64(new Uint8Array(ct)) } as GroupSealed };")], ['group_control_envelope', W3]),
  ('envelope accepts extra fields', S+'groupControl.ts', [("  exactKeys(e, ['n', 'c'], 'envelope');\n", "")], ['group_control_envelope']),
  ('topic table not refreshed on projection', S+'groupEngine.ts', [("    refreshTopics(rt).catch((e) => log('topic refresh failed:', (e as Error)?.message ?? e));\n  }\n\n  // ====", "  }\n\n  // ====")], [W3]),
  ('removed group keeps its topics with the app', S+'groupEngine.ts', [("    emitTopics();   // 被踢、離開、刪群、忘掉：這個群的主題（含上一代的）馬上不訂了\n", "")], [W3]),
  # ── overlap ──
  ('no overlap (previous topic dropped at once)', S+'groupTopics.ts', [("    if (e.until === null) previous.push({ tid: e.tid, kid: e.kid, until: now + overlapMs });\n", "")], [W3, W2]),
  ('previous topic never expires', S+'groupTopics.ts', [("    else if (e.until > now) previous.push(e);", "    else previous.push(e);")], [W3, W2]),
  ('no cap on previous topics', S+'groupTopics.ts', [("    if (kept >= MAX_PREVIOUS_TOPICS) break;\n", "")], [W3]),
  ('future commit ts stretches the overlap', S+'groupTopics.ts', [("  const until = Math.min(startedAt, now) + overlapMs;", "  const until = startedAt + overlapMs;")], [W3]),
  ('overlap not restored after a restart', S+'groupEngine.ts', [("    await seedPreviousTopic(rt);\n", "")], [W3]),
  ('restored previous topic from a key that fails its kc', S+'groupEngine.ts', [("    if (until === null || !(await keyAuthorised(state, prev.kid, prev.kc, key))) return;", "    if (until === null) return;")], [W3]),
  ('expiry while opening not re-checked', S+'groupEngineControl.ts', [("    if (!live(rt) || !listed(rt, at)) return drop('old-epoch');\n", "")], [W3]),
  ('here/sync on the previous topic answered', S+'groupEngineControl.ts', [
     # W4: the here reply became `const replied = …` and a co-member's here may also be answered (answerHere) — both off the previous topic;
     # W5: both go through `may` (mayReply), the sync reply through mayReplyTo
     ("        const may = !previous && mayReplyTo(rt, m.sender);", "        const may = mayReplyTo(rt, m.sender);"),
     ("        if (!previous && mayReplyTo(rt, m.sender)) reply(rt, m.sender);", "        if (mayReplyTo(rt, m.sender)) reply(rt, m.sender);")], [W3]),
  ('late messages on the previous topic refused', S+'groupEngineControl.ts', [("  const listed = (rt: Runtime, at: { tid: string; kid: string }): boolean => rt.topics.some((e) => e.tid === at.tid && e.kid === at.kid);",
     "  const listed = (rt: Runtime, at: { tid: string; kid: string }): boolean => rt.topics.some((e) => e.tid === at.tid && e.kid === at.kid && e.until === null);")], [W3, W2]),
  # ── nothing on an old topic after the switch ──
  ('rekey notice sent after the switch', S+'groupEngine.ts', [
     ("    for (const a of own) if (entryOf(a).kid === fromKid) await control.notifyCommit(rt, a, entryOf(a), after);\n", ""),
     ("    if (after.epoch.kid !== fromKid) {\n      for (const a of own) if (entryOf(a).kid === after.epoch.kid) void control.notifyCommit(rt, a, entryOf(a), after);\n    }",
      "    for (const a of own) void control.notifyCommit(rt, a, entryOf(a), after);")], [W3, W2]),
  ('old-epoch publish not refused', S+'groupEngineControl.ts', [("    if (rt.rep.view.state.epoch.kid !== kid) { count(guarded ? 'resealed-later' : 'dropped:not-current-epoch'); return 'retry'; }\n", "")], [W3]),
  ('W2 order: notices after the switch and no current-epoch check', S+'groupEngine.ts', [
     ("    for (const a of own) if (entryOf(a).kid === fromKid) await control.notifyCommit(rt, a, entryOf(a), after);\n", ""),
     ("    if (after.epoch.kid !== fromKid) {\n      for (const a of own) if (entryOf(a).kid === after.epoch.kid) void control.notifyCommit(rt, a, entryOf(a), after);\n    }",
      "    for (const a of own) void control.notifyCommit(rt, a, entryOf(a), after);")],
   [W3], [(S+'groupEngineControl.ts', "    if (rt.rep.view.state.epoch.kid !== kid) { count(guarded ? 'resealed-later' : 'dropped:not-current-epoch'); return 'retry'; }\n", "")]),
  ('no grace after the switch (held messages released before members subscribed)', S+'groupEngineControl.ts', [("    rt.switchedAt !== null && deps.now() - rt.switchedAt < (deps.switchGraceMs ?? SWITCH_GRACE_MS);", "    rt.switchedAt !== null && false;")], [W3]),
  ('topic table not repaired when behind the chain', S+'groupEngine.ts', [("    if (topicsBehindChain(rt)) refreshTopics(rt).catch((e) => log('topic refresh failed:', (e as Error)?.message ?? e));\n", "")], [W3]),
  ('mqtt refusal ignored (counted as sent)', S+'groupEngineControl.ts', [("    if (deps.publish(tid, envelope as GroupSealed, { qos: QOS[t] }) === false) {", "    if (void deps.publish(tid, envelope as GroupSealed, { qos: QOS[t] }) as unknown as boolean) {")], [W3]),
  ('mqtt refusal retried at once (busy loop)', S+'groupEngineControl.ts', [
     ("    if (outcome === 'retry') releaseSoon(rt);\n    return 'held';", "    releaseSoon(rt);\n    return 'held';"),
     ("      if (outcome === 'retry') releaseSoon(rt);\n      return;", "      releaseSoon(rt);\n      return;")], [W3]),
  # ── mqtt.ts ──
  ('group messages queued while offline', S+'mqtt.ts', [("    if (!isGroupTopicId(tid) || !this.client?.connected) return false;\n",
     "    if (!isGroupTopicId(tid)) return false;\n    if (!this.client?.connected) { this._enqueueOutgoing(this.groupTopicFor(tid), JSON.stringify({ type, from: this.publicKeyBase64, payload, timestamp: this._serverNow() }), 1); return true; }\n")],
   ['mqtt_durable_puback', W2]),
  ('queued group-topic entries flushed (gid on the broker)', S+'mqtt.ts', [("    if (topic.startsWith('mist/group/') || topic === 'mist/broadcast') return null;", "    if (topic === 'mist/broadcast') return null;")], ['mqtt_acl_scope']),
  ('any group id in the token scope', S+'mqttCredential.ts', [("const GROUP_TOPIC_RE = /^[A-Za-z0-9_-]{22}$/;", "const GROUP_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;")], ['mqtt_acl_scope']),
  ('topics dropped from the scope stay subscribed', S+'mqtt.ts', [("    const drop = [...new Set([...this.subscribedGroupTopics, ...this._staleGroupTopics])].filter((t) => !desired.has(t));",
     "    const drop: string[] = [];")], ['mqtt_acl_scope', 'mqtt_group_resubscribe']),
  ('leftover session subscriptions kept after a restart', S+'mqtt.ts', [("          this._loadLeftoverGroupTopics();\n", "")], ['mqtt_group_resubscribe']),
  ('group topics not resubscribed after session loss', S+'mqtt.ts', [("          this.grantedGroupTopics.clear();\n          this.subscribedGroupTopics.clear();\n", "          this.grantedGroupTopics.clear();\n")], ['mqtt_group_resubscribe', 'mqtt_suback_refused']),
  ('refused group subscription reported as subscribed', S+'mqtt.ts', [("          if (code === undefined || code >= 0x80) {\n            // 沒訂成", "          if (code === undefined) {\n            // 沒訂成")], ['mqtt_suback_refused']),
  ('SUBACK codes read from the requested qos (mqtt.js 5 refusal)', S+'mqtt.ts', [
     ("    if (Array.isArray(fromPacket) && fromPacket.length === n && fromPacket.every((c) => typeof c === 'number')) return fromPacket as number[];\n", ""),
     ("    if (!err && Array.isArray(granted) && granted.length === n) return granted.map((g) => g.qos);", "    if (Array.isArray(granted) && granted.length === n) return granted.map((g) => g.qos);")], ['mqtt_suback_refused']),
  ('a partly refused batch counted as all refused', S+'mqtt.ts', [("    if (Array.isArray(fromPacket) && fromPacket.length === n && fromPacket.every((c) => typeof c === 'number')) return fromPacket as number[];\n", "")], ['mqtt_suback_refused']),
  ('SUBSCRIBE without SUBACK never resent on a new client', S+'mqtt.ts', [("            if (!this.grantedGroupTopics.has(t.split('/')[2])) this.subscribedGroupTopics.delete(t);\n", "")], ['mqtt_group_resubscribe']),
  ('shrinking scope swaps the token', S+'mqtt.ts', [("    if (aclScopeKey(scope) === this._tokenScopeKey) return true;\n    const held = this._tokenScope;", "    return aclScopeKey(scope) === this._tokenScopeKey;\n    const held = this._tokenScope;")], ['mqtt_token_lifecycle', 'mqtt_acl_scope']),
  ('previous-epoch topics not limited to the free slots', S+'mqttCredential.ts', [("previous.slice(0, Math.max(0, MAX_ACL_GROUPS - current.length))", "previous")], ['mqtt_scope_groups']),
  ('no scope while the topic table is late', 'providers/AppProvider.tsx', [("  const scopeTopics = groupTopics ?? (groupTopicsLate ? [] : null);", "  const scopeTopics = groupTopics;")], ['mqtt_scope_groups']),
  # ── WebRTC offer proof ──
  ('offer proof carries the kid', S+'offerProof.ts', [("      items.push({ t, m: bytesToB64(new Uint8Array(sig)) });", "      items.push({ t, m: bytesToB64(new Uint8Array(sig)), k: k.keyId } as OfferProofItem);")], ['offer_proof']),
  ('offer proof tid not re-derived from the local key', S+'offerProof.ts', [("      if (derived !== t) continue;\n", "")], ['offer_proof']),
  ('previous-epoch topics ranked before current ones', S+'mqttCredential.ts', [("  return [...current, ...previous.slice(0, Math.max(0, MAX_ACL_GROUPS - current.length))];", "  return [...previous.slice(0, Math.max(0, MAX_ACL_GROUPS - current.length)), ...current];")], ['mqtt_scope_groups']),
  # ── server ──
  ('server accepts any group id', 'api/chat/mqtt_auth.py', [('MQTT_GROUP_TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")', 'MQTT_GROUP_TOPIC_RE = re.compile(r"^[A-Za-z0-9_+#/-]{1,64}$")')], ['py:mqtt_token_acl']),
]


def run_test(t, src_copy, repo_copy):
    if t.startswith('py:'):
        name = t[3:]
        return subprocess.run(UV + [f'{repo_copy}/scripts/review/{name}_self_test.py'], cwd=repo_copy, capture_output=True, text=True, timeout=1200)
    return subprocess.run(['node', f'scripts/review/{t}_self_test.mjs'], cwd=REPO, env={**os.environ, 'AEGISTALK_PWA_SRC': src_copy},
                          capture_output=True, text=True, timeout=1200)


def fresh_copies():
    src_copy = WORK + '/app/packages/pwa/src'
    repo_copy = WORK + '/repo'
    shutil.rmtree(repo_copy, ignore_errors=True)
    kit.make_copy(WORK + '/app', ['packages/pwa/src'], ['packages/pwa/tsconfig.json'])
    shutil.copytree(REPO + '/api', repo_copy + '/api', ignore=shutil.ignore_patterns('__pycache__'))
    os.makedirs(repo_copy + '/scripts/review', exist_ok=True)
    shutil.copy(REPO + '/scripts/review/mqtt_token_acl_self_test.py', repo_copy + '/scripts/review/')
    return src_copy, repo_copy


only = set(sys.argv[1:])
os.makedirs(WORK, exist_ok=True)
# 基準（同 W4／W5）：每個會用到的測試在沒改過的副本上都要過 —— 不然「失敗」可能只是副本或環境壞了（例如副本 import 不到 api/chat）
baseline_bad = []
for t in sorted({t for m in MUTANTS if not only or m[0] in only for t in m[3]}):
    src_copy, repo_copy = fresh_copies()
    r = run_test(t, src_copy, repo_copy)
    print(f"baseline {t}: {'passes' if r.returncode == 0 else 'FAILS'}", flush=True)
    if r.returncode != 0:
        baseline_bad.append(t)
        print('\n'.join((r.stdout + r.stderr).splitlines()[-8:]), flush=True)
if baseline_bad:
    shutil.rmtree(WORK, ignore_errors=True)
    print(json.dumps({'baseline_failed': baseline_bad}))
    sys.exit(2)
results = []
for m in MUTANTS:
    name, f, reps, tests = m[:4]
    extra = m[4] if len(m) > 4 else []
    if only and name not in only: continue
    src_copy, repo_copy = fresh_copies()
    ok = True
    for file, old, new in [(f, o, n) for o, n in reps] + extra:
        p = (repo_copy + '/' + file) if file.startswith('api/') else (src_copy + '/' + file)
        s = open(p).read()
        if s.count(old) != 1:
            ok = False; print(f'!! {name}: pattern count {s.count(old)} in {file}: {old[:70]!r}', flush=True); break
        open(p, 'w').write(s.replace(old, new))
    if not ok:
        results.append((name, 'BAD-PATTERN', [])); continue
    outcome = []
    for t in tests:
        t0 = time.time()
        r = run_test(t, src_copy, repo_copy)
        why = next((l.strip() for l in (r.stdout + r.stderr).splitlines() if 'AssertionError' in l or 'Error:' in l or l.startswith('FAIL')), '')
        outcome.append((t, 'FAILS' if r.returncode != 0 else 'passes', round(time.time() - t0), why[:160]))
    killed = any(o[1] == 'FAILS' for o in outcome)
    results.append((name, 'KILLED' if killed else 'SURVIVED', outcome))
    print(f"{'KILLED  ' if killed else 'SURVIVED'} {name}: " + '; '.join(f'{t} {st} ({sec}s) {why}' for t, st, sec, why in outcome), flush=True)
shutil.rmtree(WORK, ignore_errors=True)
killed = sum(r[1] == 'KILLED' for r in results)
print(json.dumps({'killed': killed, 'total': len(results)}))
sys.exit(0 if results and killed == len(results) else 1)

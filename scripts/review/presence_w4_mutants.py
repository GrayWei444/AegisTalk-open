#!/usr/bin/env python3
"""
W4 mutation check (docs/GROUP_LOG_WIRING_W4.md): each mutant removes one W4 protection in a COPY of the repository (the real tree is
never touched); the named review tests must fail against the copy.
  The copy holds scripts/, api/, packages/pwa/src, packages/pwa/android and packages/pwa/package.json; every test runs from the copy
  (its root is ../../ of the test file) with AEGISTALK_PWA_SRC pointing at the copy's src, Python tests with $AEGISTALK_PYTHON
  (else uv, else this interpreter).

  python3 scripts/review/presence_w4_mutants.py            # all mutants
  python3 scripts/review/presence_w4_mutants.py "<name>"   # selected ones

The copy goes to $W4_MUTANT_DIR (default: a .w4-mutants folder next to the repo; packages/pwa/node_modules is linked into it) and is
deleted afterwards. The guardian-plugin mutant (official edition only) comes from mutants_official.py (mutant_kit.py).
Exit code 0 only if every mutant is killed (and every pattern still matches the source).
  Baseline first (W4 review #12): every test the selected mutants name runs once on an unmutated copy and must pass — otherwise exit 2
  and no mutant runs. A mutant counts as killed only when a test fails on an assertion (AssertionError in its output); a crash, a
  syntax error or a missing tool is reported as ERROR, not as a kill.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

import mutant_kit as kit
REPO = str(Path(__file__).resolve().parents[2])
WORK = os.environ.get('W4_MUTANT_DIR', str(Path(REPO).parent / '.w4-mutants'))
UV = kit.python_cmd(['uv', 'run', '--no-project', '--with', 'fastapi', '--with', 'pydantic>=2', '--with', 'pyjwt', '--with', 'cryptography', '--with', 'httpx', 'python'])
S = 'packages/pwa/src/services/'
SECRET = 'presence_secret'
SVC = 'presence_service'
MQ = 'mqtt_presence_w4'
WIRE = 'presence_w4_wiring'
MUTANTS = [
  # ── presenceSecret.ts ──
  ('AAD not bound to the topic', S+'presenceSecret.ts', [
     ("iv: toBuf(iv), additionalData: toBuf(utf8(p.topic)) }, await presenceKey(p.secret), toBuf(plain));", "iv: toBuf(iv) }, await presenceKey(p.secret), toBuf(plain));"),
     ("iv: toBuf(iv), additionalData: toBuf(utf8(p.topic)) }, await presenceKey(p.secret), toBuf(ct)));", "iv: toBuf(iv) }, await presenceKey(p.secret), toBuf(ct)));")], [SECRET]),
  ('open does not check the topic belongs to the secret', S+'presenceSecret.ts', [
     ("  checkSecret(p.secret);\n  await checkTopic(p.secret, p.topic);\n  let env", "  checkSecret(p.secret);\n  let env")], [SECRET]),
  ('stale online accepted', S+'presenceSecret.ts', [("  if (next.on === 1 && now - next.ts > ONLINE_FRESH_MS) return false;\n", "")], [SECRET, MQ, 'mqtt_freshness']),
  ('will of an older connection accepted', S+'presenceSecret.ts', [("  if (next.cs < prev.cs) return false;\n", "")], [SECRET, MQ]),
  ('online after its own offline accepted', S+'presenceSecret.ts', [("  if (prev.on === 0 && next.on === 1) return false;\n", "")], [SECRET, MQ]),
  ('online never expires (no TTL)', S+'presenceSecret.ts', [("  return !!st && st.on === 1 && now - st.ts < ONLINE_TTL_MS;", "  return !!st && st.on === 1;")], [SECRET, MQ]),
  ('extra plaintext fields accepted', S+'presenceSecret.ts', [("Array.isArray(o) || !exactKeys(o as Record<string, unknown>, ['on', 'ts', 'cs'])) reject", "Array.isArray(o)) reject")], [SECRET]),
  ('same-epoch conflict never resolved (iat ignored)', S+'presenceSecret.ts', [("  return (incoming.iat ?? 0) > (stored.iat ?? 0) ? 'new' : 'conflict';", "  return 'conflict';")], [SECRET, SVC]),
  ('same-epoch: the earlier-sealed secret wins', S+'presenceSecret.ts', [("  return (incoming.iat ?? 0) > (stored.iat ?? 0) ? 'new' : 'conflict';", "  return 'new';")], [SECRET, SVC]),
  ('older share replaces the current one', S+'presenceSecret.ts', [("  if (incoming.e < stored.e) return 'stale';\n", "  if (incoming.e < stored.e) return 'new';\n")], [SECRET, SVC]),
  ('unfriend/block never rotates', S+'presenceSecret.ts', [("  if (self.sharedWith.some((pk) => !recipients.has(pk))) return 'revoked';\n", "")], [SECRET, SVC]),
  ('new epoch not monotonic', S+'presenceSecret.ts', [("  return Math.max(okEpoch(prev) ? prev + 1 : 1, Math.floor(nowMs / 1000));", "  return Math.floor(nowMs / 1000);")], [SECRET]),
  ('share body with extra fields accepted', S+'presenceSecret.ts', [("  if (exactKeys(body, ['kind', 's', 'e', ...SEAL_FIELDS])) {", "  if (typeof body.s === 'string' && 'e' in body) {")], [SECRET]),
  # ── presenceService.ts ──
  ('blocked friends still get the secret', S+'presenceService.ts', [("    const out = new Set(deps.friends().filter((pk) => pk !== deps.me && !blocked.has(pk)));", "    const out = new Set(deps.friends().filter((pk) => pk !== deps.me));")], [SVC]),
  ('shares/requests from non-friends taken', S+'presenceService.ts', [("    if (from === deps.me || blocked.has(from) || !(await deps.isFriend(from))) { count('not-a-friend'); return 'ignored'; }\n", "")], [SVC, WIRE]),
  ('rotation without clearing the old topic', S+'presenceService.ts', [("      try { cleared = await deps.clearRetained(oldTopic); } catch { cleared = false; }", "      cleared = true;")], [SVC]),
  ('unconfirmed clear still switches', S+'presenceService.ts', [("      if (!cleared) { count('clear-not-confirmed'); return; }\n", "")], [SVC]),
  ('rotation keeps the secret (only e + 1)', S+'presenceService.ts', [("    return { s: random(32), e: nextEpoch(", "    return { s: self?.secret.s ?? random(32), e: nextEpoch(")], [SVC]),
  ('old topic still sealed while a rotation is pending', S+'presenceService.ts', [("      return !stopped && !!self && !next && !!myTag && topic", "      return !stopped && !!self && !!myTag && topic")], [SVC]),
  ('ex-friend secrets kept', S+'presenceService.ts', [("    for (const pk of [...peers.keys()]) if (!to.has(pk)) { peers.delete(pk); dropped = true; }\n", "")], [SVC]),
  ('empty friend list rotates (no database re-check)', S+'presenceService.ts', [("    for (const pk of doubtful) if (await deps.isFriend(pk)) out.add(pk);\n", "")], [SVC]),
  ('share changes not rate-limited (a friend forces token swaps)', S+'presenceService.ts', [("      if (stored && last !== undefined && now - last < SHARE_CHANGE_MIN_MS && !askedAt.has(from) && !clearedFrom.has(from)) {", "      if (false) {")], [SVC]),
  ('lost rotation share never re-asked (silent topic)', S+'presenceService.ts', [("{ count('peer-topic-silent'); await ask(pk); }", "{ count('peer-topic-silent'); }")], [SVC]),
  ('a stopped service keeps sending shares', S+'presenceService.ts', [("    if (!self || stopped) return false;", "    if (!self) return false;"), ("      if (stopped || self !== mine) return;", "      if (self !== mine) return;")], [SVC]),
  ('a stopped service still saves', S+'presenceService.ts', [("    if (stopped) return;   // 停掉之後", "    // 停掉之後")], [SVC]),
  ('sharedWith recorded only after sending', S+'presenceService.ts', [("    for (const pk of pks) mine.sharedWith.add(pk);\n    await persist();\n", ""), ("      if (!(await share(pk))) { mine.sharedWith.delete(pk); failed = true; }", "      if (await share(pk)) mine.sharedWith.add(pk); else failed = true;"), ("    if (failed) await persist();", "    await persist();")], [SVC]),
  ('a cleared old topic of a friend wipes his state', S+'presenceService.ts', [("!peers.has(parsed.owner) || peerTags.get(parsed.owner) !== parsed.tag) return false;", "!peers.has(parsed.owner)) return false;")], [SVC]),
  ('friend state before loading is dropped', S+'presenceService.ts', [("      if (!ready) {\n        let timer", "      if (false) {\n        let timer")], [SVC]),
  ('events before the stored state is loaded', S+'presenceService.ts', [("    reconcile: () => afterLoad(doReconcile),\n    onConnected: () => afterLoad(doReconcile),\n    onSealed: (from, body) => afterLoad(() => doOnSealed(from, body)),",
     "    reconcile: () => run(doReconcile),\n    onConnected: () => run(doReconcile),\n    onSealed: (from, body) => run(() => doOnSealed(from, body)),")], [SVC]),
  # ── mqtt.ts／mqttCredential.ts ──
  ('peers back in the token request', S+'mqttCredential.ts', [("    presence: scope?.presence ?? [],\n  };", "    presence: scope?.presence ?? [],\n    peers: [],\n  };")], [MQ, 'mqtt_acl_scope']),
  ('any presence string in the token scope', S+'mqttCredential.ts', [("  const p = [...new Set(presence.filter(isPresenceTopic))]", "  const p = [...new Set(presence.filter((t) => typeof t === 'string'))]")], [MQ, 'mqtt_acl_scope']),
  ('received presence not ordered (acceptState skipped)', S+'mqtt.ts', [("      if (!acceptState(prev, opened.state, this._presenceNow())) {", "      if (!acceptState(null, { ...opened.state, ts: this._presenceNow() }, this._presenceNow())) {")], [MQ, 'mqtt_freshness']),
  ('isFriendOnline ignores the TTL', S+'mqtt.ts', [("    return stillOnline(this.friendPresence.get(friendPublicKey), this._presenceNow());", "    return this.friendPresence.get(friendPublicKey)?.on === 1;")], [MQ]),
  ('retained accepted on any topic', S+'mqtt.ts', [("    if (retained && !presence) {", "    if (retained && false) {")], [MQ, 'mqtt_freshness', 'mqtt_acl_scope']),
  ('clearPresence on any topic', S+'mqtt.ts', [("    if (!client?.connected || topic !== this._myPresenceTopic()) return Promise.resolve(false);", "    if (!client?.connected) return Promise.resolve(false);")], [MQ]),
  ('shrinking presence scope swaps the token', S+'mqtt.ts', [("      && scope.presence.every((t) => held.presence.includes(t));", "      && scope.presence.join(',') === held.presence.join(',');")], [MQ]),
  ('a tag change does not swap the token', S+'mqtt.ts', [("    return scope.presenceTag === held.presenceTag && scope.groups.every", "    return scope.groups.every")], [MQ]),
  ('friend leaving the scope stays online', S+'mqtt.ts', [("    this._forgetPresenceOutside(this._aclScope.presence);\n", "")], [MQ]),
  ('TTL expiry not notified', S+'mqtt.ts', [("      else if (this._presenceNotified.get(pk)) this._notifyPresence(pk);   // TTL 已經過了：補通知「離線」\n", "")], [MQ]),
  ('empty payload on an old friend topic wipes his state', S+'mqtt.ts', [("        if (current && owner && this.friendPresence.delete(owner)) this._notifyPresence(owner);", "        if (owner && this.friendPresence.delete(owner)) this._notifyPresence(owner);")], [MQ]),
  ('graceful shutdown during a rotation keeps the old will', S+'mqtt.ts', [("      if (presenceTopic && !this._presenceCodec?.current(presenceTopic)) {\n        noWill = true;", "      if (false) {\n        noWill = true;")], [MQ]),
  ('a seal that outlived the rotation start is published', S+'mqtt.ts', [("    if (!payload || this.client !== client || !client.connected || this._myPresenceTopic() !== topic\n        || !this._presenceCodec?.current(topic)) return;", "    if (!payload || this.client !== client || !client.connected || this._myPresenceTopic() !== topic) return;")], [MQ]),
  ('presence back on the key-only topic', S+'mqtt.ts', [("    return tag ? `mist/user/${toUrlSafeBase64(this.publicKeyBase64)}/presence/${tag}` : null;", "    return tag ? `mist/user/${toUrlSafeBase64(this.publicKeyBase64)}/presence` : null;")], [MQ, 'mqtt_acl_scope']),
  # ── 群組引擎／App ──
  ('here does not report the member seen', S+'groupEngineControl.ts', [("        const answer = may && shouldAnswer(rt, m.sender);\n        memberSeen(rt, m.sender);\n", "        const answer = may && shouldAnswer(rt, m.sender);\n")], [WIRE]),
  ('a co-member\'s here is never answered', S+'groupEngineControl.ts', [("        if (answer && !replied && reply(rt, m.sender)) count('answered-here');", "")], [WIRE]),
  ('here answered although my own here is fresh (cascade)', S+'groupEngineControl.ts', [("    if (deps.now() - (hereAt.get(rt.gid) ?? -Infinity) < REPLY_MIN_INTERVAL_MS) return false;\n", "")], [WIRE]),
  ('App answers every here (friends, seen, open channel)', 'packages/pwa/src/providers/AppProvider.tsx', [("      answerHere: (_gid, from) => from !== me && notBlocked(from) && !useChatStore.getState().getFriendByPublicKey(from)\n        && !memberPresence.recentlySeen(from) && !webrtcService.isDataChannelOpen(from),", "      answerHere: (_gid, from) => from !== me,")], [WIRE]),
  ('early presence envelope dropped (no wait for the service)', 'packages/pwa/src/providers/AppProvider.tsx', [("          const presence = await waitForPresenceService(presenceRef, publicKey);", "          const presence = presenceRef.current;")], [WIRE]),
  ('presence envelope to another account\'s service', 'packages/pwa/src/providers/AppProvider.tsx', [("    if (service) return service.me === me ? service : null;", "    if (service) return service;")], [WIRE]),
  ('stopped presence effect still sends under the current account', 'packages/pwa/src/providers/AppProvider.tsx', [("      sendSealed: async (to, body) => (stopped || currentSealer()?.me !== me ? false : sendGroupSealed(to, body)),", "      sendSealed: (to, body) => sendGroupSealed(to, body),")], [WIRE]),
  ('stopped presence effect still sets the token scope', 'packages/pwa/src/providers/AppProvider.tsx', [("      onScope: (scope) => { if (!stopped) setPresenceScope(scope); },", "      onScope: (scope) => setPresenceScope(scope),")], [WIRE]),
  ('reconcile on every chat message', 'packages/pwa/src/providers/AppProvider.tsx', [("      if (keys === lastFriendKeys) return;\n", "")], [WIRE]),
  ('presence envelopes handed to the group engine', 'packages/pwa/src/providers/AppProvider.tsx', [("        if (opened.kind === 'presence') {", "        if (opened.kind === ('presence' as string) && false) {")], [WIRE]),
  ('health check ignores members seen via here', 'packages/pwa/src/providers/AppProvider.tsx', [("onlinePeersRef.current.has(pk) || memberPresence.recentlySeen(pk) || webrtcService.isPeerFailed(pk)", "onlinePeersRef.current.has(pk) || webrtcService.isPeerFailed(pk)")], ['group_peer_reach', WIRE]),
  ('here reach not throttled', 'packages/pwa/src/providers/AppProvider.tsx', [("      if (now - (reachedAt.get(pk) ?? 0) < 10_000) return;\n", "")], ['group_peer_reach']),
  ('presence not an identity-sealed kind', S+'groupKeyDelivery.ts', [("const KINDS = ['invite', 'ack', 'req', 'dist', 'call', 'presence'] as const;", "const KINDS = ['invite', 'ack', 'req', 'dist', 'call'] as const;")], [WIRE]),
  ('online dot back to "me only"', 'packages/pwa/src/components/GroupChat/GroupSettingsModal.tsx', [("online={!!member.isOnline || onlinePeers.has(member.publicKey)}", "online={!!member.isOnline}")], [WIRE]),
  ('member seen via here never expires', S+'memberPresence.ts', [("    return at !== undefined && now() - at < ttl;", "    return at !== undefined;")], [WIRE]),
  ('every here re-renders (notify without a flip)', S+'memberPresence.ts', [("      if (!was) notify(pk);", "      notify(pk);")], [WIRE]),
  ('online dot hook runs while the modal is closed', 'packages/pwa/src/hooks/usePeerOnline.ts', [("    if (!enabled) return undefined;\n", "")], [WIRE]),
  ('closed P2P channel does not mark the member offline', S+'memberPresence.ts', [("      if (seenAt.delete(pk)) notify(pk);", "      if (seenAt.has(pk)) notify(pk);")], [WIRE]),
  ('blocking is not announced', S+'localBlacklist.ts', [("    [pubkeyHash, 'manual', null, 0, now, pubkey, notes || null, nickname || null],\n  );\n  notifyChanged();", "    [pubkeyHash, 'manual', null, 0, now, pubkey, notes || null, nickname || null],\n  );")], [WIRE]),
  ('account wipe keeps the presence secrets', S+'storage.ts', [("    { statement: `DELETE FROM settings WHERE key LIKE 'presence_secret:%'`, values: [] },\n", "")], ['account_wipe_outbox']),
  ('kick wipe keeps the presence secrets', S+'deviceClaim.ts', [("      await wipePresenceSecrets();\n", "")], ['account_wipe_outbox']),
  ('account wipe keeps the remembered topics', S+'storage.ts', [("  wipeRememberedTopics();\n", "")], ['account_wipe_outbox']),
  ('kick wipe keeps the remembered topics', S+'deviceClaim.ts', [("    wipeRememberedTopics();\n", "")], ['account_wipe_outbox']),
  ('remembered-topic wipe misses the presence lists', S+'topicMemory.ts', [(" || k.startsWith(PRESENCE_TOPICS_KEY_PREFIX)", "")], ['account_wipe_outbox']),
  # ── 模擬的 PRESENCE 稽核 ──
  ('sim audit ignores a non-friend subscription', 'scripts/sim/lib/presenceAudit.mjs', [("      if (owner && owner !== ev.label && !isFriend(ev.label, owner)) find(`${ev.label} subscribed to", "      if (false) find(`${ev.label} subscribed to")], ['sim_presence_audit']),
  ('sim audit only counts the total (no per friend direction)', 'scripts/sim/lib/presenceAudit.mjs', [("      else find(`no presence of ${owner} was ever delivered to ${label} (a friend)`);", "")], ['sim_presence_audit']),
  ('sim audit ignores will payloads', 'scripts/sim/lib/presenceAudit.mjs', [("      checkPayload(ev, 'presence will');\n", ""), ("      checkPayload(ev, 'fired presence will');\n", "")], ['sim_presence_audit']),
  ('sim audit ignores the app never seeing a friend online', 'scripts/sim/lib/presenceAudit.mjs', [("        else find(`${label}'s app never saw its friend ${owner} online (isFriendOnline)`);", "")], ['sim_presence_audit']),
  ('sim audit ignores open-failed', 'scripts/sim/lib/presenceAudit.mjs', [("      if (st && honestFailed > 0) find(", "      if (false) find(")], ['sim_presence_audit']),
  ('sim audit accepts the key-only topic', 'scripts/sim/lib/presenceAudit.mjs', [("      if (!EXACT.test(t)) find(", "      if (!/^mist\\/user\\/[^/]+\\/presence(\\/[A-Za-z0-9_-]{22})?$/.test(t)) find(")], ['sim_presence_audit']),
  # ── server ──
  ('server accepts the key-only presence topic', 'api/chat/mqtt_auth.py', [('MQTT_PRESENCE_TOPIC_RE = re.compile(r"^mist/user/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]/presence/[A-Za-z0-9_-]{22}$")',
     'MQTT_PRESENCE_TOPIC_RE = re.compile(r"^mist/user/[A-Za-z0-9_-]{43}/presence(/[A-Za-z0-9_+#-]{1,22})?$")')], ['py:mqtt_token_acl', 'sim_server_acl']),
  ('server ignores extra fields (peers accepted)', 'api/chat/mqtt_auth.py', [('        model_config = ConfigDict(extra="forbid")\n\n        #: client 把簽章內容', '        #: client 把簽章內容')], ['py:mqtt_token_acl', 'sim_server_acl']),
  ('server lets me publish presence on any tag', 'api/chat/mqtt_auth.py', [('        pub.append(f"mist/user/{username}/presence/{presence_tag}")', '        pub.append(f"mist/user/{username}/presence/+")')], ['py:mqtt_token_acl', 'sim_server_acl']),
]
MUTANTS += kit.official_mutants('presence_w4')

COPY_DIRS = ['scripts', 'api', 'packages/pwa/src', 'packages/pwa/android/app/src']
COPY_FILES = ['packages/pwa/package.json', 'packages/pwa/tsconfig.json']


def make_copy(dst):
    # paths this checkout lacks are left out; the app's node_modules is linked in (mutant_kit.make_copy)
    kit.make_copy(dst, COPY_DIRS, COPY_FILES, ignore=('__pycache__', 'node_modules', 'res'))


ASSERTION = ('AssertionError', 'ERR_ASSERTION')


def failed_on_assertion(r):
    return r.returncode != 0 and any(a in (r.stdout + r.stderr) for a in ASSERTION)


def run_test(t, copy):
    if t.startswith('py:'):
        return subprocess.run(UV + [f'{copy}/scripts/review/{t[3:]}_self_test.py'], cwd=copy, capture_output=True, text=True, timeout=1200)
    return subprocess.run(['node', f'{copy}/scripts/review/{t}_self_test.mjs'], cwd=copy,
                          env={**os.environ, 'AEGISTALK_PWA_SRC': f'{copy}/packages/pwa/src'}, capture_output=True, text=True, timeout=1200)


only = set(sys.argv[1:])
selected = kit.runnable([m for m in MUTANTS if not only or m[0] in only])
os.makedirs(WORK, exist_ok=True)
# 基準：每個會用到的測試在沒改過的副本上都要過（審查 W4 #12：不然「失敗」可能只是環境壞了）
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

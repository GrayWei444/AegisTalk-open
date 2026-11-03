# Group log wiring — step W5 (adversarial simulation with Mallory), 2026-10-26

Background: [W1](GROUP_LOG_WIRING_W1.md#background-the-group-log-model) … [W4](GROUP_LOG_WIRING_W4.md) (each ends with what W5 must do).
Clean break: no compatibility paths were kept.

## 1. What changed in the app

### 1.1 W4 leftovers

1. **Periodic `here`** (`groupEngine.ts` `refreshHere`/`scheduleHere`, `groupEngineControl.lastHere`, App `needsHere`). Non-friend
   co-members only learn about each other from group-topic `here` (W4 `memberPresence`: 10 minutes without one → offline), so a
   member who stayed connected but silent dropped out of the health check and the online dot after 10 minutes. Now every group whose
   applied roster holds someone who cannot see my presence (not a friend holding my current secret, `presenceService.sharesWith`) gets a
   QoS0 `here` every 4 minutes (+0–10 % jitter; two chances inside the TTL). Not sent while MQTT is down (not queued: the reconnect
   announces), within half an interval of another `here` (a clock set back counts as "long ago"), after stop (also when stopped while
   loading), in a group with someone I blocked, or before the blocked list is loaded; held like any control message during needsRekey /
   missing key / switch grace. One failing round does not stop the timer. Friends-only groups send nothing extra. Receivers count it
   like any `here` (`onMemberSeen`); `answerHere` does not fire for someone seen recently, so no cascade.
2. **Bounded clock for short-window receive checks** (`presenceSecret.presenceClock`, `mqtt.boundedNow`). The device clock plus the API
   offset capped at ±5 minutes (`PRESENCE_MAX_CLOCK_SKEW_MS`) now judges: friend presence (`acceptState`, the online TTL, expiry
   timers, `isFriendOnline`), the presence service (rotation timer, share epochs), group control `here` / `sync` / `call`
   (`EngineDeps.receiveNow`) and in-call signals (`groupCallService.handleSignal`). An operator answering token requests with a
   `serverTime` far in the past can no longer make a recorded online, call start or `here` look fresh. Kept on the corrected clock
   (`serverNow`, W2 #1): everything I stamp, group `commit` / `delete` (24 h window; a replay only re-fetches / re-deletes) and the 7-day
   window of identity-sealed envelopes (invites, keys, requests: their content is checked against the chain and `kc`), so a phone whose
   own clock is wrong still gets invites, keys and deletes. The replay table is pruned on the earlier of the two clocks. A phone whose
   clock is more than 5 minutes off the server gets a banner (`clock-drift`, 5 languages): group calls and online dots may not come
   through until it uses automatic time.
3. **Last presence state per topic survives a clear** (`mqtt._presenceFloor`). W4: an empty retained message on a friend's current topic
   dropped his state, and with it the only thing older replays were ordered against; the operator could clear, then replay. Each exact
   friend topic now keeps its last accepted state (a genuine rotation moves to a new topic anyway); pruned with the scope, wiped on logout.
4. **Native guardian MQTT service removed** (decision asked for in W4; the guardian / family check-in feature is not part of the
   community edition). Since W4 `GuardianMqttService` acted on no inbox message, yet held a persistent broker session
   (`mist/user/<me>/inbox/+` → every inbox message queued twice) and a 30-day refresh token. Nothing depended on it. Removed: the service,
   its boot receiver and manifest entries, the Paho dependency, the plugin's start/stop calls, the client credential module and the
   server's guardian-token / refresh / revoke endpoints. What remains of the native check-in config stores only the strings the alarm
   screens read (no group ids or names, no members' keys or nicknames); logout / kick / device transfer clear it.

### 1.2 Holes found by the sim and the reviews (each with a test and a mutant)

| # | Found by | Hole | Fix |
|---|---|---|---|
| H1 | sim S13 | A message typed while waiting for a key was not sent (correct) but its row said `sent`: the `failed` update could land before the insert | `useGroupChat`: wait for the saved row, then mark `failed`; also when the send throws (`finally`) |
| H2 | sim P1 | Unfriending rotated the presence secret only at the next change: the reconcile ran while the contact row still existed, the DB fallback still saw a friend | `chatStore.onFriendRemoved` fires after the row is deleted; the presence effect reconciles on it |
| H3 | sim S12 | A server that only withholds entries from one member (no different entry, so head gossip only ever says "I am behind") was never shown | `groupEngineGossip.checkBehind`: a complete sync round started after a member's first report of a later head, still behind it → `logConflict` `server-behind-peer` (one notice); clears on catch-up; a fork found on catch-up becomes `head-differs`; never overwrites a stronger warning |
| H4 | review 1 M1 | Group control, call signals and sealed envelopes judged freshness on the uncapped API clock | §1.1 item 2 (short windows on the bounded clock) |
| H5 | review 1 M2, review 2 | Periodic `here`, answers to his `here`, replies to his `sync` / older-head `here` let a blocked co-member ask whether I am online | `needsHere` skips groups with someone I blocked; `answerHere` and the new `mayReply` dep exclude blocked senders; the blocked list fails closed until loaded, reloads are ordered |
| H6 | review 1 M3 | Periodic `here` in groups where everyone already sees my presence | `needsHere` uses `presenceService.sharesWith` |
| H7 | review 1 L1 | Presence service on the uncapped clock; a friend's far-future share epoch would outrank his real ones forever | service on `boundedNow`; shares with `e` > now + 1 day refused; my own far-future epoch restarts from now at the next rotation |
| H8 | review 1 L3/L4 | Periodic `here` stopped forever after one throwing round or a clock set back; an engine stopped while loading kept its timers | `since < 0` = long ago, `try/finally` reschedule, `stopped` checks before `ready` |
| H9 | review 1 L5, review 2 | The native check-in config kept the whole guardian roster at rest; upgraded phones kept it and the legacy credentials until logout | strings only; plugin `load()` clears the old format and `guardian_mqtt` |
| H10 | review 2 | `server-behind-peer` could erase a real fork warning; the timing used a clock that jumps on token refresh and was reset by every new head | §H3 rules, sync round counter instead of the clock, first report kept until caught up |
| H11 | review 2 | Bounded receive clock made invites / keys / deletes silently fail on a phone with a wrong clock (regressed W2 #1) | §1.1 item 2: those stay on `serverNow`; `clock-drift` banner |
| H12 | review 2 | An engine stopped while verifying stored chains could delete a stored group and project into the next account's screen | `loadStored` checks `stopped` after every await |
| H13 | review 1 L7 | Sim harness: the attacker label check was duplicated; withholds did not cover retained-at-subscribe | shared `isAdversary`; withhold applies to retained messages too |

### 1.3 Independent reviews

Two independent read-only reviews saw the code, not the author's conclusions. **Review 1** (the W5 diff): M1–M3 and L1, L3–L5, L7
above (H4–H9, H13), all fixed. **Review 2** (the fix round): no CRITICAL/HIGH, 3 MEDIUM, 8 LOW.
- MEDIUM, fixed: the capped clock on 7-day envelopes and on commit/delete regressed W2 #1 (H11); `checkBehind` could overwrite and then clear a
  real fork warning (H10); a blocked member could still probe via `sync` replies (H5).
- LOW, fixed: far-future own epoch (H7), blocked list failing open (H5), open-channel check suppressing the periodic `here` (H6), fragile
  timing of `checkBehind` (H10), stop during load (H12), throw in the unsent path (H1), legacy guardian data on upgraded phones (H9), stale
  comments.
- Changed differently than suggested: on a fork found at catch-up the reviewer suggested an immediate rebuild check. The entry was just
  fetched from the same server, so asking again at once mostly gets the same answer and spends the per-group rebuild budget (1/min); the
  warning is shown at once and the check runs on the next disagreeing head (W2 test `group_control_w2` §3 shows the recovery).
- Not changed: group bubbles have no send-status UI (pre-existing; §5). The sim P2 check of Dave's fresh state on a −5-minute-capped clock
  passes by the latency margin (cap = future window); that is the intended edge, not a flake source (latency is always positive).
- Mutation runs found two weak tests, both tightened: the "stopped engine keeps its periodic `here`" mutant survived because `stop()` also
  clears the runtimes (the test now also counts `connected()` calls after stop), and the "stopped engine keeps loading" mutant survived
  because inner checks caught it (the test now stops the engine inside the chain verification).

## 2. The harness

- **Mallory** (`scripts/sim/lib/adversaryKit.mjs`): in-process Node MQTT 5 clients (`mqtt-packet`, async both ways) with real tokens from
  the mock API (`/api/mqtt/token`, Ed25519-signed request with his own account key), real signatures, the app's pure modules bundled with
  esbuild (`groupControl`, `groupState`, `identitySeal`, `presenceSecret`…). Attackers: Mallory (his own account), `Bob~shadow` (a second
  client with removed Bob's real key and token, S2X) and the operator (broker / log server / API). Their ACL denials and API refusals are
  counted apart from the app's (`adversaryDenied`, `adversaryRejected`).
- **Broker** (`lib/broker.mjs`): `inject` (as the operator, any topic, retained or not), `tap`/`spy`, `withhold`/`release` (per client,
  topic and payload predicate; also retained-at-subscribe), `expireSession`, `refuseConnect`, `dropClientsWhere`.
- **Malicious log server** (`lib/groupLogServer.mjs`, the real `group_log_routes.py` behind it): per-member `equivocate` (a different
  entry at the same seq), `swap`, `withhold` (entries after a seq), `clear`; `injectEntry`.
- **Mock API**: `serverTimeSkew` per phone — the lying-clock operator: token `serverTime`, `clock_skew` detail, and the signature
  windows of what the app signs with `serverNow` (token, group log); push requests (then signed with the device clock) are judged on the
  real time.
- **In-page hook** `window.__simAdversary` (`lib/simAdversary.ts`): only in the sim build (`vite.sim.config.mjs`); the app build has 0
  mentions (checked on every build). It forges commits / control messages with the page's own key (S10), reads engine state, notices,
  presence state and the clock offset, and unfriends / blocks through the real stores.
- **Audits** after all scenarios, honest phones only: BROKER-ACL (app `deniedPub` = `deniedSub` = 0), API-AUTH (no app request refused),
  LEAK (every app publish and will scanned for group names, guardian settings, other members' keys; group topics carry only `{n, c}`),
  GROUP-TOPICS (no gid / kid on the broker), PRESENCE (each presence topic only ever carries the owner's current-secret states, the old topic
  is cleared after a rotation and nothing is published on it afterwards).

## 3. Attacks and results

4 phones (Alice, Bob, Carol, Dave; B, C, D not friends with each other) + Mallory + the operator, real app build (sim bundle), one
Chrome per phone, mock MQTT 5 broker with the production ACL, mock API with the real token ACL and the real log routes.
Evidence numbers are from run 2 (188 checks, 0 failed); the final runs 4 and 5 on the final code give the same picture (§4).
"Required" = the scenario fails without it.

| ID | Attack | Expected | Result | Evidence (run 2) |
|---|---|---|---|---|
| S2X | Removed Bob keeps a second client with his real key and token: old topic, key requests, sync, a `here` sealed with the old key "as Carol"; Alice renames, makes it a guardian group, adds Dave, starts a call | Bob learns only his removal | PASS | token 200 + SUBACK on the old tid, the gid and 3 guessed tids (server grants any well-formed tid); on the old topic he reads exactly his removal notice, nothing after; 0 deliveries on the 5 post-removal tids; 0 keys / invites / inbox writes to him; his sync dropped unopened (non-member); forged `here` → `bad-envelope`; his retained key opens his removal entry and none of the 4 later entries |
| S8 | Operator / Mallory injection: forged, self-signed and "from admin" add commits in the log, garbage and plaintext adds on the group topic, forged invites to Carol and Dave, Mallory's key requests; Alice relays Mallory's valid chain | nothing changes, nothing answered | PASS | Mallory's appends 200/200 + operator entry at seq 9, all skipped by every replica (rosters, admins, name, key, head unchanged); member-suffix publish and foreign subscribes 0x87; 0 writes to Mallory's inbox; forged invites dropped unopened / signature fails; relay rejected `sender-is-not-the-adder` (required); 1 forged `group_sealed` `bad-envelope` |
| S9 | Replay: S2/S3 log entries re-appended, old invites, old `group_sealed` (removal, here, commit, call), old call signals; a fresh delete replayed inside its window | no effect, Bob not re-added | PASS | 3 entries re-appended (seq 10–12), 12 sealed envelopes, 16 `group_sealed` re-injected → 23 dropped (replay / stale / unknown topic / non-member), 12 re-opened idempotently (re-fetch / re-delete); in-window replay dropped as replay by Carol and Dave (required ≥ 2: 2); nothing rings; Bob has no group |
| S10 | Dave (plain member) signs forged commits with his own key: remove Carol, promote himself, rename, rekey, add Mallory "by Alice" | rejected by every replica, Dave's included | PASS | 5 commits appended at seq 13–17, every replica skipped them and processed past them |
| S11 | Carol offline longer than her broker session while Alice removes Dave and renames; Dave re-added | converges from the log alone | PASS | session expired; Carol converged in 2 s (roster, name, key, head); re-add rotates the key, all agree |
| S12 | Equivocation: Carol's rename served to Dave as a different entry at the same seq; then Carol's next rename withheld from Dave | conflict in the UI, no forged state adopted, recovery; withholding flagged | PASS | forged entry served 2×: warning on the group screen, name / roster / key unchanged, rebuild to Carol's chain once honest, warning clears; withheld log served 1×: `server-behind-peer` warning (required) while the old name stays, cleared after catch-up |
| S13 | Broken admin (Carol) rotates leaving Dave out of the bundle; operator withholds Carol's key replies; a wrong key (right kid, wrong bytes) is let through | Dave waits, never uses the old key, recovers | PASS | waiting-key in state and on screen; no sending key; wrong key refused (kc), no row stored; Dave's message while waiting reaches nobody and is `failed` on his phone (H1); no group-topic publish from Dave; Carol's key reply withheld 1× while Dave still waits (required); recovery after release |
| S14 | Floods: a friend sends Carol 30 invites, Mallory floods invites, plaintext legacy group types and 300 forged `group_sealed` under Carol's suffix | ignored and rate-limited | PASS | ≤ 3 invites per sender stored (3), 2 log probes for 30 invites (budget 2/min), Mallory's invites dropped unopened; Dave decrypted 123 of 300 (≤ budget 167), 123 `bad-envelope`, 123 non-member; group keeps working |
| P1 | Presence: request floods (non-friend co-member, friend, Mallory), Dave's will withheld, A unfriends B then blocks C, crafted ciphertext and replayed states on Dave's topic, guessed tags, Dave offline across a rotation | rotations clean, nothing leaks, pushes still sent | PASS | non-friend 20 requests: 0 answers; friend 20: ≤ 1/min; Mallory: 0; withheld will → offline by the 10-minute rule; each rotation: old topic cleared before the new tag, nothing else published on it afterwards (required), no retained state; ex-friend and blocked opened nothing after their rotation; guessed tags deliver nothing; crafted ciphertext `open-failed`; push sent despite forged / replayed states; Dave recovers through the silent-topic request (~635 s); 5 replayed old shares refused |
| P2 | API operator lies to Alice: token `serverTime` 30 minutes early; clears Dave's topic, replays his ~20-minute-old online | not fooled; user told; recovers | PASS | offset −30 min taken; `clock-drift` banner (30 min); Dave still online (bounded clock); forged clear → offline (safe side); replay refused (`outOfOrder`); real reconnect → online; offset back to −0.6 s after the lie stops |
| T1 | Token requests with `+`, `#`, `/`, 21/23-char or old-format group ids, 51 ids, key-only / wildcard / extra-level presence topics, `+` tag, `peers`, an unknown field | whole token refused 400/422 | PASS | 16/16 refused as expected; exact forms 200 |
| — | Audits (honest phones only) | | PASS | BROKER-ACL app `deniedPub` = `deniedSub` = 0 (attackers: pub 2, sub 4; operator injected 360, withheld 2); API-AUTH app rejected {} (attackers' refused token requests: 17), 48 signed pushes, 0 with names; LEAK 56 group-topic publishes, all `{n, c}` `group_sealed`, 498 publishes / wills scanned, 0 findings; GROUP-TOPICS 0 gid / kid on the broker over 1219 events, 0 deliveries to Bob on post-removal tids; PRESENCE 0 findings over 436 topics / rules, friend directions 6/6, non-friend probes 5/5 refused; NETWORK-GUARD 0 requests left localhost |

The regular scenarios (SETUP, D1, S1–S7, LATE) pass alongside.

## 4. Verification

- **Builds** (fresh checkout per run): wasm OK, full `tsc` 0 errors, `vite build` OK (app bundle: 0
  mentions of `__simAdversary`; sim bundle: the hook in 1 chunk), eslint on the changed files 0 errors (4 old warnings in
  `AppProvider.tsx`, none in W5 lines), Gradle `compileDebugKotlin` + Java OK (native code changed: plugin `load()` cleanup).
  Last run on the final code: same results.
- **`scripts/review`**: 101 of 102 pass. The one failure (Python) needs the official edition's identity service, which is not in this
  repository; it fails the same way before W5. Updated because they pinned old wiring (no assertion weakened): `group_call_identity` and
  `group_control_w2_review_fixes` (call signals on `boundedNow`; the 7-day envelope window stays on `serverNow`), `presence_w4_wiring` and
  `group_here_refresh` (blocked list in `answerHere` / `needsHere`), `mqtt_token_lifecycle` (a working retry now also shows
  `clock-drift`), `group_control_w2` §3 (B warns one step earlier — at catch-up — and asks the server on the next head).
  New: `w5_review_fixes` (9 sections), `group_unsent_status`, plus the earlier W5 tests (`group_here_refresh`, `mqtt_presence_w5`,
  `sim_adversary_harness`, `sim_leak_check` W5 part).
- **Mutation runs** (each mutant removes one protection in a copy; killed only by an assertion): W5 62/62, W2 46/46, W3 39/39,
  W4 77/77 on the final code.
- **4-phone + Mallory sim, all scenarios**: run 1 failed S5 and API-AUTH for harness reasons (S5 closed Carol's page 3 ms after her own
  send, inside the app's documented 2-s DB debounce; the P2 lie also covered push signatures the app then signed with the device clock)
  and showed the S13 withhold matched nothing — fixed in the harness, no app change. Run 2: every scenario and audit PASS, 188 checks,
  0 failed (P1 662 s, S13 87 s). Run 3 failed one S13 check: the sim hook writes Carol's broken rekey straight into the log, and her own
  engine took 23 s (next poll / someone's head) to apply it, past the 20-s wait — harness timing, fixed (S13 asks her engine to sync,
  waits up to 60 s). **Runs 4 and 5 on the final code: all 21 scenarios and 6 audits PASS, 188 checks each, 0 failed** (S13 77 s,
  P1 662–663 s, P2 14 s; LEAK 55 / 54 group-topic publishes `{n, c}` only, 489 / 502 publishes and wills scanned, 0 findings;
  GROUP-TOPICS 0 over 1203 / 1226 events; PRESENCE 0 over 436 / 437; BROKER-ACL app 0/0, attackers pub 2 sub 4 each; API-AUTH app
  rejected {} both).

## 5. Limits (by design or for later)

- Co-members who are not friends see each other online in a shared group (periodic `here`); a blocked co-member still sees my
  `here` when I really connect and my messages. Leaving the group is the way out.
- A member can claim any head: a lying member makes the others show a `logConflict` for him (as `head-differs` already could). The
  warning names nobody in the UI.
- A phone whose own clock is more than 5 minutes off loses group calls, `here` and friend online dots until it uses automatic time
  (banner); before W5 an operator could shift those windows arbitrarily.
- The operator can still drop anything (withhold, refuse connects): every such attack ends in "waiting" or "offline", never in the old key,
  a forged member or a plaintext leak — but availability is his.
- Group message bubbles do not render a send status yet (pre-existing UI gap): an unsent message is `failed` in the database and the
  key-wait banner is shown, the bubble itself looks normal.
- Friend graph on the broker: presence topics name the owner (`mist/user/<owner>/presence/<tag>`), so the broker sees who subscribes to
  whose topic (W4 limit, unchanged).

## 6. Open items and later changes

- **Server code.** The chat server (`api/chat_app.py`) mounts `api/chat/*` and `api/group_log_routes.py`. The sim runs the real ACL
  (`mqtt_acl` via `scripts/sim/lib/server_acl.py`) and the real log routes (`group_log_bridge.py`), so the sim and the Python tests test
  the code a server runs.
- **Log append is open to any registered account that knows a gid** (S8: Mallory's append is stored; every replica rejects it). Fine for
  safety and bounded by the quotas (60 appends/min and 16 MiB/day per account, 30/min and 4 MiB/day per account+gid, global caps), but
  junk still takes seq numbers in a real group. Still open: a member-held append token per group (derived from the epoch key, like the
  tid) so outsiders cannot write at all.
- **Broker ACL** (`docs/MQTT_BROKER.md`): the server grants any well-formed 22-char tid and any well-formed presence topic in the
  requested scope — it cannot know membership or friendship (end-to-end). Guessing is cheap to refuse (random tids, secret tags), the sim
  shows nothing is delivered on guessed topics, and the server limits how many distinct group / presence topics one account can obtain per
  24 hours (`CHAT_TOKEN_TOPICS_PER_DAY`).
- **Mock API = the contract.** `scripts/sim/lib/mockApi.mjs` encodes what the app expects (`serverTime`, `clock_skew` detail, signed
  pushes, the token shape, the 400/422 rules of T1, keys-only accounts: every sim phone registers through `POST /api/account/register`, and
  claim, push, short codes and group-log appends refuse keys without an account; short codes are signed). It doubles as a conformance test
  for other server implementations. The simulation runs on any machine with `scripts/sim/local-run.sh` (it reads the edition
  from the build's `dist/aegis-edition.json`); the real server is checked against the docker compose example by
  `scripts/selfhost/conformance.sh` (smoke test, two browsers, reverse-proxy settings; `docs/SELF_HOSTING.md` "Check your
  server").
- **Push signing.** Push requests used to be signed with the device clock, so a phone more than 5 minutes off could not send pushes (seen
  in sim run 1, P2). They are now signed with `serverNow` and retried once on `clock_skew` (`docs/DIRECT_SEALED.md` §6).
- **1:1 signalling.** `PROFILE_UPDATE`, WebRTC SDP/ICE and push-subscription updates were still plaintext 1:1 inbox types at the end of
  W5. Since `docs/DIRECT_SEALED.md` every 1:1 signal is one sealed `direct_sealed` type, `X3DH_INIT` carries no name, calls and
  DataChannels are usable only after the DTLS fingerprints cross-match, `group_msg_ack` is signed, and LEAK fails on any plaintext 1:1
  type, push hint or readable display name. Since step 5d group calls check the DTLS fingerprints per peer connection too, and a
  full-screen ring from a push needs the caller's signed ring token (`docs/DIRECT_SEALED.md` §4).
- **Guardian.** The guardian / family check-in feature is not part of the community edition; nothing guardian-related is on the chat
  server.
- **Keep `scripts/sim` and `scripts/review` together.** The mutation runners copy `scripts`, `api`, `packages/pwa/src` and the Android
  sources. The sim hook (`scripts/sim/lib/simAdversary.ts`) and the attacker kit live under `scripts/sim` only; the app build has no
  reference to them.

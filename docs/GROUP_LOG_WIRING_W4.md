# Group log wiring — step W4 (friends-only secret presence), 2026-10-25

Background: [W1](GROUP_LOG_WIRING_W1.md#background-the-group-log-model), [W2](GROUP_LOG_WIRING_W2.md), [W3](GROUP_LOG_WIRING_W3.md).
Design choice: one secret presence topic per user, shared only with friends. Rejected alternatives: per-pair topics (no last will),
inbox-only presence (no retained state, slow), server-checked grants (the server would have to learn the social graph).
Clean break: the old `mist/user/<pk>/presence` topic, the `presence` MQTT type, the token's `peers` list and the inbox `check_in_reminder`
are gone.

## What changed

1. **One secret presence topic per user** (`services/presenceSecret.ts`, pure). `mist/user/{me}/presence/{tag}` with
   `tag = b64url(HMAC-SHA256(S, "aegistalk-presence-v1|" + e)[:16])` (22 chars). S = 32 random bytes, e = epoch (only grows:
   `max(e + 1, now in seconds)`, so a restored or new device still beats the shares its friends hold). Payload `{n, c}` only:
   AES-256-GCM under `HKDF-SHA256(S, salt = empty, "aegistalk-presence-key-v1|" + e)`, **AAD = the topic**; plaintext `{on: 0|1, ts, cs}`
   (`cs` = when this MQTT connection started: the will, the online and the 4-minute refreshes share it). No sender field, no public key, no
   readable state on the wire. An empty retained payload = the owner cleared the topic (rotation).
   Receivers order states with `acceptState`: an online must be ≤ 5 min old; an offline of any age is taken (the will is written at connect
   time); a state of an older connection (`cs` smaller) or an online after the same connection's offline is refused; nothing more than 5 min in
   the future. Online expires 10 min after its last refresh (`ONLINE_TTL_MS`; the sender refreshes every 4 min).
2. **Secrets only between friends** (`services/presenceService.ts`, store `presenceStore.ts` = settings row `presence_secret:<me>`).
   Shares `{kind: 'presence', s, e}` and requests `{kind: 'presence', have}` travel as identity-sealed `GROUP_KEY_SEALED` envelopes
   (`groupKeyDelivery` kind `presence`, ≤ 64 KB, exact fields). Recipients = friends minus blocked (a friend list that is momentarily empty is
   re-checked against the database before anyone counts as removed). A share is taken only from a current, unblocked friend and only if its
   epoch is newer than the one held (replays refused); two different secrets of the same epoch (two creations in one second) → the one sealed
   later (the envelope's signed `iat`) wins. A friend's secret changes at most once per 10 min unless I asked for it or his current topic was
   just cleared (a friend cannot force endless token swaps). A request is answered only for a current friend (1/min each). Missing secrets are
   requested with a backoff (2 min, 10 min, 1 h, 6 h); a friend whose current topic was emptied is asked again (10 min), and so is a friend
   whose subscribed current topic stays empty for 10 min (the broker always keeps the owner's last state, so an empty topic means my copy is
   stale: his rotation share was lost). A share from a friend I have not sealed to yet is answered at once (the first share of a new
   friendship can arrive before the other side lists me as a friend). A friend is added to `sharedWith` and saved **before** his share goes
   out (a crash mid-way cannot hide him from the next revocation); failed sends are removed again.
   Every operation waits until the stored state is loaded (an early envelope must not overwrite it); a friend state that arrives before that
   waits up to 10 s; a failed load stops the service. After `stop()` (account switch, logout, wipe) work still in flight sends, saves and
   changes the scope no more; the App side also refuses to seal once its effect stopped or another account's sealer is active, and a presence
   envelope that arrives before the service exists waits for it (≤ 60 s, same account only).
3. **Rotation** (unfriend, block, 30-day timer) — always a new S and a larger e, in two steps: (1) the new secret is stored as `next`; from
   now on nothing is published on the old topic (no online, refresh or will — the codec refuses to seal); (2) while connected and the token
   can still publish the old topic, an **empty retained** message clears it (`mqttService.clearPresence`, waits for the PUBACK); only then the
   new tag is used (token swap, 250 ms) and the new secret is sealed to every remaining friend (one envelope each). No PUBACK → stays pending,
   retried on the next connect. The removed friend keeps only the old S: the old topic is empty and silent, the new tag cannot be derived
   (new S), the new state does not open, and requests are ignored. Ex-friends' and blocked friends' secrets are dropped at once (their topic
   leaves the scope). Reconcile runs on start, when the set of friend keys or the blacklist changes (`localBlacklist.onBlacklistChanged`; not
   on every message that touches the friend list), on every MQTT connect and every 5 minutes. Recipients are recomputed after the clear (a
   friend removed during it gets nothing).
4. **mqtt.ts.** `setAclScope(groupTopics, { tag, topics }, owner)`: token scope = group tids + my tag + exact friend presence topics (≤ 150).
   The will and the online/refresh/graceful-offline states are sealed by the presence codec on `mist/user/{me}/presence/{tag of the token}`;
   friend topics follow the scope like group topics (`_syncPresenceTopics`: subscribe what the token grants, unsubscribe what left, leftovers
   of a surviving broker session remembered in `aegis_mqtt_presence_topics:<user>`, unconfirmed SUBSCRIBEs resent on a new client). A
   shrinking presence scope keeps the token; a new friend topic swaps it after 2 s; a new tag after 250 ms. Messages on a presence topic
   bypass the normal message path: empty → `codec.cleared` (only on the friend's **current** topic: his state is dropped and the codec asks
   for the new secret; an empty message on an old topic changes nothing); otherwise `codec.open` (only the current topic of a friend whose
   secret I hold) → `acceptState` → `isFriendOnline` / `onPresenceChange` (offline is notified when the TTL lapses).
   Retained is accepted only on exact presence topics; the old key-only topic is no longer a presence topic. A seal is re-checked against
   the codec right before it is published (a rotation that started during the seal stops it). `gracefulShutdown` while a rotation is pending
   (the codec refuses the token's topic) ends with a clean DISCONNECT, so the broker drops the old-secret will instead of publishing it.
   `presenceStats()` (E2E/sim) adds the service counters as `svc.*`.
5. **Non-friend co-members** get no presence. The group engine reports every verified `here`/`sync` (QoS0, 5-min freshness) as
   `deps.onMemberSeen(gid, from)` (not commits or deletes — the broker may have queued those for hours). The App marks the member seen
   (`memberPresence`: seen until 10 min without a new here, or until the P2P channel closes) and reaches him with the same rule as a new roster
   member (`reachPeerRef`: open channel → flush; otherwise connect if I am the initiator or have messages queued for him; at most once per
   10 s). A member who just connected cannot see me either, so the engine answers his `here` with my own (`deps.answerHere`: he is not a
   friend, I have not seen him in 10 min and have no open channel to him; not when I sent a here in this group within 10 s — his here may be
   the answer to mine — and at most once per member per 10 s), so both sides learn about each other without a cascade. Consumers: P2P start
   (friends: verified presence; members: here), watchdog (`presence-online ∪ here-seen ∪ failed`), push suppression (`useChat`, friends only:
   authenticated and TTL-bounded), online dot (`GroupSettingsModal` → `usePeerOnline`: friend presence ∪ recent here ∪ open channel; only
   while the modal is open, re-rendered only when a member flips to seen).
6. **Server / token** (`api/chat/mqtt_auth.py`). `MqttTokenRequest` has `presence` (exact topics, `MQTT_PRESENCE_TOPIC_RE`, ≤ 150) and
   optional `presence_tag` (`MQTT_PRESENCE_TAG_RE`); `peers` is gone and the model forbids extra fields (sending `peers` → 422). `mqtt_scope`
   refuses wildcards, extra levels, the key-only form, non-canonical owners, standard base64 (400 `invalid_acl_presence` /
   `invalid_acl_presence_tag`). `mqtt_acl`: publish `inbox/{me}`, `group/+/{me}` and — only with a tag — `mist/user/{me}/presence/{tag}`
   (the only retained topic); subscribe own inbox, exact group tids, exact presence topics, kick. The server still knows nothing about
   friendships. Simulator (`scripts/sim/lib/server_acl.py`, `mockApi.mjs`, `profiles.mjs`) runs the same functions. `docs/MQTT_BROKER.md`
   §1, §3.1, §4, §5 (H1 closed), §6 updated.
7. **Plaintext group ids** (`CHECK_IN_REMINDER`). The inbox `check_in_reminder` of the guardian (family check-in) feature carried a
   plaintext `groupId` on the broker and had no sender left in the app; it is removed end to end (the MQTT type, its handler and the native
   reminder path). Guardian features are not part of the community edition. No other plaintext group identifier is left on the broker or in
   push payloads (push hints carry only type / isVideoCall; GROUP-TOPICS in the sim checks every topic and payload).
8. **Account data.** `storage.clearAllData` and `deviceClaim.wipeLocalKeys` delete the presence secrets (`presence_secret:%`) and the
   remembered topic lists in localStorage (`aegis_mqtt_presence_topics:*`, `aegis_mqtt_group_topics:*`, `services/topicMemory.ts`: they hold
   friends' keys and current tags).

## Limits (by design or for later steps)

- **The broker still sees the friend graph**: presence topics carry the owner's key, so who subscribes to whose presence topic is visible to
  the operator (it was before, via `peers` in the token and the old topics); plus connect/disconnect times, refresh timing, and rotation
  bursts (≤ one sealed envelope per friend right after an unfriend/block). Not hidden by W4.
- **Operator liveness**: the operator can drop or delay any presence message. Dropping my will keeps friends believing I am online for at
  most 10 minutes (TTL), during which their `useChat` does not push me. The broker side cannot forge an online (no S) or replay an old one
  (freshness, ordering). The **API** operator can: freshness uses the clock offset from the token response (`serverTime`), so skewing a
  victim's clock makes a recorded online of the same epoch (≤ 30 days old) look fresh; an empty message on the current topic then resets
  the ordering, and replayed refreshes keep the friend "online". Impact is small (the same operator relays pushes and can drop them anyway);
  bounding offset jumps or a local monotonic clock for presence is left for later.
- **A tag is a liveness signal**: whoever knows a tag (friends, the operator through the token scope) sees the owner's publish cadence
  (connect, 4-minute refresh, will) without S; only the on/off bit and the times inside are hidden.
- **Friends are trusted with S**: a friend colluding with the operator (who can publish on my topic) could forge my state for other friends.
- **A will armed before a rotation**: between clearing the old topic and the token swap (≈ 250 ms + a token fetch; longer if the token
  fetch fails), an **abnormal** disconnect (crash, network loss) makes the broker publish the old connection's will (sealed with the old S)
  on the old topic, retained: an ex-friend can read one "offline" with that connection's start time. Backgrounding the app in that window is
  a clean DISCONNECT (no will).
- **Offline rotation**: an unfriend/block while offline rotates on the next connect; until then the old secret stays in use (nothing is
  published on the old topic while the rotation is pending, but the old retained state stays until it is cleared).
- **Lost shares**: shares/requests are inbox messages (broker session 24 h, App queue 200). A friend offline for longer than the broker keeps
  the session misses a rotation share and still holds the old S; his subscription to the old (cleared) topic stays empty, so after 10 min
  online he asks again and gets the new secret (requests answered at most once a minute). Until then I look offline to him.
- **Co-member presence is weaker than friend presence**: a member who connects without sending a here (token-swap reconnects do not
  announce) is not seen until his next real connect, a group message or a P2P channel; "offline" is inferred from the P2P channel closing or
  10 minutes without a here. A co-member who stays connected but silent for more than 10 minutes drops out of the watchdog list and shows
  offline (before W4 the old retained presence kept him listed) — a periodic here or a P2P keep-alive would close that gap (W5).
- **Late subscribers** see a retained online that is at most 4 minutes old (refresh), so it passes the 5-minute freshness; a phone whose JS
  timers are throttled in the background may miss a refresh — the TTL then marks it offline (pushes are sent: the safe side).
- The native guardian service kept an MQTT connection that acted on nothing (removed in W5).

## What the next steps must do

- **W5 — Mallory** (as listed in W3) plus presence: a fifth actor with a real token subscribes to a friend's old tag after an unfriend (must
  see nothing after the clear), to guessed tags (nothing), injects plaintext and crafted `{n, c}` online states on a friend topic (refused,
  pushes still sent), replays an old share envelope after a rotation (refused), floods presence requests (rate-limited, no answer to
  non-friends), and drops wills (TTL bounds the damage).
- **Sim scenario for rotation** (not in the 4-phone sim yet): A unfriends B and blocks C → A's old topic is cleared, B and C never see A
  again (no delivery on A's new tag, nothing opens), D (still a friend) sees A after the token swap; a friend offline across a rotation gets
  the new secret through the silent-topic request.
- Decide whether the native `GuardianMqttService` keeps its MQTT connection (no inbox type left; the broker now queues every inbox
  message twice) or goes away together with the guardian-token endpoints (done in W5: removed).
- Co-members silent for more than 10 minutes drop out of the watchdog and the online dot: a periodic here (or a P2P keep-alive) per
  group, rate-limited (done in W5).
- Bound the API clock offset used for presence freshness (or use a local monotonic clock with a maximum skew) (done in W5).
- Optional hardening: hide the friend graph from the broker (owner-less presence topics would need another publish-right check), seal the
  remaining plaintext 1-1 signalling (`PROFILE_UPDATE`, WebRTC SDP/ICE, push-subscription updates) (the second part is done:
  `docs/DIRECT_SEALED.md`).

## Status (2026-10-25, end of W4)

Independent review of the W4 diff (no CRITICAL/HIGH; 5 MEDIUM, 9 LOW, 5 INFO). Fixed: #1 lost rotation share (silent-topic request, early
envelopes wait), #2 co-members already online (answer here), #3 stopped service (guards in the service and in the App closures, same-epoch
tiebreak), #4 forced token swaps (10-min share limit), #5 sim soundness (wills, per-direction deliveries, app acceptance, profile gate), #6
old-secret will on backgrounding (clean DISCONNECT, publish re-check), #8 old-topic clear, #9 sharedWith before send, #10 reconcile on key
changes, #11 remembered topics wiped, #12 mutation runner baseline, #13 docs, #14 notify on flip. Documented, not changed: #7 (API clock
offset, Limits), #15 (native guardian connection, W5), #18 (tag cadence, Limits), #19 (`have` is only counted: requests are always answered
with the current secret, rate-limited).

Tests changed because they pinned the removed protocol or a review fix (no security assertion weakened; each old check has a W4 counterpart):
- `mqtt_token_acl` (Python) — `peers` → `presence` (exact topics) + `presence_tag`; `peers` now 422 (`extra_forbidden`); new rejections for
  key-only / wildcard / extra-level / non-canonical / standard-base64 presence topics and bad tags; 150 accepted, 151 → 422; the ACL publishes
  presence only on `presence/<my tag>`, no `…/presence` rule anywhere.
- `sim_server_acl` — the simulated scope runs the new `_mqtt_scope`/`_mqtt_acl`; presence cases added.
- `mqtt_acl_scope`, `mqtt_group_resubscribe`, `mqtt_scope_groups`, `mqtt_suback_refused`, `mqtt_token_lifecycle` — `setAclScope(groups,
  { tag, topics }, owner)`; presence topics are subscribed from the scope (no `subscribeToFriendPresence`); the will/online are on the secret
  topic; the forged-presence checks use the codec path (plaintext `{online}` on any topic is ignored); presence leftovers after a restart;
  test codecs gained `current()` (the publish re-check).
- `mqtt_freshness` — the X2 rules (offline of any age, online ≤ 5 min, nothing in the future) are applied to sealed states via the codec.
- `group_peer_reach` — no presence for co-members; a verified `here` reaches them (initiator / queued / open channel, throttled, never a
  blocked one). `group_outbox_membership` — the extracted effect now also sets `reachPeerRef`.
- `guardian_sender_roles` — the reminder allowlist and the inbox reminder are gone end to end (JS, plugin, Kotlin, Java).
  `GuardianInboxTest` (Kotlin) keeps only the SUBACK rule.
- `account_wipe_outbox` — the presence secrets and the remembered group/presence topic lists are wiped with the account (clear and kick).
- `group_control_w2_review_fixes` — the "engine runs on the server clock" check is bounded to `createGroupEngine({…})` (the presence
  service's identical `now:` line had made the W2 mutant R1 survive).
- `group_w2_mutants.py` / `group_w3_mutants.py` — one pattern each follows the moved source line (W2 R1 anchor; W3 here reply now
  `const replied = …` plus the answer path).

New: `presence_secret`, `presence_service`, `mqtt_presence_w4`, `presence_w4_wiring`, `sim_presence_audit`; `presence_w4_mutants.py`.

Numbers:
- `scripts/review`: 96 of 97 pass. The one failure (Python) needs the official edition's identity service, which is not in this
  repository; it failed the same way before W4 and is unrelated to it. New W4 tests: `presence_secret` 7
  sections, `presence_service` 16, `mqtt_presence_w4` 8, `presence_w4_wiring` 5, `sim_presence_audit` 2 (17 violation cases);
  `mqtt_token_acl` (Python) passes.
- Mutation: `presence_w4_mutants.py` 77/77 killed, all on assertions (baseline of the 12 named tests passes first); W3 runner 39/39;
  W2 runner 46/46 (R1 needed the bounded check above).
- Build (fresh checkout): wasm-pack ok; `tsc --noEmit` 0 errors; `vite build` ok; eslint on the 21 W4 files 0 errors,
  5 warnings, all on lines older than W4; Gradle `compileDebugKotlin` + `compileDebugJavaWithJavac` ok, `GuardianInboxTest` 1/1.
- 4-phone sim: SETUP, D1, S1–S7, LATE all PASS; NETWORK-GUARD 0 blocked; BROKER-ACL deniedPub 0 / deniedSub 0; API-AUTH rejected
  {} (37 signed pushes, 0 with names); LEAK 27 group publishes, 0 findings; GROUP-TOPICS 0 findings over 572 broker events (no gid/kid;
  Bob after S2: 0 deliveries on 2 post-removal tids); PRESENCE 0 findings over 255 presence topics/rules — 34 publishes, 22 subscriptions,
  34 wills set / 18 fired, 76 deliveries to friends, every friend direction delivered 6/6 and seen online by the app 6/6, no raw-key
  topic, non-friend token probes (key-only topic, `+` tag, `+` owner, `#`, `peers`) 5/5 refused.

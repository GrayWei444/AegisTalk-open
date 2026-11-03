# Group log wiring — step W3 (epoch-derived group topic ids), 2026-10-24

Background: [W1](GROUP_LOG_WIRING_W1.md#background-the-group-log-model) (the group log model), [W2](GROUP_LOG_WIRING_W2.md)
(`group_sealed`). Clean break: no old topic is kept.

## What changed

1. **Topics** (`services/groupTopics.ts`, `groupControl.deriveTopicId`). A group's MQTT topic is
   `mist/group/{tid}/{sender}` with `tid = b64url(HKDF-SHA256(K_e, "aegistalk-gtopic-v1|" + gid))[:22]` of the **current**
   epoch. The gid is never on the broker: not in a topic, not in the token request or the JWT acl, not in a payload.
   Each group has a topic table in the engine:
   - the current epoch's tid — only when the current key is held and kc-checked (`currentEpochKey`); no key → no topic;
   - after a rekey the previous tid stays for `TOPIC_OVERLAP_MS` = 10 min (at most 2 previous topics per group), then it is
     dropped and unsubscribed. The table is in memory; at engine load, if the current epoch started (ts of its rekey commit,
     clamped to now) less than 10 min ago, the previous tid is put back until that time + 10 min — only if the stored previous
     key passes its kc (`keyAuthorised`), so a bad stored key never yields a subscription.
   - Recomputed on every projection (chain or key change), and again whenever the table's current epoch differs from the
     applied chain (an `absorb` that failed after the replica advanced; checked on every sync, `topicsBehindChain`); the whole
     list goes to the App (`deps.onTopics`).
2. **Receive** (`groupEngine.onControl(tid, …)`, `groupEngineControl.receive`). tid → group only through the engine's table
   (`findTopic`); unknown tid (the gid, a random id, an expired or foreign topic) → `unknown-topic`, not decrypted.
   `groupControlSource` returns `{ tid, from, envelope }` — no gid. The topic fixes the epoch (the tid is derived from its key
   and bound in the AAD with that epoch's kid): the envelope is `{ n, c }` only — **no kid on the wire** (review M3: every log
   entry carries its kid in clear next to the gid, so a kid on the broker would let the operator map the tid back to the gid).
   An envelope sealed under another epoch does not open with the topic's key (`bad-envelope`). If the topic leaves the table
   while the message is being opened (overlap expired, removed, group gone) it is dropped (`old-epoch`). Late messages of the
   previous epoch from **current** members on the previous tid are opened with that epoch's key during the overlap
   (signature, freshness, de-dup as usual; call/delete go to the App; here/sync only feed gossip — no reply, the sender
   cannot hear the new topic yet); the removed member / leaver is not on the roster → dropped unopened. The W2 path
   "kid of an epoch I do not know yet → hold and retry" is gone: a sender ahead of me publishes on a topic I am not subscribed to.
3. **Send.** A message is handed to MQTT only if its epoch is the current epoch of my applied chain at that moment
   (`publish` re-checks after sealing; guarded sends are re-held and re-sealed under the new epoch, commit notices dropped).
   The commit notice of the commit that **ends** an epoch (remove/rekey/re-add) is published on that epoch's topic under that
   epoch's key **before** the author's replica switches (`absorb`): the removed member and the members that have not switched
   yet are there; afterwards nothing is published on that topic by that client. Notices of own commits under the new epoch go
   out after the switch; notices of epochs skipped inside one batch are not sent (hints only). `mqtt.sendToGroup(tid)` never
   queues (offline → `false`, the engine keeps the message and re-seals with the epoch current at release time; a refusal
   while connected is not retried in a loop — next connect); queued `mist/group/…` entries from the old scheme are dropped
   (they would put a gid on the broker).
   **Switch grace** (review M1): for `SWITCH_GRACE_MS` = 5 s after this client's current topic changes, control messages are
   held (like during `needsRekey`) and released afterwards, so the other members have swapped their token and subscribed the
   new topic first. Without it, a delete/call held while waiting for the rekey went out at once on the new topic and reached
   only the admin who wrote the rekey.
4. **Token scope and subscriptions** (`mqttCredential`, `mqtt.ts`, `AppProvider`). `groups` in `/api/mqtt/token` are topic ids:
   the App ranks the engine's table (`rankScopeTopics`: current topics in group order — recently active first —
   previous topics last, so they are the first to go above 50) and passes it to `setAclScope`. The server accepts only
   `^[A-Za-z0-9_-]{22}$` (no `+`, `#`, `/`, ≤ 50, else 400/422). Group subscriptions follow the scope (`_syncGroupTopics`):
   on every scope change and every CONNACK, topics the token grants are subscribed, topics that left the scope are
   unsubscribed; a scope that only shrinks keeps the token (no reconnect); a scope that needs a topic the token lacks swaps
   the token (250 ms) as before. After a restart with a surviving broker session, topics remembered in localStorage
   (`aegis_mqtt_group_topics:<user>`) that are no longer wanted are unsubscribed. `subscribeToGroup` /
   `syncGroupSubscriptions` / `unsubscribeFromGroup` are gone (hooks too). `peers` stay until W4 (presence is still
   `mist/user/<pk>/presence`).
   Review fixes: SUBACK reason codes are read the mqtt.js 5.14 way (`subackCodes`: any refusal makes the whole callback an
   `err`, the real codes are in `packet.granted`; granted topics in a partly refused batch still count); a SUBSCRIBE whose
   SUBACK never came because the client was replaced (token swap, reconnect) is sent again on the new client even when the
   broker kept the session (M2: otherwise `onTopicReady` and the post-join sync never fired); previous-epoch topics only
   fill the slots the current ones leave free (no "groups dropped" banner because of them, L6); if the engine has not
   produced its table 3 s after the lists are loaded, the scope is set with no group topics so friend presence does not wait
   (L7).
5. **Offline catch-up.** A member returning after one or more rekeys syncs the log (start / connect / poll), applies the
   rekeys (keys from the bundles in the log), derives the current tid and subscribes it; the intermediate epochs are never
   subscribed. Old-topic queued notices only speed this up; they are not needed.
6. **WebRTC offer proofs** (`offerProof.ts`): the plaintext offer signalling used to carry the gid (found by the sim's
   GROUP-TOPICS audit), then the kid; each item is now `{ t: tid, m: HMAC }`. The receiver maps the tid through the engine's
   topic table to its own group and epoch key (`useWebRTC keysForTopic`), re-derives the tid from that key, and checks the
   HMAC (still bound to sender, recipient, gid, kid, time). Only the current and overlapping previous epochs can be proved.
7. **Simulator.** `server_acl.py` runs the server's `_mqtt_scope` + `_MQTT_*` constants (refusals count as API rejections);
   the broker reports every visible event (`onEvent`); `lib/topics.mjs` + run.mjs **GROUP-TOPICS**: no gid and no kid in any
   topic, filter, will, token acl or payload; the phone removed in S2 never subscribed to, received on, published on or held a
   token for the post-removal tids, while the others did receive on them. LEAK requires a 22-char tid and `{ n, c }` payloads.

## Limits (by design or for later steps)

- **Switch gap.** Messages published on a new topic before a member has subscribed it (token swap + reconnect + SUBACK,
  ~1 s; or the whole time a member is offline across a rekey) are not delivered to it. The 5 s switch grace covers the
  members that switch together (online, notified); a member that switches later (behind, offline, slow token) still misses
  a "delete for everyone" or a call control sent in that window. State is unaffected (log). In W2 it was held and retried.
- **Every rekey costs every online member a token fetch and a reconnect** (review L8). With `addPolicy: members` someone
  with spare accounts can force add → leave → rekey cycles; bounded by the cost of accounts and the per-IP token limit
  (120/min, shared behind NAT). Not debounced: a debounce would lengthen the switch gap; revisit if it shows up in practice.
- A joiner whose post-join `sync` lands on the previous topic just before the switch gets no reply (previous-topic here/sync
  are not answered); the head comparison waits for the next `here`, chat message or poll.
- **Behind members hear only their current topic.** A member that missed the rekey notice (author offline at that moment,
  a commit written by another client without a notice) learns of the rekey at its next poll (≤ 2 min), reconnect, or the
  next group chat message (head gossip in the signed plaintext); in W2 any message on the shared topic triggered a sync.
- The overlap is in memory; a restart restores it from the rekey commit's ts (clamped to now), not from the local switch time.
- Leftover broker subscriptions are cleaned only for topics this client remembered (localStorage); a session from a W2-era
  client may keep gid subscriptions until it expires (nobody publishes there any more).
- The broker still sees who subscribes to which tid and when the tids change (membership size, rekey timing); the tids of
  one group are linkable through the same clientId (README, "What the server still sees").
- "No gid on the broker" protects against a broker-only observer (a broker compromise or log leak) and against removed
  members subscribing by gid. Neither the envelope nor the offer proof carries a kid any more (M3), so the broker's data
  holds no identifier the log API also sees. An operator that runs both can still correlate by **timing** (a rekey append to
  the log of gid X, then a burst of token requests and new subscriptions to one fresh tid) and can grant any well-formed tid
  to anyone (metadata only: the content needs the epoch key).
- The Android native check-in path still had a plaintext `groupId` in `CHECK_IN_REMINDER` handling (receive only; no
  sender left in the app) — removed in W4.
- Topic scope above 50 groups: the least active groups get no group-topic traffic (W2 limit, unchanged).

## What the next steps must do

- **W4 — presence secret**: per-user secret presence topics shared with friends; co-member presence from `here`;
  then drop `peers` from the token request (server `MqttTokenRequest`, `_mqtt_scope`, sim `server_acl.py`) and the
  presence subscriptions of non-friends; update `docs/MQTT_BROKER.md` §4 and the H1 note.
- **W5 — Mallory**: a fifth actor with real tokens and broker `inject/tap`, now also: subscribe to a removed group's old
  tid and check it sees nothing after the switch except the rekey notice; guess/replay tids; inject on a current member's
  suffix on the previous tid during the overlap (must fail the signature); try `mist/group/+/+` and non-22-char ids in the
  token request (400) — plus the W2 list (equivocating logs, withheld bundles, invite floods, forged gossip, replays).

## Status (2026-10-25, end of W3)

Tests changed because they pinned W2 APIs/semantics (no security assertion weakened; every changed check has a W3
counterpart):
- `groupEngineKit` — phones follow the engine's topic table (`deps.onTopics`), the broker delivers only per tid,
  `controlLog` records tid, gid (test-only) and the sender's applied seq at publish time; `fetchHook` to stall a sync.
- `group_control_w2` — tid instead of gid on the wire and in the route (no gid field), only `{n, c}` (no kid), nothing queued
  offline; old-epoch section rewritten for W3 (sealed under another epoch → does not open; previous topic during the overlap
  accepts late messages from current members, refuses the removed member; expired topic → unknown-topic); the route refuses
  non-22-char ids.
- `group_control_envelope` — the envelope is exactly `{n, c}`; the kid is an argument of `openControl` (from the topic).
- `group_control_w2_review_fixes` #4 — nothing is held any more (fake kids dropped unopened; honest bursts accepted).
- `group_engine_review_fixes` — a commit appended by a raw client sends no notice on the old topic: D catches up at its poll.
- `mqtt_acl_scope`, `mqtt_group_resubscribe`, `mqtt_suback_refused`, `mqtt_scope_groups`, `mqtt_token_lifecycle` — 22-char
  topic ids; subscriptions driven by the scope (the per-group APIs are gone); a shrinking scope keeps the token and
  unsubscribes; leftovers after a restart are unsubscribed; previous-epoch topics rank last and only fill free slots;
  the SUBACK stub behaves like mqtt.js 5.14 (refusal → `err` + `packet.granted`); an unconfirmed SUBSCRIBE is resent on a
  new client; the 3 s fallback scope.
- `mqtt_durable_puback`, `mqtt_queue_restart_order` — group topics never queue (the same-millisecond order is now checked
  with two sealed inbox envelopes).
- `offer_proof` — proofs carry `{tid, mac}` only (the gid used to travel in plaintext WebRTC offers — found by the sim's
  GROUP-TOPICS audit; then the kid, review M3), lookup by tid through the topic table, tid re-derived from the local key,
  another kid or another group fails, both older formats are refused.
- `mqtt_token_acl` (Python) — group ids are 22-char topic ids; `+`, `#`, `/`, 21/23 chars, trailing newline, old group
  ids → 400; non-string → 422; 50 accepted, 51 → 422; every group rule in the JWT is an exact 22-char id.
- `sim_server_acl` — the simulated scope check is the server's `_mqtt_scope`; `sim_leak_check` — non-tid group topics and a
  kid in the payload flagged (each case now asserts its own finding, not just "something").
- Several mqtt tests now honour `AEGISTALK_PWA_SRC` (they bundled the real tree, so mutants could not be killed).

New: `group_topics_w3`, `sim_topic_audit`; `group_w3_mutants.py`; `group_w2_mutants.py` updated (patterns follow the
W3 code; the three held-incoming mutants removed with that code; "kid of another epoch than the topic" became "epoch taken
from my chain instead of the topic" once the envelope lost its kid).

Independent review of the W3 diff (no CRITICAL/HIGH): M1 switch grace, M2 resend unconfirmed SUBSCRIBE, M3 no kid on the
wire (envelope and offer proof), L4 mqtt.js 5 SUBACK codes, L5 topic table repaired from the chain, L6 previous topics only in
free slots, L7 3 s fallback scope, L9 test gaps (expiry while opening, here/sync on the previous topic, poll catch-up, a stub
that holds SUBACK, the mqtt.js 5 refusal shape), INFO kc check when restoring the previous topic — each fixed with a test and
a mutant in `group_w3_mutants.py`. L8 (token fetch + reconnect per rekey) is documented above, not changed.

Numbers at the end of W3: full `tsc --noEmit` 0 errors and `vite build` OK; eslint on the
changed files: no new findings (one error and five warnings on lines W3 did not touch); review suite 91/92 — the one failure
needs the official edition's identity service (not in this repository; no group code involved); mutants
W3 39/39 and W2 46/46 killed (`R2 sync replies limited per group` depends on timing and once survived under CPU load, it was
killed when run on its own); 4-phone sim: SETUP, D1, S1–S7, LATE, NETWORK-GUARD, BROKER-ACL (0/0), API-AUTH (0 rejected),
LEAK (26 checked, 0 findings), GROUP-TOPICS (691 broker events, 0 gid/kid findings; Bob after S2: 0 subscriptions or
deliveries on the 2 post-removal tids, 43 deliveries to the others) all PASS.

# Group log wiring — step W2 (group control over `group_sealed`), 2026-10-23

Background (the group log model): [W1](GROUP_LOG_WIRING_W1.md#background-the-group-log-model).
W2 moves every remaining group control message off plaintext MQTT. Clean break: the old types are gone.

## What changed

1. **One type on group topics: `group_sealed`** (`services/groupControl.ts`, `groupEngineControl.ts`).
   `{k: kid, n, c}`, AES-GCM under K_ctl = HKDF(K_epoch, "aegistalk-gctl-v1|gid"), AAD = tid|kid|sender, inner
   `{t, gid, kid, ts, nonce, body}` signed by the sender's identity key ("aegistalk-gctl-v1:"); the plaintext is padded
   to 1 KB so every kind has the same length on the wire. The topic is still
   `mist/group/{gid}/{sender}` (W3 switches to the epoch topic id); tid is derived from the key and bound in the AAD.
   Bodies (exact shapes, extra fields refused on seal and open):
   - `commit {head: {seq, id}}` — my commit was applied at `seq` (replaces W1's `group_log_ping`). Sent after the
     author's own sync applied it, under the epoch the log entry itself was sealed with (the parent epoch for
     rekey-carrying commits): whoever can read the notification can already read that entry, and a removed member
     learns of its removal at once. A leaver announces its leave before dropping the group.
   - `here {head: {seq, id}}` — QoS0, on real MQTT connects only (`mqttService.onConnected({tokenSwap})`; token-swap
     reconnects do not announce); an announce before the engine has loaded is sent after loading, and an engine
     started while MQTT is already connected announces itself.
   - `sync {have: {seq, id}}` — sent after joining, once the group topic is actually subscribed (SUBACK →
     `onTopicReady`; before that the replies could not arrive); members reply with `here` (rate-limited per requester).
   - `call {action: start|join|leave|end, video}` — group calls; no group name, no claimed ids.
   - `delete {messageId}` — "delete for everyone" (was one plaintext `delete_message` with a `groupId` per member).
2. **Receive rules** (`groupEngineControl.receive`): sender (topic suffix) not on the applied roster → dropped before
   decrypting; kid of an older chain epoch → dropped (never decrypted with an old key); kid unknown (the sender is
   ahead) or the current key not held yet → held (per sender at most 2 waiting kids and 128 messages per kid; 256 per
   group, 1024 total; 10 min from first receipt) and retried when the chain or keys change; inner signature; freshness of the signed ts per kind (here/sync 5 min,
   call 2 min, commit/delete 24 h, at most 5 min in the future, all on the server-corrected clock); de-dup by
   (sender, ts, nonce) in a cache per (group, sender) (≤ 128; evicting the oldest raises that sender's floor, so one
   member's flood never evicts another's entries and an evicted entry is still a replay). The MQTT layer gives
   `group_sealed` the 24 h broker window (it carries deletes); the app also caps each sender at 120 messages
   (refill 2/s) before the engine.
3. **Send rules**: only `currentEpochKey`. While `needsRekey` is set (someone left and still holds the key), the key
   is missing or MQTT is down, control messages are held in the engine and sealed only when they may be sent
   (released on the admin's rekey, on key arrival, on every connect); after sealing the engine checks again and
   re-holds (and retries at once if it is already possible again) if a leave / rekey / disconnect landed during the
   await. Held deletes are also stored (`ctl` pending rows) and survive an app restart; here/sync/call stay in memory. Held call signalling older than 60 s is dropped;
   `here`/`sync` keep only the latest and carry the head at release time. Nothing is ever sent under the key the
   leaver holds. Commit notifications are skipped while offline (a hint only).
4. **Head gossip** (`groupEngineGossip.ts`): the signed chat plaintext and every here/commit/sync carry (seq, head id)
   and the verified sender. Behind → fetch. Same seq, different head (or a seq I skipped that they applied) → the
   group shows `logConflict` (per member), the engine checks that seq against the server and rebuilds per the W1 rules
   (no rebuild if the server agrees with me; a rebuild that would drop applied commits is not adopted). A warning
   clears when that member reports a consistent head or an adopted rebuild resolves it.
5. **Group calls** (`groupCallService.ts`): start/join/leave/end as `call` controls; offer/answer/ICE are sealed to
   the peer's identity key (`GROUP_KEY_SEALED` kind `call`, transient: sent only while connected, never persisted;
   dated and judged on the server-corrected clock; receivers drop signals whose `iat` is older than 2 min, replays
   (sender|nonce), other groups, non-members, > 32 KB). The seven plaintext `group_call_*` types are removed.
6. **W1 open items**
   - Invite receipts: the invitee acks (`ack {gid, id}`) after `confirmInvite`, and again for a duplicate invite;
     any verified control message from the invitee also counts. The inviter keeps a `sent` row (survives restarts)
     and resends after 30 s, 2 min, 10 min, 1 h, 6 h (at most 6 sends). Then the row becomes `unacked`:
     `Group.unackedInvites` → the settings member list shows "invite not delivered · resend" (`engine.resendInvite`
     starts a new cycle); the group screen also shows the `invite-unacked` notice. A row only waits for the member that add brought in (current addedAtV), so after remove + re-add the old
     invite (old chain, pre-removal key) is never resent. Duplicate invites are acked only to the member who wrote the
     add (no membership oracle for ex-members).
   - Forget locally: `engine.forgetGroup()` (settings → "forget on this device", shown while the key is missing)
     deletes the chain, keys, pending rows and join row on this device, writes no commit.
   - Invite verification runs in a Web Worker (`groupInviteWorker.ts`, same WASM verifier) with a main-thread
     fallback (no Worker, load error, crash, malformed reply). A timeout (limit 25 ms per commit, ≥ 60 s) retries once
     in a fresh Worker; a second timeout makes the join retry later (its backoff) instead of using the main thread. Measured cost
     of `verifyInvite` (2-core Linux server, Node, strict Ed25519): 52 commits 0.14 s, 202 → 0.38 s, 502 → 0.82 s, 1002 → 1.6 s
     (≈ 1.6 ms per commit); in the 4-phone sim (Chrome) the Worker verified 1–3-commit invites in 12–14 ms.
7. **Removed**: `group_log_ping` (+ `makePing`/`verifyPing`/`pingHash`), `group_call_start/join/leave/end/offer/
   answer/ice`, the inbox `delete_message` path for groups. Group topics accept `group_sealed` only, and
   `group_sealed` is refused on inbox topics.

## Limits (by design or for later steps)

- Held here/sync/call messages live in memory only (deletes are stored). Incoming held messages expire after 10 min.
- `serverNow` is the device clock until the first token fetch: times taken during a cold start before connecting
  (rekeySeenAt, held timestamps) shift by the skew afterwards (worst case: a duplicate admin rekey, dropped by rebase).
- The post-join `sync` waits for the SUBACK in memory only: a restart before it loses that sync (the joiner's `here`
  on the next real connect still lets members compare).
- The replay cache is in memory: after a restart, a replay of a genuine delete/commit from the last 24 h is accepted
  again (idempotent: delete again, fetch again), likewise a here/call control from the last minutes.
- QoS0 vs QoS1 still tells here/sync apart from the rest (all kinds are the same length).
- The gid is still visible on the topic (W3), presence is still per identity (W4).
- A member can make others show a conflict warning by gossiping a wrong head (no rebuild unless the server's answer
  differs from what that device applied); the warning names no one and clears when that member reports a consistent
  head. A member can still flood control traffic within the per-sender budget (120, refill 2/s).
- Chains are re-verified on the main thread at every engine start (`loadChainFromRows`) — same ≈ 1.6 ms per commit;
  only invites moved to the Worker.

## What the next steps must do

- **W3 — epoch topic ids**: publish/subscribe `mist/group/{tid}/{sender}` with tid = `deriveTopicId(K_epoch, gid)`
  (already bound in the AAD); token scope by tid (rescope + 250 ms swap on every rekey), keep the old tid ~10 min for
  late commit notifications (the parent-epoch notification of a rekey must still reach the old topic, so the removed
  member learns of its removal), `groupControlSource` maps tid → gid via the engine, never via the payload.
- **W4 — presence secret**: per-user secret presence topics shared with friends; co-member presence from `here`
  (`deps.onControl` can expose verified `here` senders); remove group-member presence subscriptions from the token.
- **W5 — Mallory**: a fifth actor with real tokens and broker `inject/tap`: forged / replayed / old-epoch
  `group_sealed` on member suffixes, plaintext legacy types on group topics, operator equivocation (different logs →
  `logConflict` on the victim), withheld invites (resend), withheld bundles (key wait → forget), invite floods,
  call-signal replays; assert nothing reaches another member's app state and LEAK stays clean.

## Status (2026-10-24, end of W2)

Tests changed because they pinned removed types/APIs (no security assertion weakened):
`group_engine_wiring`, `group_engine_review_fixes` (onGossip gets the sender; "non-member ping ignored" became
"non-member commit notification dropped unopened"), `group_call_identity` (rewritten for handleControl/handleSignal,
every old check kept), `group_delete` (receiver via groupControlRoute; inbox group deletes now ignored),
`group_outbox_storage`, `block_all_paths`, `group_key_delivery` (slice markers, wiring regexes, serverNow stub),
`identity_seal_kind_limits` (ack/call kinds), `group_log` (here body), `group_control_envelope` (W2 bodies; the
"over 512 KB at seal" case became "oversized envelope refused before decrypting"), `mqtt_acl_scope`,
`mqtt_durable_puback`, `mqtt_buffers`, `mqtt_freshness` (group_sealed instead of the removed types).
New: `group_control_w2`, `group_control_w2_review_fixes`, `group_invite_worker`, `sim_leak_check`;
`group_w2_mutants.py` (49 mutants, one protection removed each in a copy of src).

Verification: full `tsc` 0 errors (vite build bundles `groupInviteWorker` with the WASM); review suite 89 of 90 (the
remaining test needs the official edition's identity service, as in W1); mutation run 49/49 killed; 4-phone sim: SETUP,
D1, S1–S7, LATE PASS, NETWORK-GUARD 0 blocked, BROKER-ACL
deniedPub = deniedSub = 0, API-AUTH rejected = {} (5 group-log appends, 55 fetches, 0 rejections), LEAK 26 group-topic
publishes (22 QoS0 here/sync, 4 QoS1 commit notifications), all `group_sealed`, 0 findings; the invite Worker
verified the sim's invites in 11–15 ms. The sim has no group-call scenario; group calls are covered by
`group_call_identity` and `group_control_w2` §7.

Independent review: no HIGH; 2 MEDIUM (call/here freshness on unsynchronised phone clocks; the post-join sync sent
before the topic was subscribed), 8 LOW, 2 INFO — all fixed with a regression test each and mutation-checked. The
re-review confirmed the fixes and found 2 new LOW (re-held messages could wait for the next change; offline deletes
lost on restart) plus 3 partial fixes (#4 honest bursts, #10 timeouts, #11 undelivered invites) — fixed and
mutation-checked as well.

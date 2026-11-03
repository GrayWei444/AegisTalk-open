# Group log wiring — step W1 (core only), 2026-10-23

W1 wires the group-state modules (`groupStateCommit/Rules/State.ts`, `groupLog.ts`, `groupLogEntry.ts`, `identitySeal.ts`) and the server's
group log (`api/group_log_routes.py`) into the app. Clean break: groups from before W1 were not migrated. The later steps are
[W2](GROUP_LOG_WIRING_W2.md) (group control), [W3](GROUP_LOG_WIRING_W3.md) (topic ids), [W4](GROUP_LOG_WIRING_W4.md) (presence) and
[W5](GROUP_LOG_WIRING_W5.md) (adversarial simulation).

## Background: the group log model

The group design document itself is not published; this is the part the W-documents rely on.

- **State = a signed commit chain.** Every change (create, add, remove, leave, rekey, role, info, delete) is a commit
  `{gid, v, prev, op, actor, args, ts}` signed by its author's Ed25519 identity key (domain `aegistalk-gstate-v1:`); the gid is derived
  from the genesis commit. Each member checks every signature and permission itself (admins remove, rekey and change roles; adding follows
  the group's add policy). Removing a member always carries a new epoch key (atomic remove + rekey); after a leave, control traffic is held
  until an admin rotates the key.
- **The server only orders.** Per gid the server keeps an append-only log (`POST/GET /api/group-log/{gid}`): opaque entries, gapless
  sequence numbers, first come first served. An entry is `{k: kid, n, c}`, AES-GCM under a log key derived from the epoch key, so the
  server sees the gid, the epoch id (kid), sizes and timing, not the commit. Appends are signed by a registered account and rate limited
  per account and per (account, gid); reading needs no login.
- **Every member computes the same chain.** Members apply the log in order and skip what is invalid (bad signature, not permitted, stale
  `prev`, undecryptable); a gap stops processing until it is re-fetched. Same log + same rules → same chain on every member, so there is
  no fork choice: an ex-member signing at an old position is always stale.
- **Keys follow the chain.** A rekey-carrying commit carries the new epoch key sealed to each remaining member (one ephemeral X25519, one
  AES-GCM copy per member); a key is accepted only if a verified commit names its `kid` and key check value `kc`. A new member receives
  the verified chain up to its add plus the key in force, then confirms its add against the server log before joining.
- **Equivocation is detected, not prevented.** Every signed group message and `here` carries the sender's `(seq, head id)`; two members
  that compare heads see when the server showed them different logs (W2 head gossip, W5 S12).

### Residual risks of the log model

- **Operator liveness.** The server can refuse, delay or drop appends and fetches, and chooses the order of concurrent commits.
- **Operator equivocation.** It can show different logs to different members; head gossip detects this as long as members exchange any
  signed message. An operator that fully isolates a member can keep it on an old view, and together with a removed member read what that
  isolated member still sends under the old key.
- **Trusted admins.** A malicious or broken admin client can stall the control plane (a rekey whose key nobody else receives) or give some
  members bad key copies; affected members request the key from other admins.
- **Groups without admins.** After a leave, a group whose admins are all gone stays "waiting for an admin"; the old key stays valid until
  then (chat content goes peer-to-peer only to the current roster; control traffic is held).
- **Junk appends.** Any registered account that knows a gid (for example a removed member) can append garbage within its own per-account
  limits; clients skip it cheaply (kid check). Many accounts together could fill the server's global log cap (new groups are paused first,
  then all appends stop until the operator compacts the log). The registration policy (invite codes by default, per-IP and global
  limits, see `docs/SELF_HOSTING.md`) bounds how many accounts one person can get.
- **What the log server learns.** gid, seq, entry size, timing, the IP of appenders and fetchers, the epoch kid of each entry (so when rekeys
  happen) and which account appended which entry (kept at most 2 days in the usage counters for limits; the log rows do not store it); not
  roles or content. Reading is unauthenticated: anyone with the gid can follow seq / size / timing / kid changes; the size of a key bundle
  roughly reveals the roster size at each rekey.

## What changes

1. **Persistence** (`database.ts` v12, `services/groupLogStore.ts`)
   - `group_commits(gid, v, id, prev, body, sig)` — the applied chain (`encodeCommitRow`), reloaded with `loadChainFromRows`
     (every signature re-verified at start).
   - `group_log_state(gid, head_v, head_id, processed_seq, head_seq, first_seq, base_v, join_v, join_id, status, applied_at,
     waiting, rekey_seen_at)` — the `LogReplica` minus the view.
   - `group_pending_commits(gid, id, op, signed, blob, args, state)` — own commits: `append` (persisted before the POST,
     re-appended until the log shows them applied / stale / rejected), `invite` (add applied → sealed invite still to send),
     `held` (draft refused with `needs-rekey`, re-proposed after the admin rekey), `join` (an invite being confirmed).
   - `group_keys` rebuilt with primary key `(group_id, key_id)` (a kid chosen by one group's creator can no longer replace
     another group's key); `is_active` = the chain's current epoch, `origin` = `chain` | `pending` (my own unapplied rekey).
   - `groups` / `group_members` stay as a projection of the applied chain, written in the same batch as the chain rows
     (nicknames are a local cache, not authority). Migration deletes all old group rows (no chain → no authority).
   - Backup blob (`aegisIdBlob`) and device transfer carry, per group, the wire chain + replica position + the current
     epoch key (kc-checked on restore); one restore helper (`groupBackup.ts`) is used by every restore path. Newer epoch
     keys come back from the key bundles in the log (sealed to the identity key).
     The community edition restores groups the same way from a device transfer (`App.tsx`) and from the offline recovery
     kit (`ext/chat/kitRestore.ts`, blob v2 from `services/identityBlob.ts`): both go through `services/groupRestore.ts`
     → `groupBackup.restoreGroupBackups`.

2. **Log client** (`services/groupLogClient.ts`): append = POST `/api/group-log/{gid}` signed by the account key exactly as
   `group_log_routes.append_signed_payload` (sorted JSON, server-clock timestamp, fresh `request_id`), retries with backoff on
   network / 5xx / 429 / 409; fetch = GET `?after=&limit=` following `more`. Own commit and any new epoch key are written
   and flushed to the store **before** the POST (crash → re-append → duplicate, skipped).

3. **Engine** (`services/groupEngine.ts` + `groupEngineSealed.ts`): one serialised queue per gid.
   - Group state = applied chain only. `applyLog` result → persist chain rows, replica, new keys, projection → store.
     UI actions author commits: `checkCommit` (inside `buildCommitEntry`) → persist → append → minimal ping → sync → applied.
     `staleOwn` → `rebaseDraft` + rebuild on the new head (fresh key for rekey-carrying ops, dropped when no longer
     applicable: target gone, rekey no longer needed); own commits skipped for any other reason are dropped and reported.
   - Catch-up: on engine start, on every MQTT (re)connect, on a ping, on a gossip `i-am-behind`, every 120 s.
     `gap` → re-fetch from `processedSeq`; `waiting` / `keyMissing` → sealed `req` to the admins (UI "waiting for key").
     Gossip `conflict` → re-fetch from `firstSeq` and `rebuildLog` (rate-limited).
   - Rekey: after a leave every admin tracks the local time it first saw `needsRekey`; `shouldRekeyNow` decides.
   - Removed / left / deleted / not-joined → local group, chain, keys and pending rows deleted.
   - **Temporary broadcast (W2 replaces it):** after an append, a minimal signed ping on the existing group topic,
     `group_log_ping {h, s, ts, sig}` with `h = b64url(SHA-256("aegistalk-glog-ping-v1|" + gid))[:22]`, `s` = seq,
     `sig = Ed25519(identity, "aegistalk-glog-ping-v1:" + canonical{from, h, s, ts})`. No group data; it only triggers a
     (rate-limited) GET.

4. **Invites**: sent only after my add is applied from the log (`inviteParams`), sealed `invite` (identitySeal kind limits,
   ≤ 512 KB) with the full verified chain, the key in force at the add, `headSeq`, `baseSeq` and, for a re-add, the parent
   epoch's read-only log key (`logKeyBytes`). Invitee: sender must be a friend and not blocked (existing rule) and the author
   of the add; `verifyInvite` → fetch from `baseSeq` → `confirmInvite` → join. Genesis members get the same invite.

5. **Keys**: the only sending key is `currentEpochKey` (no 72 h dual encryption, no fallback to an older epoch, no 1-1
   ratchet fallback). A key enters the store only from: own genesis/rekey, invite (kc-checked), a bundle opened while applying,
   or a sealed `dist` that passes `keyAuthorised`. Key requests are answered only per `mayReceiveKey`. Leave → the leaver
   drops out of the roster (fan-out) at once; control commits other than rekey/remove/leave are held; UI shows
   "waiting for an admin to rotate the key". Received chat: decrypted only with a key of that group's chain, sender must be
   a member of the applied chain (unknown sender or kid → sync, buffer, retry; no roster self-heal). Group chat plaintext
   (already signed) carries the sender's `(seq, head id)` for `compareGossip`.

6. **Removed**: `GROUP_INVITE`, `GROUP_MEMBER_ADDED/REMOVED/LEFT`, `GROUP_ROLE_UPDATED`, `GROUP_INFO_UPDATED` (incl.
   `checkinSignal`), `mergeRosterFromAdmin`, roster self-heal (both paths), `heldRotations.ts`, `heldGroupKeys.ts`,
   `groupEnforcement.ts` (always enforced), `groupRoles.ts`, `groupKeyRules.ts`, key origins / transition key,
   `inviterRole` / `acceptRoleUpdate` / `mayRotateSoon`, the stored departed list (now `former` from the chain).
   Guardian roles (a family check-in feature that is not part of the community edition) read the chain roster only.

Not in W1: `group_sealed` broadcasts for info/role/call/delete and `here` gossip (W2), epoch topic ids (W3),
presence secret (W4), Mallory scenarios (W5). Group calls stay on the old path (membership always enforced).

## Verification

Full `tsc`; every `scripts/review` test (old-protocol tests updated or removed with reasons); new integration
tests against the real `group_log_routes.py` (log round trip, rebase on stale, catch-up across a rekey, invite verify +
log confirmation, chain-gated key accept/answer, leave → hold until admin rekey, backup/transfer carry the chain);
4-phone sim (SETUP, D1, S1–S7, LATE, NETWORK-GUARD, BROKER-ACL, API-AUTH) with the sim API serving the group log through
the real `group_log_routes.py`.

## Status (2026-10-23, after W1)

Removed review tests (they pinned code that no longer exists; the property is covered elsewhere): `group_enforcement`,
`group_cold_start_roster`, `group_invite_roster`, `group_roster_repair`, `group_roster_heal`, `group_key_cutoff`,
`group_key_origin`, `group_primary_key_request`, `group_key_guard`, `group_key_rotation`, `held_rotations`,
`group_roles`. New: `group_engine_wiring`, `group_engine_review_fixes`, `group_chain_receive`.

Verification: full `tsc` 0 errors; review suite 85 of 86 (the remaining Python test exercises the identity service of the
official edition, which is not in this repository); 4-phone sim: SETUP, D1, S1–S7, LATE all PASS, NETWORK-GUARD 0 blocked,
BROKER-ACL deniedPub = deniedSub = 0, API-AUTH rejected = {} with 5 group-log appends, 41 fetches, 0 rejections through the
real `group_log_routes.py`.

Independent review: 3 HIGH (overtaken own commit stuck; same-head key-rotating commits sharing a kid → current key
dropped; destructive rebuild on a forged gossip), 5 MEDIUM, LOWs — fixed and mutation-checked; the re-review confirmed the
HIGH fixes and two follow-ups were fixed. Still open (by design or for later steps):
- the inviter does not resend an invite that was lost (needs W2 `here` gossip / receipts);
- the blob does not carry over a previous backup's chain for a group this device failed to restore;
- leaving or deleting needs the current epoch key (no "forget locally" yet);
- group tables are not per account; the parent read-only log key sits in the join row until the join completes;
- invites are verified on the main thread (budgeted, not in a worker).

What the next steps must do:
- **W2**: `group_sealed` broadcasts for info/role/call/delete and `here` gossip (head + receipts) replacing the W1
  `group_log_ping`; invite receipts / resend; group calls off the old path.
- **W3**: epoch-derived topic ids instead of the plain gid on MQTT (the gid is still visible to the broker in W1).
- **W4**: presence secret (presence topics are still per identity).
- **W5**: Mallory sim — a malicious server / member: equivocating logs, withheld bundles, invite floods, forged gossip,
  replayed pings — against the defences above.

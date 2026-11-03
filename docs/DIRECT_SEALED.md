# DIRECT_SEALED — sealed 1:1 signalling, DTLS fingerprint check, signed acks and pushes

Status: implemented (2026-10-28; step 5d, 2026-11-02: caller-signed ring token for pushes, DTLS fingerprint check for group
calls). This was a clean break: the plaintext types were removed, not kept for compatibility.
Labels such as "review M1" or "review L4" name findings of the independent code reviews of this change (M = medium, L = low severity).

## 1. What changed

Before this change every 1:1 control message was a plaintext inbox type: DataChannel `webrtc_offer/answer/ice_candidate`, call
`call_request/accept/reject/end` and `call_webrtc_offer/answer/ice`, `profile_update` / `profile_request` (display name, avatar),
`prekey_request` / `prekey_bundle`, `delete_message`, `push_subscription_update`, `typing`. The broker saw SDP (IP addresses, DTLS
fingerprints) and names, and anyone who can publish on an inbox topic (the operator, or whoever holds the JWT signing key) could send any of
them *as* a friend. Injecting one offer to each side made the operator a man in the middle of calls and DataChannels; a forged
`call_request` rang the phone as "Mom".

Now:

| Area | Mechanism | Code |
|---|---|---|
| 1:1 signalling | One MQTT type `direct_sealed` for all of it, payload = identitySeal envelope | `services/directSeal.ts` (portable), `services/directSignal.ts` (app) |
| Calls | callId + seq state machine; connected only after DTLS fingerprints cross-match | `services/callSignalGuard.ts` (portable), `services/voiceCall.ts` |
| DataChannels | unusable until fingerprints cross-match; PC generation rules | `services/webrtc.ts`, `services/dtlsFingerprint.ts` (portable) |
| Names | not in `X3DH_INIT` (inside the sealed via), not in push hints, profile is sealed | `friendInvites.ts`, `AddFriendModal.tsx`, `AppProvider.tsx` |
| Group receipts | `group_msg_ack` signed by the acknowledger, bound to the sender | `services/groupAck.ts` (portable), `AppProvider.tsx` |
| Push | signed on the server-corrected clock, one `clock_skew` retry | `services/signedPost.ts` (portable), `mqtt.ts`, `capacitor.ts` |
| Web Push | signed `POST /api/push/webpush/register` replaces `push_subscription_update` + the unauthenticated relay | `services/webPush.ts`, `api/chat/push.py` |
| Push display | the service worker shows fixed texts only (type + isVideoCall) | `services/pushDisplay.ts`, `sw-custom.ts` |
| Group bubbles | "not sent" + retry for messages that could not be sent | `hooks/useGroupChat.ts`, `GroupChatWindow.tsx` |
| Push ring (5d) | a full-screen / named ring only for a caller-signed ring token that the phone verifies (native and service worker) | `services/ringToken.ts` (portable), `ringDirectory.ts`, `ringSync.ts`, `AegisFCMService.kt` + `RingToken.kt`, `api/chat/push.py` |
| Group calls (5d) | DTLS fingerprints cross-checked per peer connection; media gated per connection | `services/groupCallService.ts` (+ `dtlsFingerprint.ts`) |

## 2. The envelope

`identitySeal` (unchanged, shared with group-key envelopes and friend vias): recipient Ed25519 → X25519, one-time ECDH, HKDF, AES-GCM;
inside, the sender's Ed25519 signature over `domain ‖ content`; content binds `from`, `to`, `iat`, a random `nonce` and the body. The AAD
binds `from`/`to` too. `directScheme(prefix)` gives the domain triple (`prefix:` signature domain, `prefix|` AAD, `prefix/hkdf` info);
AegisTalk uses `aegistalk-direct-v1`. Envelopes of one prefix never open under another (or as group-key envelopes / friend vias).

The broker sees `{ type: 'direct_sealed', from, to, payload: { v, ek, n, ct }, timestamp }` — nothing about the kind.

| kind | content | max ct | fresh (server-corrected clock) | ordering | padded to |
|---|---|---|---|---|---|
| `call` | request / accept / reject / end / offer / answer / ice / fp | 64 KB | 2 min | callId + seq; `request` strictly newer per sender (persisted) | 1 / 16 / 64 KB |
| `dc` | offer / answer / ice / fp, `pc` / `rpc` generation ids, group-key proof | 64 KB | 2 min | PC generation + iat (webrtc) | 1 / 16 / 64 KB |
| `profile` | display name, avatar, `initEph` (add-friend confirmation) | 512 KB | 7 days | strictly newer per sender (persisted) | 1 / 64 / 256 / 512 KB |
| `prekey` | "re-run X3DH with me" + my bundle | 8 KB | 24 h | strictly newer per sender (persisted) | 1 / 8 KB |
| `delete` | delete one 1:1 message I sent | 8 KB | 24 h | (idempotent) | 1 / 8 KB |

Padding puts ICE, fingerprints and call control in the same 1 KB bucket and every SDP (DataChannel, voice, video) in 16 KB, so the broker
cannot tell a voice call from a video call by size. Both sides stamp and judge on `serverNow` (review M1: with the bounded clock a phone 7+
minutes off could not open any DataChannel). The replay guard remembers `(sender, nonce)` until the envelope is stale; the persisted
per-sender marks (`localStorage aegis_direct_marks_v1:<me>`) are capped at `boundedNow + 5 min`, and ordered envelopes more than a day ahead
of the bounded clock are refused (review L1: an operator who moves both clocks a year ahead cannot freeze later profile updates).

## 3. Receive pipeline (`directSignal.startDirectSignal`)

1. One promise chain per sender (an offer that takes long to open is not overtaken by its ICE); at most 1024 senders in flight.
2. `to` must be me. Stored identity = a friend, or a member of one of my groups (AegisTalk identities *are* the public keys, so the stored key
   must equal `from`; the topic suffix is never the trust anchor). Known senders: 120 burst, 2/s. Strangers: 40 burst, 0.5/s each, 120 / 2/s
   in total — enough for one DataChannel setup by a group member my roster has not caught up with.
3. Blocked senders are not opened; an unreadable block list counts as blocked (review L5).
4. Open with the stored key, kind window, then the replay guard. Strangers may only send `dc` (webrtc then requires a group-key proof or holds
   the offer, as before); every other kind from a stranger is dropped. Strangers still use the sealed invite (`X3DH_INIT` via) to become
   friends.
5. One handler per kind (`onDirect`); messages that arrive before their handler registers are kept 60 s (64 per kind).

Sending (`sendDirect`) seals with the unlocked identity and keeps the call order per recipient (review M2: concurrent seals used to reach the
broker out of order and the receiver dropped the "older" seq). DataChannel signals are transient (only while connected), call signals are
queued for 60 s, profile / prekey / delete for 24 h; all of them carry an MQTT 5 message expiry so an offline recipient's queue does not
fill with stale signalling (review L4). A full pre-listener buffer drops the oldest `direct_sealed` (the fresh call that woke the phone
stays).

## 4. Calls

- Every call has a 16-byte random `callId` chosen by the caller; every signal carries it and a per-sender `seq`. Only signals from the
  current peer with the current callId belong to the call; state-changing ones (request/accept/reject/end/offer/answer) need a higher seq,
  ICE and fp do not (replays of those are stopped by the nonce guard).
- The callee takes exactly one offer per call, the caller never takes one; answers only in `have-local-offer`; ICE only for the active call
  (buffered until the remote description is set). A late or replayed `end` of a previous call cannot end the next one.
- Requests from non-friends, blocked contacts (or an unreadable block list) and requests sealed more than 35 s ago do not ring (the caller
  gives up after 30 s). Signals are handled in order (a hang-up that arrives while the request is still being checked ends that call).
- After ICE connects both sides exchange `{ local, remote, got }` fingerprints read from the DTLS transport's certificates
  (`getStats`, SDP as fallback). The call is CONNECTED only when *my remote = his local and my local = his remote*. Until then the
  microphone/camera tracks are disabled and remote tracks muted. Mismatch, 30 s without verification, or unreadable fingerprints → `end`,
  hang-up, `aegis:mqtt-notice { kind: 'call-unverified' }`. 45 s after accepting without being connected → `end (failed)` (review M2).

### Push ring (caller-signed ring token)

Before step 5d the native FCM full-screen call (and the Web Push call notification) trusted the `senderPubkey` the push server
names: the operator could make a phone ring full-screen as "Mom" (no connection followed). Now:

- **Token** (`ringToken.ts`, portable; AegisTalk prefix `aegistalk-ring-v1`): `r1.<b64url claims>.<b64url Ed25519 sig>`, claims
  `{"v":1,"d":prefix,"callId","from","to","iat","nonce","video"}` in exactly one encoding (fixed field order, no whitespace,
  canonical base64url; JS, Python and Kotlin match it with the same pattern instead of three JSON parsers), signature over
  `prefix:` ‖ the claims bytes. No names. `callId` is the call's id (the sealed `request` carries the same one).
- **Caller**: `voiceCall.startCall` → `mqtt.triggerFcmNotify(peer, { type: 'incoming_call', isVideoCall, callId })` signs the token
  with the unlocked identity. `iat` is on the **bounded** clock (`boundedNow`: device clock + API offset capped at ±5 min;
  security review H1: on `serverNow` an operator answering `clock_skew` with "next Tuesday" could collect a token that rings
  next Tuesday). If the server finds that stale (the caller's clock more than ~10 min off) the push goes again without a token.
- **Server** (`ring_token_ok`): only on `incoming_call` (else 422 `ring_token_not_allowed`); shape, `from` = the request signer
  (verified with that key), `to` = the recipient, ±300 s, else 422 `invalid_ring_token` before any cooldown / `request_id` is
  used; passed through unchanged (`ringToken` in the FCM data / Web Push payload). The server builds every push and adds no names.
- **Phone** (both paths, same rules and the same test vectors): `to` = me; `from` = the push's `senderPubkey`; `from` is a stored
  friend (local contact, not blocked; an unreadable block list counts as blocked); signature; `iat` within ±5 min of the bounded
  clock (offset capped at ±5 min on read and write; review H2); the `callId` not seen before. Only verified tokens are remembered
  (a forged token cannot burn a genuine call id); entries are kept until `iat + 20 min` (freshness + 2 × cap) and pruned only by
  the **device** clock, so moving the API offset cannot empty the cache while a token is still acceptable.
  - native: `AegisFCMService` → `RingToken.verify` (Tink Ed25519, works on minSdk 24), `RingContextStore` (me + offset, set by JS
    through the `RingContext` plugin), `RingSeenStore`. Valid → `IncomingCallActivity` full screen with the local contact name,
    video from the token. Otherwise a plain message-channel notification ("Incoming call", app label, no name; none while the app
    is in the foreground).
  - service worker: `decideRing` (WebCrypto Ed25519) on an IndexedDB directory `{ me, non-blocked friends → local name, offset }`
    that the chat screen syncs (`useRingDirectory` → `ringSync`, the web build only). Valid → call-style notification with the
    local name; otherwise a plain notification with its own tag (a click opens the app; a swipe sends no `REJECT_CALL`).
  - Logout, kick and device transfer clear the directory, the native context and the seen calls; a sync still running at
    logout writes nothing afterwards (review L1).

### Group calls

Group-call signalling is sealed since W2 (`group_key_sealed` kind `call`). Step 5d ports the 1:1 fingerprint check:

- After a peer connection's ICE connects, both sides send `{ local, remote, got }` as a new signal `fp` over the same sealed,
  transient channel (sender proven by the identity envelope, member check, 2-minute window, nonce replay guard). The connection
  counts as connected only when the fingerprints cross-match (`createFingerprintCheck`, 30 s timeout).
- Media gate per connection: every PC gets its own `track.clone()` of the microphone / camera, disabled until that PC verified (a
  track shared by all PCs cannot be switched off for one peer); the peer's stream is held back and muted until then; mute and
  camera toggles reach the clones.
- Mismatch, timeout or unreadable fingerprints → only that PC is closed and the participant removed (the others stay), its clones
  are stopped, `aegis:mqtt-notice { kind: 'group-call-unverified' }` shows a banner.

## 5. DataChannels

- `isDataChannelOpen` / `send` are false and inbound frames are held (256 frames / 8 MB) until the fingerprints cross-match for this exact
  PC pair (`pc` = the peer's PC id, `rpc` = mine); OPEN is announced only then. Mismatch → close the PC, drop the held frames,
  `link-unverified` notice; timeout → close (health checks reconnect).
- Only an offer that came through the sealed channel (`authenticated`) is handled. A live PC is torn down for an offer with a different
  pcId only if that offer is newer than the one that set up the current PC (`remotePcIat`): replays and late offers cannot hijack it.
- Answers must answer my current PC (`rpc = localPcId`) in `have-local-offer`; an answer from a *different* PC generation of the peer on a
  live PC closes it (review L2: the peer's certificate changed, the verified fingerprints no longer apply). ICE only for the peer's current PC.

### Why the fingerprints travel in DIRECT_SEALED, not in the Double Ratchet

An earlier design put them "inside the Double Ratchet channel". The ratchet adds nothing here: whoever holds a friend's identity key can reset the
ratchet anyway (`X3DH_INIT` with `sessionReset`), so both channels have the same trust anchor (the stored identity key). The sealed channel
also works for the voice call PC (which has no DataChannel to carry ratchet messages before it is verified), for group members who are not
friends (no 1:1 session), and does not depend on a healthy ratchet (a desynchronised session would turn every reconnect into a false
"man in the middle" alarm). Each fingerprint message is bound to the callId / PC pair, fresh for 2 minutes and single-use.

## 6. Names, receipts, pushes

- `X3DH_INIT` carries no `senderName`; the name is inside the sealed via (`makeVia(..., senderName)`, `viaName`), and the reply profile is
  a sealed `profile` (with `initEph`). `cleanPeerName` and a 400 KB avatar cap apply on receipt.
- `group_msg_ack` = `{ type, ids, ts, sig }`, `sig` = acknowledger's Ed25519 over `aegistalk-gack-v1:` ‖ JSON `{from, to, ids, ts}`.
  The receiver verifies with the DataChannel peer's key and `to = me`; otherwise nothing is cleared and resends continue.
- Push and FCM registration requests are signed on `mqttService.signedClock()` (server-corrected) and retried once on
  `401 {code: clock_skew, server_time}`. MQTT messages carry no push hint. Call pushes carry the caller-signed ring token (§4).
- Native Android: the community flavour has no FCM unless a self-hoster adds their own `google-services.json`
  (`docs/SELF_HOSTING.md`, "Android app"); then the same ring-token rules apply.
  The community edition sends only `message` and `incoming_call` (the chat server accepts nothing else):
  `services/pushRequest.ts` uses the community set unless `VITE_AEGIS_EDITION=official`, and `vite.config.ts` refuses that
  variable together with `AEGIS_EDITION=chat` (`push_signing_self_test`).
- Web Push: after notification permission is granted the PWA subscribes with the server's VAPID key (`/api/chat/server-config`) and
  registers it signed; subscriptions left by older builds, made with another key, or not yet registered by this account are replaced
  (review M3 — old endpoints were broadcast to friends). The server deletes subscriptions the push service answers 401/403/404/410.
- The service worker never shows names, titles, bodies, icons or tags from a push (review M4); `isVideoCall` is parsed from the server's
  `"true"`/`"false"` strings.

## 7. Threat model

Operator / broker / anyone with the JWT key: reads, drops, delays, replays, reorders and injects any MQTT message on any topic; can lie
about server time to one or all clients; runs the push server. Cannot forge Ed25519 signatures of identities it does not hold.

| Attack | Result now |
|---|---|
| inject offers to both sides of a call or DataChannel (MITM) | plaintext types are dropped; Mallory-signed envelopes labelled as the peer do not open; even with a working relay the DTLS fingerprints would not cross-match → hang-up / PC closed, user told |
| forged call request / accept / profile / prekey / delete | dropped (signature, stored identity, stranger rule) |
| replay recorded genuine signalling | nonce guard, callId/seq, PC generation + iat, persisted request/profile/prekey marks; a full replay of an old call cannot complete DTLS |
| pcId hijack of a live DataChannel | refused unless authenticated and newer |
| forged `group_msg_ack` to stop resends | ignored, resends continue |
| read names / SDP / IPs / fingerprints on the broker | sealed; sizes bucketed |
| ring a phone with a forged push (native or web) | no full-screen / call-style ring and no name: that needs a fresh token signed by the friend for me; at most a plain notification |
| replay or delay a genuine call push | rings at most once per call id, and only while the token is fresh: about 10 minutes after the real call (15 if the operator also skews the caller's clock by the 5-minute cap) |
| inject offers or a relay into a group call | each peer connection's fingerprints must cross-match before media flows; a mismatch drops only that connection, user told |
| forge, replay or hold back an existing friend's `X3DH_INIT` (session reset, bundle, name) | dropped unless signed by the friend for me over every field it acts on, fresh on the bounded clock (10 minutes; at most 5 minutes of server offset believed) and newer than the newest INIT accepted from him (persisted mark); at most 5 resets per friend per 10 minutes |

What the server still sees (residual metadata): who sends to whom and when (inbox topics, `from`, outer timestamp), ciphertext size buckets,
the ring token's `callId` (random) and `video` flag for call pushes,
message counts and timing (a call is request + accept + offer/answer + ICE bursts; a DataChannel setup lacks the request/accept), the push
API's sender, recipient, `incoming_call` and `isVideoCall`, web push endpoints per account, `X3DH_INIT`'s outer fields (ephemeral key, SPK,
`sessionReset`, sealed via).

Accepted / left for later:
- **Server clock trust.** Freshness uses `serverNow` so skewed phones keep working; an operator who lies about time can deliver a withheld,
  never-seen call request later (it rings; accepting leads to the 45 s connect timeout). Seen requests cannot be replayed (persisted mark).
  `X3DH_INIT` is judged on `boundedNow` instead (security review M1): a phone whose own clock is more than 5 minutes off refuses its
  friends' INITs (session repair) like group calls and presence, and is told about the drift.
- **Delayed genuine ring.** The operator can withhold a friend's real call push and deliver it up to ~10–15 minutes late (see the
  table); it rings once, for a call that really happened. The seen-call cache is cleared on logout / reinstall, so right after
  logging in again a still-fresh genuine push can ring once more. A phone whose clock is more than 5 minutes off (or a push
  without a valid token, e.g. from an old build) gets the plain notification; the in-app ring (sealed `request`) is unaffected.
- **Seen-call cache by volume.** The cache keeps 256 call ids; a group of colluding friends who sign hundreds of genuine tokens
  to me inside 20 minutes (the push server's per-sender limits allow about 6 calls a minute each) can push out older entries, and
  the operator can then re-ring one genuine call that is at most ~10 minutes old, once.
- **Group-call renegotiation** on a verified connection must keep the verified remote certificate (`a=fingerprint` in the new
  offer), otherwise the connection is dropped (defence in depth; the sealed signalling already stops injected offers).
- **Group-call `fp` is not bound to a PC id.** A delayed `fp` from an earlier connection with the same member (inside the 2-minute
  window) mismatches and drops a verified link — a denial of service the operator can already cause by dropping signals.
- **`X3DH_INIT`** is still a plaintext outer type (needed before a session exists). An existing friend's INIT carries his identity
  signature over every field the receiver acts on and the recipient (step 5b, `services/x3dhInitAuth.ts`), is judged fresh on the bounded
  clock, and must be newer than the newest INIT accepted from that friend (a persisted mark that does not expire, `services/x3dhReplay.ts`;
  security review M1), so a forged or recorded INIT can no longer force a reset, store a stale bundle or bring back an old name. Left:
  the operator can withhold an INIT, or deliver a genuine one up to 10 minutes late when no newer one from that friend arrived first (it
  does once what the friend asked); its outer fields stay visible (above).
- **Ring actions carry no call id** (security review L5). The service worker's accept / reject notification actions and the native
  full-screen ring (`IncomingCallActivity`) act on "the" incoming call: a genuine but late ring (up to about 15 minutes, see the table)
  that the user acts on could accept or reject a different call that is ringing in the app at that moment. Carrying the call id from the
  push through the notification, the service-worker / native intents and the call state machine (and ignoring a mismatch) is left for
  later.
- **Community account without an owner record** (security review L5). An install from before the owner record existed, or one where
  both writes of the record failed, is used on whatever server is active, without asking (`services/serverAccount.ts`
  `localAccountOwner`). Every create, restore and unlock writes the record, so only such installs are affected.
- `seed_sync` and other control frames ride the (now verified) DataChannel without extra signing; device transfer types are unchanged.
- The `Friend.pushSubscription` field that older builds stored is no longer read; a later storage migration removes it.

## 8. Tests

- Step 5d: `ring_token` (JS rules, `decideRing`, 22 cross-implementation vectors in
  `packages/pwa/android/app/src/test/resources/ring_token_vectors.json`, clock caps, device-clock pruning, the logout race, wiring),
  `RingTokenTest.kt` (JVM: the same vectors plus Tink-signed cases), `push_ring_token_self_test.py` (server), `push_display`,
  `group_call_fingerprint`; mutation runner `step5d_mutants.py` (JS / Python and native JVM mutants); simulator `G1` (group-call
  fingerprints, mismatch drops one peer) and `R1` (genuine vs forged / replayed / stale call pushes on the JS push path, the push
  server refusing forged and forwarded tokens).
- Unit / integration (`scripts/review`): `direct_seal`, `direct_signal`, `call_state_machine`, `dtls_fingerprint`,
  `webrtc_fingerprint_gate`, `group_ack_signed`, `webpush_register` (also runs the real Python router), `push_display`,
  `direct_sealed_wiring`, extended `mqtt_buffers`, `push_signing`, `group_unsent_status`, `webpush_self_test.py`, plus the updated
  pre-existing suites.
- Mutation: `scripts/review/step4_mutants.py` — 63 mutants, each removing one protection; all killed.
- Security review (step 9): `x3dh_init_mark` (M1), `account_export_pin` (M2: recovery kit and device transfer need the PIN),
  `server_pick_switch` (L1, L2), `capacitor_navigation` (L3), `chat_auth_fail_closed` (L4); their mutants are in
  `step5_mutants.py` and `step5d_mutants.py`.
- Four-phone simulation (`scripts/sim`): `C1` (call via UI, fingerprints cross-match, hang-up), `C2` (operator/Mallory injection for both
  sides, replays, DataChannel rebuild replay, call during injection), `C3` (fingerprint mismatch → hang-up + notice), S13 bubble "not sent"
  + retry; LEAK fails on any plaintext 1:1 type, malformed `direct_sealed`, name in `X3DH_INIT`, push hint, or readable display name on any
  topic. Run on 2026-10-28: 24 scenarios, 202/202 required checks; LEAK checked 693 inbox publishes (567 `direct_sealed`,
  123 `group_key_sealed`, 3 `x3dh_init`) and 834 non-group publishes, 0 findings; API-AUTH 0 rejections (52 signed pushes, no names).

## 9. Reusing the portable modules

These modules have no app imports and can be reused by another app with its own domain prefix: `directSeal.ts`
(`directScheme('<your-prefix>-v1')`), `callSignalGuard.ts`, `dtlsFingerprint.ts`, `groupAck.ts` (its own `domain`), `signedPost.ts`,
`ringToken.ts` (`signRingToken` / `verifyRingToken({ prefix: '<your-prefix>-ring-v1', … })`, `clampRingOffset`, `ringSeenToPrune`).

群星 (AegisPlay) port notes for step 5d:
- Ring token: copy `ringToken.ts` unchanged and pass your own prefix; on the server copy `ring_token_ok` / `RING_*_RE` from
  `api/chat/push.py` (the prefix is read from the claims, so the server code is app-agnostic) and the `ringToken` hint field.
  Natively copy `RingToken.kt` (change `PREFIX`) and `RingTokenTest.kt`; regenerate the vectors with
  `node scripts/review/ring_token_self_test.mjs --write` after switching the prefix there. The glue to rewrite: the friend
  lookup (AegisTalk: identity = public key, `LocalSenders` on the native side, `ringSync` → IndexedDB for the service worker),
  the bounded clock (`boundedNow`), `triggerFcmNotify` (sign in the push builder, retry without a token on 422), the service
  worker's push handler and `AegisFCMService`.
- Group-call fingerprints: the pattern in `groupCallService.ts` (a fingerprint check per peer connection, an `fp` signal over the
  app's sealed group-call channel, per-PC `track.clone()` gate, drop only that PC on failure) applies to 群星's mesh calls; reuse
  `dtlsFingerprint.ts` as is.
The glue that has to be rewritten against another app's stores: `directSignal.ts` (stored identity = friend or group member, block list,
marks storage, MQTT type), the `voiceCall.ts` / `webrtc.ts` integration (`onDirect('call' | 'dc')`, one fingerprint check per PC, the
media/DataChannel gate), the `AppProvider` handlers for profile/prekey/delete and the ack branch, `webPush.ts` + the server route, and
`pushDisplay.ts` in the service worker. A server for it must accept only server-built push hints and answer `clock_skew`.

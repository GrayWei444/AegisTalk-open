# Changelog

## 1.0.0 — 2026-11-03

First public source release of AegisTalk Chat, the self-hostable chat edition of AegisTalk, under the MIT license.

- **Chat server you can run yourself** (`api/chat_app.py`): keys-only accounts signed by the identity key (no e-mail,
  phone number or face scan), registration policy `invite` by default (`open` / `closed`), per-IP and global limits,
  start-up checks that refuse unsafe settings instead of generating secrets, Web Push (VAPID) built in, FCM optional
  with your own Firebase project. Guide: `docs/SELF_HOSTING.md`; broker policy for EMQX 5.8.9: `docs/MQTT_BROKER.md`.
- **Sealed 1:1 signalling**: every 1:1 control message is one signed, encrypted `direct_sealed` envelope; calls and
  DataChannels connect only after the DTLS fingerprints cross-match, group calls per peer connection
  (`docs/DIRECT_SEALED.md`).
- **Push rings signed by the caller**: a full-screen / named incoming-call ring from a push needs a ring token the caller
  signed and the phone verifies (friend, fresh, once per call); the push operator cannot ring a phone as one of its contacts
  (`docs/DIRECT_SEALED.md` §4).
- **Group state as a signed commit chain** on a server-ordered log, epoch-derived group topics, friends-only encrypted
  presence, and an adversarial simulation with a malicious operator (`docs/GROUP_LOG_WIRING_W1.md` … `W5.md`).
- **Encryption core built from source** with a pinned toolchain; it logs no key material, and builds can be checked
  against published hashes (`packages/crypto-core/README.md`).
- **Community app** "AegisTalk Chat (community)" for Android (`com.aegisrd.talk.community`, its own Gradle flavour without
  the official app's native plugins; FCM only with your own Firebase project) and the web: no default server (chosen on first run,
  changeable in Settings), local PIN login, device transfer to a new phone and an offline recovery kit for a lost
  one, Web Push only after notification permission.
- **Tests you can run on your own machine**: `npm test` runs the review suite (`scripts/review/run-all.mjs`, with the
  mutation runners on request), `scripts/sim/local-run.sh` the four-phone + attacker simulation against a simulated server
  that applies the real server's token ACL and group-log code, and `scripts/selfhost/conformance.sh` brings up the docker
  compose example and checks it end to end (smoke test, two browsers, reverse-proxy settings).
- Not included: the AI anti-fraud engine (its warning components are present but inert), guardian / family
  check-in, payments, and the iOS app (planned for v1.1).

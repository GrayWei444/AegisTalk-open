# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's **"Report a vulnerability"** button (Security →
Advisories) on this repository. Do not open public issues, discussions or pull requests for security problems.

<!-- RELEASE CHECK: enable private vulnerability reporting on the public repository (Settings → Code security, or `gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting`) before the first push. -->

Include the affected component and version or commit, steps to reproduce, and the impact you expect. We aim to
acknowledge reports within 7 days and to agree on a disclosure date with you once a fix is available.

## Supported versions

Only the latest release receives security fixes. Self-hosted servers should run the server code of the same release
as the apps that connect to them.

## Scope

In scope:

- the app (`packages/pwa`, including the Android shell),
- the encryption core (`packages/crypto-core`),
- the chat server (`api/chat_app.py`, `api/chat/`, `api/group_log_routes.py`),
- the example deployment (`docker-compose.example.yml`, `emqx/base.hocon.example`, `api/.env.example`,
  `docs/SELF_HOSTING.md`, `docs/MQTT_BROKER.md`).

Out of scope: third-party dependencies (please report upstream), deployments run by other people, and the parts of
the official AegisTalk service that are not in this repository.

## Threat model in short

The design assumes the **server operator is not trusted with content**. The operator — or anyone who controls the
broker or holds the server's MQTT signing key — can read, drop, delay, replay, reorder and inject any MQTT message on
any topic, lie about the server time, run the push and group-log servers, and show different group logs to
different members. It cannot forge the Ed25519 signature of an identity key it does not hold
([DIRECT_SEALED §7](docs/DIRECT_SEALED.md#7-threat-model)).

What the design protects against that operator:

- **Content.** Messages and files travel peer-to-peer over WebRTC DataChannels, encrypted with X3DH + Double Ratchet
  (1:1) or the group's current epoch key (groups). There is no TURN relay and no server-side copy.
- **1:1 signalling.** Every 1:1 control message (call and DataChannel offers / answers / ICE, call control, profile,
  pre-key requests, deletes) is one sealed, signed `direct_sealed` envelope; injected or replayed signals do not open
  or are refused ([DIRECT_SEALED §1–§3](docs/DIRECT_SEALED.md#1-what-changed)).
- **Man in the middle of calls and DataChannels.** A call is connected, and a DataChannel usable, only after both sides'
  DTLS certificate fingerprints cross-match over the sealed channel
  ([DIRECT_SEALED §4–§5](docs/DIRECT_SEALED.md#4-calls)).
- **Group membership and keys.** Group state is a chain of commits signed by members and checked by every member; the
  server only orders opaque log entries. Forged members, forged admin actions and replays are rejected; a server that
  shows different logs is detected through head gossip, not prevented
  ([W1 background](docs/GROUP_LOG_WIRING_W1.md#background-the-group-log-model), [W5 attacks](docs/GROUP_LOG_WIRING_W5.md#3-attacks-and-results)).
- **Group and presence metadata.** Group topics are derived from the epoch key (no group id on the broker,
  [W3](docs/GROUP_LOG_WIRING_W3.md)); presence is a secret, encrypted topic shared only with friends
  ([W4](docs/GROUP_LOG_WIRING_W4.md)).
- **Broker access.** Every MQTT token carries its own default-deny ACL bound to the connection's username and client
  id ([MQTT_BROKER](docs/MQTT_BROKER.md)).
- **Key material.** The crypto core does not log key material, and builds can be checked against
  `packages/crypto-core/REPRODUCIBLE*.sha256` ([crypto-core README](packages/crypto-core/README.md)).

What it does **not** protect against — metadata visible to the server, availability, and the known gaps — is listed
in the README: [What the server still sees](README.md#what-the-server-still-sees),
[What the operator can do](README.md#what-the-operator-can-do) and [Known limits](README.md#known-limits).

## For reviewers

- `scripts/review/` holds the unit / integration tests (`*_self_test.mjs`, `*_self_test.py`) and the mutation
  runners (`*_mutants.py`: each mutant removes one protection and must be caught by an assertion).
- `scripts/sim/` runs four simulated phones plus an attacker ("Mallory") and a malicious operator against the real
  app build, the real token ACL and the real group-log routes, with audits for plaintext leaks, broker ACL refusals,
  group ids on the broker and presence topics ([W5 §2](docs/GROUP_LOG_WIRING_W5.md#2-the-harness)).
- `scripts/selfhost/` checks a running server from the outside (`selfhost_smoke.py`, `two_browsers_e2e.mjs`) and brings
  up the docker compose example to run both against it (`conformance.sh`).

All of it runs on one machine, with nothing connecting to a real service
([SELF_HOSTING · Running the tests](docs/SELF_HOSTING.md#running-the-tests) has the setup):

```bash
npm test -- --python .venv/bin/python               # the review suite (scripts/review/run-all.mjs)
npm test -- --python .venv/bin/python --mutants     # plus the mutation runners
scripts/sim/local-run.sh --playwright <dir>         # the four-phone + Mallory simulation (community edition)
scripts/selfhost/conformance.sh                     # the compose stack: smoke test, two browsers, reverse-proxy settings
```

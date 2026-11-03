# Self-hosting the AegisTalk chat server

> Status: the bare-metal setup below was run end to end on 2026-10-26 (Ubuntu 20.04, Python 3.12, EMQX 5.8.9
> tarball, Caddy 2.10.2): `scripts/selfhost/selfhost_smoke.py` passed 34/34 checks through Caddy.
> `docker-compose.example.yml` was run under Docker on 2026-11-03 (Ubuntu 24.04, Docker 29.4.1, Compose 5.1.3, EMQX
> 5.8.9) with `scripts/selfhost/conformance.sh` ([Check your server](#check-your-server)): `selfhost_smoke.py` 34/34
> direct and 34/34 behind the reverse-proxy settings, the proxy-token guard 403 / 403 / 401, and the two-browser test
> 12/12 with the community web build.

AegisTalk apps talk to one chat server: an API (FastAPI + SQLite) and an MQTT broker (EMQX). Messages, files and
calls go directly between the phones over WebRTC and are end-to-end encrypted; the server relays encrypted
signalling envelopes and keeps accounts, tokens, the group logs and a few counters.

Contents: [what a server consists of](#what-a-server-consists-of) · [accounts](#accounts) ·
[quick start (docker compose)](#quick-start-docker-compose) · [bare metal](#bare-metal-the-setup-that-was-tested) ·
[reverse proxy](#reverse-proxy-caddy) · [settings and start-up checks](#settings) · [MQTT broker](#mqtt-broker) ·
[push](#push-notifications-optional) · [data and backups](#data-on-disk-and-backups) · [upgrading](#upgrading) ·
[pointing the apps at your server](#pointing-the-apps-at-your-server) · [known limits](#known-limits) · [check your server](#check-your-server) ·
[running the tests](#running-the-tests)

## What a server consists of

| Part | What it does | Sees message content? |
|---|---|---|
| API (`api/chat_app.py`) | keys-only accounts, MQTT tokens, one-active-device check, short friend codes, group log (ordering only), push | No |
| MQTT broker (EMQX 5.8.9) | delivers encrypted envelopes, presence (encrypted), offline queue (24 h sessions) | No |
| TLS reverse proxy (Caddy) | HTTPS for the API, `wss://` for the broker, optional static web app | No |
| Static web host (optional) | serves the PWA (`packages/pwa/dist`) | No |

What the operator can still see or do (by design; the full list is in the README, "What the server still sees" and
"What the operator can do"): who connects when and from which IP,
which topics a token covers (that reveals who subscribes to whose presence topic, i.e. the friend graph), the
size and timing of every envelope, which account appends to which group log, and the plaintext public parts of a
short friend code (public key, display name). The operator can drop or delay anything. It cannot read messages,
forge members or keys, or decrypt presence.

## Accounts

There is no e-mail, phone number or face scan. An account is an Ed25519 identity key: the app signs
`POST /api/account/register`, and the server maps the key to a random account id (`pubkey_account_map`).
Every later request is signed by the same key.

`CHAT_REGISTRATION` decides who may create an account:

| Policy | Meaning |
|---|---|
| `invite` (default) | a new account needs an invite code |
| `open` | anyone can register (still rate limited) |
| `closed` | no new accounts; existing ones keep working |

`invite` is the default because a self-hosted server is usually for a known group of people, and because every
account can use the server's resources (offline queues, group-log appends, push) within per-account limits: the
registration policy is what bounds how many accounts one person can create.

Invite codes (only their SHA-256 is stored; the code is shown once):

```bash
cd api && AEGIS_DB_PATH=/srv/chat/chat.db python -m chat.invites create --uses 5 --days 7 --note "family"
python -m chat.invites list
python -m chat.invites revoke <code or id>
# docker:
docker compose -f docker-compose.example.yml exec -u 10001 api python -m chat.invites create --uses 5
```

New accounts are also limited per client IP and in total, per hour and per day (`CHAT_REGISTER_*`, defaults
3 / 10 per IP and 60 / 500 overall). An IP that guesses ten wrong invite codes in an hour is refused for the rest
of the hour. Every per-IP limit counts an IPv6 client by its /64 (one home network = one IP). IPs are stored only
as keyed hashes for one day; the key mixes a random value in the database with `AEGIS_MQTT_JWT_SECRET`, so a copy
of the database alone does not reveal them.

## Quick start (docker compose)

```bash
cp api/.env.example api/.env        # fill it in; leave AEGIS_MQTT_JWT_SECRET empty there
cat > .env <<EOF
AEGIS_MQTT_JWT_SECRET=$(openssl rand -hex 32)
EMQX_NODE_COOKIE=$(openssl rand -hex 32)
EMQX_DASHBOARD_PASSWORD=$(openssl rand -hex 16)
EOF
docker compose -f docker-compose.example.yml up -d
curl http://127.0.0.1:8000/health
```

In `api/.env` for compose: `AEGIS_DB_PATH=/data/chat.db`, `CHAT_TRUSTED_PROXIES` = the compose network's
gateway address (the `gateway` under `networks:` in `docker-compose.example.yml`, also given as the example value in
`api/.env.example`: that is the address the API sees when the host's Caddy connects to the published port) and a
`CHAT_PROXY_TOKEN` (`openssl rand -hex 32`) that your Caddy also gets. All ports are published on 127.0.0.1 only.
The API runs as uid 10001 and owns only `/data`.

What the compose file runs:

| Service | Image | Notes |
|---|---|---|
| `api` | `python:3.12.14-slim-bookworm` | installs `api/requirements-chat.txt` (+ `CHAT_PIP_EXTRAS`) at start, then drops to uid 10001; `api/` is mounted read-only |
| `emqx` | `emqx/emqx:5.8.9` | `emqx/base.hocon.example` mounted as `base.hocon`; the JWT secret comes from the environment |
| `web` (profile `web`) | `caddy:2.10.2-alpine` | optional static server for `packages/pwa/dist` on 127.0.0.1:8080 |

For production, build an image with the requirements pre-installed (`pip install --require-hashes`) instead of
installing them at every start, as the comment in the compose file says.

## Bare metal (the setup that was tested)

```bash
python3.12 -m venv /srv/chat/venv
/srv/chat/venv/bin/pip install -r api/requirements-chat.txt          # + -r api/requirements-webpush.txt for Web Push
cp api/.env.example /srv/chat/env                                    # fill in (see "Settings")
cd api && set -a && . /srv/chat/env && set +a
/srv/chat/venv/bin/uvicorn chat_app:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

`--no-proxy-headers` matters: the app decides itself which `X-Forwarded-For` to believe (see "Reverse proxy").

EMQX: download the 5.8.9 package for your OS from emqx.com (check the `.sha256` next to it), then

```bash
cp emqx/base.hocon.example <emqx>/etc/base.hocon
EMQX_NODE__COOKIE=$(openssl rand -hex 32) \
EMQX_AUTHENTICATION__1__SECRET=<the same value as AEGIS_MQTT_JWT_SECRET> \
EMQX_DASHBOARD__LISTENERS__HTTP__BIND=127.0.0.1:18083 \
EMQX_DASHBOARD__DEFAULT_PASSWORD=<a new password> \
<emqx>/bin/emqx foreground
```

The JWT secret is passed as an environment variable so it never sits in a config file. `emqx ctl conf show
authentication` / `authorization` / `mqtt` show what EMQX actually uses.

## Reverse proxy (Caddy)

```caddyfile
chat-api.example.com {
	reverse_proxy 127.0.0.1:8000 {
		# the API trusts X-Forwarded-For only on requests from CHAT_TRUSTED_PROXIES that carry this token;
		# header_up replaces whatever a client sent in the same header
		header_up X-Aegis-Internal {env.CHAT_PROXY_TOKEN}
	}
}
chat-mqtt.example.com {
	reverse_proxy /mqtt 127.0.0.1:8083
}
chat.example.com {
	root * /srv/chat/pwa
	file_server
}
```

Start Caddy with `CHAT_PROXY_TOKEN` in its environment (the same value as in the API's settings). Caddy replaces a
client's own `X-Forwarded-For` with the real address, so the API's per-IP limits see real clients; in the tested
setup a client sending a forged `X-Forwarded-For` and a forged `X-Aegis-Internal` through Caddy was still counted
as its real address. Other proxies work the same way if they (1) connect from an address listed in
`CHAT_TRUSTED_PROXIES`, (2) set `X-Aegis-Internal` and (3) set or append `X-Forwarded-For`; the API takes the
right-most address that is not one of your proxies.

Symptoms of a wrong proxy setup: `POST /api/mqtt/token` answers `403 Unauthorized` (the request did not come from
a trusted address with the token), or every client shares one rate-limit bucket.

## Settings

Every setting is an environment variable; `api/.env.example` lists all of them with comments. The server refuses
to start — and lists every problem — when:

- a required value is missing: `AEGIS_MQTT_JWT_SECRET`, `AEGIS_DB_PATH`, `CHAT_PUBLIC_MQTT_URL`,
  `CHAT_APP_ORIGINS`, `CHAT_TRUSTED_PROXIES` (an address list, or `none` when clients reach the API directly);
- a secret is shorter than 32 characters, or two secrets are equal (MQTT secret, proxy token, VAPID key);
- `CHAT_PUBLIC_MQTT_URL` is not `wss://` (`ws://` only for localhost); an origin in `CHAT_APP_ORIGINS` is `*`,
  has a path, or is `http://` on a non-local host;
- `CHAT_TRUSTED_PROXIES` lists addresses but `CHAT_PROXY_TOKEN` is missing, is `none` but a token is set, contains
  something that is not an IP/CIDR, or trusts everyone (`0.0.0.0/0`);
- only one of the two VAPID keys is set, they do not belong together, `CHAT_VAPID_SUBJECT` is missing, or
  `pywebpush` is not installed;
- `CHAT_FCM_CREDENTIALS` is set but unreadable, not a service-account JSON, or `firebase-admin` is missing;
- the database folder is not writable; a number is out of range; a chat module fails to import.

Nothing is ever generated for you: a missing secret is an error, not a random value that changes at every restart.
The error names every problem at once (never a secret's value), for example:

```text
chat server refuses to start (see api/.env.example):
  - AEGIS_MQTT_JWT_SECRET is required (generate one with: openssl rand -hex 32)
  - CHAT_TRUSTED_PROXIES is required ...
```

At start the server prints one line with the effective settings (database paths, broker URL, origins, trusted
proxies, registration policy, ACL format, push), without secrets.

## How the app finds the rest of your server

The user enters only the API URL. The app then calls `GET {api}/api/chat/server-config` (no login, no secrets):

```json
{
  "service": "aegistalk-chat",
  "api_version": 1,
  "mqtt_url": "wss://chat-mqtt.example.com/mqtt",
  "stun_urls": ["stun:stun.example.com:3478"],
  "vapid_public_key": "BP…",
  "push": { "webpush": true, "fcm": false, "types": ["message", "incoming_call"] },
  "backup": { "server": false },
  "registration": "invite",
  "name": "Example chat",
  "links": { "privacy": "https://…", "terms": "https://…", "support": "https://…" }
}
```

`registration: "external"` means the server creates accounts some other way (the official AegisTalk service does);
a community build cannot register on such a server. `push.types` is what the server accepts — the chat server accepts
only `message` and `incoming_call`. `backup.server: false`: the server keeps no backups of anyone's keys or
messages.

## MQTT broker

`emqx/base.hocon.example` is the whole broker policy (`docs/MQTT_BROKER.md` explains every line):

- one authenticator: JWT from the MQTT password, HS256 with the API's secret, `acl_claim_name = acl`, the token's
  `username` / `clientid` claims must match the connection, expired tokens are refused and connections are closed
  when the token expires; no user database, no superuser;
- authorization: no sources at all, `no_match = deny`, `deny_action = ignore` — a client can do exactly what its
  token's rules allow. Tokens use the EMQX ≥ 5.7 rule format: only the owner's own presence topic may be retained
  (a retained publish to an inbox or group topic gets PUBACK 0x87), and every token ends with a deny-all rule;
- listeners on 127.0.0.1 (compose: inside the container network), ssl/wss listeners off; per-client rate on the
  ws listener (50 messages/s, 1 MB/s); session and queue limits; retained messages capped (200 000, 2 KB each,
  7 days).

The API adds per-account limits on what tokens may cover, per 24 hours: 2000 distinct group / presence topics
(`CHAT_TOKEN_TOPICS_PER_DAY`, limits topic guessing), 20 own presence tags (= retained topics; beyond that a
token comes without the right to publish presence) and 10 client ids (= persistent broker sessions; beyond that
429).

Do not change authentication or authorization in the EMQX dashboard: dashboard changes are stored in
`cluster.hocon` and override `base.hocon`. Keep the node cookie secret (anyone who can reach the Erlang
distribution port with it controls the broker). EMQX honours an `is_superuser` claim in a token; the API never
issues one, but anyone who has `AEGIS_MQTT_JWT_SECRET` could — rotate it if it leaks (update the API and the
broker at the same time; existing tokens stop working and apps fetch new ones).

### EMQX version and license

Pinned: EMQX 5.8.9 (`emqx/emqx:5.8.9`, released 2025-12-31). Checked 2026-10-26: the `LICENSE` file at tag
`v5.8.9` says the default license of the open-source code is Apache-2.0 (Business Source License only for
enterprise-edition folders that the community build does not ship). From 5.9.0 on (`e5.9.0` tag) EMQX is
distributed under the Business Source License 1.1 (production use limited to a single node not offered to third
parties as a service; each version converts to Apache-2.0 four years after release). The rule-format ACL above
needs EMQX ≥ 5.7; with an older broker set `CHAT_MQTT_ACL_FORMAT=legacy` (tokens then cannot restrict retain).

Why exactly 5.8.9 and not "5.8" or "latest":

- **License.** 5.8.x is the last line under Apache-2.0; a floating tag could pull a BSL release.
- **Tested keys.** `base.hocon.example` was checked key by key with `emqx ctl conf show` on 5.8.9. EMQX renames keys
  between minor versions (for example `retainer.backend.max_retained_messages`; the old top-level key makes 5.8.9
  refuse to start), and an unknown or renamed key can stop the broker or silently fall back to a default.
- **Behaviour the tokens rely on.** The rule-format `acl` claim with `retain`, `verify_claims` and
  `disconnect_after_expire` were tested on this version (`docs/MQTT_BROKER.md` §3.1).

Another broker is possible if it can do the same: JWT (HS256) authentication with the token's own ACL, username
and client id bound to the token, default deny, and no retained messages outside the owner's presence topic.

## Push notifications (optional)

**Web Push** (browsers, the PWA): generate keys with `cd api && python -m chat.vapid`, put both into the settings
with `CHAT_VAPID_SUBJECT=mailto:you@example.com`, install `requirements-webpush.txt`. Browsers register their
subscription with a request signed by the account key (`POST /api/push/webpush/register`); the server only delivers
to the big push services (FCM, Mozilla, Apple, Microsoft — `CHAT_WEBPUSH_HOSTS`), never follows redirects, and
deletes subscriptions the push service reports as gone. A push carries no text: `{"type": "message"}` or, for a call,
the verified caller's public key; the app looks the name up in its own contacts. The web app subscribes only after the
user has granted notification permission, using the VAPID public key from `/api/chat/server-config`; if you change the
key pair, each browser subscribes again with the new key the next time the app starts (`docs/DIRECT_SEALED.md` §6).
Keep `CHAT_VAPID_PRIVATE_KEY` as secret as the other secrets: whoever has it can send pushes to your users' browsers.

**FCM** (native apps): only with your own Firebase project and your own app build (the official app's Firebase
project is not usable from a self-hosted server). Set `CHAT_FCM_CREDENTIALS` to the service-account JSON and
install `requirements-fcm.txt`.

The chat server accepts only `message` and `incoming_call` pushes.

## Data on disk and backups

| File | Contents |
|---|---|
| `AEGIS_DB_PATH` (SQLite) | public key hashes → account ids, active device per account, push tokens / subscriptions, short friend codes (public key, pre-key, display name, 24 h), invite code hashes, one-time request ids (≈ 11 min), rate counters (keyed hashes, ≤ 1 day), token topic counters (keyed hashes, 24 h) |
| group log (`group_log.db`, or `AEGIS_GROUP_LOG_DB_PATH`) | per group: opaque encrypted entries in order; per account and group: usage counters (≤ 2 days) |
| EMQX data | sessions and queued encrypted envelopes (≤ 24 h), retained presence states (encrypted, ≤ 7 days) |

No message, file or call content is stored on the server, and there are no server-side backups of anyone's keys:
a user's keys, contacts and history live on the phone (new phone: transfer from the old one; lost phone: the user's
own recovery kit).

What to back up, and how:

- **Both SQLite files.** They are in WAL mode, so do not copy the files while the API runs; use
  `sqlite3 chat.db ".backup chat.bak"` and `sqlite3 group_log.db ".backup group_log.bak"` (docker:
  run it in the `api` container or on the `chat-data` volume). The group log is the server's only record of each
  group's commit order; back it up together with `chat.db`, and do not restore an older copy of it on a server that
  members kept using (members that already applied later entries would then see the server disagree with them).
- **Your settings and secrets** (`api/.env`, the compose `.env`, the VAPID key pair, the FCM service-account file),
  stored somewhere safe and separate from the database backups. `AEGIS_MQTT_JWT_SECRET` also keys the hashed IP
  addresses in the rate counters, so a database copy without it does not reveal them.
- **EMQX data is optional.** Losing it drops queued envelopes (≤ 24 h) and retained presence; apps republish their
  presence when they reconnect.

## Upgrading

1. Read `CHANGELOG.md` for the version you are moving to.
2. Back up both databases (above).
3. Stop the API, update the code, reinstall the requirements (`pip install -r api/requirements-chat.txt` plus your
   extras; compose does this at start), start it again. The server creates missing tables on start
   (`CREATE TABLE IF NOT EXISTS`) and has no separate migration step; it refuses to start if a new release added a
   required setting, and lists it.
4. Run `scripts/selfhost/selfhost_smoke.py` against the upgraded server.

Keep EMQX on 5.8.9 unless a release note says otherwise (see "EMQX version and license"). If you move to another
version, compare `emqx ctl conf show authentication`, `authorization`, `mqtt` and `listeners` with
`base.hocon.example` before opening it to users, and run MQTT_BROKER.md §6.

## Pointing the apps at your server

- **Community build.** The public app is "AegisTalk Chat (community)" (Android application id
  `com.aegisrd.talk.community`; self-hosters building their own app can override it at build time). It has no
  default server: on first run the user types the server's API URL, "Check" reads `/api/chat/server-config` (the
  broker URL, STUN servers, push keys and registration policy come from there) and "Use this server" saves the choice
  and reloads; from then on the page may connect only to that API and its broker (its `connect-src` is narrowed to
  them). The server can be changed later in Settings and on the welcome screen; switching locks the app.
- **Accounts.** Registration happens in the app: choose the server → welcome screen (create an account, move from an
  old phone, or restore a recovery kit; the server's registration policy is shown) → set a local PIN twice → choose a
  name, plus the invite code when the policy is `invite` → the app registers its identity key
  (`POST /api/account/register`). The PIN is saved only after the server accepted the account, so a refused or
  mistyped invite code can simply be retried. The PIN unlocks the keys on that phone and the server never sees it;
  five wrong PINs lock the app for five minutes.
- **Invite codes.** Give each new user a code from `python -m chat.invites create` ([Accounts](#accounts)); one code
  with `--uses N` serves N accounts.
- **An account stays with its server.** If the account on a phone was created on another server than the one now
  chosen, the app shows a screen instead of the login: switch back (the account unlocks there with its PIN) or start
  a new account on this server (the old one is wiped from the phone first). An account is never used on another
  server.
- **New phone, lost phone.** A new phone gets its data from the old one (device transfer, "move from my old phone").
  For a lost phone the user needs the offline recovery kit made earlier in Settings: a file encrypted with
  AES-256-GCM under Argon2id (64 MiB, t = 3, p = 4) of a passphrase — one the app generates (125 bits, shown once and
  typed back) or one the user chooses (at least 16 characters, about 72 bits). It holds the identity keys, friends,
  groups with their signed chains, the own signed pre-key and the server; restoring it (on the welcome screen, or on
  first run, where it brings the server along) re-registers the account, asking for an invite code if the server no
  longer knows it. The server keeps no copy.
- **Official server.** The official AegisTalk server does not accept accounts from community builds in v1.
- **Web app.** Serve the built web app (`packages/pwa/dist`) from your own domain (the compose `web` profile or your
  reverse proxy) and list that origin in `CHAT_APP_ORIGINS`.
- **Push on Android.** Web Push works in the browser/PWA with this server. Native Android push (FCM) needs your own
  Firebase project and your own build of the app (next section).

## Android app (community flavour)

The Android project (`packages/pwa/android`) has two flavours; the public one is `chat` ("AegisTalk Chat (community)",
`com.aegisrd.talk.community`). It contains none of the official app's native plugins or models (`docs/EDITIONS.md` §2).

```bash
cd packages/pwa
# (only in a tree that still has editions/chat: cp editions/chat/package.json editions/chat/package-lock.json .)
npm ci && npm run prep:chat
AEGIS_EDITION=chat npx vite build
AEGIS_EDITION=chat npx cap sync android
cd android && ./gradlew assembleChatRelease        # app/build/outputs/apk/chat/release/app-chat-release-unsigned.apk
```

- **Your own id and name.** Publish under your own application id (and, if you like, name and launcher label):
  `./gradlew assembleChatRelease -PaegisChatAppId=org.example.chat -PaegisChatAppName="Example Chat" -PaegisChatLauncherLabel="Example"`
  (or `AEGIS_CHAT_APP_ID`, `AEGIS_CHAT_APP_NAME`, `AEGIS_CHAT_LAUNCHER_LABEL`; also set `AEGIS_CHAT_APP_ID` for `cap sync`). The
  official id `com.aegisrd.talk` is refused. Keep the `.debug` suffix in mind for debug builds.
- **Signing.** Without `android/key.properties` the release APK is unsigned; sign it with your own key (`apksigner`). Keystores
  and passwords never go into the repository.
- **Without FCM (default).** No `google-services.json` → the app never initialises Firebase and registers no FCM token. Users get
  Web Push in the browser/PWA and notifications while the app runs (the Firebase library is still in the APK because
  `@capacitor/push-notifications` depends on it; it stays idle).
- **With FCM.** Create your own Firebase project with an Android app for your application id (add `<id>.debug` too for debug
  builds), put its `google-services.json` at `packages/pwa/android/app/src/chat/google-services.json` (not `app/`; that path
  is the official app's), and give the server your service account (FCM settings above). The chat build never uses an
  `app/google-services.json`.
- **Incoming calls.** A full-screen ring with the caller's name needs the caller's signed ring token, which the server checks and
  forwards (`docs/DIRECT_SEALED.md` §4 "Push ring"); a push without a valid token shows a plain notification.

## Known limits

- The operator sees metadata (who connects when, from which IP, which topics a token covers — that includes the
  friend graph — sizes and timing) and can drop or delay anything; see the README.
- Device-transfer tokens (the new phone receiving its data from the old one) need no account: 20 per IP per hour,
  receive-only, 5 minutes.
- Someone with an account can fill another user's offline queue (1000 messages per session, then the oldest are
  dropped); the per-client rate above slows this down, it does not prevent it.
- Any registered account that knows a group id can append junk entries to that group's log within its own limits;
  members skip them (`docs/GROUP_LOG_WIRING_W5.md` §6).
- There is no TURN relay: two phones whose networks block every direct connection cannot exchange messages or
  calls, and the STUN servers the apps use see their IP addresses. The apps use exactly the `stun_urls` of
  `/api/chat/server-config` (`CHAT_STUN_URLS`); if that list is empty they use their built-in public STUN servers,
  `stun.l.google.com` and `stun1.l.google.com` (`packages/pwa/src/services/iceServers.ts`).

## Check your server

```bash
pip install cryptography paho-mqtt
python3 scripts/selfhost/selfhost_smoke.py --api https://chat-api.example.com --invite <a code with --uses 2>
```

It registers two throw-away accounts and walks the whole path an app uses: server-config, registration, tokens,
broker connect (and refusals), inbox delivery, retain rules, device claim with the "device replaced" notice coming
back through the broker, group log, a signed short friend code, a device-transfer token. It uses two new accounts, so
run it on a server whose per-IP limit still allows two registrations.

`scripts/selfhost/two_browsers_e2e.mjs` does the same with the real web app in two browsers (choose the server,
register with an invite, add each other with a short code, messages both ways, no request to any other host):

```bash
node scripts/selfhost/two_browsers_e2e.mjs --dist packages/pwa/dist --api https://chat-api.example.com \
  --invite <a code with --uses 2> --playwright <a node_modules folder with playwright>
```

It serves the web build on `http://127.0.0.1:48280`, so that origin has to be in `CHAT_APP_ORIGINS` of the server you
point it at (a local test server; see the conformance run below).

**The compose stack, end to end.** `scripts/selfhost/conformance.sh` runs `docker-compose.example.yml` with
`emqx/base.hocon.example` in a temporary copy (fresh secrets; only the chat server's files go into the API
container), runs both checks above against it, then the API again with the reverse-proxy settings of
`api/.env.example` (token requests without the proxy token are refused; the smoke test passes with it), and removes
the stack and its volumes. It needs Docker with the compose plugin, the ports 8000, 8083, 18083 and 48280 free, and the
community web build for the browser part (`--no-browsers` skips it):

```bash
pip install -r scripts/review/requirements-test.txt    # cryptography, paho-mqtt (and the test packages)
(cd packages/pwa && npm ci && npm run build)            # the community web build, packages/pwa/dist
scripts/selfhost/conformance.sh --playwright ~/.cache/aegistalk-sim/node_modules
```

## Running the tests

Everything below runs on your machine; nothing talks to a real service.

```bash
cd packages/pwa && npm ci && cd ../..
python3 -m venv .venv && .venv/bin/pip install -r scripts/review/requirements-test.txt   # Python 3.10–3.13
npm test -- --python .venv/bin/python             # every scripts/review test (scripts/review/run-all.mjs)
npm test -- --python .venv/bin/python --mutants   # plus the mutation runners (hours)
```

Python 3.14 does not work yet: the server's pinned `pydantic` 2.9.0 has no build for it and its `pydantic-core` fails to
compile (seen with Python 3.14.9 on macOS); use 3.10–3.13 (for example `uv venv -p 3.12 .venv`).

`scripts/review/run-all.mjs` checks the environment first and says what is missing, runs the tests in parallel and
writes each output to `test-results/run-all/`. Tests of the official app that this repository does not contain are
named in its summary (`scripts/review/official-only.json`).

The four-phone simulation (Alice, Bob, Carol, Dave and an attacker, Mallory, against a simulated server and broker that
apply the real server's ACL and group-log code) needs Playwright with a Chromium, installed once outside the
repository:

```bash
npm install --prefix ~/.cache/aegistalk-sim playwright@1
~/.cache/aegistalk-sim/node_modules/.bin/playwright install chromium
scripts/sim/local-run.sh --playwright ~/.cache/aegistalk-sim/node_modules     # 50-60 minutes; report in test-results/sim-chat/
```

It builds the community edition from your working tree (the crypto core too, if `packages/pwa/src/wasm/pkg` is missing
or stale: Rust and wasm-pack, [packages/crypto-core/README.md](../packages/crypto-core/README.md)); `--scenarios S1,S2`
runs a few scenarios only.

# Editions — community chat vs official (open-source steps 5a–6: client boundary, tests)

The PWA builds as one of two editions from the same source tree:

| | community chat (`AEGIS_EDITION=chat`) | official (`AEGIS_EDITION=official`, default in this repo) |
|---|---|---|
| implementation of `@ext` | `src/ext/chat/` (public) | `src/ext-official/` (private, never exported) |
| anti-fraud | none: nothing scanned, no risk ever reported, no "safe" badge (`enabled: false`) | AI rule engine, trust scores, rule sync, file / voice / URL scanning, L3 behaviour analysis |
| login | `ChatAuthScreen` (5b): choose the server → create an account (PIN ×2 → name + invite code → keys-only `POST /api/account/register`), move from an old phone (device transfer) or restore an offline recovery kit; PIN via `services/pinAuth.ts`; change PIN without an account key | AegisID (face + PIN, sealed cloud blob, social recovery, change PIN) |
| server | none built in: asked on first run, changeable in Settings and on the welcome screen (5c) | the official service by default, switchable the same way |
| guardian / payments / VPN / plugin host / AegisBot status | absent | present |
| package manifest | `editions/chat/package.json` + lock (no `@aegisrd/*`, ONNX, MediaPipe, mammoth, jszip, opencc, MoonPay, Transak, Crossmint) | `package.json` (unchanged) |
| type check | `tsc -p tsconfig.chat.json` (excludes `src/ext-official`) | `tsc -b` |
| Android flavour (5d) | `chat`: "AegisTalk Chat (community)", `com.aegisrd.talk.community`, no official-only native plugins, FCM only with the builder's own `google-services.json` | `official`: `com.aegisrd.talk`, "AegisTalk" (unchanged) |

## 1. The contract (`src/ext/types.ts`)

The app reaches everything that is not chat through one object, `ext` from `'@ext'`:

- `antiFraud` — `inspectInbound(ev)` is awaited at the four places AppProvider used to scan (group-key message, chunked
  file, legacy 1-1 group message, plain 1-1 message); `ev.site` keeps each place's own rules (which types, whose score,
  logs) — see `src/ext-official/antiFraud.ts` and `scripts/review/ext_official_antifraud_self_test.mjs`. Plus
  `start` / `stop` (engine, rules, sync), `onAppResume`, `afterLogin`, `contactRisk` (add-friend warning),
  `contactRiskLevels` (avatar frames), `evaluateUrl` (message links), `text` (voice transcript check), `speech`,
  `callAnalysis`, `e2eApi`.
- `identity` — `AuthScreen` slot, `register?` (keys-only registration, wired in 5b), `backup` (`markDirty`,
  `setProviders`, `setOwnSignedPreKey`, `flushNow`, `clear`), `verifyPin`, `changePin?`, `restoreTransfer` /
  `transferExtras` (device transfer), boot hooks (`initStorage`, `bootModels`, `preloadModels`, `disposeModels`,
  `runDevHarness`), `onRecoveryShard?`, `useServiceRegistration`.
- `guardian?` (`onLegacyGroupMessage`: guardianAlert / checkIn control messages), `payments?` (`registerIdentity`,
  `onDirectControl` for `payment_*`, `onResume`), `vpn?` (`loadSettings`), `onAgentStatus?`.
- `ui` slots — hooks and components the official edition fills: `useChatShell` (wallet / shield tabs and panels,
  check-in overlay, behaviour provider, NetworkShield lifecycle), `useSettingsExtras`, `useChatRoomExtras` (L3 alerts,
  guardian notification, AegisPay), `useGroupGuardian`, `useCallRisk`, `PaymentCard`, `VoiceInput`,
  `CreateGuardianGroupModal`, `useCanCreateGuardianGroup`, `isGuardianGroup`, `useAppEffects` / `AppOverlays`
  (NetworkShield threat decisions and modal), `ProviderWrapper` (plugin host), `requestNotificationPermission`.
- `hooks` — AppProvider background services: `useGuardian`, `usePaymentSweep`, `useCheckInScheduler`.

Rules: members named `use*` are hooks that both editions provide (the chat ones call no hooks), so call sites call them
unconditionally where the official code used to run, bound to a local `useX` first so the react-hooks lint rule sees
them; public code never reads `ext` at module top level (official modules import public ones, so a top-level read could
run before `src/ext-official/index.ts` is evaluated); the official index only uses getters / wrappers for imported
components and functions. Low-level modules the extension itself imports (chatStore, groupStore, useCrypto, deviceClaim,
voiceCall) use two leaf entries instead of `@ext` — `@ext/backup` (`ext.identity.backup`) and `@ext/callAnalysis`
(`ext.antiFraud.callAnalysis`) — so the module graph keeps its pre-split shape (store → blob service, voiceCall → voice
analyzer) and gains no import cycle through the extension.

What stays public and inert in the chat edition: the scam alert modal and the red-shield event path (nothing emits
risk), avatar risk frames (only the local block list can colour one), the local domain / contact block lists, the
group-state guardian schema (`groupType`, `guardianSettings`, `sendCheckIn` — reserved; guardian control messages are
dropped), the `payment` message type and fields in the stores (shown as a plain message), the native-data cleanup hook on
logout, kick and device transfer (`services/guardianBackground.ts`: the official edition registers its guardian-data cleanup
there; the chat edition registers none). The Firebase check before push registration asks the shared `FCMTokenPlugin`.

## 2. Build selection

`vite.config.ts` resolves `@ext` from `AEGIS_EDITION` (`official` by default here; the export will default to `chat`)
and refuses `AEGIS_EDITION=chat` together with `VITE_AEGIS_EDITION=official` (the step-4 push-type switch in
`services/pushRequest.ts`). The chat build copies `public/` without the official-only files (sherpa-onnx speech models
and WASM, the call-analysis worklet, anti-fraud test audio and test page, prep-generated face / ONNX / MediaPipe files),
and `__AEGIS_EDITION__` drops the MediaPipe CDN cache rules from the chat service worker (`sw-custom.ts`; builds without
the define keep them). The chat PIN lock (5 wrong PINs) counts down on the lock screen and unlocks itself after 5 minutes
(the community edition has no face login to fall back on).
`tsconfig.json` maps `@ext` to the official index; `tsconfig.chat.json` maps it to `src/ext/chat` and excludes
`src/ext-official`. The chat manifest's `prep:chat` builds the crypto WASM and copies sql.js's `sql-wasm.wasm` into `public/`
(`scripts/copy-sqlite-wasm.mjs`; the browser SQLite loads it). `vite build` writes `dist/aegis-edition.json`
(`{"edition": …}`) for the Android check below; `capacitor.config.ts` takes appId / appName from `AEGIS_EDITION`
(`AEGIS_CHAT_APP_ID` / `AEGIS_CHAT_APP_NAME` override the chat ones).

**Android (step 5d).** `packages/pwa/android/app/build.gradle` has two product flavours (dimension `edition`):

- `official` — `com.aegisrd.talk`, "AegisTalk", exactly as before. Official-only native code lives in `app/src/official`
  (UsbDebug, AegisOnnx + onnxruntime-android, the guardian plugin, CheckInScheduler + the check-in reminder activity / alarm receiver,
  GoogleDrive + the Google API client, the MoonPay frame, the threat-warning layout), with its own manifest (check-in components,
  the official site's App Links, VPN / exact-alarm / overlay / boot permissions) and `proguard-official.pro`. Private Capacitor
  plugin modules that `cap sync` puts on `implementation` (`node_modules/@aegisrd/*`, e.g. `@aegisrd/guard` = NetworkShield) are
  moved to `officialImplementation`.
- `chat` — "AegisTalk Chat (community)", launcher label "AegisTalk Chat", `com.aegisrd.talk.community`. Self-hosters override
  them with `-PaegisChatAppId=…` / `AEGIS_CHAT_APP_ID` (never `com.aegisrd.talk`), `-PaegisChatAppName` / `AEGIS_CHAT_APP_NAME`,
  `-PaegisChatLauncherLabel` / `AEGIS_CHAT_LAUNCHER_LABEL`. `app/src/chat/.../EditionPlugins.java` registers no extra plugin; no
  guardian notification channel or guardian push types.
- Shared plugins (FCMTokenPlugin incl. the Firebase check, SharePlugin, NotificationStrings, RingContext) are registered in
  `MainActivity`; the flavour adds `EditionPlugins.all()`.
- FCM: official uses `app/google-services.json` (as before) or `app/src/official/google-services.json`; chat only
  `app/src/chat/google-services.json`. Without it the chat build has no FCM (Web Push / in-app notifications only) and never
  falls back to the official file (`processChat*GoogleServices` is disabled).
- `debug` keeps the `.debug` suffix; release builds without `key.properties` are unsigned (signing stays outside the repo).
- Build a flavour from a tree whose web assets were built for it: `AEGIS_EDITION=chat npx vite build && AEGIS_EDITION=chat npx cap
  sync android && (cd android && ./gradlew assembleChatRelease)`; official: `npx vite build && npx cap sync android &&
  (cd android && ./gradlew assembleOfficialRelease)` (APKs in `app/build/outputs/apk/<flavour>/<type>/`).

## 3. Enforcement

- ESLint `no-restricted-imports` for every file outside `src/ext-official`: `**/ext-official/**`, `@aegisrd/*`, and the
  anti-fraud / payments-only packages.
- `scripts/review/chat_edition_boundary_self_test.mjs` bundles the chat entry (esbuild, npm packages external, no
  node_modules needed) and fails on any reachable `src/ext-official` file, private / anti-fraud package (static or
  dynamic import), package missing from the chat manifest, model file or model path, or official host outside
  `scripts/review/chat_edition_host_allowlist.txt` (stale entries fail too); the official edition is bundled as a
  control (it must reach `ext-official` and `@aegisrd`).
- The 4-phone simulation runs either edition, on the build machine (`scripts/sim/remote-run.sh --edition chat`) or on this
  machine (`scripts/sim/local-run.sh`, step 6; the default there is `chat` when `src/ext-official` is absent). Both build with
  `AEGIS_EDITION=<edition>` from a node_modules link farm (chat: without the private packages), check the chat dist for
  official code and official hosts, and label the report. Which edition ran is read from the build's own marker,
  `dist/aegis-edition.json` (`scripts/sim/lib/profiles.mjs` `profileForBuild`), not from a broker URL; a build of the other
  edition than `--edition` asked for is refused (`scripts/review/sim_edition_marker_self_test.mjs`).
- Tests (step 6): `scripts/review/official-only.json` is the one list of review tests that need the official edition (with the
  paths they need); `scripts/review/run-all.mjs` (`npm test`) runs such a test only when those exist and reports it as SKIP
  otherwise. Shared tests print a `SKIP` line for an official-only part instead of failing without it. Mutants of official-only
  code live in `scripts/review/mutants_official.py`; `scripts/review/mutant_kit.py` skips them when that file or the code is
  absent.
- Android (5d): `mergeChat*Assets` / `mergeOfficial*Assets` depend on `checkChatWebAssets` / `checkOfficialWebAssets`: the
  edition marker in `src/main/assets/public/aegis-edition.json` must match the flavour, and the chat assets must hold no model /
  ONNX / MediaPipe / sherpa / anti-fraud test file and no `@aegisrd/*` entry in `capacitor.plugins.json` (Capacitor would also
  crash on a registered class that is not compiled in). The official-only Java / Kotlin sources are not in the chat source set,
  so they cannot be compiled into it.

## 4. Verification (release check 2026-11-03; earlier pass 2026-11-01)

**Release check (open-source step 9, 2026-11-03).** App code as of `5dd1ff4`; the later commits up to `fd807e8` change
tests, test runners, export tooling and docs only, and the compose run below added `af6d15f` (compose file) and
`8b47bad` (community build prep). Build Mac (macOS arm64, Node 26.12.1, Python 3.12.16) in fresh
folders deleted afterwards, and this repository's Linux VPS (Node 24.22.1, Python 3.12.13).

- **Builds (Mac).** Official tree with the private siblings linked: `tsc -b` 0 errors, `vite build` OK, dist
  389,996 KB (87 files, JS 6.74 MB, WASM 113.68 MB with the prep-fetched models). Chat tree with no private sibling
  next to it, `npm ci` from the chat lock: `tsc -p tsconfig.chat.json` 0 errors, `AEGIS_EDITION=chat vite build` OK,
  dist 6,636 KB (44 files, JS 3.05 MB, WASM 0.31 MB; 7,260 KB and 45 files once `8b47bad` added sql.js's
  652,953-byte `sql-wasm.wasm`, measured with `npm ci && npm run build` in the export), none of the official markers
  listed below (the CSP comment in
  `index.html`, which reaches `dist/`, named the official folder; reworded in `5dd1ff4`); the official dist has them
  (control). ESLint on the 87 TS/TSX files changed since `ebe249a`: 0 errors, 17 warnings; the 58 of them that existed
  at `ebe249a`: 0 errors, 17 warnings.
- **`npm test` in the author's tree (Mac):** 142 of 142 pass; `sealed_blob_unlock` skips its second part (no AegisID
  checkout with `/aegisid/unlock` on that machine). Fixed on the way (test faults, see the commit messages):
  `group_control_w2_review_fixes` (its "honest" burst was older than the same sender's earlier flood on a fast machine:
  0/24 on the Mac), `direct_seal` / `presence_secret` (short words found inside random base64), and four mqtt tests that
  relied on the official default server. `group_engine_review_fixes`, reported flaky in an earlier full run, did not
  fail in 44 runs (30 on the Mac, 10 at a time; 14 on the VPS, 6 and 8 at a time next to mutation runs); cause not found.
- **Exported snapshot** (`export-public.sh` at `fd807e8`, 570 files; `verify-export.sh --strict --mutants` on the Mac,
  no private sibling next to the copy): self-contained, links, `npm ci` (525 packages), crypto WASM build, `tsc`,
  `vite build` (6.5 MB), the 10 Python tests, `run-all` 127 of 127 (the 15 official-only tests are not in the export;
  6 shared tests skip their official part), compose file structure and call tones PASS; the mutation runners 455 of
  455 killed (8 runners; without `mutants_official.py` and the JVM ones, 22 fewer than in the author's tree);
  `crypto-repro` FAIL and the two Docker stages SKIP (below). The chat Android build from the export
  (`vite build`, `cap sync`, `assembleChatDebug`, no `src/ext-official`, no `google-services.json`) gives a
  34,988,984-byte debug APK.
- **Mutation runners in the author's tree** (with `mutants_official.py`; 0 skipped): step 3 58/58, step 4 63/63,
  step 5 60/60, step 5d 72/72 (63 JS / Python on the VPS, all 72 with the 9 JVM ones on the Mac), W2 46/46, W3 39/39,
  W4 77/77, W5 62/62. The W2 and W3 runners had been broken since step 5c (their copy of `src` could not resolve
  `@ext/server`; W2, which had no baseline check, reported a false 46/46); fixed, and the one real W2 survivor found
  then is killed by a stronger test.
- **4-phone + Mallory simulation** at `5dd1ff4`: official edition with `remote-run.sh` (the bash `prepare.sh` under
  macOS bash 3.2) and community edition with `local-run.sh` (registration through `ChatAuthScreen` with invite codes),
  each 26 scenarios incl. G1 (group-call fingerprints) and R1 (ring tokens) and 6 audits PASS, 250 checks, 0 failed.
- **Android (Mac).** `assembleChatDebug` / `assembleChatRelease` in a tree with no private sibling and no
  `google-services.json`, `assembleOfficialDebug` with the private packages linked: chat release (unsigned)
  27,228,107 bytes, chat debug 34,990,952, official debug 242,187,232 (built before `8b47bad`, which adds the
  `sql-wasm.wasm` above to the chat web assets). `aapt dump badging`: `com.aegisrd.talk.community`
  (`.debug`), label "AegisTalk Chat (community)", launcher "AegisTalk Chat", minSdk 24, target 34. The chat APKs hold
  none of the official-only classes (the debug APK's `EditionPlugins` is the chat flavour's own class), no ONNX runtime,
  no Drive API, no model file, no `@aegisrd` asset, 16 Capacitor plugins, edition marker `chat`; no APK contains
  `CLAUDE.md`. `testChatDebugUnitTest` (RingTokenTest) 10/10. `chatReleaseRuntimeClasspath`: Capacitor modules only.
- **Compose stack** (`scripts/selfhost/conformance.sh` at `8b47bad`, on this repository's Linux VPS: Docker 29.4.1,
  Compose 5.1.3, EMQX 5.8.9; the browsers in the official Playwright 1.62.1 image on the host network, because the host
  lacks Chromium's libraries): A1 `selfhost_smoke.py` direct 34/34, A2 `two_browsers_e2e.mjs` 12/12 (incl. "no request
  to any other host" for both users), B1 proxy guard 403 / 403 / 401, B2 `selfhost_smoke.py` behind the proxy 34/34;
  the stack, its volumes and network and the pulled images removed afterwards. The first Docker runs found two bugs,
  fixed before this run: the api start command split into two shell commands (`af6d15f`, the api container restarted
  forever) and the community `npm run build` left out the browser SQLite's `sql-wasm.wasm` (`8b47bad`, the web app
  stopped at account setup). **Crypto WASM:** `build.sh --verify` passes on Linux x86_64 only; the Mac build differs
  already in rustc's output (`packages/crypto-core/README.md`, "Reproducibility")

**Earlier pass (2026-11-01, steps 5a–5d):**

- **Mac, fresh folders, deleted afterwards.** Official tree with the private siblings linked: `tsc -b` 0 errors,
  `vite build` OK. Chat tree with no `../../../AegisAI` etc. next to it, `npm ci` from the chat lock (525 packages,
  no `@aegisrd`): `tsc -p tsconfig.chat.json` 0 errors, `AEGIS_EDITION=chat vite build` OK.
  - dist: official 104,628 KB (JS 6.22 MB, WASM 27.0 MB, 77 files); chat 8,080 KB (JS 2.95 MB, WASM 0.31 MB,
    47 files). The chat dist has none of `@aegisrd/`, `ext-official`, `onnxruntime`, `mediapipe`, `auraface`,
    `crossmint`, `transak`, `opencc`, `mammoth`, `NetworkShield` or the official-only markers
    (`aegisid-pin-verifier-v1`, `AEGIS_FACEENGINE_HARNESS`, `[DIAG:GRISK] GK L2 eval`), no official-only public file,
    no MediaPipe rule in `sw-custom.js`; the official dist has all of them (control). The official domain remained in the chat
    `index.html` CSP and the API-base defaults (removed in 5c); `moonpay` only in the CSP.
  - ESLint on the 134 changed files: 4 errors / 20 warnings — the same 4 pre-existing errors as the same files at
    `91aad7e` (2 `jsx-a11y/media-has-caption` rule not loaded, 2 `no-constant-binary-expression` in `GroupList`) and
    the same warning count; a probe file importing `ext-official` and `@aegisrd/aegisid` is refused (2 errors).
- **`scripts/review`**: 119 of 120 pass; the one failure, `sealed_blob_unlock` (Python), needs an AegisID checkout with
  `/aegisid/unlock` (pre-existing, fails the same at `91aad7e`). Repointed (same assertions, new places): see the commit
  messages of `ea316fa` and `ec137f7`. New: `chat_edition_boundary`, `pin_auth`, `ext_official_antifraud`.
- **Mutation runs** (each mutant removes one protection in a copy): step 3 58/58, step 4 63/63, W5 62/62, W2 46/46,
  W3 39/39, W4 77/77 killed (in the full W4 run one mutant's test crashed under load instead of failing an assertion;
  rerun alone it was killed by the assertion).
- **4-phone + Mallory simulation**, official edition at `aad2a8d` and chat edition at `df59b7f` (the later commits only
  touch the chat sim / chat build): each 24 scenarios and 6 audits PASS, 218 checks, 0 failed (SETUP, D1, C1–C3,
  S1–S14, LATE, P1, P2, T1; BROKER-ACL 0/0, API-AUTH no rejections and 52 signed pushes without names, LEAK 57 group-topic
  and 696 inbox publishes, 837 non-group topics, 0 findings; GROUP-TOPICS, PRESENCE, NETWORK-GUARD PASS).
- **Independent review** of the diff: 2 HIGH (chat sim leak check aborted the run; chat PIN lock never expired),
  4 MEDIUM (import cycle growth, PIN test without a fixed answer, ChatRoom effect order, comment), LOW items — all fixed in
  `aad2a8d` / `f46be0e` (see that commit message).

## 5. Steps 5b–6, and what is left

- **5b** — done (2026-11-02): `ChatAuthScreen` replaced the 5a PIN-only screen (server → welcome: create account / move
  from my old phone / restore from recovery kit → PIN ×2 → name + invite code → `POST /api/account/register` signed by the
  identity key, `ext/chat/registration.ts`; the PIN is written only after the server accepted the account);
  `identity.register` wired. Recovery kit (`services/recoveryKit.ts`): blob v2 from the public `services/identityBlob.ts`
  (keys, friends, groups with their signed chains, own signed pre-key) plus the server, AES-256-GCM under Argon2id
  (64 MiB, t = 3, p = 4) of a generated (125 bits) or chosen (16+ characters, ~72 bits) passphrase; exported from Settings,
  restored on the auth screen (`ext/chat/kitRestore.ts`). Chat `changePin` re-encrypts with a journal under both PIN keys
  (no AegisID account key). The device-transfer payload carries face / behaviour data only through
  `identity.transferExtras` (none in the chat edition). Tests: `recovery_kit`, `account_register`, `chat_identity`,
  `pin_auth`; mutants: `step5_mutants.py` (41).
- **5c** — done (2026-11-02): the server is chosen at runtime (`services/serverChoice.ts`, `apiBase.ts`, `serverSwitch.ts`,
  ported from AegisTrans): no default in the chat edition, `src/ext-official/official-server.json` in the official one;
  `components/Settings/ServerSettings.tsx` in Settings and on the welcome screens; `ServerMismatchScreen` when the account on
  the phone belongs to another server (switch back, or wipe it and start a new account). `index.html` carries the community
  CSP and `services/connectPolicy.ts` narrows `connect-src` to the chosen server; `chat_edition_host_allowlist.txt` is empty
  and the boundary test requires it. Web Push subscribes only after the permission prompt was granted, with the chosen
  server's VAPID key. Tests: `server_switch`, `push_permission`, `chat_edition_boundary`.
- **5d** — done (2026-11-02): Android chat / official flavours (above), plus the two step-4 call leftovers: the
  caller-signed ring token for pushes and the DTLS fingerprint check for group calls (`docs/DIRECT_SEALED.md` §4).
  The face engine plugin has no Android part (iOS only), so there was nothing to move. Mutants: `step5d_mutants.py` (69; the
  Kotlin ones need a built Android project, `--no-jvm` leaves them out).
- **6** — written (2026-11-02), tests and simulator portable:
  - one entry point, `scripts/review/run-all.mjs` (`npm test` at the root and in `packages/pwa`): environment check (Node,
    `npm ci`, Python packages from `scripts/review/requirements-test.txt`), parallel runs with a timeout, logs in
    `test-results/run-all/`, `--mutants` for the mutation runners; official-only tests listed in
    `scripts/review/official-only.json` (§3);
  - shared tests run without the official edition: the official parts of `chat_edition_boundary` (control bundle),
    `chat_identity`, `visible_types`, `guardian_logout` and `group_log_api` (the `api/main.py` wiring; the standalone
    `api/chat_app.py` wiring is checked instead) print `SKIP`; `key_quarantine`, `shared_safety` and `w5_review_fixes` are
    split into a shared test and a `*_official` one; the mutation runners use `mutant_kit.py` (Python from
    `AEGISTALK_PYTHON`, a copy that tolerates missing files and links `node_modules`, official mutants from
    `mutants_official.py`);
  - the simulator: `scripts/sim/local-run.sh` (this machine; `prepare.sh` is bash now), the edition from
    `dist/aegis-edition.json`, and `server_acl.py` takes even the token request's field list from `api/chat/mqtt_auth.py`
    (`MQTT_TOKEN_REQUEST_FIELDS`), so the simulator keeps no copy of the server's rules;
  - `scripts/selfhost/conformance.sh`: `docker-compose.example.yml` brought up, `selfhost_smoke.py` and
    `two_browsers_e2e.mjs` against it, the reverse-proxy settings checked, torn down
    (`docs/SELF_HOSTING.md` "Check your server");
  - `src/main/assets/CLAUDE.md` no longer goes into the APKs (`ignoreAssetsPattern`).
  Verified in the step-9 release check (§4, 2026-11-03).
- **Left** — the chat flavour still uses the AegisTalk launcher icon (the name / logo are not licensed, `TRADEMARKS.md` —
  the export or a self-hoster replaces `res/mipmap-*`); unify `pushRequest.appEdition()` with the `@ext` edition once the
  official server accepts the guardian push types (step 10).
- **Export (step 7)** — exclude `src/ext-official`, the official-only `public/` files above, the tests listed in
  `scripts/review/official-only.json` and `scripts/review/mutants_official.py` (the shared parts of `key_quarantine`,
  `shared_safety`, `w5_review_fixes` and the `step3` / `step4` / `w5` mutation runners carry no official code any more and
  can be published), `scripts/sim/remote-run.sh` / `mac-job.sh` (the author's build machine); swap in
  `editions/chat/package.json` + lock, default `AEGIS_EDITION=chat` (vite.config.ts and capacitor.config.ts, which both
  read it; 5d), keep only the `chat` flavour's sources (`android/app/src/official` and `proguard-official.pro` stay
  private) and the committed `capacitor.settings.gradle` / `capacitor.build.gradle` regenerated by `cap sync` in a chat tree.

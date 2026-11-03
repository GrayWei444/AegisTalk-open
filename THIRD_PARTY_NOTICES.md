# Third-Party Notices — AegisTalk Chat

AegisTalk Chat is released under the MIT License (see `LICENSE`). It uses the third-party components listed below,
each under its own license. The full license texts of npm packages and Rust crates ship inside each package
(`node_modules/<name>/LICENSE*`, or the crate source on crates.io); Apache-2.0 `NOTICE` files, where a package has
one, ship the same way.

Last checked: npm table 2026-11-03, regenerated from the chat edition's lock (`packages/pwa/package-lock.json` in
this repository): the same 214 packages, versions and licenses as before. `packages/crypto-core/Cargo.lock` and the
`api/requirements-*.txt` files: 2026-11-01.

---

## 1. Code and assets in this repository that come from elsewhere

### 1.1 Inline SVG icon paths

Several components draw icons as inline SVG. Their path data matches two open-source icon sets (identified by
comparing the paths; no package is installed for them):

- **Lucide** — `packages/pwa/src/components/common/icons.tsx` (trash, copy, forward, share, flame, search,
  paperclip, mic, audio-lines, mic-off). ISC License (Lucide Contributors; portions MIT, from Feather by Cole Bemis).
  Upstream and license text: https://github.com/lucide-icons/lucide
- **Heroicons** (v1 outline style) — many components under `packages/pwa/src/components` (for example the close,
  back, check and phone icons). MIT License (Tailwind Labs). Upstream and license text:
  https://github.com/tailwindlabs/heroicons

<!-- OWNER/STEP 9: confirm these two origins (and the exact copyright lines) before release; if confirmed, keep this section, otherwise replace the icons. -->

### 1.2 Call sounds — not third-party

`packages/pwa/public/sounds/{ringtone,ringback,connect,hangup}.wav` are synthesized tones written by
`scripts/sounds/generate_call_tones.py` in this repository (deterministic; `--check` verifies the files). They contain
no third-party material and are covered by this repository's MIT License. Earlier sound files of unrecorded origin
were replaced before the first public release.

<!-- MERGE: the generated sounds are on branch oss/call-tones (84932c2); this section assumes that branch is merged. -->

### 1.3 Encryption core and chat interface — not third-party

`packages/crypto-core` (Rust crate `safetalk-core`; its `Cargo.toml` declares MIT) was imported from the `rust-core`
crate of the author's own earlier, archived project, from which the chat user interface also comes; see
`packages/crypto-core/README.md` ("Provenance"). Both are covered by this repository's MIT License. The crate's
third-party crates are listed in §4.

### 1.4 Name and logo

The AegisTalk name and logo (`aegistalk_logo.png`, `packages/pwa/public/logo-*.png`, `favicon.png` and the Android
launcher icons) are not licensed under the MIT License; see "Trademarks" in `README.md`.

---

## 2. Server side (installed by the operator, not shipped in this repository)

The chat server's Python packages are installed from PyPI by whoever runs the server (`api/requirements-chat.txt`
and the optional files). The versions are those the server was tested with; licenses as declared in each package's
metadata.

| Package | Tested version | License | Needed for |
|---|---|---|---|
| `fastapi` | 0.115.0 | MIT | API |
| `uvicorn[standard]` | 0.31.0 | BSD-3-Clause | ASGI server |
| `pydantic` | 2.9.0 | MIT | request models |
| `PyJWT` | 2.15.1 | MIT | MQTT tokens |
| `cryptography` | 50.0.2 | Apache-2.0 OR BSD-3-Clause | Ed25519 signatures, VAPID key checks |
| `paho-mqtt` | 2.1.0 | EPL-2.0 OR EDL-1.0 (declared as `EPL-2.0 OR BSD-3-Clause`; the EDL is a BSD-3-Clause license) | the server's own "device replaced" notices |
| `pywebpush` (optional) | 2.5.0 | MPL-2.0 | Web Push (`requirements-webpush.txt`) |
| `py-vapid` (optional, via `pywebpush`) | 1.9.6 | MPL-2.0 | Web Push |
| `http-ece` (optional, via `pywebpush`) | 1.2.1 | MIT | Web Push |
| `firebase-admin` (optional) | 7.7.0 | Apache-2.0 | FCM (`requirements-fcm.txt`) |

Their own dependencies (Starlette, AnyIO, pydantic-core, requests, aiohttp, Google client libraries, …) are
installed by pip under their own licenses.

**MPL-2.0 note.** `pywebpush` and `py-vapid` are used unmodified, as separately installed packages; nothing from them
is copied into this repository. MPL-2.0 is a file-level copyleft: if you distribute modified versions of *their*
files, those files must stay under MPL-2.0. Your own code is not affected.

**EPL-2.0 / EDL-1.0 note.** `paho-mqtt` is dual-licensed; you may use it under the Eclipse Distribution License 1.0
(BSD-3-Clause).

### 2.1 Broker and container images

| Component | Version | License | Note |
|---|---|---|---|
| EMQX (`emqx/emqx`) | 5.8.9 | Apache-2.0 | pinned on purpose: EMQX 5.9.0 and later are under the Business Source License 1.1 (`docs/SELF_HOSTING.md`, "EMQX version and license") |
| `python` image | 3.12.14-slim-bookworm | Python Software Foundation License; Debian packages under their own licenses | `docker-compose.example.yml` (`api`) |
| Caddy (`caddy` image) | 2.10.2-alpine | Apache-2.0 | optional static web server and the reverse proxy in the guide |

None of these are redistributed by this repository: `docker compose` or the operator downloads them.

---

## 3. Android app (native libraries)

The Android shell (`packages/pwa/android`) is built with Gradle in two flavours (`docs/EDITIONS.md` §2); this list is the
community flavour `chat` (checked against its Gradle dependencies and the built APK, 2026-11-02). Besides Capacitor and its
plugins (MIT, listed in §4) the app module declares:

| Component | Version | License | Note |
|---|---|---|---|
| AndroidX `appcompat`, `coordinatorlayout`, `core-splashscreen`, `biometric` | see `variables.gradle` / `app/build.gradle` | Apache-2.0 | |
| Kotlin standard library | 2.1.0 | Apache-2.0 | |
| Google Tink for Android (`com.google.crypto.tink:tink-android`) | 1.8.0 | Apache-2.0 | Ed25519 check of the caller-signed ring token (`RingToken.kt`); the same version `@capacitor-community/sqlite` already brings in through `androidx.security:security-crypto` |
| Firebase Cloud Messaging (Firebase BoM 33.7.0) | | Apache-2.0 (the Firebase Android SDK); it depends on Google Play services client libraries, distributed under the Android Software Development Kit License, not an open-source license | in the APK because `@capacitor/push-notifications` depends on it; never initialised without your own `app/src/chat/google-services.json` |

Native libraries in the community APK come from Capacitor plugins' dependencies: `libsqlcipher.so` (SQLCipher Community Edition,
`net.zetetic:sqlcipher-android`, BSD-style license; `@capacitor-community/sqlite`) and `libdatastore_shared_counter.so` (AndroidX
DataStore, Apache-2.0). Transitively the app also contains AndroidX libraries and `kotlinx-coroutines` (Apache-2.0).
Unit tests only (not shipped): JUnit 4.13.2 (EPL-1.0), `org.json:json` 20240303 (public domain).

Not in the community flavour (official app only): ONNX Runtime for Android, Google Play services Auth and the Google API client
/ Drive libraries, and the private first-party Android modules.

---

## 4. Bundled packages

Generated from the lock files on the date above (npm: production dependency closure of the chat edition's direct
dependencies, including optional platform-specific packages that npm installs only on matching systems; Rust: the
crates compiled into the WebAssembly core for `wasm32-unknown-unknown`, normal dependencies only).

Build tools whose code ends up in the web bundle are MIT-licensed and not repeated in the table: Vite 5.4.21 (module
preload helper), Tailwind CSS 3.4.19 (its base styles), and Workbox 7.4.0 (`workbox-precaching`, `workbox-routing`,
`workbox-strategies`, `workbox-expiration`, `workbox-window`, compiled into the service worker).

### Web / mobile app (`packages/pwa`, chat edition, production dependencies) — 214 packages

Direct dependencies (32): `@capacitor-community/sqlite`, `@capacitor/android`, `@capacitor/app`, `@capacitor/browser`, `@capacitor/camera`, `@capacitor/cli`, `@capacitor/core`, `@capacitor/device`, `@capacitor/filesystem`, `@capacitor/haptics`, `@capacitor/ios`, `@capacitor/keyboard`, `@capacitor/local-notifications`, `@capacitor/network`, `@capacitor/push-notifications`, `@capacitor/share`, `@capacitor/splash-screen`, `@capacitor/status-bar`, `@capawesome-team/capacitor-file-opener`, `capacitor-native-biometric`, `hash-wasm`, `html5-qrcode`, `idb`, `jeep-sqlite`, `jsqr`, `mqtt`, `pdfjs-dist`, `qrcode`, `react`, `react-dom`, `sql.js`, `zustand`.

Left out because only the official edition uses them: the private first-party packages, the on-device AI / vision runtimes (`onnxruntime-web`, `@mediapipe/tasks-vision`), the document and text converters of the anti-fraud scanner (`mammoth`, `opencc-js`, and `jszip` as a direct dependency) and the payment SDKs (`@crossmint/*`, `@moonpay/*`, `@transak/*`). `jszip` still appears below as a dependency of `jeep-sqlite`.

Licenses: MIT (172), ISC (22), BlueOak-1.0.0 (9), Apache-2.0 (6), (MIT AND Zlib) (1), (MIT OR GPL-3.0-or-later) (1), 0BSD (1), BSD-3-Clause (1), Unlicense (1)

| Package | Version | License | Note |
|---|---|---|---|
| [`@babel/runtime`](https://www.npmjs.com/package/@babel/runtime) | 7.28.4 | MIT |  |
| [`@capacitor-community/sqlite`](https://www.npmjs.com/package/@capacitor-community/sqlite) | 8.0.0 | MIT |  |
| [`@capacitor/android`](https://www.npmjs.com/package/@capacitor/android) | 8.0.1 | MIT |  |
| [`@capacitor/app`](https://www.npmjs.com/package/@capacitor/app) | 8.0.0 | MIT |  |
| [`@capacitor/browser`](https://www.npmjs.com/package/@capacitor/browser) | 8.0.0 | MIT |  |
| [`@capacitor/camera`](https://www.npmjs.com/package/@capacitor/camera) | 8.0.0 | MIT |  |
| [`@capacitor/cli`](https://www.npmjs.com/package/@capacitor/cli) | 7.5.0 | MIT |  |
| [`@capacitor/core`](https://www.npmjs.com/package/@capacitor/core) | 3.9.0 | MIT |  |
| [`@capacitor/core`](https://www.npmjs.com/package/@capacitor/core) | 8.0.1 | MIT |  |
| [`@capacitor/device`](https://www.npmjs.com/package/@capacitor/device) | 8.0.0 | MIT |  |
| [`@capacitor/filesystem`](https://www.npmjs.com/package/@capacitor/filesystem) | 8.0.0 | MIT |  |
| [`@capacitor/haptics`](https://www.npmjs.com/package/@capacitor/haptics) | 8.0.0 | MIT |  |
| [`@capacitor/ios`](https://www.npmjs.com/package/@capacitor/ios) | 8.0.1 | MIT |  |
| [`@capacitor/keyboard`](https://www.npmjs.com/package/@capacitor/keyboard) | 8.0.0 | MIT |  |
| [`@capacitor/local-notifications`](https://www.npmjs.com/package/@capacitor/local-notifications) | 8.0.0 | MIT |  |
| [`@capacitor/network`](https://www.npmjs.com/package/@capacitor/network) | 8.0.1 | MIT |  |
| [`@capacitor/push-notifications`](https://www.npmjs.com/package/@capacitor/push-notifications) | 8.0.0 | MIT |  |
| [`@capacitor/share`](https://www.npmjs.com/package/@capacitor/share) | 8.0.0 | MIT |  |
| [`@capacitor/splash-screen`](https://www.npmjs.com/package/@capacitor/splash-screen) | 8.0.0 | MIT |  |
| [`@capacitor/status-bar`](https://www.npmjs.com/package/@capacitor/status-bar) | 8.0.0 | MIT |  |
| [`@capacitor/synapse`](https://www.npmjs.com/package/@capacitor/synapse) | 1.0.4 | ISC |  |
| [`@capawesome-team/capacitor-file-opener`](https://www.npmjs.com/package/@capawesome-team/capacitor-file-opener) | 8.0.1 | MIT |  |
| [`@ionic/cli-framework-output`](https://www.npmjs.com/package/@ionic/cli-framework-output) | 2.2.8 | MIT |  |
| [`@ionic/utils-array`](https://www.npmjs.com/package/@ionic/utils-array) | 2.1.6 | MIT |  |
| [`@ionic/utils-fs`](https://www.npmjs.com/package/@ionic/utils-fs) | 3.1.7 | MIT |  |
| [`@ionic/utils-object`](https://www.npmjs.com/package/@ionic/utils-object) | 2.1.6 | MIT |  |
| [`@ionic/utils-process`](https://www.npmjs.com/package/@ionic/utils-process) | 2.1.12 | MIT |  |
| [`@ionic/utils-stream`](https://www.npmjs.com/package/@ionic/utils-stream) | 3.1.7 | MIT |  |
| [`@ionic/utils-subprocess`](https://www.npmjs.com/package/@ionic/utils-subprocess) | 3.0.1 | MIT |  |
| [`@ionic/utils-terminal`](https://www.npmjs.com/package/@ionic/utils-terminal) | 2.3.5 | MIT |  |
| [`@isaacs/balanced-match`](https://www.npmjs.com/package/@isaacs/balanced-match) | 4.0.1 | MIT |  |
| [`@isaacs/brace-expansion`](https://www.npmjs.com/package/@isaacs/brace-expansion) | 5.0.1 | MIT |  |
| [`@isaacs/fs-minipass`](https://www.npmjs.com/package/@isaacs/fs-minipass) | 4.0.1 | ISC |  |
| [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-android-arm64`](https://www.npmjs.com/package/@napi-rs/canvas-android-arm64) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-darwin-arm64`](https://www.npmjs.com/package/@napi-rs/canvas-darwin-arm64) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-darwin-x64`](https://www.npmjs.com/package/@napi-rs/canvas-darwin-x64) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-arm-gnueabihf`](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm-gnueabihf) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-arm64-gnu`](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-gnu) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-arm64-musl`](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-musl) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-riscv64-gnu`](https://www.npmjs.com/package/@napi-rs/canvas-linux-riscv64-gnu) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-x64-gnu`](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-gnu) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-linux-x64-musl`](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-musl) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-win32-arm64-msvc`](https://www.npmjs.com/package/@napi-rs/canvas-win32-arm64-msvc) | 0.1.88 | MIT | optional, platform-specific |
| [`@napi-rs/canvas-win32-x64-msvc`](https://www.npmjs.com/package/@napi-rs/canvas-win32-x64-msvc) | 0.1.88 | MIT | optional, platform-specific |
| [`@rollup/rollup-darwin-arm64`](https://www.npmjs.com/package/@rollup/rollup-darwin-arm64) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-darwin-x64`](https://www.npmjs.com/package/@rollup/rollup-darwin-x64) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-linux-arm64-gnu`](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-gnu) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-linux-arm64-musl`](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-musl) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-linux-x64-gnu`](https://www.npmjs.com/package/@rollup/rollup-linux-x64-gnu) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-linux-x64-musl`](https://www.npmjs.com/package/@rollup/rollup-linux-x64-musl) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-win32-arm64-msvc`](https://www.npmjs.com/package/@rollup/rollup-win32-arm64-msvc) | 4.34.9 | MIT | optional, platform-specific |
| [`@rollup/rollup-win32-x64-msvc`](https://www.npmjs.com/package/@rollup/rollup-win32-x64-msvc) | 4.34.9 | MIT | optional, platform-specific |
| [`@stencil/core`](https://www.npmjs.com/package/@stencil/core) | 4.42.1 | MIT |  |
| [`@types/fs-extra`](https://www.npmjs.com/package/@types/fs-extra) | 8.1.5 | MIT |  |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | 20.19.29 | MIT |  |
| [`@types/readable-stream`](https://www.npmjs.com/package/@types/readable-stream) | 4.0.23 | MIT |  |
| [`@types/slice-ansi`](https://www.npmjs.com/package/@types/slice-ansi) | 4.0.0 | MIT |  |
| [`@types/ws`](https://www.npmjs.com/package/@types/ws) | 8.18.1 | MIT |  |
| [`@xmldom/xmldom`](https://www.npmjs.com/package/@xmldom/xmldom) | 0.8.11 | MIT |  |
| [`abort-controller`](https://www.npmjs.com/package/abort-controller) | 3.0.0 | MIT |  |
| [`ansi-regex`](https://www.npmjs.com/package/ansi-regex) | 5.0.1 | MIT |  |
| [`ansi-styles`](https://www.npmjs.com/package/ansi-styles) | 4.3.0 | MIT |  |
| [`astral-regex`](https://www.npmjs.com/package/astral-regex) | 2.0.0 | MIT |  |
| [`at-least-node`](https://www.npmjs.com/package/at-least-node) | 1.0.0 | ISC |  |
| [`base64-js`](https://www.npmjs.com/package/base64-js) | 1.5.1 | MIT |  |
| [`big-integer`](https://www.npmjs.com/package/big-integer) | 1.6.52 | Unlicense |  |
| [`bl`](https://www.npmjs.com/package/bl) | 6.1.6 | MIT |  |
| [`bplist-parser`](https://www.npmjs.com/package/bplist-parser) | 0.3.2 | MIT |  |
| [`broker-factory`](https://www.npmjs.com/package/broker-factory) | 3.1.11 | MIT |  |
| [`browser-fs-access`](https://www.npmjs.com/package/browser-fs-access) | 0.35.0 | Apache-2.0 |  |
| [`buffer`](https://www.npmjs.com/package/buffer) | 6.0.3 | MIT |  |
| [`buffer-crc32`](https://www.npmjs.com/package/buffer-crc32) | 0.2.13 | MIT |  |
| [`buffer-from`](https://www.npmjs.com/package/buffer-from) | 1.1.2 | MIT |  |
| [`camelcase`](https://www.npmjs.com/package/camelcase) | 5.3.1 | MIT |  |
| [`capacitor-native-biometric`](https://www.npmjs.com/package/capacitor-native-biometric) | 4.2.2 | MIT |  |
| [`chownr`](https://www.npmjs.com/package/chownr) | 3.0.0 | BlueOak-1.0.0 |  |
| [`cliui`](https://www.npmjs.com/package/cliui) | 6.0.0 | ISC |  |
| [`color-convert`](https://www.npmjs.com/package/color-convert) | 2.0.1 | MIT |  |
| [`color-name`](https://www.npmjs.com/package/color-name) | 1.1.4 | MIT |  |
| [`commander`](https://www.npmjs.com/package/commander) | 12.1.0 | MIT |  |
| [`commist`](https://www.npmjs.com/package/commist) | 3.2.0 | MIT |  |
| [`concat-stream`](https://www.npmjs.com/package/concat-stream) | 2.0.0 | MIT |  |
| [`core-util-is`](https://www.npmjs.com/package/core-util-is) | 1.0.3 | MIT |  |
| [`cross-spawn`](https://www.npmjs.com/package/cross-spawn) | 7.0.6 | MIT |  |
| [`debug`](https://www.npmjs.com/package/debug) | 4.4.3 | MIT |  |
| [`decamelize`](https://www.npmjs.com/package/decamelize) | 1.2.0 | MIT |  |
| [`define-lazy-prop`](https://www.npmjs.com/package/define-lazy-prop) | 2.0.0 | MIT |  |
| [`dijkstrajs`](https://www.npmjs.com/package/dijkstrajs) | 1.0.3 | MIT |  |
| [`elementtree`](https://www.npmjs.com/package/elementtree) | 0.1.7 | Apache-2.0 |  |
| [`emoji-regex`](https://www.npmjs.com/package/emoji-regex) | 8.0.0 | MIT |  |
| [`env-paths`](https://www.npmjs.com/package/env-paths) | 2.2.1 | MIT |  |
| [`event-target-shim`](https://www.npmjs.com/package/event-target-shim) | 5.0.1 | MIT |  |
| [`events`](https://www.npmjs.com/package/events) | 3.3.0 | MIT |  |
| [`fast-unique-numbers`](https://www.npmjs.com/package/fast-unique-numbers) | 9.0.24 | MIT |  |
| [`fd-slicer`](https://www.npmjs.com/package/fd-slicer) | 1.1.0 | MIT |  |
| [`find-up`](https://www.npmjs.com/package/find-up) | 4.1.0 | MIT |  |
| [`fs-extra`](https://www.npmjs.com/package/fs-extra) | 9.1.0 | MIT |  |
| [`fs-extra`](https://www.npmjs.com/package/fs-extra) | 11.3.3 | MIT |  |
| [`get-caller-file`](https://www.npmjs.com/package/get-caller-file) | 2.0.5 | ISC |  |
| [`glob`](https://www.npmjs.com/package/glob) | 13.0.0 | BlueOak-1.0.0 |  |
| [`graceful-fs`](https://www.npmjs.com/package/graceful-fs) | 4.2.11 | ISC |  |
| [`hash-wasm`](https://www.npmjs.com/package/hash-wasm) | 4.12.0 | MIT |  |
| [`help-me`](https://www.npmjs.com/package/help-me) | 5.0.0 | MIT |  |
| [`html5-qrcode`](https://www.npmjs.com/package/html5-qrcode) | 2.3.8 | Apache-2.0 |  |
| [`idb`](https://www.npmjs.com/package/idb) | 7.1.1 | ISC |  |
| [`ieee754`](https://www.npmjs.com/package/ieee754) | 1.2.1 | BSD-3-Clause |  |
| [`immediate`](https://www.npmjs.com/package/immediate) | 3.0.6 | MIT |  |
| [`inherits`](https://www.npmjs.com/package/inherits) | 2.0.4 | ISC |  |
| [`ini`](https://www.npmjs.com/package/ini) | 4.1.3 | ISC |  |
| [`ip-address`](https://www.npmjs.com/package/ip-address) | 10.1.0 | MIT |  |
| [`is-docker`](https://www.npmjs.com/package/is-docker) | 2.2.1 | MIT |  |
| [`is-fullwidth-code-point`](https://www.npmjs.com/package/is-fullwidth-code-point) | 3.0.0 | MIT |  |
| [`is-wsl`](https://www.npmjs.com/package/is-wsl) | 2.2.0 | MIT |  |
| [`isarray`](https://www.npmjs.com/package/isarray) | 1.0.0 | MIT |  |
| [`isexe`](https://www.npmjs.com/package/isexe) | 2.0.0 | ISC |  |
| [`jeep-sqlite`](https://www.npmjs.com/package/jeep-sqlite) | 2.8.0 | MIT |  |
| [`js-sdsl`](https://www.npmjs.com/package/js-sdsl) | 4.3.0 | MIT |  |
| [`js-tokens`](https://www.npmjs.com/package/js-tokens) | 4.0.0 | MIT |  |
| [`jsonfile`](https://www.npmjs.com/package/jsonfile) | 6.2.0 | MIT |  |
| [`jsqr`](https://www.npmjs.com/package/jsqr) | 1.4.0 | Apache-2.0 |  |
| [`jszip`](https://www.npmjs.com/package/jszip) | 3.10.1 | (MIT OR GPL-3.0-or-later) | dual-licensed; used under MIT (dependency of `jeep-sqlite`) |
| [`kleur`](https://www.npmjs.com/package/kleur) | 3.0.3 | MIT |  |
| [`kleur`](https://www.npmjs.com/package/kleur) | 4.1.5 | MIT |  |
| [`lie`](https://www.npmjs.com/package/lie) | 3.1.1 | MIT |  |
| [`lie`](https://www.npmjs.com/package/lie) | 3.3.0 | MIT |  |
| [`localforage`](https://www.npmjs.com/package/localforage) | 1.10.0 | Apache-2.0 |  |
| [`locate-path`](https://www.npmjs.com/package/locate-path) | 5.0.0 | MIT |  |
| [`loose-envify`](https://www.npmjs.com/package/loose-envify) | 1.4.0 | MIT |  |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache) | 10.4.3 | ISC |  |
| [`lru-cache`](https://www.npmjs.com/package/lru-cache) | 11.2.4 | BlueOak-1.0.0 |  |
| [`minimatch`](https://www.npmjs.com/package/minimatch) | 10.1.1 | BlueOak-1.0.0 |  |
| [`minimist`](https://www.npmjs.com/package/minimist) | 1.2.8 | MIT |  |
| [`minipass`](https://www.npmjs.com/package/minipass) | 7.1.2 | ISC |  |
| [`minizlib`](https://www.npmjs.com/package/minizlib) | 3.1.0 | MIT |  |
| [`mqtt`](https://www.npmjs.com/package/mqtt) | 5.14.1 | MIT |  |
| [`mqtt-packet`](https://www.npmjs.com/package/mqtt-packet) | 9.0.2 | MIT |  |
| [`ms`](https://www.npmjs.com/package/ms) | 2.1.3 | MIT |  |
| [`native-run`](https://www.npmjs.com/package/native-run) | 2.0.3 | MIT |  |
| [`number-allocator`](https://www.npmjs.com/package/number-allocator) | 1.0.14 | MIT |  |
| [`open`](https://www.npmjs.com/package/open) | 8.4.2 | MIT |  |
| [`p-limit`](https://www.npmjs.com/package/p-limit) | 2.3.0 | MIT |  |
| [`p-locate`](https://www.npmjs.com/package/p-locate) | 4.1.0 | MIT |  |
| [`p-try`](https://www.npmjs.com/package/p-try) | 2.2.0 | MIT |  |
| [`package-json-from-dist`](https://www.npmjs.com/package/package-json-from-dist) | 1.0.1 | BlueOak-1.0.0 |  |
| [`pako`](https://www.npmjs.com/package/pako) | 1.0.11 | (MIT AND Zlib) | dependency of `jszip` |
| [`path-exists`](https://www.npmjs.com/package/path-exists) | 4.0.0 | MIT |  |
| [`path-key`](https://www.npmjs.com/package/path-key) | 3.1.1 | MIT |  |
| [`path-scurry`](https://www.npmjs.com/package/path-scurry) | 2.0.1 | BlueOak-1.0.0 |  |
| [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) | 5.4.530 | Apache-2.0 |  |
| [`pend`](https://www.npmjs.com/package/pend) | 1.2.0 | MIT |  |
| [`plist`](https://www.npmjs.com/package/plist) | 3.1.0 | MIT |  |
| [`pngjs`](https://www.npmjs.com/package/pngjs) | 5.0.0 | MIT |  |
| [`process`](https://www.npmjs.com/package/process) | 0.11.10 | MIT |  |
| [`process-nextick-args`](https://www.npmjs.com/package/process-nextick-args) | 2.0.1 | MIT |  |
| [`prompts`](https://www.npmjs.com/package/prompts) | 2.4.2 | MIT |  |
| [`qrcode`](https://www.npmjs.com/package/qrcode) | 1.5.4 | MIT |  |
| [`react`](https://www.npmjs.com/package/react) | 18.3.1 | MIT |  |
| [`react-dom`](https://www.npmjs.com/package/react-dom) | 18.3.1 | MIT |  |
| [`readable-stream`](https://www.npmjs.com/package/readable-stream) | 2.3.8 | MIT |  |
| [`readable-stream`](https://www.npmjs.com/package/readable-stream) | 3.6.2 | MIT |  |
| [`readable-stream`](https://www.npmjs.com/package/readable-stream) | 4.7.0 | MIT |  |
| [`require-directory`](https://www.npmjs.com/package/require-directory) | 2.1.1 | MIT |  |
| [`require-main-filename`](https://www.npmjs.com/package/require-main-filename) | 2.0.0 | ISC |  |
| [`rfdc`](https://www.npmjs.com/package/rfdc) | 1.4.1 | MIT |  |
| [`rimraf`](https://www.npmjs.com/package/rimraf) | 6.1.2 | BlueOak-1.0.0 |  |
| [`safe-buffer`](https://www.npmjs.com/package/safe-buffer) | 5.1.2 | MIT |  |
| [`safe-buffer`](https://www.npmjs.com/package/safe-buffer) | 5.2.1 | MIT |  |
| [`sax`](https://www.npmjs.com/package/sax) | 1.1.4 | ISC |  |
| [`scheduler`](https://www.npmjs.com/package/scheduler) | 0.23.2 | MIT |  |
| [`semver`](https://www.npmjs.com/package/semver) | 7.7.3 | ISC |  |
| [`set-blocking`](https://www.npmjs.com/package/set-blocking) | 2.0.0 | ISC |  |
| [`setimmediate`](https://www.npmjs.com/package/setimmediate) | 1.0.5 | MIT |  |
| [`shebang-command`](https://www.npmjs.com/package/shebang-command) | 2.0.0 | MIT |  |
| [`shebang-regex`](https://www.npmjs.com/package/shebang-regex) | 3.0.0 | MIT |  |
| [`signal-exit`](https://www.npmjs.com/package/signal-exit) | 3.0.7 | ISC |  |
| [`sisteransi`](https://www.npmjs.com/package/sisteransi) | 1.0.5 | MIT |  |
| [`slice-ansi`](https://www.npmjs.com/package/slice-ansi) | 4.0.0 | MIT |  |
| [`smart-buffer`](https://www.npmjs.com/package/smart-buffer) | 4.2.0 | MIT |  |
| [`socks`](https://www.npmjs.com/package/socks) | 2.8.7 | MIT |  |
| [`split2`](https://www.npmjs.com/package/split2) | 4.2.0 | ISC |  |
| [`sql.js`](https://www.npmjs.com/package/sql.js) | 1.11.0 | MIT |  |
| [`string_decoder`](https://www.npmjs.com/package/string_decoder) | 1.1.1 | MIT |  |
| [`string_decoder`](https://www.npmjs.com/package/string_decoder) | 1.3.0 | MIT |  |
| [`string-width`](https://www.npmjs.com/package/string-width) | 4.2.3 | MIT |  |
| [`strip-ansi`](https://www.npmjs.com/package/strip-ansi) | 6.0.1 | MIT |  |
| [`tar`](https://www.npmjs.com/package/tar) | 7.5.7 | BlueOak-1.0.0 |  |
| [`through2`](https://www.npmjs.com/package/through2) | 4.0.2 | MIT |  |
| [`tree-kill`](https://www.npmjs.com/package/tree-kill) | 1.2.2 | MIT |  |
| [`tslib`](https://www.npmjs.com/package/tslib) | 2.8.1 | 0BSD |  |
| [`typedarray`](https://www.npmjs.com/package/typedarray) | 0.0.6 | MIT |  |
| [`undici-types`](https://www.npmjs.com/package/undici-types) | 6.21.0 | MIT |  |
| [`universalify`](https://www.npmjs.com/package/universalify) | 2.0.1 | MIT |  |
| [`untildify`](https://www.npmjs.com/package/untildify) | 4.0.0 | MIT |  |
| [`use-sync-external-store`](https://www.npmjs.com/package/use-sync-external-store) | 1.6.0 | MIT |  |
| [`util-deprecate`](https://www.npmjs.com/package/util-deprecate) | 1.0.2 | MIT |  |
| [`which`](https://www.npmjs.com/package/which) | 2.0.2 | ISC |  |
| [`which-module`](https://www.npmjs.com/package/which-module) | 2.0.1 | ISC |  |
| [`worker-factory`](https://www.npmjs.com/package/worker-factory) | 7.0.46 | MIT |  |
| [`worker-timers`](https://www.npmjs.com/package/worker-timers) | 8.0.27 | MIT |  |
| [`worker-timers-broker`](https://www.npmjs.com/package/worker-timers-broker) | 8.0.13 | MIT |  |
| [`worker-timers-worker`](https://www.npmjs.com/package/worker-timers-worker) | 9.0.11 | MIT |  |
| [`wrap-ansi`](https://www.npmjs.com/package/wrap-ansi) | 6.2.0 | MIT |  |
| [`wrap-ansi`](https://www.npmjs.com/package/wrap-ansi) | 7.0.0 | MIT |  |
| [`ws`](https://www.npmjs.com/package/ws) | 8.19.0 | MIT |  |
| [`xml2js`](https://www.npmjs.com/package/xml2js) | 0.6.2 | MIT |  |
| [`xmlbuilder`](https://www.npmjs.com/package/xmlbuilder) | 11.0.1 | MIT |  |
| [`xmlbuilder`](https://www.npmjs.com/package/xmlbuilder) | 15.1.1 | MIT |  |
| [`y18n`](https://www.npmjs.com/package/y18n) | 4.0.3 | ISC |  |
| [`yallist`](https://www.npmjs.com/package/yallist) | 5.0.0 | BlueOak-1.0.0 |  |
| [`yargs`](https://www.npmjs.com/package/yargs) | 15.4.1 | MIT |  |
| [`yargs-parser`](https://www.npmjs.com/package/yargs-parser) | 18.1.3 | ISC |  |
| [`yauzl`](https://www.npmjs.com/package/yauzl) | 2.10.0 | MIT |  |
| [`zustand`](https://www.npmjs.com/package/zustand) | 4.5.7 | MIT |  |

### Encryption core (`packages/crypto-core`, Rust crates compiled into the WASM) — 68 crates

Licenses: MIT OR Apache-2.0 (40), Apache-2.0 OR MIT (16), BSD-3-Clause (4), MIT (3), (MIT OR Apache-2.0) AND Unicode-3.0 (1), Apache-2.0 OR BSL-1.0 (1), Apache-2.0/MIT (1), BSD-2-Clause OR Apache-2.0 OR MIT (1), Unlicense OR MIT (1)

| Crate | Version | License | Source |
|---|---|---|---|
| `aead` | 0.5.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `aes` | 0.8.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| `aes-gcm` | 0.10.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| `base64` | 0.21.7 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `base64ct` | 1.8.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `bincode` | 1.3.3 | MIT | https://github.com/servo/bincode |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `bumpalo` | 3.19.0 | MIT OR Apache-2.0 | https://github.com/fitzgen/bumpalo |
| `cfg-if` | 1.0.4 | MIT OR Apache-2.0 | https://github.com/rust-lang/cfg-if |
| `chacha20` | 0.9.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/stream-ciphers |
| `chacha20poly1305` | 0.10.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs/tree/master/chacha20poly1305 |
| `cipher` | 0.4.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `console_error_panic_hook` | 0.1.7 | Apache-2.0/MIT | https://github.com/rustwasm/console_error_panic_hook |
| `const-oid` | 0.9.6 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/const-oid |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `ctr` | 0.9.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| `curve25519-dalek` | 4.1.3 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| `der` | 0.7.10 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/der |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `ed25519` | 2.2.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures/tree/master/ed25519 |
| `ed25519-dalek` | 2.2.0 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| `generic-array` | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| `getrandom` | 0.2.16 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| `ghash` | 0.5.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `hkdf` | 0.12.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/KDFs/ |
| `hmac` | 0.12.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| `inout` | 0.1.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `itoa` | 1.0.15 | MIT OR Apache-2.0 | https://github.com/dtolnay/itoa |
| `js-sys` | 0.3.83 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| `memchr` | 2.7.6 | Unlicense OR MIT | https://github.com/BurntSushi/memchr |
| `once_cell` | 1.21.3 | MIT OR Apache-2.0 | https://github.com/matklad/once_cell |
| `opaque-debug` | 0.3.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| `pkcs8` | 0.10.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/pkcs8 |
| `poly1305` | 0.8.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `polyval` | 0.6.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| `ppv-lite86` | 0.2.21 | MIT OR Apache-2.0 | https://github.com/cryptocorrosion/cryptocorrosion |
| `proc-macro2` | 1.0.103 | MIT OR Apache-2.0 | https://github.com/dtolnay/proc-macro2 |
| `quote` | 1.0.42 | MIT OR Apache-2.0 | https://github.com/dtolnay/quote |
| `rand` | 0.8.5 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `rand_chacha` | 0.3.1 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `rand_core` | 0.6.4 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| `ryu` | 1.0.20 | Apache-2.0 OR BSL-1.0 | https://github.com/dtolnay/ryu |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_core` | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_derive` (build-time macro) | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | 1.0.145 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `serde-wasm-bindgen` | 0.6.5 | MIT | https://github.com/RReverser/serde-wasm-bindgen |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `signature` | 2.2.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits/tree/master/signature |
| `spki` | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/spki |
| `subtle` | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| `syn` | 2.0.111 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| `thiserror` | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `thiserror-impl` (build-time macro) | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `typenum` | 1.19.0 | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| `unicode-ident` | 1.0.22 | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| `universal-hash` | 0.5.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| `uuid` | 1.19.0 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `wasm-bindgen` | 0.2.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen |
| `wasm-bindgen-futures` | 0.4.56 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| `wasm-bindgen-macro` (build-time macro) | 0.2.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| `wasm-bindgen-macro-support` | 0.2.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| `wasm-bindgen-shared` | 0.2.106 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| `web-sys` | 0.3.83 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| `x25519-dalek` | 2.0.1 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/x25519-dalek |
| `zerocopy` | 0.8.31 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| `zeroize` | 1.8.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `zeroize_derive` (build-time macro) | 1.4.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils/tree/master/zeroize/derive |
---

## Maintenance rule

Any new vendored, forked or adapted third-party code or asset must be added to this file in the same commit, with its
upstream license text kept next to it (`LICENSE.upstream`). Regenerate §4 whenever `package-lock.json` or
`Cargo.lock` changes. New third-party code must use a license that fits an MIT project (MIT, BSD, ISC, Apache-2.0,
0BSD, Zlib, BlueOak-1.0.0, Unlicense); ask the maintainers before adding anything else.

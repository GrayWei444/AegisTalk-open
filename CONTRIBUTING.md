# Contributing

Thanks for your interest in AegisTalk Chat. Issues and pull requests are welcome. Please open an issue to discuss a
larger change before sending it, and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License of contributions and sign-off

AegisTalk Chat is MIT-licensed ([LICENSE](LICENSE)); contributions are accepted under the same license.

Every commit must be signed off with `git commit -s`, which adds a line like
`Signed-off-by: Your Name <you@example.com>`. You may use your GitHub no-reply address. By signing off you certify
the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or otherwise have
the right to submit it under this project's MIT license. Pull requests with commits that are not signed off are not
merged.

## Development setup

- Node.js 20 or newer and npm.
- For the encryption core: `rustup` (the pinned toolchain in `packages/crypto-core/rust-toolchain.toml` installs
  itself), `wasm-pack` 0.13.1 and a C linker — see [packages/crypto-core/README.md](packages/crypto-core/README.md).
- For the chat server: Python 3.12 (`api/requirements-chat.txt`; Web Push needs Python ≥ 3.10).
- For the tests: the same Python with `scripts/review/requirements-test.txt` (the server's packages, Web Push, httpx).
- For the Android app: Android Studio or the Android SDK with Gradle.

```bash
cd packages/pwa
npm ci
npm run dev              # builds the crypto core from source first if it is missing
npm run type-check && npm run lint && npm run build
npm run android:build    # then: cd android && ./gradlew assembleChatDebug (the community flavour; docs/EDITIONS.md §2)
```

A local server for development: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) (the server accepts a `ws://` broker URL
and `http://` app origins for `localhost` only).

## Checks

Run the review suite before opening a pull request (it needs `npm ci` in packages/pwa and a Python with
`scripts/review/requirements-test.txt`; it says what is missing):

```bash
python3 -m venv .venv && .venv/bin/pip install -r scripts/review/requirements-test.txt   # once
npm test -- --python .venv/bin/python                    # every scripts/review test, in parallel
npm test -- --python .venv/bin/python --only <name>,...  # just some (e.g. --only group_log,py:chat_app)
```

`scripts/review/run-all.mjs` writes each test's output to `test-results/run-all/` and ends with a summary. A few tests
belong to the official app and are not in this repository; the summary names them, and a shared test that has an
official-only part prints a `SKIP` line for it. Neither counts as a failure.

Security-relevant code (sealing, signatures, the group log, the broker ACL, push) is also covered by the mutation
runners (`scripts/review/*_mutants.py`; each mutant removes one protection in a copy of the repository and a test has to
fail on an assertion) and by the four-phone simulator. If you change such code, run them and make sure every mutant is
still caught and every scenario and audit passes:

```bash
npm test -- --python .venv/bin/python --mutants-only            # or one runner: .venv/bin/python scripts/review/step4_mutants.py
scripts/sim/local-run.sh --playwright <a node_modules folder with playwright>   # 50-60 minutes; report in test-results/sim-chat/
```

For changes to the server, the broker policy or the compose example, also run the self-host checks: against a server of
your own, `python3 scripts/selfhost/selfhost_smoke.py --api http://127.0.0.1:8000 --invite <code>`; the whole compose
stack, `scripts/selfhost/conformance.sh`. How to install Playwright for the simulator and the browser check:
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#running-the-tests).

## Guidelines

- Keep changes small and focused; add or update a test in `scripts/review/` for every behaviour change.
- Keep `scripts/sim/` and `scripts/review/` together: the mutation runners copy `scripts`, `api`, `packages/pwa/src`
  and the Android sources.
- Never commit secrets, real e-mail addresses, addresses of real deployments or build-machine details.
- Nothing may put message content, names or group identifiers on the broker in plaintext; the simulator's LEAK,
  GROUP-TOPICS and PRESENCE audits must stay at 0 findings.
- The risk-warning components in the app are display-only in this edition: the anti-fraud detection that feeds them
  is not part of this repository.
- New third-party code or assets must use a license that fits an MIT project (MIT, BSD, ISC, Apache-2.0, 0BSD, Zlib,
  BlueOak-1.0.0, Unlicense) and be added to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the same commit.
- Commit messages: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).

## Name and logo

Contributing does not change the rules for the AegisTalk and 安心說 names and the logo: the MIT License covers the
code only. See [TRADEMARKS.md](TRADEMARKS.md).

# crypto-core — AegisTalk end-to-end encryption core

Rust crate `safetalk-core` (X3DH, Double Ratchet, AES-256-GCM, Ed25519, HKDF),
compiled to WebAssembly with `wasm-bindgen`. The PWA imports the generated
module from `packages/pwa/src/wasm/pkg/safetalk_core.js`
(see `packages/pwa/src/services/crypto.ts`). `src/wasm/` is a build product and
is not tracked; it is always built from this source.

## Build

Requirements:

- `rustup` — `rust-toolchain.toml` pins rustc **1.90.0** and the
  `wasm32-unknown-unknown` target; rustup installs both on first use.
- `wasm-pack` **0.13.1** — `cargo install wasm-pack --version 0.13.1 --locked`.
  It downloads the matching `wasm-bindgen` CLI (0.2.106, from `Cargo.lock`)
  and binaryen `wasm-opt` version_117.
- A host C linker for build scripts / proc-macros
  (Linux: `build-essential`; macOS: Xcode Command Line Tools).

```bash
packages/crypto-core/build.sh            # build into packages/crypto-core/target/pkg
packages/crypto-core/build.sh --verify   # build and compare with REPRODUCIBLE*.sha256
packages/crypto-core/build.sh --install  # build and copy into packages/pwa/src/wasm/pkg
```

`npm run build` / `npm run dev` in `packages/pwa` run `scripts/ensure-crypto-wasm.mjs`
first: when `src/wasm/pkg` is missing or incomplete, was built from a different
version of this source, or any of its five files was replaced (the stamp
`src/wasm/pkg/.crypto-core-source.json` records the SHA-256 of `Cargo.toml`,
`Cargo.lock`, `rust-toolchain.toml`, `build.sh` and `src/`, and of each installed
file), it calls `build.sh --install`. `npm run build:crypto` forces a rebuild.

## Reproducibility

`build.sh` passes `--locked` and remaps `$CARGO_HOME` and this directory to fixed
prefixes (`/cargo`, `/crypto-core`), because dependency source paths end up in
panic messages inside the `.wasm`. With the pinned toolchain, lockfile and
wasm-pack version the output does not depend on user name or checkout location.
`REPRODUCIBLE.sha256` lists the expected hashes of the JS glue, type definitions
and `package.json`. wasm-bindgen 0.2.106 emits two imports (`__wbindgen_cast_*`)
in a nondeterministic order, so the `.wasm` comes out as one of two byte-for-byte
variants of identical size; both are listed in `REPRODUCIBLE-wasm.sha256`.

The crate is byte-identical to `packages/crypto-core` in the AegisTrans
repository (same source, `Cargo.toml`, `Cargo.lock` and toolchain), so both
repositories list the same expected hashes.

The hashes were measured on Linux x86_64 (the same values come out on the
AegisTalk and AegisTrans build machines). A macOS arm64 build with the same
rustc 1.90.0, wasm-pack 0.13.1, wasm-bindgen 0.2.106 and wasm-opt version_117
(2026-10-26) produced identical JS glue, type definitions and `package.json`,
but a different `.wasm` (305,659 bytes; the code and function sections differ,
and its locally built wasm-bindgen CLI writes no git hash into the producers
section). Build release binaries on Linux, or add a macOS variant to
`REPRODUCIBLE-wasm.sha256` only after explaining the difference.

Re-checked 2026-11-03: on Linux x86_64 (rustc 1.90.0, wasm-pack 0.13.1)
`build.sh --verify` reproduced the listed hash (`28a9f0e0…`). On macOS arm64 with
the same rustc and wasm-pack 0.13.1 the `.wasm` was again the 305,659-byte file
(`bfdcb737…`), and the difference is already in rustc's own output, before
wasm-bindgen and wasm-opt run (`target/wasm32-unknown-unknown/release/safetalk_core.wasm`:
`2e2e1558…` on Linux, `267764a6…` on macOS; the remapped source paths are the
same on both). So it comes from the compiler on the two host platforms, not from
wasm-pack's tools, and it is not explained yet. The hashes in
`REPRODUCIBLE-wasm.sha256` are for Linux x86_64 only; on macOS arm64
`build.sh --verify` fails on the `.wasm` (the JS glue, type definitions and
`package.json` still match). A wasm-pack other than 0.13.1 (for example a
Homebrew 0.15.0) changes the output too; `build.sh` warns about it.

## Provenance

The source came from the original `rust-core` crate (archived `mist`
repository) and was imported here on 2026-08-03. That repository's
`Cargo.lock` is not available, so `Cargo.lock` was regenerated with every
dependency pinned to the newest release published before 2025-12-13
(wasm-bindgen family pinned to 0.2.106).

## Tests

`cargo test --locked` runs the crate's unit tests on the host. 9 of 10 pass;
`aes::tests::test_aes_with_aad` fails on non-wasm targets only, because its
expected error path constructs a `JsError` (wasm-bindgen imports cannot be
called outside WebAssembly).

The crate does not log key material (debug `console.log` calls printing
shared secrets, DH outputs, chain keys and key prefixes removed 2026-10-26,
same change as AegisTrans 2026-10-18).

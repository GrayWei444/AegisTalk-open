/**
 * Chat edition boundary (open-source step 5a): bundle the community edition from its entry and fail if anything
 * private is reachable.
 *
 *   node scripts/review/chat_edition_boundary_self_test.mjs
 *
 * esbuild bundles the chat edition's entries — src/main.tsx, the group-invite worker (vite follows `new Worker(new URL(…))`,
 * esbuild does not) and the service worker src/sw-custom.ts (built separately by vite-plugin-pwa) — with '@ext' →
 * src/ext/chat (what vite does for AEGIS_EDITION=chat).
 * npm packages are not bundled (marked external and recorded), so this runs without node_modules or the private
 * sibling packages. Fails when the chat entry reaches:
 *   1. src/ext-official/** (the private implementation)
 *   2. @aegisrd/* or a private / anti-fraud-only npm package (ONNX, MediaPipe, mammoth, jszip, opencc, MoonPay,
 *      Transak, Crossmint, viem) — static or dynamic import
 *   3. a package the official manifest declares but packages/pwa/editions/chat/package.json does not (the chat manifest
 *      must be complete; packages neither manifest declares — transitive ones like workbox-expiration — are listed)
 *   4. a model file (import of .onnx / .task / .tflite / .bin / .data / .ort) or a model path in the source
 *      (x.onnx / x.task / x.tflite, /models/, mediapipe-models, auraface, face_landmarker)
 *   5. a reached file outside packages/pwa/src
 *   6. an official host (the official domain or the official server address, OFFICIAL_HOST below) in a reached source file or index.html that is not on the allowlist
 *      (scripts/review/chat_edition_host_allowlist.txt — same idea as the export scan's official-host allowlist);
 *      stale allowlist entries (file gone, not reachable, or no host left) fail too, so the list only shrinks.
 *      Since the server switch (step 5c) the list must be EMPTY: the community edition has no default server and names no
 *      official host anywhere.
 *   7. an official host in the bundled chat output itself (what esbuild emits for the three entries — the strings a dist
 *      would contain), and the official edition's default-server leaf (src/ext-official/server.ts, official-server.json)
 *      reached from the chat entry.
 * Then it bundles the official edition the same way as a control: it must reach ext-official and @aegisrd (the
 * checks above are not vacuous), and the chat edition must not depend on any file the official one lacks.
 * In the public repository (no src/ext-official, and packages/pwa/package.json is the chat manifest because the export
 * moved editions/chat/package.json there) the chat checks run against that manifest and the control is reported as SKIP.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = new URL('../../', import.meta.url).pathname;
const pwa = path.join(root, 'packages/pwa');
const require = createRequire(path.join(pwa, 'package.json'));
const esbuild = require('esbuild');

const SRC = path.join(pwa, 'src');
const ALIAS = {
  '@/': 'src/', '@components/': 'src/components/', '@config/': 'src/config/', '@hooks/': 'src/hooks/',
  '@services/': 'src/services/', '@stores/': 'src/stores/', '@types/': 'src/types/', '@utils/': 'src/utils/',
  '@plugins/': 'src/plugins/', '@wasm/': 'src/wasm/',
};
const PRIVATE_PKG = /^(@aegisrd\/|onnxruntime-web|onnxruntime-common|@mediapipe\/|mammoth$|jszip$|opencc-js|@moonpay\/|@transak\/|@crossmint\/|viem(\/|$))/;
const MODEL_IMPORT = /\.(onnx|task|tflite|bin|data|ort)(\?.*)?$/i;
const MODEL_TEXT = /[\w-]+\.(onnx|task|tflite)\b|\/models\/|mediapipe-models|auraface|face_landmarker/i;
const OFFICIAL_HOST = /aegisrd\.com|31\.97\.71\.140/i;
/** Model references allowed in a reached source only behind the edition guard (dropped from the chat build by the define). */
const MODEL_GUARDED = { 'src/sw-custom.ts': /if \(!\(typeof __AEGIS_EDITION__ !== 'undefined' && __AEGIS_EDITION__ === 'chat'\)\) \{\s*registerRoute\([\s\S]*?mediapipe[\s\S]*?mediapipe-models[\s\S]*?\n\}\n/ };

const depsOf = (file) => { const m = JSON.parse(fs.readFileSync(path.join(pwa, file), 'utf8')); return new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]); };
/** the public repository has one manifest (the chat one, as packages/pwa/package.json) and no official edition */
const ONE_MANIFEST = !fs.existsSync(path.join(pwa, 'editions/chat/package.json'));
const HAS_OFFICIAL = fs.existsSync(path.join(SRC, 'ext-official'));
const chatDeps = depsOf(ONE_MANIFEST ? 'package.json' : 'editions/chat/package.json');
const officialDeps = ONE_MANIFEST ? new Set() : depsOf('package.json');
const ENTRIES = ['main.tsx', 'services/groupInviteWorker.ts', 'sw-custom.ts'];
const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const allowFile = path.join(root, 'scripts/review/chat_edition_host_allowlist.txt');
const allowlist = fs.readFileSync(allowFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);

async function bundle(edition) {
  const extDir = path.join(SRC, edition === 'chat' ? 'ext/chat' : 'ext-official');
  const packages = new Map();   // package spec → importer
  const plugin = { name: 'edition', setup(b) {
    // '@ext' → the edition's index; '@ext/backup', '@ext/callAnalysis' → its leaf entries (same as vite.config.ts)
    b.onResolve({ filter: /^@ext(\/[\w]+)?$/ }, (a) => ({ path: resolveFile(path.join(extDir, a.path === '@ext' ? 'index' : a.path.slice(5))) }));
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === 'entry-point') return null;
      const spec = a.path;
      if (spec.startsWith('.') || spec.startsWith('/')) return null;
      for (const [k, v] of Object.entries(ALIAS)) {
        if (spec.startsWith(k)) return { path: resolveFile(path.join(pwa, v, spec.slice(k.length))) };
      }
      if (!packages.has(spec)) packages.set(spec, path.relative(pwa, a.importer));
      return { path: spec, external: true };
    });
    // the WASM glue (generated, not in git) and CSS are not part of the boundary
    b.onResolve({ filter: /wasm\/pkg\/|\.css$/ }, (a) => ({ path: a.path, external: true }));
  } };
  const res = await esbuild.build({
    entryPoints: ENTRIES.map((e) => path.join(SRC, e)), bundle: true, write: false, metafile: true, format: 'esm',
    // the chat entry imports official-server.json nowhere; the official one does (its default server)
    loader: { '.json': 'json' },
    platform: 'browser', outdir: path.join(os.tmpdir(), 'edition-boundary'), logLevel: 'silent',
    loader: { '.png': 'empty', '.svg': 'empty', '.webp': 'empty', '.wav': 'empty', '.mp3': 'empty' },
    define: { 'import.meta.env': '{}', __BUILD_HASH__: '"boundary"' }, jsx: 'automatic', plugins: [plugin], splitting: true,
  });
  const inputs = Object.keys(res.metafile.inputs).map((p) => path.relative(pwa, path.resolve(process.cwd(), p)));
  const output = res.outputFiles.map((f) => f.text).join('\n');
  return { inputs, packages, output };
}

function resolveFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return base;
}

const failures = [];
const fail = (msg) => failures.push(msg);

const chat = await bundle('chat');
const official = HAS_OFFICIAL ? await bundle('official') : null;
const srcInputs = chat.inputs.filter((p) => p.startsWith('src/'));
const isSource = (p) => p.startsWith('src/');

// 1. no private implementation
for (const p of chat.inputs) if (p.includes('ext-official')) fail(`chat edition reaches ${p}`);
// 2./3. packages
const undeclared = new Set();
for (const [spec, importer] of chat.packages) {
  const name = pkgName(spec);
  if (PRIVATE_PKG.test(spec)) fail(`chat edition imports private package ${spec} (from ${importer})`);
  else if (spec.startsWith('node:') || chatDeps.has(name)) continue;
  else if (officialDeps.has(name)) fail(`chat edition imports ${spec} (from ${importer}) — in package.json but not in editions/chat/package.json`);
  else undeclared.add(name);
}
// 5. nothing outside the app source (the wasm glue and CSS are external)
for (const p of chat.inputs) if (!p.startsWith('src/') && !p.includes('<define:')) fail(`chat edition reaches a file outside packages/pwa/src: ${p}`);
// 4./5. model files and official hosts in the reachable sources
for (const p of chat.inputs) if (MODEL_IMPORT.test(p)) fail(`chat edition imports a model file: ${p}`);
const hostFiles = new Set();
for (const p of [...srcInputs, 'index.html'].filter((p) => isSource(p) || p === 'index.html')) {
  const text = fs.readFileSync(path.join(pwa, p), 'utf8');
  const guarded = MODEL_GUARDED[p] ? text.replace(MODEL_GUARDED[p], '') : text;
  if (MODEL_GUARDED[p] && guarded === text) fail(`${p}: the edition guard around its model cache rules is gone`);
  const model = guarded.match(MODEL_TEXT);
  if (model) fail(`chat edition source ${p} refers to a model (${model[0]})`);
  if (OFFICIAL_HOST.test(text)) {
    hostFiles.add(`packages/pwa/${p}`);
    if (!allowlist.includes(`packages/pwa/${p}`)) fail(`official host in ${p} (not on chat_edition_host_allowlist.txt)`);
  }
}
for (const entry of allowlist) {
  if (!hostFiles.has(entry)) fail(`stale allowlist entry ${entry} (missing, not reachable from the chat entry, or no official host left) — remove it`);
}
// 6b. since step 5c the list is empty: nothing reachable from the chat entry may name an official host
if (allowlist.length) fail(`chat_edition_host_allowlist.txt must be empty since the server switch (step 5c), has ${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'}`);
// 7. the bundled chat output (= what the dist ships) names no official host; the official default server is not reached
const outHost = chat.output.match(OFFICIAL_HOST);
if (outHost) fail(`the bundled chat edition contains an official host (${outHost[0]})`);
for (const p of chat.inputs) if (/ext-official\/(server\.ts|official-server\.json|csp\.json)$/.test(p)) fail(`chat edition reaches the official default server ${p}`);
// control: the official edition does reach the private parts, and contains everything the chat one does
if (official) {
  if (!official.inputs.some((p) => p.includes('src/ext-official/'))) fail('control: official edition does not reach src/ext-official');
  if (![...official.packages.keys()].some((s) => s.startsWith('@aegisrd/'))) fail('control: official edition imports no @aegisrd package');
  if (!official.inputs.includes('src/ext-official/official-server.json')) fail('control: official edition does not reach its default server (official-server.json)');
  if (!OFFICIAL_HOST.test(official.output)) fail('control: the official bundle names no official host (the output scan would be vacuous)');
  const officialSet = new Set(official.inputs);
  for (const p of srcInputs) {
    if (!officialSet.has(p) && !p.startsWith('src/ext/chat/') && p !== 'src/services/pinAuth.ts') {
      fail(`chat edition reaches ${p}, which the official edition does not use`);
    }
  }
}

console.log(`chat edition: ${srcInputs.length} source files, ${chat.packages.size} package imports (manifest ${ONE_MANIFEST ? 'package.json' : 'editions/chat/package.json'}); `
  + (official ? `official: ${official.inputs.filter((p) => p.startsWith('src/')).length} source files, ${official.packages.size} package imports` : 'official: not in this checkout'));
console.log(`official hosts in chat sources + index.html: ${[...hostFiles].length}; in the bundled chat output: ${outHost ? 'yes' : 'none'}`);
if (undeclared.size) console.log(`note: packages declared in neither manifest (transitive, pre-existing): ${[...undeclared].join(', ')}`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n${failures.length} boundary check(s) FAILED`);
  process.exit(1);
}
console.log('PASS chat edition (app, invite worker, service worker): no ext-official, no @aegisrd / private package, chat manifest complete, nothing outside src, no model file, no official host in any reached source, index.html or the bundled output (allowlist empty)');
if (official) console.log('PASS control: the official edition reaches ext-official and @aegisrd; the chat edition uses no source the official one lacks (except src/ext/chat and pinAuth)');
else console.log('SKIP control (official edition): src/ext-official is not in this checkout, so the official bundle that shows these checks are not vacuous was not built');

#!/usr/bin/env node
/**
 * One entry point for the review suite (open-source step 6): every scripts/review/*_self_test.mjs and *_self_test.py,
 * and with --mutants the mutation runners (*_mutants.py).
 *
 *   node scripts/review/run-all.mjs [--js | --py] [--only <name,...>] [--jobs N] [--timeout SECONDS]
 *                                   [--python PATH] [--mutants | --mutants-only] [--list] [--logs DIR]
 *   npm test                         (in packages/pwa or at the repository root; `npm test -- --js` passes options on)
 *
 * Before anything runs it checks the environment and stops with exit code 2 and the command to fix it:
 *   - Node.js 20 or newer, and `npm ci` done in packages/pwa (the tests bundle app code with its esbuild);
 *   - a Python 3.10+ with scripts/review/requirements-test.txt (fastapi, pydantic, PyJWT, cryptography, httpx) when a
 *     selected test needs it: every *_self_test.py, and the .mjs tests that drive the Python routers ($AEGISTALK_PYTHON).
 *     Pick the interpreter with --python or AEGISTALK_PYTHON (default python3).
 *
 * Official edition. Tests that need code the public repository does not have (src/ext-official, the official server
 * api/main.py, an AegisID checkout) are listed in scripts/review/official-only.json with what they need. A listed test
 * runs only when all of it exists; otherwise it is SKIP with the missing path. Listed tests whose file is not in this
 * checkout (the public repository leaves them out) are named once in the summary. A shared test with an official-only
 * part prints a line starting with "SKIP" for that part; the summary lists those lines. A test that prints only SKIP
 * lines and exits 0 (for example the Web Push test without pywebpush) counts as SKIP, not PASS.
 *
 * Every test's output goes to --logs (default test-results/run-all/<test>.log). Tests run in parallel (--jobs, default
 * min(4, CPUs - 1)); each one has --timeout seconds (default 1200). --mutants runs the mutation runners afterwards, one
 * at a time (they take long and print as they go); --mutants-only runs only them.
 *
 * Exit code: 0 when everything that ran passed, 1 when something failed or timed out, 2 when the environment is not ready.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REVIEW = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(REVIEW, '../..');
const PWA = path.join(ROOT, 'packages/pwa');
const OFFICIAL_LIST = path.join(REVIEW, 'official-only.json');
const PY_REQUIRED = ['fastapi', 'pydantic', 'jwt', 'cryptography', 'httpx'];
const PY_OPTIONAL = { pywebpush: 'the Web Push tests skip without it', argon2: 'pin_auth skips its Argon2 cross-check' };
const rel = (p) => path.relative(process.cwd(), p) || '.';

// ───────── options ─────────
function parseArgs(argv) {
  const o = { js: true, py: true, only: null, jobs: Math.max(1, Math.min(4, os.cpus().length - 1)), timeout: 1200,
    python: process.env.AEGISTALK_PYTHON || 'python3', tests: true, mutants: false, list: false,
    logs: path.join(ROOT, 'test-results/run-all') };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) usage(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--js') o.py = false;
    else if (a === '--py') o.js = false;
    else if (a === '--only') { o.only = value(i, a).split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--jobs') { o.jobs = positiveInt(value(i, a), a); i++; }
    else if (a === '--timeout') { o.timeout = positiveInt(value(i, a), a); i++; }
    else if (a === '--python') { o.python = value(i, a); i++; }
    else if (a === '--logs') { o.logs = path.resolve(value(i, a)); i++; }
    else if (a === '--mutants') o.mutants = true;
    else if (a === '--mutants-only') { o.mutants = true; o.tests = false; }
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown option ${a}`);
  }
  if (!o.js && !o.py) usage('--js and --py together select nothing');
  // a path (not a bare command name): absolute, since the tests run from the repository root and spawn it from there
  if (o.python.includes(path.sep)) o.python = path.resolve(o.python);
  return o;
}

function positiveInt(s, flag) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) usage(`${flag} wants a positive whole number, got ${s}`);
  return n;
}

function usage(problem) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const head = text.slice(text.indexOf('/**') + 3, text.indexOf('*/')).replace(/^ \* ?/gm, '').trim();
  if (problem) console.error(`run-all: ${problem}\n`);
  console.error(head);
  process.exit(problem ? 2 : 0);
}

// ───────── what to run ─────────
function loadOfficialList() {
  if (!fs.existsSync(OFFICIAL_LIST)) {
    console.log(`note: ${rel(OFFICIAL_LIST)} not found — every test is treated as a shared one`);
    return { tests: {}, mutants: {} };
  }
  const data = JSON.parse(fs.readFileSync(OFFICIAL_LIST, 'utf8'));
  return { tests: data.tests ?? {}, mutants: data.mutants ?? {} };
}

/** a need: "a | b" (any one), "$VAR" (the path in that variable), "~/x" (home), otherwise relative to the repository root */
function needMet(need) {
  for (const alt of need.split('|').map((s) => s.trim()).filter(Boolean)) {
    let p = alt;
    if (p.startsWith('$')) {
      p = process.env[p.slice(1)] || '';
      if (!p) continue;
    } else if (p.startsWith('~/')) {
      p = path.join(os.homedir(), p.slice(2));
    } else {
      p = path.resolve(ROOT, p);
    }
    if (fs.existsSync(p)) return true;
  }
  return false;
}

const baseName = (file) => file.replace(/_(self_test|mutants)\.(mjs|py)$/, '');
function selectedByOnly(file, only) {
  if (!only) return true;
  const short = baseName(file);
  return only.some((o) => o === file || o === short || o === `py:${short}` || o === file.replace(/\.(mjs|py)$/, ''));
}

function plan(opts, official) {
  const files = fs.readdirSync(REVIEW).sort();
  const tests = [];
  const skipped = [];
  const absent = [];
  const wanted = (file) => selectedByOnly(file, opts.only);
  if (opts.tests) {
    for (const file of files) {
      const m = /_self_test\.(mjs|py)$/.exec(file);
      if (!m || !wanted(file)) continue;
      const kind = m[1] === 'py' ? 'py' : 'js';
      if ((kind === 'py' && !opts.py) || (kind === 'js' && !opts.js)) continue;
      const entry = official.tests[file];
      const missing = entry ? (entry.needs ?? []).filter((n) => !needMet(n)) : [];
      if (missing.length) skipped.push({ file, reason: `official edition: needs ${missing.join(', ')}` });
      else tests.push({ file, kind, official: !!entry });
    }
    for (const file of Object.keys(official.tests)) {
      const kindOk = file.endsWith('.py') ? opts.py : opts.js;
      if (!files.includes(file) && kindOk && wanted(file)) absent.push(file);
    }
  }
  const mutants = [];
  if (opts.mutants) {
    for (const file of files) {
      if (!/_mutants\.py$/.test(file) || !wanted(file)) continue;
      const entry = official.mutants[file];
      const missing = entry ? (entry.needs ?? []).filter((n) => !needMet(n)) : [];
      if (missing.length) skipped.push({ file, reason: `official edition: needs ${missing.join(', ')}` });
      else mutants.push({ file, kind: 'mutants' });
    }
    for (const file of Object.keys(official.mutants)) {
      if (!files.includes(file) && wanted(file)) absent.push(file);
    }
  }
  return { tests, mutants, skipped, absent };
}

// ───────── environment ─────────
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) return [`Node.js ${process.versions.node} is too old: install Node.js 20 or newer`];
  try {
    createRequire(path.join(PWA, 'package.json')).resolve('esbuild');
  } catch {
    return [`the app's packages are not installed: cd ${rel(PWA)} && npm ci`];
  }
  return [];
}

/** a selected .mjs test that drives the Python routers names $AEGISTALK_PYTHON in its source */
const usesPython = (t) => t.kind === 'py' || fs.readFileSync(path.join(REVIEW, t.file), 'utf8').includes('AEGISTALK_PYTHON');

function checkPython(python) {
  const probe = `import importlib.util, json, sys
mods = ${JSON.stringify([...PY_REQUIRED, ...Object.keys(PY_OPTIONAL)])}
print(json.dumps({"version": list(sys.version_info[:3]), "missing": [m for m in mods if importlib.util.find_spec(m) is None]}))`;
  const r = spawnSync(python, ['-c', probe], { encoding: 'utf8' });
  const fix = `python3 -m venv .venv && .venv/bin/pip install -r scripts/review/requirements-test.txt\n`
    + '      then: npm test -- --python .venv/bin/python   (or AEGISTALK_PYTHON=.venv/bin/python)';
  if (r.error || r.status !== 0) return { problems: [`cannot run Python "${python}" (${r.error?.code ?? r.stderr.trim().split('\n').pop()}):\n      ${fix}`], notes: [] };
  const { version, missing } = JSON.parse(r.stdout);
  const problems = [];
  if (version[0] < 3 || (version[0] === 3 && version[1] < 10)) problems.push(`Python ${version.join('.')} (${python}) is too old: 3.10 or newer`);
  const req = missing.filter((m) => PY_REQUIRED.includes(m));
  if (req.length) problems.push(`Python (${python}) lacks ${req.map((m) => (m === 'jwt' ? 'PyJWT' : m)).join(', ')}:\n      ${fix}`);
  const notes = missing.filter((m) => m in PY_OPTIONAL).map((m) => `Python lacks optional ${m}: ${PY_OPTIONAL[m]}`);
  return { problems, notes, version: version.join('.') };
}

// ───────── running ─────────
/** each test runs in its own process group: a timeout or Ctrl-C also stops what it started (Python bridges, browsers) */
const running = new Set();
const killGroup = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const pid of running) killGroup(pid);
    console.error(`\nrun-all: ${sig} — stopped ${running.size} running test(s)`);
    process.exit(130);
  });
}

function runOne(t, opts) {
  const file = path.join(REVIEW, t.file);
  const cmd = t.kind === 'js' ? process.execPath : opts.python;
  const args = [file];
  if (t.kind === 'mutants' && t.file === 'step5d_mutants.py' && !process.env.AEGISTALK_JVM_PROJECT) args.push('--no-jvm');
  const env = { ...process.env, AEGISTALK_PYTHON: opts.python, SIM_PYTHON: process.env.SIM_PYTHON || opts.python, PYTHONDONTWRITEBYTECODE: '1' };
  const started = Date.now();
  const live = t.kind === 'mutants';
  const prefix = `  [${baseName(t.file)}] `;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) running.add(child.pid);
    const chunks = [];
    let atLineStart = true;
    const take = (buf) => {
      chunks.push(buf);
      if (!live) return;
      const s = buf.toString('utf8');
      process.stdout.write((atLineStart && s ? prefix : '') + s.replace(/\n(?=.)/g, `\n${prefix}`));
      atLineStart = s.endsWith('\n');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    let exitCode = null;
    let done = false;
    const timer = t.kind === 'mutants' ? null : setTimeout(() => { timedOut = true; killGroup(child.pid); }, opts.timeout * 1000);
    const finish = (code, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      running.delete(child.pid);
      const output = Buffer.concat(chunks).toString('utf8') + (error ? `\n${error.message}\n` : '');
      const log = path.join(opts.logs, `${t.file}.log`);
      fs.writeFileSync(log, output);
      resolve({ ...t, code, timedOut, output, log, seconds: (Date.now() - started) / 1000 });
    };
    child.on('error', (e) => finish(127, e));
    // the test is done: stop whatever it left behind in its group (that also closes pipes a leftover still holds)
    child.on('exit', (code, signal) => { exitCode = code ?? (signal ? 128 : 1); killGroup(child.pid); });
    child.on('close', (code) => finish(exitCode ?? code ?? 1));
  });
}

function classify(r) {
  const lines = r.output.split('\n').map((l) => l.trim());
  const skipLines = lines.filter((l) => /^SKIP\b/.test(l));
  if (r.timedOut) return { ...r, verdict: 'TIMEOUT', skipLines };
  if (r.code !== 0) return { ...r, verdict: 'FAIL', skipLines };
  const passLines = lines.filter((l) => /^PASS\b/.test(l));
  if (r.kind !== 'mutants' && skipLines.length && !passLines.length) return { ...r, verdict: 'SKIP', skipLines };
  return { ...r, verdict: 'PASS', skipLines };
}

async function runPool(items, opts, onDone) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const t = items[next++];
      const r = classify(await runOne(t, opts));
      results.push(r);
      onDone(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.jobs, items.length) }, worker));
  return results;
}

function report(r) {
  const secs = `${r.seconds.toFixed(1)}s`;
  if (r.verdict === 'PASS') {
    const parts = r.skipLines.length ? ` — ${r.skipLines.length} official part(s) skipped` : '';
    const score = r.kind === 'mutants' ? mutantScore(r.output) : '';
    console.log(`PASS  ${r.file} (${secs})${score}${parts}`);
  } else if (r.verdict === 'SKIP') {
    console.log(`SKIP  ${r.file} — ${r.skipLines[0].replace(/^SKIP\s*/, '')}`);
  } else {
    const why = r.verdict === 'TIMEOUT' ? `timed out after ${r.seconds.toFixed(0)}s` : `exit ${r.code}, ${secs}`;
    console.log(`${r.verdict.padEnd(5)} ${r.file} (${why}) → ${rel(r.log)}`);
    for (const line of r.output.trimEnd().split('\n').slice(-15)) console.log(`        ${line}`);
  }
}

/** the runners end with {"killed": k, "total": n[, "skipped": s]} */
function mutantScore(output) {
  const last = output.trimEnd().split('\n').reverse().find((l) => l.trim().startsWith('{"killed"'));
  if (!last) return '';
  const s = JSON.parse(last);
  return ` — ${s.killed}/${s.total} mutants killed${s.skipped ? `, ${s.skipped} skipped (official)` : ''}`;
}

function minutes(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// ───────── main ─────────
const opts = parseArgs(process.argv.slice(2));
const official = loadOfficialList();
const { tests, mutants, skipped, absent } = plan(opts, official);

const printSkips = () => {
  for (const s of skipped) console.log(`skip  ${s.file} — ${s.reason}`);
  for (const f of absent) console.log(`skip  ${f} — official edition only, not in this checkout`);
};
if (opts.list) {
  for (const t of [...tests, ...mutants]) console.log(`run   ${t.file}${t.official ? '   (official edition)' : ''}`);
  printSkips();
  process.exit(0);
}
if (!tests.length && !mutants.length) {
  console.log(`run-all: nothing to run${opts.only ? ` for --only ${opts.only.join(',')}` : ''}`);
  printSkips();
  process.exit(skipped.length || absent.length ? 0 : 2);
}

const problems = checkNode();
const notes = [];
let pythonVersion = null;
if ([...tests, ...mutants].some(usesPython)) {
  const py = checkPython(opts.python);
  problems.push(...py.problems);
  notes.push(...py.notes);
  pythonVersion = py.version;
}
if (problems.length) {
  console.error('run-all: the environment is not ready —');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}
fs.mkdirSync(opts.logs, { recursive: true });
console.log(`run-all: ${tests.length} test(s)${mutants.length ? ` + ${mutants.length} mutation runner(s)` : ''}, ${opts.jobs} at a time; `
  + `node ${process.versions.node}${pythonVersion ? `, python ${pythonVersion} (${opts.python})` : ''}; logs in ${rel(opts.logs)}`);
for (const n of notes) console.log(`note: ${n}`);

const t0 = Date.now();
// Python tests first (they are quick), then the .mjs ones; mutation runners last, one at a time
const ordered = [...tests.filter((t) => t.kind === 'py'), ...tests.filter((t) => t.kind === 'js')];
const results = await runPool(ordered, opts, report);
for (const m of mutants) {
  console.log(`\n── ${m.file} (mutation runner; prints as it goes) ──`);
  const r = classify(await runOne(m, opts));
  results.push(r);
  report(r);
}

const by = (v) => results.filter((r) => r.verdict === v);
const failed = [...by('FAIL'), ...by('TIMEOUT')];
const selfSkipped = by('SKIP');
console.log('\n──────── summary ────────');
console.log(`passed ${by('PASS').length}, failed ${failed.length}, skipped ${skipped.length + selfSkipped.length}`
  + ` (of ${results.length + skipped.length}) in ${minutes(Date.now() - t0)}`);
if (skipped.length || selfSkipped.length) {
  console.log('skipped:');
  for (const s of skipped) console.log(`  ${s.file} — ${s.reason}`);
  for (const r of selfSkipped) console.log(`  ${r.file} — ${r.skipLines[0].replace(/^SKIP\s*/, '')}`);
}
if (absent.length) console.log(`official edition only, not in this checkout: ${absent.map(baseName).join(', ')}`);
const partial = results.filter((r) => r.verdict === 'PASS' && r.skipLines.length);
if (partial.length) {
  console.log('official parts skipped inside passing tests:');
  for (const r of partial) for (const l of r.skipLines) console.log(`  ${r.file}: ${l}`);
}
if (failed.length) console.log(`FAILED: ${failed.map((r) => r.file).join(', ')} (logs in ${rel(opts.logs)})`);
process.exit(failed.length ? 1 : 0);

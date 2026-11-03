/**
 * Keys-only registration, client against server (open-source step 5b): the real client (ext/chat/registration.ts with
 * signedPost / canonicalJson) talks to the real chat server (api/chat_app.py, CHAT_REGISTRATION=invite, FastAPI TestClient
 * in a Python bridge process).
 *
 *   node scripts/review/account_register_self_test.mjs   (AEGISTALK_PYTHON with fastapi / pydantic / cryptography / httpx)
 *
 *   1. a new key with a valid invite → created; the body is exactly the server's AccountRegisterRequest fields
 *   2. the same key again without an invite → created: false (an existing account needs no invite)
 *   3. invite reuse: a one-use code a second time → invalid_invite; no code on an invite server → invite_required
 *   4. forged / unsigned / tampered: signed by another key for this public key → 401; no signature → 422; invite swapped
 *      after signing → 401; the identical request again → 409 — none of them creates an account
 *   5. clock 10 minutes off: 401 clock_skew → re-signed once with the server time → created
 *   6. outcome mapping: 429 → rate_limited, network error → unreachable, 403 registration_closed; a malformed invite code
 *      is refused before any request
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const API_DIR = process.env.AEGISTALK_API_DIR ?? root + 'api';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'acctreg-'));
await require('esbuild').build({ entryPoints: [SRC + '/ext/chat/registration.ts'], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'r.mjs'), logLevel: 'silent', define: { 'import.meta.env': '{}' } });
const R = await import(pathToFileURL(join(dir, 'r.mjs')));

// ── the real server in a bridge process: one JSON request per line in, one response per line out ──
const BRIDGE = `
import json, os, sys, sqlite3, tempfile
sys.path.insert(0, os.environ['API_DIR'])
tmp = tempfile.mkdtemp(prefix='acctreg-')
env = {'AEGIS_MQTT_JWT_SECRET': 'acct-register-fixture-mqtt-secret-0123456789', 'AEGIS_DB_PATH': os.path.join(tmp, 'chat.db'),
       'CHAT_PUBLIC_MQTT_URL': 'wss://mqtt.example.test/mqtt', 'CHAT_APP_ORIGINS': 'https://chat.example.test', 'CHAT_TRUSTED_PROXIES': 'none',
       'CHAT_REGISTRATION': 'invite'}
import chat_app
from fastapi.testclient import TestClient
app = chat_app.create_app(env)
from chat.accounts import create_invite
conn = sqlite3.connect(env['AEGIS_DB_PATH'])
one = create_invite(conn.cursor(), uses=1); two = create_invite(conn.cursor(), uses=2); conn.commit()
client = TestClient(app)
print(json.dumps({'one': one, 'two': two}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get('count'):
        n = sqlite3.connect(env['AEGIS_DB_PATH']).execute('SELECT COUNT(*) FROM pubkey_account_map').fetchone()[0]
        print(json.dumps({'accounts': n}), flush=True); continue
    r = client.post('/api/account/register', content=req['body'], headers={'Content-Type': 'application/json'})
    print(json.dumps({'status': r.status_code, 'body': r.text}), flush=True)
`;
const py = spawn(process.env.AEGISTALK_PYTHON || 'python3', ['-c', BRIDGE], { env: { ...process.env, API_DIR, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: py.stdout });
const waiting = [];
lines.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
const nextLine = () => new Promise((resolve) => waiting.push(resolve));
const invites = await nextLine();
const bridge = async (msg) => { const p = nextLine(); py.stdin.write(JSON.stringify(msg) + '\n'); return p; };
const sent = [];
/** fetch → the bridge (records every body the client sent) */
const serverFetch = async (_url, init) => {
  sent.push(JSON.parse(init.body));
  const r = await bridge({ body: init.body });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const accounts = async () => (await bridge({ count: true })).accounts;
let skewMs = 0;
const clock = { now: () => Date.now() + skewMs, adopt: (s) => { skewMs = s * 1000 - Date.now(); } };
const deps = { clock, fetchImpl: serverFetch, base: 'https://chat-api.example.test' };
const signer = (id) => ({ publicKey: id.pk, sign: id.sign });

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n    ', String(e.stack || e.message).split('\n').slice(0, 3).join('\n     ')); }
}
const alice = identity(), bob = identity(), carol = identity(), mallory = identity();

await check('a new key with a valid invite is registered; the body is exactly the server\'s request fields', async () => {
  const before = await accounts();
  assert.deepEqual(await R.registerAccount(signer(alice), invites.one, deps), { ok: true, created: true });
  assert.deepEqual(Object.keys(sent.at(-1)).sort(), ['action', 'invite_code', 'pubkey', 'request_id', 'signature', 'timestamp']);
  assert.equal(sent.at(-1).action, 'account_register');
  assert.equal(await accounts(), before + 1);
});

await check('the same key again without an invite: created false (no invite used)', async () => {
  assert.deepEqual(await R.registerAccount(signer(alice), undefined, deps), { ok: true, created: false });
  assert.ok(!('invite_code' in sent.at(-1)), 'no invite field when none is given');
});

await check('invite reuse refused (invalid_invite); no invite on an invite server → invite_required', async () => {
  const before = await accounts();
  assert.deepEqual(await R.registerAccount(signer(bob), invites.one, deps), { ok: false, code: 'invalid_invite', status: 403 });
  assert.deepEqual(await R.registerAccount(signer(bob), undefined, deps), { ok: false, code: 'invite_required', status: 403 });
  assert.equal(await accounts(), before);
});

await check('forged, unsigned, tampered or replayed registrations are refused and create nothing', async () => {
  const before = await accounts();
  const forged = R.signedRegisterBody({ publicKey: bob.pk, sign: mallory.sign }, invites.two, Date.now());
  assert.equal((await bridge({ body: JSON.stringify(forged) })).status, 401, 'signed by another key');
  const good = R.signedRegisterBody(signer(bob), invites.two, Date.now());
  const { signature, ...unsigned } = good;
  void signature;
  assert.equal((await bridge({ body: JSON.stringify(unsigned) })).status, 422, 'no signature');
  assert.equal((await bridge({ body: JSON.stringify({ ...good, invite_code: invites.one }) })).status, 401, 'invite swapped after signing');
  assert.equal((await bridge({ body: JSON.stringify({ ...good, pubkey: carol.pk }) })).status, 401, 'public key swapped');
  assert.equal(await accounts(), before, 'nothing created by the refused ones');
  assert.equal((await bridge({ body: JSON.stringify(good) })).status, 200, 'the genuine one');
  assert.equal((await bridge({ body: JSON.stringify(good) })).status, 409, 'replayed request_id');
  assert.equal(await accounts(), before + 1);
});

await check('clock 10 minutes off: clock_skew answered by re-signing once with the server time', async () => {
  skewMs = -10 * 60_000;
  const n = sent.length;
  assert.deepEqual(await R.registerAccount(signer(carol), invites.two, deps), { ok: true, created: true });
  assert.equal(sent.length - n, 2, 'two requests (skewed, then corrected)');
  assert.notEqual(sent.at(-1).request_id, sent.at(-2).request_id, 'new request_id for the re-signed one');
  skewMs = 0;
});

await check('outcomes: 429 → rate_limited, network → unreachable, registration_closed; malformed invite refused locally', async () => {
  const fake = (status, detail) => async () => new Response(JSON.stringify({ detail }), { status });
  assert.deepEqual(await R.registerAccount(signer(bob), undefined, { ...deps, fetchImpl: fake(429, 'registration_rate_limited') }), { ok: false, code: 'rate_limited', status: 429 });
  assert.deepEqual(await R.registerAccount(signer(bob), undefined, { ...deps, fetchImpl: fake(429, 'too_many_invite_attempts') }), { ok: false, code: 'rate_limited', status: 429 });
  assert.deepEqual(await R.registerAccount(signer(bob), undefined, { ...deps, fetchImpl: fake(403, 'registration_closed') }), { ok: false, code: 'registration_closed', status: 403 });
  assert.deepEqual(await R.registerAccount(signer(bob), undefined, { ...deps, fetchImpl: async () => { throw new TypeError('offline'); } }), { ok: false, code: 'unreachable' });
  let called = false;
  assert.deepEqual(await R.registerAccount(signer(bob), 'short', { ...deps, fetchImpl: async () => { called = true; return new Response('{}'); } }), { ok: false, code: 'invalid_invite' });
  assert.equal(called, false, 'no request for a malformed code');
  assert.equal(R.cleanInviteCode(' ab cd\n'), 'abcd');
});

py.stdin.end();
py.kill();
void crypto;
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nPASS account_register: the client\'s signed registration is accepted by the real server; forged / unsigned / reused / replayed ones are not');
process.exit(0);

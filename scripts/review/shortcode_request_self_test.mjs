/**
 * 好友短碼的 register／refresh 請求由帳戶金鑰簽（開源計畫第 3 步；伺服器端 api/chat/shortcode.py，shortcode_signing_self_test.py）。
 *   1. 真的 services/shortcodeRequest.ts（esbuild 打包）：request_signature 是身分金鑰對 canonical JSON
 *      {action, public_key, signed_pre_key, signature, display_name, timestamp, request_id} 的簽章；timestamp 用給的（校正過的）時鐘；
 *      request_id 每次新的
 *   2. 跨語言：JS 做出來的請求送進真的 Python router（FastAPI TestClient，api/chat/shortcode.py）→ register／refresh 都 200；
 *      改一個字 → 401（中文名字也一樣：canonical JSON 兩邊一字不差）
 *   3. FriendCode.fetchShortCode 用 signedShortCodeRequest、action 跟著 register／refresh、時間用 mqttService.serverNow，
 *      沒有已解鎖的簽章金鑰就不送；401 clock_skew → 照伺服器時間重簽一次；403（帳號還在建立）→ 重試，最多 4 次
 * Run: node scripts/review/shortcode_request_self_test.mjs   （第 2 項要 python 有 fastapi／pydantic／cryptography／httpx：
 *      AEGISTALK_PYTHON 指定直譯器，預設 python3）
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'shortcode-req-'));
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/shortcodeRequest.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const { signedShortCodeRequest } = await import(pathToFileURL(join(dir, 'r.mjs')).href);

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (e) {
    failed++;
    console.log('FAIL', name, '\n    ', `${e.code ?? e.name}: ${String(e.message).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
function identity() {
  const seed = crypto.randomBytes(32);
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pk = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { publicKey: pk, sign: (d) => new Uint8Array(crypto.sign(null, Buffer.from(d), priv)), seed: seed.toString('base64') };
}
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
function bundleFor(id, name) {
  const spk = crypto.randomBytes(32);
  return { signedPreKey: spk.toString('base64'), preKeySignature: Buffer.from(id.sign(spk)).toString('base64'), displayName: name };
}

const me = identity();
const NOW = 1_800_000_123_456;

await check('the request is signed by the identity key over the canonical JSON of every field', () => {
  const b = bundleFor(me, 'Alice');
  const req = signedShortCodeRequest(me, b, 'register_shortcode', NOW);
  const { request_signature, ...signed } = req;
  assert.deepEqual(Object.keys(signed).sort(), ['action', 'display_name', 'public_key', 'request_id', 'signature', 'signed_pre_key', 'timestamp']);
  assert.equal(signed.action, 'register_shortcode');
  assert.equal(signed.public_key, me.publicKey);
  assert.equal(signed.signed_pre_key, b.signedPreKey);
  assert.equal(signed.signature, b.preKeySignature);
  assert.equal(signed.timestamp, Math.floor(NOW / 1000), 'timestamp from the given (server-corrected) clock');
  assert.match(signed.request_id, /^[0-9a-f]{32}$/);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(me.publicKey, 'base64')]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, Buffer.from(JSON.stringify(canonical(signed))), key, Buffer.from(request_signature, 'base64')));
  const again = signedShortCodeRequest(me, b, 'refresh_shortcode', NOW);
  assert.notEqual(again.request_id, req.request_id, 'a new request_id every time');
  assert.equal(again.action, 'refresh_shortcode');
});

const python = process.env.AEGISTALK_PYTHON || 'python3';
const SERVER = String.raw`
import json, sys, hashlib, sqlite3, tempfile, os
from contextlib import contextmanager
sys.path.insert(0, sys.argv[1])
from fastapi import FastAPI
from fastapi.testclient import TestClient
from chat import shortcode, signing
from chat.config import DIRECT_CLIENTS
tmp = tempfile.mkdtemp()
@contextmanager
def db():
    c = sqlite3.connect(os.path.join(tmp, "db")); c.row_factory = sqlite3.Row
    try: yield c
    finally: c.close()
with db() as c:
    signing.create_tables(c.cursor()); shortcode.create_tables(c.cursor()); c.commit()
reqs = json.loads(sys.stdin.read())
with db() as c:
    for pk in {r["body"]["public_key"] for r in reqs}:
        c.execute("INSERT OR IGNORE INTO pubkey_account_map (pubkey_hash, account_key) VALUES (?, ?)", (hashlib.sha256(pk.encode()).hexdigest(), "acct-" + pk[:6]))
    c.commit()
app = FastAPI(); app.include_router(shortcode.create_shortcode_router(db, DIRECT_CLIENTS))
client = TestClient(app)
print(json.dumps([client.post(r["path"], json=r["body"]).status_code for r in reqs]))
`;

await check('a JS-made request is accepted by the real Python router (register, refresh, a Chinese name); one changed character → 401', () => {
  let out;
  const now = Date.now();
  const reqs = [
    { path: '/api/shortcode/register', body: signedShortCodeRequest(me, bundleFor(me, 'Alice'), 'register_shortcode', now) },
    { path: '/api/shortcode/register', body: signedShortCodeRequest(me, bundleFor(me, '王小明 🙂'), 'register_shortcode', now) },
    { path: '/api/shortcode/refresh', body: signedShortCodeRequest(me, bundleFor(me, '王小明'), 'refresh_shortcode', now) },
  ];
  const tampered = signedShortCodeRequest(me, bundleFor(me, 'Alice'), 'register_shortcode', now);
  reqs.push({ path: '/api/shortcode/register', body: { ...tampered, display_name: 'Alicf' } });
  reqs.push({ path: '/api/shortcode/refresh', body: signedShortCodeRequest(me, bundleFor(me, 'Alice'), 'register_shortcode', now) });
  try {
    out = execFileSync(python, ['-c', SERVER, root + 'api'], { input: JSON.stringify(reqs), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  } catch (e) {
    throw new Error(`python with fastapi needed (set AEGISTALK_PYTHON): ${String(e.stderr || e.message).slice(-300)}`);
  }
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [200, 200, 200, 401, 401]);
});

await check('FriendCode.fetchShortCode signs with the unlocked identity, action follows register/refresh, clock = mqttService.serverNow', () => {
  const fc = readFileSync(root + 'packages/pwa/src/components/Verification/FriendCode.tsx', 'utf8');
  const a = fc.indexOf('const fetchShortCode = useCallback(');
  const body = fc.slice(a, fc.indexOf('// 自動取得短碼', a));
  assert.match(body, /const signer = mqttService\.identitySignerFor\(publicKey\);\s*if \(!signer\)/, 'no unlocked identity → nothing is sent');
  assert.match(body, /signedShortCodeRequest\(signer, bundle, forceRefresh \? 'refresh_shortcode' : 'register_shortcode',\s*mqttService\.serverNow\(\) \+ clockFixMs\)/);
  assert.ok(body.indexOf('identitySignerFor') < body.indexOf('fetch('), 'checked before the request');
  assert.doesNotMatch(body, /body: JSON\.stringify\(\{\s*public_key/, 'the old unsigned body is gone');
});

await check('FriendCode retries: 401 clock_skew → re-signed once on the server time; 403 (account still being created) → retried, at most 4 tries', async () => {
  const fc = readFileSync(root + 'packages/pwa/src/components/Verification/FriendCode.tsx', 'utf8');
  const a = fc.indexOf('const fetchShortCode = useCallback(');
  const snippet = fc.slice(a, fc.indexOf('// 自動取得短碼', a));
  const { transformSync } = require('esbuild');
  const code = transformSync(snippet, { loader: 'tsx' }).code + ';({ fetchShortCode })';
  const { runInNewContext } = await import('node:vm');
  const SERVER_NOW = 1_800_000_000_000;
  function run(replies) {
    const sent = [];
    const errors = [];
    const ctx = {
      useCallback: (fn) => fn, publicKey: me.publicKey, signedPreKey: { publicKeyBase64: 'SPK', signatureBase64: 'SIG' }, displayName: 'Me',
      t: (k) => k, onError: (e) => errors.push(e), onCodeGenerated() {}, apiBase: () => 'https://api', JSON, Error, Promise, Math,
      setTimeout: (fn) => fn(), mqttService: { identitySignerFor: () => me, serverNow: () => SERVER_NOW }, signedShortCodeRequest,
      fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); const r = replies.shift(); return { ok: r.status === 200, status: r.status, json: async () => r.body }; },
      rememberShortCode() {}, setIsLoading() {}, setError() {}, setShortCode() {}, setExpiresAt() {},
    };
    return runInNewContext(code, ctx).fetchShortCode().then(() => ({ sent, errors }));
  }
  const ok = { status: 200, body: { short_code: 'ABC234', expires_at: 1, remaining_seconds: 1, is_new: true } };
  let r = await run([{ status: 401, body: { detail: { code: 'clock_skew', server_time: SERVER_NOW / 1000 + 600 } } }, ok]);
  assert.equal(r.sent.length, 2, 'retried once after clock_skew');
  assert.equal(r.sent[1].timestamp, SERVER_NOW / 1000 + 600, 'the second request is signed on the server time');
  assert.notEqual(r.sent[0].request_id, r.sent[1].request_id, 'a fresh request_id');
  r = await run([{ status: 401, body: { detail: { code: 'clock_skew', server_time: SERVER_NOW / 1000 + 600 } } }, { status: 401, body: { detail: { code: 'clock_skew', server_time: 1 } } }]);
  assert.equal(r.sent.length, 2, 'clock correction only once');
  r = await run([{ status: 403, body: { detail: 'account_not_registered' } }, { status: 403, body: {} }, ok]);
  assert.equal(r.sent.length, 3, 'retried while the account is being created');
  r = await run([403, 403, 403, 403, 403].map((status) => ({ status, body: {} })));
  assert.equal(r.sent.length, 4, 'at most 4 tries');
  assert.equal(r.errors.length, 1);
  r = await run([{ status: 401, body: { detail: 'invalid_shortcode_signature' } }]);
  assert.equal(r.sent.length, 1, 'a real signature error is not retried');
});

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nALL PASS');

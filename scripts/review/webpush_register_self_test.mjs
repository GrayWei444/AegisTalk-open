/**
 * 瀏覽器的 Web Push 註冊（開源第 4 步，services/webPush.ts）：取代明文的 PUSH_SUBSCRIPTION_UPDATE（訂閱經 broker 交給每個好友）
 * 與沒有驗證的 mist relay（寄件人拿好友的訂閱去叫 relay 推）。真的 webPush.ts／pushRequest.ts／signedPost.ts，假的瀏覽器推播 API。
 *   1. 沒允許通知、伺服器沒開 Web Push（server-config 沒有 vapid_public_key）、身分還沒解鎖 → 什麼都不做（不跳詢問、不訂閱、不送）
 *   2. 允許了：用伺服器的 VAPID 公鑰訂閱，POST /api/push/webpush/register 由帳戶金鑰簽章（簽章內容＝送出的所有欄位，
 *      canonical JSON），request_id 每次新的。舊版留下的訂閱（別的金鑰、或這個帳號還沒用這一版登記過）先退訂再重新訂閱
 *      （審查 M3：舊訂閱的網址與金鑰經 broker 給過好友）；登記過、同一把金鑰的才沿用；伺服器換了金鑰 → 重新訂閱
 *   3. 時鐘差：401 clock_skew → 用伺服器的時間重簽一次
 *   4. JS 產生的請求交給真的 Python 路由（api/chat/push.py）：收下；改一個字 → 401；同一份再送 → 409
 *   5. 原始碼：沒有 PUSH_SUBSCRIPTION_UPDATE／relay／寄件人自己推；PWA 開啟時才註冊（原生 App 走 FCM）；沒有寫死的 VAPID 公鑰
 * Run: node scripts/review/webpush_register_self_test.mjs   （第 4 項要 python 有 fastapi／pydantic／cryptography／httpx：AEGISTALK_PYTHON）
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, verify } from './directKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'webpush-'));
// the build's default server ('@ext/server'): an example one, so the test runs the same in the community tree (no default
// server there) and in the official one (the official default otherwise)
const EXT_SERVER = `export const defaultServer = { name: 'Example chat', apiUrl: 'https://chat-api.example.org', mqttUrl: 'wss://chat-mqtt.example.org/mqtt', registration: 'invite' };
  export const connectSources = []; export const brandLegal = undefined;`;
await require('esbuild').build({
  stdin: { contents: "export { registerWebPush } from './webPush';", resolveDir: SRC + '/services', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'w.mjs'), logLevel: 'silent',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /^@ext\/server$|utils\/devLog$|^\.\/mqtt$/ }, (a) => ({ path: a.path, namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path === '@ext/server' ? EXT_SERVER : a.path.includes('devLog')
      ? 'export const devLog=()=>{};export const devWarn=()=>{};'
      : `export const mqttService = {
          identitySignerFor: (pk) => (globalThis.__signer && globalThis.__signer.publicKey === pk ? globalThis.__signer : null),
          signedClock: () => ({ now: () => Date.now() + (globalThis.__skewMs ?? 0), adopt: (s) => { globalThis.__skewMs = s * 1000 - Date.now(); } }),
        };` }));
  } }],
});
const { registerWebPush } = await import(pathToFileURL(join(dir, 'w.mjs')));

const me = identity();
const b64url = (b) => Buffer.from(b).toString('base64url');
const vapidPub = b64url(crypto.createECDH('prime256v1').generateKeys());
const p256dh = crypto.createECDH('prime256v1').generateKeys();
const auth = crypto.randomBytes(16);
let permission = 'default';
let serverVapid = vapidPub;
let existing = null;
const subscribes = [];
/** 一個訂閱（applicationServerKey ＝ 訂的時候用的 VAPID 公鑰）；每次訂閱網址都不一樣 */
const makeSub = (key) => {
  const sub = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`,
    options: { applicationServerKey: key }, unsubscribed: false,
    getKey: (k) => (k === 'p256dh' ? p256dh : auth).buffer.slice(0),
    unsubscribe: async () => { sub.unsubscribed = true; if (existing === sub) existing = null; return true; },
  };
  return sub;
};
const registration = { pushManager: {
  getSubscription: async () => existing,
  subscribe: async (opts) => { subscribes.push(opts); existing = makeSub(opts.applicationServerKey); return existing; },
} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); } };
globalThis.window = { PushManager: function PushManager() {}, Notification: {} };
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { ready: Promise.resolve(registration) } }, configurable: true });
globalThis.Notification = { get permission() { return permission; } };
const posts = [];
let skewNext = null;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (url.endsWith('/api/chat/server-config')) return { ok: true, json: async () => ({ vapid_public_key: serverVapid }) };
  const body = JSON.parse(init.body);
  posts.push({ url, body });
  if (skewNext !== null) {
    const serverTime = Math.floor(Date.now() / 1000) + skewNext;     // 先算好：json() 是之後才呼叫的
    const res = { ok: false, status: 401, json: async () => ({ detail: { code: 'clock_skew', server_time: serverTime } }) };
    skewNext = null;
    return { ...res, clone: () => res };
  }
  return { ok: true, status: 200, json: async () => ({ success: true }) };
};
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const verifies = (body) => {
  const { signature, ...rest } = body;
  return verify(Buffer.from(me.pk, 'base64'), Buffer.from(JSON.stringify(canonical(rest))), Buffer.from(signature, 'base64'));
};

// 1
globalThis.__signer = { publicKey: me.pk, sign: me.sign };
assert.equal(await registerWebPush(me.pk), false, 'notifications not allowed → nothing');
permission = 'granted';
serverVapid = null;
assert.equal(await registerWebPush(me.pk), false, 'the server has no Web Push → nothing');
serverVapid = vapidPub;
globalThis.__signer = null;
assert.equal(await registerWebPush(me.pk), false, 'identity still locked → nothing');
assert.deepEqual([subscribes.length, posts.length], [0, 0], 'no subscription and no request in any of these cases');
console.log('PASS without permission, server Web Push or an unlocked identity nothing is subscribed or sent');

// 2
globalThis.__signer = { publicKey: me.pk, sign: me.sign };
// 舊版留下的訂閱（用 mist relay 那把金鑰訂的；網址與金鑰經 broker 給過好友）
const legacy = makeSub(new Uint8Array(Buffer.from(b64url(crypto.createECDH('prime256v1').generateKeys()), 'base64url')).buffer);
existing = legacy;
assert.equal(await registerWebPush(me.pk), true);
assert.ok(legacy.unsubscribed, 'the subscription left by an older build is unsubscribed');
assert.equal(subscribes.length, 1);
const ENDPOINT = existing.endpoint;
assert.notEqual(ENDPOINT, legacy.endpoint, 'a fresh endpoint (the one friends and the broker saw is dead)');
assert.equal(subscribes[0].userVisibleOnly, true);
assert.deepEqual(Buffer.from(new Uint8Array(subscribes[0].applicationServerKey)), Buffer.from(vapidPub, 'base64url'), 'subscribed with the server\'s VAPID key');
const reg = posts.at(-1);
assert.equal(reg.url, 'https://chat-api.example.org/api/push/webpush/register');
assert.deepEqual(Object.keys(reg.body).sort(), ['action', 'auth', 'endpoint', 'p256dh', 'pubkey', 'request_id', 'signature', 'timestamp']);
assert.deepEqual([reg.body.action, reg.body.pubkey, reg.body.endpoint, reg.body.p256dh, reg.body.auth],
  ['webpush_register', me.pk, ENDPOINT, b64url(p256dh), b64url(auth)]);
assert.ok(verifies(reg.body), 'signed by the account key over every field');
assert.ok(Math.abs(reg.body.timestamp - Date.now() / 1000) < 5);
assert.equal(await registerWebPush(me.pk), true);
assert.equal(subscribes.length, 1, 'a subscription this version registered with the same key is reused');
assert.notEqual(posts.at(-1).body.request_id, reg.body.request_id, 'a new request_id every time');
// 同一把金鑰、但這個帳號還沒用這一版登記過（別的帳號在這個瀏覽器登記的）→ 也重新訂閱
const other = identity();
globalThis.__signer = { publicKey: other.pk, sign: other.sign };
const before = existing;
assert.equal(await registerWebPush(other.pk), true);
assert.ok(before.unsubscribed && subscribes.length === 2, 'another account on this browser gets its own fresh subscription');
globalThis.__signer = { publicKey: me.pk, sign: me.sign };
assert.equal(await registerWebPush(me.pk), true);
assert.equal(subscribes.length, 2, 'me: flag set and same key → reused');
// 伺服器換了 VAPID 金鑰 → 舊的訂閱推不到 → 重新訂閱
const rotated = b64url(crypto.createECDH('prime256v1').generateKeys());
serverVapid = rotated;
const beforeRotation = existing;
assert.equal(await registerWebPush(me.pk), true);
assert.ok(beforeRotation.unsubscribed && subscribes.length === 3, 'a server key change re-subscribes');
assert.deepEqual(Buffer.from(new Uint8Array(subscribes.at(-1).applicationServerKey)), Buffer.from(rotated, 'base64url'));
serverVapid = vapidPub;
assert.equal(await registerWebPush(me.pk), true);           // 換回來：再訂一次（之後的測試用這一把）
console.log('PASS the subscription is registered with the server, signed by the account key; legacy / foreign-key subscriptions are replaced, ours reused');

// 3
const n0 = posts.length;
skewNext = 1200;
assert.equal(await registerWebPush(me.pk), true);
const [refused, retried] = posts.slice(n0);
assert.ok(refused && retried && posts.length === n0 + 2, 'refused once, re-signed once');
assert.ok(Math.abs(retried.body.timestamp - (Date.now() / 1000 + 1200)) < 5 && verifies(retried.body), 'the retry is signed on the server time');
assert.notEqual(retried.body.request_id, refused.body.request_id);
globalThis.__skewMs = 0;
console.log('PASS clock_skew → re-signed once on the server time');

// 4 交給真的 Python 路由
const python = process.env.AEGISTALK_PYTHON || 'python3';
const SERVER = String.raw`
import json, sys, hashlib, sqlite3, tempfile, os
from contextlib import contextmanager
sys.path.insert(0, sys.argv[1])
from fastapi import FastAPI
from fastapi.testclient import TestClient
from chat import push, signing
from chat.config import ProxyGuard
tmp = tempfile.mkdtemp()
@contextmanager
def db():
    c = sqlite3.connect(os.path.join(tmp, "db")); c.row_factory = sqlite3.Row
    try: yield c
    finally: c.close()
with db() as c:
    signing.create_tables(c.cursor()); push.create_tables(c.cursor()); c.commit()
reqs = json.loads(sys.stdin.read())
with db() as c:
    for pk in {r["body"]["pubkey"] for r in reqs}:
        c.execute("INSERT OR IGNORE INTO pubkey_account_map (pubkey_hash, account_key, created_at) VALUES (?, ?, 0)", (hashlib.sha256(pk.encode()).hexdigest(), "acct-" + pk[:6]))
    c.commit()
class Sender:
    def send(self, *a): return "sent"
app = FastAPI()
app.include_router(push.create_push_router(db, signing.resolve_account_key, ProxyGuard(client_ip=lambda r: "203.0.113.9", internal_ok=lambda r: True), fcm=False, webpush=Sender()))
client = TestClient(app)
out = [client.post("/api/push/webpush/register", json=r["body"]).status_code for r in reqs]
with db() as c:
    rows = c.execute("SELECT endpoint, p256dh, auth FROM webpush_subscriptions").fetchall()
print(json.dumps({"status": out, "rows": [list(r) for r in rows]}))
`;
const fresh = posts.length;
await registerWebPush(me.pk);
const good = posts[fresh].body;
const CURRENT = existing.endpoint;
const reqs = [{ body: good }, { body: { ...good, endpoint: good.endpoint + 'x' } }, { body: good }];
let out;
try {
  out = JSON.parse(execFileSync(python, ['-c', SERVER, root + 'api'], { input: JSON.stringify(reqs), encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n').pop());
} catch (e) {
  throw new Error(`python with fastapi needed (set AEGISTALK_PYTHON): ${String(e.stderr || e.message).slice(-400)}`);
}
assert.deepEqual(out.status, [200, 401, 409], 'accepted; one changed character → 401; the same request again → 409');
assert.deepEqual(out.rows, [[CURRENT, b64url(p256dh), b64url(auth)]], 'the server stored exactly this subscription');
console.log('PASS the real Python router accepts the JS-made registration and rejects altered or replayed ones');

// 5 原始碼
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const code = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [f.slice(SRC.length), readFileSync(f, 'utf8')]);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const [f, s] of code) {
  const c = strip(s);
  assert.ok(!/PUSH_SUBSCRIPTION_UPDATE|push_subscription_update/.test(c), `${f}: no plaintext push-subscription message`);
  assert.ok(!/mist\.aegisrd\.com|PUSH_RELAY_URL/.test(c), `${f}: no unauthenticated relay`);
  assert.ok(!/sendPushNotification|webpush\.sendNotification/.test(c), `${f}: the sender never pushes by itself`);
  assert.ok(!/['"]B[A-Za-z0-9_-]{85}['"]/.test(c), `${f}: no hard-coded VAPID public key`);
}
const chatApp = readFileSync(SRC + '/pages/ChatApp.tsx', 'utf8');
// 開源第 5b 步：只在使用者允許通知（granted）之後登記（push_permission_self_test 跑這段的行為）
assert.match(chatApp, /if \(granted && publicKey && !isNativeApp\(\)\) registerWebPush\(publicKey\)/, 'PWA registers Web Push (after permission); the native app uses FCM');
console.log('PASS no plaintext subscription message, relay or sender-side push is left; PWA registers on start');

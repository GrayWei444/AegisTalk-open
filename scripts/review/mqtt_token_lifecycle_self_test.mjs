/**
 * MQTT token 的生命週期（審查 2a：MEDIUM token 到期、LOW 換範圍／登出／晚到的 token）：真的 mqtt.ts，stub 掉 mqtt.js、IDB、fetch。
 *   以前：
 *   - 換範圍：先 end(true) 拆線（不送 DISCONNECT → broker 發離線遺囑），再去拿 token（拿不到就一直斷著）
 *   - token 1 小時到期：只有重連時才換，到期那一刻 broker 踢線（disconnect_after_expire）
 *   - 拿 token 的 await 期間登出：回來照樣寫進手上那張，範圍也還留著，下一個帳號的第一張 token 帶著上一個帳號的群組／好友
 *   - 兩個 token 請求交錯：晚回來的舊那張蓋掉新的（手上的範圍與連線用的 token 對不上）
 *   - 被換掉的裝置（伺服器 403 device_replaced）claim 回來後還要等 60 秒冷卻；claim 前拿的 token 沒有 kick 主題
 *   現在：
 *   1. 換範圍：舊連線照常，先拿新 token，再送 DISCONNECT（reason 0、沒有遺囑），用新 token 連回來；拿不到就留著舊連線
 *   2. 到期前 5 分鐘自動照 1 的方式換新
 *   3. 登出（disconnect）時進行中的 token 請求作廢、範圍清掉；換帳號時別人的範圍不拿來簽
 *   4. 晚到的舊請求不蓋掉新的
 *   5. onDeviceClaimed：清掉 device_replaced 的冷卻；手上的 token 沒有 kick 主題就換一張
 *   6. 手機時鐘差太多（審查 MEDIUM）：伺服器回 401 clock_skew＋server_time → 用伺服器時間重簽一次；之後訊息外層時戳、
 *      收件的新鮮度、token 到期都用校正後的時間；重簽還是不行 → aegis:mqtt-notice 提示使用者（以前永遠 401、什麼都不顯示）
 * Run: node scripts/review/mqtt_token_lifecycle_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttlife-'));
globalThis.__clients = [];
globalThis.__events = [];
const DEVICE = '0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab';
// the build's default server ('@ext/server'): an example one, so the test runs the same in the community tree (no default
// server there) and in the official one
const EXT_SERVER = `export const defaultServer = { name: 'Example chat', apiUrl: 'https://chat-api.example.org', mqttUrl: 'wss://chat-mqtt.example.org/mqtt', registration: 'invite' };
  export const connectSources = []; export const brandLegal = undefined;`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@ext/server' ? EXT_SERVER
    : a.path === 'mqtt' ? `export default { connect(url, options) {
        const handlers = {}; const subs = []; const pubs = [];
        const c = { connected: true, disconnected: false, subs, pubs, options, handlers, ended: null,
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          subscribe(topic, opts, cb) { subs.push(topic); cb?.(null, [].concat(topic).map((t) => ({ topic: t, qos: 1 }))); },
          unsubscribe() {}, publish(t, p, o, cb) { pubs.push({ topic: t, payload: p, opts: o }); cb?.(null); },
          removeAllListeners() { for (const k in handlers) delete handlers[k]; },
          end(force, opts, cb) { c.ended = { force: !!force, opts: typeof opts === 'object' ? opts : null }; c.connected = false;
            globalThis.__events.push('end:' + c.options.password + ':' + (force ? 'forced' : 'disconnect'));
            if (typeof opts === 'function') opts(); else cb?.(); } };
        globalThis.__events.push('client:' + options.password);
        globalThis.__clients.push(c); return c; } };`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? `export const getDeviceIdSync=()=>"${DEVICE}";`
    : `let n = 0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
globalThis.localStorage = { getItem: (k) => (k === 'aegis_device_id' ? DEVICE : null), setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {}; console.log = (...x) => process.stdout.write(x.join(' ') + '\n');
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));
const Svc = svc.constructor;

const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(raw).toString('base64'), sign: (data) => new Uint8Array(edSign(null, Buffer.from(data), privateKey)) };
}
const me = keypair();
const other = keypair();
// 群組主題 id（W3）：22 個 URL-safe 字元
const [G1, G2, G3, SECRET, OTHER, OLD, NEW] = ['g1', 'g2', 'g3', 'secret', 'other', 'old', 'new'].map((x) => x.padEnd(22, 'Q'));
const friend = keypair().pk;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// W4：presence 範圍是確切的好友主題＋我的 tag；codec 這裡把狀態原樣當 payload（真的加解密見 mqtt_presence_w4_self_test）
const TAG = 'Pq9_Rs8-Tu7Vw6Xy5Za4Bc';
const PS = { tag: TAG, topics: [`mist/user/${friend.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}/presence/${TAG}`] };
const NOP = { tag: null, topics: [] };
svc.setPresenceCodec({ async seal(topic, st) { return JSON.stringify(st); }, current: () => true, async open() { return null; }, cleared: () => false });

// ── fetch：預設馬上回；hold() 之後的請求要手動放行（模擬慢網路）──
const requests = [];
let lifetimeS = 3600;
let kick = true;
let refuse = null;          // { status, detail }：下一個請求回這個錯誤
let holding = false;
const held = [];
let serverSkewMs = 0;       // 伺服器時間 − 本機時間
let jumpy = false;          // true：每次回的伺服器時間都不一樣（時鐘一直在跳，重簽也不會過）
globalThis.fetch = async (u, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  const n = requests.push({ url: String(u), body });
  const token = 'jwt-' + n;
  globalThis.__events.push('fetch:' + token);
  const answer = () => {
    if (String(u).endsWith('/api/mqtt/token')) {
      const serverMs = Date.now() + serverSkewMs + (jumpy ? requests.length * 3_600_000 : 0);
      if (Math.abs(body.timestamp * 1000 - serverMs) > 300_000) {
        return { ok: false, status: 401, json: async () => ({ detail: { code: 'clock_skew', server_time: Math.floor(serverMs / 1000) } }) };
      }
    }
    if (refuse) {
      const r = refuse; refuse = null;
      return { ok: false, status: r.status, json: async () => ({ detail: r.detail }) };
    }
    const sub = [`mist/user/${url(body.pubkey)}/inbox/+`, ...body.groups.map((g) => `mist/group/${g}/+`),
      ...body.presence, ...(kick && body.device_id ? [`aegis/device/${body.device_id}/kicked`] : [])];
    const serverS = Math.floor((Date.now() + serverSkewMs) / 1000);
    return { ok: true, json: async () => ({ token, expiresAt: serverS + lifetimeS, username: url(body.pubkey),
      subscribe: sub, serverTime: serverS }) };
  };
  if (!holding) return answer();
  return new Promise((resolve) => held.push({ token, release: () => resolve(answer()) }));
};
const until = async (cond, ms = 3000) => { for (let i = 0; i < ms / 5 && !cond(); i++) await sleep(5); return cond(); };
async function connectAndAck(pk) {
  const before = globalThis.__clients.length;
  const p = svc.connect(pk);
  await until(() => globalThis.__clients.length > before, 1000);
  const c = globalThis.__clients.length > before ? globalThis.__clients.at(-1) : null;
  c?.emit('connect', { cmd: 'connack', sessionPresent: false });
  await p;
  return c;
}
const ack = (c) => c.emit('connect', { cmd: 'connack', sessionPresent: false });

// ── 1. 換範圍：先拿 token，再正常斷線（DISCONNECT），再連 ──
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([G1], PS, me.pk);
const c1 = await connectAndAck(me.pk);
assert.ok(c1, 'connected');
globalThis.__events.length = 0;
svc.setAclScope([G1, G2], PS, me.pk);            // 多了群組主題 → 250ms 後換
await until(() => globalThis.__clients.at(-1) !== c1);
const c2 = globalThis.__clients.at(-1);
assert.notEqual(c2, c1, 'scope change → new client');
const ev = globalThis.__events.join(' ');
const t2 = c2.options.password;
assert.ok(globalThis.__events.indexOf('fetch:' + t2) < globalThis.__events.findIndex((e) => e.startsWith('end:')),
  `the new token is fetched before the old connection is closed (${ev})`);
assert.deepEqual(c1.ended, { force: false, opts: { reasonCode: 0 } }, 'the old connection ends with a normal DISCONNECT (no offline will)');
assert.deepEqual(requests.at(-1).body.groups, [G1, G2]);
ack(c2);
await sleep(10);
console.log('PASS scope change: new token first, then a clean DISCONNECT (no will), then reconnect');

// 只少了群組主題（W3：換金鑰後上一代的過了重疊期）：這張 token 還夠 → 不換、不重連；之後真的需要多的才換
const tokensShrink = requests.length;
svc.setAclScope([G2], PS, me.pk);
await sleep(400);
assert.equal(globalThis.__clients.at(-1), c2, 'dropping a group topic does not swap the token');
assert.equal(requests.length, tokensShrink);
svc.setAclScope([G1, G2], PS, me.pk);           // 回來的那個這張 token 本來就有 → 也不換
await sleep(400);
assert.equal(globalThis.__clients.at(-1), c2, 'a topic the token already grants needs no swap either');
console.log('PASS a scope that only shrinks (an old epoch topic expired) keeps the token and the connection');

// 換範圍時拿不到 token → 留著舊連線（不斷線、不發遺囑）
refuse = { status: 503, detail: 'unavailable' };
svc.setAclScope([G1, G2, G3], PS, me.pk);
await sleep(400);
assert.equal(globalThis.__clients.at(-1), c2, 'no new client');
assert.equal(c2.ended, null, 'the working connection is kept when the new token cannot be fetched');
svc._tokenFetchFailedAt = 0;
console.log('PASS a failed token fetch during a scope change keeps the working connection');

// ── 2. 到期前 5 分鐘換新 ──
svc.disconnect();
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
Svc.TOKEN_REFRESH_RETRY_MS = 20;                        // 測試裡把「至少等多久」縮短
lifetimeS = 300 + 1;                                    // 到期前 5 分鐘＝1 秒後
const c3 = await connectAndAck(me.pk);
const t3 = c3.options.password;
lifetimeS = 3600;
await until(() => globalThis.__clients.at(-1) !== c3, 3000);
const c4 = globalThis.__clients.at(-1);
assert.notEqual(c4, c3, 'a new connection before the token expires');
assert.notEqual(c4.options.password, t3, 'with a new token');
assert.deepEqual(c3.ended, { force: false, opts: { reasonCode: 0 } }, 'the old one ends with a normal DISCONNECT');
ack(c4);
await sleep(10);
assert.ok(svc._tokenRefreshTimer, 'the next refresh is scheduled');
console.log('PASS the token is refreshed (clean reconnect) 5 minutes before it expires');

// ── 3. 登出時正在拿 token：回來作廢、範圍清掉，下一個帳號不帶上一個帳號的範圍 ──
svc.disconnect();
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([SECRET], PS, me.pk);
holding = true;
const before3 = globalThis.__clients.length;
const pending = svc.connect(me.pk);
await until(() => held.length === 1);
svc.disconnect();                                       // 登出
svc.setIdentitySigner(null);
held.shift().release();
await pending;
await sleep(10);
assert.equal(globalThis.__clients.length, before3, 'no client is opened for the logged-out account');
assert.equal(svc._mqttToken, null, 'the late token is not kept');
assert.equal(svc._aclScope, null, 'the scope is cleared even though there was no client yet');
holding = false;
svc.setIdentitySigner({ publicKey: other.pk, sign: other.sign });
const c5 = await connectAndAck(other.pk);
assert.ok(c5);
assert.deepEqual([requests.at(-1).body.groups, requests.at(-1).body.presence, requests.at(-1).body.presence_tag], [[], [], undefined], 'the next account does not inherit the previous scope');
assert.ok(!('peers' in requests.at(-1).body), 'no peers (W4)');
console.log('PASS logout during a token fetch discards the late token and the old scope');

// 換帳號時上一個帳號的請求還在路上（範圍都是空的）：下一個帳號不能共用那個請求、拿到上一個帳號的 token
svc.disconnect();
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
holding = true;
const mine = svc.connect(me.pk);
await until(() => held.length === 1);
svc.disconnect();
svc.setIdentitySigner({ publicKey: other.pk, sign: other.sign });
const theirs = svc.connect(other.pk);
await until(() => held.length === 2, 1000);
assert.equal(held.length, 2, 'the next account sends its own token request');
for (const h of held.splice(0)) h.release();
await mine;
await until(() => globalThis.__clients.at(-1).options.username === url(other.pk), 1000);
const c5b = globalThis.__clients.at(-1);
assert.equal(c5b.options.username, url(other.pk));
assert.equal(c5b.options.password, 'jwt-' + (requests.findLastIndex((r) => r.body.pubkey === other.pk) + 1), 'connected with its own token');
ack(c5b);
await theirs;
holding = false;
console.log('PASS an in-flight request of the previous account is never shared with the next one');

// 換帳號（中間鎖過）：上一個帳號的範圍不拿來簽
svc.setAclScope([OTHER], PS, other.pk);
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
assert.equal(svc._aclScope, null, 'a scope owned by another account is dropped when the signer changes');
svc.disconnect();
console.log('PASS a scope set for another account is never signed by the next one');

// ── 4. 晚到的舊請求不蓋掉新的 ──
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([OLD], NOP, me.pk);
holding = true;
const first = svc.connect(me.pk);
await until(() => held.length === 1);
svc._teardown();                                        // HealthMonitor 重建連線
svc.setAclScope([NEW], NOP, me.pk);
const second = svc.connect(me.pk);
await until(() => held.length === 2);
const [oldReq, newReq] = held.splice(0);
newReq.release();
await until(() => globalThis.__events.includes('client:' + newReq.token));
const cNew = globalThis.__clients.at(-1);
ack(cNew);
await second;
oldReq.release();
await first;
await sleep(10);
holding = false;
assert.equal(globalThis.__clients.at(-1), cNew, 'the late request does not open another client');
assert.equal(svc._mqttToken, newReq.token, 'the late token does not overwrite the newer one');
assert.equal(svc._tokenScopeKey, `${NEW}||`, 'the scope of the token in hand stays the newer one');
const stale = { ...svc._activeGrant(), token: 'jwt-older', scopeKey: `${OLD}|`, seq: svc._adoptedSeq - 1 };
assert.equal(svc._adopt(stale), newReq.token, 'adopting an older grant returns the newer token');
assert.equal(svc._mqttToken, newReq.token);
svc.disconnect();
console.log('PASS a late token request never overwrites a newer token');

// ── 5. device_replaced → claim 之後不等冷卻；claim 前的 token 沒有 kick → 換一張 ──
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
refuse = { status: 403, detail: 'device_replaced' };
assert.equal(await connectAndAck(me.pk), null, '403 device_replaced → no connection');
const n5 = requests.length;
assert.equal(await connectAndAck(me.pk), null, 'in cooldown');
assert.equal(requests.length, n5, 'no request during the cooldown');
kick = false;                                           // claim 剛完成、伺服器這一張還沒給 kick（例如帳號第一次 claim）
svc.onDeviceClaimed();
const c6 = await connectAndAck(me.pk);
assert.ok(c6, 'connects right after the claim without waiting for the cooldown');
assert.ok(!c6.subs.flat().some((t) => t.startsWith('aegis/device/')));
kick = true;
svc.onDeviceClaimed();                                  // 這張沒有 kick 主題 → 換一張
await until(() => globalThis.__clients.at(-1) !== c6);
const c7 = globalThis.__clients.at(-1);
assert.notEqual(c7, c6, 'a token without the kick topic is swapped after the claim');
ack(c7);
await sleep(10);
assert.ok(c7.subs.flat().includes(`aegis/device/${DEVICE}/kicked`), 'the kick topic is subscribed with the new token');
svc.onDeviceClaimed();
await sleep(300);
assert.equal(globalThis.__clients.at(-1), c7, 'no further swap once the token has the kick topic');
svc.disconnect();
console.log('PASS after a device claim: no cooldown wait, and a token without the kick topic is swapped');

// ── 6. 手機時鐘快了 2 小時（伺服器時間比本機晚 2 小時）──
const notices = [];
globalThis.window = { dispatchEvent: (e) => { notices.push(e.detail); return true; } };
serverSkewMs = -2 * 3_600_000;
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([G1], PS, me.pk);   // 有 tag 才發 presence（W4）
const n6 = requests.length;
const c8 = await connectAndAck(me.pk);
assert.ok(c8, 'connects even though the phone clock is 2 hours ahead');
assert.equal(requests.length, n6 + 2, 'one 401 clock_skew, then one request re-signed with the server time');
assert.ok(Math.abs(requests.at(-1).body.timestamp * 1000 - (Date.now() + serverSkewMs)) < 5_000, 'the retry is signed with the server time');
assert.ok(Math.abs(svc._clockOffsetMs - serverSkewMs) < 2_000, 'the offset is remembered');
const presence = c8.pubs.filter((x) => x.topic.includes('/presence/')).map((x) => JSON.parse(x.payload)).at(-1);   // 這裡的 codec 封的就是明文 {on, ts, cs}
assert.ok(presence && Math.abs(presence.ts - (Date.now() + serverSkewMs)) < 5_000, 'presence carries the server-aligned time (inside the sealed state, W4)');
svc.sendToUser(friend, 'direct_sealed', {});
assert.equal(svc.sendToGroup(G1, 'group_sealed', { k: 'k', n: 'n', c: 'c' }), true);
await sleep(10);
for (const m of c8.pubs.slice(-2).map((x) => JSON.parse(x.payload))) {
  assert.ok(Math.abs(m.timestamp - (Date.now() + serverSkewMs)) < 5_000, `${m.type} envelope carries the server-aligned time`);
}
const seen = [];
svc.onMessage('direct_sealed', (m) => seen.push(m.from));
svc.handleMessage(`mist/user/${url(me.pk)}/inbox/${url(friend)}`,
  Buffer.from(JSON.stringify({ type: 'direct_sealed', from: friend, payload: {}, timestamp: Date.now() + serverSkewMs })));
assert.deepEqual(seen, [friend], 'a message stamped with the correct (server) time is not "from the future" here');
await sleep(300);
assert.equal(globalThis.__clients.at(-1), c8, 'token expiry is judged in server time (no refresh loop)');
assert.ok(svc._tokenRefreshTimer, 'refresh scheduled ~55 min out');
assert.deepEqual(notices.filter((n) => n.kind === 'clock-skew'), [], 'no "refused" notice when the retry works');
// W5：收端窗短的檢查（通話、here、好友在線）用有上限的時鐘 → 時鐘差超過 5 分鐘要請使用者校正（clock-drift），只說一次
assert.deepEqual(notices.filter((n) => n.kind === 'clock-drift').map((n) => n.minutes), [120], 'but the user is told the phone clock is 2 h off');
notices.length = 0;
svc._teardown();                                        // 斷線重連：手上那張（伺服器時間還有 1 小時）照用
const nReuse = requests.length;
assert.ok(await connectAndAck(me.pk), 'reconnected');
assert.equal(requests.length, nReuse, 'the cached token is still valid in server time (no new request)');
svc.disconnect();
console.log('PASS clock skew: re-signed with the server time, envelopes/freshness/expiry use the corrected clock');

// 重簽還是不行（時鐘一直在跳）→ 提示使用者；之後連上了 → 收回提示
jumpy = true;
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
assert.equal(await connectAndAck(me.pk), null, 'still refused');
assert.equal(notices.length, 1, 'the user is told why');
assert.equal(notices[0].kind, 'clock-skew');
assert.ok(notices[0].minutes >= 60, `minutes off is reported (${notices[0].minutes})`);
jumpy = false;
svc._tokenFetchFailedAt = 0;
const c9 = await connectAndAck(me.pk);
assert.ok(c9, 'connects once the clock settles');
assert.deepEqual(notices.at(-1), { kind: 'clock-ok' }, 'the notice is withdrawn after a successful token');
svc.disconnect();
globalThis.window = undefined;
serverSkewMs = 0;
console.log('PASS a clock that still fails after the retry is shown to the user, and cleared once connected');

// ── UI：App 掛著 ConnectionNotice，它聽 aegis:mqtt-notice；五種語言都有文案 ──
const { readFileSync } = await import('node:fs');
const src = (p) => readFileSync((process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/' + p, 'utf8');
assert.match(src('App.tsx'), /<ConnectionNotice \/>/, 'App renders the notice');
assert.match(src('components/common/ConnectionNotice.tsx'), /addEventListener\('aegis:mqtt-notice'/);
for (const lang of ['en', 'zh-TW', 'zh-CN', 'ja', 'ko']) {
  const body = src(`i18n/locales/${lang}.ts`).match(/connectionNotice: \{[\s\S]*?clockSkewBody: (['"])(.*?)\1/);
  assert.ok(body && body[2].includes('{minutes}'), `${lang}: clock-skew text with {minutes}`);
}
console.log('PASS the clock-skew notice is rendered and translated');

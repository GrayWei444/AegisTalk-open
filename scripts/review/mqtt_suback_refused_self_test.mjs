/**
 * broker 拒絕訂閱（SUBACK 0x87）時的處理（審查 2a：以前沒有測試）：真的 mqtt.ts，stub 掉 mqtt.js、IDB、fetch。
 *   stub 照 mqtt.js 5.14（package-lock 釘的版本，審查 W3 L4）：同一批只要有一個被拒，callback 就拿到 err、第二個參數是**要求的**
 *   qos、每個主題真正的原因碼在第三個參數 packet.granted；全部准了才是 err＝null。被拒的主題不能記成「訂過了」——
 *   不然 presence／群組主題的同步之後直接跳過，永遠不再試；同一批裡准了的照樣要算訂好。
 *   1. 群組主題（W3：照範圍，連上時訂）／好友的 presence 主題（W4：一樣照範圍）被拒 → 不追蹤，下次（範圍再設、重連）再訂；被拒的不算訂好
 *      （isGroupSubscribed false，群組引擎不會以為主題好了就送加入後的 sync）
 *   2. 一批裡有的被拒 → 只追蹤准了的
 *   3. broker 沒保留 session、連上後重訂一批，有的被拒 → 從追蹤清單拿掉（以前只記 log、留在清單裡）
 * Run: node scripts/review/mqtt_suback_refused_self_test.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'suback-'));
globalThis.__clients = [];
globalThis.__denied = new Set();
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
        const handlers = {}; const subs = [];
        const c = { connected: true, disconnected: false, subs, options, handlers,
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          subscribe(topic, opts, cb) { const list = [].concat(topic); subs.push(...list);
            const codes = list.map((t) => (globalThis.__denied.has(t) ? 0x87 : 1));
            const packet = { cmd: 'suback', granted: codes };
            if (codes.some((x) => x >= 0x80)) cb?.(Object.assign(new Error('Subscribe error: Not authorized'), { packet }), list.map((t) => ({ topic: t, qos: 1 })), packet);
            else cb?.(null, list.map((t, i) => ({ topic: t, qos: codes[i] })), packet); },
          unsubscribe() {}, publish(t, p, o, cb) { cb?.(null); },
          removeAllListeners() { for (const k in handlers) delete handlers[k]; }, end(f, o, cb) { (typeof o === 'function' ? o : cb)?.(); } };
        globalThis.__clients.push(c); return c; } };`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ return null }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? `export const getDeviceIdSync=()=>"${DEVICE}";`
    : 'export const makeOutgoingId=()=>"o"; export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }' }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {};
const { mqttService: svc } = await import(pathToFileURL(join(dir, 'm.mjs')));

const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pk: Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64'),
    sign: (d) => new Uint8Array(edSign(null, Buffer.from(d), privateKey)) };
};
const me = key();
const [f1, f2] = [key().pk, key().pk];
globalThis.fetch = async (u, init) => {
  const body = JSON.parse(init.body);
  // 伺服器的 token 給這些主題（broker 端另外用 __denied 模擬「還是被拒」—— 例如 token 已換、broker 的授權快取還是舊的）
  const subscribe = [`mist/user/${url(body.pubkey)}/inbox/+`, ...body.groups.map((g) => `mist/group/${g}/+`), ...body.presence];
  return { ok: true, json: async () => ({ token: 'jwt', expiresAt: Math.floor(Date.now() / 1000) + 3600, username: url(body.pubkey), subscribe, serverTime: Math.floor(Date.now() / 1000) }) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(sessionPresent = false) {
  const before = globalThis.__clients.length;
  const p = svc.connect(me.pk);
  for (let i = 0; i < 200 && globalThis.__clients.length === before; i++) await sleep(5);
  const c = globalThis.__clients.at(-1);
  c.emit('connect', { cmd: 'connack', sessionPresent });
  await p;
  return c;
}
const presence = (pk) => `mist/user/${url(pk)}/presence/${'P'.repeat(22)}`;   // 好友的秘密 presence 主題（W4，照範圍訂）
const scope = () => ({ tag: null, topics: [presence(f1), presence(f2)] });
const group = (t) => `mist/group/${t}/+`;
const T1 = 'T1aaaaaaaaaaaaaaaaaaaa';   // 群組主題 id（W3）
const T2 = 'T2bbbbbbbbbbbbbbbbbbbb';
const subscribed = new Set();
svc.onGroupSubscribed((tid) => subscribed.add(tid));

svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([T1, T2], scope(), me.pk);
// ── 1. 單一訂閱被拒（群組主題：連上時照範圍訂）──
globalThis.__denied = new Set([group(T1), presence(f1)]);
let c = await connect();
await sleep(5);
assert.ok(!svc.subscribedGroupTopics.has(group(T1)), 'a refused group subscription is not tracked');
assert.ok(!svc.isGroupSubscribed(T1) && !subscribed.has(T1), 'and not reported as subscribed (the engine would send its post-join sync too early)');
assert.ok(svc.isGroupSubscribed(T2) && subscribed.has(T2), 'the granted one in the same (refused) batch is (mqtt.js 5 reports the batch as err)');
assert.ok(!svc.subscribedPresenceTopics.has(presence(f1)), 'a refused presence subscription is not tracked');
globalThis.__denied = new Set();
const n1 = c.subs.length;
svc.setAclScope([T1, T2], scope(), me.pk);   // 範圍再設一次（一樣的範圍）：群組主題照範圍補訂
await sleep(5);
assert.deepEqual(c.subs.slice(n1).flat().sort(), [group(T1), presence(f1)].sort(), 'both are tried again later');
assert.ok(svc.subscribedGroupTopics.has(group(T1)) && svc.subscribedPresenceTopics.has(presence(f1)), 'and tracked once granted');
console.log('PASS a refused group/presence subscription is not remembered and is retried');

// ── 2. 一批裡有的被拒 ──
svc.subscribedGroupTopics.clear();
globalThis.__denied = new Set([group(T2)]);
svc.setAclScope([T1, T2], scope(), me.pk);
await sleep(5);
assert.ok(svc.subscribedGroupTopics.has(group(T1)) && !svc.subscribedGroupTopics.has(group(T2)), 'only the granted ones are tracked');
globalThis.__denied = new Set();
const n2 = c.subs.length;
svc.setAclScope([T1, T2], scope(), me.pk);
await sleep(5);
assert.deepEqual(c.subs.slice(n2).flat(), [group(T2)], 'the refused one is retried, the granted one is not re-sent');
console.log('PASS a partially refused batch tracks only what was granted');

// ── 3. 重訂（broker 沒保留 session）時有的被拒 ──
await sleep(5);
assert.ok(svc.subscribedPresenceTopics.has(presence(f2)));
svc._teardown();
globalThis.__denied = new Set([presence(f2), group(T2)]);
c = await connect(false);                                 // sessionPresent=false → 重訂全部追蹤中的／範圍裡的
await sleep(5);
assert.ok(c.subs.flat().includes(presence(f2)), 'resubscribed after the session was lost');
assert.ok(c.subs.flat().includes(group(T2)), 'group topics too');
assert.ok(!svc.subscribedPresenceTopics.has(presence(f2)), 'a refused resubscription is dropped from tracking');
assert.ok(!svc.subscribedGroupTopics.has(group(T2)) && !svc.isGroupSubscribed(T2));
assert.ok(svc.subscribedPresenceTopics.has(presence(f1)) && svc.subscribedGroupTopics.has(group(T1)), 'granted ones stay tracked');
globalThis.__denied = new Set();
const n3 = c.subs.length;
svc.setAclScope([T1, T2], scope(), me.pk);
await sleep(5);
assert.deepEqual(c.subs.slice(n3).flat().sort(), [group(T2), presence(f2)].sort(), 'so the next pass subscribes them again');
svc.disconnect();
console.log('PASS refused resubscriptions after a lost session are dropped from tracking and retried');

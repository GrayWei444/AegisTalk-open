/**
 * MQTT 主題綁寄件者＋簽章 token＋訂閱範圍（移植群星 A8；伺服器端見 mqtt_token_acl_self_test.py）：
 *   真的 mqtt.ts／mqttCredential.ts，stub 掉 mqtt.js、IDB、fetch。
 *   以前：收件箱主題沒有寄件者那一節、from 是寄件者自己填的（任何人都能冒用任何人送 X3DH_INIT／群組事件）；
 *         token 只送 pubkeyHash；訂閱不看 token 給不給（之後 broker 開 ACL 就會被拒）。
 *   現在：
 *   1. 發布到 mist/user/<收件人>/inbox/<我>（離線排隊也一樣）、mist/group/<tid>/<我>（W3：群組主題 id，不排隊）
 *   2. 收到時主題最後一節 ≠ URL-safe(from) 一律丟；presence（W4）只在確切的秘密主題 mist/user/<他>/presence/<tag> 上、交給 codec 拆
 *      （舊的 mist/user/<他>/presence 不再是 presence 主題；presence 型別走收件箱也不收）
 *   3. IDB 裡舊版排隊的 …/inbox 補上自己那一節；舊的 mist/broadcast、任何群組主題上的（舊版用 gid 當主題）丟掉
 *   4. token 請求用已解鎖的身分簽章（groups＝群組主題 id／presence／presence_tag／client_id／device_id 在簽章內，W4 起沒有 peers）；
 *      沒解鎖不拿、不連；群組主題 id 只送剛好 22 字元的、presence 只送確切的主題（萬用字元、舊的格式都不送：伺服器會整張拒絕）
 *   5. 只訂 token 給得起的群組主題／presence；群組主題照範圍訂（連上時、範圍變了時）；範圍多了 token 給不起的 → 換 token
 *      重連、重連後才訂；只少了群組主題 → 不換 token，直接退訂（W3：換金鑰後上一代的主題過了重疊期）
 *   6. 換機臨時身分：不簽章、clientId＝伺服器給的 username、不發 presence／遺囑、只訂收件箱
 * Run: node scripts/review/mqtt_acl_scope_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqttacl-'));
globalThis.__clients = [];
globalThis.__idb = new Map();
const DEVICE = '0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab';
// the build's default server ('@ext/server'): an example one, so the test runs the same in the community tree (no default
// server there) and in the official one (the official default otherwise)
const EXT_SERVER = `export const defaultServer = { name: 'Example chat', apiUrl: 'https://chat-api.example.org', mqttUrl: 'wss://chat-mqtt.example.org/mqtt', registration: 'invite' };
  export const connectSources = []; export const brandLegal = undefined;`;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^@ext\/server$|^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === '@ext/server' ? EXT_SERVER
    : a.path === 'mqtt' ? `export default { connect(url, options) {
        const handlers = {}; const subs = []; const pubs = [];
        const c = { connected: true, disconnected: false, subs, pubs, options, handlers,
          on(ev, fn) { (handlers[ev] ??= []).push(fn); return c; },
          emit(ev, ...x) { for (const fn of handlers[ev] ?? []) fn(...x); },
          subscribe(topic, opts, cb) { subs.push(topic); cb?.(null, [].concat(topic).map((t) => ({ topic: t, qos: 1 }))); },
          unsubs: [], unsubscribe(t, cb) { c.unsubs.push(...[].concat(t)); cb?.(null); },
          publish(t, p, o, cb) { pubs.push({ topic: t, payload: p, opts: o }); cb?.(null); },
          removeAllListeners() { for (const k in handlers) delete handlers[k]; }, end() {} };
        globalThis.__clients.push(c); return c; } };`
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(env){ return globalThis.__unseal(env) }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? `export const getDeviceIdSync=()=>"${DEVICE}";`
    : `let n = 0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(e){ globalThis.__idb.set(e.id, e) }
       export async function removeOutgoing(id){ globalThis.__idb.delete(id) }
       export async function loadAllOutgoing(){ return [...globalThis.__idb.values()] }` }));
} };
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/mqtt.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'm.mjs'), logLevel: 'silent', plugins: [stub], define: { 'import.meta.env': '{}' } });
globalThis.window = undefined;
globalThis.localStorage = { getItem: (k) => (k === 'aegis_device_id' ? DEVICE : null), setItem() {}, removeItem() {} };
console.warn = () => {}; console.error = () => {}; console.log = (...x) => process.stdout.write(x.join(' ') + '\n');
const { mqttService: svc, MessageType } = await import(pathToFileURL(join(dir, 'm.mjs')));

const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(raw).toString('base64'), publicKey, sign: (data) => new Uint8Array(edSign(null, Buffer.from(data), privateKey)) };
}
const me = keypair();
const friend = keypair().pk;
const member = keypair().pk;
const stranger = keypair().pk;
const GROUP = 'Tq3xZ0-_aB9cD8eF7gH6iJ';      // 群組主題 id（W3）：22 個 URL-safe 字元
const GROUP2 = 'Zz9yX8wV7uT6sR5qP4oN3m';
const ME = url(me.pk);
// W4：presence 是確切的秘密主題；codec（App 裡是 presenceService）這裡只認一則固定的「真的」好友狀態
const TAG = 'Pq9_Rs8-Tu7Vw6Xy5Za4Bc';
const ptopic = (pk) => `mist/user/${url(pk)}/presence/${TAG}`;
const MY_PRESENCE = `mist/user/${ME}/presence/${TAG}`;
svc.setPresenceCodec({
  async seal(topic, st) { return topic === MY_PRESENCE ? JSON.stringify({ n: 'n', c: `sealed-${st.on}` }) : null; },
  current(topic) { return topic === MY_PRESENCE; },
  async open(topic, payload) { return topic === ptopic(friend) && payload === 'REAL' ? { owner: friend, state: { on: 1, ts: Date.now(), cs: Date.now() } } : null; },
  cleared() { return false; },
});

// fetch：記下每個 token 請求，回一張 token。subscribe＝伺服器 _mqtt_acl 的 sub（kick 主題只給帳號的活躍裝置：kickGranted）
const requests = [];
let kickGranted = true;
const serverSubscribe = (b) => [`mist/user/${url(b.pubkey)}/inbox/+`, ...b.groups.map((g) => `mist/group/${g}/+`),
  ...b.presence, ...(b.device_id && kickGranted ? [`aegis/device/${b.device_id}/kicked`] : [])];
globalThis.fetch = async (u, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  requests.push({ url: String(u), body });
  if (String(u).endsWith('/api/mqtt/transfer-token')) {
    return { ok: true, json: async () => ({ token: 'transfer-jwt', expiresAt: Math.floor(Date.now() / 1000) + 300, username: 'transfer_AbCdEfGhIjKlMnOpQrStUvWxYz012345' }) };
  }
  return { ok: true, json: async () => ({ token: 'jwt-' + requests.length, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    username: url(body.pubkey), subscribe: serverSubscribe(body), serverTime: Math.floor(Date.now() / 1000) }) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connectAndAck(pk, sessionPresent = false) {
  const before = globalThis.__clients.length;
  const p = svc.connect(pk);
  for (let i = 0; i < 100 && globalThis.__clients.length === before; i++) await sleep(5);
  const c = globalThis.__clients.at(-1);
  if (globalThis.__clients.length === before) { await p; return null; }
  c.emit('connect', { cmd: 'connack', sessionPresent });
  await p;
  return c;
}

// ── 4. 沒解鎖不拿 token、不連 ──
assert.equal(await connectAndAck(me.pk), null, 'no client without the unlocked identity');
assert.equal(requests.length, 0, 'no token request without a signer (and no pubkeyHash fallback)');
console.log('PASS no unlocked identity → no token request, no connection');

// ── 4. 簽章請求 ──
// W2：每次連上都通知（群組引擎補抓 log）；換 token 的重連標 tokenSwap（群組的 here 只在真的上線時發）
const connects = [];
svc.onConnected(({ tokenSwap }) => connects.push(tokenSwap));
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
svc.setAclScope([GROUP, 'bad/group', '+', '#', 'A'.repeat(21), 'A'.repeat(23), 'group-1760000000000-abc1234'],
  { tag: TAG, topics: [ptopic(friend), ptopic(member), `mist/user/${url(stranger)}/presence`, `mist/user/+/presence/${TAG}`, 'not-a-topic'] });
let c = await connectAndAck(me.pk);
assert.ok(c, 'connected once the identity is unlocked');
const req = requests.at(-1).body;
assert.equal(requests.at(-1).url, 'https://chat-api.example.org/api/mqtt/token');
assert.ok(!('pubkeyHash' in req), 'no pubkeyHash');
assert.deepEqual(req.groups, [GROUP], 'only exact 22-char group topic ids are sent (the server would reject the whole token)');
assert.ok(!('peers' in req), 'no peers (public keys) any more (W4)');
assert.deepEqual(req.presence, [ptopic(friend), ptopic(member)].sort(), 'only exact presence topics, sorted');
assert.equal(req.presence_tag, TAG, 'my tag (publish right) is signed too');
assert.equal(req.client_id, `mist_${ME.slice(0, 16)}_${DEVICE.slice(0, 8)}`);
assert.equal(req.device_id, DEVICE);
assert.equal(req.action, 'mqtt_token');
assert.ok(/^[0-9a-f]{32}$/.test(req.request_id), 'fresh random request_id');
const { signature, ...signed } = req;
const canonical = JSON.stringify(Object.fromEntries(Object.keys(signed).sort().map((k) => [k, signed[k]])));
assert.ok(edVerify(null, Buffer.from(canonical), me.publicKey, Buffer.from(signature, 'base64')), 'signature covers every field (sorted JSON)');
assert.equal(c.options.clientId, req.client_id, 'connects with the clientId the token is bound to');
assert.equal(c.options.username, ME, 'username = server-issued URL-safe key');
assert.ok(c.options.will, 'a will is set');
assert.equal(c.options.will.topic, MY_PRESENCE, 'will on my own secret presence topic');
console.log('PASS token request is signed by the unlocked identity and carries the scope; clientId/username bound');

// ── 5. 只訂 token 給得起的 ──
assert.ok(c.subs.flat().includes(`mist/user/${ME}/inbox/+`), 'inbox/+ subscribed');
assert.ok(c.subs.flat().includes(`aegis/device/${DEVICE}/kicked`), 'own kick topic subscribed when the server grants it');
const subs1 = c.subs.flat();
assert.ok(subs1.includes(ptopic(friend)) && subs1.includes(`mist/group/${GROUP}/+`), 'in-scope topics subscribed (group and presence topics straight from the scope at CONNACK)');
assert.ok(!subs1.some((t) => t.includes(url(stranger)) || t.includes(GROUP2)), 'out-of-scope topics are not even tried');
const tokensBefore = requests.length;
const scope3 = { tag: TAG, topics: [ptopic(friend), ptopic(member), ptopic(stranger)] };
svc.setAclScope([GROUP, GROUP2], scope3);
assert.ok(!c.subs.flat().includes(`mist/group/${GROUP2}/+`), 'a brand-new group topic waits for the scope reconnect');
await sleep(2300);                                  // 新的群組主題：250ms 後換 token（舊連線正常斷線最多等 1.5 秒）再重連
const c2 = globalThis.__clients.at(-1);
assert.notEqual(c2, c, 'scope change → new client');
assert.equal(requests.length, tokensBefore + 1, 'one new token');
assert.deepEqual(requests.at(-1).body.groups, [GROUP, GROUP2].sort());
c2.emit('connect', { cmd: 'connack', sessionPresent: false });
await sleep(10);
assert.deepEqual(connects, [false, true], 'the first connect is a real one; the scope-change reconnect is flagged as a token swap');
const subs2 = c2.subs.flat();
assert.ok(subs2.includes(`mist/group/${GROUP2}/+`) && subs2.includes(ptopic(stranger)), 'subscribed after the new token');
svc.setAclScope([GROUP, GROUP2], scope3);
await sleep(2300);
assert.equal(globalThis.__clients.at(-1), c2, 'same scope → no reconnect');
// 只少了群組主題（換金鑰後上一代的過了重疊期）：不換 token，直接退訂
const tokensShrink = requests.length;
svc.setAclScope([GROUP2], scope3);
await sleep(2300);
assert.equal(globalThis.__clients.at(-1), c2, 'a group topic dropped from the scope → no token swap');
assert.equal(requests.length, tokensShrink, 'no new token');
assert.deepEqual(c2.unsubs, [`mist/group/${GROUP}/+`], 'the dropped group topic is unsubscribed at once');
svc.setAclScope([GROUP, GROUP2], scope3);   // 回到範圍裡（這張 token 給得起）：直接重訂，不換 token
await sleep(400);
assert.equal(globalThis.__clients.at(-1), c2);
assert.equal(c2.subs.flat().filter((t) => t === `mist/group/${GROUP}/+`).length, 2, 'subscribed again on the same connection');
console.log('PASS only topics the token grants are subscribed; a scope that needs more swaps the token and then subscribes; a group topic dropped from the scope is unsubscribed without a swap');

// ── 1. 發布主題帶自己那一節 ──
svc.sendToUser(friend, MessageType.DIRECT_SEALED, {});
assert.equal(svc.sendToGroup(GROUP, MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }), true);
await sleep(10);
const topics = c2.pubs.map((p) => p.topic);
assert.ok(topics.includes(`mist/user/${url(friend)}/inbox/${ME}`), `inbox publish carries the sender (${topics.join(' ')})`);
assert.ok(topics.includes(`mist/group/${GROUP}/${ME}`), 'group publish carries the sender');
assert.ok(topics.includes(MY_PRESENCE), 'presence on my own secret topic');
assert.ok(!topics.some((t) => t.startsWith('mist/broadcast')), 'no broadcast');
console.log('PASS publishes land on my own sender segment');

// ── 2. 收件時核對寄件者 ──
const got = [];
svc.onMessage(MessageType.DIRECT_SEALED, (m) => got.push(m.from));
svc.onMessage(MessageType.GROUP_SEALED, (m) => got.push('g:' + m.from));
const deliver = (topic, type, from, payload = {}) =>
  svc.handleMessage(topic, Buffer.from(JSON.stringify({ type, from, payload, timestamp: Date.now() })));
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'direct_sealed', friend);
deliver(`mist/user/${ME}/inbox/${url(stranger)}`, 'direct_sealed', friend);       // 冒用 friend 的 from
deliver(`mist/user/${ME}/inbox`, 'direct_sealed', friend);                        // 舊格式（沒有寄件者）
deliver(`mist/group/${GROUP}/${url(member)}`, 'group_sealed', member);
deliver(`mist/group/${GROUP}/${url(stranger)}`, 'group_sealed', member);
deliver(`mist/user/${url(friend)}/presence`, 'direct_sealed', friend);            // 舊的 presence 主題（W4 起不是 presence 主題）
deliver(ptopic(friend), 'direct_sealed', friend);                                 // 一般訊息格式走秘密 presence 主題
assert.deepEqual(got, [friend, 'g:' + member], `only messages whose topic sender matches from are delivered (got ${got.join(',')})`);
const online = [];
svc.onPresenceChange((pk, on) => online.push(`${pk === friend ? 'F' : '?'}:${on}`));
deliver(`mist/user/${url(friend)}/presence`, 'presence', friend, { online: true });    // 舊格式的明文「在線」（營運方也寫得出來）
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'presence', friend, { online: true }); // presence 走收件箱
deliver(ptopic(friend), 'presence', friend, { online: true });                        // 明文「在線」放在秘密主題上
svc.handleMessage(ptopic(stranger), Buffer.from('REAL'));                             // codec 只認 friend 主題上的
await sleep(10);
assert.equal(svc.isFriendOnline(friend), false, 'forged / plaintext / old-form presence ignored');
svc.handleMessage(ptopic(friend), Buffer.from('REAL'));
await sleep(10);
assert.equal(svc.isFriendOnline(friend), true, 'a state the codec opens is accepted');
console.log('PASS receiver drops messages whose topic sender differs from the claimed from');

// ── 2b. from 只收標準寫法（審查 MEDIUM）：同一把金鑰的其他字串寫法（最後一個資料字元沒用到的位元改掉）主題也對得上，
//        但要擋 —— 否則封鎖名單、好友清單都對不上，變成「另一個人」
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const variant = friend.slice(0, 42) + ALPHA[ALPHA.indexOf(friend[42]) ^ 1] + '=';
assert.ok(variant !== friend && Buffer.from(variant, 'base64').equals(Buffer.from(friend, 'base64')), 'same key bytes, different string');
got.length = 0;
deliver(`mist/user/${ME}/inbox/${url(variant)}`, 'direct_sealed', variant);           // 主題那一節跟 from 一致
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'direct_sealed', friend.slice(0, 43)); // 沒有 padding
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'direct_sealed', friend.slice(0, 41) + '-_='); // URL-safe 字母
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'direct_sealed', friend + 'AAAA');      // 多出來的
svc.handleMessage(`mist/user/${url(variant)}/presence/${TAG}`, Buffer.from('REAL'));   // 非標準寫法的主人：不是 presence 主題
await sleep(10);
assert.deepEqual(got, [], `non-canonical from strings are rejected (got ${got.join(',')})`);
assert.equal(svc.isFriendOnline(friend), true, 'a non-canonical presence did not touch the real friend');
deliver(`mist/user/${ME}/inbox/${url(friend)}`, 'direct_sealed', friend);
assert.deepEqual(got, [friend], 'the canonical form still goes through');
console.log('PASS only the canonical 44-char base64 of the sender key is accepted as from');

// ── 2d. client 的 message 事件把 retain 旗標交給 handleMessage：收件箱上的 retained 丟掉 ──
got.length = 0;
const wire = (retain) => c2.emit('message', `mist/user/${ME}/inbox/${url(friend)}`,
  Buffer.from(JSON.stringify({ type: 'direct_sealed', from: friend, payload: {}, timestamp: Date.now() })), { retain });
wire(true);
assert.deepEqual(got, [], 'a retained inbox message from the wire is dropped');
wire(false);
assert.deepEqual(got, [friend], 'the same message without retain is delivered');
console.log('PASS the retain flag from the client reaches the receive path');

// ── 2c. sealed 訊息：解開後的寄件者照樣核對主題（以前這條路徑沒有測試）、照樣只收標準寫法與新鮮時戳 ──
svc.privateKeyBase64 = 'sealed-test-key';
const sealed = (topic, inner) => {
  globalThis.__unseal = async () => ({ verified: true, payload: {}, timestamp: Date.now(), ...inner });
  svc.handleMessage(topic, Buffer.from(JSON.stringify({ sealed: true, envelope: { v: 1 }, timestamp: Date.now() })));
  return sleep(5);
};
got.length = 0;
await sealed(`mist/user/${ME}/inbox/${url(friend)}`, { type: 'direct_sealed', from: friend });
assert.deepEqual(got, [friend], 'a sealed message whose sender matches the topic is delivered');
await sealed(`mist/user/${ME}/inbox/${url(stranger)}`, { type: 'direct_sealed', from: friend });
await sealed(`mist/user/${ME}/inbox/${url(variant)}`, { type: 'direct_sealed', from: variant });
await sealed(`mist/user/${ME}/inbox/${url(friend)}`, { type: 'direct_sealed', from: friend, timestamp: Date.now() - 2 * 86_400_000 });
await sealed(`mist/user/${ME}/inbox/${url(friend)}`, { type: 'not_a_type', from: friend });
assert.deepEqual(got, [friend], `sealed: forged/non-canonical sender, stale or unknown type rejected (got ${got.join(',')})`);
svc.privateKeyBase64 = null;
console.log('PASS sealed messages: decrypted sender must match the topic sender, canonical, fresh, known type');

// ── 3. 舊版 IDB 待送訊息補上寄件者那一節 ──
svc._teardown();
globalThis.__idb.clear();
const old = (id, topic, type) => ({ id, topic, qos: 1, timestamp: Date.now() - 1000, payload: JSON.stringify({ type, from: me.pk, payload: {}, timestamp: Date.now() }) });
globalThis.__idb.set('a', old('a', `mist/user/${url(friend)}/inbox`, 'group_key_sealed'));
globalThis.__idb.set('b', old('b', `mist/group/${GROUP}`, 'group_sealed'));
globalThis.__idb.set('b2', old('b2', `mist/group/${GROUP}/${ME}`, 'group_sealed'));   // W2：群組主題是 gid，會排隊
globalThis.__idb.set('c', old('c', 'mist/broadcast', 'direct_sealed'));
const c3 = await connectAndAck(me.pk, true);
await sleep(20);
assert.equal(connects.at(-1), false, 'a reconnect after a teardown (not a token swap) is a real one again');
const flushed = c3.pubs.map((p) => p.topic).filter((t) => !t.includes('/presence/'));
assert.deepEqual(flushed, [`mist/user/${url(friend)}/inbox/${ME}`], `queued inbox topic upgraded, nothing on a group topic (got ${flushed.join(' ')})`);
for (const id of ['b', 'b2', 'c']) assert.ok(!globalThis.__idb.has(id), `retired entry ${id} dropped from IDB`);
console.log('PASS queued messages from the old topic scheme go out on the new topics; broadcast and group-topic entries (a gid on the broker) dropped');

// ── 5b. kick 主題以伺服器回的 subscribe 為準：這台不是帳號的活躍裝置（或還沒 claim）→ 伺服器不給 → 不訂（不讓 broker 拒絕） ──
svc.disconnect();
svc.setIdentitySigner(null);
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
kickGranted = false;
const nBeforeNoKick = requests.length;
const cNoKick = await connectAndAck(me.pk);
assert.equal(requests.length, nBeforeNoKick + 1, 'a fresh token was requested');
assert.ok(requests.at(-1).body.device_id === DEVICE, 'the device id is still asked for');
assert.ok(!cNoKick.subs.flat().some((t) => t.startsWith('aegis/device/')), `kick topic not subscribed when the token lacks it (${cNoKick.subs.flat().join(' ')})`);
kickGranted = true;
svc.disconnect();
console.log('PASS the kick topic is subscribed only when the server-issued token grants it');

// ── 6. 換機臨時身分 ──
svc.disconnect();
svc.setIdentitySigner(null);
const nReq = requests.length;
const cred = await svc.createTransferCredential();
svc.useTemporaryCredential(cred);
const c4 = await connectAndAck(cred.username);
assert.equal(requests.length, nReq + 1, 'only the transfer-token request, no signed token request');
assert.equal(c4.options.clientId, cred.username, 'clientId = server-assigned username');
assert.equal(c4.options.username, cred.username);
assert.equal(c4.options.will, undefined, 'no will (no presence publish right)');
assert.deepEqual(c4.subs.flat(), [`mist/user/${cred.username}/inbox/+`], 'only its own inbox');
assert.ok(!c4.pubs.length, 'publishes nothing (no presence)');
svc.disconnect();
svc.setIdentitySigner({ publicKey: me.pk, sign: me.sign });
const c5 = await connectAndAck(me.pk);
assert.equal(c5.options.clientId, `mist_${ME.slice(0, 16)}_${DEVICE.slice(0, 8)}`, 'back to the account identity after the transfer');
console.log('PASS transfer credential: receive-only, server-assigned clientId, dropped on disconnect');
svc.disconnect();

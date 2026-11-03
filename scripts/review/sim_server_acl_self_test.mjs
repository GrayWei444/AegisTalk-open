/**
 * 四手機模擬的 token ACL 來自伺服器的程式（審查 2a：以前 scripts/sim/lib/profiles.mjs 抄了一份 _mqtt_acl，
 * 伺服器改了模擬照舊 PASS）。真的 scripts/sim/lib/mockApi.mjs＋server_acl.py＋api/chat/mqtt_auth.py，不開瀏覽器。
 *   1. 模擬 /api/mqtt/token 發的 JWT acl ＝ 直接呼叫 api/chat/mqtt_auth.py mqtt_acl 的結果；改了 mqtt_auth.py（暫存複本），模擬跟著變
 *   1b.（W3）範圍驗證也是伺服器的 mqtt_scope：群組主題 id 剛好 22 字元，萬用字元／長度不對 → 400、超過 50 個 → 422（記在
 *       rejected，模擬的 API-AUTH 會因此失敗）；改了 mqtt_auth.py 的 MQTT_GROUP_TOPIC_RE，模擬跟著變
 *   1c.（W4）presence：沒有 peers 了（送了 → 422，伺服器的 extra="forbid"）；presence 只收確切的 mist/user/<他>/presence/<tag>
 *       （只有公鑰的舊形狀、萬用字元 → 400 invalid_acl_presence）；我的 tag 給一個確切的 presence 發布權
 *   1d.（開源第 6 步）多的欄位也照伺服器的欄位表（mqtt_auth.py MQTT_TOKEN_REQUEST_FIELDS）：暫存複本多收一個欄位，模擬跟著變
 *   2. 回應帶 subscribe（＝acl.sub）與 serverTime
 *   3. kick 主題只給 /api/devices/claim 記下的那台；記的是別台 → 403 device_replaced（同伺服器 mqtt_kick_device）
 *   4. 時鐘差 → 401 {code: clock_skew, server_time}
 *   5. profiles.mjs 裡沒有 AegisTalk 的 ACL 複本
 *   6.（開源第 3 步）token 的 acl claim 是伺服器 mqtt_acl_claim 的規則格式（EMQX ≥ 5.7）：模擬 broker 的判斷（aclAllows）——
 *      只有自己的 presence 主題能 retain、收件箱與群組頻道的 retained 拒絕、其他一律拒絕
 *   7.（開源第 3 步）keys-only 帳號：只從 POST /api/account/register 來（簽章、request_id 不重放）；沒帳號的金鑰在裝置 claim、
 *      推播、信任分數、短碼 → 403（記在 rejected：模擬的 API-AUTH 會失敗）
 *   8.（開源第 4 步）推播／信任分數照這一支聽到的伺服器時間判、差太多回 clock_skew（記在 clockSkewed，不算拒收）；社群版只收
 *      message／incoming_call；Web Push 登記照伺服器
 * 需要 python3（標準庫即可）。Run: node scripts/review/sim_server_acl_self_test.mjs
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const { createMockApi, decodeToken, serverAclFrom } = await import(pathToFileURL(root + 'scripts/sim/lib/mockApi.mjs'));
const { aclAllows, aclView } = await import(pathToFileURL(root + 'scripts/sim/lib/aclView.mjs'));
const { PROFILES } = await import(pathToFileURL(root + 'scripts/sim/lib/profiles.mjs'));
const profile = PROFILES.aegistalk;
const SERVER_PY = 'api/chat/mqtt_auth.py';
assert.equal(profile.serverAcl, SERVER_PY, 'AegisTalk profile takes its ACL from the chat server (api/chat/mqtt_auth.py)');

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(raw).toString('base64'), sign: (s) => edSign(null, Buffer.from(s), privateKey).toString('base64') };
}
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const url = (b64) => Buffer.from(b64, 'base64').toString('base64url');
const me = keypair();
const friend = keypair().pk;
const DEVICE = '0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab';
const TID = 'Tq3xZ0-_aB9cD8eF7gH6iJ';   // 群組主題 id（W3）
const TAG = 'Pq9_Rs8-Tu7Vw6Xy5Za4Bc';   // presence tag（W4）
const FTOPIC = `mist/user/${url(friend)}/presence/${TAG}`;
let n = 0;
function tokenRequest(over = {}) {
  const fields = { action: 'mqtt_token', pubkey: me.pk, timestamp: Math.floor(Date.now() / 1000), request_id: `req-${++n}-0123456789abcdef`,
    client_id: `mist_${url(me.pk).slice(0, 16)}_${DEVICE.slice(0, 8)}`, groups: [TID], presence: [FTOPIC], presence_tag: TAG, device_id: DEVICE, ...over };
  return JSON.stringify({ ...fields, signature: me.sign(JSON.stringify(canonical(fields))) });
}
const call = (api, body) => { const r = api.handle('POST', '/api/mqtt/token', body); return { status: r.status, body: JSON.parse(r.body) }; };
/** keys-only 帳號（POST /api/account/register，身分金鑰簽） */
function register(api, who, over = {}) {
  const fields = { action: 'account_register', pubkey: who.pk, timestamp: Math.floor(Date.now() / 1000), request_id: `reg-${++n}-0123456789abcdef`, ...over };
  const r = api.handle('POST', '/api/account/register', JSON.stringify({ ...fields, signature: who.sign(JSON.stringify(canonical(fields))) }));
  return { status: r.status, body: JSON.parse(r.body), fields };
}

// ── 1. ACL ＝ 伺服器的 mqtt_acl ──
const serverAcl = serverAclFrom(root + SERVER_PY);
const api = createMockApi({ log() {}, profile, serverAcl });
const ok = call(api, tokenRequest());
assert.equal(ok.status, 200, JSON.stringify(ok.body));
const claims = decodeToken(ok.body.token);
const expected = serverAcl({ pubkey: me.pk, groups: [TID], presence: [FTOPIC], presence_tag: TAG, device_id: null });
assert.deepEqual(claims.acl, expected.claim, 'the simulated token carries exactly what api/chat/mqtt_auth.py mqtt_acl_claim returns');
assert.ok(Array.isArray(claims.acl), 'rules format (EMQX >= 5.7) by default');
const view = aclView(claims.acl);
assert.deepEqual(view.sub, [`mist/user/${url(me.pk)}/inbox/+`, `mist/group/${TID}/+`, FTOPIC]);
assert.deepEqual(view.sub, expected.acl.sub, 'same subscriptions as mqtt_acl');
assert.ok(view.pub.includes(`mist/user/${url(me.pk)}/presence/${TAG}`) && !view.pub.some((t) => t.endsWith('/presence')), 'publish only on my exact presence topic');
// 改伺服器的程式（暫存複本）→ 模擬跟著變
const dir = mkdtempSync(join(tmpdir(), 'simacl-'));
const patched = join(dir, 'mqtt_auth.py');
copyFileSync(root + SERVER_PY, patched);
const src = readFileSync(patched, 'utf8');
const marker = '    sub = [inbox]\n';
assert.equal(src.split(marker).length, 2, 'patch point in mqtt_acl');
writeFileSync(patched, src.replace(marker, marker + '    sub.append("sim/followed-the-server")\n'));
const changed = decodeToken(call(createMockApi({ log() {}, profile, serverAcl: serverAclFrom(patched) }), tokenRequest()).body.token);
assert.ok(aclView(changed.acl).sub.includes('sim/followed-the-server'), 'a change in api/chat/mqtt_auth.py shows up in the simulation');
console.log('PASS the simulated token ACL is computed by api/chat/mqtt_auth.py mqtt_acl (and follows changes to it)');

// ── 1b. 範圍驗證＝伺服器的 mqtt_scope（W3：群組主題 id 剛好 22 字元）──
{
  const strict = createMockApi({ log() {}, profile, serverAcl });
  for (const bad of ['+', '#', 'A'.repeat(21), 'A'.repeat(23), 'A'.repeat(21) + '+', 'A'.repeat(10) + '/' + 'A'.repeat(11), 'group-1', '']) {
    const r = call(strict, tokenRequest({ groups: [TID, bad] }));
    assert.deepEqual([r.status, r.body.detail], [400, 'invalid_acl_groups'], `group topic ${JSON.stringify(bad)} refused like on the server`);
  }
  const tooMany = call(strict, tokenRequest({ groups: Array.from({ length: 51 }, (_, i) => `${String(i).padStart(2, '0')}${'A'.repeat(20)}`) }));
  assert.equal(tooMany.status, 422, 'more than 50 group topics → 422 (pydantic max_length on the server)');
  assert.ok([...strict.rejected.keys()].some((k) => k.includes('invalid_acl_groups')), 'refusals are recorded (the run\'s API-AUTH check fails on them)');
  // 改伺服器的規則（暫存複本：長度 21）→ 模擬跟著變
  const p2 = join(dir, 'mqtt_auth21.py');
  const src21 = readFileSync(root + SERVER_PY, 'utf8');
  const re22 = 'MQTT_GROUP_TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")';
  assert.equal(src21.split(re22).length, 2, 'the server regex is where the simulator expects it');
  writeFileSync(p2, src21.replace(re22, re22.replace('{22}', '{21}')));
  const follows = call(createMockApi({ log() {}, profile, serverAcl: serverAclFrom(p2) }), tokenRequest({ groups: ['A'.repeat(21)] }));
  assert.equal(follows.status, 200, 'a change of the server regex shows up in the simulation');
  console.log('PASS the simulated token scope is validated by api/chat/mqtt_auth.py mqtt_scope (22-char topic ids; follows changes to it)');
}

// ── 1c. presence（W4）──
{
  const strict = createMockApi({ log() {}, profile, serverAcl });
  const peers = call(strict, tokenRequest({ peers: [friend] }));
  assert.equal(peers.status, 422, 'the old peers field (public keys) is refused');
  for (const bad of [`mist/user/${url(friend)}/presence`, `mist/user/${url(friend)}/presence/+`, `mist/user/+/presence/${TAG}`, `mist/user/${url(friend)}/#`]) {
    const r = call(strict, tokenRequest({ presence: [FTOPIC, bad] }));
    assert.deepEqual([r.status, r.body.detail], [400, 'invalid_acl_presence'], `presence topic ${bad} refused like on the server`);
  }
  const badTag = call(strict, tokenRequest({ presence_tag: 'A'.repeat(21) + '+' }));
  assert.deepEqual([badTag.status, badTag.body.detail], [400, 'invalid_acl_presence_tag']);
  const noPresence = call(strict, tokenRequest({ presence: undefined }));
  assert.equal(noPresence.status, 422, 'presence is required');
  console.log('PASS the simulated presence scope: no peers (422), exact topics only (400), my tag validated');
}

// ── 1d. 多的欄位 → 422，用的是伺服器的欄位表（開源第 6 步：模擬裡沒有抄的那一份了）──
{
  const src0 = readFileSync(root + SERVER_PY, 'utf8');
  const fields = /^MQTT_TOKEN_REQUEST_FIELDS = \(([^)]*)\)/m.exec(src0);
  assert.ok(fields && fields[1].includes('"device_id"'), 'the server\'s field list is where the simulator expects it');
  const p3 = join(dir, 'mqtt_auth_fields.py');
  writeFileSync(p3, src0.replace(fields[0], fields[0].replace('"device_id"', '"device_id", "peers"')));
  const loose = call(createMockApi({ log() {}, profile, serverAcl: serverAclFrom(p3) }), tokenRequest({ peers: [friend] }));
  assert.equal(loose.status, 200, `a field the server's list allows passes the simulator too: ${JSON.stringify(loose.body)}`);
  const strict = call(createMockApi({ log() {}, profile, serverAcl }), tokenRequest({ peers: [friend] }));
  assert.deepEqual([strict.status, strict.body.detail], [422, 'extra_forbidden:peers'], 'the real list refuses it');
  console.log('PASS extra token-request fields are judged by the server\'s own field list (and follow changes to it)');
}

// ── 2. subscribe／serverTime ──
assert.deepEqual(ok.body.subscribe, aclView(claims.acl).sub);
assert.ok(Math.abs(ok.body.serverTime - Date.now() / 1000) < 5);
const transfer = JSON.parse(api.handle('POST', '/api/mqtt/transfer-token', '').body);
assert.deepEqual(decodeToken(transfer.token).acl, serverAcl({ username: transfer.username, receive_only: true }).claim, 'transfer token ACL from the server too');
assert.deepEqual(transfer.subscribe, [`mist/user/${transfer.username}/inbox/+`]);
console.log('PASS responses carry subscribe and serverTime; the transfer token ACL comes from the server as well');

// ── 3. kick 主題只給 claim 過的那台 ──
assert.ok(!view.sub.some((t) => t.startsWith('aegis/device/')), 'no claim → no kick topic (E2E mode never claims)');
assert.equal(api.handle('POST', '/api/devices/claim', JSON.stringify({ pubkey: me.pk, device_id: DEVICE })).status, 403, 'no account → claim 403');
assert.equal(register(api, me).status, 200);
assert.equal(api.handle('POST', '/api/devices/claim', JSON.stringify({ pubkey: me.pk, device_id: DEVICE })).status, 200);
assert.ok(aclView(decodeToken(call(api, tokenRequest()).body.token).acl).sub.includes(`aegis/device/${DEVICE}/kicked`), 'claimed device gets its kick topic');
api.handle('POST', '/api/devices/claim', JSON.stringify({ pubkey: me.pk, device_id: 'ffffffff-8a2d-4c3b-9e7f-1234567890ab' }));
const replaced = call(api, tokenRequest());
assert.deepEqual([replaced.status, replaced.body.detail], [403, 'device_replaced'], 'the replaced device gets no token');
console.log('PASS kick topic only for the claimed device; a replaced device is refused (as on the server)');

// ── 4. 時鐘差 ──
const skew = call(api, tokenRequest({ timestamp: Math.floor(Date.now() / 1000) - 3600 }));
assert.equal(skew.status, 401);
assert.equal(skew.body.detail.code, 'clock_skew');
assert.ok(Math.abs(skew.body.detail.server_time - Date.now() / 1000) < 5);
console.log('PASS clock skew is answered with the server time');

// ── 5. 沒有複本 ──
const profilesSrc = readFileSync(root + 'scripts/sim/lib/profiles.mjs', 'utf8');
assert.ok(!/mist\/user\/\+\/inbox|function talkAcl/.test(profilesSrc), 'profiles.mjs has no copy of the AegisTalk ACL');
const mockSrc = readFileSync(root + 'scripts/sim/lib/mockApi.mjs', 'utf8');
assert.ok(!/TALK_TOKEN_FIELDS|'presence_tag', 'device_id'\]/.test(mockSrc), 'mockApi.mjs has no copy of the token request fields');
// 開源第 6 步：local-run.sh（這台機器上跑）一定在；remote-run.sh（送到建置機）只在作者的 repo
const runners = ['scripts/sim/local-run.sh', 'scripts/sim/remote-run.sh'].filter((f) => existsSync(root + f));
assert.ok(runners.includes('scripts/sim/local-run.sh'), 'scripts/sim/local-run.sh is there');
for (const f of runners) {
  const appPaths = (readFileSync(root + f, 'utf8').match(/^APP_PATHS=\(([^)]*)\)/m)?.[1] ?? '').split(/\s+/);
  assert.ok(appPaths.includes('api/chat'), `${f} stages the chat server (api/chat) with the app`);
  assert.ok(appPaths.includes('api/group_log_routes.py'), `${f} stages the real group log routes the simulated API serves (W1)`);
}
console.log(`PASS no copied ACL or request rules left in the simulator; ${runners.map((f) => f.split('/').pop()).join(' and ')} stage api/chat and api/group_log_routes.py`);

// ── 6. rules 格式：模擬 broker 照規則放行（retain 只准自己的 presence 主題）──
{
  const acl = claims.acl;
  const mine = `mist/user/${url(me.pk)}/presence/${TAG}`;
  const inboxOfFriend = `mist/user/${url(friend)}/inbox/${url(me.pk)}`;
  assert.ok(aclAllows(acl, 'publish', mine, { retain: true }) && aclAllows(acl, 'publish', mine, { retain: false }), 'my presence: retained or not');
  assert.ok(aclAllows(acl, 'publish', inboxOfFriend) && !aclAllows(acl, 'publish', inboxOfFriend, { retain: true }), 'inbox: not retained only');
  assert.ok(aclAllows(acl, 'publish', `mist/group/${TID}/${url(me.pk)}`) && !aclAllows(acl, 'publish', `mist/group/${TID}/${url(me.pk)}`, { retain: true }), 'group: not retained only');
  assert.ok(!aclAllows(acl, 'publish', `mist/user/${url(friend)}/inbox/${url(friend)}`), "someone else's slot refused");
  assert.ok(!aclAllows(acl, 'publish', FTOPIC, { retain: true }), "a friend's presence topic refused");
  assert.ok(aclAllows(acl, 'subscribe', FTOPIC) && !aclAllows(acl, 'subscribe', '#') && !aclAllows(acl, 'subscribe', 'mist/user/+/presence/+'), 'subscriptions');
  assert.deepEqual(acl.at(-1), { permission: 'deny', action: 'all', topic: '#' }, 'deny-all last');
  // legacy 格式也照舊讀得懂（群星的 profile 還是 {pub, sub, all}）
  assert.ok(aclAllows({ pub: [mine], sub: [], all: [] }, 'publish', mine, { retain: true }) && !aclAllows({ pub: [mine], sub: [], all: [] }, 'subscribe', mine));
  console.log('PASS the token is in the rules format and the simulated broker enforces it: retain only on my own presence topic, inbox/group retained refused, deny-all last');
}

// ── 7. keys-only 帳號 ──
{
  const strict = createMockApi({ log() {}, profile, serverAcl });
  const alice = keypair();
  const bob = keypair();
  const sc = (who) => {
    const spk = Buffer.alloc(32, 7).toString('base64');
    const f = { action: 'register_shortcode', public_key: who.pk, signed_pre_key: spk, signature: who.sign(Buffer.from(spk, 'base64')),
      display_name: 'x', timestamp: Math.floor(Date.now() / 1000), request_id: `sc-${++n}-0123456789abcdef` };
    return strict.handle('POST', '/api/shortcode/register', JSON.stringify({ ...f, request_signature: who.sign(JSON.stringify(canonical(f))) }));
  };
  const push = (who, to) => {
    const f = { action: 'push_notify', pubkey: who.pk, recipient_pubkey: to.pk, notificationHint: { type: 'message' },
      timestamp: Math.floor(Date.now() / 1000), request_id: `push-${++n}-0123456789abcdef` };
    return strict.handle('POST', '/api/push/notify', JSON.stringify({ ...f, signature: who.sign(JSON.stringify(canonical(f))) }));
  };
  assert.equal(sc(alice).status, 403, 'short code without an account');
  assert.equal(push(alice, bob).status, 403, 'push without an account');
  assert.equal(strict.handle('POST', '/api/devices/claim', JSON.stringify({ pubkey: alice.pk, device_id: DEVICE })).status, 403);
  assert.ok([...strict.rejected.keys()].some((k) => k.includes('account_not_registered')), 'recorded for API-AUTH');
  const r = register(strict, alice);
  assert.deepEqual([r.status, r.body.created], [200, true]);
  assert.equal(strict.handle('POST', '/api/account/register', JSON.stringify({ ...r.fields, signature: alice.sign(JSON.stringify(canonical(r.fields))) })).status, 409, 'replay');
  assert.equal(register(strict, alice).body.created, false, 'already registered');
  const forged = register(strict, bob, { pubkey: alice.pk });
  assert.equal(forged.status, 401, "a key cannot register for someone else's key");
  assert.equal(sc(alice).status, 200, 'short code with an account (signed request + pre-key signature)');
  {
    const spk = Buffer.alloc(32, 9).toString('base64');
    const f = { action: 'register_shortcode', public_key: alice.pk, signed_pre_key: spk, signature: alice.sign(Buffer.from(spk, 'base64')),
      display_name: 'x', timestamp: Math.floor(Date.now() / 1000) };
    const r = strict.handle('POST', '/api/shortcode/register', JSON.stringify({ ...f, request_signature: alice.sign(JSON.stringify(canonical(f))) }));
    assert.equal(r.status, 422, 'short code without a request_id → 422 (as the server)');
  }
  assert.equal(JSON.parse(push(alice, bob).body).reason, 'recipient_not_registered', 'recipient without an account (as on the server)');
  register(strict, bob);
  assert.equal(push(alice, bob).status, 200);
  assert.equal(strict.accountOf(alice.pk)?.startsWith('chat_'), true, 'group-log accounts come from the registry');
  assert.equal(strict.accountOf(keypair().pk), null);
  console.log('PASS keys-only accounts in the mock API: register (signed, replay 409, foreign key 401); without an account claim/push/short code 403 (recorded); recipient_not_registered');
}

// ── 8. 開源第 4 步：推播／信任分數也用校正到伺服器的時鐘簽 → 模擬 API 照這一支聽到的時間判；差太多回 clock_skew（不算拒收）；
//     社群版只收 message／incoming_call；Web Push 的登記照伺服器（帳戶簽章、多的欄位 422）──
{
  const api2 = createMockApi({ log() {}, profile, serverAcl });
  const alice = keypair();
  const bob = keypair();
  register(api2, alice);
  register(api2, bob);
  const push = (hint, ts = Math.floor(Date.now() / 1000), who = null) => {
    const f = { action: 'push_notify', pubkey: alice.pk, recipient_pubkey: bob.pk, notificationHint: hint, timestamp: ts, request_id: `p8-${++n}-0123456789abcdef` };
    return api2.handle('POST', '/api/push/notify', JSON.stringify({ ...f, signature: alice.sign(JSON.stringify(canonical(f))) }), '', who);
  };
  const r1 = push({ type: 'message' }, Math.floor(Date.now() / 1000) - 900);
  assert.equal(r1.status, 401);
  assert.equal(JSON.parse(r1.body).detail.code, 'clock_skew', 'a push signed 15 min off → clock_skew with the server time');
  assert.equal(api2.rejected.size, 0, '…which is not counted as a rejection (the app re-signs)');
  assert.equal(api2.clockSkewed.get('POST /api/push/notify'), 1);
  assert.equal(push({ type: 'message' }).status, 200, 're-signed on the server time → accepted');
  api2.serverTimeSkew.set('Alice', -30 * 60_000);
  assert.equal(push({ type: 'message' }, Math.floor(Date.now() / 1000) - 1800, 'Alice').status, 200,
    'a phone the operator lies to signs on the lie and is judged on it (consistent)');
  for (const type of ['guardian_alert', 'check_in']) {
    assert.equal(push({ type }).status, 422, `community chat server: ${type} → 422`);
  }
  assert.ok([...api2.rejected.keys()].some((k) => k.includes('hint:')), 'recorded for API-AUTH');
  const wp = (over = {}) => {
    const f = { action: 'webpush_register', pubkey: alice.pk, endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22),
      timestamp: Math.floor(Date.now() / 1000), request_id: `wp-${++n}-0123456789abcdef`, ...over };
    return api2.handle('POST', '/api/push/webpush/register', JSON.stringify({ ...f, signature: alice.sign(JSON.stringify(canonical(f))) }));
  };
  assert.equal(wp().status, 200, 'web push registration: signed by the account key');
  assert.equal(wp({ extra: 1 }).status, 422, 'extra field → 422');
  assert.equal(api2.webpushSubs.get('https://fcm.googleapis.com/fcm/send/x'), alice.pk);
  assert.equal(JSON.parse(api2.handle('GET', '/api/chat/server-config', '').body).vapid_public_key, null, 'server-config: no Web Push in the simulation');
  console.log('PASS push / trust judged on the server-corrected clock with clock_skew (not a rejection); community push types; signed Web Push registration');
}

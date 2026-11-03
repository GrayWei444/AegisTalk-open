/**
 * W2（docs/GROUP_LOG_WIRING_W2.md）：群組主題上的 group_sealed 控制訊息。真的引擎＋存檔＋log client＋api/group_log_routes.py
 * （groupEngineKit），加上真的 mqtt.ts 與 groupControlRoute（App 那一段）。
 *   1. 來回（App 那條路）：engine.sendControl → 真的 mqtt.sendToGroup → 收端真的 mqtt.handleMessage（主題由收端填進訊息）
 *      → groupControlSource（主題 id、寄件人取自主題；W3：主題是 tid，沒有 gid）→ engine.onControl → 驗過的 delete／call
 *      交給 App；線上只有 {n, c}（W3 審查 M3：沒有 kid）；沒連上不排隊（W3）
 *   2. 丟掉：名冊外的人（就算拿到目前這一代的金鑰也不解密）、偽造（掛別人的主題、簽別人的名）、重放、過期、未來時間、
 *      別的一代封的（W3：主題決定是哪一代，用那一代的金鑰拆不開）；換金鑰之後：上一代主題上、現在的成員送的晚到訊息
 *      在重疊期內照收（W3），被踢的人送的不解密，過了重疊期那個主題就不在表上（unknown-topic）
 *   3. head 交叉比對：伺服器給某人的 log 弄壞一筆 → 成員的 here 對不上 → 畫面警告（Group.logConflict）→ 問伺服器、重建 →
 *      之後一致就清掉；成員亂報 head → 警告、不重建，他之後報對了就清掉
 *   4. 邀請回條與重送：第一封丟了 → 30 秒後重送 → 加入、回條 → 不再送；一直沒回條 → 共送 6 次就放棄並通知畫面；
 *      回條丟了但對方在群組主題上發了訊息（加入後的 sync）→ 算收到；已經加入又收到同一份 → 再回一次條、不存
 *   5. 在本機忘掉群組：拿不到目前那一代的金鑰、離開不了 → forgetGroup 只刪本機（log 上沒有多一筆），別人照常，重開不會回來
 *   6. 有人離開、等 admin 換金鑰（needsRekey）：控制訊息先留著、一則都不用離開的人手上的金鑰送；換金鑰套上後用新的一代送出
 *      （通話信令留超過 60 秒就丟）
 *   7. 群組通話走密封的路：call 只帶 {action, video}；群名、自稱的 id 封不進去
 *   8. here 只在真的上線時發（App 看 mqtt 的 tokenSwap）；引擎還沒載完就連上 → 載完再發
 * Run: node scripts/review/group_control_w2_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { World, E } from './groupEngineKit.mjs';
import { SRC, verify } from './groupStateKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'gctlw2-'));

// ── 真的 mqtt.ts（stub 掉 mqtt.js、IDB、裝置 id）與 groupControlRoute ──
globalThis.__clients = [];
const mqttStub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^mqtt$|sealedSender$|utils\/devLog$|utils\/diagLog$|deviceId$|outgoingQueueStore$|^\.\/database$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents:
    a.path === 'mqtt' ? 'export default { connect() { throw new Error("not used"); } };'
    : a.path.includes('sealedSender') ? 'export async function unsealMessageBase64(){ throw new Error("not used") }'
    : a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
    : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
    : a.path.includes('database') ? 'export async function getSetting(){ return null }'
    : a.path.includes('deviceId') ? 'export const getDeviceIdSync=()=>"0b6f4c1e-8a2d-4c3b-9e7f-1234567890ab";'
    : `let n = 0; export const makeOutgoingId=()=>"o"+(++n);
       export async function persistOutgoing(){} export async function removeOutgoing(){} export async function loadAllOutgoing(){ return [] }` }));
} };
await build({ entryPoints: [`${SRC}/services/mqtt.ts`], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'mqtt.mjs'),
  logLevel: 'silent', plugins: [mqttStub], define: { 'import.meta.env': '{}' } });
await build({ entryPoints: [`${SRC}/services/groupControlRoute.ts`], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs'), logLevel: 'silent' });
globalThis.window = undefined;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const mqttA = await import(pathToFileURL(join(dir, 'mqtt.mjs')) + '?a');
const mqttB = await import(pathToFileURL(join(dir, 'mqtt.mjs')) + '?b');
const route = await import(pathToFileURL(join(dir, 'route.mjs')));

const world = new World();
const serverHead = async (gid) => JSON.parse((await world.server.handle('GET', `/api/group-log/${gid}`, '?after=0&limit=1', '')).body).head;
const since = (mark, from, gid) => world.controlLog.slice(mark).filter((e) => e.from === from.pk && (!gid || e.gid === gid));
const stat = (p, k) => p.engine.controlStats()[k] ?? 0;
const sealAs = (who, p) => E.CTL.sealControl({ ts: world.now(), ...p, sender: who.pk, sign: who.id.sign });
const quiet = console.error;
console.error = (...a) => { if (!/^\[(group(Engine|Control|Invite)|MQTT)\]/.test(String(a[0]))) quiet(...a); };
try {
  const [A, B, C, D, O] = await Promise.all(['alice', 'bob', 'carol', 'dave', 'olga'].map((l) => world.phone(l)));
  for (const x of [B, C, D]) world.befriend(A, x);
  for (const p of [A, B, C, D, O]) await p.boot();
  const g = await A.engine.createGroup({ name: 'Secret Family', members: [B.pk, C.pk, D.pk] });
  await world.settle();
  for (const p of [B, C, D]) assert.deepEqual(p.roster(g), [A.pk, B.pk, C.pk, D.pk].sort(), `${p.label} joined`);

  // ── 1. App 那條路 ──
  {
    const svcA = mqttA.mqttService;
    const svcB = mqttB.mqttService;
    const wire = [];
    svcA.publicKeyBase64 = A.pk;
    svcA.client = { connected: true, publish: (topic, payload, opts) => wire.push({ topic, payload, opts }), subscribe() {}, unsubscribe() {} };
    svcB.publicKeyBase64 = B.pk;
    const delivered = [];
    svcB.onMessage(mqttB.MessageType.GROUP_SEALED, (m) => delivered.push(m));
    A.shutdown();
    await A.boot({ publish: (tid, envelope, opts) => svcA.sendToGroup(tid, mqttA.MessageType.GROUP_SEALED, envelope, opts) });
    await world.settle();
    assert.ok(wire.length === 1 && wire[0].opts.qos === 0, 'an engine started while connected announces a here (QoS0)');
    wire.length = 0;
    assert.equal(await A.engine.sendControl(g, 'delete', { messageId: 'msg-secret-123' }), 'sent');
    assert.equal(await A.engine.sendControl(g, 'call', { action: 'start', video: true }), 'sent');
    assert.equal(wire.length, 2);
    const tidA = A.tidOf(g);
    assert.ok(tidA && tidA !== g && /^[A-Za-z0-9_-]{22}$/.test(tidA), 'the group topic is a 22-char topic id, not the gid');
    for (const w of wire) {
      assert.equal(w.topic, `mist/group/${tidA}/${A.pk.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`, 'on my own sender segment of the epoch topic');
      assert.ok(!w.topic.includes(g) && !w.payload.includes(g), 'the gid is nowhere on the wire');
      assert.equal(w.opts.qos, 1);
      const outer = JSON.parse(w.payload);
      assert.deepEqual(Object.keys(outer).sort(), ['from', 'payload', 'timestamp', 'type']);
      assert.equal(outer.type, 'group_sealed');
      assert.deepEqual(Object.keys(outer.payload).sort(), ['c', 'n'], 'only {n, c} on the wire (no kid: W3 M3)');
      for (const secret of ['msg-secret-123', 'Secret Family', 'start', 'video', C.pk, D.pk]) assert.ok(!w.payload.includes(secret), `nothing readable on the wire (${secret.slice(0, 12)})`);
    }
    // 收端：真的 handleMessage 把實際的主題填進訊息（payload 自帶的 topic 蓋掉）→ groupControlSource → 引擎
    for (const w of wire) {
      const forgedTopic = JSON.stringify({ ...JSON.parse(w.payload), topic: `mist/group/${'X'.repeat(22)}/x` });
      svcB.handleMessage(w.topic, Buffer.from(forgedTopic));
    }
    const urlOf = (pk) => pk.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    svcB.handleMessage(`mist/user/${urlOf(B.pk)}/inbox/${urlOf(A.pk)}`, Buffer.from(wire[0].payload));   // group_sealed 不走收件箱（寄件人那一節是對的）
    assert.equal(delivered.length, 2, 'both arrive through the real receive path, the inbox copy is dropped');
    for (const m of delivered) {
      const src = route.groupControlSource(m);
      assert.deepEqual([src.tid, src.from], [tidA, A.pk], 'topic id and sender come from the actual topic');
      assert.ok(!('gid' in src), 'the route knows no gid (only the engine maps tid → group)');
      assert.equal(await B.engine.onControl(src.tid, src.from, src.envelope), 'ok');
    }
    assert.equal(route.groupControlSource({ ...delivered[0], topic: `mist/group/${tidA}/${'Z'.repeat(43)}` }), null, 'a topic sender that is not the from is refused');
    assert.equal(route.groupControlSource({ ...delivered[0], topic: 'mist/group/short/x' }), null);
    const urlA = A.pk.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const bad of ['short', 'A'.repeat(21), 'A'.repeat(23), '+', '#', 'group-1760000000000-abc1234']) {
      assert.equal(route.groupControlSource({ ...delivered[0], topic: `mist/group/${bad}/${urlA}` }), null, `a topic id that is not 22 URL-safe chars is refused (${bad})`);
    }
    assert.deepEqual(B.controls.map((c) => [c.gid, c.from, c.t, JSON.stringify(c.body)]),
      [[g, A.pk, 'delete', '{"messageId":"msg-secret-123"}'], [g, A.pk, 'call', '{"action":"start","video":true}']], 'verified delete and call handed to the app');
    const calls = [];
    const deletes = [];
    for (const c of B.controls) route.routeGroupControl(c.gid, c.from, c.t, c.body, { onCall: (...x) => calls.push(x), onDelete: (...x) => deletes.push(x) });
    assert.deepEqual(deletes, [[g, A.pk, 'msg-secret-123']]);
    assert.deepEqual(calls, [[g, A.pk, { action: 'start', video: true }]]);
    // 沒連上：QoS0、QoS1 都不送、不排隊（W3：排著的是用當時那一代封的；引擎留著、連上再用那時的這一代重封）
    svcA.client = { connected: false, publish() { throw new Error('offline'); }, subscribe() {}, unsubscribe() {} };
    const queued = svcA.outgoingQueue.length;
    assert.equal(svcA.sendToGroup(tidA, mqttA.MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }, { qos: 0 }), false);
    assert.equal(svcA.sendToGroup(tidA, mqttA.MessageType.GROUP_SEALED, { k: 'k', n: 'n', c: 'c' }, { qos: 1 }), false);
    assert.equal(svcA.outgoingQueue.length, queued, 'nothing on a group topic is queued while offline');
    A.shutdown();
    await A.boot();
    B.controls.length = 0;
    console.log('PASS app path: engine → real mqtt.sendToGroup (epoch topic id, no gid) → real handleMessage (topic from the wire) → groupControlSource (tid) → engine → app; only {n, c} on the wire; nothing queued offline');
  }

  // ── 2. 丟掉的 ──
  const kid1 = A.activeKid(g)[0];
  const key1 = A.engine.decryptKey(g, kid1);
  const toB = async (from, envelope, tid = B.tidOf(g)) => B.engine.onControl(tid, from.pk, envelope);
  {
    const del = (who, id, over = {}) => sealAs(who, { gid: g, kid: kid1, key: key1, t: 'delete', body: { messageId: id }, ...over });
    // 名冊外的人：就算拿到目前這一代的金鑰，不解密就丟
    const decryptsBefore = stat(B, 'decrypt');
    assert.equal(await toB(O, (await del(O, 'x1')).envelope), 'non-member');
    assert.equal(stat(B, 'decrypt'), decryptsBefore, 'not even decrypted');
    assert.equal(stat(B, 'dropped:bad-envelope'), 0);
    // 偽造：C 的信封掛在 A 的主題；C 自稱 A 但簽自己的名
    assert.equal(await toB(A, (await del(C, 'x2')).envelope), 'bad-envelope', 'someone else\'s envelope relabelled with my sender segment');
    const impostor = await E.CTL.sealControl({ gid: g, kid: kid1, key: key1, sender: A.pk, sign: C.id.sign, t: 'delete', body: { messageId: 'x3' }, ts: world.now() });
    assert.equal(await toB(A, impostor.envelope), 'bad-envelope', 'a member signing in another member\'s name');
    // 重放、過期、未來
    const real = await del(C, 'x4');
    assert.equal(await toB(C, real.envelope), 'ok');
    assert.equal(await toB(C, real.envelope), 'replay', 'the same envelope twice');
    assert.equal(await toB(C, (await del(C, 'x5', { ts: world.now() - 25 * 3_600_000 })).envelope), 'stale', 'a delete older than 24 h');
    assert.equal(await toB(C, (await sealAs(C, { gid: g, kid: kid1, key: key1, t: 'call', body: { action: 'start', video: false }, ts: world.now() - 3 * 60_000 })).envelope), 'stale', 'a call start older than 2 min');
    assert.equal(await toB(C, (await del(C, 'x6', { ts: world.now() + 10 * 60_000 })).envelope), 'stale', 'a message from the future');
    assert.deepEqual(B.controls.map((c) => c.body.messageId), ['x4'], 'only the one genuine, fresh, first copy reached the app');
    // 封的時候說是別的一代（W3：信封上沒有 kid，kid 綁在 AAD 裡；主題那一代的金鑰拆不開）：丟掉、也不收著
    const future = await sealAs(C, { gid: g, kid: 'not-an-epoch-of-this-chain', key: key1, t: 'delete', body: { messageId: 'x7' } });
    assert.equal(await toB(C, future.envelope), 'bad-envelope');
    const decryptsWrong = stat(B, 'decrypt');
    assert.equal(await toB(C, (await del(C, 'x7b')).envelope, 'A'.repeat(22)), 'unknown-topic', 'a topic id that is not on my table');
    assert.equal(await toB(C, (await del(C, 'x7c')).envelope, g), 'unknown-topic', 'the gid itself is not a topic');
    assert.equal(stat(B, 'decrypt'), decryptsWrong, 'unknown topics are not decrypted');
    // 換金鑰：A 踢掉 D
    const tid1 = B.tidOf(g);
    const beforeRekey = await del(C, 'x8');
    const markR = world.controlLog.length;
    assert.equal(await A.engine.removeMember(g, D.pk), 'applied');
    await world.settle();
    const kid2 = A.activeKid(g)[0];
    const tid2 = B.tidOf(g);
    // commit 通知用那筆 entry 本身的那一代（踢人＝上一代）、發在上一代的主題上、在 A 切換之前：被踢的人看得懂通知
    //   （本來就打得開那筆 entry），馬上去抓、知道自己被踢了
    const notes = [];
    for (const e of since(markR, A, g)) notes.push({ kid: e.kid, tid: e.tid, m: await A.peekControl(e) });
    const removeNote = notes.find((x) => x.m?.t === 'commit');
    assert.ok(removeNote && removeNote.kid === kid1 && removeNote.tid === tid1,
      `the remove is announced under the epoch its log entry was sealed with, on that epoch's topic (${JSON.stringify(notes.map((x) => [x.kid === kid1, x.tid === tid1, x.m?.t]))})`);
    assert.ok(!D.groups.has(g), 'the removed member learned of its removal right away');
    assert.ok(!D.everSubscribed.has(tid2), 'and never subscribed to the new topic');
    assert.notEqual(kid2, kid1);
    assert.notEqual(tid2, tid1, 'a new epoch → a new topic');
    assert.deepEqual(B.activeKid(g), [kid2]);
    assert.deepEqual(B.topicsOf(g).map((t) => [t.tid, t.current]), [[tid2, true], [tid1, false]], 'the previous topic stays on the table during the overlap');
    // 上一代：在新一代的主題上 → 用新一代的金鑰拆不開（從不拿舊金鑰去拆新主題上的東西）；在上一代的主題上（重疊期內）、
    //   現在的成員送的 → 照收（還沒換過來的人的晚到訊息）；被踢的人 → 不解密
    assert.equal(await toB(C, beforeRekey.envelope, tid2), 'bad-envelope', 'an old-epoch envelope on the new topic does not open');
    const decryptsOld = stat(B, 'decrypt');
    assert.equal(await toB(D, (await del(D, 'x10')).envelope, tid1), 'non-member', 'the removed member with the old key, on the old topic');
    assert.equal(stat(B, 'decrypt'), decryptsOld, 'not decrypted');
    assert.equal(await toB(C, beforeRekey.envelope, tid1), 'ok', 'a late message of the previous epoch from a current member is accepted on the previous topic');
    assert.equal(stat(B, 'opened-previous:delete'), 1);
    world.offset += 10 * 60_000 + 1_000;
    assert.equal(await A.engine.updateInfo(g, { name: 'Secret Family 2' }), 'applied');   // 鏈變了 → 主題表重算（已過了重疊期）
    await world.settle();
    assert.deepEqual(B.topicsOf(g).map((t) => t.tid), [tid2], 'after the overlap only the current topic is left');
    assert.ok(!B.subs.has(tid1), 'and the previous topic is unsubscribed');
    assert.equal(await toB(C, (await del(C, 'x9')).envelope, tid1), 'unknown-topic', 'the expired topic is no longer mapped to the group');
    assert.deepEqual(B.controls.map((c) => c.body.messageId), ['x4', 'x8'], 'only the genuine, fresh, first copies reached the app');
    B.controls.length = 0;
    console.log('PASS dropped: non-member (not decrypted, even with the key), forged sender/signature, replayed, stale, future, wrong epoch for the topic, unknown topic; previous-epoch late messages accepted during the overlap only');
  }

  // ── 3. head 交叉比對 ──
  {
    const s = await serverHead(g) + 1;
    const flip = (blob) => { const o = JSON.parse(blob); o.n = Buffer.from(Buffer.from(o.n, 'base64').map((x) => x ^ 0xff)).toString('base64'); return JSON.stringify(o); };
    world.fetchFilter = (phone, gid, entries) => (phone === B && gid === g ? entries.map((e) => (e.seq === s ? { ...e, blob: flip(e.blob) } : e)) : entries);
    assert.equal(await A.engine.updateInfo(g, { name: 'Renamed for everyone' }), 'applied');
    await world.settle();
    world.fetchFilter = null;
    assert.equal(B.groups.get(g).name, 'Secret Family 2', 'the server garbled that entry for B');
    assert.equal(C.groups.get(g).name, 'Renamed for everyone');
    // W5：A 的 commit 通知報的 head 在 B 處理過、卻沒套上的那一號 → B 抓完就警告（head-differs）；重建等下一則對不上的 head
    assert.ok(B.groups.get(g).logConflict, 'B already warns after catching up past the seq A reported (W5 checkBehind)');
    assert.ok(!B.notices.some((n) => n.reason === 'server-changed-history' || n.reason === 'peer-disagrees'), 'but asks the server only on the next disagreeing head');
    C.engine.announce();          // C 的 here：同一個 seq，B 跳過了、C 套上了 → 對不上
    await world.settle();
    assert.ok(B.conflictSeen.has(g), 'B\'s screen showed the conflict warning');
    assert.ok(B.notices.some((n) => n.kind === 'conflict' && n.reason === 'server-changed-history'), JSON.stringify(B.notices.slice(-3)));
    assert.equal(B.groups.get(g).name, 'Renamed for everyone', 're-fetched from the base and rebuilt');
    assert.deepEqual(B.engine.gossip(g), C.engine.gossip(g));
    world.offset += 16_000;
    C.engine.announce();          // 之後 C 報來一致的 head → 警告清掉
    await world.settle();
    assert.ok(!B.groups.get(g).logConflict, 'the warning clears once that member reports the same head');
    // 成員亂報：警告、不重建；他之後報對了就清掉
    world.offset += 61_000;
    const firstSeq = B.sql('SELECT first_seq FROM group_log_state WHERE gid = ?', [g])[0].first_seq;
    const full = () => B.fetchCount.get(`${g}|${firstSeq}`) ?? 0;
    const fullBefore = full();
    assert.ok(!B.groups.get(g).logConflict);
    B.engine.onGossip(g, { seq: C.engine.gossip(g).seq, id: 'cd'.repeat(32) }, C.pk);
    await world.settle();
    assert.equal(B.groups.get(g).logConflict, true, 'a member\'s conflicting head is shown');
    assert.equal(full(), fullBefore, 'but does not trigger a rebuild when the server agrees with me');
    B.engine.onGossip(g, C.engine.gossip(g), C.pk);
    await world.settle();
    assert.ok(!B.groups.get(g).logConflict, 'cleared when the same member reports the right head');
    world.offset += 61_000;       // 重建的一分鐘限制已過：名冊外的人說的 head 也不能觸發核對或重建
    const conflictNotices = B.notices.filter((n) => n.kind === 'conflict').length;
    const seqNow = C.engine.gossip(g).seq;
    const probes = () => B.fetchCount.get(`${g}|${seqNow - 1}`) ?? 0;
    const probesBefore = probes();
    B.engine.onGossip(g, { seq: seqNow, id: 'ef'.repeat(32) }, O.pk);
    await world.settle();
    assert.ok(!B.groups.get(g).logConflict, 'a non-member\'s head claim is ignored');
    assert.equal(B.notices.filter((n) => n.kind === 'conflict').length, conflictNotices, 'no conflict check for a non-member');
    assert.equal(probes(), probesBefore, 'and no request to the server');
    console.log('PASS head gossip: a here at the same seq that differs → UI conflict warning, server check, rebuild; cleared once consistent; member lies → warning only');
  }

  // ── 4. 邀請回條與重送 ──
  {
    const [Ev, F, Gm] = await Promise.all(['erin', 'fred', 'gina'].map((l) => world.phone(l)));
    for (const x of [Ev, F, Gm]) { world.befriend(A, x); await x.boot(); }
    const invitesTo = (p) => world.sealedLog.filter((m) => m.kind === 'invite' && m.to === p.pk && m.gid === g);
    const acksFrom = (p) => world.sealedLog.filter((m) => m.kind === 'ack' && m.from === p.pk && m.gid === g);
    const sentRows = () => A.sql("SELECT id, args FROM group_pending_commits WHERE gid = ? AND state = 'sent'", [g]);
    let dropped = false;
    world.sealedFilter = ({ to, body }) => !(to === Ev.pk && body.kind === 'invite' && !dropped && (dropped = true));
    assert.equal(await A.engine.addMember(g, Ev.pk), 'applied');
    await world.settle();
    assert.equal(invitesTo(Ev).length, 1);
    assert.ok(!Ev.groups.has(g), 'the first invite was lost');
    assert.equal(sentRows().length, 1, 'the inviter keeps a row until the invitee acks');
    A.shutdown();                                   // 重送紀錄在資料庫裡：App 重開也照樣重送
    await A.boot();
    await world.settle();
    world.offset += 31_000;
    A.engine.requestSync(g);
    await world.settle();
    assert.equal(invitesTo(Ev).length, 2, 'resent after 30 s');
    assert.ok(Ev.groups.has(g), 'joined with the resent invite');
    assert.equal(acksFrom(Ev).length, 1, 'the invitee acks once it joined');
    assert.equal(sentRows().length, 0, 'the ack clears the row');
    world.offset += 10 * 60_000;
    A.engine.requestSync(g);
    await world.settle();
    assert.equal(invitesTo(Ev).length, 2, 'no more resends after the ack');
    // 已經加入又收到同一份邀請：再回一次條、不存成確認中的邀請
    await world.deliverSealed(A, Ev.pk, invitesTo(Ev).at(-1).body);
    await world.settle();
    assert.equal(acksFrom(Ev).length, 2, 'a duplicate invite after joining is acked again');
    assert.equal(Ev.sql("SELECT COUNT(*) AS n FROM group_pending_commits WHERE state = 'join'")[0].n, 0);
    // 一直沒回條：共送 1 + INVITE_RESEND_MS.length 次就放棄
    world.sealedFilter = ({ to, body }) => !(to === F.pk && body.kind === 'invite');
    assert.equal(await A.engine.addMember(g, F.pk), 'applied');
    await world.settle();
    for (const d of E.INVITE_RESEND_MS) {
      world.offset += d + 1_000;
      A.engine.requestSync(g);
      await world.settle();
    }
    assert.equal(invitesTo(F).length, 1 + E.INVITE_RESEND_MS.length, `bounded resends (${invitesTo(F).length})`);
    assert.ok(A.notices.some((n) => n.kind === 'invite-unacked'), 'the inviter is told the invite was never acknowledged');
    assert.equal(sentRows().length, 0);
    world.offset += 24 * 3_600_000;
    A.engine.requestSync(g);
    await world.settle();
    assert.equal(invitesTo(F).length, 1 + E.INVITE_RESEND_MS.length, 'and stops');
    // 回條丟了，但他加入後在群組主題上發了 sync → 算收到
    world.sealedFilter = ({ from, body }) => !(from === Gm.pk && body.kind === 'ack');
    assert.equal(await A.engine.addMember(g, Gm.pk), 'applied');
    await world.settle();
    assert.ok(Gm.groups.has(g));
    assert.ok(since(0, Gm, g).length >= 1, 'the new member asked everyone for their head (sync)');
    assert.equal(sentRows().length, 0, 'a verified control message from the invitee counts as the ack');
    world.offset += 31_000;
    A.engine.requestSync(g);
    await world.settle();
    assert.equal(invitesTo(Gm).length, 1, 'no resend');
    world.sealedFilter = null;
    console.log(`PASS invites: lost invite resent after 30 s, ack stops resends, duplicate acked again; never acked → ${1 + E.INVITE_RESEND_MS.length} sends then give up; a verified control message counts as the ack`);
  }

  // ── 5. 在本機忘掉群組 ──
  {
    const gF = await A.engine.createGroup({ name: 'Forget me', members: [B.pk, C.pk] });
    await world.settle();
    const kidF = C.activeKid(gF)[0];
    A.shutdown();                                   // 唯一的 admin 不在
    C.shutdown();
    C.db.run('DELETE FROM group_keys WHERE group_id = ?', [gF]);
    await C.boot();
    await world.settle();
    assert.equal(C.groups.get(gF).keyState, 'waiting-key');
    await assert.rejects(C.engine.leave(gF), (e) => e.reason === 'no-key', 'leaving needs the current epoch key');
    const head = await serverHead(gF);
    await C.engine.forgetGroup(gF);
    await world.settle();
    assert.ok(!C.groups.has(gF), 'gone from this device');
    for (const t of ['group_commits WHERE gid', 'group_log_state WHERE gid', 'group_pending_commits WHERE gid', 'group_keys WHERE group_id', 'groups WHERE id']) {
      assert.equal(C.sql(`SELECT COUNT(*) AS n FROM ${t} = ?`, [gF])[0].n, 0, `${t.split(' ')[0]} deleted`);
    }
    assert.ok(C.notices.some((n) => n.gid === gF && n.kind === 'forgotten'));
    assert.equal(await serverHead(gF), head, 'no commit was written');
    assert.ok(B.roster(gF).includes(C.pk), 'the others still list C');
    C.shutdown();
    await C.boot();
    await world.settle();
    assert.ok(!C.groups.has(gF), 'does not come back after a restart');
    void kidF;
    await A.boot();
    await world.settle();
    console.log('PASS forget locally: without the current key (cannot leave) the group is removed from this device only; nothing on the log, others unaffected');
  }

  // ── 6. needsRekey 期間先留著 ──
  {
    const gH = await A.engine.createGroup({ name: 'Hold', members: [B.pk, C.pk] });
    await world.settle();
    const kOld = A.activeKid(gH)[0];
    const keyOld = A.engine.decryptKey(gH, kOld);
    A.shutdown();                                   // 唯一的 admin 不在：沒人換金鑰
    assert.equal(await B.engine.leave(gH), 'applied');
    await world.settle();
    assert.equal(C.groups.get(gH).keyState, 'waiting-admin-rekey', 'C applied the leave (B notified before dropping the group)');
    const mark = world.controlLog.length;
    assert.equal(await C.engine.sendControl(gH, 'delete', { messageId: 'm-held' }), 'held');
    assert.equal(await C.engine.sendControl(gH, 'call', { action: 'start', video: false }), 'held');
    world.offset += 16_000;
    C.engine.announce();
    await world.settle();
    assert.deepEqual(since(mark, C, gH), [], 'nothing is sent under the key the leaver still holds');
    world.offset += 61_000;                         // 留著的通話信令超過 60 秒
    await A.boot();                                 // admin 回來 → 第一順位，馬上換金鑰
    await world.settle();
    const kNew = A.activeKid(gH)[0];
    assert.notEqual(kNew, kOld, 'the admin rotated');
    assert.deepEqual(C.activeKid(gH), [kNew]);
    const out = since(mark, C, gH);
    assert.ok(out.length >= 2, `released after the rekey (${out.length})`);
    assert.ok(out.every((e) => e.kid === kNew), 'released under the new epoch only');
    const kinds = [];
    for (const e of out) kinds.push((await A.peekControl(e))?.t);
    assert.deepEqual(kinds.sort(), ['delete', 'here'], `the delete and the here went out, the stale call did not (${kinds})`);
    assert.equal(stat(C, 'expired:call'), 1);
    assert.ok(A.controls.some((c) => c.gid === gH && c.t === 'delete' && c.body.messageId === 'm-held' && c.from === C.pk), 'the admin received the delete');
    for (const e of out) {
      await assert.rejects(E.CTL.openControl({ envelope: e.envelope, gid: gH, tid: await E.CTL.deriveTopicId(keyOld, gH), sender: C.pk, kid: e.kid, key: keyOld, verify }),
        /groupControl/, 'the leaver\'s key opens none of them');
    }
    assert.equal(await C.engine.sendControl(gH, 'call', { action: 'start', video: false }), 'sent', 'after the rekey control traffic flows again');
    console.log('PASS needsRekey: control traffic held (nothing under the leaver\'s key), released under the new epoch after the admin rekey, stale call signalling dropped');
  }

  // ── 7. 群組通話走密封的路 ──
  {
    const before = C.controls.length;
    assert.equal(await A.engine.sendControl(g, 'call', { action: 'join', video: false }), 'sent');
    await world.settle();
    assert.deepEqual(C.controls.slice(before).map((c) => [c.t, c.from, JSON.stringify(c.body)]), [['call', A.pk, '{"action":"join","video":false}']]);
    await assert.rejects(A.engine.sendControl(g, 'call', { action: 'start', video: false, groupName: 'Secret Family' }), /malformed/, 'no group name inside a call message');
    await assert.rejects(A.engine.sendControl(g, 'call', { action: 'start', video: false, initiatorId: B.pk }), /malformed/, 'no claimed ids');
    await assert.rejects(A.engine.sendControl('Nope_gid_0123456789abc', 'call', { action: 'start', video: false }), (e) => e.reason === 'unknown-group');
    console.log('PASS group calls: call controls carry only {action, video} and reach members through the sealed path');
  }

  // ── 8. here 只在真的上線時發 ──
  {
    const provider = readFileSync(`${SRC}/providers/AppProvider.tsx`, 'utf8');
    assert.ok(/mqttService\.onConnected\(\(\{ tokenSwap \}\) => \{[^]*?syncAll\(\);[^]*?if \(!tokenSwap\) engine\?\.announce\(\);/.test(provider),
      'the app syncs on every connect and announces only on real ones (mqtt_acl_scope_self_test checks the tokenSwap flag)');
    assert.ok(/mqtt\.subscribe\(MessageType\.GROUP_SEALED[^]*?groupControlSource\(message\)[^]*?onControl\(src\.tid, src\.from, src\.envelope\)/.test(provider),
      'group_sealed goes to the engine with the topic id and sender taken from the topic (the engine maps tid → group)');
    assert.ok(!/GROUP_LOG_PING|GROUP_CALL_/.test(provider), 'no plaintext group types left in AppProvider');
    const mark = world.controlLog.length;
    C.shutdown();
    C.online = true;
    C.mqttUp = false;                               // 這一刻 MQTT 剛好又斷了：here 留著，連上再送
    C.engine = E.createGroupEngine(C.deps());
    C.engine.announce();                            // 連上比引擎載完早
    await C.engine.start();
    await world.settle();
    assert.deepEqual(since(mark, C, g), [], 'nothing sent while offline');
    C.mqttUp = true;
    C.engine.flushControl();
    await world.settle();
    const heres = [];
    for (const e of since(mark, C, g)) heres.push(e.qos === 0 ? (await A.peekControl(e))?.t : null);
    assert.ok(heres.includes('here'), `the early announce is sent once the engine has loaded (${heres})`);
    console.log('PASS here: sent on real connects only; an announce before the engine has loaded is sent after loading');
  }
} finally {
  console.error = quiet;
  world.close();
}
await new Promise((r) => setTimeout(r, 10));
process.exit(0);

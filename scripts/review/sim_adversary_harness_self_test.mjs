/**
 * W5 模擬的攻擊者工具（scripts/sim/lib/adversaryKit.mjs、broker.mjs 的 inject／spy／withhold／expireSession／refuseConnect、
 * groupLogServer.mjs 的 malice、mockApi.mjs 的 who／adversaryRejected）真的做得到它說的事（模擬的對抗情境才判得準）：
 *   1. Mallory 拿到真的 token（server_acl.py 跑 api/chat/mqtt_auth.py 的 mqtt_scope／mqtt_acl）、連上；冒用別人那一節發、訂別人的收件箱 → 0x87，
 *      而且只算進攻擊者的拒絕數（App 的 deniedPub／deniedSub 不動）
 *   2. inject 繞過 ACL、spy 記得到、withhold 真的扣下
 *   3. 群組 log：攻擊者簽章 append 成功；equivocate 只騙 victim；withhold 讓 head 跟著說謊、more＝false；營運方直接寫
 *   4. 攻擊者封的身分信封，收件人用 App 真的 identitySeal 拆得開；DIRECT_SEALED（開源第 4 步）用 directSeal 只拆得開成他自己寄的
 *   5. token 請求的萬用字元／尾端換行／peers／多的欄位／51 個群 → 400／422，記在 adversaryRejected（App 的 rejected 是空的）
 *   6. refuseConnect：斷網時 CONNECT 回 0x88
 * Run: node scripts/review/sim_adversary_harness_self_test.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const tmp = mkdtempSync(join(tmpdir(), 'simadv-'));
const req = createRequire(R + '/packages/pwa/package.json');
const { createBroker, makeResolver } = await import(R + '/scripts/sim/lib/broker.mjs');
const { createMockApi, decodeToken, serverAclFrom } = await import(R + '/scripts/sim/lib/mockApi.mjs');
const { createGroupLogServer } = await import(R + '/scripts/sim/lib/groupLogServer.mjs');
const { PROFILES } = await import(R + '/scripts/sim/lib/profiles.mjs');
const { Actor, loadServices, newIdentity, x25519, verify, isAdversary } = await import(R + '/scripts/sim/lib/adversaryKit.mjs');
const resolveModule = (name) => req(name);
void makeResolver;
for (const l of ['Alice', 'Bob', 'Carol', 'Dave', null, undefined]) assert.equal(isAdversary(l), false, `${l} is an honest label`);
for (const l of ['Mallory', 'Mallory-probe', 'operator', 'Bob~shadow']) assert.equal(isAdversary(l), true, `${l} is an attacker label`);
const events = [];
const log = () => {};
const broker = createBroker({ resolveModule, verifyToken: decodeToken, log, isAdversary, onEvent: (e) => events.push(e) });
const profile = PROFILES.aegistalk;
const serverAcl = serverAclFrom(R + '/api/chat/mqtt_auth.py');
const groupLog = createGroupLogServer({ routesPy: R + '/api/group_log_routes.py', dbPath: join(tmp, 'gl.db') });
const mockApi = createMockApi({ log, profile, serverAcl, groupLog, isAdversary });
const svc = await loadServices({ pwaSrc: process.env.AEGISTALK_PWA_SRC ?? R + '/packages/pwa/src', resolveModule, workDir: join(tmp, 'svc') });
const mqttPacket = resolveModule('mqtt-packet');
const mk = (label, id, suffix) => new Actor({ label, pk: id.pk, sign: id.sign, mockApi, broker, mqttPacket, services: svc, clientSuffix: suffix });
const mid = newIdentity(); const vid = newIdentity();
const M = mk('Mallory', mid, 'evil0001');
const V = mk('Victim', vid, 'vict0001');
const tid = 'T'.repeat(22);
const mc = await M.connect({ groups: [tid] });
assert.equal(mc.token.status, 200, JSON.stringify(mc.token));
assert.equal(mc.connack, 0);
const vc = await V.connect({ groups: [tid] });
assert.equal(vc.connack, 0);
console.log('PASS Mallory gets a real token and connects');
assert.deepEqual(await mc.link.subscribe([`mist/group/${tid}/+`]), [1]);
assert.deepEqual(await vc.link.subscribe([`mist/group/${tid}/+`, `mist/user/${V.user}/inbox/+`]), [1, 1]);
assert.deepEqual(await mc.link.subscribe([`mist/user/${V.user}/inbox/+`]), [0x87]);
assert.equal(await mc.link.publish(`mist/group/${tid}/${V.user}`, 'x'), 0x87);
assert.equal(await mc.link.publish(`mist/group/${tid}/${M.user}`, 'hello'), 0);
await new Promise((r) => setTimeout(r, 50));
assert.equal(vc.link.receivedOn(`mist/group/${tid}/${M.user}`).length, 1);
assert.deepEqual(broker.stats.adversaryDenied, { pub: 1, sub: 1 });
assert.equal(broker.stats.deniedPub + broker.stats.deniedSub, 0, 'app counters untouched');
console.log('PASS ACL denials of the attacker are counted separately', JSON.stringify(broker.stats.deniedBy));
// inject + spy + withhold
const spy = broker.spy((r) => r.topic.startsWith('mist/group/'));
broker.inject(`mist/group/${tid}/${V.user}`, 'forged');
await new Promise((r) => setTimeout(r, 20));
assert.equal(spy.records.length, 1);
assert.equal(vc.link.receivedOn(`mist/group/${tid}/${V.user}`).length, 1);
const wid = broker.withhold(({ to }) => to === 'Victim');
broker.inject(`mist/group/${tid}/${V.user}`, 'forged2');
await new Promise((r) => setTimeout(r, 20));
assert.equal(vc.link.receivedOn(`mist/group/${tid}/${V.user}`).length, 1, 'withheld');
broker.release(wid);
console.log('PASS inject bypasses the ACL, spy records it, withhold drops it');
// group log
const gid = 'G'.repeat(22);
const a1 = await M.appendLog(gid, JSON.stringify({ k: 'kid1', n: 'AAAAAAAAAAAAAAAA', c: 'AAAAAAAAAAAAAAAAAAAAAA==' }));
assert.equal(a1.status, 200, JSON.stringify(a1));
const a2 = await M.appendLog(gid, 'second');
const page = await M.fetchLog(gid, 0);
assert.equal(page.entries.length, 2);
const rule = groupLog.malice.equivocate({ gid, victim: 'Victim', seq: 2, blob: 'LIE' });
const vpage = await V.fetchLog(gid, 0);
assert.equal(vpage.entries.find((e) => e.seq === 2).blob, 'LIE');
assert.equal((await M.fetchLog(gid, 0)).entries.find((e) => e.seq === 2).blob, 'second');
groupLog.malice.clear(rule);
const w = groupLog.malice.withhold({ gid, victim: 'Victim', fromSeq: 2 });
const wpage = await V.fetchLog(gid, 0);
assert.equal(wpage.entries.length, 1); assert.equal(wpage.head, 1); assert.equal(wpage.more, false);
groupLog.malice.clear(w);
const inj = await groupLog.injectEntry(gid, 'operator-entry');
assert.equal(inj, 3);
assert.equal(mockApi.rejected.size, 0, 'app rejections untouched');
console.log('PASS group log: signed append, equivocate/withhold only the victim, operator write');
// seal & open
const env = await M.seal(V.pk, { kind: 'req', gid, kid: 'kid1' });
const opened = await svc.S.openFromIdentity({ envelope: env, from: M.pk, to: V.pk, myX25519Private: await svc.S.edSeedToX25519Scalar(vid.seed), verify, kindLimits: svc.S.GROUP_SEALED_KIND_LIMITS }, x25519);
assert.equal(opened.kind, 'req');
console.log('PASS the attacker\'s identity-sealed envelope opens with the app\'s identitySeal');
// 開源第 4 步：Mallory 封的 DIRECT_SEALED 用 App 真的 directSeal 拆得開（寄件人＝他）；寫成 from＝別人就拆不開（C2 的「冒名」）
{
  const vx = await svc.S.edSeedToX25519Scalar(vid.seed);
  const denv = await M.sealDirect(V.pk, { kind: 'call', sig: 'request', callId: 'C'.repeat(22), seq: 1 });
  const dopen = (from) => svc.D.openDirect({ envelope: denv, from, to: V.pk, storedKey: from, myX25519Private: vx, verify, now: Date.now(), scheme: svc.D.AEGISTALK_DIRECT }, x25519);
  assert.equal((await dopen(M.pk)).sig, 'request', 'opens as from Mallory');
  await assert.rejects(dopen(newIdentity().pk), /./, 'labelled as from someone else it does not open');
  console.log('PASS the attacker\'s DIRECT_SEALED envelope opens with the app\'s directSeal only as his own');
}
// token probes
for (const [over, want] of [[{ groups: ['+'] }, 400], [{ groups: ['A'.repeat(22) + '\n'] }, 400], [{ peers: [V.pk] }, 422], [{ acl: ['#'] }, 422], [{ presence_tag: '+' }, 400],
  [{ groups: Array.from({ length: 51 }, (_, i) => `${'G'.repeat(20)}${String(i).padStart(2, '0')}`) }, 422]]) {
  const r = await M.requestToken(over);
  assert.equal(r.status, want, `${JSON.stringify(over).slice(0, 60)} → ${r.status} ${JSON.stringify(r.body)}`);
}
assert.equal(mockApi.rejected.size, 0, 'the app map stays empty');
assert.ok(mockApi.adversaryRejected.size >= 4, 'refusals land in adversaryRejected');
console.log('PASS malformed token requests are refused (400/422) and counted as the attacker\'s');
// expire session
broker.refuseConnect('Victim', true);
broker.dropClientsWhere((s) => s.label === 'Victim');
const again = await V.connect({});
assert.equal(again.connack, 0x88, 'refused while network down');
broker.refuseConnect('Victim', false);
console.log('PASS refuseConnect: CONNECT 0x88 while the network is down');
// 7. simAdversary.ts 只進模擬的 dist：只有 scripts/sim/vite.sim.config.mjs 引用它，App 的 vite 設定與原始碼一個都沒有（審查 W5 L7）
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? (n === 'node_modules' || n === 'wasm' ? [] : walk(f)) : [f]; });
  const srcRoot = process.env.AEGISTALK_PWA_SRC ?? R + '/packages/pwa/src';
  const hits = walk(srcRoot).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && /simAdversary|__simAdversary/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], 'no app source references the sim hook');
  assert.ok(!/simAdversary/.test(readFileSync(R + '/packages/pwa/vite.config.ts', 'utf8')), 'the app build config does not load it');
  const simCfg = readFileSync(R + '/scripts/sim/vite.sim.config.mjs', 'utf8');
  assert.match(simCfg, /lib\/simAdversary\.ts/, 'only the sim build config wires it in');
  assert.match(readFileSync(R + '/scripts/sim/lib/simAdversary.ts', 'utf8'), /localStorage\.getItem\('AEGIS_E2E_TEST'\) === 'true'/, 'and it only mounts in E2E mode');
  console.log('PASS the sim hook lives only in the sim build (no app source or app build config references it)');
}
groupLog.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);

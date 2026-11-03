/**
 * 模擬的 GROUP-TOPICS 稽核（scripts/sim/lib/topics.mjs，W3）真的抓得到：
 *   1. deriveTopicId 跟 App 的 groupControl.deriveTopicId 一字不差（真的 groupControl.ts，esbuild）
 *   2. gid 出現在 broker 看得到的任何地方（發布／訂閱／退訂主題、遺囑主題、token 的 acl、payload 原文）→ 抓到；
 *      群組主題不是 22 字元的 tid → 抓到；乾淨的一輪 → 通過；一個 gid 都不知道 → 不算通過（檢查是空的）；
 *      金鑰 id（kid）也一樣：在主題、token、payload（例如控制信封或 offer 證明帶明文 kid）→ 抓到（審查 W3 M3）
 *   3. 被踢的那支訂了／收到／發了踢人之後的 tid、token 裡有它 → 抓到；其他人在那些 tid 上什麼都沒收到 → 不算通過
 * Run: node scripts/review/sim_topic_audit_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTopicAudit, deriveTopicId } from '../sim/lib/topics.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'simtopics-'));
await require('esbuild').build({ entryPoints: [(process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src') + '/services/groupControl.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'ctl.mjs'), logLevel: 'silent' });
const CTL = await import(pathToFileURL(join(dir, 'ctl.mjs')));

// ── 1. 跟 App 的推法一樣 ──
for (let i = 0; i < 20; i++) {
  const key = crypto.randomBytes(32);
  const gid = crypto.randomBytes(16).toString('base64url').slice(0, 22);
  assert.equal(deriveTopicId(key.toString('base64'), gid), await CTL.deriveTopicId(new Uint8Array(key), gid));
}
console.log('PASS the simulator derives topic ids exactly like the app (20 random keys/groups)');

// ── 2. gid ──
const gid = 'GidGidGidGidGidGidGid0';
const tid = 'TidTidTidTidTidTidTid0';
const kid = 'KidKidKidKidKidKidKid0';
const me = 'A'.repeat(43);
const clean = () => {
  const a = createTopicAudit();
  a.record({ kind: 'connect', label: 'Alice', topic: `mist/user/${me}/presence`, acl: { pub: [`mist/group/+/${me}`], sub: [`mist/group/${tid}/+`], all: [] } });
  a.record({ kind: 'subscribe', label: 'Alice', topic: `mist/group/${tid}/+`, granted: true });
  a.record({ kind: 'publish', label: 'Alice', topic: `mist/group/${tid}/${me}`, payload: Buffer.from('{"type":"group_sealed","payload":{"n":"AAAA","c":"AAAA"}}'), granted: true });
  a.record({ kind: 'deliver', label: 'Carol', topic: `mist/group/${tid}/${me}` });
  return a;
};
assert.ok(clean().gidHidden([gid]).pass, 'a clean run passes');
assert.ok(clean().gidHidden([gid], [kid]).pass && clean().gidHidden([gid], [kid]).kids === 1, 'with the kids too');
assert.equal(clean().gidHidden([]).pass, false, 'no gid known → the check is empty, not a pass');
const leaks = [
  ['in a publish topic', { kind: 'publish', label: 'Alice', topic: `mist/group/${gid}/${me}`, payload: Buffer.from('{}'), granted: true }],
  ['in a denied publish', { kind: 'publish', label: 'Alice', topic: `mist/group/${gid}/${me}`, payload: Buffer.from('{}'), granted: false }],
  ['in a subscription', { kind: 'subscribe', label: 'Bob', topic: `mist/group/${gid}/+`, granted: false }],
  ['in an unsubscribe', { kind: 'unsubscribe', label: 'Bob', topic: `mist/group/${gid}/+` }],
  ['in the token', { kind: 'connect', label: 'Bob', topic: null, acl: { pub: [], sub: [`mist/group/${gid}/+`], all: [] } }],
  ['in a payload', { kind: 'publish', label: 'Bob', topic: `mist/user/${me}/inbox/${me}`, payload: Buffer.from(`{"type":"check_in_reminder","payload":{"groupId":"${gid}"}}`), granted: true }],
  ['a group topic that is not a tid', { kind: 'publish', label: 'Bob', topic: `mist/group/short/${me}`, payload: Buffer.from('{}'), granted: true }],
];
for (const [why, ev] of leaks) {
  const a = clean();
  a.record(ev);
  const r = a.gidHidden([gid]);
  assert.ok(!r.pass && r.findings.length > 0, `flagged: gid ${why}`);
}
const kidLeaks = [
  ['in a control envelope', { kind: 'publish', label: 'Alice', topic: `mist/group/${tid}/${me}`, payload: Buffer.from(`{"type":"group_sealed","payload":{"k":"${kid}","n":"AAAA","c":"AAAA"}}`), granted: true }],
  ['in a WebRTC offer proof', { kind: 'publish', label: 'Alice', topic: `mist/user/${me}/inbox/${me}`, payload: Buffer.from(`{"type":"o","payload":{"groupProof":{"v":1,"items":[{"k":"${kid}","m":"x"}]}}}`), granted: true }],
  ['in a topic', { kind: 'subscribe', label: 'Bob', topic: `mist/group/${kid}/+`, granted: true }],
];
for (const [why, ev] of kidLeaks) {
  const a = clean();
  a.record(ev);
  const r = a.gidHidden([gid], [kid]);
  assert.ok(!r.pass && r.findings.some((f) => f.includes('the kid')), `flagged: kid ${why}`);
}
console.log(`PASS GID-HIDDEN: ${leaks.length} ways the gid (or a non-tid group topic) and ${kidLeaks.length} ways a kid could reach the broker are flagged; a clean run passes`);

// ── 3. 被踢的那支 ──
const post = ['PostPostPostPostPost01'];
const base = () => {
  const a = clean();
  a.record({ kind: 'deliver', label: 'Carol', topic: `mist/group/${post[0]}/${me}` });
  a.record({ kind: 'deliver', label: 'Bob', topic: `mist/group/${tid}/${me}` });   // 踢人之前的主題：不算
  return a;
};
assert.ok(base().removedSilent({ removed: 'Bob', tids: post, others: ['Alice', 'Carol'] }).pass, 'silent removed phone passes');
const noisy = [
  ['subscribed (even if refused)', { kind: 'subscribe', label: 'Bob', topic: `mist/group/${post[0]}/+`, granted: false }],
  ['received', { kind: 'deliver', label: 'Bob', topic: `mist/group/${post[0]}/${me}` }],
  ['published', { kind: 'publish', label: 'Bob', topic: `mist/group/${post[0]}/${me}`, payload: Buffer.from('{}'), granted: true }],
  ['token', { kind: 'connect', label: 'Bob', topic: null, acl: { pub: [], sub: [`mist/group/${post[0]}/+`], all: [] } }],
];
for (const [why, ev] of noisy) {
  const a = base();
  a.record(ev);
  assert.equal(a.removedSilent({ removed: 'Bob', tids: post, others: ['Alice', 'Carol'] }).pass, false, `flagged: the removed phone ${why}`);
}
assert.equal(clean().removedSilent({ removed: 'Bob', tids: post, others: ['Alice', 'Carol'] }).pass, false, 'nobody received on the new topics → empty check, not a pass');
assert.equal(base().removedSilent({ removed: 'Bob', tids: [], others: ['Alice', 'Carol'] }).pass, false, 'no post-removal topic → not a pass');
console.log('PASS REMOVED-SILENT: subscribing, receiving, publishing or holding a token for a post-removal topic is flagged; empty checks do not pass');

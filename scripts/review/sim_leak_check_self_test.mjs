/**
 * 模擬的 LEAK 檢查（scripts/sim/lib/leak.mjs，W2）真的抓得到洩漏：群組主題上明文的舊型別、看得到的欄位裡有群名／暱稱／守護設定、
 * from 不是主題寄件人、帶了別的成員的公鑰、payload 帶明文金鑰 id（W3 審查 M3）→ 都算；正常的 group_sealed（{ n, c }）、收件箱主題 → 不算。
 * 開源第 4 步 checkDirect：收件箱上明文的 1 對 1 信令型別、direct_sealed 形狀不對、X3DH_INIT 帶名字、推播提示、任何主題上看得到的顯示名稱 → 都算。
 * Run: node scripts/review/sim_leak_check_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createLeakCheck } from '../sim/lib/leak.mjs';

const key = () => crypto.randomBytes(32).toString('base64');
const url = (b) => b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const [alice, bob, carol] = [key(), key(), key()];
const gid = 'AbCdEfGhIjKlMnOpQrStUv';
const topic = (pk) => `mist/group/${gid}/${url(pk)}`;
const sealed = (from, payload = { n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(300).toString('base64') }) =>
  Buffer.from(JSON.stringify({ type: 'group_sealed', from, payload, timestamp: Date.now() }));
const fresh = () => createLeakCheck({ secrets: () => ['SimGroup', 'Alice', 'Bob', 'notifyTime', 'customMessage'], members: () => [alice, bob, carol] });

let L = fresh();
for (let i = 0; i < 200; i++) L.check('Alice', topic(alice), sealed(alice));
L.check('Alice', `mist/user/${url(bob)}/inbox/${url(alice)}`, Buffer.from(JSON.stringify({ type: 'group_key_sealed', from: alice, payload: { to: bob, groupName: 'SimGroup' } })));
assert.deepEqual([L.stats.checked, L.stats.findingCount, L.stats.types], [200, 0, { group_sealed: 200 }], 'sealed control messages pass; inbox topics are not this check');

const nc = { n: 'AAAA', c: 'AAAA' };
const cases = [
  ['plaintext W1 call start', topic(alice), { type: 'group_call_start', from: alice, payload: { groupId: gid, groupName: 'SimGroup', initiatorId: alice }, timestamp: 1 }, /plaintext type/],
  ['plaintext log ping', topic(alice), { type: 'group_log_ping', from: alice, payload: { h: 'x', s: 1 }, timestamp: 1 }, /plaintext type/],
  ['group name in a visible field', topic(alice), { type: 'group_sealed', from: alice, payload: nc, timestamp: 1, name: 'SimGroup' }, /readable "SimGroup"/],
  ['a kid in clear (W3: links the tid to the gid through the log)', topic(alice), { type: 'group_sealed', from: alice, payload: { k: 'kid_1', ...nc }, timestamp: 1 }, /payload is not \{n, c\}/],
  ['guardian notify time', topic(alice), { type: 'group_sealed', from: alice, payload: { ...nc, notifyTime: '09:00' }, timestamp: 1 }, /readable "notifyTime"/],
  ['from is not the topic sender', topic(alice), { type: 'group_sealed', from: bob, payload: nc, timestamp: 1 }, /from is not the topic sender/],
  ['another member\'s key', topic(alice), { type: 'group_sealed', from: alice, payload: nc, timestamp: 1, to: carol }, /another member's key/],
  ['another member\'s key, URL-safe', topic(alice), { type: 'group_sealed', from: alice, payload: nc, timestamp: 1, x: url(bob).slice(0, 43) }, /another member's key/],
  ['ciphertext that is not base64', topic(alice), { type: 'group_sealed', from: alice, payload: { n: 'AAAA', c: 'hello Bob' }, timestamp: 1 }, /not \{base64, base64\}/],
  ['a group topic that is not a 22-char topic id (W3)', `mist/group/group-1760000000000-abc1234/${url(alice)}`, { type: 'group_sealed', from: alice, payload: nc, timestamp: 1 }, /22-char tid/],
];
for (const [why, t, msg, expect] of cases) {
  L = fresh();
  L.check('Alice', t, Buffer.from(JSON.stringify(msg)));
  assert.ok(L.stats.findings.some((f) => expect.test(f)), `flagged: ${why} (${JSON.stringify(L.stats.findings)})`);
}
L = fresh();
L.check('Alice', topic(alice), Buffer.from('not json'));
assert.equal(L.stats.findingCount, 1, 'flagged: not JSON');
console.log(`PASS LEAK check: 200 sealed messages clean; ${cases.length + 1} kinds of leak on a group topic flagged`);

// W5：群組主題以外（收件箱、presence、遺囑）也掃群名與守護設定的內容；暱稱不算
{
  const A = createLeakCheck({ secrets: () => ['SimGroup', 'Alice'], members: () => [], anywhere: () => ['SimGroup', 'sim-checkin-secret'] });
  A.scanAny('Alice', `mist/user/${url(bob)}/inbox/${url(alice)}`, Buffer.from(JSON.stringify({ type: 'profile_update', from: alice, payload: { displayName: 'Alice' } })));
  assert.equal(A.stats.findingCount, 0, 'a nickname in a plaintext profile update is not a group secret');
  A.scanAny('Alice', `mist/user/${url(bob)}/inbox/${url(alice)}`, Buffer.from(JSON.stringify({ type: 'x', payload: { name: 'SimGroup' } })));
  A.scanAny('Alice', `mist/user/${url(alice)}/presence/${'T'.repeat(22)}`, Buffer.from('{"note":"sim-checkin-secret"}'));
  assert.equal(A.stats.findingCount, 2, 'a group name on an inbox topic and a guardian message in a presence payload are flagged');
  assert.equal(A.stats.scanned, 3);
  console.log('PASS LEAK scanAny: group names and guardian settings are flagged on any topic, nicknames are not');
}

// 開源第 4 步：checkDirect —— 收件箱上只准封好的型別、direct_sealed 的形狀、X3DH_INIT 不帶名字、沒有推播提示、任何地方都沒有顯示名稱
{
  const names = () => ['Alice', 'Bob', 'Carol', 'Dave'];
  const D = () => createLeakCheck({ secrets: () => [], members: () => [], names });
  const ib = `mist/user/${url(bob)}/inbox/${url(alice)}`;
  const b64 = (n) => crypto.randomBytes(n).toString('base64');
  const sealedEnv = () => ({ v: 1, ek: b64(32), n: b64(12), ct: b64(1024) });
  const msg = (o) => Buffer.from(JSON.stringify({ from: alice, to: bob, timestamp: 1, ...o }));
  let X = D();
  X.checkDirect('Alice', ib, msg({ type: 'direct_sealed', payload: sealedEnv() }));
  X.checkDirect('Alice', ib, msg({ type: 'x3dh_init', payload: { ephemeralPublicKey: b64(32), signedPreKey: b64(32), signature: b64(64), sessionReset: true, via: sealedEnv() } }));
  X.checkDirect('Alice', ib, msg({ type: 'group_key_sealed', payload: sealedEnv() }));
  X.checkDirect('Alice', `mist/user/${url(alice)}/presence/${'T'.repeat(22)}`, Buffer.from(JSON.stringify({ n: b64(12), c: b64(64) })));
  X.checkDirect('Alice', `mist/user/${url(alice)}/presence/${'T'.repeat(22)}`, Buffer.alloc(0));
  X.checkDirect('Alice', topic(alice), sealed(alice));                    // 群組主題不是這一項
  // base64 裡碰巧有 "Bob" 不算（亂數）
  X.checkDirect('Alice', ib, msg({ type: 'direct_sealed', payload: { v: 1, ek: b64(32), n: b64(12), ct: 'xxBobxxAlicexx' + b64(64) } }));
  assert.deepEqual([X.stats.findingCount, X.stats.direct.checked, X.stats.direct.types], [0, 4, { direct_sealed: 2, x3dh_init: 1, group_key_sealed: 1 }],
    `clean sealed traffic passes (${JSON.stringify(X.stats.findings)})`);
  const bad = [
    ['plaintext call request', msg({ type: 'call_request', payload: { callId: 'c' } }), /plaintext 1:1 type call_request/],
    ['plaintext DataChannel offer', msg({ type: 'webrtc_offer', payload: { sdp: 'v=0' } }), /plaintext 1:1 type webrtc_offer/],
    ['plaintext call offer', msg({ type: 'call_webrtc_offer', payload: { sdp: 'v=0' } }), /plaintext 1:1 type call_webrtc_offer/],
    ['plaintext profile update with the name', msg({ type: 'profile_update', payload: { displayName: 'Alice' } }), /readable name "Alice"/],
    ['plaintext prekey request', msg({ type: 'prekey_request', payload: {} }), /plaintext 1:1 type prekey_request/],
    ['plaintext push subscription', msg({ type: 'push_subscription_update', payload: { endpoint: 'https://x' } }), /plaintext 1:1 type push_subscription_update/],
    ['a sealed message with a push hint', msg({ type: 'direct_sealed', payload: sealedEnv(), notificationHint: { type: 'incoming_call' } }), /push hint|extra fields notificationHint/],
    ['a sealed message whose kind is readable', msg({ type: 'direct_sealed', payload: { ...sealedEnv(), kind: 'call' } }), /payload is not \{v, ek, n, ct\}/],
    ['a sealed message that is not base64', msg({ type: 'direct_sealed', payload: { v: 1, ek: 'not base64!', n: b64(12), ct: b64(64) } }), /not \{1, base64/],
    ['X3DH_INIT with the sender name', msg({ type: 'x3dh_init', payload: { ephemeralPublicKey: b64(32), senderName: 'Bob' } }), /X3DH_INIT carries a name field/],
    ['a name inside some other readable field', msg({ type: 'group_key_sealed', payload: { ...sealedEnv(), note: 'from Carol with love' } }), /readable name "Carol"/],
  ];
  for (const [why, payload, expect] of bad) {
    X = D();
    X.checkDirect('Alice', ib, payload);
    assert.ok(X.stats.findings.some((f) => expect.test(f)), `flagged: ${why} (${JSON.stringify(X.stats.findings)})`);
  }
  X = D();
  X.checkDirect('Alice', `mist/user/${url(alice)}/presence/${'T'.repeat(22)}`, Buffer.from('{"note":"Dave is online"}'));
  assert.ok(X.stats.findings.some((f) => /readable name "Dave"/.test(f)), 'a name on a presence topic is flagged too');
  console.log(`PASS LEAK checkDirect: sealed 1:1 traffic passes; ${bad.length + 1} kinds of plaintext 1:1 signalling, push hints and readable names are flagged`);
}

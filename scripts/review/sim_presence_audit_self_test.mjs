/**
 * 四手機模擬的 PRESENCE 稽核（W4，scripts/sim/lib/presenceAudit.mjs）真的抓得到問題：每一種違規各自造一個事件，看得到對應的 finding；
 * 乾淨的一輪 PASS。純函式，不開瀏覽器、不跑 broker。
 *   SHAPE：只有公鑰的 mist/user/<他>/presence、萬用字元、多一層 → finding（主題、遺囑、token 規則都查）
 *   PAYLOAD：明文的 {online}、帶公鑰、不是 {n, c} → finding；空的（清掉主題）可以
 *   OWNER：在別人的 presence 主題上發、token 能發別人的 → finding
 *   FRIENDS-ONLY：非好友訂到／收到／token 給了別人的 presence → finding
 *   NOT-EMPTY：好友之間一則都沒送到 → finding
 *   遺囑（審查 W4 #5）：連線時留的、broker 替斷線的人發出的（will 事件）內容也看：明文、帶公鑰 → finding
 *   EVERY PAIR：某一對好友的某一個方向一則不是空的都沒送到 → finding（只送空的也不算）
 *   ACCEPTED：App 從沒認定某個好友在線（isFriendOnline）、presence 服務有 open-failed → finding
 * Run: node scripts/review/sim_presence_audit_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const { presenceAudit } = await import(pathToFileURL(root + 'scripts/sim/lib/presenceAudit.mjs'));
const url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const key = () => Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('base64');
const phones = ['Alice', 'Bob', 'Carol'].map((label) => ({ label, pubkey: key() }));
const [A, B, C] = phones;
const friendsOf = new Map([['Alice', new Set(['Bob', 'Carol'])], ['Bob', new Set(['Alice'])], ['Carol', new Set(['Alice'])]]);
const tag = (c) => c.repeat(22);
const topic = (p, t = tag('T')) => `mist/user/${url(p.pubkey)}/presence/${t}`;
const sealed = JSON.stringify({ n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(40).toString('base64') });
const clean = () => [
  { kind: 'connect', label: 'Alice', topic: topic(A), payload: sealed, acl: { pub: [`mist/user/+/inbox/${url(A.pubkey)}`, topic(A)], sub: [topic(B), topic(C)], all: [] } },
  { kind: 'connect', label: 'Bob', topic: topic(B), payload: sealed, acl: { pub: [topic(B)], sub: [topic(A)], all: [] } },
  { kind: 'publish', label: 'Alice', topic: topic(A), payload: sealed, granted: true },
  { kind: 'publish', label: 'Alice', topic: topic(A), payload: '', granted: true },
  { kind: 'subscribe', label: 'Bob', topic: topic(A), granted: true },
  { kind: 'deliver', label: 'Bob', topic: topic(A), payload: sealed },
  { kind: 'deliver', label: 'Alice', topic: topic(B), payload: sealed },
  { kind: 'deliver', label: 'Alice', topic: topic(C), payload: sealed },
  { kind: 'deliver', label: 'Carol', topic: topic(A), payload: sealed },
  { kind: 'will', label: 'Bob', topic: topic(B), payload: sealed, granted: true },
  { kind: 'subscribe', label: 'Alice', topic: `mist/group/${tag('G')}/+`, granted: true },
];
const allOnline = () => new Map([['Alice', new Set(['Bob', 'Carol'])], ['Bob', new Set(['Alice'])], ['Carol', new Set(['Alice'])]]);
const stats = () => new Map([['Alice', { acceptedOnline: 3, 'svc.opened': 3 }], ['Bob', { acceptedOnline: 1 }]]);
const run = (extra, opts = {}) => presenceAudit([...clean(), ...extra], { phones, friendsOf, online: allOnline(), stats: stats(), ...opts });

const ok = run([]);
assert.ok(ok.pass, JSON.stringify(ok.findings));
assert.equal(ok.deliveredToFriends, 4);
assert.deepEqual([ok.pairs, ok.pairsDelivered, ok.pairsOnline, ok.willsFired], [4, 4, 4, 1]);
assert.ok(presenceAudit(clean(), { phones, friendsOf }).pass, 'without online/stats only the broker side is checked');
console.log('PASS a clean run passes (exact topics, sealed or empty payloads and wills, friends only, every friend direction delivered and seen online)');

const cases = [
  ['key-only topic subscribed', [{ kind: 'subscribe', label: 'Bob', topic: `mist/user/${url(A.pubkey)}/presence`, granted: true }], /not mist\/user\/<key>\/presence\/<22-char tag>/],
  ['key-only will', [{ kind: 'connect', label: 'Carol', topic: `mist/user/${url(C.pubkey)}/presence`, acl: { pub: [], sub: [], all: [] } }], /not mist\/user/],
  ['wildcard in a token rule', [{ kind: 'connect', label: 'Bob', topic: null, acl: { pub: [], sub: [`mist/user/+/presence/${tag('T')}`], all: [] } }], /not mist\/user/],
  ['extra level', [{ kind: 'publish', label: 'Alice', topic: `${topic(A)}/x`, payload: sealed, granted: true }], /not mist\/user/],
  ['plaintext online', [{ kind: 'publish', label: 'Alice', topic: topic(A), payload: JSON.stringify({ type: 'presence', from: A.pubkey, payload: { online: true } }), granted: true }], /not \{n, c\}|readable|public key/],
  ['a public key in the payload', [{ kind: 'publish', label: 'Alice', topic: topic(A), payload: JSON.stringify({ n: 'AAAA', c: url(B.pubkey) }), granted: true }], /public key|not \{n, c\}/],
  ['someone else\'s topic', [{ kind: 'publish', label: 'Bob', topic: topic(A), payload: sealed, granted: false }], /published on the presence topic of Alice/],
  ['token may publish another owner', [{ kind: 'connect', label: 'Bob', topic: null, acl: { pub: [topic(A)], sub: [], all: [] } }], /may publish presence for Alice/],
  ['non-friend subscribes', [{ kind: 'subscribe', label: 'Bob', topic: topic(C), granted: false }], /presence of Carol, who is not a friend/],
  ['non-friend is delivered', [{ kind: 'deliver', label: 'Carol', topic: topic(B) }], /delivered the presence of Bob, who is not a friend/],
  ['non-friend in the token', [{ kind: 'connect', label: 'Carol', topic: topic(C), acl: { pub: [topic(C)], sub: [topic(B)], all: [] } }], /token grants the presence topic of Bob/],
];
cases.push(
  ['plaintext will at connect', [{ kind: 'connect', label: 'Carol', topic: topic(C), payload: JSON.stringify({ from: C.pubkey, online: false }), acl: { pub: [topic(C)], sub: [topic(A)], all: [] } }],
    /presence will is not \{n, c\}|presence will carries/],
  ['fired will with a public key', [{ kind: 'will', label: 'Carol', topic: topic(C), payload: JSON.stringify({ n: 'AAAA', c: C.pubkey }), granted: true }], /fired presence will carries a public key/],
  ['fired will on another owner', [{ kind: 'will', label: 'Carol', topic: topic(A), payload: sealed, granted: false }], /will fired on the presence topic of Alice/],
);
for (const [name, extra, re] of cases) {
  const r = run(extra);
  assert.equal(r.pass, false, `${name}: should fail`);
  assert.ok(r.findings.some((f) => re.test(f)), `${name}: ${JSON.stringify(r.findings)}`);
}
// 一個方向壞掉：Carol → Alice 只送過空的（清掉主題），沒有一則真的狀態
const oneWay = presenceAudit([...clean().filter((e) => !(e.kind === 'deliver' && e.label === 'Alice' && e.topic === topic(C))),
  { kind: 'deliver', label: 'Alice', topic: topic(C), payload: '' }], { phones, friendsOf });
assert.ok(!oneWay.pass && oneWay.findings.some((f) => /no presence of Carol was ever delivered to Alice/.test(f)), 'one broken direction fails although the total is not 0');
const notSeen = allOnline();
notSeen.get('Bob').delete('Alice');
const r1 = run([], { online: notSeen });
assert.ok(!r1.pass && r1.findings.some((f) => /Bob's app never saw its friend Alice online/.test(f)), 'delivered but never accepted (key or AAD mismatch) fails');
const r2 = run([], { stats: new Map([['Bob', { 'svc.open-failed': 2 }]]) });
assert.ok(!r2.pass && r2.findings.some((f) => /Bob: 2 presence message\(s\) on a friend's current topic did not open/.test(f)), 'open-failed > 0 fails');
const empty = presenceAudit(clean().filter((e) => e.kind !== 'deliver'), { phones, friendsOf });
assert.ok(!empty.pass && empty.findings.some((f) => /would be empty/.test(f)), 'nothing delivered between friends → the check fails');
console.log(`PASS each violation is caught with its own finding (${cases.length} cases) and an empty check fails`);

/**
 * 群組金鑰改封給「收件人的身分金鑰」（對應群星 4aee0d93；不需要好友、不需要 1-1 session，收件人離線也送得到）。
 * 真的 services/identitySeal.ts；X25519／Ed25519 由 Node 的 crypto 實作（App 裡是 WASM），用來證明：
 *   1. Ed25519 公鑰 → X25519 公鑰（雙有理映射）與 Ed25519 種子 → X25519 純量（SHA-512＋clamp）對得上：
 *      由轉出來的純量算的 X25519 公鑰 ＝ 由 Ed25519 公鑰轉出來的那把（隨機 64 組）；兩邊 ECDH 結果相同
 *   2. libsodium 的公開測試向量（ed25519_convert）
 *   3. 封／拆：只有收件人拆得開；寄件人、收件人被綁在密文與簽章裡；竄改、換人、低階點一律拒絕
 *   4. 不是曲線上的點、恆等點 → 拒絕
 *   5. 網域字串是 AegisTalk 自己的
 *   6. 簽過名的內容帶封裝時間（iat）與亂數（nonce）：超過 7 天、或比現在晚 5 分鐘以上、或沒有時間 → 拒絕（對應群星 5aa70b48）
 * Run: node scripts/review/identity_seal_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'idseal-'));
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/identitySeal.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 's.mjs'), logLevel: 'silent' });
const seal = await import(pathToFileURL(join(dir, 's.mjs')));

const b64 = (u8) => Buffer.from(u8).toString('base64');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const xPriv = (scalar) => crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(scalar)]), format: 'der', type: 'pkcs8' });
const xPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });
const xPubOfScalar = (scalar) => new Uint8Array(crypto.createPublicKey(xPriv(scalar)).export({ format: 'der', type: 'spki' }).subarray(-32));
const edPubOfSeed = (seed) => new Uint8Array(crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32));
function edKeys() {
  const seed = new Uint8Array(crypto.randomBytes(32));
  return { seed, pub: edPubOfSeed(seed) };
}

// App 裡由 WASM（x25519-dalek）提供；這裡用 Node 的 X25519
const deps = {
  generateX25519() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    return {
      privateKey: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
      publicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    };
  },
  x25519(priv, pub) { return new Uint8Array(crypto.diffieHellman({ privateKey: xPriv(priv), publicKey: xPub(pub) })); },
};
const signer = (seed) => (data) => new Uint8Array(crypto.sign(null, Buffer.from(data),
  crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })));
const verify = (pub, data, sig) => {
  try {
    return crypto.verify(null, Buffer.from(data), crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));
  } catch { return false; }
};

// ── 1. 轉換：公鑰那邊與私鑰那邊得到同一把 X25519 金鑰；ECDH 兩邊一致 ──
for (let i = 0; i < 64; i++) {
  const k = edKeys();
  const scalar = await seal.edSeedToX25519Scalar(k.seed);
  assert.equal(scalar.length, 32);
  assert.equal(scalar[0] & 7, 0, 'clamped: low 3 bits cleared');
  assert.equal(scalar[31] & 0xc0, 0x40, 'clamped: bit 255 clear, bit 254 set');
  assert.equal(b64(seal.edPublicToX25519(k.pub)), b64(xPubOfScalar(scalar)), 'birational map of the Ed25519 public key = X25519 public key of the converted scalar');
  const eph = deps.generateX25519();
  const a = deps.x25519(eph.privateKey, seal.edPublicToX25519(k.pub));
  const b = deps.x25519(scalar, eph.publicKey);
  assert.equal(b64(a), b64(b), 'ECDH agrees: ephemeral × converted public = converted private × ephemeral');
}
console.log('PASS Ed25519 → X25519 conversion: public map and private scalar agree on 64 random keys; ECDH matches both ways');

// ── 2. libsodium test/default/ed25519_convert 的公開向量 ──
const vSeed = Buffer.from('421151a459faeade3d247115f94aedae42318124095afabe4d1451a559faedee', 'hex');
const vEdPub = Buffer.from('b5076a8474a832daee4dd5b4040983b6623b5f344aca57d4d6ee4baf3f259e6e', 'hex');
assert.equal(Buffer.from(edPubOfSeed(vSeed)).toString('hex'), vEdPub.toString('hex'), 'vector seed → Ed25519 public key (Node)');
assert.equal(Buffer.from(seal.edPublicToX25519(new Uint8Array(vEdPub))).toString('hex'),
  'f1814f0e8ff1043d8a44d25babff3cedcae6c22c3edaa48f857ae70de2baae50', 'libsodium crypto_sign_ed25519_pk_to_curve25519');
assert.equal(Buffer.from(await seal.edSeedToX25519Scalar(new Uint8Array(vSeed))).toString('hex'),
  '8052030376d47112be7f73ed7a019293dd12ad910b654455798b4667d73de166', 'libsodium crypto_sign_ed25519_sk_to_curve25519');
console.log('PASS libsodium ed25519_convert test vectors');

// ── 3. 封／拆 ──
const alice = edKeys(), bob = edKeys(), carol = edKeys();
const A = b64(alice.pub), B = b64(bob.pub), C = b64(carol.pub);
const bobX = await seal.edSeedToX25519Scalar(bob.seed);
const carolX = await seal.edSeedToX25519Scalar(carol.seed);
const body = { kind: 'dist', groupId: 'group-1-abc', keyId: 'gk-1', dist: { keyBase64: 'SECRETKEYMATERIAL' } };
const env = await seal.sealToIdentity({ from: A, to: B, body, sign: signer(alice.seed) }, deps);
assert.equal(env.v, 1);
assert.ok(!JSON.stringify(env).includes('SECRETKEYMATERIAL') && !JSON.stringify(env).includes('group-1-abc'), 'nothing readable outside the envelope');
const opened = await seal.openFromIdentity({ envelope: env, from: A, to: B, myX25519Private: bobX, verify }, deps);
assert.deepEqual({ kind: opened.kind, groupId: opened.groupId, keyId: opened.keyId, dist: opened.dist }, body, 'the recipient opens it');
assert.equal(opened.from, A); assert.equal(opened.to, B);

const rejects = async (p, why) => assert.rejects(seal.openFromIdentity(p, deps), undefined, why);
await rejects({ envelope: env, from: A, to: C, myX25519Private: carolX, verify }, 'another member cannot open it');
await rejects({ envelope: env, from: C, to: B, myX25519Private: bobX, verify }, 'cannot be passed off as coming from someone else');
const flip = (s) => { const u = Buffer.from(s, 'base64'); u[u.length - 1] ^= 1; return u.toString('base64'); };
await rejects({ envelope: { ...env, ct: flip(env.ct) }, from: A, to: B, myX25519Private: bobX, verify }, 'tampered ciphertext');
await rejects({ envelope: { ...env, ek: b64(new Uint8Array(32)) }, from: A, to: B, myX25519Private: bobX, verify }, 'low-order (all-zero) ephemeral key');
await rejects({ envelope: { ...env, v: 2 }, from: A, to: B, myX25519Private: bobX, verify }, 'unknown version');
await rejects({ envelope: { v: 1, ek: 'x', n: 'y' }, from: A, to: B, myX25519Private: bobX, verify }, 'malformed envelope');
// Carol 是成員、拿到一份寫給她的分發：把同一份簽過名的內容重新封給 Bob → 內容裡的 to 是她 → Bob 拒收
const forCarol = await seal.sealToIdentity({ from: A, to: C, body, sign: signer(alice.seed) }, deps);
const innerForCarol = await seal.openFromIdentity({ envelope: forCarol, from: A, to: C, myX25519Private: carolX, verify }, deps);
assert.equal(innerForCarol.to, C);
// 簽章不是 Alice 的（Carol 自己簽一份說是 Alice 寄的）→ 拒收
const forged = await seal.sealToIdentity({ from: A, to: B, body, sign: signer(carol.seed) }, deps);
await rejects({ envelope: forged, from: A, to: B, myX25519Private: bobX, verify }, 'signature must be the sender\'s');
console.log('PASS only the recipient opens it; sender and recipient are bound; tampering, forgery and low-order keys are rejected');

// ── 4. 不合法的公鑰 ──
const identity = new Uint8Array(32); identity[0] = 1;                       // y = 1：恆等點
assert.throws(() => seal.edPublicToX25519(identity), undefined, 'identity point rejected');
assert.throws(() => seal.edPublicToX25519(new Uint8Array(31)), undefined, 'wrong length rejected');
const pBytes = Buffer.from('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex');   // y = p
assert.throws(() => seal.edPublicToX25519(new Uint8Array(pBytes)), undefined, 'non-canonical y rejected');
let offCurve = 0;
for (let y = 2; y < 40; y++) {
  const raw = new Uint8Array(32); raw[0] = y;
  try { seal.edPublicToX25519(raw); } catch { offCurve++; }
}
assert.ok(offCurve > 5, 'y values that are not on the curve are rejected');
await assert.rejects(seal.sealToIdentity({ from: A, to: b64(identity), body, sign: signer(alice.seed) }, deps), undefined, 'cannot seal to an invalid key');
console.log('PASS invalid public keys (identity, non-canonical, off-curve) are rejected');

// ── 5. 網域跟群星分開：AegisTalk 的信封不會被當成群星的（反之亦然） ──
const srcText = (await import('node:fs')).readFileSync(root + 'packages/pwa/src/services/identitySeal.ts', 'utf8');
assert.ok(/const DOMAIN = 'aegistalk-gks-v1:'/.test(srcText) && /const AAD_PREFIX = 'aegistalk-gks-v1\|'/.test(srcText)
  && /'AegisTalk-GroupKeySeal-v1'/.test(srcText) && !/aegisplay/i.test(srcText.replace(/群星/g, '')), 'AegisTalk uses its own domain strings');
console.log('PASS domain separation: signature, AAD and HKDF info are AegisTalk-specific');

// ── 6. 新鮮度（對應群星 5aa70b48，審查 LOW，深度防禦）：iat＋nonce 在簽過名的內容裡 ──
//   MQTT 那層的 24 小時新鮮度不在簽章裡：拿到一封寫給我的舊信封（broker 或任何轉手過的人）重放，拆封這層以前照收
const DAY = 86_400_000;
const fresh = await seal.openFromIdentity({ envelope: env, from: A, to: B, myX25519Private: bobX, verify }, deps);
assert.equal(typeof fresh.iat, 'number', 'sealed content carries its sealing time');
assert.ok(typeof fresh.nonce === 'string' && Buffer.from(fresh.nonce, 'base64').length === 16, 'and a 16-byte nonce');
const env2 = await seal.sealToIdentity({ from: A, to: B, body, sign: signer(alice.seed) }, deps);
const again = await seal.openFromIdentity({ envelope: env2, from: A, to: B, myX25519Private: bobX, verify }, deps);
assert.notEqual(again.nonce, fresh.nonce, 'every envelope gets its own nonce');
await rejects({ envelope: env, from: A, to: B, myX25519Private: bobX, verify, now: Date.now() + 8 * DAY }, 'older than 7 days → rejected');
assert.ok(await seal.openFromIdentity({ envelope: env, from: A, to: B, myX25519Private: bobX, verify, now: Date.now() + 6 * DAY }, deps), '6 days old is still fine');
const future = await seal.sealToIdentity({ from: A, to: B, body, sign: signer(alice.seed), now: Date.now() + 10 * 60_000 }, deps);
await rejects({ envelope: future, from: A, to: B, myX25519Private: bobX, verify }, 'dated more than 5 minutes in the future → rejected');
const undated = await seal.sealToIdentity({ from: A, to: B, body, sign: signer(alice.seed), now: Number.NaN }, deps);
await rejects({ envelope: undated, from: A, to: B, myX25519Private: bobX, verify }, 'no sealing time → rejected');
const sneaky = await seal.sealToIdentity({ from: A, to: B, body: { ...body, iat: Date.now() + DAY * 365, nonce: 'x' }, sign: signer(alice.seed) }, deps);
const sneakyOpened = await seal.openFromIdentity({ envelope: sneaky, from: A, to: B, myX25519Private: bobX, verify }, deps);
assert.ok(sneakyOpened.iat <= Date.now() && sneakyOpened.nonce !== 'x', 'the body cannot override iat / nonce');
console.log('PASS sealed content is dated and nonced; stale, future-dated and undated envelopes are rejected');

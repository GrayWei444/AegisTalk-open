/**
 * identitySeal 的種類上限（設計 B2：dist／req／invite／state／presence，invite 與 state 可到 512 KB）：真的 services/identitySeal.ts。
 *   1. 沒傳 kindLimits（現有的群組金鑰 dist／req、好友 via）：行為不變 —— 拆的時候 64 KB 上限、不看 kind
 *   2. 傳 GROUP_SEALED_KIND_LIMITS：300 KB 的 invite／state 拆得開；超過 64 KB 的 dist／req／presence 封不出去、拆的時候也拒收；
 *      不在表上的種類拒收；超過 512 KB 一律拒收
 * Run: node scripts/review/identity_seal_kind_limits_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { load, identity, verify, b64 } from './groupStateKit.mjs';

const seal = await load('identitySeal');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const deps = {
  generateX25519() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    return {
      privateKey: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
      publicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    };
  },
  x25519: (priv, pub) => new Uint8Array(crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(priv)]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }),
  })),
};
const alice = identity('ks-alice'), bob = identity('ks-bob');
const bobSeed = crypto.createHash('sha256').update('ed25519-seed|ks-bob').digest();
const bobX = await seal.edSeedToX25519Scalar(new Uint8Array(bobSeed));
const L = seal.GROUP_SEALED_KIND_LIMITS;
const body = (kind, bytes) => ({ kind, pad: 'p'.repeat(bytes) });
const doSeal = (b, kindLimits) => seal.sealToIdentity({ from: alice.pk, to: bob.pk, body: b, sign: alice.sign, kindLimits }, deps);
const doOpen = (envelope, kindLimits) => seal.openFromIdentity({ envelope, from: alice.pk, to: bob.pk, myX25519Private: bobX, verify, kindLimits }, deps);

// W2 加了 ack（邀請回條）與 call（群組通話信令）：都是 64 KB
assert.deepEqual({ ...L }, { dist: 65536, req: 65536, invite: 524288, ack: 65536, call: 65536, state: 524288, presence: 65536 });
assert.equal(seal.MAX_LARGE_CT_BYTES, 512 * 1024);

// ── 1. 沒傳 kindLimits：原本的行為 ──
{
  const small = await doSeal({ kind: 'dist', dist: { keyBase64: 'K' } });
  assert.equal((await doOpen(small)).kind, 'dist');
  const big = await doSeal(body('invite', 100 * 1024));   // 原本封的時候不檢查大小
  await assert.rejects(doOpen(big), /bad ciphertext size/, 'without kindLimits the 64 KB limit still applies, whatever the kind');
  const unknown = await doSeal({ kind: 'whatever' });
  assert.equal((await doOpen(unknown)).kind, 'whatever', 'without kindLimits the kind is not looked at');
  console.log('PASS default path unchanged: 64 KB on open, kind ignored, no seal-side size check');
}

// ── 2. GROUP_SEALED_KIND_LIMITS ──
{
  for (const kind of ['invite', 'state']) {
    const env = await doSeal(body(kind, 300 * 1024), L);
    assert.ok(Buffer.from(env.ct, 'base64').length > 64 * 1024);
    assert.equal((await doOpen(env, L)).kind, kind, `${kind} up to 512 KB opens`);
    await assert.rejects(doOpen(env), /bad ciphertext size/, `${kind}: a caller without kindLimits still refuses it`);
  }
  for (const kind of ['dist', 'req', 'ack', 'call', 'presence']) {
    await assert.rejects(doSeal(body(kind, 100 * 1024), L), /too large for this kind/, `${kind} > 64 KB refused at seal time`);
    const smuggled = await doSeal(body(kind, 100 * 1024));
    await assert.rejects(doOpen(smuggled, L), /too large for this kind/, `${kind} > 64 KB refused after opening`);
    assert.equal((await doOpen(await doSeal(body(kind, 1000), L), L)).kind, kind, `small ${kind} still fine`);
  }
  await assert.rejects(doSeal({ kind: 'admin' }, L), /unknown kind/, 'unknown kind refused at seal time');
  await assert.rejects(doOpen(await doSeal({ kind: 'admin' }), L), /unknown kind/, 'unknown kind refused on open');
  await assert.rejects(doOpen(await doSeal({ noKind: true }), L), /unknown kind/, 'missing kind refused on open');
  await assert.rejects(doSeal(body('invite', 600 * 1024), L), /too large for this kind/, '> 512 KB refused at seal time');
  await assert.rejects(doOpen(await doSeal(body('invite', 600 * 1024)), L), /bad ciphertext size/, '> 512 KB refused before decrypting');
  const huge = { invite: 10 * 1024 * 1024 };
  await assert.rejects(doOpen(await doSeal(body('invite', 600 * 1024)), huge), /bad ciphertext size/, 'a caller cannot raise the cap above 512 KB');
  for (const bad of [{ ...L, invite: NaN }, { ...L, state: Infinity }, { ...L, dist: -1 }, { ...L, req: '64' }]) {
    await assert.rejects(doOpen(await doSeal(body('invite', 1000)), bad), /bad kind limit/, `a broken limit table fails closed: ${JSON.stringify(bad)}`);
  }
  await assert.rejects(doSeal(body('invite', 1000), { invite: NaN }), /bad kind limit/, 'NaN limit refused at seal time');
  const forged = await doSeal(body('invite', 200 * 1024));
  const tampered = { ...forged, ct: b64(Buffer.from(forged.ct, 'base64').map((x, i) => (i === 10 ? x ^ 1 : x))) };
  await assert.rejects(doOpen(tampered, L), undefined, 'large envelopes are still authenticated');
  console.log('PASS kind limits: invite/state ≤ 512 KB, dist/req/presence ≤ 64 KB (seal and open), unknown kinds refused, hard cap 512 KB');
}

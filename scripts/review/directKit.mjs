/**
 * DIRECT_SEALED 測試用的共用工具（不是測試本身）：Node crypto 的 Ed25519／X25519（同 sim/lib/adversaryKit.mjs），
 * 打包 App 真的 directSeal.ts（＋identitySeal.ts）。
 *   identity(seed?)            一把 Ed25519 身分：{ pk, sign, seed }
 *   x25519, verify             給 identitySeal 的 X25519／簽章驗證
 *   loadDirectSeal(root)       真的 directSeal.ts 模組
 *   x25519PrivOf(id)           身分種子推出來的 X25519 純量（identitySeal.edSeedToX25519Scalar）
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export function identity(seed = crypto.randomBytes(32)) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pk: Buffer.from(pub).toString('base64'), seed: new Uint8Array(seed), sign: (d) => new Uint8Array(crypto.sign(null, Buffer.from(d), priv)) };
}

export function verify(pub, data, sig) {
  try {
    return crypto.verify(null, Buffer.from(data), crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));
  } catch {
    return false;
  }
}

export const x25519 = {
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

export async function loadDirectSeal(root) {
  const require = createRequire(root + 'packages/pwa/package.json');
  const dir = mkdtempSync(join(tmpdir(), 'directseal-'));
  const src = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';
  await require('esbuild').build({
    stdin: { contents: "export * from './directSeal'; export { edSeedToX25519Scalar, GROUP_KEY_SEAL, FRIEND_VIA_SEAL, sealToIdentity } from './identitySeal';",
      resolveDir: src + '/services', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'ds.mjs'), logLevel: 'silent',
  });
  return import(pathToFileURL(join(dir, 'ds.mjs')).href);
}

export async function x25519PrivOf(mod, id) {
  return mod.edSeedToX25519Scalar(new Uint8Array(id.seed));
}

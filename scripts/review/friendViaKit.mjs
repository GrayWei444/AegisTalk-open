/**
 * 加好友 via 測試用的「手機」：真的 groupKeyDelivery.ts（friendViaSealer）＋真的 identitySeal.ts，
 * mqtt 換成記錄器、WASM 的 X25519／Ed25519 換成 Node crypto（同 group_key_delivery_self_test）。
 * 每個角色一把真的 Ed25519 身分金鑰、一份自己的模組（各自的已註冊身分），party.sealer 就是那支手機的 friendViaSealer。
 * 不是測試本身（檔名不是 *_self_test），給 friend_* / qr_invite_window 測試共用。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export async function friendViaKit(root) {
  const require = createRequire(root + 'packages/pwa/package.json');
  const dir = mkdtempSync(join(tmpdir(), 'friendvia-'));
  globalThis.__friendViaSent = [];
  globalThis.__nodeCrypto = crypto;
  const stub = { name: 'stub', setup(b) {
    b.onResolve({ filter: /^\.\/mqtt$|^\.\/crypto$/ }, (a) => ({ path: a.path, namespace: 's' }));
    b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path === './mqtt'
      ? `export const MessageType = { GROUP_KEY_SEALED: 'group_key_sealed' };
         export const mqttService = { sendToUser(to, type, payload) { globalThis.__friendViaSent.push({ to, type, payload }); } };`
      : `const c = globalThis.__nodeCrypto;
         const XP = Buffer.from('302e020100300506032b656e04220420', 'hex'), XS = Buffer.from('302a300506032b656e032100', 'hex');
         const ES = Buffer.from('302a300506032b6570032100', 'hex');
         export function x25519Generate() {
           const k = c.generateKeyPairSync('x25519');
           return { privateKey: new Uint8Array(k.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
                    publicKey: new Uint8Array(k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)) };
         }
         export function x25519Dh(priv, pub) {
           return new Uint8Array(c.diffieHellman({ privateKey: c.createPrivateKey({ key: Buffer.concat([XP, Buffer.from(priv)]), format: 'der', type: 'pkcs8' }),
                                                   publicKey: c.createPublicKey({ key: Buffer.concat([XS, Buffer.from(pub)]), format: 'der', type: 'spki' }) }));
         }
         export const Identity = { verify(pub, data, sig) {
           try { return c.verify(null, Buffer.from(data), c.createPublicKey({ key: Buffer.concat([ES, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig)); }
           catch { return false; } } };` }));
  } };
  await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/groupKeyDelivery.ts'], bundle: true, platform: 'node',
    format: 'esm', outfile: join(dir, 'd.mjs'), logLevel: 'silent', plugins: [stub] });
  const url = pathToFileURL(join(dir, 'd.mjs')).href;

  const cache = new Map();
  /** 一支已登入的手機：{ name, pk, sealer, mod } */
  async function party(name) {
    if (cache.has(name)) return cache.get(name);
    const seed = crypto.randomBytes(32);
    const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
    const pk = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const mod = await import(`${url}?${encodeURIComponent(name)}`);
    assert.equal(typeof mod.friendViaSealer?.seal, 'function', 'groupKeyDelivery exports friendViaSealer (the via is sealed to the receiver\'s identity key)');
    const unlock = () => mod.registerGroupKeySealer({ publicKeyBase64: pk, privateKey: new Uint8Array(seed),
      sign: (d) => new Uint8Array(crypto.sign(null, Buffer.from(d), priv)) });
    unlock();
    /** lock()：登出／冷啟動還沒解鎖身分；unlock()：解鎖 */
    const p = { name, pk, sealer: mod.friendViaSealer, mod, unlock, lock: () => mod.unregisterGroupKeySealer(pk) };
    cache.set(name, p);
    return p;
  }
  return { party, sent: () => globalThis.__friendViaSent };
}

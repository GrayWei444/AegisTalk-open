/**
 * 群組信封封給收件人身分金鑰、經 MQTT 收件匣送（對應群星 c64d268c；多人模擬 S4／S6：非好友成員拿不到輪換後的新金鑰）。
 * 真的 groupKeyDelivery.ts ＋ identitySeal.ts ＋ groupEngineTypes.ts；mqtt 換成記錄器、WASM 的 X25519／Ed25519 換成 Node crypto。
 *   1. A 封給 B（不是好友、沒有 session）→ B 拆得開；C 拆不開；說成別人寄的拆不開；索取也一樣；不認得的種類、超過上限的不封也不收
 *   2. 內容格式（groupEngineTypes）：金鑰 32 bytes、gid／kid 合法、邀請欄位齊全。
 *      收件規則（只收鏈上那一代、kc 對得上、寄件人是成員；只回 mayReceiveKey 允許的人；邀請只收好友、要是寫那筆 add 的人）
 *      W1 起由狀態鏈決定，測在 group_engine_wiring_self_test（#5 邀請、#6 金鑰）與 group_state／group_log 的純模組測試；
 *      舊的 groupKeyRules（decideKeyDistribution／held rotations／「第一階段只對好友放寬」）連同那些斷言一起拿掉了。
 *   3. 換帳號後舊帳號的金鑰不能再用；身分種子用完歸零
 *   4. 接線：邀請／索取／回覆都走信封，1-1 session 上的群組金鑰訊息一律不收；MQTT 型別是 durable、等 listener 期間會暫存
 *   5. 冷啟動：清單載完才判斷寄件者
 * Run: node scripts/review/group_key_delivery_self_test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'gkdeliv-'));
globalThis.__sent = [];
globalThis.__nodeCrypto = crypto;
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$|^\.\/crypto$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, (a) => ({ loader: 'js', contents: a.path === './mqtt'
    ? `export const MessageType = { GROUP_KEY_SEALED: 'group_key_sealed' };
       export const mqttService = { sendToUser(to, type, payload) { globalThis.__sent.push({ to, type, payload }); }, serverNow: () => Date.now() + (globalThis.__clockOffset ?? 0) };`
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
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/groupEngineTypes.ts'], bundle: true, platform: 'node',
  format: 'esm', outfile: join(dir, 'r.mjs'), logLevel: 'silent' });
const url = pathToFileURL(join(dir, 'd.mjs')).href;
const types = await import(pathToFileURL(join(dir, 'r.mjs')).href);
const silence = console.error; console.error = () => {};

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
function account(name) {
  const seed = crypto.randomBytes(32);
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { name, pub, seed, sign: (d) => new Uint8Array(crypto.sign(null, Buffer.from(d), priv)) };
}
async function device(acct) {
  const mod = await import(url + '?' + acct.name);   // 每支手機一份模組（各自的已註冊身分）
  const seedCopy = new Uint8Array(acct.seed);
  mod.registerGroupKeySealer({ publicKeyBase64: acct.pub, privateKey: seedCopy, sign: acct.sign });
  return { mod, seedCopy };
}
const A = account('A'), B = account('B'), C = account('C');
const a = await device(A), b = await device(B), c = await device(C);
const keyBase64 = crypto.randomBytes(32).toString('base64');
const gid = 'Grp1_abcdefghijklmnopq';   // 22 個字元（groupStateCommit GID_RE）
const dist = { kind: 'dist', gid, kid: 'gk-2-def', key: keyBase64 };

// ── 1 ──
await a.mod.sendGroupSealed(B.pub, dist);
const sent = globalThis.__sent.at(-1);
assert.equal(sent.to, B.pub); assert.equal(sent.type, 'group_key_sealed');
assert.ok(!JSON.stringify(sent.payload).includes(keyBase64) && !JSON.stringify(sent.payload).includes(gid), 'the broker sees neither the key nor the group');
// 拆出來的 body 另外帶信封的 from／to／iat／nonce／v（identitySeal 簽進去的）
const opened = (o) => o && { kind: o.kind, from: o.from, body: Object.fromEntries(Object.entries(o.body).filter(([k]) => !['from', 'to', 'iat', 'nonce', 'v'].includes(k))), to: o.body.to };
assert.deepEqual(opened(await b.mod.openGroupSealed(A.pub, sent.payload)), { kind: 'dist', from: A.pub, body: dist, to: B.pub }, 'a non-friend member opens it without any session');
assert.equal(await c.mod.openGroupSealed(A.pub, sent.payload), null, 'another member cannot open it');
assert.equal(await b.mod.openGroupSealed(C.pub, sent.payload), null, 'cannot be passed off as coming from someone else');
await b.mod.sendGroupSealed(A.pub, { kind: 'req', gid, kid: 'gk-2-def' });
assert.deepEqual(opened(await a.mod.openGroupSealed(B.pub, globalThis.__sent.at(-1).payload)), { kind: 'req', from: B.pub, body: { kind: 'req', gid, kid: 'gk-2-def' }, to: A.pub });
const before = globalThis.__sent.length;
await assert.rejects(a.mod.sendGroupSealed(B.pub, { kind: 'state', gid }), /unknown kind/, 'kinds not used in W1 are not sent');
await assert.rejects(a.mod.sendGroupSealed(B.pub, { kind: 'dist', gid, pad: 'x'.repeat(70 * 1024) }), undefined, 'a dist over its 64 KB limit is not sent');
assert.equal(globalThis.__sent.length, before, 'nothing went out');
console.log('PASS envelopes reach non-friend members; only the addressee opens them, sender is authenticated; kinds and sizes are bounded');

// ── 2 內容格式 ──
assert.deepEqual(types.parseKeyDist(dist), { gid, kid: 'gk-2-def', key: new Uint8Array(Buffer.from(keyBase64, 'base64')) });
assert.equal(types.parseKeyDist({ ...dist, key: 'c2hvcnQ=' }), null, 'key must be 32 bytes');
assert.equal(types.parseKeyDist({ ...dist, key: Buffer.alloc(33).toString('base64') }), null);
assert.equal(types.parseKeyDist({ ...dist, gid: '../x' }), null, 'gid must be well-formed');
assert.equal(types.parseKeyDist({ ...dist, kid: 'x'.repeat(500) }), null, 'kid must be well-formed');
assert.deepEqual(types.parseKeyRequest({ gid, kid: 'gk-2-def' }), { gid, kid: 'gk-2-def' });
assert.equal(types.parseKeyRequest({ gid, kid: 3 }), null);
const inv = { gid, chain: [{}], kid: 'gk-2-def', key: keyBase64, headSeq: 3, baseSeq: 1 };
assert.ok(types.parseInvite(inv), 'a complete invite parses');
for (const [k, v] of [['chain', []], ['chain', 'x'], ['headSeq', -1], ['headSeq', 1.5], ['baseSeq', '1'], ['key', 'c2hvcnQ='], ['parentLogKey', 'c2hvcnQ='], ['gid', '../x']]) {
  assert.equal(types.parseInvite({ ...inv, [k]: v }), null, `invite with bad ${k} is refused`);
}
console.log('PASS envelope contents are shape-checked (receive rules are chain rules: see group_engine_wiring #5/#6)');

// ── 3 ──
assert.ok(a.seedCopy.every((x) => x === 0), 'the identity seed copy is wiped after deriving the X25519 key');
b.mod.unregisterGroupKeySealer(B.pub);
await a.mod.sendGroupSealed(B.pub, dist);
assert.equal(await b.mod.openGroupSealed(A.pub, globalThis.__sent.at(-1).payload), null, 'after logout nothing is opened');
await assert.rejects(b.mod.sendGroupSealed(A.pub, { kind: 'req', gid, kid: 'gk-2-def' }), undefined, 'after logout nothing is sent');
assert.equal(b.mod.currentSealer(), null, 'and the engine cannot sign or open key packages any more');
a.mod.unregisterGroupKeySealer('SOMEONE-ELSE');
await a.mod.sendGroupSealed(C.pub, dist);
assert.ok(await c.mod.openGroupSealed(A.pub, globalThis.__sent.at(-1).payload), 'another account\'s logout does not unregister me');
console.log('PASS logout stops sealing/opening; the seed copy is wiped');

// ── 4 接線 ──
console.error = silence;
const read = (p) => readFileSync(root + 'packages/pwa/src/' + p, 'utf8');
const provider = read('providers/AppProvider.tsx');
const hook = read('hooks/useGroupChat.ts');
const mqtt = read('services/mqtt.ts');
const sealedSrc = read('services/groupEngineSealed.ts');
const engineSrc = read('services/groupEngine.ts');
assert.ok(/mqtt\.subscribe\(MessageType\.GROUP_KEY_SEALED/.test(provider), 'AppProvider listens for sealed group envelopes');
const sealedHandler = provider.slice(provider.indexOf('mqtt.subscribe(MessageType.GROUP_KEY_SEALED'));
const openAt = sealedHandler.indexOf('openGroupSealed(');
assert.ok(sealedHandler.indexOf('isBlacklisted(message.from)') > 0 && sealedHandler.indexOf('isBlacklisted(message.from)') < openAt, 'blocked senders are dropped before opening');
assert.ok(sealedHandler.indexOf('engine.onSealed(opened.from, opened.body)') > openAt, 'opened envelopes go to the group engine (chain rules)');
assert.ok(/sendSealed: async \(to, body\) => \{ await sendGroupSealed\(to, body\); \}/.test(provider), 'the engine seals through groupKeyDelivery');
assert.ok(/registerGroupKeySealer\(/.test(provider) && /unregisterGroupKeySealer\(/.test(provider), 'the sealer follows the unlocked identity');
for (const kind of ['invite', 'ack', 'req', 'dist']) {
  assert.ok(new RegExp(`sendSealed\\([^)]*\\{ kind: '${kind}'`).test(sealedSrc), `the engine sends ${kind} as a sealed envelope`);
}
const oneToOne = provider.slice(provider.indexOf("if (ctl === 'group_key_distribution' || ctl === 'group_key_request') {"));
assert.ok(oneToOne.length > 0 && /^[^]*?diagLog\([^]*?\);\s*return;\s*\}/.test(oneToOne.slice(0, 400)), 'group keys over the 1-1 channel are ignored');
assert.ok(!/acceptGroupKeyDistribution|answerGroupKeyRequest|sendGroupKeyDistribution|decideKeyDistribution|holdRotation|holdUnknownGroupKey/.test(provider + hook + sealedSrc + engineSrc),
  'none of the pre-chain key paths are left');
assert.ok(!/encryptToJson\(pk, body\)|encrypt\(pk, body\)/.test(provider), 'no key is sent over a 1-1 session');
assert.ok(!/encrypt\(memberPk, JSON\.stringify\(keyDist\)\)|encrypt\(memberPublicKey, JSON\.stringify\(keyDist\)\)|encrypt\(pk, body\)/.test(hook), 'useGroupChat no longer needs a 1-1 session to hand out keys');
assert.ok(/GROUP_KEY_SEALED = 'group_key_sealed'/.test(mqtt), 'new MQTT type');
const durable = mqtt.slice(mqtt.indexOf('DURABLE_TYPES = new Set'), mqtt.indexOf(']);', mqtt.indexOf('DURABLE_TYPES = new Set')));
assert.ok(/MessageType\.GROUP_KEY_SEALED/.test(durable), 'sealed keys are durable (persisted until the broker acknowledges)');
const persistent = mqtt.slice(mqtt.indexOf('const PERSISTENT_MSG_TYPES'), mqtt.indexOf('];', mqtt.indexOf('const PERSISTENT_MSG_TYPES')));
assert.ok(/'group_key_sealed'/.test(persistent), '24 h freshness (the broker queues them while the recipient is offline)');
const critical = mqtt.slice(mqtt.indexOf('CRITICAL_PENDING = new Set'), mqtt.indexOf(']);', mqtt.indexOf('CRITICAL_PENDING = new Set')));
assert.ok(/MessageType\.GROUP_KEY_SEALED/.test(critical), 'kept while no listener is registered yet (own budget, 120 s)');
const cryptoSrc = read('services/crypto.ts');
assert.ok(/export function x25519Generate\(/.test(cryptoSrc) && /X25519KeyPair\.fromBytes\(privateKey\)/.test(cryptoSrc) && /keyPair\.diffieHellman\(publicKey\)/.test(cryptoSrc), 'X25519 runs in the WASM core (crypto-core X25519KeyPair)');
const keysRs = readFileSync(root + 'packages/crypto-core/src/crypto/keys.rs', 'utf8');
assert.ok(/js_name = diffieHellman/.test(keysRs) && /js_name = fromBytes/.test(keysRs) && /js_name = privateKeyBytes/.test(keysRs), 'the AegisTalk crypto-core exports the X25519 helpers');
console.log('PASS wiring: every invite, key request and reply goes through the sealed envelope; 1-1 group keys are ignored');

// ── 5 冷啟動：清單還沒載完就到的信封，等清單載完才判斷（程式碼審查 H2） ──
assert.ok(sealedHandler.indexOf('await waitForLocalLists()') > 0
  && sealedHandler.indexOf('await waitForLocalLists()') < openAt, 'the sealed-envelope listener waits for the friend and group lists first');
assert.ok(/getFriendByPublicKey\(pk\)\s*\|\|\s*await findFriendSettled\(pk\)/.test(provider.slice(provider.indexOf('async function isFriendOrFellowMember('))),
  'the sender check waits for a (re)loading friend list');
assert.ok(/isFriend: async \(pk\) => !!\(useChatStore\.getState\(\)\.getFriendByPublicKey\(pk\) \|\| await findFriendSettled\(pk\)\)/.test(provider),
  'and so does the engine\'s "invites only from friends" check');
{
  const { transformSync } = require('esbuild');
  const { runInNewContext } = await import('node:vm');
  const fnSrc = provider.slice(provider.indexOf('function waitForLocalLists('), provider.indexOf('\n}\n', provider.indexOf('function waitForLocalLists(')) + 3);
  const mkStore = (loaded) => { const subs = new Set(); const st = { isLoaded: loaded };
    return { st, store: { getState: () => st, subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); } }, emit: () => subs.forEach((cb) => cb()), subs }; };
  const chat = mkStore(false); const grp = mkStore(true);
  const ctx = { globalThis: {}, setTimeout, clearTimeout, Promise, useChatStore: chat.store, useGroupStore: grp.store };
  runInNewContext(transformSync(fnSrc + '\nglobalThis.__w = waitForLocalLists;', { loader: 'ts' }).code, ctx);
  let done = false;
  const p = ctx.globalThis.__w(5_000).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, 'waits while the friend list is still loading');
  chat.st.isLoaded = true; chat.emit();
  await p;
  assert.equal(done, true, 'resumes as soon as both lists are loaded');
  assert.equal(chat.subs.size + grp.subs.size, 0, 'and unsubscribes');
  const t0 = Date.now(); chat.st.isLoaded = false;
  await ctx.globalThis.__w(60);
  assert.ok(Date.now() - t0 >= 50, 'bounded wait if the lists never load');
}
console.log('PASS cold start: sealed keys are judged only after the friend and group lists are loaded (bounded wait)');

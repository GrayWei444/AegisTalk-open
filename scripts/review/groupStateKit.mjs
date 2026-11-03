/**
 * 群組狀態鏈／控制信封測試共用：用 esbuild 打包真的 services/*.ts 後載入；Ed25519 由 Node crypto 提供（App 裡是 WASM）。
 * AEGISTALK_PWA_SRC 可以指向另一份 src（變異測試：在副本裡故意拿掉某個保護，確認測試會失敗；不動正式檔案）。
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
export const SRC = process.env.AEGISTALK_PWA_SRC ?? root + 'packages/pwa/src';

export async function load(name) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  await require('esbuild').build({ entryPoints: [`${SRC}/services/${name}.ts`], bundle: true, platform: 'node', format: 'esm',
    outfile: join(dir, 'm.mjs'), logLevel: 'silent' });
  return import(pathToFileURL(join(dir, 'm.mjs')));
}

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export const b64 = (u8) => Buffer.from(u8).toString('base64');
export const b64url = (u8) => Buffer.from(u8).toString('base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** 由標籤決定的 Ed25519 身分（同一個標籤每次都是同一把，性質測試可重現） */
export function identity(label = crypto.randomBytes(8).toString('hex')) {
  const seed = sha256(`ed25519-seed|${label}`);
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = new Uint8Array(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { label, pk: b64(pub), pub, sign: (data) => new Uint8Array(crypto.sign(null, Buffer.from(data), priv)) };
}

export function verify(pub, data, sig) {
  try {
    return crypto.verify(null, Buffer.from(data), crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));
  } catch {
    return false;
  }
}

/**
 * 測試用的 Ed25519 點運算（BigInt、仿射座標，跟受測的 ed25519Strict.ts 各寫各的）：
 * 做「不在曲線上」「混了小階成分」的公鑰、R 特製的簽章，以及寬鬆／嚴格／cofactored 三種驗章器。很慢（每次純量乘法約 0.1 秒），只在少數案例用。
 */
export const ed = (() => {
  const p = (1n << 255n) - 19n;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const mod = (a, m = p) => ((a % m) + m) % m;
  const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % p; b = b * b % p; e >>= 1n; } return r; };
  const inv = (a) => pow(a, p - 2n);
  const d = mod(-121665n * inv(121666n));
  const sqrtM1 = pow(2n, (p - 1n) / 4n);
  const le = (u8) => [...u8].reverse().reduce((n, b) => (n << 8n) | BigInt(b), 0n);
  const le32 = (n) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const O = [0n, 1n];
  /** RFC 8032 解碼；strict＝y 必須 < p（寬鬆版把 y 先 mod p，像 curve25519-dalek 的 decompress） */
  function decode(bytes, strict = true) {
    const sign = bytes[31] >> 7;
    let y = le(Uint8Array.from(bytes, (b, i) => (i === 31 ? b & 0x7f : b)));
    if (y >= p) { if (strict) return null; y = mod(y); }
    const u = mod(y * y - 1n), v = mod(d * y * y + 1n);
    let x = pow(u * inv(v), (p + 3n) / 8n);
    if (mod(v * x * x) !== u) { x = mod(x * sqrtM1); if (mod(v * x * x) !== u) return null; }
    if (x === 0n && sign) return null;
    if (Number(x & 1n) !== sign) x = p - x;
    return [x, y];
  }
  const encode = ([x, y]) => { const out = le32(y); out[31] |= Number(x & 1n) << 7; return out; };
  function add([x1, y1], [x2, y2]) {
    const t = mod(d * x1 * x2 * y1 * y2);
    return [mod((x1 * y2 + y1 * x2) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))];
  }
  function mul(P, n) {
    let r = O;
    for (const bit of mod(n, 1n << 256n).toString(2)) { r = add(r, r); if (bit === '1') r = add(r, P); }
    return r;
  }
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  const B = decode(Buffer.from('5866666666666666666666666666666666666666666666666666666666666666', 'hex'));
  /** 8 階的點（加到誠實公鑰上＝混了小階成分） */
  const T8 = decode(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'));
  const IDENTITY_ENC = encode(O);
  const sha512mod = (...parts) => mod(le(crypto.createHash('sha512').update(Buffer.concat(parts.map((x) => Buffer.from(x)))).digest()), L);
  /** 由標籤的種子算 clamp 過的私鑰純量（跟 identity() 同一把） */
  function scalarOf(label) {
    const h = crypto.createHash('sha512').update(sha256(`ed25519-seed|${label}`)).digest();
    const a = Uint8Array.from(h.subarray(0, 32));
    a[0] &= 248; a[31] &= 127; a[31] |= 64;
    return le(a);
  }
  /** 簽章，R 可以特製：rPoint(r) 回傳要用的 R 點（預設 [r]B）；sAdd 加在 S 上（例如 L → 非正規 S） */
  function signCustom(label, pub, msg, { r = 12345n, rPoint, rBytes, sAdd = 0n } = {}) {
    const a = scalarOf(label);
    const Renc = rBytes ?? encode(rPoint ? rPoint(r) : mul(B, r));
    const k = sha512mod(Renc, pub, msg);
    return Uint8Array.from([...Renc, ...le32(mod(r + k * a, L) + sAdd)]);
  }
  /** 三種驗章器（都照 RFC 8032 算 k）：cofactorless 寬鬆（只比 R 的位元組）、dalek verify_strict 式、ZIP-215 cofactored */
  function parts(pub, msg, sig, strictDecode) {
    const A = decode(pub, strictDecode), R = decode(sig.subarray(0, 32), strictDecode), S = le(sig.subarray(32));
    return { A, R, S, k: sha512mod(sig.subarray(0, 32), pub, msg) };
  }
  const neg = ([x, y]) => [mod(-x), y];
  const smallOrder = (P) => eq(mul(P, 8n), O);
  function verifyLenient(pub, msg, sig) {
    const { A, S, k } = parts(pub, msg, sig, true);
    if (!A || S >= L) return false;
    return Buffer.from(encode(add(mul(B, S), mul(neg(A), k)))).equals(Buffer.from(sig.subarray(0, 32)));
  }
  function verifyStrict(pub, msg, sig) {
    const { A, R, S, k } = parts(pub, msg, sig, false);
    if (!A || !R || S >= L || smallOrder(A) || smallOrder(R)) return false;
    return eq(add(mul(B, S), mul(neg(A), k)), R);
  }
  function verifyCofactored(pub, msg, sig) {
    const { A, R, S, k } = parts(pub, msg, sig, false);
    if (!A || !R || S >= L) return false;
    return eq(mul(add(add(mul(B, S), mul(neg(A), k)), neg(R)), 8n), O);
  }
  /** 32 bytes、y < p、不在小階名單，但不是曲線上的點（舊的 validPubkey 會收） */
  function offCurveKey(seed) {
    for (let i = 0; ; i++) {
      const b = new Uint8Array(sha256(`off-curve|${seed}|${i}`));
      b[31] &= 0x7f;
      if (!decode(b)) return Buffer.from(b).toString('base64');
    }
  }
  /** 誠實公鑰 ＋ 8 階點：在曲線上，但混了小階成分 */
  const mixedOrderKey = (pkB64) => Buffer.from(encode(add(decode(Buffer.from(pkB64, 'base64')), T8))).toString('base64');
  return { p, L, B, T8, O, IDENTITY_ENC, decode, encode, add, mul, le32, signCustom, verifyLenient, verifyStrict, verifyCofactored, offCurveKey, mixedOrderKey };
})();

/** 由標籤決定的 32 bytes 群組金鑰 */
export const groupKey = (label) => new Uint8Array(sha256(`group-key|${label}`));

/** 不靠受測模組、照規格自己算 kc = HMAC-SHA256(K, "aegistalk-gkc-v1|gid|kid")（URL-safe base64） */
export const kcSpec = (key, gid, kid) => crypto.createHmac('sha256', Buffer.from(key)).update(`aegistalk-gkc-v1|${gid}|${kid}`).digest('base64url');

/** 可重現的亂數（mulberry32） */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

export function shuffle(xs, r) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** X25519（App 裡是 WASM；這裡用 Node crypto） */
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
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
/** 身分的 Ed25519 種子（identity() 用同一個標籤算的） */
export const seedOf = (label) => new Uint8Array(sha256(`ed25519-seed|${label}`));

/**
 * 小幫手：G = groupState 模組。建群、簽下一筆（換金鑰的 op 自動補 kid／kc／kb）、照順序接上直線鏈。
 * kb 在這裡只是格式正確的雜湊（鏈的規則不看封裝包）；要真的封裝包請用 groupLog.buildCommitEntry。
 */
export function chainKit(G) {
  let kidCounter = 0;
  const keys = new Map();   // kid → key bytes
  /** state 的 head 上、actor 寫的換金鑰 commit 要用的新一代：kid 由位置與作者決定（審查 L5；舊版沒有 epochKidFor 就自己編） */
  const freshKey = async (state, actor) => {
    const kid = typeof G.epochKidFor === 'function' ? await G.epochKidFor(state.head.id, actor.pk ?? actor) : `k${++kidCounter}-${crypto.randomBytes(3).toString('hex')}`;
    const key = groupKey(kid + crypto.randomBytes(3).toString('hex'));
    keys.set(kid, key);
    return { kid, key, kc: await G.keyCommitment(key, state.gid, kid), kb: crypto.randomBytes(32).toString('base64url') };
  };
  async function genesis(creator, opts = {}) {
    const kid = `k${++kidCounter}-g`;
    const key = groupKey(kid + crypto.randomBytes(3).toString('hex'));
    keys.set(kid, key);
    const g = await G.createGenesis({ creator: creator.pk, sign: creator.sign, name: opts.name ?? 'SimGroup', key, kid, ts: opts.ts ?? 1_000, ...opts });
    return { ...g, kid, key };
  }
  /** state 之後的下一筆（不檢查權限，方便做不合法的 commit）；remove／rekey 沒給 kid 就自動補 */
  async function next(state, who, op, args = {}, ts = state.head.v * 1_000 + 1_000) {
    const full = { ...args };
    if ((op === 'remove' || op === 'rekey') && !('kid' in full)) {
      const { kid, kc, kb } = await freshKey(state, who);
      Object.assign(full, { kid, kc, kb });
    }
    return G.signCommit(G.proposeCommit(state, who.pk, op, full, ts), who.sign, who.pk);
  }
  /** actor 加回舊成員要帶的新一代 */
  async function readdArgs(state, pk, actor) {
    const { kid, kc, kb } = await freshKey(state, actor);
    return { pk, kid, kc, kb };
  }
  /** 從 genesis 開始的直線鏈 */
  async function start(g) {
    const r = await G.startChain(g.gid, { c: g.commit.c, s: g.commit.s }, verify);
    if (!r.ok) throw new Error(r.reason);
    return r.view;
  }
  /** 簽好的 commit 依序接上，每一筆都要成功 */
  async function extend(view, commits) {
    let v = view;
    for (const c of commits) {
      const res = await G.appendCommit(v, c, verify);
      if (!res.ok) throw new Error(`expected appended, got ${res.reason}`);
      v = res.view;
    }
    return v;
  }
  /** 一筆一筆從 head 往下簽並接上 */
  async function run(view, steps) {
    let v = view;
    for (const [who, op, args, ts] of steps) v = await extend(v, [await next(v.state, who, op, args, ts)]);
    return v;
  }
  return { genesis, start, next, extend, run, freshKey, readdArgs, keys };
}

/**
 * 群組 log 的模擬（伺服器 log ＝ 陣列）與客戶端小幫手。G = groupState、L = groupLog、S = identitySeal（都是 load() 載入的真模組）。
 * 也能拿舊版 src 跑（AEGISTALK_PWA_SRC）：沒有的新 API（confirmInvite 等）就退回舊的做法，讓回歸測試在舊版上照樣跑到斷言、而且失敗。
 */
export function logKit(G, L, S) {
  const wire = (vc) => ({ c: vc.c, s: vc.s });
  const randomKey = () => new Uint8Array(crypto.randomBytes(32));
  function newLog() {
    const entries = [];
    return {
      entries,
      append: (blob) => { entries.push({ seq: entries.length + 1, blob }); return entries.length; },
      after: (seq) => entries.filter((e) => e.seq > seq),
      head: () => entries.length,
    };
  }
  async function client(id, rep, keys, verifyFn = verify) {
    return { id, rep, keys: new Map(keys), xpriv: await S.edSeedToX25519Scalar(seedOf(id.label)), verify: verifyFn };
  }
  const deps = (cl) => ({ verify: cl.verify, keyFor: (kid) => cl.keys.get(kid) ?? null, myX25519Private: cl.xpriv, x25519 });
  /** 照 seq 套用（預設：伺服器 log 裡 processedSeq 之後的全部） */
  async function pull(cl, log, entries) {
    const res = await L.applyLog(cl.rep, entries ?? log.after(cl.rep.processedSeq), deps(cl));
    for (const nk of res.newKeys) cl.keys.set(nk.kid, nk.key);
    cl.rep = res.replica;
    return res;
  }
  /** 換金鑰 op 要的新一代：新版 kid 由位置決定（只給金鑰），舊版要自己給 kid */
  const newEpoch = () => (typeof G.epochKidFor === 'function' ? { key: randomKey() } : { kid: 'e' + crypto.randomBytes(6).toString('hex'), key: randomKey() });
  function build(cl, op, args, opts = {}) {
    const rekeys = op === 'rekey' || op === 'remove' || (op === 'add' && cl.rep.view.state.former.includes(args.pk));
    return L.buildCommitEntry({
      view: cl.rep.view, actor: cl.id.pk, sign: opts.sign ?? cl.id.sign, op, args, ts: opts.ts ?? 5,
      epochKey: cl.keys.get(cl.rep.view.state.epoch.kid), newEpoch: opts.newEpoch ?? (rekeys ? newEpoch() : undefined),
    }, x25519);
  }
  /** 寫一筆並 append（作者先存好新金鑰） */
  async function submit(cl, log, op, args, opts = {}) {
    const built = await build(cl, op, args, opts);
    if (built.newEpoch) cl.keys.set(built.newEpoch.kid, built.newEpoch.key);
    return { seq: log.append(built.blob), built };
  }
  /** 手工簽一筆（不經作者端檢查，做不合法的 commit） */
  function forge(state, who, op, args, ts = 7) {
    const c = G.proposeCommit(state, who.pk, op, args, ts);
    return { c, s: b64(who.sign(new TextEncoder().encode(G.GSTATE_DOMAIN + G.commitBody(c)))) };
  }
  /** 用 state 那一代的金鑰把 commit 封成 entry 並 append */
  async function appendRaw(log, state, key, commit, bundle) {
    return log.append(await L.sealLogEntry({ gid: state.gid, kid: state.epoch.kid, key, commit, bundle }));
  }
  async function newGroup(creator, opts = {}) {
    const k = chainKit(G);
    const g = await k.genesis(creator, opts);
    const log = newLog();
    const seq = log.append(await L.sealGenesisEntry({ gid: g.gid, genesis: wire(g.commit), kid: g.kid, key: g.key }));
    const view = await k.start(g);
    return { k, g, log, owner: await client(creator, L.startLog({ view, me: creator.pk, headSeq: seq }), [[g.kid, g.key]]) };
  }
  /** 邀請的內容（inviter 看到 add 上鏈之後）：新版用 inviteParams，舊版只有整條鏈＋seq */
  function inviteOf(inviter, addId, addSeq) {
    if (typeof L.inviteParams === 'function') return L.inviteParams(inviter.rep, addId);
    const at = inviter.rep.view.chain.findIndex((x) => x.id === addId);
    return { chain: inviter.rep.view.chain.slice(0, at + 1).map(wire), headSeq: addSeq, baseSeq: addSeq };
  }
  /**
   * 新成員收邀請：verifyInvite（鏈與金鑰）＋對照伺服器 log 確認（confirmInvite，審查 M1）；舊版沒有確認，直接 startLog。
   * 回傳 { ok, client?, reason? }。
   */
  async function accept(who, p, log, verifyFn = verify) {
    const gid = p.gid;
    const res = await G.verifyInvite({ chain: p.chain, gid, me: who.pk, key: p.key, verify: verifyFn });
    if (!res.ok) return res;
    const cl = await client(who, null, [[p.key.kid, p.key.key]], verifyFn);
    if (typeof L.confirmInvite !== 'function') {
      cl.rep = L.startLog({ view: res.view, me: who.pk, headSeq: p.headSeq });
      return { ok: true, client: cl };
    }
    const conf = await L.confirmInvite({ view: res.view, me: who.pk, key: p.key, headSeq: p.headSeq, baseSeq: p.baseSeq,
      entries: log.after(p.baseSeq - 1), logHead: log.head(), ...(p.parentLogKey ? { parentLogKey: p.parentLogKey } : {}) }, deps(cl));
    if (!conf.ok) return conf;
    for (const nk of conf.result.newKeys) cl.keys.set(nk.kid, nk.key);
    cl.rep = conf.result.replica;
    return { ok: true, client: cl };
  }
  /** inviter 把 who 加進來、看到自己的 add 上鏈後送邀請；who 驗證並對照 log 確認 */
  async function invite(inviter, log, who) {
    const { seq, built } = await submit(inviter, log, 'add', { pk: who.pk });
    await pull(inviter, log);
    const params = inviteOf(inviter, built.id, seq);
    if (!params) throw new Error('add not applied');
    const addV = params.chain.length;
    const { kid } = inviter.rep.view.state.epochs.filter((e) => e.v <= addV).at(-1);   // 加我那時正在用的那一代
    // 加回舊成員：另附上一代的只讀 log 金鑰（只用來對照 log）
    const parentLogKey = params.parentKid ? await L.logKeyBytes(inviter.keys.get(params.parentKid), inviter.rep.view.gid) : undefined;
    const res = await accept(who, { ...params, gid: inviter.rep.view.gid, key: { kid, key: inviter.keys.get(kid) }, parentLogKey }, log);
    if (!res.ok) throw new Error(`invite rejected: ${res.reason}`);
    return res.client;
  }
  return { wire, newLog, client, deps, pull, build, submit, forge, appendRaw, newGroup, inviteOf, accept, invite, newEpoch };
}

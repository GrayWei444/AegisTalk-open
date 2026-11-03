/**
 * 邀請的整條鏈放到 Web Worker 驗（W1 待辦，W2）：真的 services/groupInviteWorker.ts（WASM 換成 Node crypto 的 Ed25519）
 * 與 groupInviteVerify.ts（主執行緒那一端）。
 *   1. Worker 的結果跟主執行緒的 verifyInvite 一樣（接受與拒收都一樣）；回來的 view 重新凍結
 *   2. Worker 壞掉（onerror）、回了怪東西、根本沒有 Worker → 在主執行緒驗（絕不跳過驗證、絕不因此收下壞邀請），壞過一次就不再用；
 *      逾時 → 換新的 Worker 再試一次，兩次都逾時 → 丟 invite-verify-timeout（加入流程稍後再試），不在主執行緒驗
 *   3. 耗時：同一條鏈在主執行緒與 Worker（這裡是同一個 process，只看功能；數字見 docs/GROUP_LOG_WIRING_W2.md）
 * Run: node scripts/review/group_invite_worker_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC, load, identity, verify, chainKit } from './groupStateKit.mjs';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'ginvw-'));
globalThis.__verify = verify;
const quiet = console.error;
console.error = (...a) => { if (!/^\[groupInvite\]/.test(String(a[0]))) quiet(...a); };

// 真的 Worker 模組：WASM 換成 Node 的 Ed25519；self 換成假的（收 onmessage、記 postMessage）
const wasmStub = { name: 'wasm', setup(b) {
  b.onResolve({ filter: /wasm\/pkg\/safetalk_core$/ }, () => ({ path: 'wasm', namespace: 'w' }));
  b.onLoad({ filter: /.*/, namespace: 'w' }, () => ({ loader: 'js', contents: `
    export default async function init() { globalThis.__wasmInits = (globalThis.__wasmInits ?? 0) + 1; }
    export const IdentityKeyPair = { verifySignature: (pk, data, sig) => globalThis.__verify(pk, data, sig) };` }));
} };
await build({ entryPoints: [`${SRC}/services/groupInviteWorker.ts`], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'worker.mjs'), logLevel: 'silent', plugins: [wasmStub] });
await build({ entryPoints: [`${SRC}/services/groupInviteVerify.ts`], bundle: true, platform: 'node', format: 'esm',
  outfile: join(dir, 'client.mjs'), logLevel: 'silent', define: { 'import.meta.env': '{}' } });

/** 每次 new 一個「Worker」：載入真的 worker 模組（各自一份 self），訊息用 structuredClone 傳（跟瀏覽器一樣） */
let workerSeq = 0;
async function realWorker() {
  const posted = [];
  const fake = { onmessage: null, postMessage: (m) => posted.push(m) };
  globalThis.self = fake;
  await import(pathToFileURL(join(dir, 'worker.mjs')) + `?w${++workerSeq}`);
  const handler = fake.onmessage;
  const w = {
    onmessage: null, onerror: null, terminated: false, calls: 0,
    postMessage(m) {
      w.calls++;
      const req = structuredClone(m);
      setImmediate(() => handler({ data: req }));
      const poll = setInterval(() => {
        const out = posted.shift();
        if (!out) return;
        clearInterval(poll);
        w.onmessage?.({ data: structuredClone(out) });
      }, 1);
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

const G = await load('groupState');
const K = chainKit(G);
const C = await import(pathToFileURL(join(dir, 'client.mjs')));
const admin = identity('inv-admin');
const people = Array.from({ length: 30 }, (_, i) => identity(`inv-m${i}`));
const invitee = identity('inv-invitee');
const g = await K.genesis(admin, { name: 'Worker' });
let view = await K.start(g);
view = await K.run(view, people.map((p) => [admin, 'add', { pk: p.pk }]));
for (let i = 0; i < 60; i++) view = await K.run(view, [[admin, 'info', { name: `Worker ${i}` }]]);
view = await K.run(view, [[admin, 'add', { pk: invitee.pk }]]);
const chain = view.chain.map((x) => ({ c: x.c, s: x.s }));
const key = { kid: view.state.epoch.kid, key: K.keys.get(view.state.epoch.kid) };
const params = { chain, gid: g.gid, me: invitee.pk, key };
const tampered = structuredClone(chain);
tampered[5].c.args.pk = people[7].pk;
const bad = { ...params, chain: tampered };

// ── 1 ──
const t0 = Date.now();
const main = await G.verifyInvite({ ...params, verify });
const mainMs = Date.now() - t0;
assert.ok(main.ok);
const w1 = await realWorker();
const viaWorker = C.createInviteVerifier({ verify, makeWorker: () => w1 });
const t1 = Date.now();
const r1 = await viaWorker(params);
const workerMs = Date.now() - t1;
assert.equal(w1.calls, 1, 'the chain went to the worker');
assert.ok(r1.ok && r1.addedBy === admin.pk);
assert.equal(r1.view.state.head.id, main.view.state.head.id, 'same chain as on the main thread');
assert.deepEqual(r1.view.state.members.map((m) => m.pk), main.view.state.members.map((m) => m.pk));
assert.ok(Object.isFrozen(r1.view) && Object.isFrozen(r1.view.state) && Object.isFrozen(r1.view.chain[0].c), 're-frozen after the structured clone');
const rBad = await viaWorker(bad);
assert.deepEqual([rBad.ok, rBad.reason], [false, (await G.verifyInvite({ ...bad, verify })).reason], 'a tampered chain is refused in the worker exactly as on the main thread');
assert.equal(w1.calls, 2);
const rKey = await viaWorker({ ...params, key: { kid: key.kid, key: new Uint8Array(32).fill(3) } });
assert.deepEqual([rKey.ok, rKey.reason], [false, 'key-mismatch'], 'the key bytes cross the worker boundary intact');
console.log(`PASS worker: same answers as the main thread (accept, tampered chain, wrong key); view re-frozen (${chain.length} commits: main ${mainMs} ms, worker ${workerMs} ms in this process)`);

// ── 2 ──
{
  let made = 0;
  const broken = C.createInviteVerifier({ verify, makeWorker: () => { made++; return { onmessage: null, onerror: null, postMessage() { setImmediate(() => this.onerror?.({ message: 'wasm failed to load' })); }, terminate() {} }; } });
  const r = await broken(params);
  assert.ok(r.ok, 'a broken worker → verified on the main thread');
  assert.equal((await broken(bad)).ok, false, 'and a bad chain is still refused');
  assert.equal(made, 1, 'a broken worker is not tried again');
  const liar = C.createInviteVerifier({ verify, makeWorker: () => ({ onmessage: null, onerror: null,
    postMessage(m) { setImmediate(() => this.onmessage?.({ data: { id: m.id, result: { ok: 'yes' } } })); }, terminate() {} }) });
  assert.equal((await liar(bad)).ok, false, 'a malformed worker reply is not taken as an acceptance');
  let silentMade = 0;
  const silent = C.createInviteVerifier({ verify, timeoutMs: 50, makeWorker: () => { silentMade++; return { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; } });
  await assert.rejects(silent(bad), /invite-verify-timeout/, 'two timeouts in a row → "try later", not a long chain on the main thread');
  await assert.rejects(silent(params), /invite-verify-timeout/);
  assert.equal(silentMade, 4, 'each timeout retires that worker and retries once in a fresh one (not stuck on the main thread for the session)');
  // 審查 W2 #10：第一個 Worker 逾時（很長的鏈、手機很忙），換一個新的就驗完了 → 還是在 Worker 裡
  const fresh = await realWorker();
  let madeFlaky = 0;
  const flaky = C.createInviteVerifier({ verify, timeoutMs: 2_000, makeWorker: () => (++madeFlaky === 1
    ? { onmessage: null, onerror: null, postMessage() {}, terminate() {} } : fresh) });
  const r2 = await flaky(params);
  assert.ok(r2.ok && madeFlaky === 2 && fresh.calls === 1, 'after a timeout the next attempt runs in a fresh worker');
  assert.ok(Object.isFrozen(r2.view), 'and the result came from the worker (re-frozen)');
  const none = C.createInviteVerifier({ verify, makeWorker: () => null });
  assert.ok((await none(params)).ok && !(await none(bad)).ok, 'no Worker at all → main thread');
  const throws = C.createInviteVerifier({ verify, makeWorker: () => { throw new Error('module workers unsupported'); } });
  assert.ok((await throws(params)).ok, 'a Worker constructor that throws → main thread');
  assert.equal(C.makeInviteWorker(), null, 'makeInviteWorker is null where there is no Worker (Node)');
  console.log('PASS fallbacks: broken / lying / missing worker → main thread, never skipped; timeouts → fresh worker, then "try later"');
}
console.error = quiet;
process.exit(0);

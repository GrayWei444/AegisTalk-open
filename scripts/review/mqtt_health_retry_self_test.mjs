/**
 * MQTT 健康監控（傳輸統一 X1）：真的 mqttHealthMonitor.ts，stub 掉 mqtt.ts。
 *   以前連續重連失敗 5 次就停在 paused，只有切回前景或網路恢復才會再試
 *   → 桌機分頁一直開在前景時，broker 重啟幾分鐘後就永久斷線。
 *   現在：失敗 5 次後改用慢速退避（約 60s）繼續重試；連上後回到正常退避。
 * Run: node scripts/review/mqtt_health_retry_self_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url).pathname;
const require = createRequire(root + 'packages/pwa/package.json');
const dir = mkdtempSync(join(tmpdir(), 'mqtthealth-'));
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/mqtt$/ }, (a) => ({ path: a.path, namespace: 's' }));
  b.onLoad({ filter: /.*/, namespace: 's' }, () => ({ loader: 'js', contents: `
    export const ConnectionState = { DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected' };
    export const mqttService = globalThis.__mqtt;` }));
} };
await require('esbuild').build({ entryPoints: [root + 'packages/pwa/src/services/mqttHealthMonitor.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'h.mjs'), logLevel: 'silent', plugins: [stub] });

// broker.up=false 時 forceReconnect 連不上；up=true 時連得上
const broker = { up: false, connected: false, attempts: 0 };
globalThis.__mqtt = {
  getHealthInfo: () => ({ publicKey: 'A'.repeat(44), hasPinHash: true, tokenFailed: false, wsReadyState: null,
    state: broker.connected ? 'connected' : 'disconnected', clientConnected: broker.connected, lastMessageReceivedAt: 0 }),
  forceReconnect: async () => { broker.attempts++; broker.connected = broker.up; },
};
// 退避的等待不真的睡，只記錄延遲；probe 的 setInterval 不跑，由測試手動觸發
const delays = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
console.error = () => {};
Math.random = () => 0.5; // jitter = 0

const { mqttHealthMonitor: mon } = await import(pathToFileURL(join(dir, 'h.mjs')));
mon.start();

for (let i = 0; i < 8; i++) await mon._probe();
assert.equal(broker.attempts, 8, `keeps reconnecting after 5 failures while foreground (got ${broker.attempts} of 8)`);
assert.notEqual(mon.state, 'paused', 'never parks in paused while the network is online');
const slow = delays.slice(-3);
assert.ok(slow.every((d) => d >= 30_000 && d <= 90_000), `slow backoff after 5 failures (got ${slow.join(', ')}ms)`);
console.log(`PASS keeps retrying while foreground (8/8 attempts, slow backoff ${slow[0]}ms)`);

broker.up = true;
await mon._probe();                   // broker 恢復 → 慢速重試這次連上
assert.equal(broker.connected, true, 'reconnects once the broker is back');
assert.equal(mon.state, 'probing');
broker.connected = false;             // 之後又斷一次
delays.length = 0;
await mon._probe();
assert.equal(broker.attempts, 10, 'reconnects again after the next drop');
assert.equal(delays.length, 0, 'first retry after a success is immediate (failure counter was reset)');
console.log('PASS recovers and resets the failure counter');

// 退避等待中被 suspend（App 優雅關閉、剛宣告離線）：醒來不能再重連，否則把剛宣告的離線蓋回在線
//   （對應 AegisPlay 26859e56）
broker.up = false;
broker.connected = false;
await mon._probe();                   // 這次立刻重試、失敗 → 下一次要等
const before = broker.attempts;
const pending = mon._probe();         // 進入退避等待
mon.suspend();
await pending;
assert.equal(broker.attempts, before, 'a reconnect that was waiting when the monitor was suspended does not run');
console.log('PASS suspend during the backoff wait cancels the pending reconnect');

// 退避等待中回到前景 → 立刻另起一輪；舊那輪醒來時新的還在跑（狀態也是 reconnecting），不能再 forceReconnect
//   一次把進行中的連線拆掉（對應 AegisPlay f3103670，第二輪審查 L2）
mon.onVisibilityChange(true);         // 解除 suspend
broker.up = false;
broker.connected = false;
await mon._probe();                   // 失敗一次 → 下一輪要等
const base = broker.attempts;
let release = () => {};
let calls = 0;
globalThis.__mqtt.forceReconnect = () => {   // 第一個呼叫（新的一輪）卡在連線中；之後的立刻回來
  broker.attempts++;
  calls++;
  return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve();
};
const waiting = mon._probe();         // 舊的一輪：進入退避等待
mon.onVisibilityChange(true);         // 回前景：立刻另起一輪（卡在 forceReconnect）
await waiting;                        // 舊的一輪醒來
assert.equal(broker.attempts, base + 1, 'the stale round does not tear down the reconnect that is in progress');
release();
console.log('PASS a stale backoff round does not interfere with a newer reconnect');

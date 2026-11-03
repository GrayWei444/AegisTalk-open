/**
 * 送檔沒等到 ack 時怎麼重試、通道不穩時怎麼判斷（2026-10-23 四機模擬 D1 跟著修的；換通道見 file_resume_new_channel_self_test）。
 * 以前等 ack 逾時只說「下次連上再送」—— 通道一直開著就永遠沒有下次；對方走了還每 30 秒往死通道推一塊。
 * 真的 fileTransfer.ts＋模擬通道（fileTransferKit）：
 *   1. 通道一直開著、第一次的 ack 掉了 → 自己逾時重送（從 manifest 起頭），不必等重連；失敗次數跟著待送清單存著
 *   2. 一直沒有 ack：同一條連線上退避（5、10、20 秒）最多 3 次定時重試，再來等重連；累計 8 次失敗放棄、標失敗
 *   3. ICE 斷一下（推到一半、或推完在等緩衝排空）又自己恢復 → 接著送，不從第一塊重來
 *   4. 通道連續 10 秒不能用 → 這一輪停（不再往死通道推）；重連後補完
 *   5. 「連著」但緩衝 30 秒一點都沒排出去 → 這一輪算失敗，不再每 30 秒硬推一塊
 *   6. 該重試的時候沒連著 → 不丟掉，晚一點再看；殭屍通道自己恢復（沒有 open 事件）也重試得到
 *   7. 每個檔自己的重試時間：別的檔的 5 秒重試不會把剛排了 80 秒退避的檔提早拉起來
 *   8. 收端收齊了 sha256 卻對不上 → 回 fail，送端不再重送、標失敗；重送的 manifest 也回 fail（不是 ack）；版本不對也回 fail
 *   9. 收端：送端換通道從第一塊重推時，重複的塊也算「還在動」，不會因為 60 秒沒新塊被判中斷
 *  10. 收端：已經收好的檔又推來的 chunks 直接丟（不佔 early buffer）
 * Run: node scripts/review/file_retry_self_test.mjs
 */
import assert from 'node:assert/strict';
import {
  BUFFER_HIGH, sleep, until, load, makeNet, wireSender, wireReceiver, mkFile, pending, manifestsOf, runScenarios,
} from './fileTransferKit.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);
const retryDelays = (A) => A.logs.map((l) => /retry in ([\d.]+)s/.exec(l)?.[1]).filter(Boolean).map(Number);
const ended = (A, how) => A.logs.filter((l) => l.includes(`ended ${how}`)).length;

scenario('1', async () => {
  const net = makeNet();
  const A = load('a1', { speed: 1000 });
  const B = load('b1');
  wireSender(A, net);
  let dropped = 0;
  const r = wireReceiver(B, A, { dropCtl: (c) => c.kind === 'ack' && dropped++ < 1 });
  net.openTo(B);
  await A.api.sendFile('B', mkFile('small.bin', 3));
  const ok = await until(() => pending(A).length === 0, 5_000);
  const manifests = manifestsOf(net);
  assert.ok(ok, `A retries by itself after the ack timeout and clears once acked (manifests sent: ${manifests.length})`);
  assert.equal(manifests.length, 2, 'one retry, starting with the manifest again');
  assert.equal(manifests[1].tries, 1, 'the failed delivery is counted in the persisted pending list');
  assert.equal(net.epoch, 1, 'no reconnect was needed');
  await sleep(50);
  assert.equal(r.got.length, 1, 'the receiver keeps one copy');
  console.log('PASS an ack lost while the channel stays open is retried without waiting for a reconnect');
});

scenario('2', async () => {
  const net = makeNet();
  const A = load('a2', { speed: 1000 });
  const B = load('b2');
  wireSender(A, net);
  wireReceiver(B, A, { dropCtl: () => true });
  net.openTo(B);
  const progress = [];
  A.api.onFileProgress((p) => progress.push(p.status));
  await A.api.sendFile('B', mkFile('never.bin', 2));
  assert.ok(await until(() => A.logs.some((l) => /timed retries .* on this connection/.test(l)), 5_000), 'the per-connection cap is reached');
  await sleep(400);                                    // 400 秒（壓縮後）：比最長的退避還久
  assert.equal(manifestsOf(net).length, 4, 'one connection: the first delivery + 3 timed retries, then it waits for a reconnect');
  assert.deepEqual(retryDelays(A).slice(0, 3), [5, 10, 20], 'timed retries back off');
  assert.equal(pending(A)[0]?.tries, 4, 'four failed deliveries recorded');
  net.openTo(B);                                       // 重連（新通道）→ 補送全部重來
  A.api.resumePendingChunks('B');
  const gaveUp = await until(() => pending(A).length === 0, 10_000);
  assert.ok(gaveUp, `gives up in the end (manifests ${manifestsOf(net).length}, tries ${pending(A)[0]?.tries})`);
  assert.equal(manifestsOf(net).length, 8, '8 failed deliveries in total (MAX_DELIVERY_TRIES)');
  assert.equal(progress.at(-1), 'failed', 'and reports the failure');
  await sleep(400);
  assert.equal(manifestsOf(net).length, 8, 'nothing more after giving up');
  console.log('PASS without any ack: backoff, at most 3 timed retries per connection, give up after 8 failed deliveries');
});

scenario('3', async () => {
  // a) 推到一半（緩衝塞滿、在背壓裡等）ICE 斷了 0.3 秒（壓縮前 3 秒）又恢復 —— 恢復時 webrtc 會補發一次 OPEN
  {
    const net = makeNet();
    const A = load('a3', { speed: 10 });
    const B = load('b3');
    wireSender(A, net);
    const r = wireReceiver(B, A);
    net.openTo(B);
    net.onChunk = (i) => { if (i === 10 && !net.hold && net.connected) { net.hold = true; net.connected = false; } };
    const file = mkFile('blip.bin', 100);
    await A.api.sendFile('B', file);
    assert.ok(await until(() => net.buffered > BUFFER_HIGH, 5_000), 'the buffer fills while ICE is down');
    await sleep(300);
    net.onChunk = null;
    net.release();
    A.api.resumePendingChunks('B');                    // ICE 恢復：同一條通道補發 OPEN
    assert.ok(await until(() => r.got.length === 1 && pending(A).length === 0, 10_000), 'the file still arrives');
    assert.equal(manifestsOf(net).length, 1, `a short ICE blip during the push does not restart the file (ended down: ${ended(A, 'down')})`);
  }
  // b) 推完、在等送出緩衝排空時 ICE 斷了一下
  {
    const net = makeNet();
    const A = load('a3b', { speed: 10 });
    const B = load('b3b');
    wireSender(A, net);
    const r = wireReceiver(B, A);
    net.openTo(B);
    net.onChunk = (i) => { if (i === 0) { net.hold = true; net.connected = false; } };
    await A.api.sendFile('B', mkFile('drain.bin', 20));
    assert.ok(await until(() => net.held.length === 19, 5_000), 'all chunks handed to the channel while ICE is down');
    await sleep(300);
    net.onChunk = null;
    net.release();
    A.api.resumePendingChunks('B');
    assert.ok(await until(() => r.got.length === 1 && pending(A).length === 0, 10_000), 'the file still arrives');
    assert.equal(manifestsOf(net).length, 1, `a short ICE blip while draining does not restart the file (ended down: ${ended(A, 'down')})`);
  }
  console.log('PASS a short ICE blip (while pushing or while draining) continues on the same channel without a restart');
});

scenario('4', async () => {
  const net = makeNet();
  const A = load('a4', { speed: 100 });
  const idbB = new Map();
  const B1 = load('b4', { idb: idbB });
  wireSender(A, net);
  wireReceiver(B1, A);
  net.openTo(B1);
  net.onChunk = (i) => { if (net.to === B1 && i === 0) { B1.close(); net.to = null; } };
  await A.api.sendFile('B', mkFile('vanish.bin', 80));
  assert.ok(await until(() => net.buffered > BUFFER_HIGH, 5_000));
  net.connected = false;                               // isDataChannelOpen 回 false；readyState 還是 open（send 照收）
  const atLoss = net.wire.length;
  assert.ok(await until(() => ended(A, 'down') === 1, 1_000), 'the round stops once the channel has been unusable for 10 s');
  await sleep(400);
  assert.equal(net.wire.length, atLoss, `nothing more goes into a channel the app knows is dead (pushed ${net.wire.length - atLoss})`);
  const B2 = load('b4b', { idb: idbB });
  const r2 = wireReceiver(B2, A);
  net.openTo(B2);
  A.api.resumePendingChunks('B');
  assert.ok(await until(() => r2.got.length > 0 && pending(A).length === 0, 8_000), 'finished after the reconnect');
  console.log('PASS a channel unusable for longer than the grace period stops the round; the reconnect finishes the file');
});

scenario('5', async () => {
  const net = makeNet();
  const A = load('a5', { speed: 100 });
  const B = load('b5');
  wireSender(A, net);
  wireReceiver(B, A);
  net.openTo(B);
  net.onChunk = (i) => { if (net.to === B && i === 0) { B.close(); net.to = null; } };   // 那頭沒了，App 卻一直說連著
  await A.api.sendFile('B', mkFile('stuck.bin', 80));
  assert.ok(await until(() => ended(A, 'failed') >= 1, 2_000), 'a buffer that does not drain at all for 30 s fails the round');
  const second = net.wire.findIndex((w, i) => i > 0 && w.kind === 'manifest');
  const firstRound = net.wire.slice(0, second === -1 ? undefined : second).filter((w) => w.kind === 'chunk');
  assert.ok(firstRound.length <= 66, `pushing stopped once the buffer was full (${firstRound.length} chunks in that round)`);
  console.log('PASS a send buffer that never drains fails the round instead of forcing a chunk every 30 s');
});

scenario('6', async () => {
  const net = makeNet();
  const A = load('a6', { speed: 1000 });
  const B = load('b6');
  wireSender(A, net);
  let dropped = 0;
  const r = wireReceiver(B, A, { dropCtl: (c) => c.kind === 'ack' && dropped++ < 1 });
  net.openTo(B);
  await A.api.sendFile('B', mkFile('zombie.bin', 3));
  assert.ok(await until(() => r.got.length === 1, 3_000));
  net.connected = false;                               // 殭屍：App 說不能用（ack 已經掉了，A 還在等）
  assert.ok(await until(() => A.logs.some((l) => /ended timeout/.test(l)), 3_000));
  await sleep(100);                                    // 100 秒（壓縮後）：重試到期時沒連著
  assert.equal(manifestsOf(net).length, 1, 'no retry while disconnected');
  net.connected = true;                                // 自己恢復了，沒有新的 open 事件
  assert.ok(await until(() => pending(A).length === 0, 3_000), 'retried once the channel is usable again, without an open event');
  assert.equal(manifestsOf(net).length, 2);
  console.log('PASS a retry that comes due while disconnected is kept and runs once the channel recovers');
});

scenario('7', async () => {
  const net = makeNet();
  const A = load('a7', { speed: 100 });
  const B = load('b7');
  wireSender(A, net);
  const firstAck = new Set();
  wireReceiver(B, A, { dropCtl: (c) => c.kind === 'ack' && !firstAck.has(c.fileId) && firstAck.add(c.fileId) });
  net.openTo(B);
  const x = (await A.api.sendFile('B', mkFile('x.bin', 3))).fileId;
  A.ls.set('aegis_file_pending', JSON.stringify(pending(A).map((p) => (p.manifest.fileId === x ? { ...p, tries: 4 } : p))));
  const y = (await A.api.sendFile('B', mkFile('y.bin', 3))).fileId;
  assert.ok(await until(() => pending(A).every((p) => p.manifest.fileId !== y), 8_000), 'y is retried (5 s) and acked');
  assert.equal(manifestsOf(net, x).length, 1, `x (next retry in 80 s) is not pulled forward by y's retry (x sent ${manifestsOf(net, x).length}x)`);
  assert.ok(await until(() => pending(A).length === 0, 8_000), 'x is retried on its own schedule and acked');
  console.log('PASS each file keeps its own retry time; one file\'s retry does not restart another early');
});

scenario('8', async () => {
  const net = makeNet();
  const A = load('a8', { speed: 100 });
  const B = load('b8');
  wireSender(A, net);
  const r = wireReceiver(B, A);
  const progress = [];
  A.api.onFileProgress((p) => progress.push(p.status));
  const file = mkFile('changed.bin', 5);
  const { fileId } = await A.api.sendFile('B', file);  // 對方不在線 → 掛著
  assert.ok(await until(() => A.logs.some((l) => /chunks parked until reconnect/.test(l)), 5_000));
  A.idb.set(fileId, mkFile('changed.bin', 5));         // 本機的檔跟 manifest 的 sha256 對不上了
  let manifest = null;
  net.onManifest = (m) => { manifest = JSON.parse(JSON.stringify(m)); };
  net.openTo(B);
  A.api.resumePendingChunks('B');
  assert.ok(await until(() => pending(A).length === 0, 5_000), 'the receiver\'s fail stops the sender');
  await sleep(1_000);                                  // 100 秒（壓縮後）：逾時、退避都早該到了
  assert.equal(manifestsOf(net).length, 1, 'no retries after fail');
  assert.equal(progress.at(-1), 'failed', 'reported as failed');
  assert.deepEqual(r.got, [], 'nothing stored');
  assert.deepEqual(r.ctl.map((c) => c.kind), ['fail'], 'the receiver said fail (not ack)');
  await B.api.handleManifestPayload(manifest, 'A');   // fail 掉了、送端又送來同一個 manifest
  assert.equal(r.ctl.at(-1).kind, 'fail', 'a repeated manifest of a failed file gets fail again, never ack');
  await B.api.handleManifestPayload({ ...manifest, v: 2, fileId: 'file_v2xxxxxx' }, 'A');
  assert.deepEqual(r.ctl.at(-1), { kind: 'fail', fileId: 'file_v2xxxxxx' }, 'an unsupported manifest version gets fail');
  console.log('PASS sha256 mismatch / unsupported version: the receiver says fail and the sender stops retrying');
});

scenario('9', async () => {
  const net = makeNet();
  const A = load('a9', { speed: 10 });
  const B = load('b9', { speed: 100 });                // 收端的 60 秒 stall＝0.6 秒
  wireSender(A, net);
  const r = wireReceiver(B, A);
  net.openTo(B);
  net.onChunk = (i) => { if (i === 29 && net.epoch === 1) { net.openTo(B); net.pace = 30; } };   // 換通道、之後慢慢到
  await A.api.sendFile('B', mkFile('dups.bin', 40));
  assert.ok(await until(() => r.got.length === 1 && pending(A).length === 0, 10_000), 'delivered after the restart');
  assert.ok(!r.progress.includes('failed'), `re-sent chunks the receiver already had keep the transfer alive (receiver progress: ${[...new Set(r.progress)].join(',')})`);
  console.log('PASS duplicate chunks during a restart keep the receiver\'s stall watchdog from firing');
});

scenario('10', async () => {
  const net = makeNet();
  const A = load('a10', { speed: 1000 });
  const B = load('b10');
  wireSender(A, net);
  let acks = 0;
  const r = wireReceiver(B, A, { dropCtl: (c) => c.kind === 'ack' && ++acks <= 2 });   // 收好的 ack、重送 manifest 的 ack 都掉了
  net.openTo(B);
  await A.api.sendFile('B', mkFile('again.bin', 3));
  assert.ok(await until(() => pending(A).length === 0, 5_000), 'acked in the end');
  assert.ok(manifestsOf(net).length >= 2 && net.wire.filter((w) => w.kind === 'chunk').length > 3, 'chunks of the completed file were pushed again');
  assert.equal(B.debug().chunksWithoutManifest, 0, 'chunks of a file the receiver already has are dropped, not parked in the early buffer');
  assert.equal(r.got.length, 1);
  console.log('PASS chunks for an already-received file are dropped instead of filling the early-chunk buffer');
});

await runScenarios(scenarios);

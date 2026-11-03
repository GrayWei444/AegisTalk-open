/**
 * 傳檔傳到一半，收端關 App、幾秒後重開，送端原本那一輪還在跑（2026-10-23 四機模擬 D1 在 bdd03df 重現兩次：32 MB、512 塊）。
 *   以前：1. 新通道 open 時的補送（resumePendingChunks）跳過這個檔 —— 舊的那一輪還佔著位子（要推完、再等 60 秒 ack 才放）
 *         2. 舊的那一輪把剩下的 chunks 推進**新**通道：新開的頁面沒有 manifest（manifest 送進了已經關掉的舊頁面），30 秒後丟掉
 *         3. 等 ack 逾時只說「下次連上再送」，但新通道一直開著、沒有下次（重試見 file_retry_self_test）
 * 真的 fileTransfer.ts＋模擬通道（fileTransferKit）。一輪送檔綁在 manifest 走的那條通道上：
 *   1. 四機模擬 D1 原樣：收端收到第一塊就關 App、重開 → 新通道 open 的補送當場接手；新通道上先到 manifest；收齊、只存一份、
 *      回 ack；換通道被打斷的那一輪不算失敗（tries 還是 0）
 *   2. 推到一半換了通道、補送還沒跑 → 舊一輪的 chunks 一塊都不進新通道；從 manifest 重來，同一個收端只存一份；不算失敗
 *   3. 補送的 manifest 送進舊頁面、還在等收端回 ack 的 1.5 秒內換了通道 → 新頁面先拿到新的 manifest
 *   4. manifest 送出去的「期間」換了通道（送之前、送之後不是同一條）→ 不當成送到了新通道，在新通道上再送一次
 *   5. 送 manifest 時沒連著（進了離線 outbox）→ 連上後先在這條通道上再送一次 manifest，才推 chunks
 *   6. 排了三個檔、第一個傳到一半收端重開 → 三個都到、各一份；新通道上每個檔都是 manifest 先到
 *   7. 沒連著的時候被叫補送（通道拆了）→ 什麼都不做：不作廢還在等 ack 的那一輪、不開新的一輪
 *   8. 傳到一半登出（shutdown）→ 這一輪停、不再重試；待送清單留著，下次登入接著送完
 *   9. 接線：AppProvider 把 webrtc 的通道編號交給 fileTransfer；webrtc 每條通道 open 換號
 * Run: node scripts/review/file_resume_new_channel_self_test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ROOT, BUFFER_HIGH, sleep, until, load, makeNet, wireSender, wireReceiver, mkFile, pending, firstOn, manifestsOf, runScenarios,
} from './fileTransferKit.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);
const restartTries = (net, epoch, fileId) => manifestsOf(net, fileId).filter((w) => w.epoch === epoch).map((w) => w.tries);

scenario('1', async () => {
  const net = makeNet();
  const A = load('a1', { speed: 100 });
  const idbB = new Map();
  const B1 = load('b1', { idb: idbB });
  wireSender(A, net);
  const r1 = wireReceiver(B1, A);
  net.openTo(B1);
  net.onChunk = (i) => { if (net.to === B1 && i === 0) { B1.close(); net.to = null; } };
  const file = mkFile('big.bin', 80);
  const { fileId } = await A.api.sendFile('B', file);
  assert.ok(await until(() => net.buffered > BUFFER_HIGH, 5_000), 'A keeps pushing into the dead channel until its send buffer is full');
  await sleep(30);                                     // 送端在背壓裡等（App 還以為通道開著）
  const B2 = load('b2', { idb: idbB });                // B 重開 App：新頁面、新通道 → A 的 onPeerConnected
  const r2 = wireReceiver(B2, A);
  net.openTo(B2);
  const before = A.logs.length;
  A.api.resumePendingChunks('B');
  assert.ok(A.logs.slice(before).some((l) => /resuming 1 parked file/.test(l)),
    `the new channel takes the file over right away (A logged: ${A.logs.slice(before).join(' | ') || 'nothing'})`);
  const done = await until(() => r2.got.length > 0 && pending(A).length === 0, 8_000);
  assert.equal(firstOn(net, 2, fileId).split(',')[0], 'manifest', `the new channel starts with the manifest (got ${firstOn(net, 2, fileId)})`);
  assert.ok(done, `B's reopened app gets the file and A's pending list clears (B got ${r2.got.length}, pending ${JSON.stringify(pending(A))})`);
  assert.deepEqual(restartTries(net, 2, fileId), [0], 'the round cut off by the channel switch is not counted as a failed delivery');
  await sleep(100);
  assert.deepEqual(r2.got, [{ name: 'big.bin', size: file.size }], 'stored once (sha256 checked by the app)');
  assert.equal(r1.got.length, 0, 'the closed page got nothing');
  assert.equal(B2.puts, 1, 'written to IndexedDB once');
  console.log('PASS receiver restarts mid-transfer while the sender is still pushing: the new channel restarts from the manifest, the file arrives once, A clears it');
});

scenario('2', async () => {
  const net = makeNet();
  const A = load('a2', { speed: 100 });
  const B = load('b2');
  wireSender(A, net);
  const r = wireReceiver(B, A);
  net.openTo(B);
  net.onChunk = (i) => { if (i === 10 && net.epoch === 1) net.openTo(B); };   // 同一個頁面換了一條通道（例如兩條都開了）
  const file = mkFile('switch.bin', 40);
  const { fileId } = await A.api.sendFile('B', file);
  const ok = await until(() => r.got.length > 0 && pending(A).length === 0, 8_000);
  assert.ok(ok, `restarted on the new channel and acked (channel 2 saw: ${firstOn(net, 2, fileId) || 'nothing'})`);
  assert.equal(firstOn(net, 2, fileId).split(',')[0], 'manifest', `no chunk of the old round reaches the newer channel (got ${firstOn(net, 2, fileId)})`);
  assert.deepEqual(restartTries(net, 2, fileId), [0], 'the switch is not counted as a failed delivery');
  await sleep(100);
  assert.deepEqual(r.got, [{ name: 'switch.bin', size: file.size }], 'the same receiver ignores the repeated manifest / chunks and stores it once');
  assert.equal(B.puts, 1);
  console.log('PASS a round whose channel changed never pushes into the new channel; the restart is accepted once and costs no try');
});

scenario('3', async () => {
  const net = makeNet();
  const A = load('a3', { speed: 10 });                 // 10 倍：補送先等 ack 的 1.5 秒＝0.15 秒，重開一定落在這段裡
  const idbB = new Map();
  const B1 = load('b3', { idb: idbB });
  wireSender(A, net);
  wireReceiver(B1, A);
  const file = mkFile('peek.bin', 20);
  const { fileId } = await A.api.sendFile('B', file);  // 對方不在線：送不出去，15 秒（這裡 1.5 秒）後掛著等重連
  assert.ok(await until(() => A.logs.some((l) => /chunks parked until reconnect/.test(l)), 5_000), 'parked while B is offline');
  let r2 = null;
  net.onManifest = () => {
    net.onManifest = null;
    setTimeout(() => {                                 // 補送的 manifest 剛送進 B1，B 就關 App、重開
      B1.close();
      const B2 = load('b3b', { idb: idbB });
      r2 = wireReceiver(B2, A);
      net.openTo(B2);
      A.api.resumePendingChunks('B');
    }, 3);
  };
  net.openTo(B1);
  A.api.resumePendingChunks('B');
  const done = await until(() => r2?.got.length > 0 && pending(A).length === 0, 8_000);
  assert.equal(firstOn(net, 2, fileId).split(',')[0], 'manifest', `the reopened page gets the manifest before any chunk (got ${firstOn(net, 2, fileId)})`);
  assert.ok(done, 'the reopened page gets the file; A clears it');
  console.log('PASS a resent manifest that went to the old page binds the round to the old channel; the reopened page gets a fresh manifest first');
});

scenario('4', async () => {
  const net = makeNet();
  const A = load('a4', { speed: 100 });
  const idbB = new Map();
  const B1 = load('b4', { idb: idbB });
  wireSender(A, net);
  wireReceiver(B1, A);
  net.openTo(B1);
  let r2 = null;
  net.duringManifest = async () => {                   // manifest 送進 B1 之後、送 manifest 的呼叫還沒回來：B 重開、新通道
    net.duringManifest = null;
    B1.close();
    const B2 = load('b4b', { idb: idbB });
    r2 = wireReceiver(B2, A);
    net.openTo(B2);
    A.api.resumePendingChunks('B');
    await sleep(2);
  };
  const file = mkFile('during.bin', 20);
  const { fileId } = await A.api.sendFile('B', file);
  const done = await until(() => r2?.got.length > 0 && pending(A).length === 0, 8_000);
  assert.equal(firstOn(net, 2, fileId).split(',')[0], 'manifest', `channel changed while the manifest was being sent → sent again on the new one first (got ${firstOn(net, 2, fileId)})`);
  assert.ok(done, 'the reopened page gets the file');
  console.log('PASS a channel switch during the manifest send is not mistaken for delivery on the new channel');
});

scenario('5', async () => {
  const net = makeNet();
  const A = load('a5', { speed: 100 });
  const B = load('b5');
  wireSender(A, net);
  const r = wireReceiver(B, A);
  const file = mkFile('outbox.bin', 20);
  const { fileId } = await A.api.sendFile('B', file);  // 沒連著：manifest 進了離線 outbox（之後補送到哪裡不一定）
  assert.ok(await until(() => net.wire.some((w) => w.kind === 'offline-manifest'), 2_000));
  await sleep(30);
  net.openTo(B);                                       // 15 秒（0.15 秒）內連上
  A.api.resumePendingChunks('B');
  const done = await until(() => r.got.length > 0 && pending(A).length === 0, 8_000);
  assert.equal(firstOn(net, 1, fileId).split(',')[0], 'manifest', `the manifest is sent again on the live channel before the chunks (got ${firstOn(net, 1, fileId)})`);
  assert.ok(done, 'delivered');
  console.log('PASS a manifest that only reached the offline outbox is re-sent on the live channel before any chunk');
});

scenario('6', async () => {
  const net = makeNet();
  const A = load('a6', { speed: 100 });
  const idbB = new Map();
  const B1 = load('b6', { idb: idbB });
  wireSender(A, net);
  wireReceiver(B1, A);
  net.openTo(B1);
  net.onChunk = (i) => { if (net.to === B1 && i === 0) { B1.close(); net.to = null; } };
  const files = [mkFile('one.bin', 80), mkFile('two.bin', 5), mkFile('three.bin', 5)];
  const ids = [];
  for (const f of files) ids.push((await A.api.sendFile('B', f)).fileId);
  assert.ok(await until(() => net.buffered > BUFFER_HIGH, 5_000));
  await sleep(30);
  const B2 = load('b6b', { idb: idbB });
  const r2 = wireReceiver(B2, A);
  net.openTo(B2);
  A.api.resumePendingChunks('B');
  const done = await until(() => r2.got.length === 3 && pending(A).length === 0, 10_000);
  assert.ok(done, `all three arrive after the restart (got ${r2.got.map((g) => g.name).join(',')}, pending ${pending(A).length})`);
  for (const id of ids) assert.equal(firstOn(net, 2, id).split(',')[0], 'manifest', `${id}: manifest first on the new channel (${firstOn(net, 2, id)})`);
  await sleep(100);
  assert.deepEqual(r2.got.map((g) => g.name).sort(), ['one.bin', 'three.bin', 'two.bin'], 'each once');
  assert.equal(B2.puts, 3);
  console.log('PASS three queued files: the interrupted one restarts, the queued ones go out on the new channel, each arrives once');
});

scenario('7', async () => {
  const net = makeNet();
  const A = load('a7', { speed: 100 });
  const B = load('b7');
  wireSender(A, net);
  const r = wireReceiver(B, A, { dropCtl: () => true });   // ack 都掉了：A 推完在等 ack
  net.openTo(B);
  await A.api.sendFile('B', mkFile('wait.bin', 5));
  assert.ok(await until(() => r.got.length === 1, 5_000));
  net.open = false; net.connected = false;            // 通道拆了（channelEpoch 0、isDataChannelOpen false）
  const before = A.logs.length;
  A.api.resumePendingChunks('B');
  assert.deepEqual(A.logs.slice(before), [], 'nothing aborted, nothing started while there is no connection');
  console.log('PASS a resume while disconnected leaves the waiting round alone and starts nothing');
});

scenario('8', async () => {
  const net = makeNet();
  const A = load('a8', { speed: 100 });
  const B = load('b8');
  wireSender(A, net);
  const r = wireReceiver(B, A);
  net.openTo(B);
  net.onChunk = (i) => { if (i === 10) net.buffered = BUFFER_HIGH + 1; };   // 送出緩衝滿了：A 在背壓裡等
  await A.api.sendFile('B', mkFile('logout.bin', 40));
  assert.ok(await until(() => net.wire.some((w) => w.chunkIndex === 10), 5_000));
  await A.api.shutdownFileTransfer();                  // 登出／換帳號：這個 session 不再動它
  const atShutdown = net.wire.length;
  net.onChunk = null;
  net.buffered = 0;                                    // 同一條通道，緩衝排空了
  await sleep(600);                                    // 60 秒（壓縮後）：背壓、等 ack、重試都早該動了
  assert.equal(net.wire.length, atShutdown, `after shutdown nothing is pushed or retried (${net.wire.length - atShutdown} more)`);
  assert.equal(pending(A).length, 1, 'the pending entry stays for the next login');
  assert.equal(r.got.length, 0);
  wireSender(A, net);                                  // 同一個帳號再登入：init 時對已連著的 peer 補送
  assert.ok(await until(() => r.got.length === 1 && pending(A).length === 0, 8_000), 'the next login finishes it');
  console.log('PASS a shutdown mid-round stops pushing and retrying; the next login resumes and finishes');
});

scenario('9', async () => {
  const app = readFileSync(ROOT + 'src/providers/AppProvider.tsx', 'utf8');
  const init = app.slice(app.indexOf('fileTransfer.initFileTransfer({'), app.indexOf('fileTransfer.onFileReceived('));
  assert.match(init, /channelEpoch: \(peer\) => webrtcService\.channelEpoch\(peer\)/, 'the send round is bound to the live channel number');
  const connected = app.slice(app.indexOf('const onPeerConnected = useCallback('), app.indexOf('const onPeerDisconnected'));
  assert.match(connected, /resumePendingChunks\(peerPublicKey\)/, 'every channel open resumes (and takes over rounds bound to an older channel)');
  const rtc = readFileSync(ROOT + 'src/services/webrtc.ts', 'utf8');
  // 開源第 4 步：通道「真的可以用」＝開著＋DTLS 指紋對過；編號在 announceOpen（onopen 時已經對過，或對上的那一刻）
  const onopen = rtc.slice(rtc.indexOf('channel.onopen = () => {'), rtc.indexOf('channel.onclose = () => {'));
  assert.match(onopen, /this\.announceOpen\(remotePublicKeyBase64, peer\)/, 'channel open announces the channel (once verified)');
  const announce = rtc.slice(rtc.indexOf('private announceOpen('), rtc.indexOf('// ───────── 封好的信令'));
  assert.match(announce, /peer\.dcEpoch = \+\+this\.dcEpochSeq/, 'webrtc numbers each channel when it opens');
  const verifiedSrc = rtc.slice(rtc.indexOf('private onPeerVerified('), rtc.indexOf('private onPeerUnverified('));
  assert.match(verifiedSrc, /if \(peer\.dataChannel\?\.readyState === 'open'\) this\.announceOpen\(remote, peer\);/,
    'a channel that opened before the fingerprint check finished is numbered when it passes');
  console.log('PASS AppProvider passes webrtc channelEpoch to fileTransfer; channel open resumes parked files');
});

await runScenarios(scenarios);

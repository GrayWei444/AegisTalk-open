/**
 * 開源第 4 步（docs/DIRECT_SEALED.md）：1 對 1 通話與 DataChannel 的信令全部封好（DIRECT_SEALED）、DTLS 指紋兩邊交叉核對。
 * 接在 D1 之後（A↔B 是好友、DataChannel 開著）；需要的東西都在 world.adv（run.mjs 建）。
 *   C1  A 打給 B（畫面上按）、B 接（畫面上按）→ 兩邊都「接通」且指紋驗過、A 讀到的對方 ＝ B 自己的（反之亦然：中間沒有人）→ A 掛斷 → 兩邊都結束
 *   C2  營運方／Mallory：明文的舊信令型別（兩邊各塞）、Mallory 簽的信封寫成 from＝對方（兩邊各塞 offer）、Mallory 自己（陌生人）的來電與
 *       個人資料、重放錄下來的真信令、拆掉重建 DataChannel 之後重放那則 offer —— 沒有一則被收下：不響、不改名、DataChannel 不換、
 *       兩邊的指紋照樣交叉對得上；通話中營運方再塞兩邊的 offer，通話的指紋照樣對得上
 *   C3  B 送出去的指紋故意寫錯（＝中間有人）→ A 掛斷、提示使用者、A 的麥克風從沒送出去；B 收到 end 也結束
 * LEAK（run.mjs）另外判：broker 上沒有任何明文的 1 對 1 信令型別、沒有任何顯示名稱、沒有推播提示。
 */
import crypto from 'node:crypto';
import { Scenario, waitFor, sleep, sendDirect, expectDirect } from './scenarios.mjs';
import { toUrl } from './lib/adversaryKit.mjs';

const callOf = (ph) => ph.callState().catch(() => null);
const waitCall = (ph, pred, timeout = 45_000) => waitFor(async () => { const s = await callOf(ph); return s && pred(s) ? s : null; }, { timeout, interval: 500 });
const idle = (s) => s.callState === 'idle';
const sameSet = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length > 0 && x.length === y.length && x.every((v) => y.includes(v));
/** 中間沒有人：我讀到的「對方」＝ 對方讀到的「自己」，反過來也是 */
const crossMatch = (a, b) => !!a && !!b && sameSet(a.local, b.remote) && sameSet(a.remote, b.local);
const callId = () => crypto.randomBytes(16).toString('base64url');
const pcId = () => crypto.randomBytes(16).toString('base64url');
const inbox = (to, from) => `mist/user/${toUrl(to.pubkey ?? to)}/inbox/${toUrl(from.pubkey ?? from)}`;
const outer = (type, from, to, payload) => JSON.stringify({ type, from, to, payload, timestamp: Date.now() });
const statsDelta = (s0, s1, keys) => keys.reduce((n, k) => n + ((s1?.[k] ?? 0) - (s0?.[k] ?? 0)), 0);

/** A↔B 的 DataChannel 兩邊都開著、指紋驗過（沒有 → 送一則觸發重連，最多等 timeout） */
async function dcReady(world, sc, A, B, timeout = 60_000) {
  const ok = async () => (await A.adv('dcOpen', B.pubkey).catch(() => false)) && (await B.adv('dcOpen', A.pubkey).catch(() => false));
  if (!(await ok())) {
    const nudge = await sendDirect(sc, A, B, 'reconnect nudge');
    await expectDirect(world, sc, A, B, nudge, { timeout, what: ' (DataChannel rebuilt)' });
  }
  return waitFor(ok, { timeout, interval: 500 });
}

async function dcFingerprintsMatch(A, B) {
  const fa = await A.adv('dcFingerprints', B.pubkey).catch(() => null);
  const fb = await B.adv('dcFingerprints', A.pubkey).catch(() => null);
  return { ok: crossMatch(fa, fb), fa, fb };
}

/** 一通 A→B 的語音通話打到接通；回傳兩邊的狀態 */
async function placeCall(sc, A, B, label) {
  await waitCall(A, idle, 15_000);
  await waitCall(B, idle, 15_000);
  await A.startVoiceCall(B.name);
  const rang = await B.acceptIncomingCall();
  sc.check(`${label}: B's phone rings and B accepts on screen`, rang, '');
  const a = await waitCall(A, (s) => s.callState === 'connected' && s.verified);
  const b = await waitCall(B, (s) => s.callState === 'connected' && s.verified);
  return { a, b };
}

// ───────────── C1：接通、指紋交叉對上、掛斷 ─────────────

export async function C1(world) {
  const sc = new Scenario('C1', '1:1 voice call A→B over sealed signalling: rings, connects only after the DTLS fingerprints are verified on both sides (A\'s view of B = B\'s own, and back), hang-up ends both');
  const { A, B } = world.p;
  const adv = world.adv;
  // C2 拿來重放的真信令：這通電話的每一則（A↔B 收件箱）
  const tap = adv.broker.spy((r) => r.kind === 'publish' && (r.topic === inbox(A, B) || r.topic === inbox(B, A)));
  const p0 = adv.mockApi.pushes.length;
  const { a, b } = await placeCall(sc, A, B, 'C1');
  sc.check('A is connected with verified fingerprints', !!a, JSON.stringify(await callOf(A)));
  sc.check('B is connected with verified fingerprints', !!b, JSON.stringify(await callOf(B)));
  sc.check('both sides are in the same call (same call id)', !!a && !!b && a.callId === b.callId, `${a?.callId} / ${b?.callId}`);
  const fa = await A.adv('callFingerprints');
  const fb = await B.adv('callFingerprints');
  sc.check('no man in the middle: A\'s remote fingerprint is B\'s local and B\'s remote is A\'s local', crossMatch(fa, fb), JSON.stringify({ fa, fb }));
  const pushes = adv.mockApi.pushes.slice(p0).filter((p) => p.from === A.pubkey && p.to === B.pubkey);
  // 開源第 5d 步：來電另外帶 A 簽的響鈴 token（只有公鑰、這一通的 callId、時間；沒有名字）—— 模擬 API 照伺服器驗過才收
  const callPush = pushes.find((p) => p.hint?.type === 'incoming_call');
  const ringClaims = (() => { try { return JSON.parse(Buffer.from(callPush.hint.ringToken.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } })();
  sc.check('the incoming-call push went through the signed API with only { type, isVideoCall, ringToken }; the token is A\'s for B and this call',
    !!callPush && pushes.every((p) => Object.keys(p.hint).every((k) => ['type', 'isVideoCall', 'ringToken'].includes(k)))
      && ringClaims?.from === A.pubkey && ringClaims?.to === B.pubkey && ringClaims?.callId === a?.callId,
    JSON.stringify({ hints: pushes.map((p) => Object.keys(p.hint)), ringClaims, callId: a?.callId }));
  await sleep(3_000);
  await A.hangUp();
  const bEnded = await waitCall(B, (s) => s.callState === 'ended' || s.callState === 'idle', 15_000);
  sc.check('A hangs up on screen → B\'s call ends too', !!bEnded, JSON.stringify(await callOf(B)));
  sc.check('both phones are idle again', !!(await waitCall(A, idle, 15_000)) && !!(await waitCall(B, idle, 15_000)), '');
  const counters = { A: (await callOf(A))?.counters, B: (await callOf(B))?.counters };
  sc.check('no fingerprint failure and no refused signal of this call on either side',
    !Object.values(counters).some((c) => Object.keys(c ?? {}).some((k) => /^fp-(mismatch|timeout|unreadable)$|^not-current|refused$/.test(k))), JSON.stringify(counters), false);
  tap.stop();
  world.callCapture = tap.records.slice();
  sc.note(`captured ${world.callCapture.length} sealed signal(s) of this call for C2's replays`);
  return sc;
}

// ───────────── C2：營運方／Mallory 塞信令 ─────────────

export async function C2(world) {
  const sc = new Scenario('C2', 'Operator and Mallory inject 1:1 signalling for both sides — plaintext legacy types, Mallory-signed envelopes labelled as the peer (DataChannel and call offers), Mallory\'s own call/profile, replays of genuine signals — nothing is taken: no ring, no rename, the DataChannel is not replaced and its fingerprints still cross-match; a call set up meanwhile still cross-matches');
  const { A, B } = world.p;
  const adv = world.adv;
  const M = adv.mallory;
  const ready = await dcReady(world, sc, A, B);
  sc.check('A↔B DataChannel is open and verified on both sides', !!ready, '');
  const dcA0 = (await A.adv('dcDebug')).peers[B.pubkey];
  const dcB0 = (await B.adv('dcDebug')).peers[A.pubkey];
  const nameOfB0 = (await A.friends()).find((f) => f.pubkey === B.pubkey)?.nickname;
  const sA0 = await A.adv('directStats');
  const sB0 = await B.adv('directStats');
  const rings = () => Promise.all([callOf(A), callOf(B)]).then(([x, y]) => [x?.callState, y?.callState]);

  // 1 明文的舊型別（以前 broker 綁的 from 就算數）：兩邊各塞
  for (const [to, from] of [[A, B], [B, A]]) {
    for (const [type, payload] of [
      ['call_request', { callId: callId(), isVideoCall: false }],
      ['call_accept', { callId: callId() }],
      ['webrtc_offer', { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 6.6.6.6\r\na=fingerprint:sha-256 66:66\r\n', pcId: pcId() }],
      ['call_webrtc_offer', { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 66:66\r\n' }],
      ['profile_update', { displayName: 'Hacked Name', avatar: '' }],
      ['prekey_request', { signedPreKey: 'x', signature: 'y' }],
      ['delete_message', { messageId: 'x' }],
      ['typing', { isTyping: true }],
    ]) adv.broker.inject(inbox(to, from), outer(type, from.pubkey, to.pubkey, payload));
  }
  await sleep(4_000);
  sc.check('plaintext legacy signalling (call_request, webrtc_offer, profile_update, …) does nothing: no ring on either side', (await rings()).every((x) => x === 'idle'), JSON.stringify(await rings()));
  sc.check('…no rename', (await A.friends()).find((f) => f.pubkey === B.pubkey)?.nickname === nameOfB0, JSON.stringify(await A.friends()));

  // 2 Mallory 簽、寫成 from＝對方：兩邊各塞 DataChannel offer、來電、個人資料（＝營運方想當中間人）
  const forgedFor = async (to, as) => {
    for (const body of [
      { kind: 'dc', sig: 'offer', pc: pcId(), data: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 66:66\r\n' } },
      { kind: 'call', sig: 'request', callId: callId(), seq: 1, video: false },
      { kind: 'call', sig: 'offer', callId: callId(), seq: 2, data: { type: 'offer', sdp: 'v=0\r\n' } },
      { kind: 'profile', displayName: 'Hacked Name', avatar: '' },
    ]) {
      const env = await M.sealDirect(to.pubkey, body);
      adv.broker.inject(inbox(to, as), outer('direct_sealed', as.pubkey, to.pubkey, env));
    }
  };
  await forgedFor(A, B);
  await forgedFor(B, A);
  await sleep(4_000);
  const sA1 = await A.adv('directStats');
  const sB1 = await B.adv('directStats');
  sc.check('envelopes signed by Mallory but labelled from the peer are rejected on both sides (bad signature)',
    statsDelta(sA0, sA1, ['bad-envelope']) >= 4 && statsDelta(sB0, sB1, ['bad-envelope']) >= 4,
    `A +${statsDelta(sA0, sA1, ['bad-envelope'])}, B +${statsDelta(sB0, sB1, ['bad-envelope'])}`);
  sc.check('…no ring, no rename', (await rings()).every((x) => x === 'idle') && (await A.friends()).find((f) => f.pubkey === B.pubkey)?.nickname === nameOfB0,
    JSON.stringify(await rings()));

  // 3 Mallory 自己（陌生人）：來電、個人資料（他簽的、真的是他）→ 只能到 DataChannel 的閘門，其他種類一律丟
  const mc = await M.connect({});
  sc.check('Mallory is connected to the broker', mc.connack === 0, JSON.stringify(mc.token?.status));
  for (const body of [{ kind: 'call', sig: 'request', callId: callId(), seq: 1 }, { kind: 'profile', displayName: 'Mallory', avatar: '' },
    { kind: 'dc', sig: 'offer', pc: pcId(), data: { type: 'offer', sdp: 'v=0\r\n' } }]) {
    const env = await M.sealDirect(A.pubkey, body);
    if (mc.link) await mc.link.publish(M.inboxTopic(A.pubkey), outer('direct_sealed', M.pk, A.pubkey, env));
  }
  await sleep(4_000);
  const sA2 = await A.adv('directStats');
  sc.check('a stranger\'s sealed call request and profile are dropped (not friends)', statsDelta(sA1, sA2, ['stranger:call', 'stranger:profile']) >= 2,
    JSON.stringify(sA2));
  sc.check('…and his DataChannel offer gets no answer (no connection to a stranger)', !((await A.adv('dcDebug')).peers[M.pk]), JSON.stringify((await A.adv('dcDebug')).peers[M.pk]));

  // 4 重放 C1 錄下來的真信令（來電、接聽、offer／answer／ICE／指紋）
  const capture = world.callCapture ?? [];
  for (const r of capture) adv.broker.inject(r.topic, r.payload);
  await sleep(5_000);
  const sA3 = await A.adv('directStats');
  const sB3 = await B.adv('directStats');
  const replayRefused = statsDelta(sA2, sA3, ['replay:call', 'out-of-order:call', 'bad-envelope']) + statsDelta(sB1, sB3, ['replay:call', 'out-of-order:call', 'bad-envelope']);
  sc.check(`replaying the ${capture.length} genuine signal(s) of C1's call does nothing (refused as replays / out of order / stale)`,
    capture.length > 0 && replayRefused >= capture.length && (await rings()).every((x) => x === 'idle'), `refused ${replayRefused}, rings ${JSON.stringify(await rings())}`);

  // 5 拆掉重建 DataChannel（錄下新的 offer）→ 重放那則 offer：已經用過 → 丟；連線不換
  const tap = adv.broker.spy((r) => r.kind === 'publish' && (r.topic === inbox(A, B) || r.topic === inbox(B, A)));
  await A.adv('dcDrop', B.pubkey);
  await B.adv('dcDrop', A.pubkey);
  const rebuilt = await dcReady(world, sc, A, B, 90_000);
  tap.stop();
  sc.check('after a teardown the DataChannel is rebuilt over sealed signalling and verified again', !!rebuilt, '');
  const dcA1 = (await A.adv('dcDebug')).peers[B.pubkey];
  const dcB1 = (await B.adv('dcDebug')).peers[A.pubkey];
  const sA4 = await A.adv('directStats');
  const sB4 = await B.adv('directStats');
  for (const r of tap.records) adv.broker.inject(r.topic, r.payload);
  await sleep(5_000);
  const dcA2 = (await A.adv('dcDebug')).peers[B.pubkey];
  const dcB2 = (await B.adv('dcDebug')).peers[A.pubkey];
  const sA5 = await A.adv('directStats');
  const sB5 = await B.adv('directStats');
  const dcReplays = statsDelta(sA4, sA5, ['replay:dc', 'bad-envelope']) + statsDelta(sB4, sB5, ['replay:dc', 'bad-envelope']);
  sc.check(`replaying the ${tap.records.length} signal(s) of that rebuild is refused and replaces nothing (same PC generation on both sides, still verified)`,
    tap.records.length > 0 && dcReplays >= tap.records.length && dcA2?.localPcId === dcA1?.localPcId && dcB2?.localPcId === dcB1?.localPcId && !!dcA2?.verified && !!dcB2?.verified,
    JSON.stringify({ dcReplays, records: tap.records.length, dcA1, dcA2, dcB1, dcB2 }));
  sc.note(`DataChannel generations: A ${dcA0?.localPcId?.slice(0, 6)}→${dcA2?.localPcId?.slice(0, 6)}, B ${dcB0?.localPcId?.slice(0, 6)}→${dcB2?.localPcId?.slice(0, 6)}`);
  const dfp = await dcFingerprintsMatch(A, B);
  sc.check('no man in the middle on the DataChannel: fingerprints cross-match', dfp.ok, JSON.stringify(dfp));
  const msg = await sendDirect(sc, B, A, 'after the attacks');
  await expectDirect(world, sc, B, A, msg, { what: ' (after the injections)' });

  // 6 通話中營運方兩邊各塞 offer（Mallory 簽、寫成對方；他不知道 callId —— 在密文裡）→ 通話的指紋照樣對得上
  await A.startVoiceCall(B.name);
  const rang = await B.acceptIncomingCall();
  for (const [to, as] of [[A, B], [B, A]]) {
    const env = await M.sealDirect(to.pubkey, { kind: 'call', sig: 'offer', callId: callId(), seq: 3, data: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 66:66\r\n' } });
    adv.broker.inject(inbox(to, as), outer('direct_sealed', as.pubkey, to.pubkey, env));
  }
  const a = await waitCall(A, (s) => s.callState === 'connected' && s.verified);
  const b = await waitCall(B, (s) => s.callState === 'connected' && s.verified);
  const fa = await A.adv('callFingerprints');
  const fb = await B.adv('callFingerprints');
  sc.check('a call set up while the operator injects offers for both sides connects with cross-matching fingerprints (no MITM)',
    rang && !!a && !!b && crossMatch(fa, fb), JSON.stringify({ a, b, fa, fb }));
  await A.hangUp();
  await waitCall(A, idle, 15_000);
  await waitCall(B, idle, 15_000);
  mc.link?.disconnect();
  return sc;
}

// ───────────── C3：指紋對不上 → 掛斷 ─────────────

export async function C3(world) {
  const sc = new Scenario('C3', 'DTLS fingerprint mismatch (Bob\'s phone reports a certificate A did not see — as with a man in the middle): A hangs up, tells the user, A\'s microphone was never sent; Bob\'s call ends too');
  const { A, B } = world.p;
  await waitCall(A, idle, 15_000);
  await waitCall(B, idle, 15_000);
  const n0 = (await A.adv('notices')).length;
  const a0 = (await callOf(A))?.counters ?? {};
  await B.adv('corruptFingerprints', true);
  try {
    await A.startVoiceCall(B.name);
    const rang = await B.acceptIncomingCall();
    sc.check('B\'s phone rings and B accepts', rang, '');
    const aEnd = await waitCall(A, (s) => (s.counters?.['fp-mismatch'] ?? 0) > (a0['fp-mismatch'] ?? 0), 45_000);
    sc.check('A detects the fingerprint mismatch', !!aEnd, JSON.stringify(await callOf(A)));
    const a1 = await waitCall(A, (s) => s.callState === 'ended' || s.callState === 'idle', 10_000);
    sc.check('…and hangs up', !!a1, JSON.stringify(await callOf(A)));
    sc.check('A never counted the call as verified (its microphone was never sent)',
      ((await callOf(A))?.counters?.['fp-verified'] ?? 0) === (a0['fp-verified'] ?? 0), JSON.stringify((await callOf(A))?.counters));
    const notice = (await A.adv('notices')).slice(n0).find((x) => x.kind === 'mqtt:call-unverified');
    sc.check('A\'s user is told (call-unverified notice)', !!notice, JSON.stringify((await A.adv('notices')).slice(n0)));
    // 畫面上的提示橫幅（ConnectionNotice）：看得到，使用者按「知道了」關掉（不然它蓋住頁首，之後的情境點不到返回鍵）
    const banner = A.page.locator('div[role="alert"]', { hasText: A.t('connectionNotice.securityTitle') }).first();
    const shown = await banner.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    sc.check('…on screen: the security banner explains the call was hung up', shown, `title "${A.t('connectionNotice.securityTitle')}"`);
    if (shown) await banner.getByRole('button', { name: A.t('connectionNotice.dismiss'), exact: true }).click().catch((e) => sc.note(`dismiss: ${e.message}`));
    const bEnd = await waitCall(B, (s) => s.callState === 'ended' || s.callState === 'idle', 15_000);
    sc.check('B\'s call ends too (A sent end)', !!bEnd, JSON.stringify(await callOf(B)));
  } finally {
    await B.adv('corruptFingerprints', false).catch(() => {});
  }
  await waitCall(A, idle, 15_000);
  await waitCall(B, idle, 15_000);
  const ready = await dcReady(world, sc, A, B);
  sc.check('the A↔B DataChannel still works afterwards', !!ready, '');
  return sc;
}

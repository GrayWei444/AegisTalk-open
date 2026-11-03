/**
 * 開源第 5d 步（docs/DIRECT_SEALED.md §4「Push ring」「Group calls」）：
 *   G1  群組通話 A、B、C（B、C 不是好友）：每一對的 DTLS 指紋兩邊都驗過才接通、交叉對得上（中間沒有人）；
 *       再一通：C 送出去的指紋故意寫錯（＝中間有人）→ A、B 只拆掉跟 C 的那一條、提示使用者，A↔B 照樣驗過、接通
 *   R1  推播來電的響鈴 token：好友 A 真的來電推播 → B 的 JS 那一條路（跟 service worker 同一段 decideRing ＋ pushDisplayFor，
 *       名單是 B 的 App 自己同步的）響、顯示 B 自己存的名字；營運方／Mallory 偽造的推播（沒有 token、Mallory 簽成 A、Mallory 自己的、
 *       A 給別人的、重放、太舊、推播說的寄件人不對）一律不響、不顯示名字；推播伺服器擋掉偽造的、轉寄的 token
 * G1 接在 S1 之後（A、B、C 同一個群組）；R1 接在 G1 之後（離 C1 的真推播夠久：太舊的那一張要真的太舊）。
 */
import { Scenario, waitFor, sleep } from './scenarios.mjs';
import { ringTokenOk } from './lib/mockApi.mjs';

const sameSet = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length > 0 && x.length === y.length && x.every((v) => y.includes(v));
const crossMatch = (a, b) => !!a && !!b && sameSet(a.local, b.remote) && sameSet(a.remote, b.local);
const dbg = (ph) => ph.adv('groupCallDebug').catch(() => null);
const idleCall = (ph) => waitFor(async () => (await dbg(ph))?.groupId === null, { timeout: 15_000, interval: 500 });
const peerOf = async (x, y) => (await dbg(x))?.peers?.[y.pubkey] ?? null;
const counter = async (ph, k) => (await dbg(ph))?.counters?.[k] ?? 0;

async function endGroupCall(world, phones) {
  for (const ph of phones) await ph.adv('groupCallLeave').catch(() => {});
  for (const ph of phones) await idleCall(ph);
  await sleep(500);
}

async function startGroupCall(gid, A, joiners) {
  await A.adv('groupCallStart', gid, false);
  for (const ph of joiners) {
    await sleep(1_500);
    await ph.adv('groupCallJoin', gid, false);
  }
}

// ───────────── G1：群組通話的 DTLS 指紋 ─────────────

export async function G1(world) {
  const sc = new Scenario('G1', 'Group call A, B, C (B and C are not friends): every pair connects only after its DTLS fingerprints cross-match (no man in the middle); then Carol\'s phone reports a certificate the others did not see — A and B drop only Carol\'s connection and tell the user, A↔B stays verified');
  const { A, B, C } = world.p;
  const gid = await A.groupIdByName(world.groupName);
  sc.check('A, B and C share the group from S1', !!gid && !!(await B.groupIdByName(world.groupName)) && !!(await C.groupIdByName(world.groupName)), String(gid));
  if (!gid) return sc;
  const pairs = [[A, B], [A, C], [B, C]];

  // 1 全部對得上
  await startGroupCall(gid, A, [B, C]);
  const all = await waitFor(async () => {
    for (const [x, y] of pairs) {
      const xy = await peerOf(x, y);
      const yx = await peerOf(y, x);
      if (!xy?.verified || !xy.connected || !yx?.verified || !yx.connected) return null;
    }
    return true;
  }, { timeout: 90_000, interval: 1_000 });
  sc.check('every pair (A↔B, A↔C, B↔C) is connected only with verified fingerprints on both sides', !!all,
    JSON.stringify({ A: await dbg(A), B: await dbg(B), C: await dbg(C) }));
  for (const [x, y] of pairs) {
    const fx = await x.adv('groupCallFingerprints', y.pubkey).catch(() => null);
    const fy = await y.adv('groupCallFingerprints', x.pubkey).catch(() => null);
    sc.check(`no man in the middle ${x.name[0]}↔${y.name[0]}: each one's remote fingerprint is the other's local`, crossMatch(fx, fy), JSON.stringify({ fx, fy }));
  }
  const streams = await Promise.all(pairs.flatMap(([x, y]) => [peerOf(x, y), peerOf(y, x)]));
  sc.check('the remote streams reach the screen only now (after verification)', streams.every((p) => p?.stream), JSON.stringify(streams), false);
  sc.check('no fingerprint failure on any phone',
    (await Promise.all([A, B, C].map((ph) => dbg(ph)))).every((d) => !Object.keys(d?.counters ?? {}).some((k) => /^fp-(mismatch|timeout|unreadable)$/.test(k))),
    JSON.stringify((await Promise.all([A, B, C].map((ph) => dbg(ph)))).map((d) => d?.counters)));
  await endGroupCall(world, [A, B, C]);

  // 2 C 的指紋對不上（中間有人）
  const nA0 = (await A.adv('notices')).length;
  const nB0 = (await B.adv('notices')).length;
  const mA0 = await counter(A, 'fp-mismatch');
  const mB0 = await counter(B, 'fp-mismatch');
  await C.adv('corruptFingerprints', true);
  try {
    await startGroupCall(gid, A, [B, C]);
    const detected = await waitFor(async () => (await counter(A, 'fp-mismatch')) > mA0 && (await counter(B, 'fp-mismatch')) > mB0,
      { timeout: 90_000, interval: 1_000 });
    sc.check('A and B detect the mismatch with Carol', !!detected, JSON.stringify({ A: await dbg(A), B: await dbg(B) }));
    sc.check('…and drop Carol\'s connection (only hers)', !(await peerOf(A, C)) && !(await peerOf(B, C)),
      JSON.stringify({ A: await peerOf(A, C), B: await peerOf(B, C) }));
    const ab = await waitFor(async () => {
      const x = await peerOf(A, B);
      const y = await peerOf(B, A);
      return x?.verified && x.connected && y?.verified && y.connected ? { x, y } : null;
    }, { timeout: 60_000, interval: 1_000 });
    sc.check('A↔B stays verified and connected', !!ab, JSON.stringify({ A: await dbg(A), B: await dbg(B) }));
    const told = async (ph, n0) => (await ph.adv('notices')).slice(n0).some((x) => x.kind === 'mqtt:group-call-unverified');
    sc.check('A\'s and B\'s users are told (group-call-unverified notice)', (await told(A, nA0)) && (await told(B, nB0)),
      JSON.stringify({ A: (await A.adv('notices')).slice(nA0), B: (await B.adv('notices')).slice(nB0) }));
    const banner = A.page.locator('div[role="alert"]', { hasText: A.t('connectionNotice.groupCallUnverifiedBody') }).first();
    const shown = await banner.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    sc.check('…on screen: the security banner explains one participant was dropped', shown, `"${A.t('connectionNotice.groupCallUnverifiedBody').slice(0, 40)}…"`);
    if (shown) await banner.getByRole('button', { name: A.t('connectionNotice.dismiss'), exact: true }).click().catch((e) => sc.note(`dismiss: ${e.message}`));
    sc.note(`Carol's own view (she compared the others' honest fingerprints): ${JSON.stringify(await dbg(C))}`);
  } finally {
    await C.adv('corruptFingerprints', false).catch(() => {});
    await endGroupCall(world, [A, B, C]);
  }
  for (const ph of [A, B, C]) await ph.dismissOverlays().catch(() => {});
  return sc;
}

// ───────────── R1：推播來電的響鈴 token ─────────────

const claimsOf = (token) => {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
};
/** 推播伺服器組給收件端的內容（＝ api/chat/push.py push_fcm_data） */
const pushData = (hint, sender) => ({
  type: hint.type, action: 'wake_and_sync', senderPubkey: sender, isVideoCall: hint.isVideoCall ? 'true' : 'false',
  ...(hint.ringToken ? { ringToken: hint.ringToken } : {}),
});

export async function R1(world) {
  const sc = new Scenario('R1', 'Push ring tokens: a genuine incoming-call push from friend A rings B\'s JS push path with B\'s own name for A; forged pushes from the operator / Mallory (no token, Mallory signing as A, Mallory\'s own token, A\'s token for someone else, a replay, a stale token, another named sender) never ring and show no name; the push server refuses forged and forwarded tokens');
  const { A, B, C } = world.p;
  const adv = world.adv;
  const M = adv.mallory;
  const dir = await waitFor(() => B.adv('ringDirectory'), { timeout: 30_000, interval: 1_000 });
  sc.check('B\'s app synced the ring directory for its JS push path (me + friends)', dir?.me === B.pubkey && dir.friends >= 1, JSON.stringify(dir));
  const nameOfA = (await B.friends()).find((f) => f.pubkey === A.pubkey)?.nickname ?? '';
  sc.check('B has a local name for A', !!nameOfA, JSON.stringify(await B.friends()));

  // 真的來電推播（A 打給 B，B 不接）
  const p0 = adv.mockApi.pushes.length;
  await A.startVoiceCall(B.name);
  const push = await waitFor(() => adv.mockApi.pushes.slice(p0).find((p) => p.from === A.pubkey && p.to === B.pubkey && p.hint?.type === 'incoming_call'),
    { timeout: 20_000, interval: 500 });
  await A.hangUp().catch((e) => sc.note(`hang up: ${e.message}`));
  await waitFor(async () => (await A.callState())?.callState === 'idle' && (await B.callState())?.callState === 'idle', { timeout: 45_000, interval: 1_000 });
  await B.dismissOverlays().catch(() => {});
  const hint = push?.hint ?? {};
  const claims = claimsOf(hint.ringToken);
  sc.check('A\'s incoming-call push carries a ring token the server accepted (signed by A for B, this call, no name)',
    !!hint.ringToken && ringTokenOk(hint.ringToken, A.pubkey, B.pubkey, Date.now()) && claims?.from === A.pubkey && claims?.to === B.pubkey
      && Object.keys(hint).every((k) => ['type', 'isVideoCall', 'ringToken'].includes(k)) && !/nick|name/i.test(JSON.stringify(claims)),
    JSON.stringify({ hint: Object.keys(hint), claims }));
  const genuine = pushData(hint, A.pubkey);

  const ok = await B.adv('ringDecision', genuine);
  sc.check('the genuine push rings B\'s JS path with B\'s own name for A (call style)',
    ok?.ring?.name === nameOfA && ok.display.ring === true && ok.display.body.includes(nameOfA), JSON.stringify(ok));

  const shownName = (d) => !!nameOfA && (JSON.stringify(d?.display ?? {}).includes(nameOfA) || !!d?.ring);
  const forged = [
    ['the same push again (replay)', B, genuine],
    ['no ring token (the server-named sender alone)', B, pushData({ type: 'incoming_call', isVideoCall: false }, A.pubkey)],
    ['Mallory signs a token as A', B, pushData({ type: 'incoming_call', ringToken: M.ringToken(B.pubkey, { from: A.pubkey }) }, A.pubkey)],
    ['Mallory\'s own valid token (a stranger)', B, pushData({ type: 'incoming_call', ringToken: M.ringToken(B.pubkey) }, M.pk)],
    ['A\'s token for B delivered to Carol', C, genuine],
    ['A\'s genuine token with another named sender', B, pushData(hint, M.pk)],
  ];
  // C1 的真推播（A→B）：等到它超過 5 分鐘（R1 排在 G1 之後，通常早就超過了）
  const c1 = adv.mockApi.pushes.find((p) => p.from === A.pubkey && p.to === B.pubkey && p.hint?.ringToken && p !== push);
  if (c1) {
    const age = Date.now() - (claimsOf(c1.hint.ringToken)?.iat ?? Date.now());
    if (age < 5.5 * 60_000) { sc.note(`waiting ${Math.round((5.5 * 60_000 - age) / 1000)} s for C1's token to be stale`); await sleep(5.5 * 60_000 - age); }
    forged.push([`a stale genuine token (C1's, ${Math.round((Date.now() - claimsOf(c1.hint.ringToken).iat) / 1000)} s old, never shown)`, B, pushData(c1.hint, A.pubkey)]);
  } else {
    sc.check('a genuine push from C1 was recorded (for the stale-token case)', false, '');
  }
  for (const [label, ph, data] of forged) {
    const d = await ph.adv('ringDecision', data);
    sc.check(`forged / replayed push — ${label}: no ring, no name`, d && d.ring === null && d.display.ring === false && !shownName(d), JSON.stringify(d));
  }

  // 推播伺服器（api/chat/push.py ring_token_ok 的那一關；模擬 API 照它驗）
  const refused = async (label, h) => {
    const r = await M.pushNotify(B.pubkey, h);
    sc.check(`push server refuses ${label}`, r.status === 422, JSON.stringify(r));
  };
  await refused('a token Mallory signed as A', { type: 'incoming_call', ringToken: M.ringToken(B.pubkey, { from: A.pubkey }) });
  await refused('A\'s genuine token forwarded by Mallory', { type: 'incoming_call', ringToken: hint.ringToken });
  await refused('a token on a message push', { type: 'message', ringToken: M.ringToken(B.pubkey) });
  const own = await M.pushNotify(B.pubkey, { type: 'incoming_call', ringToken: M.ringToken(B.pubkey) });
  sc.check('…but takes Mallory\'s own token (his signature, to B) — B\'s phone still does not ring for it (above)', own.status === 200, JSON.stringify(own));
  return sc;
}

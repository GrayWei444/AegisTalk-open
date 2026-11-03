/**
 * 群組語意情境（LINE 式：群組裡每個成員都看得到每一則群組訊息，不管是不是寄件人的好友；
 * 加人、踢人、離開（金鑰輪換）之後、以及有人在成員變動時離線，都一樣）。
 *
 * 情境依序接續（S2 接 S1 的狀態……），每個情境各自判 PASS/FAIL。
 * 判定只看「必要」檢查（required）；其餘是幫忙找原因的資訊（名冊、金鑰、管理權）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 45_000, interval = 700 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = undefined; }
    await sleep(interval);
  }
  return last;
}

function rand() { return Math.random().toString(36).slice(2, 6); }

export class Scenario {
  constructor(id, title) {
    this.id = id; this.title = title; this.checks = []; this.notes = []; this.error = null;
    this.startedAt = Date.now();
  }
  check(name, pass, detail = '', required = true) {
    this.checks.push({ name, pass: !!pass, required, detail });
    return pass;
  }
  note(s) { this.notes.push(s); }
  get pass() { return !this.error && this.checks.filter((c) => c.required).every((c) => c.pass); }
}

/** 診斷：一則訊息從 from 到 to 停在哪裡 */
async function diagnose(world, from, to, since, text) {
  const out = [];
  const safe = async (f) => { try { return await f(); } catch (e) { return 'err: ' + e.message; } };
  out.push(`P2P ${from.name}→${to.name}: ${from.name} sees peer state=${await safe(() => from.peerState(to.pubkey))}; ${to.name} sees ${from.name} state=${await safe(() => to.peerState(from.pubkey))}`);
  const pend = await safe(() => from.pending());
  if (Array.isArray(pend)) {
    const mine = pend.filter((p) => p.to_pk === to.pubkey);
    out.push(`${from.name} outbox → ${to.name}: ${mine.length} pending ${mine.map((p) => p.type + '#' + p.retry_count).join(', ')}`);
  }
  const esc = (x) => String(x ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const reFrom = new RegExp(`useGroupChat|SIM:DC:SEND|DIAG:P2P|DIAG:SEND|connectPeer|WebRTC.*${esc(to.pubkey?.slice(0, 8))}|rotate|Group Key|GROUP_`, 'i');
  const reTo = new RegExp(`DIAG:GK|SIM:DC:RECV|DIAG:P2P|WebRTC|inbound|GROUP_|rotate|Group Key|offer`, 'i');
  out.push(`--- ${from.name} log (since send):`, ...from.grep(reFrom, since, 25));
  out.push(`--- ${to.name} log (since send):`, ...to.grep(reTo, since, 30));
  out.push(`--- broker (since send):`, ...world.brokerGrep(new RegExp(`${esc(from.name)}|${esc(to.name)}`), since, 30));
  return out;
}

export async function expectSeen(world, sc, sender, observer, groupName, text, since, { timeout = 45_000, required = true } = {}) {
  const gid = await observer.groupIdByName(groupName).catch(() => null);
  const ok = await waitFor(async () => {
    if (!observer.page) return false;
    const id = gid || (await observer.groupIdByName(groupName));
    if (!id) return false;
    const msgs = await observer.groupMessages(id);
    return msgs.some((m) => m.content === text);
  }, { timeout });
  sc.check(`${observer.name} sees ${sender.name}'s "${text}"`, ok, ok ? '' : (await diagnose(world, sender, observer, since, text)).join('\n'), required);
  if (!ok) world.missing.push({ observer, sender, text, sentAt: since, scenario: sc.id });
  return ok;
}

export async function expectNotSeen(sc, observer, text, { required = true } = {}) {
  if (!observer.page) { sc.check(`${observer.name} does not receive "${text}"`, true, 'app closed'); return true; }
  const rows = await observer.q('SELECT id, group_ids FROM messages WHERE content = ?', [text]);
  const ok = rows.length === 0;
  sc.check(`${observer.name} does NOT receive "${text}"`, ok, ok ? '' : `found in ${observer.name}'s DB: ${JSON.stringify(rows)}`, required);
  return ok;
}

const WORDS = ['lunch', 'movie', 'park', 'coffee', 'game', 'music', 'dinner', 'beach', 'train', 'books'];
export async function send(sc, sender, groupName, label) {
  // 一般聊天句子＋唯一標記（亂碼字串容易被 App 的防詐 L2 當成可疑而跳警告）
  const text = `${sender.name}: ${label.replace(/-/g, ' ')}, ${WORDS[Math.floor(Math.random() * WORDS.length)]} later? #${sc.id}${rand()}`;
  const since = Date.now();
  await sender.sendGroupText(groupName, text);
  return { text, since };
}

export async function roster(phone, groupName) {
  const id = await phone.groupIdByName(groupName);
  if (!id) return null;
  return phone.groupRoster(id);
}

export function names(world, rows) {
  if (!rows) return '(no group)';
  return rows.map((r) => `${world.nameOf(r.pubkey)}${r.role === 'admin' ? '*' : ''}`).join(',');
}

export async function activeKey(phone, groupName) {
  const id = await phone.groupIdByName(groupName);
  if (!id) return null;
  const keys = await phone.groupKeys(id);
  const act = keys.filter((k) => k.is_active === 1 || k.is_active === true);
  return { all: keys.map((k) => '…' + k.key_id.slice(-7) + (k.is_active ? '(active)' : '')), active: act.map((k) => k.key_id) };
}

export async function sendDirect(sc, sender, recipient, label) {
  const text = `${sender.name}: ${label.replace(/-/g, ' ')}, ${WORDS[Math.floor(Math.random() * WORDS.length)]} later? #${sc.id}${rand()}`;
  const since = Date.now();
  await sender.sendDirectText(recipient.name, text);
  return { text, since };
}

/** 1 對 1：收件人的資料庫裡有這則（不是自己送出的那份） */
export async function expectDirect(world, sc, sender, recipient, sent, { timeout = 45_000, what = '' } = {}) {
  const ok = await waitFor(async () => {
    if (!recipient.page) return false;
    const rows = await recipient.q('SELECT id FROM messages WHERE content = ? AND is_outgoing = 0', [sent.text]);
    return rows.length > 0;
  }, { timeout });
  sc.check(`${recipient.name} receives ${sender.name}'s direct "${sent.text}"${what}`, ok,
    ok ? '' : (await diagnose(world, sender, recipient, sent.since, sent.text)).join('\n'), true);
  if (!ok) world.missing.push({ observer: recipient, sender, text: sent.text, sentAt: sent.since, scenario: sc.id });
  return ok;
}

// ───────────────────────── 情境 ─────────────────────────

export async function setupWorld(world) {
  const sc = new Scenario('SETUP', 'Register A,B,C,D; A befriends B, C, D (B, C, D are not friends with each other)');
  const { A, B, C, D } = world.p;
  for (const ph of [A, B, C, D]) {
    await ph.register();
    sc.note(`${ph.name} registered, pubkey ${ph.pubkey?.slice(0, 12)}`);
  }
  const code = await A.myFriendCode();
  sc.note(`A's friend code ${code}`);
  for (const ph of [B, C, D]) {
    await ph.addFriendByCode(code);
    const ok = await waitFor(async () => {
      const af = await A.friends();
      const pf = await ph.friends();
      return af.some((f) => f.pubkey === ph.pubkey) && pf.some((f) => f.pubkey === A.pubkey);
    }, { timeout: 45_000 });
    sc.check(`A and ${ph.name} are friends on both sides`, ok, ok ? '' : `A: ${JSON.stringify(await A.friends())} / ${ph.name}: ${JSON.stringify(await ph.friends())}`);
  }
  for (const [x, y] of [[B, C], [B, D], [C, D]]) {
    const xf = await x.friends();
    sc.check(`${x.name} and ${y.name} are NOT friends`, !xf.some((f) => f.pubkey === y.pubkey), '', true);
  }
  return sc;
}

/**
 * 1 對 1（好友之間，內容走 P2P、信令走 MQTT 收件箱）：兩個方向都要到；B 離線時 A 發的那則，B 回來之後要補到
 * （A 的待送佇列 → B 上線的 presence → 建 P2P → 補送）。在群組情境之前跑：S6 會把 A、B 關掉。
 * 接著傳檔（移植群星 B32）：小檔送一次、B 回 ack 後 A 的待送清單清掉；大檔傳到一半 B 關 App → A 留在待送清單 →
 * B 回來後 A 補送、B 收齊（App 自己驗 sha256）、回 ack、清單清掉，B 只存一份。
 */
export async function D1(world) {
  const sc = new Scenario('D1', '1:1 chat: A↔B both directions; a message A sends while B is offline arrives when B comes back; a file transfer interrupted by B closing resumes when B is back');
  const { A, B } = world.p;
  const a1 = await sendDirect(sc, A, B, 'hello');
  await expectDirect(world, sc, A, B, a1);
  const b1 = await sendDirect(sc, B, A, 'hi back');
  await expectDirect(world, sc, B, A, b1);
  sc.check(`B's chat screen shows A's message`, await B.uiChatShows('Alice', a1.text), '', false);

  const offAt = Date.now();
  await B.closeApp();
  // 等 A 真的發現 B 走了（P2P 通道關了）再發：這則一定要進 A 的待送佇列、等 B 回來才補得到
  const gone = await waitFor(async () => (await A.peerState(B.pubkey)) !== 'open', { timeout: 30_000, interval: 500 });
  sc.note(`B closed the app; A's channel to B ${gone ? 'closed' : 'still looked open'} after ${Math.round((Date.now() - offAt) / 1000)}s`);
  const a2 = await sendDirect(sc, A, B, 'while-B-offline');
  await sleep(5_000);
  const queued = (await A.pending()).filter((p) => p.to_pk === B.pubkey).length;
  sc.note(`while B offline: A has ${queued} message(s) queued for B`);
  const backAt = Date.now();
  await B.reopenApp();
  sc.note(`B reopened the app ${Math.round((backAt - offAt) / 1000)}s after closing`);
  await expectDirect(world, sc, A, B, a2, { timeout: 60_000, what: ' (sent while B was offline)' });
  const b2 = await sendDirect(sc, B, A, 'back online');
  await expectDirect(world, sc, B, A, b2, { what: ' (after B came back)' });
  await directFileWithInterruption(world, sc, A, B);
  return sc;
}

/** D1 的傳檔段：檔名每輪唯一；檔案放在 log 目錄，跑完刪掉 */
async function directFileWithInterruption(world, sc, A, B) {
  const CHUNK = 64 * 1024;   // fileTransfer.ts CHUNK_SIZE
  const mkFile = (label, bytes) => {
    const file = path.join(A.sim.logDir, `${label}-${rand()}.bin`);
    fs.writeFileSync(file, crypto.randomBytes(bytes));
    return { path: file, name: path.basename(file), size: bytes, chunks: Math.ceil(bytes / CHUNK) };
  };
  const copies = async (ph, f) => (ph.page ? (await ph.receivedFiles()).filter((r) => r.name === f.name && r.size === f.size).length : 0);
  const parked = async (ph, f) => ((await ph.parkedFiles()) ?? []).filter((p) => p.name === f.name);
  const fileLog = /fileTransfer|DIAG:FILE|SIM:DC:(SEND|RECV).*(file_ctl|encrypted_message)/;
  const files = [];
  try {
    // 1. 小檔，兩邊都在線
    const f1 = mkFile('d1-small', 300 * 1024);
    files.push(f1);
    const f1At = Date.now();
    await A.sendDirectFile(B.name, f1.path);
    const f1ok = await waitFor(async () => (await copies(B, f1)) > 0, { timeout: 60_000 });
    sc.check(`${B.name} receives ${A.name}'s file (${f1.size}B)`, f1ok,
      f1ok ? '' : [...A.grep(fileLog, f1At, 25), '---', ...B.grep(fileLog, f1At, 25)].join('\n'));
    const f1acked = await waitFor(async () => (await parked(A, f1)).length === 0, { timeout: 30_000 });
    sc.check(`${A.name}'s pending-file list clears once ${B.name} acks`, f1acked, JSON.stringify(await A.parkedFiles()));

    // 2. 大檔，B 收到第一塊 chunk 就關 App
    const f2 = mkFile('d1-big', 32 * 1024 * 1024);
    files.push(f2);
    const firstChunk = B.waitLog(/\[SIM:DC:RECV\].*binary/, 90_000);
    const f2At = Date.now();
    await A.sendDirectFile(B.name, f2.path);
    const started = await firstChunk;
    await B.closeApp();
    const gotBeforeClose = B.grep(/\[SIM:DC:RECV\].*binary/, f2At, 1e6).length;
    const interrupted = started && gotBeforeClose < f2.chunks;
    sc.note(`file 2 (${f2.chunks} chunks): B got ${gotBeforeClose} chunk frame(s) before its app closed${started ? '' : ' (no chunk seen in 90s)'}`);
    sc.check(`the transfer was interrupted mid-way (${gotBeforeClose}/${f2.chunks} chunks before B closed)`, interrupted, '', false);
    await sleep(3_000);
    const stillParked = (await parked(A, f2)).length > 0;
    sc.check(`${A.name} keeps the interrupted file in its pending list while ${B.name} is gone`, stillParked,
      JSON.stringify(await A.parkedFiles()), interrupted);

    // 3. B 回來 → A 補送 → B 收齊、回 ack
    const backAt = Date.now();
    await B.reopenApp();
    const f2ok = await waitFor(async () => (await copies(B, f2)) > 0, { timeout: 150_000, interval: 1_000 });
    sc.check(`${B.name} gets the interrupted file after reopening (${f2.size}B; the app checks sha256)`, f2ok,
      f2ok ? '' : [...A.grep(fileLog, backAt, 30), '---', ...B.grep(fileLog, backAt, 30)].join('\n'));
    sc.check(`${A.name} resumed the parked file when ${B.name} came back`,
      A.grep(/resuming \d+ parked file/, backAt, 5).length > 0, '', interrupted);
    sc.note(`file 2 resumed: B got ${B.grep(/\[SIM:DC:RECV\].*binary/, backAt, 1e6).length} chunk frame(s) after reopening, ${Math.round((Date.now() - backAt) / 1000)}s after reopen`);
    const f2acked = await waitFor(async () => (await parked(A, f2)).length === 0, { timeout: 90_000 });
    sc.check(`${A.name}'s pending list clears after ${B.name} acks the resumed file`, f2acked, JSON.stringify(await A.parkedFiles()));
    const n2 = await copies(B, f2);
    sc.check(`${B.name} stores the file once (no duplicate after the resend)`, n2 === 1, `copies=${n2}`);
  } finally {
    for (const f of files) fs.rmSync(f.path, { force: true });
  }
}

export async function S1(world) {
  const sc = new Scenario('S1', 'A (friend of B and C) creates a group with B and C (B, C not friends); everyone sees everything');
  const { A, B, C } = world.p;
  const G = world.groupName;
  await A.createGroup(G, ['Bob', 'Carol']);
  const createdId = await waitFor(() => A.groupIdByName(G), { timeout: 20_000 });
  if (createdId) world.gids?.add(createdId);
  for (const ph of [B, C]) {
    const r = await waitFor(async () => { const r = await roster(ph, G); return r && r.length === 3 ? r : null; }, { timeout: 45_000 });
    sc.check(`${ph.name} joined the group with the full roster`, !!r, r ? names(world, r) : `roster=${names(world, await roster(ph, G).catch(() => null))}`, true);
  }
  sc.note(`rosters: A=${names(world, await roster(A, G))} B=${names(world, await roster(B, G))} C=${names(world, await roster(C, G))}`);
  sc.note(`keys: A=${JSON.stringify(await activeKey(A, G))} B=${JSON.stringify(await activeKey(B, G))} C=${JSON.stringify(await activeKey(C, G))}`);

  const b1 = await send(sc, B, G, 'hello');
  await expectSeen(world, sc, B, C, G, b1.text, b1.since);
  await expectSeen(world, sc, B, A, G, b1.text, b1.since);
  const c1 = await send(sc, C, G, 'reply');
  await expectSeen(world, sc, C, B, G, c1.text, c1.since);
  await expectSeen(world, sc, C, A, G, c1.text, c1.since);
  const a1 = await send(sc, A, G, 'hi-all');
  await expectSeen(world, sc, A, B, G, a1.text, a1.since);
  await expectSeen(world, sc, A, C, G, a1.text, a1.since);
  // 畫面（不只資料庫）：C 的群組視窗看得到 B 的訊息
  const ui = await C.uiGroupTexts(G).catch(() => []);
  sc.check(`C's group screen shows B's message`, ui.some((t) => t.includes(b1.text)), ui.length ? '' : 'no bubbles rendered', true);
  world.history.S1 = [b1.text, c1.text, a1.text];
  return sc;
}

export async function S2(world) {
  const sc = new Scenario('S2', 'A kicks B; A and C keep chatting after the key rotation; B receives nothing new');
  const { A, B, C } = world.p;
  const G = world.groupName;
  const keysBefore = await activeKey(C, G);
  const bKeys = await activeKey(B, G);
  // W5 S2X：被踢之前，Bob 另外開一條「影子」連線訂著目前這一代的主題、留著這一代的金鑰（惡意的前成員會這樣做）
  if (world.adv?.beforeKick) await world.adv.beforeKick(world, sc).catch((e) => sc.note(`shadow setup failed: ${e.message}`));
  const kickAt = Date.now();
  await A.kick(G, B.pubkey);
  const cr = await waitFor(async () => { const r = await roster(C, G); return r && !r.some((m) => m.pubkey === B.pubkey) ? r : null; }, { timeout: 30_000 });
  sc.check(`C's roster drops B`, !!cr, names(world, await roster(C, G)), false);
  const bGone = await waitFor(async () => !(await B.groupIdByName(G)), { timeout: 30_000 });
  sc.check(`B's app shows B is no longer in the group`, !!bGone, '', false);
  const rotated = await waitFor(async () => {
    const k = await activeKey(C, G);
    return k && k.active.length === 1 && !keysBefore?.active.includes(k.active[0]) ? k : null;
  }, { timeout: 30_000 });
  sc.check(`C got the rotated group key (new active key ≠ the key B holds)`, !!rotated,
    `C before=${JSON.stringify(keysBefore)} C now=${JSON.stringify(await activeKey(C, G))} B holds=${JSON.stringify(bKeys)}`, true);
  // GROUP-TOPICS（W3，run.mjs）：之後每一代的群組主題 id 由這一代起算；B 從沒訂到、從沒收到
  const gidNow = await C.groupIdByName(G);
  if (rotated && gidNow) world.s2 = { gid: gidNow, kid: rotated.active[0], removed: B.name, kickAt };

  const a1 = await send(sc, A, G, 'after-kick');
  await expectSeen(world, sc, A, C, G, a1.text, a1.since);
  const c1 = await send(sc, C, G, 'after-kick');
  await expectSeen(world, sc, C, A, G, c1.text, c1.since);
  await sleep(5000);
  await expectNotSeen(sc, B, a1.text);
  await expectNotSeen(sc, B, c1.text);
  sc.note(`A keys=${JSON.stringify(await activeKey(A, G))}`);
  world.history.S2 = [a1.text, c1.text];
  return sc;
}

export async function S3(world) {
  const sc = new Scenario('S3', 'A adds D (friend of A only) while C is offline; C comes back; C and D see each other');
  const { A, C, D } = world.p;
  const G = world.groupName;
  const offAt = Date.now();
  await C.closeApp();
  sc.note('C closed the app (offline)');
  await A.addMember(G, 'Dave');
  const dr = await waitFor(async () => { const r = await roster(D, G); return r && r.length >= 3 ? r : null; }, { timeout: 45_000 });
  sc.check(`D joined with the full roster`, !!dr, names(world, await roster(D, G).catch(() => null)), true);
  // ① C 剛離線幾秒內 A 發的（A 那邊到 C 的通道看起來還開著）
  const aEarly = await send(sc, A, G, 'right-after-C-left');
  sc.note(`A sent "${aEarly.text}" ${Math.round((aEarly.since - offAt) / 1000)}s after C closed the app`);
  // ② 等 A 的 WebRTC 發現 C 斷了以後才發（應該進 A 的待送佇列，C 回來再補）
  await sleep(Math.max(0, offAt + 20_000 - Date.now()));
  const aLate = await send(sc, A, G, 'while-C-offline');
  // ③ D（不是 C 的好友、從沒跟 C 連過）在 C 離線時發
  const dOff = await send(sc, D, G, 'while-C-offline');
  await expectSeen(world, sc, A, D, G, aLate.text, aLate.since);
  await expectSeen(world, sc, D, A, G, dOff.text, dOff.since);
  const pa = (await A.pending()).filter((p) => p.to_pk === C.pubkey).length;
  const pd = (await D.pending()).filter((p) => p.to_pk === C.pubkey).length;
  sc.note(`while C offline: A has ${pa} queued for C, D has ${pd} queued for C`);
  await sleep(2000);
  const backAt = Date.now();
  await C.reopenApp();
  sc.note(`C reopened the app (online) ${Math.round((backAt - offAt) / 1000)}s after closing`);
  const cr = await waitFor(async () => { const r = await roster(C, G); return r && r.some((m) => m.pubkey === D.pubkey) ? r : null; }, { timeout: 45_000 });
  sc.check(`C's roster learned about D (member-added while offline)`, !!cr, names(world, await roster(C, G)), true);
  await expectSeen(world, sc, A, C, G, aEarly.text, backAt, { timeout: 45_000 });
  await expectSeen(world, sc, A, C, G, aLate.text, backAt, { timeout: 45_000 });
  await expectSeen(world, sc, D, C, G, dOff.text, backAt, { timeout: 45_000 });
  const d1 = await send(sc, D, G, 'after-C-back');
  await expectSeen(world, sc, D, C, G, d1.text, d1.since);
  const c1 = await send(sc, C, G, 'after-C-back');
  await expectSeen(world, sc, C, D, G, c1.text, c1.since);
  await expectSeen(world, sc, C, A, G, c1.text, c1.since);
  sc.note(`keys: A=${JSON.stringify(await activeKey(A, G))} C=${JSON.stringify(await activeKey(C, G))} D=${JSON.stringify(await activeKey(D, G))}`);
  return sc;
}

export async function S4(world) {
  const sc = new Scenario('S4', 'The sole admin A leaves; C and D keep chatting and see everything');
  const { A, C, D } = world.p;
  const G = world.groupName;
  const keysBefore = { C: await activeKey(C, G), D: await activeKey(D, G) };
  await A.leave(G);
  for (const ph of [C, D]) {
    const r = await waitFor(async () => { const r = await roster(ph, G); return r && !r.some((m) => m.pubkey === A.pubkey) ? r : null; }, { timeout: 30_000 });
    sc.check(`${ph.name}'s roster drops A`, !!r, names(world, await roster(ph, G)), false);
  }
  const admins = await waitFor(async () => {
    const rc = await roster(C, G); const rd = await roster(D, G);
    const ac = rc?.filter((m) => m.role === 'admin').map((m) => m.pubkey).join();
    const ad = rd?.filter((m) => m.role === 'admin').map((m) => m.pubkey).join();
    return ac && ac === ad ? ac : null;
  }, { timeout: 20_000 });
  sc.check(`C and D agree on a new admin`, !!admins, `C=${names(world, await roster(C, G))} D=${names(world, await roster(D, G))}`, false);
  const rot = await waitFor(async () => {
    const kc = await activeKey(C, G); const kd = await activeKey(D, G);
    return kc?.active.length === 1 && kd?.active.length === 1 && kc.active[0] === kd.active[0]
      && !keysBefore.C?.active.includes(kc.active[0]) ? kc.active[0] : null;
  }, { timeout: 30_000 });
  sc.check(`C and D both hold the same rotated key (A's copy no longer current)`, !!rot,
    `before C=${JSON.stringify(keysBefore.C)} D=${JSON.stringify(keysBefore.D)} now C=${JSON.stringify(await activeKey(C, G))} D=${JSON.stringify(await activeKey(D, G))}`, true);
  const c1 = await send(sc, C, G, 'after-A-left');
  await expectSeen(world, sc, C, D, G, c1.text, c1.since);
  const d1 = await send(sc, D, G, 'after-A-left');
  await expectSeen(world, sc, D, C, G, d1.text, d1.since);
  await sleep(4000);
  await expectNotSeen(sc, A, c1.text);
  await expectNotSeen(sc, A, d1.text);
  world.history.S4 = [c1.text, d1.text];
  return sc;
}

export async function S5(world) {
  const sc = new Scenario('S5', "Restart: close and reopen C's app; history and new messages still work");
  const { C, D } = world.p;
  const G = world.groupName;
  const gid = await C.groupIdByName(G);
  // App 的資料庫落地有去抖（database.ts DEBOUNCE_MS／MAX_DEBOUNCE_MS：異常關閉最多丟 ~2 秒的寫入，設計上接受）：
  //   W5 起 S5 緊接在 S14 後面，S14 最後一步就是 C 發訊 —— 先等落地再關，這裡測的是「存好的歷史重開還在」
  await sleep(2_500);
  const before = gid ? (await C.groupMessages(gid)).map((m) => m.content) : [];
  const closedAt = Date.now();
  await C.closeApp();
  await C.reopenApp();
  const backAt = Date.now();
  // ① C 一回到線上（App 重開、MQTT 連上），D 馬上發 —— D 手上那條通道還指著 C 關掉前的舊頁面
  const d1 = await send(sc, D, G, 'right after C restart');
  sc.note(`C restarted in ${Math.round((backAt - closedAt) / 1000)}s; D sent "${d1.text}" ${((d1.since - closedAt) / 1000).toFixed(1)}s after C closed the app`);
  const gid2 = await C.groupIdByName(G);
  sc.check(`C still has the group after restart`, !!gid2, '', true);
  const after = gid2 ? (await C.groupMessages(gid2)).map((m) => m.content) : [];
  const lost = before.filter((t) => !after.includes(t));
  sc.check(`C's group history survived the restart (${before.length} messages)`, lost.length === 0, lost.length ? `missing: ${lost.join(', ')}` : '', true);
  const ui = await C.uiGroupTexts(G).catch(() => []);
  const notShown = before.filter((t) => !ui.some((u) => u.includes(t)));
  sc.check(`C's group screen shows the history`, notShown.length === 0, notShown.length ? `not on screen: ${notShown.join(', ')}` : '', true);
  // ② 過 20 秒再發
  await sleep(20_000);
  const d2 = await send(sc, D, G, 'later after C restart');
  const c1 = await send(sc, C, G, 'after-restart');
  await expectSeen(world, sc, D, C, G, d1.text, d1.since);
  await expectSeen(world, sc, D, C, G, d2.text, d2.since);
  await expectSeen(world, sc, C, D, G, c1.text, c1.since);
  return sc;
}

/**
 * 過了 73 小時（以前金鑰輪換有 72 小時的雙發過渡期；W1 起沒有過渡期，只用鏈上目前那一代，這一段照樣留著）：
 * C、D 隔了 73 小時再發群組訊息，彼此還收得到嗎？
 * C、D 兩支手機的牆上時鐘（Date）都往後撥 73 小時、模擬伺服器（簽章時間窗、token 期限、群組 log）一起平移；
 * 只撥一邊的話 WebRTC 信令會因為兩邊時鐘差 73 小時被當成過期訊息丟掉，那就不是在測過渡期了。
 */
export async function S6(world) {
  const sc = new Scenario('S6', '73 h later (no key-transition window since W1; C and D on the chain epoch rotated when A left): C and D still see each other');
  const { C, D } = world.p;
  const G = world.groupName;
  const kc = await activeKey(C, G); const kd = await activeKey(D, G);
  sc.note(`keys before: C=${JSON.stringify(kc)} D=${JSON.stringify(kd)}`);
  const H73 = 73 * 3600 * 1000;
  // A、B 已不在群組裡：關掉，免得它們用真實時間去要 token 被（已平移的）模擬伺服器拒絕而洗 log
  await world.p.A.closeApp(); await world.p.B.closeApp();
  world.setClockOffset(H73);
  await C.timeTravel(H73);
  await D.timeTravel(H73);
  sc.note('73 h later: the sim server and C and D moved their clocks forward 73 h (both apps reopened)');
  const c1 = await send(sc, C, G, 'after-73h');
  await expectSeen(world, sc, C, D, G, c1.text, c1.since);
  const d1 = await send(sc, D, G, 'after-73h');
  await expectSeen(world, sc, D, C, G, d1.text, d1.since);
  return sc;
}

/**
 * App 連續關掉再開，每次都在存檔進行中關（2026-10-15：web 版存檔是 jeep 的「先刪再寫」，在中間關 App 整顆資料庫
 * 就沒了 —— 4605e95 那輪 Dave 重開後空資料庫，見 webStoreAtomicSave）。
 * 平常的資料庫很小，存檔幾毫秒就完，關 App 幾乎碰不到那個空檔；所以先在 D 的資料庫塞 16 MB 亂數（存一次要好幾百毫秒），
 * 每一輪：發一則群訊、等它存進資料庫並過了存檔去抖（2 秒）→ 再寫一筆（觸發 500 毫秒後的存檔）→ 隔一段時間關 App
 * （每輪不同：520 毫秒～1.5 秒，掃過「存檔正在寫」的那段）→ 重開。每次重開：群組、好友、塞的那 16 MB、之前存好的
 * 每一則都要在。最後清掉塞的資料，D 發一則、C 要收得到（重開這麼多次還能用）。
 * 需要 D 已經在群組裡（S3 之後；單獨驗證時跑 S1,S2,S3,S7）。
 */
export async function S7(world) {
  const DELAYS = [520, 560, 600, 650, 700, 760, 830, 920, 1100, 1500];
  const sc = new Scenario('S7', `Restart loop: D's app is closed while its database is being saved and reopened, ${DELAYS.length} times; the database survives every time`);
  const { C, D } = world.p;
  const G = world.groupName;
  const gid = await D.groupIdByName(G);
  if (!gid) { sc.check('D is in the group (S3 has to run before S7)', false, '', true); return sc; }
  const e2eRun = (sql, params = []) => D.page.evaluate(([q, p]) => window.__aegisE2E.run(q, p), [sql, params]);
  const ballastRows = async () => (await D.q('SELECT COUNT(*) AS n FROM sim_ballast').catch(() => [{ n: -1 }]))[0]?.n ?? -1;
  // 16 MB 亂數（randomblob 壓不小）：存一次整顆資料庫要好幾百毫秒，關 App 才碰得到「刪了還沒寫完」
  await e2eRun('CREATE TABLE IF NOT EXISTS sim_ballast (id INTEGER PRIMARY KEY, b BLOB)');
  await e2eRun(`INSERT INTO sim_ballast (b) SELECT randomblob(1048576) FROM
    (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 16) SELECT x FROM c)`);
  await sleep(4_000);                                       // 這一大包先存好
  const friendsBefore = (await D.friends()).length;
  const survivors = new Set((await D.groupMessages(gid)).map((m) => m.content));
  sc.note(`before: ${friendsBefore} friend(s), ${survivors.size} group message(s), ballast rows ${await ballastRows()}`);
  const failures = [];
  const timings = [];
  for (let i = 0; i < DELAYS.length; i++) {
    const settled = await send(sc, D, G, `restart ${i + 1} settled`);
    const stored = await waitFor(async () => (await D.groupMessages(gid)).some((m) => m.content === settled.text), { timeout: 15_000 });
    if (stored) survivors.add(settled.text);
    else failures.push(`round ${i + 1}: "${settled.text}" never reached D's own database`);
    await sleep(2_600);                                     // 去抖存檔最晚 2 秒（database.ts MAX_DEBOUNCE_MS）
    await e2eRun("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('sim_s7_round', ?, ?)", [String(i + 1), Date.now()]);   // 500 毫秒後存檔
    await sleep(DELAYS[i]);
    const closedAt = Date.now();
    await D.closeApp();
    await D.reopenApp();
    timings.push(Math.round((Date.now() - closedAt) / 100) / 10);
    const gid2 = await D.groupIdByName(G).catch(() => null);
    const friends = (await D.friends().catch(() => [])).length;
    const ballast = await ballastRows();
    const now = new Set(gid2 ? (await D.groupMessages(gid2)).map((m) => m.content) : []);
    const missing = [...survivors].filter((t) => !now.has(t));
    if (!gid2 || friends < friendsBefore || ballast !== 16 || missing.length) {
      failures.push(`round ${i + 1} (closed ${DELAYS[i]} ms after the write): group ${gid2 ? 'present' : 'GONE'}, friends ${friends}/${friendsBefore}, `
        + `ballast rows ${ballast}/16, ${missing.length} saved message(s) missing` + (missing.length ? `: ${missing.slice(0, 3).join(' | ')}` : ''));
      break;                                                // 資料庫已經壞了，後面幾輪沒有意義
    }
    for (const t of now) survivors.add(t);
  }
  sc.check(`D's database survived every restart (group, friends, ballast and every saved message still there)`, failures.length === 0, failures.join('\n'), true);
  sc.note(`close delays after the write: ${DELAYS.slice(0, timings.length).join(', ')} ms; reopen took ${timings.join('s, ')}s`);
  if (failures.length) return sc;
  await e2eRun('DROP TABLE IF EXISTS sim_ballast');
  await sleep(3_000);
  const d1 = await send(sc, D, G, 'after restart loop');
  await expectSeen(world, sc, D, C, G, d1.text, d1.since);
  return sc;
}

/** 前面判失敗的「看得到」：最後再等一段時間，分出「晚到」與「一直沒到」 */
export async function lateSweep(world, waitMs = 60_000) {
  const sc = new Scenario('LATE', `Messages that failed earlier: did they arrive later? (waited ${waitMs / 1000}s more)`);
  const items = world.missing.slice();
  if (!items.length) { sc.note('nothing missing'); return sc; }
  const t0 = Date.now();
  const found = new Map();
  await waitFor(async () => {
    for (const m of items) {
      if (found.has(m.text) || !m.observer.page) continue;
      const rows = await m.observer.q('SELECT created_at FROM messages WHERE content = ?', [m.text]).catch(() => []);
      if (rows.length) found.set(m.text, Date.now());
    }
    return found.size === items.length;
  }, { timeout: waitMs, interval: 2000 });
  for (const m of items) {
    const at = found.get(m.text);
    sc.check(`${m.observer.name} ← "${m.text}": ${at ? `arrived late (+${Math.round((at - m.sentAt) / 1000)}s after send)` : `never arrived (${Math.round((Date.now() - m.sentAt) / 1000)}s after send)`}`, !!at, '', false);
  }
  sc.note(`sweep took ${Math.round((Date.now() - t0) / 1000)}s`);
  return sc;
}

export const ALL = { D1, S1, S2, S3, S4, S5, S6, S7 };

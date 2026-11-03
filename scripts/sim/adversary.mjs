/**
 * W5 對抗情境（docs/GROUP_LOG_WIRING_W5.md）：惡意的第五個角色 Mallory（自己的帳號、真的 token 與簽章）、被踢的 Bob（他自己 App 的身分
 * ＋踢之前留下的金鑰）、改過 App 的成員（D 偽造踢人、admin C 換金鑰漏掉人、好友 A 灌邀請）、惡意的營運方（broker 繞過 ACL 塞訊息、
 * 扣下投遞、session 過期；伺服器給不同的人看不同的 log）。
 *
 * 接在 scenarios.mjs 的正常流程裡（run.mjs 決定順序）；每個情境自己判 PASS／FAIL（required 的檢查）。需要的東西都在 world.adv（run.mjs 建）：
 *   broker（inject／spy／withhold／expireSession／refuseConnect）、groupLog（malice／appended／injectEntry）、mockApi、svc（App 的純模組）、
 *   mallory（Actor）、actor(opts)（再開一個攻擊者）、events()（broker 看到的每一樣東西）、deriveTopicId、leakSecrets、expectOpenFailed
 */
import crypto from 'node:crypto';
import { Scenario, waitFor, sleep, send, expectSeen } from './scenarios.mjs';
import { toUrl, randomTid, verify } from './lib/adversaryKit.mjs';

const HEX = (n) => crypto.randomBytes(n).toString('hex');
const sortedKeys = (rows) => (rows ?? []).map((r) => r.pubkey).sort();
/** 引擎的提案結果：套上了或還在路上（過時了會在新的 head 上重寫） */
const okProp = (r) => r === 'applied' || r === 'pending';

// ───────────── 小工具 ─────────────

const gidOf = (world) => world.s2?.gid ?? [...world.gids][0] ?? null;

async function keysOf(ph, gid) {
  return ph.q('SELECT key_id, key_base64, epoch_v, is_active FROM group_keys WHERE group_id = ? ORDER BY epoch_v', [gid]);
}

async function activeRow(ph, gid) {
  return (await keysOf(ph, gid)).find((k) => Number(k.is_active) === 1) ?? null;
}

async function logState(ph, gid) {
  return (await ph.q('SELECT head_v, head_id, head_seq, processed_seq FROM group_log_state WHERE gid = ?', [gid]))[0] ?? null;
}

/** 一支手機眼中的群：名冊、admin、名字、目前那一代、head（比對「什麼都沒變」） */
async function snap(ph, gid) {
  if (!ph.page) return null;
  const members = await ph.q('SELECT pubkey, role FROM group_members WHERE group_id = ?', [gid]);
  const g = (await ph.q('SELECT name FROM groups WHERE id = ?', [gid]))[0];
  const st = await logState(ph, gid);
  const act = await activeRow(ph, gid);
  return { roster: sortedKeys(members), admins: members.filter((m) => m.role === 'admin').map((m) => m.pubkey).sort(), name: g?.name ?? null,
    kid: act?.key_id ?? null, headId: st?.head_id ?? null, headV: st?.head_v ?? null };
}

async function snapAll(phones, gid) {
  const out = {};
  for (const ph of phones) out[ph.name] = await snap(ph, gid);
  return out;
}

function sameSnap(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function diffSnaps(before, after) {
  const out = [];
  for (const k of Object.keys(before)) if (!sameSnap(before[k], after[k])) out.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  return out.join('\n');
}

/** 這支目前這一代的群組主題 id（從它自己的金鑰推；W3 deriveTopicId） */
async function tidOf(world, ph, gid) {
  const act = await activeRow(ph, gid);
  return act ? world.adv.deriveTopicId(act.key_base64, gid) : null;
}

const stats = (ph) => ph.adv('engineCall', 'controlStats').catch(() => ({}));
const delta = (a, b, k) => (b?.[k] ?? 0) - (a?.[k] ?? 0);

/** 拆一則群組主題上的 group_sealed（外層 JSON 的 payload ＝ { n, c }）；拆不開 → null */
async function openCtl(world, raw, { gid, tid, kid, keyB64 }) {
  const { CTL } = world.adv.svc;
  try {
    const m = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    return await CTL.openControl({ envelope: m.payload, gid, tid, sender: m.from, kid, key: new Uint8Array(Buffer.from(keyB64, 'base64')), verify });
  } catch {
    return null;
  }
}

/** 模擬時鐘（S6 之後手機與伺服器都 +73 小時）：每個情境開頭設好 */
let clockOf = () => 0;
/** 一則 App 外層格式的 MQTT 訊息（外層時戳照模擬時鐘：不然 App 當成太舊的丟掉，攻擊就沒測到） */
const msg = (type, from, payload, extra = {}) => JSON.stringify({ type, from, payload, timestamp: Date.now() + clockOf() + (extra.offset ?? 0), ...(extra.to ? { to: extra.to } : {}) });

/** 每一支在線手機：要求補抓這個群的 log（被塞的東西大家馬上看到，不必等 2 分鐘的輪詢） */
async function syncEveryone(phones, gid) {
  for (const ph of phones) if (ph.page) await ph.adv('engineCall', 'requestSync', gid).catch(() => {});
}

// ───────────── S2X：被踢的 Bob ─────────────

/** S2 踢人之前（scenarios.mjs 呼叫）：Bob 的影子連線訂著目前這一代的主題，記下這一代的金鑰 */
export async function prepareBobShadow(world, sc) {
  clockOf = world.clockOffset ?? (() => 0);
  const { B } = world.p;
  const gid = await B.groupIdByName(world.groupName);
  const act = gid ? await activeRow(B, gid) : null;
  if (!act) { sc.note('shadow: Bob has no active key'); return; }
  const oldTid = world.adv.deriveTopicId(act.key_base64, gid);
  const shadow = world.adv.actor({ label: 'Bob~shadow', pk: B.pubkey, clientSuffix: 'shadow01',
    sign: async (bytes) => Buffer.from(await B.adv('sign', Buffer.from(bytes).toString('base64')), 'base64') });
  const { link, connack, token } = await shadow.connect({ groups: [oldTid] });
  const granted = link ? await link.subscribe([`mist/group/${oldTid}/+`]) : [];
  world.s2x = { gid, oldKid: act.key_id, oldKey: act.key_base64, oldTid, shadow, link, connack, granted, armedAt: Date.now() };
  sc.note(`Bob's shadow connection (Bob's own identity, his retained key): token ${token.status}, CONNACK ${connack}, SUBACK ${JSON.stringify(granted)} on the current tid ${oldTid.slice(0, 6)}…`);
}

export async function S2X(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S2X', 'Removed Bob (S2) keeps the old topic, asks for keys and a sync; Alice renames, changes guardian settings, adds a member (S3) and starts a call — Bob learns nothing but his removal');
  const { A, B, C, D } = world.p;
  const x = world.s2x;
  const adv = world.adv;
  if (!x?.link || !world.s2?.kickAt) { sc.check("Bob's shadow connection was set up before the kick in S2", false, JSON.stringify({ x: !!x, s2: !!world.s2 })); return sc; }
  const { gid, oldTid, oldKid, oldKey } = x;
  const kickAt = world.s2.kickAt;
  const removeEntry = adv.groupLog.appended.find((e) => e.gid === gid && e.who === 'Alice' && e.at >= kickAt);
  const removeSeq = removeEntry?.seq ?? null;
  sc.note(`removal appended by Alice at seq ${removeSeq}`);

  // ── 1. Bob 的 App 去要目前這一代與上一代的金鑰；影子連線在舊主題上發 sync ──
  const cur = await activeRow(C, gid);
  const reqAt = Date.now();
  for (const to of [A, C, D]) await B.adv('sendSealed', to.pubkey, { kind: 'req', gid, kid: cur.key_id }).catch((e) => sc.note(`req to ${to.name}: ${e.message}`));
  await B.adv('sendSealed', A.pubkey, { kind: 'req', gid, kid: oldKid }).catch(() => {});
  const before = { A: await stats(A), C: await stats(C) };
  const sealedSync = await B.adv('sealControl', { gid, kid: oldKid, keyB64: oldKey, t: 'sync', body: { have: { seq: 1, id: 'a'.repeat(64) } } });
  const syncAt = Date.now();
  const syncAck = await x.link.publish(x.shadow.groupTopic(oldTid), msg('group_sealed', B.pubkey, sealedSync.envelope), { qos: 1 });
  sc.check(`the broker accepts Bob's sync on the old topic (PUBACK ${syncAck}: any account may publish on mist/group/+/<me>)`, syncAck === 0, '', false);
  // 營運方＋被踢的 Bob 串通：Bob 用他留著的上一代金鑰封一則「Carol 寄的」here（AAD 綁 Carol，內層是 Bob 的簽章），營運方塞在
  //   舊主題的 Carol 那一節（重疊期裡 Alice 還收舊主題）→ 拆得開、簽章驗不過 → bad-envelope
  const forgedAsCarol = await B.adv('sealControl', { gid, kid: oldKid, keyB64: oldKey, t: 'here', body: { head: { seq: 1, id: 'a'.repeat(64) } }, sender: C.pubkey });
  adv.broker.inject(`mist/group/${oldTid}/${toUrl(C.pubkey)}`, msg('group_sealed', C.pubkey, forgedAsCarol.envelope), { qos: 0 });

  // ── 2. 影子換一張新 token：舊主題、gid 當主題、猜的主題；萬用字元 ──
  const shadow2 = adv.actor({ label: 'Bob~shadow', pk: B.pubkey, clientSuffix: 'shadow02',
    sign: async (bytes) => Buffer.from(await B.adv('sign', Buffer.from(bytes).toString('base64')), 'base64') });
  const guessed = [randomTid(), randomTid(), randomTid()];
  const again = await shadow2.connect({ groups: [oldTid, gid, ...guessed] });
  const granted2 = again.link ? await again.link.subscribe([oldTid, gid, ...guessed].map((t) => `mist/group/${t}/+`)) : [];
  const wildTok = await shadow2.requestToken({ groups: ['+'] });
  const wildSub = again.link ? await again.link.subscribe(['mist/group/+/+']) : [];
  sc.check('a wildcard group id in the token request → 400', wildTok.status === 400, `status ${wildTok.status}`);
  sc.check('subscribing mist/group/+/+ → SUBACK 0x87', JSON.stringify(wildSub) === JSON.stringify([0x87]), JSON.stringify(wildSub));
  sc.note(`fresh shadow token for the old tid + the gid as a tid + 3 guessed tids: ${again.token.status}, SUBACK ${JSON.stringify(granted2)} (the server grants any well-formed tid — metadata only)`);

  // ── 3. Alice：改名、改守護設定、通話（加人是 S3 的 Dave） ──
  const renamed = 'SimGroup S2X';
  adv.leakSecrets.add(renamed);
  const guardian = { type: 'guardian', checkIn: { enabled: false, frequency: 'daily', notifyTime: '09:37', responseDeadline: 24, customMessage: 'sim-checkin-secret-W5' },
    protection: { riskAlert: true, paymentAlert: true, linkAlert: false, riskThreshold: 71 } };
  adv.leakSecrets.add('sim-checkin-secret-W5');
  adv.leakSecrets.add('09:37');
  const actAt = Date.now();
  sc.check('Alice renames the group', okProp(await A.adv('engineCall', 'updateInfo', gid, { name: renamed }).catch((e) => e.message)));
  sc.check('Alice turns it into a guardian group (check-in settings)',
    okProp(await A.adv('engineCall', 'updateInfo', gid, { groupType: 'guardian', guardianSettings: guardian }).catch((e) => e.message)));
  const seen = await waitFor(async () => (await C.adv('groupView', gid))?.name === renamed && (await D.adv('groupView', gid))?.groupType === 'guardian', { timeout: 30_000 });
  sc.check('Carol and Dave see the new name and the guardian settings', !!seen, JSON.stringify(await C.adv('groupView', gid)));
  await A.adv('engineCall', 'sendControl', gid, 'call', { action: 'start', video: false });
  await A.adv('sendSealed', C.pubkey, { kind: 'call', gid, signal: 'offer', data: { type: 'offer', sdp: 'v=0\r\no=sim 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' } }, true);
  const callSeen = await waitFor(async () => (await C.adv('callLog')).some((r) => r.what === 'incoming' && r.gid === gid && r.at >= actAt), { timeout: 20_000 });
  sc.check("Carol's app hears Alice's call start (the call control reached a member)", !!callSeen, JSON.stringify((await C.adv('callLog')).slice(-4)), false);
  await A.adv('engineCall', 'sendControl', gid, 'call', { action: 'end', video: false });
  world.s2x.callAt = actAt;
  await sleep(1_500);
  for (const ph of [C, D]) await ph.dismissOverlays();
  // 改回一般群組、原來的名字（後面的情境照名字找群）
  await A.adv('engineCall', 'updateInfo', gid, { name: world.groupName, groupType: 'normal', guardianSettings: null });
  await waitFor(async () => (await C.adv('groupView', gid))?.name === world.groupName && (await D.adv('groupView', gid))?.groupType === 'normal', { timeout: 30_000 });
  await sleep(6_000);

  // ── 檢查 ──
  // Bob 的資料庫：沒有這個群的任何東西
  const bRows = {
    groups: (await B.q('SELECT COUNT(*) AS n FROM groups WHERE id = ?', [gid]))[0]?.n,
    keys: (await B.q('SELECT COUNT(*) AS n FROM group_keys WHERE group_id = ?', [gid]))[0]?.n,
    commits: (await B.q('SELECT COUNT(*) AS n FROM group_commits WHERE gid = ?', [gid]))[0]?.n,
    messages: (await B.q('SELECT COUNT(*) AS n FROM messages WHERE group_ids LIKE ? AND created_at >= ?', [`%"${gid}"%`, kickAt]))[0]?.n,
  };
  sc.check("Bob's database has nothing of the group after his removal (no group row, key, commit or new message)",
    Object.values(bRows).every((n) => Number(n) === 0), JSON.stringify(bRows));
  const bSealed = (await B.adv('sealedLog')).filter((r) => r.at >= reqAt && r.gid === gid);
  sc.check("no key (dist) and no invite for the group ever reached Bob's engine after his requests", !bSealed.some((r) => r.kind === 'dist' || r.kind === 'invite'), JSON.stringify(bSealed));
  // 寄給 Bob 收件箱的：Carol、Dave 不是他的好友，什麼都不該寄
  const ev = adv.events();
  const toBob = ev.filter((e) => e.kind === 'publish' && e.at >= reqAt && /^mist\/user\//.test(e.topic ?? '') && e.topic.startsWith(`mist/user/${toUrl(B.pubkey)}/inbox/`));
  const fromNonFriends = toBob.filter((e) => e.label === 'Carol' || e.label === 'Dave');
  sc.check('Carol and Dave never wrote to Bob\'s inbox after his key requests (requests from an ex-member are not answered)', fromNonFriends.length === 0,
    fromNonFriends.map((e) => `${e.label} ${e.topic}`).join('\n'));
  // 影子在舊主題上收到的：只有踢他的那則通知（拆得開，head 就是踢人那一號）；其他拆得開的只能是別人還沒套上踢人之前的
  const onOld = ev.filter((e) => e.kind === 'deliver' && e.label === 'Bob~shadow' && e.topic?.startsWith(`mist/group/${oldTid}/`) && e.at >= kickAt
    && !e.topic.endsWith(`/${toUrl(B.pubkey)}`) && e.from !== 'operator');
  let removalNotices = 0;
  const leaks = [];
  for (const d of onOld) {
    const o = await openCtl(world, d.payload, { gid, tid: oldTid, kid: oldKid, keyB64: oldKey });
    if (!o) { leaks.push(`undecryptable ${d.topic.split('/').pop().slice(0, 6)}`); continue; }
    const seq = o.body?.head?.seq ?? o.body?.have?.seq;
    if (o.t === 'commit' && seq === removeSeq) removalNotices++;
    else if ((o.t === 'here' || o.t === 'sync') && removeSeq !== null && seq < removeSeq) { /* 寄件人那時還沒套上踢人 */ }
    else leaks.push(`${o.t} from ${world.nameOf(o.sender)} head=${seq}`);
  }
  sc.check('on the old topic Bob reads exactly the notice of his own removal', removalNotices >= 1, `removal notices ${removalNotices}, deliveries ${onOld.length}`);
  sc.check('…and nothing sent after it (rename, guardian settings, the add, the call all went to topics he cannot derive)', leaks.length === 0, leaks.join('\n'));
  // Bob 的 sync 真的送到了還訂著舊主題的成員（重疊期），他們不拆就丟（寄件人不在名冊上）；回覆只會發在 Bob 推不出來的新主題
  const syncDelivered = ev.filter((e) => e.kind === 'deliver' && ['Alice', 'Carol'].includes(e.label) && e.at >= syncAt && e.topic === x.shadow.groupTopic(oldTid));
  sc.check(`Bob's sync reached members still subscribed to the old topic (${syncDelivered.map((e) => e.label).join(', ') || 'none'})`, syncDelivered.length >= 1,
    'nobody had the old topic subscribed — the drop check below would be empty');
  const after = { A: await stats(A), C: await stats(C) };
  const dropped = delta(before.A, after.A, 'dropped:non-member') + delta(before.C, after.C, 'dropped:non-member') + delta(before.A, after.A, 'dropped:unknown-topic') + delta(before.C, after.C, 'dropped:unknown-topic');
  sc.check("…and their engines dropped it unopened (non-member / unknown topic)", dropped >= 1, JSON.stringify({ before, after }));
  const badEnv = delta(before.A, after.A, 'dropped:bad-envelope') + delta(before.C, after.C, 'dropped:bad-envelope');
  sc.check('a here sealed by Bob with his old key but claiming Carol (operator-injected on her suffix) fails the signature (bad-envelope)', badEnv >= 1, JSON.stringify({ before, after }));
  const repliesToSync = ev.filter((e) => e.kind === 'deliver' && e.label === 'Bob~shadow' && e.at > syncAt && e.topic?.startsWith(`mist/group/${oldTid}/`)
    && !e.topic.endsWith(`/${toUrl(B.pubkey)}`) && e.from !== 'operator');
  sc.check("nobody answers Bob's sync on the old topic (replies go to the current topic, which he cannot derive)", repliesToSync.length === 0, repliesToSync.map((e) => e.topic).join('\n'), false);
  const onGuessed = ev.filter((e) => e.kind === 'deliver' && e.label === 'Bob~shadow' && [gid, ...guessed].some((t) => e.topic?.startsWith(`mist/group/${t}/`)));
  sc.check('nothing ever arrives on the gid used as a topic or on guessed topic ids (by construction: nobody publishes there)', onGuessed.length === 0, onGuessed.map((e) => e.topic).join('\n'), false);
  // log（GET 不用登入）：踢人之後的每一筆，Bob 留著的金鑰一筆都打不開（踢人那一筆本身是上一代封的：他打得開，所以知道自己被踢）
  const { L } = adv.svc;
  const page = await x.shadow.fetchLog(gid, 0);
  let openedAfter = 0;
  let openedRemoval = false;
  for (const e of page.entries) {
    if (removeSeq === null || e.seq < removeSeq) continue;
    try {
      await L.openLogEntry({ blob: e.blob, gid, key: new Uint8Array(Buffer.from(oldKey, 'base64')) });
      if (e.seq === removeSeq) openedRemoval = true; else openedAfter++;
    } catch { /* 打不開 */ }
  }
  sc.check(`Bob's retained key opens his own removal entry but none of the ${page.entries.filter((e) => e.seq > (removeSeq ?? Infinity)).length} later log entries`, openedRemoval && openedAfter === 0,
    `removal opened ${openedRemoval}, later opened ${openedAfter}`);
  x.link.disconnect();
  again.link?.disconnect();
  return sc;
}

// ───────────── S8：營運方塞東西 ─────────────

export async function S8(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S8', 'Operator injection: forged / self-signed / "from admin" add commits in the log, garbage and plaintext adds on the group topic, forged invites into Carol and Dave, Mallory\'s key requests — nothing changes, nothing is answered');
  const { A, C, D } = world.p;
  const adv = world.adv;
  const { G, L } = adv.svc;
  const M = adv.mallory;
  const gid = gidOf(world);
  const phones = [A, C, D];
  const before = await snapAll(phones, gid);
  const tid = await tidOf(world, C, gid);
  const cur = await activeRow(C, gid);
  const t0 = Date.now();
  const st0 = { C: await stats(C), D: await stats(D) };
  const groupsBefore = { C: (await C.q('SELECT COUNT(*) AS n FROM groups'))[0].n, D: (await D.q('SELECT COUNT(*) AS n FROM groups'))[0].n };

  // Mallory 自己的 token：訂目前這一代的主題（伺服器給得出任何 22 字元的 id；只有 metadata）
  const mc = await M.connect({ groups: [tid] });
  const subCur = mc.link ? await mc.link.subscribe([`mist/group/${tid}/+`]) : [];
  sc.note(`Mallory's token for the current tid: ${mc.token.status}, SUBACK ${JSON.stringify(subCur)}`);
  // ACL：冒用別人那一節、訂別人的收件箱、萬用字元 → 一律拒絕（另外算進 Mallory 的拒絕數）
  const denials = [];
  if (mc.link) {
    denials.push(['publish on Alice\'s inbox suffix', await mc.link.publish(`mist/user/${toUrl(C.pubkey)}/inbox/${toUrl(A.pubkey)}`, msg('group_key_sealed', A.pubkey, { v: 1 }))]);
    denials.push(['publish on Alice\'s group suffix', await mc.link.publish(`mist/group/${tid}/${toUrl(A.pubkey)}`, msg('group_sealed', A.pubkey, { n: 'AAAA', c: 'AAAA' }))]);
    denials.push(['subscribe Carol\'s inbox', (await mc.link.subscribe([`mist/user/${toUrl(C.pubkey)}/inbox/+`]))[0]]);
    denials.push(['subscribe #', (await mc.link.subscribe(['#']))[0]]);
    denials.push(['subscribe mist/group/+/+', (await mc.link.subscribe(['mist/group/+/+']))[0]]);
  }
  sc.check('Mallory cannot publish under a member\'s suffix nor subscribe to others\' inboxes or wildcards (all 0x87)', denials.every(([, code]) => code === 0x87), JSON.stringify(denials));

  // (a) log：Mallory 自己的帳號 append（真的簽章）＋營運方直接寫 —— 自簽的 add、冒名 admin 的 add、垃圾；外層 kid 是目前這一代（GET 看得到）
  const fake = (actor, sign) => {
    const c = { gid, v: 99, prev: HEX(32), op: 'add', actor, args: { pk: M.pk }, ts: Date.now() };
    return { c, s: Buffer.from(sign(Buffer.from(G.GSTATE_DOMAIN + G.commitBody(c)))).toString('base64') };
  };
  const randKey = () => new Uint8Array(crypto.randomBytes(32));
  const selfSigned = await L.sealLogEntry({ gid, kid: cur.key_id, key: randKey(), commit: fake(M.pk, M.sign) });
  const fromAdmin = await L.sealLogEntry({ gid, kid: cur.key_id, key: randKey(), commit: fake(A.pubkey, M.sign) });
  const garbage = JSON.stringify({ k: cur.key_id, n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(80).toString('base64') });
  const app1 = await M.appendLog(gid, selfSigned);
  const app2 = await M.appendLog(gid, garbage);
  const inj = await adv.groupLog.injectEntry(gid, fromAdmin);
  sc.note(`log: Mallory's appends → ${app1.status}/${app2.status} (any registered account can append to a known gid), operator wrote seq ${inj}`);

  // (b) 群組主題：營運方用 Alice 那一節塞垃圾信封與明文的舊型別
  adv.broker.inject(`mist/group/${tid}/${toUrl(A.pubkey)}`, msg('group_sealed', A.pubkey, { n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(300).toString('base64') }));
  adv.broker.inject(`mist/group/${tid}/${toUrl(A.pubkey)}`, msg('group_member_added', A.pubkey, { groupId: gid, memberPublicKey: M.pk, nickname: 'Mallory', addedBy: A.pubkey }));
  adv.broker.inject(`mist/group/${tid}/${toUrl(A.pubkey)}`, msg('group_invite', A.pubkey, { groupId: gid, members: [M.pk] }));

  // (c) 邀請：Mallory 自己建一個真的群（genesis 列了 Carol、Dave），封真的邀請 —— 自己的名義送、營運方改成「Alice 寄的」送
  const gkey = randKey();
  const gkid = crypto.randomBytes(16).toString('base64url');
  const gen = await G.createGenesis({ creator: M.pk, sign: M.sign, name: 'Mallory Club', members: [C.pubkey, D.pubkey], key: gkey, kid: gkid, ts: Date.now() });
  adv.leakSecrets.add('Mallory Club');
  const gseq = (await M.appendLog(gen.gid, await L.sealGenesisEntry({ gid: gen.gid, genesis: G.wireOf(gen.commit), kid: gkid, key: gkey }))).body?.seq ?? 1;
  for (const to of [C, D]) {
    const body = { kind: 'invite', gid: gen.gid, chain: [G.wireOf(gen.commit)], kid: gkid, key: Buffer.from(gkey).toString('base64'), headSeq: gseq, baseSeq: gseq };
    const env = await M.seal(to.pubkey, body);
    if (mc.link) await mc.link.publish(M.inboxTopic(to.pubkey), msg('group_key_sealed', M.pk, env, { to: to.pubkey }));
    adv.broker.inject(M.inboxTopic(to.pubkey, A.pubkey), msg('group_key_sealed', A.pubkey, env, { to: to.pubkey }));
    // 營運方也試著把一份「Mallory 的鏈、真的 gid」塞進現有的群（gid 不是這條鏈的 genesis 雜湊 → 驗不過）
    const merge = await M.seal(to.pubkey, { ...body, gid });
    adv.broker.inject(M.inboxTopic(to.pubkey, A.pubkey), msg('group_key_sealed', A.pubkey, merge, { to: to.pubkey }));
  }
  // (c2) 好友 Alice（改過的 App）把 Mallory 那條真的鏈轉成邀請送給 Carol —— 信封驗得過（Alice 的簽章、好友），
  //   鏈本身也驗得過：擋它的是「寫那筆 add 的人不是寄件人」；同一條鏈配上真的 gid → genesis 雜湊對不上
  world.extraGids = new Set([...(world.extraGids ?? []), gen.gid]);
  const c2At = Date.now();
  const relayed = { kind: 'invite', gid: gen.gid, chain: [G.wireOf(gen.commit)], kid: gkid, key: Buffer.from(gkey).toString('base64'), headSeq: gseq, baseSeq: gseq };
  await A.adv('sendSealed', C.pubkey, relayed);
  await A.adv('sendSealed', C.pubkey, { ...relayed, gid });
  // (d) Mallory 要金鑰（自己的名義），營運方冒充被踢的 Bob 要
  for (const to of [A, C, D]) {
    const env = await M.seal(to.pubkey, { kind: 'req', gid, kid: cur.key_id });
    if (mc.link) await mc.link.publish(M.inboxTopic(to.pubkey), msg('group_key_sealed', M.pk, env, { to: to.pubkey }));
    adv.broker.inject(M.inboxTopic(to.pubkey, world.p.B.pubkey), msg('group_key_sealed', world.p.B.pubkey, env, { to: to.pubkey }));
  }
  await syncEveryone(phones, gid);
  await sleep(8_000);

  // ── 檢查 ──
  const afterSnap = await snapAll(phones, gid);
  sc.check('rosters, admins, name, epoch key and head are unchanged on Alice, Carol and Dave', sameSnap(before, afterSnap), diffSnaps(before, afterSnap));
  const logs = await Promise.all([C, D].map((ph) => logState(ph, gid)));
  const lastInjected = Math.max(inj, app1.body?.seq ?? 0, app2.body?.seq ?? 0);
  sc.check('every member processed past the injected entries (skipped, not stuck)', logs.every((s) => Number(s?.processed_seq) >= lastInjected), JSON.stringify(logs));
  const groupsAfter = { C: (await C.q('SELECT COUNT(*) AS n FROM groups'))[0].n, D: (await D.q('SELECT COUNT(*) AS n FROM groups'))[0].n };
  sc.check('Carol and Dave did not join Mallory\'s group or anything else', groupsAfter.C === groupsBefore.C && groupsAfter.D === groupsBefore.D, JSON.stringify({ groupsBefore, groupsAfter }));
  const ev = adv.events();
  const toMallory = ev.filter((e) => e.kind === 'publish' && e.at >= t0 && (e.topic ?? '').startsWith(`mist/user/${toUrl(M.pk)}/inbox/`) && !adv.isAdversary(e.label));
  sc.check('no honest phone ever wrote to Mallory\'s inbox (no sealed reply, no key)', toMallory.length === 0, toMallory.map((e) => `${e.label} → ${e.topic}`).join('\n'));
  const st1 = { C: await stats(C), D: await stats(D) };
  sc.note(`Carol/Dave control drops since S8: bad-envelope ${delta(st0.C, st1.C, 'dropped:bad-envelope')}/${delta(st0.D, st1.D, 'dropped:bad-envelope')}; ${JSON.stringify(st1.D)}`);
  const sealedAtC = (await C.adv('sealedLog')).filter((r) => r.at >= t0 && r.from !== A.pubkey);
  sc.check('no forged invite or key request from Mallory or "Bob" reached Carol\'s engine (stranger → dropped unopened; claimed sender → signature fails)',
    !sealedAtC.some((r) => r.kind === 'invite' || r.kind === 'req'), JSON.stringify(sealedAtC));
  const rejectedAtC = await waitFor(async () => {
    const n = (await C.adv('notices')).filter((x) => x.at >= c2At && x.kind === 'invite-rejected');
    return n.some((x) => x.reason === 'sender-is-not-the-adder') ? n : null;
  }, { timeout: 20_000 });
  const reasons = (rejectedAtC ?? (await C.adv('notices')).filter((x) => x.at >= c2At && x.kind === 'invite-rejected')).map((x) => x.reason);
  sc.check('Alice relaying Mallory\'s valid chain: rejected because the adder is not the sender', reasons.includes('sender-is-not-the-adder'), JSON.stringify(reasons));
  // 同一條鏈配上 Carol 已經在的群的 gid：引擎當成「可能是被踢又加回來」先停著（不驗、不動群），之後 resume 時驗 → gid 對不上就丟
  const parked = (await C.q("SELECT COUNT(*) AS n FROM group_pending_commits WHERE gid = ? AND id = 'join'", [gid]))[0]?.n;
  sc.note(`relay under the real gid: parked join rows for the group ${parked} (the group itself is unchanged — see the roster check)`);
  const malloryGot = mc.link ? mc.link.receivedOn(`mist/group/${tid}/${toUrl(A.pubkey)}`).length : 0;
  sc.note(`Mallory received ${mc.link?.received.length ?? 0} message(s) on the current tid (opaque {n, c}; ${malloryGot} under Alice's suffix incl. the operator's own)`);
  mc.link?.disconnect();
  world.s8 = { selfSigned, fromAdmin, garbage, malloryGid: gen.gid };
  return sc;
}

// ───────────── S9：重放 ─────────────

export async function S9(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S9', 'Replay: captured S2/S3 log entries re-appended, old invites, old group_sealed (removal notice, here, commit, call) and old call signals re-injected — no effect; Bob is not re-added');
  const { A, B, C, D } = world.p;
  const adv = world.adv;
  const gid = gidOf(world);
  const phones = [A, C, D];
  const before = await snapAll(phones, gid);
  const t0 = Date.now();
  const st0 = { A: await stats(A), C: await stats(C), D: await stats(D) };
  // (a) log：S2 的踢人、S3 的加人（照原樣的 blob）由 Mallory 再 append 一次
  const s2 = adv.groupLog.appended.filter((e) => e.gid === gid && e.at >= (world.s2?.kickAt ?? 0) && e.who === 'Alice').slice(0, 3);
  const replayedSeqs = [];
  for (const e of s2) replayedSeqs.push((await adv.mallory.appendLog(gid, e.blob)).body?.seq);
  // (b) 收件箱：A 在 S1 寄給 B、在 S3 寄給 D 的每一封身分信封（裡面有邀請；也有 presence 的 share）照原樣重放
  const ev = adv.events();
  const inboxOf = (to, from) => ev.filter((e) => e.kind === 'publish' && e.label === from.name && e.topic === `mist/user/${toUrl(to.pubkey)}/inbox/${toUrl(from.pubkey)}`
    && e.payload?.includes('"group_key_sealed"'));
  const old = [...inboxOf(B, A), ...inboxOf(D, A), ...inboxOf(C, A)].filter((e) => e.at < t0);
  for (const e of old) adv.broker.inject(e.topic, e.payload);
  // (c) 群組主題：到現在為止誠實手機發過的每一則 group_sealed（踢人通知、here、commit、call）照原樣重放
  const sealed = ev.filter((e) => e.kind === 'publish' && !adv.isAdversary(e.label) && (e.topic ?? '').startsWith('mist/group/') && e.at < t0);
  for (const e of sealed.slice(-80)) adv.broker.inject(e.topic, e.payload, { qos: 1 });
  sc.note(`replayed ${s2.length} log entries (new seqs ${replayedSeqs.join(',')}), ${old.length} sealed inbox envelopes, ${Math.min(80, sealed.length)} group_sealed`);
  // (d) 時間窗內的重放：Alice 剛發的一則 delete（24 小時的窗）照原樣再塞一次 → 只能靠去重表擋（不是過期）
  const delAt = Date.now();
  await A.adv('engineCall', 'sendControl', gid, 'delete', { messageId: `sim-w5-del-${crypto.randomBytes(3).toString('hex')}` });
  const freshPub = await waitFor(async () => adv.events().find((e) => e.kind === 'publish' && e.label === 'Alice' && e.at >= delAt && (e.topic ?? '').startsWith('mist/group/')), { timeout: 10_000 });
  await sleep(2_000);
  const stMid = { C: await stats(C), D: await stats(D) };
  if (freshPub) adv.broker.inject(freshPub.topic, freshPub.payload, { qos: 1 });
  await syncEveryone(phones, gid);
  await sleep(10_000);
  const stEnd = { C: await stats(C), D: await stats(D) };
  const freshReplays = delta(stMid.C, stEnd.C, 'dropped:replay') + delta(stMid.D, stEnd.D, 'dropped:replay');
  sc.check(`a replay inside the freshness window (Alice's delete, seconds old) is dropped as a replay by Carol and Dave (${freshReplays})`, !!freshPub && freshReplays >= 2,
    JSON.stringify({ stMid, stEnd }));
  const afterSnap = await snapAll(phones, gid);
  sc.check('rosters, names, keys and heads unchanged everywhere', sameSnap(before, afterSnap), diffSnaps(before, afterSnap));
  sc.check('Bob is not re-added (no group on his phone)', !(await B.groupIdByName(world.groupName)) && !(await B.q('SELECT id FROM groups WHERE id = ?', [gid])).length);
  const calls = (await C.adv('callLog')).filter((r) => r.at >= t0 && r.what === 'incoming');
  sc.check('the replayed call start / offer rings nobody', calls.length === 0, JSON.stringify(calls));
  const st1 = { A: await stats(A), C: await stats(C), D: await stats(D) };
  const replayDrops = ['A', 'C', 'D'].reduce((n, k) => n + delta(st0[k], st1[k], 'dropped:replay') + delta(st0[k], st1[k], 'dropped:stale')
    + delta(st0[k], st1[k], 'dropped:unknown-topic') + delta(st0[k], st1[k], 'dropped:non-member'), 0);
  const accepted = ['A', 'C', 'D'].reduce((n, k) => n + Object.keys(st1[k]).filter((x) => x.startsWith('opened')).reduce((m, x) => m + delta(st0[k], st1[k], x), 0), 0);
  sc.note(`engines: ${replayDrops} replayed control message(s) dropped (replay/stale/unknown-topic/non-member), ${accepted} opened again (idempotent: a fetch or a re-delete)`);
  sc.check('replayed control messages were dropped by the engines', replayDrops > 0, JSON.stringify({ st0, st1 }), false);
  return sc;
}

// ───────────── S10：成員偽造 ─────────────

export async function S10(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S10', 'Dave (a plain member) signs forged commits with his own key — remove Carol, promote himself, rename, rekey, and an add "by Alice" — rejected by every replica, Dave\'s own included');
  const { A, C, D } = world.p;
  const gid = gidOf(world);
  const phones = [A, C, D];
  const before = await snapAll(phones, gid);
  const results = [];
  const tryForge = async (what, p) => {
    try { results.push([what, await D.adv('forgeCommit', { gid, ...p })]); } catch (e) { results.push([what, `error ${e.message}`]); }
  };
  await tryForge('remove Carol (with a valid key bundle)', { op: 'remove', args: { pk: C.pubkey }, newEpoch: true, notify: true });
  await tryForge('promote himself to admin', { op: 'role', args: { pk: D.pubkey, role: 'admin' } });
  await tryForge('rename', { op: 'info', args: { name: 'Dave rules' } });
  await tryForge('rekey', { op: 'rekey', newEpoch: true });
  await tryForge('add Mallory, signed by Dave but claiming Alice', { op: 'add', args: { pk: world.adv.mallory.pk }, actor: A.pubkey });
  world.adv.leakSecrets.add('Dave rules');
  sc.note(`forged: ${results.map(([w, r]) => `${w} → seq ${r?.seq ?? r}`).join('; ')}`);
  sc.check('all five forged commits were appended (the server cannot tell; replicas must reject them)', results.every(([, r]) => Number.isInteger(r?.seq)), JSON.stringify(results));
  await syncEveryone(phones, gid);
  const lastSeq = Math.max(...results.map(([, r]) => r?.seq ?? 0));
  await waitFor(async () => {
    for (const ph of phones) if (Number((await logState(ph, gid))?.processed_seq) < lastSeq) return false;
    return true;
  }, { timeout: 30_000 });
  const afterSnap = await snapAll(phones, gid);
  sc.check('every replica skipped them: roster still has Carol, Dave is not admin, name and epoch key unchanged (Dave\'s own replica too)', sameSnap(before, afterSnap), diffSnaps(before, afterSnap));
  sc.check('every replica processed past the forged seqs', (await Promise.all(phones.map((ph) => logState(ph, gid)))).every((s) => Number(s?.processed_seq) >= lastSeq));
  const v = await C.adv('groupView', gid);
  sc.check("Carol still sees herself in the group", v?.members?.some((m) => m.publicKey === C.pubkey));
  return sc;
}

// ───────────── S11：C 離線超過 broker 的 session ─────────────

export async function S11(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S11', 'Carol is offline longer than the broker keeps her session while Alice removes Dave and renames; Carol converges from the log alone; Alice then re-adds Dave (re-add rotates the key)');
  const { A, C, D } = world.p;
  const adv = world.adv;
  const gid = gidOf(world);
  const G = world.groupName;
  await C.closeApp();
  const expired1 = adv.broker.expireSession('Carol');
  await A.kick(G, D.pubkey);
  const dGone = await waitFor(async () => !(await D.groupIdByName(G)), { timeout: 30_000 });
  sc.check('Dave sees he was removed', !!dGone, '', false);
  const renamed = 'SimGroup S11';
  adv.leakSecrets.add(renamed);
  sc.check('Alice renames while Carol is away', okProp(await A.adv('engineCall', 'updateInfo', gid, { name: renamed }).catch((e) => e.message)));
  await sleep(3_000);
  const expired2 = adv.broker.expireSession('Carol');
  sc.note(`Carol's broker session expired twice (before: ${expired1}, after the changes: ${expired2}) — every queued notice is gone`);
  const backAt = Date.now();
  await C.reopenApp();
  const want = await snap(A, gid);
  const conv = await waitFor(async () => {
    const s = await snap(C, gid);
    return s && sameSnap(s, want) ? s : null;
  }, { timeout: 60_000, interval: 1_000 });
  sc.check(`Carol converges from the log: roster without Dave, the new name, Alice's epoch key and head (${Math.round((Date.now() - backAt) / 1000)}s)`, !!conv,
    `Carol ${JSON.stringify(await snap(C, gid))}\nAlice ${JSON.stringify(want)}`);
  world.groupName = renamed;
  const a1 = await send(sc, A, renamed, 'after-carol-converged');
  await expectSeen(world, sc, A, C, renamed, a1.text, a1.since);
  const c1 = await send(sc, C, renamed, 'after-carol-converged');
  await expectSeen(world, sc, C, A, renamed, c1.text, c1.since);
  // 加回 Dave（曾經在群裡：那一筆 add 本身換金鑰、邀請附上一代的只讀 log 金鑰）
  await A.addMember(renamed, 'Dave');
  const dBack = await waitFor(async () => {
    const s = await snap(D, gid);
    return s && sameSnap(s, await snap(A, gid)) ? s : null;
  }, { timeout: 60_000, interval: 1_000 });
  sc.check('Dave is re-added and holds the same roster, name and new epoch key as Alice', !!dBack, `Dave ${JSON.stringify(await snap(D, gid))}\nAlice ${JSON.stringify(await snap(A, gid))}`);
  const cSees = await waitFor(async () => sameSnap(await snap(C, gid), await snap(A, gid)), { timeout: 30_000 });
  sc.check('Carol follows the re-add', !!cSees, JSON.stringify(await snap(C, gid)));
  const d1 = await send(sc, D, renamed, 'back-after-readd');
  await expectSeen(world, sc, D, C, renamed, d1.text, d1.since);
  await expectSeen(world, sc, D, A, renamed, d1.text, d1.since);
  // 名字改回來（後面的情境照原名找群）
  await A.adv('engineCall', 'updateInfo', gid, { name: 'SimGroup' });
  world.groupName = 'SimGroup';
  await waitFor(async () => (await C.groupIdByName('SimGroup')) && (await D.groupIdByName('SimGroup')), { timeout: 30_000 });
  return sc;
}

// ───────────── S12：伺服器給不同的人看不同的 log ─────────────

export async function S12(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S12', 'Server equivocation: Carol\'s rename is served to Dave as a different entry at the same seq — Dave detects it through head gossip (conflict state in the UI), recovers once the honest log is served');
  const { C, D } = world.p;
  const adv = world.adv;
  const gid = gidOf(world);
  const honest = await adv.groupLog.read(gid, 0);
  const seq = honest.head + 1;
  const genesisBlob = (await adv.groupLog.read(gid, 0)).entries.find((e) => e.seq === Math.min(...honest.entries.map((x) => x.seq)))?.blob;
  const rule = adv.groupLog.malice.equivocate({ gid, victim: 'Dave', seq, blob: genesisBlob });
  const renamed = 'SimGroup S12';
  adv.leakSecrets.add(renamed);
  const dBefore = await snap(D, gid);
  const r = await C.adv('engineCall', 'updateInfo', gid, { name: renamed }).catch((e) => e.message);
  sc.check(`Carol (admin since S4) renames; the server puts it at seq ${seq}`, okProp(r), String(r));
  // Dave 抓到那一號（被換成別的、跳過）之後，Carol 說一句話：群訊的明文帶她的 head (seq, id) —— 同一號、Dave 跳過了她套上的 → conflict
  await waitFor(async () => Number((await logState(D, gid))?.processed_seq) >= seq, { timeout: 20_000 });
  const c0 = await send(sc, C, renamed, 'gossip-after-rename');
  await expectSeen(world, sc, C, D, dBefore?.name ?? world.groupName, c0.text, c0.since);
  const conflict = await waitFor(async () => (await D.adv('groupView', gid))?.logConflict === true, { timeout: 40_000 });
  sc.check("Dave's group shows the log-conflict warning (head gossip: same seq, different entry)", !!conflict, JSON.stringify(await D.adv('groupView', gid)));
  await D.openGroup(dBefore?.name ?? world.groupName).catch(() => {});
  const onScreen = await waitFor(async () => D.page.getByText(D.t('group.logConflict'), { exact: false }).first().isVisible().catch(() => false), { timeout: 10_000 });
  sc.check("…and the warning is on Dave's group screen", !!onScreen, `text "${D.t('group.logConflict')}"`);
  const dMid = await snap(D, gid);
  sc.check('…and Dave did not adopt anything from the forged view (name, roster, key unchanged)', dMid?.name === dBefore?.name && sameSnap({ ...dMid, headId: 0, headV: 0 }, { ...dBefore, headId: 0, headV: 0 }),
    `${JSON.stringify(dBefore)} → ${JSON.stringify(dMid)}`);
  sc.note(`malicious server served Dave the replaced entry ${adv.groupLog.malice.hits(rule)} time(s)`);
  // 恢復誠實；Dave 一分鐘最多重建一次 → 等過那一分鐘，Carol 再說一句話（群訊的明文帶 head）
  adv.groupLog.malice.clear(rule);
  await sleep(62_000);
  const c1 = await send(sc, C, renamed, 'after-equivocation');
  await expectSeen(world, sc, C, D, dBefore?.name ?? world.groupName, c1.text, c1.since);
  const healed = await waitFor(async () => {
    const s = await snap(D, gid);
    const v = await D.adv('groupView', gid);
    return s?.name === renamed && !v?.logConflict && sameSnap(s, await snap(C, gid)) ? s : null;
  }, { timeout: 90_000, interval: 1_500 });
  sc.check('after the honest log is served Dave rebuilds: same chain as Carol (new name), the warning clears', !!healed,
    `Dave ${JSON.stringify(await snap(D, gid))} view ${JSON.stringify(await D.adv('groupView', gid))}\nCarol ${JSON.stringify(await snap(C, gid))}`);

  // 第二種：伺服器不換、只扣 —— Dave 看到的 log 停在 Carol 下一筆之前（head 也跟著說謊）。交叉比對永遠是「我落後」，
  //   抓完了伺服器還是說沒有更新的 → Dave 照樣要顯示警告（W5：以前不會，扣著的 log 完全看不出來）
  const head2 = (await adv.groupLog.read(gid, 0)).head;
  const wrule = adv.groupLog.malice.withhold({ gid, victim: 'Dave', fromSeq: head2 + 1 });
  const w0 = Date.now();
  const r2 = await C.adv('engineCall', 'updateInfo', gid, { name: 'SimGroup' }).catch((e) => e.message);
  sc.check(`Carol renames back (seq ${head2 + 1}); the server withholds it from Dave`, okProp(r2), String(r2));
  const c2 = await send(sc, C, 'SimGroup', 'gossip-while-withheld');
  await expectSeen(world, sc, C, D, renamed, c2.text, c2.since);
  const flagged = await waitFor(async () => (await D.adv('groupView', gid))?.logConflict === true, { timeout: 40_000 });
  const dNotes = (await D.adv('notices')).filter((n) => n.at >= w0 && n.kind === 'conflict').map((n) => n.reason);
  sc.check('Dave flags the withholding (a member reports a later head, the server says there is nothing newer)', !!flagged && dNotes.includes('server-behind-peer'),
    `view ${JSON.stringify(await D.adv('groupView', gid))} notices ${JSON.stringify(dNotes)}`);
  sc.check('…while he still shows the old name (nothing was forged into his chain)', (await snap(D, gid))?.name === renamed, JSON.stringify(await snap(D, gid)));
  sc.note(`withheld log served to Dave ${adv.groupLog.malice.hits(wrule)} time(s)`);
  adv.groupLog.malice.clear(wrule);
  const c3 = await send(sc, C, 'SimGroup', 'after-withholding');
  await expectSeen(world, sc, C, D, renamed, c3.text, c3.since);
  const caught = await waitFor(async () => (await snap(D, gid))?.name === 'SimGroup' && !(await D.adv('groupView', gid))?.logConflict, { timeout: 60_000, interval: 1_500 });
  sc.check('once the server stops withholding Dave catches up and the warning clears', !!caught, `view ${JSON.stringify(await D.adv('groupView', gid))}`);
  await waitFor(async () => (await D.groupIdByName('SimGroup')) && (await C.groupIdByName('SimGroup')), { timeout: 30_000 });
  return sc;
}

// ───────────── S13：扣下換金鑰的那一份 ─────────────

export async function S13(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S13', 'Withheld rekey bundle: a broken admin client (Carol) rotates the key leaving Dave out of the bundle and the operator withholds Carol\'s key replies — Dave waits for the key, never falls back to the old one, recovers when the reply gets through');
  const { C, D } = world.p;
  const adv = world.adv;
  const gid = gidOf(world);
  const oldKid = (await activeRow(D, gid))?.key_id;
  let letThrough = false;   // 只放一封壞掉的金鑰回覆過去（見下面）
  const wid = adv.broker.withhold(({ topic }) => !letThrough && topic === `mist/user/${toUrl(D.pubkey)}/inbox/${toUrl(C.pubkey)}`);
  const t0 = Date.now();
  const forged = await C.adv('forgeCommit', { gid, op: 'rekey', newEpoch: true, skip: [D.pubkey], notify: true }).catch((e) => ({ error: e.message }));
  sc.check('Carol\'s rekey without Dave\'s copy is appended', Number.isInteger(forged?.seq), JSON.stringify(forged));
  const waiting = await waitFor(async () => (await D.adv('groupView', gid))?.keyState === 'waiting-key', { timeout: 30_000 });
  sc.check('Dave applies the rekey and shows "waiting for key"', !!waiting, JSON.stringify(await D.adv('groupView', gid)));
  await D.openGroup(world.groupName).catch(() => {});
  const waitShown = await waitFor(async () => D.page.getByText(D.t('group.keyWaiting'), { exact: false }).first().isVisible().catch(() => false), { timeout: 10_000 });
  sc.check("…on Dave's group screen too", !!waitShown, `text "${D.t('group.keyWaiting')}"`);
  // forgeCommit 繞過 Carol 自己的引擎直接寫進 log（壞掉的客戶端）：她的引擎要等一次同步才套上（run 3：輪詢／別人的 head 帶動花了 23 秒）
  await C.adv('engineCall', 'requestSync', gid).catch(() => {});
  const cNew = await waitFor(async () => { const k = await activeRow(C, gid); return k && k.key_id !== oldKid ? k : null; }, { timeout: 60_000 });
  sc.check('Carol is on the new epoch', !!cNew);
  const sk = await D.adv('engineCall', 'sendingKey', gid);
  sc.check('Dave has no sending key (never the previous epoch\'s)', sk === null, JSON.stringify(sk));
  // 壞掉的 admin 再送一把錯的金鑰（kid 對、內容不對）：kc 核對不過 → 不收，照樣等
  letThrough = true;
  await C.adv('sendSealed', D.pubkey, { kind: 'dist', gid, kid: forged.kid, key: crypto.randomBytes(32).toString('base64') }).catch((e) => sc.note(`bad dist: ${e.message}`));
  await sleep(3_000);
  letThrough = false;
  const badKeyRows = (await D.q('SELECT COUNT(*) AS n FROM group_keys WHERE group_id = ? AND key_id = ?', [gid, forged.kid]))[0]?.n;
  sc.check('a wrong key for the new epoch (kc mismatch) is refused: Dave still waits, no key stored for that kid',
    Number(badKeyRows) === 0 && (await D.adv('groupView', gid))?.keyState === 'waiting-key', `rows ${badKeyRows} view ${JSON.stringify(await D.adv('groupView', gid))}`);
  const pending = await send(sc, D, world.groupName, 'while-waiting-for-key');
  await sleep(8_000);
  const leaked = (await C.q('SELECT id FROM messages WHERE content = ?', [pending.text])).length;
  sc.check("Dave's message written while waiting does not reach Carol (nothing goes out under the old key)", leaked === 0, `found ${leaked}`);
  const mine = await D.q('SELECT status FROM messages WHERE content = ?', [pending.text]);
  sc.check('…it is marked unsent on Dave\'s phone (the user resends it once the key is there; never under the old key)', mine.length > 0 && mine.every((m) => m.status === 'failed'),
    JSON.stringify(mine));
  // 開源第 4 步：畫面上那則泡泡也標著「未送出」（以前看起來跟送出去的一樣）
  const bubbleOf = () => D.page.locator('[data-send-status="failed"]', { hasText: D.t('group.notSent') });
  await D.openGroup(world.groupName).catch(() => {});
  const marked = await waitFor(async () => (await bubbleOf().count().catch(() => 0)) > 0, { timeout: 10_000 });
  sc.check('…and Dave\'s bubble shows "not sent" with a retry button', !!marked && await bubbleOf().locator('button').first().isVisible().catch(() => false),
    `text "${D.t('group.notSent')}"`);
  const dPubs = adv.events().filter((e) => e.kind === 'publish' && e.label === 'Dave' && e.at >= t0 && (e.topic ?? '').startsWith('mist/group/'));
  sc.check('Dave publishes nothing on any group topic while he waits', dPubs.length === 0, dPubs.map((e) => e.topic).join('\n'));
  // 營運方扣著 Carol 回給 Dave 的金鑰（run 1：Dave 第一次要的時候 Carol 還沒套上換金鑰，30 秒後的第二次落在放行之後 →
  //   這條規則一則都沒扣到）：等過 Dave 的 30 秒（同一把每 30 秒最多問一次）、讓他再要一次，Carol 的回覆被扣下 → 他照樣等
  const withheldOf = () => adv.events().filter((e) => e.kind === 'withheld' && e.at >= t0 && e.label === 'Dave' && !e.will).length;
  await sleep(31_000);
  await D.adv('engineCall', 'requestSync', gid).catch(() => {});
  const withheld = await waitFor(async () => withheldOf() || null, { timeout: 45_000, interval: 1_000 });
  sc.check("the operator withheld Carol's key reply when Dave asked again — and Dave still waits (no old key)",
    !!withheld && (await D.adv('groupView', gid))?.keyState === 'waiting-key' && (await D.adv('engineCall', 'sendingKey', gid)) === null,
    `withheld ${withheldOf()} view ${JSON.stringify(await D.adv('groupView', gid))}`);
  sc.note(`operator withheld ${withheldOf()} message(s) from Carol to Dave (the key reply)`);
  // 放行：Dave 30 秒後再要一次（同一把每 30 秒最多問一次）
  adv.broker.release(wid);
  await sleep(31_000);
  await D.adv('engineCall', 'requestSync', gid).catch(() => {});
  const got = await waitFor(async () => {
    const v = await D.adv('groupView', gid);
    const k = await activeRow(D, gid);
    return v?.keyState === 'ok' && k?.key_id === cNew?.key_id ? k : null;
  }, { timeout: 90_000, interval: 1_500 });
  sc.check('once the reply gets through Dave holds the new key (kc-checked) and leaves the waiting state', !!got, JSON.stringify(await D.adv('groupView', gid)));
  const d2 = await send(sc, D, world.groupName, 'after-key-arrived');
  await expectSeen(world, sc, D, C, world.groupName, d2.text, d2.since);
  // 開源第 4 步：金鑰到了 → 按那則泡泡的「重送」→ 用新的一代送出去，Carol 收到；泡泡上的「未送出」拿掉
  await D.openGroup(world.groupName).catch(() => {});
  const retryAt = Date.now();
  await bubbleOf().locator('button').first().click({ timeout: 10_000 }).catch((e) => sc.note(`retry click: ${e.message}`));
  await expectSeen(world, sc, D, C, world.groupName, pending.text, retryAt);
  const cleared = await waitFor(async () => (await bubbleOf().count().catch(() => 1)) === 0, { timeout: 10_000 });
  const stored = await D.q('SELECT status FROM messages WHERE content = ?', [pending.text]);
  sc.check('after the retry the bubble is no longer marked and the row is "sent"', !!cleared && stored.every((m) => m.status === 'sent'), JSON.stringify(stored));
  return sc;
}

// ───────────── S14：灌邀請、群組主題上的明文舊型別 ─────────────

export async function S14(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('S14', 'Floods: a friend floods Carol with invites, Mallory floods invites, plaintext legacy group types and garbage group_sealed on group topics — ignored and rate-limited; the group keeps working');
  const { A, C, D } = world.p;
  const adv = world.adv;
  const M = adv.mallory;
  const gid = gidOf(world);
  const before = await snapAll([C, D], gid);
  const tid = await tidOf(world, C, gid);
  const t0 = Date.now();
  const st0 = { C: await stats(C), D: await stats(D) };
  // (a) 好友 A（不在這個群了）灌 30 份格式正確的假邀請（亂數 gid）
  const fakeGids = [];
  for (let i = 0; i < 30; i++) {
    const g = crypto.randomBytes(16).toString('base64url').slice(0, 22);
    fakeGids.push(g);
    await A.adv('sendSealed', C.pubkey, { kind: 'invite', gid: g, chain: [{ c: {}, s: '' }], kid: crypto.randomBytes(16).toString('base64url'),
      key: crypto.randomBytes(32).toString('base64'), headSeq: 5, baseSeq: 1 }).catch(() => {});
  }
  // (b) Mallory 灌 50 份（陌生人）
  const mc = await M.connect({ groups: [tid] });
  for (let i = 0; i < 50 && mc.link; i++) {
    const env = await M.seal(C.pubkey, { kind: 'invite', gid: crypto.randomBytes(16).toString('base64url').slice(0, 22), chain: [{ c: {}, s: '' }],
      kid: 'k', key: crypto.randomBytes(32).toString('base64'), headSeq: 1, baseSeq: 1 });
    await mc.link.publish(M.inboxTopic(C.pubkey), msg('group_key_sealed', M.pk, env, { to: C.pubkey }), { qos: 0 });
  }
  // (c) 群組主題：Mallory 自己那一節的明文舊型別與垃圾；營運方用 Carol 那一節灌 300 則垃圾 group_sealed
  const legacy = ['group_member_added', 'group_member_removed', 'group_info_updated', 'group_role_updated', 'group_invite', 'group_key_message', 'presence', 'delete_message'];
  for (const type of legacy) {
    if (mc.link) await mc.link.publish(M.groupTopic(tid), msg(type, M.pk, { groupId: gid, memberPublicKey: M.pk, name: 'pwned' }));
    adv.broker.inject(`mist/group/${tid}/${toUrl(C.pubkey)}`, msg(type, C.pubkey, { groupId: gid, memberPublicKey: M.pk, name: 'pwned' }));
  }
  for (let i = 0; i < 300; i++) {
    adv.broker.inject(`mist/group/${tid}/${toUrl(C.pubkey)}`, msg('group_sealed', C.pubkey, { n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(200).toString('base64') }), { qos: 0 });
    if (mc.link && i < 300) await mc.link.publish(M.groupTopic(tid), msg('group_sealed', M.pk, { n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(200).toString('base64') }), { qos: 0 });
  }
  adv.leakSecrets.add('pwned');
  const floodSecs = (Date.now() - t0) / 1000;
  await sleep(15_000);
  // ── 檢查 ──
  const afterSnap = await snapAll([C, D], gid);
  sc.check('Carol and Dave: roster, name, key, head unchanged', sameSnap(before, afterSnap), diffSnaps(before, afterSnap));
  const joins = (await C.q("SELECT COUNT(*) AS n FROM group_pending_commits WHERE id = 'join'"))[0].n;
  sc.check(`Carol keeps at most 3 invites per sender waiting (${joins} stored)`, Number(joins) <= 3, String(joins));
  const verified = adv.groupLog.fetched.filter((f) => f.who === 'Carol' && fakeGids.includes(f.gid) && f.at >= t0);
  sc.check(`Carol looked at most a handful of the 30 flooded invites (invite budget 2/min per sender): ${verified.length} log probe(s)`, verified.length <= 4, String(verified.length));
  const mal = (await C.adv('sealedLog')).filter((r) => r.at >= t0 && r.from === M.pk);
  sc.check("none of Mallory's invites reached Carol's engine (stranger → dropped unopened)", mal.length === 0, JSON.stringify(mal.slice(0, 3)));
  const st1 = { C: await stats(C), D: await stats(D) };
  const dec = delta(st0.D, st1.D, 'decrypt');
  const bound = 120 + Math.ceil(2 * (floodSecs + 16)) + 10;
  sc.check(`Dave decrypted at most the per-sender budget of the 300 forged envelopes under Carol's suffix (${dec} ≤ ${bound})`, dec <= bound, JSON.stringify({ st0: st0.D, st1: st1.D }));
  sc.note(`Dave: dropped bad-envelope +${delta(st0.D, st1.D, 'dropped:bad-envelope')}, non-member +${delta(st0.D, st1.D, 'dropped:non-member')}, received +${delta(st0.D, st1.D, 'received')} (the rest stopped at the App budget or the type check)`);
  const c1 = await send(sc, C, world.groupName, 'after-the-floods');
  await expectSeen(world, sc, C, D, world.groupName, c1.text, c1.since);
  mc.link?.disconnect();
  return sc;
}

// ───────────── P1：presence（W4 的攻擊 ＋ 刪好友／封鎖換秘密） ─────────────

/** 每支手機現在把誰當好友、秘密給誰（好友減封鎖）：PRESENCE 稽核的時間軸 */
export async function friendshipSnapshot(world) {
  // 關著的手機照上一份（P1 的 Dave 斷網、關著的時候：他的好友名單沒變）
  const prev = world.adv?.friendsTimeline?.at(-1)?.shares;
  const shares = new Map();
  for (const ph of Object.values(world.p)) {
    if (!ph.page) { if (prev?.has(ph.name)) shares.set(ph.name, prev.get(ph.name)); continue; }
    const contacts = new Set((await ph.friends().catch(() => [])).map((f) => f.pubkey));
    const blocked = new Set((await ph.q('SELECT pubkey FROM local_user_blacklist').catch(() => [])).map((r) => r.pubkey));
    shares.set(ph.name, new Set(Object.values(world.p).filter((o) => contacts.has(o.pubkey) && !blocked.has(o.pubkey)).map((o) => o.name)));
  }
  return shares;
}

const onlineOf = (ph, other) => ph.isFriendOnline(other.pubkey);

export async function P1(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('P1', 'Presence: request floods, a withheld will (≤ 10 min), A unfriends B then blocks C (two rotations), forged and replayed states, guessed tags, a friend offline beyond his broker session gets the new secret through the silent-topic request');
  const { A, B, C, D } = world.p;
  const adv = world.adv;
  const M = adv.mallory;
  const H73 = 73 * 3600 * 1000;
  const presTopicOf = (ph) => `mist/user/${toUrl(ph.pubkey)}/presence/`;
  // A、B 在 S6 被關掉了：照撥過的時鐘重開
  if (!A.page) await A.timeTravel(H73);
  if (!B.page) await B.timeTravel(H73);
  const allOnline = await waitFor(async () => (await onlineOf(A, B)) && (await onlineOf(A, C)) && (await onlineOf(A, D)) && (await onlineOf(D, A)) && (await onlineOf(B, A)) && (await onlineOf(C, A)),
    { timeout: 120_000, interval: 2_000 });
  sc.check('after reopening, every friend pair sees each other online', !!allOnline,
    JSON.stringify({ AB: await onlineOf(A, B), AC: await onlineOf(A, C), AD: await onlineOf(A, D), BA: await onlineOf(B, A), CA: await onlineOf(C, A), DA: await onlineOf(D, A) }));

  // ── 1. request 灌爆：同群組的非好友（Dave → Carol）一則都不回；好友（Dave → Alice）每分鐘最多回一則；陌生人（Mallory）不拆 ──
  const s0 = { A: await A.presenceStats(), C: await C.presenceStats() };
  const f0 = Date.now();
  for (let i = 0; i < 20; i++) await D.adv('sendSealed', C.pubkey, { kind: 'presence', have: 0 }).catch(() => {});
  for (let i = 0; i < 20; i++) await D.adv('sendSealed', A.pubkey, { kind: 'presence', have: 0 }).catch(() => {});
  const mc = await M.connect({});
  for (let i = 0; i < 20 && mc.link; i++) {
    await mc.link.publish(M.inboxTopic(A.pubkey), msg('group_key_sealed', M.pk, await M.seal(A.pubkey, { kind: 'presence', have: 0 }), { to: A.pubkey }), { qos: 0 });
  }
  await sleep(8_000);
  const s1 = { A: await A.presenceStats(), C: await C.presenceStats() };
  const ev1 = adv.events().filter((e) => e.kind === 'publish' && e.at >= f0);
  const cToD = ev1.filter((e) => e.label === 'Carol' && e.topic === `mist/user/${toUrl(D.pubkey)}/inbox/${toUrl(C.pubkey)}`);
  const aToD = ev1.filter((e) => e.label === 'Alice' && e.topic === `mist/user/${toUrl(D.pubkey)}/inbox/${toUrl(A.pubkey)}`);
  const aToM = adv.events().filter((e) => e.kind === 'publish' && e.at >= f0 && (e.topic ?? '').startsWith(`mist/user/${toUrl(M.pk)}/inbox/`) && !adv.isAdversary(e.label));
  sc.check('a fellow member who is not a friend (Dave → Carol, 20 requests) is never answered', cToD.length === 0 && delta(s0.C, s1.C, 'svc.not-a-friend') >= 15,
    `Carol → Dave publishes ${cToD.length}, not-a-friend +${delta(s0.C, s1.C, 'svc.not-a-friend')}`);
  sc.check('a friend\'s request flood (Dave → Alice, 20) is answered at most once a minute', aToD.length <= 2 && delta(s0.A, s1.A, 'svc.request-rate-limited') >= 15,
    `Alice → Dave publishes ${aToD.length}, rate-limited +${delta(s0.A, s1.A, 'svc.request-rate-limited')}`);
  sc.check('Mallory\'s requests are never answered', aToM.length === 0, aToM.map((e) => e.topic).join('\n'));
  mc.link?.disconnect();

  // ── 2. 擋掉 Dave 的遺囑、讓他斷網 → Alice 最多 10 分鐘後當他離線（推播照發） ──
  const lastState = await A.adv('presenceStateOf', D.pubkey);
  const wid = adv.broker.withhold(({ will, from }) => !!will && from === 'Dave');
  adv.broker.refuseConnect('Dave', true);
  const dropAt = Date.now();
  adv.broker.dropClientsWhere((s) => s.label === 'Dave');
  await D.closeApp();
  const willWithheld = adv.events().some((e) => e.kind === 'withheld' && e.label === 'Dave' && e.at >= dropAt);
  const stillOnline = await onlineOf(A, D);
  sc.check('Dave\'s will was really withheld by the operator, and right after he vanished Alice still believes he is online', willWithheld && stillOnline === true,
    `withheld will ${willWithheld}, Alice sees him online ${stillOnline}`);
  sc.note(`Dave vanished (network down, will withheld); Alice's last state of him: ${JSON.stringify(lastState)}`);

  // ── 3. 換秘密兩次：A 刪掉 B（一次）、再封鎖 C（一次）—— 每次都先清掉舊主題、才用新的 tag ──
  const rotateBy = async (what, act) => {
    const tagBefore = await A.adv('presenceTag');
    const oldTopic = `${presTopicOf(A)}${tagBefore}`;
    const at = Date.now();
    await act();
    const tag = await waitFor(async () => { const t = await A.adv('presenceTag'); return t && t !== tagBefore ? t : null; }, { timeout: 60_000 });
    const clear = adv.events().find((e) => e.kind === 'publish' && e.label === 'Alice' && e.topic === oldTopic && e.at >= at && (e.payload ?? '').length === 0);
    sc.check(`${what}: Alice's old topic is cleared (empty retained) before the new tag is used`, !!tag && !!clear, `new tag ${tag}, clear ${!!clear}`);
    const between = adv.events().filter((e) => (e.kind === 'publish' || e.kind === 'will') && e.label === 'Alice' && e.topic === oldTopic && e.at >= at
      && (e.payload ?? '').length > 0);
    sc.check(`${what}: nothing but the clear is published on the old topic once the change is made (no online, refresh or will)`, between.length === 0,
      between.map((e) => `${e.kind} at +${e.at - at}ms`).join('\n'));
    sc.check(`${what}: the cleared old topic keeps no retained state`, !adv.broker.retained.has(oldTopic));
    world.adv.friendsTimeline.push({ at, shares: await friendshipSnapshot(world) });
    return { at, tag, oldTopic, clearAt: clear?.at ?? Date.now() };
  };
  const r1 = await rotateBy('unfriend B', () => A.adv('unfriend', B.pubkey));
  const bSvc0 = await B.presenceStats();   // B 在他那一次清掉之後的計數（之後一則都不該拆開）
  const r2 = await rotateBy('block C', () => A.adv('block', C.pubkey));
  const cSvc0 = await C.presenceStats();
  const expired = adv.broker.expireSession('Dave');
  sc.check(`Dave's broker session really expired (${expired}): the new-secret shares queued for him are gone`, expired >= 1);

  // ── 4. 等 Dave 的「在線」過期（遺囑被擋：TTL 10 分鐘）的時候做別的攻擊 ──
  //   (a) Mallory 猜 tag：訂得到（伺服器給確切的主題）但什麼都沒有；訂 Alice 清掉的舊主題：空的
  const guesses = [randomTid(), randomTid(), randomTid()].map((t) => `${presTopicOf(A)}${t}`);
  const mp = await M.connect({ presence: [...guesses, r1.oldTopic, r2.oldTopic] });
  const gSub = mp.link ? await mp.link.subscribe([...guesses, r1.oldTopic, r2.oldTopic]) : [];
  //   (b) B、C 跟 Alice 要新的秘密：已經不是能給的人 → 不回
  const aStat0 = await A.presenceStats();
  const reqAt = Date.now();
  await B.adv('sendSealed', A.pubkey, { kind: 'presence', have: 0 }).catch(() => {});
  await C.adv('sendSealed', A.pubkey, { kind: 'presence', have: 0 }).catch(() => {});
  //   (c) 營運方在 Dave 目前的主題上塞一則自己編的密文，並重放 Dave 以前發過的狀態（Alice 訂著那個主題）
  const dPubs = adv.events().filter((e) => (e.kind === 'publish' || e.kind === 'will') && e.label === 'Dave' && (e.topic ?? '').startsWith(presTopicOf(D)) && (e.payload ?? '').length > 0);
  const dTopic = dPubs.at(-1)?.topic ?? null;
  let injectedOpenFail = 0;
  if (dTopic) {
    adv.broker.inject(dTopic, JSON.stringify({ n: crypto.randomBytes(12).toString('base64'), c: crypto.randomBytes(40).toString('base64') }), { qos: 1 });
    injectedOpenFail++;
    for (const e of dPubs.slice(-4)) adv.broker.inject(e.topic, e.payload, { qos: 1 });
  }
  const prevExpect = adv.expectOpenFailed.get('Alice');
  sc.note(`operator: 1 crafted ciphertext + ${Math.min(4, dPubs.length)} replayed state(s) of Dave on ${dTopic ? dTopic.slice(-22, -16) + '…' : 'none'}`);
  await sleep(6_000);
  const gotGuess = mp.link ? mp.link.received.filter((r) => r.payload.length > 0).length : 0;
  sc.check(`Mallory's guessed tags and Alice's cleared old topics deliver nothing (SUBACK ${JSON.stringify(gSub)})`, gotGuess === 0, `${gotGuess} non-empty delivered`);
  const aStat1 = await A.presenceStats();
  const toEx = adv.events().filter((e) => e.kind === 'publish' && e.label === 'Alice' && e.at >= reqAt
    && [B, C].some((x) => e.topic === `mist/user/${toUrl(x.pubkey)}/inbox/${toUrl(A.pubkey)}`) && e.payload?.includes('group_key_sealed'));
  sc.check('Alice ignores the ex-friend\'s and the blocked friend\'s secret requests (nothing sealed back to them)', toEx.length === 0,
    `sealed to B/C ${toEx.length}`);
  sc.note(`Alice: not-a-friend +${delta(aStat0, aStat1, 'svc.not-a-friend')} (an ex-friend who is no fellow member and a blocked sender are dropped before the presence service even opens them)`);
  const openFailed = delta(aStat0, aStat1, 'svc.open-failed');
  sc.check(`the crafted ciphertext on Dave's topic does not open for Alice (open-failed +${openFailed}, injected ${injectedOpenFail})`, openFailed === injectedOpenFail && injectedOpenFail === 1);
  // PRESENCE 稽核只扣掉「看到的」那幾則（不是預期的）：一則真的拆不開的不會被抵掉（審查 W5 M4e）
  adv.expectOpenFailed.set('Alice', { count: (prevExpect?.openSeq === A.openSeq ? prevExpect.count : 0) + Math.min(openFailed, injectedOpenFail), openSeq: A.openSeq });
  // Alice 的「Dave 在線」最晚在他最後那一則的 ts ＋ 10 分鐘消失（App 時鐘 ＝ 模擬時鐘：S6 之後 +73 小時）
  const ttlEnd = (lastState?.ts ?? (dropAt + world.clockOffset())) + 10 * 60_000;
  const wentOff = await waitFor(async () => (await onlineOf(A, D)) === false,
    { timeout: Math.max(5_000, ttlEnd - (Date.now() + world.clockOffset()) + 90_000), interval: 3_000 });
  const offAt = Date.now();
  sc.check(`with the will withheld Alice sees Dave offline within the 10-minute rule (${Math.round((offAt - dropAt) / 1000)}s after he vanished)`,
    !!wentOff && offAt + world.clockOffset() <= ttlEnd + 60_000, `last state ts ${lastState?.ts}, ttl end ${ttlEnd}, now ${offAt + world.clockOffset()}`);
  const pushBefore = adv.mockApi.pushes.length;
  await A.sendDirectText('Dave', `Alice: are you there? #P1${crypto.randomBytes(2).toString('hex')}`);
  const pushed = await waitFor(async () => adv.mockApi.pushes.slice(pushBefore).some((p) => p.from === A.pubkey && p.to === D.pubkey), { timeout: 30_000 });
  sc.check('Alice\'s message to the (offline) Dave triggers a push — forged or replayed states did not suppress it', !!pushed, '');
  // B、C：各自那一次換秘密之後，一則 Alice 的都沒拆開、也沒收到不是空的
  const bSvc1 = await B.presenceStats();
  const cSvc1 = await C.presenceStats();
  const opened = (a, b) => delta(a, b, 'svc.opened');
  sc.check('the ex-friend (B) opened nothing of Alice after the unfriend rotation; the blocked C nothing after the block rotation',
    opened(bSvc0, bSvc1) === 0 && opened(cSvc0, cSvc1) === 0, `B opened +${opened(bSvc0, bSvc1)}, C opened +${opened(cSvc0, cSvc1)}`);
  const exDeliv = adv.events().filter((e) => e.kind === 'deliver' && !adv.isAdversary(e.from) && (e.topic ?? '').startsWith(presTopicOf(A)) && (e.payload ?? '').length > 0
    && ((e.label === 'Bob' && e.at > r1.clearAt) || (e.label === 'Carol' && e.at > r2.clearAt)));
  sc.check('…and were delivered no non-empty presence of Alice after their clear (old or new topic)', exDeliv.length === 0, exDeliv.map((e) => `${e.label} ${e.topic}`).join('\n'));
  mp.link?.disconnect();

  // ── 5. Dave 回來（session 過期、新秘密的 share 弄丟了）：舊主題上什麼都沒有 → 10 分鐘後跟 Alice 要 → 看到 Alice ──
  adv.broker.release(wid);
  adv.broker.refuseConnect('Dave', false);
  const backAt = Date.now();
  await D.reopenApp();
  await sleep(5_000);
  sc.check('while he holds the stale secret Dave does not see Alice online', (await onlineOf(D, A)) === false, JSON.stringify(await D.presenceStats()));
  // 他的 presence 服務每 5 分鐘、每次連上比對一次：10 分半鐘時讓他重連一次（不然要等到第 15 分鐘那一次）
  await sleep(Math.max(0, backAt + 10.5 * 60_000 - Date.now()));
  adv.broker.dropClientsWhere((s) => s.label === 'Dave');
  const dSees = await waitFor(async () => onlineOf(D, A), { timeout: 6 * 60_000, interval: 5_000 });
  sc.check(`Dave (missed the rotation share) asks Alice again through the silent-topic rule and sees her online (${Math.round((Date.now() - backAt) / 1000)}s after reopening)`, !!dSees,
    JSON.stringify(await D.presenceStats()));
  // 舊 share 重放：A 換秘密之前寄給 D 的信封照原樣塞回去 → D 照樣用新的（舊的 e 比較小 → stale）
  const oldShares = adv.events().filter((e) => e.kind === 'publish' && e.label === 'Alice' && e.at < r1.at
    && e.topic === `mist/user/${toUrl(D.pubkey)}/inbox/${toUrl(A.pubkey)}` && e.payload?.includes('group_key_sealed'));
  const dS0 = await D.presenceStats();
  for (const e of oldShares) adv.broker.inject(e.topic, e.payload);
  await sleep(6_000);
  const dS1 = await D.presenceStats();
  sc.check(`replayed old share envelopes (${oldShares.length}) are refused and Dave keeps seeing Alice on her new topic`,
    (await onlineOf(D, A)) === true && delta(dS0, dS1, 'svc.share-new') === 0, `share-stale +${delta(dS0, dS1, 'svc.share-stale')}, share-new +${delta(dS0, dS1, 'svc.share-new')}`);
  world.adv.friendsTimeline.push({ at: Date.now(), shares: await friendshipSnapshot(world) });
  return sc;
}

// ───────────── P2：API 對一支手機謊報時鐘＋清掉主題＋重放 ─────────────

export async function P2(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('P2', 'Presence vs the API operator: Alice\'s token responses lie that it is 30 minutes earlier; the operator clears Dave\'s topic and replays a 30-minute-old online of his — Alice is not fooled, and sees him again when he really refreshes');
  const { A, D } = world.p;
  const adv = world.adv;
  const SKEW = -30 * 60_000;
  const dTopicOf = () => adv.events().filter((e) => e.kind === 'publish' && e.label === 'Dave' && (e.topic ?? '').startsWith(`mist/user/${toUrl(D.pubkey)}/presence/`)
    && (e.payload ?? '').length > 0).at(-1)?.topic ?? null;
  adv.mockApi.serverTimeSkew.set('Alice', SKEW);
  await A.closeApp();
  await A.reopenApp();
  const off = await A.adv('clockOffset');
  sc.check(`Alice took the lie: her API clock offset is about −30 min (${Math.round((off ?? 0) / 60_000)} min)`, typeof off === 'number' && Math.abs(off - SKEW) < 3 * 60_000, String(off));
  // 時鐘差超過上限 → 畫面提示校正時間（W5 複審：通話、在線這幾種收端判斷會不準；連線本身沒被拒）
  const drift = await waitFor(async () => (await A.adv('notices')).find((n) => n.kind === 'mqtt:clock-drift') ?? null, { timeout: 30_000, interval: 1_000 });
  sc.check(`Alice is told her clock is off (clock-drift notice, ${drift?.minutes ?? '?'} min)`, !!drift && Math.abs((drift.minutes ?? 0) - 30) <= 3, JSON.stringify(drift));
  const sees = await waitFor(async () => onlineOf(A, D), { timeout: 90_000, interval: 2_000 });
  sc.check('Alice still sees Dave online (presence uses the bounded clock: −30 min is taken as −5 min)', !!sees, JSON.stringify(await A.presenceStats()));
  const topic = dTopicOf();
  // 30 分鐘左右之前 Dave 發的「在線」（撥慢 30 分鐘的時鐘看起來正新鮮）
  const nowSim = Date.now() + world.clockOffset();
  const old = adv.events().filter((e) => e.kind === 'publish' && e.label === 'Dave' && e.topic === topic && (e.payload ?? '').length > 0
    && e.at <= Date.now() - 20 * 60_000).at(-1) ?? adv.events().find((e) => e.kind === 'publish' && e.label === 'Dave' && e.topic === topic && (e.payload ?? '').length > 0);
  sc.note(`replaying Dave's state published ${old ? Math.round((Date.now() - old.at) / 60_000) : '?'} min ago on ${topic ? topic.slice(-22, -16) + '…' : 'none'} (sim clock ${nowSim})`);
  const st0 = await A.presenceStats();
  if (topic) adv.broker.inject(topic, Buffer.alloc(0), { retain: true, qos: 1 });   // 營運方「清掉」他目前的主題
  await sleep(2_000);
  sc.check('the forged clear makes Alice treat Dave as offline (the safe side: pushes are sent)', (await onlineOf(A, D)) === false, '', false);
  if (topic && old) adv.broker.inject(topic, old.payload, { qos: 1 });
  await sleep(3_000);
  const st1 = await A.presenceStats();
  sc.check('…and the replayed old online does not bring him back (refused: older than the last state on that topic / too old on the bounded clock)',
    (await onlineOf(A, D)) === false && delta(st0, st1, 'outOfOrder') >= 1 && !!old, `outOfOrder +${delta(st0, st1, 'outOfOrder')}, accepted online +${delta(st0, st1, 'acceptedOnline')}`);
  // Dave 真的重連（新的連線、新的「在線」）→ Alice 又看到他
  adv.broker.dropClientsWhere((x) => x.label === 'Dave');
  const back = await waitFor(async () => onlineOf(A, D), { timeout: 90_000, interval: 2_000 });
  sc.check('when Dave really reconnects (new connection) Alice sees him online again', !!back, JSON.stringify(await A.presenceStats()));
  // 營運方不再說謊：Alice 關掉、恢復誠實的時鐘、重開（新的 token、新的時鐘差）→ 之後的檢查在正常的時鐘上跑
  //   （先關再改：開著的時候改，她手上撥慢 30 分鐘的時鐘簽的 log 請求會被誠實的伺服器拒收）
  await A.closeApp();
  adv.mockApi.serverTimeSkew.delete('Alice');
  await A.reopenApp();
  const off2 = await A.adv('clockOffset');
  sc.check(`after the lie stops Alice's clock offset is back near 0 (${off2} ms)`, typeof off2 === 'number' && Math.abs(off2) < 60_000, String(off2), false);
  return sc;
}

// ───────────── T1：token 請求的形狀 ─────────────

export async function T1(world) {
  clockOf = world.clockOffset ?? (() => 0);
  const sc = new Scenario('T1', 'Token requests with wildcards, non-exact ids, extra levels, old-format ids, peers or extra fields → 400/422 (whole token refused)');
  const M = world.adv.mallory;
  const user = toUrl(world.p.A.pubkey);
  const tag = 'T'.repeat(22);
  const cases = [
    ['group "+"', { groups: ['+'] }, 400], ['group "#"', { groups: ['#'] }, 400], ['group with a slash', { groups: ['abcdefghij/klmnopqrstu'] }, 400],
    ['21-char group id', { groups: ['A'.repeat(21)] }, 400], ['23-char group id', { groups: ['A'.repeat(23)] }, 400],
    ['old group-<ms>-… id', { groups: ['group-1730000000000-abc'] }, 400], ['group id with a trailing newline', { groups: ['A'.repeat(22) + '\n'] }, 400],
    ['51 group ids', { groups: Array.from({ length: 51 }, (_, i) => `${'G'.repeat(20)}${String(i).padStart(2, '0')}`) }, 422],
    ['presence key-only topic', { presence: [`mist/user/${user}/presence`] }, 400], ['presence wildcard tag', { presence: [`mist/user/${user}/presence/+`] }, 400],
    ['presence wildcard owner', { presence: [`mist/user/+/presence/${tag}`] }, 400], ['presence extra level', { presence: [`mist/user/${user}/presence/${tag}/x`] }, 400],
    ['presence multi-level #', { presence: [`mist/user/${user}/#`] }, 400], ['presence_tag "+"', { presence_tag: '+' }, 400],
    ['peers (public-key list)', { peers: [world.p.A.pubkey] }, 422], ['an unknown field', { acl: ['#'] }, 422],
  ];
  for (const [name, over, want] of cases) {
    const r = await M.requestToken(over);
    sc.check(`${name} → ${want}`, r.status === want, `got ${r.status} ${JSON.stringify(r.body)}`);
  }
  const ok = await M.requestToken({ groups: ['A'.repeat(22)], presence: [`mist/user/${user}/presence/${tag}`] });
  sc.check('the exact forms are still accepted (control)', ok.status === 200, `got ${ok.status}`);
  return sc;
}

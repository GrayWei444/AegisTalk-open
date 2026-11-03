/**
 * PRESENCE 稽核（W4，docs/GROUP_LOG_WIRING_W4.md）：用 broker 看到的每一樣東西（lib/broker.mjs onEvent，跟 lib/topics.mjs 同一份紀錄）判斷
 *   SHAPE：每一個 presence 主題（發布、訂閱、遺囑、token 的 acl 規則）都是確切的 mist/user/<標準寫法的 URL-safe 公鑰>/presence/<22 字元 tag> ——
 *     沒有舊的 mist/user/<公鑰>/presence（只要知道公鑰就能訂）、沒有萬用字元、沒有多一層
 *   PAYLOAD：presence 主題上的每一則都是空的（清掉主題）或剛好 {n, c}（兩個 base64）；整則裡沒有任何一支手機的公鑰（標準或 URL-safe）、
 *     沒有 from／online 這種明文 —— 發布的、連線時留的遺囑、broker 替斷線的人發出的遺囑（will）都看（審查 W4 #5）
 *   OWNER：只有主人在自己的 presence 主題上發（遺囑也是）
 *   FRIENDS-ONLY：每一支手機訂到的、token 給的、收到的 presence 主題，主人都是它的好友（同群組但不是好友的人一個都沒有）
 *   EVERY PAIR：每一對好友、兩個方向，broker 都送到過至少一則不是空的 presence（只看總數的話，一個方向壞掉也會過）
 *   ACCEPTED（有給 online／stats 才看）：每一對好友、兩個方向，App 至少一次認定對方在線（isFriendOnline：拆得開、AAD 對、夠新）；
 *     presence 服務的 open-failed（好友目前的主題上一則拆不開：金鑰或 AAD 對不上）一律是 0
 * W5（docs/GROUP_LOG_WIRING_W5.md）：好友關係會變（刪好友、封鎖 → 換秘密）。sharesWith(owner, label, at)：那一刻主人還把秘密給這個人嗎
 *   （沒給 ＝ 照 friendsOf）—— 不是空的投遞要主人那時還把他當好友（營運方塞的、Mallory 發的由 skip 拿掉，它們另外判）；
 *   expectOpenFailed：label → 這一輪營運方故意塞進好友目前主題、一定拆不開的那幾則（open-failed 扣掉這些才算 App 的）
 * 純函式；scripts/review/sim_presence_audit_self_test.mjs 測它真的抓得到。
 */
import { aclView } from './aclView.mjs';

const MAX_FINDINGS = 40;
const EXACT = /^mist\/user\/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\/presence\/[A-Za-z0-9_-]{22}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** 看起來跟 presence 有關的主題／規則（要嚴格檢查形狀的那些） */
const presenceLike = (t) => typeof t === 'string' && /^mist\/user\/[^/]*\/presence(\/|$)/.test(t);

/**
 * events：lib/topics.mjs createTopicAudit().events；phones：[{ label, pubkey（標準 base64） }]；
 * friendsOf：label → Set(好友的 label)；online（可選）：label → Set(App 認定在線過的好友 label)；
 * stats（可選）：label → mqttService.presenceStats()（svc. 開頭的是 presence 服務的）
 */
export function presenceAudit(events, { phones, friendsOf, online = null, stats = null, skip = () => false, sharesWith = null, expectOpenFailed = null }) {
  const findings = [];
  const find = (why) => { if (findings.length < MAX_FINDINGS) findings.push(why); };
  const labelOfSeg = new Map(phones.map((p) => [toUrl(p.pubkey), p.label]));
  const keys = phones.flatMap((p) => [p.pubkey, toUrl(p.pubkey)]);
  const counts = { topics: 0, publishes: 0, subscribes: 0, deliveredToFriends: 0, wills: 0, willsFired: 0, pairs: 0, pairsDelivered: 0, pairsOnline: 0 };
  const ownerOf = (t) => labelOfSeg.get(EXACT.exec(t)?.[1] ?? '') ?? null;
  const isFriend = (label, owner) => friendsOf.get(label)?.has(owner) ?? false;
  /** 好友 owner → 收的人 label：broker 送過幾則不是空的 */
  const pairDeliveries = new Map();
  function checkPayload(ev, what) {
    const raw = ev.payload ?? '';
    if (raw.length > 0) {
      let m = null;
      try { m = JSON.parse(raw); } catch { find(`${ev.label}: ${what} is not JSON`); }
      const k = m && typeof m === 'object' && !Array.isArray(m) ? Object.keys(m).sort().join(',') : '';
      if (m && (k !== 'c,n' || !B64.test(m.n ?? '') || !B64.test(m.c ?? ''))) find(`${ev.label}: ${what} is not {n, c} (${k.slice(0, 40)})`);
      if (/"(from|online|type|on)"/.test(raw)) find(`${ev.label}: ${what} carries a readable field`);
    }
    for (const key of keys) if (raw.includes(key)) find(`${ev.label}: ${what} carries a public key ${key.slice(0, 8)}…`);
  }
  for (const ev of events) {
    if (skip(ev)) continue;
    const acl = aclView(ev.acl);   // legacy {pub, sub, all} 或 rules 清單（lib/aclView.mjs）
    const rules = acl.rules.map((r) => r.topic);
    for (const t of [ev.topic, ...rules].filter(presenceLike)) {
      counts.topics++;
      if (!EXACT.test(t)) find(`${ev.kind} by ${ev.label}: presence topic ${t.slice(0, 70)} is not mist/user/<key>/presence/<22-char tag>`);
    }
    // token 的規則裡的 presence 主題：訂閱的主人要是好友；發布的只能是自己的
    for (const r of acl.sub.filter((x) => EXACT.test(x))) {
      const owner = ownerOf(r);
      if (owner && owner !== ev.label && !isFriend(ev.label, owner)) find(`${ev.label}'s token grants the presence topic of ${owner}, who is not a friend`);
    }
    for (const r of acl.pub.filter(presenceLike)) {
      if (ownerOf(r) !== ev.label) find(`${ev.label}'s token may publish presence for ${ownerOf(r) ?? r.slice(0, 40)}`);
    }
    const t = ev.topic;
    if (!presenceLike(t) || !EXACT.test(t)) continue;
    const owner = ownerOf(t);
    if (ev.kind === 'connect') {
      counts.wills++;
      if (owner !== ev.label) find(`${ev.label}'s will is on the presence topic of ${owner ?? 'someone else'}`);
      checkPayload(ev, 'presence will');
    } else if (ev.kind === 'will') {
      counts.willsFired++;
      if (owner !== ev.label) find(`${ev.label}'s will fired on the presence topic of ${owner ?? 'someone else'} (granted=${ev.granted})`);
      checkPayload(ev, 'fired presence will');
    } else if (ev.kind === 'publish') {
      counts.publishes++;
      if (owner !== ev.label) find(`${ev.label} published on the presence topic of ${owner ?? 'someone else'} (granted=${ev.granted})`);
      checkPayload(ev, 'presence payload');
    } else if (ev.kind === 'subscribe') {
      counts.subscribes++;
      if (owner && owner !== ev.label && !isFriend(ev.label, owner)) find(`${ev.label} subscribed to the presence of ${owner}, who is not a friend (granted=${ev.granted})`);
    } else if (ev.kind === 'deliver') {
      const nonEmpty = (ev.payload ?? '').length > 0;
      if (owner && owner !== ev.label && !isFriend(ev.label, owner)) find(`${ev.label} was delivered the presence of ${owner}, who is not a friend`);
      else if (owner && owner !== ev.label && nonEmpty && sharesWith && !sharesWith(owner, ev.label, ev.at)) {
        find(`${ev.label} was delivered a presence state of ${owner} after ${owner} stopped sharing with ${ev.label} (unfriended/blocked)`);
      } else if (owner && owner !== ev.label) {
        counts.deliveredToFriends++;
        if ((ev.payload ?? '').length > 0) pairDeliveries.set(`${owner}>${ev.label}`, (pairDeliveries.get(`${owner}>${ev.label}`) ?? 0) + 1);
      }
    }
  }
  if (counts.deliveredToFriends === 0) find('no presence was delivered between friends (the check would be empty)');
  // 每一對好友、兩個方向（只看有公鑰的手機）
  const known = new Set(phones.map((p) => p.label));
  for (const [label, friends] of friendsOf) {
    if (!known.has(label)) continue;
    for (const owner of friends) {
      if (!known.has(owner) || owner === label) continue;
      counts.pairs++;
      if (pairDeliveries.get(`${owner}>${label}`)) counts.pairsDelivered++;
      else find(`no presence of ${owner} was ever delivered to ${label} (a friend)`);
      if (online) {
        if (online.get(label)?.has(owner)) counts.pairsOnline++;
        else find(`${label}'s app never saw its friend ${owner} online (isFriendOnline)`);
      }
    }
  }
  if (stats) {
    for (const [label, st] of stats) {
      const honestFailed = (st?.['svc.open-failed'] ?? 0) - (expectOpenFailed?.get(label) ?? 0);
      if (st && honestFailed > 0) find(`${label}: ${honestFailed} presence message(s) on a friend's current topic did not open (key or AAD mismatch)`);
    }
  }
  return { pass: findings.length === 0, findings, ...counts };
}

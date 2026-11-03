/**
 * 群組主題稽核（W3，docs/GROUP_LOG_WIRING_W3.md）：broker 看到的每一樣東西（lib/broker.mjs onEvent）記下來，跑完再判。
 *   GID-HIDDEN：群組 id（gid）從來沒出現在 broker 上 —— 發布／訂閱／退訂的主題、遺囑主題、token 的 acl（JWT 就是 MQTT 密碼，
 *     broker 看得到）、每一則 payload 的原文（密文是 base64，gid 是 URL-safe 字母，亂數撞到的機率是 0）；
 *     金鑰 id（kid）也一樣不能出現（審查 W3 M3：群組 log 上每一筆都帶明文 kid、看得到 gid —— broker 上看到 kid，營運方就能把 tid 對回 gid）
 *   REMOVED-SILENT：被踢的那支（S2 的 Bob）從沒訂過、也從沒收過踢人之後那幾代的群組主題（tid），token 裡也沒有；
 *     而且其他手機在那些主題上真的有收到東西（不然這個檢查是空的）
 * 純函式（不碰 broker、不碰瀏覽器）；scripts/review/sim_topic_audit_self_test.mjs 測它真的抓得到。
 */
import { aclRules, aclView } from './aclView.mjs';
import crypto from 'node:crypto';

const MAX_FINDINGS = 40;
const TOPIC_ID = /^[A-Za-z0-9_-]{22}$/;

/** = packages/pwa/src/services/groupControl.ts deriveTopicId：URL-safe base64(HKDF-SHA256(K_e, 空 salt, "aegistalk-gtopic-v1|" + gid))[:22] */
export function deriveTopicId(keyBase64, gid) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('group key must be 32 bytes');
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(`aegistalk-gtopic-v1|${gid}`, 'utf8'), 32)).toString('base64url').slice(0, 22);
}

const groupTid = (topic) => {
  const parts = String(topic ?? '').split('/');
  return parts.length === 4 && parts[0] === 'mist' && parts[1] === 'group' ? parts[2] : null;
};

export function createTopicAudit() {
  const events = [];
  const counts = { connect: 0, publish: 0, subscribe: 0, unsubscribe: 0, deliver: 0 };
  function record(ev) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    const payload = ev.payload === undefined ? undefined : (Buffer.isBuffer(ev.payload) ? ev.payload.toString('utf8') : String(ev.payload));
    events.push({ kind: ev.kind, label: ev.label, topic: ev.topic ?? null, payload, acl: ev.acl ?? null, granted: ev.granted,
      at: ev.at ?? null, from: ev.from ?? null });
  }

  /**
   * gids：這一輪所有的群組 id；kids：所有群組金鑰的 id（每一代，22 字元）。回傳 { pass, checked, gids, kids, findings }。
   * skip(ev)：不算的事件（W5：攻擊者自己發的、營運方塞的、送到誠實手機的那些 —— 它們本來就可以帶任何東西；判的是 App）
   */
  function gidHidden(gids, kids = [], { skip = () => false } = {}) {
    const list = [...gids].filter(Boolean);
    const kidList = [...kids].filter(Boolean);
    const findings = [];
    let checked = 0;
    const find = (why) => { if (findings.length < MAX_FINDINGS) findings.push(why); };
    for (const ev of events) {
      if (skip(ev)) continue;
      const visible = [ev.topic, ...aclRules(ev.acl).map((r) => r.topic)].filter(Boolean);
      checked++;
      for (const g of list) {
        if (visible.some((t) => String(t).includes(g))) find(`${ev.kind} by ${ev.label}: the gid ${g.slice(0, 6)}… is in a topic or token rule`);
        if (ev.payload !== undefined && ev.payload.includes(g)) find(`${ev.kind} by ${ev.label} on ${String(ev.topic).split('/').slice(0, 2).join('/')}: the gid ${g.slice(0, 6)}… is in the payload`);
      }
      for (const k of kidList) {
        if (visible.some((t) => String(t).includes(k))) find(`${ev.kind} by ${ev.label}: the kid ${k.slice(0, 6)}… is in a topic or token rule`);
        if (ev.payload !== undefined && ev.payload.includes(k)) find(`${ev.kind} by ${ev.label} on ${String(ev.topic).split('/').slice(0, 2).join('/')}: the kid ${k.slice(0, 6)}… is in the payload`);
      }
      const tid = groupTid(ev.topic);
      if (ev.topic && String(ev.topic).startsWith('mist/group/') && (tid === null || (!TOPIC_ID.test(tid) && tid !== '+'))) {
        find(`${ev.kind} by ${ev.label}: group topic ${String(ev.topic).slice(0, 40)} is not mist/group/{22-char tid}/…`);
      }
    }
    return { pass: list.length > 0 && findings.length === 0, checked, gids: list.length, kids: kidList.length, findings };
  }

  /**
   * removed：被踢的那支的 label；tids：踢人之後那幾代的群組主題 id；others：其他（還在群裡的）label。
   */
  function removedSilent({ removed, tids, others, skip = () => false }) {
    const set = new Set(tids);
    const findings = [];
    const find = (why) => { if (findings.length < MAX_FINDINGS) findings.push(why); };
    let delivered = 0;
    let deliveredToOthers = 0;
    for (const ev of events) {
      if (skip(ev)) continue;
      const tid = groupTid(ev.topic);
      const onNew = tid !== null && set.has(tid);
      if (ev.label === removed) {
        if (ev.kind === 'subscribe' && onNew) find(`${removed} subscribed to a post-removal topic ${tid.slice(0, 6)}… (granted=${ev.granted})`);
        if (ev.kind === 'deliver' && onNew) { delivered++; find(`${removed} was delivered a message on a post-removal topic ${tid.slice(0, 6)}…`); }
        if (ev.kind === 'publish' && onNew) find(`${removed} published on a post-removal topic ${tid.slice(0, 6)}…`);
        if (ev.kind === 'connect' && ev.acl && aclView(ev.acl).sub.some((t) => set.has(groupTid(t)))) find(`${removed}'s token grants a post-removal topic`);
      } else if (ev.kind === 'deliver' && onNew && others.includes(ev.label)) {
        deliveredToOthers++;
      }
    }
    if (set.size === 0) find('no post-removal topic known (the check would be empty)');
    else if (deliveredToOthers === 0) find('nobody received anything on the post-removal topics (the check would be empty)');
    return { pass: findings.length === 0, tids: set.size, deliveredToRemoved: delivered, deliveredToOthers, findings };
  }

  return { record, gidHidden, removedSilent, counts, events };
}

/**
 * token 的 acl claim 兩種格式（伺服器 api/chat/mqtt_auth.py mqtt_acl_claim）在模擬裡的同一個讀法：
 *   legacy {pub, sub, all}                     EMQX 5.3 起；每一條都是 allow，不分 retain
 *   rules [{permission, action, topic, retain?}] EMQX ≥ 5.7（開源計畫第 3 步的預設）：依序比對、第一條命中的決定；
 *                                              retain: false 只命中非 retained 的發布（true 只命中 retained），沒寫 ＝ 都命中；
 *                                              都沒命中 ＝ 拒絕（broker 的 no_match = deny）
 * 比對照 EMQX：發布 → 規則（可含 +／#）涵蓋這個主題；訂閱 → 規則涵蓋這個 filter（filter 的 + 只能落在規則也是 + 的位置）。
 * broker.mjs（模擬 broker 照這個放行）、topics.mjs／presenceAudit.mjs（稽核 token 給了哪些主題）共用。
 */

export function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** ACL 規則（可含 +）是否涵蓋這個訂閱 filter：filter 的 + 只能落在規則也是 + 的位置 */
export function aclCoversFilter(rule, filter) {
  const r = rule.split('/');
  const f = filter.split('/');
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '#') return true;
    if (i >= f.length) return false;
    if (r[i] === '+') continue;
    if (f[i] !== r[i]) return false;
  }
  return r.length === f.length;
}

const ACTIONS = { pub: 'publish', publish: 'publish', sub: 'subscribe', subscribe: 'subscribe', all: 'all' };

/** 任一格式 → 規則清單（legacy 的每一條都是 allow、不限 retain） */
export function aclRules(acl) {
  if (!acl) return [];
  if (Array.isArray(acl)) return acl.map((r) => ({ ...r, action: ACTIONS[r.action] ?? r.action }));
  return [
    ...(acl.pub ?? []).map((topic) => ({ permission: 'allow', action: 'publish', topic })),
    ...(acl.sub ?? []).map((topic) => ({ permission: 'allow', action: 'subscribe', topic })),
    ...(acl.all ?? []).map((topic) => ({ permission: 'allow', action: 'all', topic })),
  ];
}

/** { pub, sub }：token 准的發布／訂閱主題（allow 規則的 topic；稽核看 token 給了什麼用），rules：完整規則 */
export function aclView(acl) {
  const rules = aclRules(acl);
  const allowed = (action) => rules.filter((r) => r.permission === 'allow' && (r.action === action || r.action === 'all')).map((r) => r.topic);
  return { rules, pub: allowed('publish'), sub: allowed('subscribe') };
}

/** 這張 token 准不准：action ＝ publish（topic、retain）／subscribe（filter） */
export function aclAllows(acl, action, topic, { retain = false } = {}) {
  for (const r of aclRules(acl)) {
    if (r.action !== action && r.action !== 'all') continue;
    if (action === 'publish' && typeof r.retain === 'boolean' && r.retain !== !!retain) continue;
    const hit = action === 'publish' ? topicMatches(r.topic, topic) : aclCoversFilter(r.topic, topic);
    if (hit) return r.permission === 'allow';
  }
  return false;
}

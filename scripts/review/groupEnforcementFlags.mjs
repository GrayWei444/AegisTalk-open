/**
 * 測試共用：以前 services/groupEnforcement.ts 有兩個開關（第一階段「只記 log、不輪換」與「擋、輪換」），群組測試兩種都跑。
 * W1（docs/GROUP_LOG_WIRING_W1.md）把開關拿掉了：成員檢查一直開著、換金鑰由狀態鏈的 remove／rekey commit 做。
 * 這裡只剩一種模式（ENFORCED），讓還在用 MODES／flagContext 的測試照跑「擋」那一種 —— 斷言一條都不放寬，
 * 只是不再跑已經不存在的「只記 log」模式。
 * 不是測試本身（檔名沒有 _self_test），由各測試 import。
 */
export const ENFORCED = Object.freeze({ ENFORCE_GROUP_MEMBERSHIP: true, ROTATE_ON_MEMBER_CHANGE: true });
export const MODES = Object.freeze([['enforced (always on)', ENFORCED]]);

/** 以前把 groupEnforcement.ts 的常數換掉的 esbuild plugin；模組已經不在，留一個什麼都不做的 */
export function enforcementPlugin() {
  return { name: 'group-enforcement-flags', setup() { /* groupEnforcement.ts removed in W1 */ } };
}

/** 抽出來在 vm 裡跑的程式碼還用得到的名字（舊的片段；新程式碼已經不引用它們） */
export function flagContext(flags = ENFORCED, logs = []) {
  return {
    ENFORCE_GROUP_MEMBERSHIP: flags.ENFORCE_GROUP_MEMBERSHIP,
    ROTATE_ON_MEMBER_CHANGE: flags.ROTATE_ON_MEMBER_CHANGE,
    groupCheckWouldBlock: (reason, details = {}) => { logs.push(['block', reason, details]); },
    groupCheckWouldRotate: (reason, details = {}) => { logs.push(['rotate', reason, details]); },
  };
}

/** logs 裡某一種 would block／would rotate 的原因 */
export const reasons = (logs, kind = 'block') => logs.filter(([k]) => k === kind).map(([, r]) => r);

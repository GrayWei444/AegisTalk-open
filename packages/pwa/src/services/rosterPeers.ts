/**
 * 「我要連得到的人」＝好友＋同群組的成員（對應群星 64f3d211，多人模擬 S3）。
 *
 * 群訊逐人走 P2P，成員不一定是好友（LINE 式群組）。以前上線通知（presence 訂閱）與 P2P 健康檢查都只算好友
 * → 非好友成員之間的連線斷了沒人修、對方上線也不知道，待送的群訊一直卡著。
 * （AegisTalk 的 MQTT token 沒有訂閱範圍 —— EMQX 只驗 JWT —— 所以沒有群星那段 token 範圍的修正。）
 */

type RosterGroup = { members: ReadonlyArray<{ publicKey: string }> };

/** 所有群組的成員公鑰（不含自己），去重、照出現順序 */
export function groupMemberKeys(groups: ReadonlyArray<RosterGroup>, me: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const g of groups) {
    for (const m of g.members) {
      if (m.publicKey && m.publicKey !== me) out.add(m.publicKey);
    }
  }
  return [...out];
}

/** 要追蹤上線狀態、檢查 P2P 健康的人：好友在前、其次是群組成員（去重、不含自己） */
export function knownPeerKeys(
  friendKeys: ReadonlyArray<string>,
  groups: ReadonlyArray<RosterGroup>,
  me: string | null | undefined,
): string[] {
  const out = new Set<string>(friendKeys.filter((k) => k && k !== me));
  for (const k of groupMemberKeys(groups, me)) out.add(k);
  return [...out];
}

/** next 裡有、prev 裡沒有的 */
export function newlyAdded(prev: ReadonlySet<string>, next: Iterable<string>): string[] {
  const out: string[] = [];
  for (const k of next) if (!prev.has(k)) out.push(k);
  return out;
}

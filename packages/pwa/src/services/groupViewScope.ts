/**
 * 收到的群組訊息能出現在哪些群組畫面（稽核 H8，對應群星 P1-8）。
 *
 * 一則訊息可以同時出現在多個「視圖群組」（明文 groupIds）。以前直接照寄件人給的 groupIds 存：
 * X 群的成員（或任何好友）在明文寫上 Y 群的 id，訊息就以非成員身分出現在 Y 群；群組檔案的
 * manifest 更完全不檢查。
 *
 * 現在只留下「本機知道、且寄件人是成員」的群組（名冊＝套上的狀態鏈）。唯一例外：訊息實際寄給的那個群（outerGroupId）
 * 本機還不認得時照舊保留 —— 邀請可能還在對照 log 確認，等加入後才看得到。
 */

type GroupLookup = (groupId: string) => { members: { publicKey: string }[] } | undefined;

const MAX_VIEW_GROUPS = 50;   // 跟群組數上限一致

export function permittedGroupIds(
  sender: string,
  outerGroupId: string | undefined,
  claimed: unknown,
  getGroup: GroupLookup,
): string[] {
  const ids = [...(outerGroupId ? [outerGroupId] : []), ...(Array.isArray(claimed) ? claimed : [])]
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128);
  const out: string[] = [];
  for (const id of new Set(ids)) {
    if (out.length >= MAX_VIEW_GROUPS) break;
    const group = getGroup(id);
    if (group ? group.members.some((m) => m.publicKey === sender) : id === outerGroupId) out.push(id);
  }
  return out;
}

/**
 * 實際要存進哪些群組畫面＝permittedGroupIds（成員檢查一直開著；以前的第一階段「只記 log」開關拿掉了）。
 * 第五個參數是舊的「沒檢查時照存」清單，留著只為了不改呼叫端的形狀，不再使用。
 */
export function viewGroupIdsToSave(
  sender: string,
  outerGroupId: string | undefined,
  claimed: unknown,
  getGroup: GroupLookup,
  _unenforced?: string[],
): string[] {
  return permittedGroupIds(sender, outerGroupId, claimed, getGroup);
}

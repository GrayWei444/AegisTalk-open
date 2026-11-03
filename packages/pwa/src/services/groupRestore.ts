/**
 * App 用的群組還原入口（帳號恢復、社交恢復、換機）：備份裡每個群的整條狀態鏈用真的驗章器重驗後寫進本機
 * （groupBackup.restoreGroupBackups）；引擎啟動時從本機載入、再向伺服器 log 補進度。
 * 還原時引擎可能已經在跑（身分先解鎖、群組後還原）→ 請它把本機新出現的群載進來（adoptStored）。失敗只記 log，不擋登入。
 */
import { restoreGroupBackups } from './groupBackup';
import { groupLogStore } from './groupLogStore';
import { verify } from './groupKeyDelivery';
import { getGroupEngine } from './groupEngineHost';

export async function restoreGroupsFromBackup(groups: unknown, me: string): Promise<number> {
  try {
    const n = await restoreGroupBackups(groups, me, verify, groupLogStore);
    if (n > 0) await getGroupEngine()?.adoptStored();
    return n;
  } catch (e) {
    console.error('[groupRestore] restoring groups failed:', (e as Error)?.message ?? e);
    return 0;
  }
}

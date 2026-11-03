/**
 * 帳號離開這台裝置（登出、清除帳號、被踢、換機）時，清掉這個版本留在原生端的本機資料。
 * 官方版在載入時註冊清除的做法（src/ext-official/guardian：守護功能的報平安設定、舊版背景服務留下的憑證、還沒交給 JS 的
 * 「報平安」；不連網）；社群版沒有原生端的守護資料，沒有註冊 → 什麼都不做（開源第 5d 步：社群版的 Android 沒有守護外掛）。
 * 失敗只記 log，不擋登出。呼叫端：App.tsx exitChat、deviceClaim.ts wipeLocalKeys、SettingsPage 換機（舊手機）。
 */

type NativeDataCleaner = () => Promise<void>;

let cleaner: NativeDataCleaner | null = null;

/** 版本註冊（或用 null 取消）帳號離開時要跑的原生端清除 */
export function setNativeAccountDataCleaner(fn: NativeDataCleaner | null): void {
  cleaner = fn;
}

export async function clearGuardianNativeData(): Promise<void> {
  const run = cleaner;
  if (!run) return;
  try {
    await run();
  } catch (err) {
    console.error('[GuardianBackground] clearing the native account data failed:', err);
  }
}

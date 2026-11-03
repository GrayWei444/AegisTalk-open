/**
 * App 目前這個帳號的群組 log 引擎（AppProvider 在身分解鎖、資料庫就緒後建立，登出／換帳號時停掉）。
 * 畫面（useGroupChat）、收訊（AppProvider）、備份（main.tsx 的 blob providers）都從這裡拿，沒有就是還沒登入。
 */
import type { GroupEngine } from './groupEngine';

let current: GroupEngine | null = null;

export function setGroupEngine(engine: GroupEngine | null): void {
  current = engine;
}

export function getGroupEngine(): GroupEngine | null {
  return current;
}

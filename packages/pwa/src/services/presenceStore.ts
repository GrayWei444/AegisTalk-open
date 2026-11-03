/**
 * 秘密 presence 的存檔（W4，presenceService.ts）：settings 表，一個帳號一筆 presence_secret:<我的公鑰>（JSON）。
 * 裡面有我的 S 與好友的 S —— 帳號離開這台裝置（被踢、清除帳號）時跟其他帳號資料一起清（wipePresenceSecrets）。
 */
import * as db from './database';
import type { PersistedPresence } from './presenceService';

const PREFIX = 'presence_secret:';

export const presenceStore = {
  async load(me: string): Promise<unknown> {
    const raw = await db.getSetting(PREFIX + me);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
  async save(me: string, data: PersistedPresence): Promise<void> {
    await db.setSetting(PREFIX + me, JSON.stringify(data));
  },
};

/** 這台裝置上所有帳號的 presence 秘密都刪掉 */
export async function wipePresenceSecrets(): Promise<void> {
  await db.run(`DELETE FROM settings WHERE key LIKE '${PREFIX}%'`, []);
}

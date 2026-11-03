import { registerPlugin } from '@capacitor/core';

export interface FCMTokenPluginInterface {
  getToken(): Promise<{ token: string | null; needsSync: boolean }>;
  markSynced(): Promise<{ success: boolean }>;
  /** Firebase 有沒有初始化（社群版沒有放 google-services.json ＝ 沒有 FCM；開源第 5d 步） */
  hasFirebase(): Promise<{ available: boolean }>;
}

export const FCMTokenPlugin = registerPlugin<FCMTokenPluginInterface>('FCMTokenPlugin', {
  web: {
    async getToken() { return { token: null, needsSync: false }; },
    async markSynced() { return { success: true }; },
    async hasFirebase() { return { available: false }; },
  },
});

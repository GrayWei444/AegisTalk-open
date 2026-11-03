import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface SharedFileData {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export interface ShareCheckResult {
  hasShare: boolean;
  title?: string;
  text?: string;
  files: SharedFileData[];
}

export interface SharePluginInterface {
  checkShare(): Promise<ShareCheckResult>;
  clearShare(): Promise<{ success: boolean }>;
  addListener(eventName: 'shareReceived', handler: () => void): Promise<PluginListenerHandle>;
}

export const SharePlugin = registerPlugin<SharePluginInterface>('SharePlugin', {
  web: {
    async checkShare() { return { hasShare: false, files: [] }; },
    async clearShare() { return { success: true }; },
    async addListener() { return { remove: async () => {} }; },
  },
});

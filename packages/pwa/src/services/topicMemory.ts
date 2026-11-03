/**
 * mqtt 記在 localStorage 的「這個帳號在 broker session 裡可能還訂著的主題」（群組 tid、好友的 presence 主題；
 * mqtt.ts _persistGroupTopics／_persistPresenceTopics：App 重開、broker 還留著 session 時，才知道要退訂哪些）。
 * presence 那一份裡有好友的公鑰與他們目前的 tag —— 知道 tag 就看得到他上下線的節奏（審查 W4 #11）——
 * 帳號離開這台裝置（被踢 deviceClaim.wipeLocalKeys、清除帳號 storage.clearAllData）時一起清。
 */
export const GROUP_TOPICS_KEY_PREFIX = 'aegis_mqtt_group_topics:';
export const PRESENCE_TOPICS_KEY_PREFIX = 'aegis_mqtt_presence_topics:';

type KeyStore = Pick<Storage, 'length' | 'key' | 'removeItem'>;

function defaultStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;   // 隱私模式、被封鎖的網站資料：拿 localStorage 本身就會丟例外
  }
}

/** 這台裝置上所有帳號記著的群組／presence 主題都刪掉；回傳刪了幾筆 */
export function wipeRememberedTopics(store: KeyStore | null = defaultStore()): number {
  if (!store) return 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (k.startsWith(GROUP_TOPICS_KEY_PREFIX) || k.startsWith(PRESENCE_TOPICS_KEY_PREFIX))) doomed.push(k);
    }
    for (const k of doomed) store.removeItem(k);
    return doomed.length;
  } catch (e) {
    console.error('[topicMemory] wiping the remembered topics failed:', (e as Error)?.message ?? e);
    return 0;
  }
}

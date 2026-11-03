/**
 * App 這一層的群組控制訊息路由（W2，docs/GROUP_LOG_WIRING_W2.md）：AppProvider 收到 MQTT group_sealed → 群組引擎；
 * 引擎驗過的 call／delete → 群組通話、刪除群訊。純函式，方便測試整條路（mqtt.ts → 這裡 → groupEngine）。
 */
import { isGroupTopicId, toUrlSafeBase64 } from './mqttCredential';

/**
 * MQTT 訊息 → (主題 id, 寄件人, 信封)。主題 id 與寄件人都取自實際的主題 mist/group/{tid}/{寄件人}（mqtt.ts 已核對最後一節＝from，
 * 這裡再核一次）；不是群組主題、主題 id 不是 22 字元 → null。W3：這裡**沒有** gid —— tid 是哪個群，只有群組引擎自己的主題表
 * 知道（engine.onControl）；payload 裡自稱的任何群組 id 都不看。
 */
export function groupControlSource(message: { topic?: string; from: string; payload: unknown }):
  { tid: string; from: string; envelope: unknown } | null {
  const parts = typeof message.topic === 'string' ? message.topic.split('/') : [];
  if (parts.length !== 4 || parts[0] !== 'mist' || parts[1] !== 'group') return null;
  if (!isGroupTopicId(parts[2]) || parts[3] !== toUrlSafeBase64(message.from)) return null;
  return { tid: parts[2], from: message.from, envelope: message.payload };
}

export interface ControlHandlers {
  /** 群組通話 start／join／leave／end */
  onCall(gid: string, from: string, body: Record<string, unknown>): void;
  /** 為所有人刪除：只刪「這個群、這個作者」的那一則 */
  onDelete(gid: string, from: string, messageId: string): void;
}

/** 群組引擎 deps.onControl：驗過的 call／delete 交給畫面那一層 */
export function routeGroupControl(gid: string, from: string, t: 'call' | 'delete', body: Record<string, unknown>, h: ControlHandlers): void {
  if (t === 'call') h.onCall(gid, from, body);
  else if (t === 'delete' && typeof body.messageId === 'string') h.onDelete(gid, from, body.messageId);
}

/**
 * Web Push 收到的內容 → 要顯示的通知（service worker 用；開源第 4 步審查 M4、第 5d 步）。
 *
 * 推播內容由 chat 伺服器組（api/chat/push.py push_fcm_data）：type、action、senderPubkey、isVideoCall（字串 "true"／"false"），
 * 來電另外帶來電者簽的 ringToken。推播這條路的其他欄位沒有寄件人簽章 —— 推得動的人（持有 VAPID 私鑰的營運方；舊版留下、拿到
 * 別人訂閱的 relay）可以塞任何欄位。以前 service worker 直接顯示 callerName、callerAvatar（當圖示網址）、title、body、tag：
 * 誰都能讓手機跳「媽媽 正在呼叫你」、釣魚文字或追蹤用的圖片網址。
 * 現在文字是固定的，推播裡的名字、標題、內文、圖示、tag 一律不採用：
 *   - 來電：只有響鈴 token 驗過（ring，services/ringDirectory.decideRing：好友簽的、寄給我、夠新鮮、這一通沒響過）才是來電的樣子
 *     （接聽／拒接、一直震動、不會自己消失），名字是本機存的那個好友的名字、視訊與否看 token；驗不過 → 一則不帶名字的一般通知
 *   - 其他型別：固定文字
 * 純函式：不碰 service worker 的 API，可以測、可以移植到群星。
 */

export type PushDisplayKind = 'incoming_call' | 'message' | 'guardian_alert' | 'check_in';

export interface PushDisplay {
  kind: PushDisplayKind;
  title: string;
  body: string;
  /** 通知的 tag：來電同一時間只有一個；其他各自一個 */
  tag: string;
  isVideoCall: boolean;
  /** 來電的樣子（接聽／拒接、長震動、不會自己消失）：只有響鈴 token 驗過的來電才有 */
  ring: boolean;
}

/** 響鈴 token 驗過的來電（decideRing）：名字是本機存的、視訊與否是來電者簽的 */
export interface VerifiedRing {
  name: string;
  video: boolean;
}

const KINDS: readonly PushDisplayKind[] = ['incoming_call', 'message', 'guardian_alert', 'check_in'];
const MAX_NAME = 64;

/** 推播的 JSON（解析失敗、不是物件 → 當成一般訊息）；ring：這則來電的響鈴 token 驗過了（沒驗過 → null） */
export function pushDisplayFor(data: unknown, now: number, ring: VerifiedRing | null = null): PushDisplay {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const kind: PushDisplayKind = (KINDS as readonly unknown[]).includes(d.type) ? (d.type as PushDisplayKind) : 'message';
  if (kind === 'incoming_call') {
    if (ring) {
      const isVideoCall = ring.video === true;
      const name = typeof ring.name === 'string' ? ring.name.trim().slice(0, MAX_NAME) : '';
      return {
        kind, ring: true, isVideoCall, tag: 'incoming-call',
        title: isVideoCall ? '📹 視訊來電' : '📞 來電',
        body: name ? (isVideoCall ? `${name} 正在發起視訊通話` : `${name} 正在呼叫你`) : '打開 AegisTalk 接聽',
      };
    }
    // 驗不過（偽造、陌生人、封鎖、重放、太舊、沒有 token）：不是來電的樣子、不帶名字；自己的 tag（不會蓋掉一則驗過的來電，審查 L3）
    return { kind, ring: false, isVideoCall: false, tag: 'call-hint', title: 'AegisTalk', body: '可能有人打給你，打開 AegisTalk 看看' };
  }
  if (kind === 'guardian_alert') {
    return { kind, ring: false, isVideoCall: false, tag: `guardian-${now}`, title: 'AegisTalk', body: '你有新的守護通知' };
  }
  if (kind === 'check_in') {
    return { kind, ring: false, isVideoCall: false, tag: `check-in-${now}`, title: 'AegisTalk', body: '你有新的報平安通知' };
  }
  return { kind: 'message', ring: false, isVideoCall: false, tag: `msg-${now}`, title: 'AegisTalk', body: '你有新訊息' };
}

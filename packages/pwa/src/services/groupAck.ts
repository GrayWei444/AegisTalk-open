/**
 * 群組訊息的送達回條（group_msg_ack），由回條者的身分金鑰簽章（開源第 4 步；群星 aegisplay-call-check.md「plaintext group_msg_ack」）。
 *
 * 以前回條是 DataChannel 上的明文 { type: 'group_msg_ack', ids }：通道被中間人接手（明文信令時代任何人都能塞 offer）的話，
 * 他每看到一則群訊就替收件人回一張回條 → 寄件人停止重送 → 那則群訊永遠到不了。
 * 現在：sig ＝ 回條者 Ed25519 簽 DOMAIN ‖ JSON {from, to, ids, ts}（from ＝ 回條者、to ＝ 寄件人）。收端用「這條通道的對方」的身分金鑰驗，
 * from／to 要是他與我；對不上就不清任何等回條。重放一張真的回條無害（那幾則他本來就收到了），to 綁住寄件人：他回給別人的不能拿來清我的。
 * 純函式（簽章／驗章由呼叫端注入），網域前綴可換：可以直接移植到群星。
 */

export const GROUP_ACK_DOMAIN = 'aegistalk-gack-v1:';
const MAX_IDS = 50;
/** 訊息 id：可見的 ASCII（generateId 是 `gmsg-<時間>-<亂數>`；別的寫法也收），最多 128 字 */
const ID_RE = /^[\x21-\x7e]{1,128}$/;

export interface GroupAckFrame {
  type: 'group_msg_ack';
  ids: string[];
  ts: number;
  sig: string;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function signedBytes(domain: string, from: string, to: string, ids: readonly string[], ts: number): Uint8Array {
  return new TextEncoder().encode(domain + JSON.stringify({ from, to, ids, ts }));
}

/** 回條（我 from 回給寄件人 to）：ids 是收好的群訊 id */
export function signGroupAck(p: { from: string; to: string; ids: string[]; ts: number; sign: (d: Uint8Array) => Uint8Array; domain?: string }): GroupAckFrame {
  const ids = p.ids.filter((id) => ID_RE.test(id)).slice(0, MAX_IDS);
  return { type: 'group_msg_ack', ids, ts: p.ts, sig: toB64(p.sign(signedBytes(p.domain ?? GROUP_ACK_DOMAIN, p.from, p.to, ids, p.ts))) };
}

/**
 * 通道的對方（from）回給我（to）的回條：簽章對、格式對才回 ids；否則 null（不清任何等回條）
 */
export function openGroupAck(p: {
  frame: unknown; from: string; to: string;
  verify: (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean;
  domain?: string;
}): string[] | null {
  const f = p.frame as Partial<GroupAckFrame> | null;
  if (!f || typeof f !== 'object' || f.type !== 'group_msg_ack') return null;
  if (!Array.isArray(f.ids) || f.ids.length === 0 || f.ids.length > MAX_IDS || !f.ids.every((id) => typeof id === 'string' && ID_RE.test(id))) return null;
  if (typeof f.ts !== 'number' || !Number.isFinite(f.ts) || typeof f.sig !== 'string') return null;
  const sig = fromB64(f.sig);
  const pk = fromB64(p.from);
  if (!sig || sig.length !== 64 || !pk || pk.length !== 32) return null;
  try {
    return p.verify(pk, signedBytes(p.domain ?? GROUP_ACK_DOMAIN, p.from, p.to, f.ids, f.ts), sig) ? [...f.ids] : null;
  } catch {
    return null;
  }
}

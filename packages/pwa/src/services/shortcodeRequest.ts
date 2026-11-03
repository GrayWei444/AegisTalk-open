/**
 * 好友短碼的 register／refresh 請求（伺服器端：api/chat/shortcode.py，開源計畫第 3 步移植群星）。
 *
 * 以前只送 {public_key, signed_pre_key, signature, display_name}、伺服器不驗簽 —— 知道我公鑰的人能把我短碼背後的預備金鑰
 * 換成他的（加我的人會跟他做 X3DH），也能用 refresh 作廢我的短碼。現在由**已解鎖的帳戶金鑰**簽整份請求：
 *   request_signature ＝ 身分金鑰簽 canonical JSON {action, public_key, signed_pre_key, signature, display_name, timestamp, request_id}
 *   （跟伺服器 json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False) 一字不差，mqttCredential.canonicalJson）
 * signature 照舊是 signed pre-key 的 X3DH 簽章（伺服器也會驗）。timestamp 用校正到伺服器的時鐘（mqtt.serverNow），
 * request_id 每次新的（伺服器只收一次）。
 */
import { canonicalJson, type IdentitySigner } from './mqttCredential';

export type ShortCodeAction = 'register_shortcode' | 'refresh_shortcode';

export interface ShortCodeBundle {
  signedPreKey: string;
  preKeySignature: string;
  displayName: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** POST /api/shortcode/register 或 /refresh 的 body（nowMs：校正到伺服器的現在時間，毫秒） */
export function signedShortCodeRequest(
  signer: IdentitySigner, bundle: ShortCodeBundle, action: ShortCodeAction, nowMs: number,
): Record<string, unknown> {
  const body = {
    action,
    public_key: signer.publicKey,
    signed_pre_key: bundle.signedPreKey,
    signature: bundle.preKeySignature,
    display_name: bundle.displayName,
    timestamp: Math.floor(nowMs / 1000),
    request_id: requestId(),
  };
  const requestSignature = bytesToBase64(signer.sign(new TextEncoder().encode(canonicalJson(body))));
  return { ...body, request_signature: requestSignature };
}

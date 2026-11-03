/**
 * FriendCode - 好友短碼元件
 *
 * 透過 VPS 產生 6 位短碼，24 小時過期
 * 取代舊的 Base64 長碼，方便記憶和分享
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useApp } from '../../providers/AppProvider';
import { useChatStore } from '@stores/chatStore';
import { useLanguage } from '../../i18n';
import { rememberShortCode } from '../../services/friendInvites';
import { mqttService } from '../../services/mqtt';
import { signedShortCodeRequest } from '../../services/shortcodeRequest';
// 伺服器是執行期選的那一台（開源第 5c 步）：沒有寫死的 API 網址
import { apiBase } from '../../services/apiBase';
const SHORTCODE_PREFIX = 'ATK-';

interface ShortCodeResponse {
  short_code: string;
  expires_at: number;
  remaining_seconds: number;
  is_new: boolean;
}

interface FriendCodeProps {
  onCodeGenerated?: (code: string) => void;
  onError?: (error: string) => void;
}

export function FriendCode({ onCodeGenerated, onError }: FriendCodeProps) {
  const { publicKey, signedPreKey, cryptoReady } = useApp();
  const displayName = useChatStore((state) => state.userProfile.displayName);
  const { t } = useLanguage();

  const [shortCode, setShortCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [countdown, setCountdown] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // 向 VPS 註冊/取得短碼
  const fetchShortCode = useCallback(async (forceRefresh = false) => {
    if (!publicKey || !signedPreKey) {
      const errMsg = t('friendCode.keysNotReady');
      setError(errMsg);
      onError?.(errMsg);
      return;
    }

    // 請求由帳戶金鑰簽（伺服器 api/chat/shortcode.py 驗；以前不驗簽，知道我公鑰的人就能換掉我短碼背後的預備金鑰）
    const signer = mqttService.identitySignerFor(publicKey);
    if (!signer) {
      const errMsg = t('friendCode.keysNotReady');
      setError(errMsg);
      onError?.(errMsg);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const endpoint = forceRefresh ? '/api/shortcode/refresh' : '/api/shortcode/register';
      const bundle = {
        signedPreKey: signedPreKey.publicKeyBase64,
        preKeySignature: signedPreKey.signatureBase64,
        displayName: displayName || `User ${publicKey.slice(0, 6)}`,
      };
      // 每次重送都重簽（新的 request_id）：
      //   401 clock_skew → 照伺服器給的時間校正一次再簽（手機時鐘差、MQTT 還沒拿到 serverTime）
      //   403 → 帳號還在建立（官方站：AegisID 註冊在進聊天之後才在背景跑完）：隔一下再試，最多 4 次
      let clockFixMs = 0;
      let res: Response;
      for (let attempt = 1; ; attempt++) {
        res = await fetch(`${apiBase()}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signedShortCodeRequest(signer, bundle, forceRefresh ? 'refresh_shortcode' : 'register_shortcode',
            mqttService.serverNow() + clockFixMs)),
        });
        if (res.ok || attempt >= 4) break;
        if (res.status === 401 && clockFixMs === 0) {
          const detail = (await res.json().catch(() => null))?.detail;
          if (detail?.code === 'clock_skew' && typeof detail.server_time === 'number') {
            clockFixMs = detail.server_time * 1000 - mqttService.serverNow();
            continue;
          }
        }
        if (res.status !== 403) break;
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      }

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const data: ShortCodeResponse = await res.json();
      // 記下發出去的短碼：之後用它加我的人帶這個碼算的 proof 來，我才認得是透過我的碼（稽核 H2）。
      //   認到伺服器到期＋24 小時（broker 佇列）；按「重新產生」成功 → 以前的碼馬上作廢（審查 M3）
      if (typeof data.short_code === 'string') {
        rememberShortCode(publicKey, data.short_code, data.expires_at * 1000, { replacePrevious: forceRefresh });
      }
      setShortCode(data.short_code);
      setExpiresAt(data.expires_at);
      setError(null);
      onCodeGenerated?.(`${SHORTCODE_PREFIX}${data.short_code}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t('friendCode.generateFailed');
      setError(errMsg);
      onError?.(errMsg);
    } finally {
      setIsLoading(false);
    }
  }, [publicKey, signedPreKey, displayName, onCodeGenerated, onError, t]);

  // 自動取得短碼
  useEffect(() => {
    if (cryptoReady && publicKey && signedPreKey && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchShortCode();
    }
  }, [cryptoReady, publicKey, signedPreKey, fetchShortCode]);

  // 倒數計時
  useEffect(() => {
    if (!expiresAt) return;

    const updateCountdown = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = expiresAt - now;

      if (remaining <= 0) {
        setCountdown(t('friendCode.expired'));
        setShortCode(null);
        fetchedRef.current = false;
        return;
      }

      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      setCountdown(`${hours}h ${String(minutes).padStart(2, '0')}m`);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 60_000); // 每分鐘更新
    return () => clearInterval(timer);
  }, [expiresAt, t]);

  // 複製短碼
  const handleCopy = useCallback(async () => {
    if (!shortCode) return;
    const fullCode = `${SHORTCODE_PREFIX}${shortCode}`;

    try {
      await navigator.clipboard.writeText(fullCode);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = fullCode;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  }, [shortCode]);

  // 分享短碼
  const handleShare = useCallback(async () => {
    if (!shortCode) return;
    const fullCode = `${SHORTCODE_PREFIX}${shortCode}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'AegisTalk',
          text: t('friendCode.shareText', { code: fullCode }),
        });
      } catch {
        handleCopy();
      }
    } else {
      handleCopy();
    }
  }, [shortCode, handleCopy, t]);

  // 刷新短碼
  const handleRefresh = useCallback(() => {
    fetchedRef.current = false;
    fetchShortCode(true);
  }, [fetchShortCode]);

  if (!cryptoReady) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-on-surface-secondary">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* 標題 */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-on-surface-primary">{t('friendCode.shareHint')}</h3>
      </div>

      {/* 短碼顯示 */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-6">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-on-surface-secondary text-sm">{t('friendCode.generating')}</span>
        </div>
      ) : shortCode ? (
        <div className="w-full">
          <div className="p-4 bg-surface-tertiary rounded-xl text-center">
            <p className="text-xl tracking-[0.2em] text-on-surface-primary font-mono whitespace-nowrap">
              {SHORTCODE_PREFIX}{shortCode}
            </p>
            <div className="flex items-center justify-center gap-2 mt-2">
              <svg className="w-3.5 h-3.5 text-on-surface-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-xs text-on-surface-tertiary">
                {countdown}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="py-4 text-center">
          <p className="text-on-surface-secondary text-sm mb-3">{t('friendCode.expired')}</p>
          <button
            onClick={handleRefresh}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium"
          >
            {t('friendCode.regenerate')}
          </button>
        </div>
      )}

      {/* 錯誤 */}
      {error && (
        <div className="w-full px-4 py-3 bg-red-500/20 rounded-lg">
          <p className="text-sm text-red-400 text-center">{error}</p>
        </div>
      )}

      {/* 操作按鈕 */}
      {shortCode && (
        <div className="flex gap-3 w-full">
          <button
            onClick={handleCopy}
            className={`
              flex-1 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-1.5
              ${isCopied
                ? 'bg-green-500/20 text-green-400'
                : 'bg-accent hover:opacity-90 text-white'
              }
            `}
          >
            {isCopied ? (
              <>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {t('friendCode.copied')}
              </>
            ) : (
              <>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                {t('friendCode.copy')}
              </>
            )}
          </button>
          <button
            onClick={handleShare}
            className="flex-1 px-3 py-2.5 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            {t('friendCode.share')}
          </button>
          <button
            onClick={handleRefresh}
            className="px-3 py-2.5 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-lg text-sm font-medium transition-colors flex items-center justify-center"
            title={t('friendCode.regenerate')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 檢查是否為短碼格式 (ATK-XXXXXX)
 */
export function isShortCode(text: string): boolean {
  const cleaned = text.trim().toUpperCase();
  return /^ATK-[A-Z2-9]{6}$/.test(cleaned);
}

/** 短碼查詢被伺服器限速（每 IP 每分鐘 30 次）：要跟「找不到」分開告訴使用者（部署前審查 LOW） */
export class ShortCodeRateLimitedError extends Error {
  constructor() {
    super('short code lookup rate limited');
    this.name = 'ShortCodeRateLimitedError';
  }
}

/**
 * 透過 VPS API 查詢短碼。找不到／過期／網路錯誤回 null；被限速（429）丟 ShortCodeRateLimitedError
 */
export async function lookupShortCode(code: string): Promise<{
  v: number;
  pk: string;
  spk: string;
  sig: string;
  name: string;
  expires_at?: number;
} | null> {
  const cleaned = code.trim().toUpperCase().replace(/^ATK-/, '');
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/shortcode/lookup/${cleaned}`);
  } catch {
    return null;
  }
  if (res.status === 429) throw new ShortCodeRateLimitedError();
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// 舊的 aegis:base64 長碼（parseFriendCode／isFriendCode）2026-10-15 拿掉：App 早就不再產生，碼主人那邊也沒有
// 記錄可對 —— 收端只認自己發出的短碼／QR nonce，用長碼加一定被拒收。App 還沒上線，沒有已分享出去的舊碼要相容。

export default FriendCode;

/**
 * QRCodeVerification - QR Code 好友驗證元件
 *
 * 用於面對面驗證好友身份，產生和顯示驗證 QR Code
 * 使用 X3DH 格式：包含 IdentityKey + SignedPreKey
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../providers/AppProvider';
import { useChatStore } from '@stores/chatStore';
import QRCode from 'qrcode';
import { useLanguage } from '../../i18n';
import { issueQrInvite, qrScreenTick } from '../../services/friendInvites';

// QR Code 資料結構 (與 AddFriendModal 掃描格式一致)
// v2: 加入時間戳和過期時間，修復安全性問題
interface QRCodeData {
  v: number;      // 版本號 (2 = 安全版本)
  pk: string;     // Ed25519 公鑰 (Base64)
  spk: string;    // SignedPreKey 公鑰 (Base64)
  sig: string;    // SignedPreKey 簽名 (Base64)
  name: string;   // 用戶名稱
  ts: number;     // 產生時間戳 (Unix ms)
  exp: number;    // 過期時間戳 (Unix ms)
  n: string;      // 這張 QR 的 nonce：5 分鐘內掃的人（可多人）加我時帶回來，我才把他記成「已驗證」（稽核 H2）；舊版掃描端會忽略此欄位
}

interface QRCodeVerificationProps {
  onVerified?: (publicKey: string, verificationCode: string) => void;
  onError?: (error: string) => void;
}

export function QRCodeVerification({
  onVerified: _onVerified,
  onError,
}: QRCodeVerificationProps) {
  const { t } = useLanguage();
  const { publicKey, signedPreKey, cryptoReady } = useApp();
  const displayName = useChatStore((state) => state.userProfile.displayName);

  /** 畫面上這一張：圖與到期時間（5 分鐘一張，到期就換新的，不留一張失效的碼在畫面上） */
  const [qr, setQr] = useState<{ image: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isGeneratingQR, setIsGeneratingQR] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generatingRef = useRef(false);

  // 產生 QR Code (X3DH 格式)：每張一個新 nonce，5 分鐘內誰掃都認；舊的那張只認到它自己的 5 分鐘（＋寬限）
  const generateQR = useCallback(async () => {
    if (!publicKey || !signedPreKey) {
      setError(t('friendCode.keysNotReady'));
      return;
    }
    if (generatingRef.current) return;   // 到期那一秒可能 tick 不只一次，只產一張
    generatingRef.current = true;
    setIsGeneratingQR(true);
    setError(null);

    try {
      // 建立安全的 QR 資料 (v2: 含時間戳和過期時間)
      const invite = issueQrInvite(publicKey);
      const qrData: QRCodeData = {
        v: 2,  // v2 = 安全版本，掃描時會驗證時間
        pk: publicKey,
        spk: signedPreKey.publicKeyBase64,
        sig: signedPreKey.signatureBase64,
        name: displayName || t('addFriend.unnamedUser', { id: publicKey.slice(0, 6) }),
        ts: invite.issuedAt,
        exp: invite.expiresAt,
        n: invite.nonce,
      };

      const jsonData = JSON.stringify(qrData);

      // 產生 QR Code
      const qrCodeDataUrl = await QRCode.toDataURL(jsonData, {
        width: 280,
        margin: 2,
        color: {
          dark: '#000000', // 黑色，提高掃描成功率
          light: '#FFFFFF',
        },
        errorCorrectionLevel: 'M',
      });

      setQr({ image: qrCodeDataUrl, expiresAt: invite.expiresAt });
      setNow(Date.now());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('friendCode.generateFailed');
      setError(errorMsg);
      onError?.(errorMsg);
    } finally {
      generatingRef.current = false;
      setIsGeneratingQR(false);
    }
  }, [publicKey, signedPreKey, displayName, onError, t]);

  // 打開畫面（含關掉再開）就產生新的一張；失敗就停在錯誤畫面等使用者按重試，不無限重試
  useEffect(() => {
    if (cryptoReady && publicKey && signedPreKey && !qr && !isGeneratingQR && !error) {
      void generateQR();
    }
  }, [cryptoReady, publicKey, signedPreKey, qr, isGeneratingQR, error, generateQR]);

  // 每秒更新倒數；到期就換新的一張。用牆上時間算：App 在背景時計時器會停，
  // 回到前景那一刻（visibilitychange）馬上檢查，不顯示已失效的碼
  useEffect(() => {
    if (!qr || error) return;   // 換新失敗：停在錯誤畫面等重試，不每秒重試
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (qrScreenTick(qr.expiresAt, at).renew) void generateQR();
    };
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [qr, error, generateQR]);

  const handleRefresh = () => {
    void generateQR();
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // 這一張到期了（新的還在產生）就不畫出來
  const view = qr ? qrScreenTick(qr.expiresAt, now) : null;
  const showQr = !!view && !view.renew;

  // 載入中（第一張還沒好）
  if (!cryptoReady || (isGeneratingQR && !qr)) {
    return (
      <div className="flex flex-col items-center gap-4 p-6">
        <div className="w-12 h-12 border-4 border-mist-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-on-surface-secondary">{t('friendCode.qrGenerating')}</p>
      </div>
    );
  }

  // 錯誤
  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 p-6">
        <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <p className="text-red-400">{error}</p>
        <button
          onClick={handleRefresh}
          className="px-4 py-2 bg-mist-500 hover:bg-mist-600 text-white rounded-lg transition-colors"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 p-6">
      {/* 標題 */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-on-surface-primary">{t('friendCode.myQrTitle')}</h3>
        <p className="text-sm text-on-surface-tertiary mt-1">{t('friendCode.myQrHint')}</p>
      </div>

      {/* QR Code（到期會自動換新的一張，沒有「過期」畫面） */}
      <div className="p-4 bg-white rounded-2xl shadow-lg">
        {showQr && qr ? (
          <img src={qr.image} alt={t('friendCode.qrAlt')} className="w-[280px] h-[280px]" />
        ) : (
          <div className="w-[280px] h-[280px] bg-surface-elevated animate-pulse rounded-lg" />
        )}
      </div>

      {/* 公鑰縮寫顯示 */}
      {publicKey && (
        <div className="text-center">
          <p className="text-sm text-on-surface-tertiary mb-2">{t('friendCode.myId')}</p>
          <code className="px-4 py-2 bg-surface-tertiary rounded-lg text-sm font-mono text-mist-400">
            {publicKey.slice(0, 12)}...{publicKey.slice(-8)}
          </code>
        </div>
      )}

      {/* 倒數：這張還剩多久換新的一張；下面一行說明 5 分鐘一張、可多人掃 */}
      <div className="flex flex-col items-center gap-1 text-on-surface-tertiary">
        {view && showQr && (
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm">{t('friendCode.qrRefreshesIn', { time: formatTime(view.secondsLeft) })}</span>
          </div>
        )}
        <p className="text-xs text-center">{t('friendCode.qrRefreshHint')}</p>
      </div>

      {/* 刷新按鈕（舊的那張照樣認到它自己的 5 分鐘） */}
      <button
        onClick={handleRefresh}
        className="px-4 py-2 text-on-surface-tertiary hover:text-on-surface-primary transition-colors flex items-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {t('friendCode.regenerate')}
      </button>
    </div>
  );
}

export default QRCodeVerification;

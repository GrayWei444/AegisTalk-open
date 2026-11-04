/**
 * 加好友彈窗送出 X3DH_INIT 之後的狀態（程式碼審查 M1）：等對方確認 → 等太久還沒確認 → 對方確認了。
 * 對方收下 INIT 會回 PROFILE_UPDATE，收到才算加成功（見 stores/pendingFriendStore）。不是錯誤，不用紅字。
 */
import { useLanguage } from '../../i18n';
import type { PendingVia } from '../../stores/pendingFriendStore';

interface FriendConfirmStatusProps {
  phase: 'waiting' | 'unconfirmed' | 'confirmed';
  name: string;
  via: PendingVia;
  /** 本機加好了、雲端備份暫時沒同步（會自動重試） */
  syncFailed?: boolean;
}

export function FriendConfirmStatus({ phase, name, via, syncFailed }: FriendConfirmStatusProps) {
  const { t } = useLanguage();
  const text = phase === 'confirmed'
    ? t('friendConfirm.added', { name })
    : phase === 'waiting'
      ? t('friendConfirm.waiting', { name })
      : t(via === 'qr' ? 'friendConfirm.notConfirmedQr' : 'friendConfirm.notConfirmedCode', { name });

  return (
    <div className="flex flex-col items-center gap-3 text-center px-2">
      {phase === 'confirmed' ? (
        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
          <svg className="w-10 h-10 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      ) : phase === 'waiting' ? (
        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      ) : (
        <div className="w-16 h-16 bg-yellow-500/20 rounded-full flex items-center justify-center">
          <svg className="w-9 h-9 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      )}
      <p className={`text-sm ${phase === 'confirmed' ? 'text-green-400 font-medium' : phase === 'waiting' ? 'text-accent' : 'text-yellow-400'}`}>
        {text}
      </p>
      {syncFailed && (
        <p className="text-xs text-on-surface-tertiary">{t('friendConfirm.syncFailed')}</p>
      )}
    </div>
  );
}

export default FriendConfirmStatus;

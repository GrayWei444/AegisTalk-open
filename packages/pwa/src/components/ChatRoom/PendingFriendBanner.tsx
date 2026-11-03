/**
 * 聊天室頂端：我加了他、他還沒確認（程式碼審查 M1）。
 * 他收下我的 X3DH_INIT 之前，傳過去的訊息要等他確認才收得到；一直沒確認（憑證過期、被拒），訊息就到不了 ——
 * 說清楚，並讓使用者取消（＝刪掉這個好友，走聊天室原本的刪好友確認）。他確認了這條就自己消失。
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../i18n';
import { usePendingFriendStore, findPending, addFriendPhase, FRIEND_CONFIRM_WAIT_MS } from '../../stores/pendingFriendStore';

interface PendingFriendBannerProps {
  owner: string;
  friendPublicKey: string;
  friendName: string;
  onCancel: () => void;
}

export function PendingFriendBanner({ owner, friendPublicKey, friendName, onCancel }: PendingFriendBannerProps) {
  const { t } = useLanguage();
  const entry = usePendingFriendStore((s) => findPending(s.entries, owner, friendPublicKey));
  const [, setTick] = useState(0);

  // 等滿 2 分鐘：重畫一次，改說「對方還沒確認…」
  useEffect(() => {
    if (!entry) return;
    const left = entry.since + FRIEND_CONFIRM_WAIT_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [entry]);

  if (!entry) return null;
  const phase = addFriendPhase(entry.since, true, Date.now());
  const text = phase === 'waiting'
    ? t('friendConfirm.waiting', { name: friendName })
    : t(entry.via === 'qr' ? 'friendConfirm.notConfirmedQr' : 'friendConfirm.notConfirmedCode', { name: friendName });

  return (
    <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-yellow-400/90">{text}</span>
        <button
          onClick={onCancel}
          className="shrink-0 px-3 py-1 text-xs bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
        >
          {t('friendConfirm.cancel')}
        </button>
      </div>
    </div>
  );
}

export default PendingFriendBanner;

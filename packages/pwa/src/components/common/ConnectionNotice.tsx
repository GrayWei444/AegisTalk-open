/**
 * ConnectionNotice — MQTT 連線的提示橫幅（審查 2a）。
 *
 * mqtt.ts 用 `aegis:mqtt-notice` 事件通知：
 *  - { kind: 'clock-skew', minutes }：手機時鐘差太多，用伺服器時間重簽了還是被拒（以前只會每分鐘默默 401 一次）
 *  - { kind: 'clock-ok' }：之後連上了 → 收起來
 *  - { kind: 'clock-drift', minutes }：連得上，但手機時鐘差超過 5 分鐘：群組通話、成員／好友在線可能收不到或不準（W5）
 *  - { kind: 'clock-drift-ok' }：回到 5 分鐘內 → 收起來
 *  - { kind: 'scope-overflow', groups, max }：群組超過 token 上限，最不活躍的那幾個收不到即時的成員異動
 *  - { kind: 'scope-ok' }：不再超過 → 收起來
 *  - { kind: 'call-unverified', reason }：1 對 1 通話的 DTLS 指紋對不上／驗不了，掛斷了（開源第 4 步，voiceCall）
 *  - { kind: 'link-unverified', reason }：跟聯絡人的直連（DataChannel）指紋對不上，拆掉了（webrtc；訊息照樣端對端加密、改走新連線）
 *  - { kind: 'group-call-unverified', reason }：群組通話裡跟某位參與者的連線指紋對不上，拆掉那一條（開源第 5d 步，groupCallService）
 * 使用者可以關掉；數字變了（或再發生）會再出現。
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '../../i18n/context';

interface Notices {
  clockMinutes?: number;
  driftMinutes?: number;
  overflow?: { count: number; max: number };
  /** 連線的安全檢查（DTLS 指紋）沒過：call ＝ 通話被掛斷、groupCall ＝ 群組通話裡一位參與者被拆掉、link ＝ 直連被拆掉 */
  security?: 'call' | 'groupCall' | 'link';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function apply(prev: Notices, detail: unknown): Notices {
  if (!detail || typeof detail !== 'object') return prev;
  const d = detail as { kind?: unknown; minutes?: unknown; groups?: unknown; max?: unknown };
  switch (d.kind) {
    case 'clock-skew':
      return finite(d.minutes) ? { ...prev, clockMinutes: Math.max(1, Math.round(d.minutes)) } : prev;
    case 'clock-ok':
      return { ...prev, clockMinutes: undefined };
    case 'clock-drift':
      return finite(d.minutes) ? { ...prev, driftMinutes: Math.max(1, Math.round(d.minutes)) } : prev;
    case 'clock-drift-ok':
      return { ...prev, driftMinutes: undefined };
    case 'scope-overflow':
      return finite(d.groups) && finite(d.max) && d.groups > 0
        ? { ...prev, overflow: { count: Math.round(d.groups), max: Math.round(d.max) } } : prev;
    case 'scope-ok':
      return { ...prev, overflow: undefined };
    case 'call-unverified':
      return { ...prev, security: 'call' };
    case 'group-call-unverified':
      return prev.security === 'call' ? prev : { ...prev, security: 'groupCall' };
    case 'link-unverified':
      return prev.security === 'call' || prev.security === 'groupCall' ? prev : { ...prev, security: 'link' };
    default:
      return prev;
  }
}

function Banner({ title, body, dismiss, onDismiss }: { title: string; body: string; dismiss: string; onDismiss: () => void }) {
  return (
    <div className="mx-auto max-w-md mt-2 rounded-xl bg-amber-500 text-white shadow-lg px-4 py-3" role="alert">
      <p className="font-semibold">{title}</p>
      <p className="text-sm text-white/90 mt-1 leading-relaxed">{body}</p>
      <div className="flex justify-end mt-2">
        <button
          onClick={onDismiss}
          className="px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-sm font-medium transition-colors"
        >
          {dismiss}
        </button>
      </div>
    </div>
  );
}

export function ConnectionNotice() {
  const { t } = useLanguage();
  const [notices, setNotices] = useState<Notices>({});

  useEffect(() => {
    const onNotice = (event: Event) => setNotices((prev) => apply(prev, (event as CustomEvent).detail));
    window.addEventListener('aegis:mqtt-notice', onNotice);
    return () => window.removeEventListener('aegis:mqtt-notice', onNotice);
  }, []);

  if (notices.clockMinutes === undefined && notices.driftMinutes === undefined && !notices.overflow && !notices.security) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[9998] px-4 pt-[env(safe-area-inset-top)]">
      {notices.clockMinutes !== undefined && (
        <Banner
          title={t('connectionNotice.clockSkewTitle')}
          body={t('connectionNotice.clockSkewBody', { minutes: notices.clockMinutes })}
          dismiss={t('connectionNotice.dismiss')}
          onDismiss={() => setNotices((n) => ({ ...n, clockMinutes: undefined }))}
        />
      )}
      {notices.clockMinutes === undefined && notices.driftMinutes !== undefined && (
        <Banner
          title={t('connectionNotice.clockSkewTitle')}
          body={t('connectionNotice.clockDriftBody', { minutes: notices.driftMinutes })}
          dismiss={t('connectionNotice.dismiss')}
          onDismiss={() => setNotices((n) => ({ ...n, driftMinutes: undefined }))}
        />
      )}
      {notices.security && (
        <Banner
          title={t('connectionNotice.securityTitle')}
          body={t(notices.security === 'call' ? 'connectionNotice.callUnverifiedBody'
            : notices.security === 'groupCall' ? 'connectionNotice.groupCallUnverifiedBody' : 'connectionNotice.linkUnverifiedBody')}
          dismiss={t('connectionNotice.dismiss')}
          onDismiss={() => setNotices((n) => ({ ...n, security: undefined }))}
        />
      )}
      {notices.overflow && (
        <Banner
          title={t('connectionNotice.groupsOverflowTitle')}
          body={t('connectionNotice.groupsOverflowBody', { count: notices.overflow.count, max: notices.overflow.max })}
          dismiss={t('connectionNotice.dismiss')}
          onDismiss={() => setNotices((n) => ({ ...n, overflow: undefined }))}
        />
      )}
    </div>
  );
}

export default ConnectionNotice;

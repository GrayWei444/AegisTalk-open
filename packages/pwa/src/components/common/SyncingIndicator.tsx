/**
 * 「同步中…」指示器（LEARNINGS §14.5，抄 AegisTrans SyncingIndicator）
 * 登入後 crypto/fileTransfer 還在初始化時顯示，ready 後消失。
 * 圈圈用「圓潤塗鴉」手繪風：viewBox 48、stroke 4.5、圓角、有機開口弧，animate-spin。
 */

import { useLanguage } from '../../i18n/context';

export function SyncingIndicator({ className = '' }: { className?: string }) {
  const { t } = useLanguage();
  return (
    <div
      className={`flex items-center justify-center gap-2 py-1.5 text-mist-300 text-sm ${className}`}
      role="status"
      aria-live="polite"
    >
      <svg
        className="w-5 h-5 animate-spin"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* 手繪開口弧：兩段略帶有機弧度、缺口讓旋轉看得出來（不是完美圓） */}
        <path d="M39.5 19.5q-3.2-11-15.5-10.8-11 .2-13.8 12" />
        <path d="M8.5 28q3 11.2 15.5 11 8-.2 12-6.4" />
      </svg>
      <span>{t('chat.syncing')}</span>
    </div>
  );
}

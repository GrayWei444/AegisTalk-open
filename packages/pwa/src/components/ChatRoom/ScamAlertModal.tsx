/**
 * ScamAlertModal - 詐騙警告彈窗
 *
 * 當偵測到高風險訊息時彈出警告，而不是每條訊息都顯示 badge
 */

import { useEffect, useState } from 'react';
import type { RiskLevel, RiskResult } from '../../types';
import { useLanguage } from '../../i18n/context';

interface ScamAlertModalProps {
  /** 是否顯示 */
  isOpen: boolean;
  /** 關閉回調 */
  onClose: () => void;
  /** 風險分析結果 */
  riskResult: RiskResult;
  /** 觸發警告的訊息內容 */
  messageContent?: string;
  /** 標記為安全（非詐騙）的回調 - 僅影響此訊息 */
  onMarkSafe?: () => void;
  /** 封鎖用戶的回調 */
  onBlockUser?: () => void;
  /** 檢舉並封鎖的回調 */
  onReportAndBlock?: () => void;
}

const getRiskStyle = (riskLevel: RiskLevel) => {
  switch (riskLevel) {
    case 'critical':
      return {
        icon: '\u{1F6D1}',
        titleKey: 'risk.criticalRiskWarning' as const,
        color: 'bg-red-600',
        borderColor: 'border-red-600',
        textColor: 'text-red-600',
      };
    case 'high':
      return {
        icon: '\u{26A0}\u{FE0F}',
        titleKey: 'risk.highRiskWarning' as const,
        color: 'bg-red-500',
        borderColor: 'border-red-500',
        textColor: 'text-red-500',
      };
    case 'medium':
      return {
        icon: '\u{26A1}',
        titleKey: 'risk.mediumRiskWarning' as const,
        color: 'bg-orange-500',
        borderColor: 'border-orange-500',
        textColor: 'text-orange-500',
      };
    default:
      return {
        icon: '\u{1F4A1}',
        titleKey: 'risk.riskWarning' as const,
        color: 'bg-yellow-500',
        borderColor: 'border-yellow-500',
        textColor: 'text-yellow-500',
      };
  }
};

export function ScamAlertModal({
  isOpen,
  onClose,
  riskResult,
  messageContent,
  onMarkSafe,
  onBlockUser,
  onReportAndBlock,
}: ScamAlertModalProps) {
  const { t } = useLanguage();
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const config = getRiskStyle(riskResult.riskLevel);

  const handleClose = () => {
    setIsAnimating(false);
    setTimeout(onClose, 200);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 transition-opacity duration-200 ${
        isAnimating ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClose}
    >
      <div
        className={`bg-surface-secondary rounded-2xl max-w-sm w-full shadow-xl transform transition-all duration-200 max-h-[90vh] overflow-y-auto ${
          isAnimating ? 'scale-100' : 'scale-95'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`${config.color} text-white p-4 rounded-t-2xl`}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{config.icon}</span>
            <div>
              <h2 className="text-lg font-bold">{t(config.titleKey)}</h2>
              <p className="text-sm opacity-90">{t('risk.aiDetectedSuspicious')}</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {riskResult.warnings && riskResult.warnings.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-on-surface-secondary">
                {t('risk.detectedRisks')}
              </p>
              <ul className="space-y-1">
                {riskResult.warnings.map((warning, index) => (
                  <li
                    key={index}
                    className={`flex items-start gap-2 text-sm ${config.textColor}`}
                  >
                    <span className="mt-0.5">{'\u2022'}</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {messageContent && (
            <div className="bg-surface-tertiary rounded-lg p-3">
              <p className="text-xs text-on-surface-tertiary mb-1">
                {t('risk.suspiciousContent')}
              </p>
              <p className="text-sm text-on-surface-secondary line-clamp-3">
                {messageContent}
              </p>
            </div>
          )}

          <div className={`border ${config.borderColor} rounded-lg p-3`}>
            <p className="text-sm font-medium text-on-surface-secondary mb-2">
              {t('risk.safetyAdvice')}
            </p>
            <ul className="text-xs text-on-surface-tertiary space-y-1">
              <li>{'\u2022'} {t('risk.dontClickLinks')}</li>
              <li>{'\u2022'} {t('risk.dontShareInfo')}</li>
              <li>{'\u2022'} {t('risk.verifyWithFriends')}</li>
              <li>{'\u2022'} {t('risk.callAntiScam')}</li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--surface-border)] space-y-3">
          {/* 主要操作：檢舉封鎖 + 封鎖 */}
          {(onReportAndBlock || onBlockUser) && (
            <div className="flex gap-3">
              {onReportAndBlock && (
                <button
                  onClick={() => { onReportAndBlock(); handleClose(); }}
                  className={`flex-1 py-2.5 px-4 ${config.color} text-white rounded-lg font-medium hover:opacity-90 transition-opacity`}
                >
                  {t('risk.reportAndBlock')}
                </button>
              )}
              {onBlockUser && (
                <button
                  onClick={() => { onBlockUser(); handleClose(); }}
                  className="flex-1 py-2.5 px-4 bg-surface-elevated text-on-surface-secondary rounded-lg font-medium hover:bg-surface-tertiary transition-colors border border-[var(--surface-border)]"
                >
                  {t('risk.blockUser')}
                </button>
              )}
            </div>
          )}

          {/* 次要操作 */}
          <button
            onClick={handleClose}
            className="w-full py-2 px-4 bg-surface-tertiary text-on-surface-secondary rounded-lg font-medium hover:bg-surface-elevated transition-colors"
          >
            {t('risk.iKnow')}
          </button>

          {onMarkSafe && (
            <button
              onClick={() => { onMarkSafe(); handleClose(); }}
              className="w-full py-2 px-4 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
            >
              {t('risk.notScamIgnore')}
            </button>
          )}

          {/* 165 改為文字提示 */}
          <p className="text-xs text-center text-on-surface-tertiary">
            {t('risk.antiScamHint')}
          </p>
        </div>
      </div>
    </div>
  );
}

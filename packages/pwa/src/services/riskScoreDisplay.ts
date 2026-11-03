/**
 * 聯絡人風險等級的顯示（加好友時的警告文字、等級顏色／名稱）。只做顯示：分數本身來自 ext.antiFraud.contactRisk
 * （官方版的信任分數服務）；社群版沒有分數，這些函式不會被叫到（警告永遠不出現）。
 */
import { getServiceTranslation } from '../i18n/serviceHelper';
import type { ContactRiskLevel as RiskLevel, ContactRiskInfo as RiskScoreInfo } from '../ext/types';

/**
 * 取得風險等級的顏色
 */
export function getRiskLevelColor(level: RiskLevel): string {
  switch (level) {
    case 'high':
      return 'text-red-500 bg-red-500/20';
    case 'medium':
      return 'text-orange-500 bg-orange-500/20';
    case 'low':
      return 'text-yellow-500 bg-yellow-500/20';
    case 'safe':
    default:
      return 'text-green-500 bg-green-500/20';
  }
}

/**
 * 取得風險等級的名稱
 */
export function getRiskLevelName(level: RiskLevel): string {
  const t = getServiceTranslation();
  switch (level) {
    case 'high':
      return t('riskScoreService.riskHigh');
    case 'medium':
      return t('riskScoreService.riskMedium');
    case 'low':
      return t('riskScoreService.riskLow');
    case 'safe':
    default:
      return t('riskScoreService.riskSafe');
  }
}

/**
 * 判斷是否應該顯示警告
 */
export function shouldShowWarning(info: RiskScoreInfo | null): boolean {
  if (!info) return false;
  // 對齊風險分界（medium 起 = 分數 >= 50）：單次意外（最多 +10）不會跳警告
  return info.riskLevel === 'medium' || info.riskLevel === 'high';
}

/**
 * 取得警告訊息
 */
export function getWarningMessage(info: RiskScoreInfo): string {
  const t = getServiceTranslation();
  const totalTriggers = info.l2TriggerCount + info.l3TriggerCount;

  if (info.riskLevel === 'high') {
    return t('riskScoreService.warningHigh', { count: totalTriggers });
  } else if (info.riskLevel === 'medium') {
    return t('riskScoreService.warningMedium', { count: totalTriggers });
  } else if (info.riskLevel === 'low') {
    return t('riskScoreService.warningLow');
  }

  return '';
}


/**
 * MessageContent - 訊息內容元件（含 URL 風險掃描）
 *
 * 自動偵測訊息中的 URL 並顯示風險標記：
 * - 安全連結：綠色小盾牌
 * - 可疑連結：黃色警告標記
 * - 危險連結：紅色刪除線 + 阻擋點擊 + 「封鎖」按鈕
 */

import { useMemo, useState, useEffect } from 'react';
import { ext } from '@ext';
import { isDomainBlacklisted, isDomainWhitelisted, addToUserBlacklist, addToUserWhitelist } from '../../services/domainManagement';
import { useLanguage } from '../../i18n/context';

/** URL 正則匹配 */
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

/** 從 URL 提取域名 */
function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** URL 風險評估結果快取（有大小限制） */
const URL_RISK_CACHE_MAX = 200;
const urlRiskCache = new Map<
  string,
  { riskLevel: string; riskScore: number; warnings: string[]; isBlacklisted: boolean }
>();

/** 清除 URL 風險快取（黑名單變更或 Aegis 初始化後呼叫） */
function clearUrlRiskCache(): void {
  urlRiskCache.clear();
}

async function getUrlRisk(url: string, blacklistWarning: string) {
  if (urlRiskCache.has(url)) return urlRiskCache.get(url)!;

  const domain = extractDomainFromUrl(url);
  // 用戶手動加的封鎖名單（user_blacklist）優先
  const isBlocked = domain ? await isDomainBlacklisted(domain) : false;

  let result: { riskLevel: string; riskScore: number; warnings: string[] };
  if (isBlocked) {
    result = { riskLevel: 'high', riskScore: 100, warnings: [blacklistWarning] };
  } else {
    // evaluateUrl 是 async（官方版先查它同步下來的網域黑白名單，再 fallback WASM typo/TLD/keyword 偵測）
    // 網址風險（官方版的規則引擎；社群版回 null ＝ 沒評估，不顯示盾牌）
    try {
      const evalResult = await ext.antiFraud.evaluateUrl(url);
      result = evalResult ? {
        riskLevel: evalResult.riskLevel,
        riskScore: evalResult.riskScore,
        warnings: evalResult.warnings,
      } : { riskLevel: 'unknown', riskScore: 0, warnings: [] };
    } catch {
      result = { riskLevel: 'safe', riskScore: 0, warnings: [] };
    }
  }

  const cached = { ...result, isBlacklisted: isBlocked };

  // 超過上限時移除最舊的
  if (urlRiskCache.size >= URL_RISK_CACHE_MAX) {
    const firstKey = urlRiskCache.keys().next().value;
    if (firstKey) urlRiskCache.delete(firstKey);
  }

  urlRiskCache.set(url, cached);
  return cached;
}

interface MessageContentProps {
  content: string;
}

export function MessageContent({ content }: MessageContentProps) {
  const parts = useMemo(() => {
    const matches = [...content.matchAll(URL_REGEX)];
    if (matches.length === 0) {
      return [{ type: 'text' as const, value: content }];
    }

    const result: { type: 'text' | 'url'; value: string }[] = [];
    let lastIndex = 0;

    for (const match of matches) {
      const url = match[0];
      const start = match.index!;
      if (start > lastIndex) {
        result.push({ type: 'text', value: content.slice(lastIndex, start) });
      }
      result.push({ type: 'url', value: url });
      lastIndex = start + url.length;
    }

    if (lastIndex < content.length) {
      result.push({ type: 'text', value: content.slice(lastIndex) });
    }

    return result;
  }, [content]);

  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{part.value}</span>;
        }
        return <UrlPart key={i} url={part.value} />;
      })}
    </span>
  );
}

/** 單一 URL 風險標記元件（處理非同步黑名單查詢） */
function UrlPart({ url }: { url: string }) {
  const { t } = useLanguage();
  const [risk, setRisk] = useState<{
    riskLevel: string;
    riskScore: number;
    warnings: string[];
    isBlacklisted: boolean;
  } | null>(() => urlRiskCache.get(url) ?? null);

  const blacklistWarning = t('risk.domainBlacklisted');

  useEffect(() => {
    let cancelled = false;
    getUrlRisk(url, blacklistWarning).then((r) => {
      if (!cancelled) setRisk(r);
    });
    return () => { cancelled = true; };
  }, [url, blacklistWarning]);

  // 快取命中或尚未載入時，先用安全預設值渲染（沒有網址檢查的版本不先畫「安全」盾牌）
  const r = risk ?? { riskLevel: ext.antiFraud.enabled ? 'safe' : 'unknown', riskScore: 0, warnings: [] as string[], isBlacklisted: false };
  const isHigh = r.riskLevel === 'high' || r.isBlacklisted;
  const isMedium = r.riskLevel === 'medium';

  return (
    <span className="inline">
      <a
        href={isHigh ? undefined : url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={isHigh ? (e) => e.preventDefault() : undefined}
        className={`underline break-all ${
          isHigh
            ? 'text-red-400 line-through cursor-not-allowed'
            : isMedium
            ? 'text-amber-400'
            : 'text-blue-400'
        }`}
      >
        {url}
      </a>
      {isHigh && (
        <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-red-500/20 px-1 py-0.5 text-[0.625rem] text-red-400 align-middle">
          <span>{'\u{1F6E1}\u{FE0F}'}</span> {t('risk.dangerous')}
        </span>
      )}
      {isMedium && (
        <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-amber-500/20 px-1 py-0.5 text-[0.625rem] text-amber-400 align-middle">
          <span>{'\u{26A0}\u{FE0F}'}</span> {t('risk.suspicious')}
        </span>
      )}
      {r.riskLevel === 'safe' && r.riskScore === 0 && !r.isBlacklisted && (
        <span className="ml-0.5 text-[0.625rem] text-emerald-400 align-middle">{'\u{1F6E1}\u{FE0F}'}</span>
      )}
      {isHigh && (
        <>
          <button
            onClick={async () => {
              const domain = extractDomainFromUrl(url);
              if (domain) {
                const alreadyBlocked = await isDomainBlacklisted(domain);
                if (!alreadyBlocked) {
                  await addToUserBlacklist(domain, 'manual', t('risk.blockedInChat'));
                  clearUrlRiskCache();
                }
              }
            }}
            className="ml-1 rounded bg-red-500/20 px-1.5 py-0.5 text-[0.625rem] text-red-400 hover:bg-red-500/30 align-middle"
          >
            {t('risk.blockDomain')}
          </button>
          <button
            onClick={async () => {
              const domain = extractDomainFromUrl(url);
              if (domain) {
                const alreadyWhitelisted = await isDomainWhitelisted(domain);
                if (!alreadyWhitelisted) {
                  await addToUserWhitelist(domain, t('risk.trustedInChat'));
                  clearUrlRiskCache();
                  setRisk({ riskLevel: 'safe', riskScore: 0, warnings: [], isBlacklisted: false });
                }
              }
            }}
            className="ml-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[0.625rem] text-emerald-400 hover:bg-emerald-500/30 align-middle"
          >
            {t('risk.trustDomain')}
          </button>
        </>
      )}
    </span>
  );
}

/**
 * useContactRisk — 聯絡人風險等級（VPS 風險分數 + 本地黑名單）
 *
 * 頭像外框顏色（分界與伺服器的風險分數分級一致）：
 * - safe (綠框):   risk score < 20
 * - low  (黃框):   20–49
 * - medium (橙框): 50–79
 * - high (紅框):   >= 80，或在本地黑名單上
 *
 * 伺服器的風險分數是官方版的防詐功能（ext.antiFraud）；社群版沒有分數 → 只有本地黑名單會給紅框，其他人沒有外框
 * （不畫綠框假裝「安全」）。
 */

import { useState, useEffect } from 'react';
import { isBlacklisted } from '../services/localBlacklist';
import { ext } from '@ext';
import type { ContactRiskLevel as RiskLevel } from '../ext/types';

// 全域快取（跨組件共享，減少 API 呼叫）
const riskCache = new Map<string, { level: RiskLevel | undefined; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分鐘

/** 查不到分數時的等級：有防詐分數的版本是 safe，沒有的版本是「不知道」（不畫外框） */
const unknownLevel = (): RiskLevel | undefined => (ext.antiFraud.enabled ? 'safe' : undefined);

// 查伺服器的風險分數 → RiskLevel（官方版：以 pubkey 的 sha256 查詢，server 直接回 4-band riskLevel）。
// API 不可用時是空的，用本地黑名單 fallback
function fetchRiskLevels(pubkeys: string[]): Promise<Map<string, RiskLevel>> {
  return ext.antiFraud.contactRiskLevels(pubkeys);
}

/** 單一聯絡人風險等級 */
export function useContactRisk(publicKey?: string): RiskLevel | undefined {
  const [level, setLevel] = useState<RiskLevel | undefined>(() => {
    if (!publicKey) return unknownLevel();
    const cached = riskCache.get(publicKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.level;
    return unknownLevel();
  });

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;

    (async () => {
      // 先查本地黑名單（即時）
      const blocked = await isBlacklisted(publicKey).catch(() => false);
      if (cancelled) return;
      if (blocked) {
        riskCache.set(publicKey, { level: 'high', fetchedAt: Date.now() });
        setLevel('high');
        return;
      }

      // 查 VPS 風險分數 → RiskLevel
      const levels = await fetchRiskLevels([publicKey]);
      if (cancelled) return;
      const lv = levels.get(publicKey) ?? unknownLevel();
      riskCache.set(publicKey, { level: lv, fetchedAt: Date.now() });
      setLevel(lv);
    })();

    return () => { cancelled = true; };
  }, [publicKey]);

  return level;
}

/** 批次查詢（好友列表用） */
export function useContactRiskMap(publicKeys: string[]): Map<string, RiskLevel> {
  const [map, setMap] = useState<Map<string, RiskLevel>>(new Map());

  useEffect(() => {
    if (publicKeys.length === 0) return;
    let cancelled = false;

    (async () => {
      const result = new Map<string, RiskLevel>();
      const known = new Set<string>();   // 快取還新鮮的（等級可能是「不知道」，那就不放進 result）

      // 先查本地黑名單 / 快取
      for (const pk of publicKeys) {
        const cached = riskCache.get(pk);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          if (cached.level) result.set(pk, cached.level);
          known.add(pk);
          continue;
        }
        const blocked = await isBlacklisted(pk).catch(() => false);
        if (blocked) {
          riskCache.set(pk, { level: 'high', fetchedAt: Date.now() });
          result.set(pk, 'high');
        }
      }

      // 未查到的去 VPS 批次查
      const uncached = publicKeys.filter(pk => !result.has(pk) && !known.has(pk));
      if (uncached.length > 0) {
        const levels = await fetchRiskLevels(uncached);
        for (const pk of uncached) {
          const lv = levels.get(pk) ?? unknownLevel();
          riskCache.set(pk, { level: lv, fetchedAt: Date.now() });
          if (lv) result.set(pk, lv);
        }
      }

      if (!cancelled) setMap(result);
    })();

    return () => { cancelled = true; };
  }, [publicKeys.join(',')]);

  return map;
}

/** 清除快取（封鎖/解封後呼叫） */
export function invalidateRiskCache(publicKey?: string) {
  if (publicKey) {
    riskCache.delete(publicKey);
  } else {
    riskCache.clear();
  }
}

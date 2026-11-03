import { devLog } from '../utils/devLog';
import { create } from 'zustand';
import * as db from '../services/database';

/**
 * Policy Store - AegisTalk 訂閱方案管理
 *
 * 兩種方案：
 * - free: 基本通訊 + 有限好友 (20人) + 有限群組 (3個)
 * - premium: 無限好友 + 無限群組 + 完整 AI 防詐
 *
 * 注意：AegisTalk 不包含天氣偽裝和閱後即焚功能
 */

export type PolicyLevel = 'free' | 'premium';

// 儲存 key
const POLICY_STORAGE_KEY = 'aegistalk_policy';

// 功能定義
export interface PolicyFeatures {
  // 基本功能 (所有方案)
  oneToOneChat: boolean;
  voiceCall: boolean;
  offlineMessage: boolean;
  e2eEncryption: boolean;

  // Premium 功能
  unlimitedFriends: boolean;
  groupChat: boolean;
  nestedGroups: boolean;

  // AI 防詐功能 (所有方案都有基本防護)
  l2RuleEngine: boolean;      // L2 規則引擎
  l3BehaviorAI: boolean;      // L3 行為 AI
  voiceRiskAnalysis: boolean; // 語音風險分析
  advancedAlerts: boolean;    // 進階警示
}

// 各方案的功能配置
const POLICY_FEATURES: Record<PolicyLevel, PolicyFeatures> = {
  free: {
    // 基本功能
    oneToOneChat: true,
    voiceCall: true,
    offlineMessage: true,
    e2eEncryption: true,

    // 限制功能
    unlimitedFriends: false,  // 最多 20 位好友
    groupChat: true,          // 可以使用群組，但最多 3 個
    nestedGroups: false,

    // AI 防詐 (基本)
    l2RuleEngine: true,       // 基本規則檢測
    l3BehaviorAI: false,      // 需要 Premium
    voiceRiskAnalysis: false, // 需要 Premium
    advancedAlerts: false,    // 需要 Premium
  },
  premium: {
    // 基本功能
    oneToOneChat: true,
    voiceCall: true,
    offlineMessage: true,
    e2eEncryption: true,

    // 完整功能
    unlimitedFriends: true,
    groupChat: true,
    nestedGroups: true,

    // AI 防詐 (完整)
    l2RuleEngine: true,
    l3BehaviorAI: true,
    voiceRiskAnalysis: true,
    advancedAlerts: true,
  },
};

// 方案顯示資訊
export const POLICY_INFO: Record<PolicyLevel, { name: string; price: string; description: string }> = {
  free: {
    name: 'Free',
    price: 'NT$0',
    description: '基本防詐保護',
  },
  premium: {
    name: 'Premium',
    price: 'NT$30/月',
    description: '完整 AI 防詐 + 群組',
  },
};

// 方案限制
export const POLICY_LIMITS = {
  free: {
    maxFriends: 20,
    maxGroups: 3,
  },
  premium: {
    maxFriends: Infinity,
    maxGroups: Infinity,
  },
};

interface PolicyState {
  // 當前方案
  currentPolicy: PolicyLevel;

  // 訂閱資訊
  subscriptionId: string | null;
  expiresAt: number | null; // timestamp

  // 功能開關
  features: PolicyFeatures;

  // Actions
  setPolicy: (policy: PolicyLevel) => void;
  setSubscription: (subscriptionId: string, expiresAt: number) => void;
  clearSubscription: () => void;
  hasFeature: (feature: keyof PolicyFeatures) => boolean;
  loadFromStorage: () => Promise<void>;
}

// 從 localStorage 載入
function loadPolicy(): { policy: PolicyLevel; subscriptionId: string | null; expiresAt: number | null } {
  try {
    const saved = localStorage.getItem(POLICY_STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      // 檢查訂閱是否過期
      if (data.expiresAt && data.expiresAt < Date.now()) {
        // 訂閱過期，降級為 free
        return { policy: 'free', subscriptionId: null, expiresAt: null };
      }
      return data;
    }
  } catch (e) {
    console.error('[policyStore] Failed to load policy:', e);
  }
  return { policy: 'free', subscriptionId: null, expiresAt: null };
}

// 保存到 localStorage + SQLite
function savePolicy(data: { policy: PolicyLevel; subscriptionId: string | null; expiresAt: number | null }): void {
  try {
    localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('[policyStore] Failed to save policy:', e);
  }
  db.setSetting(POLICY_STORAGE_KEY, JSON.stringify(data)).catch(() => {});
}

export const usePolicyStore = create<PolicyState>((set, get) => {
  const initial = loadPolicy();

  return {
    currentPolicy: initial.policy,
    subscriptionId: initial.subscriptionId,
    expiresAt: initial.expiresAt,
    features: POLICY_FEATURES[initial.policy],

    setPolicy: (policy: PolicyLevel) => {
      const state = get();
      savePolicy({ policy, subscriptionId: state.subscriptionId, expiresAt: state.expiresAt });
      set({
        currentPolicy: policy,
        features: POLICY_FEATURES[policy],
      });
      devLog('[policyStore] Policy changed to:', policy);
    },

    setSubscription: (subscriptionId: string, expiresAt: number) => {
      const state = get();
      savePolicy({ policy: state.currentPolicy, subscriptionId, expiresAt });
      set({ subscriptionId, expiresAt });
      devLog('[policyStore] Subscription updated:', subscriptionId);
    },

    clearSubscription: () => {
      savePolicy({ policy: 'free', subscriptionId: null, expiresAt: null });
      set({
        currentPolicy: 'free',
        subscriptionId: null,
        expiresAt: null,
        features: POLICY_FEATURES.free,
      });
      devLog('[policyStore] Subscription cleared, downgraded to free');
    },

    hasFeature: (feature: keyof PolicyFeatures) => {
      return get().features[feature];
    },

    loadFromStorage: async () => {
      try {
        await db.migrateFromLocalStorage(POLICY_STORAGE_KEY);
        const saved = await db.getSetting(POLICY_STORAGE_KEY);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.expiresAt && data.expiresAt < Date.now()) {
            set({ currentPolicy: 'free', subscriptionId: null, expiresAt: null, features: POLICY_FEATURES.free });
            return;
          }
          set({
            currentPolicy: data.policy,
            subscriptionId: data.subscriptionId,
            expiresAt: data.expiresAt,
            features: POLICY_FEATURES[data.policy as PolicyLevel],
          });
        }
      } catch {
        const data = loadPolicy();
        set({
          currentPolicy: data.policy,
          subscriptionId: data.subscriptionId,
          expiresAt: data.expiresAt,
          features: POLICY_FEATURES[data.policy],
        });
      }
    },
  };
});

// 便利的 hooks
export function useHasFeature(feature: keyof PolicyFeatures): boolean {
  return usePolicyStore((state) => state.features[feature]);
}

export function useCurrentPolicy(): PolicyLevel {
  return usePolicyStore((state) => state.currentPolicy);
}

// 向後兼容的 hooks (移除的功能永遠返回 false)
export function usePrivacyMode(): boolean {
  return false; // AegisTalk 不支援隱私模式
}

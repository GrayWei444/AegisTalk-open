// 第一個 import（開源第 5c 步）：connect-src 縮到所選伺服器的 API 與 broker，在任何其他模組跑之前（services/connectPolicy.ts）
import './services/connectPolicyBoot';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppProvider } from './providers';
import { ConfigProvider, configService } from './config';
import { LanguageProvider } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Initialize theme store early to register system theme change listener
import './stores/themeStore';

// jeep-sqlite web component（Web 平台的 SQLite 支援）
import { defineCustomElements as jeepSqlite } from 'jeep-sqlite/loader';
import { devLog } from './utils/devLog';
import { isAppInitCompleted } from './utils/initFlag';
jeepSqlite(window);

// 版本可見性：啟動立刻打 build hash（console.error → prod 不砍）
// → 用來確認 gray/ding 兩台真的跑同一版,杜絕「測試其實跑舊 bundle/stale cache」的盲測。
console.error('[DIAG:BUILD] hash=' + __BUILD_HASH__);

// 初始化配置服務 (供非 React 服務使用)
// 品牌的條款／支援連結依版本（開源第 5c 步）：官方版用官方的（'@ext/server' brandLegal）；社群版沒有預設，連結來自所選伺服器
import { brandLegal } from '@ext/server';
configService.initialize(brandLegal ? { brand: { legal: brandLegal } } : undefined);

// 版本的擴充（src/ext/chat 或 src/ext-official，由建置時的 AEGIS_EDITION 決定，見 vite.config.ts）
import { ext } from '@ext';

// 身分 SDK 的儲存（官方版 AegisID：注入 database adapter，讓 SDK 使用 SQLite 而非 localStorage）
ext.identity.initStorage();

// 帳號備份：注入資料來源（從 zustand stores 投影社交圖譜；官方版 AegisID Blob Sync，社群版目前不備份）
import { useChatStore } from './stores/chatStore';
import { useGroupStore } from './stores/groupStore';
import { getGroupEngine } from './services/groupEngineHost';
ext.identity.backup.setProviders({
  /**
   * 好友清單真的載完才准寫雲端（移植群星 B24）。chatStore 在 jeep 還沒 ready 時可能先 latch「isLoaded、0 個好友」
   * （它自己會背景重載自癒）—— 所以清單是空的時候，直接問資料庫確認。登入後那一發備份改寫（官方版雲端備份的初次同步）
   * 是在好友載入之前排的，沒有這一關就可能把空的好友清單蓋上雲端。
   */
  isReady: async () => {
    const s = useChatStore.getState();
    if (!s.isLoaded) return false;
    // 群組的備份是整條狀態鏈（引擎記憶體裡的）：引擎還沒載完 → 不寫（群組畫面那時可能也還沒載，
    //   寫出去就會把雲端備份裡的群組整份蓋掉，審查 W1 M-4）；幾秒後備份服務自己再試
    if (!getGroupEngine()?.isReady()) return false;
    if (s.friends.length > 0) return true;
    try {
      const { getAllContacts } = await import('./services/storage');
      return (await getAllContacts()).length === 0;
    } catch { return false; }
  },
  getDisplayName: () => useChatStore.getState().userProfile.displayName || '',
  getContacts: () => useChatStore.getState().friends.map((f) => ({
    publicKey: f.publicKey,
    nickname: f.name,
    avatar: f.avatar,
    trustLevel: f.trustLevel,
    addedAt: f.addedAt,
    signedPreKey: f.signedPreKey,
    signature: f.signature,
  })),
  // 每個群帶整條狀態鏈（還原時重驗，見 services/groupBackup）；引擎沒有這個群的鏈就不放（沒有鏈＝沒有依據）
  getGroups: () => useGroupStore.getState().groups.flatMap((g) => {
    const log = getGroupEngine()?.backupOf(g.id);
    if (!log) return [];
    return [{
      id: g.id,
      name: g.name,
      avatar: g.avatar,
      members: g.members.map((m) => ({
        publicKey: m.publicKey,
        nickname: m.nickname,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      createdAt: g.createdAt,
      createdBy: g.createdBy,
      groupType: g.groupType,
      guardianSettings: g.guardianSettings,
      log,
    }];
  }),
});

// E2E 測試 helper：暴露 SQLite query API + 簽章驗證給 Playwright
// - query/queryOne: 驗證 DB 殘留、讀取 messages.risk_result 做 risk score 斷言
// - run: 寫入 SQL（time-travel 測試：UPDATE checkin_records SET requested_at = ? 往前推）
// - mqttConnected: MQTT 連線狀態
// - verifyEvidence: 真實驗簽（Test 22 擴充）— 給定 EvidencePackage 回傳 {valid, signatureValid, messagesHashMatch, messageHashErrors}
//   AegisTest 可翻轉一 bit（例：evidence.messages[0].content = 'tampered'）預期 valid=false
if (typeof localStorage !== 'undefined' && localStorage.getItem('AEGIS_E2E_TEST') === 'true') {
  Promise.all([
    import('./services/database'),
    import('./services/mqtt'),
    import('./services/chatExport'),
    // 官方版：防詐規則引擎的 E2E 查詢（訊息／網址評估、規則統計、系統黑白名單）；社群版沒有
    ext.antiFraud.e2eApi(),
    import('./services/webrtc'),
    import('./services/p2pSend'),
  ]).then(([db, mqttModule, chatExport, antiFraudE2E, webrtcModule, p2pSendModule]) => {
    (window as unknown as {
      __aegisE2E?: Record<string, unknown> & {
        query: typeof db.query;
        queryOne: typeof db.queryOne;
        run: typeof db.run;
        mqttConnected: () => boolean;
        verifyEvidence: typeof chatExport.verifyEvidence;
        forceClosePeer: (remotePublicKeyBase64?: string) => number;
        forceConnect: (remotePublicKeyBase64: string) => Promise<void>;
        getP2PQueueSize: (remotePublicKeyBase64: string) => Promise<number>;
        getPeerState: (remotePublicKeyBase64: string) => string;
        isFriendOnline: (remotePublicKeyBase64: string) => boolean;
        presenceStats: () => Record<string, number>;
      };
    }).__aegisE2E = {
      query: db.query,
      queryOne: db.queryOne,
      run: db.run,
      mqttConnected: () => mqttModule.mqttService.isConnected(),
      verifyEvidence: chatExport.verifyEvidence,
      ...antiFraudE2E,
      // T27 P2P 中斷測試用：強制關閉 DataChannel，模擬網路短暫斷線
      forceClosePeer: (remotePublicKeyBase64?: string) => webrtcModule.webrtcService.forceClosePeerForE2E(remotePublicKeyBase64),
      // glare 壓力測試用：強制發起連線（兩端同時呼叫 → 保證 offer 對撞 glare），驗證 glare 解析不卡 new
      forceConnect: (remotePublicKeyBase64: string) => webrtcModule.webrtcService.connect(remotePublicKeyBase64),
      // T27 輔助：P2P 佇列當前大小（flush 前應 > 0，flush 後 = 0）
      getP2PQueueSize: (remotePublicKeyBase64: string) => p2pSendModule.getQueueSize(remotePublicKeyBase64),
      // T23/T27 輔助：取得 P2P DataChannel readyState（'none'|'no-channel'|'connecting'|'open'|'closing'|'closed'）
      getPeerState: (remotePublicKeyBase64: string) => webrtcModule.webrtcService.getPeerStateForE2E(remotePublicKeyBase64),
      // W4 模擬的 PRESENCE 檢查：好友之間真的看得到彼此在線（驗過、解得開的秘密 presence）、收 presence 的計數
      isFriendOnline: (remotePublicKeyBase64: string) => mqttModule.mqttService.isFriendOnline(remotePublicKeyBase64),
      presenceStats: () => mqttModule.mqttService.presenceStats(),
    };
  });
}

// Phase 27: 確保裝置 ID 已初始化（需在 MQTT 連線前完成）
import { ensureDeviceId } from './services/deviceId';
ensureDeviceId().catch(() => {});

// （遠端除錯 remoteDebugger 拿掉了，同群星 2026-10-01：它把所有 console 輸出 —— 含群組明文的 DIAG log ——
//   串到正式 broker 的 aegis/debug/*，?debug=1 在正式站就能開。看 log 改用 logcat／Console.app／E2E 的 console，見 CLAUDE.md §12）

// 臉部辨識（官方版 AegisID）：face storage 同步、原生推論注入、啟動預載（iOS 跳過，改在 AuthScreen on-demand）；社群版沒有
ext.identity.bootModels();

// === iOS WebKit 隱藏錯誤捕捉 ===
// window.onerror 和 unhandledrejection 捕捉 React tree 外的致命錯誤
// 這些錯誤不會進入 console.error
// iOS WebKit 常在 OOM 或 JIT 失敗時拋出這類錯誤後直接重載頁面

window.onerror = (message, source, lineno, colno, error) => {
  const detail = [
    `msg=${message}`,
    `src=${source}`,
    `line=${lineno}:${colno}`,
    error?.stack ? `stack=${error.stack.slice(0, 500)}` : 'no-stack',
  ].join(' | ');
  console.error(`[DIAG:ONERROR] ${detail}`);
  return false; // 讓錯誤繼續傳播
};

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  let detail: string;
  if (reason instanceof Error) {
    detail = `${reason.constructor.name}: ${reason.message}` + (reason.stack ? ` | stack: ${reason.stack.slice(0, 500)}` : '');
  } else {
    try { detail = JSON.stringify(reason); } catch { detail = String(reason); }
  }
  console.error(`[DIAG:UNHANDLED_REJECTION] ${detail}`);
});

// 捕捉 script/resource 載入失敗（img, script, link, wasm 等）
window.addEventListener('error', (event) => {
  // 只處理資源載入錯誤（非 JS runtime error — 那些由 window.onerror 處理）
  const target = event.target as EventTarget | null;
  if (target && target !== window && target instanceof HTMLElement) {
    const tag = target.tagName;
    const src = (target as HTMLImageElement).src || (target as HTMLLinkElement).href || 'unknown';
    console.error(`[DIAG:RESOURCE_ERROR] ${tag} failed to load: ${src}`);
  }
}, true); // capture phase — 資源錯誤不冒泡，必須用 capture

// 捕捉頁面即將卸載 — 用於偵測 iOS WebKit 自動重載
window.addEventListener('beforeunload', () => {
  console.error(`[DIAG:BEFOREUNLOAD] Page unloading | uptime=${Math.round(performance.now() / 1000)}s | visibilityState=${document.visibilityState}`);
});

// 記錄頁面啟動時間，幫助確認是否為重載
console.error(`[DIAG:BOOT] Page loaded | ${new Date().toISOString()} | referrer=${document.referrer || 'none'} | navType=${performance?.getEntriesByType?.('navigation')?.[0]?.toJSON?.()?.type || 'unknown'}`);

devLog(`[AegisTalk] Starting ${configService.brand.appName} v${configService.brand.version}`);

// Service Worker 管理
// 一次性遷移：強制清掉舊 SW（有 skipWaiting），讓新 SW（無 skipWaiting）接管
// 一次性遷移：清掉舊 SW（有 skipWaiting）
// 用 cookie 存標記 — iOS 清 localStorage 但不清 cookie
if ('serviceWorker' in navigator) {
  const SW_MIGRATION_KEY = 'sw_no_skip_v1';
  const hasCookie = document.cookie.includes(SW_MIGRATION_KEY);
  const hasLS = !!localStorage.getItem(SW_MIGRATION_KEY);
  if (!hasCookie && !hasLS) {
    // 同步檢查：有沒有已註冊的 SW 要清
    navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      if (registrations.length > 0) {
        console.error('[SW] Migration: unregistering', registrations.length, 'old SWs...');
        for (const reg of registrations) {
          await reg.unregister();
        }
        console.error('[SW] Migration: done, reloading...');
      }
      // 不管有沒有 SW，都設標記防重複
      document.cookie = `${SW_MIGRATION_KEY}=1; max-age=31536000; path=/; SameSite=Lax`;
      localStorage.setItem(SW_MIGRATION_KEY, '1');
      if (registrations.length > 0) {
        window.location.reload();
      }
    }).catch((err) => {
      console.error('[SW] Migration error:', err);
    });
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.error('[PWA] New SW activated — update will apply on next app launch');
  });
}

// 處理 PWA 從背景恢復時的空白頁面問題
// 某些瀏覽器（尤其是 Android Chrome PWA）在 App 暫停後可能不會正確恢復渲染
let lastVisibilityState = document.visibilityState;
let resumeCheckTimer: ReturnType<typeof setTimeout> | null = null;
let hasReloadedThisSession = false; // 每個 session 只允許 reload 一次
const MIN_UPTIME_FOR_RELOAD_MS = 30_000; // 啟動 30 秒內不做 reload（app 仍在 settling）

// 強制重繪函數
function forceRepaint() {
  const root = document.getElementById('root');
  if (!root) return;

  // 方法 1: transform hack (觸發 GPU 重繪)
  // 注意：不使用 display:none toggle — 在 iOS 上會導致 checkAndRecover 誤判 height=0
  root.style.transform = 'translateZ(0)';
  root.offsetHeight; // 強制 reflow
  requestAnimationFrame(() => {
    root.style.transform = '';
  });

  // 方法 2: opacity toggle
  document.body.style.opacity = '0.999';
  requestAnimationFrame(() => {
    document.body.style.opacity = '1';
  });

  devLog('[PWA] Forced repaint');
}

// 檢查頁面是否空白
function checkAndRecover() {
  const root = document.getElementById('root');
  const initDone = isAppInitCompleted();
  const uptimeMs = performance.now();
  const uptimeSec = Math.round(uptimeMs / 1000);

  console.error(`[DIAG] checkAndRecover: children=${root?.children.length}, innerHTML=${root?.innerHTML.length}, initDone=${initDone}, uptime=${uptimeSec}s`);

  // 初始化尚未完成時，不做 reload（避免中斷 init flow）
  if (!initDone) {
    console.error('[DIAG] checkAndRecover: skipping — app still initializing');
    if (root) forceRepaint();
    return;
  }

  // 安全閥：啟動後 30 秒內不 reload（iOS 登入後模式切換期間 DOM 可能暫時空白）
  if (uptimeMs < MIN_UPTIME_FOR_RELOAD_MS) {
    console.error(`[DIAG] checkAndRecover: skipping reload — uptime ${uptimeSec}s < ${MIN_UPTIME_FOR_RELOAD_MS / 1000}s threshold`);
    if (root) forceRepaint();
    return;
  }

  // 每個 session 只允許 reload 一次，防止 reload 循環
  if (hasReloadedThisSession) {
    console.error('[DIAG] checkAndRecover: skipping — already reloaded this session');
    if (root) forceRepaint();
    return;
  }

  // 檢查 1: root 是否有子元素
  if (root && root.children.length === 0) {
    console.error(`[DIAG:RELOAD] checkAndRecover: root empty → reloading | visibilityState=${document.visibilityState} | uptime=${uptimeSec}s | href=${location.href}`);
    hasReloadedThisSession = true;
    setTimeout(() => window.location.reload(), 500);
    return;
  }

  // 檢查 2: 檢查是否有可見內容 (某些情況下 children 存在但不可見)
  if (root) {
    const rect = root.getBoundingClientRect();
    const hasVisibleContent = rect.height > 0 && root.innerHTML.length > 100;

    if (!hasVisibleContent) {
      console.error(`[DIAG] checkAndRecover: no visible content (h=${rect.height}, len=${root.innerHTML.length}), forcing repaint...`);
      forceRepaint();

      // 如果 2 秒後還是空白，才重載（從 500ms 放寬到 2s，給 iOS 更多恢復時間）
      setTimeout(() => {
        const newRect = root.getBoundingClientRect();
        if (newRect.height === 0) {
          console.error(`[DIAG:RELOAD] checkAndRecover: still blank after 2s → reloading | uptime=${Math.round(performance.now() / 1000)}s`);
          hasReloadedThisSession = true;
          setTimeout(() => window.location.reload(), 500);
        } else {
          console.error(`[DIAG] checkAndRecover: recovered after repaint (h=${newRect.height})`);
        }
      }, 2000);
      return;
    }

    // 有內容，只做 repaint
    forceRepaint();
  }
}

document.addEventListener('visibilitychange', () => {
  const currentState = document.visibilityState;
  devLog(`[PWA] Visibility changed: ${lastVisibilityState} -> ${currentState}`);

  if (currentState === 'visible' && lastVisibilityState === 'hidden') {
    // 從背景恢復到前景
    devLog('[PWA] App resumed from background');

    // 清除之前的 timer
    if (resumeCheckTimer) {
      clearTimeout(resumeCheckTimer);
    }

    // 立即嘗試 repaint
    forceRepaint();

    // 延遲檢查並恢復
    resumeCheckTimer = setTimeout(checkAndRecover, 100);

    // 再次檢查（某些設備需要更長時間）
    setTimeout(checkAndRecover, 500);
  }

  lastVisibilityState = currentState;
});

// 額外處理: pageshow 事件 (bfcache 恢復)
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    devLog('[PWA] Page restored from bfcache');
    forceRepaint();
    setTimeout(checkAndRecover, 100);
  }
});

// 額外處理: focus 事件
window.addEventListener('focus', () => {
  devLog('[PWA] Window focused');
  // 只做輕量的 repaint，不檢查重載
  requestAnimationFrame(forceRepaint);
});

// Phase 2 M1+M2 驗證 harness（官方版、iOS、localStorage AEGIS_FACEENGINE_HARNESS='1' 才接手頁面；見 ext-official/identity/faceEngineHarness.ts）
if (ext.identity.runDevHarness()) {
  // harness 接手了 #root
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ConfigProvider>
          <LanguageProvider>
            <AppProvider>
              <App />
            </AppProvider>
          </LanguageProvider>
        </ConfigProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

import { devLog, devWarn } from './utils/devLog';
import { useState, useEffect, useCallback, useRef } from 'react';
import { ChatApp } from './pages/ChatApp';
import { ShareTargetPage } from './pages/ShareTargetPage';
import { DeviceTransferScanner } from './components/DeviceTransfer';
import { GlobalVoiceCallUI } from './components/VoiceCall';
import { UnsupportedVersionModal } from './components/common/UnsupportedVersionModal';
import { DeviceKickedModal } from './components/common/DeviceKickedModal';
import { ConnectionNotice } from './components/common/ConnectionNotice';
import { ServerMismatchScreen } from './components/common/ServerMismatchScreen';
import { ownerMismatch, rememberAccountOwner, type AccountOwner } from './services/serverAccount';
import { useChatStore } from './stores/chatStore';
import { useApp } from './providers';
import { Identity, SignedPreKey, fromBase64, toBase64 } from './services/crypto';
import { quickCompatibilityCheck } from './services/deviceCompatibility';
import { setStatusBar } from './services/capacitor';
import { Capacitor } from '@capacitor/core';
import type { TransferData } from './services/deviceTransfer';
import { restoreGroupsFromBackup } from './services/groupRestore';
import { ext } from '@ext';
import type { TrustLevel } from './types';

/**
 * AegisTalk App - 專注於防詐保護的通訊應用
 *
 * 注意：AegisTalk 不包含天氣偽裝和閱後即焚功能
 * 這些是 Mist 專屬的隱私功能
 */

type AppMode = 'auth' | 'chat' | 'device-transfer-scan' | 'share-target';

// 檢查 URL 是否為 Share Target
function checkForShareTarget(): boolean {
  const path = window.location.pathname;
  return path === '/share-target' || path === '/share-target/';
}

// 邀請連結（?invite=…）2026-10-15 拿掉：產生連結的入口早在 AddFriendModal v2 就移除了，對方那頭也不再接受 INVITE_ACCEPT。
// 加好友只走 ATK- 短碼與當面掃 QR，兩條都帶對方發出的憑證（services/friendInvites）。

function App() {
  const { hasIdentity, mqttConnected, enterChatMode, publicKey } = useApp();
  // 登入／註冊畫面是版本的身分功能（官方版 AegisID；社群版目前是只有 PIN 的畫面，第 5b 步換成正式的註冊流程）
  const AuthScreen = ext.identity.AuthScreen;
  const AppOverlays = ext.ui.AppOverlays;

  // 初始模式設為 auth — 帳號恢復改由 AegisID blob lookup 處理（在 AuthScreen 內）
  const [mode, setMode] = useState<AppMode>('auth');
  // 帳號屬於哪台伺服器（開源第 5c 步，services/serverAccount.ts）：這支手機上的帳號屬於另一台 → 不進登入畫面，
  //   改顯示「切換回去／在這台重新開始」。undefined ＝ 還在查（查完才決定顯示哪一個）
  const [mismatch, setMismatch] = useState<AccountOwner | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    ownerMismatch().then((m) => { if (alive) setMismatch(m); }).catch(() => { if (alive) setMismatch(null); });
    return () => { alive = false; };
  }, []);
  // 等待 hasIdentity 變為 true 後再進入 chat（解決生物辨識登入的 React 狀態時序問題）
  const [pendingEnterChat, setPendingEnterChat] = useState(false);

  // 版本相容性狀態
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);

  const [_degradedModeEnabled, setDegradedModeEnabled] = useState(false);

  // Ref 追蹤最新 mode（給 useEffect 閉包使用，避免 stale closure）
  const modeRef = useRef<AppMode>(mode);
  modeRef.current = mode;

  // 強制重新渲染計數器（用於從背景恢復）
  const [, forceUpdate] = useState(0);

  // 啟動時設定狀態列 + 檢查版本相容性
  useEffect(() => {
    // 設定 Android 狀態列：不覆蓋 WebView，深色背景
    setStatusBar({ style: 'dark', backgroundColor: '#0d1b2a' });

    const { isLikelySupported, platform } = quickCompatibilityCheck();
    devLog('[App] Version compatibility check:', { isLikelySupported, platform });

    if (!isLikelySupported) {
      devWarn('[App] Device version not supported, showing upgrade modal');
      setShowUnsupportedModal(true);
    }
  }, []);

  // VPN 威脅卡片（原生）按攔截/放行後 → 寫進守護頁的 user_blacklist/user_whitelist(SQLite)（官方版的網路防護；社群版沒有）
  const { useAppEffects } = ext.ui;
  useAppEffects();

  // 處理降級模式
  const handleDegradedMode = useCallback(() => {
    devLog('[App] User chose degraded mode');
    setDegradedModeEnabled(true);
    setShowUnsupportedModal(false);
  }, []);

  // 處理 App 從背景恢復 - 強制重新渲染整個 App
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        devLog('[App] Visibility changed to visible, forcing re-render. Current mode:', mode);

        // 方法 1: 強制 React 重新渲染
        forceUpdate(prev => prev + 1);

        // 方法 2: 使用 requestAnimationFrame 確保下一幀渲染
        requestAnimationFrame(() => {
          // 再次觸發渲染
          forceUpdate(prev => prev + 1);
        });

        // iOS：背景會凍結 WebView 中斷黑名單同步 → 每次回前景續傳（官方版的防詐規則同步；社群版沒有）
        ext.antiFraud.onAppResume();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [mode]);

  // 當 hasIdentity 變為 true 且有 pending 進入 chat 的請求時，完成轉場
  useEffect(() => {
    if (pendingEnterChat && hasIdentity) {
      setPendingEnterChat(false);
      void rememberAccountOwner();   // 帳號屬於目前這台伺服器（開源第 5c 步）
      // 先初始化重型資源（MQTT/加密），分享也需要這些
      enterChatMode();
      // 通知權限 + FCM 在 ChatApp 掛載時處理
      // 檢查是否有 pending share
      const hasPendingShare = sessionStorage.getItem('aegis_pending_share_target');
      devLog('[App] pendingEnterChat: pendingShare=' + hasPendingShare);
      if (hasPendingShare) {
        sessionStorage.removeItem('aegis_pending_share_target');
        devLog('[App] pendingEnterChat: → share-target');
        setMode('share-target');
        return;
      }
      setMode('chat');
    }
  }, [pendingEnterChat, hasIdentity, enterChatMode, publicKey]);

  // 檢查 Share Target URL（只在首次載入時）
  useEffect(() => {
    if (checkForShareTarget()) {
      devLog('[App] Share Target URL detected');
      if (hasIdentity) {
        setMode('share-target');
      } else {
        sessionStorage.setItem('aegis_pending_share_target', 'true');
      }
    }
  }, [hasIdentity]);

  // 檢查 Android 原生分享 Intent（啟動時 + onNewIntent 事件）
  useEffect(() => {
    // SharePlugin = Android 原生分享 Intent；iOS/web 無此 plugin → 只在 Android 掛載
    //   （否則 iOS 的 addListener 會 not-implemented reject、洗 unhandled rejection log）。
    if (Capacitor.getPlatform() !== 'android') return;

    const processNativeShare = async (fromEvent = false) => {
      try {
        const { SharePlugin } = await import('./plugins/sharePlugin');
        const result = await SharePlugin.checkShare();

        if (!result.hasShare) return;
        devLog('[App] Native share intent detected:', {
          title: result.title,
          text: result.text?.substring(0, 50),
          fileCount: result.files?.length ?? 0,
        });

        // 將原生分享資料存入 sessionStorage
        const { savePendingShare } = await import('./services/fileShare');
        const { generateId } = await import('./utils/secureId');
        savePendingShare({
          title: result.title,
          text: result.text,
          files: (result.files ?? []).map((f) => ({
            id: generateId('file'),
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            dataUrl: f.dataUrl,
            receivedAt: Date.now(),
          })),
        });

        // 清除 Intent 防止重複觸發
        await SharePlugin.clearShare();

        // 設 pending flag，等生物辨識完成後由 enterChat 處理
        sessionStorage.setItem('aegis_pending_share_target', 'true');
        devLog('[App] SHARE: pending flag SET, mode=' + modeRef.current + ' fromEvent=' + fromEvent);

        // 如果 app 已在 chat 模式（onNewIntent 場景），強制回到 auth 頁面做生物辨識
        if (fromEvent && modeRef.current === 'chat') {
          devLog('[App] SHARE: forcing re-auth from chat');
          setMode('auth');
          return;
        }
      } catch (e) {
        devWarn('[App] Native share check failed:', e);
      }
    };

    // 啟動時檢查（只存 pending，不直接切換模式）
    processNativeShare(false);

    // 監聽 onNewIntent（app 已開啟時收到分享 Intent）
    let listenerHandle: { remove: () => Promise<void> } | null = null;
    import('./plugins/sharePlugin').then(({ SharePlugin }) => {
      SharePlugin.addListener('shareReceived', () => {
        devLog('[App] shareReceived event from native');
        processNativeShare(true);
      }).then(h => { listenerHandle = h; }).catch((e) => devWarn('[App] SharePlugin.addListener skipped:', e));
    }).catch(() => { /* 無 SharePlugin */ });

    return () => {
      listenerHandle?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterAuth = useCallback(() => {
    setMode('auth');
  }, []);

  const enterChat = useCallback(() => {
    // 如果 hasIdentity 尚未為 true（生物辨識登入的非同步時序問題），
    // 設定 pending 標記，等 useEffect 偵測到 hasIdentity 變為 true 後再轉場
    if (!hasIdentity) {
      setPendingEnterChat(true);
      return;
    }
    // 釋放 face 模型記憶體 — 登入後不再需要，防 iOS OOM（官方版 AegisID；社群版沒有模型）
    ext.identity.disposeModels();

    // 這個帳號屬於目前這台伺服器（開源第 5c 步：之後換到別台伺服器就不會拿來用）
    void rememberAccountOwner();

    // 先初始化重型資源（分享頁面也需要 MQTT/加密）
    enterChatMode();

    // Phase 34a: 登入後背景下載 Whisper 模型（官方版的語音辨識；E2E 測試跳過；社群版沒有）
    ext.antiFraud.afterLogin();

    // 檢查是否有 pending share target
    const hasPendingShare = sessionStorage.getItem('aegis_pending_share_target');
    devLog('[App] enterChat: pendingShare=' + hasPendingShare);
    if (hasPendingShare) {
      sessionStorage.removeItem('aegis_pending_share_target');
      devLog('[App] enterChat: → share-target');
      setMode('share-target');
    } else {
      devLog('[App] enterChat: → chat');
      setMode('chat');
    }
    // 通知權限 + FCM 註冊移至 ChatApp 元件掛載時處理
    // 確保用戶已看到聊天畫面才彈出系統 prompt

    // SW 更新不再 reload — 新 SW 已接管（controllerchange 已觸發），
    // 記憶體中的 JS 在下次自然刷新時更新即可，避免 reload 造成重複 face scan
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).__swPendingReload) {
      devLog('[PWA] SW update pending — will apply on next app launch (no reload)');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__swPendingReload = false;
    }
  }, [enterChatMode, hasIdentity, publicKey]);

  const exitChat = useCallback(async () => {
    // 登出：清掉原生端的守護資料（報平安設定、舊版憑證、還沒交給 JS 的「報平安」）
    try {
      const { clearGuardianNativeData } = await import('./services/guardianBackground');
      await clearGuardianNativeData();
    } catch (err) {
      console.error('[exitChat] clearing the native guardian data failed:', err);
    }
    // 驗來電推播用的本機資料（好友名單副本、我是誰、看過的來電；開源第 5d 步）
    try {
      const { clearRingData } = await import('./services/ringSync');
      await clearRingData();
    } catch (err) {
      console.error('[exitChat] clearing the ring data failed:', err);
    }
    // 登出前先把 web SQLite blob 落地 IndexedDB，再 reload。jeep 的 saveDBToStore 是
    // 非原子 removeItem→setItem，若 reload 在 setItem 前打斷 → blob 永久遺失（Test 3
    // 重登好友消失）。flushToStore 會等到「key 真的在 store」才回，確保 reload 安全。
    // 不再 closeConnection：頁面 reload 本就整個拆掉連線，多一次 close 反而可能開另一個
    // 可被 reload 打斷的寫入窗口。原生平台 flushToStore no-op。
    try {
      const { flushToStore } = await import('./services/database');
      await flushToStore({ seal: true });   // 登出前封印：flush 後不再開任何 save 窗口，reload 安全
    } catch (err) {
      console.error('[exitChat] flush before reload failed:', err);
    }
    window.location.reload();
  }, []);

  // 進入掃描換機模式
  const enterDeviceTransferScan = useCallback(() => {
    devLog('[App] Entering device transfer scan mode');
    setMode('device-transfer-scan');
  }, []);

  // 換機掃描成功處理
  const { setDisplayName, setAvatar, addFriend } = useChatStore();

  const handleDeviceTransferSuccess = useCallback(async (data: TransferData) => {
    devLog('[App] Device transfer successful');

    try {
      // 1. 恢復身份（私鑰）
      const privateKeyBytes = fromBase64(data.privateKey);
      const identity = Identity.fromPrivateKey(privateKeyBytes);

      // 2. Restore or regenerate signedPreKey
      let signedPreKeyData: { id: number; publicKey: string; privateKey: string; signature: string; timestamp: number };
      if (data.signedPreKey) {
        const spk = SignedPreKey.fromPrivateKey(
          fromBase64(data.signedPreKey.privateKey),
          data.signedPreKey.id,
          fromBase64(data.signedPreKey.signature),
          data.signedPreKey.timestamp,
        );
        signedPreKeyData = {
          id: spk.id,
          publicKey: spk.publicKeyBase64,
          privateKey: data.signedPreKey.privateKey,
          signature: data.signedPreKey.signature,
          timestamp: spk.timestamp,
        };
        spk.free();
      } else {
        const spk = SignedPreKey.generate(identity, 1);
        signedPreKeyData = {
          id: spk.id,
          publicKey: spk.publicKeyBase64,
          privateKey: toBase64(spk.privateKey),
          signature: toBase64(spk.signature),
          timestamp: spk.timestamp,
        };
        spk.free();
      }

      // 儲存身份到 localStorage + SQLite（完整 StoredKeys 格式）
      const keysData = JSON.stringify({
        identity: {
          publicKey: identity.publicKeyBase64,
          privateKey: data.privateKey,
        },
        signedPreKey: signedPreKeyData,
        oneTimePreKeys: [],
      });

      // Encrypt with real key if available, otherwise ephemeral key (never plaintext)
      const { getEncryptionKey, encryptData, encryptWithEphemeralKey } = await import('./services/keyEncryption');
      const { setSetting } = await import('./services/database');
      const encKey = getEncryptionKey();
      let encrypted: string;
      if (encKey) {
        encrypted = await encryptData(keysData, encKey);
      } else {
        encrypted = await encryptWithEphemeralKey(keysData);
      }
      localStorage.setItem('mist_keys', encrypted);
      setSetting('mist_keys', encrypted).catch(() => {});

      // 3. 設定用戶資料
      if (data.displayName) {
        setDisplayName(data.displayName);
      }
      if (data.avatar) {
        setAvatar(data.avatar);
      }

      // 4. 恢復好友列表
      if (data.friends && data.friends.length > 0) {
        for (const friend of data.friends) {
          const trustLevel: TrustLevel = friend.verified ? 'verified' : 'unverified';
          addFriend(
            friend.publicKey,
            friend.nickname || `好友 ${friend.publicKey.slice(0, 8)}`,
            trustLevel
          );
        }
      }

      // 4b. 群組：整條簽章狀態鏈重驗後還原（services/groupBackup）；引擎登入後從本機載入、向伺服器 log 補進度
      if (Array.isArray(data.groups) && data.groups.length > 0) {
        const restored = await restoreGroupsFromBackup(data.groups, identity.publicKeyBase64);
        devLog('[App] Device transfer: restored', restored, 'of', data.groups.length, 'groups from their chains');
      }

      // 5–6. Phase 27: 還原認證資料 (PIN hash/salt, behavior baseline)、face embedding（版本的身分功能）
      await ext.identity.restoreTransfer({
        pinHash: data.pinHash,
        pinSalt: data.pinSalt,
        backupAuthHash: data.backupAuthHash,
        behaviorBaseline: data.behaviorBaseline,
        faceEmbedding: data.faceEmbedding,
      });

      // 7. Phase 27: 判斷是否可直接登入（有 PIN hash = B 機已有完整認證資料）
      if (data.pinHash && data.pinSalt) {
        devLog('[App] Phase 27: B 機零輸入登入 — 完整認證資料已還原');
        // 直接進入聊天（PIN 已還原，下次啟動時正常 verify）
        setMode('auth');
      } else {
        // 沒有 PIN（Phase 8 舊版 transfer）→ 進入 PIN 設定
        devLog('[App] Device transfer complete, entering auth for PIN setup');
        setMode('auth');
      }
    } catch (err) {
      console.error('[App] Failed to apply transfer data:', err);
      setMode('auth');
    }
  }, [setDisplayName, setAvatar, addFriend]);

  // 取消掃描換機
  const handleDeviceTransferCancel = useCallback(() => {
    devLog('[App] Device transfer scan cancelled');
    setMode('auth');
  }, []);

  // 根據模式渲染不同頁面
  const renderPage = () => {
    if (mode === 'auth' || mode === 'device-transfer-scan') {
      if (mismatch === undefined) {
        return <div className="min-h-[100dvh] bg-surface-primary" />;
      }
      if (mismatch) return <ServerMismatchScreen owner={mismatch} />;
    }
    switch (mode) {
      case 'auth':
        return (
          <AuthScreen
            onSuccess={enterChat}
            onBack={enterAuth}
            onDeviceTransfer={enterDeviceTransferScan}
          />
        );
      case 'device-transfer-scan':
        return (
          <DeviceTransferScanner
            onSuccess={handleDeviceTransferSuccess}
            onCancel={handleDeviceTransferCancel}
          />
        );
      case 'share-target':
        return (
          <ShareTargetPage
            onBack={() => {
              // 清除 URL 中的 share-target 路徑
              window.history.replaceState({}, '', '/');
              setMode('chat');
            }}
            onComplete={() => {
              // 清除 URL 中的 share-target 路徑
              window.history.replaceState({}, '', '/');
              setMode('chat');
              enterChatMode();
            }}
          />
        );
      case 'chat':
        return (
          <ChatApp
            onLogout={exitChat}
          />
        );
      default:
        return (
          <AuthScreen
            onSuccess={enterChat}
            onBack={enterAuth}
            onDeviceTransfer={enterDeviceTransferScan}
          />
        );
    }
  };

  // 全域語音通話 UI
  const showGlobalVoiceCall = hasIdentity && mqttConnected;

  return (
    <>
      {renderPage()}
      {showGlobalVoiceCall && <GlobalVoiceCallUI />}

      {/* 版本不支援提示 Modal */}
      {showUnsupportedModal && (
        <UnsupportedVersionModal
          allowDegradedMode={true}
          onDismiss={handleDegradedMode}
        />
      )}

      {/* Phase 35a: 帳號被新裝置踢下線提示 */}
      <DeviceKickedModal />

      {/* MQTT 連線提示（手機時間不準等，mqtt.ts 的 aegis:mqtt-notice） */}
      <ConnectionNotice />

      {/* 網路守護(VPN)威脅警告 — 自掛 aegis:threat-detected listener，跳通知→點通知→彈此視窗（官方版） */}
      <AppOverlays />
    </>
  );
}

export default App;

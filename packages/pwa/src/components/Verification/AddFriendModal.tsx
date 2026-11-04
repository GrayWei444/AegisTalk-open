import { devLog, devWarn } from '../../utils/devLog';
import { AlertTriangleIcon } from '../common/icons';

/**
 * AddFriendModal - 新增好友彈窗元件
 *
 * 整合 QR Code 掃描、顯示和好友碼功能
 * v2: 移除邀請連結，新增好友碼，修復 QR Code 安全性
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { AegisQrScanner, isNativeQrScannerAvailable } from '../../plugins/aegisQrScanner';
import { QRCodeVerification } from './QRCodeVerification';
import { FriendCode, isShortCode, lookupShortCode, ShortCodeRateLimitedError } from './FriendCode';
import { useLanguage } from '../../i18n';
import { mqttService, MessageType, ConnectionState } from '../../services/mqtt';
import { useApp } from '../../providers/AppProvider';
import { useChatStore } from '../../stores/chatStore';
import { toBase64, fromBase64 } from '../../services/crypto';
import { clearPeerSession } from '../../services/cryptoSessionControl';
import { webrtcService } from '../../services/webrtc';
import { deletePendingMessagesForRecipient } from '../../services/storage';
import { flushSessionWrites } from '../../hooks/useCrypto';
import { ext } from '@ext';
import { qrScanExpired, makeVia, type FriendInvite, type FriendVia } from '../../services/friendInvites';
import { friendViaSealer } from '../../services/groupKeyDelivery';
import { withInitAuth } from '../../services/x3dhInitSend';
import type { InitAuth } from '../../services/x3dhInitAuth';
import { usePendingFriendStore, findPending, addFriendPhase, FRIEND_CONFIRM_WAIT_MS, type PendingVia } from '../../stores/pendingFriendStore';
import { FriendConfirmStatus } from './FriendConfirmStatus';
// Phase 12: 信任分數服務（分數是官方版的防詐功能 ext.antiFraud.contactRisk；社群版回 null → 不警告）
import {
  shouldShowWarning,
  getWarningMessage,
  getRiskLevelName,
  getRiskLevelColor,
} from '../../services/riskScoreDisplay';
import type { ContactRiskInfo as RiskScoreInfo } from '../../ext/types';

type TabType = 'scan' | 'myqr' | 'friendcode';

// QR Code 資料結構 (v2: 含時間戳和過期時間)
interface QRCodeData {
  v: number;      // 版本號 (1 = 舊版, 2 = 安全版本)
  pk: string;     // Ed25519 公鑰 (Base64)
  spk: string;    // SignedPreKey 公鑰 (Base64)
  sig: string;    // SignedPreKey 簽名 (Base64)
  name: string;
  ts?: number;    // 產生時間戳 (v2)
  exp?: number;   // 過期時間戳 (v2)
  n?: string;     // 這張 QR 的 nonce：加好友時帶回給對方，對方據此認定「當面掃過我的 QR」（稽核 H2）
}

/**
 * 掃到的 QR 要帶 nonce 才有憑證。沒有 nonce 就不是這個 App 的加好友 QR（App 還沒上線，沒有舊版 QR）——
 * 送出去對方一定拒收，所以掃描時就擋下。nonce 只留在本機算 proof，不放進 INIT（見 friendInvites.makeVia）。
 */
const qrInvite = (qr: QRCodeData): FriendInvite | null =>
  typeof qr.n === 'string' && qr.n ? { kind: 'qr', token: qr.n } : null;

// 好友碼資料結構 (無時效)
interface FriendCodeData {
  v: number;      // 版本號 (1)
  pk: string;
  spk: string;
  sig: string;
  name: string;
}

// X3DH 初始化訊息（不帶名字：開源第 4 步起名字在封給對方的 via 裡，broker 看不到）
interface X3DHInitPayload {
  ephemeralPublicKey: string;
  signedPreKey?: string;
  signature?: string;
  sessionReset?: boolean; // QR 重加好友 = authoritative reset → 收端清舊 session/outbox 後 accept 新 session
  via: FriendVia;         // 我是透過對方發出的什麼加他的：封給對方身分金鑰的 { 種類, 綁我金鑰與這封 ephemeral 的 proof }（憑證不上線，審查 M2）；對方還不是我好友時，對不上就整封拒收
  auth?: InitAuth;        // 我身分金鑰的簽章（開源第 5b 步，x3dhInitAuth）：對方已經是我好友時（重加），沒有它他一律不收
}

interface AddFriendModalProps {
  isOpen: boolean;
  onClose: () => void;
  onFriendAdded?: (publicKey: string, isVerified: boolean) => void;
}

export function AddFriendModal({
  isOpen,
  onClose,
  onFriendAdded,
}: AddFriendModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('scan');
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'connecting' | 'waiting' | 'error' | 'warning'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  /** 送出 INIT 之後在等誰確認（審查 M1）：對方收下會回 PROFILE_UPDATE，見 stores/pendingFriendStore */
  const [awaiting, setAwaiting] = useState<{ pk: string; name: string; via: PendingVia; since: number; syncFailed: boolean } | null>(null);
  /**
   * 第幾次加好友：每次開始（掃到 QR、送出短碼、看完風險警告按確認）換一個編號，關掉彈窗也換。await 回來時編號變了
   * 就不再動畫面 —— 慢的那次不能蓋掉新的那次的畫面，也不能在彈窗關掉後才跳出等待畫面。已經開始的加好友本身照樣做完。
   */
  const addAttemptRef = useRef(0);

  // Phase 12: 風險警告狀態
  const [riskWarning, setRiskWarning] = useState<{
    show: boolean;
    riskInfo: RiskScoreInfo | null;
    pendingQrData: QRCodeData | null;
  }>({ show: false, riskInfo: null, pendingQrData: null });

  // 好友碼輸入狀態
  const [friendCodeInput, setFriendCodeInput] = useState('');
  const [friendCodeError, setFriendCodeError] = useState('');
  const [friendCodeProcessing, setFriendCodeProcessing] = useState(false);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerContainerId = 'qr-scanner-modal';

  const { publicKey, cryptoReady, createSession, signedPreKey } = useApp();
  const { reAddFriend, userProfile } = useChatStore();
  const { t } = useLanguage();

  // Phase 12: 實際執行加好友的邏輯（風險警告確認後調用）
  // trustLevel: 'verified' = QR Code 掃描, 'unverified' = 好友碼貼上
  // invite：一定要有（對方收到沒有憑證的 INIT 會整封拒收）—— 新的加好友路也得先有對方發出、對方記得的憑證。
  //   憑證本身不送，送的是綁我金鑰與這封 ephemeral 的 proof（INIT 是明文，broker 上看得到，審查 M2）
  const proceedAddFriend = useCallback(async (
    peerData: QRCodeData | FriendCodeData, trustLevel: 'verified' | 'unverified', invite: FriendInvite, attempt: number,
  ) => {
    if (!publicKey) return;
    const live = () => addAttemptRef.current === attempt;

    try {
      setStatusMessage(t('addFriend.keyExchange'));

      // 連接 MQTT (如果尚未連接)
      if (mqttService.getState() !== ConnectionState.CONNECTED) {
        setStatusMessage(t('addFriend.connectingServer'));
        await mqttService.connect(publicKey);
      }

      // 執行 X3DH (作為發起者) - 使用 AppProvider 的 createSession
      const peerIdentityPubKey = fromBase64(peerData.pk);
      const peerSignedPreKeyPub = fromBase64(peerData.spk);
      const peerSignature = fromBase64(peerData.sig);

      // ===== QR re-add is authoritative：掃到的新 publicKey/spk/sig 覆蓋所有舊本機/VPS 金鑰，強制全新 X3DH。最新 key wins。=====
      // 1. 清舊 session（in-memory + durable mist_sessions）
      await clearPeerSession(peerData.pk);
      // 1b. 也要重置「傳輸層」：authoritative reset 只清 crypto/DB，不會清 WebRTC PeerConnection。
      //     舊 stale PC 還活著 → 重加後送訊撞 "Live PC, DC not open" → polite 端永遠等對方 re-offer →
      //     outbox 卡死。teardown 舊 peer，下面 createSession + 送訊才會建 fresh P2P transport。
      webrtcService.disconnect(peerData.pk);
      // 2. 清該 peer 舊 outbox 密文（舊 session 加密的 → reset 後 flush 必 aead、污染新 session）
      await deletePendingMessagesForRecipient(peerData.pk);
      // 3. 無條件覆蓋 contact bundle（name/trust/signedPreKey/signature）+ 等本機 SQLite 真的寫入
      //    （await — 否則 VPS 是新 key 但本機 DB 還是舊/空，reload 後對不上；persist 失敗會 throw 到下方 catch）
      await reAddFriend(peerData.pk, peerData.name, trustLevel, { signedPreKey: peerData.spk, signature: peerData.sig });
      // 3b. 對方確認之前都算「等待確認」（審查 M1）：接下來哪一步失敗，他也是看得到、可以取消的待確認好友，
      //     不是看起來加好了、訊息卻默默被對方丟掉的半個好友
      usePendingFriendStore.getState().markPending(publicKey, peerData.pk, invite.kind);

      // 4. 用「新」金鑰建 fresh X3DH session
      const { ephemeralPublicKey } = createSession(
        peerIdentityPubKey,
        peerSignedPreKeyPub,
        peerSignature,
        undefined,
        undefined,
        true // forceFresh：QR 重加一律建全新 Alice session（與送出的新 ephemeral 同源），不准沿用舊 ratchet
      );
      // 5. 等新 session 真的落 DB 才送第一則訊息（否則 remount/reload 讀不到 → No stored sessions → aead）
      await flushSessionWrites();

      console.log('[AddFriendModal] Fresh session created with peer:', peerData.pk.slice(0, 16) + '...', 'trustLevel:', trustLevel);

      // 6. 送 X3DH_INIT，帶 sessionReset:true → 收端先清舊 session/outbox 再 accept 新 session
      const ephemeralB64 = toBase64(ephemeralPublicKey);
      // 等待確認綁這封 INIT：對方回的 PROFILE_UPDATE 要帶這把 ephemeral（initEph）才算確認他收下的是這一封
      usePendingFriendStore.getState().markPending(publicKey, peerData.pk, invite.kind, ephemeralB64);
      // 封給對方的身分金鑰；我的名字也在裡面（以前是 INIT 明文的 senderName，broker 看得到）
      const via = await makeVia(invite, publicKey, ephemeralB64, peerData.pk, friendViaSealer,
        userProfile.displayName || t('addFriend.unnamedUser', { id: publicKey.slice(0, 6) }));
      const initPayload: X3DHInitPayload = {
        ephemeralPublicKey: ephemeralB64,
        signedPreKey: signedPreKey?.publicKeyBase64,
        signature: signedPreKey?.signatureBase64,
        sessionReset: true,
        via,   // 對方的信任等級只看這個；不送 trustLevel（收端從來不採信自稱的等級）
      };
      console.log('[AddFriendModal] Sending X3DH_INIT(reset) to:', peerData.pk.slice(0, 16), 'MQTT connected:', mqttService.isConnected());
      mqttService.sendToUser(peerData.pk, MessageType.X3DH_INIT, withInitAuth(peerData.pk, initPayload));

      // 7. 立即 force flush VPS blob（新 contact bundle 覆蓋雲端）。失敗不可靜默成功 —
      //    dirty flag 會自動重試，但 UI 也明講「雲端同步暫時失敗」，不假裝全綠。
      let blobSynced = true;
      try {
        const flushRes = await ext.identity.backup.flushNow();
        blobSynced = flushRes.success;
        if (!blobSynced) console.error('[AddFriendModal] VPS blob 同步未完成（會自動重試）:', flushRes.error || flushRes.skipped);
      } catch (err) {
        blobSynced = false;
        console.error('[AddFriendModal] VPS blob 同步丟例外（會自動重試）:', err);
      }

      // 8. 不說「已加入」（審查 M1）：對方可能很久之後才處理這封 INIT（掃完就鎖屏、離線佇列），也可能拒收。
      //    等他收下回 PROFILE_UPDATE（AppProvider 拿掉等待記錄）才算，見下方「等對方確認」的 effect
      if (!live()) return;   // 已經開始新的一次、或彈窗關了：不動畫面（加好友本身上面已經做完）
      setAwaiting({ pk: peerData.pk, name: peerData.name, via: invite.kind, since: Date.now(), syncFailed: !blobSynced });
      setScanStatus('waiting');

    } catch (err) {
      console.error('[AddFriendModal] proceedAddFriend failed:', err);
      console.error('[AddFriendModal] Peer data:', {
        pk: peerData.pk.slice(0, 16) + '...',
        name: peerData.name,
        trustLevel,
      });
      if (!live()) return;
      const errorMsg = err instanceof Error ? err.message : t('addFriend.addFailed');
      setScanError(errorMsg);
      setScanStatus('error');
      setStatusMessage(errorMsg);
    }
  }, [publicKey, createSession, reAddFriend, userProfile, t]);

  // 處理掃描到的 QR Code
  const handleQrScanned = useCallback(async (qrText: string) => {
    if (!publicKey) {
      setScanError(t('friendCode.keysNotReady'));
      setScanStatus('error');
      return;
    }
    const attempt = ++addAttemptRef.current;
    const live = () => addAttemptRef.current === attempt;
    setAwaiting(null);   // 新的一次：上一次的等待畫面先清掉

    try {
      setScanStatus('connecting');
      setStatusMessage(t('addFriend.parsingQr'));

      const peerQr: QRCodeData = JSON.parse(qrText);

      if (!peerQr.pk || !peerQr.spk || !peerQr.sig) {
        throw new Error(t('addFriend.invalidQr'));
      }

      // 只收這個 App「我的 QR」畫面畫的那種：v2、有時間、有 nonce。沒有 nonce 的（v1 等）對方一定拒收，
      // 不送出去讓人以為加成功（App 還沒上線，沒有舊版 QR 要相容）
      const invite = qrInvite(peerQr);
      if (!(peerQr.v >= 2) || !peerQr.exp || !peerQr.ts || !invite) {
        throw new Error(t('addFriend.unsupportedQr'));
      }
      if (qrScanExpired(peerQr.exp)) {   // 一張 5 分鐘；容兩支手機的時鐘差一點
        throw new Error(t('addFriend.qrExpired'));
      }
      devLog('[AddFriendModal] QR Code 時間驗證通過，剩餘', Math.round((peerQr.exp - Date.now()) / 1000), '秒');

      setStatusMessage(t('addFriend.friendFound', { name: peerQr.name }));

      // Phase 12: 查詢對方的風險分數
      setStatusMessage(t('addFriend.checkingSecurity'));
      const riskInfo = await ext.antiFraud.contactRisk(peerQr.pk);
      if (!live()) return;   // 查的時候又掃了一張、或彈窗關了：這次不加

      if (shouldShowWarning(riskInfo)) {
        // 有風險記錄，顯示警告
        devWarn('[AddFriendModal] ⚠️ Risk warning for peer:', peerQr.name, riskInfo);
        setRiskWarning({
          show: true,
          riskInfo,
          pendingQrData: peerQr,
        });
        setScanStatus('warning');
        setStatusMessage(t('addFriend.riskWarning'));
        return;
      }

      // 無風險，直接加好友 (QR Code = verified)
      await proceedAddFriend(peerQr, 'verified', invite, attempt);

    } catch (err) {
      if (!live()) return;
      const errorMsg = err instanceof Error ? err.message : t('addFriend.scanFailed');
      setScanError(errorMsg);
      setScanStatus('error');
      setStatusMessage(errorMsg);
    }
  }, [publicKey, proceedAddFriend, t]);

  // Phase 12: 確認加好友（忽略風險警告）
  const handleConfirmAddFriend = useCallback(async () => {
    if (!riskWarning.pendingQrData) return;
    const attempt = ++addAttemptRef.current;
    setAwaiting(null);
    setRiskWarning({ show: false, riskInfo: null, pendingQrData: null });
    // 看警告的這段時間 QR 可能已過 5 分鐘：對方不認這張了，送出去會被拒收 → 請他給你掃新的那張
    //   （nonce、exp 掃描時已確認有；這裡再判斷一次只為了讓型別收窄）
    const { exp } = riskWarning.pendingQrData;
    const invite = qrInvite(riskWarning.pendingQrData);
    if (!invite || !exp || qrScanExpired(exp)) {
      const msg = t('addFriend.qrExpired');
      setScanError(msg);
      setScanStatus('error');
      setStatusMessage(msg);
      return;
    }
    setScanStatus('connecting');
    await proceedAddFriend(riskWarning.pendingQrData, 'verified', invite, attempt);
  }, [riskWarning.pendingQrData, proceedAddFriend, t]);

  // Phase 12: 取消加好友
  const handleCancelAddFriend = useCallback(() => {
    setRiskWarning({ show: false, riskInfo: null, pendingQrData: null });
    setScanStatus('idle');
    setStatusMessage('');
  }, []);

  // 處理好友碼貼上
  const handleFriendCodeSubmit = useCallback(async () => {
    if (!publicKey) {
      setFriendCodeError(t('friendCode.keysNotReady'));
      return;
    }

    const code = friendCodeInput.trim();
    if (!code) {
      setFriendCodeError(t('addFriend.enterCode'));
      return;
    }

    // 只收 ATK-XXXXXX 短碼。舊的 aegis: 長碼拿掉了：App 早就不再產生，碼主人那邊也沒有記錄可對，
    //   送出去一定被拒收（App 還沒上線，沒有已分享出去的舊碼要相容）
    if (!isShortCode(code)) {
      setFriendCodeError(t('addFriend.invalidCodeFormat'));
      return;
    }

    const attempt = ++addAttemptRef.current;
    const live = () => addAttemptRef.current === attempt;
    setAwaiting(null);   // 新的一次：上一次的等待畫面先清掉
    setFriendCodeProcessing(true);
    setFriendCodeError('');

    try {
      // 透過 VPS API 查詢短碼
      const friendData: FriendCodeData | null = await lookupShortCode(code);
      if (!live()) return;   // 查的時候又送了一次、或彈窗關了：這次不加
      if (!friendData) {
        throw new Error(t('addFriend.codeNotFound'));
      }
      devLog('[AddFriendModal] Short code lookup success:', friendData.name);

      // 檢查是否是自己
      if (friendData.pk === publicKey) {
        throw new Error(t('addFriend.cannotAddSelf'));
      }

      // Phase 12: 查詢對方的風險分數
      const riskInfo = await ext.antiFraud.contactRisk(friendData.pk);
      if (!live()) return;

      if (shouldShowWarning(riskInfo)) {
        devWarn('[AddFriendModal] ⚠️ Risk warning for friend code:', friendData.name, riskInfo);
      }

      // 加好友 (好友碼 = unverified)。短碼是憑證：INIT 帶它算出的 proof，碼主人據此認得是透過他的碼
      await proceedAddFriend(friendData, 'unverified', { kind: 'code', token: code }, attempt);

      // 清空輸入
      if (live()) setFriendCodeInput('');

    } catch (err) {
      console.error('[AddFriendModal] Friend code submit failed:', err);
      if (!live()) return;
      // 被限速（429）時說「太多次，稍後再試」，不是「找不到」—— 以前使用者以為碼錯了一直重打
      const errorMsg = err instanceof ShortCodeRateLimitedError
        ? t('friendCode.lookupRateLimited')
        : err instanceof Error ? err.message : t('addFriend.addFailed');
      setFriendCodeError(errorMsg);
    } finally {
      if (live()) setFriendCodeProcessing(false);   // 關掉彈窗的那個 effect 也會清
    }
  }, [publicKey, friendCodeInput, proceedAddFriend, t]);

  // 開始掃描
  const startScanning = useCallback(async () => {
    setScanError('');
    setScanStatus('scanning');
    setStatusMessage(t('addFriend.scanHint'));

    // iOS 原生掃描：AVFoundation 連續自動對焦(near) + 全畫面解碼，根治 WKWebView 對焦/小框死結。
    //   開原生全螢幕掃描器；web(PWA)/Android-web 走下方 html5-qrcode fallback。
    if (isNativeQrScannerAvailable()) {
      try {
        const res = await AegisQrScanner.scan();
        if (res?.value) {
          handleQrScanned(res.value);
        } else {
          // 使用者取消 → 回 idle
          setScanStatus('idle');
          setStatusMessage('');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('deviceTransfer.cameraError');
        console.error('[Scanner] native scan failed:', err);
        setScanError(msg);
        setScanStatus('error');
        setStatusMessage(msg);
      }
      return;
    }

    try {
      // 確保容器存在
      await new Promise(resolve => setTimeout(resolve, 100));

      const scanner = new Html5Qrcode(scannerContainerId);
      scannerRef.current = scanner;

      await scanner.start(
        // ⚠️ cameraIdOrConfig 必須「恰好一個 key」的相機選擇器（html5-qrcode 規定）；
        //   放多個 key（含 width/height）會丟 "cameraIdOrConfig should have exactly 1 key"
        //   → 相機根本開不起來。解析度偏好改放 config.videoConstraints（下方）。
        { facingMode: 'environment' },
        {
          fps: 10,
          // 只用 ideal(軟性偏好,永不失敗)拉高解析度；min 是硬限制,滿足不了會 OverconstrainedError→相機開不起來。
          videoConstraints: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          // 自適應 qrbox：取畫面短邊 60%（min 120）→ 白框框住 QR 留適當邊距(不再填滿整個畫面)。
          //   容器比例已對齊相機(aspect-[3/4])，白框=真正解碼區，所見即所掃；QR 完整落在框內即解開。
          qrbox: (vw: number, vh: number) => {
            const min = Math.min(vw, vh);
            const size = Math.max(Math.floor(min * 0.6), 120);
            return { width: size, height: size };
          },
          // 不固定 aspectRatio（相機未必支援精確 1:1，讓它用原生比例 → 解碼用真實畫面）
        },
        (decodedText) => {
          // 掃描成功，停止掃描並處理
          devLog('[Scanner] QR Code detected:', decodedText.slice(0, 40));
          stopScanning();
          handleQrScanned(decodedText);
        },
        (errorMessage) => {
          // 掃描中（每幀 callback）— 只在非「找不到 QR」的真實錯誤時記錄
          if (!errorMessage.includes('No QR code found')) {
            devLog('[Scanner] Scanning:', errorMessage);
          }
        }
      );

      setIsScanning(true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('deviceTransfer.cameraError');
      console.error('[Scanner] Failed to start camera:', err);
      setScanError(errorMsg);
      setScanStatus('error');
      setStatusMessage(errorMsg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleQrScanned, t]);

  // 停止掃描
  const stopScanning = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current = null;
      } catch {
        // 忽略
      }
    }
    setIsScanning(false);
  }, []);

  // 切換 tab 時停止掃描
  useEffect(() => {
    if (activeTab !== 'scan') {
      stopScanning();
    }
  }, [activeTab, stopScanning]);

  // 送出 INIT 之後：等對方確認（審查 M1）。對方回 PROFILE_UPDATE → AppProvider 拿掉等待記錄 → 這裡變成「已確認」
  const awaitingEntry = usePendingFriendStore((s) => (awaiting ? findPending(s.entries, publicKey, awaiting.pk) : undefined));
  const [, setPhaseTick] = useState(0);
  const phase = awaiting ? addFriendPhase(awaiting.since, !!awaitingEntry, Date.now()) : null;
  // 等滿 2 分鐘還沒確認：重畫一次，改說「對方還沒確認，他打開 App 就會加上…」
  useEffect(() => {
    if (phase !== 'waiting' || !awaiting) return;
    const left = Math.max(0, awaiting.since + FRIEND_CONFIRM_WAIT_MS - Date.now());
    const timer = setTimeout(() => setPhaseTick((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [phase, awaiting]);
  // 對方確認了：顯示「已加入」一下，再交給父元件（好友清單會關掉彈窗）
  const onFriendAddedRef = useRef(onFriendAdded);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onFriendAddedRef.current = onFriendAdded;
    onCloseRef.current = onClose;
  }, [onFriendAdded, onClose]);
  useEffect(() => {
    if (phase !== 'confirmed' || !awaiting) return;
    const timer = setTimeout(() => {
      if (onFriendAddedRef.current) onFriendAddedRef.current(awaiting.pk, awaiting.via === 'qr');
      else onCloseRef.current();
    }, 1500);
    return () => clearTimeout(timer);
  }, [phase, awaiting]);

  // 關閉時停止掃描並重置狀態
  useEffect(() => {
    if (!isOpen) {
      stopScanning();
      setScanStatus('idle');
      setScanError('');
      addAttemptRef.current += 1;   // 還在跑的那次回來時不再動畫面
      setAwaiting(null);   // 關掉彈窗不影響等待確認：好友清單／聊天室照樣顯示，對方確認了就自動變正常好友
      setFriendCodeProcessing(false);
      // Phase 12: 重置風險警告狀態
      setRiskWarning({ show: false, riskInfo: null, pendingQrData: null });
    }
  }, [isOpen, stopScanning]);

  // 組件卸載時清理
  useEffect(() => {
    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 彈窗內容 */}
      <div className="relative w-full max-w-md mx-4 bg-surface-secondary rounded-2xl shadow-2xl overflow-hidden">
        {/* 標題列 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--surface-border)]">
          <h2 className="text-lg font-semibold text-on-surface-primary">{t('friendList.addFriend')}</h2>
          <button
            onClick={onClose}
            className="p-2 text-on-surface-tertiary hover:text-on-surface-primary hover:bg-surface-tertiary rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 標籤切換 */}
        <div className="flex border-b border-[var(--surface-border)]">
          <button
            onClick={() => setActiveTab('scan')}
            className={`
              flex-1 px-4 py-3 text-sm font-medium transition-colors
              ${activeTab === 'scan'
                ? 'text-accent border-b-2 border-accent bg-accent-soft'
                : 'text-on-surface-secondary hover:text-on-surface-primary'
              }
            `}
          >
            <span className="flex items-center justify-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              {t('friendCode.scan')}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('myqr')}
            className={`
              flex-1 px-4 py-3 text-sm font-medium transition-colors
              ${activeTab === 'myqr'
                ? 'text-accent border-b-2 border-accent bg-accent-soft'
                : 'text-on-surface-secondary hover:text-on-surface-primary'
              }
            `}
          >
            <span className="flex items-center justify-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 3H4a1 1 0 00-1 1v3" />
                <path d="M17 3h3a1 1 0 011 1v3" />
                <path d="M7 21H4a1 1 0 01-1-1v-3" />
                <path d="M17 21h3a1 1 0 001-1v-3" />
                <rect x="7" y="7" width="4" height="4" fill="currentColor" stroke="none" />
                <rect x="13" y="7" width="4" height="4" fill="currentColor" stroke="none" />
                <rect x="7" y="13" width="4" height="4" fill="currentColor" stroke="none" />
                <rect x="14" y="14" width="2" height="2" fill="currentColor" stroke="none" />
                <rect x="17" y="13" width="1" height="1" fill="currentColor" stroke="none" />
                <rect x="13" y="17" width="1" height="1" fill="currentColor" stroke="none" />
              </svg>
              {t('friendCode.myCode')}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('friendcode')}
            className={`
              flex-1 px-4 py-3 text-sm font-medium transition-colors
              ${activeTab === 'friendcode'
                ? 'text-accent border-b-2 border-accent bg-accent-soft'
                : 'text-on-surface-secondary hover:text-on-surface-primary'
              }
            `}
          >
            <span className="flex items-center justify-center gap-1.5">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="10" cy="10" r="6" />
                <circle cx="8" cy="9" r="1.5" fill="currentColor" stroke="none" />
                <path d="M14.5 13.5l6.5 6.5" />
                <path d="M16 20l2-1.5V16l2-1" />
              </svg>
              {t('friendCode.friendCodeTab')}
            </span>
          </button>
        </div>

        {/* 內容區域 */}
        <div className="max-h-[70vh] overflow-y-auto">
          {activeTab === 'scan' && (
            <div className="flex flex-col items-center gap-4 p-6">
              <div className="text-center mb-2">
                <h3 className="text-lg font-semibold text-on-surface-primary">{t('addFriend.scanTitle')}</h3>
                <p className="text-sm text-on-surface-secondary mt-1">{t('addFriend.scanHint')}</p>
              </div>

              {/* 掃描區域 */}
              <div className="relative w-full max-w-[220px] aspect-[3/4] bg-surface-tertiary rounded-xl overflow-hidden">
                <div id={scannerContainerId} className="w-full h-full" />

                {/* 狀態覆蓋層 */}
                {!isScanning && scanStatus !== 'scanning' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-primary/90">
                    {scanStatus === 'idle' && (
                      <>
                        <svg className="w-16 h-16 text-on-surface-tertiary mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M7 3H4a1 1 0 00-1 1v3" />
                          <path d="M17 3h3a1 1 0 011 1v3" />
                          <path d="M7 21H4a1 1 0 01-1-1v-3" />
                          <path d="M17 21h3a1 1 0 001-1v-3" />
                          <line x1="3" y1="12" x2="21" y2="12" strokeWidth={1} opacity={0.5} />
                        </svg>
                        <p className="text-on-surface-secondary text-sm">{t('addFriend.openCameraHint')}</p>
                      </>
                    )}
                    {scanStatus === 'connecting' && (
                      <>
                        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin mb-4" />
                        <p className="text-accent">{statusMessage}</p>
                      </>
                    )}
                    {scanStatus === 'waiting' && awaiting && phase && (
                      <FriendConfirmStatus phase={phase} name={awaiting.name} via={awaiting.via} syncFailed={awaiting.syncFailed} />
                    )}
                    {scanStatus === 'error' && (
                      <>
                        <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-4">
                          <svg className="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </div>
                        <p className="text-red-400">{statusMessage || scanError}</p>
                      </>
                    )}
                    {/* Phase 12: 風險警告狀態 */}
                    {scanStatus === 'warning' && riskWarning.show && riskWarning.riskInfo && (
                      <div className="p-4 text-center">
                        <div className="w-16 h-16 bg-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                          <AlertTriangleIcon size={30} className="text-orange-400" />
                        </div>
                        <h4 className="text-lg font-semibold text-orange-400 mb-2">{t('addFriend.riskWarning')}</h4>
                        <p className="text-sm text-on-surface-secondary mb-3">
                          {getWarningMessage(riskWarning.riskInfo)}
                        </p>
                        <div className="flex justify-center gap-2 mb-4">
                          <span className={`px-2 py-1 rounded text-xs ${getRiskLevelColor(riskWarning.riskInfo.riskLevel)}`}>
                            {getRiskLevelName(riskWarning.riskInfo.riskLevel)}
                          </span>
                          <span className="px-2 py-1 rounded text-xs bg-surface-tertiary text-on-surface-secondary">
                            {t('addFriend.riskScore', { score: riskWarning.riskInfo.riskScore })}
                          </span>
                        </div>
                        <div className="flex gap-3 justify-center">
                          <button
                            onClick={handleCancelAddFriend}
                            className="px-4 py-2 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-lg text-sm transition-colors"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            onClick={handleConfirmAddFriend}
                            className="px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg text-sm transition-colors"
                          >
                            {t('addFriend.addAnyway')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 控制按鈕 */}
              {!cryptoReady ? (
                <div className="text-center text-on-surface-secondary">
                  <div className="w-8 h-8 border-2 border-on-surface-tertiary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm">{t('auth.initCryptoModule')}</p>
                </div>
              ) : scanStatus === 'idle' || scanStatus === 'error' ? (
                <button
                  onClick={startScanning}
                  className="px-6 py-3 bg-accent hover:opacity-90 text-white rounded-xl font-medium transition-all"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 3H4a1 1 0 00-1 1v3" />
                    <path d="M17 3h3a1 1 0 011 1v3" />
                    <path d="M7 21H4a1 1 0 01-1-1v-3" />
                    <path d="M17 21h3a1 1 0 001-1v-3" />
                  </svg>
                  {t('friendCode.openCamera')}
                </button>
              ) : isScanning ? (
                <button
                  onClick={stopScanning}
                  className="px-6 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-xl font-medium transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  {t('friendCode.stopScan')}
                </button>
              ) : null}

              {scanError && scanStatus !== 'error' && (
                <p className="text-red-400 text-sm text-center">{scanError}</p>
              )}
            </div>
          )}

          {activeTab === 'myqr' && (
            <QRCodeVerification
              onVerified={(publicKey) => {
                onFriendAdded?.(publicKey, true);
              }}
            />
          )}

          {activeTab === 'friendcode' && (
            <div className="flex flex-col gap-6 p-6">
              {/* 輸入好友碼區塊 */}
              <div className="space-y-4">
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-on-surface-primary">{t('friendCode.enterCode')}</h3>
                  <p className="text-sm text-on-surface-tertiary mt-1">{t('friendCode.enterCodeHint')}</p>
                </div>

                <div className="space-y-3">
                  <input
                    type="text"
                    value={friendCodeInput}
                    onChange={(e) => {
                      setFriendCodeInput(e.target.value.toUpperCase());
                      setFriendCodeError('');
                    }}
                    placeholder="ATK-XXXXXX"
                    maxLength={10}
                    className="w-full px-4 py-3 bg-surface-tertiary border border-[var(--surface-border)] rounded-lg text-on-surface-primary text-center text-xl font-mono tracking-[0.2em] focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />

                  {friendCodeError && (
                    <p className="text-sm text-red-400">{friendCodeError}</p>
                  )}

                  <button
                    onClick={handleFriendCodeSubmit}
                    disabled={friendCodeProcessing || !friendCodeInput.trim()}
                    className={`
                      w-full px-4 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2
                      ${friendCodeProcessing || !friendCodeInput.trim()
                        ? 'bg-surface-tertiary text-on-surface-tertiary cursor-not-allowed'
                        : 'bg-accent hover:opacity-90 text-white'
                      }
                    `}
                  >
                    {friendCodeProcessing ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        {t('common.processing')}
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                        </svg>
                        {t('friendList.addFriend')}
                      </>
                    )}
                  </button>

                  {/* 送出之後：等對方確認（審查 M1） */}
                  {awaiting && awaiting.via === 'code' && phase && (
                    <FriendConfirmStatus phase={phase} name={awaiting.name} via="code" syncFailed={awaiting.syncFailed} />
                  )}
                </div>

              </div>

              {/* 分隔線 */}
              <div className="flex items-center gap-4">
                <div className="flex-1 h-px bg-[var(--surface-border)]" />
                <span className="text-sm text-on-surface-tertiary">{t('common.or')}</span>
                <div className="flex-1 h-px bg-[var(--surface-border)]" />
              </div>

              {/* 我的好友碼 */}
              <FriendCode
                onCodeGenerated={(code) => {
                  devLog('[AddFriendModal] Friend code generated:', code.slice(0, 30) + '...');
                }}
              />
            </div>
          )}
        </div>

        {/* 說明區域 */}
        <div className="px-6 py-4 bg-surface-tertiary border-t border-[var(--surface-border)]">
          {activeTab === 'scan' && (
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 3H4a1 1 0 00-1 1v3" />
                <path d="M17 3h3a1 1 0 011 1v3" />
                <path d="M7 21H4a1 1 0 01-1-1v-3" />
                <path d="M17 21h3a1 1 0 001-1v-3" />
                <rect x="7" y="7" width="4" height="4" fill="currentColor" stroke="none" />
                <rect x="13" y="7" width="4" height="4" fill="currentColor" stroke="none" />
                <rect x="7" y="13" width="4" height="4" fill="currentColor" stroke="none" />
              </svg>
              <div className="text-sm">
                <p className="text-on-surface-primary font-medium">{t('friendCode.scanAddFriend')}</p>
                <p className="text-on-surface-tertiary mt-0.5">
                  {t('friendCode.scanAddFriendHint')}
                </p>
              </div>
            </div>
          )}
          {activeTab === 'myqr' && (
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <div className="text-sm">
                <p className="text-on-surface-primary font-medium">{t('friendCode.faceToFaceVerify')}</p>
                <p className="text-on-surface-tertiary mt-0.5">
                  {t('friendCode.faceToFaceVerifyHint')}
                </p>
              </div>
            </div>
          )}
          {activeTab === 'friendcode' && (
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="text-sm">
                <p className="text-on-surface-primary font-medium">{t('friendCode.codeUnverified')}</p>
                <p className="text-on-surface-tertiary mt-0.5">
                  {t('friendCode.codeUnverifiedHint')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddFriendModal;

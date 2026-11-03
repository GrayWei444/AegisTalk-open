/**
 * useCrypto Hook - 加密功能 React Hook
 *
 * 提供 WASM 加密模組的 React 整合
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  initCrypto,
  Identity,
  SignedPreKey,
  OneTimePreKey,
  Session,
  createPreKeyBundle,
  x3dhInitiator,
  x3dhResponder,
  getCryptoVersion,
  toBase64,
  fromBase64,
  type PreKeyBundleData,
  type RatchetMessage,
} from '@services/crypto';
import * as db from '../services/database';
import { registerClearPeerSession } from '../services/cryptoSessionControl';
import { backup } from '@ext/backup';
import type { BlobSignedPreKey } from '../ext/types';

/** 自己的 spk 進帳號備份（恢復時還原同一把；官方版 AegisID blob，社群版目前沒有備份） */
function setOwnSignedPreKey(spk: BlobSignedPreKey | null): void {
  backup.setOwnSignedPreKey(spk);
}
import {
  getEncryptionKey,
  encryptData,
  decryptData,
  isEncryptedData,
  hasUnreadableKeys,
} from '../services/keyEncryption';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';

// 金鑰儲存類型
interface StoredKeys {
  identity: {
    publicKey: string; // Base64
    privateKey: string; // Base64
  };
  signedPreKey: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    timestamp: number;
  };
  oneTimePreKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
}

// Hook 狀態
interface CryptoState {
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  identity: Identity | null;
  signedPreKey: SignedPreKey | null;
  oneTimePreKeys: OneTimePreKey[];
  keysLocked: boolean; // true when encrypted keys exist but no encryption key is available
  version: string | null;
}

// Session 儲存 key
const SESSIONS_STORAGE_KEY = 'mist_sessions';

// IndexedDB 儲存鍵
const STORAGE_KEY = 'mist_keys';

// Session 版本 - 當 Double Ratchet 邏輯修改時需要遞增此值
// v2: 修正 initAsBob chain key 問題
const SESSION_VERSION = 2;
const SESSION_VERSION_KEY = 'mist_session_version';

// WASM 核心版本儲存鍵 - 當 WASM 核心更新時自動清除舊 session
const WASM_CORE_VERSION_KEY = 'mist_wasm_core_version';

/**
 * 加密功能 Hook
 */
// generateIdentity 的 saveKeys 落地 promise — 呼叫端 await 用（取代 mist_keys timer poll；
// 背景分頁 timer 節流下 100ms poll 永久卡死，2026-07-19 test30 取證）。
let _lastKeysSavePromise: Promise<unknown> = Promise.resolve();
export function waitKeysSaved(): Promise<unknown> { return _lastKeysSavePromise; }

export function useCrypto() {
  const [state, setState] = useState<CryptoState>({
    initialized: false,
    loading: true,
    error: null,
    identity: null,
    signedPreKey: null,
    oneTimePreKeys: [],
    version: null,
    keysLocked: false,
  });

  // 使用 ref 存儲 sessions，避免 React state 更新延遲問題
  // 這樣 session 的存取是同步的，不會有 race condition
  const sessionsRef = useRef<Map<string, Session>>(new Map());
  // 每個 sender「上次 accept 的 ephemeral」（抄 AegisTrans）：用來區分「MQTT 重投遞同一 X3DH_INIT
  //   (同 ephemeral → 保留 ratchet)」vs「對方重啟/恢復/重加建新 session(異 ephemeral → 換新)」。
  //   取代易 glare 的 sessionReset 旗標。in-memory（與 AegisTrans 一致）。
  const acceptedEphemeralsRef = useRef<Map<string, string>>(new Map());
  // 我「最近一次對某 peer 發起 X3DH(createSession as Alice)」的時間戳。用於 glare tiebreak：
  //   兩台同時恢復都發起時，收端靠「我也剛發起 + 我 pubkey 較大」決定保留自己的 initiator session
  //   （較小那邊 replace 成 responder）→ 收斂到單一 session，不互撞。非對稱(只有一邊發起)時對方沒此
  //   紀錄 → 不觸發 tiebreak → 正常 accept/replace（修「只有一邊恢復也要通」）。
  const initiatedAtRef = useRef<Map<string, number>>(new Map());

  // Phase 29: 儲存 privateKey base64 供多設備同步使用
  const privateKeyBase64Ref = useRef<string | null>(null);

  // Track latest state in ref for cleanup (avoids stale closure capturing initial state)
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * 初始化加密模組
   */
  const initialize = useCallback(async () => {
    try {
      devLog('[DIAG] useCrypto: initialize starting...');
      setState((s) => ({ ...s, loading: true, error: null }));

      // 初始化 WASM
      await initCrypto();
      devLog('[DIAG] useCrypto: WASM initCrypto() done');

      // Migrate keys from localStorage to SQLite (one-time)
      await db.migrateFromLocalStorage(STORAGE_KEY);
      await db.migrateFromLocalStorage(SESSIONS_STORAGE_KEY);
      await db.migrateFromLocalStorage(SESSION_VERSION_KEY);
      await db.migrateFromLocalStorage(WASM_CORE_VERSION_KEY);

      // 取得當前 WASM 核心版本
      const currentWasmVersion = getCryptoVersion();
      devLog('[useCrypto] WASM core version:', currentWasmVersion);

      // 檢查 WASM 核心版本，如果版本不符則清除舊的 sessions
      const storedWasmVersion = await db.getSetting(WASM_CORE_VERSION_KEY) ?? localStorage.getItem(WASM_CORE_VERSION_KEY);
      if (storedWasmVersion && storedWasmVersion !== currentWasmVersion) {
        devWarn(`[useCrypto] ⚠️ WASM core version changed: ${storedWasmVersion} -> ${currentWasmVersion}`);
        devWarn('[useCrypto] Clearing all sessions due to WASM core update...');
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
        db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
        // 通知用戶（可選）
        devWarn('[useCrypto] Sessions cleared - need to re-establish connections with contacts');
      }
      localStorage.setItem(WASM_CORE_VERSION_KEY, currentWasmVersion);
      db.setSetting(WASM_CORE_VERSION_KEY, currentWasmVersion).catch(() => {});

      // 檢查 session 協議版本，如果版本不符則清除舊的 sessions
      const storedVersion = await db.getSetting(SESSION_VERSION_KEY) ?? localStorage.getItem(SESSION_VERSION_KEY);
      const currentVersion = SESSION_VERSION.toString();
      if (storedVersion !== currentVersion) {
        devLog(`[useCrypto] Session protocol version mismatch: ${storedVersion} -> ${currentVersion}, clearing old sessions`);
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
        db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
        localStorage.setItem(SESSION_VERSION_KEY, currentVersion);
        db.setSetting(SESSION_VERSION_KEY, currentVersion).catch(() => {});
      }

      // 嘗試從 SQLite 載入已存在的金鑰（fallback to localStorage）
      const storedKeys = await loadKeysFromDb();

      if (storedKeys) {
        // 還原金鑰
        const identity = Identity.fromPrivateKey(fromBase64(storedKeys.identity.privateKey));
        const signedPreKey = SignedPreKey.fromPrivateKey(
          fromBase64(storedKeys.signedPreKey.privateKey),
          storedKeys.signedPreKey.id,
          fromBase64(storedKeys.signedPreKey.signature),
          storedKeys.signedPreKey.timestamp
        );
        setOwnSignedPreKey(storedKeys.signedPreKey); // 載入的 spk 進 blob cache → flush 寫進 VPS blob，恢復可還原同一把
        let oneTimePreKeys = storedKeys.oneTimePreKeys.map((k) =>
          OneTimePreKey.fromPrivateKey(fromBase64(k.privateKey), k.id)
        );

        // If no OTPs available (e.g. after device transfer/recovery), generate fresh ones
        if (oneTimePreKeys.length === 0) {
          devLog('[useCrypto] No OTPs found — generating fresh prekeys');
          oneTimePreKeys = Array.from({ length: 10 }, (_, i) =>
            OneTimePreKey.generate(i + 1)
          );
          // Persist updated keys with new OTPs
          await saveKeys({
            identity: storedKeys.identity,
            signedPreKey: storedKeys.signedPreKey,
            oneTimePreKeys: oneTimePreKeys.map((k) => ({
              id: k.id,
              publicKey: k.publicKeyBase64,
              privateKey: toBase64(k.privateKey),
            })),
          });
        }

        // 還原 sessions (async to prefer SQLite source)
        await restoreSessions(sessionsRef);

        privateKeyBase64Ref.current = storedKeys.identity.privateKey;

        devLog(`[DIAG] useCrypto: Keys loaded OK, identity=${identity.publicKeyBase64.slice(0,12)}...`);
        setState((s) => ({
          ...s,
          initialized: true,
          loading: false,
          identity,
          signedPreKey,
          oneTimePreKeys,
          version: getCryptoVersion(),
        }));
      } else {
        // No keys loaded — check if data is encrypted (locked, not absent)
        const rawData = await db.getSetting(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY);
        const locked = !!rawData && isEncryptedData(rawData);
        devLog(`[DIAG] useCrypto: No keys loaded, locked=${locked}, rawData=${!!rawData}`);
        if (locked) {
          devWarn('[useCrypto] Keys are encrypted but no encryption key available — keys locked');
        }
        setState((s) => ({
          ...s,
          initialized: true,
          loading: false,
          keysLocked: locked,
          version: getCryptoVersion(),
        }));
      }
    } catch (error) {
      devLog('[DIAG] useCrypto: initialize FAILED:', error);
      setState((s) => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, []);

  /**
   * 生成新的身份金鑰
   */
  const generateIdentity = useCallback(() => {
    if (!state.initialized) {
      throw new Error('Crypto not initialized');
    }

    // 生成金鑰
    const identity = Identity.generate();
    const signedPreKey = SignedPreKey.generate(identity, 1);
    const oneTimePreKeys = Array.from({ length: 10 }, (_, i) =>
      OneTimePreKey.generate(i + 1)
    );

    // 儲存金鑰 (async — fire-and-forget since generateIdentity is sync)
    console.error('[useCrypto] generateIdentity: saving keys pk=' + identity.publicKeyBase64.slice(0, 16));
    _lastKeysSavePromise = saveKeys({
      identity: {
        publicKey: identity.publicKeyBase64,
        privateKey: toBase64(identity.privateKey),
      },
      signedPreKey: {
        id: signedPreKey.id,
        publicKey: signedPreKey.publicKeyBase64,
        privateKey: toBase64(signedPreKey.privateKey),
        signature: toBase64(signedPreKey.signature),
        timestamp: signedPreKey.timestamp,
      },
      oneTimePreKeys: oneTimePreKeys.map((k) => ({
        id: k.id,
        publicKey: k.publicKeyBase64,
        privateKey: toBase64(k.privateKey),
      })),
    }).then(() => {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('mist_keys') : null;
      console.error('[useCrypto] saveKeys DONE — mist_keys in localStorage: ' + (ls ? 'present(len=' + ls.length + ')' : 'NULL'));
    }).catch(err => console.error('[useCrypto] saveKeys FAILED:', err?.message || err));

    // 新產生的 spk 也進 blob cache → 註冊後 flush 把它寫進 VPS blob，日後恢復還原同一把（不再重生）。
    setOwnSignedPreKey({
      id: signedPreKey.id,
      publicKey: signedPreKey.publicKeyBase64,
      privateKey: toBase64(signedPreKey.privateKey),
      signature: toBase64(signedPreKey.signature),
      timestamp: signedPreKey.timestamp,
    });

    // 剛用解鎖中的金鑰產好、存好的身分不是鎖著的。隔離區有舊資料時 unlockAndReloadKeys 會保持鎖住（B21），
    //   使用者在 AuthScreen 確定開新帳號才會走到這裡 —— 不解鎖的話新帳號一直 keysLocked、連不上 MQTT
    setState((s) => ({
      ...s,
      identity,
      signedPreKey,
      oneTimePreKeys,
      keysLocked: false,
    }));

    return identity.publicKeyBase64;
  }, [state.initialized]);

  /**
   * 取得 PreKeyBundle
   */
  const getPreKeyBundle = useCallback((): string | null => {
    const { identity, signedPreKey, oneTimePreKeys } = state;
    if (!identity || !signedPreKey) {
      return null;
    }

    const oneTimePreKey = oneTimePreKeys[0]; // 使用第一個可用的 OTP

    const bundleData: PreKeyBundleData = {
      identityKey: identity.publicKey,
      signedPreKey: {
        id: signedPreKey.id,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        timestamp: signedPreKey.timestamp,
      },
      oneTimePreKey: oneTimePreKey
        ? {
            id: oneTimePreKey.id,
            publicKey: oneTimePreKey.publicKey,
          }
        : undefined,
    };

    return createPreKeyBundle(bundleData);
  }, [state]);

  /**
   * 建立與對方的會話 (作為發起者)
   */
  const createSession = useCallback(
    (
      recipientIdentityPublic: Uint8Array,
      recipientSignedPrekeyPublic: Uint8Array,
      recipientSignedPrekeySignature: Uint8Array,
      recipientOneTimePrekeyPublic?: Uint8Array,
      recipientOneTimePrekeyId?: number,
      forceFresh?: boolean
    ) => {
      const { identity, signedPreKey } = state;
      if (!identity || !signedPreKey) {
        throw new Error('Identity not initialized');
      }

      // 執行 X3DH
      const x3dhResult = x3dhInitiator(
        identity,
        recipientIdentityPublic,
        recipientSignedPrekeyPublic,
        recipientSignedPrekeySignature,
        recipientOneTimePrekeyPublic,
        recipientOneTimePrekeyId
      );

      // 建立 Double Ratchet 會話 (使用 X3DH 的臨時金鑰對)
      const session = Session.initAsAlice(
        x3dhResult.sharedSecret,
        recipientSignedPrekeyPublic,
        x3dhResult.ephemeralPrivateKey,
        x3dhResult.ephemeralPublicKey
      );

      // 歸零敏感密鑰材料
      x3dhResult.sharedSecret.fill(0);
      x3dhResult.ephemeralPrivateKey.fill(0);

      // 儲存會話到 ref（同步，立即可用）
      const recipientKeyBase64 = toBase64(recipientIdentityPublic);

      // Idempotency: 預設已有 session 就拒絕覆蓋（防 MQTT 重投遞同一封握手訊息重置 ratchet）。
      // ⚠️ forceFresh（QR 重加 / SessionRepair / PreKeyReq 等 sessionReset 路徑）例外：必須改用「剛建的
      //   新 Alice session」，否則我方停在舊 ratchet 卻送出新 ephemeral → 收端 forceReset 用新 ephemeral
      //   建 Bob → 兩邊 ratchet 不同源 → 每則訊息 aead（GPT 抓到的發起方真因；也防 clearPeerSession 清錯 instance）。
      const existingForRecipient = sessionsRef.current.get(recipientKeyBase64);
      if (existingForRecipient && !forceFresh) {
        // 釋放剛建立但未使用的新 session
        try { session.free(); } catch { /* ignore */ }
        return {
          session: existingForRecipient,
          ephemeralPublicKey: x3dhResult.ephemeralPublicKey,
          usedOneTimePrekeyId: x3dhResult.usedOneTimePrekeyId,
        };
      }
      if (existingForRecipient) {
        // forceFresh：丟掉舊 session，改用新建的（與送出的新 ephemeral 同源）。
        try { existingForRecipient.free(); } catch { /* ignore */ }
        console.error('[DIAG:CRYPTO] createSession forceFresh — replaced existing Alice session for', recipientKeyBase64.slice(0, 16));
      }

      sessionsRef.current.set(recipientKeyBase64, session);
      acceptedEphemeralsRef.current.delete(recipientKeyBase64); // 現在我是 Alice → 清掉舊的「我曾 accept 的 ephemeral」紀錄
      initiatedAtRef.current.set(recipientKeyBase64, Date.now()); // 記下「我發起 X3DH」時刻，供收端 glare tiebreak
      console.error('[DIAG:CRYPTO] Session created as Alice + queued save for:', recipientKeyBase64.slice(0, 16)); // prod 可見，確認發起方真的建成新 Alice
      devLog('[useCrypto] Total sessions:', sessionsRef.current.size);

      // 持久化 session
      saveSession(recipientKeyBase64, session);

      return {
        session,
        ephemeralPublicKey: x3dhResult.ephemeralPublicKey,
        usedOneTimePrekeyId: x3dhResult.usedOneTimePrekeyId,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.identity, state.signedPreKey]
  );

  /**
   * 接受對方建立的會話 (作為接收者)
   *
   * Idempotent: 若已有 session，直接回傳現有 session，不重新初始化
   * （防止 MQTT 重投遞 X3DH_INIT 重置 Double Ratchet 狀態 → aead::Error）
   */
  const acceptSession = useCallback(
    (
      senderIdentityPublic: Uint8Array,
      senderEphemeralPublic: Uint8Array,
      usedOneTimePrekeyId?: number,
      forceReset?: boolean,
      /**
       * 這個 forceReset 是不是「帳號恢復的自動 SessionRepair」送來的（相對於 QR 重加）。
       * 只有它會套用下面的 glare tiebreak —— QR 重加是使用者當面掃的，必須永遠贏。
       */
      fromRepair?: boolean
    ) => {
      const { identity, signedPreKey, oneTimePreKeys } = state;
      if (!identity || !signedPreKey) {
        throw new Error('Identity not initialized');
      }

      // Idempotency 靠 ephemeral 追蹤（抄 AegisTrans，取代易 glare 的 sessionReset 旗標）：
      //   1. 同 sender + 同 ephemeral → MQTT 重投遞 → SKIP，保留現有 ratchet。
      //   2. 同 sender + 不同 ephemeral → 對方重啟/恢復/重加建新 session → REPLACE，
      //      否則本地 ratchet 跟對方對不上 → 每則訊息 aead::Error。
      //   「兩台同時恢復雙建 → 互撞 glare」由發起端 repairMissingSessions 的「唯一發起者」防止：
      //   **lex-larger pubkey 才發起 X3DH，較小方改送 PREKEY_REQUEST 請較大方發起**（2026-08-19 才真的
      //   實作 —— 之前這行註解只是聲稱、repair 其實兩邊都無條件發起 → 兩邊都是 Bob → 永遠 aead，
      //   完整診斷見 docs/CRYPTO_X3DH_GLARE_20260819.md）。下面的 glare tiebreak 保留當舊版對端的備援。
      const senderKeyBase64Check = toBase64(senderIdentityPublic);
      const senderEphemeralB64 = toBase64(senderEphemeralPublic);
      const existingSession = sessionsRef.current.get(senderKeyBase64Check);
      const lastEphemeralB64 = acceptedEphemeralsRef.current.get(senderKeyBase64Check);
      if (existingSession && lastEphemeralB64 === senderEphemeralB64) {
        diagLog('[DIAG:CRYPTO] acceptSession SKIPPED — redelivery (same ephemeral) for', senderKeyBase64Check.slice(0, 16));
        return existingSession;
      }
      // Glare tiebreak（兩台同時恢復都發起 X3DH）：若我「30s 內也對這人發起過 X3DH」且我 pubkey 較大
      //   → 保留我的 initiator session、忽略對方的 X3DH_INIT（較小那邊會 replace 成 responder）→ 收斂到
      //   單一 session、不互撞。非對稱(只有一邊恢復發起)時我沒「剛發起」紀錄 → 不觸發 → 照下面 ephemeral
      //   replace 正常換新（修「只恢復一邊也要通」）。
      const recentlyInitiated = (Date.now() - (initiatedAtRef.current.get(senderKeyBase64Check) ?? 0)) < 30_000;
      /**
       * ⚠️ 這段（含下面的 glareKeepMine && fromRepair）是**備援**，不是主要防線（2026-08-19 定案）：
       *
       * 主要防線在發起端 `repairMissingSessions` 的唯一發起者（lex-larger 才發起）——
       * 兩台新版同時恢復時，較小方根本不會送 INIT，glare 不會發生。
       *
       * 這裡的備援只攔「對端是舊版（兩邊都發起）」的情況，而且**它在 repair 的 reset 路徑上
       * 其實讀不到證據**：AppProvider 在呼叫 acceptSession 前就 clearPeerSession（session 與
       * initiatedAt 都被清掉，hasSession=false）→ 真正在 reset 前生效的檢查已移到
       * AppProvider 的 X3DH_INIT handler（clearPeerSession 之前，用 recentlyInitiatedTo）。
       * 完整事故經過見 docs/CRYPTO_X3DH_GLARE_20260819.md（兩層防護都沒生效 → 兩邊都是 Bob）。
       *
       * ⚠️ **只對 repair 來的 forceReset 套用**：QR 重加是使用者當面掃的，語意是「以最新這次為準」，
       * 必須永遠贏，不能被對方 30 秒內的自動 repair 蓋掉。
       */
      const glareKeepMine = existingSession && recentlyInitiated
        && identity.publicKeyBase64 > senderKeyBase64Check;
      diagLog('[DIAG:GLARE] fromRepair=', fromRepair, 'hasSession=', !!existingSession,
              'recentlyInitiated=', recentlyInitiated,
              'lexLarger=', identity.publicKeyBase64 > senderKeyBase64Check,
              'for', senderKeyBase64Check.slice(0, 8));
      if (glareKeepMine && fromRepair) {
        diagLog('[DIAG:CRYPTO] acceptSession GLARE(repair) — lex-larger + recently initiated → keep my initiator session for', senderKeyBase64Check.slice(0, 16));
        return existingSession;
      }
      if (forceReset) {
        initiatedAtRef.current.delete(senderKeyBase64Check);
        if (existingSession) console.error('[DIAG:CRYPTO] acceptSession forceReset — dropping existing session, rebuilding as Bob for', senderKeyBase64Check.slice(0, 16));
      } else if (glareKeepMine) {
        diagLog('[DIAG:CRYPTO] acceptSession GLARE — lex-larger + recently initiated → keep my initiator session for', senderKeyBase64Check.slice(0, 16));
        return existingSession;
      }
      // 走到這＝不是 redelivery(同 ephemeral 已 return)、也不是 glare 我方保留(已 return)。
      //   故要(重)建 session：先釋放舊的（換 key / glare 較小方放棄自己的 initiator session → 改當 responder）。
      if (existingSession) {
        console.error('[useCrypto] acceptSession (re)building — replacing existing session for', senderKeyBase64Check.slice(0, 16));
        try { existingSession.free(); } catch { /* ignore */ }
        sessionsRef.current.delete(senderKeyBase64Check);
        acceptedEphemeralsRef.current.delete(senderKeyBase64Check);
      }

      // 找到使用的 OTP
      let usedOTP: OneTimePreKey | null = null;
      if (usedOneTimePrekeyId !== undefined) {
        const otpIndex = oneTimePreKeys.findIndex(
          (k) => k.id === usedOneTimePrekeyId
        );
        if (otpIndex >= 0) {
          usedOTP = oneTimePreKeys[otpIndex];
          // 從列表中移除已使用的 OTP
          setState((s) => ({
            ...s,
            oneTimePreKeys: s.oneTimePreKeys.filter(
              (k) => k.id !== usedOneTimePrekeyId
            ),
          }));
        }
      }

      // 執行 X3DH + 建立 Double Ratchet（responder=Bob）。失敗一律 console.error（prod 也看得到，
      //   別讓收方靜默斷在半路 → 對方訊息永遠 aead 卻查不到原因，正是 GPT 質疑的「沒建成 Bob session」）。
      let sharedSecret: Uint8Array;
      let session: Session;
      try {
        sharedSecret = x3dhResponder(
          identity,
          signedPreKey,
          usedOTP,
          senderIdentityPublic,
          senderEphemeralPublic
        );
        session = Session.initAsBob(
          sharedSecret,
          signedPreKey.privateKey,
          signedPreKey.publicKey,
          senderEphemeralPublic
        );
      } catch (e) {
        console.error('[DIAG:CRYPTO] acceptSession FAILED to build Bob session for', senderKeyBase64Check.slice(0, 16), ':', String(e));
        throw e;
      }

      // 歸零敏感密鑰材料
      sharedSecret.fill(0);

      // 儲存會話到 ref（同步，立即可用）
      const senderKeyBase64 = toBase64(senderIdentityPublic);
      sessionsRef.current.set(senderKeyBase64, session);
      acceptedEphemeralsRef.current.set(senderKeyBase64, senderEphemeralB64); // 記住這次 ephemeral，下次同→skip/異→replace
      console.error('[DIAG:CRYPTO] Session created as Bob + queued save for:', senderKeyBase64.slice(0, 16)); // prod 可見，確認 responder 真的建成
      devLog('[useCrypto] Total sessions:', sessionsRef.current.size);

      // 持久化 session
      saveSession(senderKeyBase64, session);

      return session;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.identity, state.signedPreKey, state.oneTimePreKeys]
  );

  // Per-session 互斥鎖，防止並發 encrypt/decrypt 損壞 Ratchet 狀態
  const sessionLocksRef = useRef<Map<string, Promise<void>>>(new Map());

  const withSessionLock = useCallback(
    async <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
      const prev = sessionLocksRef.current.get(key) ?? Promise.resolve();
      let resolve: () => void;
      const next = new Promise<void>((r) => { resolve = r; });
      sessionLocksRef.current.set(key, next);
      try {
        await prev;
        // ⚠️ 必須 await fn()：若 fn 回傳 Promise（async callback），
        // `return fn()` 會讓 finally 提前釋放鎖 → 並發 encrypt/decrypt race
        return await fn();
      } finally {
        resolve!();
      }
    },
    []
  );

  /**
   * 加密訊息（async — 序列化同一 session 的操作）
   *
   * Phase 35: 單裝置政策已生效（talk_active_device），多裝置 session 同步邏輯已移除
   */
  const encrypt = useCallback(
    async (recipientPublicKeyBase64: string, plaintext: string): Promise<RatchetMessage> => {
      const result = await withSessionLock(recipientPublicKeyBase64, async () => {
        // ⚠️ ratchet 狀態唯一真實來源是 DB：每次 encrypt 前都從 DB 重載 session，不信任 in-memory map。
        // 元件 remount churn 會讓多個 mount 各持有分叉的 session 快取——舊 mount 可能仍停在「尚未首送」
        // 的 None 狀態。若用 stale None-state session 做首送，會 ratchet 出「第二把」sending DH（≠ DB 已
        // 落地那把）→ 對端 root key 已前進 → aead::Error。對齊 decrypt 的 aead-retry：reload→set→op→save。
        let session = sessionsRef.current.get(recipientPublicKeyBase64);
        try {
          // 先等排隊中的存檔寫完再讀（對應群星 B29）：acceptSession／createSession 剛換了新 session、還沒落 DB 時
          //   讀到的是舊的 —— 用舊的加密再存回去，蓋掉新的，之後每則都 aead
          await flushSessionWrites();
          const stored = await loadAllSessionsFromDb();
          const base64Data = stored[recipientPublicKeyBase64];
          if (base64Data) {
            const fresh = Session.deserialize(fromBase64(base64Data));
            sessionsRef.current.set(recipientPublicKeyBase64, fresh);
            session = fresh;
          }
        } catch (reloadErr) {
          // DB 重載失敗（極早期 cold-start、keys 未解鎖）→ 退回 in-memory（首送前 DB 尚無 blob 的短窗）
          devWarn('[useCrypto] encrypt: DB session reload failed, using in-memory session:', String(reloadErr));
        }
        if (!session) {
          devLog('[useCrypto] No session for encrypt. Looking for:', recipientPublicKeyBase64.slice(0, 16) + '...');
          devLog('[useCrypto] Available sessions:', Array.from(sessionsRef.current.keys()).map(k => k.slice(0, 16) + '...'));
          throw new Error('No session with this recipient');
        }
        const encrypted = session.encrypt(plaintext);
        // 加密後 **同步等待** 持久化完成（ratchet 狀態已推進，必須先落 DB 才能回傳訊息給呼叫端）
        // 否則 page reload 在 save 完成前發生 → DB 回退 → 下次 encrypt 重用已用過的 Ns → 對端 aead::Error
        await saveSession(recipientPublicKeyBase64, session);
        return encrypted;
      });

      return result;
    },
    [withSessionLock]
  );

  /**
   * 解密訊息（async — 序列化同一 session 的操作）
   * aead::Error 時自動從 DB 重載 session 重試一次（修復群聊→個聊切換導致的 ratchet 不同步）
   */
  const decrypt = useCallback(
    async (senderPublicKeyBase64: string, message: RatchetMessage): Promise<string> => {
      const tryDecrypt = async (session: Session): Promise<string> => {
        const decrypted = session.decryptToString(message);
        // 解密後 **同步等待** 持久化完成（ratchet 狀態已推進）
        // 否則 page reload 在 save 完成前發生 → DB 回退 → 下次收到同一訊息會再次推進 Nr → aead::Error
        await saveSession(senderPublicKeyBase64, session);
        return decrypted;
      };

      // 第一次嘗試：使用記憶體中的 session
      try {
        return await withSessionLock(senderPublicKeyBase64, async () => {
          const session = sessionsRef.current.get(senderPublicKeyBase64);
          if (!session) {
            console.error('[useCrypto] No session for decrypt:', senderPublicKeyBase64.slice(0, 16) + '...');
            throw new Error('No session with this sender');
          }
          return tryDecrypt(session);
        });
      } catch (firstErr) {
        const errMsg = String(firstErr);
        // 只有 aead 相關錯誤才重試（其他錯誤直接拋出）
        if (!errMsg.includes('aead') && !errMsg.includes('AEAD') && !errMsg.includes('decrypt')) {
          throw firstErr;
        }

        diagLog('[DIAG:CRYPTO] Decrypt FAILED (aead), reloading session from DB for retry:', senderPublicKeyBase64.slice(0, 16) + '...', 'err:', errMsg);

        // 第二次嘗試：從 DB 重載 session（可能其他 tab/設備更新了 ratchet 狀態）
        try {
          await flushSessionWrites();   // 同上（B29）：別讀到排隊中、還沒寫進去的舊狀態
          const stored = await loadAllSessionsFromDb();
          const base64Data = stored[senderPublicKeyBase64];
          if (!base64Data) {
            diagLog('[DIAG:CRYPTO] No session in DB for retry — giving up');
            throw firstErr;
          }

          const freshSession = Session.deserialize(fromBase64(base64Data));

          return await withSessionLock(senderPublicKeyBase64, async () => {
            // 用從 DB 載入的 fresh session 替換記憶體中的
            sessionsRef.current.set(senderPublicKeyBase64, freshSession);
            try {
              const result = await tryDecrypt(freshSession);
              diagLog('[DIAG:CRYPTO] Decrypt SUCCEEDED on retry with DB session for', senderPublicKeyBase64.slice(0, 16));
              return result;
            } catch (retryErr) {
              diagLog('[DIAG:CRYPTO] Decrypt FAILED on retry too for', senderPublicKeyBase64.slice(0, 16), ':', String(retryErr));
              throw retryErr;
            }
          });
        } catch (reloadErr) {
          if (reloadErr === firstErr) throw firstErr;
          console.error('[useCrypto] Session reload/retry failed:', reloadErr);
          throw firstErr; // 拋出原始錯誤
        }
      }
    },
    [withSessionLock]
  );

  /**
   * 解鎖並重新載入加密的金鑰（PIN 驗證或生物辨識成功後呼叫）
   * 需要先呼叫 setEncryptionKey() 設定加密金鑰
   */
  const unlockAndReloadKeys = useCallback(async (): Promise<boolean> => {
    try {
      const storedKeys = await loadKeysFromDb();
      if (!storedKeys) {
        /**
         * ⚠️ 有資料但解不開（被搬去隔離區）時**不可以**把 keysLocked 設 false —— 那會讓 AppProvider 產一個全新身分
         * 蓋掉這個帳號（對應群星 B21）。保持鎖住，由 AuthScreen 導去恢復（刷臉＋PIN 從雲端拿回來）。
         */
        if (hasUnreadableKeys()) {
          console.error('[useCrypto] unlockAndReloadKeys — stored keys unreadable (quarantined); staying locked');
          return false;
        }
        // 真的沒有金鑰（新裝置／乾淨狀態）→ 讓 AppProvider 產身分
        devWarn('[useCrypto] unlockAndReloadKeys — no keys found, resetting keysLocked');
        setState((s) => ({ ...s, keysLocked: false }));
        return false;
      }

      const identity = Identity.fromPrivateKey(fromBase64(storedKeys.identity.privateKey));
      const signedPreKey = SignedPreKey.fromPrivateKey(
        fromBase64(storedKeys.signedPreKey.privateKey),
        storedKeys.signedPreKey.id,
        fromBase64(storedKeys.signedPreKey.signature),
        storedKeys.signedPreKey.timestamp
      );
      const oneTimePreKeys = storedKeys.oneTimePreKeys.map((k) =>
        OneTimePreKey.fromPrivateKey(fromBase64(k.privateKey), k.id)
      );

      await restoreSessions(sessionsRef);

      privateKeyBase64Ref.current = storedKeys.identity.privateKey;

      setState((s) => ({
        ...s,
        identity,
        signedPreKey,
        oneTimePreKeys,
        keysLocked: false,
      }));

      devLog('[useCrypto] Keys unlocked and restored successfully');
      return true;
    } catch (err) {
      console.error('[useCrypto] unlockAndReloadKeys failed:', err);
      return false;
    }
  }, []);

  /**
   * 清除所有金鑰
   */
  const clearKeys = useCallback(() => {
    // 釋放記憶體
    state.identity?.free();
    state.signedPreKey?.free();
    state.oneTimePreKeys.forEach((k) => k.free());
    sessionsRef.current.forEach((s) => s.free());

    // 清除儲存
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SESSIONS_STORAGE_KEY);
    localStorage.removeItem(SESSION_VERSION_KEY);
    localStorage.removeItem(WASM_CORE_VERSION_KEY);
    // Also clear from SQLite
    db.deleteSetting(STORAGE_KEY).catch(() => {});
    db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
    db.deleteSetting(SESSION_VERSION_KEY).catch(() => {});
    db.deleteSetting(WASM_CORE_VERSION_KEY).catch(() => {});

    // 清空 sessions ref
    sessionsRef.current = new Map();

    // Phase 29: 清除 privateKey ref
    privateKeyBase64Ref.current = null;

    devLog('[useCrypto] All keys and sessions cleared');

    setState((s) => ({
      ...s,
      identity: null,
      signedPreKey: null,
      oneTimePreKeys: [],
    }));
  }, [state.identity, state.signedPreKey, state.oneTimePreKeys]);

  /**
   * 只清除 sessions（保留身份金鑰）
   * 用於 session 同步問題時重建連線
   */
  const clearSessions = useCallback(() => {
    // 釋放 session 記憶體
    sessionsRef.current.forEach((s) => s.free());
    sessionsRef.current = new Map();

    // 清除 session 儲存
    localStorage.removeItem(SESSIONS_STORAGE_KEY);
    db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});

    devLog('[useCrypto] All sessions cleared (identity preserved)');
  }, []);

  /**
   * 清除「單一 peer」的 active session + ephemeral 追蹤（移除/重建好友時用）。
   * 真因：removeFriend 只刪 legacy ratchet_states，沒清 sessionsRef / mist_sessions →
   * 重加時 createSession idempotency guard 找到舊 session → 保留舊 ratchet 卻送新 ephemeral →
   * 兩邊對不上 aead。
   * 用 console.error 以便 prod build（已砍 console.log）也能在 logcat／E2E console 看到。
   */
  const clearSession = useCallback(async (peerPubkeyBase64: string) => {
    await withSessionLock(peerPubkeyBase64, async () => {
      const existing = sessionsRef.current.get(peerPubkeyBase64);
      if (existing) {
        try { existing.free(); } catch { /* ignore */ }
      }
      sessionsRef.current.delete(peerPubkeyBase64);
      acceptedEphemeralsRef.current.delete(peerPubkeyBase64);
      initiatedAtRef.current.delete(peerPubkeyBase64);
      await deleteStoredSession(peerPubkeyBase64);
      console.error('[useCrypto] clearSession — in-memory + durable session cleared for', peerPubkeyBase64.slice(0, 16));
    });
  }, [withSessionLock]);

  // 讓非 hook 的 store（chatStore.removeFriend）能呼叫上面的 per-peer 清除
  useEffect(() => {
    // 回傳 unregister：instance unmount 後不該再被呼叫（它的 sessionsRef 已無意義）
    return registerClearPeerSession(clearSession);
  }, [clearSession]);

  /**
   * 「我 30 秒內對這個 peer 發起過 X3DH（createSession 建過 Alice、INIT 已/將送出）」。
   * Glare tiebreak 的證據讀取口 —— 給 AppProvider 在 sessionReset 的清除動作**之前**判斷：
   * 放在 acceptSession 內判斷會因 clearPeerSession 先跑而讀不到（session 與 initiatedAt 都被清），
   * 2026-08-19 插樁證實（docs/CRYPTO_X3DH_GLARE_20260819.md §4.1）。
   */
  const recentlyInitiatedTo = useCallback((peerPubkeyBase64: string): boolean => {
    return Date.now() - (initiatedAtRef.current.get(peerPubkeyBase64) ?? 0) < 30_000;
  }, []);

  /** 這個 peer 目前有沒有 session —— 重複的 X3DH_INIT 只在有 session 時才當重投遞忽略（傳輸統一 X6） */
  const hasSessionWith = useCallback((peerPubkeyBase64: string): boolean => {
    return sessionsRef.current.has(peerPubkeyBase64);
  }, []);

  // 自動初始化
  useEffect(() => {
    initialize();

    // 清理函式 — use stateRef to capture latest state, not stale initial closure
    return () => {
      stateRef.current.identity?.free();
      stateRef.current.signedPreKey?.free();
      stateRef.current.oneTimePreKeys.forEach((k) => k.free());
      sessionsRef.current.forEach((s) => s.free());
      privateKeyBase64Ref.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // 狀態
    initialized: state.initialized,
    isInitialized: state.initialized, // 別名
    loading: state.loading,
    error: state.error,
    version: state.version,
    hasIdentity: !!state.identity,
    keysLocked: state.keysLocked, // 加密金鑰存在但無法解密（等待 PIN 輸入）
    identity: state.identity, // 暴露完整身份物件 (用於驗證簽章)
    signedPreKey: state.signedPreKey, // 暴露 SignedPreKey (用於 QR Code)
    oneTimePreKeys: state.oneTimePreKeys, // 暴露 OneTimePreKeys (用於 E2E 測試)
    publicKeyBase64: state.identity?.publicKeyBase64 ?? null,

    // 金鑰管理
    generateIdentity,
    getPreKeyBundle,
    clearKeys,
    clearSessions, // 只清除 sessions，保留身份
    clearSession, // 清除單一 peer 的 in-memory session（移除好友時用）
    unlockAndReloadKeys, // PIN/生物辨識成功後解鎖加密的金鑰

    // 會話管理
    createSession,
    acceptSession,
    recentlyInitiatedTo, // glare tiebreak 證據（AppProvider 在 sessionReset 清除前判斷用）
    hasSessionWith, // 重複 X3DH_INIT 去重（AppProvider 在 sessionReset 清除前判斷用）

    // 加解密
    encrypt,
    decrypt,
  };
}

// ============================================
// 金鑰儲存輔助函式
// ============================================

async function saveKeys(keys: StoredKeys): Promise<void> {
  try {
    const encKey = getEncryptionKey();
    if (!encKey) {
      // 結構性不變式：saveKeys 必定在 setEncryptionKey 之後呼叫。
      // 違反 → caller bug（先前 ephemeral fallback 寫的壞資料就是這條造成的）。
      throw new Error('saveKeys called without encryption key — PIN-derived encKey must be set first');
    }
    const json = JSON.stringify(keys);
    const encrypted = await encryptData(json, encKey);
    localStorage.setItem(STORAGE_KEY, encrypted);
    db.setSetting(STORAGE_KEY, encrypted).catch(() => {});
  } catch (error) {
    devWarn('Failed to save keys:', error);
  }
}

// Sync version (reads localStorage cache) - used during init before SQLite is ready
// Returns null if data is encrypted (caller must use async version after PIN entry)
function loadKeys(): StoredKeys | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    if (isEncryptedData(data)) return null; // Encrypted, need async decrypt
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to load keys:', error);
    return null;
  }
}

// Async version (prefers SQLite, fallback to localStorage; supports decryption)
async function loadKeysFromDb(): Promise<StoredKeys | null> {
  try {
    const sqliteCopy = await db.getSetting(STORAGE_KEY);
    const lsCopy = localStorage.getItem(STORAGE_KEY);
    const data = sqliteCopy ?? lsCopy;
    if (!data) return null;

    const encKey = getEncryptionKey();
    if (isEncryptedData(data) && encKey) {
      try {
        const decrypted = await decryptData(data, encKey);
        return JSON.parse(decrypted);
      } catch (e) {
        // ⚠️ 修復 2026-06-12（Test 33 揭發）：SQLite 與 localStorage 兩副本可能分歧 —
        // changePin 重加密後 setSetting 只進記憶體 DB，jeep 的 IndexedDB 持久化是
        // debounced；reload 撕在持久化前 → SQLite 是舊 PIN 密文、localStorage 是新的。
        // 舊版只試 SQLite 副本 → 新 PIN 解不開 → 「金鑰解密失敗」鎖在門外。
        // 改為：SQLite 副本解不開且 localStorage 有「不同」副本 → 試 localStorage，
        // 成功則回寫 SQLite 自癒。
        if (lsCopy && lsCopy !== data && isEncryptedData(lsCopy)) {
          console.error('[useCrypto] SQLite mist_keys undecryptable — trying diverged localStorage copy');
          const decrypted = await decryptData(lsCopy, encKey);  // 再失敗就丟給外層 catch
          db.setSetting(STORAGE_KEY, lsCopy).catch(() => {});
          console.error('[useCrypto] localStorage copy decrypted ✓ — SQLite copy healed');
          return JSON.parse(decrypted);
        }
        throw e;
      }
    }

    // Plaintext (legacy or pre-encryption)
    if (!isEncryptedData(data)) {
      const keys = JSON.parse(data) as StoredKeys;
      // Auto-migrate: re-encrypt if encryption key is available
      if (encKey) {
        const encrypted = await encryptData(JSON.stringify(keys), encKey);
        localStorage.setItem(STORAGE_KEY, encrypted);
        db.setSetting(STORAGE_KEY, encrypted).catch(() => {});
        devLog('[useCrypto] Keys migrated to encrypted storage');
      }
      return keys;
    }

    return null;
  } catch (error) {
    console.error('Failed to load keys from db:', error);
    return loadKeys();
  }
}

// ============================================
// Session 儲存輔助函式
// ============================================

interface StoredSessions {
  [publicKeyBase64: string]: string; // Base64 encoded serialized session
}

// Promise queue serializes async session saves to prevent read-modify-write races
let _sessionSaveQueue: Promise<void> = Promise.resolve();

/**
 * Persist ratchet session to DB+localStorage.
 *
 * ⚠️ CRITICAL — 呼叫端務必 await 本函式。
 * 若 fire-and-forget，in-memory session 已推進但 DB 尚未寫入；
 * 此時 page reload/crash 會讓 DB 回退成舊狀態 → Nr/Ns 與對端不同步 → aead::Error。
 *
 * 回傳的 Promise 在本次 save 真正寫入 DB/localStorage 後 resolve。
 * 內部仍透過 `_sessionSaveQueue` 序列化以避免 read-modify-write race。
 */
function saveSession(publicKeyBase64: string, session: Session): Promise<void> {
  let serialized: Uint8Array;
  let base64: string;
  try {
    serialized = session.serialize();
    base64 = toBase64(serialized);
  } catch (error) {
    devWarn('[useCrypto] Failed to serialize session:', error);
    return Promise.reject(error);
  }

  // Chain onto queue to ensure sequential read-modify-write across sessions
  const thisSave = _sessionSaveQueue.then(async () => {
    const encKey = getEncryptionKey();
    if (!encKey) {
      // Session 只在 identity 建立後才會存在；identity 建立前提是 encKey 已 set。
      // 走到這裡代表 caller 順序錯誤（regression）→ 拋出讓上層 .catch 記錄。
      throw new Error('saveSession called without encryption key — identity flow invariant violated');
    }
    const stored = await loadAllSessionsFromDb();
    stored[publicKeyBase64] = base64;
    const json = JSON.stringify(stored);
    const encrypted = await encryptData(json, encKey);
    localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
    await db.setSetting(SESSIONS_STORAGE_KEY, encrypted);
  });

  // 鏈上一個用 .catch 包，避免一次失敗把後續全部卡住
  _sessionSaveQueue = thisSave.catch(err => {
    devWarn('[useCrypto] Failed to save session:', err);
  });

  devLog('[useCrypto] Session save queued for:', publicKeyBase64.slice(0, 16) + '...');
  return thisSave;
}

/**
 * 等所有排隊中的 session 寫入(save/delete)真的落 DB。
 * QR 重加好友後、送第一則訊息前必呼叫 → 確保新 session 已 durable；否則 remount/reload 在 save
 * 完成前讀不到 → 「No stored sessions to restore」→ 退回舊/無 session → aead。
 */
export function flushSessionWrites(): Promise<void> {
  return _sessionSaveQueue;
}

function deleteStoredSession(publicKeyBase64: string): Promise<void> {
  const thisDelete = _sessionSaveQueue.then(async () => {
    const encKey = getEncryptionKey();
    if (!encKey) {
      throw new Error('deleteStoredSession called without encryption key — identity flow invariant violated');
    }
    const stored = await loadAllSessionsFromDb();
    if (!(publicKeyBase64 in stored)) return;
    delete stored[publicKeyBase64];
    const encrypted = await encryptData(JSON.stringify(stored), encKey);
    localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
    await db.setSetting(SESSIONS_STORAGE_KEY, encrypted);
  });

  _sessionSaveQueue = thisDelete.catch(err => {
    devWarn('[useCrypto] Failed to delete stored session:', err);
  });

  return thisDelete;
}

// Sync version (reads localStorage cache) - returns empty if encrypted
function loadAllSessions(): StoredSessions {
  try {
    const data = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!data) return {};
    if (isEncryptedData(data)) return {}; // Encrypted, need async version
    return JSON.parse(data);
  } catch (error) {
    console.error('[useCrypto] Failed to load sessions:', error);
    return {};
  }
}

// Async version (prefers SQLite, fallback to localStorage; supports decryption)
async function loadAllSessionsFromDb(): Promise<StoredSessions> {
  try {
    const data = await db.getSetting(SESSIONS_STORAGE_KEY) ?? localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!data) return {};

    const encKey = getEncryptionKey();
    if (isEncryptedData(data) && encKey) {
      const decrypted = await decryptData(data, encKey);
      return JSON.parse(decrypted);
    }

    if (!isEncryptedData(data)) {
      const sessions = JSON.parse(data) as StoredSessions;
      // Auto-migrate: re-encrypt if encryption key is available
      if (encKey) {
        const encrypted = await encryptData(JSON.stringify(sessions), encKey);
        localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
        db.setSetting(SESSIONS_STORAGE_KEY, encrypted).catch(() => {});
      }
      return sessions;
    }

    return {};
  } catch {
    return loadAllSessions();
  }
}

async function restoreSessions(sessionsRef: React.MutableRefObject<Map<string, Session>>): Promise<void> {
  try {
    const stored = await loadAllSessionsFromDb();
    const entries = Object.entries(stored);

    if (entries.length === 0) {
      devLog('[useCrypto] No stored sessions to restore');
      return;
    }

    for (const [publicKeyBase64, base64Data] of entries) {
      try {
        const bytes = fromBase64(base64Data);
        const session = Session.deserialize(bytes);
        sessionsRef.current.set(publicKeyBase64, session);
        devLog('[useCrypto] Session restored for:', publicKeyBase64.slice(0, 16) + '...');
      } catch (err) {
        console.error('[useCrypto] Failed to restore session for:', publicKeyBase64.slice(0, 16), err);
        // Remove corrupted session from the already-loaded data (NOT sync loadAllSessions which returns {} for encrypted data)
        delete stored[publicKeyBase64];
        const json = JSON.stringify(stored);
        const encKey = getEncryptionKey();
        if (encKey) {
          encryptData(json, encKey).then(encrypted => {
            localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
            db.setSetting(SESSIONS_STORAGE_KEY, encrypted).catch(() => {});
          }).catch(e => console.error('[useCrypto] Failed to persist session cleanup:', e));
        } else {
          // 沒 encKey — 清理延後到下次正常 saveSession（會以新 list 覆蓋）
          devWarn('[useCrypto] Session cleanup deferred: no encKey yet');
        }
      }
    }

    devLog('[useCrypto] Restored', sessionsRef.current.size, 'sessions');
  } catch (error) {
    console.error('[useCrypto] Failed to restore sessions:', error);
  }
}

export default useCrypto;

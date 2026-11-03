/**
 * Community edition login (open-source step 5b; the chat edition's `identity.AuthScreen` slot, replaces the 5a
 * PinAuthScreen). No AegisID: an account is the identity key, registered keys-only on the chosen server.
 *
 *   1. server   (no server chosen yet — the community build has none): type the API URL, check its server-config,
 *               "Use this server" (stores the choice and reloads; services/serverChoice.ts). Or restore a recovery kit,
 *               which brings its own server.
 *   2. welcome  (server chosen, no account here): the server and its registration policy, "Create account", "Move from my
 *               old phone" (device transfer, App's scanner), "Restore from recovery kit".
 *   3. create   PIN → confirm → display name (+ invite code when the server's policy is invite, or the server asked for one)
 *               → POST /api/account/register signed by the identity key (registration.ts). The PIN is written only
 *               after the server accepted the account: a refused registration (bad invite, closed, rate limited) shows a
 *               clear message and can be retried with the same keys.
 *   4. verify   PIN (5 wrong → 5 minutes, counts down on screen). Finishes an interrupted PIN change (changePin.ts). After a
 *               kit restore it confirms the account still exists on the server (unconfirmed → asks for an invite).
 *   5. kit      choose the file, passphrase → openKit (nothing written on any error) → new PIN → applyKit → reload.
 * Same storage as before (mist_keys encrypted with the PIN-derived key, PIN hash via services/pinAuth) and the same
 * deferred identity generation; same texts for the PIN steps.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '../../i18n';
import { useCommunityStrings, type CommunityStringKey } from '../../i18n/communityStrings';
import { useApp } from '../../providers';
import { useChatStore } from '../../stores/chatStore';
import { hideSplashScreen } from '../../services/capacitor';
import {
  deriveEncryptionKey, setEncryptionKey, hasUnreadableKeys, clearUnreadableKeys, encryptData,
} from '../../services/keyEncryption';
import * as db from '../../services/database';
import { pinAuth, PIN_LENGTH } from '../../services/pinAuth';
import { mqttService } from '../../services/mqtt';
import { getActiveServer, hasDefaultServer, saveCustomServer, clearCustomServer, webHost } from '../../services/serverChoice';
import { hasLocalAccount, rememberAccountOwner, wipeLocalAccount } from '../../services/serverAccount';
import { openKit, KitError, KIT_MAX_BYTES, type KitContents } from '../../services/recoveryKit';
import { PinKeypad } from '../../components/SocialRecovery/PinKeypad';
import { ServerSettings } from '../../components/Settings/ServerSettings';
import { serverPickRequested } from '../../services/connectPolicy';
import { registerAccount, type RegisterOutcome } from './registration';
import { withIdentitySigner } from './identityKeys';
import { resumeChatPinChange } from './changePin';
import { applyKit, ACCOUNT_UNCONFIRMED_FLAG } from './kitRestore';
import type { AuthScreenProps } from '../types';

type Mode = 'loading' | 'server' | 'pick' | 'welcome' | 'setup' | 'confirm' | 'name' | 'verify' | 'kit' | 'unconfirmed';
type Flow = 'create' | 'kit';

const MAX_ATTEMPTS = 5;

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex items-center p-4">
      <button onClick={onClick} className="p-2 text-on-surface-secondary hover:text-on-surface-primary transition-colors">
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </div>
  );
}

function LockIcon({ small }: { small?: boolean }) {
  return (
    <div className={`${small ? 'w-14 h-14 mb-3' : 'w-20 h-20 mb-8'} rounded-full bg-mist-500/20 flex items-center justify-center`}>
      <svg className={`${small ? 'w-7 h-7' : 'w-10 h-10'} text-mist-400`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    </div>
  );
}

function regMessageKey(outcome: Extract<RegisterOutcome, { ok: false }>): CommunityStringKey {
  return `reg.err.${outcome.code}` as CommunityStringKey;
}

/** keys or a PIN hash in localStorage (synchronous: used when the storage answer is slow) */
function localAccountVisible(): boolean {
  try { return !!(localStorage.getItem('mist_keys') || localStorage.getItem('mist_pin_hash')); } catch { return false; }
}

function setFlag(key: string, on: boolean): void {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* */ }
  (on ? db.setSetting(key, '1') : db.deleteSetting(key)).catch(() => {});
}

async function flagSet(key: string): Promise<boolean> {
  try { if (localStorage.getItem(key) === '1') return true; } catch { /* */ }
  return (await db.getSetting(key).catch(() => null)) === '1';
}

/** The StoredKeys JSON (mist_keys) for a restored identity: the kit's own signed pre-key, or a new one. */
async function kitKeyTools(): Promise<{ publicKeyOf: (p: string) => string; keysJson: (b: KitContents['blob']) => string }> {
  const { Identity, SignedPreKey, fromBase64, toBase64 } = await import('../../services/crypto');
  return {
    publicKeyOf: (priv) => {
      const id = Identity.fromPrivateKey(fromBase64(priv));
      try { return id.publicKeyBase64; } finally { id.free(); }
    },
    keysJson: (b) => {
      const identity = Identity.fromPrivateKey(fromBase64(b.privateKey));
      try {
        const spk = b.signedPreKey
          ? SignedPreKey.fromPrivateKey(fromBase64(b.signedPreKey.privateKey), b.signedPreKey.id, fromBase64(b.signedPreKey.signature), b.signedPreKey.timestamp)
          : SignedPreKey.generate(identity, 1);
        try {
          return JSON.stringify({
            identity: { publicKey: identity.publicKeyBase64, privateKey: b.privateKey },
            signedPreKey: {
              id: spk.id, publicKey: spk.publicKeyBase64, privateKey: toBase64(spk.privateKey),
              signature: toBase64(spk.signature), timestamp: spk.timestamp,
            },
            oneTimePreKeys: [],
          });
        } finally { spk.free(); }
      } finally { identity.free(); }
    },
  };
}

export function ChatAuthScreen({ onSuccess, onBack, onDeviceTransfer }: AuthScreenProps) {
  const { t } = useLanguage();
  const s = useCommunityStrings();
  const { unlockAndReloadKeys, keysLocked, generateIdentity } = useApp();
  const { setDisplayName: saveDisplayName } = useChatStore();
  const server = getActiveServer();

  const [mode, setMode] = useState<Mode>('loading');
  const [flow, setFlow] = useState<Flow>('create');
  const [pin, setPin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteAsked, setInviteAsked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [resetTrigger, setResetTrigger] = useState(0);
  const [kitText, setKitText] = useState<string | null>(null);
  const [kitFile, setKitFile] = useState('');
  const [kitPass, setKitPass] = useState('');
  const [kit, setKit] = useState<KitContents | null>(null);
  const [pickHasAccount, setPickHasAccount] = useState(true);
  const pinSetupPromiseRef = useRef<Promise<void> | null>(null);
  const submitRunningRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const shakeAndReset = useCallback((message: string) => {
    setError(message);
    setShake(true);
    setTimeout(() => setShake(false), 500);
    setResetTrigger((n) => n + 1);
  }, []);

  // no server → choose one; PIN → verify; otherwise the welcome screen (new account / transfer / kit)
  useEffect(() => {
    const checkAuth = async () => {
      try {
        try { localStorage.removeItem('aegis_identity_deferred'); } catch { /* */ }
        if (!getActiveServer()) {
          void hideSplashScreen();
          setMode('server');
          return;
        }
        // reloaded to pick another server (connect-src not narrowed on this page): only the server choice — the account
        //   stays locked and nothing connects (security review L1); Cancel / switching reloads into a normal page
        if (serverPickRequested()) {
          setPickHasAccount(await hasLocalAccount().catch(() => true));
          void hideSplashScreen();
          setMode('pick');
          return;
        }
        // slow storage is not "no PIN" (security review L4): before, a hasPin() slower than 5 s showed the welcome screen of a
        //   fresh install, where restoring a kit used to delete the account without asking. Now: an account visible in
        //   localStorage goes to the PIN screen; otherwise keep waiting for the answer
        const pinCheck = pinAuth().hasPin();
        const quick = await Promise.race([pinCheck, new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), 5000))]);
        const hasPin = quick === 'slow' ? (localAccountVisible() || await pinCheck) : quick;
        if (!hasPin) {
          setMode('welcome');
          return;
        }
        const keysInLocalStorage = !!localStorage.getItem('mist_keys');
        const sqliteKeys = await db.getSetting('mist_keys');
        // iOS WebKit 可能清掉 localStorage：SQLite 是持久化來源，補回 localStorage
        if (!keysInLocalStorage && sqliteKeys) {
          localStorage.setItem('mist_keys', sqliteKeys);
          const sqlitePin = await db.getSetting('mist_pin_hash');
          if (sqlitePin && !localStorage.getItem('mist_pin_hash')) localStorage.setItem('mist_pin_hash', sqlitePin);
        }
        if (!keysInLocalStorage && !sqliteKeys) {
          console.error('[ChatAuthScreen] PIN set but no mist_keys — data partially cleared → welcome');
          setMode('welcome');
          return;
        }
        void hideSplashScreen();
        setMode('verify');
        pinAuth().isLockedOut();   // also expires an old lock
        setAttempts(pinAuth().getFailedAttempts());
      } catch (err) {
        console.error('[ChatAuthScreen] checkAuth failed (first launch?):', err);
        setMode(getActiveServer() ? 'welcome' : 'server');
      }
    };
    void checkAuth();
  }, []);

  useEffect(() => {
    if (mode === 'name') nameInputRef.current?.focus();
  }, [mode]);

  const locked = attempts >= MAX_ATTEMPTS && mode === 'verify';
  const [lockRemainingMs, setLockRemainingMs] = useState(0);
  useEffect(() => {
    if (!locked) return;
    const tick = () => {
      if (!pinAuth().isLockedOut()) {
        setAttempts(pinAuth().getFailedAttempts());
        setLockRemainingMs(0);
        return;
      }
      setLockRemainingMs(pinAuth().getLockoutRemaining());
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [locked]);

  const startCreate = () => {
    setError('');
    setFlow('create');
    setPin('');
    setMode('setup');
    setResetTrigger((n) => n + 1);
  };

  // ───────── kit restore (after the new PIN is confirmed) ─────────
  const restoreKit = useCallback(async (newPin: string) => {
    if (!kit) return;
    setBusy(true);
    setError('');
    try {
      if (!kit.server && !hasDefaultServer()) throw new KitError('invalid_contents');
      // another account's leftovers (keys of an unfinished registration, an old account): gone before this one is written —
      //   but never without asking (security review L4: the account may be a real one the welcome screen did not show)
      if (await hasLocalAccount()) {
        if (!window.confirm(s('mismatch.startOverConfirm'))) {
          setBusy(false);
          setFlow('create');
          setMode('kit');
          return;
        }
        await wipeLocalAccount({ seal: false });
      }
      const encKey = await deriveEncryptionKey(newPin, { isInitialSetup: true });
      await setEncryptionKey(encKey);
      const keys = await kitKeyTools();
      const storage = await import('../../services/storage');
      const { restoreGroupsFromBackup } = await import('../../services/groupRestore');
      await applyKit(kit, {
        publicKeyOf: keys.publicKeyOf,
        storedKeysJson: keys.keysJson,
        encrypt: (text) => encryptData(text, encKey),
        saveKeys: async (enc) => { localStorage.setItem('mist_keys', enc); await db.setSetting('mist_keys', enc); },
        addContact: (c) => storage.addContact({
          pubkey: c.publicKey,
          nickname: c.nickname || `${c.publicKey.slice(0, 8)}…`,
          avatar: c.avatar || '',
          addedAt: c.addedAt || Date.now(),
          trustLevel: c.trustLevel === 'verified' ? 'verified' : 'unverified',
          signedPreKey: c.signedPreKey,
          signature: c.signature,
        }),
        restoreGroups: (groups, me) => restoreGroupsFromBackup(groups, me),
        setDisplayName: (name) => saveDisplayName(name),
        saveServer: (srv) => { if (srv) saveCustomServer(srv); else clearCustomServer(); },
        setFlag: (key) => setFlag(key, true),
      });
      await pinAuth().setPin(newPin);
      for (const k of ['mist_pin_hash', 'mist_pin_salt', 'aegis_backup_auth_hash']) {
        const v = localStorage.getItem(k);
        if (v) await db.setSetting(k, v);
      }
      clearUnreadableKeys();
      try { localStorage.removeItem('aegis_identity_deferred'); } catch { /* */ }
      await rememberAccountOwner();
      await db.flushToStore();
      // restart on the account's server (API base, broker, connect-src): the next screen is the PIN
      window.location.reload();
    } catch (err) {
      console.error('[ChatAuthScreen] kit restore failed:', err instanceof KitError ? err.code : (err as Error)?.message);
      setBusy(false);
      setFlow('create');
      setMode('kit');
      setError(s(err instanceof KitError ? (`kit.err.${err.code}` as CommunityStringKey) : 'kit.err.restore_failed'));
    }
  }, [kit, s, saveDisplayName]);

  // 確認 PIN：一致 → 先衍生加密金鑰解鎖（不持久化 PIN，等註冊成功才寫）
  const handleConfirm = useCallback((confirmed: string) => {
    if (confirmed !== pin) {
      setPin('');
      setMode('setup');
      shakeAndReset(t('auth.pinMismatch'));
      return;
    }
    setError('');
    if (flow === 'kit') {
      void restoreKit(pin);
      return;
    }
    setMode('name');
    pinSetupPromiseRef.current = (async () => {
      try {
        const encKey = await deriveEncryptionKey(pin, { isInitialSetup: true });
        await setEncryptionKey(encKey);
        const unlocked = await unlockAndReloadKeys();
        // no identity yet: AppProvider must not generate one by itself (deferred) — created at "Create account"
        if (!unlocked) {
          try { localStorage.setItem('aegis_identity_deferred', '1'); } catch { /* */ }
        }
      } catch (err) {
        console.error('[ChatAuthScreen] Failed to derive encKey:', err);
        setError(t('auth.setupFailed'));
      }
    })();
  }, [pin, flow, t, unlockAndReloadKeys, shakeAndReset, restoreKit]);

  const handlePinComplete = useCallback((value: string) => {
    if (mode === 'setup') {
      setPin(value);
      setError('');
      setMode('confirm');
      setResetTrigger((n) => n + 1);
    } else if (mode === 'confirm') {
      handleConfirm(value);
    }
  }, [mode, handleConfirm]);

  const needInvite = server?.registration === 'invite' || inviteAsked;

  const handleCreate = useCallback(async () => {
    if (submitRunningRef.current) return;
    submitRunningRef.current = true;
    try {
      const trimmedName = displayName.trim();
      if (!trimmedName) { setError(t('auth.nameRequired')); return; }
      if (trimmedName.length > 20) { setError(t('auth.nameTooLong')); return; }
      if (needInvite && !invite.trim()) { setError(s('reg.err.invite_required')); return; }
      setBusy(true);
      setError('');
      saveDisplayName(trimmedName);
      if (pinSetupPromiseRef.current) {
        try { await pinSetupPromiseRef.current; } catch { setError(t('auth.setupFailed')); return; }
        pinSetupPromiseRef.current = null;
      }
      if (!localStorage.getItem('mist_keys')) {
        generateIdentity();
        const { waitKeysSaved } = await import('../../hooks/useCrypto');
        await waitKeysSaved().catch(() => {});
      }
      const outcome = await withIdentitySigner((signer) =>
        registerAccount(signer, needInvite ? invite : undefined, { clock: mqttService.signedClock() }));
      if (!outcome) { setError(s('reg.err.no_identity')); return; }
      if (!outcome.ok) {
        if (outcome.code === 'invite_required' || outcome.code === 'invalid_invite') setInviteAsked(true);
        setError(outcome.code === 'failed' ? s('reg.err.failed', { status: outcome.status ?? '?' }) : s(regMessageKey(outcome)));
        return;
      }
      // PIN 寫入 = 註冊完成（伺服器已經收下這個帳號）
      try {
        await pinAuth().setPin(pin);
      } catch (err) {
        console.error('[ChatAuthScreen] setPin failed:', err);
        setError(t('auth.setupFailed'));
        return;
      }
      try { localStorage.removeItem('aegis_identity_deferred'); } catch { /* */ }
      clearUnreadableKeys();   // the new account is final: quarantined leftovers are not needed
      await rememberAccountOwner();
      onSuccess();
    } finally {
      setBusy(false);
      submitRunningRef.current = false;
    }
  }, [displayName, invite, needInvite, pin, saveDisplayName, generateIdentity, onSuccess, t, s]);

  /** after a kit restore: is the account known to this server? (re-register with an invite if the server lost it) */
  const confirmAccount = useCallback(async (inviteCode?: string): Promise<'ok' | 'need-invite' | 'error'> => {
    const outcome = await withIdentitySigner((signer) => registerAccount(signer, inviteCode, { clock: mqttService.signedClock() }));
    if (outcome?.ok) {
      setFlag(ACCOUNT_UNCONFIRMED_FLAG, false);
      return 'ok';
    }
    if (outcome && (outcome.code === 'invite_required' || outcome.code === 'invalid_invite')) {
      if (inviteCode) setError(s(regMessageKey(outcome)));
      return 'need-invite';
    }
    if (outcome && inviteCode) setError(outcome.code === 'failed' ? s('reg.err.failed', { status: outcome.status ?? '?' }) : s(regMessageKey(outcome)));
    return 'error';
  }, [s]);

  const handleVerifyComplete = useCallback(async (value: string) => {
    const isValid = await pinAuth().verifyPin(value);
    if (!isValid) {
      const remaining = MAX_ATTEMPTS - pinAuth().getFailedAttempts();
      shakeAndReset(remaining > 0 ? t('auth.pinWrong', { count: remaining }) : t('auth.accountLockedRetry'));
      setAttempts(pinAuth().getFailedAttempts());
      return;
    }
    try {
      // an interrupted PIN change finishes here (either PIN opens its journal); the key comes from the PIN in force now
      const effective = await resumeChatPinChange(value).catch((err) => {
        console.error('[ChatAuthScreen] resuming the PIN change failed:', (err as Error)?.message);
        return value;
      });
      const encKey = await deriveEncryptionKey(effective);
      await setEncryptionKey(encKey);
      const unlocked = await unlockAndReloadKeys();
      if (!unlocked && hasUnreadableKeys()) {
        // PIN right, but the keys on this phone do not open: never turn that into "no keys → new identity"
        setError(t('auth.decryptFailed'));
        setMode('welcome');
        return;
      }
      if (!unlocked && keysLocked) {
        shakeAndReset(t('auth.decryptFailed'));
        return;
      }
    } catch (err) {
      console.error('[ChatAuthScreen] Failed to derive encryption key:', err);
      if (keysLocked) {
        shakeAndReset(t('auth.decryptFailed'));
        return;
      }
    }
    if (await flagSet(ACCOUNT_UNCONFIRMED_FLAG)) {
      const r = await confirmAccount();
      if (r === 'need-invite') {
        setMode('unconfirmed');
        return;
      }
      // unreachable now: go on (the flag stays; checked again at the next unlock)
    }
    await rememberAccountOwner();
    onSuccess();
  }, [keysLocked, onSuccess, t, unlockAndReloadKeys, shakeAndReset, confirmAccount]);

  const handleUnconfirmed = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if ((await confirmAccount(invite)) !== 'ok') return;
      await rememberAccountOwner();
      onSuccess();
    } finally {
      setBusy(false);
    }
  }, [busy, confirmAccount, invite, onSuccess]);

  // ───────── kit file + passphrase ─────────
  const chooseKitFile = (file: File | undefined) => {
    setError('');
    setKit(null);
    setKitText(null);
    if (!file) return;
    if (file.size > KIT_MAX_BYTES) { setError(s('kit.err.too_large')); return; }
    setKitFile(file.name);
    file.text().then(setKitText).catch(() => setError(s('kit.err.read_failed')));
  };

  const openKitFile = async () => {
    if (!kitText || busy) return;
    setBusy(true);
    setError('');
    try {
      setKit(await openKit(kitText, kitPass));
      setKitPass('');
    } catch (err) {
      setError(s(err instanceof KitError ? (`kit.err.${err.code}` as CommunityStringKey) : 'kit.err.corrupt'));
    } finally {
      setBusy(false);
    }
  };

  const serverLine = server ? (server.name || webHost(server.apiUrl) || server.apiUrl) : '';
  const policyKey = server?.registration ? (`server.policy.${server.registration}` as CommunityStringKey) : null;
  const cannotCreate = server?.registration === 'closed' || server?.registration === 'external';

  if (mode === 'loading') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex items-center justify-center safe-area-top">
        <div className="w-12 h-12 border-4 border-mist-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (locked) {
    const secs = Math.ceil(lockRemainingMs / 1000);
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6 safe-area-top">
        <h2 className="text-xl font-semibold text-on-surface-primary mb-2">{t('auth.accountLocked')}</h2>
        <p className="text-on-surface-secondary text-center mb-2">{t('auth.tooManyAttempts')}</p>
        {secs > 0 && (
          <p className="text-on-surface-tertiary text-center mb-6">
            {t('auth.lockRemainingTime', { time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` })}
          </p>
        )}
        <button onClick={onBack} className="text-mist-400 hover:text-mist-300">{t('common.back')}</button>
      </div>
    );
  }

  if (mode === 'pick') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6 safe-area-top" data-testid="chat-auth-pick">
        <LockIcon small />
        <h1 className="text-2xl font-semibold text-on-surface-primary mb-2 text-center">{s('server.title')}</h1>
        <ServerSettings signedIn={pickHasAccount} compact warnExternal />
      </div>
    );
  }

  if (mode === 'server') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6 safe-area-top" data-testid="chat-auth-server">
        <LockIcon small />
        <h1 className="text-2xl font-semibold text-on-surface-primary mb-2 text-center">{s('server.firstRunTitle')}</h1>
        <p className="text-on-surface-secondary text-center max-w-xs text-sm">{s('server.firstRunDesc')}</p>
        <ServerSettings signedIn={false} firstRun warnExternal />
        <button
          onClick={() => { setError(''); setMode('kit'); }}
          className="mt-6 w-full max-w-xs px-8 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-xl font-medium transition-all"
        >
          {s('auth.restoreKit')}
        </button>
      </div>
    );
  }

  if (mode === 'welcome') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col safe-area-top" data-testid="chat-auth-welcome">
        <div className="flex-1 flex flex-col items-center justify-center p-6 pb-12">
          <LockIcon />
          <h1 className="text-2xl font-semibold text-on-surface-primary mb-2">AegisTalk Chat</h1>
          <p className="text-on-surface-secondary mb-2 text-center max-w-xs">{t('auth.setupPinDescription')}</p>
          {policyKey && <p className={`text-xs mb-6 text-center max-w-xs ${cannotCreate ? 'text-red-400' : 'text-on-surface-tertiary'}`}>{serverLine}: {s(policyKey)}</p>}
          {error && <p className="text-red-400 text-sm mb-4" role="alert">{error}</p>}
          <button
            onClick={startCreate}
            disabled={cannotCreate}
            className="w-full max-w-xs px-8 py-3 bg-accent hover:opacity-90 text-white rounded-xl font-medium transition-all disabled:opacity-50"
          >
            {s('auth.createAccount')}
          </button>
          {onDeviceTransfer && (
            <button
              onClick={onDeviceTransfer}
              className="mt-4 w-full max-w-xs px-8 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-xl font-medium transition-all"
            >
              {s('auth.moveFromOldPhone')}
            </button>
          )}
          <button
            onClick={() => { setError(''); setMode('kit'); }}
            className="mt-4 w-full max-w-xs px-8 py-3 bg-surface-tertiary hover:opacity-80 text-on-surface-primary rounded-xl font-medium transition-all"
          >
            {s('auth.restoreKit')}
          </button>
          <ServerSettings signedIn={false} compact warnExternal />
        </div>
      </div>
    );
  }

  if (mode === 'kit') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col safe-area-top" data-testid="chat-auth-kit">
        <BackButton onClick={() => { setError(''); setKit(null); setMode(server ? 'welcome' : 'server'); }} />
        <div className="flex-1 flex flex-col items-center p-6 space-y-4">
          <h1 className="text-xl font-semibold text-on-surface-primary">{s('kit.importTitle')}</h1>
          <p className="text-on-surface-secondary text-sm text-center max-w-xs">{s('kit.importDesc')}</p>
          <label className="w-full max-w-xs px-4 py-3 bg-surface-tertiary rounded-xl text-center text-on-surface-primary cursor-pointer">
            {kitFile ? s('kit.fileChosen', { name: kitFile }) : s('kit.chooseFile')}
            <input type="file" accept=".json,application/json" className="hidden" data-testid="kit-file"
              onChange={(e) => chooseKitFile(e.target.files?.[0])} />
          </label>
          {kitText && !kit && (
            <div className="w-full max-w-xs space-y-2">
              <label className="text-sm text-on-surface-secondary block" htmlFor="kit-pass">{s('kit.passLabel')}</label>
              <input id="kit-pass" type="password" autoComplete="off" value={kitPass} onChange={(e) => { setKitPass(e.target.value); setError(''); }}
                className="w-full px-3 py-2 bg-surface-tertiary text-on-surface-primary rounded-lg border border-[var(--surface-border)]" />
              <button type="button" disabled={!kitPass || busy} onClick={() => void openKitFile()}
                className="w-full py-3 rounded-xl bg-mist-500 text-white disabled:opacity-50">
                {busy ? s('kit.opening') : s('kit.open')}
              </button>
            </div>
          )}
          {error && <p className="text-red-400 text-sm text-center max-w-xs" role="alert">{error}</p>}
          {kit && (
            <div className="w-full max-w-xs space-y-3">
              <p className="text-sm text-on-surface-primary" data-testid="kit-summary">
                {s('kit.opened', {
                  name: kit.blob.displayName || kit.blob.publicKey.slice(0, 8),
                  contacts: kit.blob.contacts.length,
                  groups: kit.blob.groups.length,
                  server: kit.server ? (kit.server.name || webHost(kit.server.apiUrl) || kit.server.apiUrl) : s('mismatch.defaultServer'),
                })}
              </p>
              <button type="button" disabled={busy} onClick={() => { setFlow('kit'); setPin(''); setMode('setup'); setResetTrigger((n) => n + 1); }}
                className="w-full py-3 rounded-xl bg-accent text-white disabled:opacity-50">
                {s('kit.continue')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (mode === 'name') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col safe-area-top">
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <h1 className="text-2xl font-semibold text-on-surface-primary mb-2">{t('auth.setName')}</h1>
          <p className="text-on-surface-secondary mb-8 text-center">{t('auth.nameDescription')}</p>
          <div className="w-full max-w-xs mb-6">
            <input
              ref={nameInputRef}
              type="text"
              value={displayName}
              onChange={(e) => { setDisplayName(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              placeholder={t('auth.namePlaceholder')}
              maxLength={20}
              className="w-full px-4 py-3 bg-surface-tertiary border border-[var(--surface-border)] rounded-xl text-on-surface-primary text-center text-lg placeholder:text-on-surface-tertiary focus:outline-none focus:border-mist-500 transition-colors"
            />
            <p className="text-on-surface-tertiary text-xs text-center mt-2">{t('auth.nameCharCount', { count: displayName.length })}</p>
          </div>
          {needInvite && (
            <div className="w-full max-w-xs mb-6">
              <label className="text-sm text-on-surface-secondary block mb-1" htmlFor="chat-invite-code">{s('auth.inviteCode')}</label>
              <input
                id="chat-invite-code"
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={invite}
                onChange={(e) => { setInvite(e.target.value); setError(''); }}
                className="w-full px-4 py-3 bg-surface-tertiary border border-[var(--surface-border)] rounded-xl text-on-surface-primary font-mono focus:outline-none focus:border-mist-500"
              />
              <p className="text-on-surface-tertiary text-xs mt-1">{s('auth.inviteCodeHint')}</p>
            </div>
          )}
          {error && <p className="text-red-400 text-sm mb-4 text-center max-w-xs" role="alert">{error}</p>}
          <button
            onClick={() => void handleCreate()}
            disabled={!displayName.trim() || busy}
            className="px-8 py-3 bg-[#4DD0E1] hover:bg-[#3dbfcf] disabled:bg-gray-400 text-white rounded-xl font-medium transition-all disabled:cursor-not-allowed"
          >
            {busy ? s('auth.registering') : t('auth.completeSetup')}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'unconfirmed') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col items-center justify-center p-6 safe-area-top" data-testid="chat-auth-unconfirmed">
        <h1 className="text-xl font-semibold text-on-surface-primary mb-2 text-center">{s('auth.unconfirmedTitle')}</h1>
        <p className="text-on-surface-secondary mb-6 text-center max-w-xs text-sm">{s('auth.unconfirmedDesc')}</p>
        <div className="w-full max-w-xs mb-4">
          <label className="text-sm text-on-surface-secondary block mb-1" htmlFor="chat-invite-code-again">{s('auth.inviteCode')}</label>
          <input id="chat-invite-code-again" type="text" autoCapitalize="off" spellCheck={false} value={invite}
            onChange={(e) => { setInvite(e.target.value); setError(''); }}
            className="w-full px-4 py-3 bg-surface-tertiary border border-[var(--surface-border)] rounded-xl text-on-surface-primary font-mono" />
        </div>
        {error && <p className="text-red-400 text-sm mb-4 text-center max-w-xs" role="alert">{error}</p>}
        <button onClick={() => void handleUnconfirmed()} disabled={!invite.trim() || busy}
          className="w-full max-w-xs px-8 py-3 bg-accent text-white rounded-xl font-medium disabled:opacity-50">
          {busy ? s('auth.registering') : s('auth.register')}
        </button>
      </div>
    );
  }

  if (mode === 'verify') {
    return (
      <div className="min-h-[100dvh] bg-surface-primary flex flex-col safe-area-top">
        <BackButton onClick={onBack} />
        <div className="flex-1 flex flex-col items-center justify-center p-6 pb-20">
          <LockIcon />
          <h1 className="text-2xl font-semibold text-on-surface-primary mb-2">{t('auth.enterPin')}</h1>
          <p className="text-on-surface-secondary mb-8 text-center">{t('auth.enterYourPin')}</p>
          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
          <div className={shake ? 'animate-shake' : ''}>
            <PinKeypad length={PIN_LENGTH} onComplete={(v) => void handleVerifyComplete(v)} resetTrigger={resetTrigger} error={error} />
          </div>
        </div>
      </div>
    );
  }

  // setup / confirm (new account or kit restore)
  return (
    <div className="min-h-[100dvh] bg-surface-primary flex flex-col safe-area-top" data-testid="auth-screen">
      <BackButton onClick={() => {
        if (mode === 'confirm') { setPin(''); setMode('setup'); setError(''); setResetTrigger((n) => n + 1); }
        else setMode(flow === 'kit' ? 'kit' : 'welcome');
      }} />
      <div className="flex flex-col items-center px-6 pt-2">
        <LockIcon small />
        <h1 className="text-lg font-semibold text-on-surface-primary mb-1">
          {mode === 'setup' ? t('auth.setupPin') : t('auth.confirmPin')}
        </h1>
        <p className="text-on-surface-secondary mb-3 text-center text-sm">
          {busy ? s('kit.restoring') : mode === 'setup' ? t('auth.setupPinDescription') : t('auth.confirmPinDescription')}
        </p>
        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
        <div className={shake ? 'animate-shake' : ''}>
          <PinKeypad length={PIN_LENGTH} onComplete={handlePinComplete} resetTrigger={resetTrigger} error={error} />
        </div>
      </div>
    </div>
  );
}

export default ChatAuthScreen;

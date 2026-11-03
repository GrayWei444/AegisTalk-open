/**
 * The community chat edition (AEGIS_EDITION=chat): end-to-end encrypted chat, groups and calls, nothing else.
 *   - anti-fraud: no-op — nothing is scanned, no risk is ever reported (no "safe" badge either: enabled = false);
 *     the display-only pieces (scam alert modal, risk frames, local block list) stay in the app and are inert
 *   - identity: keys-only accounts on the chosen server (ChatAuthScreen: server → PIN → name → POST /api/account/register
 *     signed by the identity key, invite code when the server asks; device transfer without face / behaviour data;
 *     change PIN with a crash-safe journal); no server-held backup — the offline recovery kit (Settings)
 *   - no guardian, payments, VPN, plugin host, AegisBot status
 * Only public modules may be imported here (enforced by ESLint and scripts/review/chat_edition_boundary_self_test.mjs).
 */
import type { ReactNode } from 'react';
import type { AppExtensions } from '../types';
import { ChatAuthScreen } from './ChatAuthScreen';
import { RecoveryKitSettingsItem } from './RecoveryKitExport';
import { chatPinChange } from './changePin';
import { registerAccount } from './registration';
import { pinAuth } from '../../services/pinAuth';
import { mqttService } from '../../services/mqtt';
import { requestNotificationPermission } from '../../services/callNotification';
import { backup } from './backup';
import { callAnalysis } from './callAnalysis';

function PassThrough({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function NoOverlays() {
  return null;
}

const noop = (): void => {};

export const ext: AppExtensions = {
  edition: 'chat',

  antiFraud: {
    enabled: false,
    start: async () => {},
    stop: noop,
    onAppResume: noop,
    afterLogin: noop,
    inspectInbound: async () => undefined,
    contactRisk: async () => null,
    contactRiskLevels: async () => new Map(),
    evaluateUrl: async () => null,
    text: {
      isReady: () => false,
      normalize: (text) => text,
      quickEvaluate: () => { throw new Error('the chat edition has no risk engine'); },
    },
    speech: null,
    callAnalysis,
    e2eApi: async () => ({}),
  },

  identity: {
    AuthScreen: ChatAuthScreen,
    initStorage: noop,
    bootModels: noop,
    preloadModels: noop,
    disposeModels: noop,
    runDevHarness: () => false,
    register: (signer, inviteCode) => registerAccount(signer, inviteCode, { clock: mqttService.signedClock() }),
    verifyPin: (pin) => pinAuth().verifyPin(pin),
    changePin: chatPinChange,
    restoreTransfer: (data) => pinAuth().restoreFromTransfer(data),
    // the device-transfer payload carries no face embedding and no behaviour baseline in this edition
    transferExtras: async () => ({}),
    backup,
    useServiceRegistration: noop,
  },

  ui: {
    useChatShell: () => ({
      mobileTabs: null,
      mobilePanelOpen: false,
      mobilePanel: null,
      desktopPanel: null,
      overlay: null,
      Wrapper: PassThrough,
    }),
    // Settings, account block: create the offline recovery kit
    useSettingsExtras: () => ({ accountItems: <RecoveryKitSettingsItem />, sections: null, modals: null }),
    useChatRoomExtras: () => ({ ambientClass: '', modals: null }),
    useGroupGuardian: () => ({ isGuardianGroup: false, headerBadges: null, menuItem: () => null, panel: null, modal: null }),
    useCallRisk: () => ({ isAnalyzing: false, sliceCount: 0, shield: null, transcript: null, summary: null }),
    useCanCreateGuardianGroup: () => false,
    isGuardianGroup: () => false,
    CreateGuardianGroupModal: null,
    VoiceInput: null,
    PaymentCard: null,
    useAppEffects: noop,
    AppOverlays: NoOverlays,
    ProviderWrapper: PassThrough,
    requestNotificationPermission: () => requestNotificationPermission(),
  },

  hooks: {
    useGuardian: noop,
    usePaymentSweep: noop,
    useCheckInScheduler: noop,
  },
};

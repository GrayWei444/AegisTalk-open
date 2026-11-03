/**
 * Edition boundary (open-source step 5a): everything the chat app needs from the parts that are not chat.
 *
 * The app imports one object, `ext` from '@ext'. The build picks its implementation (vite / tsconfig alias):
 *   - src/ext/chat      — the public community edition: anti-fraud is a no-op that reports no risk, there is no
 *                          guardian, payments or VPN, and the identity slot is the keys-only login (ChatAuthScreen:
 *                          server → PIN → name → registration; device transfer; offline recovery kit).
 *   - src/ext-official  — the private official edition: AegisID (face, cloud blob, social recovery), AI anti-fraud,
 *                          family guardian, AegisPay, NetworkShield and the plugin host. Never shipped in the export.
 *
 * Rules (enforced by ESLint no-restricted-imports and scripts/review/chat_edition_boundary_self_test.mjs):
 *   - nothing outside src/ext-official imports src/ext-official, @aegisrd/* or the private npm packages;
 *   - public code never reads `ext` at module top level (official modules import public ones: a top-level read
 *     could run before src/ext-official/index.ts is evaluated) — only inside functions, components and hooks;
 *   - members named use* are React hooks; both editions provide them (the chat ones call no hooks), so call sites
 *     call them unconditionally, in the same place the official code used to run (bind them to a local `useX` first
 *     so the react-hooks lint rule checks them);
 *   - low-level modules that the extension itself imports (stores, useCrypto, deviceClaim, voiceCall) use the leaf
 *     entries '@ext/backup' and '@ext/callAnalysis' instead of '@ext', so the module graph keeps the shape it had before
 *     the split (store → blob service, voiceCall → voice analyzer) and gains no import cycle through the extension.
 */
import type { ComponentType, ReactNode } from 'react';
import type { CallState } from '../services/voiceCall';
import type { Friend, Group, GuardianGroupSettings, L2Result, Message, PaymentData, RiskResult, TrustLevel } from '../types';

export type Edition = 'chat' | 'official';

// ─────────────────────────────── server ('@ext/server') ───────────────────────────────

/**
 * The edition's default chat server ('@ext/server' leaf: defaultServer). Community: none (asks on first run);
 * official: the official service. See services/serverChoice.ts.
 */
export interface EditionServerConfig {
  name?: string;
  apiUrl: string;
  mqttUrl: string;
  stunUrls?: string[];
  registration?: 'open' | 'invite' | 'closed' | 'external';
  links?: { privacy?: string; terms?: string; support?: string; supportEmail?: string };
}

// ─────────────────────────────── anti-fraud ───────────────────────────────

export interface InboundFileMeta { name: string; mimeType: string; size: number }

/**
 * One received message at one of the points where the official app scans it. `site` says which point, because each
 * point has its own rules today (which types are scanned, whose risk score moves, what is logged); the official
 * implementation keeps each of them exactly. `scoreKey` is the public key whose trust score moves.
 */
export type InboundEvent =
  /** group-key message (handleGroupKeyMessage): text only */
  | { site: 'group-key'; sender: string; messageId: string; type: string; content?: string }
  /** chunked P2P file, reassembled in fileBlobStore */
  | { site: 'file-blob'; sender: string; scoreKey: string; fileId: string; file: InboundFileMeta }
  /** encrypted 1-1 message that carries a groupId (legacy group path) */
  | { site: 'group-1to1'; sender: string; type: string; content?: string; fileData?: InboundFileMeta }
  /** plain 1-1 message */
  | { site: 'direct'; sender: string; scoreKey: string; type: string; content?: string; fileData?: InboundFileMeta };

export type ContactRiskLevel = 'safe' | 'low' | 'medium' | 'high';

/** Server trust record of one contact (shape of the official /api/trust answer). */
export interface ContactRiskInfo {
  pubkeyHash: string;
  riskScore: number;
  l2TriggerCount: number;
  l3TriggerCount: number;
  lastTriggerAt: number | null;
  riskLevel: ContactRiskLevel;
}

export interface UrlVerdict { riskLevel: string; riskScore: number; warnings: string[] }

/** On-device speech recognition (transcribing received voice messages). */
export interface SpeechEngine {
  getStatus(): string;
  isReady(): boolean;
  initialize(): Promise<void>;
  recognizeAudio(samples: Float32Array): { text?: string } | null;
}

export interface AudioSlice {
  data: Float32Array;
  startTime: number;
  endTime: number;
  sampleRate: number;
  isPartial: boolean;
}

/** Live analysis of the other side's voice during a 1-1 call. */
export interface CallVoiceAnalysis {
  initialize(): Promise<void>;
  onSlice(callback: (slice: AudioSlice) => void): () => void;
  start(stream: MediaStream): Promise<void>;
  stop(): void;
  startSession(sessionId: string): Promise<void>;
}

export interface AntiFraudExtension {
  /** this build has a risk engine (official); false = nothing is ever reported as checked or safe */
  readonly enabled: boolean;
  /** Chat mode entered: start the engine, load and sync rules, preload speech. */
  start(): Promise<void>;
  /** Stop background rule sync (unmount / account change). */
  stop(): void;
  /** App came back to the foreground. */
  onAppResume(): void;
  /** Login finished (App.enterChat): background model downloads. */
  afterLogin(): void;
  /** Awaited where the app scans a received message; the result is stored with the message. undefined = no risk. */
  inspectInbound(ev: InboundEvent): Promise<L2Result | undefined>;
  /** Trust record of one contact before adding him; null = nothing known. */
  contactRisk(pubkey: string): Promise<ContactRiskInfo | null>;
  /** Trust levels for avatar frames; contacts missing from the map have no known risk. */
  contactRiskLevels(pubkeys: string[]): Promise<Map<string, ContactRiskLevel>>;
  /** URL check for message links; null = not evaluated (no badge). */
  evaluateUrl(url: string): Promise<UrlVerdict | null>;
  /** Synchronous text check (transcripts of received voice messages). */
  text: { isReady(): boolean; normalize(text: string): string; quickEvaluate(text: string): L2Result };
  speech: SpeechEngine | null;
  callAnalysis: CallVoiceAnalysis | null;
  /** Extra members of window.__aegisE2E (AEGIS_E2E_TEST mode only). */
  e2eApi(): Promise<Record<string, unknown>>;
}

// ─────────────────────────────── identity ───────────────────────────────

export interface AuthScreenProps {
  onSuccess: () => void;
  onBack: () => void;
  onDeviceTransfer?: () => void;
}

/** Contact in the identity backup (projection of Friend). */
export interface BlobContact {
  publicKey: string;
  nickname: string;
  avatar: string;
  trustLevel: TrustLevel;
  addedAt: number;
  /** peer's X3DH signed pre-key (Base64) — rebuild the session after a restore */
  signedPreKey?: string;
  /** signature of that pre-key (Base64) */
  signature?: string;
}

export interface BlobGroupMember {
  publicKey: string;
  nickname?: string;
  role: 'admin' | 'member';
  joinedAt: number;
}

/** Group in the identity backup; a restore only trusts `log` (the signed state chain, see services/groupBackup.ts). */
export interface BlobGroup {
  id: string;
  name: string;
  avatar?: string;
  members: BlobGroupMember[];
  createdAt: number;
  createdBy: string;
  groupType?: 'normal' | 'guardian';
  guardianSettings?: GuardianGroupSettings;
  log?: import('../services/groupBackup').GroupBackup;
}

/** The user's own signed pre-key material (all base64, same shape as mist_keys.signedPreKey). */
export interface BlobSignedPreKey {
  id: number;
  publicKey: string;
  privateKey: string;
  signature: string;
  timestamp: number;
}

/** Where the backup reads the social graph from (injected by main.tsx, so the backup does not import the stores). */
export interface BlobDataProviders {
  getContacts: () => BlobContact[];
  getGroups: () => BlobGroup[];
  getDisplayName: () => string;
  /** friends and groups really loaded (never write an empty graph over a full one) */
  isReady?: () => boolean | Promise<boolean>;
}

export interface BackupFlushResult { success: boolean; skipped?: string; error?: string }

/** Account backup (official: the sealed AegisID cloud blob; chat: none on any server — the user's offline recovery kit). */
export interface IdentityBackup {
  setProviders(providers: BlobDataProviders): void;
  setOwnSignedPreKey(spk: BlobSignedPreKey | null): void;
  /** friends / groups / name changed */
  markDirty(): void;
  /** write now (after adding a friend); resolves with what happened, never throws */
  flushNow(): Promise<BackupFlushResult>;
  /** account left this device (wipe / kick) */
  clear(): void;
}

/** Auth material a device transfer carries (written by the sender, applied by the receiver). */
export interface TransferAuthData {
  pinHash?: string;
  pinSalt?: string;
  backupAuthHash?: string;
  behaviorBaseline?: string;
  faceEmbedding?: string;
}

export interface ChangePinResult { ok: boolean; code?: 'bad_format' | 'same_as_old' | 'old_wrong' | 'rekey_failed' | 'pending' }

/** Outcome of a keys-only registration (POST /api/account/register; ext/chat/registration.ts). */
export type RegisterOutcome =
  | { ok: true; created: boolean }
  | { ok: false; code: 'invite_required' | 'invalid_invite' | 'registration_closed' | 'rate_limited' | 'unreachable' | 'failed'; status?: number };

export interface PinChange {
  change(oldPin: string, newPin: string): Promise<ChangePinResult>;
  /** finish a PIN change that was interrupted; returns the PIN to use from now on */
  resume(pin: string): Promise<string>;
}

export interface IdentityExtension {
  /** Login / registration screen (official: AegisID face + PIN; chat: ChatAuthScreen, keys-only). */
  AuthScreen: ComponentType<AuthScreenProps>;
  /** main.tsx, right after config init: storage adapters for the identity SDK. */
  initStorage(): void;
  /** main.tsx, after the device id: face storage sync, native inference providers, model preload. */
  bootModels(): void;
  /** AppProvider init: preload models again if main.tsx did not (non-blocking). */
  preloadModels(): void;
  /** App.enterChat: free model memory before the chat screen. */
  disposeModels(): void;
  /** iOS face-engine verification harness (official, opt-in); true = it took over the page. */
  runDevHarness(): boolean;
  /** Keys-only account registration (POST /api/account/register, signed by the identity key); absent = accounts come from elsewhere (official: AegisID). */
  register?: (signer: { publicKey: string; sign: (message: Uint8Array) => Uint8Array }, inviteCode?: string) => Promise<RegisterOutcome>;
  /** Check the local PIN (chat export asks for it). */
  verifyPin(pin: string): Promise<boolean>;
  /** Change PIN with re-encryption; absent = the edition has no change-PIN yet. */
  changePin?: PinChange;
  /** Device transfer, receiving side: apply the auth material. */
  restoreTransfer(data: TransferAuthData): Promise<void>;
  /** Device transfer, sending side: edition-specific extras for the payload (official: face embedding, behaviour baseline; chat: none). */
  transferExtras(): Promise<Pick<TransferAuthData, 'faceEmbedding' | 'behaviorBaseline'>>;
  backup: IdentityBackup;
  /** A friend sent a recovery shard he keeps for me (official social recovery); absent = dropped. */
  onRecoveryShard?: (from: string, payload: unknown) => Promise<void>;
  /** Encrypt / sign functions for identity services that send through the app (official social recovery). */
  useServiceRegistration(ctx: {
    cryptoReady: boolean;
    publicKey: string | null;
    encrypt: (recipientPublicKey: string, plaintext: string) => Promise<{ toJson(): string }>;
    identity: { sign(data: Uint8Array): Uint8Array } | null;
  }): void;
}

// ─────────────────────────────── guardian ───────────────────────────────

/** guardianAlert / checkIn fields of a legacy encrypted 1-1 group message. */
export interface LegacyGroupControl {
  group: Group;
  groupId: string;
  sender: string;
  me: string | null;
  messageData: { guardianAlert?: unknown; checkIn?: unknown; timestamp?: number };
}

export interface GuardianExtension {
  /** true = the message was a guardian control message and has been handled (or dropped by the role checks) */
  onLegacyGroupMessage(ctx: LegacyGroupControl): boolean;
}

// ─────────────────────────────── payments ───────────────────────────────

export interface PaymentsExtension {
  registerIdentity(sign: (data: Uint8Array) => Uint8Array, publicKey: Uint8Array): void;
  /** payment_* status control message from a friend; true = handled (not a visible message) */
  onDirectControl(ctx: { type: string; txId?: string; dueAt?: unknown; friendId: string; me: string | null }): boolean;
  /** foreground again: run due schedules */
  onResume(publicKey: string): void;
}

// ─────────────────────────────── VPN ───────────────────────────────

export interface VpnExtension {
  /** reload the protection settings store */
  loadSettings(): void;
}

// ─────────────────────────────── UI slots ───────────────────────────────

/** ChatApp shell: extra tabs and panels. */
export interface ChatShellContext {
  publicKey: string | null;
  displayName: string;
  /** show a group on the groups tab (check-in navigation) */
  openGroup: (groupId: string) => void;
}

export interface ChatShell {
  /** extra mobile bottom-nav buttons after friends / groups */
  mobileTabs: ReactNode;
  /** a full-screen mobile panel was requested */
  mobilePanelOpen: boolean;
  /** the panel to render (null falls through to settings / group / chat room) */
  mobilePanel: ReactNode;
  /** tablet / desktop right pane that replaces the chat (null = none) */
  desktopPanel: ReactNode;
  /** overlay on the main views (check-in card) */
  overlay: ReactNode;
  /** wraps every ChatApp view (official: behaviour analysis provider); a stable component, not created per render */
  Wrapper: ComponentType<{ children: ReactNode; myPublicKey: string | null }>;
  /** FriendList guard button (desktop); undefined = no button */
  openGuard?: () => void;
}

export interface SettingsExtras {
  /** under the account block (official: help a friend recover) */
  accountItems: ReactNode;
  /** sections after security (official: AegisGuard settings, AegisPay toggle) */
  sections: ReactNode;
  /** modals at the end of the page */
  modals: ReactNode;
}

export interface ChatRoomContext {
  currentFriend: Friend | null | undefined;
  myPublicKey: string | null;
  myName: string;
  messages: Message[];
  /** latest messages (for listeners that must not re-subscribe on every message) */
  messagesRef: { readonly current: Message[] };
  sendPaymentMessage: (paymentData: PaymentData) => void;
  sendPaymentCancelled: (txId: string) => void;
  updatePaymentStatus: (friendId: string, txId: string, status: PaymentData['status'], myPublicKey: string, extra?: Partial<PaymentData>) => Promise<void>;
  /** open the scam alert modal */
  showScamAlert: (riskResult: RiskResult, messageContent: string) => void;
}

export interface ChatRoomExtras {
  /** ambient frame class from behaviour analysis ('' = none) */
  ambientClass: string;
  /** wallet button in the input bar; undefined = hidden */
  onTransfer?: () => void;
  onCancelPayment?: (message: Message) => Promise<void>;
  onActivatePayments?: () => void;
  /** modals rendered after the input bar (transfer, activation) */
  modals: ReactNode;
}

export interface GroupGuardianContext {
  currentGroup: Group | undefined;
  publicKey: string | null;
  sendCheckIn: (status: 'ok' | 'help') => void;
  updateGuardianSettings: (settings: GuardianGroupSettings) => Promise<void> | void;
}

export interface GroupGuardian {
  isGuardianGroup: boolean;
  /** header line additions (you are guardian / protected) */
  headerBadges: ReactNode;
  /** settings menu entry */
  menuItem: (closeMenu: () => void) => ReactNode;
  /** status / alert / check-in cards above the messages */
  panel: ReactNode;
  /** settings modal */
  modal: ReactNode;
}

export interface CallRiskContext {
  callState: CallState;
  peerId?: string;
  /** seconds */
  duration: number;
  peerName: string;
}

/** In-call voice risk analysis (official); chat: nothing analysed, nothing shown. */
export interface CallRisk {
  isAnalyzing: boolean;
  sliceCount: number;
  /** shown while connected */
  shield: ReactNode;
  /** live transcript, shown while connected */
  transcript: ReactNode;
  /** risk summary after the call (null = none) */
  summary: ReactNode;
}

export interface UiExtension {
  useChatShell(ctx: ChatShellContext): ChatShell;
  useSettingsExtras(ctx: { myPubkey: string | null }): SettingsExtras;
  useChatRoomExtras(ctx: ChatRoomContext): ChatRoomExtras;
  useGroupGuardian(ctx: GroupGuardianContext): GroupGuardian;
  useCallRisk(ctx: CallRiskContext): CallRisk;
  /** FriendList / CreateGroupModal: offer to create a guardian group */
  useCanCreateGuardianGroup(): boolean;
  isGuardianGroup(group: Group): boolean;
  CreateGuardianGroupModal: ComponentType<{ isOpen: boolean; onClose: () => void; onCreated?: (groupId: string) => void }> | null;
  /** chat input dictation (on-device speech); null = no dictation button */
  VoiceInput: ComponentType<{ onLiveText: (text: string) => void; onStop: () => void }> | null;
  /** payment card in a message bubble; null = shown as a plain message */
  PaymentCard: ComponentType<{ paymentData: PaymentData; isMine: boolean; onCancel?: () => Promise<void>; onActivateRequest?: () => void }> | null;
  /** App-level effects and overlays (official: VPN threat decisions + threat modal) */
  useAppEffects(): void;
  AppOverlays: ComponentType;
  /** wraps the AppProvider tree (official: plugin host) */
  ProviderWrapper: ComponentType<{ children: ReactNode; myPublicKey?: string; encryptToJson: (peer: string, plaintext: string) => Promise<string> }>;
  /** settings notification row: ask the OS for notification permission */
  requestNotificationPermission(): Promise<boolean>;
}

/** AppProvider hooks for official background services (chat: no-ops). */
export interface AppServiceHooks {
  /** guardian check-in notifications / native schedule (was useGuardianService) */
  useGuardian(publicKey: string | null): void;
  /** payments: pending intent sweep */
  usePaymentSweep(publicKey: string | null, encryptToJson: (peer: string, plaintext: string) => Promise<string>): void;
  /** guardian check-in reminders (web) and check-in events */
  useCheckInScheduler(ctx: {
    isGroupsLoaded: boolean;
    cryptoReady: boolean;
    publicKey: string | null;
    encrypt: (recipientPublicKey: string, plaintext: string) => Promise<{ toJson(): string }>;
    getFriendByPublicKey: (publicKey: string) => { name?: string } | undefined;
  }): void;
}

export interface AppExtensions {
  edition: Edition;
  antiFraud: AntiFraudExtension;
  identity: IdentityExtension;
  guardian?: GuardianExtension;
  payments?: PaymentsExtension;
  vpn?: VpnExtension;
  ui: UiExtension;
  hooks: AppServiceHooks;
  /** AegisBot transient status (official); absent = dropped */
  onAgentStatus?: (fromPubkey: string, status: string) => void;
}

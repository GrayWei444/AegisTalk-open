/**
 * '@ext' for the review tests (open-source step 5a: the app reaches anti-fraud, identity backup, guardian and payments
 * only through `ext` from '@ext'). Not a test itself.
 *
 *   extStubPlugin()   esbuild plugin: '@ext' → a small object shaped like the chat edition (nothing scanned, no risk,
 *                     no backup, no guardian / payments). Without it esbuild follows tsconfig "paths" to the official
 *                     implementation, which pulls in React and the private SDKs.
 *                     A test can watch / steer calls with globalThis.__extHooks = { backupClear() {}, backupMarkDirty() {},
 *                     backupFlush() {}, setOwnSignedPreKey(spk) {}, contactRisk(pk) {}, inspectInbound(ev) {} } — a hook
 *                     replaces the default result when it returns something other than undefined;
 *                     globalThis.__extHooks.callAnalysis = { initialize, onSlice, start, stop, startSession } gives voiceCall an analyzer.
 *   extVm             the same object for code run with runInNewContext (AppProvider / modal snippets): pass `ext: extVm`.
 *
 * The defaults are what the old stubs did: "rule engine not ready" (isAegisReady → false), no trust record, cloud
 * flush succeeds.
 */
const EXT_SOURCE = `
const hook = (name, args, fallback) => {
  const h = globalThis.__extHooks && globalThis.__extHooks[name];
  if (!h) return fallback();
  const r = h(...args);
  return r === undefined ? fallback() : r;
};
export const ext = {
  edition: 'chat',
  antiFraud: {
    enabled: false,
    start: async () => {}, stop() {}, onAppResume() {}, afterLogin() {},
    inspectInbound: (ev) => hook('inspectInbound', [ev], async () => undefined),
    contactRisk: (pk) => hook('contactRisk', [pk], async () => null),
    contactRiskLevels: async () => new Map(),
    evaluateUrl: async () => null,
    text: { isReady: () => false, normalize: (t) => t, quickEvaluate() { throw new Error('no risk engine'); } },
    speech: null,
    get callAnalysis() { return (globalThis.__extHooks && globalThis.__extHooks.callAnalysis) || null; },
    e2eApi: async () => ({}),
  },
  identity: {
    AuthScreen: null,
    initStorage() {}, bootModels() {}, preloadModels() {}, disposeModels() {}, runDevHarness: () => false,
    verifyPin: async () => false,
    restoreTransfer: async () => {},
    transferExtras: async () => ({}),
    backup: {
      setProviders() {},
      setOwnSignedPreKey: (spk) => hook('setOwnSignedPreKey', [spk], () => undefined),
      markDirty: () => hook('backupMarkDirty', [], () => undefined),
      flushNow: () => hook('backupFlush', [], async () => ({ success: true })),
      clear: () => hook('backupClear', [], () => undefined),
    },
    useServiceRegistration() {},
  },
  ui: {},
  hooks: { useGuardian() {}, usePaymentSweep() {}, useCheckInScheduler() {} },
};
`;

/** '@ext/server' for the review tests: a neutral test server (globalThis.__extHooks.server replaces it; null = none chosen) */
const SERVER_SOURCE = `
const h = globalThis.__extHooks && globalThis.__extHooks.server;
export const defaultServer = h !== undefined ? h : { name: 'Test chat', apiUrl: 'https://chat-api.test', mqttUrl: 'wss://chat-mqtt.test/mqtt' };
export const connectSources = [];
export const brandLegal = undefined;
`;

export function extStubPlugin() {
  return { name: 'ext-stub', setup(b) {
    // '@ext' and its leaf entries '@ext/backup' / '@ext/callAnalysis' (stores, useCrypto, deviceClaim, voiceCall use those)
    //   and '@ext/server' (services/serverChoice: the edition's default server — here a neutral test server)
    b.onResolve({ filter: /^@ext(\/(backup|callAnalysis|server))?$/ }, (a) => ({ path: a.path, namespace: 'ext-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'ext-stub' }, (a) => ({ loader: 'js', contents: a.path === '@ext' ? EXT_SOURCE
      : a.path === '@ext/backup' ? `${EXT_SOURCE}\nexport const backup = ext.identity.backup;`
      : a.path === '@ext/server' ? SERVER_SOURCE
      : `${EXT_SOURCE}\nexport const callAnalysis = ext.antiFraud.callAnalysis;` }));
  } };
}

/** Same object for vm contexts (sources run with runInNewContext keep `ext.` member calls). */
export const extVm = await import('data:text/javascript,' + encodeURIComponent(EXT_SOURCE)).then((m) => m.ext);

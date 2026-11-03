/**
 * 模擬專用（W5，docs/GROUP_LOG_WIRING_W5.md）：建模擬用的 dist 時由 scripts/sim/vite.sim.config.mjs 接到 main.tsx 後面，正式版沒有這個檔。
 * 只在 AEGIS_E2E_TEST 模式下掛 window.__simAdversary：
 *   - 讓「手機自己的主人」做壞事（被踢的 Bob 再去要金鑰、要 sync；普通成員 D 用自己的身分簽一筆偽造的踢人；admin C 換金鑰時故意漏掉
 *     某個人；好友 A 灌邀請）—— 這些都只用那支手機本來就有的身分與金鑰，等於一個改過的 App
 *   - 看 App 收到了什麼（引擎收到的封給身分金鑰的信封種類、群組畫面的狀態），模擬才判得出「什麼都沒收到」
 *   - 開源第 4 步：1 對 1 通話與 DataChannel 的狀態、兩邊讀到的 DTLS 指紋（交叉比對「中間沒有人」）、directSignal 的計數；
 *     corruptFingerprints(true)：這支送出去的指紋故意寫錯（模擬「中間有人」：對方必須掛斷、拆線、提示使用者；第 5d 步起群組通話也是）
 *   - 開源第 5d 步：推播來電的 JS 那一條路（ringDecision：跟 service worker 同一段 decideRing ＋ pushDisplayFor，名單是 App 自己同步的
 *     IndexedDB）；群組通話（groupCall*：直接叫 groupCallService，不經畫面）與每條 PC 的指紋狀態
 * 不碰任何正式服務；網路一律由模擬攔下。
 */
import { currentSealer, sendGroupSealed, x25519, verify } from '../../../packages/pwa/src/services/groupKeyDelivery';
import { getGroupEngine } from '../../../packages/pwa/src/services/groupEngineHost';
import { mqttService, MessageType } from '../../../packages/pwa/src/services/mqtt';
import { createGroupLogClient } from '../../../packages/pwa/src/services/groupLogClient';
import { apiBase } from '../../../packages/pwa/src/services/apiBase';
import * as G from '../../../packages/pwa/src/services/groupState';
import * as L from '../../../packages/pwa/src/services/groupLog';
import * as CTL from '../../../packages/pwa/src/services/groupControl';
import { useGroupStore } from '../../../packages/pwa/src/stores/groupStore';
import { useChatStore } from '../../../packages/pwa/src/stores/chatStore';
import { addToBlacklistManual } from '../../../packages/pwa/src/services/localBlacklist';
import { groupCallService } from '../../../packages/pwa/src/services/groupCallService';
import { voiceCallService } from '../../../packages/pwa/src/services/voiceCall';
import { webrtcService } from '../../../packages/pwa/src/services/webrtc';
import { directStats } from '../../../packages/pwa/src/services/directSignal';
import { decideRing, loadRingDirectory } from '../../../packages/pwa/src/services/ringDirectory';
import { pushDisplayFor } from '../../../packages/pwa/src/services/pushDisplay';

type Rec = Record<string, unknown>;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sealer() {
  const s = currentSealer();
  if (!s) throw new Error('identity is locked');
  return s;
}

function engine() {
  const e = getGroupEngine();
  if (!e) throw new Error('no group engine');
  return e;
}

/** 引擎收到的封給身分金鑰的信封、通話信令、群組來電（模擬判「什麼都沒收到」用） */
const sealedLog: Rec[] = [];
const callLog: Rec[] = [];
const PATCHED = Symbol('simAdversaryPatched');

/** 把目前這個引擎的 onSealed 包一層記錄（引擎換了 —— 重開、換帳號 —— 再包一次）；groupCallService 一次就好 */
function watch(): boolean {
  const e = getGroupEngine() as unknown as Rec | null;
  if (e && !e[PATCHED as unknown as string]) {
    const orig = e.onSealed as (from: string, body: Rec) => Promise<void>;
    e.onSealed = (from: string, body: Rec) => {
      sealedLog.push({ at: Date.now(), from, kind: body?.kind ?? null, gid: body?.gid ?? null, kid: body?.kid ?? null });
      if (sealedLog.length > 5000) sealedLog.splice(0, 1000);
      return orig(from, body);
    };
    e[PATCHED as unknown as string] = true;
  }
  const gc = groupCallService as unknown as Rec;
  if (!gc[PATCHED as unknown as string]) {
    const origSignal = gc.handleSignal as (from: string, body: Rec, now?: number) => void;
    gc.handleSignal = function (this: unknown, from: string, body: Rec, now?: number) {
      callLog.push({ at: Date.now(), from, what: 'signal', gid: body?.gid ?? null, signal: body?.signal ?? null });
      return origSignal.call(groupCallService, from, body, now);
    };
    groupCallService.onIncomingCall((gid, _name, initiator) => { callLog.push({ at: Date.now(), from: initiator, what: 'incoming', gid }); });
    gc[PATCHED as unknown as string] = true;
  }
  return !!e;
}

async function chainView(gid: string) {
  const b = engine().backupOf(gid);
  if (!b) throw new Error('not a member of that group');
  const loaded = await G.loadChain(gid, b.chain, verify, Number.POSITIVE_INFINITY);
  if (!loaded.ok) throw new Error(`chain does not load: ${loaded.reason}`);
  if (!b.epochKey) throw new Error('no current epoch key');
  return { view: loaded.view, kid: b.epochKey.kid, key: unb64(b.epochKey.key) };
}

/**
 * 用我的身分簽一筆 commit、用目前這一代封成 log entry、append（不經 checkCommit：規則不收的也寫得出去）。
 *   actor：commit 上寫的作者（預設我；寫別人 ＝ 「冒名」：簽章是我的，驗不過）
 *   newEpoch：帶新一代（rekey／remove）：kid 照位置與作者推、封裝包給 rosterAfter 減掉 skip 的人
 *   notify：在目前這一代的主題上發 commit 通知（大家馬上去抓）
 */
async function forgeCommit(p: { gid: string; op: string; args?: Rec; actor?: string; newEpoch?: boolean; skip?: string[]; notify?: boolean }) {
  const s = sealer();
  const { view, kid: epochKid, key: epochKey } = await chainView(p.gid);
  const state = view.state;
  const actor = p.actor ?? s.me;
  let args: Rec = { ...(p.args ?? {}) };
  let bundle: L.KeyBundle | undefined;
  let newKid: string | null = null;
  if (p.newEpoch) {
    newKid = await G.epochKidFor(state.head.id, actor);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const recipients = G.rosterAfter(state, p.op as G.GroupOp, args.pk as string | undefined).filter((pk) => !(p.skip ?? []).includes(pk));
    bundle = (await L.sealKeyBundle({ gid: p.gid, kid: newKid, key, recipients }, x25519)).bundle;
    args = { ...args, kid: newKid, kc: await G.keyCommitment(key, p.gid, newKid), kb: await L.bundleHash(bundle) };
  }
  const commit = G.parseCommit(G.proposeCommit(state, actor, p.op as Exclude<G.GroupOp, 'create'>, args, mqttService.serverNow()));
  const signed = { c: commit, s: b64(s.sign(G.utf8(G.GSTATE_DOMAIN + G.commitBody(commit)))) };
  const blob = await L.sealLogEntry({ gid: p.gid, kid: epochKid, key: epochKey, commit: signed, bundle });
  const client = createGroupLogClient({ base: apiBase(), signer: () => ({ publicKey: s.me, sign: s.sign }), serverNow: () => mqttService.serverNow() });
  const seq = await client.append(p.gid, blob);
  const id = await G.commitIdOf(commit);
  if (p.notify) {
    const { tid, envelope } = await CTL.sealControl({ gid: p.gid, kid: epochKid, key: epochKey, sender: s.me, sign: s.sign, t: 'commit',
      body: { head: { seq, id } }, ts: mqttService.serverNow() });
    mqttService.sendToGroup(tid, MessageType.GROUP_SEALED, envelope, { qos: 1 });
  }
  return { id, seq, kid: newKid, epochKid, headV: state.head.v };
}

/**
 * 用給的金鑰（例如被踢的人留著的上一代）封一則群組控制訊息；回傳 { tid, envelope }（由呼叫端決定發不發、發在哪）。
 * sender：信封上寫的寄件人（預設我；寫別人 ＝ 冒名：AAD 綁他，但內層簽章是我的，收端驗不過）
 */
async function sealControl(p: { gid: string; kid: string; keyB64: string; t: CTL.ControlKind; body: Rec; ts?: number; sender?: string }) {
  const s = sealer();
  return CTL.sealControl({ gid: p.gid, kid: p.kid, key: unb64(p.keyB64), sender: p.sender ?? s.me, sign: s.sign, t: p.t, body: p.body, ts: p.ts ?? mqttService.serverNow() });
}

/** 引擎給畫面的通知（invite-rejected、conflict、key-wait…）：模擬判「這份邀請為什麼被拒」用；mqtt 的提示也記在這裡（kind ＝ mqtt:…） */
const noticeLog: Rec[] = [];
if (typeof window !== 'undefined') {
  window.addEventListener('aegis:group-notice', (ev) => {
    const d = (ev as CustomEvent).detail as Rec | undefined;
    noticeLog.push({ at: Date.now(), gid: d?.gid ?? null, kind: d?.kind ?? null, reason: d?.reason ?? null, op: d?.op ?? null });
    if (noticeLog.length > 2000) noticeLog.splice(0, 500);
  });
  // mqtt 給畫面的提示（clock-drift 等；W5 P2）：kind 前面加 mqtt:
  window.addEventListener('aegis:mqtt-notice', (ev) => {
    const d = (ev as CustomEvent).detail as Rec | undefined;
    noticeLog.push({ at: Date.now(), gid: null, kind: `mqtt:${String(d?.kind ?? '')}`, reason: null, op: null, minutes: d?.minutes ?? null });
    if (noticeLog.length > 2000) noticeLog.splice(0, 500);
  });
}

function groupView(gid: string) {
  const g = useGroupStore.getState().getGroupById(gid);
  if (!g) return null;
  const x = g as unknown as Rec;
  return {
    id: g.id, name: g.name, groupType: x.groupType ?? null, keyState: x.keyState ?? null, logConflict: x.logConflict ?? null,
    unackedInvites: x.unackedInvites ?? null, guardianSettings: x.guardianSettings ?? null,
    members: g.members.map((m) => ({ publicKey: m.publicKey, role: (m as unknown as Rec).role ?? null })),
  };
}

/** 引擎的一個方法（結果轉成可序列化的；金鑰不出來） */
async function engineCall(method: string, ...args: unknown[]) {
  const e = engine() as unknown as Record<string, (...a: unknown[]) => unknown>;
  const out = await e[method](...args);
  if (method === 'sendingKey') return out ? { kid: (out as Rec).kid } : null;
  return out === undefined ? null : JSON.parse(JSON.stringify(out));
}

/** 開源第 4 步：這支送出去的 DTLS 指紋故意寫錯（通話與 DataChannel；on=false 恢復） */
const FAKE_FP = 'sha-256 ' + Array.from({ length: 32 }, () => '00').join(':');
const origSendFp = new Map<string, unknown>();
function corruptFingerprints(on: boolean): boolean {
  for (const [name, svc] of [['call', voiceCallService], ['dc', webrtcService], ['group', groupCallService]] as const) {
    const x = svc as unknown as Rec;
    if (!origSendFp.has(name)) origSendFp.set(name, x.sendFingerprint);
    const orig = origSendFp.get(name) as (...a: unknown[]) => void;
    if (!on) { x.sendFingerprint = orig; continue; }
    x.sendFingerprint = name === 'call'
      ? function (this: unknown, fp: Rec, got: boolean) { return orig.call(svc, { ...fp, remote: [FAKE_FP] }, got); }
      : function (this: unknown, peer: string, fp: Rec, got: boolean) { return orig.call(svc, peer, { ...fp, remote: [FAKE_FP] }, got); };
  }
  return on;
}

/** 開源第 5d 步：一則推播（伺服器組的內容）→ 這支手機的 JS 那一條路會不會響、顯示什麼（同 sw-custom.ts 的 push 事件） */
async function ringDecision(data: unknown) {
  const now = Date.now();
  const ring = await decideRing(data, now);
  const display = pushDisplayFor(data, now, ring);
  return { ring, display };
}

/** 開源第 5d 步：同步給 JS 那一條路的名單（我是誰、好友數、時鐘差；不回名字） */
async function ringDirectoryInfo() {
  const d = await loadRingDirectory().catch(() => null);
  return d ? { me: d.me, friends: Object.keys(d.friends).length, offsetMs: d.offsetMs } : null;
}

/** 群組通話（不經畫面：GroupChatWindow 沒開時 groupCallService 還沒初始化 → 用我的身分初始化） */
function groupCallReady(): void {
  const me = currentSealer()?.me;
  if (!me) throw new Error('identity is locked');
  if (groupCallService.localPublicKey !== me) groupCallService.initialize(me);
}
async function groupCallStart(gid: string, video = false) {
  groupCallReady();
  const g = useGroupStore.getState().getGroupById(gid);
  if (!g) throw new Error('not a member of that group');
  const me = currentSealer()?.me;
  await groupCallService.startGroupCall(gid, g.name, g.members.map((m) => m.publicKey).filter((pk) => pk !== me), video);
  return true;
}
async function groupCallJoin(gid: string, video = false) {
  groupCallReady();
  await groupCallService.joinGroupCall(gid, video);
  return true;
}

async function unfriend(pk: string) {
  const f = useChatStore.getState().getFriendByPublicKey(pk);
  if (!f) return false;
  await useChatStore.getState().removeFriend(f.id);
  return true;
}

async function block(pk: string) {
  const name = useChatStore.getState().getFriendByPublicKey(pk)?.name;
  await addToBlacklistManual(pk, name, 'sim W5');
  return true;
}

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem('AEGIS_E2E_TEST') === 'true') {
  (window as unknown as Rec).__simAdversary = {
    me: () => currentSealer()?.me ?? null,
    sign: (dataB64: string) => b64(sealer().sign(unb64(dataB64))),
    watch,
    sealedLog: () => sealedLog.slice(),
    callLog: () => callLog.slice(),
    notices: () => noticeLog.slice(),
    sendSealed: (to: string, body: Rec, transient = false) => sendGroupSealed(to, body, { transient }),
    sealControl,
    publishGroup: (tid: string, envelope: unknown, qos: 0 | 1 = 1) => mqttService.sendToGroup(tid, MessageType.GROUP_SEALED, envelope, { qos }),
    forgeCommit,
    groupView,
    engineCall,
    unfriend,
    block,
    presenceTag: () => ((mqttService as unknown as Rec)._tokenScope as Rec | null)?.presenceTag ?? null,
    /** 我這邊採用的好友狀態 { on, ts, cs }（沒有 → null） */
    presenceStateOf: (pk: string) => ((mqttService as unknown as Rec).friendPresence as Map<string, unknown>).get(pk) ?? null,
    clockOffset: () => (mqttService as unknown as Rec)._clockOffsetMs ?? null,
    // 開源第 4 步：1 對 1 通話、DataChannel、封好的信令
    callDebug: () => voiceCallService.debugState(),
    callFingerprints: () => voiceCallService.debugFingerprints(),
    dcDebug: () => webrtcService.debugState(),
    dcFingerprints: (pk: string) => webrtcService.debugFingerprints(pk),
    dcOpen: (pk: string) => webrtcService.isDataChannelOpen(pk),
    dcDrop: (pk: string) => webrtcService.forceClosePeerForE2E(pk),
    directStats: () => directStats(),
    corruptFingerprints,
    // 開源第 5d 步：推播來電（JS 那一條路）、群組通話的指紋
    ringDecision,
    ringDirectory: ringDirectoryInfo,
    groupCallStart,
    groupCallJoin,
    groupCallLeave: () => { groupCallService.leaveCall(); return true; },
    groupCallEnd: () => { groupCallService.endCall(); return true; },
    groupCallDebug: () => groupCallService.debugState(),
    groupCallFingerprints: (pk: string) => groupCallService.debugFingerprints(pk),
  };
  // 引擎晚一點才建（解鎖、資料庫就緒之後）：每秒看一次，換了就再包
  setInterval(() => { try { watch(); } catch { /* 還沒有引擎 */ } }, 1000);
}

/**
 * 群組狀態鏈的備份與還原（備份 blob aegisIdBlob、帳號恢復、換機 deviceTransfer 共用）。
 *
 * 備份：整條驗過的鏈（線上格式）、log 位置（firstSeq／baseV／processedSeq／headSeq／joinAt／appliedAt）、目前那一代的金鑰。
 * 還原：重新驗整條鏈（loadChain，每個簽章與權限）、我要在名冊上、金鑰要對得上鏈上的 kc、位置要自洽 —— 任何一項不對就不還原
 * 這個群（不會用一份壞掉的備份蓋掉別的東西）。之後的換金鑰在伺服器 log 的封裝包裡（封給身分金鑰），還原後補進度就拿得到。
 * 備份 blob 本身已封存加密（PIN＋伺服器保管的秘密），裡面本來就有身分私鑰；多放目前那一代的群組金鑰不會多洩漏什麼。
 */
import {
  keyAuthorised, loadChain, memberOf, validCommitId, wireOf, encodeCommitRow, epochOfKey,
  type SignedCommit, type VerifyFn,
} from './groupState';
import { projectionRow } from './groupProjection';
import type { GroupLogStore, ReplicaMeta } from './groupLogStore';
import type { Runtime } from './groupEngine';

export interface GroupBackup {
  v: 1;
  chain: SignedCommit[];
  firstSeq: number;
  baseV: number;
  processedSeq: number;
  headSeq: number;
  joinAt: { v: number; id: string } | null;
  appliedAt: Record<string, string>;
  /** 目前那一代的金鑰（標準 base64）；沒有就 null（還原後向 admin 要） */
  epochKey: { kid: string; key: string } | null;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function unb64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function backupOf(rt: Runtime): GroupBackup {
  const r = rt.rep;
  const kid = r.view.state.epoch.kid;
  const key = rt.keys.get(kid);
  return {
    v: 1, chain: r.view.chain.map(wireOf), firstSeq: r.firstSeq, baseV: r.baseV, processedSeq: r.processedSeq, headSeq: r.headSeq,
    joinAt: r.joinAt, appliedAt: { ...r.appliedAt }, epochKey: key ? { kid, key: b64(key) } : null,
  };
}

const okSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** 備份的外形（鏈另外整條重驗） */
function shapeOk(b: Partial<GroupBackup> | null | undefined): b is GroupBackup {
  if (!b || typeof b !== 'object' || b.v !== 1 || !Array.isArray(b.chain) || b.chain.length < 1) return false;
  if (!okSeq(b.firstSeq) || !okSeq(b.processedSeq) || !okSeq(b.headSeq) || !okSeq(b.baseV) || b.baseV < 1) return false;
  if (b.firstSeq > b.headSeq || b.headSeq > b.processedSeq || b.baseV > b.chain.length) return false;
  if (b.joinAt !== null && !(b.joinAt && okSeq(b.joinAt.v) && validCommitId(b.joinAt.id))) return false;
  if (!b.appliedAt || typeof b.appliedAt !== 'object') return false;
  if (!Object.entries(b.appliedAt).every(([seq, id]) => /^\d{1,16}$/.test(seq) && validCommitId(id))) return false;
  return b.epochKey === null || (!!b.epochKey && typeof b.epochKey.kid === 'string' && typeof b.epochKey.key === 'string');
}

/**
 * 還原一個群：驗過才寫進本機（鏈、位置、金鑰、投影）。回傳有沒有還原。
 * me：還原出來的帳號公鑰；已經在本機的群（有 log 狀態）不覆寫。
 */
export async function restoreGroupBackup(p: {
  gid: string;
  backup: unknown;
  me: string;
  verify: VerifyFn;
  store: GroupLogStore;
  nicknameOf?: (pk: string) => string | undefined;
  /** 本機已經有 log 狀態的群（一次還原很多個時由呼叫端先查一次） */
  existing?: ReadonlySet<string>;
}): Promise<boolean> {
  const b = p.backup as Partial<GroupBackup> | null;
  if (!shapeOk(b)) return false;
  const loaded = await loadChain(p.gid, b.chain, p.verify, Number.POSITIVE_INFINITY);
  if (!loaded.ok) return false;
  const view = loaded.view;
  const state = view.state;
  if (state.deleted || !memberOf(state, p.me)) return false;
  if (b.appliedAt[String(b.headSeq)] !== state.head.id) return false;
  if (b.joinAt && view.chain[b.joinAt.v - 1]?.id !== b.joinAt.id) return false;
  const existing = p.existing ?? new Set((await p.store.loadGroupLogs(p.me)).map((s) => s.meta.gid));
  if (existing.has(p.gid)) return false;
  let keys: Array<{ kid: string; key: Uint8Array; v: number; actor: string; origin: 'chain' }> = [];
  if (b.epochKey) {
    const key = unb64(b.epochKey.key);
    const epoch = epochOfKey(state, b.epochKey.kid);
    if (key && key.length === 32 && epoch && (await keyAuthorised(state, epoch.kid, epoch.kc, key))) {
      keys = [{ kid: epoch.kid, key, v: epoch.v, actor: view.chain[epoch.v - 1]?.c.actor ?? '', origin: 'chain' }];
    }
  }
  // 重建（交叉比對發現伺服器改了歷史時）的基準點挪到目前這一代開始的地方：備份只帶這一代的金鑰，從更早的地方重建一定
  //   卡在等舊的金鑰（審查 W1 HIGH-3）。appliedAt 裡沒有那一筆（超出保留範圍）就照備份的
  const epochStartId = view.chain[state.epoch.v - 1]?.id;
  const startSeq = Object.entries(b.appliedAt).find(([, id]) => id === epochStartId)?.[0];
  const moveBase = startSeq !== undefined && state.epoch.v >= b.baseV && Number(startSeq) >= b.firstSeq && Number(startSeq) <= b.headSeq;
  const meta: ReplicaMeta = {
    gid: p.gid, me: p.me, headV: state.head.v, headId: state.head.id, processedSeq: b.processedSeq, headSeq: b.headSeq,
    firstSeq: moveBase ? Number(startSeq) : b.firstSeq, baseV: moveBase ? state.epoch.v : b.baseV, joinAt: b.joinAt, status: 'member',
    appliedAt: { ...b.appliedAt }, waiting: null, rekeySeenAt: null,
  };
  const active = keys.find((k) => k.kid === state.epoch.kid)?.kid ?? null;
  await p.store.persistGroupLog({
    gid: p.gid, replaceFromV: 0, rows: view.chain.map((vc) => encodeCommitRow(p.gid, vc)), meta, keys, activeKid: active,
    projection: projectionRow(view, p.nicknameOf ?? (() => undefined)),
  });
  return true;
}

/** 備份裡的群組清單（新格式：每個群帶 log）一個一個還原；回傳還原了幾個 */
export async function restoreGroupBackups(groups: unknown, me: string, verify: VerifyFn, store: GroupLogStore,
  nicknameOf?: (pk: string) => string | undefined): Promise<number> {
  if (!Array.isArray(groups)) return 0;
  let n = 0;
  const existing = new Set((await store.loadGroupLogs(me)).map((s) => s.meta.gid));
  for (const g of groups as Array<{ id?: unknown; log?: unknown }>) {
    if (!g || typeof g.id !== 'string' || !g.log) continue;
    try {
      if (await restoreGroupBackup({ gid: g.id, backup: g.log, me, verify, store, nicknameOf, existing })) {
        existing.add(g.id);
        n++;
      }
    } catch (e) {
      console.error('[groupBackup] restore failed for', g.id.slice(0, 8), (e as Error)?.message ?? e);
    }
  }
  return n;
}

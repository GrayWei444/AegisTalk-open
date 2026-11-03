/**
 * 群組狀態鏈的「一筆變更」（commit）格式：欄位檢查、正規 JSON、id、簽章（設計 B1，2026-10-22）。
 * 純函式：沒有 I/O、沒有模組層級的可變狀態；簽章與驗章由呼叫端注入（App 用 WASM 的 Identity，測試用 Node crypto）。
 *
 * Commit = { gid, v, prev, op, actor, args, ts }
 *   id  = hex(SHA-256(canonicalJson(commit)))          —— canonicalJson 跟 API 簽章用的同一個（mqttCredential.ts）
 *   sig = Ed25519(actor, "aegistalk-gstate-v1:" + canonicalJson(commit))
 * 網域字串跟 API 的簽章 JSON（沒有前綴）、群組金鑰信封（"aegistalk-gks-v1:"）、群組控制信封（"aegistalk-gctl-v1:"）、
 * 群訊簽章（明文 JSON，以 "{" 開頭）都不同：任何一邊的簽章拿到另一邊都驗不過。
 * 創群（genesis）：v = 1、prev 全零、gid 欄位是空字串（gid 由 genesis 的雜湊算出來，見 genesisGid）。
 * 收到的 commit 一律照欄位重建：多一個欄位、型別不對、超過上限 → 拒收，不會有「簽的是一份、存的是另一份」。
 */
import { canonicalJson, isCanonicalPubkey } from './mqttCredential';
import { isPrimeOrderPoint, isStrictSignature } from './ed25519Strict';
import type { GroupType, GuardianGroupSettings } from '../types';

export const GSTATE_DOMAIN = 'aegistalk-gstate-v1:';
/** genesis 的 prev：64 個 0（hex） */
export const ZERO_ID = '0'.repeat(64);
/** ＝ GROUP_CONSTANTS.MAX_MEMBERS（不 import types 的值：types/index.ts 會連帶拖進 i18n） */
export const MAX_MEMBERS = 50;
/** ＝ GROUP_CONSTANTS.MAX_NAME_LENGTH（UTF-16 長度，跟 groupStore 的 slice 一樣） */
export const MAX_NAME_LENGTH = 50;
/** 鏈上的群組頭像（data URL 字串長度）：每筆 commit、每份邀請都帶著，所以只放小縮圖 */
export const MAX_AVATAR_LENGTH = 2048;
const MAX_CUSTOM_MESSAGE_LENGTH = 500;
const MAX_COMMIT_BYTES = 16 * 1024;

const ID_HEX_RE = /^[0-9a-f]{64}$/;
const GID_RE = /^[A-Za-z0-9_-]{22}$/;
const KID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** HMAC-SHA256 的 URL-safe base64（無 padding） */
const KC_RE = /^[A-Za-z0-9_-]{43}$/;
/** 16 bytes 亂數的 URL-safe base64（無 padding） */
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
/** 64 bytes Ed25519 簽章的標準 base64，而且只收唯一的正規寫法：最後一個資料字元的低 4 bits 必須是 0（審查 L5） */
const SIG_RE = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
const NOTIFY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMEZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export type GroupOp = 'create' | 'add' | 'remove' | 'leave' | 'rekey' | 'role' | 'info' | 'delete';
export type AddPolicy = 'members' | 'admins';
export type MemberRole = 'admin' | 'member';
export type { GroupType, GuardianGroupSettings };

const OPS: readonly GroupOp[] = ['create', 'add', 'remove', 'leave', 'rekey', 'role', 'info', 'delete'];

export interface Commit {
  /** 群組 id；genesis 是空字串 */
  gid: string;
  /** 版本，genesis = 1 */
  v: number;
  /** 上一筆的 id（hex）；genesis 是 ZERO_ID */
  prev: string;
  op: GroupOp;
  /** 發起人的 Ed25519 公鑰（標準 base64） */
  actor: string;
  args: Record<string, unknown>;
  /** 發起人自己說的時間（ms）；只用在輪換負責人的 60 秒順延，不當安全依據 */
  ts: number;
}

/** 線上格式：commit ＋ 發起人簽章（標準 base64） */
export interface SignedCommit {
  c: Commit;
  s: string;
}

/** 驗過格式與簽章；id 是本機算的，不信任對方給的 */
export interface VerifiedCommit extends SignedCommit {
  id: string;
}

export type SignFn = (data: Uint8Array) => Uint8Array;
export type VerifyFn = (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array) => boolean;

/** 狀態鏈拒收的原因（內部用例外傳遞，對外一律轉成 { ok: false, reason }） */
export class ChainReject extends Error {
  constructor(readonly reason: string) {
    super(`groupState: ${reason}`);
  }
}

export function fail(reason: string): never {
  throw new ChainReject(reason);
}

export function rejectReason(e: unknown): string {
  if (e instanceof ChainReject) return e.reason;
  return `error:${(e as Error)?.message ?? String(e)}`;
}

// ============================================
// 欄位檢查
// ============================================

function plainObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${what}-not-object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(`${what}-not-object`);
  return v as Record<string, unknown>;
}

function keysWithin(o: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(`${what}-missing-${k}`);
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(`${what}-unknown-${k}`);
}

const exactKeys = (o: Record<string, unknown>, keys: readonly string[], what: string) => keysWithin(o, keys, [], what);

/**
 * 小階點的 y（忽略 x 的正負號；＝libsodium has_small_order 的名單）。這種點當成員公鑰，(R = 恆等點, S = 0) 之類的「簽章」
 * 在非嚴格驗章下對任何內容都成立 → 營運方可以冒用那位「成員」簽任何 commit。
 */
const SMALL_ORDER_Y: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000', // y = 0（4 階）
  '0100000000000000000000000000000000000000000000000000000000000000', // y = 1（恆等點）
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p − 1（2 階）
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // 8 階
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // 8 階
];

/** y 是正規編碼（< p = 2^255 − 19），而且不是小階點（便宜的檢查，不解壓縮） */
function strongEd25519(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const y = Uint8Array.from(bytes);
  y[31] &= 0x7f;
  if (y[31] === 0x7f && y.subarray(1, 31).every((b) => b === 0xff) && y[0] >= 0xed) return false;
  return !SMALL_ORDER_Y.includes(hex(y));
}

/**
 * 格式上像公鑰（便宜）：標準 base64 的 32 bytes、y 正規、不是小階點。用在「一定已經是成員才會生效」的位置
 * （非 genesis 的 actor、remove／role 的對象、封裝包裡的收件人欄位）：成員的公鑰在進名冊時已經做過完整檢查（validPubkey）。
 */
export function wellFormedPubkey(v: unknown): v is string {
  return isCanonicalPubkey(v) && strongEd25519(fromB64(v));
}

/**
 * 能進名冊的成員公鑰（鏈規則，審查 H1／M2）：wellFormedPubkey，而且在曲線上（解壓縮得出來）、在質數階子群裡
 * （不是小階點、沒有小階成分）。不在曲線上的 32 bytes 轉不成 X25519，換金鑰時封不了新金鑰；混了小階成分的公鑰會讓
 * cofactored 與 cofactorless 驗章器對同一個簽章給不同答案。約 1 ms（只做在 genesis 與 add 的新成員）。
 */
export function validPubkey(v: unknown): v is string {
  return wellFormedPubkey(v) && isPrimeOrderPoint(fromB64(v));
}

/** 整個物件樹凍結（commit、狀態、副本都是共用的：呼叫端改了就會改到已簽的內容） */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

export const validKid = (v: unknown): v is string => typeof v === 'string' && KID_RE.test(v);
export const validKc = (v: unknown): v is string => typeof v === 'string' && KC_RE.test(v);
/** 新金鑰封裝包（log entry 裡、簽章外）的 SHA-256，URL-safe base64 */
export const validKb = (v: unknown): v is string => typeof v === 'string' && KC_RE.test(v);
export const validCommitId = (v: unknown): v is string => typeof v === 'string' && ID_HEX_RE.test(v);
export const validGid = (v: unknown): v is string => typeof v === 'string' && GID_RE.test(v);

/** 進名冊的新成員（genesis 的成員、add 的對象）：完整檢查 */
function newMemberOf(v: unknown): string {
  if (!validPubkey(v)) fail('bad-pubkey');
  return v;
}

/** 已經是成員才有意義的對象（remove、role）：格式檢查即可，不是成員由規則拒收 */
function pkOf(v: unknown): string {
  if (!wellFormedPubkey(v)) fail('bad-pubkey');
  return v;
}

function nameOf(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_NAME_LENGTH) fail('bad-name');
  return v;
}

function avatarOf(v: unknown): string {
  if (typeof v !== 'string' || v.length > MAX_AVATAR_LENGTH) fail('bad-avatar');
  return v;
}

function groupTypeOf(v: unknown): GroupType {
  if (v !== 'normal' && v !== 'guardian') fail('bad-group-type');
  return v;
}

function policyOf(v: unknown): AddPolicy {
  if (v !== 'members' && v !== 'admins') fail('bad-add-policy');
  return v;
}

function roleOf(v: unknown): MemberRole {
  if (v !== 'admin' && v !== 'member') fail('bad-role');
  return v;
}

function kidOf(v: unknown): string {
  if (!validKid(v)) fail('bad-kid');
  return v;
}

function kcOf(v: unknown): string {
  if (!validKc(v)) fail('bad-kc');
  return v;
}

function boolOf(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`bad-${what}`);
  return v;
}

function numberIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`bad-${what}`);
  return v;
}

/** 守護群組設定：照 types/guardianGroup.ts 的欄位，多的、型別不對的一律拒收 */
export function parseGuardianSettings(raw: unknown): GuardianGroupSettings {
  const g = plainObject(raw, 'guardian-settings');
  exactKeys(g, ['type', 'checkIn', 'protection'], 'guardian-settings');
  if (g.type !== 'guardian') fail('bad-guardian-settings-type');
  const c = plainObject(g.checkIn, 'check-in');
  keysWithin(c, ['enabled', 'frequency', 'notifyTime', 'responseDeadline'], ['timezone', 'customMessage'], 'check-in');
  if (c.frequency !== 'daily' && c.frequency !== 'every_2_days' && c.frequency !== 'weekly') fail('bad-check-in-frequency');
  if (typeof c.notifyTime !== 'string' || !NOTIFY_TIME_RE.test(c.notifyTime)) fail('bad-check-in-notify-time');
  if (c.timezone !== undefined && (typeof c.timezone !== 'string' || !TIMEZONE_RE.test(c.timezone))) fail('bad-check-in-timezone');
  if (c.customMessage !== undefined && (typeof c.customMessage !== 'string' || c.customMessage.length > MAX_CUSTOM_MESSAGE_LENGTH)) {
    fail('bad-check-in-message');
  }
  const p = plainObject(g.protection, 'protection');
  exactKeys(p, ['riskAlert', 'paymentAlert', 'linkAlert', 'riskThreshold'], 'protection');
  return {
    type: 'guardian',
    checkIn: {
      enabled: boolOf(c.enabled, 'check-in-enabled'),
      frequency: c.frequency,
      notifyTime: c.notifyTime,
      ...(c.timezone !== undefined ? { timezone: c.timezone as string } : {}),
      responseDeadline: numberIn(c.responseDeadline, 0, 24 * 365, 'check-in-deadline'),
      ...(c.customMessage !== undefined ? { customMessage: c.customMessage as string } : {}),
    },
    protection: {
      riskAlert: boolOf(p.riskAlert, 'risk-alert'),
      paymentAlert: boolOf(p.paymentAlert, 'payment-alert'),
      linkAlert: boolOf(p.linkAlert, 'link-alert'),
      riskThreshold: numberIn(p.riskThreshold, 0, 100, 'risk-threshold'),
    },
  };
}

/**
 * 換金鑰的 commit（rekey、remove、加回舊成員）帶的新一代：kid、kc（金鑰承諾）、kb（新金鑰封給每位留下成員的封裝包的雜湊）。
 * 封裝包本身放在 log entry 裡、不進簽章與鏈（邀請不會越來越大），kb 把它綁在這筆簽過名的 commit 上（決定 2026-10-22 log 模型 1）。
 */
function newEpochArgs(a: Record<string, unknown>): Record<string, unknown> {
  if (!validKb(a.kb)) fail('bad-kb');
  return { kid: kidOf(a.kid), kc: kcOf(a.kc), kb: a.kb };
}

function parseCreateArgs(a: Record<string, unknown>, actor: string): Record<string, unknown> {
  exactKeys(a, ['name', 'avatar', 'groupType', 'guardianSettings', 'addPolicy', 'members', 'kid', 'kc', 'nonce'], 'create');
  const groupType = groupTypeOf(a.groupType);
  const guardianSettings = a.guardianSettings === null ? null : parseGuardianSettings(a.guardianSettings);
  if (groupType !== 'guardian' && guardianSettings) fail('guardian-settings-on-normal-group');
  if (!Array.isArray(a.members) || a.members.length > MAX_MEMBERS - 1) fail('bad-initial-members');
  const members = a.members.map(newMemberOf);
  if (new Set(members).size !== members.length || members.includes(actor)) fail('bad-initial-members');
  if (typeof a.nonce !== 'string' || !NONCE_RE.test(a.nonce)) fail('bad-nonce');
  return {
    name: nameOf(a.name), avatar: avatarOf(a.avatar), groupType, guardianSettings, addPolicy: policyOf(a.addPolicy),
    members, kid: kidOf(a.kid), kc: kcOf(a.kc), nonce: a.nonce,
  };
}

function parseInfoArgs(a: Record<string, unknown>): Record<string, unknown> {
  keysWithin(a, [], ['name', 'avatar', 'groupType', 'guardianSettings', 'addPolicy'], 'info');
  if (Object.keys(a).length === 0) fail('info-empty');
  const out: Record<string, unknown> = {};
  if (a.name !== undefined) out.name = nameOf(a.name);
  if (a.avatar !== undefined) out.avatar = avatarOf(a.avatar);
  if (a.groupType !== undefined) out.groupType = groupTypeOf(a.groupType);
  if (a.guardianSettings !== undefined) out.guardianSettings = a.guardianSettings === null ? null : parseGuardianSettings(a.guardianSettings);
  if (a.addPolicy !== undefined) out.addPolicy = policyOf(a.addPolicy);
  return out;
}

function parseArgs(op: GroupOp, raw: unknown, actor: string): Record<string, unknown> {
  const a = plainObject(raw, 'args');
  switch (op) {
    case 'create':
      return parseCreateArgs(a, actor);
    case 'add': {
      // 再加回曾經在群裡的人要同一筆換金鑰（規則 5）：{kid, kc, kb} 要嘛都有、要嘛都沒有，由狀態決定該不該有
      keysWithin(a, ['pk'], ['kid', 'kc', 'kb'], 'add');
      const n = [a.kid, a.kc, a.kb].filter((x) => x !== undefined).length;
      if (n !== 0 && n !== 3) fail('add-key-incomplete');
      return n === 0 ? { pk: newMemberOf(a.pk) } : { pk: newMemberOf(a.pk), ...newEpochArgs(a) };
    }
    case 'remove':
      exactKeys(a, ['pk', 'kid', 'kc', 'kb'], 'remove');
      return { pk: pkOf(a.pk), ...newEpochArgs(a) };
    case 'rekey':
      exactKeys(a, ['kid', 'kc', 'kb'], 'rekey');
      return newEpochArgs(a);
    case 'role':
      exactKeys(a, ['pk', 'role'], 'role');
      return { pk: pkOf(a.pk), role: roleOf(a.role) };
    case 'info':
      return parseInfoArgs(a);
    case 'leave':
    case 'delete':
      exactKeys(a, [], op);
      return {};
  }
}

/** 照欄位重建一筆 commit；格式不對丟 ChainReject */
export function parseCommit(raw: unknown): Commit {
  const o = plainObject(raw, 'commit');
  exactKeys(o, ['gid', 'v', 'prev', 'op', 'actor', 'args', 'ts'], 'commit');
  const { v, gid, prev, op, actor, ts } = o;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) fail('bad-version');
  if (typeof op !== 'string' || !OPS.includes(op as GroupOp)) fail('bad-op');
  if ((op === 'create') !== (v === 1)) fail('create-must-be-genesis');
  if (v === 1 ? gid !== '' : !validGid(gid)) fail('bad-gid');
  if (v === 1 ? prev !== ZERO_ID : !validCommitId(prev) || prev === ZERO_ID) fail('bad-prev');
  // genesis 的建立者直接進名冊 → 完整檢查；其他 commit 的 actor 一定要是成員（規則），成員的公鑰進名冊時已經完整檢查過
  if (typeof actor !== 'string' || !(op === 'create' ? validPubkey(actor) : wellFormedPubkey(actor))) fail('bad-actor');
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) fail('bad-ts');
  const commit: Commit = { gid: gid as string, v, prev: prev as string, op: op as GroupOp, actor, args: parseArgs(op as GroupOp, o.args, actor), ts };
  if (utf8(canonicalJson(commit)).length > MAX_COMMIT_BYTES) fail('commit-too-large');
  return deepFreeze(commit);
}

// ============================================
// id、簽章
// ============================================

export function commitBody(c: Commit): string {
  return canonicalJson(c);
}

function signingBytes(c: Commit): Uint8Array {
  return utf8(GSTATE_DOMAIN + commitBody(c));
}

export async function commitIdOf(c: Commit): Promise<string> {
  return hex(await sha256(utf8(commitBody(c))));
}

/** 簽一筆 commit：先照欄位檢查（不合格丟 ChainReject），只能簽自己是 actor 的 */
export function signCommit(commit: Commit, sign: SignFn, signerPublicKey: string): SignedCommit {
  const c = parseCommit(commit);
  if (c.actor !== signerPublicKey) fail('signer-not-actor');
  return deepFreeze({ c, s: toB64(sign(signingBytes(c))) });
}

/**
 * 收到的 { c, s }：欄位、大小、actor 的簽章都對才回傳；否則丟 ChainReject。
 * 審查 M2：鏈的有效性不能取決於注入的驗章器（寬鬆的 dalek verify、嚴格的 verify_strict、cofactored 的 ZIP-215 答案不同）。
 * 先在這裡自己擋：S < L、R 是正規編碼且在質數階子群（不是小階點、沒有小階成分）；actor 的公鑰在進名冊時已做同樣的檢查
 * （genesis 的建立者在 parseCommit 檢查；非成員的 actor 不管驗章器怎麼說都會被規則拒收）。這樣每種驗章器的結果都一樣。
 * TODO（跟 AegisTrans 共用）：crypto-core 改用 verify_strict。
 */
export async function toVerifiedCommit(raw: unknown, verify: VerifyFn): Promise<VerifiedCommit> {
  const o = plainObject(raw, 'signed-commit');
  exactKeys(o, ['c', 's'], 'signed-commit');
  const c = parseCommit(o.c);
  if (typeof o.s !== 'string' || !SIG_RE.test(o.s)) fail('bad-signature-format');
  const sig = fromB64(o.s);
  if (!isStrictSignature(sig)) fail('non-strict-signature');
  await checkDerivedKid(c);
  let ok = false;
  try {
    ok = verify(fromB64(c.actor), signingBytes(c), sig);
  } catch {
    ok = false;
  }
  if (!ok) fail('bad-signature');
  return deepFreeze({ c, s: o.s, id: await commitIdOf(c) });
}

const GKID_PREFIX = 'aegistalk-gkid-v1|';

/**
 * 換金鑰 commit（rekey、remove、加回舊成員）的新 kid 由位置與作者決定（審查 L5）：
 *   kid = URL-safe base64(SHA-256("aegistalk-gkid-v1|" + prev + "|" + actor))[:22]
 * 鏈上每個位置的 prev 都不同 → 同一個 kid 不可能出現在兩個位置（過時被跳過的那筆也一樣，重送時 prev 一定不同）；
 * 兩位 admin 在同一個 head 同時換金鑰也是不同的 kid（不會在本機金鑰表撞在一起）。
 * kid 明文寫在 log entry 上，但伺服器不知道 prev（在密文裡），算不出是誰。genesis 的 kid 由建立者自己選（不受這條限制）。
 */
export async function epochKidFor(prev: string, actor: string): Promise<string> {
  return toB64Url(await sha256(utf8(`${GKID_PREFIX}${prev}|${actor}`))).slice(0, 22);
}

/** 非 genesis 的 commit 帶了新 kid，就一定要是 epochKidFor(prev, actor)；不是 → ChainReject('kid-not-derived') */
export async function checkDerivedKid(c: Commit): Promise<void> {
  if (c.v > 1 && c.args.kid !== undefined && c.args.kid !== (await epochKidFor(c.prev, c.actor))) fail('kid-not-derived');
}

/** genesis 的 id → 群組 id：URL-safe base64 的前 22 字（132 bits） */
export function genesisGid(genesisId: string): string {
  return toB64Url(fromHex(genesisId)).slice(0, 22);
}

// ============================================
// 位元組工具（同一套也給 groupControl 用）
// ============================================

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuf(bytes)));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomB64Url(byteLength: number): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

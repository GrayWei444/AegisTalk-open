/**
 * 已接受過的 X3DH_INIT（傳輸統一 X6）。
 *
 * 加好友與自動修復送的 X3DH_INIT 都帶 sessionReset：收端先清 session、outbox 密文、WebRTC 再 accept。
 * 同一封 INIT 再到一次（發送端 MQTT 離線佇列重送、broker QoS1 重投、App 被殺後重播）就會把剛建好的
 * session 拆掉重建 → 對方下一則 aead → 又一輪修復。以前只靠 useCrypto 記憶體裡的 ephemeral 去重，
 * 而且 clearPeerSession 會先把那份紀錄清掉，判斷在清除之後才跑。
 *
 * 現在：清除之前先查「這把 ephemeral 是否已接受過」，紀錄存 localStorage、跨重啟有效。
 * 保存 48h：INIT 的新鮮度與 broker session 都是 24h，更舊的重播會被 validateMessage 擋掉。
 * 記錄綁帳號（同一台換帳號不互通）。ephemeral 是公鑰，不是秘密。
 *
 * Newest accepted INIT per friend (security review M1): the 48 h list above expires, and the INIT's signed iat is judged
 * on a clock the operator can move (the token response's server time). So every accepted INIT also leaves a persisted,
 * never-expiring mark "newest iat accepted from this friend" (per account, like the direct_sealed marks); an INIT
 * older than the mark is refused before anything happens (no rename, no bundle update, no session reset). A genuine
 * friend's later INIT is always newer (iat is his server-corrected send time); the exact same INIT again (iat equal to the
 * mark) goes on to the duplicate check above.
 */
const KEY = 'aegis_x3dh_accepted_v1';
export const INIT_IAT_KEY = 'aegis_x3dh_init_iat_v1';
const TTL_MS = 48 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_IAT_MARKS = 2000;
type Entry = { owner: string; peer: string; eph: string; at: number };

function read(): Entry[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const now = Date.now();
    return Array.isArray(list)
      ? list.filter((e: Entry) => e && typeof e.owner === 'string' && typeof e.peer === 'string'
        && typeof e.eph === 'string' && typeof e.at === 'number' && now - e.at < TTL_MS)
      : [];
  } catch { return []; }
}

export function wasInitAccepted(owner: string, peer: string, eph: unknown): boolean {
  if (!owner || !peer || typeof eph !== 'string' || !eph) return false;
  return read().some((e) => e.owner === owner && e.peer === peer && e.eph === eph);
}

/** iat must be a safe integer (verifyInitAuth checked it for an existing friend's INIT) */
const validIat = (iat: unknown): iat is number => typeof iat === 'number' && Number.isSafeInteger(iat);

/** in-memory copy: without storage the marks still hold for this page */
let iatMem: Record<string, number> | null = null;

function readIatMarks(): Record<string, number> {
  const out: Record<string, number> = { ...(iatMem ?? {}) };
  try {
    const raw = JSON.parse(localStorage.getItem(INIT_IAT_KEY) ?? '{}') as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (validIat(v) && !(out[k] >= v)) out[k] = v;
      }
    }
  } catch { /* unreadable: the in-memory copy still holds */ }
  return out;
}

const iatKey = (owner: string, peer: string): string => `${owner}|${peer}`;

/** true = an INIT from this friend with a newer iat was already accepted on this account: refuse this one */
export function isInitOlderThanAccepted(owner: string, peer: string, iat: unknown): boolean {
  if (!owner || !peer || !validIat(iat)) return false;
  const newest = readIatMarks()[iatKey(owner, peer)];
  return newest !== undefined && iat < newest;
}

function rememberInitIat(owner: string, peer: string, iat: unknown): void {
  if (!validIat(iat)) return;
  const marks = readIatMarks();
  const k = iatKey(owner, peer);
  if (marks[k] !== undefined && marks[k] >= iat) return;
  const next = { ...marks, [k]: iat };
  const keys = Object.keys(next);
  const kept = keys.length > MAX_IAT_MARKS
    ? Object.fromEntries(keys.sort((a, b) => next[b] - next[a]).slice(0, MAX_IAT_MARKS).map((x) => [x, next[x]]))
    : next;
  iatMem = kept;
  try { localStorage.setItem(INIT_IAT_KEY, JSON.stringify(kept)); } catch { /* no storage: the in-memory copy holds for this page */ }
}

/** after accepting an INIT: its ephemeral (48 h duplicate check) and, with iat, the friend's newest-INIT mark */
export function rememberAcceptedInit(owner: string, peer: string, eph: unknown, iat?: unknown): void {
  if (!owner || !peer || typeof eph !== 'string' || !eph) return;
  rememberInitIat(owner, peer, iat);
  const rest = read().filter((e) => !(e.owner === owner && e.peer === peer && e.eph === eph));
  try { localStorage.setItem(KEY, JSON.stringify([...rest, { owner, peer, eph, at: Date.now() }].slice(-MAX_ENTRIES))); }
  catch { /* 無 storage：退回只靠 useCrypto 的記憶體去重 */ }
}

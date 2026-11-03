/**
 * DataChannel 大訊息分塊（傳輸統一 X5）
 *
 * Chromium 的 SCTP 單則上限約 256KB，超過時 RTCDataChannel.send() 直接 throw。
 * 1 對 1 語音（base64 音訊包在 ratchet 密文裡，JSON 數字陣列約 3.6 倍）約 7 秒就超過，
 * 進 outbox 後 flush 每次都停在那筆 → 該好友之後的訊息全部卡住 30 天。
 *
 * 格式：沒超過上限的字串原樣送（舊版對端照常收；上限＝舊版直接 send 送得出去的大小，見 webrtc.ts）；超過的切成
 *   "\u0001P|<id>|<seq>|<count>|<片段>"
 * 開頭是控制字元，不可能是 JSON：舊版對端解析失敗就忽略（這種大小以前本來就送不到）。
 * DataChannel 是 ordered + reliable，片段依序到達；收端仍容許交錯，並限制記憶體用量。
 */

/** 單則訊息（重組後）上限：60 秒語音約 2.3M 字元 */
export const DC_MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

const PART_PREFIX = '\u0001P|';
const MAX_PARTS = 1024;
const MAX_ASSEMBLIES = 4;          // 每個 peer 同時重組中的訊息數
const ASSEMBLY_TTL_MS = 60_000;    // 對方送到一半斷線：60 秒後丟掉殘片

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (isHighSurrogate(c)) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * 回傳要依序送出的幀；沒超過 singleMaxBytes（預設＝maxBytes）就是 [data] 原樣，否則切成每片不超過 maxBytes。
 * 超過 DC_MAX_MESSAGE_CHARS 回 null（永遠送不出去）。
 */
export function splitFrame(data: string, maxBytes: number, singleMaxBytes = maxBytes): string[] | null {
  if (data.length > DC_MAX_MESSAGE_CHARS) return null;
  if (data.length * 3 <= singleMaxBytes || utf8Length(data) <= singleMaxBytes) return [data];
  // 每個字元最多 3 bytes（surrogate pair 是 2 個字元 4 bytes）→ 片段一定塞得進 maxBytes
  const partChars = Math.max(1024, Math.floor((maxBytes - 64) / 3));
  const bodies: string[] = [];
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + partChars, data.length);
    // 不把 emoji 切成兩半：半個 surrogate 經 UTF-8 編碼會變成 U+FFFD，重組後內容就壞了
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end--;
    bodies.push(data.slice(i, end));
    i = end;
  }
  if (bodies.length > MAX_PARTS) return null;
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return bodies.map((body, seq) => `${PART_PREFIX}${id}|${seq}|${bodies.length}|${body}`);
}

type Assembly = { count: number; parts: (string | undefined)[]; received: number; chars: number; startedAt: number };

/** 每個 peer 一個 */
export class FrameAssembler {
  private assemblies = new Map<string, Assembly>();
  private total = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.assemblies.size; }
  get bufferedChars(): number { return this.total; }

  /**
   * undefined = 不是分塊幀（照原樣處理）；null = 片段已收下或無效（先不往上送）；string = 重組好的整則訊息
   */
  push(frame: string): string | null | undefined {
    if (!frame.startsWith(PART_PREFIX)) return undefined;
    this.expire();
    const h1 = frame.indexOf('|', PART_PREFIX.length);
    const h2 = h1 < 0 ? -1 : frame.indexOf('|', h1 + 1);
    const h3 = h2 < 0 ? -1 : frame.indexOf('|', h2 + 1);
    if (h3 < 0) return null;
    const id = frame.slice(PART_PREFIX.length, h1);
    const seq = Number(frame.slice(h1 + 1, h2));
    const count = Number(frame.slice(h2 + 1, h3));
    const body = frame.slice(h3 + 1);
    if (!id || id.length > 64 || !Number.isInteger(seq) || !Number.isInteger(count)
      || count < 1 || count > MAX_PARTS || seq < 0 || seq >= count) return null;

    let a = this.assemblies.get(id);
    if (!a) {
      if (this.assemblies.size >= MAX_ASSEMBLIES) this.drop(this.assemblies.keys().next().value as string);
      a = { count, parts: new Array<string | undefined>(count), received: 0, chars: 0, startedAt: this.now() };
      this.assemblies.set(id, a);
    }
    if (a.count !== count) { this.drop(id); return null; }
    if (a.parts[seq] !== undefined) return null;
    if (this.total + body.length > DC_MAX_MESSAGE_CHARS) { this.drop(id); return null; }
    a.parts[seq] = body;
    a.received++;
    a.chars += body.length;
    this.total += body.length;
    if (a.received < a.count) return null;
    this.drop(id);
    return a.parts.join('');
  }

  private drop(id: string): void {
    const a = this.assemblies.get(id);
    if (!a) return;
    this.total -= a.chars;
    this.assemblies.delete(id);
  }

  private expire(): void {
    const cutoff = this.now() - ASSEMBLY_TTL_MS;
    for (const [id, a] of this.assemblies) if (a.startedAt < cutoff) this.drop(id);
  }
}

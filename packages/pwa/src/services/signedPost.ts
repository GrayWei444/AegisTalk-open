/**
 * 帳戶簽章的 POST，時間用校正到伺服器的時鐘簽；伺服器說時鐘差太多（401 {code: clock_skew, server_time}）→ 用它的時間校正、
 * 換一個 request_id 重簽一次（開源第 4 步：推播與信任分數以前用本機時鐘簽、沒有重試 —— 手機時鐘差 5 分鐘以上就永遠推不出去，
 * W5 P2／sim run 1 看到的）。token、群組 log、短碼早就這樣做（mqtt._requestGrant、groupLogClient、shortcodeRequest）。
 * build(nowMs) 每次都重建整份 body（新的 request_id、新的時間戳），只重試一次。
 */

export interface SignedClock {
  /** 校正到伺服器的現在（毫秒） */
  now(): number;
  /** 伺服器說它現在幾秒（clock_skew 的 server_time）：拿來校正 */
  adopt(serverTimeSec: number): void;
}

/** 401 回應裡的 server_time（不是 clock_skew → null） */
export async function clockSkewServerTime(res: { status: number; clone?: () => { json(): Promise<unknown> }; json(): Promise<unknown> }): Promise<number | null> {
  if (res.status !== 401) return null;
  try {
    const body = (await (res.clone ? res.clone().json() : res.json())) as { detail?: { code?: unknown; server_time?: unknown } } | null;
    const d = body?.detail;
    return d && d.code === 'clock_skew' && typeof d.server_time === 'number' && Number.isFinite(d.server_time) ? d.server_time : null;
  } catch {
    return null;
  }
}

export async function postSigned(
  url: string,
  build: (nowMs: number) => Record<string, unknown>,
  clock: SignedClock,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const send = (body: Record<string, unknown>) => fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const first = await send(build(clock.now()));
  const serverTime = await clockSkewServerTime(first);
  if (serverTime === null) return first;
  clock.adopt(serverTime);
  return send(build(clock.now()));
}

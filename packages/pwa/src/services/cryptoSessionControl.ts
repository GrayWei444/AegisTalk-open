/**
 * cryptoSessionControl — 讓非 hook 的 store/service 能清掉 useCrypto 內的
 * in-memory session ref + durable `mist_sessions` entry。
 *
 * 真因（2026-06-28 換機/重加好友 aead 死罪）：removeFriend 只刪了 legacy ratchet_states，
 * 沒清 useCrypto 的 sessionsRef / mist_sessions。重加好友時 createSession 的 idempotency guard
 * 找到舊 session → 保留舊 ratchet 卻仍送出新 ephemeral 進 X3DH_INIT → 收端用新
 * ephemeral 重建 responder ratchet，發起端卻停在舊 ratchet → 兩邊對不上 → aead::Error 永遠失敗。
 * 清掉 active session 後，重加時 createSession 走 fresh path，ephemeral 與 ratchet 才一致。
 */
type ClearPeerSessionFn = (peerPubkeyBase64: string) => void | Promise<void>;

/**
 * ⚠️ 是 **Set 不是單一函式**：`useCrypto()` 是普通 hook（非 context），全 app 有 8 個呼叫點，
 * 每個 instance 各自持有 `sessionsRef`。舊版只存最後註冊的那一個 → 只清得掉一個 instance 的
 * in-memory 快取；其餘 instance 仍握著已被作廢的 session。
 * 而 `encrypt` 在「DB 重載成功但查無此 peer」時會**回退用 in-memory 那份**（useCrypto.ts:590-603）
 * → 「已清掉的 session」照樣被拿去加密，clear 等於沒清。
 * （useCrypto.ts:376 的 `forceFresh` 註解「也防 clearPeerSession 清錯 instance」講的就是這件事，
 *   那裡是繞過去，這裡是治本。）
 * 2026-08-26 E2E 實錄：seam 清掉 Bob 的 session 並記錄成功，下一則訊息仍正常加密直送、對方解得開。
 */
const _clearPeerSessionFns = new Set<ClearPeerSessionFn>();

/** useCrypto 掛載時註冊它的 per-peer session 清除函式；回傳 unregister（unmount 時呼叫） */
export function registerClearPeerSession(fn: ClearPeerSessionFn): () => void {
  _clearPeerSessionFns.add(fn);
  return () => { _clearPeerSessionFns.delete(fn); };
}

/**
 * store/service 端呼叫：清掉某 peer 的 in-memory + durable session（移除/重建好友時用）。
 * **每一個掛載中的 useCrypto instance 都要清**，否則沒清到的那個會用 stale session 加密。
 */
export async function clearPeerSession(peerPubkeyBase64: string): Promise<void> {
  if (_clearPeerSessionFns.size === 0) {
    throw new Error('clearPeerSession called before useCrypto registered session control');
  }
  // 序列執行：每個 instance 的清除都會 read-modify-write 同一份 durable blob，不可並行
  for (const fn of [..._clearPeerSessionFns]) {
    await fn(peerPubkeyBase64);
  }
}


// E2E seam（同 __simulateDcDeath 慣例）：讓測試能製造「無 session」狀態驗證
// plaintext-pending outbox（不是新能力 —— removeFriend 等 UI 動作本就可達同效果）。
if (typeof window !== 'undefined') {
  (window as unknown as { __aegisClearPeerSession?: (pk: string) => Promise<void> }).__aegisClearPeerSession =
    (pk: string) => clearPeerSession(pk);
}

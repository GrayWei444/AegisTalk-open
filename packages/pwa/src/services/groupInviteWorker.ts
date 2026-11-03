/**
 * Web Worker：驗邀請的整條狀態鏈（groupState.verifyInvite —— 每筆 commit 的嚴格 Ed25519 檢查約 1.5 ms，
 * 500 筆的鏈在 VPS 的 Node 上約 0.8 秒，手機更慢），不卡畫面。簽章用跟主執行緒同一份 WASM（IdentityKeyPair.verifySignature）。
 * 只做純計算：收 { id, chain, gid, me, kid, key }，回 { id, result } 或 { id, error }。用法見 groupInviteVerify.ts。
 */
import init, { IdentityKeyPair } from '../wasm/pkg/safetalk_core';
import { verifyInvite } from './groupState';

interface Request {
  id: number;
  chain: unknown[];
  gid: string;
  me: string;
  kid: string;
  key: Uint8Array;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
  postMessage: (msg: unknown) => void;
};

const ready = init().then(() => undefined);
const verify = (publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean =>
  IdentityKeyPair.verifySignature(publicKey, data, signature);

scope.onmessage = (ev) => {
  const { id, chain, gid, me, kid, key } = ev.data;
  ready
    .then(() => verifyInvite({ chain, gid, me, key: { kid, key }, verify }))
    .then((result) => scope.postMessage({ id, result }))
    .catch((e: unknown) => scope.postMessage({ id, error: String((e as Error)?.message ?? e) }));
};

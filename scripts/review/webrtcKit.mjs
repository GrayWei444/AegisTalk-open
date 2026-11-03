/**
 * 測 webrtc.ts 用的共用工具（開源第 4 步起 DataChannel 的信令是 DIRECT_SEALED kind 'dc'：directSignal 驗過寄件人的簽章、
 * 新鮮度、重放才交給 webrtc）。不是測試本身（檔名不是 *_self_test）。
 *   webrtcStub()             esbuild plugin：stub 掉 devLog／diagLog／iceServers，directSignal 換成記錄器 ——
 *                            onDirect 的 handler 存在 globalThis.__dcHandler，sendDirect 送的記在 globalThis.__dcSent
 *   dcBody(sig, data, opts)  一則驗過的 kind 'dc' 內容（directSignal 交給 webrtc 的樣子）
 *   deliverDc(svc, from, b)  交給 webrtc 對應的 handler 並等它做完（handleDirect 是 fire-and-forget，測試要等）
 *   sentDc()                 webrtc 送出去的 kind 'dc'：[{ to, sig, pc, rpc, data, groupProof, transient }]
 */
export function webrtcStub() {
  globalThis.__dcSent = [];
  return { name: 'webrtc-stub', setup(b) {
    b.onResolve({ filter: /utils\/devLog$|utils\/diagLog$|\.\/directSignal$|\.\/iceServers$/ }, (a) => ({ path: a.path, namespace: 'wk' }));
    b.onLoad({ filter: /.*/, namespace: 'wk' }, (a) => ({ loader: 'js', contents:
      a.path.includes('devLog') ? 'export const devLog=()=>{};export const devWarn=()=>{};'
      : a.path.includes('diagLog') ? 'export const diagLog=()=>{};'
      : a.path.includes('directSignal') ? `export const onDirect=(kind,f)=>{ if (kind === 'dc') globalThis.__dcHandler=f; return ()=>{}; };
          export const sendDirect=async(to,body,opts)=>{ globalThis.__dcSent.push({ to, ...body, transient: !!opts?.transient }); return true; };`
      : 'export function getIceServers(){return []}' }));
  } };
}

let nonceSeq = 0;
export function dcBody(sig, data, { pc = 'pc-remote-1', rpc, iat = Date.now(), groupProof } = {}) {
  return { kind: 'dc', sig, pc, ...(rpc ? { rpc } : {}), data, iat, nonce: `nonce-${++nonceSeq}-xxxxxxxxxxxx`,
    ...(groupProof !== undefined ? { groupProof } : {}) };
}

export async function deliverDc(svc, parse, from, body) {
  const msg = parse(from, body);
  if (!msg) return 'malformed';
  if (msg.sig === 'offer') return svc.handleOffer(msg);
  if (msg.sig === 'answer') return svc.handleAnswer(msg);
  if (msg.sig === 'ice') return svc.handleIceCandidate(msg);
  return svc.handleFingerprint(msg);
}

export const sentDc = () => globalThis.__dcSent;

/*
 * 每個模擬手機的頁面在 App 任何程式之前先跑這段（Playwright addInitScript）。
 *  1. 測試旗標：AEGIS_E2E_TEST（App 自己的 E2E 開關：印 [DIAG] log、開 window.__aegisE2E 讀 SQLite、
 *     跳過單一裝置綁定與 Whisper 下載）、介面語言 en、開場動畫看過了。
 *  2. WebRTC 不用任何 STUN/TURN（App 預設會打它內建的 STUN/TURN 伺服器）—— 同一台 Mac 上用 host candidate 直連。
 *  3. DataChannel 追蹤：每個送出／收到的 JSON 幀印一行 [SIM:DC]（群組訊息印 messageId/groupId/keyId），
 *     失敗時能指出訊息停在哪一段。心跳不印。
 */
(() => {
  try {
    if (!localStorage.getItem('AEGIS_E2E_TEST')) localStorage.setItem('AEGIS_E2E_TEST', 'true');
    if (!localStorage.getItem('aegistalk_language')) localStorage.setItem('aegistalk_language', 'en');
    localStorage.setItem('astra_intro_seen_v1', '1');
  } catch (e) { /* storage blocked */ }

  const Orig = window.RTCPeerConnection;
  if (!Orig || Orig.__sim) return;

  const short = (s, n = 10) => (typeof s === 'string' ? s.slice(0, n) : String(s));
  function summarize(data) {
    if (typeof data !== 'string') return 'binary ' + (data.byteLength ?? data.size ?? '?') + 'B';
    if (data.length < 40 && data.includes('__dc_hb')) return null;
    let m;
    try { m = JSON.parse(data); } catch { return 'text ' + data.length + 'B'; }
    if (!m || typeof m !== 'object') return 'json';
    if (m.type === '__dc_hb') return null;
    if (m.np !== undefined) return null;
    if (m.type === 'group_key_message' && m.payload) {
      const p = m.payload; const e = p.encrypted || {};
      return `group_key_message msg=${p.messageId} group=${p.groupId} sender=${short(p.senderId)} key=${short(e.keyId, 12)}${e.legacyKeyId ? ' legacy=' + short(e.legacyKeyId, 12) : ''}`;
    }
    if (m.type === 'encrypted_message') return 'encrypted_message ' + data.length + 'B';
    return 'type=' + (m.type ?? Object.keys(m).slice(0, 3).join(',')) + ' ' + data.length + 'B';
  }
  const log = (dir, ch, data) => {
    try {
      const s = summarize(data);
      if (s) console.error(`[SIM:DC:${dir}] ch=${ch.label} ${s}`);
    } catch (e) { /* */ }
  };
  const hook = (ch) => {
    if (!ch || ch.__simHooked) return;
    ch.__simHooked = true;
    ch.addEventListener('message', (ev) => log('RECV', ch, ev.data));
  };

  const origSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    log('SEND', this, data);
    return origSend.call(this, data);
  };
  const origCreate = Orig.prototype.createDataChannel;
  Orig.prototype.createDataChannel = function (...args) {
    const ch = origCreate.apply(this, args);
    hook(ch);
    return ch;
  };
  const origSetConf = Orig.prototype.setConfiguration;
  if (origSetConf) {
    Orig.prototype.setConfiguration = function (c) {
      return origSetConf.call(this, Object.assign({}, c || {}, { iceServers: [] }));
    };
  }
  function Patched(cfg, ...rest) {
    const pc = new Orig(Object.assign({}, cfg || {}, { iceServers: [] }), ...rest);
    pc.addEventListener('datachannel', (ev) => hook(ev.channel));
    return pc;
  }
  Patched.prototype = Orig.prototype;
  Patched.__sim = true;
  if (Orig.generateCertificate) Patched.generateCertificate = Orig.generateCertificate.bind(Orig);
  window.RTCPeerConnection = Patched;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
})();

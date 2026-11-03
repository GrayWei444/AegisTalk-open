/**
 * W5 攻擊者的工具（docs/GROUP_LOG_WIRING_W5.md）：第五個角色 Mallory（自己的帳號金鑰、拿真的 token／簽章）與「被踢的 Bob 的影子連線」，
 * 都是純 Node 的用戶端 —— 不開瀏覽器，直接接在模擬 broker 上（同一個行程），API 直接呼叫模擬 API（mockApi.handle，who ＝ 自己的 label）。
 *
 *   loadServices({ pwaSrc, resolveModule, workDir })   用 esbuild 打包 App 真的純模組（identitySeal、groupState、groupLog、groupControl、
 *                                                       presenceSecret）給攻擊者用：它做得出跟 App 一模一樣格式的信封、commit、log entry
 *   newIdentity()                                       Ed25519 身分（Node crypto）；verify、x25519 同 scripts/review/groupStateKit
 *   MqttLink                                            MQTT 5 用戶端（mqtt-packet；CONNECT／SUBSCRIBE／PUBLISH／PUBACK），收到的都記在 received
 *   Actor                                               一個攻擊者：簽 token 請求、連線、發、訂、append 群組 log、封身分信封
 * 只在模擬裡用；不碰正式服務。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 攻擊者的 label：Mallory（含它的探測）、營運方、被踢的人的影子連線（run.mjs 與測試共用一份） */
export const isAdversary = (label) => typeof label === 'string' && (/^Mallory/.test(label) || label === 'operator' || /~shadow$/.test(label));

export const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const canonicalJson = (v) => (Array.isArray(v) ? v.map(canonicalJson) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalJson(v[k])])) : v);
export const canonical = (v) => JSON.stringify(canonicalJson(v));

/** 一把新的 Ed25519 身分（seed 可以給：同一個 seed 每次同一把） */
export function newIdentity(seed = crypto.randomBytes(32)) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = new Uint8Array(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { pk: Buffer.from(pub).toString('base64'), pub, seed: new Uint8Array(seed), sign: (data) => new Uint8Array(crypto.sign(null, Buffer.from(data), priv)) };
}

export function verify(pub, data, sig) {
  try {
    return crypto.verify(null, Buffer.from(data), crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));
  } catch {
    return false;
  }
}

export const x25519 = {
  generateX25519() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    return {
      privateKey: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
      publicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    };
  },
  x25519: (priv, pub) => new Uint8Array(crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(priv)]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }),
  })),
};

/** App 真的純模組（esbuild 打包一次）：S identitySeal、G groupState、L groupLog、CTL groupControl、P presenceSecret、D directSeal（開源第 4 步）、
 *  RT ringToken（第 5d 步：來電者簽的響鈴 token） */
export async function loadServices({ pwaSrc, resolveModule, workDir }) {
  const { build } = resolveModule('esbuild');
  fs.mkdirSync(workDir, { recursive: true });
  const out = path.join(workDir, 'adversary-services.mjs');
  await build({
    stdin: {
      contents: `export * as S from './identitySeal'; export * as G from './groupState'; export * as L from './groupLog';
        export * as CTL from './groupControl'; export * as P from './presenceSecret'; export * as D from './directSeal';
        export * as RT from './ringToken';`,
      resolveDir: path.join(pwaSrc, 'services'), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', define: { 'import.meta.env': '{}' },
  });
  return import(pathToFileURL(out).href);
}

/**
 * 接在模擬 broker 上的 MQTT 5 用戶端（同一個行程：broker.attach 的 conn 介面）。只做攻擊者用得到的：連線、訂閱、發布、收。
 * 每個動作等 broker 的回覆（CONNACK／SUBACK／PUBACK），回傳原因碼。
 */
export class MqttLink {
  constructor({ broker, mqttPacket, label }) {
    this.broker = broker;
    this.mqttPacket = mqttPacket;
    this.label = label;
    this.received = [];
    this.waiters = new Map();
    this.pid = 0;
    this.closed = false;
    this.onMessage = null;
  }
  /**
   * 兩個方向都非同步（setImmediate，順序不變）：同步呼叫的話，broker 在處理我送的封包時又同步送封包給我 ——
   * mqtt-packet 的 parser 被重入，會把同一個封包重複吐好幾百次（真的 WebSocket 本來就是非同步的）
   */
  _send(packet) {
    if (this.closed) return;
    const buf = this.mqttPacket.generate(packet, { protocolVersion: 5 });
    setImmediate(() => this.toBroker?.(buf));
  }
  _wait(key, ms = 5_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(key); resolve(null); }, ms);
      this.waiters.set(key, (v) => { clearTimeout(timer); resolve(v); });
    });
  }
  _resolve(key, v) { const w = this.waiters.get(key); if (w) { this.waiters.delete(key); w(v); } }
  /** clean：不要持久 session（預設）；sessionExpiry：秒 */
  connect({ clientId, username, token, clean = true, sessionExpiry = 0 }) {
    const parser = this.mqttPacket.parser({ protocolVersion: 5 });
    parser.on('packet', (p) => this._onPacket(p));
    parser.on('error', () => {});
    const link = this;
    this.closed = false;
    this.broker.attach({
      label: this.label,
      send: (buf) => { const b = Buffer.from(buf); setImmediate(() => parser.parse(b)); },
      close: () => { link.closed = true; link.onClose?.(); },
      onData: (cb) => { link.toBroker = cb; },
      onClose: (cb) => { link.onClose = cb; },
    });
    const ack = this._wait('connack');
    this._send({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clean, clientId, keepalive: 0, username, password: Buffer.from(token ?? ''),
      properties: sessionExpiry ? { sessionExpiryInterval: sessionExpiry } : {} });
    return ack.then((p) => (p ? p.reasonCode ?? 0 : -1));
  }
  _onPacket(p) {
    if (p.cmd === 'connack') this._resolve('connack', p);
    else if (p.cmd === 'suback') this._resolve(`sub:${p.messageId}`, p.granted ?? p.reasonCode);
    else if (p.cmd === 'puback') this._resolve(`pub:${p.messageId}`, p.reasonCode ?? 0);
    else if (p.cmd === 'unsuback') this._resolve(`unsub:${p.messageId}`, true);
    else if (p.cmd === 'publish') {
      const rec = { at: Date.now(), topic: p.topic, payload: Buffer.from(p.payload ?? ''), retain: !!p.retain, qos: p.qos };
      this.received.push(rec);
      if (p.qos === 1) this._send({ cmd: 'puback', messageId: p.messageId, reasonCode: 0 });
      try { this.onMessage?.(rec); } catch { /* 呼叫端的事 */ }
    } else if (p.cmd === 'disconnect') {
      this.closed = true;
    }
  }
  /** 回傳每個 filter 的 SUBACK 原因碼（0／1 ＝ 准了，0x87 ＝ 拒絕） */
  async subscribe(topics, qos = 1) {
    const messageId = (this.pid = (this.pid % 65535) + 1);
    const ack = this._wait(`sub:${messageId}`);
    this._send({ cmd: 'subscribe', messageId, subscriptions: [].concat(topics).map((topic) => ({ topic, qos })) });
    return (await ack) ?? [];
  }
  async unsubscribe(topics) {
    const messageId = (this.pid = (this.pid % 65535) + 1);
    const ack = this._wait(`unsub:${messageId}`);
    this._send({ cmd: 'unsubscribe', messageId, unsubscriptions: [].concat(topics) });
    return ack;
  }
  /** QoS1 回 PUBACK 原因碼（0 ＝ 收了，0x87 ＝ ACL 拒絕）；QoS0 回 undefined */
  async publish(topic, payload, { qos = 1, retain = false } = {}) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    if (qos === 0) { this._send({ cmd: 'publish', topic, payload: buf, qos: 0, retain }); await sleep(5); return undefined; }
    const messageId = (this.pid = (this.pid % 65535) + 1);
    const ack = this._wait(`pub:${messageId}`);
    this._send({ cmd: 'publish', topic, payload: buf, qos: 1, retain, messageId });
    return ack;
  }
  disconnect() {
    this._send({ cmd: 'disconnect', reasonCode: 0 });
    this.closed = true;
  }
  receivedOn(topic, since = 0) { return this.received.filter((r) => r.topic === topic && r.at >= since); }
}

/**
 * 一個攻擊者：身分（自己的，或借別人的簽章 —— 被踢的 Bob 的影子連線用 Bob 自己 App 的身分簽）、模擬 API、broker。
 *   sign(bytes)：同步或 async 都可以（Bob 的影子經 page.evaluate 簽）
 */
export class Actor {
  constructor({ label, pk, sign, mockApi, broker, mqttPacket, services, clock = () => Date.now(), clientSuffix = 'evil0001' }) {
    this.label = label;
    this.pk = pk;
    this.user = toUrl(pk);
    this.sign = sign;
    this.mockApi = mockApi;
    this.broker = broker;
    this.mqttPacket = mqttPacket;
    this.svc = services;
    this.clock = clock;
    this.clientId = `mist_${this.user.slice(0, 16)}_${clientSuffix}`;
    this.links = [];
    this.tokenResults = [];
  }
  async _sig(bytes) { return Buffer.from(await this.sign(bytes)).toString('base64'); }
  /** POST /api/mqtt/token（簽章照 App：排序 JSON）；over 蓋掉／多加欄位（萬用字元、peers…）。回傳 { status, body } */
  async requestToken(over = {}) {
    const fields = { action: 'mqtt_token', pubkey: this.pk, client_id: this.clientId, groups: [], presence: [],
      timestamp: Math.floor(this.clock() / 1000), request_id: crypto.randomBytes(16).toString('hex'), ...over };
    const signature = await this._sig(Buffer.from(canonical(fields)));
    const res = this.mockApi.handle('POST', '/api/mqtt/token', JSON.stringify({ ...fields, signature }), '', this.label);
    const out = { status: res?.status ?? 0, body: res?.body ? JSON.parse(res.body) : null };
    this.tokenResults.push({ over: Object.keys(over), status: out.status });
    return out;
  }
  /** 拿一張 token（只有 groups／presence／presence_tag）、連線；回傳 { link, connack, token } */
  async connect({ groups = [], presence = [], presence_tag } = {}) {
    const tok = await this.requestToken({ groups, presence, ...(presence_tag ? { presence_tag } : {}) });
    if (tok.status !== 200) return { link: null, connack: -1, token: tok };
    const link = new MqttLink({ broker: this.broker, mqttPacket: this.mqttPacket, label: this.label });
    const connack = await link.connect({ clientId: this.clientId, username: this.user, token: tok.body.token });
    this.links.push(link);
    return { link, connack, token: tok };
  }
  /** POST /api/account/register（keys-only 帳號，api/chat/accounts.py；簽章照伺服器：排序 JSON）。回傳 { status, body } */
  async registerAccount(inviteCode) {
    const fields = { action: 'account_register', pubkey: this.pk, timestamp: Math.floor(this.clock() / 1000),
      request_id: crypto.randomBytes(16).toString('hex'), ...(inviteCode ? { invite_code: inviteCode } : {}) };
    const signature = await this._sig(Buffer.from(canonical(fields)));
    const res = this.mockApi.handle('POST', '/api/account/register', JSON.stringify({ ...fields, signature }), '', this.label);
    return { status: res?.status ?? 0, body: res?.body ? JSON.parse(res.body) : null };
  }
  /** POST /api/group-log/{gid}（帳號簽章照 groupLogClient）；回傳 { status, body } */
  async appendLog(gid, blob) {
    const timestamp = Math.floor(this.clock() / 1000);
    const request_id = crypto.randomBytes(16).toString('hex');
    const signed = { action: 'group_log_append', pubkey: this.pk, gid, blob_sha256: crypto.createHash('sha256').update(Buffer.from(blob, 'utf8')).digest('hex'), timestamp, request_id };
    const signature = await this._sig(Buffer.from(canonical(signed)));
    const res = await this.mockApi.handle('POST', `/api/group-log/${encodeURIComponent(gid)}`, JSON.stringify({ blob, pubkey: this.pk, timestamp, request_id, signature }), '', this.label);
    return { status: res?.status ?? 0, body: res?.body ? JSON.parse(res.body) : null };
  }
  /** GET /api/group-log/{gid}?after=（不用登入：任何知道 gid 的人都能讀） */
  async fetchLog(gid, after = 0) {
    const res = await this.mockApi.handle('GET', `/api/group-log/${encodeURIComponent(gid)}`, '', `?after=${after}&limit=200`, this.label);
    return res?.status === 200 ? JSON.parse(res.body) : { entries: [], head: 0, more: false };
  }
  /** 封一封身分信封（GROUP_KEY_SEALED 的 payload）給 to；簽的是這個攻擊者自己的身分 */
  async seal(to, body, { iat } = {}) {
    const { S } = this.svc;
    const kindLimits = S.GROUP_SEALED_KIND_LIMITS;
    // sign 可能是 async（Bob 的影子）：identitySeal 要同步的 → 先拿到要簽的內容再簽一次不可行，所以影子只用同步的簽章（見 run 的 shadow）
    return S.sealToIdentity({ from: this.pk, to, body, sign: this.sign, kindLimits, now: iat ?? this.clock() }, x25519);
  }
  /**
   * 封一則 DIRECT_SEALED 給 to（開源第 4 步）：簽的是這個攻擊者自己的身分 —— 寫成 from＝別人的話收端驗不過
   */
  async sealDirect(to, body, { iat } = {}) {
    const { D } = this.svc;
    return D.sealDirect({ from: this.pk, to, body, sign: this.sign, now: iat ?? this.clock(), scheme: D.AEGISTALK_DIRECT }, x25519);
  }
  /**
   * 響鈴 token（開源第 5d 步，App 真的 ringToken.signRingToken）：簽的是這個攻擊者自己的身分 —— claims 寫成 from＝別人就是偽造的
   */
  ringToken(to, { from = this.pk, callId = crypto.randomBytes(16).toString('base64url'), video = false, iat = this.clock() } = {}) {
    const { RT } = this.svc;
    return RT.signRingToken({ prefix: RT.AEGISTALK_RING_PREFIX, callId, from, to, video, now: iat, sign: this.sign });
  }
  /** POST /api/push/notify（帳戶簽章照 App 的 pushRequest）；回傳 { status, body } */
  async pushNotify(recipient, hint) {
    const fields = { action: 'push_notify', pubkey: this.pk, recipient_pubkey: recipient, notificationHint: hint,
      timestamp: Math.floor(this.clock() / 1000), request_id: crypto.randomBytes(16).toString('hex') };
    const signature = await this._sig(Buffer.from(canonical(fields)));
    const res = await this.mockApi.handle('POST', '/api/push/notify', JSON.stringify({ ...fields, signature }), '', this.label);
    return { status: res?.status ?? 0, body: res?.body ? JSON.parse(res.body) : null };
  }
  /** 一則 MQTT 訊息（App 的外層格式）：{ type, from, to?, payload, timestamp } */
  message(type, payload, { from = this.pk, to, timestamp = this.clock() } = {}) {
    return JSON.stringify({ type, from, ...(to ? { to } : {}), payload, timestamp });
  }
  inboxTopic(recipientPk, senderPk = this.pk) { return `mist/user/${toUrl(recipientPk)}/inbox/${toUrl(senderPk)}`; }
  groupTopic(tid, senderPk = this.pk) { return `mist/group/${tid}/${toUrl(senderPk)}`; }
  close() { for (const l of this.links) { try { l.disconnect(); } catch { /* */ } } }
}

/** 隨機的 22 字元主題 id（猜的 tid／tag） */
export const randomTid = () => crypto.randomBytes(16).toString('base64url').slice(0, 22);

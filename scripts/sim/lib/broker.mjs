/**
 * 迷你 MQTT 5 broker（只在模擬裡用）。
 *
 * 為什麼自己寫：App 用 MQTT 5（protocolVersion 5、clean:false、sessionExpiryInterval 86400），
 * 手邊的 aedes 只支援 3.1.1。這裡只做 App 用得到的部分，但語意照 EMQX：
 *  - 持久 session：clean:false 且未過期 → sessionPresent=1，訂閱保留，離線期間 QoS1 訊息排隊，
 *    沒收到 PUBACK 的 inflight 在重連時以 dup 重送。
 *  - retained、遺囑（非正常斷線才發；DISCONNECT 0x00 不發）、keepalive 逾時。
 *  - ACL 來自 token（模擬 /api/mqtt/token 發的 claims）：發佈不准 → PUBACK 0x87 並丟掉；
 *    訂閱不准 → SUBACK 0x87（跟正式站 EMQX 的 deny-by-default 檔案授權一樣「默默不給」）。
 *  - 同一個 clientId 第二條連線 → 舊的收到 DISCONNECT 0x8E（session taken over）後關閉。
 *
 * 連線用抽象介面接進來（Playwright routeWebSocket 的 route 物件）：
 *   broker.attach({ label, send(buf), close(), onData(cb), onClose(cb) })
 * onPublish(label, topic, payload)：每一則 ACL 放行的 PUBLISH（模擬的 LEAK 檢查看群組主題上 broker 到底看得到什麼）
 * onEvent({ kind, label, topic, payload?, acl?, granted?, at })：broker 看得到的每一樣東西（W3 的主題稽核 lib/topics.mjs）——
 *   connect（token 的 acl、遺囑主題與遺囑內容）、publish（含被拒的）、will（broker 替斷線的人發出遺囑；W4 審查 #5：
 *   遺囑不經 PUBLISH，以前稽核看不到它的內容）、subscribe／unsubscribe（filter、准了沒）、deliver（送到哪一支、內容、from ＝ 誰發的）、
 *   inject（營運方繞過 ACL 直接塞的）、withheld（營運方扣下不送的）
 *
 * W5（docs/GROUP_LOG_WIRING_W5.md）—— 惡意的營運方與第五個角色 Mallory：
 *   inject(topic, payload, { retain, qos, as })  營運方繞過 ACL 在任何主題上發（as ＝ 寄件人那一節要假裝成誰都行，事件 label 是 operator）
 *   tap()／spy(filter)                           記下之後 broker 轉送的每一則（publish、will、inject；filter 過的）：{ at, kind, from, topic, payload, qos, retain }
 *   withhold(pred)／release(id)                  營運方扣下符合 pred({ topic, payload, from, to }) 的投遞（不送、不排隊）
 *   expireSession(label)                         這支的持久 session 過期了（離線超過 24 小時：排隊的、訂閱全部沒了）
 *   refuseConnect(label, on)                     不讓這支連上（斷網：CONNECT 回 0x88 server unavailable）
 *   isAdversary(label)                           這個 label 是攻擊者（Mallory、Bob 的影子連線）：它被拒的發布／訂閱另外算（stats.adversaryDenied），
 *                                                不算進 App 的 deniedPub／deniedSub
 */
import { createRequire } from 'node:module';
import { aclAllows, aclView } from './aclView.mjs';

export function createBroker({ resolveModule, verifyToken, log, clock = () => Date.now(), tokenMatchesUser = (claims, username) => claims.username === username, onPublish = null, onEvent = null, isAdversary = () => false }) {
  const mqttPacket = resolveModule('mqtt-packet');
  const sessions = new Map();   // clientId → session
  const retained = new Map();   // topic → { payload, qos }
  const stats = { connects: 0, publishes: 0, delivered: 0, queued: 0, deniedPub: 0, deniedSub: 0, injected: 0, withheld: 0,
    adversaryDenied: { pub: 0, sub: 0 }, deniedBy: {} };
  const spies = new Set();
  const withholds = new Map();   // id → pred
  let withholdSeq = 0;
  const refused = new Set();

  const now = () => Date.now();
  const emit = (ev) => { try { onEvent?.({ ...ev, at: now() }); } catch (e) { log('broker', `onEvent failed: ${e.message}`); } };
  /** 被拒的發布／訂閱：App 的算進 deniedPub／deniedSub（BROKER-ACL 要 0），攻擊者的另外算 */
  function denied(label, what) {
    const by = (stats.deniedBy[label] ??= { pub: 0, sub: 0 });
    by[what]++;
    if (isAdversary(label)) stats.adversaryDenied[what]++;
    else if (what === 'pub') stats.deniedPub++;
    else stats.deniedSub++;
  }
  function offerSpies(rec) {
    for (const s of spies) {
      try { if (s.filter(rec)) s.records.push(rec); } catch { /* 呼叫端的 filter 壞了：不影響 broker */ }
    }
  }

  function topicMatches(filter, topic) {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (i >= t.length) return false;
      if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }

  function describe(payload) {
    try {
      const m = JSON.parse(payload.toString('utf8'));
      return { type: m.type, from: typeof m.from === 'string' ? m.from.slice(0, 10) : undefined, payloadKeys: m.payload && typeof m.payload === 'object' ? Object.keys(m.payload).slice(0, 6) : undefined, groupId: m.payload?.groupId, member: typeof m.payload?.memberPublicKey === 'string' ? m.payload.memberPublicKey.slice(0, 10) : undefined, online: m.payload?.online };
    } catch {
      return { type: '?' };
    }
  }

  function sendPacket(sess, packet) {
    if (!sess.conn) return false;
    try {
      sess.conn.send(mqttPacket.generate(packet, { protocolVersion: 5 }));
      return true;
    } catch (e) {
      log('broker', `send failed to ${sess.clientId}: ${e.message}`);
      return false;
    }
  }

  function nextPacketId(sess) {
    sess.pid = (sess.pid % 65535) + 1;
    return sess.pid;
  }

  function deliver(sess, topic, payload, qos, retain = false, from = null) {
    emit({ kind: 'deliver', label: sess.label, topic, payload, from, queued: !sess.conn && qos !== 0 });
    if (qos === 0) {
      if (!sess.conn) return;
      sendPacket(sess, { cmd: 'publish', topic, payload, qos: 0, retain, dup: false });
      stats.delivered++;
      return;
    }
    if (!sess.conn) {
      if (sess.queue.length >= 1000) sess.queue.shift();
      sess.queue.push({ topic, payload, qos: 1, at: now(), from });
      stats.queued++;
      log('broker', `queued for offline ${sess.label}: ${topic} ${JSON.stringify(describe(payload))}`);
      return;
    }
    const messageId = nextPacketId(sess);
    sess.inflight.set(messageId, { topic, payload });
    sendPacket(sess, { cmd: 'publish', topic, payload, qos: 1, messageId, retain, dup: false });
    stats.delivered++;
  }

  /** 營運方扣下這一則投遞嗎（withhold 的規則）；扣下的記一筆 withheld 事件 */
  function withheldFor(sess, topic, payload, from) {
    for (const [id, pred] of withholds) {
      let hit = false;
      try { hit = !!pred({ topic, payload, from, to: sess.label }); } catch { hit = false; }
      if (!hit) continue;
      stats.withheld++;
      emit({ kind: 'withheld', label: sess.label, topic, payload, from, rule: id });
      return true;
    }
    return false;
  }

  function route(topic, payload, qos, from = null) {
    for (const sess of sessions.values()) {
      let best = -1;
      for (const [filter, subQos] of sess.subs) {
        if (topicMatches(filter, topic)) best = Math.max(best, subQos);
      }
      if (best < 0) continue;
      if (withholds.size && withheldFor(sess, topic, payload, from)) continue;
      deliver(sess, topic, payload, Math.min(best, qos), false, from);
    }
  }

  function publish(topic, payload, qos, retain, from = null, kind = 'publish') {
    stats.publishes++;
    if (spies.size) offerSpies({ at: now(), kind, from, topic, payload: Buffer.from(payload), qos, retain: !!retain });
    if (retain) {
      if (payload.length === 0) retained.delete(topic);
      else retained.set(topic, { payload, qos, from });
    }
    route(topic, payload, qos, from);
  }

  function publishWill(sess) {
    const will = sess.will;
    sess.will = null;
    if (!will) return;
    const allowed = !!sess.acl && aclAllows(sess.acl, 'publish', will.topic, { retain: !!will.retain });
    emit({ kind: 'will', label: sess.label, topic: will.topic, payload: Buffer.from(will.payload ?? ''), granted: allowed });
    if (!allowed) {
      log('broker', `will of ${sess.label} denied by ACL: ${will.topic}`);
      return;
    }
    // 營運方也能扣下遺囑（W5：「擋掉遺囑」—— 好友頂多誤以為他在線 10 分鐘）
    for (const [id, pred] of withholds) {
      let hit = false;
      try { hit = !!pred({ topic: will.topic, payload: Buffer.from(will.payload ?? ''), from: sess.label, to: null, will: true }); } catch { hit = false; }
      if (!hit) continue;
      stats.withheld++;
      emit({ kind: 'withheld', label: sess.label, topic: will.topic, payload: Buffer.from(will.payload ?? ''), from: sess.label, rule: id, will: true });
      log('broker', `will of ${sess.label} withheld by the operator: ${will.topic}`);
      return;
    }
    log('broker', `will published for ${sess.label}: ${will.topic} ${JSON.stringify(describe(will.payload))}`);
    publish(will.topic, Buffer.from(will.payload), Math.min(will.qos ?? 0, 1), !!will.retain, sess.label, 'will');
  }

  function endConnection(sess, conn, { will }) {
    if (sess.conn !== conn) return;
    sess.conn = null;
    clearTimeout(sess.kaTimer);
    if (will) publishWill(sess);
    else sess.will = null;
    if (!sess.expiry) {
      sessions.delete(sess.clientId);
    } else {
      sess.expiresAt = now() + sess.expiry * 1000;
    }
  }

  function armKeepalive(sess, conn) {
    clearTimeout(sess.kaTimer);
    if (!sess.keepalive) return;
    sess.kaTimer = setTimeout(() => {
      if (sess.conn !== conn) return;
      log('broker', `keepalive timeout ${sess.label}`);
      endConnection(sess, conn, { will: true });
      try { conn.close(); } catch { /* */ }
    }, sess.keepalive * 1500);
  }

  function onConnect(conn, packet, state) {
    const claims = verifyToken(packet.password ? packet.password.toString() : '');
    const reject = (reasonCode, why) => {
      log('broker', `CONNECT rejected (${why}) clientId=${packet.clientId}`);
      try { conn.send(mqttPacket.generate({ cmd: 'connack', reasonCode, sessionPresent: false }, { protocolVersion: 5 })); } catch { /* */ }
      setTimeout(() => { try { conn.close(); } catch { /* */ } }, 20);
    };
    if (packet.protocolVersion !== 5) return reject(0x84, 'protocol ' + packet.protocolVersion);
    if (!claims) return reject(0x86, 'bad token');
    if (!tokenMatchesUser(claims, packet.username)) return reject(0x86, 'username mismatch');
    if (claims.clientid && claims.clientid !== packet.clientId) return reject(0x85, 'clientid mismatch');
    if (claims.exp && claims.exp * 1000 < clock()) return reject(0x86, 'token expired');
    if (refused.has(conn.label)) return reject(0x88, 'network down (sim)');

    const clientId = packet.clientId;
    const expiry = packet.properties?.sessionExpiryInterval ?? 0;
    let sess = sessions.get(clientId);
    if (sess && sess.conn) {
      log('broker', `session takeover ${sess.label}`);
      const old = sess.conn;
      sendPacket(sess, { cmd: 'disconnect', reasonCode: 0x8e });
      sess.conn = null;
      clearTimeout(sess.kaTimer);
      try { old.close(); } catch { /* */ }
    }
    if (sess && sess.expiresAt && sess.expiresAt < now()) { sessions.delete(clientId); sess = null; }
    let sessionPresent = false;
    if (sess && !packet.clean) {
      sessionPresent = true;
    } else {
      sess = { clientId, subs: new Map(), queue: [], inflight: new Map(), pid: 0 };
      sessions.set(clientId, sess);
    }
    sess.conn = conn;
    sess.label = conn.label || clientId;
    sess.username = packet.username;
    sess.acl = claims.acl;
    sess.expiry = expiry;
    sess.expiresAt = 0;
    sess.keepalive = packet.keepalive;
    sess.will = packet.will ? { topic: packet.will.topic, payload: packet.will.payload, qos: packet.will.qos, retain: packet.will.retain } : null;
    state.sess = sess;
    stats.connects++;
    emit({ kind: 'connect', label: sess.label, topic: sess.will?.topic ?? null, acl: claims.acl, ...(sess.will ? { payload: Buffer.from(sess.will.payload ?? '') } : {}) });
    sendPacket(sess, { cmd: 'connack', reasonCode: 0, sessionPresent });
    log('broker', `CONNECT ${sess.label} clientId=${clientId} clean=${packet.clean} sessionPresent=${sessionPresent} queued=${sess.queue.length} inflight=${sess.inflight.size} aclSub=${aclView(claims.acl).sub.length}`);
    try { conn.onConnectInfo?.({ username: packet.username, clientId }); } catch { /* */ }
    armKeepalive(sess, conn);
    // 先重送 inflight（dup），再送離線排隊
    for (const [messageId, m] of sess.inflight) {
      sendPacket(sess, { cmd: 'publish', topic: m.topic, payload: m.payload, qos: 1, messageId, dup: true, retain: false });
    }
    const queued = sess.queue.splice(0);
    for (const m of queued) deliver(sess, m.topic, m.payload, 1, false, m.from ?? null);
  }

  function onPacket(conn, packet, state) {
    const sess = state.sess;
    if (packet.cmd === 'connect') return onConnect(conn, packet, state);
    if (!sess || sess.conn !== conn) return;
    armKeepalive(sess, conn);
    switch (packet.cmd) {
      case 'publish': {
        // token 的 acl（legacy 或 EMQX ≥ 5.7 的規則清單，lib/aclView.mjs）：rules 格式的發布規則帶 retain 條件
        const allowed = aclAllows(sess.acl, 'publish', packet.topic, { retain: !!packet.retain });
        emit({ kind: 'publish', label: sess.label, topic: packet.topic, payload: packet.payload, granted: allowed });
        if (!allowed) {
          denied(sess.label, 'pub');
          log('broker', `PUBLISH denied ${sess.label}: ${packet.topic}`);
          if (packet.qos === 1) sendPacket(sess, { cmd: 'puback', messageId: packet.messageId, reasonCode: 0x87 });
          return;
        }
        if (packet.qos === 1) sendPacket(sess, { cmd: 'puback', messageId: packet.messageId, reasonCode: 0 });
        try { onPublish?.(sess.label, packet.topic, packet.payload); } catch (e) { log('broker', `onPublish failed: ${e.message}`); }
        const d = describe(packet.payload);
        if (d.type !== 'presence' || packet.retain) log('broker', `PUBLISH ${sess.label} ${packet.topic} q${packet.qos}${packet.retain ? ' retain' : ''} ${JSON.stringify(d)}`);
        publish(packet.topic, packet.payload, Math.min(packet.qos, 1), packet.retain, sess.label);
        return;
      }
      case 'puback':
        sess.inflight.delete(packet.messageId);
        return;
      case 'subscribe': {
        const granted = [];
        for (const sub of packet.subscriptions) {
          const ok = aclAllows(sess.acl, 'subscribe', sub.topic);
          emit({ kind: 'subscribe', label: sess.label, topic: sub.topic, granted: ok });
          if (!ok) {
            denied(sess.label, 'sub');
            granted.push(0x87);
            log('broker', `SUBSCRIBE denied ${sess.label}: ${sub.topic}`);
            continue;
          }
          const q = Math.min(sub.qos, 1);
          sess.subs.set(sub.topic, q);
          granted.push(q);
          for (const [topic, r] of retained) {
            if (!topicMatches(sub.topic, topic)) continue;
            // 營運方也能扣下訂閱當下補送的 retained（W5 審查 L7）
            if (withholds.size && withheldFor(sess, topic, r.payload, r.from ?? null)) continue;
            deliver(sess, topic, r.payload, Math.min(q, r.qos), true, r.from ?? null);
          }
        }
        sendPacket(sess, { cmd: 'suback', messageId: packet.messageId, granted, reasonCode: granted });
        return;
      }
      case 'unsubscribe': {
        for (const t of packet.unsubscriptions) { sess.subs.delete(t); emit({ kind: 'unsubscribe', label: sess.label, topic: t }); }
        sendPacket(sess, { cmd: 'unsuback', messageId: packet.messageId, granted: packet.unsubscriptions.map(() => 0) });
        return;
      }
      case 'pingreq':
        sendPacket(sess, { cmd: 'pingresp' });
        return;
      case 'disconnect': {
        const normal = !packet.reasonCode;
        if (packet.properties?.sessionExpiryInterval !== undefined) sess.expiry = packet.properties.sessionExpiryInterval;
        log('broker', `DISCONNECT ${sess.label} reason=${packet.reasonCode ?? 0}`);
        endConnection(sess, conn, { will: !normal });
        try { conn.close(); } catch { /* */ }
        return;
      }
      default:
        return;
    }
  }

  function attach(conn) {
    const state = { sess: null };
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    parser.on('packet', (p) => {
      try { onPacket(conn, p, state); } catch (e) { log('broker', `packet handler error: ${e.stack || e}`); }
    });
    parser.on('error', (e) => {
      log('broker', `parse error ${conn.label}: ${e.message}`);
      try { conn.close(); } catch { /* */ }
    });
    conn.onData((buf) => parser.parse(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
    conn.onClose(() => {
      if (state.sess) endConnection(state.sess, conn, { will: true });
    });
  }

  /** 讓某個 clientId 的連線「斷網」：不送 DISCONNECT，直接關（broker 會發遺囑） */
  function dropClientsWhere(pred) {
    for (const sess of sessions.values()) {
      if (sess.conn && pred(sess)) {
        const c = sess.conn;
        endConnection(sess, c, { will: true });
        try { c.close(); } catch { /* */ }
      }
    }
  }

  /** 營運方繞過 ACL 在任何主題上發（W5）：寄件人那一節照 topic（要假裝成誰都行）；事件的 label 是 as（預設 operator） */
  function inject(topic, payload, { retain = false, qos = 1, as = 'operator' } = {}) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    stats.injected++;
    emit({ kind: 'inject', label: as, topic, payload: buf, granted: true });
    log('broker', `INJECT (${as}) ${topic} q${qos}${retain ? ' retain' : ''} ${buf.length}B`);
    publish(topic, buf, Math.min(qos, 1), retain, as, 'inject');
  }

  /** 記下之後轉送的每一則（filter 過的）：{ at, kind: publish|will|inject, from, topic, payload, qos, retain }；stop() 停止記 */
  function spy(filter = () => true) {
    const s = { filter, records: [], stop() { spies.delete(s); } };
    spies.add(s);
    return s;
  }
  const tap = () => spy(() => true);

  /** 營運方扣下符合 pred({ topic, payload, from, to, will? }) 的投遞；回傳 id（release(id) 放行） */
  function withhold(pred) {
    const id = ++withholdSeq;
    withholds.set(id, pred);
    return id;
  }
  const release = (id) => withholds.delete(id);

  /** 這支（label）離線的持久 session 過期（W5 S11：離線超過 broker 保留 session 的時間）：排隊的訊息與訂閱全部沒了 */
  function expireSession(label) {
    let n = 0;
    for (const [id, sess] of sessions) {
      if (sess.label === label && !sess.conn) { sessions.delete(id); n++; }
    }
    if (n) log('broker', `session of ${label} expired (sim) — queue and subscriptions dropped`);
    return n;
  }

  /** 斷網（W5）：on ＝ 這支的 CONNECT 一律拒絕（0x88），off ＝ 恢復 */
  function refuseConnect(label, on = true) {
    if (on) refused.add(label);
    else refused.delete(label);
  }

  return { attach, stats, sessions, retained, dropClientsWhere, inject, spy, tap, withhold, release, expireSession, refuseConnect };
}

/** 依序在幾個 node_modules 目錄找套件（ESM 不吃 NODE_PATH） */
export function makeResolver(dirs) {
  return (name) => {
    let lastErr;
    for (const d of dirs.filter(Boolean)) {
      try { return createRequire(d.replace(/\/?$/, '/') + 'noop.js')(name); } catch (e) { lastErr = e; }
    }
    throw new Error(`cannot resolve ${name} from ${dirs.join(', ')}: ${lastErr?.message}`);
  };
}

/**
 * 本機網路：靜態伺服器（dist）＋每個瀏覽器 context 的攔截規則。
 *
 * 規則（任何一條沒涵蓋到的對外請求都算違規，整輪判失敗）：
 *  - 127.0.0.1 / localhost：放行（本機靜態檔；/api/* 由模擬 API 回答）
 *  - profile 的 API 主機（prodApiHosts：社群版是模擬伺服器的假主機，官方版是 App 寫死的那幾個）的 /api/*：攔下來由模擬 API 回答，不會送出去
 *  - profile 的 broker（brokerUrl）：攔下來接到本機模擬 broker
 *  - 刷臉模型的 CDN 備援（cdn.jsdelivr.net/@mediapipe、storage.googleapis.com/mediapipe-models）：
 *    開機就預載、跟群組無關 → 本機直接回 404
 *  - profiles.mjs 的 intercept404（官方版：防詐規則同步的網址）：跟群組無關 → 本機回 404
 *  - 其他：abort，記成違規
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain', '.onnx': 'application/octet-stream',
  '.data': 'application/octet-stream', '.task': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
};

export function startStaticServer({ root, port, mockApi, log }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const r = await mockApi.handle(req.method, url.pathname, body, url.search);
        const out = r || { status: 404, body: JSON.stringify({ detail: 'sim: not mocked' }), contentType: 'application/json' };
        if (!r) log('api', `unmocked (server) ${req.method} ${url.pathname}`);
        res.writeHead(out.status, { 'Content-Type': out.contentType });
        res.end(out.body);
      });
      return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (url.pathname === '/' || url.pathname === '/share-target' || url.pathname === '/share-target/') file = path.join(root, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const INTERCEPT_404 = [
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\//,
  /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//,
];

export function isLocalUrl(u) {
  try {
    const url = typeof u === 'string' ? new URL(u) : u;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch { return false; }
}

/**
 * 掛到一個 BrowserContext 上。onMqttSocket(route) 由呼叫端接到 broker。
 * 回傳的 guard 物件累計：intercepted（被模擬接住的正式站網址）與 violations（被擋下的對外請求）。
 */
export async function guardContext(context, { label, mockApi, onMqttSocket, guard, log, profile }) {
  await context.route((url) => url.protocol.startsWith('http') && (!isLocalUrl(url) || url.pathname.startsWith('/api/')), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (isLocalUrl(url) || profile.prodApiHosts.includes(url.hostname)) {
      if (url.pathname.startsWith('/api/')) {
        const r = await mockApi.handle(req.method(), url.pathname, req.postData() || '', url.search, label);
        if (!isLocalUrl(url)) guard.intercepted.set(`${req.method()} ${url.origin}${url.pathname.replace(/\/lookup\/.*/, '/lookup/:code')}`, (guard.intercepted.get(`${req.method()} ${url.origin}${url.pathname.replace(/\/lookup\/.*/, '/lookup/:code')}`) || 0) + 1);
        if (!r) log(label, `[sim] unmocked API ${req.method()} ${url.pathname}`);
        const out = r || { status: 404, body: JSON.stringify({ detail: 'sim: not mocked' }), contentType: 'application/json' };
        return route.fulfill({ status: out.status, contentType: out.contentType, body: out.body });
      }
      if (isLocalUrl(url)) return route.continue();
    }
    if (INTERCEPT_404.some((re) => re.test(url.href)) || (profile.intercept404 ?? []).some((re) => re.test(url.href))) {
      const k = `${url.origin}${url.pathname.split('/').slice(0, 3).join('/')}/…`;
      guard.intercepted.set(k, (guard.intercepted.get(k) || 0) + 1);
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'sim: blocked third-party asset' });
    }
    guard.violations.push({ who: label, method: req.method(), url: req.url(), at: new Date().toISOString() });
    log(label, `[sim] BLOCKED outbound request ${req.method()} ${req.url()}`);
    return route.abort('blockedbyclient');
  });

  await context.routeWebSocket(() => true, (ws) => {
    const url = ws.url();
    if (url === profile.brokerUrl) {
      onMqttSocket(ws);
      return;
    }
    if (isLocalUrl(url)) {
      ws.connectToServer();
      return;
    }
    guard.violations.push({ who: label, method: 'WS', url, at: new Date().toISOString() });
    log(label, `[sim] BLOCKED outbound websocket ${url}`);
    ws.close({ code: 1008, reason: 'sim: blocked' });
  });
}

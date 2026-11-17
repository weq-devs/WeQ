// @vitest-environment node
import { createServer, get, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { WebCore } from '../src/main/web/application';
import { router, procedure } from '../src/main/ipc/trpc';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('缺少监听地址');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-development-web-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url!);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['accept-encoding']).toBeUndefined();
    if (req.url === '/large.js' || req.url === '/large.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Vary', 'Origin');
      res.setHeader('ETag', 'W/"fixture-code"');
      if (req.headers['if-none-match'] === 'W/"fixture-code"') res.writeHead(304).end();
      else res.end('/* fixture payload */\n'.repeat(1000));
      return;
    }
    if (req.url === '/deps/shared.js?v=fixture') {
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'max-age=31536000,immutable');
      res.end('export const shared = true;');
      return;
    }
    if (req.url === '/image.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.alloc(4096, 42));
      return;
    }
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript');
    res.end(
      req.url === '/'
        ? `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data:"><script type="module" src="/src/main.tsx"></script></head><body>dev page</body></html>`
        : 'export const updated = true;',
    );
  });
  const upstreamUrl = await listen(upstream);
  const wss = new WebSocketServer({ server: upstream, path: '/_weq-dev/hmr' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected' }));
    ws.on('message', (message) => ws.send(message));
  });
  cleanup.push(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  let allowed = true;
  const revoked = new Set<() => void>();
  const core = new WebCore({
    publicDir: join(root, 'missing'),
    exportDir: join(root, 'exports'),
    version: 'test',
    developmentUrl: upstreamUrl,
    router: router({ ping: procedure.query(() => 'business') }),
  });
  const app = core.entry({
    login: async () => false,
    logout() {},
    isAuthed: () => allowed,
    watchSession: (_req, revoke) => {
      revoked.add(revoke);
      return () => revoked.delete(revoke);
    },
  });
  const server = createServer((req, res) => app.handle(req, res));
  app.attach(server);
  const base = await listen(server);
  cleanup.push(() => app.close());
  return {
    base,
    app,
    core,
    seen,
    revoked,
    deny: () => {
      allowed = false;
    },
  };
}
it('无静态构建仍可使用开发页，资源实时转发，业务 API 不转发，HTTP 仍经认证', async () => {
  const f = await fixture();
  expect(f.core.assetsInstalled).toBe(true);
  const page = await fetch(f.base, {
    headers: { cookie: 'private=secret', Authorization: 'Bearer secret' },
  });
  const html = await page.text();
  expect(html).toContain('dev page');
  expect(html).toContain("script-src 'self' 'unsafe-inline'");
  expect(html).toContain("img-src 'self' data:");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await (await fetch(`${f.base}/src/App.tsx?t=123`)).text()).toContain('updated');
  expect((await (await fetch(`${f.base}/trpc/ping`)).json()).result.data.json).toBe('business');
  expect(f.seen).toEqual(['/', '/src/App.tsx?t=123']);
  f.deny();
  expect((await fetch(`${f.base}/@vite/client`)).status).toBe(401);
  expect(f.seen).toHaveLength(2);
});
function rawGet(url: string, encoding: string) {
  return new Promise<{ headers: import('node:http').IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      get(url, { headers: { 'Accept-Encoding': encoding } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        res.once('error', reject);
      }).once('error', reject);
    },
  );
}
it.each(['js', 'css'])(
  '开发 %s 使用真实 gzip 传输，保留来源 Vary，不压缩图片',
  async (extension) => {
    const f = await fixture();
    const encoded = await rawGet(`${f.base}/large.${extension}`, 'br, gzip');
    expect(encoded.headers['content-encoding']).toBe('gzip');
    expect(encoded.headers.vary).toContain('Origin');
    expect(encoded.headers.vary).toContain('Accept-Encoding');
    expect(encoded.headers['content-length']).toBeUndefined();
    expect(gunzipSync(encoded.body).toString()).toBe('/* fixture payload */\n'.repeat(1000));
    expect(encoded.body.length).toBeLessThan(500);
    const identity = await rawGet(`${f.base}/large.${extension}`, '*;q=1, gzip;q=0');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body).toEqual(gunzipSync(encoded.body));
    const image = await rawGet(`${f.base}/image.png`, 'gzip');
    expect(image.headers['content-encoding']).toBeUndefined();
    expect(image.body).toEqual(Buffer.alloc(4096, 42));
  },
);
it('开发源码保留 ETag 条件验证，带版本依赖复用缓存，HTML 仍不缓存', async () => {
  const f = await fixture();
  const source = await fetch(`${f.base}/large.js`);
  expect(source.headers.get('cache-control')).toBe('private, no-cache');
  await source.text();
  const unchanged = await fetch(`${f.base}/large.js`, {
    headers: { 'If-None-Match': source.headers.get('etag')! },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  const dep = await fetch(`${f.base}/deps/shared.js?v=fixture`);
  expect(dep.headers.get('cache-control')).toBe('private, max-age=31536000,immutable');
  await dep.text();
  const head = await fetch(`${f.base}/large.js`, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-encoding')).toBe('gzip');
  expect(await head.text()).toBe('');
  expect((await fetch(f.base)).headers.get('cache-control')).toBe('no-store');
});
it('旧版 Remote 开发页在模块前接入已有阶段协议，普通浏览器不附带进度桥', async () => {
  const f = await fixture();
  const response = await fetch(f.base, { headers: { 'User-Agent': 'old WeQRemote' } });
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await response.text();
  expect(html).toContain('data-weq-development-progress');
  expect(html.indexOf('data-weq-development-progress')).toBeLessThan(
    html.indexOf('src="/src/main.tsx"'),
  );
  expect(html).toContain('weq-remote-startup');
  expect(await (await fetch(f.base)).text()).not.toContain('data-weq-development-progress');
});
it('热更新 WebSocket 与业务订阅并存，撤销和关闭释放连接，未登录不升级', async () => {
  const f = await fixture();
  const ws = new WebSocket(
    `${f.base.replace('http:', 'ws:')}/_weq-dev/hmr?token=fixture`,
    'vite-hmr',
  );
  cleanup.push(() => ws.terminate());
  const connected = once(ws, 'message');
  await once(ws, 'open');
  expect(JSON.parse(String((await connected)[0])).type).toBe('connected');
  const echo = once(ws, 'message');
  ws.send('update');
  expect(String((await echo)[0])).toBe('update');
  const business = new WebSocket(`${f.base.replace('http:', 'ws:')}/trpc-ws`);
  cleanup.push(() => business.terminate());
  await once(business, 'open');
  const closed = once(ws, 'close');
  for (const revoke of [...f.revoked]) revoke();
  await closed;
  f.deny();
  const denied = new WebSocket(`${f.base.replace('http:', 'ws:')}/_weq-dev/hmr`, 'vite-hmr');
  cleanup.push(() => denied.terminate());
  expect(String((await once(denied, 'unexpected-response'))[1].statusCode)).toBe('401');
  const aborted = once(denied, 'error');
  denied.terminate();
  expect(String((await aborted)[0])).toContain('closed before');
  f.app.close();
  expect(f.revoked.size).toBe(0);
});

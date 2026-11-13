import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import superjson from 'superjson';
import { DEFAULT_APP_SETTINGS } from '@weq/service';
import { serveStatic } from '../../src/main/web/static.ts';

const root = resolve(process.env.WEQ_WEB_PUBLIC ?? '.artifacts/remote-load-speed/public');
const output = resolve('.artifacts/remote-load-speed/screenshots');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
let reads = [];
const config = { configId: 'synthetic', uin: '10001', static: true, rkeys: [] };
function value(path) {
  reads.push(path);
  if (path === 'startup.snapshot')
    return {
      backup: {
        ok: true,
        error: null,
        result: null,
        appliedThisStartup: false,
        client: null,
        canReveal: false,
        canRestart: false,
      },
      snapshot: {
        native: null,
        current: { uin: '10001' },
        settings: DEFAULT_APP_SETTINGS,
        config,
        home: null,
      },
    };
  if (path === 'bootstrap.getSettings') return DEFAULT_APP_SETTINGS;
  if (path === 'bootstrap.currentAccount') return { uin: '10001' };
  if (path === 'account.getAccountConfig') return config;
  if (path === 'account.listRecentContacts') return { items: [], nextCursor: null };
  if (path === 'bootstrap.getNativeBuildInfo' || path.startsWith('bootstrap.consume')) return null;
  if (
    path === 'bootstrap.getWelcomeAcknowledged' ||
    path === 'bootstrap.getJoinGroupPromptAcknowledged'
  )
    return true;
  if (path.includes('.list') || path.includes('getAll') || path.includes('getUnread')) return [];
  return undefined;
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/trpc/')) {
    const results = decodeURIComponent(url.pathname.slice(6))
      .split(',')
      .map((path) => {
        const data = value(path);
        return data === undefined
          ? {
              error: superjson.serialize({
                message: '合成夹具未提供该业务数据',
                code: -32601,
                data: { code: 'NOT_FOUND', httpStatus: 404, path },
              }),
            }
          : { result: { data: superjson.serialize(data) } };
      });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(url.searchParams.get('batch') === '1' ? results : results[0]));
    return;
  }
  void serveStatic(res, root, req.url ?? '/', req.headers['accept-encoding'], true).catch((error) =>
    res.destroy(error),
  );
});
const sockets = new WebSocketServer({ server, path: '/trpc-ws' });
sockets.on('connection', (socket) =>
  socket.on('message', (raw) => {
    const messages = JSON.parse(raw.toString());
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      if (message.method === 'subscription')
        socket.send(JSON.stringify({ id: message.id, result: { type: 'started' } }));
    }
  }),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  for (const [width, theme] of [
    [390, 'light'],
    [1280, 'dark'],
  ]) {
    reads = [];
    const context = await browser.newContext({
      userAgent: 'WeQRemote',
      viewport: { width, height: 844 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.weqRemoteStartup?.state === 'ready', undefined, {
      timeout: 20000,
    });
    await page.waitForTimeout(250);
    if (!(await page.locator('.app-shell-root').isVisible()))
      console.log(JSON.stringify({ errors, reads, body: await page.locator('body').innerText() }));
    assert.ok(await page.locator('.app-shell-root').isVisible());
    assert.deepEqual(errors, []);
    assert.equal(reads.filter((name) => name === 'startup.snapshot').length, 1);
    for (const name of ['bootstrap.currentAccount', 'bootstrap.nativeStatus'])
      assert.equal(reads.filter((path) => path === name).length, 0, `快照后重复请求 ${name}`);
    for (const name of ['bootstrap.getSettings', 'account.getAccountConfig'])
      assert.ok(reads.filter((path) => path === name).length <= 1, `配置读取未合并 ${name}`);
    await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
    console.log(
      JSON.stringify({
        width,
        theme,
        ready: true,
        startupRequests: reads.filter((name) => name.startsWith('startup.')),
        errors,
      }),
    );
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

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
const pendingPanels = process.argv.includes('--pending-panels');
if (!pendingPanels) await mkdir(output, { recursive: true });
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const settings = pendingPanels
  ? { ...DEFAULT_APP_SETTINGS, startupPage: 'home' }
  : DEFAULT_APP_SETTINGS;
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
        settings,
        config,
        home: null,
      },
    };
  if (path === 'bootstrap.getSettings') return settings;
  if (path === 'bootstrap.currentAccount') return { uin: '10001' };
  if (path === 'account.getAccountConfig') return config;
  if (path === 'account.listRecentContacts') return { items: [], nextCursor: null };
  if (path === 'bootstrap.nativeStatus') return null;
  if (path === 'bootstrap.getDevelopmentFeatures') return { dressTools: pendingPanels };
  if (path === 'account.getGroupAlbumAccessState') return { qqOnline: false, attachEnabled: true };
  if (path === 'clientState.snapshot')
    return { serverId: 'fixture', epoch: 'fixture', revision: 1, records: {}, values: {} };
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
  browser = await engines[pendingPanels ? 'webkit' : 'chromium'].launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (pendingPanels) await checkPendingPanels(browser);
  for (const [width, theme] of pendingPanels
    ? []
    : [
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

async function checkPendingPanels(browser) {
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone) WeQRemote',
    viewport: { width: 402, height: 874 },
    colorScheme: 'dark',
    hasTouch: true,
  });
  page.setDefaultTimeout(7500);
  const errors = [];
  const requested = new Set();
  const gates = {
    WorkspaceTools: Promise.withResolvers(),
    ExportView: Promise.withResolvers(),
    QzoneAlbumDialog: Promise.withResolvers(),
    SettingsDialog: Promise.withResolvers(),
    DressUpDialog: Promise.withResolvers(),
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    const panel = url.pathname.match(
      /\/(WorkspaceTools|ExportView|QzoneAlbumDialog|SettingsDialog|DressUpDialog)-[^/]+\.js$/,
    )?.[1];
    if (panel) {
      requested.add(panel);
      await gates[panel].promise;
    }
    await route.continue();
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('.weq-chathome').waitFor();
    await page.waitForFunction(() => window.weqRemoteStartup?.state === 'ready');
    const pending = page.locator('.weq-panel-loading');
    assert.equal(await pending.count(), 0, '未打开工具时主页没有占位');
    assert.equal(requested.size, 0, '首屏不请求相册和任务列表模块');

    const checkContained = async (panel) => {
      const feedback = panel.getByRole('status').filter({ hasText: '正在加载' });
      await feedback.waitFor();
      const [box, parent] = await Promise.all([feedback.boundingBox(), panel.boundingBox()]);
      assert.ok(
        box && parent && box.y >= parent.y && box.y + box.height <= parent.y + parent.height,
      );
      assert.equal(
        await feedback.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
        true,
        '状态文字处于面板的可见层',
      );
      assert.equal(await pending.count(), 1);
      assert.equal(await page.evaluate(() => window.weqRemoteStartup.state), 'ready');
    };
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^更多/ })
      .click();
    await page.locator('.weq-mobile-more:visible').getByRole('button', { name: /^任务/ }).click();
    await checkContained(page.getByRole('region', { name: '任务', exact: true }));
    assert.ok(requested.has('ExportView'));
    assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), true);
    await pending.waitFor({ state: 'detached' });
    gates.ExportView.resolve();

    const header = page.locator('.weq-mobile-header');
    await header.locator('.weq-titlebar-search button').first().click();
    await header.getByRole('searchbox').fill('我的空间相册');
    await page
      .locator('.weq-titlebar-search-results')
      .getByText('我的空间相册', { exact: true })
      .click();
    const album = page.getByRole('region', { name: '空间相册', exact: true });
    await checkContained(album);
    assert.ok(requested.has('QzoneAlbumDialog'));
    await album.getByRole('button', { name: '关闭', exact: true }).click();
    await pending.waitFor({ state: 'detached' });
    const received = page.waitForResponse(/\/QzoneAlbumDialog-[^/]+\.js$/);
    gates.QzoneAlbumDialog.resolve();
    await (await received).finished();
    assert.equal(await album.count(), 0, '关闭后模块返回不会重新打开相册');

    const more = page.locator('.weq-mobile-more:visible');
    for (const [chunk, label] of [
      ['SettingsDialog', '设置'],
      ['DressUpDialog', '个性装扮'],
    ]) {
      if (!(await more.isVisible()))
        await page
          .getByRole('navigation', { name: '主导航' })
          .getByRole('button', { name: /^更多/ })
          .click();
      await more.getByRole('button', { name: label, exact: true }).click();
      const panel = page.getByRole('region', { name: label, exact: true });
      await checkContained(panel);
      await panel.getByRole('button', { name: '关闭', exact: true }).click();
      await pending.waitFor({ state: 'detached' });
      const received = page.waitForResponse(new RegExp(`/${chunk}-[^/]+\\.js$`));
      gates[chunk].resolve();
      await (await received).finished();
      assert.equal(await panel.count(), 0, `${label}关闭后不会由迟到代码重新打开`);
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS: 手机首屏无占位；任务、相册、设置及装扮在自身面板内等待，加载期间可返回或关闭。',
    );
  } finally {
    for (const gate of Object.values(gates)) gate.resolve();
    await page.close();
  }
}

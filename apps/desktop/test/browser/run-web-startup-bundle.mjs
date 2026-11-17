import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { startupShell } from '../../src/main/web/startup_assets.ts';

const root = process.env.WEQ_WEB_DIST;
if (!root) throw new Error('需要 WEQ_WEB_DIST 指向隔离构建目录，不读取运行中服务');
const publicRoot = resolve(root, 'public');
const reload = !process.argv.includes('--cold-only');
const inventory = JSON.parse(await readFile(join(publicRoot, 'weq-startup.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(publicRoot, '.vite/manifest.json'), 'utf8'));
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const install = {
  qqExePath: '/fixture/QQ.app',
  wrapperNodePath: '/fixture/wrapper.node',
  loginDbPath: '/fixture/login.db',
  tencentFilesRoot: '/fixture/QQ',
  version: '合成版本',
  userDataPath: '/fixture/QQ',
  hasQqExe: true,
  hasWrapper: true,
  hasUserData: true,
  hasLoginDb: true,
};
const settings = { startupPage: 'home', welcomeShown: true };
const backup = {
  ok: true,
  result: null,
  appliedThisStartup: false,
  client: null,
  canReveal: false,
  canRestart: false,
};
const data = {
  'startup.snapshot': {
    backup,
    snapshot: { native: null, current: null, settings, home: [install, [], null] },
  },
  'bootstrap.nativeStatus': null,
  'bootstrap.currentAccount': null,
  'bootstrap.describeInstall': install,
  'bootstrap.listAccountConfigs': [],
  'bootstrap.getAutoEnter': null,
  'bootstrap.getSettings': settings,
  'bootstrap.getNativeBuildInfo': null,
  'bootstrap.listLogins': [],
  'clientState.snapshot': { revision: 0, values: {}, records: {}, serverId: 'fixture' },
};
const requests = new Map();
const unknown = new Set();
async function serveFixture(req, res, pathname) {
  const asset = /^\/assets\/[^/]+$/.test(pathname);
  const name = asset || pathname === '/startup-theme.js' ? pathname : '/index.html';
  let body = await readFile(join(publicRoot, name));
  const compressed = req.headers['accept-encoding']?.includes('gzip') ?? false;
  if (name === '/index.html')
    body = Buffer.from(await startupShell(publicRoot, body.toString('utf8'), compressed));
  const type = name.endsWith('.html')
    ? 'text/html'
    : name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : 'application/octet-stream';
  res.setHeader('content-type', type);
  res.setHeader('cache-control', asset ? 'public, max-age=31536000, immutable' : 'no-store');
  if (compressed && /\.(js|css)$/.test(name) && body.length >= 1024) {
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('vary', 'accept-encoding');
    body = gzipSync(body);
  }
  res.end(body);
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname.startsWith('/trpc/')) {
    const result = decodeURIComponent(url.pathname.slice('/trpc/'.length))
      .split(',')
      .map((path) => {
        if (!(path in data)) unknown.add(path);
        return { result: { data: { json: data[path] ?? null } } };
      });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(url.searchParams.get('batch') === '1' ? result : result[0]));
    return;
  }
  if (url.pathname.startsWith('/assets/'))
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
  void serveFixture(req, res, url.pathname).catch((error) => res.destroy(error));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.WEQ_STARTUP_BUNDLE_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const results = [];
try {
  for (const [name, engine, executablePath] of [
    ['chromium', chromium, process.env.WEQ_CHROMIUM_EXECUTABLE],
    ['webkit', webkit, process.env.WEQ_WEBKIT_EXECUTABLE],
  ]) {
    const browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const width of [390, 1180]) {
        console.log(`检查 ${name} / ${width}`);
        const context = await browser.newContext({
          userAgent: 'WeQRemote',
          viewport: { width, height: 844 },
          reducedMotion: 'reduce',
          colorScheme: width === 390 ? 'dark' : 'light',
        });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          requests.clear();
          await page.goto(origin);
          await page.waitForFunction(() => window.weqRemoteStartup?.state === 'ready');
          await page.locator('.weq-account-workspace').waitFor();
          assert.equal(await page.locator('.weq-account-workspace').isVisible(), true);
          assert.deepEqual(errors, []);
          await page.waitForFunction(
            (paths) =>
              paths.every((path) => performance.getEntriesByName(location.origin + path).length),
            inventory.resources.map((asset) => asset.path),
          );
          for (const asset of inventory.resources)
            assert.equal(requests.get(asset.path), 1, asset.path);
          const coldRequests = [...requests.values()].reduce((sum, count) => sum + count, 0);
          if (reload) {
            await page.reload();
            await page.waitForFunction(() => window.weqRemoteStartup?.state === 'ready');
            await page.locator('.weq-account-workspace').waitFor();
            for (const asset of inventory.resources)
              assert.equal(requests.get(asset.path), 1, asset.path);
          }
          // 主工作区与按需模块均执行真实产物，检查分包循环及初始化顺序。
          const modules = Object.values(manifest)
            .filter((entry) => entry.isDynamicEntry)
            .map((entry) => '/' + entry.file);
          await page.evaluate(
            async (paths) => {
              for (const path of paths) await import(path);
            },
            [...new Set(modules)],
          );
          if (errors.length) console.error(JSON.stringify({ browser: name, width, errors }));
          assert.deepEqual(errors, []);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          if (output) await page.screenshot({ path: join(output, `${name}-${width}.png`) });
          results.push({
            browser: name,
            width,
            coldRequests,
            reload,
            dynamicEntries: modules.length,
            errors,
          });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify({ results, fixtureQueries: [...unknown] }));
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

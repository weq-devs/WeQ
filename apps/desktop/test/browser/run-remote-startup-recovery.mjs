import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { serveStatic } from '../../src/main/web/static.ts';
import { REMOTE_STARTUP_RESOURCE_STALL_MS } from '../../src/main/web/startup_recovery.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(join(root, '.artifacts'), { recursive: true });
const output = await mkdtemp(join(root, '.artifacts/remote-startup-recovery-'));
let server;
const results = [];
try {
  await build({
    configFile: false,
    root: join(root, 'test/browser'),
    plugins: [react()],
    define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
    build: {
      outDir: output,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: join(root, 'test/browser/remote-startup-recovery.html') },
    },
  });
  const manifest = JSON.parse(await readFile(join(output, '.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((value) => value.isEntry);
  const workspace = Object.values(manifest).find((value) => value.isDynamicEntry);
  assert.ok(entry && workspace?.css?.length);
  await writeFile(
    join(output, 'index.html'),
    await readFile(join(output, 'remote-startup-recovery.html')),
  );
  const resources = [];
  for (const path of new Set(
    Object.values(manifest).flatMap((value) => [value.file, ...(value.css ?? [])]),
  )) {
    if (!/\.(js|css)$/.test(path)) continue;
    const body = await readFile(join(output, path));
    resources.push({ path: '/' + path, raw: body.length, gzip: body.length, preload: false });
  }
  await writeFile(
    join(output, 'weq-startup.json'),
    JSON.stringify({ version: 1, entry: '/' + entry.file, resources }),
  );
  let mode = '';
  let failures = 0;
  let documents = 0;
  let attempts = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname === '/') documents++;
    const selected =
      mode === 'entry'
        ? '/' + entry.file
        : mode === 'css'
          ? '/' + workspace.css[0]
          : '/' + workspace.file;
    if (url.pathname === selected) {
      attempts++;
      if (mode === 'stall' && attempts === 1) return;
      if (failures > 0) {
        failures--;
        res.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/plain' });
        res.end('synthetic resource unavailable');
        return;
      }
    }
    void serveStatic(res, output, req.url, '', true).catch((error) => res.destroy(error));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, engine, executablePath] of [
    ['chromium', chromium, process.env.WEQ_CHROMIUM_EXECUTABLE],
    ['webkit', webkit, process.env.WEQ_WEBKIT_EXECUTABLE],
  ]) {
    if (process.env.WEQ_STARTUP_BROWSER && process.env.WEQ_STARTUP_BROWSER !== name) continue;
    const browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const scenario of process.argv.length > 2
        ? process.argv.slice(2)
        : ['entry', 'module', 'css', 'permanent', 'stall', 'runtime', 'ready']) {
        mode = scenario;
        failures =
          scenario === 'permanent'
            ? Infinity
            : ['entry', 'module', 'css'].includes(scenario)
              ? 1
              : 0;
        documents = 0;
        attempts = 0;
        const context = await browser.newContext({
          userAgent: 'WeQRemote',
          viewport: { width: 390, height: 844 },
        });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.clock.install();
          await page.goto(`${origin}/?mode=${scenario}&keep=1#chat`, { waitUntil: 'commit' });
          if (scenario === 'stall') {
            await page.waitForFunction(
              () => window.weqRemoteStartup?.message === '正在加载界面模块',
            );
            await page.clock.runFor(REMOTE_STARTUP_RESOURCE_STALL_MS);
          }
          const failed = ['permanent', 'runtime'].includes(scenario);
          try {
            await page.waitForFunction(
              (state) => window.weqRemoteStartup?.state === state,
              failed ? 'error' : 'ready',
              { timeout: 5000 },
            );
          } catch (error) {
            console.error(
              JSON.stringify({
                engine: name,
                scenario,
                documents,
                attempts,
                errors,
                page: await page.evaluate(() => ({
                  url: location.href,
                  startup: window.weqRemoteStartup,
                  retrying: window.weqRemoteStartupRetrying,
                  resources: window.weqRemoteResourceLoads,
                  text: document.body.textContent,
                })),
              }),
            );
            throw error;
          }
          const expectedDocuments = ['permanent', 'runtime', 'ready'].includes(scenario) ? 1 : 2;
          assert.equal(documents, expectedDocuments, `${name}/${scenario}: 文档加载次数`);
          if (!failed) {
            assert.equal(await page.locator('.app-shell-root').isVisible(), true);
            assert.equal(
              await page
                .locator('.app-shell-root')
                .evaluate((node) => getComputedStyle(node).color),
              'rgb(20, 90, 60)',
            );
            assert.equal(new URL(page.url()).searchParams.has('__weqStartupRetry'), false);
            assert.equal(new URL(page.url()).hash, '#chat');
            await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')));
            await page.clock.runFor(REMOTE_STARTUP_RESOURCE_STALL_MS * 2);
            assert.equal(documents, expectedDocuments, '就绪后不得再重载');
          } else {
            await page.clock.runFor(REMOTE_STARTUP_RESOURCE_STALL_MS * 2);
            assert.equal(documents, expectedDocuments, '失败后不得循环重载');
          }
          results.push({
            engine: name,
            scenario,
            documents,
            attempts,
            state: failed ? 'error' : 'ready',
          });
          console.log(JSON.stringify(results.at(-1)));
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify({ cases: results.length, results }));
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(output, { recursive: true, force: true });
}

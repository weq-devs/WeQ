import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { chromium, _electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cache = join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'client-sync-'));
const artifacts = process.env.WEQ_SYNC_ARTIFACTS ?? join(cache, 'client-sync-evidence');
await mkdir(artifacts, { recursive: true });
const servers = [];
let backend, browser, electron;
try {
  await build({
    entryPoints: [join(root, 'test/browser/client-sync-server.ts')],
    outfile: join(temporary, 'server.mjs'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: 'synthetic-context',
        setup(context) {
          context.onResolve({ filter: /context\/app_context$/ }, () => ({
            path: join(root, 'test/browser/client-sync-context.ts'),
          }));
          context.onResolve({ filter: /^\.\.\/trpc$/ }, () => ({
            path: join(root, 'test/browser/client-sync-trpc.ts'),
          }));
        },
      },
    ],
  });
  backend = spawn(process.execPath, [join(temporary, 'server.mjs')], {
    env: { ...process.env, WEQ_SYNC_FIXTURE_ROOT: join(temporary, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  backend.stderr.on('data', (data) => {
    errors += data;
  });
  const port = await new Promise((resolvePort, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`fixture timeout: ${errors}`)), 15000);
    backend.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`fixture exited: ${errors}`));
    });
    backend.stdout.on('data', (data) => {
      output += data;
      if (output.includes('\n')) {
        clearTimeout(timer);
        resolvePort(JSON.parse(output.trim()).port);
      }
    });
  });
  async function serve(target) {
    const server = await createServer({
      configFile: false,
      root,
      cacheDir: join(temporary, `vite-${target}`),
      plugins: [react(), tailwind()],
      define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(target) },
      optimizeDeps: { entries: ['test/browser/client-sync.html'] },
      resolve: {
        alias: {
          '@transport': join(root, 'test/browser/client-sync-transport.ts'),
          '@renderer': join(root, 'src/renderer/src'),
          '@resources': resolve(root, '../../resources'),
        },
      },
      server: {
        host: '127.0.0.1',
        port: 0,
        hmr: false,
        watch: null,
        fs: { allow: [resolve(root, '../..')] },
        proxy: {
          '/trpc-ws': { target: `ws://127.0.0.1:${port}`, ws: true },
          '/trpc': `http://127.0.0.1:${port}`,
        },
      },
    });
    await server.listen();
    servers.push(server);
    return `http://127.0.0.1:${server.httpServer.address().port}/test/browser/client-sync.html`;
  }
  const desktopUrl = await serve('electron');
  const webUrl = await serve('web');
  await build({
    entryPoints: [join(root, 'test/browser/client-sync-electron.ts')],
    outfile: join(temporary, 'electron.mjs'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    external: ['electron'],
  });
  electron = await _electron.launch({
    executablePath: require('electron'),
    args: [join(temporary, 'electron.mjs')],
    env: {
      ...process.env,
      WEQ_SYNC_ELECTRON_PROFILE: join(temporary, 'profile'),
      WEQ_SYNC_SCENE_URL: desktopUrl,
    },
  });
  const desktop = await electron.firstWindow();
  await desktop.emulateMedia({ reducedMotion: 'reduce' });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }),
    browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }),
  ]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const pageErrors = [];
  for (const page of [desktop, ...pages])
    page.on('pageerror', (error) => pageErrors.push(error.message));
  await desktop.waitForFunction(() => window.syncQa?.preferences.getState().ready);
  await Promise.all(pages.map((page) => page.goto(webUrl)));
  await Promise.all(
    pages.map((page) => page.waitForFunction(() => window.syncQa?.preferences.getState().ready)),
  );
  for (const page of [desktop, ...pages]) {
    await page.waitForFunction(() => window.syncFirstPaint?.height > 0);
    assert.equal(await page.evaluate(() => window.syncFirstCommit.count), 80);
    assert.equal(await page.evaluate(() => window.syncFirstPaint.count), 80);
  }
  await pages[0].getByLabel('界面背景', { exact: true }).selectOption('grid');
  for (const page of [desktop, ...pages])
    await page.waitForFunction(() => document.documentElement.dataset.background === 'grid');
  await desktop.getByLabel('界面背景', { exact: true }).selectOption('dots');
  for (const page of pages)
    await page.waitForFunction(() => document.documentElement.dataset.background === 'dots');
  await pages[1].getByLabel('界面背景', { exact: true }).selectOption('paper');
  await pages[0].waitForFunction(() => document.documentElement.dataset.background === 'paper');
  await desktop.waitForFunction(() => document.documentElement.dataset.background === 'paper');
  for (const page of [desktop, ...pages])
    assert.equal(await page.getByLabel('设置作用范围').count(), 0);
  await pages[0].evaluate(() =>
    window.syncQa.client.clientState.patch.mutate({
      preference: 'dark',
      privacyMode: true,
      capturePrivacy: true,
    }),
  );
  for (const page of [desktop, ...pages]) {
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.theme === 'dark' &&
        document.documentElement.hasAttribute('data-privacy') &&
        window.syncQa.privacy.getState().capturePrivacy,
    );
  }
  await desktop.evaluate(() =>
    window.syncQa.client.clientState.patch.mutate({ privacyMode: false, capturePrivacy: false }),
  );
  await pages[0].evaluate(() =>
    window.syncQa.client.bootstrap.setRenderTextMarkdown.mutate({ enabled: false }),
  );
  for (const page of [desktop, ...pages]) await page.waitForSelector('[data-markdown="false"]');
  await pages[0].evaluate(() =>
    window.syncQa.client.bootstrap.setAutoFollowLatestMessages.mutate({ enabled: false }),
  );
  await desktop.evaluate(() =>
    window.syncQa.client.bootstrap.setChatImageCacheMiB.mutate({ miB: 32 }),
  );
  for (const page of [desktop, ...pages]) {
    await page.waitForSelector('[data-follow="false"]');
    await page.waitForSelector('[data-cache="32"]');
  }
  await pages[0].evaluate(() =>
    window.syncQa.client.clientState.accountPatch.mutate({
      expectedAccountUin: '10001',
      expectedAccountConfigId: '10001_fixture',
      namespace: 'pins',
      values: { 123: true },
    }),
  );
  for (const page of [desktop, ...pages]) await page.waitForSelector('[data-pin="true"]');
  await pages[1].evaluate(() =>
    window.syncQa.client.clientState.accountPatch.mutate({
      expectedAccountUin: '10001',
      expectedAccountConfigId: '10001_fixture',
      namespace: 'pins',
      values: { 123: false },
    }),
  );
  await pages[0].evaluate(() =>
    window.syncQa.client.clientState.accountPatch.mutate({
      expectedAccountUin: '10001',
      expectedAccountConfigId: '10001_fixture',
      namespace: 'pins',
      values: { 123: true },
      seed: true,
    }),
  );
  for (const page of [desktop, ...pages]) await page.waitForSelector('[data-pin="false"]');
  const originalDraft = await pages[0].evaluate(() =>
    window.syncQa.client.clientState.saveDraft.mutate({
      expectedAccountUin: '10001',
      expectedAccountConfigId: '10001_fixture',
      key: 'assistant:fixture',
      value: '第一端草稿',
      expectedVersion: null,
    }),
  );
  assert.equal(originalDraft.ok, true);
  await pages[1].evaluate(() => {
    window.syncDraftResult = window.syncQa.resolveDraftSave(
      'assistant:fixture',
      '第二端草稿',
      null,
      (expectedVersion) =>
        window.syncQa.client.clientState.saveDraft.mutate({
          expectedAccountUin: '10001',
          expectedAccountConfigId: '10001_fixture',
          key: 'assistant:fixture',
          value: '第二端草稿',
          expectedVersion,
        }),
    );
  });
  await pages[1].setViewportSize({ width: 320, height: 900 });
  await pages[1].getByRole('heading', { name: '发现另一份草稿' }).waitFor();
  await pages[1].screenshot({ path: join(artifacts, 'conflict-320.png') });
  await pages[1].getByRole('button', { name: '另存副本', exact: true }).click();
  await pages[1].evaluate(() => window.syncDraftResult);
  await pages[1].getByLabel('冲突副本', { exact: true }).waitFor();
  assert.equal(
    await pages[1]
      .locator('.weq-modal')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    '副本对话框横向溢出',
  );
  await pages[1].screenshot({ path: join(artifacts, 'copies-320.png') });
  await pages[1].keyboard.press('Escape');
  assert.equal(
    await pages[0].evaluate(() =>
      window.syncQa.client.clientState.draftCopies
        .query({ expectedAccountUin: '10001', expectedAccountConfigId: '10001_fixture' })
        .then((rows) => rows.length),
    ),
    1,
  );
  await pages[0].evaluate(
    (expectedVersion) =>
      window.syncQa.client.clientState.saveDraft.mutate({
        expectedAccountUin: '10001',
        expectedAccountConfigId: '10001_fixture',
        key: 'assistant:fixture',
        value: '',
        expectedVersion,
      }),
    originalDraft.current.version,
  );
  const staleDraft = await pages[1].evaluate(
    (expectedVersion) =>
      window.syncQa.client.clientState.saveDraft.mutate({
        expectedAccountUin: '10001',
        expectedAccountConfigId: '10001_fixture',
        key: 'assistant:fixture',
        value: '迟到旧稿',
        expectedVersion,
      }),
    originalDraft.current.version,
  );
  assert.equal(staleDraft.ok, false);
  // 独立 Web 存储在断线后补读共享值，不依赖浏览器 storage 事件。
  await contexts[0].setOffline(true);
  await pages[1].getByLabel('界面背景', { exact: true }).selectOption('telegram');
  await contexts[0].setOffline(false);
  await pages[0].reload();
  await pages[0].waitForFunction(() => document.documentElement.dataset.background === 'telegram');
  let scenes = 0;
  for (const width of [320, 390, 1280]) {
    await pages[1].setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await pages[1].evaluate(
        (value) => window.syncQa.theme.getState().setPreference(value),
        theme,
      );
      await pages[1].evaluate(
        () =>
          new Promise((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
          ),
      );
      assert.equal(await pages[1].locator('.sync-message:visible').count(), 80);
      assert.equal(
        await pages[1].evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        '横向溢出',
      );
      await pages[1].screenshot({ path: join(artifacts, `${width}-${theme}.png`) });
      scenes++;
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      passed: true,
      clients: ['Electron', 'Web 手机视口', 'Web 桌面视口'],
      scenes,
      artifacts,
    }),
  );
} finally {
  await electron?.close();
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolveExit) => backend.once('exit', resolveExit));
  }
  await rm(temporary, { recursive: true, force: true });
}

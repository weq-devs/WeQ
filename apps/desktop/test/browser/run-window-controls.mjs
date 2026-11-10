import assert from 'node:assert/strict';
import { createServer, build as buildRenderer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
let temporary;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_WINDOW_CONTROLS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const platform of ['darwin', 'linux', 'win32']) {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 760 },
      reducedMotion: 'reduce',
    });
    await page.addInitScript((platform) => {
      window.electron = { process: { platform } };
    }, platform);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/test/browser/window-controls.html`);
    await page.getByText('提醒与窗口', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('switch', { name: '使用仿 Windows 窗口按钮' }).count(),
      platform === 'win32' ? 0 : 1,
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const store = window.windowControlsTheme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        store.setBackground(theme === 'light' ? 'grid' : 'telegram');
      }, theme);
      for (const width of [1180, 640]) {
        await page.setViewportSize({ width, height: 760 });
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (output)
          await page.screenshot({ path: resolve(output, `${platform}-${theme}-${width}.png`) });
        cases++;
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(
    `${origin}/src/renderer/window-controls.html?title=${encodeURIComponent('WeQ · 独立工具窗口与报告预览')}`,
  );
  await page.getByRole('button', { name: '最小化' }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('weq.theme-preference', theme);
    }, theme);
    await page.reload();
    for (const width of [320, 1000]) {
      await page.setViewportSize({ width, height: 32 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const bounds = await page.getByRole('button', { name: '关闭', exact: true }).boundingBox();
      assert.equal(bounds.height, 32);
      assert.equal(Math.round(bounds.x + bounds.width), width);
      if (output) await page.screenshot({ path: resolve(output, `header-${theme}-${width}.png`) });
      cases++;
    }
  }
  await page.close();
  await mkdir(resolve(root, '.artifacts'), { recursive: true });
  temporary = await mkdtemp(resolve(root, '.artifacts/window-controls-'));
  await buildRenderer({
    configFile: false,
    base: './',
    root: resolve(root, 'src/renderer'),
    plugins: [react(), tailwind()],
    build: {
      outDir: resolve(temporary, 'renderer'),
      rollupOptions: { input: resolve(root, 'src/renderer/window-controls.html') },
    },
  });
  const entry = resolve(temporary, 'main/controls.mjs');
  await build({
    stdin: {
      contents:
        "export * from './src/main/window_controls'; export * from './src/main/window_controls_events';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: entry,
  });
  for (const mode of ['development', 'built'])
    await new Promise((resolvePromise, reject) => {
      const child = spawn(
        require('electron'),
        [resolve(root, 'test/electron/window_controls.cjs')],
        {
          cwd: root,
          stdio: 'inherit',
          env: {
            ...process.env,
            WEQ_WINDOW_CONTROLS_MODULE: entry,
            ELECTRON_RENDERER_URL: mode === 'development' ? `${origin}/src/renderer` : '',
          },
        },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`Electron: ${code}`)),
      );
    });
  console.log(`PASS: ${cases} 个设置与标题栏视觉场景，Electron 真实按钮链路通过`);
} finally {
  await browser?.close();
  await server.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

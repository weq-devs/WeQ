import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { createDevelopmentReload } = await tsImport(
  '../../src/main/development_reload.ts',
  import.meta.url,
);
const reload = createDevelopmentReload();
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-development-reload-test'),
  plugins: [reload.rendererPlugin(), react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  optimizeDeps: {
    entries: ['test/browser/development-reload.html'],
    include: ['react', 'react/jsx-dev-runtime', 'react-dom/client', 'zustand', 'lucide-react'],
  },
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, watch: null },
});
let browser;
let restarts = 0;
let cases = 0;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_RELOAD_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/development-reload.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#81c995' : '#b5243e',
        );
        window.reloadFixtureId = Math.random();
      }, theme);
      const instance = await page.evaluate(() => window.reloadFixtureId);
      server.ws.send({ type: 'full-reload', path: '*' });
      const banner = page.getByRole('status');
      await banner.filter({ hasText: '点击重载' }).waitFor();
      assert.equal(await page.evaluate(() => window.reloadFixtureId), instance);
      const first = await banner.getAttribute('class');
      for (let count = 0; count < 4; count++) server.ws.send({ type: 'full-reload', path: '*' });
      reload.built('main', () => {
        restarts++;
      });
      await banner.filter({ hasText: '点击重启' }).waitFor();
      assert.equal(await banner.count(), 1);
      assert.equal(await banner.getAttribute('class'), first);
      assert.equal(await page.locator('.lucide-refresh-cw').count(), 1);
      const box = await banner.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      const before = restarts;
      if (width === 390) await banner.locator('h3').click();
      else await page.getByRole('button', { name: '重启应用', exact: true }).press('Enter');
      await banner.waitFor({ state: 'detached' });
      assert.equal(restarts, before + 1);
      reload.built('preload', () => {});
      await page.getByRole('status').waitFor();
      const pendingId = reload.status().id;
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('status').waitFor({ state: 'detached' });
      reload.built('preload', () => {});
      await page.waitForTimeout(150);
      assert.equal(await page.getByRole('status').count(), 0, '关闭后不再提示同一批');
      reload.apply(pendingId);
      server.ws.send({ type: 'full-reload', path: '*' });
      await page.getByRole('button', { name: '重载界面', exact: true }).waitFor();
      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: '重载界面', exact: true }).click(),
      ]);
      assert.equal(
        await page.evaluate(() => window.reloadFixtureId),
        undefined,
        '点击后才真正重载页面',
      );
      assert.equal(await page.getByRole('status').count(), 0, '已应用的更新不重复提示');
      await page.close();
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${cases} 个深浅主题／手机桌面组合：手动应用、原位合并、关闭去重、重载图标和可见范围`,
  );
} finally {
  await browser?.close();
  await server.close();
}

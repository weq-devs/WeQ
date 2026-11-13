import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-audit'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const out = process.env.WEQ_SETTINGS_AUDIT_ARTIFACTS;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WEQ_BROWSER_EXECUTABLE,
  });
  if (out) await mkdir(out, { recursive: true });
  const errors = [];
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const base = (error) =>
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-sync-status.html${error ? '?error=1' : ''}`;
  const results = [];
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.goto(base(false));
      await page.evaluate((theme) => {
        window.syncStatusQa.theme.getState().setPreference(theme);
        window.syncStatusQa.theme.getState().setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      await page.waitForTimeout(600);
      assert.equal(await page.locator('.weq-sync-status').count(), 0);
      await page.evaluate(() =>
        window.syncStatusQa.preferences.setState({
          error: '共享设置读取失败：无法连接电脑端服务，修改暂时只保存在本机。',
        }),
      );
      await page.locator('.weq-sync-status').waitFor();
      const fits = await page.locator('.weq-sync-status').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
        );
      });
      assert.equal(fits, true, `同步提示溢出：${width}/${theme}`);
      if (out) await page.screenshot({ path: resolve(out, `sync-error-${width}-${theme}.png`) });
      results.push({ width, theme, fits });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors: errors.slice(0, 6) }, null, 1));
} finally {
  await browser?.close();
  await server.close();
}

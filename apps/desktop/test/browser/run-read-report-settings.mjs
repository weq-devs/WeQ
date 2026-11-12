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
  cacheDir: resolve(root, 'node_modules/.vite-read-report-settings'),
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_READ_REPORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-audit.html?section=chat-messages&settingId=read-sync`,
      );
      await page.evaluate((theme) => {
        window.settingsAuditQa.theme.getState().setPreference(theme);
        window.settingsAuditQa.theme
          .getState()
          .setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      const row = page.locator('[data-setting-id="read-sync"]');
      await row.waitFor();
      assert.equal(await row.count(), 1);
      const card = row.locator('xpath=ancestor::section[contains(@class,"weq-set-card")][1]');
      assert.equal(await card.locator('.weq-set-card-title').textContent(), '未读提醒');
      assert.equal(await page.locator('.weq-set-card .weq-set-card').count(), 0);
      const toggle = row.getByRole('switch', { name: '向 QQ 服务器上报已读位置', exact: true });
      await toggle.scrollIntoViewIfNeeded();
      const labelBounds = await row.locator('.weq-set-row-label').boundingBox();
      const toggleBounds = await toggle.boundingBox();
      assert(labelBounds && toggleBounds && labelBounds.x + labelBounds.width <= toggleBounds.x);
      assert(
        await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
        '已读上报设置行不应横向溢出',
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

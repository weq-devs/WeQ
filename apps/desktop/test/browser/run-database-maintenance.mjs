import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const stub = resolve(root, 'test/browser/database-maintenance.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-database-maintenance'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/(QqAvatar|Toast|useQQAutoRefresh)$/, replacement: stub },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_MAINTENANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1060])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 780 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-maintenance.html`,
      );
      await page.waitForFunction(() => window.maintenanceQa);
      await page.evaluate((theme) => {
        const store = window.maintenanceQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#006d50' : '#ffe593');
        window.maintenanceQa.checkup();
      }, theme);
      await page.getByText('34.8%', { exact: true }).waitFor();
      const capture = async (name) => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const overflows = await page.locator('.weq-db-progress *').evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.width > 0 &&
                (box.left < -1 ||
                  box.right > innerWidth + 1 ||
                  node.scrollWidth > node.clientWidth + 1)
              );
            })
            .map((node) => node.className),
        );
        assert.deepEqual(overflows, []);
        if (output)
          await page.screenshot({
            path: `${output}/${name}-${width}-${theme}.png`,
            fullPage: true,
          });
        cases++;
      };
      await capture('checkup');
      await page.getByRole('button', { name: '跳过体检，直接选数据库 →' }).click();
      await page.locator('.weq-rp-pick').first().click();
      await page.getByRole('button', { name: '开始修复', exact: true }).click();
      await page.getByRole('button', { name: '确认替换并修复', exact: true }).click();
      await page.evaluate(() => window.maintenanceQa.repair());
      await page.getByText('62.4%', { exact: true }).waitFor();
      const consoleBox = await page.locator('.weq-db-progress').boundingBox();
      assert.ok(consoleBox && consoleBox.y >= 0 && consoleBox.y + 190 < 780);
      assert.equal(await page.locator('.weq-rp-preparation').getAttribute('open'), null);
      await capture('repair');
      await page.evaluate(() => window.maintenanceQa.repair('Repair'));
      assert.equal(
        await page
          .locator('.weq-db-progress > .weq-task-progress-track progress')
          .getAttribute('value'),
        null,
      );
      await capture('rebuild');
      await page.evaluate(() => window.maintenanceQa.disconnect());
      await page
        .getByText('进度连接中断，正在重新连接；任务结果尚未确认。', { exact: true })
        .waitFor();
      await capture('disconnected');
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, firstViewport: true, responsive: true }));
} finally {
  await browser?.close();
  await server.close();
}

import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-datetime'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/datetime.html'] },
  resolve: {
    alias: [
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
let browser;
const output = process.env.WEQ_TIME_ARTIFACTS;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({ timezoneId: 'America/New_York', hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/datetime.html`,
  );
  await page.locator('.compact-time').waitFor();
  assert.equal(await page.locator('.compact-time').textContent(), '14:05');
  assert.equal(await page.getByTestId('chinese-date').textContent(), '2026 年 3 月 4 日');
  assert.equal(await page.getByTestId('relative-time').textContent(), '3 分钟前');
  assert.equal(await page.getByTestId('duration').textContent(), '1 天 1 小时 1 分钟 1 秒');
  assert.equal(
    await page.locator('.weq-birth-details summary span').textContent(),
    '2010 年（推断） · 水瓶座',
  );
  await page.locator('.weq-birth-details summary').click();
  assert.equal(
    await page.locator('.weq-birth-details p').textContent(),
    '推断生日：2010 年 1 月 20 日至 2 月 18 日',
  );
  assert.equal(
    await page.getByTestId('source-text').textContent(),
    '原文2026年11月16日，耗时3秒，QQ12345',
  );
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await page.locator('.composer-send strong').evaluate((node) => {
          const label = node.getBoundingClientRect();
          const button = node.closest('button').getBoundingClientRect();
          return label.left >= button.left && label.right <= button.right;
        }),
        true,
      );
      await page.mouse.move(0, 0);
      await page.locator('.compact-time').hover();
      try {
        await page.getByRole('tooltip').waitFor({ timeout: 5000 });
      } catch (error) {
        console.log(
          JSON.stringify({
            width,
            theme,
            errors,
            time: await page.locator('.compact-time').evaluate((element) => element.outerHTML),
            tooltips: await page.locator('[role="tooltip"]').count(),
          }),
        );
        throw error;
      }
      assert.equal(
        await page.getByRole('tooltip').textContent(),
        '2026-03-04 14:05:06.789（北京时间）',
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
  await page.keyboard.press('Tab');
  await page.locator('.compact-time').focus();
  await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.compact-time').tap();
  await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByTestId('opened').textContent(), '打开次数 0');
  await page.keyboard.press('Escape');
  await page.locator('input[type="datetime-local"]').fill('2026-03-04T14:05:07');
  assert.equal(await page.locator('output').textContent(), '2026-03-04 14:05:07');
  await page.getByTestId('scroller').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.deepEqual(errors, []);
  const result = {
    viewports: 6,
    timezone: 'America/New_York',
    checks: [
      'beijing-seconds',
      'chinese-date-and-duration-spacing',
      'birthday-inference-spacing',
      'mute-label-fits',
      'source-text-unchanged',
      'true-milliseconds',
      'no-overflow',
      'hover',
      'keyboard',
      'touch-without-opening-row',
      'seconds-input-roundtrip',
      'scroll',
    ],
    errors,
  };
  if (output) await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}

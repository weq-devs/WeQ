import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-performance-monitor'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/performance-monitor.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/performance-monitor.html`;
  const output = process.env.WEQ_PERFORMANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const host of ['desktop', 'web']) {
    await page.goto(`${url}?host=${host}`);
    await page.getByLabel('记录档位').waitFor();
    await page.getByRole('button', { name: '完整记录', exact: true }).click();
    await page.waitForFunction(() => window.performanceQa.changes.length === 1);
    assert.equal(
      await page.evaluate(() => window.performanceQa.changes[0].fullDurationMinutes),
      60,
    );
    assert.equal(
      await page
        .getByRole('button', { name: '完整记录', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    await page.getByLabel('进程', { exact: true }).selectOption('2:2');
    await page
      .locator('.weq-perf-chart svg')
      .first()
      .click({ position: { x: 180, y: 70 } });
    await page.getByText('同步 1.2 ms', { exact: false }).waitFor();
    await page.getByLabel('明细类别').selectOption('resources');
    await page.getByText('受管图片', { exact: false }).waitFor();
    await page.getByLabel('进程', { exact: true }).selectOption('');
    const beforeKey = await page.evaluate(() => window.performanceQa.detailIds.at(-1));
    const graph = page.locator('.weq-perf-chart svg').first();
    await graph.focus();
    await graph.press('ArrowRight');
    await graph.press('ArrowRight');
    assert.ok(
      await page.evaluate((before) => window.performanceQa.detailIds.at(-1) > before, beforeKey),
    );
    await page.getByLabel('进程', { exact: true }).selectOption('2:2');
    await page.getByRole('button', { name: '放大时间轴' }).click();
    await page.getByLabel('开始时间').waitFor();
    await page.getByRole('button', { name: 'CSV', exact: true }).click();
    assert.equal(await page.evaluate(() => window.performanceQa.exports.length), 1);
    for (const width of [1180, 390, 320])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'light' ? '#006d50' : '#f5cb70',
          );
        }, theme);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${host}-${width}-${theme}.png`),
            fullPage: true,
          });
      }
    await page.getByRole('button', { name: '跟随最新', exact: true }).click();
    await page.evaluate(() => {
      window.performanceQa.requests = [];
      window.performanceQa.setActive(false);
    });
    await page.waitForTimeout(100);
    assert.ok(
      await page.evaluate(() =>
        window.performanceQa.requests
          .filter((row) => row.route !== 'detail')
          .every((row) => !row.enabled),
      ),
    );
  }
  for (const state of ['empty', 'error']) {
    await page.goto(`${url}?state=${state}`);
    await page
      .getByText(state === 'empty' ? '此时间范围暂无记录' : '历史读取失败：合成读取失败', {
        exact: false,
      })
      .waitFor();
  }
  await page.goto(url);
  await page.getByLabel('记录档位').waitFor();
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清空历史', exact: true }).click();
  await page.getByText('此时间范围暂无记录').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    '性能监视桌面/Web 视图、档位、明细、缩放、导出、清空、空/失败状态和 320/390/1180px 浅深主题通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

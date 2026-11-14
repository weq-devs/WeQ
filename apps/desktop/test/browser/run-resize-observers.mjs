import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/resize-observers-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
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
const results = [];
const output = process.env.WEQ_RESIZE_ARTIFACTS;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  for (const [width, theme] of [
    [1280, 'light'],
    [1280, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.addInitScript(() => {
      window.resizeErrors = [];
      window.addEventListener('error', (event) => window.resizeErrors.push(event.message));
    });
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    const frames = (count = 8) =>
      page.evaluate(async (count) => {
        for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame);
      }, count);
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?resize-diagnostics&composer-actions&count=3000`,
      );
      await page.locator('.weq-virtual-timeline-row').first().waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = theme === 'light' ? 'paper' : 'dots';
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#15764a' : '#ebbd51',
        );
      }, theme);
      await frames();
      for (const id of ['row-1500', 'row-2000']) {
        await page.evaluate((id) => window.timelineTest.jump(id), id);
        await page.locator(`[data-message-id="${id}"]`).waitFor();
        await frames();
      }
      await page.evaluate(() => window.timelineTest.grow('row-1999'));
      await frames();
      if (width > 760) {
        const geometry = await page.evaluate(async () => {
          const scroll = document.querySelector('.message-scroll');
          const bounds = scroll.getBoundingClientRect();
          const row = [...scroll.querySelectorAll('.weq-virtual-timeline-row')].find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top > bounds.top && rect.bottom < bounds.bottom && row.nextElementSibling;
          });
          if (!row) throw new Error('缺少可见的动态行高测试目标');
          const next = row.nextElementSibling;
          const id = row.querySelector('[data-message-id]').getAttribute('data-message-id');
          return new Promise((resolve) => {
            const observer = new ResizeObserver(() => {
              observer.disconnect();
              resolve({
                bottom: row.getBoundingClientRect().bottom,
                nextTop: next.getBoundingClientRect().top,
              });
            });
            observer.observe(row);
            window.timelineTest.grow(id);
          });
        });
        assert(
          geometry.nextTop >= geometry.bottom + 16,
          `动态增高在首帧重叠: ${JSON.stringify(geometry)}`,
        );
        await frames();
      }
      await page.evaluate(() => window.timelineTest.enterSelection());
      await frames();
      await page.evaluate(() => window.timelineTest.exitSelection());
      await frames();
      await page.evaluate(() => window.timelineTest.prepend());
      await frames();
      await page.evaluate(() => window.timelineTest.setCount(30));
      await frames();
      await page.evaluate(() => window.timelineTest.setCount(3000));
      await frames();
      await page.setViewportSize({ width: width - 80, height: 740 });
      await frames();
      await page.setViewportSize({ width, height: 900 });
      await frames();
      await page.locator('.message-scroll').hover();
      for (const delta of [1200, -900, 1800, -1200]) {
        await page.mouse.wheel(0, delta);
        await frames();
      }
      const files = page.locator('.composer input[type="file"]:not([accept])');
      await files.setInputFiles([
        { name: 'resize-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') },
      ]);
      await page.locator('.composer-media-tray').waitFor();
      await frames();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await page.getByRole('button', { name: '移除 resize-fixture.txt', exact: true }).click();
      await frames();
      const result = await page.evaluate(() => ({
        windowErrors: window.resizeErrors,
        reports: window.timelineTest.resizeReports(),
        rows: document.querySelectorAll('.weq-virtual-timeline-row').length,
      }));
      results.push({ width, theme, ...result, errors });
      assert.deepEqual(errors, []);
      assert(result.rows > 0 && result.rows < 100);
    } finally {
      await page.close();
    }
  }
  console.log(JSON.stringify({ results }));
  if (output) await writeFile(resolve(output, 'report.json'), JSON.stringify({ results }, null, 2));
  assert(
    results.every(({ windowErrors }) => windowErrors.length === 0),
    '尺寸监听仍产生未交付通知',
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

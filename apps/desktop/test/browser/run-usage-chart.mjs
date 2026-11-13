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
  cacheDir: resolve(root, 'node_modules/.vite-usage-chart'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/usage-chart.html'] },
  resolve: {
    alias: [{ find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') }],
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
const output = process.env.WEQ_USAGE_ARTIFACTS;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/usage-chart.html`,
  );
  await page.locator('.weq-usage-line-dot').first().waitFor();
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1818, 960, 390, 320]) {
    await page.setViewportSize({ width, height: 500 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#007ebd' : '#6ed4b0',
        );
      }, theme);
      for (const reducedMotion of ['no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion });
        for (const busy of [false, true]) {
          if (busy) await page.getByRole('button').click();
          await page.waitForFunction(() => {
            const svg = document.querySelector('.weq-usage-line-svg');
            return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 0.1;
          });
          const metrics = await page.evaluate(() => {
            const svg = document.querySelector('.weq-usage-line-svg');
            const path = svg.querySelector('.weq-usage-line-stroke');
            const style = getComputedStyle(path);
            const dots = [...svg.querySelectorAll('circle')];
            const first = dots[0].getBoundingClientRect();
            const last = dots.at(-1).getBoundingClientRect();
            const labels = [...document.querySelectorAll('.weq-usage-line-axis span')];
            return {
              dash: style.strokeDasharray,
              length: path.getTotalLength(),
              round: Math.abs(first.width - first.height) < 0.1,
              ticksAligned: labels.every((label, index) => {
                const tick = label.getBoundingClientRect();
                const dot = dots[index * 3].getBoundingClientRect();
                return Math.abs(tick.x + tick.width / 2 - dot.x - dot.width / 2) < 0.5;
              }),
              overflow: document.documentElement.scrollWidth > innerWidth,
              lastVisible: last.right <= innerWidth && last.left >= 0,
            };
          });
          assert.equal(metrics.dash, 'none', '折线必须连续，不能按固定长度截断');
          if (busy) assert.ok(metrics.length > 1000, '回归样本必须超过旧的虚线长度');
          assert.equal(metrics.round, true, '数据点不可拉伸为椭圆');
          assert.equal(metrics.ticksAligned, true, '时刻必须对齐对应数据点');
          assert.equal(metrics.overflow, false);
          assert.equal(metrics.lastVisible, true);
          await page.locator('.weq-usage-line-dot').nth(22).hover();
          await page.locator('.weq-usage-line-tooltip').waitFor();
          const tooltip = await page.locator('.weq-usage-line-tooltip').boundingBox();
          assert.ok(tooltip.x >= 0 && tooltip.x + tooltip.width <= width);
          await page.mouse.move(0, 0);
          if (output && !busy && reducedMotion === 'no-preference') {
            await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
          }
          if (busy) await page.getByRole('button').click();
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('用量折线图：32 组尺寸/主题/动态效果/数据组合通过，含缩放、末点提示与刻度对齐。');
} finally {
  await browser?.close();
  await server.close();
}

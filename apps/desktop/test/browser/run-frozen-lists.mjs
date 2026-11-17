import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_FROZEN_LIST_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-frozen-lists'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/frozen-lists.html'] },
  resolve: {
    alias: [
      {
        find: /^(?:\.\.\/)+trpc\/client$/,
        replacement: resolve(root, 'test/browser/api-usage.stub.ts'),
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
    executablePath: process.env.WEQ_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const scroll = async (container, x, y) => {
    await page.locator(container).evaluate(
      (element, { x, y }) => {
        element.scrollLeft = x;
        element.scrollTop = y;
      },
      { x, y },
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const box = async (selector) => page.locator(selector).first().boundingBox();
  const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 2, `${label}: ${a} != ${b}`);
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/frozen-lists.html`,
      );
      await page.locator('.weq-ov-matrix-cell').first().waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#81c995' : '#b5243e',
        );
      }, theme);
      for (let labels = 0; labels < 2; labels++) {
        const scroller = '.weq-ov-matrix-scroll';
        const corner = await box('.weq-ov-matrix-corner');
        const row = await box('.weq-ov-matrix-rowhead');
        const head = await box('.weq-ov-matrix-head');
        await scroll(scroller, 220, 200);
        near((await box('.weq-ov-matrix-corner')).x, corner.x, 'matrix corner x');
        near((await box('.weq-ov-matrix-corner')).y, corner.y, 'matrix corner y');
        near((await box('.weq-ov-matrix-rowhead')).x, row.x, 'matrix row label x');
        near((await box('.weq-ov-matrix-head')).y, head.y, 'matrix column label y');
        near(
          (await box('.weq-ov-matrix-rowhead')).y,
          row.y - 200,
          'matrix row follows vertical scroll',
        );
        near(
          (await box('.weq-ov-matrix-head')).x,
          head.x - 220,
          'matrix column follows horizontal scroll',
        );
        assert.equal(
          await page.locator(scroller).evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return !!document
              .elementFromPoint(bounds.left + 2, bounds.top + 80)
              ?.closest('.weq-ov-matrix-rowheads');
          }),
          true,
          'matrix left edge must mask scrolling cells',
        );
        const target = await page.locator(scroller).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          for (let offset = 0; offset < 40; offset += 5) {
            const hit = document.elementFromPoint(bounds.right - 32 - offset, bounds.bottom - 32);
            const cell = hit?.closest('.weq-ov-matrix-cell');
            if (cell) return cell.getAttribute('title');
          }
          return null;
        });
        assert.ok(target?.includes('共同成员'), 'frozen labels must not block visible cells');
        await page.getByTitle(target, { exact: true }).click();
        assert.ok(await page.locator('output').textContent());
        if (output)
          await page.screenshot({
            path: resolve(output, `matrix-${labels}-${width}-${theme}.png`),
          });
        await scroll(scroller, 100000, 100000);
        near((await box('.weq-ov-matrix-corner')).x, corner.x, 'matrix corner at right edge');
        near((await box('.weq-ov-matrix-corner')).y, corner.y, 'matrix corner at bottom edge');
        near((await box('.weq-ov-matrix-rowhead')).x, row.x, 'matrix row label at right edge');
        near((await box('.weq-ov-matrix-head')).y, head.y, 'matrix column label at bottom edge');
        await scroll(scroller, 0, 0);
        await page.getByRole('button', { name: '切换矩阵标签' }).click();
      }
      const database = '[data-fixture="database"] .weq-cache-grid-scroll';
      const number = await box(`${database} tbody .weq-cache-grid-rownum`);
      const header = await box(`${database} thead th`);
      await scroll(database, 400, 180);
      near(
        (await box(`${database} tbody .weq-cache-grid-rownum`)).x,
        number.x,
        'database row number',
      );
      near((await box(`${database} thead th`)).y, header.y, 'database header');
      near((await box(`${database} thead th`)).x, number.x, 'database corner');
      for (const [fixture, scroller, head] of [
        ['files', '.weq-file-manager-table-scroll', '.weq-file-manager-table thead th'],
        ['usage', '[data-fixture="usage"]', '.weq-usage-accounting-table thead th'],
        ['notifications', '[data-fixture="notifications"]', '.weq-notification-table thead th'],
      ]) {
        await page.locator(`[data-fixture="${fixture}"]`).scrollIntoViewIfNeeded();
        const bounds = await box(scroller);
        await scroll(scroller, 0, 200);
        near(
          (await box(head)).y,
          bounds.y + (fixture === 'notifications' ? 15 : 0),
          `${fixture} header`,
        );
        const color = await page
          .locator(head)
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        assert.ok(!['rgba(0, 0, 0, 0)', 'transparent'].includes(color), `${fixture} opaque header`);
        if (output)
          await page.screenshot({ path: resolve(output, `${fixture}-${width}-${theme}.png`) });
      }
      await page.locator('[data-fixture="hex"]').scrollIntoViewIfNeeded();
      const offset = await box('.weq-cap-hx-off');
      await scroll('.weq-cap-hexdump-body', 180, 160);
      near((await box('.weq-cap-hx-off')).x, offset.x, 'hex address');
      const addressBackground = await page
        .locator('.weq-cap-hx-off')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      assert.ok(
        !['rgba(0, 0, 0, 0)', 'transparent'].includes(addressBackground),
        'hex opaque address',
      );
      assert.equal(
        await page.locator('.weq-cap-hexdump-body').evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return !!document
            .elementFromPoint(bounds.left + 2, bounds.top + 16)
            ?.closest('.weq-cap-hx-off');
        }),
        true,
        'hex left edge must mask scrolling bytes',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output) await page.screenshot({ path: resolve(output, `hex-${width}-${theme}.png`) });
    }
  assert.deepEqual(errors, []);
  console.log(
    '长列表冻结：桌面／手机、深浅主题通过；矩阵双轴、数据库行号与交叉角、三类表头、十六进制地址及矩阵点击。',
  );
} finally {
  await browser?.close();
  await server.close();
}

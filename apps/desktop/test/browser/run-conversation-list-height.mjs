import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_BROWSER_ENGINE ?? 'chromium';
const heights = process.env.WEQ_LIST_HEIGHTS?.split(',').map(Number) ?? [1000, 480, 1100];
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, `node_modules/.vite-list-height-${engine}`),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  browser = await engines[engine].launch({
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
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-list-height.html`,
    );
    await page.locator('.conversation-row').first().waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const store = window.listHeightQa.store.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        store.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      for (const height of heights) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(100);
        const check = await page.evaluate(() => {
          const sidebar = document.querySelector('.sidebar-body');
          const list = document.querySelector('[data-weq-windowed-list]');
          const row = list.querySelector('.conversation-row');
          return {
            bottomGap: sidebar.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom,
            outerOverflow: sidebar.scrollHeight - sidebar.clientHeight,
            listHeight: list.clientHeight,
            sidebarHeight: sidebar.clientHeight,
            rows: list.querySelectorAll('.conversation-row').length,
            rowHeight: row.getBoundingClientRect().height,
          };
        });
        results.push({ width, height, theme, ...check });
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${height}-${theme}.png`) });
        assert.ok(Math.abs(check.bottomGap) <= 1, JSON.stringify(results.at(-1)));
        assert.ok(check.outerOverflow <= 1, JSON.stringify(results.at(-1)));
        assert.ok(check.sidebarHeight > height - 200, JSON.stringify(results.at(-1)));
        assert.ok(check.rows < 40, '列表必须保持虚拟滚动');
        await page.locator('[data-weq-windowed-list]').evaluate((list) => {
          list.scrollTop = list.scrollHeight;
        });
        await page.waitForTimeout(50);
        const endGap = await page.evaluate(() => {
          const list = document.querySelector('[data-weq-windowed-list]');
          const rows = [...list.querySelectorAll('.conversation-row')];
          return list.getBoundingClientRect().bottom - rows.at(-1).getBoundingClientRect().bottom;
        });
        assert.ok(Math.abs(endGap) <= 1, `末行后出现空白：${endGap}`);
        await page.locator('[data-weq-windowed-list]').evaluate((list) => {
          list.scrollTop = 0;
        });
        await page.waitForTimeout(50);
        const overscroll = await page.evaluate(async () => {
          const list = document.querySelector('[data-weq-windowed-list]');
          let prototype = list;
          while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'scrollTop'))
            prototype = Object.getPrototypeOf(prototype);
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop');
          const writes = [];
          let physicalTop = 0;
          // 桌面引擎不一定产生手机回弹；用真实列表覆盖负偏移和异步父级刷新。
          Object.defineProperty(list, 'scrollTop', {
            configurable: true,
            get: () => physicalTop,
            set: (value) => {
              writes.push(value);
              descriptor.set.call(list, value);
              physicalTop = descriptor.get.call(list);
            },
          });
          const initial = list.querySelector('.conversation-row').getBoundingClientRect().top;
          const samples = [];
          try {
            for (const offset of [0, -12, -64, -100, -48, -8, 0]) {
              physicalTop = offset;
              list.dispatchEvent(new Event('scroll'));
              window.listHeightQa.refresh();
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
              samples.push({
                offset,
                physicalTop: list.scrollTop,
                rowDelta:
                  list.querySelector('.conversation-row').getBoundingClientRect().top - initial,
                rows: list.querySelectorAll('.conversation-row').length,
              });
            }
            return { writes, samples };
          } finally {
            delete list.scrollTop;
          }
        });
        assert.deepEqual(overscroll.writes, [], '回弹或父级刷新不能重新定位原生滚动');
        assert.ok(
          overscroll.samples.every(
            (sample) => sample.offset === sample.physicalTop && Math.abs(sample.rowDelta) <= 1,
          ),
          JSON.stringify(overscroll),
        );
        assert.ok(overscroll.samples.every((sample) => sample.rows < 40));
        const bounds = await page.locator('[data-weq-windowed-list]').boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        for (let pull = 0; pull < 4; pull++) await page.mouse.wheel(0, -200);
        await page.waitForTimeout(50);
        const boundary = await page.locator('[data-weq-windowed-list]').evaluate((list) => ({
          top: list.scrollTop,
          firstRowTop: list.querySelector('.conversation-row').getBoundingClientRect().top,
          viewportTop: list.getBoundingClientRect().top,
        }));
        assert.ok(Math.abs(boundary.top) <= 1, JSON.stringify(boundary));
        assert.ok(Math.abs(boundary.firstRowTop - boundary.viewportTop) <= 1);
        results.at(-1).overscroll = overscroll;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

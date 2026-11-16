import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_IMPORTANT_ARTIFACTS;
if (!output) throw new Error('请设置 WEQ_IMPORTANT_ARTIFACTS');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-important-messages'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/important-messages.stub.ts'),
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
const report = { shots: [], metrics: [], errors: [] };
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.context().route('**/*', (route) =>
    route.request().url().includes('/_media/pic?')
      ? route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            'base64',
          ),
        })
      : new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue()
        : route.abort(),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/important-messages.html`,
  );
  const open = async () => {
    await page.getByRole('button', { name: '重要消息', exact: true }).click();
    await page.locator('.weq-important-row').first().waitFor();
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      const state = window.importantTheme.getState();
      state.setPreference(value);
      state.setAccent(value === 'light' ? '#006d50' : '#f5dc82');
      state.setBackground(value === 'light' ? 'paper' : 'grid');
    }, theme);
    for (const [width, height] of [
      [1180, 800],
      [390, 740],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await open();
      assert.equal(await page.getByLabel('刷新重要消息', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('仅未读', { exact: true }).count(), 0);
      const metric = await page.locator('.weq-important-messages').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          listScrolls:
            element.querySelector('ul').scrollHeight > element.querySelector('ul').clientHeight,
          rowOverflow: [...element.querySelectorAll('li')].some(
            (row) => row.scrollWidth > row.clientWidth,
          ),
        };
      });
      const shot = resolve(output, `${theme}-${width}.png`);
      await page.screenshot({ path: shot });
      report.shots.push(shot);
      assert.ok(
        metric.left >= 0 && metric.top >= 0 && metric.right <= width && metric.bottom <= height,
        `面板超出屏幕 ${JSON.stringify(metric)}`,
      );
      assert.ok(metric.scrollWidth <= width && !metric.rowOverflow, '内容横向溢出');
      assert.ok(metric.listScrolls, '长列表未滚动');
      if (width > 760) {
        const timeline = await page.locator('.chat-pane > .message-scroll').boundingBox();
        assert.ok(timeline.x + timeline.width <= metric.left + 1, '重要消息不应遮住上下文');
      }
      report.metrics.push({ theme, width, ...metric });
      await page.keyboard.press('Escape');
      await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });
    }
  }
  await page.setViewportSize({ width: 1180, height: 800 });
  await open();
  await page.locator('.weq-important-row').first().click();
  await page.waitForFunction(() => document.querySelector('output').dataset.locateCount === '1');
  await page.locator('.weq-important-row').first().click();
  await page.waitForFunction(() => document.querySelector('output').dataset.locateCount === '2');
  assert.equal(await page.locator('.weq-important-messages li').count(), 10);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.weq-important-messages li').length === 14,
  );
  await page.getByRole('button', { name: '全部类型', exact: true }).click();
  await page.getByText('未选择消息类型', { exact: true }).waitFor();
  await page.locator('[data-weq-select-id="replyMe"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.weq-important-messages li').length === 3,
  );
  await page.keyboard.press('Escape');
  await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });
  await open();
  assert.equal(
    await page.locator('[data-weq-select-id="replyMe"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    await page.locator('[data-weq-select-id="atMe"]').getAttribute('aria-pressed'),
    'false',
  );
  await page.evaluate(() => {
    window.importantMode = 'error';
  });
  await page.locator('[data-weq-select-id="atMe"]').click();
  await page.getByRole('alert').waitFor();
  await page.evaluate(() => {
    window.importantMode = 'empty';
  });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('暂无已记录的重要消息', { exact: true }).waitFor();
  await page.evaluate(() => window.changeImportantGroup('888'));
  await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.importantMode = 'ready';
  });
  await page.getByRole('button', { name: '展开重要消息列表', exact: true }).click();
  await page.locator('.weq-important-row').first().waitFor();
  await page.locator('[data-important-seq="1023"]').click();
  await page.getByText('本次提醒 · 剩余 2/3', { exact: true }).waitFor();
  assert.equal(
    await page.locator('[data-important-seq="1023"]').getAttribute('aria-current'),
    'true',
  );
  await page.getByTitle('下一条：有人@我', { exact: true }).click();
  await page.getByText('本次提醒 · 剩余 1/3', { exact: true }).waitFor();
  await page.locator('[data-important-seq="1024"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '定位到原消息', exact: true }).click();
  assert.equal(await page.locator('.weq-important-row').count(), 10);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '预览会话', exact: true }).click();
  await page.locator('.qa-preview .message-bubble').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '定位到原消息', exact: true }).click();
  await page.locator('.qa-preview').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 740 });
  await open();
  await page.locator('[data-important-seq="1022"]').click();
  await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });
  await open();
  assert.equal(
    await page.locator('[data-important-seq="1022"]').getAttribute('aria-current'),
    'true',
  );
  await page.locator('.weq-important-messages ul').evaluate((element) => {
    element.scrollTop = 320;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const savedScroll = await page
    .locator('.weq-important-messages ul')
    .evaluate((element) => element.scrollTop);
  await page.getByLabel('关闭重要消息', { exact: true }).click();
  await open();
  assert.equal(
    await page.locator('.weq-important-messages ul').evaluate((element) => element.scrollTop),
    savedScroll,
    '抽屉重开保留列表位置',
  );
  assert.deepEqual(report.errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

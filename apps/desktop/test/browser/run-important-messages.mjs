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
const dockOnly = process.argv.includes('--dock-only');
if (!output && !dockOnly) throw new Error('请设置 WEQ_IMPORTANT_ARTIFACTS');
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
async function run() {
  if (output) await mkdir(output, { recursive: true });
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
  const fixture = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/important-messages.html`;
  await page.goto(`${fixture}${dockOnly ? '?reading-position' : ''}`);
  const open = async () => {
    const more = page.getByRole('button', { name: '更多会话操作' });
    if (await more.isVisible()) {
      await more.click();
      await page.getByRole('menuitem', { name: '消息', exact: true }).click();
    } else await page.getByRole('button', { name: '消息', exact: true }).click();
    await page.getByRole('menuitem', { name: '重要消息', exact: true }).click();
    await page.locator('.weq-important-row').first().waitFor();
  };
  if (dockOnly) {
    const dock = page.locator('.weq-important-dock');
    const reading = page.getByRole('button', { name: '跳到上次阅读位置', exact: true });
    await page.setViewportSize({ width: 1180, height: 800 });
    await dock.getByRole('button', { name: '收起跳转提示' }).click();
    await dock.waitFor({ state: 'hidden' });
    await open();
    await page.keyboard.press('Escape');
    await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });

    await page.setViewportSize({ width: 390, height: 740 });
    await page.evaluate(() => window.changeImportantGroup('888'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const touchDock = async ({
      dx = 0,
      hold = false,
      cancel = false,
      button = dock.locator('button').first(),
    } = {}) => {
      const { x, y, height } = await button.boundingBox();
      const point = { x: x + 12, y: y + height / 2 };
      const send = (type, touchPoints) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      await send('touchStart', [point]);
      if (hold) await new Promise((resolve) => setTimeout(resolve, 525));
      if (dx) await send('touchMove', [{ ...point, x: point.x + dx }]);
      await send(cancel ? 'touchCancel' : 'touchEnd', []);
    };
    await dock.waitFor();
    const [unreadBox, readingBox] = await Promise.all([dock.boundingBox(), reading.boundingBox()]);
    assert.ok(
      unreadBox && readingBox && readingBox.y > unreadBox.y + unreadBox.height,
      '竖屏群聊的两种跳转入口应上下分开',
    );
    await touchDock({ dx: 24 });
    await touchDock({ dx: 66, cancel: true });
    await dock.waitFor();
    assert.equal(await page.locator('output').getAttribute('data-locate-count'), '0');
    await touchDock({ hold: true });
    await page.locator('.weq-important-row').first().waitFor();
    assert.equal(await page.locator('output').getAttribute('data-locate-count'), '0');
    await page.getByLabel('关闭重要消息', { exact: true }).click();
    await touchDock({ dx: 66 });
    await dock.waitFor({ state: 'hidden' });
    await reading.click();
    await reading.waitFor({ state: 'hidden' });

    await page.evaluate(() => window.changeImportantGroup('999'));
    await dock.waitFor();
    await page.getByRole('button', { name: '更多会话操作' }).click();
    await page.getByRole('menuitem', { name: '消息', exact: true }).click();
    await page.getByRole('menuitem', { name: '收起跳转提示', exact: true }).click();
    await dock.waitFor({ state: 'hidden' });

    await page.goto(`${fixture}?jump-layout=separate`);
    const first = page.getByRole('button', { name: '跳到首条未读', exact: true });
    const important = page.getByTitle('下一条：有人@我', { exact: true });
    const all = page.locator('.weq-chat-jump');
    await reading.waitFor();
    assert.equal(await all.count(), 3);
    for (const button of [reading, important, first]) {
      const before = await all.count();
      await touchDock({ dx: 66, button });
      await button.waitFor({ state: 'hidden' });
      assert.equal(await all.count(), before - 1);
    }

    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(`${fixture}?jump-layout=separate`);
    for (const label of ['收起首条未读跳转', '收起重要消息跳转', '收起跳转提示']) {
      const before = await all.count();
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await all.count(), before - 1);
    }

    for (const sameTarget of [false, true]) {
      await page.goto(`${fixture}?jump-layout=combined${sameTarget ? '&same-target' : ''}`);
      for (const button of [
        important,
        page.getByTitle('下一条：有人回复我', { exact: true }),
        first,
      ]) {
        await button.waitFor();
        assert.equal(await all.count(), 1);
        await button.click();
      }
      if (!sameTarget) await reading.click();
      await all.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('output').getAttribute('data-locate-count'), '3');
    }
    assert.deepEqual(report.errors, []);
    console.log(
      'Validated separate jump buttons, close, touch hold, cancelled/short drag, dismiss swipe and menu fallback.',
    );
    return;
  }
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
      assert.equal(
        await page
          .locator('.weq-important-queue, .weq-important-thumbnail, .weq-important-reasons')
          .count(),
        0,
      );
      assert.equal(
        await page.locator('.weq-important-dock .unread-dock-label').textContent(),
        '有人@我',
      );
      assert.equal(await page.locator('.weq-important-dock .unread-dock-count').textContent(), '2');
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
          rowHeights: [...element.querySelectorAll('.weq-important-row')].map(
            (row) => row.getBoundingClientRect().height,
          ),
          seqs: [...element.querySelectorAll('[data-important-seq]')].map((row) =>
            Number(row.dataset.importantSeq),
          ),
          colors: [...element.querySelectorAll('.weq-important-filters [data-important-kind]')].map(
            (filter) => {
              const icon = element.querySelector(
                `.weq-important-row [data-important-kind="${filter.dataset.importantKind}"]`,
              );
              return {
                kind: filter.dataset.importantKind,
                filter: getComputedStyle(filter).color,
                row: icon && getComputedStyle(icon).color,
              };
            },
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
      assert.ok(
        metric.rowHeights.every((height) => height === 34),
        '重要消息应固定为紧凑单行',
      );
      assert.deepEqual(
        metric.seqs,
        metric.seqs.slice().sort((a, b) => a - b),
        '重要消息应旧在上、新在下',
      );
      assert.equal(
        new Set(metric.colors.map((item) => item.filter)).size,
        8,
        '八类重要消息应各有类型色',
      );
      assert.ok(
        metric.colors.every((item) => item.filter === item.row),
        '标签与行内图标应同色',
      );
      if (width > 760) {
        assert.ok(
          await page.locator('.weq-important-dock').isVisible(),
          '展开列表后跳转按钮应继续保留',
        );
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
  assert.equal(await page.locator('.weq-important-messages li').count(), 20);
  const anchor = page.locator('[data-important-seq="1015"]');
  await anchor.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const anchorTop = (await anchor.boundingBox()).y;
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.weq-important-messages li').length === 30,
  );
  assert.ok(Math.abs((await anchor.boundingBox()).y - anchorTop) < 2, '向上补页应保留原可见位置');
  await page.getByRole('button', { name: '全部类型', exact: true }).click();
  await page.getByText('未选择消息类型', { exact: true }).waitFor();
  await page.locator('[data-weq-select-id="replyMe"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.weq-important-messages li').length === 5,
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
  await page.waitForFunction(
    () => document.querySelector('.unread-dock-count')?.textContent === '1',
  );
  assert.equal(
    await page.locator('[data-important-seq="1023"]').getAttribute('aria-current'),
    'true',
  );
  await page.getByTitle('下一条：有人@我', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.unread-dock-count'));
  assert.equal(await page.locator('.unread-dock-label').textContent(), '跳到首条未读');
  await page.locator('[data-important-seq="1024"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '定位到原消息', exact: true }).click();
  assert.equal(await page.locator('.weq-important-row').count(), 20);
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
  await page.getByLabel('关闭重要消息', { exact: true }).click();
  await page.evaluate(() => window.changeImportantGroup('999'));
  await open();
  const countBefore = await page.locator('output').getAttribute('data-locate-count');
  await page.getByTitle('下一条：有人@我', { exact: true }).click();
  await page.locator('.weq-important-messages').waitFor({ state: 'hidden' });
  assert.equal(
    Number(await page.locator('output').getAttribute('data-locate-count')),
    Number(countBefore) + 1,
    '手机抽屉展开时浮动按钮应能正常跳转',
  );
  assert.deepEqual(report.errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
try {
  await run();
} finally {
  await browser?.close();
  await server.close();
}

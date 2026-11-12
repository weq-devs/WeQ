import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/hooks\/useVoiceTranscription$/,
        replacement: resolve(root, 'test/browser/message-menu.stub.ts'),
      },
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/message-menu.stub.ts'),
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
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  const context = await browser.newContext();
  const fallback = await sharp({
    create: { width: 26, height: 26, channels: 3, background: '#21a266' },
  })
    .png()
    .toBuffer();
  const routes = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_asset/emoji/'))
      return route.fulfill({ contentType: 'image/png', body: fallback });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  };
  await context.route('**/*', routes);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/message-menu.html`;
  await page.goto(url);
  await page.waitForFunction(() => window.menuFixture);
  const open = async (x, y, mobile, theme = 'light', mode = 'full') => {
    await page.evaluate(
      (args) => window.menuFixture(...args),
      [
        x,
        y,
        mobile,
        theme,
        theme === 'light' ? '#19764c' : '#f4cf4c',
        theme === 'light' ? 'plain' : 'grid',
        mode,
      ],
    );
    await page.getByRole('menu').waitFor();
    await page.waitForFunction(
      (mode) =>
        document
          .querySelector('[data-menu-fixture-mode]')
          ?.getAttribute('data-menu-fixture-mode') === mode,
      mode,
    );
  };
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
    [320, 640],
    [640, 280],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      for (const [x, y] of [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ]) {
        await open(x, y, width < 760, theme);
        const layout = await page.getByRole('menu').evaluate((menu) => {
          const rect = menu.getBoundingClientRect();
          const buttons = [...menu.querySelectorAll('.message-menu-group button')];
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            overflow: menu.scrollWidth > menu.clientWidth,
            columns: [...menu.querySelectorAll('.message-menu-group')]
              .filter((group) => group.querySelector('button'))
              .map((group) => getComputedStyle(group).gridTemplateColumns.split(' ').length),
            textVisible: buttons.every((button) => {
              const label = button.querySelector('span');
              return (
                label &&
                label.getBoundingClientRect().width > 10 &&
                getComputedStyle(label).position !== 'absolute'
              );
            }),
            iconsUnified: buttons.every((button) => {
              const icon = button.querySelector('svg');
              return (
                icon &&
                getComputedStyle(icon).width === '18px' &&
                getComputedStyle(icon).strokeWidth === '1.75px'
              );
            }),
            minHeight: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
          };
        });
        assert(
          layout.left >= 0 &&
            layout.top >= 0 &&
            layout.right <= width &&
            layout.bottom <= height &&
            !layout.overflow,
          JSON.stringify(layout),
        );
        assert(
          layout.width <= 304 && layout.columns.every((count) => count === 2),
          JSON.stringify(layout),
        );
        assert(
          layout.textVisible && layout.iconsUnified && layout.minHeight >= (width < 760 ? 44 : 36),
          JSON.stringify(layout),
        );
        assert.equal(await page.locator('.message-action-fallback').count(), 0);
        assert.equal(await page.getByRole('menuitem', { name: '导出', exact: true }).count(), 0);
        if (output && x === 0 && y === 0)
          await page.screenshot({ path: resolve(output, `${theme}-${width}-${height}.png`) });
        const todo = page.getByRole('menuitem', { name: '设为群待办', exact: true });
        await todo.scrollIntoViewIfNeeded();
        await page.mouse.move(width - 1, height - 1);
        await todo.hover();
        await page
          .waitForFunction(
            () => document.querySelector('[role="tooltip"]')?.textContent?.includes('暂不可用'),
            undefined,
            { timeout: 5000 },
          )
          .catch(() => {
            throw new Error(`禁用提示未出现：${theme}/${width}/${height}/${x}/${y}`);
          });
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
      }
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await open(0, 0, true);
  const quick = page.getByRole('menuitemcheckbox');
  assert.equal(await quick.count(), 5);
  const initialLabels = await quick.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label')),
  );
  await quick.last().focus();
  for (const [width, count] of [
    [280, 4],
    [240, 3],
    [320, 5],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('.message-reaction-strip [role="menuitemcheckbox"]').length ===
        count,
      count,
    );
    assert.deepEqual(
      await quick.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-label')),
      ),
      initialLabels.slice(0, count),
    );
    const sizes = await page
      .locator('.message-reaction-strip button')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
    assert(
      sizes.every((size) => size >= 44),
      `快捷表情点击区域过窄：${sizes}`,
    );
    assert(
      await page
        .getByRole('menuitem', { name: '更多表情', exact: true })
        .evaluate((element) => document.activeElement === element),
    );
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 640 });
  for (const mode of ['sparse', 'voice', 'mixed', 'downloaded', 'private', 'record']) {
    await open(0, 0, true, 'dark', mode);
    if (mode === 'sparse') {
      assert.equal(await page.locator('.message-menu-group button').count(), 1);
      assert.equal(await page.locator('.message-reaction-strip').count(), 0);
    }
    if (mode === 'downloaded') {
      assert(await page.getByRole('menuitem', { name: '在文件夹中显示', exact: true }).isVisible());
      assert(await page.getByRole('menuitem', { name: '保存到服务器', exact: true }).isVisible());
    }
    if (mode === 'private') assert.equal(await page.locator('.message-reaction-strip').count(), 0);
    if (mode === 'record') {
      assert(await page.getByRole('menuitem', { name: '导出', exact: true }).isVisible());
      assert.equal(
        await page.getByRole('menuitem', { name: '保存到服务器', exact: true }).count(),
        0,
      );
    }
    if (output) await page.screenshot({ path: resolve(output, `${mode}-320.png`) });
    if (mode === 'voice' || mode === 'mixed') {
      await page.getByRole('menuitem', { name: '转换为文字', exact: true }).click();
      assert(await page.evaluate(() => window.menuActions.includes('转文字')));
    }
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [width, mobile] of [
    [1280, false],
    [390, true],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      document.documentElement.dataset.density = 'compact';
      document.documentElement.dataset.componentStyle = 'retro';
    });
    await open(50, 50, mobile);
    const minHeight = await page
      .locator('.message-menu-group button')
      .evaluateAll((buttons) =>
        Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
      );
    assert(minHeight >= (mobile ? 44 : 36), `紧凑密度缩小了菜单触控目标：${minHeight}`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.density;
    delete document.documentElement.dataset.componentStyle;
  });
  for (const [width, height] of [
    [1280, 900],
    [320, 640],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.mouse.move(width - 2, height - 2);
      await open(0, 0, width < 760, theme, 'saved-media');
      for (const name of [
        '显示另存文件',
        '显示缓存文件',
        '显示缓存缩略图',
        '显示封面缓存',
        '显示转码缓存',
      ]) {
        const button = page.getByRole('menuitem', { name, exact: true });
        assert(await button.isVisible());
        assert(
          await button.evaluate((element) => {
            const label = element.querySelector('span');
            return (
              element.scrollWidth <= element.clientWidth && label.scrollWidth <= label.clientWidth
            );
          }),
          `${name} 文案溢出`,
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `saved-media-${theme}-${width}.png`) });
      await page.getByRole('menuitem', { name: '显示另存文件', exact: true }).click();
      await page
        .getByText('另存的文件已被移动或删除，请使用“另存为”重新保存', { exact: true })
        .last()
        .waitFor();
      assert(await page.evaluate(() => window.menuActions.at(-1) === 'reveal:saved:saved-file'));
      await open(0, 0, width < 760, theme, 'saved-media');
      await page.getByRole('menuitem', { name: '显示缓存文件', exact: true }).click();
      assert(await page.evaluate(() => window.menuActions.at(-1) === 'reveal:cache:cache-file'));
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(50, 50, false);
  await page.getByRole('menuitemcheckbox', { name: '取消贴表情：赞', exact: true }).click();
  assert(await page.evaluate(() => window.menuActions.includes('76:false')));
  await page.getByRole('menuitem', { name: '+1', exact: true }).click();
  assert(await page.evaluate(() => window.menuActions.includes('+1')));
  // 禁用项允许通过方向键到达，显示原因但 Enter 不执行。
  await page.getByRole('menuitem', { name: '设为群待办', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() =>
    document.querySelector('[role="tooltip"]')?.textContent?.includes('暂不可用'),
  );
  await page.keyboard.press('Enter');
  assert(!(await page.evaluate(() => window.menuActions.includes('设为群待办'))));
  await page.keyboard.press('Escape');
  assert(await page.locator('#origin').evaluate((el) => document.activeElement === el));
  // Tab 与 Shift+Tab 沿触发消息的前后顺序退出。
  await page.evaluate(() => {
    for (const id of ['before', 'after']) {
      const button = document.createElement('button');
      button.id = id;
      button.textContent = id;
      document.getElementById('origin')[id === 'before' ? 'before' : 'after'](button);
    }
  });
  for (const tabIndex of [0, -1]) {
    await page.locator('#origin').evaluate((element, value) => {
      element.tabIndex = value;
    }, tabIndex);
    for (const [key, id] of [
      ['Tab', 'after'],
      ['Shift+Tab', 'before'],
    ]) {
      await open(50, 50, false);
      await page.keyboard.press(key);
      assert(await page.locator(`#${id}`).evaluate((el) => document.activeElement === el));
    }
  }
  await open(50, 50, false);
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert(await page.locator('#origin').evaluate((el) => document.activeElement === el));
  await open(50, 50, false);
  await page.getByRole('menuitem', { name: '显示原文', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert(await page.locator('#origin').evaluate((el) => document.activeElement === el));
  await open(50, 50, false);
  await page.getByRole('menuitem', { name: '更多表情', exact: true }).click();
  assert(
    await page
      .getByRole('dialog', { name: '贴表情' })
      .evaluate((el) => el.contains(document.activeElement)),
  );
  const selected = page
    .getByRole('dialog', { name: '贴表情' })
    .getByRole('button', { name: '赞', exact: true });
  assert.equal(await selected.getAttribute('aria-pressed'), 'true');
  await selected.click();
  assert(await page.evaluate(() => window.menuActions.includes('more:76:false')));

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await touch.route('**/*', routes);
  const touchPage = await touch.newPage();
  await touchPage.goto(url);
  await touchPage.waitForFunction(() => window.menuFixture);
  await touchPage.evaluate(() => window.menuFixture(100, 100, true, 'light', '#19764c', 'plain'));
  const target = touchPage.getByRole('menuitem', { name: '本地删除', exact: true });
  const bounds = await target.boundingBox();
  const session = await touchPage.context().newCDPSession(touchPage);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touchPage.waitForFunction(
    () => document.querySelector('[role="tooltip"]')?.textContent === '本地删除',
  );
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert(await touchPage.evaluate(() => !window.menuActions.includes('本地删除')));
  await target.tap();
  assert(await touchPage.evaluate(() => window.menuActions.includes('本地删除')));
  await touch.close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 两列图文、统一图标、适用项过滤、保存与定位并存、记录专属导出、四尺寸深浅主题四角避让、禁用键盘提示、Tab方向、回应取消及真实触屏长按。',
  );
} finally {
  await browser?.close();
  await server.close();
}

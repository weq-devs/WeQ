import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-navigation.html`,
  );
  await page.waitForSelector('.fixture-conversation');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.remoteNavigationQa.theme(theme), theme);
      const search = page.locator('.weq-mobile-header [aria-label="全局搜索"]');
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await search.boundingBox();
        await search.dispatchEvent('pointerover', { pointerType: 'touch', bubbles: true });
        await search.dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
        await page.waitForTimeout(100);
        assert.equal(await search.getAttribute('aria-expanded'), 'false');
        assert.deepEqual(await search.boundingBox(), before);
        await search.dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
        await search.dispatchEvent('pointerout', { pointerType: 'touch', bubbles: true });
        await search.tap();
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('aria-label') === '搜索全部内容',
        );
        assert.equal(await search.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.weq-titlebar-search-results').count(), 1);
        await page.locator('.fixture-conversation').dispatchEvent('pointerdown', {
          pointerType: 'touch',
          bubbles: true,
        });
        assert.equal(await search.getAttribute('aria-expanded'), 'false');
        await page.waitForTimeout(200);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.weq-mobile-header [aria-label="连接菜单"]').click();
  assert.equal(await page.locator('body').getAttribute('data-menu-calls'), '1');
  await page.getByText('合成会话', { exact: true }).first().click();
  await page.waitForSelector('.app-shell-root[data-mobile-detail]');
  await page.getByRole('textbox', { name: '消息草稿' }).fill('返回后保留的草稿');
  const swipe = async (distance, start = 4, target = '.chat-main') =>
    page.evaluate(
      async ({ distance, start, target }) => {
        const root = document.querySelector('.app-shell-root');
        const dispatch = (name, x, end = false) => {
          const touch = { identifier: 1, target: root, clientX: x, clientY: 280 };
          const event = new Event(name, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            touches: { value: end ? [] : [touch] },
            changedTouches: { value: [touch] },
          });
          root.dispatchEvent(event);
        };
        dispatch('touchstart', start);
        dispatch('touchmove', start + distance);
        const transform = document.querySelector(target).style.transform;
        // 短距离慢拖必须取消，不能因合成事件速度过高误算为快甩。
        await new Promise((resolve) => setTimeout(resolve, 150));
        dispatch('touchend', start + distance, true);
        return transform;
      },
      { distance, start, target },
    );
  assert.equal(await swipe(20), 'translateX(20px)');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.app-shell-root').getAttribute('data-mobile-detail'), 'true');
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '外观分类' }).click();
  await page.getByRole('textbox', { name: '设置输入' }).fill('设置草稿');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('button:text("外观分类")');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.fixture-settings', { state: 'detached' });
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await swipe(160);
  await page.waitForFunction(
    () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
  );
  assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
  await page.locator('.fixture-conversation').click();
  await page.getByRole('textbox', { name: '消息草稿' }).focus();
  const frames = await page.evaluate(async () => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 320 },
      offsetTop: { configurable: true, value: 96 },
    });
    window.visualViewport.dispatchEvent(new Event('resize'));
    const samples = [];
    document.querySelector('.back-button').click();
    for (let frame = 0; frame < 24; frame++) {
      await new Promise(requestAnimationFrame);
      if (document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail')) continue;
      samples.push({
        top: document.querySelector('.weq-mobile-header').getBoundingClientRect().top,
        bottom: document.querySelector('.weq-mobile-tabs').getBoundingClientRect().bottom,
        shellTransform: getComputedStyle(document.querySelector('.app-shell')).transform,
      });
    }
    delete window.visualViewport.height;
    delete window.visualViewport.offsetTop;
    window.visualViewport.dispatchEvent(new Event('resize'));
    return samples;
  });
  assert.ok(frames.length > 0);
  assert.ok(
    frames.every(
      ({ top, bottom, shellTransform }) =>
        Math.abs(top) < 1 && Math.abs(bottom - 844) < 1 && shellTransform === 'none',
    ),
    JSON.stringify(frames),
  );
  for (const [tab, distance] of [
    ['contacts', -160],
    ['qzone', -160],
    ['more', -160],
  ]) {
    await swipe(distance, 200, '.sidebar');
    await page.waitForSelector(`[data-mobile-tab="${tab}"][aria-current="page"]`);
  }
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.waitForTimeout(250);
  assert.ok(await page.locator('[aria-label="更多功能"]').isVisible());
  for (const name of ['QQ 资料与状态', '应用', 'QQ 号搜索', '群号搜索', '好友通知', '群通知']) {
    assert.equal(
      await page.locator('.weq-mobile-more').getByRole('button', { name, exact: true }).count(),
      0,
    );
  }
  await page.locator('.weq-mobile-more').getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForSelector('.fixture-settings');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.fixture-settings', { state: 'detached' });
  assert.ok(await page.locator('[aria-label="更多功能"]').isVisible());
  for (const tab of ['qzone', 'contacts', 'messages']) {
    const target = (await page.locator('.weq-mobile-more').count())
      ? '.weq-mobile-more'
      : '.sidebar';
    await swipe(160, 100, target);
    await page.waitForSelector(`[data-mobile-tab="${tab}"][aria-current="page"]`);
  }
  assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-mobile-tab="messages"]').getAttribute('aria-current') ===
      'page',
  );
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.remoteNavigationQa.theme(theme), theme);
      await page.waitForTimeout(100);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (width <= 760) {
        const bounds = await page.locator('.weq-mobile-header').evaluate((header) =>
          [...header.querySelectorAll('button')]
            .map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
            })
            .filter((rect) => rect.width > 0),
        );
        assert.ok(
          bounds.every(
            (rect) =>
              rect.left >= 0 && rect.right <= width && rect.width >= 44 && rect.height >= 44,
          ),
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `remote-root-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByText('合成会话', { exact: true }).first().click();
  assert.equal(await page.locator('.chat-header [aria-label="连接菜单"]').count(), 0);
  await page.getByRole('button', { name: '更多会话操作' }).click();
  await page.getByRole('menuitem', { name: '连接菜单' }).click();
  assert.equal(await page.locator('body').getAttribute('data-menu-calls'), '2');
  if (output) await page.screenshot({ path: resolve(output, 'remote-chat-dark.png') });
  await page.locator('.back-button').click();
  await page.waitForFunction(
    () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: WebKit 主标签双向滑动、更多重复点击与详情返回、精简入口、键盘返回逐帧布局、连接菜单、侧滑完成/取消、草稿保留、320/390/1180 深浅色与减少动态效果',
  );
} finally {
  await browser?.close();
  await server.close();
}

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_BROWSER_ENGINE ?? 'webkit';
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
  browser = await engines[engine].launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const nativeTouch = engine === 'chromium' && process.env.WEQ_NATIVE_TOUCH === '1';
  const cdp = nativeTouch ? await page.context().newCDPSession(page) : undefined;
  let settingsCaptures = 0;
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-navigation.html`,
    { timeout: 120_000 },
  );
  await page.waitForSelector('.fixture-conversation');
  for (const width of process.env.WEQ_SWIPE_ONLY ? [] : [320, 390]) {
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
  const swipe = async (distance, start = 4, target = '.chat-main') => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: start, y: 280 }],
      });
      for (let step = 1; step <= 12; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start + (distance * step) / 12, y: 280 }],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
    }
    const result = await page.evaluate(
      ({ distance, start, target, nativeTouch }) => {
        const origin = document.querySelector(target);
        const dispatch = (name, x, end = false) => {
          const touch = { identifier: 1, target: origin, clientX: x, clientY: 280 };
          const event = new Event(name, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            touches: { value: end ? [] : [touch] },
            changedTouches: { value: [touch] },
          });
          origin.dispatchEvent(event);
        };
        if (!nativeTouch) {
          dispatch('touchstart', start);
          dispatch('touchmove', start + distance);
        }
        const transform = document.querySelector(target).style.transform;
        const bounds = (selector) => {
          const node = document.querySelector(selector);
          const rect = node.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            visibility: getComputedStyle(node).visibility,
          };
        };
        const layout = {
          header: bounds('.weq-mobile-header'),
          sidebar: bounds('.sidebar'),
          tabs: bounds('.weq-mobile-tabs'),
          chatOnTop: Boolean(document.elementFromPoint(innerWidth - 1, 20)?.closest('.chat-main')),
        };
        return { transform, layout };
      },
      { distance, start, target, nativeTouch },
    );
    if (output && target === '.chat-main' && distance >= 160) {
      const theme = await page.locator('html').getAttribute('data-theme');
      await page.screenshot({
        path: resolve(output, `remote-back-drag-${page.viewportSize().width}-${theme}.png`),
      });
    }
    if (output && target === '.weq-settings-dialog')
      await page.screenshot({
        path: resolve(output, `${engine}-settings-back-drag-${settingsCaptures++}.png`),
      });
    // 短距离慢拖必须取消，不能因合成事件速度过高误算为快甩。
    await page.waitForTimeout(150);
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else
      await page.evaluate((x) => {
        const root = document.querySelector('.app-shell-root');
        const event = new Event('touchend', { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: [] },
          changedTouches: { value: [{ identifier: 1, target: root, clientX: x, clientY: 280 }] },
        });
        root.dispatchEvent(event);
      }, start + distance);
    if (target === '.chat-main') {
      const { header, sidebar, tabs, chatOnTop } = result.layout;
      assert.equal(header.visibility, 'visible', JSON.stringify(result.layout));
      assert.ok(Math.abs(header.bottom - sidebar.top) < 1, JSON.stringify(result.layout));
      assert.ok(Math.abs(sidebar.bottom - tabs.top) < 1, JSON.stringify(result.layout));
      assert.equal(tabs.bottom, 844, JSON.stringify(result.layout));
      assert.ok(chatOnTop, JSON.stringify(result.layout));
    }
    return result.transform;
  };
  assert.equal(await swipe(20), 'translateX(20px)');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.app-shell-root').getAttribute('data-mobile-detail'), 'true');
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await page.getByRole('button', { name: '打开设置' }).click();
  await page
    .locator('.weq-settings-nav')
    .getByRole('button', { name: '常规', exact: true })
    .click();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-mobile-settings:not([data-mobile-category])');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => window.remoteNavigationQa.theme(theme), theme);
    for (const category of ['常规', '基础功能', '增强功能', '凭据与数据', 'WeQ 服务', '关于 WeQ']) {
      await page
        .locator('.weq-settings-nav')
        .getByRole('button', { name: category, exact: true })
        .click();
      await page.waitForSelector('.weq-mobile-settings[data-mobile-category]');
      assert.equal(await swipe(160, 4, '.weq-settings-dialog'), 'translateX(160px)');
      await page.waitForSelector('.weq-mobile-settings:not([data-mobile-category])');
      await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
      assert.equal(await page.locator('.weq-settings-dialog').count(), 1);
      assert.equal(
        await page.locator('.weq-settings-dialog').evaluate((node) => node.style.transform),
        '',
      );
    }
  }
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-settings-dialog', { state: 'detached' });
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await swipe(160);
  await page.waitForFunction(
    () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
  );
  // 通知页使用真实面板与 shell 返回快照，不让测试替身绕过重复登记问题。
  await page.locator('[data-mobile-tab="contacts"]').click();
  await page.waitForTimeout(300);
  for (const [label, title] of [
    ['好友通知', '好友通知'],
    ['群通知', '群通知'],
  ]) {
    for (const action of ['cancel', 'swipe', 'system', 'button']) {
      await page
        .locator('[data-mobile-sidebar-page="contacts"]')
        .getByRole('button', { name: label, exact: true })
        .click();
      await page.getByRole('region', { name: title, exact: true }).waitFor();
      if (action === 'cancel') {
        await swipe(20);
        await page.waitForTimeout(250);
        assert.ok(await page.getByRole('region', { name: title, exact: true }).isVisible());
      }
      if (action === 'swipe' || action === 'cancel') await swipe(160);
      else if (action === 'system') await page.evaluate(() => window.weqMobileNavigation.back());
      else
        await page
          .getByRole('region', { name: title, exact: true })
          .getByRole('button', { name: '返回', exact: true })
          .click();
      await page.waitForSelector('.weq-notice-panel', { state: 'detached' });
      await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
      assert.equal(
        await page.locator('[data-mobile-tab="contacts"]').getAttribute('aria-current'),
        'page',
      );
      assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
    }
  }
  await page.locator('[data-mobile-tab="messages"]').click();
  await page.waitForTimeout(300);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.remoteNavigationQa.theme(theme);
        const root = document.querySelector('.app-shell-root');
        // 覆盖刘海及底部手势区，避免桌面 WebKit 的零安全区掩盖高度问题。
        root.style.setProperty('--weq-mobile-header-height', '115px');
        root.style.setProperty('--weq-mobile-tabs-height', '94px');
      }, theme);
      await page.locator('.fixture-conversation').click();
      await page.waitForSelector('.app-shell-root[data-mobile-detail]');
      assert.equal(await page.locator('.weq-mobile-navigation').getAttribute('inert'), '');
      await swipe(160);
      await page.waitForFunction(
        () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
      );
      const bounds = await page.locator('.app-shell > .sidebar').boundingBox();
      assert.equal(bounds.y, 115);
      assert.equal(bounds.y + bounds.height, 750);
      assert.equal(await page.locator('.weq-mobile-navigation').getAttribute('inert'), null);
    }
  }
  await page.evaluate(() => {
    const root = document.querySelector('.app-shell-root');
    root.style.removeProperty('--weq-mobile-header-height');
    root.style.removeProperty('--weq-mobile-tabs-height');
  });
  await page.setViewportSize({ width: 390, height: 844 });
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
  const morePage = page.locator('.weq-mobile-navigation > .weq-mobile-more');
  assert.ok(await morePage.isVisible());
  for (const name of ['QQ 资料与状态', '应用', 'QQ 号搜索', '群号搜索', '好友通知', '群通知']) {
    assert.equal(await morePage.getByRole('button', { name, exact: true }).count(), 0);
  }
  await morePage.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForSelector('.weq-settings-dialog');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-settings-dialog', { state: 'detached' });
  assert.ok(await morePage.isVisible());
  for (const tab of ['qzone', 'contacts', 'messages']) {
    const target = (await morePage.count())
      ? '.weq-mobile-navigation > .weq-mobile-more'
      : '.sidebar';
    await swipe(160, 100, target);
    await page.waitForSelector(`[data-mobile-tab="${tab}"][aria-current="page"]`);
  }
  assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-mobile-tab="messages"]').getAttribute('aria-current') ===
      'page',
  );
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
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.remoteNavigationQa.dialog());
  await page.getByRole('dialog', { name: '侧滑测试弹层' }).waitFor();
  assert.equal(await swipe(160, 4, '.weq-dialog-layer'), 'translateX(160px)');
  await page.getByRole('dialog', { name: '侧滑测试弹层' }).waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
  await page.locator('.fixture-conversation').click();
  await page.getByRole('button', { name: '打开设置' }).click();
  await page
    .locator('.weq-settings-nav')
    .getByRole('button', { name: 'WeQ 服务', exact: true })
    .click();
  await page.getByRole('button', { name: 'OneBot / cc-connect', exact: true }).click();
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建 WebSocket 服务器', exact: true });
  const draft = editor.getByLabel('OneBot 服务器名称', { exact: true });
  await draft.fill('侧滑草稿回归');
  await swipe(160, 4, '.weq-editor-dialog');
  await page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
  assert.equal(await draft.inputValue(), '侧滑草稿回归');
  assert.equal(await page.locator('.weq-mobile-settings[data-mobile-category]').count(), 1);
  await swipe(160, 4, '.weq-editor-dialog');
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await swipe(160, 4, '.weq-settings-dialog');
  await page.waitForSelector('.weq-mobile-settings:not([data-mobile-category])');
  await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${engine} ${nativeTouch ? '原生触摸' : '合成触摸'}：真实通知页三种返回与取消、七组设置深浅色逐级侧滑及分类预览、Portal 弹层、设置草稿确认与保留、主标签双向滑动、键盘返回逐帧布局、320/390/430 安全区、320/390/1180 页面与减少动态效果`,
  );
} finally {
  await browser?.close();
  await server.close();
}

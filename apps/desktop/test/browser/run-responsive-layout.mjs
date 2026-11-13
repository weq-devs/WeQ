import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_RESPONSIVE_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/responsive-layout-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const output = process.env.WEQ_RESPONSIVE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const { remote, group } of [
    { remote: false, group: false },
    { remote: true, group: false },
    { remote: true, group: true },
  ]) {
    const page = await browser.newPage({
      viewport: { width: 430, height: 932 },
      hasTouch: remote,
      userAgent: remote ? 'Mozilla/5.0 (iPhone) WeQRemote' : undefined,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript((remote) => {
      window.qaOrientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
      Object.defineProperty(screen, 'orientation', {
        configurable: true,
        value: window.qaOrientation,
      });
      const viewport = Object.assign(new EventTarget(), {
        height: innerHeight,
        offsetTop: 0,
        scale: 1,
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      if (remote)
        window.weqRemoteShell = {
          openMenu: () => {
            window.qaMenuOpened = (window.qaMenuOpened ?? 0) + 1;
          },
        };
    }, remote);
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/desktop-portrait.html${group ? '?group' : ''}`,
    );
    const editor = page.locator('.composer > .composer-editor');
    await editor.waitFor();
    await editor.fill('旋转与键盘切换保留草稿');
    const cases = remote
      ? [
          [320, 640, 'single'],
          [430, 932, 'single'],
          [640, 320, 'wide'],
          [760, 430, 'wide'],
          [844, 390, 'wide'],
          [932, 430, 'wide'],
          [1024, 768, 'wide'],
          [1180, 820, 'wide'],
          [430, 932, 'single'],
        ]
      : [
          [600, 900, 'single'],
          [600, 320, 'single'],
          [800, 1200, 'wide'],
          [430, 932, 'single'],
        ];
    for (const [width, height, layout] of cases) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        ({ width, height }) => {
          window.qaOrientation.type = width > height ? 'landscape-primary' : 'portrait-primary';
          window.qaOrientation.dispatchEvent(new Event('change'));
          window.visualViewport.height = height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        },
        { width, height },
      );
      await page.waitForFunction(
        (layout) => document.documentElement.dataset.weqLayout === layout,
        layout,
      );
      for (const { theme, preset } of ['classic', 'qqnt'].flatMap((preset) =>
        ['light', 'dark'].map((theme) => ({ theme, preset })),
      )) {
        await page.evaluate(
          ({ theme, preset }) => {
            window.desktopPortraitQa.store.getState().setComponentStyle(preset);
            window.desktopPortraitQa.store.getState().setPreference(theme);
            window.desktopPortraitQa.store
              .getState()
              .setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
          },
          { theme, preset },
        );
        const geometry = await page.evaluate(() => {
          const box = (selector) => document.querySelector(selector).getBoundingClientRect();
          const chat = box('.chat-main'),
            composer = box('.composer'),
            scroll = box('.message-scroll');
          const header = box('.chat-header');
          const buttonsFit = [...document.querySelectorAll('.chat-header button')].every(
            (button) => {
              const rect = button.getBoundingClientRect();
              return (
                !rect.width ||
                (rect.left >= header.left &&
                  rect.right <= header.right + 1 &&
                  rect.top >= header.top &&
                  rect.bottom <= header.bottom + 1)
              );
            },
          );
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            fits: chat.left >= 0 && chat.right <= innerWidth + 1 && chat.bottom <= innerHeight + 1,
            composerFits:
              composer.left >= chat.left &&
              composer.right <= chat.right + 1 &&
              composer.bottom <= chat.bottom + 1,
            messageHeight: scroll.height,
            columns: getComputedStyle(document.querySelector('.app-shell')).display,
            bridge: typeof window.weqMobileNavigation?.back,
            buttonsFit,
          };
        });
        assert.equal(
          geometry.overflow,
          false,
          JSON.stringify({ remote, width, height, theme, geometry }),
        );
        assert.equal(
          geometry.fits,
          true,
          JSON.stringify({ remote, width, height, theme, geometry }),
        );
        assert.equal(
          geometry.composerFits,
          true,
          JSON.stringify({ remote, width, height, theme, geometry }),
        );
        assert(
          geometry.messageHeight >= 40,
          JSON.stringify({ remote, width, height, theme, geometry }),
        );
        assert.equal(geometry.columns, layout === 'single' ? 'block' : 'grid');
        assert.equal(
          geometry.buttonsFit,
          true,
          JSON.stringify({ remote, group, width, height, theme, preset, geometry }),
        );
        assert.equal(await editor.textContent(), '旋转与键盘切换保留草稿');
        // 交互形态 = 布局 ∧ 指针能力：桌面窄窗口（细指针）右键仍是桌面菜单，
        // 只有「单栏 + 粗指针」才落到移动款。
        if (!remote && layout === 'single' && !group && theme === 'light') {
          const bubble = page.locator('.message-scroll .message-bubble').first();
          await bubble.click({ button: 'right' });
          await page.locator('.message-context-menu').first().waitFor({ state: 'visible' });
          const menuClass = await page
            .locator('.message-context-menu')
            .first()
            .getAttribute('class');
          assert(
            !String(menuClass).includes('message-menu-touch'),
            JSON.stringify({ width, height, menuClass }),
          );
          await page.keyboard.press('Escape');
          await page.waitForTimeout(120);
        }
        if (remote) {
          assert.equal(geometry.bridge, 'function', '横屏保留系统返回桥');
          if (layout === 'single') {
            await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
            await page.getByRole('menuitem', { name: '连接菜单', exact: true }).click();
          } else {
            await page.getByRole('button', { name: '连接菜单', exact: true }).click();
          }
          assert(await page.evaluate(() => window.qaMenuOpened > 0));
        }
        if (group && layout === 'wide' && width <= 1100) {
          // 空间不足时群资料进浮层。只断言「visible」不够：曾经它只有 2px 宽
          // （绝对定位的 grid 子项仍按基类 grid-area 落在隐式空列上），
          // 于是浮层"显示"了但用户什么都看不到。这里必须断宽高下限。
          await page.locator('.chat-header [aria-label="群资料"]').click();
          const panel = page.locator('.chat-pane.is-mobile-group-info-open > .group-info-panel');
          await panel.waitFor({ state: 'visible' });
          const overlay = await panel.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const pane = node.closest('.chat-pane').getBoundingClientRect();
            const header = node.closest('.chat-pane').querySelector('.chat-header');
            return {
              width: rect.width,
              height: rect.height,
              right: rect.right,
              top: rect.top,
              paneWidth: pane.width,
              paneRight: pane.right,
              headerHeight: header.getBoundingClientRect().height,
            };
          });
          assert(
            overlay.width >= 240 && overlay.height >= 200,
            JSON.stringify({ remote, group, width, height, preset, theme, overlay }),
          );
          assert.equal(
            Math.round(overlay.right),
            Math.round(overlay.paneRight),
            JSON.stringify({ width, overlay }),
          );
          assert(overlay.top >= overlay.headerHeight, JSON.stringify({ width, overlay }));
          if (output)
            await page.screenshot({
              path: resolve(output, `overlay-groupinfo-${width}x${height}-${preset}-${theme}.png`),
            });
          // 浮层是最上层：系统返回必须先关它，不能落到「退出会话」甚至结束应用。
          const openClass = () =>
            page.locator('.chat-pane').evaluate((node) => ({
              open: node.classList.contains('is-mobile-group-info-open'),
              title: node.querySelector('.chat-title strong')?.textContent ?? '',
            }));
          const beforeBack = await openClass();
          const consumed = await page.evaluate(() => window.weqMobileNavigation.back());
          assert.equal(consumed, true, '返回键应被群资料浮层消费');
          await page.waitForFunction(
            () => !document.querySelector('.chat-pane.is-mobile-group-info-open'),
          );
          const afterBack = await openClass();
          assert.equal(afterBack.title, beforeBack.title, '返回键不应切换会话');
          await page.waitForTimeout(120);
          assert.equal(
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
            '群资料',
            '关闭浮层后焦点回到触发按钮',
          );
          // 浮层旁边那一侧只关浮层，不能穿透去点消息。
          await page.locator('.chat-header [aria-label="群资料"]').click();
          await panel.waitFor({ state: 'visible' });
          await page.evaluate(() => {
            window.qaPointerTargets = [];
            document.addEventListener(
              'pointerdown',
              (event) => window.qaPointerTargets.push(event.target?.className ?? ''),
              { capture: true, once: true },
            );
          });
          const paneBox = await page.locator('.chat-pane').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const header = node.querySelector('.chat-header').getBoundingClientRect();
            return { left: rect.left, top: header.bottom + 40 };
          });
          await page.mouse.click(paneBox.left + 24, paneBox.top);
          await page.waitForFunction(
            () => !document.querySelector('.chat-pane.is-mobile-group-info-open'),
          );
          const targets = await page.evaluate(() => window.qaPointerTargets ?? []);
          assert(
            targets.some((name) => name.includes('weq-group-info-scrim')),
            JSON.stringify({ remote, group, width, height, targets }),
          );
          assert.equal(
            await page.locator('.message-context-menu').count(),
            0,
            '点浮层外面不应触发消息操作',
          );
        }
        if (output)
          await page.screenshot({
            path: resolve(
              output,
              `${remote ? 'remote' : 'desktop'}-${group ? 'group' : 'direct'}-${width}-${height}-${preset}-${theme}.png`,
            ),
          });
        results.push({ remote, group, width, height, theme, preset, layout });
      }
    }
    if (remote) {
      for (const [width, height] of [
        [844, 390],
        [1024, 768],
        [1180, 820],
        [1366, 1024],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => {
          window.qaOrientation.type = 'landscape-primary';
          window.qaOrientation.dispatchEvent(new Event('change'));
          window.visualViewport.height = innerHeight;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.getByRole('button', { name: '主页', exact: true }).click();
        await page.locator('[data-portrait-home]').waitFor();
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            window.desktopPortraitQa.store.getState().setPreference(theme);
          }, theme);
          const home = await page.evaluate(() => {
            const box = (selector) => document.querySelector(selector).getBoundingClientRect();
            return {
              railRight: box('.app-rail').right,
              mainLeft: box('.chat-main').left,
              mainRight: box('.chat-main').right,
              sidebarTrack: getComputedStyle(
                document.querySelector('.app-shell'),
              ).gridTemplateColumns.split(' ')[1],
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert.equal(home.sidebarTrack, '0px', JSON.stringify({ width, height, theme, home }));
          assert.equal(home.mainLeft, home.railRight, '主页紧接导航栏，不保留空白侧栏');
          assert.equal(home.mainRight, width);
          assert.equal(home.overflow, false);
          if (output)
            await page.screenshot({
              path: resolve(output, `remote-home-${width}-${height}-${theme}.png`),
            });
        }
        await page.locator('.app-rail').getByRole('button', { name: '消息', exact: true }).click();
        await editor.waitFor();
        assert(
          (await page.locator('.sidebar').boundingBox()).width >= 160,
          '返回消息后恢复正常会话列表宽度',
        );
        assert.equal(await editor.textContent(), '旋转与键盘切换保留草稿');
      }
      await page.setViewportSize({ width: 430, height: 932 });
      await page.evaluate(() => {
        window.qaOrientation.type = 'portrait-primary';
        window.qaOrientation.dispatchEvent(new Event('change'));
      });
      await page.waitForFunction(() => document.documentElement.dataset.weqLayout === 'single');
      await page.locator('.sidebar .conversation-row').first().click();
      await editor.focus();
      // 键盘可同步缩短 layout viewport；设备方向保持竖屏。
      await page.setViewportSize({ width: 430, height: 320 });
      await page.evaluate(() => {
        window.visualViewport.height = 320;
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.weqLayout), 'single');
      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => {
        window.qaOrientation.type = 'landscape-primary';
        window.qaOrientation.dispatchEvent(new Event('change'));
        window.visualViewport.height = 240;
        window.visualViewport.offsetTop = 12;
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      const keyboard = await page.locator('.app-shell-root').evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          height: rect.height,
          top: rect.top,
          layout: document.documentElement.dataset.weqLayout,
        };
      });
      assert.deepEqual(keyboard, { height: 240, top: 12, layout: 'wide' });
      await page.evaluate(() => {
        window.visualViewport.height = 390;
        window.visualViewport.offsetTop = 0;
        window.visualViewport.dispatchEvent(new Event('resize'));
        document.documentElement.style.setProperty('--weq-client-safe-left', '44px');
        document.documentElement.style.setProperty('--weq-client-safe-right', '20px');
      });
      const safe = await page.locator('.app-shell').evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      assert.deepEqual(safe, { left: 44, right: 824 });
      // 横屏详情继续登记返回栈；系统返回恢复原会话而不是退出连接壳。
      const originalTitle = await page.locator('.chat-title strong').first().textContent();
      await page.locator('.sidebar .conversation-row').nth(1).click();
      assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), true);
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.chat-title strong').first().textContent(), originalTitle);
      assert.equal(await editor.textContent(), '旋转与键盘切换保留草稿');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ engine, cases: results.length, results }));
} finally {
  await browser?.close();
  await server.close();
}

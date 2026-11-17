import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_BROWSER_ENGINE ?? 'webkit';
const output = process.env.WEQ_SAFE_AREA_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, `node_modules/.cache/mobile-safe-area-${engine}`),
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
  browser = await engines[engine].launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone) WeQRemote',
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
  await page.addInitScript(() => {
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: Object.assign(new EventTarget(), { type: 'portrait-primary' }),
    });
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-safe-area.html`;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const [width, height] of [
    [320, 640],
    [402, 874],
    [430, 932],
    [874, 402],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(url);
    await page.waitForFunction(() => window.safeAreaQa);
    for (const theme of ['light', 'dark']) {
      for (const top of [0, 20, 59]) {
        await page.evaluate(
          ({ top, theme, width, height }) => {
            screen.orientation.type = width > height ? 'landscape-primary' : 'portrait-primary';
            screen.orientation.dispatchEvent(new Event('change'));
            window.safeAreaQa.theme.getState().setPreference(theme);
            window.safeAreaQa.theme.getState().setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
            window.safeAreaQa.theme
              .getState()
              .setBackground(theme === 'light' ? 'grid' : 'telegram');
            for (const [side, value] of Object.entries({
              top,
              bottom: 34,
              left: width > height ? 24 : 0,
              right: width > height ? 16 : 0,
            }))
              document.documentElement.style.setProperty(`--weq-safe-${side}`, `${value}px`);
          },
          { top, theme, width, height },
        );
        for (const surface of [
          'home',
          'contact',
          'group',
          'chat',
          'settings',
          'page',
          'sidecar',
          'media',
          'popover',
          'card',
          'menu',
          'report',
        ]) {
          await page.evaluate((surface) => window.safeAreaQa.show(surface), surface);
          const single = await page.evaluate(
            () => document.documentElement.dataset.weqLayout === 'single',
          );
          if (!single && !['media', 'popover', 'card', 'menu', 'report'].includes(surface))
            continue;
          const selector =
            surface === 'home'
              ? '.weq-mobile-header'
              : surface === 'contact' || surface === 'group'
                ? '.weq-profile-page-toolbar'
                : surface === 'chat'
                  ? '.chat-header'
                  : surface === 'settings'
                    ? '.weq-mobile-settings-header'
                    : surface === 'media'
                      ? '.weq-preview-header'
                      : surface === 'card'
                        ? '.weq-profile-card-controls'
                        : surface === 'menu'
                          ? '.weq-conversation-actions-menu > button:first-of-type'
                          : surface === 'popover'
                            ? '[role="dialog"] [data-qa-toolbar]'
                            : '[data-qa-toolbar]';
          const header = page.locator(selector).last();
          await header.waitFor();
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          // 横屏页面位于桌面标题栏之下；这个夹具只模拟单栏内容和独立媒体/浮层。
          const geometry = await header.evaluate((node) => {
            const rects = [
              ...(node.matches('button')
                ? [node]
                : node.querySelectorAll('button, strong, .weq-preview-title')),
            ].map((element) => {
              const r = element.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
            });
            const r = node.getBoundingClientRect();
            const card = node.closest('[role="dialog"], [role="menu"]');
            return {
              rects,
              headerTop: r.top,
              height: r.height,
              card: card && {
                top: card.getBoundingClientRect().top,
                bottom: card.getBoundingClientRect().bottom,
              },
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          const detail = JSON.stringify({ engine, width, height, theme, top, surface, geometry });
          assert(
            geometry.rects.every((r) => r.top >= top - 1 && r.left >= 0 && r.right <= width + 1),
            detail,
          );
          assert.equal(geometry.overflow, false, detail);
          if (['chat', 'settings'].includes(surface))
            assert.equal(geometry.headerTop, top, `安全区不得重复累加：${detail}`);
          if (['popover', 'card', 'menu'].includes(surface)) {
            assert(geometry.card.top >= top + 7, detail);
            assert(geometry.card.bottom <= height - 33, detail);
            if (surface === 'popover')
              await page.getByRole('button', { name: '关闭页面' }).click({ trial: true });
          }
          if (output && width === 402 && top === 59)
            await page.screenshot({ path: resolve(output, `${engine}-${surface}-${theme}.png`) });
          cases++;
        }
      }
    }
  }
  // 真实 ChatShell 的横屏多栏与竖屏聊天，验证容器占位没有改变输入区的底边。
  for (const [width, height] of [
    [402, 874],
    [874, 402],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width, height });
    for (const surface of ['home', 'chat']) {
      await page.goto(
        url.replace(
          'mobile-safe-area.html',
          `desktop-portrait.html${surface === 'home' ? '?home' : ''}`,
        ),
      );
      await page.locator('.app-shell-root').waitFor();
      await page.evaluate(
        ({ width, height }) => {
          screen.orientation.type = width > height ? 'landscape-primary' : 'portrait-primary';
          screen.orientation.dispatchEvent(new Event('change'));
          document.documentElement.style.setProperty('--weq-safe-top', '59px');
        },
        { width, height },
      );
      if (surface === 'chat') {
        const row = page.locator('.sidebar .conversation-row').first();
        if (await row.isVisible()) await row.click();
        await page.locator('.composer-editor').waitFor();
      }
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const actual = await page.evaluate(() => {
        const headers = [
          ...document.querySelectorAll('.app-title-bar, .weq-mobile-header, .chat-header'),
        ].filter((node) => {
          const r = node.getBoundingClientRect();
          return r.width && r.height && getComputedStyle(node).visibility !== 'hidden';
        });
        const blocked = headers
          .flatMap((node) => [...node.querySelectorAll('button')])
          .filter((node) => {
            const r = node.getBoundingClientRect();
            return r.width && r.height && r.top < 58;
          })
          .map((node) => node.outerHTML);
        const editor = document.querySelector('.composer-editor');
        return {
          blocked,
          editorBottom: editor?.getBoundingClientRect().bottom,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.deepEqual(actual.blocked, [], JSON.stringify({ width, height, surface, actual }));
      assert.equal(actual.overflow, false);
      if (surface === 'chat') assert(actual.editorBottom <= height + 1);
      if (output)
        await page.screenshot({ path: resolve(output, `${engine}-shell-${surface}-${width}.png`) });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

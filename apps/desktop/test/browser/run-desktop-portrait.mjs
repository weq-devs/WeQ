import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.WEQ_PORTRAIT_TARGET ?? 'electron';
const nativeControls = process.env.WEQ_PORTRAIT_NATIVE === '1';
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(
    root,
    `node_modules/.vite-desktop-portrait-${target}${nativeControls ? '-native' : ''}`,
  ),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(target) },
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
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  if (nativeControls)
    await page.addInitScript(() => {
      window.electron = {
        process: { platform: 'darwin' },
        ipcRenderer: {
          on: () => () => {},
          invoke: async (channel) => (channel === 'window:get-controls' ? 'native' : undefined),
          send() {},
        },
      };
    });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/desktop-portrait.html`,
  );
  await page.waitForSelector('.message-content');
  const draft = '拉宽收窄后保留的草稿';
  await page.locator('.composer .composer-editor').fill(draft);
  assert.equal(
    await page.locator('style[data-vite-dev-id$="/im-template/styles.css"]').count(),
    0,
    '模板样式仅经真实入口加载一次',
  );
  assert.equal(
    await page.locator('style[data-vite-dev-id$="/desktop-portrait.css"]').count(),
    0,
    '不加载桌面专属单栏样式',
  );
  const output = process.env.WEQ_PORTRAIT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const variants = ['classic', 'minimal', 'retro', 'qqnt'].flatMap((preset) =>
    ['light', 'dark'].map((theme) => ({ preset, theme })),
  );
  const sizes = [360, 440, 600, 760, 800, 1180].map((width) => ({ width, height: 900 }));
  sizes.push({ width: 360, height: 520 });
  for (const { width, height } of sizes) {
    await page.setViewportSize({ width, height });
    for (const { theme, preset } of variants) {
      await page.evaluate(
        ({ theme, preset }) => {
          const store = window.desktopPortraitQa.store.getState();
          store.setComponentStyle(preset);
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        },
        { theme, preset },
      );
      if (width <= 760)
        await page.waitForFunction(
          () => getComputedStyle(document.querySelector('.chat-main')).visibility === 'visible',
        );
      assert.equal(
        await page.locator('.composer .composer-editor').textContent(),
        draft,
        '切换布局保留草稿',
      );
      const fits = await page.evaluate((target) => {
        const chat = document.querySelector('.chat-main').getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const titlebar = document.querySelector('.app-title-bar').getBoundingClientRect();
        return {
          sharedShell:
            Boolean(document.querySelector('.weq-web-shell')) ===
            (innerWidth <= 760 || target === 'web'),
          windowChrome: titlebar.height === (innerWidth <= 760 && target === 'web' ? 0 : 40),
          overflow: document.documentElement.scrollWidth > innerWidth,
          chatFits:
            chat.left >= 0 &&
            chat.right <= innerWidth &&
            chat.bottom <= innerHeight &&
            chat.top >= titlebar.bottom,
          singleColumn:
            innerWidth > 760 ||
            (chat.left === 0 &&
              chat.width === innerWidth &&
              getComputedStyle(document.querySelector('.app-shell')).display === 'block'),
          composerFits:
            composer.left >= 0 && composer.right <= innerWidth && composer.bottom <= innerHeight,
          messagesFit: [...document.querySelectorAll('.message-content')].every((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1
            );
          }),
        };
      }, target);
      if (output)
        await page.screenshot({
          path: resolve(output, `${target}-${width}-${height}-${preset}-${theme}.png`),
        });
      assert.deepEqual(
        fits,
        {
          sharedShell: true,
          windowChrome: true,
          overflow: false,
          chatFits: true,
          singleColumn: true,
          composerFits: true,
          messagesFit: true,
        },
        `${width}/${height}/${preset}/${theme}`,
      );
      if (width <= 760) {
        await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
        await page.waitForFunction(
          () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
        );
        assert.equal(
          await page.evaluate(() => {
            const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
            const rail = document.querySelector('.weq-mobile-tabs').getBoundingClientRect();
            return (
              sidebar.bottom <= rail.top + 1 &&
              getComputedStyle(document.querySelector('.sidebar-body')).paddingBottom === '0px' &&
              getComputedStyle(document.querySelector('.app-rail')).display === 'none' &&
              document.querySelectorAll('.weq-mobile-tabs > button').length === 4
            );
          }),
          true,
          '直接使用 Remote 四入口底栏，隐藏旧桌面导航',
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${target}-${width}-${height}-${preset}-${theme}-list.png`),
          });
        await page.locator('.sidebar .conversation-row').first().click();
        await page.waitForFunction(
          () => getComputedStyle(document.querySelector('.chat-main')).visibility === 'visible',
        );
        await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
        await page
          .locator('.weq-mobile-tabs')
          .getByRole('button', { name: '更多', exact: true })
          .click();
        await page
          .locator('.weq-mobile-navigation > .weq-mobile-more')
          .getByRole('button', { name: '主页', exact: true })
          .click();
        assert.equal(
          await page.locator('[data-portrait-home]').evaluate((node) => {
            const box = node.getBoundingClientRect();
            const rail = document.querySelector('.weq-mobile-tabs').getBoundingClientRect();
            const chat = node.closest('.chat-main').getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && chat.bottom <= rail.top + 1;
          }),
          true,
          '主页正文可见且不覆盖导航',
        );
        await page
          .locator('.weq-mobile-tabs')
          .getByRole('button', { name: '消息', exact: true })
          .click();
        await page.locator('.sidebar .conversation-row').first().click();
        await page.waitForFunction(
          () => getComputedStyle(document.querySelector('.chat-main')).visibility === 'visible',
        );
      }
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ target, nativeControls, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

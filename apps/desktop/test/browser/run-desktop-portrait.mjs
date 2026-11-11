import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-desktop-portrait'),
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
  assert.equal(
    await page.locator('style[data-vite-dev-id$="/im-template/styles.css"]').count(),
    0,
    '模板样式仅经真实入口加载一次',
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
          () => document.querySelector('.chat-main').getBoundingClientRect().left === 0,
        );
      const fits = await page.evaluate(() => {
        const chat = document.querySelector('.chat-main').getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const titlebar = document.querySelector('.app-title-bar').getBoundingClientRect();
        return {
          desktop: !document.querySelector('.weq-web-shell'),
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
      });
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${height}-${preset}-${theme}.png`),
        });
      assert.deepEqual(
        fits,
        {
          desktop: true,
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
          () => document.querySelector('.chat-main').getBoundingClientRect().left >= innerWidth,
        );
        assert.equal(
          await page.evaluate(() => {
            const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
            const rail = document.querySelector('.app-rail').getBoundingClientRect();
            return (
              sidebar.bottom <= rail.top + 1 &&
              getComputedStyle(document.querySelector('.sidebar-body')).paddingBottom === '0px'
            );
          }),
          true,
          '会话列表底部避开导航栏',
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${width}-${height}-${preset}-${theme}-list.png`),
          });
        await page.locator('.sidebar .conversation-row').first().click();
        await page.waitForFunction(
          () => document.querySelector('.chat-main').getBoundingClientRect().left === 0,
        );
        await page.getByRole('button', { name: '主页', exact: true }).click();
        assert.equal(
          await page.locator('[data-portrait-home]').evaluate((node) => {
            const box = node.getBoundingClientRect();
            const rail = document.querySelector('.app-rail').getBoundingClientRect();
            const chat = node.closest('.chat-main').getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && chat.bottom <= rail.top + 1;
          }),
          true,
          '主页正文可见且不覆盖导航',
        );
        await page.getByRole('button', { name: '消息', exact: true }).click();
        await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
        await page.locator('.sidebar .conversation-row').first().click();
        await page.waitForFunction(
          () => document.querySelector('.chat-main').getBoundingClientRect().left === 0,
        );
      }
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

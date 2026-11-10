import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-order'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-directory-order.stub.ts'),
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const friends = page.locator('[data-kind="friends"]'),
    groups = page.locator('[data-kind="groups"]');
  await friends.locator('.weq-directory-order').waitFor();
  const output = process.env.WEQ_CONTACT_ORDER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // 用较短的真实滚动容器验证吸顶和分组交接，不依赖列表条数或固定栏高度。
  await friends.getByLabel('分组依据').selectOption('qq');
  await groups.getByLabel('分组依据').selectOption('capacity');
  for (const width of [1180, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ theme, width }) => {
          const state = window.contactOrderQa.store.getState();
          state.setPreference(theme);
          state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          state.setBackground(theme === 'light' ? 'plain' : 'grid');
          for (const directory of document.querySelectorAll('.weq-contact-directory')) {
            directory.style.height = '170px';
            directory.parentElement.style.width = width > 700 ? '240px' : '';
          }
        },
        { theme, width },
      );
      for (const list of [friends, groups]) {
        await list.scrollIntoViewIfNeeded();
        const headers = list.locator('.contact-cat-header:not([hidden])');
        for (const header of await headers.all())
          if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
        const scroll = list.locator('.weq-contact-directory-scroll');
        await scroll.evaluate((element) => {
          element.scrollTop = 0;
        });
        const toolbar = list.locator('.weq-directory-order');
        const initialToolbar = await toolbar.boundingBox();
        const scrollBounds = await scroll.boundingBox();
        assert.ok(initialToolbar.y + initialToolbar.height <= scrollBounds.y + 1);
        for (const index of [0, 1]) {
          const header = headers.nth(index);
          await header.evaluate((element) => {
            const scroll = element.closest('.weq-contact-directory-scroll');
            const section = element.parentElement;
            scroll.scrollTop +=
              section.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 20;
          });
          await page.waitForFunction(
            ({ kind, index }) => {
              const list = document.querySelector(`[data-kind="${kind}"]`);
              const scroll = list.querySelector('.weq-contact-directory-scroll');
              const header = list.querySelectorAll('.contact-cat-header:not([hidden])')[index];
              return (
                Math.abs(header.getBoundingClientRect().top - scroll.getBoundingClientRect().top) <
                1
              );
            },
            { kind: list === friends ? 'friends' : 'groups', index },
          );
          assert.deepEqual(await toolbar.boundingBox(), initialToolbar);
          const visibleHeader = await header.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return {
              onTop: element.contains(hit),
              hit: hit?.outerHTML.slice(0, 200),
              background: getComputedStyle(element).backgroundColor,
            };
          });
          assert.equal(
            visibleHeader.onTop,
            true,
            JSON.stringify({ width, theme, index, ...visibleHeader }),
          );
          assert.notEqual(visibleHeader.background, 'rgba(0, 0, 0, 0)');
        }
        if (output)
          await list.screenshot({
            path: resolve(
              output,
              `${width}-${theme}-${list === friends ? 'friends' : 'groups'}-sticky.png`,
            ),
          });
        await headers.nth(1).click();
        assert.equal(await headers.nth(1).getAttribute('aria-expanded'), 'false');
        await headers.nth(1).click();
        await list.getByLabel('分组依据').selectOption('none');
        assert.equal(await list.locator('.contact-cat-header:not([hidden])').count(), 0);
        await list.getByLabel('分组依据').selectOption(list === friends ? 'qq' : 'capacity');
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    '联系人固定工具栏、当前分组吸顶与交接、折叠、不分组、320/390/1180px 浅深主题验证通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

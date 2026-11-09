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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html?progress=running`,
  );
  const lists = page.locator('[data-kind="friends"], [data-kind="groups"]');
  for (const list of await lists.all())
    assert.equal(
      await list.locator('.weq-directory-order [role="status"]').textContent(),
      '信息与线索缓存更新中 2/6',
    );
  const output = process.env.WEQ_CONTACT_ORDER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(
        ({ width, theme }) => {
          for (const section of document.querySelectorAll(
            '[data-kind="friends"], [data-kind="groups"]',
          ))
            section.style.width = width > 700 ? '240px' : '';
          const state = window.contactOrderQa.store.getState();
          state.setPreference(theme);
          state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          state.setBackground(theme === 'light' ? 'plain' : 'grid');
        },
        { width, theme },
      );
      for (const list of await lists.all()) {
        assert.equal(await list.locator('[role="status"]').isVisible(), true);
        assert.equal(
          await list.locator('.weq-directory-order').evaluate((toolbar) => {
            const status = toolbar.querySelector('[role="status"]').getBoundingClientRect();
            const controls = [...toolbar.querySelectorAll('select, button')].map((element) =>
              element.getBoundingClientRect(),
            );
            return (
              toolbar.scrollWidth <= toolbar.clientWidth &&
              controls.every((rect) => rect.bottom <= status.top)
            );
          }),
          true,
        );
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  assert.deepEqual(errors, []);
  console.log('好友和群聊默认依据均显示缓存进度，240px 栏宽及 320/390/1180px 浅深主题验证通过');
} finally {
  await browser?.close();
  await server.close();
}

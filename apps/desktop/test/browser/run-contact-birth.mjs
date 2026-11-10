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
  cacheDir: resolve(root, 'node_modules/.vite-contact-birth'),
  plugins: [
    {
      name: 'contact-birth-fixture',
      enforce: 'pre',
      transform(source, id) {
        if (!id.endsWith('/test/browser/contact-directory-order.tsx')) return;
        return source
          .replace('age: 20 + i,', 'age: i === 1 ? 26 : undefined,')
          .replace('birthYear: 2005 + i,', 'birthYear: i === 0 ? 2000 : undefined,')
          .replace('birthMonth: i + 1,', 'birthMonth: 6,')
          .replace('birthDay: 15,', 'birthDay: 1,');
      },
    },
    react(),
    tailwind(),
  ],
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
  await page.clock.install({ time: new Date('2026-11-10T12:00:00+08:00') });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const friends = page.locator('[data-kind="friends"]');
  await friends.getByLabel('分组依据').selectOption('none');
  for (const sort of ['age', 'birthday']) {
    await friends.getByLabel('排序依据').selectOption(sort);
    const dialog = page.getByRole('dialog', { name: '更新信息与线索缓存', exact: true });
    if (await dialog.count()) {
      await dialog.getByRole('radio', { name: '不更新', exact: true }).click();
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
    }
    const expected =
      sort === 'age'
        ? ['2000-06-01 （26 岁）', '????-06-01 （26 岁）', '????-06-01 （?? 岁）']
        : ['????-06-01 （26 岁）', '2000-06-01 （26 岁）', '????-06-01 （?? 岁）'];
    await friends.locator('.weq-directory-sort-detail').first().waitFor();
    assert.deepEqual(
      await friends.locator('.weq-directory-sort-detail').allTextContents(),
      expected,
    );
  }
  const output = process.env.WEQ_CONTACT_SORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(
        ({ theme }) => {
          const state = window.contactOrderQa.store.getState();
          state.setPreference(theme);
          state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          state.setBackground(theme === 'light' ? 'plain' : 'grid');
        },
        { theme },
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok(
        await friends
          .locator('.weq-directory-sort-detail')
          .evaluateAll((elements) =>
            elements.every((element) => element.scrollWidth <= element.clientWidth),
          ),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('生日补全年龄、原始年龄同等显示、未知问号、双重排序及深浅主题窄屏检查通过');
} finally {
  await browser?.close();
  await server.close();
}

import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const errors = [];
  for (const target of ['metrics', 'groupMembers'])
    for (const status of ['running', 'paused'])
      for (const width of [1180, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) =>
          new URL(route.request().url()).hostname === '127.0.0.1'
            ? route.continue()
            : route.abort(),
        );
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html?progress=${status}&target=${target}`,
        );
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            const state = window.contactOrderQa.store.getState();
            state.setPreference(theme);
            state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            state.setBackground(theme === 'light' ? 'plain' : 'grid');
          }, theme);
          const before = await page.evaluate(
            () => window.contactOrderQa.tasks.getState().taskOpenRequest,
          );
          const friends = page.locator('[data-kind="friends"]');
          await friends.getByLabel('排序依据').selectOption('age');
          await friends.getByLabel('排序依据').selectOption('level');
          await friends.getByLabel('分组依据').selectOption('direction');
          await page
            .locator('[data-kind="groups"]')
            .getByLabel('排序依据')
            .selectOption('friendCount');
          assert.equal(await page.getByRole('dialog').count(), 0);
          assert.equal(
            await page.evaluate(() => window.contactOrderQa.tasks.getState().taskOpenRequest),
            before,
          );
          await page.getByRole('button', { name: '查看联系人更新任务', exact: true }).click();
          assert.equal(await page.getByRole('dialog').count(), 0);
          assert.equal(
            await page.evaluate(() => window.contactOrderQa.tasks.getState().taskOpenRequest),
            before + 1,
          );
          assert.equal(
            await page.evaluate(() => window.contactOrderQa.tasks.getState().taskFocusId),
            'background:host:existing-contact-task',
          );
        }
        await page.close();
      }
  assert.deepEqual(errors, []);
  console.log('两类任务运行/暂停时手动刷新聚焦原任务、分组排序静默切换：1180/390px 浅深主题通过');
} finally {
  await browser?.close();
  await server.close();
}

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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const output = process.env.WEQ_CONTACT_REFRESH_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        const state = window.contactOrderQa.store.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        state.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      await page.getByRole('button', { name: '刷新联系人列表', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '刷新联系人', exact: true });
      await dialog.waitFor();
      const help = dialog.getByText('选择信息与线索缓存的更新范围。', { exact: true });
      assert.equal(await help.isVisible(), true);
      assert.equal(await dialog.locator('dl').count(), 0);
      for (const name of ['超 24h 未更新', '全部', '不更新']) {
        await dialog.getByRole('radio', { name, exact: true }).click();
        assert.equal(
          await dialog.getByRole('radio', { name, exact: true }).getAttribute('aria-checked'),
          'true',
        );
        assert.equal(await help.isVisible(), true);
      }
      assert.equal(
        await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            element.scrollWidth <= element.clientWidth
          );
        }),
        true,
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const sort = page.locator('[data-kind="friends"]').getByLabel('排序依据');
      await sort.selectOption('age');
      await sort.selectOption('likeCount');
      const stale = page.getByRole('dialog', { name: '更新信息与线索缓存', exact: true });
      await stale.waitFor();
      assert.equal(
        await stale
          .getByText('所选依据的信息与线索缓存已超过 7 天或尚未建立，是否更新？', { exact: true })
          .isVisible(),
        true,
      );
      const prompt = stale.getByText('选择信息与线索缓存的更新范围。', { exact: true });
      assert.equal(await prompt.isVisible(), true);
      assert.equal(
        await prompt.evaluate((element) => element.nextElementSibling?.getAttribute('aria-label')),
        '信息与线索缓存更新范围',
      );
      assert.equal(await stale.locator('dl').count(), 0);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-stale.png`) });
      await stale.getByRole('button', { name: '取消', exact: true }).click();
    }
  assert.deepEqual(errors, []);
  console.log('主动刷新与缓存过期弹窗的选项前提示、选项切换、320/390/1180px 浅深主题验证通过');
} finally {
  await browser?.close();
  await server.close();
}

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
  cacheDir: resolve(root, 'node_modules/.vite-settings-autosave'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-autosave.stub.ts'),
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
  const page = await browser.newPage({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-autosave.html`,
  );
  const input = page.getByRole('spinbutton', { name: '翻页时间窗口（秒）' });
  await input.waitFor();
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
  assert.equal(await page.locator('.weq-set-card').last().getByRole('button').count(), 0);
  await input.fill('12');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.autosaveQa.calls.length), 0);
  await page.waitForFunction(() => window.autosaveQa.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.autosaveQa.calls[0].input), {
    windowSeconds: 12,
    maxPages: 5,
  });
  await input.fill('0');
  await input.press('Enter');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.autosaveQa.calls.length), 1);
  await input.fill('14');
  await input.press('Enter');
  await page.getByText('已保存', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.autosaveQa.delay = 500;
  });
  await input.fill('15');
  await input.press('Enter');
  await input.fill('16');
  await input.press('Enter');
  await page.waitForFunction(() => window.autosaveQa.settings.qzonePagination.windowSeconds === 16);
  assert.equal(await input.isDisabled(), false);
  await page.evaluate(() => {
    window.autosaveQa.delay = 0;
    window.autosaveQa.fail = true;
  });
  await input.fill('17');
  await input.press('Enter');
  await page.getByRole('button', { name: '重试保存' }).waitFor();
  const count = await page.evaluate(() => window.autosaveQa.calls.length);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.autosaveQa.calls.length), count);
  await page.evaluate(() => {
    window.autosaveQa.fail = false;
  });
  await page.getByRole('button', { name: '重试保存' }).click();
  await page.waitForFunction(() => window.autosaveQa.settings.qzonePagination.windowSeconds === 17);
  await page.getByRole('button', { name: '恢复在线翻页限速默认设置' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await input.inputValue(), '17');
  await page.getByRole('button', { name: '恢复在线翻页限速默认设置' }).click();
  await page.getByRole('button', { name: '确认恢复默认' }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.equal(await input.inputValue(), '10');
  await page.waitForTimeout(700);
  assert.equal(await input.inputValue(), '10');
  const output = resolve(root, 'node_modules/.cache/settings-autosave-qa');
  await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.themeQa.getState().setPreference(theme);
        window.themeQa.getState().setAccent(theme === 'light' ? '#086b40' : '#f6d54a');
      }, theme);
      await input.fill('20');
      await input.press('Enter');
      await page.getByRole('button', { name: '恢复本页默认设置' }).click();
      await page.getByRole('button', { name: '确认恢复默认' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const overlap = await page.evaluate(() =>
        [...document.querySelectorAll('.weq-set-card-head, .weq-set-head')].some((head) => {
          const title = head.querySelector('.weq-set-card-title, h3');
          const button = head.querySelector('.weq-settings-reset-button');
          if (!title || !button) return false;
          return title.getBoundingClientRect().right > button.getBoundingClientRect().left;
        }),
      );
      assert.equal(overlap, false);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      cases++;
    }
  await page.getByRole('button', { name: 'call-recording', exact: true }).click();
  await page.getByRole('button', { name: '恢复保存位置默认设置' }).click();
  assert.equal(await page.getByRole('combobox', { name: '通话录音目录' }).inputValue(), 'keep');
  assert.equal(await page.getByRole('button', { name: '确认恢复默认' }).isDisabled(), true);
  await page.getByRole('combobox', { name: '通话录音目录' }).selectOption('reset');
  assert.equal(await page.getByRole('button', { name: '确认恢复默认' }).isEnabled(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

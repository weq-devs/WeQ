import {
  chooseDirectorySort,
  chooseDirectorySortDirection,
  chooseFormOption,
} from './form-select.mjs';
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
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-11-11T12:00:00+08:00') });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-birth.html`;
  await page.goto(url);
  const directory = page.locator('[data-kind="directory"]');
  await chooseFormOption(directory.getByLabel('分组依据'), 'none');
  await chooseDirectorySort(directory, 'birthday');
  const names = () => directory.locator('.contact-row .row-title-text').allTextContents();
  assert.deepEqual(await names(), ['跨年摩羯座', '前一天', '缓存水瓶座', '准确生日', '后一天']);
  const range = directory.locator('.contact-row').filter({ hasText: '缓存水瓶座' });
  assert.ok((await range.textContent()).includes('2010 年（推断）'));
  assert.ok(!(await range.textContent()).includes('月日未记录'));
  const hover = await range.locator('[title*="推断生日"]').getAttribute('title');
  assert.ok(hover.includes('1 月 20 日至 2 月 18 日'));
  await chooseDirectorySortDirection(directory, '年末的在前');
  assert.deepEqual(await names(), ['后一天', '缓存水瓶座', '准确生日', '前一天', '跨年摩羯座']);
  await chooseFormOption(directory.getByLabel('分组依据'), 'birthYear');
  assert.ok((await directory.locator('.contact-cat-name').allTextContents()).includes('2010 年'));
  await chooseFormOption(directory.getByLabel('分组依据'), 'constellation');
  assert.deepEqual(
    new Set(await directory.locator('.contact-cat-name').allTextContents()),
    new Set(['水瓶座', '摩羯座']),
  );
  await chooseFormOption(directory.getByLabel('分组依据'), 'none');
  const output = process.env.WEQ_BIRTH_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        const state = window.contactBirthQa.store.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        state.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      const profile = page.locator('[data-kind="profile"]');
      const range = profile.getByText('2010 年 1 月 20 日至 2 月 18 日', { exact: true });
      await range.waitFor();
      await profile.getByText('按星座推算', { exact: true }).waitFor();
      await profile.getByText('水瓶座', { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await range.evaluate((element) => element.scrollWidth > element.clientWidth),
        false,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  await page.goto(`${url}?member=1`);
  const member = page.locator('.weq-member-pop');
  await member.waitFor();
  await member.getByText('1 月 20 日至 2 月 18 日', { exact: true }).waitFor();
  await member.getByText('按星座推算', { exact: true }).waitFor();
  assert.equal(
    await member.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  if (output) await page.screenshot({ path: resolve(output, 'member-320-dark.png') });
  await page.goto(`${url}?member=cap`);
  const disclosure = member.getByText('查看可能日期', { exact: true });
  const possibleDate = member.getByText('12 月 22 日至 12 月 31 日', { exact: true });
  await disclosure.waitFor();
  assert.equal(await possibleDate.isVisible(), false);
  await disclosure.press('Enter');
  await possibleDate.waitFor();
  await member.getByText('1 月 1 日至 1 月 19 日', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('生日双向排序、星座和推断年份分组、资料与群友名片直接展示验证通过');
} finally {
  await browser?.close();
  await server.close();
}

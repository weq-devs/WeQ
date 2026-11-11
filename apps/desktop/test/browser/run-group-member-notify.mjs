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
  cacheDir: resolve(root, 'node_modules/.vite-member-notify'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-member-notify.stub.ts'),
      },
      {
        find: /^.*\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/group-member-notify.stub.ts'),
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-member-notify.html`,
  );
  await page.getByText('默认', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.memberNotifyQa.counters.reads), 1);
  await page.getByRole('button', { name: '群内消息提醒', exact: true }).click();
  const submenu = page.locator('.weq-member-notify-choices');
  await submenu.getByRole('menuitemradio', { name: '默认' }).waitFor();
  assert.equal(await page.evaluate(() => window.memberNotifyQa.counters.reads), 1);
  await submenu.getByRole('menuitemradio', { name: '特别关注' }).click();
  await page.waitForFunction(() => window.memberNotifyQa.counters.checks === 1);
  await submenu.getByRole('menuitemradio', { name: '特别关注', checked: true }).waitFor();
  assert.equal(await page.evaluate(() => window.memberNotifyQa.counters.writes), 1);
  await page.locator('.weq-profile-list').getByText('特别关注', { exact: true }).waitFor();
  for (const label of ['屏蔽此人', '默认']) {
    await page.getByRole('button', { name: '设置群内消息提醒', exact: true }).click();
    const choices = page.locator('.weq-conversation-actions-menu[aria-label="群内消息提醒"]');
    await choices.getByRole('menuitemradio', { name: label, exact: true }).click();
    await choices.waitFor({ state: 'hidden' });
    await submenu.getByRole('menuitemradio', { name: label, checked: true, exact: true }).waitFor();
    await page.locator('.weq-profile-list').getByText(label, { exact: true }).waitFor();
  }
  assert.equal(await page.evaluate(() => window.memberNotifyQa.counters.writes), 3);
  const output = process.env.WEQ_MEMBER_NOTIFY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate((theme) => {
        window.memberNotifyQa.theme.getState().setPreference(theme);
        window.memberNotifyQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      const menu = page.locator('.avatar-context-menu');
      const bounds = await menu.boundingBox();
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= 701,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await submenu.getByRole('menuitemradio', { name: '特别关注' }).evaluate((button) => {
          const icon = button.querySelector('svg').getBoundingClientRect();
          const label = button.querySelector('span').getBoundingClientRect();
          return Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2) < 2;
        }),
        true,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  await submenu.getByRole('menuitemradio', { name: '默认' }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '特别关注');
  assert.deepEqual(errors, []);
  console.log('成员提醒两个入口共享状态、写后确认、键盘与六组宽度／主题检查通过');
} finally {
  await browser?.close();
  await server.close();
}

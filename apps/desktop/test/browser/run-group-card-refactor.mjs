import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-card-refactor'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-card-refactor.stub.ts'),
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
const output = process.env.WEQ_GROUP_CARD_ARTIFACTS;
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    ['127.0.0.1'].includes(new URL(route.request().url()).hostname) ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-card-refactor.html`,
  );
  await page.getByText('我的群备注', { exact: true }).waitFor();
  await page.waitForFunction(() => window.groupCardFirstPaint);
  const firstPaint = await page.evaluate(() => window.groupCardFirstPaint);
  assert.equal(firstPaint.name, '我的群备注');
  assert.equal(firstPaint.hasDescription, true);
  assert.equal(firstPaint.avatars, 0);
  assert.equal(await page.getByText('只在完整资料显示的公告', { exact: true }).count(), 0);
  await page.locator('.weq-group-preview-avatars button').nth(7).waitFor();
  assert.equal(await page.locator('.weq-group-preview-avatars button').count(), 8);
  assert.match(
    await page.locator('.weq-group-preview-avatars button').first().getAttribute('title'),
    /8/,
  );
  const calls = await page.evaluate(() => window.groupCardCalls);
  assert.equal(calls.includes('account.getGroupExtendedProfile'), false);
  assert.equal(calls.includes('account.listGroupMembers'), false);
  assert.equal(calls.filter((x) => x === 'account.groupMemberPreview').length, 1);
  await page.getByRole('button', { name: '展开', exact: true }).click();
  assert.equal(await page.locator('.weq-group-description .is-clamped').count(), 0);
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.locator('.weq-group-preview-avatars button').first().click();
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: '群资料', exact: true }).waitFor();
  await page.getByRole('button', { name: '完整群资料', exact: true }).click();
  await page.getByRole('navigation', { name: '群详情分区' }).waitFor();
  const nav = page.getByRole('navigation', { name: '群详情分区' });
  await nav.getByRole('button', { name: '详细资料', exact: true }).click();
  await page.getByText('105 人', { exact: true }).waitFor();
  assert.equal(await page.locator('.weq-profile-tech').first().getAttribute('open'), null);
  await nav.getByRole('button', { name: '成员', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索群成员' }).fill('成员3');
  await page.waitForFunction(() => window.groupCardCalls.includes('account.searchGroupMembers'));
  await page.getByText('成员 3', { exact: true }).last().waitFor();
  assert.equal(await page.locator('.group-info-member-row:visible').count(), 1);
  for (const title of ['公告', '相册', '文件', '精华', '打卡', '群管理', '资料历史']) {
    await nav.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('region', { name: title, exact: true }).first().waitFor();
  }
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.groupCardQa.theme.getState().setPreference(theme);
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.evaluate(
        (theme) =>
          window.groupCardQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1'),
        theme,
      );
      if (width > 720) await nav.getByRole('button', { name: '概览', exact: true }).click();
      else
        await page
          .getByRole('tablist', { name: '群详情分区' })
          .getByRole('tab', { name: '概览', exact: true })
          .click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok(
        await page
          .locator('.weq-group-page')
          .evaluate((element) => element.getBoundingClientRect().width >= innerWidth - 32),
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.groupCardQa.long());
  await page.waitForFunction(
    () => document.querySelector('.weq-profile-name')?.textContent.length >= 60,
  );
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(
    await page
      .locator('.weq-profile-workspace-body')
      .evaluate((element) => element.getBoundingClientRect().height > 48),
  );
  if (output) await page.screenshot({ path: resolve(output, '320-dark-long.png') });
  const result = {
    firstPaint,
    checks: [
      'identity-first',
      'eight-friend-priority',
      'no-heavy-card-requests',
      'nested-return',
      'shared-directory',
      'details-only-extension',
      'member-search',
      'six-responsive-theme-captures',
      'long-names-remain-navigable',
    ],
    calls: await page.evaluate(() => window.groupCardCalls),
    errors,
  };
  if (output) await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-notification-settings'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/notification-settings.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultNavigationTimeout(120000);
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_NOTIFICATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const [width, height] of [
    [320, 740],
    [390, 920],
    [844, 390],
    [1180, 920],
  ])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/notification-settings.html`,
      );
      await page.evaluate((theme) => {
        const store = window.notificationTheme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
        store.setBackground(theme === 'light' ? 'grid' : 'telegram');
      }, theme);
      assert.equal(
        await page.getByRole('switch', { name: '在邮箱图标上显示红点', exact: true }).count(),
        0,
      );
      await page.getByRole('button', { name: '邮箱红点设置', exact: true }).click();
      const badge = page.locator(
        '[data-settings-page="global"] [data-setting-id="mail-unread-badge"]',
      );
      await badge.locator('[data-search-highlight]').count();
      await badge.getByRole('switch').waitFor();
      assert.equal(await badge.getByRole('switch').getAttribute('aria-checked'), 'false');
      assert.equal(await badge.getAttribute('data-search-highlight'), 'true');
      await badge.getByRole('switch').click();
      await page.waitForFunction(() => window.notificationFixture.mail.showUnread);
      assert.equal(await badge.getByRole('switch').getAttribute('aria-checked'), 'true');
      assert.equal(
        await page
          .getByRole('switch', { name: '在消息图标上显示红点', exact: true })
          .getAttribute('aria-checked'),
        'false',
      );
      assert.equal(
        await page.getByRole('switch', { name: '数据库异常时弹窗提醒', exact: true }).count(),
        0,
      );
      assert.equal(await page.locator('.weq-notification-event').count(), 0);
      assert.equal(await page.locator('.weq-notification-table thead th').count(), 3);
      for (const label of ['普通消息', '重点消息', '其他动态', '应用与任务'])
        await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await page.locator('.weq-notification-event').count(), 23);
      const damageBanner = page.getByRole('switch', {
        name: '数据库异常提醒：应用内横幅通知',
        exact: true,
      });
      const damageSystem = page.getByRole('switch', {
        name: '数据库异常提醒：系统通知',
        exact: true,
      });
      assert.equal(await damageBanner.getAttribute('aria-checked'), 'true');
      assert.equal(await damageSystem.getAttribute('aria-checked'), 'false');
      await damageBanner.click();
      await page.waitForFunction(
        () => !window.notificationFixture.settings.notificationEvents.databaseDamage.banner,
      );
      assert.equal(await damageSystem.getAttribute('aria-checked'), 'false');
      await damageBanner.click();
      await page.waitForFunction(
        () => window.notificationFixture.settings.notificationEvents.databaseDamage.banner,
      );
      assert.equal(
        await page.getByRole('button', { name: '选择提醒会话', exact: false }).count(),
        5,
      );
      for (const [label, event] of [
        ['@自己', 'mentionMe'],
        ['@全体成员', 'mentionAll'],
        ['引用／回复我', 'replyMe'],
        ['红包消息', 'redPacket'],
      ]) {
        const trigger = page.getByRole('button', { name: `${label}：选择提醒会话`, exact: true });
        await trigger.click();
        const scopeDialog = page.getByRole('dialog', { name: `${label} · 提醒会话`, exact: true });
        const checkScopeLayout = async () => {
          const sizes = await scopeDialog.evaluate((node) => ({
            header: node.querySelector('.weq-page-head').getBoundingClientRect().height,
            options: [...node.querySelectorAll('[role="radio"]')].map(
              (button) => button.getBoundingClientRect().height,
            ),
            overflow: node.scrollWidth > node.clientWidth,
          }));
          assert(sizes.header <= 96, JSON.stringify(sizes));
          assert(
            sizes.options.every((height) => height >= 28 && height <= 48),
            JSON.stringify(sizes),
          );
          assert.equal(sizes.overflow, false);
        };
        await checkScopeLayout();
        await scopeDialog.getByRole('radio', { name: '全部适用会话', exact: true }).click();
        await checkScopeLayout();
        assert.equal(await scopeDialog.locator('.weq-exp-picker').count(), 0);
        await scopeDialog.getByRole('radio', { name: '指定会话', exact: true }).click();
        const search = scopeDialog.getByPlaceholder('搜索会话名称或号码');
        const pickerLayout = await scopeDialog.locator('.weq-exp-picker').evaluate((node) => ({
          display: getComputedStyle(node).display,
          searchHeight: node.querySelector('.weq-exp-search').getBoundingClientRect().height,
          rowHeight: node.querySelector('.weq-exp-row').getBoundingClientRect().height,
          rowDisplay: getComputedStyle(node.querySelector('.weq-exp-row')).display,
          toolbarHeights: [...node.querySelectorAll('.weq-exp-tool')].map(
            (button) => button.getBoundingClientRect().height,
          ),
        }));
        assert.equal(pickerLayout.display, 'flex');
        assert.equal(pickerLayout.rowDisplay, 'flex');
        assert(pickerLayout.searchHeight >= 30 && pickerLayout.searchHeight <= 48);
        assert.equal(pickerLayout.rowHeight, 64);
        assert(pickerLayout.toolbarHeights.every((size) => size >= 24 && size <= 48));
        await search.fill('没有这个会话');
        await scopeDialog.getByText('没有匹配的会话', { exact: true }).waitFor();
        await search.fill('20001');
        await scopeDialog.getByText('合成提醒群', { exact: true }).waitFor();
        if (output && event === 'mentionMe')
          await page.screenshot({ path: resolve(output, `${width}-${theme}-scope.png`) });
        await scopeDialog.getByText('合成提醒群', { exact: true }).click();
        await scopeDialog.getByRole('button', { name: '保存选择', exact: true }).click();
        await page.waitForFunction(
          (event) => window.notificationFixture.records.notifications?.[event],
          event,
        );
        assert.deepEqual(
          await page.evaluate(
            (event) => window.notificationFixture.records.notifications[event],
            event,
          ),
          { mode: 'selected', targets: ['group:20001'] },
        );
        await trigger.click();
        assert.equal(
          await scopeDialog.locator('.weq-exp-row').getAttribute('aria-pressed'),
          'true',
        );
        await scopeDialog.getByRole('button', { name: '关闭', exact: true }).click();
      }
      const important = page.getByRole('checkbox', { name: '重点消息：系统通知', exact: true });
      assert.equal(await important.getAttribute('aria-checked'), 'mixed');
      await important.click();
      await page.waitForFunction(
        () => window.notificationFixture.settings.notificationEvents.redPacket.system,
      );
      assert.equal(await important.getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('.weq-notification-event').count(), 23);
      await important.click();
      await page.waitForFunction(
        () => !window.notificationFixture.settings.notificationEvents.mentionMe.system,
      );
      assert.equal(await important.getAttribute('aria-checked'), 'false');
      await page.getByRole('button', { name: '撤回提醒：选择提醒会话', exact: true }).click();
      await page.getByText('合成提醒群', { exact: true }).waitFor();
      await page.getByRole('button', { name: '保存选择', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.notificationFixture.recall.notifyTargets), [
        'group:20001',
      ]);
      await page
        .locator('.weq-tool-modal')
        .getByRole('button', { name: '关闭', exact: true })
        .first()
        .click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const overlaps = await page.locator('.weq-settings-body .weq-set-row').evaluateAll((rows) =>
        rows
          .filter((row) => {
            const label = row.querySelector('.weq-set-row-main')?.getBoundingClientRect();
            const control = row.querySelector('.weq-set-row-ctrl')?.getBoundingClientRect();
            return (
              label &&
              control &&
              label.top < control.bottom &&
              control.top < label.bottom &&
              label.right > control.left + 1
            );
          })
          .map((row) => row.textContent),
      );
      assert.deepEqual(overlaps, []);
      if (output) {
        await page.locator('.weq-notification-table').scrollIntoViewIfNeeded();
        const sticky = await page.locator('.weq-notification-table').evaluate((node) => ({
          scrollTop: node.closest('.weq-settings-body').getBoundingClientRect().top,
          headers: [...node.querySelectorAll('thead th')].map(
            (cell) => cell.getBoundingClientRect().top,
          ),
        }));
        assert(
          sticky.headers.every((top) => Math.abs(top - sticky.scrollTop) <= 2),
          JSON.stringify(sticky),
        );
        await page.locator('.weq-settings-body').evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.screenshot({ path: resolve(output, `${width}-${theme}-events.png`) });
        await badge.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
        await page.locator('[data-setting-id="damage-reminder"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(output, `${width}-${theme}-database-damage.png`) });
      }
      cases++;
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, preservedRecallTargets: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}

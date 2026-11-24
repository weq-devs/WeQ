import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-message-settings'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/message-settings.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const errors = [];
const jumpOnly = process.argv.includes('--jump-only');
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/message-settings.html`;
  const output = process.env.WEQ_MESSAGE_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  if (jumpOnly) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}?section=message-display`);
    const body = page.locator('.weq-settings-body');
    const exact = (name) => ({ name, exact: true });
    const important = body.getByRole('combobox', exact('重要消息入口'));
    const reading = body.getByRole('combobox', exact('继续上次阅读按钮'));
    const automatic = body.getByRole('switch', exact('打开会话时继续上次阅读'));
    async function selectMode(row, option) {
      await row.click();
      await page.getByRole('option', exact(option)).click();
      await row.filter({ hasText: option }).waitFor();
    }
    await selectMode(important, '仅首次提示');
    await selectMode(reading, '仅首次提示');
    await automatic.click();
    await reading.waitFor({ state: 'detached' });
    await important.waitFor();
    const toggle = body.getByRole('switch', exact('合并首条未读和重要消息入口'));
    await toggle.click();
    const combined = body.getByRole('combobox', exact('合并入口'));
    await selectMode(combined, '不显示');
    assert.equal(await important.count(), 0);
    assert.equal(await reading.count(), 0);
    await automatic.click();
    const savedReadingMode = reading.filter({ hasText: '仅首次提示' });
    await savedReadingMode.waitFor();
    await combined.filter({ hasText: '不显示' }).waitFor();
    await toggle.click();
    await important.waitFor();
    await savedReadingMode.waitFor();
    await important.filter({ hasText: '仅首次提示' }).waitFor();
    assert.equal(await body.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
  }
  for (const width of jumpOnly ? [] : [1280, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [section, title] of [
        ['chat-messages', '会话列表'],
        ['message-display', '消息阅读'],
      ]) {
        await page.goto(`${base}?section=${section}`);
        await page.locator('.weq-settings-body h3').filter({ hasText: title }).waitFor();
        await page.evaluate(
          ({ theme, width }) => {
            window.settingsAuditQa.theme.getState().setPreference(theme);
            window.settingsAuditQa.theme
              .getState()
              .setAccent(width === 1280 ? '#167d41' : '#c02e48');
            window.settingsAuditQa.theme
              .getState()
              .setBackground(width === 1280 ? 'grid' : 'paper');
          },
          { theme, width },
        );
        await page.waitForTimeout(200);
        const body = page.locator('.weq-settings-body');
        assert.equal(
          await body.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
          false,
          `${width}/${theme}/${title} 横向溢出`,
        );
        assert.equal(await body.locator('.weq-set-card .weq-set-card').count(), 0);
        if (section === 'chat-messages') {
          assert.deepEqual(await body.locator('.weq-set-card-title').allTextContents(), [
            '全部会话视图',
            '列表排序',
            '未读标记',
          ]);
          await body.getByRole('button', { name: '清除 WeQ 已读记录', exact: true }).click();
          await page.getByRole('button', { name: '清除', exact: true }).click();
          await body.getByRole('status').filter({ hasText: '已清除' }).waitFor();
          assert.deepEqual(await page.evaluate(() => window.messageSettingsQa.clearCalls), [
            { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
          ]);
        } else {
          assert.deepEqual(await body.locator('.weq-set-card-title').allTextContents(), [
            '打开会话',
            '未读与重要消息',
            '浏览消息',
            '历史消息补全',
            '内容显示',
          ]);
          const group = body.getByRole('group', { name: '个性装扮', exact: true });
          const bubble = group.getByRole('button', { name: '消息气泡', exact: true });
          const before = await bubble.getAttribute('aria-pressed');
          await bubble.click();
          await page.waitForFunction(
            ({ before }) =>
              document
                .querySelector('[data-setting-id="message-bubble"]')
                .getAttribute('aria-pressed') !== before,
            { before },
          );
          assert.equal(
            await group
              .getByRole('button', { name: '消息字体', exact: true })
              .getAttribute('aria-pressed'),
            'true',
          );
          const child = body.locator('[data-setting-id="link-screenshot"]');
          await body.getByRole('switch', { name: '自动联网补全链接预览', exact: true }).click();
          assert.equal(await child.evaluate((node) => node.classList.contains('is-indent')), true);
          const parentX = await body
            .locator('[data-setting-id="link-preview"] .weq-set-row-label')
            .evaluate((node) => node.getBoundingClientRect().left);
          const childX = await child
            .locator('.weq-set-row-label')
            .evaluate((node) => node.getBoundingClientRect().left);
          assert(childX > parentX + 10, '截图子项没有实际缩进');
          await body.getByRole('switch', { name: '链接预览卡片', exact: true }).click();
          assert.equal(await child.count(), 0);
          await body.getByRole('switch', { name: '链接预览卡片', exact: true }).click();
          await child.waitFor();
        }
        if (output)
          await page.screenshot({
            path: resolve(output, `${section}-${width}-${theme}.png`),
            fullPage: true,
          });
        if (section === 'message-display') {
          const last = body.locator('[data-setting-id="link-preview"]');
          await last.scrollIntoViewIfNeeded();
          assert(await last.isVisible(), '链接预览设置无法滚动到达');
          if (output)
            await page.screenshot({
              path: resolve(output, `${section}-${width}-${theme}-bottom.png`),
              fullPage: true,
            });
        }
      }
    }
  assert.deepEqual(errors, []);
  console.log(
    jumpOnly
      ? '聊天跳转设置浏览器回归通过：合并与分开切换、各项偏好保留、竖屏无溢出。'
      : '消息设置浏览器回归通过：桌面/手机、深浅主题、主题色与背景、多选独立保存、子项缩进及清除操作。',
  );
} finally {
  await browser?.close();
  await server.close();
}

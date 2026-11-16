import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SETTINGS_ARTIFACTS ?? resolve(root, '.artifacts/enhancement-ui');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-enhancements'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/enhancements.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/enhancements.html'] },
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/enhancements.html`;
  let cases = 0;
  for (const width of [1024, 640, 390, 320])
    for (const theme of ['light', 'dark'])
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url);
        await page.locator('.weq-set-card').first().waitFor();
        await page.evaluate(
          ({ theme, style }) => {
            const state = window.enhancementTheme.getState();
            state.setPreference(theme);
            state.setComponentStyle(style);
            state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          },
          { theme, style },
        );
        assert.equal(await page.locator('.weq-set-card').count(), 2);
        assert.equal(await page.locator('.weq-enhancement-item').count(), 4);
        assert.equal(await page.getByRole('button', { name: '恢复本页默认设置' }).count(), 1);
        const buttons = await page.locator('.weq-enhancement-actions button').evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, text: node.textContent };
          }),
        );
        assert.ok(buttons.every((button) => button.text.trim() === ''));
        assert.ok(
          buttons.every(
            (button) =>
              Math.abs(button.width - buttons[0].width) <= 1 &&
              Math.abs(button.height - buttons[0].height) <= 1,
          ),
          `下载和删除按钮必须同尺寸：${JSON.stringify({ width, theme, style, buttons })}`,
        );
        assert.equal(await page.getByRole('switch').count(), 2);
        assert.equal(await page.locator('progress').count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          '页面不能横向溢出',
        );
        const overflow = await page
          .locator('.weq-set')
          .evaluate((root) =>
            [...root.querySelectorAll('button, .weq-set-card-desc, .weq-set-card-title')]
              .filter((node) => node.scrollWidth > node.clientWidth + 2)
              .map((node) => node.textContent),
          );
        assert.deepEqual(overflow, [], '按钮和文案不能溢出');
        if (style === 'qqnt')
          await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
        cases++;
      }
  await page.goto(`${url}?recognition=1`);
  assert.equal(await page.locator('input[type="number"]').count(), 2);
  assert.equal(await page.getByRole('button', { name: '增强包', exact: true }).count(), 0);
  await page.goto(`${url}?state=empty`);
  assert.equal(await page.getByRole('button', { name: /^下载全部/ }).count(), 0);
  await page.getByRole('button', { name: '下载本地文字识别', exact: true }).click();
  await page.getByRole('button', { name: '删除本地文字识别', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-enhancement-item').count(), 4);
  await page.getByRole('button', { name: '删除本地文字识别', exact: true }).click();
  const confirmation = page.locator('.weq-dialog');
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '删除本地文字识别', exact: true }).count(),
    1,
  );
  await page.getByRole('button', { name: '删除本地文字识别', exact: true }).click();
  await confirmation.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '下载本地文字识别', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('[data-setting-id="enhancement-text"] .weq-enhancement-actions button')
      .count(),
    2,
  );
  await page.goto(`${url}?state=busy`);
  assert.equal(await page.locator('progress').evaluate((node) => node.value), 50);
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(`${url}?state=retrying`);
      await page.evaluate(
        (theme) => window.enhancementTheme.getState().setPreference(theme),
        theme,
      );
      await page
        .getByText('等待自动重试 · github-proxy.memory-echoes.cn', { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: resolve(output, `retrying-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.goto(`${url}?state=failed`);
  assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1);
  await page.goto(`${url}?state=update`);
  assert.equal(
    await page.getByRole('button', { name: '更新本地文字识别', exact: true }).count(),
    1,
  );
  await page.goto(`${url}?state=incompatible`);
  assert.equal(await page.getByRole('link', { name: '前往 WeQ 更新' }).count(), 1);
  await page.getByRole('switch', { name: '自动检查增强包更新', exact: true }).click();
  assert.equal(
    await page.getByRole('switch', { name: '自动安装增强包更新', exact: true }).count(),
    0,
  );
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${url}?state=partial`);
    const row = page.locator('[data-setting-id="enhancement-text"]');
    assert.equal(await row.locator('.weq-enhancement-actions button').count(), 3);
    assert.equal(
      await row.getByRole('button', { name: '补齐本地文字识别', exact: true }).count(),
      1,
    );
    assert.equal(await row.locator('.weq-enhancement-status').textContent(), '待补齐');
    assert.match(
      await row.locator('.weq-enhancement-status').getAttribute('title'),
      /文字筛图模型/,
    );
    assert.equal(await page.locator('details').count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const state = window.enhancementTheme.getState();
        state.setPreference(theme);
        state.setComponentStyle('qqnt');
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.screenshot({
        path: resolve(output, `partial-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  assert.deepEqual(errors, []);
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(`${url}?notice=1`);
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await page.evaluate((theme) => {
        const state = window.enhancementTheme.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      assert.equal(await dialog.locator('li').count(), 2);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.getByRole('dialog').count(), 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const overflow = await dialog.evaluate((root) =>
        [...root.querySelectorAll('h3, p, li, button')]
          .filter((node) => node.scrollWidth > node.clientWidth + 2)
          .map((node) => node.textContent),
      );
      assert.deepEqual(overflow, []);
      await page.screenshot({
        path: resolve(output, `notice-${theme}-${width}.png`),
        fullPage: true,
      });
      await dialog.getByRole('button', { name: '前往增强包', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(
        await page.locator('body').getAttribute('data-settings-section'),
        'enhancementPacks',
      );
    }
  }
  await page.goto(`${url}?notice=1`);
  await page.getByRole('dialog').getByRole('button', { name: '稍后', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('body').getAttribute('data-settings-section'), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, output }));
} finally {
  await browser?.close();
  await server.close();
}

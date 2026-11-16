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
  cacheDir: resolve(root, 'node_modules/.vite-database-management'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/database-management.stub.ts'),
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_DATABASE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-management.html?reading=1`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#006d50' : '#f5cb70',
        );
      }, theme);
      await page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true }).waitFor();
      assert.equal(await page.locator('.weq-set-card .weq-set-card').count(), 0);
      const input = page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true });
      const stepper = await input.evaluate((node) => ({
        appearance: getComputedStyle(node).appearance,
      }));
      assert.equal(stepper.appearance, 'textfield', '外部加减按钮不应叠加原生步进器');
      const typography = await page.evaluate(() => {
        const samples = document.createElement('div');
        samples.innerHTML = `
          <span class="weq-number">1234</span>
          <input class="weq-set-input" type="number" value="1234">
          <input class="weq-set-input" type="number" step="0.1" value="0.7">
          <input class="weq-set-input" inputmode="numeric" value="1234">
          <input class="weq-set-input" inputmode="decimal" value="0.7">
          <input class="weq-set-input" type="text" value="普通文本">
        `;
        document.querySelector('.weq-set').append(samples);
        const read = (node) => {
          const style = getComputedStyle(node);
          return [
            style.fontFamily,
            style.fontWeight,
            style.fontVariantNumeric,
            style.letterSpacing,
          ];
        };
        const values = [...samples.children].map(read);
        samples.remove();
        return values;
      });
      for (const sample of typography.slice(1, -1))
        assert.deepEqual(sample, typography[0], '设置数字框统一使用截图中的编号字体');
      assert.notDeepEqual(typography.at(-1), typography[0], '普通文本框不受影响');
      const increase = page.getByRole('button', { name: '增加数据库读取并发', exact: true });
      const decrease = page.getByRole('button', { name: '减少数据库读取并发', exact: true });
      await increase.click();
      assert.equal(await input.inputValue(), '5');
      await page.waitForFunction(() => window.databaseQa.changes.includes(5));
      await decrease.click();
      assert.equal(await input.inputValue(), '4');
      await page.waitForFunction(() => window.databaseQa.changes.includes(4));
      await input.press('ArrowUp');
      assert.equal(await input.inputValue(), '5');
      await input.press('ArrowDown');
      assert.equal(await input.inputValue(), '4');
      await input.fill('8');
      await input.press('Enter');
      await page.waitForFunction(() => window.databaseQa.changes.includes(8));
      assert.equal(await increase.isDisabled(), true);
      await input.fill('9');
      await input.press('Enter');
      assert.equal(await input.inputValue(), '8');
      await input.fill('1');
      await input.press('Enter');
      await page.waitForFunction(() => window.databaseQa.changes.includes(1));
      assert.equal(await decrease.isDisabled(), true);
      if (output)
        await page.screenshot({
          path: resolve(output, `reading-${width}-${theme}.png`),
          fullPage: true,
        });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-management.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#006d50' : '#f5cb70',
        );
      }, theme);
      await page.getByRole('button', { name: '打开数据库浏览', exact: true }).waitFor();
      assert.deepEqual(await page.locator('.weq-set-card-title').allTextContents(), [
        '数据库浏览',
        '监听与读取',
        '容错与修复',
      ]);
      assert.equal(
        await page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true }).count(),
        1,
      );
      const listen = page.getByRole('switch', { name: '启用数据库监听', exact: true });
      await listen.click();
      assert.equal(await listen.getAttribute('aria-checked'), 'false');
      await listen.click();
      assert.equal(await listen.getAttribute('aria-checked'), 'true');
      const level = page.getByRole('combobox', { name: '数据库容错级别', exact: true });
      await level.selectOption('2');
      assert.equal(await page.evaluate(() => window.databaseQa.levels.length), 0);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await level.inputValue(), '0');
      await level.selectOption('1');
      await page.waitForFunction(() => window.databaseQa.levels.includes(1));
      await level.selectOption('0');
      await page.waitForFunction(() => window.databaseQa.levels.includes(0));
      assert.equal(await page.getByText('默认严格模式：', { exact: false }).count(), 0);
      assert.equal(await page.getByRole('heading', { name: '损坏提醒', exact: true }).count(), 0);
      const recordAlignment = await page
        .locator('[data-setting-id="tolerance-records"]')
        .evaluate((node) => {
          const title = node.querySelector('h4').getBoundingClientRect();
          const count = node.querySelector('[role="status"]').getBoundingClientRect();
          return Math.abs(title.top + title.height / 2 - count.top - count.height / 2);
        });
      assert.ok(recordAlignment < 2);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, `management-${width}-${theme}.png`),
          fullPage: true,
        });
      if (width === 1180) {
        const [popup] = await Promise.all([
          page.waitForEvent('popup'),
          page.getByRole('button', { name: '打开数据库浏览', exact: true }).click(),
        ]);
        popup.on('pageerror', (error) => errors.push(error.message));
        await popup.getByText('合成数据库记录', { exact: true }).waitFor();
        await page.getByRole('button', { name: '打开数据库浏览', exact: true }).click();
        assert.equal(browser.contexts()[0].pages().length, 2);
        await page.getByRole('button', { name: '关闭设置', exact: true }).click();
        assert.equal(popup.isClosed(), false);
        if (output) await popup.screenshot({ path: resolve(output, `browser-${theme}.png`) });
        await popup.getByRole('button', { name: '关闭数据库浏览', exact: true }).click();
      } else {
        await page.getByRole('button', { name: '打开数据库浏览', exact: true }).click();
        await page.getByText('合成数据库记录', { exact: true }).waitFor();
        assert.equal(browser.contexts()[0].pages().length, 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (output)
          await page.screenshot({ path: resolve(output, `browser-${width}-${theme}.png`) });
      }
    }
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-management.html?reading=1&legacy-native=1`,
  );
  await page
    .getByText('当前原生组件仅支持串行读取；保存的上限将在组件更新后生效。', { exact: true })
    .waitFor();
  const legacyLimit = page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true });
  await legacyLimit.fill('6');
  await legacyLimit.press('Enter');
  await page.waitForFunction(() => window.databaseQa.changes.includes(6));
  assert.deepEqual(errors, []);
  console.log(
    '数据库管理：浏览、监听与读取、紧凑容错选择、同排计数及独立窗口通过三尺寸深浅主题验证',
  );
} finally {
  await browser?.close();
  await server.close();
}

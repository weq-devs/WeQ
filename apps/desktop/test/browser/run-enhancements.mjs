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
        assert.equal(await page.locator('.weq-set-card').count(), 4);
        const buttons = await page.locator('.weq-set-card-action button').evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, text: node.textContent };
          }),
        );
        assert.ok(buttons.every((button) => /(?:下载|删除) \d+\.\d{2} MiB/.test(button.text)));
        assert.ok(
          buttons.every(
            (button) =>
              Math.abs(button.width - buttons[0].width) <= 1 &&
              Math.abs(button.height - buttons[0].height) <= 1,
          ),
          `下载和删除按钮必须同尺寸：${JSON.stringify({ width, theme, style, buttons })}`,
        );
        assert.equal(await page.locator('input[type="checkbox"], progress').count(), 0);
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
  await page.getByRole('button', { name: /^下载全部/ }).click();
  await page.getByRole('button', { name: '删除本地文字识别', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-set-card-action button').count(), 4);
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
  assert.equal(await page.locator('[data-setting-id="enhancement-text"] button').count(), 1);
  await page.goto(`${url}?state=busy`);
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '50');
  await page.goto(`${url}?state=failed`);
  assert.equal(
    await page.getByRole('button', { name: '重试本地语音转写', exact: true }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, output }));
} finally {
  await browser?.close();
  await server.close();
}

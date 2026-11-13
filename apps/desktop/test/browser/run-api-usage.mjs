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
  cacheDir: resolve(root, 'node_modules/.vite-api-usage'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/api-usage.html'] },
  resolve: {
    alias: [
      {
        find: /^(?:\.\.\/)+trpc\/client$/,
        replacement: resolve(root, 'test/browser/api-usage.stub.ts'),
      },
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
const output = process.env.WEQ_USAGE_ARTIFACTS;
const errors = [];
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/api-usage.html`;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(url);
      await page.locator('.weq-usage-summary').waitFor();
      assert.equal(await page.getByRole('button', { name: '刷新用量' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '重试读取用量' }).count(), 0);
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#007ebd' : '#6ed4b0',
        );
      }, theme);
      await page.emulateMedia({ reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' });
      await page.waitForFunction(() => {
        const svg = document.querySelector('.weq-usage-line-svg');
        return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 0.1;
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(await page.getByText('同名配置', { exact: true }).count(), 2);
      await page.getByText('请求次数', { exact: true }).last().click();
      await page.locator('.weq-usage-line-dot').nth(1).focus();
      await page.locator('.weq-usage-line-tooltip').waitFor();
      assert.equal(await page.locator('.weq-usage-segments').count(), 0);
      await page.getByRole('radio', { name: '近 24 小时', exact: true }).click();
      assert.equal(await page.locator('.weq-usage-line-dot').count(), 24);
      await page.getByRole('radio', { name: '全部保留记录', exact: true }).click();
      await page.getByText('近 30 天趋势', { exact: true }).waitFor();
      await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
      await page.getByRole('radio', { name: '近 7 天', exact: true }).press('ArrowRight');
      await page.getByRole('radio', { name: '近 30 天', exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('radio', { name: '近 30 天', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
      await page.getByText('每份账本最多保留', { exact: false }).click();
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  }
  for (const kind of ['unknown', 'empty', 'error', 'stale', 'loading', 'clones']) {
    await page.goto(`${url}?case=${kind}`);
    await page.locator('.weq-api-usage').waitFor();
    if (kind === 'error' || kind === 'stale') {
      await page.getByRole('alert').waitFor();
      assert.equal(await page.locator('.weq-usage-summary').count(), kind === 'stale' ? 1 : 0);
      if (output) await page.screenshot({ path: resolve(output, `${kind}.png`), fullPage: true });
      await page.getByRole('button', { name: '重试读取用量' }).click();
      await page.locator('.weq-usage-summary').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
    } else if (kind === 'empty') {
      await page.getByText('所选时段暂无 API 请求').waitFor();
    } else if (kind === 'unknown') {
      assert.equal(await page.locator('.weq-usage-summary dd').first().textContent(), '未知');
      await page.getByText('请求次数', { exact: true }).last().click();
      assert.ok(await page.locator('.weq-usage-line-stroke').getAttribute('d'));
    } else if (kind === 'clones') {
      await page.locator('.weq-usage-personas summary').click();
      await page.getByText('已删除或不可用的克隆').waitFor();
    } else {
      await page.getByRole('status').waitFor();
      assert.equal(await page.getByRole('button', { name: '重试读取用量' }).count(), 0);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'API 用量：8 组尺寸／主题与 6 种状态通过，含筛选、趋势切换、键盘提示、仅失败重试和已删除克隆。',
  );
} finally {
  await browser?.close();
  await server.close();
}

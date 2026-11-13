import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = resolve(root, 'out/data-saver-validation');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-data-saver'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/data-saver.stub.ts') },
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
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const small = await sharp({
    create: { width: 200, height: 150, channels: 3, background: '#2a9160' },
  })
    .webp()
    .toBuffer();
  const requests = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_media/')) {
      requests.push(Object.fromEntries(url.searchParams));
      if (
        url.searchParams.get('token') === 'missing' &&
        url.searchParams.get('intent') !== 'interactive'
      )
        return route.fulfill({ status: 409, body: 'deferred' });
      return route.fulfill({ contentType: 'image/webp', body: small });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      requests.length = 0;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/data-saver.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      assert.equal(await page.locator('.weq-set-card').count(), 1);
      await page.getByRole('heading', { name: '省流量模式下的行为' }).waitFor();
      assert.equal(await page.getByRole('switch').count(), 9);
      assert.deepEqual(
        await page.getByLabel('省流量模式', { exact: true }).locator('option').allTextContents(),
        ['开启', '关闭', '跟随系统'],
      );
      await page.screenshot({
        path: resolve(output, `${width}-${theme}-settings.png`),
        fullPage: true,
      });
      await page.locator('.qq-media-image').last().scrollIntoViewIfNeeded();
      await page
        .getByRole('button', { name: '加载图片', exact: true })
        .waitFor()
        .catch(async (error) => {
          await page.screenshot({ path: resolve(output, 'failure.png') });
          console.error(errors, await page.locator('body').innerText());
          throw error;
        });
      assert.ok(requests.length >= 2);
      assert.ok(
        requests.every((request) => request.ds === '1' && request.v === 'thumb' && !request.intent),
        `自动加载不得请求原图或伪装成主动加载：${width}/${theme} ${JSON.stringify(requests)}`,
      );
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, '设置和图片不能撑破视口');
      await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      const activeRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.searchParams.get('token') === 'missing' &&
          url.searchParams.get('intent') === 'interactive'
        );
      });
      await page.getByRole('button', { name: '加载图片', exact: true }).click();
      const active = await activeRequest;
      await active.response();
      assert.equal(new URL(active.url()).searchParams.get('intent'), 'interactive');
      await page.getByLabel('省流量模式', { exact: true }).selectOption('never');
      await page.getByText('正常加载', { exact: false }).waitFor();
      for (const control of await page.getByRole('switch').all())
        assert.equal(await control.isEnabled(), true);
      await page.getByRole('switch', { name: '自动下载个性装扮', exact: true }).click();
      assert.equal(
        await page
          .getByRole('switch', { name: '自动下载个性装扮', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await page.getByLabel('大文件暂停阈值', { exact: true }).fill('25');
      await page.getByLabel('大文件暂停阈值', { exact: true }).press('Tab');
      assert.equal(await page.getByLabel('大文件暂停阈值', { exact: true }).inputValue(), '25');
      await page.getByLabel('恢复省流量默认设置', { exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="省流量模式"]').value === 'auto' &&
          document.querySelector('[aria-label="大文件暂停阈值"]').value === '10',
      );
      assert.equal(
        await page
          .getByRole('switch', { name: '自动下载个性装扮', exact: true })
          .getAttribute('aria-checked'),
        'false',
      );
      await page.waitForLoadState('networkidle');
    }
  assert.deepEqual(errors, []);
  console.log(
    '省流量浏览器验证通过：6 个桌面／移动浅深色场景，自动小图、点击加载、三态设置、无横向溢出。',
  );
} finally {
  await browser?.close();
  await server.close();
}

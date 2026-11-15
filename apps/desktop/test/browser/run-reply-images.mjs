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
const output = process.env.WEQ_REPLY_IMAGES_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-reply-images'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const image = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#218c61' },
  })
    .png()
    .toBuffer();
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [390, 1200])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        const errors = [];
        const requests = [];
        const cached = new Set();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/test/reply-image.png')
            return route.fulfill({ contentType: 'image/png', body: image });
          if (url.pathname === '/_media/flashpic')
            return route.fulfill({ contentType: 'image/png', body: image });
          if (url.pathname === '/_media/pic') {
            const params = Object.fromEntries(url.searchParams);
            requests.push(params);
            const deferred = params.name === 'deferred.png' && params.intent !== 'interactive';
            const failed =
              params.name === 'retry.png' && !params._weq_retry && !cached.has(params.name);
            if (!deferred && !failed) cached.add(params.name);
            return deferred || failed
              ? route.fulfill({ status: 409, headers: { 'Cache-Control': 'no-store' } })
              : route.fulfill({ contentType: 'image/png', body: image });
          }
          return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
        });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/reply-images.html`,
        );
        await page.waitForFunction(() => window.replyImages);
        await page.evaluate((theme) => {
          window.replyImages.setTheme(theme, theme === 'dark' ? '#73cab8' : '#a53251');
        }, theme);
        const fixture = (id) => page.locator(`[data-reply-image="${id}"]`);
        const deferred = fixture('deferred').getByRole('button', { name: '加载图片', exact: true });
        await deferred.waitFor();
        assert.equal(await deferred.isEnabled(), true);
        const before = await page.locator('.qq-reply-preview-image').evaluateAll((nodes) =>
          nodes.map((node) => {
            const child = node.firstElementChild.getBoundingClientRect();
            const parent = node.getBoundingClientRect();
            return {
              id: node.closest('article').dataset.replyImage,
              child: child.toJSON(),
              parent: parent.toJSON(),
              fits:
                child.width > 0 &&
                child.width <= 96 &&
                child.height <= 56 &&
                child.right <= parent.right + 1 &&
                child.bottom <= parent.bottom + 1,
            };
          }),
        );
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-deferred.png`) });
        assert.ok(
          before.every((item) => item.fits),
          `引用图片与加载占位未保持缩略图尺寸：${JSON.stringify(before)}`,
        );

        const preview = async (control, title, key) => {
          await control.focus();
          if (key) await page.keyboard.press(key);
          else await control.click();
          const photo = page.locator('.weq-lightbox-image');
          await page.waitForFunction(
            () => document.querySelector('.weq-lightbox-image')?.naturalWidth === 400,
          );
          await photo.evaluate((node) => node.decode());
          assert.equal(await photo.evaluate((node) => node.naturalWidth), 400);
          assert.equal(await page.locator('.weq-lightbox-layer').count(), 1);
          assert.equal(await page.evaluate(() => window.replyImages.jumps.length), 0, title);
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('.weq-lightbox-layer').count(), 0);
          assert.equal(await control.evaluate((node) => node === document.activeElement), true);
        };
        const loaded = fixture('loaded').getByRole('button', {
          name: '查看图片：loaded.png',
          exact: true,
        });
        await preview(loaded, '点击引用图不应跳转原消息');
        await preview(loaded, 'Enter 应仅打开图片', 'Enter');
        await preview(loaded, '空格应仅打开图片', 'Space');
        await deferred.click();
        const downloaded = fixture('deferred').getByRole('button', {
          name: '查看图片：deferred.png',
          exact: true,
        });
        await downloaded.waitFor();
        await downloaded.locator('img').waitFor({ state: 'visible' });
        await page.waitForFunction(
          () => document.querySelector('[data-reply-image="deferred"] img')?.naturalWidth === 400,
        );
        await downloaded.locator('img').evaluate((node) => node.decode());
        assert.ok(
          requests.some(
            (params) =>
              params.name === 'deferred.png' &&
              params.intent === 'interactive' &&
              params.t === '1700000000000',
          ),
        );
        await preview(downloaded, '点击加载后的引用图可预览');

        await page.evaluate(() => window.replyImages.setDataSaver(false));
        const retry = fixture('failed').getByRole('button', { name: '重试加载图片', exact: true });
        await retry.click();
        const retried = fixture('failed').getByRole('button', {
          name: '查看图片：retry.png',
          exact: true,
        });
        await page.waitForFunction(
          () => document.querySelector('[data-reply-image="failed"] img')?.naturalWidth === 400,
        );
        await retried.locator('img').evaluate((node) => node.decode());
        await preview(retried, '失败重试后的引用图可预览');
        await preview(
          fixture('flash').getByRole('button', { name: '查看闪照', exact: true }),
          '引用闪照可预览',
        );
        assert.equal(await page.evaluate(() => window.replyImages.jumps.length), 0);
        await fixture('loaded').locator('.qq-reply-quote-arrow').click();
        await fixture('loaded').locator('.qq-reply-quote-sender').click();
        await fixture('loaded').locator('.qq-reply-quote-body > span:last-of-type').click();
        assert.deepEqual(
          await page.evaluate(() => window.replyImages.jumps.map((jump) => jump.seq)),
          [42, 42, 42],
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(errors, []);
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-loaded.png`) });
        results.push({ width, theme, previews: 6, jumps: 3, errors });
      } finally {
        await page.close();
      }
    }
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

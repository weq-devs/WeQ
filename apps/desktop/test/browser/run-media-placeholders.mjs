import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = resolve(root, 'out/media-placeholders-validation');
await mkdir(output, { recursive: true });
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
  const image = await readFile(resolve(root, '../../resources/qqlevel/penguin.png'));
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        const errors = [];
        const requests = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/_media/album') {
            requests.push(Object.fromEntries(url.searchParams));
            const cached = url.searchParams.get('src')?.endsWith('photo-0.png');
            return url.searchParams.get('ds') === '1' &&
              url.searchParams.get('intent') !== 'interactive' &&
              !cached
              ? route.fulfill({
                  status: 409,
                  headers: { 'Cache-Control': 'no-store' },
                  body: 'deferred',
                })
              : route.fulfill({ contentType: 'image/png', body: image });
          }
          return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
        });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html?photos=1&data-saver=1`,
        );
        await page.waitForFunction(() => window.contactCardQa && window.mediaPlaceholderQa);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
          const qa = window.contactCardQa;
          qa.configure({ ...qa.settings, visible: { ...qa.settings.visible, photos: true } });
        }, theme);
        const photos = page.locator('.weq-contact-card .weq-profile-photo');
        await photos.last().scrollIntoViewIfNeeded();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.weq-profile-photo img')].every((image) => image.complete),
        );
        assert.equal(await photos.count(), 4);
        assert.equal(await photos.locator('.weq-image-placeholder').count(), 3);
        assert.equal(await photos.locator('.weq-shimmer-block').count(), 0);
        const layout = await photos.evaluateAll((nodes) =>
          nodes.map((node) => {
            const bounds = node.getBoundingClientRect();
            const placeholder = node.querySelector('.weq-image-placeholder');
            const fallback = placeholder?.getBoundingClientRect();
            return {
              width: bounds.width,
              height: bounds.height,
              fits:
                !fallback ||
                (Math.abs(fallback.width - bounds.width) <= 2 &&
                  Math.abs(fallback.height - bounds.height) <= 2),
              imageVisible: getComputedStyle(node.querySelector('img')).opacity !== '0',
            };
          }),
        );
        assert.ok(layout.every((item) => item.width >= 40 && item.height >= 40 && item.fits));
        assert.deepEqual(
          layout.map((item) => item.imageVisible),
          [true, false, false, false],
        );
        assert.ok(requests.every((request) => request.ds === '1' && !request.intent));
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
        const request = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.pathname === '/_media/album' && url.searchParams.get('intent') === 'interactive'
          );
        });
        await photos.nth(1).click();
        await request;
        await page.locator('.weq-lightbox-stage img').evaluate((image) => image.decode());
        await page.getByRole('button', { name: '关闭预览', exact: true }).click();
        await page.evaluate(() => window.mediaPlaceholderQa.setEnabled(false));
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.weq-profile-photo img')].every(
            (image) => !new URL(image.src).searchParams.has('ds'),
          ),
        );
        await photos
          .locator('img')
          .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
        await page.waitForFunction(
          () => document.querySelectorAll('.weq-profile-photo .weq-image-placeholder').length === 0,
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  console.log(
    '媒体占位验证通过：6 个桌面／移动浅深色场景，缓存图正常显示、占位不溢出、点击预览和解除限制后恢复加载。',
  );
} finally {
  await browser?.close();
  await server.close();
}

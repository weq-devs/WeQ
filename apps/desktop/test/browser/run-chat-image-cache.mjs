import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'chat-image-cache-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  optimizeDeps: {
    entries: ['test/browser/chat-image-cache.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime'],
  },
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/chat-image-cache.stub.tsx'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
});
let browser;
let releaseImages;
const gate = new Promise((resolve) => {
  releaseImages = resolve;
});
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0;
  const body = await sharp({
    create: { width: 640, height: 480, channels: 3, background: '#218c61' },
  })
    .png()
    .toBuffer();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname.startsWith('/_media/')) {
      requests++;
      await gate;
      return route.fulfill({ contentType: 'image/png', body });
    }
    return route.continue();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/chat-image-cache.html`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-images] img').length === 3);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-images] img[src]').length === 3,
  );
  const output = process.env.WEQ_IMAGE_CACHE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, height, accent, background] of [
    ['light', 1280, 900, '#107a54', 'plain'],
    ['dark', 1280, 900, '#f0bd52', 'grid'],
    ['light', 390, 844, '#b83057', 'paper'],
    ['dark', 390, 844, '#75cabb', 'dots'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, accent, background }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, accent, background },
    );
    const check = await page.evaluate(() => ({
      hiddenLoadingText: [...document.querySelectorAll('[data-images] img')].every(
        (img) => getComputedStyle(img).opacity === '0',
      ),
      iconPlaceholders:
        document.querySelectorAll('[data-images] .weq-image-placeholder svg').length === 3,
      noPlaceholderText: document.querySelector('[data-images]').textContent.trim() === '',
      noOverflow: document.documentElement.scrollWidth <= innerWidth,
    }));
    if (!Object.values(check).every(Boolean))
      throw new Error(JSON.stringify({ theme, width, check }));
    if (output)
      await page.screenshot({ path: resolve(output, `placeholder-${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  releaseImages();
  const loaded = () =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-images] img')].length === 3 &&
        [...document.querySelectorAll('[data-images] img')].every(
          (img) => img.naturalWidth === 640 && getComputedStyle(img).opacity === '1',
        ),
    );
  await loaded();
  const baseline = requests;
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => window.scrollTo(0, 1800));
    await page.waitForTimeout(25);
    if ((await page.locator('[data-images] img[src]').count()) !== 3)
      throw new Error('Cached offscreen source was released');
    await page.evaluate(() => window.scrollTo(0, 0));
    await loaded();
  }
  if (requests !== baseline) throw new Error('Scrolling restarted cached image requests');
  await page.getByRole('button', { name: '切换消息挂载' }).click();
  await page.getByRole('button', { name: '切换消息挂载' }).click();
  await loaded();
  const input = page.getByRole('spinbutton', { name: '图片预览内存预算' });
  await input.fill('0');
  await page.getByRole('button', { name: '保存图片预览内存预算' }).click();
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-images] img')].every((img) => !img.hasAttribute('src')),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await loaded();
  if (output) await page.screenshot({ path: resolve(output, 'loaded.png') });
  await page.route('**/_media/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-images] .qq-media-missing').length === 3,
  );
  if ((await page.locator('[data-images]').innerText()) !== '')
    throw new Error('Missing images exposed placeholder text');
  if (output) await page.screenshot({ path: resolve(output, 'missing.png') });
  if (errors.length) throw new Error(errors.join('; '));
  console.log(
    JSON.stringify({
      realMessageImages: 3,
      placeholderLayouts: 4,
      scrollRounds: 25,
      noReloadWithinBudget: true,
      zeroBudgetReleased: true,
      missingImagesAreGraphical: true,
      errors,
    }),
  );
} finally {
  releaseImages();
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

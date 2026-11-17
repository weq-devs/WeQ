import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/market-face-popover-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(cache, 'vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  optimizeDeps: {
    entries: ['test/browser/market-face-popover.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'zustand'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/market-face-popover.stub.ts'),
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
  const picture = await sharp({
    create: { width: 96, height: 96, channels: 3, background: '#247954' },
  })
    .png()
    .toBuffer();
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/_media/')) return route.continue();
    requests.push(url);
    // 禁止自动下载时，用户主动打开的整包仍能加载；第 2 张强制走加密回退。
    const active = url.searchParams.get('intent') === 'interactive';
    const fallback = url.searchParams.get('hash') === '2'.padStart(32, '0');
    if (active && fallback && !url.searchParams.has('enc'))
      return route.fulfill({ status: 404, body: 'plaintext unavailable' });
    return route.fulfill({
      contentType: 'image/png',
      body: picture,
      headers: { 'Cache-Control': 'no-store' },
    });
  });
  const output = process.env.WEQ_MARKET_POPOVER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/market-face-popover.html`;
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate((value) => {
        window.marketTheme.getState().setPreference(value);
        document.documentElement.style.setProperty('--weq-accent-effective', '#bd315d');
        document.documentElement.dataset.background = 'grid';
      }, theme);
      const triggers = page.getByRole('button', { name: '查看整组商城表情', exact: true });
      await triggers.first().click();
      const popover = page.getByRole('dialog', { name: '商城表情', exact: true });
      await popover.waitFor();
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('.weq-mface-lb-cell img')];
        return (
          images.length === 24 && images.every((image) => image.complete && image.naturalWidth > 0)
        );
      });
      assert.equal(await page.locator('[aria-modal="true"], .weq-unified-preview').count(), 0);
      const layer = await page.locator('.weq-mface-popover-layer').evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          pointer: style.pointerEvents,
          background: style.backgroundColor,
          filter: style.backdropFilter,
        };
      });
      assert.equal(layer.pointer, 'none');
      assert.equal(layer.background, 'rgba(0, 0, 0, 0)');
      assert.equal(layer.filter, 'none');
      const fits = async () => {
        const bounds = await popover.boundingBox();
        assert.ok(bounds.width <= 361 && bounds.height <= 461, JSON.stringify(bounds));
        assert.ok(bounds.x >= 7 && bounds.y >= 7, JSON.stringify(bounds));
        assert.ok(bounds.x + bounds.width <= width - 7, JSON.stringify(bounds));
        assert.ok(bounds.y + bounds.height <= 793, JSON.stringify(bounds));
        assert.equal(
          await popover.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
        );
        return bounds;
      };
      const bounds = await fits();
      const trigger = await triggers.first().boundingBox();
      if (width === 1280) assert.ok(Math.abs(bounds.x - trigger.x - trigger.width - 8) < 2);
      assert.ok(
        await popover
          .locator('.weq-mface-lb-scroll')
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-grid.png`) });
      await popover.locator('.weq-mface-lb-cell').first().click();
      await page.waitForFunction(
        () => document.querySelector('.weq-mface-detail-image')?.naturalWidth > 0,
      );
      await fits();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-detail.png`) });
      await page.keyboard.press('Escape');
      await popover.locator('.weq-mface-lb-grid').waitFor();
      // 桌面可直接切换同包入口；窄屏先收起覆盖消息区域的浮层。
      if (width < 700) await page.getByRole('button', { name: '关闭表情包', exact: true }).click();
      await triggers.last().click();
      assert.match(
        await popover.locator('.weq-mface-lb-cell.is-active').getAttribute('title'),
        /合成表情 2/,
      );
      await fits();
      await page.getByRole('button', { name: '背景操作 0', exact: true }).click();
      await popover.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '背景操作 1', exact: true }).waitFor();
      await triggers.first().focus();
      await page.keyboard.press('Enter');
      await popover.waitFor();
      await page.keyboard.press('Escape');
      await popover.waitFor({ state: 'detached' });
      assert.equal(
        await triggers.first().evaluate((element) => document.activeElement === element),
        true,
      );
      cases++;
    }
  }
  assert.ok(
    requests.some(
      (value) =>
        value.searchParams.get('enc') === 'tea' &&
        value.searchParams.get('intent') === 'interactive',
    ),
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, imageRequests: requests.length, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}

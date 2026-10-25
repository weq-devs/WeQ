import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CAPTURE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } },
});
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
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
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/menu-capture.html`,
  );
  await page.waitForSelector('.weq-menu-capture-button');
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [theme, width, height, background, accent] of [
    ['light', 1280, 900, 'plain', '#15764a'],
    ['dark', 1280, 900, 'grid', '#ebbd51'],
    ['light', 390, 844, 'paper', '#b53358'],
    ['dark', 390, 844, 'dots', '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, background, accent }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, background, accent },
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.evaluate(() => document.activeElement?.blur());
    const baseline = await page.screenshot();
    await page.locator('#open-menu').click();
    await page.waitForTimeout(200);
    const button = page.locator('.weq-menu-capture-button');
    const before = await button.boundingBox();
    await button.hover();
    await page.waitForFunction(() => document.querySelector('[data-menu-capture="preview"]'));
    assert(
      await page
        .locator('.weq-workspace-menu-head')
        .evaluate((el) => getComputedStyle(el).visibility === 'hidden'),
      'Menu remains visible',
    );
    assert(
      await button.evaluate(
        (el) =>
          getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '0.5',
      ),
      'Button not translucent',
    );
    assert(JSON.stringify(before) === JSON.stringify(await button.boundingBox()), 'Button moved');
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-preview.png`) });
    await button.click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-menu-capture="capturing"]') && window.menuCaptureTest.finish,
    );
    const captured = await page.screenshot(
      output ? { path: resolve(output, `${theme}-${width}-capture.png`) } : {},
    );
    const a = await sharp(baseline).raw().toBuffer();
    const b = await sharp(captured).raw().toBuffer();
    assert(a.equals(b), `Screenshot differs from menu-free baseline: ${theme}/${width}`);
    await page.evaluate(() => {
      window.menuCaptureTest.finish();
      window.menuCaptureTest.finish = undefined;
    });
    await page.waitForFunction(() => document.querySelector('[data-menu-capture="preview"]'));
    await page.mouse.move(width - 4, height - 4);
    await page.waitForFunction(() => !document.querySelector('[data-menu-capture]'));
    assert(await page.locator('.weq-workspace-menu-head').isVisible(), 'Menu not restored');
    results.push({ theme, width, background, pixelsMatch: true });
  }
  assert(!errors.length, errors.join('\n'));
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  await server.close();
}

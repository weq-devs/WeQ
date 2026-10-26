import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'renderer-recovery-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: {
    entries: ['test/browser/renderer-recovery.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime'],
  },
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      '@resources': resolve(root, '../../resources'),
    },
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/renderer-recovery.html`,
  );
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 640);
  const size = await page.locator('img').boundingBox();
  await page.getByRole('button', { name: '切换标签' }).click();
  await page.waitForFunction(() => !document.querySelector('img')?.hasAttribute('src'));
  const suspended = await page.locator('img').boundingBox();
  if (JSON.stringify(size) !== JSON.stringify(suspended))
    throw new Error('Suspending image changed layout');
  await page.getByRole('button', { name: '切换标签' }).click();
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 640);
  await page.evaluate(() => window.scrollTo(0, 1700));
  await page.waitForFunction(() => !document.querySelector('img')?.hasAttribute('src'));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 640);
  const rapidScrollRounds = 25;
  for (let round = 0; round < rapidScrollRounds; round++) {
    await page.evaluate(() => {
      window.previousMediaImage = document.querySelector('img');
      window.scrollTo(0, 1700);
    });
    await page.waitForFunction(() => !document.querySelector('img')?.hasAttribute('src'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 640);
    // 用旧节点补发迟到事件，模拟暂停加载的回调在恢复后才送达。
    await page.evaluate(() => {
      window.previousMediaImage.dispatchEvent(new Event('error'));
      window.previousMediaImage.dispatchEvent(new Event('load'));
      delete window.previousMediaImage;
    });
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 640);
    if (await page.locator('[data-media-missing]').count())
      throw new Error('Stale image event triggered permanent fallback');
    const restoredSize = await page.locator('img').boundingBox();
    if (JSON.stringify(size) !== JSON.stringify(restoredSize))
      throw new Error('Rapid scrolling changed image layout');
  }
  await page.getByRole('button', { name: '触发异常' }).click();
  await page.getByRole('alert').waitFor();
  const output = process.env.WEQ_RECOVERY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, height, background, accent] of [
    ['light', 1280, 900, 'plain', '#107a54'],
    ['dark', 1280, 900, 'grid', '#f0bd52'],
    ['light', 390, 844, 'paper', '#b83057'],
    ['dark', 390, 844, 'dots', '#75cabb'],
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
    const valid = await page.evaluate(() => {
      const button = document.querySelector('.weq-renderer-recovery button');
      const rect = button.getBoundingClientRect();
      return (
        rect.width > 100 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight &&
        document.documentElement.scrollWidth <= innerWidth
      );
    });
    if (!valid) throw new Error(`Recovery layout failed: ${theme}/${width}`);
    if (output) await page.screenshot({ path: resolve(output, `recovery-${theme}-${width}.png`) });
  }
  if (errors.length) throw new Error(errors.join('; '));
  console.log(
    JSON.stringify({
      imageSize: size,
      hiddenSourceReleased: true,
      offscreenSourceReleased: true,
      rapidScrollRounds,
      recoveryLayouts: 4,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

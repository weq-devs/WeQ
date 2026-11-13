import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-ocr-prefilter'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/ocr-prefilter.stub.ts'),
      },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/ocr-prefilter.html'] },
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
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ocr-prefilter.html`,
      );
      const toggle = page.getByRole('switch', { name: 'OCR 前先筛图', exact: true });
      await toggle.waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#075c30' : '#fff3a1',
        );
      }, theme);
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await toggle.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-setting-id="ocr-prefilter-enabled"] [role="switch"]')
            ?.getAttribute('aria-checked') === 'false',
      );
      await toggle.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-setting-id="ocr-prefilter-enabled"] [role="switch"]')
            ?.getAttribute('aria-checked') === 'true',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const group = page.getByRole('region', { name: '筛图模型' });
      assert.equal(await group.getByRole('switch').count(), 1);
      if (output)
        await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      cases++;
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

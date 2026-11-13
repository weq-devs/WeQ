import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-bare-links'),
  plugins: [tailwind()],
  optimizeDeps: { entries: ['test/browser/bare-links.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const output = resolve(root, '../../node_modules/.cache/bare-links-live');
let browser;
const screenshots = [];
const errors = [];
let cases = 0;
try {
  await server.listen();
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  for (const width of [390, 1180]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: width < 600,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/bare-links.html`,
      );
      await page.locator('html[data-ready="true"]').waitFor();
      for (const [id, text] of [
        ['bare', '看这里：h3cof6.com，或“example.com/path”。'],
        ['full', 'http://whatisthis.h3cof6.com'],
        ['query', 'sub.h3cof6.com/path?q=weq#chat'],
        ['www', 'www.h3cof6.com'],
        ['email', 'user@h3cof6.com mailto:user@h3cof6.com'],
        ['version', '2.7.0 v2.7.0 192.168.1.1'],
        ['filename', 'main.ts package.json report.pdf image.png README.md'],
      ])
        assert.equal(
          await page.locator(`[data-case="${id}"] .message-content`).textContent(),
          text,
        );
      for (const id of ['email', 'version', 'filename'])
        assert.equal(await page.locator(`[data-case="${id}"] button`).count(), 0);
      const bare = page.locator('[data-case="bare"] button');
      assert.deepEqual(await bare.allTextContents(), ['h3cof6.com', 'example.com/path']);
      for (const [id, text, href] of [
        ['bare', 'h3cof6.com', 'https://h3cof6.com/'],
        ['bare', 'example.com/path', 'https://example.com/path'],
        ['full', 'http://whatisthis.h3cof6.com', 'http://whatisthis.h3cof6.com/'],
        ['query', 'sub.h3cof6.com/path?q=weq#chat', 'https://sub.h3cof6.com/path?q=weq#chat'],
        ['www', 'www.h3cof6.com', 'https://www.h3cof6.com/'],
      ]) {
        const link = page
          .locator(`[data-case="${id}"]`)
          .getByRole('button', { name: text, exact: true });
        if (width < 600) await link.tap();
        else await link.click();
        assert.deepEqual(JSON.parse(await page.locator('html').getAttribute('data-last-opened')), [
          href,
          '_blank',
          'noopener,noreferrer',
        ]);
        cases++;
      }
      await bare.first().focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(JSON.parse(await page.locator('html').getAttribute('data-last-opened')), [
        'https://h3cof6.com/',
        '_blank',
        'noopener,noreferrer',
      ]);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const screenshot = resolve(output, `${width}-${theme}.png`);
        await page.screenshot({ path: screenshot });
        screenshots.push(screenshot);
      }
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, screenshots }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

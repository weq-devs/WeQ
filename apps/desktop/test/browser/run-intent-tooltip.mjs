import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-tooltip-'));
const output = process.env.WEQ_INTENT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/intent-loading.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'intent-loading.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html`,
  );
  await page.waitForFunction(() => Boolean(window.intentQa));
  await page.evaluate(() => window.intentQa.setMode('ready'));
  await page.waitForSelector('.weq-intent-details');
  await page.waitForFunction(() =>
    document.querySelector('.weq-intent-chips')?.textContent.includes('闲聊'),
  );
  let cases = 0;
  let sentimentCases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const accent of ['#075c30', '#fff3a1']) {
        await page.evaluate(
          async ({ theme, accent }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--weq-accent-effective', accent);
            window.scrollTo(0, 0);
            await new Promise(requestAnimationFrame);
            document.querySelector('.weq-intent-details').focus({ preventScroll: true });
          },
          { theme, accent },
        );
        await page.waitForSelector('.weq-intent-popover', { timeout: 5000 }).catch((error) => {
          throw new Error(`${width}/${theme}/${accent}: ${error.message}`);
        });
        const checks = await page.locator('.weq-intent-popover').evaluate((popover) => {
          const rect = popover.getBoundingClientRect();
          const confidence = popover
            .querySelector('.weq-intent-confidence')
            .getBoundingClientRect();
          const rows = [...popover.querySelectorAll('.is-metric')];
          const bars = rows.map((row) => row.children[1].getBoundingClientRect());
          return {
            metricSpacing: rows.every((row) => getComputedStyle(row).columnGap === '4px'),
            barWidth: bars.every((bar) => Math.abs(bar.width - 48) < 0.1),
            alignedBars: Math.abs(bars[0].left - bars[1].left) < 0.1,
            footerCentered:
              Math.abs(confidence.left + confidence.width / 2 - (rect.left + rect.width / 2)) < 0.5,
            signedValuesFit: rows.every((row) => {
              const value = row.lastElementChild;
              const original = value.textContent;
              value.textContent = '-100';
              const fits = value.scrollWidth <= value.clientWidth;
              value.textContent = original;
              return fits;
            }),
            inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.width <= 180,
          };
        });
        for (const [key, value] of Object.entries(checks))
          assert.equal(value, true, `${width}/${theme}/${accent}: ${key}`);
        if (output && accent === '#075c30')
          await page.locator('.weq-intent-popover').screenshot({
            path: resolve(output, `tooltip-${width}-${theme}.png`),
          });
        for (const [sentiment, start, end] of [
          [-100, 0, 24],
          [-50, 12, 24],
          [0, 24, 24],
          [50, 24, 36],
          [100, 24, 48],
        ]) {
          await page.evaluate(async (sentiment) => {
            const fixture = await import('/test/browser/intent-loading.stub.ts');
            fixture.result.sentiment = sentiment;
            fixture.publishResult();
          }, sentiment);
          await page.waitForFunction(
            (value) =>
              document.querySelector('.is-sentiment')?.nextElementSibling.textContent === value,
            sentiment > 0 ? `+${sentiment}` : String(sentiment),
          );
          const metric = await page.locator('.is-sentiment').evaluate((track) => {
            const rect = track.getBoundingClientRect();
            const fill = track.firstElementChild.getBoundingClientRect();
            const marker = getComputedStyle(track, '::after');
            return {
              start: fill.left - rect.left,
              end: fill.right - rect.left,
              marker: marker.content !== 'none' && marker.left === '24px' && marker.width === '1px',
              negative: track.firstElementChild.classList.contains('is-negative'),
            };
          });
          const label = `${width}/${theme}/${accent}/${sentiment}`;
          assert.ok(Math.abs(metric.start - start) < 0.1, `${label}: 起点应为 ${start}`);
          assert.ok(Math.abs(metric.end - end) < 0.1, `${label}: 终点应为 ${end}`);
          assert.equal(metric.marker, true, `${label}: 中点标记`);
          assert.equal(metric.negative, sentiment < 0, `${label}: 负向色`);
          if (output && width === 1280 && accent === '#075c30')
            await page.locator('.weq-intent-popover').screenshot({
              path: resolve(output, `sentiment-${sentiment}-${theme}.png`),
            });
          sentimentCases++;
        }
        await page.keyboard.press('Escape');
        await page.locator('.weq-intent-details').first().blur();
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, sentimentCases, errors, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

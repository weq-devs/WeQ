import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-task-progress'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-task-logs.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/task-progress.html`,
  );
  await page.locator('.weq-task-activity [role="log"]').waitFor();
  const output = process.env.WEQ_TASK_PROGRESS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const store = window.taskProgressQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#006d50' : '#ffe593');
      }, theme);
      for (const kind of [
        'model',
        'update',
        'database',
        'backup',
        'favorite-import',
        'forward',
        'album-upload',
        'resource',
        'analysis',
      ]) {
        await page.locator(`[data-kind="${kind}"] button`).click();
        assert.equal(await page.locator('.weq-task-activity .weq-exp-log-line').count(), 30);
        assert.equal(
          await page.locator('.weq-task-progress-details progress').getAttribute('value'),
          kind === 'resource' ? null : kind === 'backup' ? '100' : '42',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const styles = await page.locator('.weq-task-progress-track').evaluateAll((bars) =>
          bars.map((bar) => ({
            height: getComputedStyle(bar).height,
            radius: getComputedStyle(bar).borderRadius,
            background: getComputedStyle(bar).backgroundColor,
          })),
        );
        assert.equal(new Set(styles.map((style) => JSON.stringify(style))).size, 1);
        const log = page.locator('.weq-task-activity [role="log"]');
        assert.ok(await log.evaluate((element) => element.scrollHeight > element.clientHeight));
        cases++;
      }
      await page.locator('[data-kind="resource"] button').click();
      assert.equal(
        await page
          .locator('.weq-task-progress-details .weq-task-progress-indicator')
          .evaluate((node) => getComputedStyle(node).animationName),
        'none',
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases,
      unifiedTracks: true,
      scrollableLogs: true,
      reducedMotion: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

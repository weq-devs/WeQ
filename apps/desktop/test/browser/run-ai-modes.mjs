import assert from 'node:assert/strict';
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
const cacheDir = await mkdtemp(resolve(cacheRoot, 'ai-modes-'));
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html?manual`,
      );
      const start = page.getByRole('button', { name: '开始推荐回复', exact: true });
      await start.waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#075c30' : '#fff3a1',
        );
      }, theme);
      assert.equal(await start.locator('.lucide-play').count(), 1);
      assert.equal(await page.locator('.weq-int-suggest-bar').getAttribute('aria-busy'), 'false');
      const pill = page.locator('.chat-header .weq-affinity-pill');
      assert.equal(await pill.isEnabled(), true);
      await pill.click();
      assert.equal(await page.evaluate(() => window.intentQa.portraitOpened), true);
      await start.click();
      await page.getByText('重新生成的候选', { exact: true }).waitFor();
      await page.evaluate(() => window.intentQa.setMessages(['message', 'new-message']));
      assert.equal(await start.count(), 1);
      assert.equal(await page.locator('.weq-int-suggest-bar').getAttribute('aria-busy'), 'false');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await page.locator('.message-scroll .weq-intent-loading-reel').count(), 0);
      await page.evaluate(() => window.intentQa.setManualPendingMessages(['message']));
      const reels = page.locator('.message-scroll .weq-intent-loading-reel');
      await reels.first().waitFor();
      assert.equal(await reels.count(), 2);
      assert.equal(
        await page.locator('[data-message-id="new-message"] .weq-intent-loading-reel').count(),
        0,
      );
      assert.equal(
        await reels
          .first()
          .evaluate((node) =>
            node.getAnimations().some((animation) => animation.playState === 'running'),
          ),
        true,
      );
      assert.equal(
        await page
          .locator('[data-message-id="message"] .weq-intent-chips')
          .getAttribute('aria-busy'),
        'true',
      );
      await page.evaluate(() => window.intentQa.setManualPendingMessages([]));
      await reels.first().waitFor({ state: 'detached' });
      assert.equal(await reels.count(), 0);
      assert.equal(
        await page.locator('.weq-int-suggest').evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth;
        }),
        true,
      );
      if (process.env.WEQ_INTENT_ARTIFACTS) {
        await mkdir(process.env.WEQ_INTENT_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.WEQ_INTENT_ARTIFACTS, `manual-${theme}-${width}.png`),
        });
      }
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

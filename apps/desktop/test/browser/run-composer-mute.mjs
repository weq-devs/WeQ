import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-mute-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/composer-mute.html'] },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/composer-mute.stub.ts'),
      },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
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
const output = process.env.WEQ_COMPOSER_ARTIFACTS;
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  const results = [];
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
    [320, 640],
    [844, 390],
  ]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      try {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/composer-mute.html`,
        );
        await page.locator('.composer-send[data-muted="all"]').waitFor({ state: 'attached' });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = theme === 'dark' ? 'grid' : 'paper';
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#ebbd51' : '#15764a',
          );
        }, theme);
        const mobile = width <= 760;
        if (mobile) {
          await page.locator('.composer > .composer-editor').fill('保留的多行草稿。\n'.repeat(8));
          await page.locator('.mobile-composer-expand-button').click();
        }
        const button = page.locator(
          mobile ? '.composer-send-expanded' : '.composer > .composer-send',
        );
        const check = async (label) => {
          assert.equal(await button.textContent(), label);
          assert.equal(await button.isDisabled(), true);
          assert.equal(await button.locator('.lucide-message-square-off').count(), 1);
          const layout = await button.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const text = element.querySelector('strong').getBoundingClientRect();
            return {
              x: box.x,
              right: box.right,
              bottom: box.bottom,
              textFits: text.left >= box.left && text.right <= box.right,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert(
            layout.x >= 0 && layout.right <= width && layout.bottom <= height,
            JSON.stringify(layout),
          );
          assert(layout.textFits && !layout.overflow, JSON.stringify(layout));
        };
        await check('全员禁言');
        if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-all.png`) });
        await page.evaluate(() =>
          window.muteQA.set({
            muteAll: false,
            muteUntil: Math.floor(Date.now() / 1000) + 28 * 86400 + 23 * 3600 + 15,
          }),
        );
        await page.waitForFunction(() => document.querySelector('[data-muted="personal"]'));
        await check('禁言 28天23时');
        if (output)
          await page.screenshot({ path: resolve(output, `${theme}-${width}-personal.png`) });
        if (!mobile) {
          const padding = await page
            .locator('.composer > .composer-editor')
            .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingRight));
          assert(padding >= 172, `Editor text can overlap mute button: ${padding}`);
        }
        await page.evaluate(() =>
          window.muteQA.set({ muteUntil: 0, role: 'admin', muteAll: true }),
        );
        await page.waitForFunction(
          (selector) => !document.querySelector(selector).hasAttribute('data-muted'),
          mobile ? '.composer-send-expanded' : '.composer > .composer-send',
        );
        assert.equal(await button.isDisabled(), false);
        assert.equal(await button.locator('.lucide-send-horizontal').count(), 1);
        assert.deepEqual(await page.evaluate(() => window.muteQA.sent), []);
        results.push({ width, height, theme, all: true, personal: true, admin: true });
      } finally {
        await page.close();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: results.length, results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

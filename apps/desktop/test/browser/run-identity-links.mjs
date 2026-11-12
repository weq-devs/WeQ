import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-identity-links'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/relation-profile.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const output = resolve(root, '../../node_modules/.cache/identity-links-live');
let browser;
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  for (const width of [320, 390, 1180])
    for (const theme of ['light', 'dark'])
      for (const action of ['profile', 'space']) {
        await page.setViewportSize({ width, height: 850 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/identity-links.html?action=${action}${width < 600 ? '&mobile' : ''}`,
        );
        await page.locator('.weq-qzn-comment .weq-qzn-identity-link').waitFor();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const author = page.locator('.weq-qzn-post-head .weq-qzn-identity-link');
        for (const selector of ['.weq-avatar-img, .weq-avatar-fallback', 'span:last-child']) {
          await author.locator(selector).click();
          assert.equal(
            await page.evaluate(() => document.documentElement.dataset.identityTarget),
            `${action}:10002`,
          );
        }
        await author.focus();
        await page.keyboard.press('Enter');
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.identityTarget),
          `${action}:10002`,
        );
        const self = page.getByRole('button', { name: '查看我的名片' });
        await self.locator('.avatar').click();
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.identityTarget),
          'profile:10001',
        );
        await self.locator(width < 600 ? 'strong' : '.app-title-bar-nick').click();
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.identityTarget),
          'profile:10001',
        );
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll('.weq-qzn-identity-link, .weq-self-identity-link')]
            .filter((node) => node.scrollWidth > node.clientWidth + 2)
            .map((node) => node.className),
        );
        assert.deepEqual(overflow, []);
        const pageOverflow = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
            .map((node) => ({
              className: node.className?.baseVal ?? node.className,
              right: node.getBoundingClientRect().right,
            })),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
          JSON.stringify({ width, pageOverflow }),
        );
        if (action === 'profile')
          await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
        cases++;
      }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

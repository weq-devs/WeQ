import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-clone-avatar'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.href.includes('20009')) return route.fulfill({ status: 404 });
    if (url.pathname.startsWith('/_avatar/') || url.pathname === '/_media/avatar')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#287764"/></svg>',
      });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-avatar.html`,
    );
    await page.locator('.weq-virtual-avatar').first().waitFor();
    await page
      .locator('[data-conversation-id="virtual:persona:failed"] .weq-virtual-avatar-fallback')
      .waitFor();
    for (const [theme, accent, background] of [
      ['light', '#075c30', 'plain'],
      ['dark', '#fff3a1', 'grid'],
    ]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate(
        ({ theme, accent, background }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = background;
          document.documentElement.style.setProperty('--weq-accent-effective', accent);
        },
        { theme, accent, background },
      );
      const checks = await page.evaluate(() => {
        const real = document
          .querySelector('.conversation-row:not([data-conversation-id^="virtual:"]) > .avatar')
          .getBoundingClientRect();
        return [...document.querySelectorAll('.weq-virtual-avatar')].map((avatar) => {
          const rect = avatar.getBoundingClientRect();
          const content = avatar.firstElementChild.getBoundingClientRect();
          const badge = avatar.querySelector('.weq-virtual-avatar-badge').getBoundingClientRect();
          const icon = avatar
            .querySelector('.weq-virtual-avatar-badge > svg')
            .getBoundingClientRect();
          return {
            id: avatar.closest('[data-conversation-id]').dataset.conversationId,
            normal: real.width,
            width: rect.width,
            height: rect.height,
            sameSize: rect.width === real.width && rect.height === real.height,
            contentFits: content.width === rect.width && content.height === rect.height,
            badgeVisible:
              badge.width === 16 &&
              badge.height === 16 &&
              icon.width === 10 &&
              icon.height === 10 &&
              getComputedStyle(avatar).overflow === 'visible',
            mosaic: [...avatar.querySelectorAll('.weq-group-mosaic-cell')].every(
              (cell) => cell.getBoundingClientRect().width > 0,
            ),
          };
        });
      });
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      results.push({ width, theme, checks });
      if (
        checks.length !== 6 ||
        checks.some(
          (check) => !check.sameSize || !check.contentFits || !check.badgeVisible || !check.mosaic,
        )
      )
        throw new Error(JSON.stringify({ width, theme, checks }));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

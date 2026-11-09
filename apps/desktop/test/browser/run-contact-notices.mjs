import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_NOTICE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-notices'),
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
  for (const group of [false, true]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-notices.html`,
    );
    await page.evaluate((group) => window.noticeQa.render(group), group);
    await page.waitForSelector('.notice-card-request');
    await page.evaluate((group) => window.noticeQa.mountActions(group), group);
    await page.waitForSelector('.notice-request-buttons');
    for (const width of [1280, 390, 320]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate((theme) => {
          const store = window.noticeQa.store.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          store.setBackground(theme === 'light' ? 'paper' : 'grid');
        }, theme);
        const result = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('.notice-card-request')];
          const clipped = cards.filter((card) => {
            const rect = card.getBoundingClientRect();
            return [...card.querySelectorAll('button, input, .notice-request-actions > p')].some(
              (node) => {
                const child = node.getBoundingClientRect();
                return (
                  child.bottom > rect.bottom + 1 ||
                  child.right > rect.right + 1 ||
                  child.left < rect.left - 1
                );
              },
            );
          });
          const list = document.querySelector('.weq-notice-scroll');
          list.scrollTop = list.scrollHeight;
          const last = cards.at(-1).getBoundingClientRect();
          return {
            clipped: clipped.length,
            count: cards.length,
            scrollable: list.scrollHeight > list.clientHeight,
            lastVisible: last.bottom <= list.getBoundingClientRect().bottom + 1,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          };
        });
        if (
          result.clipped ||
          result.overflow ||
          result.count !== 12 ||
          !result.scrollable ||
          !result.lastVisible
        )
          throw new Error(
            `${group ? 'group' : 'friend'}/${width}/${theme}: ${JSON.stringify(result)}`,
          );
        await page.locator('.weq-notice-scroll').evaluate((node) => {
          node.scrollTop = 0;
        });
        if (output)
          await page.screenshot({
            path: resolve(output, `${group ? 'group' : 'friend'}-${width}-${theme}.png`),
          });
        console.log(`PASS ${group ? 'group' : 'friend'}/${width}/${theme}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await server.close();
}

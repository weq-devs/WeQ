import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_RESPONSIVE_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/remote-search-layout-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  browser = await engines[engine].launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone) WeQRemote',
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/desktop-portrait.html`,
  );
  const output = process.env.WEQ_RESPONSIVE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [width, height] of [
    [640, 320],
    [844, 390],
    [932, 430],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => document.documentElement.dataset.weqLayout === 'wide');
    for (const preset of ['classic', 'qqnt']) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          ({ theme, preset }) => {
            const store = window.desktopPortraitQa.store.getState();
            store.setComponentStyle(preset);
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
          },
          { theme, preset },
        );
        const search = page.locator('.app-title-bar .weq-titlebar-search');
        await search.locator('input').fill('布局检查');
        await page.getByRole('button', { name: '清空搜索', exact: true }).waitFor();
        const geometry = await search.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const bar = node.closest('.app-title-bar').getBoundingClientRect();
          return {
            height: rect.height,
            topGap: rect.top - bar.top,
            bottomGap: bar.bottom - rect.bottom,
            buttons: [...node.querySelectorAll('button')].map((button) => {
              const hit = button.getBoundingClientRect();
              return { width: hit.width, height: hit.height, top: hit.top, bottom: hit.bottom };
            }),
            barTop: bar.top,
            barBottom: bar.bottom,
          };
        });
        if (output)
          await page.screenshot({
            path: resolve(output, `${engine}-${width}x${height}-${preset}-${theme}.png`),
          });
        const context = JSON.stringify({ width, height, preset, theme, geometry });
        assert.equal(geometry.height, 36, context);
        assert(geometry.topGap >= 3 && geometry.bottomGap >= 3, context);
        for (const button of geometry.buttons) {
          assert(button.width >= 44 && button.height >= 44, context);
          assert(
            button.top >= geometry.barTop - 1 && button.bottom <= geometry.barBottom + 1,
            context,
          );
        }
        await page.getByRole('button', { name: '清空搜索', exact: true }).click();
        assert.equal(await search.locator('input').inputValue(), '');
        await page.keyboard.press('Escape');
        results.push({ width, height, preset, theme, geometry });
      }
    }
  }
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktop.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await desktop.goto(page.url());
  await desktop.locator('.app-title-bar .weq-titlebar-search').waitFor({ state: 'visible' });
  assert.equal(
    (await desktop.locator('.app-title-bar .weq-titlebar-search').boundingBox()).height,
    32,
    '桌面搜索保持原高度',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, cases: results.length, results }));
} finally {
  await browser?.close();
  await server.close();
}

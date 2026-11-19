import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.WEQ_PORTRAIT_TARGET ?? 'electron';
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/search-hover-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(target) },
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
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_SEARCH_HOVER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  let cases = 0;
  for (const remote of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 600, height: 1000 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    if (remote)
      await page.addInitScript(() => {
        window.weqRemoteShell = { openMenu() {} };
      });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/desktop-portrait.html`,
    );
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
    const search = page.locator('.weq-mobile-header .weq-titlebar-search');
    const button = search.getByRole('button', { name: '全局搜索', exact: true });
    for (const width of [320, 600, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const preset of ['classic', 'retro', 'qqnt']) {
        for (const theme of ['light', 'dark']) {
          for (const reducedMotion of ['no-preference', 'reduce']) {
            // 先完成主题切换，再单独测搜索动画，避免主题快照接管鼠标命中。
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.evaluate(
              ({ theme, preset }) => {
                const store = window.desktopPortraitQa.store.getState();
                store.setComponentStyle(preset);
                store.setPreference(theme);
                store.setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
              },
              { theme, preset },
            );
            await page.mouse.move(8, 200);
            await page.emulateMedia({ reducedMotion });
            const before = await button.boundingBox();
            const point = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
            await page.mouse.move(point.x, point.y);
            // 逐帧检查静止光标，不能只等待最终一帧恰好处于展开状态。
            const frames = await search.evaluate(async (node, point) => {
              const frames = [];
              for (let frame = 0; frame < 32; frame++) {
                await new Promise(requestAnimationFrame);
                const rect = node.getBoundingClientRect();
                frames.push({
                  expanded: node.classList.contains('is-expanded'),
                  hit: node.contains(document.elementFromPoint(point.x, point.y)),
                  left: rect.left,
                  right: rect.right,
                });
              }
              return frames;
            }, point);
            const context = JSON.stringify({ remote, width, preset, theme, reducedMotion, frames });
            assert(
              frames.every((frame) => frame.expanded && frame.hit),
              context,
            );
            assert.equal(await button.getAttribute('aria-pressed'), 'false', context);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
              context,
            );
            if (output && reducedMotion === 'no-preference')
              await page.screenshot({
                path: resolve(
                  output,
                  `${target}-${remote ? 'remote' : 'desktop'}-${width}-${preset}-${theme}.png`,
                ),
              });
            await page.mouse.move(8, 200);
            assert.equal(await button.getAttribute('aria-expanded'), 'false');
            await button.click();
            await search.locator('input').fill('保留搜索词');
            await page.mouse.move(8, 200);
            assert.equal(await button.getAttribute('aria-pressed'), 'true');
            await page.keyboard.press('Escape');
            assert.equal(await button.getAttribute('aria-expanded'), 'false');
            assert.equal(await search.locator('input').inputValue(), '保留搜索词');
            cases++;
          }
        }
      }
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ target, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

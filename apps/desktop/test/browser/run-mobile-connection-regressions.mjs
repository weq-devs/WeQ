import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_BROWSER_ENGINE ?? 'webkit';
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/mobile-connection-regressions'),
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
  browser = await engines[engine].launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    reducedMotion: 'reduce',
    userAgent: 'Mozilla/5.0 (iPhone) WeQRemote',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    window.weqRemoteShell = { openMenu() {} };
    window.weqRemoteWindowLayout = {
      width: 402,
      height: 874,
      topLeft: { width: 68, height: 54 },
      topRight: { width: 68, height: 54 },
    };
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/`;
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
    );
  if (output) await mkdir(output, { recursive: true });
  await page.goto(`${url}desktop-portrait.html?home`);
  const header = page.locator('.weq-mobile-header');
  await header.waitFor();
  await page.addStyleTag({
    content:
      ':root { --weq-window-safe-top: 0px; } .weq-mobile-header { height:115px !important; min-height:115px !important; padding-top:var(--weq-window-safe-top) !important; }',
  });
  await frames();
  const before = await header.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    left: getComputedStyle(node).paddingLeft,
  }));
  assert.equal(before.left, '76px', '未有安全区时仍保留真正相交的角部避让');
  // 不派发 resize 或切换页面：只模拟 WKWebView 首次显示后的安全区变化。
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--weq-window-safe-top', '59px'),
  );
  await frames();
  const after = await header.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    left: getComputedStyle(node).paddingLeft,
    right: getComputedStyle(node).paddingRight,
  }));
  assert.equal(after.height, before.height);
  assert.equal(after.left, '12px');
  assert.equal(after.right, '12px');
  assert.equal(await page.locator('[data-weq-window-safe-area]').count(), 1);
  if (output) await page.screenshot({ path: resolve(output, `${engine}-home-safe-area.png`) });

  await page.goto(`${url}conversation-list-height.html`);
  await page.locator('.conversation-row').first().waitFor();
  const results = [];
  for (const width of [402, 1024]) {
    await page.setViewportSize({ width, height: 874 });
    for (const theme of ['light', 'dark']) {
      for (const skin of ['qqnt', 'classic', 'retro']) {
        await page.evaluate(
          ({ theme, skin }) => {
            const store = window.listHeightQa.store.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setComponentStyle(skin);
          },
          { theme, skin },
        );
        await frames();
        const row = page.locator('.conversation-row').first();
        await page.mouse.move(width - 1, 873);
        const normal = await row.evaluate((node) => ({
          background: getComputedStyle(node).backgroundColor,
          shadow: getComputedStyle(node).boxShadow,
        }));
        await row.hover();
        assert.deepEqual(
          await row.evaluate((node) => ({
            background: getComputedStyle(node).backgroundColor,
            shadow: getComputedStyle(node).boxShadow,
          })),
          normal,
          `${width}/${theme}/${skin}: 触摸设备不能保留悬停色或阴影`,
        );
        if (engine === 'chromium') {
          const session = await page.context().newCDPSession(page);
          const box = await row.boundingBox();
          const touch = (y) => ({ x: box.x + box.width / 2, y });
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [touch(box.y + 38)],
          });
          for (let step = 1; step <= 6; step++)
            await session.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [touch(box.y + 38 - step * 4)],
            });
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await session.detach();
        }
        await page.locator('[data-weq-windowed-list]').evaluate((node) => {
          node.scrollTop = 760;
        });
        await frames();
        const hovered = await page.locator('.conversation-row:hover').evaluateAll((nodes) =>
          nodes.map((node) => ({
            background: getComputedStyle(node).backgroundColor,
            shadow: getComputedStyle(node).boxShadow,
          })),
        );
        assert.ok(
          hovered.every(
            (style) => style.background === normal.background && style.shadow === normal.shadow,
          ),
        );
        results.push({ width, theme, skin, hovered: hovered.length });
        if (output && width === 402 && skin === 'qqnt')
          await page.screenshot({ path: resolve(output, `${engine}-touch-list-${theme}.png`) });
        await page.locator('[data-weq-windowed-list]').evaluate((node) => {
          node.scrollTop = 0;
        });
      }
    }
  }
  const pointer = await browser.newPage({
    viewport: { width: 1280, height: 874 },
    hasTouch: false,
  });
  pointer.on('pageerror', (error) => errors.push(error.message));
  await pointer.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await pointer.goto(`${url}conversation-list-height.html`);
  const pointerRow = pointer.locator('.conversation-row').first();
  await pointerRow.waitFor();
  const normal = await pointerRow.evaluate((node) => getComputedStyle(node).backgroundColor);
  await pointerRow.hover();
  assert.notEqual(
    await pointerRow.evaluate((node) => getComputedStyle(node).backgroundColor),
    normal,
    '鼠标悬停反馈保留',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      safeArea: { before, after },
      touchCases: results,
      pointerHover: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

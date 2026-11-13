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
  cacheDir: resolve(root, 'node_modules/.cache/remote-window-layout-vite'),
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
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad) WeQRemote',
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
  await page.addInitScript(() => {
    window.weqRemoteShell = { openMenu() {} };
    window.weqRemoteWindowLayout = {
      width: 1024,
      height: 768,
      topLeft: { width: 100, height: 32 },
      topRight: { width: 0, height: 0 },
    };
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: Object.assign(new EventTarget(), { type: 'portrait-primary' }),
    });
    const firstCommit = new MutationObserver(() => {
      const header = document.querySelector('.app-title-bar');
      if (!header?.getBoundingClientRect().width) return;
      window.windowLayoutFirstCommit = getComputedStyle(header).paddingLeft;
      firstCommit.disconnect();
    });
    firstCommit.observe(document, { childList: true, subtree: true });
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/desktop-portrait.html`,
  );
  const editor = page.locator('.composer > .composer-editor');
  await page.locator('.sidebar .conversation-row').first().click();
  await editor.fill('窗口缩放保留草稿和输入焦点');
  assert.equal(
    await page.evaluate(() => window.windowLayoutFirstCommit),
    '108px',
    '首次 DOM 提交即避让，不只检查最终状态',
  );
  await editor.focus();
  await editor.evaluate((node) => {
    window.windowLayoutEditor = node;
  });
  const output = process.env.WEQ_RESPONSIVE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [width, height] of [
    [1024, 768],
    [820, 1180],
    [600, 900],
    [430, 800],
    [320, 700],
    [1024, 768],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [controlsWidth, controlsHeight] of [
      [100, 32],
      [170, 56],
      [0, 0],
    ]) {
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          ({ width, height, controlsWidth, controlsHeight, theme }) => {
            window.desktopPortraitQa.store.getState().setPreference(theme);
            window.desktopPortraitQa.store
              .getState()
              .setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
            window.weqRemoteWindowLayout = {
              width,
              height,
              topLeft: { width: controlsWidth, height: controlsHeight },
              topRight: { width: 0, height: 0 },
            };
            window.dispatchEvent(new Event('weq-remote-window-layout'));
          },
          { width, height, controlsWidth, controlsHeight, theme },
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const geometry = await page.evaluate(
          ({ controlsWidth, controlsHeight }) => {
            const visible = (node) => {
              const rect = node.getBoundingClientRect();
              return rect.width && rect.height && getComputedStyle(node).visibility !== 'hidden';
            };
            const headers = [
              ...document.querySelectorAll(
                '.app-title-bar, .weq-mobile-header, .chat-header, .sidebar-header, .app-rail',
              ),
            ].filter(visible);
            const blocked = (rect) =>
              rect.left < controlsWidth &&
              rect.right > 0 &&
              rect.top < controlsHeight &&
              rect.bottom > 0;
            const overlap = headers.flatMap((header) =>
              [...header.querySelectorAll('button')]
                .filter(visible)
                .filter((button) => blocked(button.getBoundingClientRect()))
                .map((button) => button.outerHTML),
            );
            const chat = document.querySelector('.chat-main').getBoundingClientRect();
            const input = document.querySelector('.composer-editor');
            return {
              overlap,
              overflow: document.documentElement.scrollWidth > innerWidth,
              chatLeft: chat.left,
              focused: document.activeElement === input,
              sameEditor: window.windowLayoutEditor === input,
              active: document.activeElement?.className,
              detail: document.querySelector('.app-shell-root').getAttribute('data-mobile-detail'),
              draft: input.textContent,
              offsets: [...document.querySelectorAll('[data-weq-window-chrome]')].map((node) => ({
                name: node.className,
                left: getComputedStyle(node).paddingLeft,
                top: getComputedStyle(node).paddingTop,
              })),
            };
          },
          { controlsWidth, controlsHeight },
        );
        assert.deepEqual(
          geometry.overlap,
          [],
          JSON.stringify({ width, height, controlsWidth, theme, geometry }),
        );
        assert.equal(
          geometry.overflow,
          false,
          JSON.stringify({ width, height, controlsWidth, geometry }),
        );
        assert.equal(
          geometry.focused,
          true,
          JSON.stringify({ width, height, controlsWidth, theme, geometry }),
        );
        assert.equal(geometry.draft, '窗口缩放保留草稿和输入焦点');
        if (!controlsWidth) assert.deepEqual(geometry.offsets, []);
        results.push({ width, height, controlsWidth, theme, geometry });
        if (output && theme === 'light' && controlsWidth === 100)
          await page.screenshot({ path: resolve(output, `${engine}-${width}x${height}.png`) });
      }
    }
  }
  // 动态挂载到 body 的真实媒体预览也使用同一份占位。
  await page.evaluate(() => {
    window.weqRemoteWindowLayout.topLeft = { width: 100, height: 32 };
    window.dispatchEvent(new Event('weq-remote-window-layout'));
    window.openWindowLayoutPreview();
  });
  await page.locator('.weq-preview-header[data-weq-window-chrome]').waitFor();
  assert.equal(
    await page
      .locator('.weq-preview-header')
      .evaluate((node) => getComputedStyle(node).paddingLeft),
    '108px',
  );
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, cases: results.length, results }));
} finally {
  await browser?.close();
  await server.close();
}

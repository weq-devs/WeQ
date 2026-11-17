import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-log-viewer'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/performance-monitor.stub.ts'),
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
  const context = await browser.newContext();
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const output = process.env.WEQ_LOG_VIEWER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/performance-monitor.html`;
  for (const host of ['desktop', 'web']) {
    for (const mode of ['popup', 'inline']) {
      await page.goto(`${url}?host=${host}&state=long-logs`);
      if (mode === 'inline')
        await page.evaluate(() => {
          window.open = () => null;
        });
      const popup = mode === 'popup' ? page.waitForEvent('popup') : Promise.resolve(page);
      await page.getByRole('button', { name: '打开日志查看', exact: true }).click();
      const logs = await popup;
      await logs.getByText('合成日志 159', { exact: false }).waitFor();
      for (const [width, height] of [
        [960, 680],
        [640, 480],
        [390, 844],
        [320, 568],
      ]) {
        await logs.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty(
              '--weq-accent-effective',
              theme === 'light' ? '#006d50' : '#f5cb70',
            );
          }, theme);
          await logs.waitForFunction(
            (theme) => document.documentElement.dataset.theme === theme,
            theme,
          );
          const bounds = await logs.locator('.weq-help-log-view').evaluate((view) => {
            const box = view.getBoundingClientRect();
            const panel = view.closest('.weq-monitor-panel').getBoundingClientRect();
            return {
              top: box.top,
              bottom: box.bottom,
              right: box.right,
              panelBottom: panel.bottom,
              viewportHeight: innerHeight,
              viewportWidth: innerWidth,
              scrollHeight: view.scrollHeight,
              clientHeight: view.clientHeight,
              clientWidth: view.clientWidth,
              scrollWidth: view.scrollWidth,
              pageScrollHeight: document.documentElement.scrollHeight,
              pageScrollWidth: document.documentElement.scrollWidth,
            };
          });
          if (output)
            await logs.screenshot({
              path: resolve(output, `${host}-${mode}-${width}-${theme}.png`),
            });
          const label = `${host} ${mode} ${width}x${height} ${theme}: ${JSON.stringify(bounds)}`;
          assert.ok(bounds.top >= 0, label);
          assert.ok(bounds.bottom <= Math.min(bounds.panelBottom, height) + 1, label);
          assert.ok(bounds.bottom <= bounds.panelBottom - (width <= 500 ? 8 : 12) + 1, label);
          assert.ok(bounds.right <= width + 1, label);
          if (mode === 'popup') assert.ok(bounds.pageScrollHeight <= height + 1, label);
          assert.ok(bounds.pageScrollWidth <= width + 1, label);
          assert.ok(bounds.clientHeight > 100, label);
          assert.ok(bounds.scrollHeight > bounds.clientHeight, label);
          assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, label);
          await logs.locator('.weq-help-log-view').evaluate((view) => {
            view.scrollTop = view.scrollHeight;
          });
          assert.equal(
            await logs
              .locator('.weq-log-line')
              .last()
              .evaluate((line) => {
                const box = line.getBoundingClientRect();
                return line.contains(
                  document.elementFromPoint(box.x + box.width / 2, box.bottom - 2),
                );
              }),
            true,
            label,
          );
        }
      }
      if (mode === 'popup') await logs.close();
      else await logs.getByRole('button', { name: '关闭监视窗口', exact: true }).click();
    }
  }
  assert.deepEqual(errors, []);
  console.log('日志查看：桌面／Web、四种窗口尺寸与浅深主题下内容留在窗口内，末条日志可滚动查看');
} finally {
  await browser?.close();
  await server.close();
}

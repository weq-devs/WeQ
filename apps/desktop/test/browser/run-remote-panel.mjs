import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-remote-panel'),
  optimizeDeps: { entries: ['test/browser/remote-panel.html'] },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  plugins: [react(), tailwind()],
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-panel.html`,
  );
  const consent = page.locator('.weq-remote-consent');
  await consent.waitFor();
  const output = process.env.WEQ_REMOTE_PANEL_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 620, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const store = window.remotePanelQa.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.mouse.move(0, 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('tooltip').count(), 0);
      const layout = await consent.evaluate((label) => {
        const checkbox = label.querySelector('input').getBoundingClientRect();
        const box = label.getBoundingClientRect();
        const button = label.previousElementSibling.getBoundingClientRect();
        const center = (rect) => rect.top + rect.height / 2;
        return {
          checkbox: Math.abs(center(checkbox) - center(box)),
          button: Math.abs(center(button) - center(box)),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(layout.checkbox <= 1, JSON.stringify(layout));
      assert.ok(layout.button <= 1, JSON.stringify(layout));
      assert.equal(layout.overflow, false);
      await consent.hover();
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      assert.ok((await tooltip.textContent()).includes('通过 Tailscale 跨网络连接'));
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await page.locator('.weq-remote-consent input').focus();
  await page.getByRole('tooltip').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await page.getByRole('checkbox').check();
  assert.ok(await page.getByText('请先启动并登录上方的 WeQ 专用 Tailscale 服务。').isVisible());
  assert.deepEqual(errors, []);
  console.log('Remote 配对操作行：6 组布局与主题、悬停、键盘提示和服务提醒通过');
} finally {
  await browser?.close();
  await server.close();
}

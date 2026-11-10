import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-navigation'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
      },
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
  const errors = [];
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.clear());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html?display=1`,
      );
      await page.evaluate((theme) => {
        window.settingsNavigationQa.theme.getState().setPreference(theme);
        window.settingsNavigationQa.theme
          .getState()
          .setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      const metadata = page.locator('[data-setting-id="custom-message-display"]');
      assert.deepEqual(await metadata.locator('.weq-set-row-label').allTextContents(), [
        '显示消息序号（seq）',
        '显示发送日期',
        '显示发送时间',
      ]);
      const headings = page.locator('.weq-set-card-head .weq-set-card-title');
      assert((await headings.count()) >= 4);
      for (const heading of await headings.all()) {
        const icon = heading.locator('.weq-set-card-icon[aria-hidden] svg');
        assert.equal(await icon.count(), 1, `设置分组缺少图标：${await heading.textContent()}`);
        const bounds = await icon.boundingBox();
        assert(bounds && bounds.width >= 14 && bounds.height >= 14);
      }
      for (const id of ['message-date', 'message-time']) {
        const row = metadata.locator(`[data-setting-id="${id}"]`);
        const label = await row.locator('.weq-set-row-label').boundingBox();
        const toggle = await row.getByRole('switch').boundingBox();
        assert(label && toggle && label.x + label.width <= toggle.x);
      }
      if (output)
        await page.screenshot({ path: resolve(output, `message-display-${width}-${theme}.png`) });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html`,
      );
      await page.evaluate((theme) => {
        window.settingsNavigationQa.theme.getState().setPreference(theme);
      }, theme);
      await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
      const name = page.locator('.weq-onebot-server-editor input').first();
      await name.fill('未保存的连接');
      await page.getByRole('button', { name: '消息', exact: true }).click();
      const modal = page.getByRole('dialog');
      await modal.getByText('当前设置尚未保存', { exact: true }).waitFor();
      const bounds = await modal.boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= 845,
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await modal.getByRole('button', { name: '先保存', exact: true }).click();
      assert.equal(await name.inputValue(), '未保存的连接');
      await page.getByRole('button', { name: '消息', exact: true }).click();
      await page.getByRole('button', { name: '暂时离开', exact: true }).click();
      await page.getByText('消息页面', { exact: true }).waitFor();
      assert.equal(await page.locator('.weq-settings-dialog').count(), 0);
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      assert.equal(await name.inputValue(), '未保存的连接');
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

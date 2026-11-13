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
  cacheDir: resolve(root, 'node_modules/.vite-missing-message-settings'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
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
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_MISSING_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-audit.html?section=chat-messages`,
      );
      await page.waitForFunction(() => !!window.settingsAuditQa);
      await page.evaluate(async (theme) => {
        const { acceptPreferences } = await import('/src/renderer/src/lib/clientPreferences.ts');
        acceptPreferences({ epoch: 'settings-audit', revision: 0, values: {}, records: {} }, false);
        window.settingsAuditQa.theme.getState().setPreference(theme);
        window.settingsAuditQa.theme
          .getState()
          .setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      const automatic = page.getByRole('switch', { name: '查看时自动拉取缺失的消息', exact: true });
      const context = page.getByRole('switch', {
        name: '定位到缺失消息时自动拉取上下文',
        exact: true,
      });
      const count = page.getByRole('spinbutton', { name: '自动拉取上下文条数', exact: true });
      await automatic.waitFor();
      assert.equal(await count.count(), 0);
      await context.click();
      await count.waitFor();
      assert.equal(await count.inputValue(), '30');
      await count.fill('47');
      await count.blur();
      await page.waitForFunction(
        async () =>
          (await import('/src/renderer/src/lib/clientPreferences.ts')).preferenceValue(
            'missingMessageContextCount',
          ) === 47,
      );
      await automatic.click();
      assert.equal(await context.count(), 0);
      assert.equal(await count.count(), 0);
      await automatic.click();
      await count.waitFor();
      assert.equal(await count.inputValue(), '47');
      for (const id of [
        'auto-fetch-missing-messages',
        'auto-fetch-missing-context',
        'missing-message-context-count',
      ]) {
        const row = page.locator(`[data-setting-id="${id}"]`);
        await row.scrollIntoViewIfNeeded();
        assert(
          await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
          `${id} 横向溢出`,
        );
        const label = await row.locator('.weq-set-row-main').boundingBox();
        const control = await row.locator('.weq-set-row-ctrl').boundingBox();
        assert(
          label &&
            control &&
            (label.x + label.width <= control.x + 1 || label.y + label.height <= control.y + 1),
          `${id} 标签与控件重叠`,
        );
      }
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

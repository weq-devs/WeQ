import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-history-visibility'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/history-visibility.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/history-visibility.stub.ts'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_avatar/'))
      return route.fulfill({
        path: resolve(root, '../../resources/brand/logo.png'),
        contentType: 'image/png',
      });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/history-visibility.html`,
  );
  await page.getByText('当前昵称', { exact: true }).waitFor();
  const output = process.env.WEQ_HISTORY_VISIBILITY_QA;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(
        (theme) => window.historyVisibilityQa.theme.getState().setPreference(theme),
        theme,
      );
      assert.equal(await page.locator('.weq-profile-field-history, .contact-history').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.getByRole('button', { name: '历史签名', exact: true }).click();
      await page.getByText('暂无历史签名', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByText('暂无历史签名', { exact: true }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '历史头像', exact: true }).click();
      await page.locator('.weq-avatar-history-grid img').waitFor();
      await page.waitForFunction(() => {
        const img = document.querySelector('.weq-avatar-history-grid img');
        return img?.complete && img.naturalWidth > 0;
      });
      await page.locator('.weq-avatar-history-grid img').click();
      await page.getByRole('dialog', { name: '历史头像预览' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '关闭历史头像' }).click();
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  const reads = await page.evaluate(() => window.historyVisibilityQa.reads);
  assert.equal(reads.fields, 0);
  assert.equal(reads.versions, 0);
  assert.ok(reads.signatures > 0 && reads.avatars > 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: 6, reads, errors }));
} finally {
  await browser?.close();
  await server.close();
}

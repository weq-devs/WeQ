import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const stub = resolve(root, 'test/browser/requirements.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-requirements'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/lib\/clientPreferences$/, replacement: stub },
      { find: /^.*\/hooks\/useExportSavePolicy$/, replacement: stub },
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/requirements.html`,
  );
  await page.getByRole('button', { name: '多选', exact: true }).click();
  await page.getByRole('button', { name: '全选已加载项', exact: true }).click();
  await page.getByRole('button', { name: '相册乙', exact: true }).click();
  await page.getByRole('button', { name: '全选已加载项', exact: true }).click();
  await page.getByRole('button', { name: '导出所选内容', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: '已选 2 项内容' }).count(), 1);
  const output = process.env.WEQ_REQUIREMENTS_QA;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#ce809d' : '#167d67',
        );
      }, theme);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2),
        false,
        `${width}/${theme} overflow`,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  await page.getByRole('button', { name: '编辑列表', exact: true }).click();
  await page.getByRole('button', { name: /相册甲的照片.*媒体/ }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).last().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: /取消/ }).last().click();
  assert.equal(await page.evaluate(() => window.requirementsQa.exports.length), 0);
  await page.evaluate(() => {
    window.requirementsQa.remote = true;
  });
  await page.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).last().click();
  await page.waitForFunction(() => window.requirementsQa.exports.length === 1);
  const exported = await page.evaluate(() => window.requirementsQa.exports[0]);
  assert.equal(exported.items.length, 1);
  assert.equal(exported.items[0].albumId, 'album-b');
  assert.equal(exported.savePolicy.directory, '.');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases: 6,
      crossAlbum: true,
      exactExport: true,
      cancelledWebSave: true,
      remoteSavePolicy: true,
      pageErrors: errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

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
  cacheDir: resolve(root, 'node_modules/.vite-group-profile'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-profile.stub.ts'),
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-profile.html`,
  );
  const section = page.getByRole('region', { name: '群扩展资料' });
  await section.getByText('467 人', { exact: true }).waitFor();
  const mode = (value) => page.evaluate((value) => window.groupProfileQa.setMode(value), value);
  await mode('zero');
  await section.getByText('0 人', { exact: true }).waitFor();
  await mode('loading');
  await section.getByText('读取中…', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button').isDisabled(), true);
  await mode('offline');
  await section.getByText('缓存', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button').isDisabled(), true);
  await mode('offline-empty');
  await section.getByText('暂无缓存', { exact: true }).waitFor();
  assert.equal(await section.getByText('未知', { exact: true }).count(), 3);
  await mode('wrong-target');
  assert.equal(await section.getByText('未知', { exact: true }).count(), 3);
  await mode('cache-save');
  await section.getByText('缓存保存失败', { exact: true }).waitFor();
  await section.getByText('467 人', { exact: true }).waitFor();
  await mode('error');
  await section.getByText('更新失败，保留缓存', { exact: true }).waitFor();
  await section.getByRole('button', { name: '刷新群扩展资料' }).click();
  await section.getByText('已更新', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.groupProfileQa.refreshes), 1);
  const output = process.env.WEQ_GROUP_PROFILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.groupProfileQa.theme.getState().setPreference(theme);
        window.groupProfileQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.waitForFunction(
        (theme) =>
          getComputedStyle(document.querySelector('.weq-group-extras-rows dd')).color ===
          (theme === 'dark' ? 'rgb(238, 238, 238)' : 'rgb(23, 23, 23)'),
        theme,
      );
      assert.equal(await section.evaluate((e) => e.scrollWidth > e.clientWidth), false);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok((await page.getByRole('dialog').textContent()).includes('本地群名保持不变'));
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  assert.deepEqual(errors, []);
  console.log('群扩展资料六组主题与宽度、零值、未知、离线缓存、加载、失败重试和目标隔离检查通过');
} finally {
  await browser?.close();
  await server.close();
}

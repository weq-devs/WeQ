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
  cacheDir: resolve(root, 'node_modules/.vite-contact-history'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-history.stub.ts'),
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-history.html`,
  );
  const region = page.getByRole('region', { name: '资料历史' });
  await region.getByRole('button', { name: /群成员名单/ }).click();
  await region.getByText('新增 1', { exact: true }).waitFor();
  await region.getByText('退出／移除 1', { exact: true }).waitFor();
  await region.getByText('变更 1', { exact: true }).waitFor();
  await region.getByText('变更 1', { exact: true }).click();
  await region.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(
    await region.getByRole('button', { name: '下一页', exact: true }).isDisabled(),
    true,
  );
  await region.getByRole('button', { name: '上一页', exact: true }).click();
  await region.getByLabel('资料类别', { exact: true }).selectOption('getGroupDetail');
  await region.getByRole('button', { name: /群资料/ }).waitFor();
  await region.getByLabel('资料类别', { exact: true }).selectOption('');
  await region.getByRole('button', { name: /群成员名单/ }).click();
  await region.getByText('完整版本', { exact: true }).click();
  const output = process.env.WEQ_CONTACT_HISTORY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.contactHistoryQa.theme.getState().setPreference(theme);
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      assert.equal(
        await region.evaluate((element) => element.scrollWidth > element.clientWidth),
        false,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  await page.evaluate(() => window.contactHistoryQa.setMode('partial'));
  await region.getByText('本次未返回 1', { exact: true }).waitFor();
  assert.equal(await region.getByText('退出／移除 1', { exact: true }).count(), 0);
  for (const [mode, text] of [
    ['loading', '正在读取历史…'],
    ['empty', '暂无资料历史'],
    ['error', '历史读取失败：合成读取失败'],
    ['migration', '部分旧缓存尚未迁入，原件已保留：旧缓存格式错误'],
  ]) {
    await page.evaluate((mode) => window.contactHistoryQa.setMode(mode), mode);
    await region.getByText(text, { exact: true }).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(
    '资料历史：六组主题与宽度、版本差异、长字段、分页、筛选、加载、空状态、错误与迁移提示通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

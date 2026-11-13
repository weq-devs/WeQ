import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-source.stub.ts'),
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fileIcon = await readFile(resolve(root, '../../resources/fileicon/txt.png'));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/fileicon/'))
      return route.fulfill({ contentType: 'image/png', body: fileIcon });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-source.html`,
  );
  await page.getByRole('button', { name: '查看群待办', exact: true }).click();
  await page.getByRole('button', { name: '定位原消息', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.groupSourceQa.jumps), [['9007199254740999']]);
  await page.getByRole('button', { name: '打开群文件', exact: true }).click();
  const locate = page.getByRole('button', {
    name: '定位原消息 群文件定位测试-长文件名-合成资料.txt',
    exact: true,
  });
  await locate.waitFor();
  assert.equal(await page.evaluate(() => window.groupSourceQa.reads), 0);
  await locate.click();
  const results = page.getByRole('region', { name: '群文件原消息' });
  await results.getByRole('button', { name: /消息 12/ }).waitFor();
  const output = process.env.WEQ_GROUP_SOURCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.groupSourceQa.theme.getState().setPreference(theme);
        window.groupSourceQa.theme.getState().setAccent(theme === 'dark' ? '#fff3a1' : '#075c30');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      assert.equal(await results.evaluate((e) => e.scrollWidth > e.clientWidth), false);
      const buttons = await page.locator('.weq-file-row-tools button').evaluateAll((buttons) =>
        buttons
          .filter((button) => button.getBoundingClientRect().width > 0)
          .map((button) => {
            const r = button.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          }),
      );
      for (let i = 0; i < buttons.length; i++)
        for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i],
            b = buttons[j];
          assert.ok(
            a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
            `按钮重叠 ${width} ${theme}`,
          );
        }
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  await results.getByRole('button', { name: /消息 11/ }).click();
  assert.deepEqual((await page.evaluate(() => window.groupSourceQa.jumps)).at(-1), ['11', '90011']);
  await page.evaluate(() => {
    window.groupSourceQa.mode = 'empty';
  });
  await page.getByRole('button', { name: '打开群文件', exact: true }).click();
  await locate.click();
  await results.getByText('本地未找到对应消息', { exact: true }).waitFor();
  await results.getByRole('button', { name: '关闭定位结果' }).click();
  await page.evaluate(() => {
    window.groupSourceQa.mode = 'error';
  });
  await locate.click();
  await results.getByText('合成查询失败', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.groupSourceQa.mode = 'single';
  });
  await results.getByRole('button', { name: '重试定位' }).click();
  await page.waitForFunction(() => window.groupSourceQa.jumps.at(-1)?.[0] === '12');
  assert.deepEqual(errors, []);
  console.log(
    '群文件与待办定位：六组主题/宽度、按钮无重叠、按需查询、多条选择、空结果、失败重试与精确跳转通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

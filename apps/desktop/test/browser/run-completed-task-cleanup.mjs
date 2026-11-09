import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-task-cleanup'),
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/completed-task-cleanup.html`,
  );
  if (output) await mkdir(output, { recursive: true });
  for (const [dark, width, accent] of [
    [false, 1000, '#075c30'],
    [true, 1000, '#fff3a1'],
    [false, 360, '#ffffff'],
    [true, 360, '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(([dark, accent]) => window.cleanupTheme(dark, accent), [dark, accent]);
    await page.getByRole('button', { name: '清除已结束任务', exact: true }).click();
    await page.getByText('确定清除 3 项已结束任务？', { exact: false }).waitFor();
    await page.getByText('其中 2 项导出尚未保存', { exact: false }).waitFor();
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role="dialog"]')].some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < 0 ||
          rect.right > innerWidth + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      }),
    );
    if (overflow) throw new Error(`控件溢出: ${dark}/${width}`);
    if (output)
      await page.screenshot({
        path: resolve(output, `task-cleanup-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('button', { name: '保留', exact: true }).click();
    await page
      .getByRole('button', { name: '清除已结束任务', exact: true })
      .waitFor({ state: 'visible' });
    for (const name of ['信息提示', '错误提示']) {
      // 真实点击右下角入口，验证提示不沿用触发点，也不退回靠右浮层布局。
      await page.getByRole('button', { name, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(Math.abs(bounds.x + bounds.width / 2 - width / 2) <= 1, '提示水平居中');
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - 400) <= 1, '提示垂直居中');
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, '窄屏提示不溢出');
      assert.equal(await dialog.getAttribute('aria-modal'), null, '信息提示保持非模态');
      if (output)
        await page.screenshot({
          path: resolve(output, `task-cleanup-${name}-${dark ? 'dark' : 'light'}-${width}.png`),
        });
      await page.getByRole('button', { name: '我知道了', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor();
      await page.mouse.click(4, 400);
      await dialog.waitFor({ state: 'detached' });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('任务清除：4 组深浅主题、主题色、桌面/窄屏确认框及信息/错误提示居中与关闭检查通过');
} finally {
  await browser?.close();
  await server.close();
}

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
  cacheDir: resolve(root, 'node_modules/.vite-qzone-forwards'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qzone-forwards.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/qzone-forwards.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const errors = [];
let scenes = 0;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_QZONE_FORWARD_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1280])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/_media/avatar?*', (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VxQAAAAASUVORK5CYII=',
            'base64',
          ),
        }),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qzone-forwards.html?theme=${theme}`,
      );
      await page.getByRole('button', { name: '查看转发者', exact: true }).click();
      const panel = page.getByRole('region', { name: '转发列表' });
      await panel.getByText('合成转发者', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('转发操作次数').textContent(), '0');
      const box = await panel.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y >= 0 &&
          box.y + box.height <= 801,
      );
      assert.equal(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await panel.getByRole('button', { name: '加载更多' }).click();
      await panel.getByText('已到可读取末页').waitFor();
      assert.equal(await panel.locator('.weq-qzn-forward-row').count(), 3);
      assert.equal(await panel.getByRole('button', { name: '加载更多' }).count(), 0);
      await panel.getByRole('button', { name: '进入 合成转发者 的空间', exact: true }).click();
      assert.equal(await page.getByLabel('当前用户').textContent(), '合成转发者');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '转发', exact: true }).click();
      assert.equal(await page.getByLabel('转发操作次数').textContent(), '1');
      scenes++;
      await page.close();
    }
  for (const mode of ['empty', 'error']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qzone-forwards.html?mode=${mode}`,
    );
    await page.getByRole('button', { name: '查看转发者', exact: true }).click();
    const panel = page.getByRole('region', { name: '转发列表' });
    if (mode === 'empty') await panel.getByText('暂无可读取的转发记录').waitFor();
    else {
      await panel.getByRole('button', { name: '重试转发名单' }).click();
      await panel.getByText('合成转发者', { exact: true }).waitFor();
    }
    scenes++;
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scenes,
      layout: true,
      pagingStop: true,
      personNavigation: true,
      writeActionPreserved: true,
      emptyAndRetry: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

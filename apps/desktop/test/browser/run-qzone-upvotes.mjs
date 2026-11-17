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
  cacheDir: resolve(root, 'node_modules/.vite-qzone-upvotes'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qzone-upvotes.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/qzone-upvotes.html'] },
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
  const output = process.env.WEQ_QZONE_UPVOTE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const visit = async (width, theme, mode = '') => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
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
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qzone-upvotes.html?theme=${theme}&mode=${mode}`,
    );
    return page;
  };
  for (const width of [320, 390, 1280])
    for (const theme of ['light', 'dark']) {
      const page = await visit(width, theme);
      const ordinary = page.getByRole('article', { name: '普通说说' });
      await ordinary
        .getByRole('button', { name: '推', exact: true })
        .filter({ hasText: '199' })
        .waitFor();
      await ordinary.getByRole('button', { name: '推', exact: true }).focus();
      const panel = page.getByRole('region', { name: '推的人', exact: true });
      await panel.getByText('合成推用户1', { exact: true }).waitFor();
      await panel.getByText('已显示 5 人，共 199 人推过', { exact: true }).waitFor();
      const box = await panel.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y >= 0 &&
          box.y + box.height <= 901,
      );
      assert.equal(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await panel.getByRole('button', { name: '进入 合成推用户1 的空间', exact: true }).click();
      assert.equal(await page.getByLabel('当前用户').textContent(), '合成推用户1');
      await page.keyboard.press('Escape');
      const feed = page.getByRole('region', { name: '空友动态' });
      const push = feed.getByRole('button', { name: '推', exact: true });
      await push.click();
      await feed
        .getByRole('button', { name: '取消推', exact: true })
        .filter({ hasText: '200' })
        .waitFor();
      await panel.getByText('合成自己', { exact: true }).waitFor();
      await feed.getByRole('button', { name: '取消推', exact: true }).click();
      await feed
        .getByRole('button', { name: '推', exact: true })
        .filter({ hasText: '199' })
        .waitFor();
      if (output) await page.screenshot({ path: resolve(output, `public-${theme}-${width}.png`) });
      scenes++;
      await page.close();
    }
  for (const mode of ['empty', 'unknown', 'error', 'readonly']) {
    const page = await visit(390, 'light', mode);
    const post = page.getByRole('article', { name: '普通说说' });
    if (mode === 'error') await post.getByRole('button', { name: '重试空友状态' }).click();
    await post.getByRole('button', { name: '推', exact: true }).focus();
    const panel = page.getByRole('region', { name: '推的人', exact: true });
    if (mode === 'empty') await panel.getByText('还没有人推过', { exact: true }).waitFor();
    if (mode === 'unknown') await panel.getByText('暂无可读取的推数据', { exact: true }).waitFor();
    if (mode === 'error') {
      await panel.getByText('合成推用户1', { exact: true }).waitFor();
    }
    if (mode === 'readonly') {
      await page.keyboard.press('Escape');
      const push = page
        .getByRole('region', { name: '空友动态' })
        .getByRole('button', { name: '推', exact: true });
      await push.click();
      await panel.getByText('匿名空友预览', { exact: true }).waitFor();
      assert.equal(await push.textContent(), '推 199');
      assert.equal(await push.getAttribute('aria-pressed'), null);
    }
    scenes++;
    await page.close();
  }
  for (const width of [320, 1280])
    for (const mode of ['tag', 'manage']) {
      const page = await visit(width, 'dark', mode);
      const post = page.getByRole('article', { name: '普通说说' });
      if (mode === 'tag')
        await post.getByRole('button', { name: '空友爱看', exact: true }).waitFor();
      else {
        await post.getByRole('button', { name: '空友爱看管理', exact: true }).hover();
        const operations = page.getByRole('region', { name: '空友爱看管理操作', exact: true });
        await operations.getByRole('button', { name: '投稿至空友爱看' }).waitFor();
        const rect = await operations.boundingBox();
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width + 1);
      }
      if (output) await page.screenshot({ path: resolve(output, `${mode}-dark-${width}.png`) });
      await page.close();
      scenes++;
    }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scenes,
      layout: true,
      navigation: true,
      publicWrites: true,
      unknownAndRetry: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

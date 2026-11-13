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
  cacheDir: resolve(root, 'node_modules/.cache/search-more-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/search-more.stub.ts'),
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
  const output = process.env.WEQ_SEARCH_MORE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  for (const width of [390, 1280]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.continue();
      if (url.hostname.endsWith('qlogo.cn'))
        return route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WsAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      return route.abort();
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/search-more.html`,
    );
    await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#237344' : '#f0cb63',
        );
      }, theme);
      await page.getByRole('button', { name: '更多', exact: true }).first().click();
      await page.locator('.weq-search-more-body [role="option"]').first().waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.locator('input').count(), 1);
      assert.equal(
        (await page.locator('.weq-titlebar-search-results').textContent()).includes('已缓存内容'),
        false,
      );
      const geometry = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '.weq-search-more-results, .weq-search-more-head, .weq-search-more-back, .weq-search-more-title, .weq-search-row',
          ),
        ];
        return nodes
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.width <= 0 ||
              box.left < 0 ||
              box.right > innerWidth ||
              node.scrollWidth > node.clientWidth + 1
            );
          })
          .map((node) => node.className);
      });
      assert.deepEqual(geometry, [], JSON.stringify({ width, theme, geometry }));
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await page.getByRole('searchbox').fill('更新');
      await page
        .locator('.weq-search-more-body [role="option"]')
        .filter({ hasText: '更新' })
        .first()
        .waitFor();
      await page.locator('.weq-search-more-body').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.weq-search-more-body [role="option"]').length === 60,
      );
      await page.getByRole('button', { name: '全局搜索', exact: true }).click();
      await page.getByRole('button', { name: '全局搜索', exact: true }).click();
      assert.equal(await page.locator('.weq-search-more-body [role="option"]').count(), 60);
      await page.getByRole('button', { name: '返回搜索总览' }).click();
      assert.equal(await page.locator('.weq-search-more-body').count(), 0);
      await page.locator('[data-search-category="chatRecord"]').first().click();
      await page.locator('.weq-chatrecords-msg').first().waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.locator('.weq-chatrecords-convs').count(), 0);
      assert.equal(await page.locator('input').count(), 1);
      const detailOverflow = await page
        .locator('.weq-search-detail')
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      assert.equal(detailOverflow, false, `${width}-${theme} detail overflow`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-records.png`) });
      await page.getByRole('button', { name: '跳转日期', exact: true }).click();
      await page.getByRole('heading', { name: '聊天日历' }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page
        .locator('.weq-message-calendar')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await page.getByRole('button', { name: '返回搜索结果' }).click();
      const bulletin = page
        .locator('[data-search-category="chatRecord"]')
        .filter({ hasText: '条群公告' });
      assert.equal(await bulletin.count(), 1);
      assert.equal(
        (await page.locator('.weq-titlebar-search-results').textContent()).includes('已缓存内容'),
        false,
      );
      await bulletin.click();
      assert.equal(await page.locator('.weq-titlebar-search-results').count(), 0);
      assert.equal(await page.evaluate(() => document.body.dataset.openedGroup), 'group-2');
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: '全局搜索', exact: true }).click();
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    '搜索更多浏览器回归通过：390/1280px、深浅色、自定义主题色、换词、分页、收起恢复与返回。',
  );
} finally {
  await browser?.close();
  await server.close();
}

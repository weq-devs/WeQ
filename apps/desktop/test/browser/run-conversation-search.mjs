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
  cacheDir: resolve(root, 'node_modules/.cache/conversation-search-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const output = process.env.WEQ_SEARCH_VIEWS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  for (const width of [390, 1280]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-search.html`,
    );
    await page.getByRole('group', { name: '搜索来源', exact: true }).waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#237344' : '#f0cb63',
        );
      }, theme);
      await page.getByRole('button', { name: '全部来源', exact: true }).click();
      await page.getByRole('button', { name: '功能与设置', exact: true }).click();
      assert.equal(await page.getByRole('group', { name: '搜索类型', exact: true }).count(), 0);
      assert((await page.locator('.weq-app-search').count()) > 0);
      await page.getByRole('button', { name: 'QQ', exact: true }).click();
      await page.getByRole('button', { name: '全部类型', exact: true }).click();
      await page.getByRole('button', { name: '文件', exact: true }).click();
      assert((await page.locator('.weq-app-search').count()) > 0);
      assert.deepEqual(await page.locator('.weq-search-section-name').allTextContents(), [
        '功能与设置',
        '文件',
      ]);
      await page.getByRole('button', { name: '全部类型', exact: true }).click();
      await page.getByRole('button', { name: '全部来源', exact: true }).click();
      const geometry = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            '.weq-search-scope button, .weq-search-filter-label, .weq-search-row',
          ),
        ];
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          invalid: nodes
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return (
                box.width <= 0 ||
                box.left < -1 ||
                box.right > window.innerWidth + 1 ||
                node.scrollWidth > node.clientWidth + 1
              );
            })
            .map((node) => node.textContent),
        };
      });
      assert.equal(geometry.overflow, false, JSON.stringify({ width, theme, geometry }));
      assert.deepEqual(geometry.invalid, [], JSON.stringify({ width, theme, geometry }));
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      for (const source of ['QQ', '克隆', '功能与设置'])
        await page.getByRole('button', { name: source, exact: true }).click();
      assert.deepEqual(await page.locator('.weq-search-section-name').allTextContents(), [
        '聊天记录',
      ]);
      assert.equal(await page.locator('[data-search-category="assistantMessage"]').count(), 1);
      assert(
        (await page.locator('[data-search-category="assistantMessage"]').textContent()).includes(
          '标题命中',
        ),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-assistant.png`) });
      await page.getByRole('button', { name: '全部来源', exact: true }).click();
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('会话搜索浏览器回归通过：390/1280px、深浅色、来源/类型交互与布局。');
} finally {
  await browser?.close();
  await server.close();
}

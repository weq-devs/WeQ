import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'page-cache-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/page-cache.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'page-cache.stub.ts') },
      {
        find: /^.*\/(?:QqAvatar|ProfileAvatar)$/,
        replacement: resolve(here, 'page-cache.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
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
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const results = [];
  for (const [width, theme] of [
    [1280, 'light'],
    [390, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/page-cache.html`,
    );
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty(
        '--weq-accent-effective',
        theme === 'dark' ? '#d18bca' : '#267758',
      );
    }, theme);
    await page.getByText('首批收藏正文', { exact: true }).waitFor();
    await page.evaluate(() => window.pageCacheQa.finish());
    await page.getByRole('button', { name: '隐藏收藏', exact: true }).click();
    await page.evaluate(() => {
      window.pageCacheQa.holdHead = true;
    });
    await page.getByRole('button', { name: '返回收藏', exact: true }).click();
    await page.getByText('首批收藏正文', { exact: true }).waitFor();
    await page.getByRole('button', { name: '打开工具', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '正在加载' }).waitFor();
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      cachedContent: document.body.innerText.includes('首批收藏正文'),
      deferredPanel: document.body.innerText.includes('正在加载…'),
    }));
    if (process.env.WEQ_PAGE_CACHE_ARTIFACTS) {
      await mkdir(process.env.WEQ_PAGE_CACHE_ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: resolve(process.env.WEQ_PAGE_CACHE_ARTIFACTS, `${width}-${theme}.png`),
      });
    }
    await page.getByText('工具已就绪', { exact: true }).waitFor();
    results.push({ width, theme, ...state });
  }
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (
    errors.length ||
    results.some((row) => row.overflow || !row.cachedContent || !row.deferredPanel)
  )
    throw new Error('页面回访浏览器回归失败');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

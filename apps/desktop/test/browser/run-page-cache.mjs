import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'page-cache-'));
const snapshots = new Map();
if (process.env.WEQ_PAGE_CACHE_INDEX_SNAPSHOT === '1') {
  const workspace = resolve(root, '../..');
  const git = (args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
  for (const file of git(['diff', 'HEAD', '--name-only']).trim().split('\n')) {
    try {
      snapshots.set(resolve(workspace, file), git(['show', `:${file}`]));
    } catch {
      /* 未暂存的新文件不属于本快照。 */
    }
  }
}
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: {
    entries: ['test/browser/page-cache.html', 'test/browser/first-conversation.html'],
  },
  plugins: [
    react(),
    tailwind(),
    {
      name: 'page-cache-index-snapshot',
      enforce: 'pre',
      load(id) {
        return snapshots.get(id.split('?')[0]) ?? null;
      },
    },
  ],
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
  await page.addInitScript(() => {
    window.pageCacheWindowErrors = [];
    window.addEventListener('error', (event) => window.pageCacheWindowErrors.push(event.message));
    window.addEventListener('unhandledrejection', (event) =>
      window.pageCacheWindowErrors.push(String(event.reason)),
    );
  });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('[page-cache]', error.message);
  });
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
      windowErrors: window.pageCacheWindowErrors,
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
  const firstEntries = [];
  for (const [width, theme] of [
    [1280, 'light'],
    [390, 'dark'],
  ]) {
    for (const warm of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/first-conversation.html?no-follow${warm ? '&warm' : ''}`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      if (warm) await page.waitForFunction(() => window.firstConversationQa.prefetched);
      await page.getByRole('button', { name: '打开尚未打开的会话', exact: true }).click();
      await page.getByText('本地首屏已经可读', { exact: true }).waitFor();
      const initial = await page.evaluate(() => ({ ...window.firstConversationQa }));
      await page.getByText('漫游缓存已合并', { exact: true }).waitFor();
      const state = await page.evaluate(() => ({
        ...window.firstConversationQa,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        windowErrors: window.pageCacheWindowErrors,
        distance: (() => {
          const scroll = document.querySelector('.message-scroll');
          return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
        })(),
      }));
      if (process.env.WEQ_PAGE_CACHE_ARTIFACTS)
        await page.screenshot({
          path: resolve(
            process.env.WEQ_PAGE_CACHE_ARTIFACTS,
            `first-${width}-${theme}-${warm ? 'warm' : 'cold'}.png`,
          ),
        });
      firstEntries.push({ width, theme, warm, initial, ...state });
    }
  }
  console.log(JSON.stringify({ firstEntries }, null, 2));
  if (process.env.WEQ_PAGE_CACHE_ARTIFACTS)
    await writeFile(
      resolve(process.env.WEQ_PAGE_CACHE_ARTIFACTS, 'page-cache-report.json'),
      JSON.stringify({ results, firstEntries, errors }, null, 2),
    );
  if (
    firstEntries.some(
      (row) =>
        row.reads !== 1 ||
        row.overflow ||
        row.distance > 2 ||
        (!row.warm && !row.initial.firstBeforeComplete),
    )
  )
    throw new Error('首次会话首屏回归失败');
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

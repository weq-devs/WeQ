import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const imageBytes = await readFile(resolve(root, '../../resources/img/password_bag.png'));
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/group-lucky-char-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/chat-header.html'] },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  const upstream = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    upstream.push(url.href);
    return route.abort();
  });
  // Remote 只允许同源图片；离线 PNG 验证真实解码，不依赖 CDN 可用性。
  await page.route('**/_media/dress?*', (route) => {
    const url = new URL(route.request().url());
    assert.equal(
      url.searchParams.get('src'),
      'https://tianquan.gtimg.cn/groupluckyword/item/10001/pic-3.png',
    );
    return route.fulfill({
      contentType: 'image/png',
      body: imageBytes,
    });
  });
  await page.route('**/test/browser/chat-header.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'Content-Security-Policy':
          "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:;",
      },
    });
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/chat-header.html`,
  );
  await page.waitForSelector('.chat-pane');
  await page.evaluate(() => window.chatHeaderQa.kind('group'));
  const output = process.env.WEQ_HEADER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 760, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const badge = page.locator('.lucky-char-badge');
      await badge.evaluate(async (image) => {
        await image.decode();
        const rect = image.getBoundingClientRect();
        if (!image.naturalWidth || rect.width <= 0 || rect.height <= 0)
          throw new Error('幸运字符未实际显示');
        const title = image.closest('.chat-title').getBoundingClientRect();
        if (rect.left < title.left || rect.right > title.right || rect.bottom > title.bottom)
          throw new Error('幸运字符被标题裁切');
        if (!image.getAttribute('src').startsWith('/_media/dress?'))
          throw new Error('幸运字符绕过了同源缓存代理');
      });
      assert.equal(await badge.getAttribute('title'), '幸运字符 · 已点亮 3 人');
      if (output)
        await page.locator('.chat-header').screenshot({
          path: resolve(output, `lucky-char-${width}-${theme}.png`),
        });
      cases++;
    }
  }
  await page.evaluate(() => window.chatHeaderQa.kind('direct'));
  await page.locator('.lucky-char-badge').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  assert.equal(
    upstream.some((url) => url.includes('/groupluckyword/')),
    false,
  );
  console.log(JSON.stringify({ cases, errors, directBadge: false }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

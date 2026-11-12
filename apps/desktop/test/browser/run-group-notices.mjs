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
  root,
  configFile: false,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // 用固定合成头像隔离网络；仍验证真实头像 URL、加载状态和像素尺寸。
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === 'thirdqq.qlogo.cn' ||
      url.pathname === '/_avatar/fetch' ||
      url.pathname === '/_media/avatar'
    )
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  const output = process.env.WEQ_GROUP_NOTICES_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-notices.html`,
      );
      await page.locator('.group-bulletin-publisher-name').waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#157347' : '#f6d46b',
        );
      }, theme);
      assert.equal(
        await page.locator('.group-bulletin-publisher-name').textContent(),
        '合成发布者',
      );
      assert.equal(
        await page.locator('.group-bulletin-content p').textContent(),
        '版本更新说明\n请先完成数据库体检和修复。\n感谢\u00a0@合成成员\u00a0的贡献！\n<b>此处仍是纯文本</b>',
      );
      assert.equal(await page.locator('.group-bulletin-content b').count(), 0);
      const image = page.locator('.avatar img');
      await image.evaluate((img) => img.decode());
      assert.ok(await image.evaluate((img) => img.naturalWidth > 0 && img.clientWidth > 0));
      assert.ok(decodeURIComponent(await image.getAttribute('src')).includes('nk=10002'));
      assert.equal(
        await page
          .locator('.group-bulletin-content p')
          .evaluate((node) => getComputedStyle(node).whiteSpace),
        'pre-wrap',
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('button', { name: '查看 合成发布者 的名片' }).click();
      assert.equal(await page.locator('body').getAttribute('data-opened-profile'), '10002');
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  assert.deepEqual(errors, []);
  console.log(
    '群公告浏览器回归通过：桌面/窄屏、浅色/深色、头像加载、昵称、换行、纯文本及名片点击。',
  );
} finally {
  await browser?.close();
  await server.close();
}

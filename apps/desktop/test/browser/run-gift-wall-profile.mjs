import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_GIFT_WALL_QA;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-gift-wall-profile'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-display.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/profile-display.stub.ts'),
      },
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
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/gift-wall-profile.html`,
  );
  const name = page.getByRole('button', { name: '查看 合成联系人 的名片', exact: true });
  for (const width of [1180, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#72d69c' : '#14703f',
        );
      }, theme);
      for (const direction of ['收到的礼物', '送出的礼物']) {
        await page.getByRole('radio', { name: direction, exact: true }).click();
        await name.waitFor();
        await name.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          document.getSelection().removeAllRanges();
          document.getSelection().addRange(range);
          node.click();
        });
        assert.equal(await page.locator('.weq-member-pop').count(), 0, '选中昵称文字不打开名片');
        await page.evaluate(() => document.getSelection().removeAllRanges());
        await page.locator('.weq-gift-wall-time').click();
        assert.equal(await page.locator('.weq-member-pop').count(), 0, '点击时间不打开名片');
        await name.click();
        const card = page.locator('.weq-member-pop');
        await card.waitFor();
        assert.ok((await card.textContent()).includes('10002'), '打开的是对应好友名片');
        await card.getByRole('button', { name: '关闭', exact: true }).click();
        await card.waitFor({ state: 'detached' });
        await name.focus();
        await page.keyboard.press('Enter');
        await card.waitFor();
        await card.getByRole('button', { name: '关闭', exact: true }).click();
        await card.waitFor({ state: 'detached' });
        await name.focus();
        await page.keyboard.press('Space');
        await card.waitFor();
        await card.getByRole('button', { name: '关闭', exact: true }).click();
        await card.waitFor({ state: 'detached' });
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}.png`),
          animations: 'disabled',
        });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    '礼物墙名片：3 种宽度 × 2 种主题 × 收发方向，鼠标、Enter、空格、选区与时间点击均通过。',
  );
} finally {
  await browser?.close();
  await server.close();
}

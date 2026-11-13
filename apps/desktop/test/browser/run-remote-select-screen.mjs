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
  cacheDir: resolve(root, 'node_modules/.cache/remote-select-screen-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qq-data-access-trpc.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const output =
  process.env.WEQ_REMOTE_SELECT_ARTIFACTS ?? resolve(root, 'node_modules/.cache/remote-select');
await mkdir(output, { recursive: true });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    userAgent: 'WeQRemote/fixture',
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-select-screen.html`,
  );
  const empty = page.locator('.weq-account-empty');
  await empty.waitFor();
  // Remote 不给死按钮：按钮保留但必须有原因，且不能真的可点。
  const pick = empty.getByRole('button', { name: '选择 QQ 数据目录' });
  assert.equal(await pick.isDisabled(), true, 'Remote 下电脑目录按钮必须禁用');
  assert.equal(await pick.getAttribute('title'), '电脑数据目录只能在电脑端选择');
  const text = (await empty.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
  assert(text.includes('电脑端还没有可用账号'), `标题要说明是电脑侧账号：${text}`);
  assert(text.includes('数据目录只能在电脑上选择'), `缺原因说明：${text}`);
  assert(text.includes('请先在电脑端选好目录并完成登录'), `缺下一步说明：${text}`);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
    { width: 844, height: 390 },
    { width: 1180, height: 820 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        const store = window.remoteSelectQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
      }, theme);
      await page.waitForTimeout(80);
      // 短高度下这块内容会溢出自身盒子（页面居中 + 不可滚动），只要求
      // 说明文字与按钮实际落在视口内、没有横向溢出。
      const fits = await empty.evaluate((node) => {
        const button = node.querySelector('button:last-of-type')?.getBoundingClientRect();
        const paragraphs = [...node.querySelectorAll('p')].map((p) => p.getBoundingClientRect());
        const inside = (rect) => rect.top >= 0 && rect.bottom <= innerHeight + 1;
        return (
          Boolean(button) &&
          inside(button) &&
          paragraphs.every(inside) &&
          document.documentElement.scrollWidth <= innerWidth + 1
        );
      });
      assert(fits, `${viewport.width}×${viewport.height}/${theme} 说明文字溢出或不可见`);
      await page.screenshot({
        path: resolve(output, `remote-select-${viewport.width}-${theme}.png`),
      });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: 8, output }));
} finally {
  await browser?.close();
  await server.close();
}

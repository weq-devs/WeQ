import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_ALIGNMENT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-icon-text-alignment'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/icon-text-alignment.html`,
  );
  await page.waitForFunction(() => window.alignmentQa);
  if (output) await mkdir(output, { recursive: true });
  const checks = () =>
    page.evaluate(() => {
      const failures = [];
      for (const [head, children] of [
        ['.weq-dialog-head', ['.weq-dialog-icon', '.weq-dialog-title', '.weq-dialog-x']],
        ['.weq-toast-header', ['.weq-toast-icon', '.weq-toast-title', '.weq-toast-actions']],
      ]) {
        const header = document.querySelector(head);
        const boxes = children.map((selector) =>
          header.querySelector(selector).getBoundingClientRect(),
        );
        const centers = boxes.map((box) => box.y + box.height / 2);
        if (Math.max(...centers) - Math.min(...centers) > 1) failures.push(`${head}: 未居中`);
        const bounds = header.getBoundingClientRect();
        if (boxes.some((box) => box.left < bounds.left - 1 || box.right > bounds.right + 1))
          failures.push(`${head}: 内容越界`);
        const icon = header.querySelector(`${children[0]} svg`).getBoundingClientRect();
        if (icon.width !== 20 || icon.height !== 20) failures.push(`${head}: 图标被压缩`);
      }
      for (const modal of document.querySelectorAll('.weq-modal')) {
        const box = modal.getBoundingClientRect();
        if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight)
          failures.push('弹窗越界');
        if (modal.scrollWidth > modal.clientWidth) failures.push('弹窗横向溢出');
      }
      const empty = document.querySelector('.weq-set-empty:has(> svg)');
      const icon = empty.querySelector('svg').getBoundingClientRect();
      const text = empty.querySelector('span').getBoundingClientRect();
      if (Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2) > 1)
        failures.push('MCP 空状态图文未居中');
      if (icon.width !== 15 || icon.right >= text.left) failures.push('MCP 空状态图标被压缩或重叠');
      if (empty.scrollWidth > empty.clientWidth) failures.push('MCP 空状态横向溢出');
      return failures;
    });
  const show = async (kind, title) => {
    await page.evaluate(({ kind, title }) => window.alignmentQa.show(kind, title), { kind, title });
    await page.waitForSelector('.weq-toast.show');
    await page.waitForSelector('.weq-dialog-title');
  };
  await show('info', '更新好友/群信息缓存');
  const oldLayout = await page.addStyleTag({
    content:
      '.weq-message-modal .weq-dialog-head{align-items:start}.weq-toast .weq-toast-header{align-items:flex-start}',
  });
  assert.equal((await checks()).filter((value) => value.includes('未居中')).length, 2);
  await oldLayout.evaluate((node) => node.remove());
  assert.deepEqual(await checks(), [], '公共标题行应垂直居中');
  let cases = 0;
  const failures = [];
  for (const width of [1180, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        await page.evaluate(
          ({ theme, style }) => {
            const store = window.alignmentQa.theme.getState();
            store.setPreference(theme);
            store.setComponentStyle(style);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'plain' : 'grid');
          },
          { theme, style },
        );
        for (const kind of ['info', 'warning', 'error', 'password']) {
          for (const title of [
            '更新好友/群信息缓存',
            '长标题换行与关闭按钮对齐验证'.repeat(4),
            'UnbrokenTitle'.repeat(18),
          ]) {
            await show(kind, title);
            for (const failure of await checks())
              failures.push(`${width}/${theme}/${style}/${kind}/${title.slice(0, 12)}: ${failure}`);
            cases++;
          }
        }
        if (output && style === 'qqnt') {
          await show('info', '更新好友/群信息缓存');
          await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
        }
      }
    }
  }
  console.log(JSON.stringify({ cases, failures, errors }, null, 2));
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}

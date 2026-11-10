import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'message-overflow-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_OVERFLOW_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const count of [30, 3000]) {
    for (const [width, theme, accent, background] of [
      [1280, 'light', '#107a54', 'plain'],
      [900, 'dark', '#f0bd52', 'grid'],
      [390, 'light', '#b83057', 'paper'],
      [390, 'dark', '#75cabb', 'dots'],
    ]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?count=${count}`,
      );
      await page.waitForSelector('.message-line.mine');
      await page.evaluate(
        ({ theme, accent, background }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = background;
          document.documentElement.style.setProperty('--weq-accent-effective', accent);
          // 复用真实挂件尺寸，重现装饰伸出消息行右边缘的情况。
          const avatar = document.querySelector('.message-line.mine .is-self');
          const pendant = document.createElement('span');
          pendant.className = 'weq-avatar-pendant';
          const decoration = document.createElement('span');
          decoration.className = 'weq-avatar-pendant-img';
          pendant.append(decoration);
          avatar.append(pendant);
          const content = document.querySelector('.message-line:not(.mine) .message-content');
          content.textContent = `https://example.invalid/${'long-filename-without-spaces'.repeat(30)}`;
          const code = document.createElement('pre');
          code.className = 'message-code-pre';
          code.textContent = 'const longLine = "test"; '.repeat(100);
          content.append(code);
          code.id = 'overflow-code';
        },
        { theme, accent, background },
      );
      await page.waitForTimeout(150);
      const label = `${count}/${theme}/${width}`;
      const scroll = page.locator('.message-scroll');
      await scroll.hover();
      await page.mouse.wheel(250, 0);
      await page.waitForTimeout(100);
      assert.equal(await scroll.evaluate((element) => element.scrollLeft), 0, label);
      assert.equal(
        await scroll.evaluate((element) => getComputedStyle(element).overflowX),
        'hidden',
        `${label}: 消息区仍允许横向滚动`,
      );
      const code = page.locator('#overflow-code');
      assert(
        await code.evaluate((element) => {
          element.scrollLeft = 100;
          return element.scrollLeft > 0 && element.scrollWidth > element.clientWidth;
        }),
        `${label}: 代码块内部不能横向滚动`,
      );
      assert(
        await code.evaluate((element) => {
          const viewport = element.closest('.message-scroll').getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return rect.left >= viewport.left && rect.right <= viewport.right;
        }),
        `${label}: 长内容撑出消息区`,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${count}-${theme}-${width}.png`) });
      const top = await scroll.evaluate((element) => element.scrollTop);
      await scroll.hover();
      await page.mouse.wheel(0, 250);
      await page.waitForFunction(
        (top) => document.querySelector('.message-scroll').scrollTop > top,
        top,
      );
    }
  }
  assert.deepEqual(errors, [], '浏览器出现运行错误');
  console.log(
    '消息区滚动回归通过：8 组普通/虚拟列表、深浅主题和窗口组合；横向手势不偏移，纵向及代码块滚动正常。',
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

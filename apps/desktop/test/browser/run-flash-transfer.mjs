import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  root,
  cacheDir: resolve(root, 'node_modules/.vite-flash-transfer'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/flash-transfer.stub.ts'),
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
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/_asset/fileicon/'))
      return route.fulfill({
        path: resolve(root, '../../resources/fileicon', url.pathname.split('/').at(-1)),
      });
    return url.hostname === '127.0.0.1' || url.protocol === 'data:'
      ? route.continue()
      : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/flash-transfer.html`,
  );
  await page.locator('.weq-ft-card').first().waitFor();
  await page.getByRole('checkbox', { name: '全选', exact: true }).check();
  if (process.env.WEQ_STYLE_ARTIFACTS)
    await mkdir(process.env.WEQ_STYLE_ARTIFACTS, { recursive: true });
  for (const [theme, width, background, accent] of [
    ['light', 1280, 'plain', '#075c30'],
    ['dark', 1280, 'grid', '#fff3a1'],
    ['light', 390, 'paper', '#ffffff'],
    ['system', 390, 'dots', '#000000'],
    ['light', 1280, 'wash', '#8b5cf6'],
    ['dark', 390, 'telegram', '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(
      ([theme, accent, background]) => window.flashFixture(theme, accent, background),
      [theme, accent, background],
    );
    const issues = await page.evaluate(() => {
      const failures = [];
      const box = document.querySelector('.weq-ft').getBoundingClientRect();
      if (box.left < 0 || box.right > innerWidth || box.bottom > innerHeight)
        failures.push('窗口溢出');
      for (const node of document.querySelectorAll('.weq-ft-card, .weq-ft-foot, .weq-ft-head')) {
        if (node.scrollWidth > node.clientWidth) failures.push('内容溢出');
      }
      if (
        [...document.querySelectorAll('.weq-ft-card-icon')].some(
          (img) => !img.complete || img.naturalWidth === 0,
        )
      )
        failures.push('文件图标未渲染');
      if (document.querySelectorAll('.weq-ft-card-checked').length !== 5)
        failures.push('选择状态错误');
      const button = document.querySelector('.weq-ft-btn-primary').getBoundingClientRect();
      if (button.width < 88 || button.height < 34) failures.push('下载按钮尺寸错误');
      return failures;
    });
    if (issues.length) throw new Error(`${theme}/${width}: ${issues.join(', ')}`);
    if (process.env.WEQ_STYLE_ARTIFACTS)
      await page.screenshot({
        path: resolve(process.env.WEQ_STYLE_ARTIFACTS, `flash-${theme}-${width}-${background}.png`),
      });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('闪传浏览器验证通过：6 组主题、背景与窗口组合；文件图标、选择状态与内容边界正常。');
} finally {
  await browser?.close();
  await server.close();
}

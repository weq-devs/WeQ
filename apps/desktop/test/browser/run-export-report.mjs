import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/export-report-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: cache,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_REPORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, theme, accent, background] of [
    [1280, 'light', '#14652d', 'plain'],
    [1280, 'dark', '#ffe8a6', 'grid'],
    [390, 'light', '#d73758', 'paper'],
    [390, 'dark', '#72c9bf', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/export-report.html`,
    );
    await page.evaluate(
      ({ theme, accent, background }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, accent, background },
    );
    await page.getByRole('button', { name: '批量导出', exact: true }).click();
    const control = page.getByRole('switch', { name: '附带完整性报告' });
    if ((await control.getAttribute('aria-checked')) !== 'false') throw new Error('报告默认值错误');
    await control.click();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true',
    );
    await page.waitForTimeout(200);
    const fitting = await control.evaluate((node) => {
      const row = node.closest('.weq-set-row');
      const label = row.querySelector('.weq-set-row-label').getBoundingClientRect();
      const toggle = node.getBoundingClientRect();
      return label.right <= toggle.left && toggle.right <= innerWidth && label.left >= 0;
    });
    if (!fitting) throw new Error(`控件重叠或越界：${theme}/${width}`);
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
    await page.getByRole('button', { name: '开始导出', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output').textContent === 'true');
    await page.getByRole('button', { name: '批量导出', exact: true }).click();
    if ((await control.getAttribute('aria-checked')) !== 'false') throw new Error('新批次未复位');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output').textContent === 'null');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('4 种主题、宽度、主题色和背景组合通过：开关、确认、取消、默认复位、布局。');
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}

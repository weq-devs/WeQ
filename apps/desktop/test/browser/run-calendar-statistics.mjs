import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = resolve(root, '.artifacts/calendar-statistics');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-calendar-statistics'),
  optimizeDeps: {
    entries: [resolve(root, 'test/browser/calendar-statistics.html')],
    include: ['react', 'react-dom/client'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/calendar-statistics.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/calendar-statistics.html`,
  );
  await page.getByRole('group', { name: '统计内容', exact: true }).waitFor();
  if (
    (await page
      .getByRole('progressbar', { name: '2026-11-11 进度', exact: true })
      .getAttribute('value')) !== '0'
  )
    throw new Error('当日进度未跟随实际扫描日');
  if ((await page.getByLabel('列表日期', { exact: true }).inputValue()) !== '2026-11-08')
    throw new Error('列表日期被扫描日覆盖');
  await mkdir(output, { recursive: true });
  for (const width of [1100, 390, 320])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((dark) => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          dark ? '#80c6a9' : '#96315f',
        );
      }, dark);
      await page.getByRole('button', { name: '任务日志', exact: true }).click();
      await page
        .getByRole('group', { name: '统计内容', exact: true })
        .getByRole('button', { name: '公众号/服务号', exact: true })
        .click();
      const option = page.getByRole('button', { name: '公众号/服务号', exact: true });
      if ((await option.getAttribute('aria-pressed')) !== 'false')
        throw new Error('组合来源不能取消');
      await option.click();
      await page.locator('.weq-overview-calendar-row').first().click();
      if ((await page.locator('body').getAttribute('data-located')) !== 'true')
        throw new Error('定位未触发');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          [...document.querySelectorAll('button,input,progress')].some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > innerWidth + 1 || rect.left < -1;
          }),
      );
      if (overflow) throw new Error(`布局溢出 ${width}/${dark}`);
      await page.screenshot({
        path: resolve(output, `${width}-${dark ? 'dark' : 'light'}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: '任务日志', exact: true }).click();
    }
  const mine = page.getByRole('button', { name: '我的设备', exact: true });
  await mine.click();
  await page.reload();
  if ((await mine.getAttribute('aria-pressed')) !== 'false') throw new Error('选择未记忆');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      cases: 6,
      overflow: false,
      selectionRemembered: true,
      navigation: true,
      output,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

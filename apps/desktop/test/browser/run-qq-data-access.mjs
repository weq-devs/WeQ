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
  root,
  cacheDir: resolve(root, 'node_modules/.vite-qq-data-access'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qq-data-access-trpc.stub.ts'),
      },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.electron = { process: { platform: 'darwin' } };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-data-access.html`,
  );
  await page.getByRole('heading', { name: 'QQ 数据读取受限' }).waitFor();
  const output = process.env.WEQ_ACCESS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 760 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({
        colorScheme: theme === 'light' ? 'light' : 'dark',
        reducedMotion: 'reduce',
      });
      for (const accent of ['#075c30', '#fff3a1']) {
        for (const background of ['plain', 'telegram']) {
          await page.evaluate(
            ({ theme, accent, background }) => {
              const store = window.accessQa.store.getState();
              store.setPreference(theme);
              store.setAccent(accent);
              store.setBackground(background);
            },
            { theme, accent, background },
          );
          const overflow = await page.evaluate(() => {
            const panel = document.querySelector('.weq-qq-data-access');
            return (
              panel.scrollWidth > panel.clientWidth + 1 ||
              document.documentElement.scrollWidth > innerWidth
            );
          });
          if (overflow) throw new Error(`布局溢出: ${width} ${theme} ${accent} ${background}`);
          if (output && accent === '#075c30' && background === 'plain')
            await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
          cases++;
        }
      }
    }
  }
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.getByText('当前进程仍无法读取。', { exact: false }).waitFor();
  await page.getByRole('button', { name: '打开系统设置', exact: true }).click();
  await page.getByText('合成的系统设置打开失败', { exact: false }).waitFor();
  if (!(await page.getByRole('button', { name: '扫码登录其他账号', exact: true }).isDisabled()))
    throw new Error('读取受限时不能继续扫码取密钥');
  await page.getByRole('button', { name: '返回账号主页', exact: true }).click();
  await page.getByRole('button', { name: '导入备份', exact: true }).click();
  await page.locator('.weq-static-backup').waitFor();
  if (await page.locator('.weq-qq-data-access').count())
    throw new Error('备份入口不应被本机授权提示阻断');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `通过 ${cases} 组授权提示布局、主题、主题色和背景检查；重试、错误反馈、本机登录拦截和备份入口通过。`,
  );
} finally {
  await browser?.close();
  await server.close();
}

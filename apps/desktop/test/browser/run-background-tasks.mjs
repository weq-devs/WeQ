import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-background-tasks'),
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/background-tasks.html`,
  );
  await page.locator('.weq-long-task').first().waitFor();
  if ((await page.locator('.weq-long-task').count()) !== 8) throw new Error('未显示八类任务');
  if (output) await mkdir(output, { recursive: true });
  for (const [dark, width, accent, background] of [
    [false, 1100, '#075c30', 'plain'],
    [true, 1100, '#fff3a1', 'paper'],
    [false, 360, '#a82e68', 'grid'],
    [true, 360, '#73cab8', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ([dark, accent, background]) => window.backgroundTheme(dark, accent, background),
      [dark, accent, background],
    );
    await page.getByRole('button', { name: /收藏表情导入/ }).click();
    await page
      .getByText('第 2 项：读回失败，保留未确认状态，不自动重传', { exact: true })
      .waitFor();
    const overflow = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'button,.weq-current-task-details,.weq-background-task-results',
        ),
      ].some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < 0 ||
          rect.right > innerWidth + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      }),
    );
    if (overflow) throw new Error(`任务控件溢出: ${dark}/${width}`);
    if (output)
      await page.screenshot({
        path: resolve(output, `background-tasks-${dark ? 'dark' : 'light'}-${width}.png`),
      });
  }
  await page.getByRole('button', { name: /合成目标群逐条转发/ }).click();
  await page.getByRole('button', { name: '停止向此会话发送', exact: true }).click();
  await page.getByText('已停止后续转发', { exact: true }).last().waitFor();
  if (await page.getByRole('button', { name: '停止向此会话发送', exact: true }).count())
    throw new Error('停止后仍显示停止按钮');
  await page.getByRole('button', { name: '移除任务', exact: true }).click();
  if ((await page.locator('.weq-long-task').count()) !== 7) throw new Error('移除记录未生效');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('八类后台任务：4 组深浅主题、主题色、背景与桌面/窄屏布局，停止及移除操作通过');
} finally {
  await browser?.close();
  await server.close();
}

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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/text-markdown.html`,
  );
  await page.locator('#message [data-streamdown="strong"]').waitFor();
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#176c47', 'plain'],
    ['dark', 1280, '#f3e7a1', 'grid'],
    ['light', 390, '#ffffff', 'paper'],
    ['system', 390, '#000000', 'dots'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(
      ([theme, accent, background]) => window.markdownFixture(theme, accent, background),
      [theme, accent, background],
    );
    await page.locator('#message').click({ button: 'right' });
    await page.getByRole('button', { name: '显示原文', exact: true }).waitFor();
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-markdown.png`) });
    await page.getByRole('button', { name: '显示原文', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#message .qq-md'));
    if (!(await page.locator('#message').innerText()).includes('**粗体内容**'))
      throw new Error('原文缺失');
    if (await page.getByRole('menu').count()) throw new Error('切换后菜单未关闭');
    await page.locator('#message').click({ button: 'right' });
    const button = page.getByRole('button', { name: '显示 Markdown', exact: true });
    await button.waitFor();
    const issues = await page.getByRole('menu').evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      return (
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > innerWidth ||
        rect.bottom > innerHeight ||
        menu.scrollWidth > menu.clientWidth
      );
    });
    if (issues) throw new Error(`${theme}/${width}: 菜单溢出`);
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-raw.png`) });
    await button.click();
    await page.locator('#message [data-streamdown="strong"]').waitFor();
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Markdown 切换浏览器验证通过：4 组主题、背景与窗口组合，双向切换、关闭菜单及内容边界正常。',
  );
} finally {
  await browser?.close();
  await server.close();
}

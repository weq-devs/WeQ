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
  cacheDir: resolve(root, 'node_modules/.vite-task-quick-actions'),
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/background-tasks.html?compact`,
  );
  await page.locator('.weq-task-quick-actions').first().waitFor();
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
    const invalid = await page.evaluate(() =>
      [...document.querySelectorAll('.weq-task-quick-actions button')].some((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.width !== 30 ||
          rect.height !== 30 ||
          !button.title ||
          !button.getAttribute('aria-label') ||
          button.textContent.trim()
        );
      }),
    );
    if (invalid) throw new Error('快捷按钮尺寸、图标或提示不符合预期');
    const overflow = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.weq-long-task-entry,.weq-long-task, .weq-task-quick-actions',
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
    if (overflow) throw new Error(`小菜单溢出: ${dark}/${width}`);
    if (await page.locator('button button,.weq-current-task-details,.weq-long-task-detail').count())
      throw new Error('小菜单不应嵌套按钮或挂载详情');
    if (output)
      await page.screenshot({
        path: resolve(output, `task-quick-actions-${dark ? 'dark' : 'light'}-${width}.png`),
      });
  }
  const exported = page.locator('.weq-long-task-entry').filter({ hasText: '合成导出-long' });
  await exported.getByRole('button', { name: '暂停', exact: true }).click();
  await exported.getByRole('button', { name: '继续导出', exact: true }).click();
  await exported.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Enter');
  await exported.getByRole('button', { name: '删除导出缓存', exact: true }).click();
  if (await exported.count()) throw new Error('导出删除后仍在列表中');
  const forwarding = page.locator('.weq-long-task-entry').filter({ hasText: '合成目标群逐条转发' });
  await forwarding.getByRole('button', { name: '停止向此会话发送', exact: true }).click();
  await forwarding.getByText('已停止后续转发', { exact: false }).waitFor();
  await forwarding.getByRole('button', { name: '移除任务', exact: true }).click();
  if (await forwarding.count()) throw new Error('转发删除后仍在列表中');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '小菜单任务快捷操作：4 组深浅主题/主题色/宽窄屏、导出暂停/继续/取消/删除、转发停止/移除及键盘操作通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

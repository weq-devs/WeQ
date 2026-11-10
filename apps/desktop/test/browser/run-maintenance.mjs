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
  cacheDir: resolve(root, 'node_modules/.vite-maintenance'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/maintenance-trpc.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  const storage = page.locator('[data-storage]');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_MAINTENANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/maintenance.html`,
      );
      await storage.getByRole('button', { name: '开始清理', exact: true }).waitFor();
      await page.evaluate(
        ({ theme }) => {
          const store = window.maintenanceQa.store.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          store.setBackground(theme === 'light' ? 'plain' : 'grid');
        },
        { theme },
      );
      await page.getByRole('button', { name: '恢复默认设置', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('无需重启 WeQ', { exact: false }).waitFor();
      await dialog.getByRole('switch', { name: '清除 API 配置', exact: true }).check();
      await dialog.getByLabel('缓存目录', { exact: true }).selectOption('reset');
      await dialog.getByRole('switch', { name: '清除 WeQ 服务配置', exact: true }).check();
      await dialog
        .getByText('另外恢复或清除：API 配置与凭据、缓存目录、Web 服务。', { exact: true })
        .waitFor();
      if (await dialog.evaluate((element) => element.scrollWidth > element.clientWidth))
        throw new Error(`恢复弹窗横向溢出：${width}/${theme}`);
      if (output) await page.screenshot({ path: `${output}/defaults-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      for (const category of await storage.locator('details.weq-storage-category').all()) {
        if (!(await category.evaluate((element) => element.open)))
          await category.locator('summary').click();
      }
      await storage.getByLabel('头像缓存', { exact: true }).check();
      await storage.getByLabel('克隆数据', { exact: true }).check();
      await storage.getByRole('button', { name: '开始清理', exact: true }).click();
      await dialog.getByRole('button', { name: '清除', exact: true }).click();
      await dialog.getByText('剩余项目被占用', { exact: true }).waitFor();
      if (output) await page.screenshot({ path: `${output}/occupied-${theme}-${width}.png` });
      await dialog.getByRole('button', { name: '暂不重启', exact: true }).click();
      const calls = await page.evaluate(() => window.maintenanceQa.calls);
      if (calls.length !== 1 || calls[0].afterExit)
        throw new Error('首次清理或取消重启时提前安排了退出');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`页面横向溢出：${width}/${theme}`);
      await storage.getByRole('button', { name: '重启并清除剩余项目', exact: true }).click();
      await dialog.getByRole('button', { name: '重启并继续清除', exact: true }).click();
      const retry = await page.evaluate(() => window.maintenanceQa.calls.at(-1));
      if (!retry.afterExit || retry.ids.join(',') !== 'agentlab')
        throw new Error('重试范围包含已清除项目');
    }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('恢复与清理：4 组深浅色/桌面窄屏交互通过，无横向溢出。');
} finally {
  await browser?.close();
  await server.close();
}

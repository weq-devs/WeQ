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
  cacheDir: resolve(root, 'node_modules/.vite-connection-status'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/connection-status.html`,
  );
  await page.waitForFunction(() => window.connectionQa);
  const output = process.env.WEQ_CONNECTION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.connectionQa.theme.getState().setPreference(theme);
        window.connectionQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        window.connectionQa.reset();
        window.connectionQa.change('network');
      }, theme);
      await page.getByText('网络已断开，恢复后自动重连', { exact: true }).waitFor();
      await page.locator('.weq-toast.show').waitFor();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      const bounds = await page.locator('.weq-toast').boundingBox();
      if (!bounds || bounds.x < 0 || bounds.x + bounds.width > width + 1)
        throw new Error(`横幅超出屏幕：${width}/${theme}/${JSON.stringify(bounds)}`);
      if (
        await page
          .locator('.weq-toast-title')
          .evaluate((node) => node.scrollWidth > node.clientWidth + 1)
      )
        throw new Error(`横幅文字溢出：${width}/${theme}`);
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await page.evaluate(() => window.connectionQa.change('connection'));
      await page.getByText('连接已中断，正在重连…', { exact: true }).waitFor();
      await page.evaluate(() => window.connectionQa.change('connected'));
      await page.getByText('连接已恢复', { exact: true }).waitFor();
      if ((await page.locator('.weq-toast').count()) !== 1)
        throw new Error('断连和恢复横幅重复堆叠');
      cases++;
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ cases, nativeTransitions: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}

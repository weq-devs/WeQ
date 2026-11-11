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
  cacheDir: resolve(root, 'node_modules/.vite-app-update'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/app-update.html'] },
  resolve: {
    alias: [
      {
        find: /^.*\/hooks\/useAppUpdate$/,
        replacement: resolve(root, 'test/browser/app-update.stub.ts'),
      },
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
  const output = process.env.WEQ_UPDATE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/app-update.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const toggle = page.getByRole('switch', { name: '检查测试版' });
      await toggle.waitFor();
      await toggle.click();
      if ((await toggle.getAttribute('aria-checked')) !== 'true') throw new Error('toggle failed');
      await page.getByRole('button', { name: '检查更新' }).click();
      await page.getByText('已是最新版本', { exact: true }).waitFor();
      const fits = await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          [...document.querySelectorAll('button')].every((node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.right <= innerWidth && box.left >= 0;
          }),
      );
      if (!fits) throw new Error(`overflow ${width} ${theme}`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: update toggle and status; 320/390/1280 light/dark; no overflow');
} finally {
  await browser?.close();
  await server.close();
}

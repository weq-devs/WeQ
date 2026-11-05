import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-web-parity'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/web-parity.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : existsSync(chrome)
        ? { executablePath: chrome }
        : {}),
  });
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    permissions: ['notifications'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/web-parity.html`,
  );
  await page.getByRole('button', { name: '选择文件' }).waitFor();
  const chooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件' }).click();
  await (await chooserEvent).setFiles({
    name: 'fixture.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('abc'),
  });
  await page.waitForFunction(
    () => document.querySelector('[data-result]')?.textContent === 'fixture.txt',
  );
  const cancelEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择文件' }).click();
  await (await cancelEvent).element().dispatchEvent('cancel');
  await page.waitForFunction(
    () => document.querySelector('[data-result]')?.textContent === '已取消',
  );
  await page.getByRole('switch', { name: '此设备通知' }).click();
  await page.waitForFunction(() => localStorage.getItem('weq:web-notifications') === 'true');
  const output = process.env.WEQ_WEB_PARITY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.evaluate((value) => window.webParityQa.getState().setPreference(value), theme);
      for (const color of ['#16875c', '#f4e188']) {
        await page.evaluate((accent) => window.webParityQa.getState().setAccent(accent), color);
        for (const background of ['paper', 'dots']) {
          await page.evaluate(
            (value) => window.webParityQa.getState().setBackground(value),
            background,
          );
          const valid = await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              [...document.querySelectorAll('button')].every((node) => {
                const box = node.getBoundingClientRect();
                return box.width > 0 && box.left >= 0 && box.right <= innerWidth;
              }),
          );
          if (!valid) throw new Error(`布局溢出：${width}/${theme}/${color}`);
          cases++;
        }
      }
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify(
      { cases, fileSelection: true, cancellation: true, notifications: true, pageErrors: errors },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}

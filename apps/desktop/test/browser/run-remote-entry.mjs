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
  cacheDir: resolve(root, 'node_modules/.vite-remote-entry'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/remote-entry.stub.ts'),
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-entry.html`,
  );
  const web = page.getByRole('switch', { name: '允许本机浏览器访问', exact: true });
  const remote = page.getByRole('switch', { name: '允许远程连接', exact: true });
  await web.waitFor();
  await remote.click();
  if ((await web.getAttribute('aria-checked')) !== 'false')
    throw new Error('Remote 联动开启本机入口');
  await web.click();
  await web.click();
  if ((await remote.getAttribute('aria-checked')) !== 'true')
    throw new Error('关闭本机入口影响 Remote');
  await web.click();
  await remote.click();
  if ((await web.getAttribute('aria-checked')) !== 'true')
    throw new Error('关闭 Remote 影响本机入口');
  const output = process.env.WEQ_REMOTE_ENTRY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ theme }) => {
          window.remoteEntryQa.theme.getState().setPreference(theme);
          window.remoteEntryQa.theme
            .getState()
            .setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          window.remoteEntryQa.state.setState({ web: true, remote: true });
        },
        { theme },
      );
      await page.waitForTimeout(30);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`设置页横向溢出：${width}/${theme}`);
      const clipped = await page
        .locator('.weq-set-row-label')
        .evaluateAll((nodes) => nodes.some((node) => node.scrollWidth > node.clientWidth + 1));
      if (clipped) throw new Error(`设置名称被裁切：${width}/${theme}`);
      if (output)
        await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      cases++;
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ cases, independentToggles: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}

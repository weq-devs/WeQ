import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_WORKSPACE_QA;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
  const image = await readFile(resolve(root, '../../resources/img/bot.png'));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['/_media/dress', '/_media/qqshow', '/_avatar/fetch'].includes(url.pathname))
      return route.fulfill({ contentType: 'image/png', body: image });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html`,
      );
      await page.getByRole('button', { name: '打开互动画像', exact: true }).waitFor();
      await page.getByRole('button', { name: '打开完整资料页', exact: true }).click();
      await page.locator('.weq-contact-workspace-v2').waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#b53049' : '#72cdb5',
        );
        window.contactCardQa.profileEnabled = true;
        window.contactCardQa.notify();
      }, theme);
      await page.getByRole('button', { name: '打开互动画像', exact: true }).click();
      await page.locator('[data-profile-anchor="portrait"]').waitFor();
      const position = await page.locator('[data-profile-anchor="portrait"]').evaluate((node) => {
        const body = node.closest('.weq-profile-workspace-body');
        const bounds = node.getBoundingClientRect();
        const viewport = body.getBoundingClientRect();
        return {
          top: bounds.top,
          viewportTop: viewport.top,
          viewportBottom: viewport.bottom,
          scrollTop: body.scrollTop,
        };
      });
      assert.ok(position.scrollTop > 0, JSON.stringify({ width, theme, position }));
      assert.ok(
        position.top >= position.viewportTop && position.top < position.viewportBottom - 40,
        JSON.stringify({ width, theme, position }),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-portrait-anchor.png`) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: 8, errors }));
} catch (error) {
  if (output && browser?.contexts()[0]?.pages()[0])
    await browser
      .contexts()[0]
      .pages()[0]
      .screenshot({ path: resolve(output, 'portrait-failure.png') });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}

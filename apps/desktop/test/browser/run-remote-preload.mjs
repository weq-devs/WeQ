import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-preload.html`,
  );
  await page.waitForSelector('[data-mobile-sidebar-active="false"]', { state: 'attached' });
  const contacts = await page.locator('[data-mobile-sidebar-active="false"]').elementHandle();
  await page.locator('[data-mobile-tab="contacts"]').click();
  assert.equal(await contacts.evaluate((el) => el.dataset.mobileSidebarActive), 'true');
  await page.getByText('我的好友', { exact: true }).click();
  await page.getByText('合成联系人 0', { exact: true }).waitFor();
  await page.locator('[data-mobile-tab="messages"]').click();
  await page.locator('[data-mobile-tab="contacts"]').click();
  assert.equal(
    await contacts.evaluate((el) => el.isConnected && el.dataset.mobileSidebarActive === 'true'),
    true,
  );
  await page.getByText('合成联系人 0', { exact: true }).waitFor();
  // 空间进入一帧后就离开，不能挂载内容。
  assert.equal(
    await page.evaluate(async () => {
      window.remotePreloadQa.navigate('qzone');
      await new Promise(requestAnimationFrame);
      const mounted = Boolean(document.querySelector('.weq-qzn'));
      window.remotePreloadQa.navigate('more');
      return mounted;
    }),
    false,
  );
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.weq-qzn').count(), 0);
  await page.locator('[data-mobile-tab="qzone"]').click();
  await page.locator('.weq-qzn').waitFor();
  const qzone = await page.locator('.weq-qzn').elementHandle();
  await page
    .locator('.chat-main')
    .dispatchEvent('touchstart', { touches: [{ clientX: 180, clientY: 400 }] });
  await page
    .locator('.chat-main')
    .dispatchEvent('touchmove', { touches: [{ clientX: 120, clientY: 400 }], cancelable: true });
  assert.equal(await qzone.evaluate((el) => el.isConnected), true);
  await page.locator('.chat-main').dispatchEvent('touchcancel', { touches: [] });
  await page.waitForTimeout(450);
  assert.equal(await qzone.evaluate((el) => el.isConnected), true);
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.remotePreloadQa.theme.getState().setPreference(theme);
        window.remotePreloadQa.navigate('contacts');
      }, theme);
      await page.waitForTimeout(250);
      assert.equal(
        await page
          .locator('.sidebar-body')
          .evaluate((el) => el.clientWidth > 0 && el.clientHeight > 0),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `contacts-${width}-${theme}.png`) });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, retainedLists: true, qzoneSettling: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}

import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-label-sources'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/group-label-sources.html'] },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-label-sources.stub.ts'),
      },
      {
        find: /^.*\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/group-label-sources.stub.ts'),
      },
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
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('pageerror:', error.message);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-label-sources.html`;
  await page.goto(url);
  const tag = page.getByRole('button', { name: 'VOCALOID，标签来源', exact: true });
  const popup = page.getByRole('region', { name: 'VOCALOID的来源', exact: true });
  assert.equal(await page.locator('.weq-profile-data-row').count(), 0);
  assert.equal(await page.evaluate(() => window.setterReads ?? 0), 0);
  await tag.hover();
  await popup.getByText('设置者', { exact: true }).waitFor();
  const person = popup.getByRole('button', { name: '查看 在线补全昵称 的名片' });
  await person.waitFor();
  await person.locator('img').evaluate((image) => image.decode());
  await person.hover();
  await page.waitForTimeout(200);
  await person.click();
  assert.equal(await page.evaluate(() => window.openedSetter.user.id), 'u_missing');
  assert.equal(await page.evaluate(() => window.openedSetter.context.code), '12345');
  const output = process.env.WEQ_GROUP_LABEL_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#fff3a1' : '#075c30',
        );
      }, theme);
      await page.mouse.move(0, 0);
      await tag.hover();
      await popup.waitFor();
      await person.locator('img').evaluate((image) => image.decode());
      await page.waitForFunction(
        () => !document.querySelector('.weq-group-label-popover .avatar.is-loading'),
      );
      const box = await popup.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'detached' });
      const long = page.getByRole('button', {
        name: `${'长标签'.repeat(30)}，标签来源`,
        exact: true,
      });
      await long.focus();
      const longPopup = page.getByRole('region', {
        name: `${'长标签'.repeat(30)}的来源`,
        exact: true,
      });
      await longPopup.waitFor();
      assert.equal(
        await longPopup.evaluate((element) => element.scrollWidth > element.clientWidth),
        false,
      );
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('weq-group-label-setter'),
        ),
        true,
      );
      await page.keyboard.press('Escape');
    }
  await tag.focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.includes('在线补全昵称')),
    true,
  );
  await page.keyboard.press('Escape');
  const touch = await browser.newContext({
    viewport: { width: 390, height: 800 },
    hasTouch: true,
    isMobile: true,
  });
  const mobile = await touch.newPage();
  await mobile.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await mobile.goto(url);
  await mobile.getByRole('button', { name: 'VOCALOID，标签来源', exact: true }).tap();
  await mobile.getByRole('button', { name: '查看 在线补全昵称 的名片' }).tap();
  assert.equal(await mobile.evaluate(() => window.openedSetter.user.id), 'u_missing');
  await touch.close();
  assert.deepEqual(errors, []);
  console.log(
    '群标签悬停来源、设置者标识、按需在线补全、头像昵称名片入口、六组主题尺寸及键盘触屏验证通过',
  );
} finally {
  await browser?.close();
  await server.close();
}

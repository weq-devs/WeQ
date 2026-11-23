import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/app-navigation-vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
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
  browser = await engines[process.env.WEQ_BROWSER_ENGINE ?? 'chromium'].launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_NAVIGATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/app-navigation.html`;
  let cases = 0;
  for (const [width, height] of [
    [320, 844],
    [390, 844],
    [844, 390],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(url);
    const single = width <= 760;
    const nav = page.locator(single ? '.weq-mobile-tabs' : '.app-rail');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.navigationQa.theme(theme);
        window.navigationQa.accent(theme === 'light' ? '#15764a' : '#ebbd51');
      }, theme);
      const entry = page
        .locator('.app-shell > .sidebar .weq-contact-notice-entry')
        .filter({ hasText: '好友通知' });
      assert.equal(await entry.innerText(), '好友通知');
      assert.equal(await entry.getAttribute('title'), '好友通知');
      assert.equal(await entry.locator('.notice-entry-text').isVisible(), true);
      assert.equal(await page.getByText('新朋友', { exact: true }).count(), 0);
      const noticeIcon = await entry.locator('svg').innerHTML();
      await entry.click();
      await page.getByRole('region', { name: '好友通知', exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('region', { name: '好友通知', exact: true })
          .locator('.weq-page-icon svg')
          .innerHTML(),
        noticeIcon,
      );
      const noticeBack = page
        .getByRole('region', { name: '好友通知', exact: true })
        .getByRole('button', { name: '返回', exact: true });
      if (single) await noticeBack.click();
      else assert.equal(await noticeBack.count(), 0);
      for (const [label, target] of [
        ['QQ 空间', 'qzone'],
        ['QQ 邮箱', 'mail'],
        ['收藏', 'collections'],
        ['QQ 频道', 'channel'],
        ['主页', 'home'],
      ]) {
        if (single && label === 'QQ 频道') continue;
        if (single) await nav.getByRole('button', { name: '更多', exact: true }).click();
        const button = single
          ? page.locator('.weq-mobile-more').getByRole('button', { name: label, exact: true })
          : label === '主页'
            ? page.getByRole('button', { name: label, exact: true }).first()
            : nav.getByRole('button', { name: label, exact: true });
        await button.click();
        await page.locator(`[data-navigation-view="${target}"]`).waitFor();
      }
      if (single) {
        await nav.getByRole('button', { name: '更多', exact: true }).click();
        for (const label of ['QQ 频道', '频道私聊', 'WeQ 助手'])
          assert.equal(
            await page
              .locator('.weq-mobile-more')
              .getByRole('button', { name: label, exact: true })
              .count(),
            0,
          );
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${height}-${theme}-more.png`) });
      }
      await nav.getByRole('button', { name: '联系人', exact: true }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const clipped = await nav.locator('button').evaluateAll((buttons) =>
        buttons
          .filter((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.width &&
              (rect.left < -1 ||
                rect.right > innerWidth + 1 ||
                button.scrollWidth > button.clientWidth + 1)
            );
          })
          .map((button) => button.textContent),
      );
      assert.deepEqual(clipped, []);
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${height}-${theme}.png`) });
      cases++;
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.weq-mobile-tabs').getByRole('button', { name: '更多', exact: true }).click();
  await page.locator('.weq-mobile-more').getByRole('button', { name: '收藏', exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('.app-rail [aria-current="page"]').waitFor();
  assert.equal(await page.locator('.app-rail [aria-current="page"]').getAttribute('title'), '收藏');
  assert.equal(await page.locator('[data-navigation-view="collections"]').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.weq-mobile-tabs [aria-current="page"]').innerText(), '更多');
  assert.equal(await page.locator('[data-navigation-view="collections"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

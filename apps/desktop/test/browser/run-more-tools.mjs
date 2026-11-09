import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: 'node_modules/.vite-more-tools',
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
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/more-tools.html`,
  );
  await page.waitForSelector('.weq-mobile-more');
  const names = ['任务', 'WeQ 助手', '分析与报告', '导出', '导出查看器', '合成聊天记录'];
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const chrome = async () => {
    assert.ok(await page.locator('.weq-mobile-header').isVisible());
    assert.ok(await page.locator('.weq-mobile-tabs').isVisible());
    const bounds = await page.locator('.chat-main').boundingBox();
    const top = await page.locator('.weq-mobile-header').boundingBox();
    const bottom = await page.locator('.weq-mobile-tabs').boundingBox();
    assert.ok(Math.abs(bounds.y - top.y - top.height) < 1);
    assert.ok(Math.abs(bounds.y + bounds.height - bottom.y) < 1);
    assert.equal(await page.locator('.weq-mobile-more').count(), 0);
  };
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.moreToolsQa.theme(theme), theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.waitForTimeout(100);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      if (output)
        await page.screenshot({ path: resolve(output, `more-list-${width}-${theme}.png`) });
      assert.equal(await page.locator('.weq-mobile-more .weq-workspace-menu-trigger').count(), 0);
      for (const name of names) {
        await page.locator('.weq-mobile-more').getByRole('button', { name, exact: true }).click();
        await page.locator(`.weq-workspace-page[aria-label="${name}"]`).waitFor();
        await page
          .locator('.weq-workspace-page')
          .getByText('正在加载…', { exact: true })
          .waitFor({ state: 'hidden' });
        await chrome();
        assert.equal(await page.locator('.weq-dialog-layer:not([hidden])').count(), 0);
        if (output)
          await page.screenshot({
            path: resolve(output, `more-${names.indexOf(name)}-${width}-${theme}.png`),
          });
        await page.evaluate(async () => {
          const target = document.querySelector('.weq-workspace-page:not([hidden])');
          const dispatch = (name, x, end = false) => {
            const touch = { identifier: 1, target, clientX: x, clientY: 280 };
            const event = new Event(name, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
              touches: { value: end ? [] : [touch] },
              changedTouches: { value: [touch] },
            });
            target.dispatchEvent(event);
          };
          dispatch('touchstart', 4);
          dispatch('touchmove', 164);
          await new Promise((resolve) => setTimeout(resolve, 150));
          dispatch('touchend', 164, true);
        });
        await page.waitForSelector('.weq-mobile-more');
        assert.equal(await page.locator(`.weq-workspace-page[aria-label="${name}"]`).count(), 0);
      }
    }
  }
  await page.locator('.weq-mobile-more').getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('region', { name: '导出', exact: true }).waitFor();
  await page.locator('[data-mobile-tab="more"]').click();
  await page.waitForSelector('.weq-mobile-more');
  await page.locator('.weq-mobile-more').getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor();
  await page.locator('[data-mobile-tab="messages"]').click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor({ state: 'detached' });
  await page.locator('[data-mobile-tab="more"]').click();
  await page
    .locator('.weq-mobile-more')
    .getByRole('button', { name: 'WeQ 助手', exact: true })
    .click();
  await page.getByRole('region', { name: 'WeQ 助手', exact: true }).waitFor();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-mobile-more');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.weq-mobile-more').getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('region', { name: '任务', exact: true }).waitFor();
  await chrome();
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.weq-mobile-more');
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.locator('.weq-workspace-menu-trigger:visible').click();
  assert.ok(await page.locator('.weq-dialog-layer:not([hidden]) .weq-workspace-menu').isVisible());
  assert.equal(await page.locator('.weq-workspace-page').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 六个真实工具并列入口、320/390 深浅色、顶底栏边界、逐页侧滑返回、同标签返回、跨标签关闭及系统返回',
  );
} finally {
  await browser?.close();
  await server.close();
}

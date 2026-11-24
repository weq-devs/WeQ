import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { launchBrowser } from '../../../../scripts/browser-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-mobile-page-exits'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
      },
      {
        find: /^\.\/DatabaseBrowser$/,
        replacement: resolve(root, 'test/browser/mobile-page-exits.stub.tsx'),
      },
      {
        find: /^\.\/settings\/(PerformanceMonitor|LogViewerPanel)$/,
        replacement: resolve(root, 'test/browser/mobile-page-exits.stub.tsx'),
      },
      {
        find: /^\.\.\/annual-report\/AnnualReportView$|^\.\/SavedAnalysisBody$/,
        replacement: resolve(root, 'test/browser/mobile-page-exits.stub.tsx'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let cases = 0;
const failures = [];
const engines = process.env.WEQ_BROWSER_ENGINES?.split(',') ?? ['chromium', 'webkit'];
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-page-exits.html`;
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const engine of engines) {
    const browser = await launchBrowser(engine);
    try {
      const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      await checkSwipeExits(page, url);
      cases += 5;
      const viewports = process.argv.includes('--swipe')
        ? []
        : [
            [320, 740],
            [390, 844],
            [844, 390],
          ];
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await page.goto(url);
        await page.waitForFunction(() => window.mobilePageExitsQa);
        // 手机横屏通常仍提供桌面式工具窗；模拟弹窗被阻止，覆盖同一个内嵌回退路径。
        await page.evaluate(() => {
          window.open = () => null;
        });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            window.mobilePageExitsQa.theme.getState().setPreference(theme);
            window.mobilePageExitsQa.theme
              .getState()
              .setAccent(theme === 'light' ? '#006d50' : '#f5cb70');
            document.querySelector('[data-scroll]').scrollTop = 137;
          }, theme);
          for (const kind of ['database', 'logs', 'performance', 'analysis', 'capture', 'repair']) {
            const label =
              kind === 'database'
                ? '关闭数据库浏览'
                : kind === 'capture'
                  ? '关闭抓包窗口提示'
                  : kind === 'repair'
                    ? '关闭数据库修复提示'
                    : kind === 'analysis'
                      ? '关闭分析报告'
                      : '关闭监视窗口';
            for (const method of ['button', 'history', 'bridge']) {
              await page.evaluate((kind) => window.mobilePageExitsQa.open(kind), kind);
              const close = page.getByRole('button', { name: label, exact: true });
              await close.waitFor();
              const bounds = await close.boundingBox();
              assert.ok(
                bounds &&
                  bounds.x >= 0 &&
                  bounds.y >= 0 &&
                  bounds.x + bounds.width <= width + 1 &&
                  bounds.y + bounds.height <= height + 1,
                `${kind} 关闭按钮必须在视口内`,
              );
              assert.ok(bounds.width >= 44 && bounds.height >= 44, `${kind} 关闭热区至少 44px`);
              if (kind !== 'capture' && kind !== 'repair')
                await page.getByText('合成工具内容', { exact: true }).waitFor();
              if (output && method === 'button')
                await page.screenshot({
                  path: resolve(output, `${engine}-${kind}-${width}-${theme}.png`),
                });
              await page.evaluate(() => window.mobilePageExitsQa.confirm());
              await page.getByRole('button', { name: '取消', exact: true }).waitFor();
              await page.evaluate(() => window.mobilePageExitsQa.back());
              await page
                .getByRole('button', { name: '取消', exact: true })
                .waitFor({ state: 'hidden' });
              await close.waitFor();
              if (method === 'button') await close.click();
              else if (method === 'history') await page.goBack();
              else await page.evaluate(() => window.weqMobileNavigation.back());
              await close.waitFor({ state: 'hidden' });
              assert.equal(await page.evaluate(() => window.mobilePageExitsQa.categoryReturns), 0);
              assert.equal(
                await page.getByLabel('原列表筛选', { exact: true }).inputValue(),
                '保留筛选',
              );
              assert.equal(
                await page.locator('[data-scroll]').evaluate((node) => node.scrollTop),
                137,
              );
              cases++;
            }
          }
          // 真实设置分类保持原位，关闭工具后再正常返回分类、退出设置。
          await page.evaluate(() => window.mobilePageExitsQa.open('settings'));
          await page.locator('.weq-settings-dialog').waitFor();
          await page.evaluate(() => window.mobilePageExitsQa.open('database'));
          await page.getByRole('button', { name: '关闭数据库浏览', exact: true }).waitFor();
          await page.evaluate(() => window.mobilePageExitsQa.back());
          await page
            .getByRole('button', { name: '关闭数据库浏览', exact: true })
            .waitFor({ state: 'hidden' });
          assert.equal(await page.locator('.weq-settings-dialog').count(), 1);
          const backToSettings = page.getByRole('button', { name: '返回设置', exact: true });
          if (await backToSettings.isVisible()) {
            await backToSettings.click();
            await page.getByRole('button', { name: '返回', exact: true }).click();
          } else {
            await page
              .locator('.weq-workspace-page')
              .filter({ has: page.locator('.weq-settings-dialog') })
              .focus();
            await page.keyboard.press('Escape');
          }
          await page.locator('.weq-settings-dialog').waitFor({ state: 'hidden' });
          cases++;
        }
      }
      failures.push(...errors.map((error) => ({ engine, error })));
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ cases, failures, engines }, null, 2));
} finally {
  await server.close();
}

async function checkSwipeExits(page, url) {
  const swipe = async () => {
    await page.waitForFunction(() => !document.querySelector('[data-mobile-animating]'));
    assert.ok(
      await page.evaluate(() => {
        const x = 4;
        const y = 280;
        const target = document.elementFromPoint(x, y);
        if (!target) return false;
        const dispatch = (name, clientX, end = false) => {
          const touch = { identifier: 1, target, clientX, clientY: y };
          const event = new Event(name, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            touches: { value: end ? [] : [touch] },
            changedTouches: { value: [touch] },
          });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        dispatch('touchstart', x);
        const handled = dispatch('touchmove', 164);
        dispatch('touchend', 164, true);
        return handled;
      }),
      `左缘滑动应由当前页处理：${page.url()}`,
    );
  };

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [url, `${url}?startup`]) {
    await page.goto(path);
    const entry = page.getByRole('button', { name: '官方公告', exact: true });
    await entry.click();
    const listEntry = page.getByRole('button', { name: /合成公告标题/ });
    await listEntry.click();
    const article = page.getByText('合成公告正文', { exact: true });
    await article.waitFor();
    await swipe();
    await listEntry.waitFor();
    await swipe();
    await listEntry.waitFor({ state: 'detached' });
    await entry.waitFor();
  }

  await page.goto(url);
  await page.waitForFunction(() => window.mobilePageExitsQa);
  for (const [kind, label] of [
    ['database', '关闭数据库浏览'],
    ['logs', '关闭监视窗口'],
    ['performance', '关闭监视窗口'],
  ]) {
    await page.evaluate((kind) => window.mobilePageExitsQa.open(kind), kind);
    const close = page.getByRole('button', { name: label, exact: true });
    await close.waitFor();
    if (kind === 'database') {
      await page.evaluate(() => window.mobilePageExitsQa.confirm());
      const cancel = page.getByRole('button', { name: '取消', exact: true });
      await cancel.waitFor();
      await swipe();
      await cancel.waitFor({ state: 'detached' });
      assert.ok(await close.isVisible());
    }
    await swipe();
    await close.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.mobilePageExitsQa.categoryReturns), 0);
  }
}

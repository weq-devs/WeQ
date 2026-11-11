import assert from 'node:assert/strict';
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
  optimizeDeps: { entries: ['test/browser/workspace-startup-loading.html'] },
  plugins: [react(), tailwind()],
  resolve: { alias: { '@resources': resolve(root, '../../resources') } },
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/workspace-startup-loading.html`,
  );
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        window.startupQa.theme.getState().setPreference(theme);
        window.startupQa.theme.getState().setAccent(theme === 'light' ? '#198754' : '#f0ce84');
      }, theme);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const spinner = page.locator('.weq-warmup-spinner');
      await spinner.waitFor({ state: 'visible' });
      const layout = await page.locator('.weq-warmup').evaluate((surface) => {
        const box = surface.getBoundingClientRect();
        const logo = surface.querySelector('img');
        const children = [...surface.children].map((node) => node.getBoundingClientRect());
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          centerX: (children[0].left + children[0].right) / 2,
          centerY: (children[0].top + children.at(-1).bottom) / 2,
          logoLoaded: logo.complete && logo.naturalWidth > 0,
          overflow: document.documentElement.scrollWidth > innerWidth,
          pending: Boolean(surface.closest('[data-weq-startup-pending]')),
        };
      });
      assert.equal(layout.logoLoaded, true, '整页占位首屏显示真实 Logo');
      assert.equal(layout.overflow, false);
      assert.equal(layout.pending, true, '启动检测仍等待工作区实际绘制');
      assert.equal(layout.x, 0);
      assert.equal(layout.y, 0);
      assert.equal(layout.width, width);
      assert.equal(layout.height, 800);
      assert(Math.abs(layout.centerX - width / 2) <= 1, '加载动画水平居中');
      assert(Math.abs(layout.centerY - 400) <= 1, '加载动画垂直居中');
      const before = await spinner.evaluate((node) => getComputedStyle(node).transform);
      await page.waitForTimeout(120);
      const after = await spinner.evaluate((node) => getComputedStyle(node).transform);
      assert.notEqual(before, after, '正常模式下转圈真实运动，不只是静态图标');
      if (process.env.WEQ_STARTUP_ARTIFACTS) {
        await mkdir(process.env.WEQ_STARTUP_ARTIFACTS, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.WEQ_STARTUP_ARTIFACTS,
            `workspace-loading-${width}-${theme}.png`,
          ),
        });
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(
        await spinner.evaluate((node) => node.getAnimations().length),
        0,
        '减少动态效果时保留居中占位并停止转圈',
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log('通过工作区整页加载的桌面/手机宽度、深浅主题、主题色、实际转圈及减少动态效果检查。');
} finally {
  await browser?.close();
  await server.close();
}

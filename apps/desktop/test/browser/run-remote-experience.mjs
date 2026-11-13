import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/remote-experience-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const output =
  process.env.WEQ_REMOTE_EXPERIENCE_ARTIFACTS ??
  resolve(root, 'node_modules/.cache/remote-experience');
await mkdir(output, { recursive: true });
await server.listen();
let cases = 0;
try {
  for (const engine of ['chromium', 'webkit']) {
    const browser = await engines[engine].launch({
      headless: true,
      ...(engine === 'chromium' && process.env.WEQ_BROWSER_EXECUTABLE
        ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
        : {}),
      ...(engine === 'webkit' && process.env.WEQ_WEBKIT_EXECUTABLE
        ? { executablePath: process.env.WEQ_WEBKIT_EXECUTABLE }
        : {}),
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        userAgent: 'WeQRemote/fixture',
        reducedMotion: 'reduce',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.weqRemoteShell = { openMenu() {} };
      });
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/_download/report-fixture')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><meta charset="utf-8"><h1>合成报告正文</h1>',
          });
        return url.hostname === '127.0.0.1' || url.protocol === 'data:'
          ? route.continue()
          : route.abort();
      });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-experience.html`,
      );
      await page.waitForSelector('[data-layout="reading"]');
      await page.locator('.weq-report-slide.is-active').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      if (engine === 'chromium') {
        const input = await page.context().newCDPSession(page);
        await input.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: 180, y: 680 }],
        });
        for (const y of [650, 620, 590, 560])
          await input.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: 180, y }],
          });
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(
          () => document.querySelector('[data-report-index]').textContent === '2',
        );
      }
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 640, height: 360 },
        { width: 844, height: 390 },
        { width: 1180, height: 820 },
      ]) {
        await page.setViewportSize(viewport);
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            window.remoteExperience.theme.getState().setPreference(theme);
            window.remoteExperience.theme
              .getState()
              .setAccent(theme === 'light' ? '#086636' : '#f8df7c');
          }, theme);
          await page.evaluate(() => window.remoteExperience.setMode('call'));
          await page.waitForSelector('.weq-call-inline');
          const fits = await page.locator('.weq-call-inline').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= 0 &&
              rect.right <= innerWidth + 1 &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight + 1 &&
              document.documentElement.scrollWidth <= innerWidth
            );
          });
          assert.equal(fits, true, `${engine}/${viewport.width}/${theme}通话越界`);
          assert.equal(
            await page
              .locator('.weq-call-name')
              .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
            true,
            '通话名称不能被压扁裁切',
          );
          await page.screenshot({
            path: resolve(output, `${engine}-${viewport.width}-${theme}-call.png`),
          });
          await page.evaluate(() => window.remoteExperience.setMode('report'));
          await page.waitForSelector('[data-report-index]');
          await page.evaluate(() => window.remoteExperience.preview());
          await page.waitForSelector('.weq-client-document iframe');
          await page
            .frameLocator('.weq-client-document iframe')
            .getByRole('heading', { name: '合成报告正文' })
            .waitFor();
          assert.equal(
            await page.locator('.weq-client-document').evaluate((node) => {
              const r = node.getBoundingClientRect();
              return (
                r.left >= 0 &&
                r.right <= innerWidth + 1 &&
                r.top >= 0 &&
                r.bottom <= innerHeight + 1
              );
            }),
            true,
          );
          await page.screenshot({
            path: resolve(output, `${engine}-${viewport.width}-${theme}-report.png`),
          });
          await page.getByRole('button', { name: '关闭报告', exact: true }).click();
          cases++;
        }
      }
      assert.deepEqual(errors, [], engine);
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify({ cases, output }));
} finally {
  await server.close();
}

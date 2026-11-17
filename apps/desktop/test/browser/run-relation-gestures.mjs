import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-relation-gestures'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/relation-profile.stub.ts'),
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
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    window.relationGestureEvents = [];
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
    ]) {
      document.addEventListener(type, (event) => {
        window.relationGestureEvents.push({
          type,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        });
        if (window.relationGestureEvents.length > 30) window.relationGestureEvents.shift();
      });
    }
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      const m = this.getTransform();
      const dpr = devicePixelRatio || 1;
      window.relationGestureView = { scale: m.a / dpr, x: m.e / dpr, y: m.f / dpr };
      window.relationGestureDrawnAt = performance.now();
      return arc.apply(this, args);
    };
  });
  const output = process.env.WEQ_RELATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const view = () => page.evaluate(() => window.relationGestureView);
  const near = (actual, expected, message, tolerance = 1.5) =>
    assert(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
  async function touch(type, points) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  let cases = 0;
  for (const width of [320, 390, 844, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-profile.html`,
      );
      await page.evaluate((theme) => {
        window.relationProfileQa.theme.getState().setPreference(theme);
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#e08aa0' : '#287b53',
        );
      }, theme);
      await page.locator('.weq-relhome-cta').click();
      const toolbar = await page.locator('.weq-graph-overlay-bar').evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          buttons: [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return {
              width: rect.width,
              height: rect.height,
              overflow: button.scrollWidth > button.clientWidth,
              padding: Number.parseFloat(style.paddingLeft),
            };
          }),
        };
      });
      assert(toolbar.left >= 0 && toolbar.right <= width, JSON.stringify(toolbar));
      for (const button of toolbar.buttons) {
        assert(button.width >= 44 && button.height >= 44, JSON.stringify({ width, button }));
        assert(!button.overflow, JSON.stringify({ width, button }));
      }
      assert(toolbar.buttons.slice(1, 5).every((button) => button.padding >= 8));
      for (const mode of ['群友圈子', '群聊网络']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await page.getByRole('button', { name: '适应全部', exact: true }).click();
        await page.waitForFunction(
          () =>
            window.relationGestureDrawnAt &&
            performance.now() - window.relationGestureDrawnAt > 600,
        );
        if (output && mode === '群友圈子')
          await page.screenshot({ path: resolve(output, `${width}-${theme}-tabs.png`) });
        const wrap = await page.locator('.weq-graph-canvas-wrap').boundingBox();
        const overlay = await page.locator('.weq-graph-overlay').boundingBox();
        const y = Math.min(overlay.y + overlay.height + 45, wrap.y + wrap.height - 45);
        const a = { id: 1, x: wrap.x + 35, y };
        const b = { id: 2, x: wrap.x + 135, y };
        const before = await view();
        await touch('touchStart', [a, b]);
        const spread = { ...b, x: b.x + 60 };
        await touch('touchMove', [a, spread]);
        const pinched = await view();
        near(pinched.scale, before.scale * 1.6, '双指缩放比例', 0.005);
        const centerX = (a.x + b.x) / 2 - wrap.x;
        near(pinched.x, centerX + 30 - (centerX - before.x) * 1.6, '缩放水平锚点');
        near(pinched.y, y - wrap.y - (y - wrap.y - before.y) * 1.6, '缩放垂直锚点');
        await touch('touchMove', [a, b]);
        near((await view()).scale, before.scale, '双指缩小回原比例', 0.005);
        await touch('touchMove', [a, spread]);
        const shiftedA = { ...a, x: a.x + 20, y: a.y + 10 };
        const shiftedB = { ...spread, x: spread.x + 20, y: spread.y + 10 };
        await touch('touchMove', [shiftedA, shiftedB]);
        const panned = await view();
        near(panned.scale, pinched.scale, '双指平移保持比例', 0.005);
        near(panned.x, pinched.x + 20, '双指水平平移');
        near(panned.y, pinched.y + 10, '双指垂直平移');
        // CDP touchEnd 的非空列表是本次抬起的触点，不是留下的触点。
        await touch('touchEnd', [shiftedB]);
        await touch('touchMove', [{ ...shiftedA, x: shiftedA.x + 20 }]);
        near(
          (await view()).x,
          panned.x + 20,
          `抬起一指后继续拖动 ${JSON.stringify(await page.evaluate(() => window.relationGestureEvents))}`,
        );
        await touch('touchEnd', []);
        assert.equal(await page.getByRole('dialog').count(), 0, '手势不应误开资料卡');
        const single = await view();
        await touch('touchStart', [a]);
        await touch('touchMove', [{ ...a, x: a.x + 30, y: a.y + 20 }]);
        await touch('touchEnd', []);
        const dragged = await view();
        near(dragged.x, single.x + 30, '单指水平拖动');
        near(dragged.y, single.y + 20, '单指垂直拖动');
        assert.equal(await page.evaluate(() => visualViewport.scale), 1, '只缩放图谱，不缩放页面');
        assert(
          await page.locator('.weq-graph-canvas').evaluate((canvas) => {
            const pixels = canvas
              .getContext('2d')
              .getImageData(0, 0, canvas.width, canvas.height).data;
            return pixels.some((value, i) => i % 4 === 3 && value > 0);
          }),
          '触屏操作后画布不应空白',
        );
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, input: 'Chromium CDP multi-touch' }));
} finally {
  await browser?.close();
  await server.close();
}

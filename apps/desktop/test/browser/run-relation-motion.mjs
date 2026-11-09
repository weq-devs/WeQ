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
  cacheDir: resolve(root, 'node_modules/.vite-relation-motion'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const arc = CanvasRenderingContext2D.prototype.arc;
    window.motionQa = { frames: 0, circles: [] };
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.motionQa.frames++;
      window.motionQa.lastFrameAt = performance.now();
      window.motionQa.circles = [];
      const tracking = window.motionQa.tracking;
      if (tracking) {
        for (const node of window.relationLayoutQa.graph.nodes) {
          if (node.id === tracking.dragged) continue;
          const previous = tracking.previous.get(node.id);
          const initial = tracking.initial.get(node.id);
          tracking.peakStep = Math.max(
            tracking.peakStep,
            Math.hypot(node.x - previous[0], node.y - previous[1]),
          );
          tracking.excursion = Math.max(
            tracking.excursion,
            Math.hypot(node.x - initial[0], node.y - initial[1]),
          );
          tracking.previous.set(node.id, [node.x, node.y]);
        }
      }
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...rest) {
      const m = this.getTransform();
      const dpr = devicePixelRatio || 1;
      window.motionQa.circles.push({
        x: (x * m.a + m.e) / dpr,
        y: (y * m.d + m.f) / dpr,
        radius: (radius * m.a) / dpr,
        worldX: x,
        worldY: y,
      });
      return arc.call(this, x, y, radius, ...rest);
    };
  });
  async function snapshot() {
    return page.evaluate(() => ({
      frames: window.motionQa.frames,
      positions: window.motionQa.circles.map((circle) => [circle.worldX, circle.worldY]),
    }));
  }
  async function stopped(message) {
    const before = await snapshot();
    await page.waitForTimeout(500);
    const after = await snapshot();
    assert.equal(after.frames, before.frames, message);
    assert.equal(JSON.stringify(after.positions), JSON.stringify(before.positions), message);
  }
  async function target() {
    return page.evaluate(() => window.motionQa.circles[0]);
  }
  const output = process.env.WEQ_RELATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const report = [];
  if (process.env.WEQ_RELATION_STABILITY) {
    for (const width of [390, 1180]) {
      for (const mode of ['people', 'groups']) {
        await page.setViewportSize({ width, height: 760 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html?count=500&dense=1&strong=1&mode=${mode}`,
        );
        await page.waitForFunction(() => window.motionQa.circles.length > 0);
        await page.evaluate(
          (theme) => window.relationLayoutQa.theme.getState().setPreference(theme),
          width === 390 ? 'dark' : 'light',
        );
        await page.waitForFunction(() => performance.now() - window.motionQa.lastFrameAt > 600);
        await stopped('500 节点密集图初始布局应停止');
        const point = await page.evaluate(() => {
          const circle = window.motionQa.circles.findLast(
            (circle) => circle.y > 120 && circle.x > 20 && circle.x < innerWidth - 30,
          );
          const graph = window.relationLayoutQa.graph;
          const dragged = graph.nodes.find(
            (node) => node.x === circle.worldX && node.y === circle.worldY,
          ).id;
          const positions = graph.nodes.map((node) => [node.id, [node.x, node.y]]);
          window.motionQa.tracking = {
            dragged,
            previous: new Map(positions),
            initial: new Map(positions),
            peakStep: 0,
            excursion: 0,
          };
          return circle;
        });
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 5, point.y + 1, { steps: 5 });
        await page.waitForTimeout(1500);
        assert(
          await page.evaluate(() => {
            const tracking = window.motionQa.tracking;
            const dragged = window.relationLayoutQa.graph.nodes.find((node) => node.fx !== null);
            const initial = tracking.initial.get(tracking.dragged);
            return (
              dragged?.id === tracking.dragged &&
              Math.hypot(dragged.x - initial[0], dragged.y - initial[1]) > 0
            );
          }),
          '微扰检查必须实际拖动并移动目标节点',
        );
        await page.mouse.up();
        await page.waitForFunction(() => performance.now() - window.motionQa.lastFrameAt > 600);
        await stopped('微扰后图谱应恢复静止');
        const measured = await page.evaluate(() => ({
          peakStep: window.motionQa.tracking.peakStep,
          excursion: window.motionQa.tracking.excursion,
          count: window.relationLayoutQa.graph.nodes.length,
          edges: window.relationLayoutQa.graph.edges.length,
        }));
        assert.equal(measured.count, 501);
        assert(measured.peakStep < 4, JSON.stringify(measured));
        assert(measured.excursion < 20, JSON.stringify(measured));
        if (output) await page.screenshot({ path: resolve(output, `${width}-${mode}-stable.png`) });
        report.push({ width, mode, ...measured });
      }
    }
  } else
    for (const width of [390, 1180]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 760 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html`,
        );
        await page.evaluate(
          (theme) => window.relationLayoutQa.theme.getState().setPreference(theme),
          theme,
        );
        await page.waitForFunction(() => window.motionQa.circles.length > 0);
        await page.waitForTimeout(3000);
        await stopped('首次布局应在短时间内停止重绘');
        const settled = await snapshot();
        const point = await target();
        await page.mouse.click(point.x, point.y);
        assert(await page.evaluate(() => window.relationLayoutQa.selected), '单击仍应命中节点');
        await page.waitForTimeout(100);
        assert.deepEqual((await snapshot()).positions, settled.positions, '单击不应重新启动布局');
        await stopped('单击后不应持续重绘');

        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 30, point.y + 20, { steps: 4 });
        await page.waitForTimeout(100);
        assert.notDeepEqual((await snapshot()).positions, settled.positions, '拖动仍应改变位置');
        await page.mouse.up();
        await page.waitForTimeout(3000);
        await stopped('拖动释放后应停止布局');

        const next = await target();
        await page.mouse.move(next.x, next.y);
        await page.mouse.down();
        await page.mouse.move(next.x + 20, next.y + 15, { steps: 3 });
        await page.evaluate(() => {
          document
            .querySelector('.weq-graph-canvas-wrap')
            .dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }));
        });
        await page.waitForTimeout(3000);
        await stopped('丢失指针捕获、未收到 pointerup 也必须停止');
        const interrupted = await snapshot();
        await page.mouse.move(next.x + 40, next.y + 35);
        await page.waitForTimeout(100);
        assert.deepEqual(
          (await snapshot()).positions,
          interrupted.positions,
          '丢失指针捕获后不能继续拖住节点',
        );
        await page.mouse.up();

        await page.mouse.move(width / 2, 400);
        await page.mouse.wheel(0, -180);
        await page.getByRole('button', { name: '适应全部', exact: true }).click();
        await page.waitForTimeout(100);
        await stopped('缩放和适应全部不应重新启动布局');
        const painted = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          return canvas
            .getContext('2d')
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, i) => i % 4 === 3 && value > 0);
        });
        assert(painted, '画布应非空');
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-settled.png`) });
        await page.getByRole('button', { name: '切换模式', exact: true }).click();
        await page.waitForTimeout(3000);
        await stopped('群聊网络首次布局也应停止');
        await page.getByRole('button', { name: '切换疏密', exact: true }).click();
        await page.waitForTimeout(3000);
        await stopped('没有群间连线时仍应停止');
        report.push({ width, theme, initialFrames: settled.frames, painted });
      }
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ report, errors }));
} finally {
  await browser?.close();
  await server.close();
}

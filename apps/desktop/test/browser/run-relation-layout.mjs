import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const baseline = process.env.WEQ_RELATION_BASELINE_REF;
const baselineFiles = new Map();
if (baseline) {
  for (const name of ['GraphCanvas.tsx', 'graphModel.ts', 'graphLayout.ts']) {
    const path = `apps/desktop/src/renderer/src/components/relationGraph/${name}`;
    baselineFiles.set(
      resolve(root, '../..', path),
      execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' }),
    );
  }
}
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-relation-layout'),
  plugins: [
    {
      name: 'relation-baseline',
      enforce: 'pre',
      transform(_code, id) {
        return baselineFiles.get(id);
      },
    },
    react(),
    tailwind(),
  ],
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
  // 观察真实 Canvas 变换后的头像圆，不向生产组件加入测试专用入口。
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.layoutCircles = [];
      const start = performance.now();
      window.frameSamples ??= [];
      if (window.lastDraw) window.frameSamples.push(start - window.lastDraw);
      window.lastDraw = start;
      queueMicrotask(() => {
        window.drawSamples ??= [];
        window.drawSamples.push(performance.now() - start);
      });
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...rest) {
      const m = this.getTransform();
      const dpr = window.devicePixelRatio || 1;
      window.layoutTransform = { scale: m.a / dpr, x: m.e / dpr, y: m.f / dpr };
      if (window.layoutCircles.length === 0) {
        window.viewSamples ??= [];
        window.viewSamples.push(window.layoutTransform);
      }
      window.layoutCircles.push({
        x: (x * m.a + m.e) / dpr,
        y: (y * m.d + m.f) / dpr,
        radius: (radius * m.a) / dpr,
      });
      return arc.call(this, x, y, radius, ...rest);
    };
  });
  const output = process.env.WEQ_RELATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  async function checkFollowing() {
    await page.evaluate(() => {
      window.viewSamples = [];
    });
    await page.waitForTimeout(500);
    const views = await page.evaluate(() => window.viewSamples);
    assert(views.length >= 5, '布局运动时应持续绘制');
    assert(new Set(views.map((view) => JSON.stringify(view))).size >= 5, '自适应应逐帧跟随布局');
    cases++;
  }
  async function check(expected) {
    await page.waitForTimeout(2100);
    const result = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const box = canvas.getBoundingClientRect();
      const top = document.querySelector('.weq-graph-overlay').getBoundingClientRect().bottom + 8;
      const circles = [...new Map(window.layoutCircles.map((c) => [`${c.x},${c.y}`, c])).values()];
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        count: circles.length,
        clipped: circles.filter(
          (c) =>
            c.x - c.radius < 0 ||
            c.x + c.radius > box.width ||
            c.y - c.radius < top ||
            c.y + c.radius > box.height,
        ),
        painted: pixels.some((value, i) => i % 4 === 3 && value > 0),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(result.count, expected, JSON.stringify(result));
    assert.equal(result.clipped.length, 0, JSON.stringify(result));
    assert(result.painted && !result.overflow, JSON.stringify(result));
    cases++;
  }
  if (process.env.WEQ_RELATION_PERFORMANCE) {
    const report = [];
    await page.setViewportSize({ width: 1180, height: 760 });
    for (const count of [200, 500, 1000]) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html?count=${count}`,
      );
      await page.waitForTimeout(6500);
      const result = await page.evaluate(() => {
        const samples = window.drawSamples.slice(10).sort((a, b) => a - b);
        const frames = window.frameSamples.slice(10).sort((a, b) => a - b);
        const canvas = document.querySelector('canvas');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return {
          frames: samples.length,
          medianDrawMs: samples[Math.floor(samples.length / 2)],
          p95DrawMs: samples[Math.floor(samples.length * 0.95)],
          medianFrameMs: frames[Math.floor(frames.length / 2)],
          p95FrameMs: frames[Math.floor(frames.length * 0.95)],
          buildMs: window.relationLayoutQa.buildMs,
          edges: window.relationLayoutQa.edges,
          painted: pixels.some((value, i) => i % 4 === 3 && value > 0),
          nodes: new Set(window.layoutCircles.map((circle) => `${circle.x},${circle.y}`)).size,
        };
      });
      assert.equal(result.nodes, count + 1);
      assert(result.painted);
      report.push({ baseline: baseline ?? 'working', count, ...result });
      if (output)
        await page.screenshot({
          path: resolve(output, `${count}-${baseline ? 'baseline' : 'optimized'}.png`),
        });
      // 真实点击命中、拖动及缩放，不能只验证离屏计算。
      const target = await page.evaluate(() => window.layoutCircles[0]);
      await page.mouse.click(target.x, target.y);
      assert(await page.evaluate(() => window.relationLayoutQa.selected), '头像点击应命中节点');
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      await page.mouse.move(target.x + 30, target.y + 20, { steps: 4 });
      await page.mouse.up();
      await page.mouse.wheel(0, -180);
      await page.getByRole('button', { name: '适应全部', exact: true }).click();
      cases++;
    }
    console.log(JSON.stringify({ report }));
  } else
    for (const width of [320, 390, 1180]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: width === 1180 ? 760 : 600 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html`,
        );
        await page.evaluate((theme) => {
          window.relationLayoutQa.theme.getState().setPreference(theme);
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#e08aa0' : '#287b53',
          );
        }, theme);
        await checkFollowing();
        await check(101);
        if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-dense.png`) });
        await page.getByRole('button', { name: '切换数量', exact: true }).click();
        await page.getByRole('button', { name: '切换疏密', exact: true }).click();
        await check(201);
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-sparse.png`) });
        // 在模拟仍运行时缩放，后续收敛及 end 事件均不得重置镜头。
        await page.mouse.move(width / 2, 300);
        await page.mouse.wheel(0, -180);
        await page.waitForTimeout(100);
        const manual = await page.evaluate(() => window.layoutTransform);
        await page.waitForTimeout(3300);
        assert.deepEqual(
          await page.evaluate(() => window.layoutTransform),
          manual,
          '手动缩放后不应自动取景',
        );
        await page.getByRole('button', { name: '适应全部', exact: true }).click();
        await page.getByRole('button', { name: '切换疏密', exact: true }).click();
        await checkFollowing();
        await check(201);
        assert.notDeepEqual(await page.evaluate(() => window.layoutTransform), manual);
        await page.getByRole('button', { name: '切换模式', exact: true }).click();
        await check(9);
      }
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}

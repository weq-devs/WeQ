import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, _electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const electron = process.env.WEQ_RELATION_ELECTRON === '1';
const production = electron || process.env.WEQ_RELATION_PRODUCTION === '1';
const outDir = production ? await mkdtemp(resolve(root, 'node_modules/.relation-worker-')) : null;
const userData = electron ? await mkdtemp(resolve(root, 'node_modules/.relation-electron-')) : null;
const config = {
  configFile: false,
  root,
  base: './',
  cacheDir: resolve(root, 'node_modules/.vite-relation-worker'),
  plugins: [
    react(),
    tailwind(),
    ...(production
      ? [
          {
            name: 'relation-worker-csp',
            transformIndexHtml() {
              return [
                {
                  tag: 'meta',
                  attrs: {
                    'http-equiv': 'Content-Security-Policy',
                    content:
                      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';",
                  },
                  injectTo: 'head-prepend',
                },
              ];
            },
          },
        ]
      : []),
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
  preview: { host: '127.0.0.1', port: 0 },
  ...(outDir
    ? {
        build: {
          outDir,
          rollupOptions: { input: resolve(root, 'test/browser/relation-layout.html') },
        },
      }
    : {}),
};
let server;
let browser;
let electronApp;
try {
  if (production) {
    await build(config);
    server = await preview(config);
  } else {
    server = await createServer(config);
    await server.listen();
  }
  let page;
  if (electron) {
    const { default: executablePath } = await import('electron');
    electronApp = await _electron.launch({
      executablePath,
      args: [resolve(root, 'test/browser/relation-worker-electron.cjs')],
      env: { ...process.env, WEQ_RELATION_USER_DATA: userData },
    });
    page = await electronApp.firstWindow();
  } else {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.WEQ_BROWSER_EXECUTABLE
        ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
        : {}),
    });
    page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    (electron && route.request().url().startsWith('file:'))
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.workerQa = { created: 0, active: 0, frames: 0, commands: [], failNext: false, raf: [] };
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        if (window.workerQa.failNext) {
          window.workerQa.failNext = false;
          throw new Error('测试布局线程失败');
        }
        super(...args);
        window.workerQa.created++;
        window.workerQa.active++;
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'frame') window.workerQa.frames++;
        });
      }
      postMessage(message, ...args) {
        window.workerQa.commands.push({
          type: message.type,
          id: message.id,
          x: message.x,
          y: message.y,
        });
        super.postMessage(message, ...args);
      }
      terminate() {
        window.workerQa.active--;
        super.terminate();
      }
    };
    let previous;
    function frame(time) {
      if (previous !== undefined) window.workerQa.raf.push(time - previous);
      previous = time;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    const arc = CanvasRenderingContext2D.prototype.arc;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.workerCircles = [];
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...rest) {
      const m = this.getTransform();
      const dpr = devicePixelRatio || 1;
      window.workerCircles.push({
        x: (x * m.a + m.e) / dpr,
        y: (y * m.d + m.f) / dpr,
        radius: (radius * m.a) / dpr,
      });
      return arc.call(this, x, y, radius, ...rest);
    };
  });
  const base = electron
    ? pathToFileURL(resolve(outDir, 'test/browser/relation-layout.html')).href
    : `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html`;
  const report = [];
  for (const count of [200, 500, 1000]) {
    await page.goto(`${base}?count=${count}&dense&worker`);
    await page.waitForFunction(() => window.workerQa.frames >= 5, undefined, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.workerQa.active), 1);
    assert.equal(page.workers().length, 1);
    assert(page.workers()[0].url().includes('graphSimulation'));
    await page.evaluate(() => {
      window.workerQa.raf = [];
    });
    await page.waitForTimeout(1000);
    const result = await page.evaluate(() => {
      const graph = window.relationLayoutQa.graph;
      const canvas = document.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const samples = window.workerQa.raf.toSorted((a, b) => a - b);
      return {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        frames: window.workerQa.frames,
        finite: graph.nodes.every((node) =>
          [node.x, node.y, node.vx, node.vy].every(Number.isFinite),
        ),
        painted: pixels.some((value, i) => i % 4 === 3 && value > 0),
        p95RafMs: samples[Math.floor(samples.length * 0.95)],
      };
    });
    assert.equal(result.nodes, count + 1);
    assert.equal(result.edges, (count * (count - 1)) / 2 + count, '完整密集边集不得抽样');
    assert(result.finite && result.painted);
    // 从当前画布位置点击并拖动，验证命令经过真实 Worker，而非仅验证静态画布。
    const target = await page.evaluate(() => window.workerCircles[0]);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => Boolean(window.relationLayoutQa.selected));
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + 20, { steps: 4 });
    await page.mouse.up();
    assert(
      await page.evaluate(() => window.workerQa.commands.some((command) => command.type === 'pin')),
    );
    assert(
      await page.evaluate(() =>
        window.workerQa.commands.some((command) => command.type === 'release'),
      ),
    );
    const closed = page.workers()[0].waitForEvent('close');
    await page.getByRole('button', { name: '切换图谱', exact: true }).click();
    await closed;
    await page.waitForFunction(() => window.workerQa.active === 0);
    assert.equal(page.workers().length, 0);
    await page.getByRole('button', { name: '切换图谱', exact: true }).click();
    await page.waitForFunction(() => window.workerQa.created === 2 && window.workerQa.active === 1);
    await page.getByRole('button', { name: '切换模式', exact: true }).click();
    await page.waitForFunction(() => window.workerQa.created === 3 && window.workerQa.active === 1);
    report.push({ count, ...result });
  }
  // 启动失败不静默回到主线程；重试恢复独立线程和绘制。
  await page.goto(`${base}?worker`);
  await page.waitForFunction(() => window.workerQa.frames >= 2);
  await page.getByRole('button', { name: '切换图谱', exact: true }).click();
  await page.evaluate(() => {
    window.workerQa.failNext = true;
  });
  await page.getByRole('button', { name: '切换图谱', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => window.workerQa.active), 0);
  await page.getByRole('button', { name: '重试图谱布局', exact: true }).click();
  await page.waitForFunction(
    () => window.workerQa.active === 1 && !document.querySelector('[role="alert"]'),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ production, electron, report, lifecycle: 'passed', retry: 'passed', errors }),
  );
} finally {
  await electronApp?.close();
  await browser?.close();
  if (server) {
    if (production)
      await new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    else await server.close();
  }
  if (outDir) await rm(outDir, { recursive: true, force: true });
  if (userData) await rm(userData, { recursive: true, force: true });
}

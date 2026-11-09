import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, _electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const electron = process.env.WEQ_RELATION_ELECTRON === '1';
const production = electron || process.env.WEQ_RELATION_PRODUCTION === '1';
const canvasFallback = process.env.WEQ_RELATION_CANVAS_FALLBACK === '1';
const density = process.env.WEQ_RELATION_DENSITY ?? 'complete';
assert(['complete', 'clusters'].includes(density));
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
  if (process.env.WEQ_RELATION_VIEWPORT_WIDTH)
    await page.setViewportSize({
      width: Number(process.env.WEQ_RELATION_VIEWPORT_WIDTH),
      height: 600,
    });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') console.log(message.text());
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    (electron && route.request().url().startsWith('file:'))
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript((canvasFallback) => {
    const NativeWorker = window.Worker;
    window.workerQa = {
      created: 0,
      active: 0,
      frames: 0,
      commands: [],
      failNext: false,
      raf: [],
      drawMs: [],
      physicsMs: [],
      drawGaps: [],
      gpuInstances: 0,
      gpuPainted: false,
      inputDelays: [],
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
      window.addEventListener(
        type,
        (event) => {
          if (event.isTrusted)
            window.workerQa.inputDelays.push(Math.max(0, performance.now() - event.timeStamp));
        },
        { capture: true, passive: true },
      );
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    const gpuCanvases = new Map();
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2' && canvasFallback) return null;
      const context = getContext.call(this, type, ...args);
      if (type === 'webgl2' && context && !gpuCanvases.has(this)) {
        gpuCanvases.set(this, context);
        const info = context.getExtension('WEBGL_debug_renderer_info');
        window.workerQa.gpuRenderer = info
          ? context.getParameter(info.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER);
        const draw = context.drawArraysInstanced.bind(context);
        context.drawArraysInstanced = (...args) => {
          window.workerQa.gpuInstances = Math.max(window.workerQa.gpuInstances, args[3]);
          const result = draw(...args);
          if (window.workerQa.frames >= 3 && !window.workerQa.gpuPainted) {
            const pixels = new Uint8Array(this.width * this.height * 4);
            context.readPixels(
              0,
              0,
              this.width,
              this.height,
              context.RGBA,
              context.UNSIGNED_BYTE,
              pixels,
            );
            window.workerQa.gpuPainted = pixels.some((value, i) => i % 4 === 3 && value > 0);
          }
          return result;
        };
      }
      return context;
    };
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
          if (data.type === 'frame' && data.stepMs > 0) window.workerQa.physicsMs.push(data.stepMs);
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
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      window.workerQa.cpuStrokes++;
      return stroke.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.workerCircles = [];
      window.workerQa.cpuStrokes = 0;
      const start = performance.now();
      if (window.workerQa.lastDraw !== undefined)
        window.workerQa.drawGaps.push(start - window.workerQa.lastDraw);
      window.workerQa.lastDraw = start;
      queueMicrotask(() => window.workerQa.drawMs.push(performance.now() - start));
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...rest) {
      const m = this.getTransform();
      const dpr = devicePixelRatio || 1;
      window.workerQa.scale = m.a / dpr;
      window.workerCircles.push({
        x: (x * m.a + m.e) / dpr,
        y: (y * m.d + m.f) / dpr,
        radius: (radius * m.a) / dpr,
      });
      return arc.call(this, x, y, radius, ...rest);
    };
  }, canvasFallback);
  const base = electron
    ? pathToFileURL(resolve(outDir, 'test/browser/relation-layout.html')).href
    : `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-layout.html`;
  const report = [];
  const counts = (process.env.WEQ_RELATION_COUNTS ?? '200,500,1000').split(',').map(Number);
  for (const count of counts) {
    await page.goto(`${base}?count=${count}&${density === 'complete' ? 'dense&' : ''}worker`);
    if (process.env.WEQ_RELATION_THEME)
      await page.evaluate(
        (theme) => window.relationLayoutQa.theme.getState().setPreference(theme),
        process.env.WEQ_RELATION_THEME,
      );
    await page.waitForFunction(() => window.workerQa.frames >= 5, undefined, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.workerQa.active), 1);
    assert.equal(page.workers().length, 1);
    assert(page.workers()[0].url().includes('graphSimulation'));
    await page.evaluate(() => {
      window.workerQa.raf = [];
      window.workerQa.drawMs = [];
      window.workerQa.physicsMs = [];
      window.workerQa.drawGaps = [];
      window.workerQa.lastDraw = undefined;
      window.workerQa.sampleStart = performance.now();
      window.workerQa.sampleFrames = window.workerQa.frames;
    });
    let profiler;
    if (process.env.WEQ_RELATION_TRACE_OUTPUT) {
      profiler = await page.context().newCDPSession(page);
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.start');
    }
    await page.waitForTimeout(Number(process.env.WEQ_RELATION_SAMPLE_MS ?? 1000));
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      await writeFile(process.env.WEQ_RELATION_TRACE_OUTPUT, JSON.stringify(profile), {
        flag: 'wx',
      });
      const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
      const time = new Map();
      profile.samples.forEach((id, i) => {
        const node = nodes.get(id);
        const key = `${node.functionName || '(anonymous)'} ${node.url || ''}`;
        time.set(key, (time.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
      });
      console.log(JSON.stringify({ cpuTop: [...time].sort((a, b) => b[1] - a[1]).slice(0, 12) }));
      await profiler.detach();
    }
    const result = await page.evaluate(() => {
      const graph = window.relationLayoutQa.graph;
      const canvas = document.querySelector('.weq-graph-canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const samples = window.workerQa.raf.toSorted((a, b) => a - b);
      const draws = window.workerQa.drawMs.toSorted((a, b) => a - b);
      const gaps = window.workerQa.drawGaps.toSorted((a, b) => a - b);
      const sampleMs = performance.now() - window.workerQa.sampleStart;
      const physics = window.workerQa.physicsMs.toSorted((a, b) => a - b);
      return {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        frames: window.workerQa.frames,
        frameUpdates: window.workerQa.frames - window.workerQa.sampleFrames,
        meanPhysicsMs: physics.reduce((sum, value) => sum + value, 0) / physics.length,
        p95PhysicsMs: physics[Math.floor(physics.length * 0.95)],
        drawCount: draws.length,
        drawHz: (draws.length * 1000) / sampleMs,
        p95DrawGapMs: gaps[Math.floor(gaps.length * 0.95)],
        finite: graph.nodes.every((node) =>
          [node.x, node.y, node.vx, node.vy].every(Number.isFinite),
        ),
        painted: pixels.some((value, i) => i % 4 === 3 && value > 0),
        p95RafMs: samples[Math.floor(samples.length * 0.95)],
        meanDrawMs: draws.reduce((sum, value) => sum + value, 0) / draws.length,
        p95DrawMs: draws[Math.floor(draws.length * 0.95)],
        gpuInstances: window.workerQa.gpuInstances,
        gpuPainted: window.workerQa.gpuPainted,
        gpuRenderer: window.workerQa.gpuRenderer,
      };
    });
    assert.equal(result.nodes, count + 1);
    assert.equal(
      result.edges,
      density === 'complete'
        ? (count * (count - 1)) / 2 + count
        : 4 * (((count / 4) * (count / 4 - 1)) / 2) + count,
      '完整边集不得抽样',
    );
    assert(result.finite && result.painted);
    const gpuExpected =
      !canvasFallback &&
      (await page.evaluate(
        () => window.relationLayoutQa.graph.edges.length >= window.relationLayoutQa.gpuThreshold,
      ));
    assert.equal(result.gpuInstances, gpuExpected ? result.edges : 0, 'GPU 绘制必须保留全部边');
    if (gpuExpected) assert(result.gpuPainted, 'GPU 连线画布必须存在实际像素');
    if ((count === 1000 || counts.length === 1) && process.env.WEQ_RELATION_GPU_SCREENSHOT)
      await page.screenshot({ path: process.env.WEQ_RELATION_GPU_SCREENSHOT });
    if (count === 200 && gpuExpected) {
      await page.evaluate(() =>
        document
          .querySelector('.weq-graph-edge-canvas')
          .getContext('webgl2')
          .getExtension('WEBGL_lose_context')
          .loseContext(),
      );
      await page.waitForFunction(
        () =>
          document.querySelector('.weq-graph-edge-canvas').hidden &&
          window.workerQa.cpuStrokes > window.relationLayoutQa.graph.nodes.length,
      );
    }
    // 从当前画布位置点击并拖动，验证命令经过真实 Worker，而非仅验证静态画布。
    const target = await page.evaluate(() => window.workerCircles[0]);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => Boolean(window.relationLayoutQa.selected));
    const dragStart = await page.evaluate(() => window.workerQa.commands.length);
    const freshTarget = await page.evaluate(() => window.workerCircles[0]);
    await page.mouse.move(freshTarget.x, freshTarget.y);
    await page.mouse.down();
    await page.mouse.move(freshTarget.x + 30, freshTarget.y + 20, { steps: 4 });
    await page.mouse.up();
    assert(
      await page.evaluate(() => window.workerQa.commands.some((command) => command.type === 'pin')),
    );
    assert(
      await page.evaluate(() =>
        window.workerQa.commands.some((command) => command.type === 'release'),
      ),
    );
    assert(
      await page.evaluate(
        (start) =>
          window.workerQa.commands.slice(start).filter((command) => command.type === 'pin').length >
          1,
        dragStart,
      ),
      '真实拖动必须连续固定节点，而不是只命中一次点击',
    );
    const scaleBefore = await page.evaluate(() => window.workerQa.scale);
    await page.mouse.wheel(0, -180);
    await page.waitForFunction((scale) => window.workerQa.scale > scale, scaleBefore);
    await page.getByRole('button', { name: '适应全部', exact: true }).click();
    result.p95InputDelayMs = await page.evaluate(() => {
      const delays = window.workerQa.inputDelays.toSorted((a, b) => a - b);
      return delays[Math.floor(delays.length * 0.95)];
    });
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
  const summary = {
    production,
    electron,
    canvasFallback,
    density,
    report,
    lifecycle: 'passed',
    retry: 'passed',
    errors,
  };
  if (process.env.WEQ_RELATION_WORKER_OUTPUT)
    await writeFile(
      process.env.WEQ_RELATION_WORKER_OUTPUT,
      `${JSON.stringify(summary, null, 2)}\n`,
      { flag: 'wx' },
    );
  console.log(JSON.stringify(summary));
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

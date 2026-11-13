import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { _electron } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const { default: executablePath } = await import('electron');
const outDir = await mkdtemp(resolve(root, 'node_modules/.relation-physics-'));
const userData = await mkdtemp(resolve(root, 'node_modules/.relation-electron-'));
const baseline = process.env.WEQ_RELATION_PHYSICS_BASELINE_REF;
const layoutPath = resolve(root, 'src/renderer/src/components/relationGraph/graphLayout.ts');
const baselineSource = baseline
  ? execFileSync(
      'git',
      ['show', `${baseline}:apps/desktop/src/renderer/src/components/relationGraph/graphLayout.ts`],
      { cwd: root, encoding: 'utf8' },
    )
  : null;
const baselinePlugin = () => ({
  name: 'physics-baseline',
  enforce: 'pre',
  transform(_code, id) {
    if (id === layoutPath && baselineSource) return baselineSource;
  },
});
let app;
let stderr = '';
let closing = false;
try {
  await build({
    configFile: false,
    root,
    base: './',
    plugins: [baselinePlugin()],
    worker: { plugins: () => [baselinePlugin()] },
    build: {
      outDir,
      rollupOptions: { input: resolve(root, 'test/browser/relation-physics.html') },
    },
  });
  app = await _electron.launch({
    executablePath,
    args: [resolve(root, 'test/browser/relation-worker-electron.cjs')],
    env: { ...process.env, WEQ_RELATION_USER_DATA: userData },
  });
  app.process().stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  app.process().on('exit', (code, signal) => {
    if (!closing)
      console.error(JSON.stringify({ unexpectedElectronExit: { code, signal }, stderr }));
  });
  const page = await app.firstWindow();
  page.on('crash', () => console.error('physics renderer crashed'));
  page.on('pageerror', (error) => console.error(`physics page error: ${error.message}`));
  await page.goto(pathToFileURL(resolve(outDir, 'test/browser/relation-physics.html')).href);
  await page.waitForFunction(() => typeof window.runPhysicsProfile === 'function');
  const report = {
    date: new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      dateStyle: 'short',
      timeStyle: 'long',
    }).format(new Date()),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    baseline,
    hotComplete: process.env.WEQ_RELATION_HOT_COMPLETE === '1',
    runtime: await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    })),
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: totalmem() / 1024 ** 3,
    },
    method:
      'production Electron file:// Web Worker; synchronous real D3 tick; no draw/transport/timer waiting; remainder = tick minus four measured forces',
    rounds: [],
  };
  const output = process.env.WEQ_RELATION_PHYSICS_OUTPUT;
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const counts = (process.env.WEQ_RELATION_COUNTS ?? '100,200,500,1000').split(',').map(Number);
  const shapes = (process.env.WEQ_RELATION_SHAPES ?? 'star,clusters,complete').split(',');
  assert(counts.every((count) => [100, 200, 500, 1000].includes(count)));
  assert(shapes.every((shape) => ['star', 'clusters', 'complete'].includes(shape)));
  const cases = counts.flatMap((count) =>
    shapes.map((shape) => ({ count, shape, hot: report.hotComplete })),
  );
  // 先暖热四种力的调用路径；正式轮次交替正反序，减少单向规模顺序偏差。
  await page.evaluate((hot) => window.runPhysicsProfile(100, 'complete', hot), report.hotComplete);
  const rounds = Number(process.env.WEQ_RELATION_ROUNDS ?? 3);
  for (let round = 0; round < rounds; round++) {
    for (const fixture of round % 2 ? cases.toReversed() : cases) {
      const result = await page.evaluate(
        ({ count, shape, hot }) => window.runPhysicsProfile(count, shape, hot),
        fixture,
      );
      const { count, shape } = fixture;
      assert.equal(result.nodes, count + 1);
      const edges =
        shape === 'star'
          ? count
          : shape === 'clusters'
            ? 4 * (((count / 4) * (count / 4 - 1)) / 2) + count
            : (count * (count - 1)) / 2 + count;
      assert.equal(result.edges, edges);
      assert(result.finite);
      report.rounds.push({ round, count, shape, ...result });
      if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        JSON.stringify({
          round,
          count,
          shape,
          edges,
          initMs: result.initializationMs,
          phases: Object.fromEntries(
            Object.entries(result.phases).map(([name, data]) => [
              name,
              { meanMs: data.tick.meanMs, p95Ms: data.tick.p95Ms },
            ]),
          ),
        }),
      );
      await page.waitForTimeout(100);
    }
  }
  if (output) console.log(`report: ${output}`);
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  closing = true;
  await app?.close();
  await rm(outDir, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}

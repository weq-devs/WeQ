import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testSummary } from './test-summary.mjs';
import { fileCosts } from './test-timing-reporter.mjs';
import BalancedSequencer, {
  balancedShards,
  costOf,
} from '../apps/desktop/test/support/ci-sequencer.mjs';

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { load } = libraryRequire('js-yaml');
const workflow = load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);

test('类型检查分组覆盖每个包和桌面端两个配置，保留完整汇总门禁', () => {
  const suites = workflow.jobs['typecheck-suites'];
  assert.equal(suites.strategy['fail-fast'], false);
  assert.deepEqual(suites.strategy.matrix.suite, [
    'desktop-node',
    'desktop-web',
    'web',
    'packages',
  ]);
  const checks = suites.steps.filter((step) => step.name?.startsWith('Type-check '));
  assert.equal(checks.length, 4);
  for (const target of ['node', 'web']) {
    const step = checks.find((step) => step.if === `matrix.suite == 'desktop-${target}'`);
    assert.equal(step.run, `pnpm --filter @weq/desktop typecheck:${target}`);
  }
  assert.equal(
    checks.find((step) => step.if === "matrix.suite == 'web'").run,
    'pnpm --filter @weq/web typecheck',
  );
  const packages = checks.find((step) => step.if === "matrix.suite == 'packages'");
  assert.equal(packages.run, "pnpm -r --filter './packages/*' --no-bail typecheck");
  for (const directory of ['apps', 'packages']) {
    for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      let manifest;
      try {
        manifest = JSON.parse(
          readFileSync(new URL(`../${directory}/${name}/package.json`, import.meta.url)),
        );
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      if (!manifest.scripts?.typecheck) continue;
      if (directory === 'apps') assert.ok(['desktop', 'web'].includes(name), `${name} 未分组`);
      else assert.equal(manifest.scripts.typecheck, 'tsc --noEmit');
    }
  }
  const gate = workflow.jobs.typecheck;
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['typecheck-suites']);
  assert.equal(gate.steps[0].env.RESULT, `\${{ needs.typecheck-suites.result }}`);
  assert.equal(gate.steps[0].run, 'test "$RESULT" = success');
});

test('类型缓存按平台、分组和编译配置区分，命中缓存也不能跳过检查', () => {
  const steps = workflow.jobs['typecheck-suites'].steps;
  const cache = steps.find((step) => step.uses === 'actions/cache@v4');
  assert.ok(cache);
  const paths = cache.with.path.trim().split('\n');
  assert.deepEqual(paths, [
    'apps/desktop/out/types-node/*.tsbuildinfo',
    'apps/desktop/out/types-web/*.tsbuildinfo',
    'apps/web/*.tsbuildinfo',
    'packages/*/*.tsbuildinfo',
  ]);
  const prefix = cache.with['restore-keys'].trim();
  assert.equal(cache.with.key, `${prefix}\${{ github.sha }}`);
  for (const field of ['runner.os', 'runner.arch', 'matrix.suite']) {
    assert.ok(prefix.includes(`\${{ ${field} }}`));
  }
  for (const input of [
    'pnpm-lock.yaml',
    'package.json',
    'tsconfig.base.json',
    'apps/*/tsconfig*.json',
    'packages/*/tsconfig*.json',
    'apps/*/package.json',
    'packages/*/package.json',
  ])
    assert.ok(prefix.includes(`'${input}'`), `${input} 必须参与缓存失效`);
  for (const step of steps.filter((step) => step.name?.startsWith('Type-check '))) {
    assert.doesNotMatch(step.if, /cache|hash|changed/);
  }
});

test('实际 tsc 增量信息不会掩盖依赖修改、删除或编译选项引入的错误', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weq-typecheck-cache-'));
  try {
    const config = {
      compilerOptions: {
        strict: true,
        incremental: true,
        noEmit: true,
        types: [],
        tsBuildInfoFile: './cache.tsbuildinfo',
      },
      include: ['*.ts'],
    };
    writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify(config));
    writeFileSync(resolve(root, 'dependency.ts'), 'export const value = 1;');
    writeFileSync(
      resolve(root, 'consumer.ts'),
      "import { value } from './dependency';\nconst n: number = value;",
    );
    const compile = () =>
      spawnSync(process.execPath, [desktopRequire.resolve('typescript/bin/tsc'), '-p', root], {
        encoding: 'utf8',
      });
    assert.equal(compile().status, 0);
    const cached = readFileSync(resolve(root, 'cache.tsbuildinfo'));
    assert.equal(compile().status, 0);
    assert.deepEqual(readFileSync(resolve(root, 'cache.tsbuildinfo')), cached);
    writeFileSync(resolve(root, 'dependency.ts'), 'export const value = "wrong";');
    const changed = compile();
    assert.equal(changed.status, 2);
    assert.match(changed.stdout, /TS2322/);
    rmSync(resolve(root, 'dependency.ts'));
    const deleted = compile();
    assert.equal(deleted.status, 2);
    assert.match(deleted.stdout, /TS2307/);
    writeFileSync(resolve(root, 'dependency.ts'), 'export const value = 1;');
    assert.equal(compile().status, 0);
    config.compilerOptions.noUnusedLocals = true;
    writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify(config));
    const stricter = compile();
    assert.equal(stricter.status, 2);
    assert.match(stricter.stdout, /TS6133/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('安装中的 Vitest 与桌面成本分片器覆盖全部真实测试文件且每文件恰好一次', async () => {
  const { BaseSequencer } = await import(desktopRequire.resolve('vitest/node'));
  for (const [directory, count] of [
    ['apps/desktop', 6],
    ['packages/service', 2],
  ]) {
    const root = fileURLToPath(new URL(`../${directory}/`, import.meta.url));
    const files = readdirSync(resolve(root, 'test'), { recursive: true })
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => ({ moduleId: resolve(root, 'test', name) }));
    assert.ok(files.length > count);
    const assigned = [];
    for (let index = 1; index <= count; index++) {
      const Sequencer = directory === 'apps/desktop' ? BalancedSequencer : BaseSequencer;
      const sequencer = new Sequencer({ config: { root, shard: { index, count } } });
      const shard = await sequencer.shard(files);
      assert.ok(shard.length > 0);
      assigned.push(...shard.map((file) => file.moduleId));
    }
    assert.equal(new Set(assigned).size, assigned.length, `${directory} 不能重复分配`);
    assert.deepEqual(assigned.sort(), files.map((file) => file.moduleId).sort());
  }
});

test('分片稳定、与输入顺序和 checkout 路径无关，新文件及失效权重也完整覆盖', async () => {
  const timings = { a: 10, b: 9, c: 8, d: 7, e: 6, f: 0, g: -1, h: null };
  const files = Object.keys(timings).concat('new');
  const cost = (file) => costOf(file, timings);
  const shards = balancedShards(files, 3, cost, (file) => file);
  assert.deepEqual(
    balancedShards([...files].reverse(), 3, cost, (file) => file),
    shards,
  );
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  for (const file of ['f', 'g', 'h', 'new']) assert.equal(cost(file), 8);
  assert.equal(costOf('new', {}), 1);
  const loads = shards.map((shard) => shard.reduce((sum, file) => sum + cost(file), 0));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 10);
  assert.throws(() => balancedShards(files, 0, cost, (file) => file), /正整数/);
  for (const count of [1, 2, 6, 12]) {
    const groups = balancedShards(files, count, cost, (file) => file);
    assert.equal(groups.length, count);
    assert.deepEqual(groups.flat().sort(), [...files].sort());
  }
  const assignments = [];
  for (const root of ['/checkout/a', '/another/checkout']) {
    const sequencer = new BalancedSequencer({ config: { root, shard: { index: 1, count: 6 } } });
    assignments.push(
      (await sequencer.shard(files.map((file) => ({ moduleId: `${root}/${file}` })))).map((file) =>
        sequencer.key(file),
      ),
    );
  }
  assert.deepEqual(...assignments);
  const invalid = new BalancedSequencer({
    config: { root: '/project', shard: { index: 0, count: 6 } },
  });
  await assert.rejects(invalid.shard([]), /越界/);
  assert.deepEqual(
    balancedShards([], 2, cost, (file) => file),
    [[], []],
  );
  const { BaseSequencer } = await import(desktopRequire.resolve('vitest/node'));
  const ctx = {
    config: { root: '/project' },
    cache: {
      getFileTestResults: () => undefined,
      getFileStats: (key) => ({ size: key.includes('large') ? 20 : 10 }),
    },
  };
  const localFiles = ['small', 'large'].map((name) => ({
    moduleId: `/project/${name}`,
    project: { name: '' },
  }));
  assert.deepEqual(
    await new BalancedSequencer(ctx).sort(localFiles),
    await new BaseSequencer(ctx).sort(localFiles),
  );
});

test('实测成本基线有效且均衡后最大分片成本不高于原生分片', async (t) => {
  const baseline = JSON.parse(
    readFileSync(new URL('../apps/desktop/test/ci-timings.json', import.meta.url)),
  );
  assert.equal(baseline.version, 1);
  assert.ok(Object.keys(baseline.files).length > 0);
  for (const [file, cost] of Object.entries(baseline.files)) {
    assert.match(file, /^test\/.*\.test\.ts$/);
    assert.ok(Number.isFinite(cost) && cost > 0);
  }
  const { BaseSequencer } = await import(desktopRequire.resolve('vitest/node'));
  const root = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
  const files = readdirSync(resolve(root, 'test'), { recursive: true })
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({ moduleId: resolve(root, 'test', name) }));
  const costs = [[], []];
  for (let index = 1; index <= 6; index++) {
    for (const [kind, Sequencer] of [BaseSequencer, BalancedSequencer].entries()) {
      const sequencer = new Sequencer({ config: { root, shard: { index, count: 6 } } });
      const assigned = await sequencer.shard(files);
      costs[kind].push(
        assigned.reduce(
          (sum, file) => sum + costOf(file.moduleId.slice(root.length).replaceAll('\\', '/')),
          0,
        ),
      );
    }
  }
  assert.ok(Math.max(...costs[1]) <= Math.max(...costs[0]));
  t.diagnostic(`文件成本之和（毫秒，非墙钟）：原生 ${costs[0]}；均衡 ${costs[1]}`);
});

test('耗时权重包含模块收集、环境、准备和执行，不将并行文件总成本称为墙钟', () => {
  assert.deepEqual(
    fileCosts('/project', [
      {
        filepath: '/project/test/a.test.ts',
        prepareDuration: 10,
        environmentLoad: 20,
        collectDuration: 30,
        setupDuration: 5,
        result: { duration: 7 },
      },
      {
        filepath: '/project/test/b.test.ts',
        collectDuration: Number.NaN,
        result: { duration: -1 },
      },
    ]),
    { 'test/a.test.ts': 72, 'test/b.test.ts': 1 },
  );
});

test('大包分片连续无缺口，其他包和 Web 仍完整运行，全部结果汇总到稳定门禁', () => {
  const suites = workflow.jobs['test-suites'];
  assert.equal(suites.strategy['fail-fast'], false);
  const matrix = suites.strategy.matrix.include;
  assert.equal(matrix.length, 9);
  for (const [suite, count] of [
    ['desktop', 6],
    ['service', 2],
  ]) {
    assert.deepEqual(
      matrix.filter((entry) => entry.suite === suite).map((entry) => entry.shard),
      Array.from({ length: count }, (_, index) => `${index + 1}/${count}`),
    );
  }
  assert.deepEqual(
    matrix.filter((entry) => entry.suite === 'core'),
    [{ suite: 'core', shard: 'all' }],
  );
  const core = suites.steps.find((step) => step.if === "matrix.suite == 'core'");
  assert.match(core.run, /--filter '!@weq\/desktop' --filter '!@weq\/service'/);
  assert.match(core.run, /--no-sort --no-bail --workspace-concurrency=2 test/);
  const shard = suites.steps.find((step) => step.name === 'Run desktop or service shard');
  assert.match(shard.run, /--shard=\$\{\{ matrix.shard \}\}/);
  assert.doesNotMatch(shard.run, /--bail|--changed|--passWithNoTests|--no-isolate|--retry/);
  assert.match(shard.run, /--reporter=\.\.\/\.\.\/scripts\/test-timing-reporter\.mjs/);
  assert.equal(shard.env.WEQ_TEST_TIMINGS, `\${{ runner.temp }}/test-timings.json`);
  const artifact = suites.steps.find((step) => step.name === 'Preserve test results');
  assert.match(artifact.with.path, /test-timings\.json/);
  const desktopConfig = readFileSync(
    new URL('../apps/desktop/vitest.config.ts', import.meta.url),
    'utf8',
  );
  assert.match(desktopConfig, /sequence: \{ sequencer: BalancedSequencer \}/);
  assert.equal(workflow.jobs.test.if, 'always()');
  assert.deepEqual(workflow.jobs.test.needs, ['test-suites', 'dev-bootstrap']);
  const bootstrap = workflow.jobs['dev-bootstrap'];
  assert.deepEqual(bootstrap.strategy.matrix.os, [
    'ubuntu-latest',
    'windows-latest',
    'macos-latest',
  ]);
  assert(!bootstrap.steps.some((step) => /pnpm install/.test(step.run ?? '')));
  assert(
    bootstrap.steps.some((step) =>
      /pnpm exec node --test scripts\/dev.test.mjs scripts\/dev-native.test.mjs/.test(
        step.run ?? '',
      ),
    ),
  );
  assert.equal(workflow.jobs.test.steps[0].env.DEV_RESULT, `\${{ needs.dev-bootstrap.result }}`);
  assert.equal(
    workflow.jobs.test.steps[0].run,
    'test "$RESULT" = success && test "$DEV_RESULT" = success',
  );
});

test('报告保留失败、跳过和慢文件信息，不把用例时间当 CI 墙钟时间', () => {
  const report = {
    numPassedTests: 3,
    numFailedTests: 1,
    numPendingTests: 2,
    testResults: [
      { name: '/runner/fast.test.ts', startTime: 0, endTime: 10, status: 'passed' },
      { name: '/runner/slow|test.ts', startTime: 0, endTime: 1200, status: 'failed' },
    ],
  };
  const summary = testSummary(report);
  assert.match(summary, /通过 3，失败 1，待运行\/跳过 2/);
  assert.ok(summary.indexOf('slow test.ts') < summary.indexOf('fast.test.ts'));
  assert.match(summary, /1.20s \| failed/);
  assert.match(summary, /### 失败文件/);
  assert.match(summary, /不包含完整的依赖收集与环境初始化/);
  assert.equal(report.testResults[0].name, '/runner/fast.test.ts');
  assert.throws(() => testSummary({}), /缺少 testResults/);
});

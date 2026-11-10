import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testSummary } from './test-summary.mjs';

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { load } = libraryRequire('js-yaml');
const workflow = load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);

test('安装中的 Vitest 分片器覆盖全部真实测试文件且每文件恰好一次', async () => {
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
      const sequencer = new BaseSequencer({ config: { root, shard: { index, count } } });
      const shard = await sequencer.shard(files);
      assert.ok(shard.length > 0);
      assigned.push(...shard.map((file) => file.moduleId));
    }
    assert.equal(new Set(assigned).size, assigned.length, `${directory} 不能重复分配`);
    assert.deepEqual(assigned.sort(), files.map((file) => file.moduleId).sort());
  }
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
  assert.equal(workflow.jobs.test.if, 'always()');
  assert.deepEqual(workflow.jobs.test.needs, ['test-suites']);
  assert.equal(workflow.jobs.test.steps[0].run, 'test "$RESULT" = success');
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

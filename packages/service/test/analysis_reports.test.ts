import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisReportsService, type SavedAnalysisRequest } from '../src/account/analysis_reports';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const request: SavedAnalysisRequest = {
  id: 'report-1',
  kind: 'group',
  name: '测试群',
  groupCode: '10001',
  period: '全部',
  scope: { expectedAccountUin: '10002', expectedAccountConfigId: 'fixture' },
};
async function fixture(run: ConstructorParameters<typeof AnalysisReportsService>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'weq-analysis-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new AnalysisReportsService(root, run);
  cleanups.push(() => service.dispose());
  return { root, service };
}
it('持久保存真实结果及阅读位置，重开不重新计算', async () => {
  const run = vi.fn(async (_request, stage) => ({ stage, exact: 9007199254740993n }));
  const { root, service } = await fixture(run);
  await service.create(request);
  await service.resume(request.id);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('completed'));
  await service.position(request.id, 420);
  await service.dispose();
  cleanups.pop();
  const reopened = new AnalysisReportsService(root, run);
  cleanups.push(() => reopened.dispose());
  expect(await reopened.get(request.id)).toMatchObject({
    status: 'completed',
    position: 420,
    results: { report: { exact: 9007199254740993n } },
  });
  await reopened.resume(request.id);
  expect(run).toHaveBeenCalledTimes(3);
  await reopened.cancel(request.id);
  expect((await reopened.get(request.id)).status).toBe('completed');
  await reopened.revise(request.id, { startTime: 10, endTime: 20 });
  await vi.waitFor(async () => expect((await reopened.get(request.id)).resultRevision).toBe(2));
  expect((await reopened.versions(request.id)).map((row) => row.resultRevision)).toEqual([2, 1]);
  expect(await reopened.version(request.id, 1)).toMatchObject({
    results: { report: { exact: 9007199254740993n } },
  });
  expect((await reopened.version(request.id, 1))?.request.scope.startTime).toBeUndefined();
  expect((await reopened.version(request.id, 2))?.request.scope.startTime).toBe(10);
});
it('失败保留已完成阶段，继续只重算未完成部分', async () => {
  let fail = true;
  const run = vi.fn(async (_request, stage) => {
    if (stage === 'batches' && fail) throw new Error('暂不可读');
    return { stage };
  });
  const { service } = await fixture(run);
  await service.create(request);
  await service.resume(request.id);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('failed'));
  fail = false;
  await service.resume(request.id);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('completed'));
  expect(run.mock.calls.map((call) => call[1])).toEqual(['report', 'batches', 'batches', 'graph']);
});
it('移除任务不删除报告，重新分析恢复任务；旧入口可打开改过范围的报告', async () => {
  const { service } = await fixture(async () => ({ count: 2 }));
  await service.create(request);
  await service.resume(request.id);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('completed'));
  await service.hideTask(request.id);
  expect(await service.get(request.id)).toMatchObject({
    taskHidden: true,
    results: { report: { count: 2 } },
  });
  await service.revise(request.id, { startTime: 10, endTime: 20 });
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('completed'));
  expect(await service.create(request)).toMatchObject({
    taskHidden: false,
    request: { scope: { startTime: 10, endTime: 20 } },
  });
});
it('刷新失败保留上次成功结果，切号退出使未完成任务待继续', async () => {
  let fail = false;
  const { root, service } = await fixture(async () => {
    if (fail) throw new Error('读取失败');
    return { count: 7 };
  });
  await service.create(request);
  await service.resume(request.id);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('completed'));
  fail = true;
  await service.resume(request.id, true);
  await vi.waitFor(async () => expect((await service.get(request.id)).status).toBe('failed'));
  expect((await service.get(request.id)).results.report).toEqual({ count: 7 });
  const unfinished = new AnalysisReportsService(
    join(root, 'unfinished'),
    async (_request, _stage, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    },
  );
  await unfinished.create(request);
  await unfinished.resume(request.id);
  await vi.waitFor(async () =>
    expect((await unfinished.get(request.id)).logs.length).toBeGreaterThan(0),
  );
  await unfinished.dispose();
  const reopened = new AnalysisReportsService(join(root, 'unfinished'), async () => null);
  cleanups.push(() => reopened.dispose());
  expect((await reopened.get(request.id)).status).toBe('paused');
  await reopened.remove(request.id);
  expect(await reopened.list()).toEqual([]);
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPerformanceMonitor, type PerformanceMonitor } from '@weq/service/performance';
import { createNodeCollector } from '@weq/service/performance-node';
import { setHost, type HostBridge } from '@weq/service';
import { performanceMonitorRouter } from '../src/main/ipc/routers/performance_monitor';
let root: string, monitor: PerformanceMonitor;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-performance-router-'));
  monitor = installPerformanceMonitor(
    root,
    createNodeCollector(() => ({ database: null })),
  );
  await monitor.ready;
  setHost({
    pickSaveTarget: async ({ defaultName }) => ({
      path: join(root, defaultName),
      downloadId: null,
    }),
    registerDownload: (_path, name) => ({ url: `/_download/${name}` }),
  } as HostBridge);
});
afterAll(async () => {
  await monitor.dispose();
  await rm(root, { force: true, recursive: true });
});
const first = performanceMonitorRouter.createCaller({}),
  second = performanceMonitorRouter.createCaller({});
it('无账号的两个客户端共用宿主配置，完整档默认一小时', async () => {
  const before = Date.now();
  await first.configure({ mode: 'full', retentionDays: 7, capacityMiB: 128 });
  const status = await second.status();
  expect(status.settings.mode).toBe('full');
  expect(status.settings.fullUntil).toBeGreaterThanOrEqual(before + 3600_000);
  expect(status.host).toBe('web');
  await second.configure({ mode: 'light', retentionDays: 7, capacityMiB: 128 });
  expect((await first.status()).settings.mode).toBe('light');
});
it('降低保存策略须明确确认，公开容量与时间范围校验有效', async () => {
  await expect(
    first.configure({ mode: 'light', retentionDays: 1, capacityMiB: 64 }),
  ).rejects.toThrow('确认');
  await first.configure({ mode: 'light', retentionDays: 1, capacityMiB: 64, confirmPrune: true });
  await expect(first.history({ from: 100, to: 0 })).rejects.toThrow();
  await expect(
    first.configure({ mode: 'full', retentionDays: 0, capacityMiB: 64 }),
  ).rejects.toThrow();
});
it('分页 JSONL 与聚合 CSV 导出使用真实文件，Web 返回下载入口', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await monitor.flush();
  const range = { from: Date.now() - 60_000, to: Date.now() + 1, buckets: 100 };
  const json = await first.export({ range, format: 'jsonl' });
  expect(json?.downloadUrl).toContain('/_download/');
  const lines = (await readFile(json!.path, 'utf8')).trim().split('\n');
  expect(lines.every((line) => JSON.parse(line).version === 1)).toBe(true);
  const csv = await second.export({ range, format: 'csv' });
  expect(await readFile(csv!.path, 'utf8')).toContain(
    'start,end,process,segment,count,metric,min,max,mean',
  );
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  PerformanceMonitor,
  normalizeMonitorSettings,
  DEFAULT_MONITOR_SETTINGS,
  sqliteWorkerExecArgv,
  type MonitorCollector,
  type MonitorRecord,
} from '../src/performance';
import { performanceWorker } from '../src/performance/worker';
import { createNodeCollector } from '../src/performance/node';
import {
  beginRequestMetric,
  enableRequestMetrics,
  requestMetrics,
} from '../src/performance/requests';

const roots: string[] = [],
  monitors: PerformanceMonitor[] = [],
  workers: Worker[] = [];
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'weq-performance-'));
  roots.push(path);
  return path;
}
function collector(): MonitorCollector {
  return {
    host: 'web',
    capabilities: ['cpu'],
    activate: vi.fn(),
    dispose: vi.fn(),
    collect: vi.fn(async () => ({
      syncMs: 1,
      waitMs: 0,
      processes: [
        {
          key: '42:1',
          label: '测试进程',
          pid: 42,
          createdAt: 1,
          metrics: {
            cpuPercent: 5,
            residentBytes: 1024,
            heapBytes: 512,
            externalBytes: null,
            eventLoopP95Ms: null,
          },
        },
      ],
    })),
  };
}
async function monitor() {
  const source = collector(),
    service = new PerformanceMonitor(await root(), source);
  monitors.push(service);
  await service.ready;
  return { service, source };
}
async function worker() {
  const instance = new Worker(`(${performanceWorker.toString()})(require)`, {
    eval: true,
    workerData: { path: join(await root(), 'history.sqlite') },
  });
  workers.push(instance);
  let sequence = 0;
  return <T>(method: string, input: object = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++sequence;
      const listener = (reply: { id: number; value: T; error?: string }) => {
        if (reply.id !== id) return;
        instance.off('message', listener);
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.value);
      };
      instance.on('message', listener);
      instance.postMessage({ id, method, input });
    });
}
afterEach(async () => {
  for (const service of monitors.splice(0)) await service.dispose();
  for (const instance of workers.splice(0)) await instance.terminate();
  vi.useRealTimers();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('宿主性能监视', () => {
  it('最低 Node 22.12 的 SQLite 开关仅传给需要它的 Worker', () => {
    expect(sqliteWorkerExecArgv('22.12.0')).toEqual(['--experimental-sqlite']);
    expect(sqliteWorkerExecArgv('22.13.0')).toBeUndefined();
    expect(sqliteWorkerExecArgv('23.3.0')).toEqual(['--experimental-sqlite']);
    expect(sqliteWorkerExecArgv('23.4.0')).toBeUndefined();
    expect(sqliteWorkerExecArgv('24.22.1')).toBeUndefined();
  });
  it('配置损坏时停止采集并保留历史，不在维护重试时静默覆盖设置', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const path = await root();
    await mkdir(join(path, 'performance-monitor'));
    const db = new DatabaseSync(join(path, 'performance-monitor/history.sqlite'));
    db.exec(
      "CREATE TABLE settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL); INSERT INTO settings VALUES(1,'broken');",
    );
    db.close();
    const source = collector(),
      service = new PerformanceMonitor(path, source);
    monitors.push(service);
    await service.ready;
    expect((await service.status()).error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_001);
    await service.status();
    expect(source.collect).not.toHaveBeenCalled();
    const check = new DatabaseSync(join(path, 'performance-monitor/history.sqlite'));
    expect(check.prepare('SELECT data FROM settings').get()!.data).toBe('broken');
    check.close();
  });
  it('真实 SQLite 写锁失败被报告，失败批次不无限重试，解锁后恢复写入', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { service } = await monitor();
    await vi.advanceTimersByTimeAsync(1);
    const db = new DatabaseSync(join(service.root, 'performance-monitor/history.sqlite'));
    db.exec('BEGIN IMMEDIATE');
    try {
      await service.flush();
      const status = await service.status();
      expect(status.error).toContain('locked');
      expect(status.dropped).toBeGreaterThan(0);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
    await vi.advanceTimersByTimeAsync(60_001);
    await service.flush();
    await service.status();
    expect((await service.status()).error).toBeNull();
  });
  it('设置严格校验；缺失不冒充有效设置', () => {
    expect(normalizeMonitorSettings(DEFAULT_MONITOR_SETTINGS)).toEqual(DEFAULT_MONITOR_SETTINGS);
    for (const patch of [
      { retentionDays: 0 },
      { retentionDays: 366 },
      { capacityMiB: 1 },
      { fullUntil: NaN },
      { mode: 'debug' },
      { version: 2 },
    ])
      expect(() => normalizeMonitorSettings({ ...DEFAULT_MONITOR_SETTINGS, ...patch })).toThrow();
  });
  it('默认轻量；关闭即停止采样，仍可查看历史；设置跨实例恢复', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { service, source } = await monitor();
    expect(service.settings).toEqual(DEFAULT_MONITOR_SETTINGS);
    await vi.advanceTimersByTimeAsync(1);
    await service.flush();
    const history = await service.history({
      from: Date.now() - 60_000,
      to: Date.now() + 1,
      buckets: 100,
    });
    expect(history.points).toHaveLength(1);
    await service.configure({ ...DEFAULT_MONITOR_SETTINGS, mode: 'off' });
    const count = vi.mocked(source.collect).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(source.collect).toHaveBeenCalledTimes(count);
    expect(source.activate).toHaveBeenLastCalledWith('off');
    expect((await service.status()).settings.mode).toBe('off');
    const path = service.root;
    await service.dispose();
    monitors.splice(monitors.indexOf(service), 1);
    const restored = new PerformanceMonitor(path, collector());
    monitors.push(restored);
    await restored.ready;
    expect(restored.settings.mode).toBe('off');
    expect((await restored.status()).records).toBeGreaterThan(0);
  });
  it('完整档到期回轻量；重启恢复剩余截止时间', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { service } = await monitor(),
      until = Date.now() + 60_000;
    await service.configure({ ...DEFAULT_MONITOR_SETTINGS, mode: 'full', fullUntil: until });
    const path = service.root;
    await service.dispose();
    monitors.splice(monitors.indexOf(service), 1);
    const restored = new PerformanceMonitor(path, collector());
    monitors.push(restored);
    await restored.ready;
    expect(restored.settings.fullUntil).toBe(until);
    await vi.advanceTimersByTimeAsync(60_001);
    // SQLite 回应来自真实 Worker，不由假定时器推进。
    for (let i = 0; i < 10 && restored.settings.mode === 'full'; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await restored.status();
    expect(restored.settings.mode).toBe('light');
  });
  it('采样未完成时切档不保留旧结果，清空不会被在途采样补回', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { service, source } = await monitor();
    let done!: (value: Awaited<ReturnType<MonitorCollector['collect']>>) => void;
    vi.mocked(source.collect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(1);
    const change = service.configure({ ...DEFAULT_MONITOR_SETTINGS, mode: 'off' });
    await Promise.resolve();
    done({ processes: [], syncMs: 0, waitMs: 0 });
    await change;
    await service.clear();
    expect((await service.status()).records).toBe(0);
    expect(vi.mocked(source.collect).mock.calls).toHaveLength(1);
  });
  it('Node 采集无需账号，缺失指标为 null；自身请求不计入业务统计', async () => {
    const node = createNodeCollector(() => ({ database: null }));
    node.activate('full');
    const first = requestMetrics(),
      own = beginRequestMetric('performanceMonitor.status');
    own();
    expect(requestMetrics()).toEqual(first);
    const finish = beginRequestMetric('account.list');
    finish(true);
    finish(true);
    expect(requestMetrics().completed).toBe(first.completed + 1);
    const sample = await node.collect(true);
    node.dispose();
    expect(sample.processes[0]!.metrics.cpuPercent).toBeNull();
    expect(sample.processes[0]!.details?.database).toBeNull();
    enableRequestMetrics(false);
  });
  it('暂停写入期间队列最多 120 条，达到上限丢弃最旧数据', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { service } = await monitor();
    const flush = vi.spyOn(service, 'flush').mockResolvedValue();
    for (let i = 0; i < 125; i++) await vi.advanceTimersByTimeAsync(30_001);
    const status = await service.status();
    expect(status.queued).toBe(120);
    expect(status.dropped).toBeGreaterThan(0);
    flush.mockRestore();
    await service.flush();
    expect((await service.status()).queued).toBe(0);
  });
});

describe('性能历史 Worker', () => {
  it('导出与清空串行，独占创建保护现有文件', async () => {
    const request = await worker(),
      at = Date.now(),
      path = join(await root(), 'export.jsonl');
    const records: MonitorRecord[] = Array.from({ length: 250 }, (_, i) => ({
      version: 1,
      session: 's',
      segment: 's',
      kind: 'event',
      at: at - 1000 + i,
      event: 'startup',
      intervalMs: 0,
    }));
    await request('batch', { records, settings: DEFAULT_MONITOR_SETTINGS });
    const exporting = request('export-file', {
      path,
      format: 'jsonl',
      range: { from: at - 2000, to: at, buckets: 100 },
    });
    const clearing = request('clear');
    await Promise.all([exporting, clearing]);
    const content = await readFile(path, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(250);
    await expect(
      request('export-file', {
        path,
        format: 'jsonl',
        range: { from: at - 2000, to: at, buckets: 100 },
      }),
    ).rejects.toThrow('EEXIST');
    expect(await readFile(path, 'utf8')).toBe(content);
    expect((await request<{ records: number }>('status')).records).toBe(0);
  });
  it('聚合保留峰值、缺测和进程会话；分页导出与明细一致', async () => {
    const request = await worker(),
      now = Date.now();
    const records: MonitorRecord[] = [1, 50, 2].map((cpu, index) => ({
      version: 1,
      session: 'session',
      segment: index === 2 ? 'after-gap' : 'before-gap',
      kind: 'sample',
      at: now - 1000 + index * 100,
      intervalMs: 30_000,
      processes: [
        {
          key: index === 2 ? '42:2' : '42:1',
          label: '进程',
          pid: 42,
          createdAt: index === 2 ? 2 : 1,
          metrics: {
            cpuPercent: cpu,
            residentBytes: null,
            heapBytes: 10,
            externalBytes: null,
            eventLoopP95Ms: null,
          },
        },
      ],
    }));
    await request('batch', { records, settings: DEFAULT_MONITOR_SETTINGS });
    const history = await request<import('../src/performance').MonitorHistory>('history', {
      from: now - 2000,
      to: now,
      buckets: 1,
    });
    expect(history.points).toHaveLength(2);
    expect(history.points[0]!.metrics.cpuPercent).toEqual({ min: 1, max: 50, mean: 25.5 });
    expect(history.points[0]!.metrics.residentBytes.mean).toBeNull();
    expect(history.points[0]!.process).not.toBe(history.points[1]!.process);
    const detail = await request<MonitorRecord>('detail', { id: history.points[0]!.id });
    expect(detail.processes![0]!.metrics.cpuPercent).toBe(50);
    const page = await request<{ rows: string[]; next: number | null }>('export', {
      from: now - 2000,
      to: now,
    });
    expect(page.rows.map((row) => JSON.parse(row))).toEqual(records);
  });
  it('按时间删除旧数据，清空后实际文件空间回收，附属文件计入容量', async () => {
    const request = await worker(),
      now = Date.now();
    const records = [-8, -1].map(
      (day): MonitorRecord => ({
        version: 1,
        session: 'session',
        segment: 'segment',
        at: now + day * 86400_000,
        kind: 'event',
        intervalMs: 30_000,
        event: 'startup',
      }),
    );
    await request('batch', { records, settings: DEFAULT_MONITOR_SETTINGS });
    const status = await request<{ records: number; bytes: number; oldest: number }>('status');
    expect(status.records).toBe(1);
    expect(status.oldest).toBe(records[1]!.at);
    expect(status.bytes).toBeGreaterThan(0);
    await request('clear');
    expect((await request<{ records: number }>('status')).records).toBe(0);
  });
  it('容量清理删除最旧记录并回收 SQLite 空闲页', async () => {
    const request = await worker(),
      at = Date.now();
    // 使用内部小配额验证物理回收；公开接口只接受 64/128/256/512 MiB。
    const records = Array.from(
      { length: 60 },
      (_, i): MonitorRecord => ({
        version: 1,
        session: 's',
        segment: 's',
        at: at - 1000 + i,
        kind: 'event',
        intervalMs: 0,
        event: `${i}:${'x'.repeat(16_384)}`,
      }),
    );
    await request('batch', {
      records,
      settings: { ...DEFAULT_MONITOR_SETTINGS, capacityMiB: 0.25 },
    });
    const status = await request<{ records: number; bytes: number; oldest: number | null }>(
      'status',
    );
    expect(status.records).toBeLessThan(60);
    expect(status.bytes).toBeLessThan(0.25 * 1048576);
  });
});

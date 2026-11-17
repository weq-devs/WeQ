import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleDatabase, SLOW_DATABASE_OPERATION_MS } from '@weq/db';
import { configureDevelopmentLogging } from '../src/common/development_logging';
import {
  configureConsoleLogger,
  flushConsoleLogger,
  getLogger,
  initLogger,
} from '../src/common/logger';
import { currentOperationId, withLogOperation } from '../src/common/operation_log';
import { logRequest } from '../src/common/request_log';

const cleanup = vi.hoisted(() => ({ stops: [] as Array<() => void> }));
vi.mock('@weq/db', async (original) => {
  const db = await original<typeof import('@weq/db')>();
  return {
    ...db,
    observeSlowDatabaseOperations: (
      ...args: Parameters<typeof db.observeSlowDatabaseOperations>
    ) => {
      const stop = db.observeSlowDatabaseOperations(...args);
      cleanup.stops.push(stop);
      return stop;
    },
  };
});

const directories: string[] = [];
afterEach(() => {
  for (const stop of cleanup.stops.splice(0)) stop();
  configureConsoleLogger({ development: false, processName: 'test', env: {} });
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '0');
  const directory = mkdtempSync(join(tmpdir(), 'weq-slow-log-'));
  directories.push(directory);
  initLogger(directory);
  configureDevelopmentLogging(true, 'test');
  const lines: string[] = [];
  configureConsoleLogger({
    development: true,
    processName: 'test',
    env: {},
    color: false,
    now: () => Date.UTC(2026, 0, 1, 16),
    sink: (line) => lines.push(line),
  });
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  return {
    lines,
    at: (value: number) => (time = value),
    records: (scope = 'database') =>
      readdirSync(join(directory, 'logs'))
        .flatMap((file) =>
          readFileSync(join(directory, 'logs', file), 'utf8')
            .trim()
            .split('\n'),
        )
        .map((line) => JSON.parse(line))
        .filter((record) => record.context?.scope === scope),
  };
}

it('终端精简和启动投影不改变文件中的原始事件与字段', () => {
  const f = fixture();
  configureConsoleLogger({
    development: true,
    processName: 'desktop-main',
    env: {},
    color: false,
    detailEvents: new Set(['logger:init']),
    startup: { startedAt: Date.now() - 100, restarting: true, warning: false },
    sink: (line) => f.lines.push(line),
  });
  getLogger().info('fixture detail', { scope: 'logger', event: 'init', logDir: '/fixture/logs' });
  getLogger().info('fixture ready', {
    scope: 'desktop-main',
    event: 'app-ready',
    fixtureField: 'kept',
  });
  expect(f.lines).toHaveLength(1);
  expect(f.lines[0]).toContain('应用重启就绪');
  expect(f.records('logger')).toContainEqual(
    expect.objectContaining({
      message: 'fixture detail',
      context: { scope: 'logger', event: 'init', logDir: '/fixture/logs' },
    }),
  );
  expect(f.records('desktop-main')).toEqual([
    expect.objectContaining({
      message: 'fixture ready',
      context: { scope: 'desktop-main', event: 'app-ready', fixtureField: 'kept' },
    }),
  ]);
});

it('一次慢操作在终端和文件中仅记一条，定位真实操作并汇总其排队影响', async () => {
  const f = fixture();
  const path = '/synthetic/log-impact.db';
  let release!: () => void;
  let operationId: string | undefined;
  const first = withLogOperation(() => {
    operationId = currentOperationId();
    return scheduleDatabase(path, () => new Promise<void>((done) => (release = done)), undefined, {
      caller: 'FixtureReader.read',
      fingerprint: 'aaaaaaaaaaaaaaaa',
    });
  });
  f.at(100);
  const waiting = Array.from({ length: 20 }, () =>
    withLogOperation(() => scheduleDatabase(path, async () => 1)),
  );
  f.at(3200);
  release();
  await Promise.all([first, ...waiting]);
  expect(f.lines).toEqual([
    '00:00:00 WARN  database  慢操作  FixtureReader.read  原生等待 3.2s  受影响查询 20  最长阻塞 3.1s\n',
  ]);
  expect(f.records()).toEqual([
    expect.objectContaining({
      level: 'warn',
      message: '数据库慢操作',
      context: expect.objectContaining({
        operationId,
        event: 'database-slow',
        caller: 'FixtureReader.read',
        fingerprint: 'aaaaaaaaaaaaaaaa',
        nativePromiseAwaitMs: 3200,
        affectedQueryCount: 20,
        maxBlockedMs: 3100,
      }),
    }),
  ]);
});

it('连续慢操作各自保留一条，不因相同队列合并或重复记录后续排队查询', async () => {
  const f = fixture();
  const path = '/synthetic/log-consecutive.db';
  let release!: () => void;
  const first = scheduleDatabase(
    path,
    () => new Promise<void>((done) => (release = done)),
    undefined,
    {
      caller: 'FixtureReader.first',
      fingerprint: 'aaaaaaaaaaaaaaaa',
    },
  );
  const second = scheduleDatabase(path, async () => f.at(1400), undefined, {
    caller: 'FixtureReader.second',
    fingerprint: 'bbbbbbbbbbbbbbbb',
  });
  const third = scheduleDatabase(path, async () => 3);
  f.at(600);
  release();
  await Promise.all([first, second, third]);
  expect(f.lines).toHaveLength(2);
  expect(f.records().map((record) => record.context)).toEqual([
    expect.objectContaining({
      caller: 'FixtureReader.first',
      affectedQueryCount: 2,
      maxBlockedMs: 600,
    }),
    expect.objectContaining({
      caller: 'FixtureReader.second',
      affectedQueryCount: 1,
      maxBlockedMs: 800,
    }),
  ]);
});

it('重复慢请求及数据库操作仅合并终端，文件保留各次耗时和关联详情', async () => {
  const f = fixture();
  let time = 0;
  for (const [index, durationMs] of [1200, 3600, 1800].entries()) {
    await logRequest('trpc', 'account.getOnlineStatus', 'query', async () => {
      time += durationMs;
      f.at(time);
      await scheduleDatabase(
        '/synthetic/log-repeated.db',
        async () => {
          time += durationMs;
          f.at(time);
        },
        undefined,
        {
          caller: 'FixtureReader.read',
          fingerprint: 'aaaaaaaaaaaaaaaa',
        },
      );
    });
    expect(f.lines).toHaveLength(2);
    expect(f.records()).toHaveLength(index + 1);
  }
  flushConsoleLogger();
  expect(f.lines).toHaveLength(4);
  expect(f.lines[2]).toContain('慢操作汇总  FixtureReader.read  本轮 3 次');
  expect(f.lines[2]).toContain('原生等待 1.2～3.6s，均值 2.2s');
  expect(f.lines[3]).toContain('慢请求汇总  account.getOnlineStatus  本轮 3 次');
  expect(f.lines[3]).toContain('耗时 2.4～7.2s，均值 4.4s');
  const records = f.records();
  expect(records.map((record) => record.context.nativePromiseAwaitMs)).toEqual([1200, 3600, 1800]);
  expect(new Set(records.map((record) => record.context.operationId)).size).toBe(3);
  const requests = f.records('trpc');
  expect(requests.map((record) => record.context.durationMs)).toEqual([2400, 7200, 3600]);
  expect(requests.map((record) => record.context.operationId)).toEqual(
    records.map((record) => record.context.operationId),
  );
});

it.each(['failed', 'cancelled'] as const)('被阻塞查询自身 %s 时仍保留独立记录', async (outcome) => {
  const f = fixture();
  const path = `/synthetic/log-${outcome}.db`;
  let release!: () => void;
  const first = scheduleDatabase(path, () => new Promise<void>((done) => (release = done)));
  const error =
    outcome === 'cancelled' ? new DOMException('取消', 'AbortError') : new Error('失败');
  const second = scheduleDatabase(path, async () => {
    throw error;
  });
  const rejected = expect(second).rejects.toBe(error);
  f.at(SLOW_DATABASE_OPERATION_MS + 1);
  release();
  await Promise.all([first, rejected]);
  expect(f.records()).toEqual([
    expect.objectContaining({ context: expect.objectContaining({ event: 'database-slow' }) }),
    expect.objectContaining({
      level: outcome === 'failed' ? 'warn' : 'debug',
      context: expect.objectContaining({ event: `database-${outcome}`, outcome }),
    }),
  ]);
  expect(f.lines).toHaveLength(outcome === 'failed' ? 2 : 1);
});

it('不把刚好达到阈值的操作记为慢操作，不输出空的影响字段', async () => {
  const f = fixture();
  const path = '/synthetic/log-boundary.db';
  await scheduleDatabase(path, async () => f.at(SLOW_DATABASE_OPERATION_MS));
  expect(f.records()).toEqual([]);
  expect(f.lines).toEqual([]);
  await scheduleDatabase(path, async () => f.at(SLOW_DATABASE_OPERATION_MS * 2 + 1));
  expect(f.records()).toHaveLength(1);
  expect(f.records()[0].context).not.toHaveProperty('affectedQueryCount');
  expect(f.lines[0]).not.toContain('受影响查询');
  expect(f.lines[0]).not.toContain('最长阻塞');
});

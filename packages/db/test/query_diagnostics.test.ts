import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { QqDb } from '../src/qq_db';
import type { NtHelperBinding } from '@weq/native';
import {
  databasePerformance,
  scheduleDatabase,
  withDatabasePriority,
  promoteDatabaseSignal,
  measureMessageWork,
  observeSlowDatabaseOperations,
  SLOW_DATABASE_OPERATION_MS,
} from '../src/query_schedule';
import { ACTIVE_QUERY_DIAGNOSTIC_LIMIT, withDatabaseRequest } from '../src/query_diagnostics';

afterEach(() => vi.unstubAllEnvs());

it('独立诊断可采样低于告警阈值的等待，不改变默认告警订阅', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const warning = vi.fn(),
    diagnostic = vi.fn();
  const stopWarning = observeSlowDatabaseOperations(warning);
  const stopDiagnostic = observeSlowDatabaseOperations(diagnostic, SLOW_DATABASE_OPERATION_MS / 4);
  try {
    await scheduleDatabase('/synthetic/separate-observation.db', async () => {
      now += SLOW_DATABASE_OPERATION_MS / 2;
    });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
    stopDiagnostic();
    await scheduleDatabase('/synthetic/separate-observation.db', async () => {
      now += SLOW_DATABASE_OPERATION_MS / 2;
    });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  } finally {
    stopWarning();
    stopDiagnostic();
    clock.mockRestore();
  }
});

it.each([
  [200, false],
  [500, false],
  [SLOW_DATABASE_OPERATION_MS - 1, false],
  [SLOW_DATABASE_OPERATION_MS, false],
  [SLOW_DATABASE_OPERATION_MS + 1, true],
] as const)('排队与原生等待 %sms 的阈值边界均正确', async (elapsed, warn) => {
  let now = 0;
  let release!: () => void;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const samples: Array<{ jsQueueWaitMs: number; nativePromiseAwaitMs: number }> = [];
  const stop = observeSlowDatabaseOperations((sample) => samples.push(sample));
  try {
    const path = `/synthetic/warning-boundary-${elapsed}.db`;
    const first = scheduleDatabase(
      path,
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const second = scheduleDatabase(path, async () => []);
    now = elapsed;
    release();
    await Promise.all([first, second]);
    expect(samples).toHaveLength(warn ? 2 : 0);
    if (warn) {
      expect(samples.some((sample) => sample.nativePromiseAwaitMs === elapsed)).toBe(true);
      expect(samples.some((sample) => sample.jsQueueWaitMs === elapsed)).toBe(true);
    }
  } finally {
    stop();
    clock.mockRestore();
  }
});

it('未开启完整诊断时仍归因超过阈值的原生读取，不泄露 SQL 或参数', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '');
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const samples: unknown[] = [];
  const stop = observeSlowDatabaseOperations((sample) => samples.push(sample));
  const path = '/synthetic/slow-source.db';
  const nt = {
    executeSql: async () => {
      now += SLOW_DATABASE_OPERATION_MS + 1;
      return [];
    },
  } as unknown as NtHelperBinding;
  const db = new QqDb(nt, { dbPath: path });
  class FixtureReader {
    read() {
      return db.query('SELECT ?', ['不得记录的 UID']);
    }
  }
  try {
    await new FixtureReader().read();
    expect(samples).toEqual([
      expect.objectContaining({
        nativePromiseAwaitMs: SLOW_DATABASE_OPERATION_MS + 1,
        fingerprint: createHash('sha256').update('SELECT ?').digest('hex').slice(0, 16),
        caller: 'FixtureReader.read',
      }),
    ]);
    for (const forbidden of [path, 'SELECT', '不得记录的 UID'])
      expect(JSON.stringify(samples)).not.toContain(forbidden);
    expect(databasePerformance(path).diagnostics).toMatchObject({ enabled: false, queries: [] });
  } finally {
    stop();
    clock.mockRestore();
  }
});

it('默认不开启逐查询采样；启用后只记录指纹与调用点，不记录 SQL、参数和路径', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '');
  const path = '/synthetic/diagnostic-source.db';
  const nt = { executeSql: vi.fn(async () => []) } as unknown as NtHelperBinding;
  const db = new QqDb(nt, { dbPath: path });
  class FixtureReader {
    read() {
      return db.query('SELECT ?', ['正文与 UID 均不得泄露']);
    }
  }
  await db.query('SELECT ?', ['未采样参数']);
  expect(databasePerformance(path).diagnostics).toMatchObject({ enabled: false, queries: [] });
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  await withDatabaseRequest('message.window', () =>
    measureMessageWork(path, 'messagePage', () => new FixtureReader().read()),
  );
  const result = databasePerformance(path).diagnostics;
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({
    operation: 'message.window',
    outcome: 'ok',
    queryCount: 1,
  });
  expect(result.queries[0]).toMatchObject({
    requestId: result.requests[0]?.id,
    phase: 'messagePage',
    fingerprint: createHash('sha256').update('SELECT ?').digest('hex').slice(0, 16),
    outcome: 'ok',
    caller: 'FixtureReader.read',
    returnedRows: 0,
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [path, 'SELECT', '未采样参数', '正文与 UID 均不得泄露'])
    expect(serialized).not.toContain(forbidden);
});

it('在途长查询能与排队请求关联，跨库不会误标成阻塞者，后台提升仍生效', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/diagnostic-blocker.db';
  let release!: () => void;
  const blocker = withDatabasePriority('background', () =>
    scheduleDatabase(
      path,
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    ),
  );
  const controller = new AbortController();
  const first = withDatabaseRequest('message.window', () =>
    withDatabasePriority(
      'background',
      () => scheduleDatabase(path, async () => [1]),
      controller.signal,
    ),
  );
  const independent = scheduleDatabase('/synthetic/diagnostic-independent.db', async () => 1);
  let state = databasePerformance(path).diagnostics;
  expect(state.queries[0]).toMatchObject({ outcome: 'running', priority: 'background' });
  expect(state.queries[1]).toMatchObject({
    outcome: 'queued',
    runningWhenQueued: state.queries[0]?.id,
  });
  expect(
    databasePerformance('/synthetic/diagnostic-independent.db').diagnostics.queries[0]
      ?.runningWhenQueued,
  ).toBeNull();
  promoteDatabaseSignal(controller.signal);
  release();
  await Promise.all([blocker, first, independent]);
  state = databasePerformance(path).diagnostics;
  expect(state.queries[1]).toMatchObject({
    outcome: 'ok',
    priority: 'interactive',
    returnedRows: 1,
  });
  expect(state.queries[1]?.jsQueueWaitMs).toBeGreaterThanOrEqual(0);
});

it('取消与失败原样传播，排队取消不虚构原生执行时间', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/diagnostic-errors.db';
  let release!: () => void;
  const blocker = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const controller = new AbortController();
  const pending = withDatabaseRequest('message.window', () =>
    withDatabasePriority(
      'interactive',
      () => scheduleDatabase(path, async () => 1),
      controller.signal,
    ),
  );
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  release();
  await Promise.all([blocker, rejected]);
  const failure = new Error('敏感错误内容');
  await expect(
    withDatabaseRequest('message.window', () =>
      scheduleDatabase(path, async () => {
        throw failure;
      }),
    ),
  ).rejects.toBe(failure);
  const state = databasePerformance(path).diagnostics;
  expect(state.queries[1]).toMatchObject({
    outcome: 'cancelled',
    nativePromiseAwaitMs: null,
    startedAtMs: null,
  });
  expect(state.queries[2]?.outcome).toBe('failed');
  expect(state.requests.map((request) => request.outcome)).toEqual(['cancelled', 'failed']);
  expect(JSON.stringify(state)).not.toContain(failure.message);
});

it('逐查询历史有界，关闭后不再暴露已有诊断记录', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/diagnostic-bounds.db';
  for (let i = 0; i < 300; i++) await scheduleDatabase(path, async () => []);
  const state = databasePerformance(path).diagnostics;
  expect(state.queries.length).toBe(state.recentLimit);
  expect(state.queries.length).toBeLessThan(300);
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '');
  expect(databasePerformance(path).diagnostics.queries).toEqual([]);
});

it('并行请求与嵌套阶段不串号，多个阶段保持同一请求关联', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/diagnostic-context.db';
  await Promise.all([
    withDatabaseRequest('message.window', async () => {
      await new Promise<void>((done) => setImmediate(done));
      await measureMessageWork(path, 'messagePage', () => scheduleDatabase(path, async () => []));
      await measureMessageWork(path, 'replyCache', () => scheduleDatabase(path, async () => []));
    }),
    withDatabaseRequest('message.window', () =>
      measureMessageWork(path, 'roamingCache', () => scheduleDatabase(path, async () => [])),
    ),
  ]);
  const snapshot = databasePerformance(path).diagnostics;
  expect(snapshot.requests).toHaveLength(2);
  expect(snapshot.requests.map((request) => request.queryCount).sort()).toEqual([1, 2]);
  const first = snapshot.queries.find((query) => query.phase === 'messagePage');
  const reply = snapshot.queries.find((query) => query.phase === 'replyCache');
  const roaming = snapshot.queries.find((query) => query.phase === 'roamingCache');
  expect(first?.requestId).toBe(reply?.requestId);
  expect(first?.requestId).not.toBe(roaming?.requestId);
});

it('历史轮转后仍能观察旧在途任务，不因大量排队记录丢失阻塞现场', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '1');
  const path = '/synthetic/diagnostic-active.db';
  let release!: () => void;
  const blocker = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const firstId = databasePerformance(path).diagnostics.queries[0]?.id;
  const pending = Array.from({ length: 300 }, () => scheduleDatabase(path, async () => []));
  const snapshot = databasePerformance(path).diagnostics;
  expect(snapshot.queries.find((query) => query.id === firstId)?.outcome).toBe('running');
  expect(snapshot.queries.length).toBeLessThanOrEqual(
    (snapshot.recentLimit ?? 0) + ACTIVE_QUERY_DIAGNOSTIC_LIMIT,
  );
  release();
  await Promise.all([blocker, ...pending]);
});

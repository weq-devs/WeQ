import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TokenUsageStore, type TokenUsageRecord } from '../src/account/agentlab_usage';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(seed?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-api-usage-'));
  dirs.push(dir);
  const path = join(dir, 'usage.json');
  if (seed) writeFileSync(path, JSON.stringify(seed));
  return { path, store: new TokenUsageStore(path) };
}
const entry: TokenUsageRecord = {
  ts: 1_790_000_000_000,
  requestId: 'fixture-request',
  model: 'fixture',
  kind: 'chat',
  scope: 'intent-analysis',
  feature: 'intent-analysis',
  status: 'pending',
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

it('同一请求的 pending、usage、结束与重复回调只计一次，重试独立计数', () => {
  const f = fixture();
  f.store.record(entry);
  expect(f.store.getStats()).toMatchObject({ totalCalls: 1, unknownCalls: 1, pendingCalls: 1 });
  const known = {
    ...entry,
    status: 'success' as const,
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
  };
  f.store.record(known);
  f.store.record(known);
  f.store.record(entry);
  expect(f.store.getStats()).toMatchObject({
    totalCalls: 1,
    totalTokens: 12,
    unknownCalls: 0,
    pendingCalls: 0,
    knownCalls: 1,
  });
  f.store.record({ ...entry, requestId: 'retry', status: 'failed' });
  expect(f.store.getStats()).toMatchObject({
    totalCalls: 2,
    totalTokens: 12,
    unknownCalls: 1,
    failedCalls: 1,
  });
  expect(new TokenUsageStore(f.path).getStats()).toMatchObject({ totalCalls: 2, totalTokens: 12 });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toHaveLength(2);
});

it('失败、取消与缺 usage 分开计数，本地推理不写 API 账本', () => {
  const f = fixture();
  f.store.record({ ...entry, status: 'failed' });
  f.store.record({
    ...entry,
    requestId: 'cancelled',
    status: 'cancelled',
    promptTokens: 2,
    completionTokens: 1,
    totalTokens: 3,
  });
  f.store.record({ ...entry, requestId: 'local', source: 'local', totalTokens: 999 });
  expect(f.store.getStats()).toMatchObject({
    totalCalls: 2,
    unknownCalls: 1,
    failedCalls: 1,
    cancelledCalls: 1,
    totalTokens: 3,
  });
  expect(f.store.getStats().byFeature).toEqual([
    { feature: 'intent-analysis', calls: 2, tokens: 3, unknownCalls: 1 },
  ]);
  expect(f.store.getStats().byPersona[0]?.personaId).not.toBe('__assistant__');
});

it('进程重启后未结束请求标为中断，保留未知费用，不继续显示进行中', () => {
  const f = fixture([entry]);
  expect(f.store.getStats()).toMatchObject({
    totalCalls: 1,
    pendingCalls: 0,
    interruptedCalls: 1,
    unknownCalls: 1,
  });
});

it('切回同一来源时在途回调与新会话共享账本，不将仍在运行的请求当成中断', () => {
  const f = fixture();
  f.store.record(entry);
  const reopened = new TokenUsageStore(f.path);
  expect(reopened.getStats()).toMatchObject({ pendingCalls: 1, interruptedCalls: 0 });
  reopened.record({ ...entry, requestId: 'new-session', status: 'success', totalTokens: 5 });
  f.store.record({ ...entry, status: 'success', totalTokens: 12 });
  expect(reopened.getStats()).toMatchObject({ totalCalls: 2, totalTokens: 17, pendingCalls: 0 });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toHaveLength(2);
});

it('总量和输入的真实零值不丢失，缺少的输出仍为未知', () => {
  const f = fixture();
  f.store.record({ ...entry, status: 'success', totalTokens: 0, promptTokens: 0 });
  expect(f.store.getStats()).toMatchObject({
    knownCalls: 1,
    unknownCalls: 0,
    totalTokens: 0,
    promptUnknownCalls: 0,
    completionUnknownCalls: 1,
  });
});

it('旧账目仍读取，非法计数不会污染汇总；账号账本互不混合，全局测试独立合并', () => {
  const a = fixture([
      {
        ...entry,
        requestId: undefined,
        status: undefined,
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
      },
      { ...entry, requestId: 'bad', totalTokens: -3 },
    ]),
    b = fixture(),
    global = fixture();
  const reloaded = new TokenUsageStore(a.path);
  b.store.record({ ...entry, totalTokens: 100 });
  global.store.record({
    ...entry,
    requestId: 'global-test',
    scope: 'connection-test',
    feature: 'connection-test',
    status: 'success',
  });
  expect(reloaded.getStats(global.store)).toMatchObject({
    totalCalls: 3,
    globalCalls: 1,
    totalTokens: 6,
    unknownCalls: 2,
  });
  expect(b.store.getStats()).toMatchObject({ totalCalls: 1, totalTokens: 100 });
});

it('同名模型按服务商及 API／TTS 配置身份分开，旧记录保持未知来源', () => {
  const f = fixture();
  for (const [requestId, providerId, kind] of [
    ['a', 'first', 'chat'],
    ['b', 'second', 'chat'],
    ['c', 'first', 'speech'],
    ['legacy', undefined, 'chat'],
  ] as const) {
    f.store.record({
      ...entry,
      requestId,
      providerId,
      providerName: '同名配置',
      kind,
      totalTokens: 3,
    });
  }
  const stats = f.store.getStats();
  expect(stats.byModel).toHaveLength(4);
  expect(new Set(stats.byModel.map((row) => row.key)).size).toBe(4);
  expect(stats.byModel.find((row) => row.providerId === null)).toMatchObject({
    providerName: null,
    calls: 1,
    tokens: 3,
  });
});

it('时间筛选同时作用于全局／账号、状态、分组和趋势，按北京时间包含当天', () => {
  const now = Date.parse('2026-11-13T04:30:00+08:00');
  const f = fixture(),
    global = fixture();
  f.store.record({
    ...entry,
    requestId: 'old',
    ts: Date.parse('2026-11-06T23:59:59+08:00'),
    totalTokens: 100,
  });
  f.store.record({
    ...entry,
    requestId: 'edge',
    ts: Date.parse('2026-11-07T00:00:00+08:00'),
    totalTokens: 5,
    status: 'failed',
  });
  global.store.record({ ...entry, requestId: 'global', ts: now, totalTokens: null });
  const stats = f.store.getStats(global.store, '7d', now);
  expect(stats).toMatchObject({
    totalCalls: 2,
    totalTokens: 5,
    globalCalls: 1,
    accountCalls: 1,
    unknownCalls: 1,
    failedCalls: 1,
  });
  expect(stats.byFeature[0]).toMatchObject({ calls: 2, tokens: 5 });
  expect(stats.byDay).toHaveLength(7);
  expect(stats.byDay[0]).toMatchObject({ day: '2026-11-07', calls: 1, tokens: 5 });
  expect(stats.byDay.at(-1)).toMatchObject({ day: '2026-11-13', calls: 1, unknownCalls: 1 });
  expect(f.store.getStats(global.store, '24h', now)).toMatchObject({
    totalCalls: 1,
    totalTokens: 0,
  });
  expect(f.store.getStats(global.store, 'retained', now).totalCalls).toBe(3);
});

it('保留上限与最早记录对外可见，不将截断后的总量冒充历史累计', () => {
  const seed = Array.from({ length: 5001 }, (_, i) => ({
    ...entry,
    requestId: `r-${i}`,
    ts: entry.ts + i,
    totalTokens: 1,
  }));
  const f = fixture(seed);
  expect(f.store.getStats()).toMatchObject({
    totalCalls: 5000,
    ledgers: [
      {
        source: 'account',
        retainedCalls: 5000,
        limit: 5000,
        atCapacity: true,
        firstRecordAt: entry.ts + 1,
      },
    ],
  });
});

it('损坏账本的读取错误不伪装成零请求，不覆盖原件', () => {
  const f = fixture();
  const path = join(dirs.at(-1)!, 'broken.json');
  writeFileSync(path, '{broken');
  const broken = new TokenUsageStore(path);
  expect(() => broken.getStats()).toThrow('API 用量记录读取失败');
  broken.record(entry);
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  expect(f.store.getStats().totalCalls).toBe(0);
});

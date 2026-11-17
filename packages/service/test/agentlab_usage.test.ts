import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beginApiUsage } from '@weq/agentlab';
import { JsonStore } from '../src/common/json_store';
import { TokenUsageStore, type TokenUsageRecord } from '../src/account/agentlab_usage';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

it('满额账本处理两千帧流式输出只落盘开始、真实用量和结束三次', () => {
  const f = fixture(
    Array.from({ length: 4999 }, (_, index) => ({
      ...entry,
      requestId: `history-${index}`,
      status: 'success',
    })),
  );
  const saves = vi.spyOn(JsonStore.prototype, 'save');
  const usage = beginApiUsage(
    {
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture',
      model: 'fixture',
      onUsage: (record) => f.store.record({ ...record, ts: record.startedAt!, scope: 'build' }),
    },
    true,
  );
  for (let index = 0; index < 2000; index++)
    usage.report({ choices: [{ delta: { content: '合成片段' } }] });
  expect(saves).toHaveBeenCalledOnce();
  usage.report({ usage: { prompt_tokens: 10, completion_tokens: 2000, total_tokens: 2010 } });
  usage.finish('success');
  expect(saves).toHaveBeenCalledTimes(3);
  const rows = JSON.parse(readFileSync(f.path, 'utf8'));
  expect(rows).toHaveLength(5000);
  expect(rows.at(-1)).toMatchObject({ status: 'success', totalTokens: 2010 });
});

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
    byCategory: [expect.objectContaining({ category: 'intent', calls: 1, tokens: 12 })],
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
  expect(stats.byCategory).toEqual([
    expect.objectContaining({
      category: 'intent',
      calls: 2,
      tokens: 5,
      unknownCalls: 1,
      features: [
        { feature: 'intent-analysis', label: '意图分析', calls: 2, tokens: 5, unknownCalls: 1 },
      ],
    }),
  ]);
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

it('功能用量按业务与用途联合汇总，共用图片能力不串类或重复计数', () => {
  const f = fixture();
  for (const [index, [scope, feature, kind]] of (
    [
      ['build', '表达风格库', 'chat'],
      ['build', '深层画像 1/5', 'chat'],
      ['build', '深层画像分块', 'chat'],
      ['chat', undefined, 'embedding'],
      ['chat', 'tts-synthesis', 'speech'],
      ['assistant', 'assistant-image', 'vision'],
      ['chat', 'cloneChat-image', 'vision'],
      ['build', 'cloneTraining-image', 'vision'],
      ['intent-image', 'intent-image', 'vision'],
      ['suggestions-image', 'suggestions-image', 'vision'],
      ['profile-image', 'profile-image', 'vision'],
      ['connection-test', 'capability-test', 'chat'],
    ] as const
  ).entries()) {
    f.store.record({
      ...entry,
      requestId: `category-${index}`,
      scope,
      feature,
      kind,
      totalTokens: index === 0 ? null : 10,
    });
  }
  const stats = f.store.getStats();
  const clone = stats.byCategory.find((row) => row.category === 'clone');
  expect(clone).toMatchObject({ label: '克隆会话', calls: 7, tokens: 60, unknownCalls: 1 });
  expect(clone?.features).toEqual(
    expect.arrayContaining([
      { feature: 'expressions', label: '表达风格库', calls: 1, tokens: 0, unknownCalls: 1 },
      {
        feature: 'deep-profile-chunk',
        label: '深层画像分块',
        calls: 2,
        tokens: 20,
        unknownCalls: 0,
      },
      { feature: 'embedding', label: '向量检索与索引', calls: 1, tokens: 10, unknownCalls: 0 },
      { feature: 'tts-synthesis', label: '语音合成', calls: 1, tokens: 10, unknownCalls: 0 },
      { feature: 'image-analysis', label: '图片分析', calls: 2, tokens: 20, unknownCalls: 0 },
    ]),
  );
  expect(stats.byCategory.map((row) => row.category).sort()).toEqual([
    'assistant',
    'clone',
    'intent',
    'profile',
    'settings',
    'suggestions',
  ]);
  for (const row of stats.byCategory) {
    for (const metric of ['calls', 'tokens', 'unknownCalls'] as const)
      expect(row.features.reduce((sum, child) => sum + child[metric], 0)).toBe(row[metric]);
  }
  expect(stats.byCategory.reduce((sum, row) => sum + row.calls, 0)).toBe(stats.totalCalls);
  expect(stats.byCategory.reduce((sum, row) => sum + row.tokens, 0)).toBe(stats.totalTokens);
  expect(stats.byFeature.find((row) => row.feature === '表达风格库')?.calls).toBe(1);
});

it('未知分类名与对象原型属性同名时仍按原名保留', () => {
  const f = fixture();
  for (const feature of ['constructor', '__proto__', 'toString']) {
    f.store.record({ ...entry, requestId: feature, scope: feature, feature });
  }
  expect(f.store.getStats().byCategory).toEqual([
    expect.objectContaining({
      category: 'other',
      calls: 3,
      features: expect.arrayContaining(
        ['constructor', '__proto__', 'toString'].map((feature) =>
          expect.objectContaining({ feature, label: feature, calls: 1 }),
        ),
      ),
    }),
  ]);
});

it('旧记录与未知功能不猜业务来源，已知用途归类，未知名称保留', () => {
  const f = fixture([
    { ...entry, requestId: 'legacy', scope: 'build', feature: undefined },
    { ...entry, requestId: 'expression', scope: 'other', feature: '表达风格库' },
    { ...entry, requestId: 'tts', scope: 'tts', feature: 'tts-synthesis', kind: 'speech' },
    { ...entry, requestId: 'image', scope: 'other', feature: 'image-analysis', kind: 'vision' },
    { ...entry, requestId: 'unknown', scope: 'other', feature: '未知用途' },
    { ...entry, requestId: 'known-scope', scope: 'assistant', feature: '自定义用途' },
    { ...entry, requestId: 'tts-test', scope: 'tts', feature: 'tts-test', kind: 'speech' },
  ]);
  const stats = f.store.getStats();
  expect(stats.byCategory.find((row) => row.category === 'clone')?.features).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ feature: 'build', label: '构建克隆（未细分）' }),
      expect.objectContaining({ feature: 'expressions', label: '表达风格库' }),
    ]),
  );
  expect(stats.byCategory.find((row) => row.category === 'speech')).toMatchObject({ calls: 1 });
  expect(stats.byCategory.find((row) => row.category === 'recognition')).toMatchObject({
    calls: 1,
  });
  expect(stats.byCategory.find((row) => row.category === 'other')?.features).toEqual([
    expect.objectContaining({ label: '未知用途' }),
  ]);
  expect(stats.byCategory.find((row) => row.category === 'assistant')?.features).toEqual([
    expect.objectContaining({ label: '自定义用途' }),
  ]);
  expect(stats.byCategory.find((row) => row.category === 'settings')).toMatchObject({ calls: 1 });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))[0].feature).toBeUndefined();
});

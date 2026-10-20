import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StatsStore } from '../../bot/src/stats';
import type { UsageSink } from '@weq/agentlab';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const entry: Parameters<UsageSink['record']>[0] = {
  requestId: 'fixture',
  ts: Date.now(),
  model: 'fixture',
  kind: 'chat',
  scope: 'chat',
  status: 'pending',
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-bot-usage-'));
  dirs.push(dir);
  return new StatsStore(join(dir, 'stats.json'));
}

it('bot 对同一请求的多次回调按增量更新，不重复累加次数或 Token', () => {
  const store = fixture();
  store.record(entry);
  const complete = {
    ...entry,
    status: 'success' as const,
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
  };
  store.record(complete);
  store.record(complete);
  store.record(entry);
  expect(store.snapshot().totals).toMatchObject({ llmCalls: 1, totalTokens: 12, unknownCalls: 0 });
  expect(store.snapshot().byModel[0]).toMatchObject({ calls: 1, totalTokens: 12 });
});

it('bot 失败和取消保留未知／已知计数，本地推理不入 API 汇总', () => {
  const store = fixture();
  store.record({ ...entry, status: 'failed' });
  store.record({ ...entry, requestId: 'cancel', status: 'cancelled', totalTokens: 3 });
  store.record({ ...entry, requestId: 'local', source: 'local', totalTokens: 999 });
  expect(store.snapshot().totals).toMatchObject({
    llmCalls: 2,
    totalTokens: 3,
    unknownCalls: 1,
    failedCalls: 1,
    cancelledCalls: 1,
  });
});

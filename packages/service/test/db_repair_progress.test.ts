import { expect, it } from 'vitest';
import { DatabaseProgressTracker, databaseStepPercent } from '../src/account/db_repair/progress';

it('百分比仅来自真实分母，不把无总量字段数或零分母变为整体进度', () => {
  expect(databaseStepPercent({ step: 'pages', message: '', completed: 25, total: 40 })).toBe(62.5);
  for (const tick of [
    { completed: 999 },
    { completed: 0, total: 0 },
    { completed: -1, total: 3 },
    { completed: Number.NaN, total: 2 },
    { completed: 1, total: Infinity },
  ])
    expect(databaseStepPercent({ step: 'test', message: '', ...tick })).toBeUndefined();
});

it('同一步骤累计真实计数与速度，切换步骤重新计时并保留不可变历史', () => {
  let now = 1000;
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db', () => now);
  const first = tracker.update('Scan', {
    step: 'pages',
    message: '扫描',
    completed: 0,
    total: 100,
    unit: 'pages',
  });
  now += 500;
  const counted = tracker.update('Scan', {
    step: 'pages',
    message: '扫描',
    completed: 50,
    total: 100,
    unit: 'pages',
  });
  expect(counted.current.rate).toBe(100);
  expect(counted.steps).toHaveLength(1);
  expect(first.current.completed).toBe(0);
  now += 500;
  const next = tracker.update('Repair', {
    step: 'data',
    message: '重建',
    completed: 200,
    unit: 'fields',
  });
  expect(next.current.startedAt).toBe(now);
  expect(next.current.rate).toBeUndefined();
  expect(databaseStepPercent(next.current)).toBeUndefined();
  expect(next.steps).toHaveLength(2);
  expect(next.steps[0]?.finishedAt).toBe(now);
  expect(next.steps[0]?.status).toBe('completed');
});

it('旧组件的阶段结束消息不会抹掉已知计数，失败和停止冻结最后进度', () => {
  let now = 1000;
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db', () => now);
  tracker.update('checkup', { step: 'pages', message: '检查', completed: 30, total: 100 });
  now += 200;
  const repeated = tracker.update('checkup', { step: 'pages', message: '检查中' });
  expect(repeated.current.completed).toBe(30);
  const failed = tracker.finish('failed');
  expect(failed?.status).toBe('failed');
  expect(failed?.current.status).toBe('failed');
  expect(failed?.current.completed).toBe(30);
  expect(failed?.current.finishedAt).toBe(now);
  expect(tracker.update('late', { step: 'late', message: '迟到回调' })).toBe(failed);
});

it('已跳过的步骤不会在任务结束时被改成已完成，历史保持有界', () => {
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  for (let index = 0; index < 100; index++)
    tracker.update('checkup', { step: String(index), message: 'check' });
  tracker.update('checkup', { step: 'skip', message: '无需分析', status: 'skipped' });
  const end = tracker.finish('completed');
  expect(end?.steps).toHaveLength(64);
  expect(end?.current.status).toBe('skipped');
});

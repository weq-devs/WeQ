import { expect, it } from 'vitest';
import {
  DatabaseProgressTracker,
  databaseProgressDisplaySteps,
  databaseStepPercent,
  type DatabaseStepProgress,
} from '../src/account/db_repair/progress';

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

it('深度修复交替上报阶段摘要和累计字段数时，同一重建步骤持续更新', () => {
  for (const end of ['Verify', 'cancelled', 'failed'] as const) {
    let now = 1000;
    const tracker = new DatabaseProgressTracker('repair', 'synthetic.db', () => now);
    tracker.update('Repair', { step: 'Repair', message: '开始重建' });
    const first = tracker.update('Repair', {
      step: 'recover-data',
      message: '恢复表数据',
      objectName: 'group_msg_table',
      completed: 58_617_852,
      unit: 'fields',
    });
    now += 500;
    const summary = tracker.update('Repair', { step: 'Repair', message: '正在恢复群聊表' });
    expect(summary.current.status).toBe('running');
    const counted = tracker.update('Repair', {
      step: 'recover-data',
      message: '恢复表数据',
      objectName: 'c2c_msg_table',
      completed: 58_998_780,
      unit: 'fields',
    });
    expect(counted.steps.filter((step) => step.step === 'recover-data')).toEqual([counted.current]);
    expect(counted.current).toMatchObject({
      status: 'running',
      objectName: 'c2c_msg_table',
      completed: 58_998_780,
      startedAt: first.current.startedAt,
    });
    const result =
      end === 'Verify'
        ? tracker.update('Verify', { step: 'Verify', message: '检查产物' })
        : tracker.finish(end);
    expect(result?.steps.find((step) => step.step === 'recover-data')).toMatchObject({
      status: { Verify: 'completed', cancelled: 'skipped', failed: 'failed' }[end],
      completed: 58_998_780,
    });
  }
});

it('旧主进程的重复重建计数只显示最新一行，并保留当前执行状态', () => {
  const first: DatabaseStepProgress = {
    phase: 'Repair',
    step: 'recover-data',
    message: '恢复表数据',
    completed: 332_894_204,
    unit: 'fields',
    objectName: 'group_msg_table',
    status: 'completed',
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: 1100,
  };
  const latest = {
    ...first,
    completed: 333_688_828,
    startedAt: 1200,
    updatedAt: 1200,
    finishedAt: 1300,
  };
  const summary: DatabaseStepProgress = {
    phase: 'Repair',
    step: 'Repair',
    message: '正在恢复群聊表',
    status: 'running',
    startedAt: 1300,
    updatedAt: 1300,
  };
  const progress = {
    kind: 'repair' as const,
    dbName: 'synthetic.db',
    startedAt: 1000,
    updatedAt: 1300,
    status: 'running' as const,
  };
  for (const [status, stepStatus] of [
    ['running', 'running'],
    ['failed', 'failed'],
    ['cancelled', 'skipped'],
  ] as const) {
    const finishedAt = status === 'running' ? undefined : 1400;
    const current = { ...summary, status: stepStatus, finishedAt };
    const steps = [first, latest, { ...current }];
    expect(databaseProgressDisplaySteps({ ...progress, status, current, steps })).toEqual([
      { ...latest, status: stepStatus, finishedAt },
    ]);
    expect(steps).toHaveLength(3);
  }

  const counting = { ...latest, status: 'running' as const, finishedAt: undefined };
  expect(
    databaseProgressDisplaySteps({ ...progress, current: counting, steps: [first, counting] }),
  ).toEqual([counting]);

  const verifying: DatabaseStepProgress = { ...summary, phase: 'Verify', step: 'Verify' };
  expect(
    databaseProgressDisplaySteps({
      ...progress,
      current: verifying,
      steps: [first, latest, verifying],
    }),
  ).toEqual([latest, verifying]);
});

it('替换后的结构复核保留未核验计数，撤销修复时保留已完成的原库校验', () => {
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db');
  tracker.update('final-check', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 8,
    total: 16,
    unit: 'pages',
  });
  tracker.update('final-check', {
    step: 'rollback-fingerprint',
    message: '校验已恢复的原库',
    completed: 1024,
    total: 1024,
    unit: 'bytes',
    status: 'completed',
  });
  expect(tracker.finish('cancelled')?.steps.map((step) => step.status)).toEqual([
    'incomplete',
    'completed',
  ]);
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

it('修复的两轮逐表检查不会挤掉前序阶段，保留各自的最近明细和早期异常', () => {
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db');
  tracker.update('backup', { step: 'backup-file', message: '备份原库' });
  tracker.update('Decrypt', { step: 'decrypt', message: '解密源数据库' });
  tracker.update('Repair', { step: 'recover-data', message: '恢复表数据' });
  tracker.update('Restore', {
    step: 'output-integrity-index-abnormal',
    message: '索引检查发现异常',
    outcome: 'abnormal',
  });
  for (let index = 0; index < 100; index++) {
    tracker.update('Restore', { step: `output-integrity-records-${index}`, message: '检查产物' });
  }
  tracker.update('swapping', { step: 'swap', message: '替换数据库' });
  for (let index = 0; index < 100; index++) {
    tracker.update('final-check', { step: `integrity-index-${index}`, message: '复核索引' });
  }
  const steps = tracker.finish('completed')?.steps.map((step) => step.step) ?? [];
  expect(steps.slice(0, 4)).toEqual([
    'backup-file',
    'decrypt',
    'recover-data',
    'output-integrity-index-abnormal',
  ]);
  expect(steps).toContain('output-integrity-records-99');
  expect(steps).toContain('swap');
  expect(steps.at(-1)).toBe('integrity-index-99');
  expect(steps).not.toContain('output-integrity-records-0');
  expect(steps).not.toContain('integrity-index-0');
  expect(steps.filter((step) => step.startsWith('output-integrity-records-'))).toHaveLength(63);
  expect(steps.filter((step) => step.startsWith('integrity-index-'))).toHaveLength(64);
});

it('体检切换到异常定位不把未扫完的页标成完成，结构检查持续显示异常', () => {
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  tracker.update('checkup', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 4336384,
    total: 4567177,
    unit: 'pages',
  });
  const next = tracker.update('checkup', {
    step: 'integrity-tables',
    message: '逐表定位结构异常',
    completed: 17,
    total: 34,
    unit: 'tables',
    outcome: 'abnormal',
  });
  expect(next.steps[0]).toMatchObject({ status: 'running', outcome: 'abnormal' });
  expect(next.steps[1]).toMatchObject({
    status: 'incomplete',
    completed: 4336384,
    total: 4567177,
    outcome: 'unverified',
  });
  expect(next.current).toMatchObject({ status: 'running', outcome: 'abnormal' });
});

it('结构最终结果更新原步骤而非追加，正常结果不能掩盖未完成计数', () => {
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  tracker.update('checkup', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 4,
    total: 4,
  });
  tracker.update('checkup', {
    step: 'integrity-records-2',
    message: '检查记录与索引对应',
    completed: 2,
    total: 4,
  });
  const done = tracker.update('checkup', {
    step: 'integrity',
    message: '检查数据库整体结构',
    status: 'completed',
    outcome: 'normal',
  });
  expect(done.steps).toHaveLength(3);
  expect(done.steps[0]).toMatchObject({ status: 'completed', outcome: 'normal' });
  expect(done.steps[1]).toMatchObject({ status: 'completed', outcome: 'normal' });
  expect(done.current).toMatchObject({ status: 'incomplete', outcome: 'unverified', completed: 2 });
  expect(tracker.finish('completed')?.current.status).toBe('incomplete');
});

it('任务返回也不把未确认的末次计数补满，停止会结束仍在等待子阶段的结构行', () => {
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'pages', message: '检查页签名', completed: 3, total: 4 });
  expect(tracker.finish('completed')?.current).toMatchObject({
    status: 'incomplete',
    completed: 3,
  });
  const cancelled = new DatabaseProgressTracker('checkup', 'synthetic.db');
  cancelled.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  cancelled.update('checkup', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 3,
    total: 4,
  });
  expect(cancelled.finish('cancelled')?.steps.map((step) => step.status)).toEqual([
    'skipped',
    'skipped',
  ]);
});

it('大量结构子阶段后仍保留原始结构结论，结果回填不丢失且历史有界', () => {
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  for (let index = 0; index < 100; index++)
    tracker.update('checkup', {
      step: `integrity-records-${index}`,
      message: '检查记录与索引对应',
      completed: 4,
      total: 4,
    });
  const result = tracker.update('checkup', {
    step: 'integrity',
    message: '结构检查发现异常',
    status: 'completed',
    outcome: 'abnormal',
  });
  expect(result.steps).toHaveLength(64);
  expect(result.steps[0]).toMatchObject({
    step: 'integrity',
    status: 'completed',
    outcome: 'abnormal',
  });
});
